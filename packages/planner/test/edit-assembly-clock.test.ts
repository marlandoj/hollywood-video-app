import {expect,test} from "bun:test";
import {contentHash} from "../../generator/src/capabilities";
import {createEditAssemblyPlan,validateEditAssemblyPlan,EditAssemblyClock} from "../src/edit-assembly-clock";
import type {EditAssemblyParent,EditAssemblyRange} from "../src/edit-assembly-types";
import {applyEditOperation,editTimeline,type EditClip,type EditLane,type EditSource} from "../src/edit-timeline";
import {EditTime} from "../src/edit-time";
import {editRenderClips,editRenderGainQ20} from "../src/edit-transition-render";
import {editRgbaGroups} from "../src/edit-rgba";

const S=1600,Q=65536;
const source:EditSource={id:"original",revision:contentHash("source"),label:"Original",frames:200,width:64,height:48,audio:["mix","dialogue"],captions:[],voices:[],unmeasuredAudio:false};
const clip=(id:string,lane:EditLane="picture",at=0,from=0,frames=100):EditClip=>({id,sourceId:source.id,lane,layer:0,at,from,frames,link:null,gainDb:0,opacity:1,crop:null,envelope:{from,frames,fadeIn:0,fadeOut:0}});
const parent=(clips=[clip("picture")],frames=100,sources=[source]):EditAssemblyParent=>{
  const timeline=editTimeline({schema:"hv-edit-timeline/1",width:64,height:48,frames,sources,clips,markers:[{id:"marker",frame:Math.min(45,frames-1),label:"Retained marker"}]});
  return {sequenceId:"parent-sequence",historyRevision:contentHash("history"),timeline,sourceReceipts:timeline.sources.map(s=>({sourceId:s.id,receiptRevision:contentHash("receipt-"+s.id)}))};
};
const range=(id:string,fromFrame:number,toFrame:number,reason="Retain this output range."):EditAssemblyRange=>({id,fromFrame,toFrame,reason});
const reseal=(value:any)=>{const {revision:_revision,...data}=value;return {...data,revision:contentHash(data)};};

test("assembly clock preserves explicit reorders, overlaps and repeats at every frame/sample boundary",()=>{
  const ranges=[range("late",80,90),range("early",3,8),range("repeat",80,90),range("overlap",85,88)],plan=createEditAssemblyPlan(parent(),ranges),clock=new EditAssemblyClock(plan),reference=ranges.flatMap(r=>Array.from({length:r.toFrame-r.fromFrame},(_,i)=>({rangeId:r.id,parentFrame:r.fromFrame+i})));
  expect(plan.frames).toBe(28);expect(plan.ranges).toEqual(ranges);expect(Array.from({length:plan.frames},(_,i)=>clock.frame(i))).toEqual(reference);
  const actual:number[]=[],expected:number[]=[];for(let sample=0;sample<plan.frames*S;sample++){actual.push(clock.sample(sample).parentSample);expected.push(reference[Math.floor(sample/S)]!.parentFrame*S+sample%S);}expect(actual).toEqual(expected);
  expect(clock.sample(10*S-1)).toEqual({rangeId:"late",parentSample:90*S-1});expect(clock.sample(10*S)).toEqual({rangeId:"early",parentSample:3*S});
  expect(clock.spans(9*S+1599,15*S+1)).toEqual([{rangeId:"late",outputStartSample:10*S-1,parentStartSample:90*S-1,samples:1},{rangeId:"early",outputStartSample:10*S,parentStartSample:3*S,samples:5*S},{rangeId:"repeat",outputStartSample:15*S,parentStartSample:80*S,samples:1}]);
  expect(clock.spans(0,plan.frames*S).map(s=>s.samples)).toEqual([10*S,5*S,10*S,3*S]);for(const at of [0,1,10*S,plan.frames*S])expect(clock.spans(at,at)).toEqual([]);
});

test("provenance inversion preserves each selected occurrence and exact fractional Q16 endpoints",()=>{
  const clock=new EditAssemblyClock(createEditAssemblyPlan(parent(),[range("late",80,90),range("early",3,8),range("repeat",80,90),range("overlap",85,88)])),a=85*S+1/Q,b=86*S+12345/Q;
  expect(clock.occurrences(a,b)).toEqual([{rangeId:"late",outputStartSample:5*S+1/Q,parentStartSample:a,samples:b-a},{rangeId:"repeat",outputStartSample:20*S+1/Q,parentStartSample:a,samples:b-a},{rangeId:"overlap",outputStartSample:25*S+1/Q,parentStartSample:a,samples:b-a}]);
  expect(clock.occurrences(79*S,81*S)).toEqual([{rangeId:"late",outputStartSample:0,parentStartSample:80*S,samples:S},{rangeId:"repeat",outputStartSample:15*S,parentStartSample:80*S,samples:S}]);
  expect(clock.occurrences(90*S,100*S)).toEqual([]);expect(clock.occurrences(0,3*S)).toEqual([]);for(const at of [0,a,100*S])expect(clock.occurrences(at,at)).toEqual([]);
});

