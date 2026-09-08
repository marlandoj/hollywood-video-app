import {expect,test} from "bun:test";
import {contentHash} from "../src/capabilities";
import {EDIT_ASSEMBLY_CAPTION_LIMITS,editAssemblyCaptionCues,editAssemblyVtt} from "../src/edit-assembly-captions";
import {editVtt} from "../src/edit-conform";
import {createEditAssemblyPlan} from "../../planner/src/edit-assembly-clock";
import type {EditAssemblyRange} from "../../planner/src/edit-assembly-types";
import {applyEditOperation,editCaptionCues,editTimeline,type EditCaption,type EditClip,type EditLane,type EditSource,type EditTimeline} from "../../planner/src/edit-timeline";

const S=1600;
const source=(captions:EditCaption[],id="original"):EditSource=>({id,revision:contentHash(id),label:id,frames:120,width:64,height:48,audio:["mix"],captions,voices:[],unmeasuredAudio:false});
const cue=(id:string,start:number,end:number,text="Retained words"):EditCaption=>({id,start,end,text});
const clip=(id="captions",at=0,from=0,frames=60,sourceId="original",lane:EditLane="captions"):EditClip=>({id,sourceId,lane,layer:0,at,from,frames,link:null,gainDb:0,opacity:1,crop:null,envelope:{from,frames,fadeIn:0,fadeOut:0}});
const timeline=(sources:EditSource[],clips:EditClip[]=[clip()],frames=60)=>editTimeline({schema:"hv-edit-timeline/1",width:64,height:48,frames,sources,clips,markers:[]});
const range=(id:string,fromFrame:number,toFrame:number):EditAssemblyRange=>({id,fromFrame,toFrame,reason:"Retain "+id});
const plan=(t:EditTimeline,ranges:EditAssemblyRange[])=>createEditAssemblyPlan({sequenceId:"parent",historyRevision:contentHash("parent-history"),timeline:t,sourceReceipts:t.sources.map(s=>({sourceId:s.id,receiptRevision:contentHash("receipt-"+s.id)}))},ranges);
function freeze(value:unknown):void {if(value&&typeof value==="object"){Object.values(value).forEach(freeze);Object.freeze(value);}}

test("assembly captions retain reordered and repeated parent occurrences while omitting unselected gaps",()=>{
  const t=timeline([source([cue("line",S+23,5*S+31)])]),input=plan(t,[range("tail",4,6),range("head",0,2),range("repeat-tail",4,6),range("gap",8,10)]),mapped=editAssemblyCaptionCues(input);
  expect(mapped.map(c=>[c.rangeId,c.start,c.end,c.clipped])).toEqual([["tail",0,S+31,true],["head",3*S+23,4*S,true],["repeat-tail",4*S,5*S+31,true]]);
  expect(mapped.every(c=>c.parentCueId==="captions:line"&&c.sourceId==="original"&&c.sourceCaptionId==="line"&&c.text==="Retained words")).toBe(true);
  expect(new Set(mapped.map(c=>c.id)).size).toBe(3);expect(mapped.every(c=>/^assembly-caption-[a-f0-9]{64}$/.test(c.id))).toBe(true);
  expect(editAssemblyCaptionCues(structuredClone(input))).toEqual(mapped);
});

test("cues straddling adjacent joins remain separate range occurrences and exact half-open edges do not leak",()=>{
  const t=timeline([source([cue("across",0,4*S),cue("left-only",0,S),cue("selected",S,2*S),cue("right-only",2*S,3*S)])]);
  const selected=editAssemblyCaptionCues(plan(t,[range("one-frame",1,2)]));
  expect(selected.map(c=>c.sourceCaptionId).sort()).toEqual(["across","selected"]);
  expect(selected.find(c=>c.sourceCaptionId==="selected")).toMatchObject({start:0,end:S,clipped:false});
  expect(selected.find(c=>c.sourceCaptionId==="across")).toMatchObject({start:0,end:S,clipped:true});
  const joined=editAssemblyCaptionCues(plan(t,[range("left",0,2),range("right",2,4)])).filter(c=>c.sourceCaptionId==="across");
  expect(joined.map(c=>[c.rangeId,c.start,c.end,c.clipped])).toEqual([["left",0,2*S,true],["right",2*S,4*S,true]]);expect(joined[0]!.id).not.toBe(joined[1]!.id);
  expect(editAssemblyCaptionCues(plan(t,[range("empty",10,11)]))).toEqual([]);expect(editAssemblyVtt(plan(t,[range("empty",10,11)]))).toBe("WEBVTT\n\n");
});

