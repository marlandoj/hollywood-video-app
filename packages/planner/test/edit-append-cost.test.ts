/**
 * HV-023-03 — one appended edit replayed everything before it.
 *
 * HV-023-01 memoized `editHistoryReplay` on the history's own recomputed revision, which made the
 * repeated replays of one save free: `validateEditLibrary` replays every sequence, twice, and
 * `appendEdit` replays the history it was handed. It could not make the last one free, because the
 * history `append` produces is content the cache has never seen — so every save still paid one full
 * replay, 369 ms at 62 events and **5,823 ms at 999**, and an editing session of n saves was n of
 * them: quadratic in the session, from the ordinary act of editing.
 *
 * What that replay establishes is the prefix and the one new event. The prefix is established
 * already, in the same call, over bytes `next` carries a clone of, and by content hash rather than
 * by assumption — that is what the memo keys on. So `append` extends that answer by the new event
 * and seeds the cache with the result.
 *
 * The first test below is the one that matters: the extended answer must equal a full replay's,
 * over every operation kind and shape this file builds. It gets the full replay by replaying the
 * same history under a different `id` — `id` is in the revision but in none of the answer — so the
 * cache cannot answer for it and the comparison is against the real thing.
 */
import {expect,test} from "bun:test";
import {appendEdit,editHistoryReplay,moveEditCursor,type EditEvent,type EditHistory} from "../src/edit-history";
import {applyEditOperation,editTimeline,type EditClip,type EditOperation,type EditSource,type EditTimeline} from "../src/edit-timeline";
import {contentHash} from "../../generator/src/capabilities";

const SOURCE:EditSource={id:"original",revision:contentHash("original"),label:"Original picture",frames:108_000,
  width:1920,height:1080,audio:[],captions:[],voices:[],unmeasuredAudio:false};
const OTHER:EditSource={...SOURCE,id:"second",revision:contentHash("second"),label:"Second original"};
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
/** A full replay of the same content: `id` is in the revision and in none of the answer. */
const cold=(value:EditHistory)=>{const data={schema:value.schema,id:"cold",root:value.root,events:value.events};
  return editHistoryReplay({...data,revision:contentHash(data)});};

const OPERATIONS:[string,EditOperation][]=[
  ["settings",{kind:"settings",clipId:"c0",gainDb:0,opacity:0.25,crop:null,fadeIn:0,fadeOut:0}],
  ["move",{kind:"move",clipId:"c1",linked:false,at:100}],
  ["trim",{kind:"trim",clipId:"c2",linked:false,edge:"out",delta:-10,ripple:false}],
  ["trim-in",{kind:"trim",clipId:"c3",linked:false,edge:"in",delta:10,ripple:false}],
  ["delete",{kind:"delete",clipId:"c5",linked:false,ripple:false}],
  ["source",{kind:"source",source:OTHER,receiptRevision:contentHash("receipt-1")}],
];

test("an appended edit answers exactly what replaying it from the root answers",()=>{
  // The whole claim of this increment, asserted rather than argued, over every operation kind and
  // over histories of three different depths.
  const base=root(8);
  for(const depth of [0,1,7])for(const [name,operation] of OPERATIONS){
    const before=history(base,depth,"agree-"+name+"-"+depth);
    const next=appendEdit(before,operation,"appended "+name,before.revision,1_700_500_000_000);
    expect({name,depth,answer:editHistoryReplay(next)}).toEqual({name,depth,answer:cold(next)});
  }
});

test("and so does a source addition on top of a source addition, which is the branch the catalog guards",()=>{
  const base=root(8);
  let current=history(base,2,"catalog");
  const third:EditSource={...SOURCE,id:"third",revision:contentHash("third"),label:"Third original"};
  current=appendEdit(current,{kind:"source",source:OTHER,receiptRevision:contentHash("r1")},"add second",current.revision,1_700_500_000_000);
  expect(editHistoryReplay(current)).toEqual(cold(current));
  current=appendEdit(current,{kind:"source",source:third,receiptRevision:contentHash("r2")},"add third",current.revision,1_700_500_001_000);
  const answer=editHistoryReplay(current);
  expect(answer).toEqual(cold(current));
  // Sorted by id and both receipts held, which is what the replay's own Map produces.
  expect(answer.catalog.map(source=>source.id)).toEqual(["original","second","third"]);
  expect(Object.keys(answer.receipts).sort()).toEqual(["second","third"]);
});