test("partial dissolves keep full parent handles, curve phase, silent holds and source-frame effect context",()=>{
  const clips:EditClip[]=(['picture','mix','captions'] as const).flatMap((lane,i)=>[{...clip("left-"+i,lane,0,20,30),link:"left",timing:{from:20,offset:0,points:[{frame:0,rate:500},{frame:30,rate:1500}]},envelope:{from:20,frames:30,fadeIn:0,fadeOut:lane==='captions'?0:3}},{...clip("right-"+i,lane,30,70,30),link:"right",envelope:{from:70,frames:30,fadeIn:lane==='captions'?0:4,fadeOut:0}}]);
  clips.push({...clip("hold","dialogue",70,100,10),link:null,timing:{from:100,offset:0,points:[{frame:0,rate:0},{frame:10,rate:0}]}});
  const p=parent(clips);p.timeline=applyEditOperation(p.timeline,{kind:"crossfade",leftId:"left-0",rightId:"right-0",linked:true,frames:7,alignment:"center",ids:{"left-0":"picture-fade","left-1":"mix-fade"}});
  p.timeline=applyEditOperation(p.timeline,{kind:"composite",clipId:"left-0",composite:{schema:"hv-edit-composite/1",masks:[{id:"mask",label:"Source mask",sourceRevision:source.revision,kind:"ellipse",combine:"replace",invert:false,featherQ8:256,keyframes:[{sourceFrame:0,interpolation:"linear",geometry:{xQ16:0,yQ16:0,widthQ16:32768,heightQ16:32768}},{sourceFrame:199,interpolation:"hold",geometry:{xQ16:32768,yQ16:0,widthQ16:32768,heightQ16:32768}}]}]}});
  const before=JSON.stringify(p),plan=createEditAssemblyPlan(p,[range("middle-of-fade",28,32),range("held",73,75)]),clock=new EditAssemblyClock(plan),render=editRenderClips(plan.parent.timeline),picture=render.filter(c=>c.lane==='picture'),sound=render.find(c=>c.id==='left-1')!,time=new EditTime(sound);
  expect(JSON.stringify(plan.parent)).toBe(before);expect(plan.parent.timeline.clips.find(c=>c.id==='left-0')!.composite!.masks![0]!.keyframes.map(k=>k.sourceFrame)).toEqual([0,199]);
  expect(picture.map(c=>[c.at,c.frames])).toEqual([[0,34],[27,33]]);expect(clock.frame(0).parentFrame).toBe(28);const weights=editRgbaGroups(picture,28)[0]!;expect(weights[0]!.alpha).toBeCloseTo(255*(1-1/7),12);expect(weights[1]!.alpha).toBeCloseTo(255/7,12);
  const mapped=clock.sample(777).parentSample;expect(mapped).toBe(28*S+777);const integrated=20*S+.5*mapped+mapped*mapped/(2*30*S);expect(time.source(mapped)).toBe(Math.round(integrated*Q)/Q);expect(editRenderGainQ20(sound,time.phase(mapped),1048576,mapped)).toBe(1048576-Math.round((mapped-27*S)/(7*S)*1048576));
  const held=new EditTime(render.find(c=>c.id==='hold')!);expect(clock.sample(4*S).parentSample).toBe(73*S);expect(held.source(clock.sample(5*S+1599).parentSample)).toBe(100*S);expect(held.speed(clock.sample(4*S).parentSample)).toBe(0);
  expect(JSON.stringify(p)).toBe(before);
});

test("plans and clocks own their input and preserve exact parent receipt order and deterministic seals",()=>{
  const other={...source,id:"another",revision:contentHash("another")},p=parent([clip("picture")],100,[source,other]),ranges=[range("a",2,4,"First line.\nSecond line.\tReviewed."),range("b",2,4)],plan=createEditAssemblyPlan(p,ranges),saved=JSON.stringify(plan),copy=validateEditAssemblyPlan(plan),clock=new EditAssemblyClock(plan);
  expect(plan.parent.sourceReceipts.map(r=>r.sourceId)).toEqual(["another","original"]);expect(copy).toEqual(plan);expect(copy).not.toBe(plan);expect(createEditAssemblyPlan(p,ranges).revision).toBe(plan.revision);const {revision,...data}=plan;expect(revision).toBe(contentHash(data));
  p.timeline.clips[0]!.from=50;p.sourceReceipts[0]!.receiptRevision=contentHash("changed");ranges[0]!.fromFrame=3;copy.ranges[0]!.toFrame=10;expect(JSON.stringify(plan)).toBe(saved);
  plan.ranges[0]!.fromFrame=60;plan.parent.timeline.frames=1;expect(clock.sample(0)).toEqual({rangeId:"a",parentSample:2*S});const spans=clock.spans(0,4*S);spans[0]!.parentStartSample=0;expect(clock.spans(0,1)[0]!.parentStartSample).toBe(2*S);
});

