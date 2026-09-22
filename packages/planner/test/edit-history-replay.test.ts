/**
 * HV-023-01 — one save replayed the whole history, once per sequence, twice over.
 *
 * `editHistoryReplay` walks every event from the root and `applyEditOperation` validates the whole
 * timeline twice per event. Nothing memoized it, and one `PATCH` to a sequence ran it **2S + 2**
 * times for a library of S sequences: `validateEditLibrary` replays every sequence
 * (`edit-library.ts:19`), `appendEdit` replays before and after the change (`edit-history.ts:40,49`),
 * and the library is validated again on the way out (`edit-library.ts:38`).
 *
 * At the limits the routes enforce — 1000 events, 256 clips, 32 sequences — one save measured
 * **20 s** with a single sequence and **5 minutes** with thirty-two, from half a megabyte of stored
 * metadata, well inside the library's own 64 MiB limit. On a single-threaded server that is every
 * other project waiting on one creator's ordinary edit.
 *
 * The cache key is the history's own revision, and the point of the first test below is that the
 * revision is **recomputed** rather than trusted: a cache keyed on a number the caller supplies is
 * a cache that will serve a validated answer to a forged question.
 */
import {expect,test} from "bun:test";
import {appendEdit,editHistoryReplay,editHistoryReplaysHeld,type EditEvent,type EditHistory} from "../src/edit-history";
import {applyEditOperation,editTimeline,type EditClip,type EditOperation,type EditSource,type EditTimeline} from "../src/edit-timeline";
import {contentHash} from "../../generator/src/capabilities";

const SOURCE:EditSource={id:"original",revision:contentHash("original"),label:"Original picture",frames:108_000,
  width:1920,height:1080,audio:[],captions:[],voices:[],unmeasuredAudio:false};
function root(clipCount:number):EditTimeline{
  const clips:EditClip[]=[];
  for(let index=0;index<clipCount;index++)clips.push({id:"c"+index,sourceId:SOURCE.id,lane:"picture",layer:index%4,link:null,
    at:Math.floor(index/4)*100,from:0,frames:100,gainDb:0,opacity:1,crop:null,envelope:{from:0,frames:100,fadeIn:0,fadeOut:0}});
  return editTimeline({schema:"hv-edit-timeline/1",width:1920,height:1080,frames:Math.max(1,Math.ceil(clipCount/4)*100),
    sources:[SOURCE],clips,markers:[]});
}
/** A history of `count` ordinary settings edits, labelled so each build is its own revision. */
function history(base:EditTimeline,count:number,tag:string):EditHistory{
  let timeline=base,previous=base.revision;const events:EditEvent[]=[];
  for(let index=1;index<=count;index++){
    const operation:EditOperation={kind:"settings",clipId:"c0",gainDb:0,opacity:(index%100)/100,crop:null,fadeIn:0,fadeOut:0};
    timeline=applyEditOperation(timeline,operation);
    const data={sequence:index,previousRevision:previous,at:new Date(1_700_000_000_000+index*1000).toISOString(),
      label:tag+" edit "+index,kind:"edit" as const,parent:index-1,operation,timelineRevision:timeline.revision};
    const event={...data,revision:contentHash(data)} as EditEvent;events.push(event);previous=event.revision;
  }
  const data={schema:"hv-edit-history/1" as const,id:"seq",root:base,events};
  return {...data,revision:contentHash(data)};
}
const ms=(work:()=>unknown):number=>{const started=Bun.nanoseconds();work();return (Bun.nanoseconds()-started)/1e6;};

test("a history that names a revision it does not have is still refused, hit or miss",()=>{
  const base=root(16),real=history(base,4,"real");
  // Replay it once so its revision is in the cache and has a validated answer behind it.
  expect(editHistoryReplay(real).state.head).toBe(4);
  // Now the forgery: the same revision, different events. Before the cache existed this was refused
  // by the check at the end of the replay; with a cache keyed on a trusted revision it would have
  // been served the real history's answer.
  const forged={...real,events:real.events.slice(0,2)} as EditHistory;
  expect(forged.revision).toBe(real.revision);
  expect(()=>editHistoryReplay(forged)).toThrow("The edit history changed.");
  // And the real one still answers, so the forgery did not poison the entry.
  expect(editHistoryReplay(real).state.head).toBe(4);
});

test("a cached replay is a copy, so one caller's edit is not another caller's timeline",()=>{
  const base=root(16),saved=history(base,3,"copies");
  const first=editHistoryReplay(saved);
  first.state.timeline.clips[0]!.opacity=0.125;
  first.state.children.push(999);
  first.catalog.length=0;
  delete first.receipts[SOURCE.id];
  const second=editHistoryReplay(saved);
  expect(second.state.timeline.clips[0]!.opacity).not.toBe(0.125);
  expect(second.state.children).not.toContain(999);
  // And the copy is equal to a replay of the same content built independently, which is the whole
  // claim: the cache changes when the work happens and not what it answers.
  expect(second).toEqual(editHistoryReplay(history(base,3,"copies")));
});

test("replaying the same history twice is not twice the work",()=>{
  const base=root(64);
  // Two histories of the same shape and size, so the miss is measured on one and the hit on the
  // other's twin rather than on a different amount of work.
  const cold=ms(()=>editHistoryReplay(history(base,200,"cold")));
  const warmed=history(base,200,"warm");
  editHistoryReplay(warmed);
  const hot=ms(()=>editHistoryReplay(warmed));
  expect({measured:cold>20,ms:Math.round(cold)}).toEqual({measured:true,ms:Math.round(cold)});
  expect({faster:hot*20<=cold,cold:Math.round(cold),hot:Number(hot.toFixed(2))})
    .toEqual({faster:true,cold:Math.round(cold),hot:Number(hot.toFixed(2))});
});

test("and appending an edit replays the history it is changing, not that one and the one before it",()=>{
  const base=root(64),operation:EditOperation={kind:"settings",clipId:"c0",gainDb:0,opacity:0.5,crop:null,fadeIn:0,fadeOut:0};
  // Cold: `appendEdit` replays the history it was handed and then the history it produced.
  const before=history(base,200,"append-cold");
  const cold=ms(()=>appendEdit(before,operation,"one more",before.revision,1_700_099_999_999));
  // Warm: the first of those two is already answered. The second is new content and always is.
  const after=history(base,200,"append-warm");
  editHistoryReplay(after);
  const warm=ms(()=>appendEdit(after,operation,"one more",after.revision,1_700_099_999_999));
  expect({halved:warm<cold*0.75,cold:Math.round(cold),warm:Math.round(warm)})
    .toEqual({halved:true,cold:Math.round(cold),warm:Math.round(warm)});
});

test("the cache is bounded, so a long editing session is not a memory leak",()=>{
  const base=root(8);
  const held=editHistoryReplaysHeld();
  expect(held).toBeLessThanOrEqual(64);
  for(let index=0;index<200;index++)editHistoryReplay(history(base,1,"bound-"+index));
  // Twice the 32 sequences a library may hold, so a save that touches every sequence twice does not
  // evict its own working set.
  expect(editHistoryReplaysHeld()).toBe(64);
});