test("the original clipped flag survives selection and identical text from different originals is never deduplicated",()=>{
  const t=timeline([source([cue("same",4*S,7*S)]),source([cue("same",5*S,7*S)],"other")],[clip("original-caption",0,5,5),clip("other-caption",0,5,5,"other")]);
  const result=editAssemblyCaptionCues(plan(t,[range("first",0,3),range("again",0,3)]));
  expect(result).toHaveLength(4);expect(new Set(result.map(c=>c.id)).size).toBe(4);expect(result.every(c=>c.text==="Retained words"&&c.sourceCaptionId==="same")).toBe(true);
  expect(result.filter(c=>c.sourceId==="original").map(c=>[c.start,c.end,c.clipped])).toEqual([[0,2*S,true],[3*S,5*S,true]]);
  expect(result.filter(c=>c.sourceId==="other").map(c=>[c.start,c.end,c.clipped])).toEqual([[0,2*S,false],[3*S,5*S,false]]);
  expect(new Set(result.map(c=>c.parentCueId))).toEqual(new Set(["original-caption:same","other-caption:same"]));
});

test("VTT rounds exact translated samples only after selection and preserves existing editorial escaping",()=>{
  const text="A & <B>\r\n\r\nC > D",t=timeline([source([cue("tiny",2*S+1,2*S+49,text)])]),input=plan(t,[range("translated",2,3)]),mapped=editAssemblyCaptionCues(input),vtt=editAssemblyVtt(input);
  expect(mapped[0]).toMatchObject({start:1,end:49,text,clipped:false});expect(vtt).toBe("WEBVTT\n\n"+mapped[0]!.id+"\n00:00:00.000 --> 00:00:00.002\nA &amp; &lt;B&gt;\nC &gt; D\n");
  expect(editVtt(t)).toContain("00:00:00.066 --> 00:00:00.068");
  const whole=plan(t,[range("whole",0,t.frames)]),wholeCue=editAssemblyCaptionCues(whole)[0]!;
  expect(editAssemblyVtt(whole).replace(wholeCue.id,wholeCue.parentCueId)).toBe(editVtt(t));
  const end=timeline([source([cue("last-sample",S-1,S)])]);
  expect(editAssemblyVtt(plan(end,[range("one",0,1)]))).toContain("00:00:00.033 --> 00:00:00.034");
});

test("caption selection retains borrowed crossfade handles from the full parent before cutting through a dissolve",()=>{
  const s=source([cue("outgoing-handle",41*S+7,42*S+9),cue("incoming-handle",58*S+7,59*S+9)]),clips=(['picture','mix','captions'] as const).flatMap(lane=>[{...clip("left-"+lane,0,10,30,s.id,lane),link:"left"},{...clip("right-"+lane,30,60,30,s.id,lane),link:"right"}]);
  const base=timeline([s],clips),t=applyEditOperation(base,{kind:"crossfade",leftId:"left-picture",rightId:"right-picture",linked:true,frames:6,alignment:"center",ids:{"left-picture":"picture-fade","left-mix":"sound-fade"}}),parentCues=editCaptionCues(t);
  expect(editCaptionCues(base)).toEqual([]);expect(parentCues.map(c=>[c.sourceCaptionId,c.start,c.end])).toEqual([["incoming-handle",28*S+7,29*S+9],["outgoing-handle",31*S+7,32*S+9]]);
  const mapped=editAssemblyCaptionCues(plan(t,[range("dissolve",28,32),range("repeat-dissolve",28,32)]));
  expect(mapped.map(c=>[c.sourceCaptionId,c.start,c.end,c.clipped])).toEqual([["incoming-handle",7,S+9,false],["outgoing-handle",3*S+7,4*S,true],["incoming-handle",4*S+7,5*S+9,false],["outgoing-handle",7*S+7,8*S,true]]);
  expect(mapped.every(c=>parentCues.some(parentCue=>parentCue.id===c.parentCueId&&parentCue.sourceId===c.sourceId))).toBe(true);
});