test("strict validation rejects changed or resealed malformed plans and non-JSON values without coercion",()=>{
  const good=createEditAssemblyPlan(parent(),[range("a",2,6)]),changes:((p:any)=>void)[]=[p=>p.schema='other',p=>p.join='dissolve',p=>p.frames++,p=>p.extra=true,p=>p.parent.extra=true,p=>p.parent.sequenceId='bad id',p=>p.parent.historyRevision='A'.repeat(64),p=>p.parent.timeline.frames--,p=>p.parent.sourceReceipts=[],p=>p.parent.sourceReceipts[0].sourceId='wrong',p=>p.parent.sourceReceipts[0].receiptRevision='stale',p=>p.parent.sourceReceipts[0].extra=1,p=>p.ranges=[],p=>p.ranges.push({...p.ranges[0]}),p=>p.ranges[0].fromFrame=-1,p=>p.ranges[0].fromFrame=.5,p=>p.ranges[0].toFrame=101,p=>p.ranges[0].toFrame=2,p=>p.ranges[0].reason=' ',p=>p.ranges[0].reason='a'.repeat(2001),p=>p.ranges[0].reason='\u0000',p=>p.ranges[0].reason='\uD800',p=>p.ranges[0].extra=true];
  for(const change of changes){const bad=structuredClone(good);change(bad);expect(()=>validateEditAssemblyPlan(reseal(bad))).toThrow();}
  const changed=structuredClone(good);changed.ranges[0]!.reason='Changed explanation';expect(()=>validateEditAssemblyPlan(changed)).toThrow('changed');
  for(const value of [undefined,NaN,Infinity,-0,1n,()=>0,Symbol('x'),new Date(),new Map(),new Set(),new Uint8Array(1)]){const bad:any=structuredClone(good);bad.ranges[0].reason=value;expect(()=>validateEditAssemblyPlan(bad)).toThrow();}
  const cyclic:any=structuredClone(good);cyclic.parent.timeline=cyclic;expect(()=>validateEditAssemblyPlan(cyclic)).toThrow('non-cyclic');
  const sparse:any=structuredClone(good);delete sparse.ranges[0];expect(()=>validateEditAssemblyPlan(sparse)).toThrow('dense');
  const accessor:any=structuredClone(good);let called=false;Object.defineProperty(accessor.ranges[0],'reason',{enumerable:true,get(){called=true;return 'getter';}});expect(()=>validateEditAssemblyPlan(accessor)).toThrow();expect(called).toBe(false);
  for(const hidden of [Symbol('hidden'),'hidden']){const bad=structuredClone(good);Object.defineProperty(bad,hidden,{value:1});expect(()=>validateEditAssemblyPlan(bad)).toThrow();}
  const two=parent([],100,[source,{...source,id:'another'}]);two.sourceReceipts.reverse();expect(()=>createEditAssemblyPlan(two,[range('a',0,1)])).toThrow('order');
  expect(()=>createEditAssemblyPlan(null as any,[])).toThrow();expect(()=>validateEditAssemblyPlan(null as any)).toThrow();
});

test("duration and range capacity are exact and queries refuse noninteger child time or non-Q16 provenance",()=>{
  const p=parent([],108000),atLimit=createEditAssemblyPlan(p,[range('all',0,108000)]),clock=new EditAssemblyClock(atLimit);expect(atLimit.frames).toBe(108000);expect(clock.frame(107999).parentFrame).toBe(107999);expect(clock.sample(108000*S-1).parentSample).toBe(108000*S-1);
  expect(()=>createEditAssemblyPlan(p,[range('all',0,108000),range('extra',0,1)])).toThrow('duration capacity');const ranges=Array.from({length:256},(_,i)=>range('r'+i,0,1));expect(createEditAssemblyPlan(p,ranges).frames).toBe(256);expect(()=>createEditAssemblyPlan(p,[...ranges,range('extra',0,1)])).toThrow('256');
  for(const value of [-1,.5,108000,Infinity,NaN,'0'] as any[])expect(()=>clock.frame(value)).toThrow();for(const value of [-1,.5,108000*S,NaN,'0'] as any[])expect(()=>clock.sample(value)).toThrow();
  for(const [start,end]of [[-1,0],[2,1],[0,108000*S+1],[.5,1],[0,NaN]])expect(()=>clock.spans(start!,end!)).toThrow();
  for(const [start,end]of [[-1,0],[2,1],[0,108000*S+1],[.1,1],[0,NaN]])expect(()=>clock.occurrences(start!,end!)).toThrow();
  expect(clock.occurrences(108000*S-1/Q,108000*S)).toEqual([{rangeId:'all',outputStartSample:108000*S-1/Q,parentStartSample:108000*S-1/Q,samples:1/Q}]);
});