test("and a cursor move, which still replays, still answers what it always did",()=>{
  // Extending covers an edit appended at the head. A cursor event selects an existing node, and the
  // timeline of a node that is not the head is in no replay's answer, so this path is unchanged.
  const base=root(8);
  const built=history(base,4,"cursor");
  const undone=moveEditCursor(built,3,"undo","step back",built.revision,1_700_500_000_000);
  expect(editHistoryReplay(undone).state.head).toBe(3);
  expect(editHistoryReplay(undone)).toEqual(cold(undone));
  // And an edit after the cursor move branches from where the cursor is, not from the last event.
  const branched=appendEdit(undone,{kind:"move",clipId:"c1",linked:false,at:100},"a different take",undone.revision,1_700_500_001_000);
  expect(editHistoryReplay(branched)).toEqual(cold(branched));
  expect(editHistoryReplay(branched).state.parent).toBe(3);
});

test("appending an edit costs the edit, not the history behind it",()=>{
  const base=root(64),operation:EditOperation={kind:"settings",clipId:"c0",gainDb:0,opacity:0.5,crop:null,fadeIn:0,fadeOut:0};
  // The comparison is against the replay itself, on this machine: a 999-event history's cold replay,
  // and an append onto that same history with its own replay already answered. Before this increment
  // the append *was* that replay and a little more -- 5,553 ms and 5,823 ms measured here.
  const deep=history(base,999,"cost-deep");
  const replay=ms(()=>cold(deep));
  editHistoryReplay(deep);
  const append=ms(()=>appendEdit(deep,operation,"one more",deep.revision,1_700_900_000_000));
  expect({measured:replay>200,replay:Math.round(replay)}).toEqual({measured:true,replay:Math.round(replay)});
  // A fifth of a replay at most. What remains is linear and is not the replay: `append` clones the
  // events into the new history and hashes it, which no version of this avoids.
  expect({cheaper:append*5<=replay,replay:Math.round(replay),append:Math.round(append)})
    .toEqual({cheaper:true,replay:Math.round(replay),append:Math.round(append)});
},30_000);

test("and the seeded answer is still an answer about the content, not about a revision",()=>{
  // The seeded entry is keyed the same way every other entry is: on the revision recomputed from
  // the content. A history that merely names it is refused, hit or miss -- the point HV-023-01 made
  // about the cache it introduced, now made about the one entry this module writes itself.
  const base=root(8),before=history(base,3,"forge");
  const next=appendEdit(before,{kind:"move",clipId:"c1",linked:false,at:100},"appended",before.revision,1_700_500_000_000);
  const forged={...next,events:next.events.slice(0,2)} as EditHistory;
  expect(forged.revision).toBe(next.revision);
  expect(()=>editHistoryReplay(forged)).toThrow("The edit history changed.");
  expect(editHistoryReplay(next).state.head).toBe(4);
  // And what the cache hands out is a copy, so one caller's edit is not another caller's timeline.
  const first=editHistoryReplay(next);first.state.timeline.clips[0]!.opacity=0.125;first.state.children.push(999);
  expect(editHistoryReplay(next).state.timeline.clips[0]!.opacity).not.toBe(0.125);
  expect(editHistoryReplay(next).state.children).not.toContain(999);
});

test("and the thousand-event ceiling is still a ceiling",()=>{
  // It used to be enforced by the replay `append` ran on what it had produced. That replay is no
  // longer always run, so the cap is checked where the event is added.
  const base=root(8),full=history(base,1000,"ceiling");
  expect(editHistoryReplay(full).state.head).toBe(1000);
  expect(()=>appendEdit(full,{kind:"move",clipId:"c1",linked:false,at:100},"one too many",full.revision,1_700_900_000_000))
    .toThrow("up to 1000 events");
});