test("ramps and held captions inherit the parent sample-clock result rather than reinterpreting source ranges",()=>{
  const s=source([cue("ramp-line",10*S+1,12*S+1),cue("held-line",40*S,41*S),cue("ends-before-hold",39*S,40*S)]),ramp={...clip("ramp",0,10,20),timing:{from:10,offset:0,points:[{frame:0,rate:500},{frame:20,rate:1500}]}},hold={...clip("hold",30,40,10),timing:{from:40,offset:0,points:[{frame:0,rate:0},{frame:10,rate:0}]}},t=timeline([s],[ramp,hold]),parentCues=editCaptionCues(t);
  const parentRamp=parentCues.find(c=>c.sourceCaptionId==="ramp-line")!;expect(parentRamp.start).toBe(2);expect(parentRamp.end%S).not.toBe(0);
  expect(parentCues.find(c=>c.sourceCaptionId==="held-line")).toMatchObject({start:30*S,end:40*S});expect(parentCues.some(c=>c.sourceCaptionId==="ends-before-hold")).toBe(false);
  const mapped=editAssemblyCaptionCues(plan(t,[range("hold",31,33),range("ramp",1,4),range("hold-again",31,33)]));
  expect(mapped.map(c=>[c.rangeId,c.start,c.end])).toEqual([["hold",0,2*S],["ramp",2*S,S+parentRamp.end],["hold-again",5*S,7*S]]);expect(mapped.every(c=>c.clipped)).toBe(true);
});

test("mapping rejects stale plans and never mutates the retained parent or aliases results",()=>{
  const input=plan(timeline([source([cue("line",0,3*S)])]),[range("keep",1,2)]),before=structuredClone(input);freeze(input);
  const result=editAssemblyCaptionCues(input),original=structuredClone(result);result[0]!.text="Changed result";result[0]!.start=123;
  expect(input).toEqual(before);expect(editAssemblyCaptionCues(input)).toEqual(original);
  const changed=structuredClone(input);changed.frames++;expect(()=>editAssemblyCaptionCues(changed)).toThrow("changed");expect(()=>editAssemblyVtt(changed)).toThrow("changed");
  const parentChanged=structuredClone(input);parentChanged.parent.timeline.sources[0]!.captions[0]!.text="Changed original";expect(()=>editAssemblyCaptionCues(parentChanged)).toThrow("changed");
});

test("mapped captions allow exactly 4096 occurrences and reject additional cues instead of truncating",()=>{
  const ranges=Array.from({length:256},(_,i)=>range("repeat-"+i,0,1)),t=timeline([source(Array.from({length:16},(_,i)=>cue("line-"+i,0,S)))]),input=plan(t,ranges);
  expect(editAssemblyCaptionCues(input)).toHaveLength(EDIT_ASSEMBLY_CAPTION_LIMITS.cues);
  const overflow=plan(timeline([source(Array.from({length:17},(_,i)=>cue("line-"+i,0,S)))]),ranges);
  expect(()=>editAssemblyCaptionCues(overflow)).toThrow("4096");expect(()=>editAssemblyVtt(overflow)).toThrow("4096");
});

test("UTF-8 caption response and escaped WebVTT size limits fail explicitly before returning partial output",()=>{
  const ranges=Array.from({length:200},(_,i)=>range("repeat-"+i,0,1)),large=plan(timeline([source(Array.from({length:4},(_,i)=>cue("line-"+i,0,S,"界".repeat(4000))))]),ranges);
  expect(()=>editAssemblyCaptionCues(large)).toThrow("8 MiB");expect(()=>editAssemblyVtt(large)).toThrow("8 MiB");
  const escaped=plan(timeline([source(Array.from({length:3},(_,i)=>cue("line-"+i,0,S,"&".repeat(4000))))]),ranges);
  expect(editAssemblyCaptionCues(escaped)).toHaveLength(600);expect(()=>editAssemblyVtt(escaped)).toThrow("WebVTT exceeds 8 MiB");
});
