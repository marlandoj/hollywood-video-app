import {expect,test} from "bun:test";
import {contentHash} from "../../generator/src/capabilities";
import {createEditAssemblyPlan} from "../src/edit-assembly-clock";
import {reviewEditAssembly} from "../src/edit-assembly-review";
import type {EditAssemblyParent,EditAssemblyPlan,EditAssemblyPurpose,EditAssemblyRange} from "../src/edit-assembly-types";
import {initialEditTimeline,type EditSource} from "../src/edit-timeline";

const parent=(frames=100):EditAssemblyParent=>{
  const source:EditSource={id:"original",revision:contentHash("original"),label:"Original picture",frames,width:64,height:48,audio:["mix"],captions:[],voices:[],unmeasuredAudio:false};
  return {sequenceId:"parent-sequence",historyRevision:contentHash("parent-history"),timeline:initialEditTimeline([source],source.id,64,48),sourceReceipts:[{sourceId:source.id,receiptRevision:contentHash("original-receipt")}]};
};
const range=(id:string,fromFrame:number,toFrame:number):EditAssemblyRange=>({id,fromFrame,toFrame,reason:"Owner retained "+id});
const plan=(ranges:EditAssemblyRange[],frames=100)=>createEditAssemblyPlan(parent(frames),ranges);
const reseal=(value:EditAssemblyPlan):EditAssemblyPlan=>{const {revision:_revision,...data}=value;return {...data,revision:contentHash(data)};};
function freeze(value:unknown):void {if(value&&typeof value==="object"){Object.values(value).forEach(freeze);Object.freeze(value);}}

test("assembly review unions only omission coverage while preserving reordered, intersecting, repeated and nested ranges",()=>{
  const input=plan([range("late",70,90),range("opening",10,30),range("overlap",20,40),range("repeat",10,30),range("adjacent",30,50),range("inside",25,28)]),before=structuredClone(input),review=reviewEditAssembly(input,"trailer");
  expect(review).toMatchObject({schema:"hv-edit-assembly-review/1",planRevision:input.revision,purpose:"trailer",frames:103,parentFrames:100,uniqueRetainedFrames:60,repeatedFrames:43,target:null});
  expect(review.omitted).toEqual([{fromFrame:0,toFrame:10},{fromFrame:50,toFrame:70},{fromFrame:90,toFrame:100}]);
  expect(review.joins).toEqual([
    {fromRangeId:"late",toRangeId:"opening",outputFrame:20,parentLeftEndFrame:90,parentRightStartFrame:10,continuous:false},
    {fromRangeId:"opening",toRangeId:"overlap",outputFrame:40,parentLeftEndFrame:30,parentRightStartFrame:20,continuous:false},
    {fromRangeId:"overlap",toRangeId:"repeat",outputFrame:60,parentLeftEndFrame:40,parentRightStartFrame:10,continuous:false},
    {fromRangeId:"repeat",toRangeId:"adjacent",outputFrame:80,parentLeftEndFrame:30,parentRightStartFrame:30,continuous:true},
    {fromRangeId:"adjacent",toRangeId:"inside",outputFrame:100,parentLeftEndFrame:50,parentRightStartFrame:25,continuous:false},
  ]);
  expect(input).toEqual(before);
  expect(input.ranges.map(r=>r.id)).toEqual(["late","opening","overlap","repeat","adjacent","inside"]);
});

test("omissions include half-open start, interior and final gaps without inventing zero-length gaps",()=>{
  const whole=reviewEditAssembly(plan([range("whole",0,100)]),"directors-cut");
  expect(whole.omitted).toEqual([]);expect(whole.joins).toEqual([]);expect(whole.uniqueRetainedFrames).toBe(100);expect(whole.repeatedFrames).toBe(0);
  const edges=reviewEditAssembly(plan([range("first",0,1),range("last",99,100)]),"custom");
  expect(edges.omitted).toEqual([{fromFrame:1,toFrame:99}]);expect(edges.frames).toBe(2);expect(edges.uniqueRetainedFrames).toBe(2);
  const interior=reviewEditAssembly(plan([range("single",49,50)]),"custom");
  expect(interior.omitted).toEqual([{fromFrame:0,toFrame:49},{fromFrame:50,toFrame:100}]);expect(interior.frames).toBe(1);
  const adjacent=reviewEditAssembly(plan([range("last",50,100),range("first",0,25),range("middle",25,50)]),"custom");
  expect(adjacent.omitted).toEqual([]);expect(adjacent.uniqueRetainedFrames).toBe(100);expect(adjacent.repeatedFrames).toBe(0);
  expect(adjacent.joins).toEqual([
    {fromRangeId:"last",toRangeId:"first",outputFrame:50,parentLeftEndFrame:100,parentRightStartFrame:0,continuous:false},
    {fromRangeId:"first",toRangeId:"middle",outputFrame:75,parentLeftEndFrame:25,parentRightStartFrame:25,continuous:true},
  ]);
});

test("sixty-second target reports one-frame short and long outcomes without padding or trimming",()=>{
  for(const [frames,status,deltaFrames]of [[1799,"short",-1],[1800,"exact",0],[1801,"long",1]] as const){
    const input=plan([range("selected",200,200+frames)],2400),before=structuredClone(input),review=reviewEditAssembly(input,"sixty-second");
    expect(review.target).toEqual({frames:1800,status,deltaFrames});expect(review.frames).toBe(frames);expect(review.parentFrames).toBe(2400);
    expect(review.uniqueRetainedFrames).toBe(frames);expect(review.repeatedFrames).toBe(0);
    expect(review.omitted).toEqual([{fromFrame:0,toFrame:200},{fromFrame:200+frames,toFrame:2400}]);expect(input).toEqual(before);
  }
  const shortParent=reviewEditAssembly(plan([range("whole",0,100)]),"sixty-second");
  expect(shortParent.target).toEqual({frames:1800,status:"short",deltaFrames:-1700});expect(shortParent.omitted).toEqual([]);expect(shortParent.frames).toBe(100);
});

test("target duration counts repeated playback rather than unique coverage and is absent for other purposes",()=>{
  const input=plan([range("first-read",0,900),range("repeat-read",0,900)],2400),review=reviewEditAssembly(input,"sixty-second");
  expect(review.target).toEqual({frames:1800,status:"exact",deltaFrames:0});expect(review.frames).toBe(1800);expect(review.uniqueRetainedFrames).toBe(900);expect(review.repeatedFrames).toBe(900);
  expect(review.omitted).toEqual([{fromFrame:900,toFrame:2400}]);expect(review.joins[0]).toMatchObject({outputFrame:900,continuous:false,parentLeftEndFrame:900,parentRightStartFrame:0});
  for(const purpose of ["directors-cut","trailer","custom"] as const){const other=reviewEditAssembly(input,purpose);expect(other.target).toBeNull();expect(other.frames).toBe(1800);expect(other.purpose).toBe(purpose);}
});

test("review seal is deterministic and binds purpose, reason, ordered identities and the retained parent",()=>{
  const input=plan([range("first",0,20),range("last",80,100)]),review=reviewEditAssembly(input,"custom"),{revision,...data}=review;
  expect(revision).toBe(contentHash(data));expect(reviewEditAssembly(structuredClone(input),"custom")).toEqual(review);
  expect(reviewEditAssembly(input,"trailer").revision).not.toBe(revision);
  const changedReason=createEditAssemblyPlan(input.parent,input.ranges.map((r,i)=>i?{...r,reason:"Owner chose the closing line"}:r)),reasonReview=reviewEditAssembly(changedReason,"custom");
  expect(reasonReview.revision).not.toBe(revision);expect(reasonReview.planRevision).toBe(changedReason.revision);expect(reasonReview.omitted).toEqual(review.omitted);
  const reversed=reviewEditAssembly(createEditAssemblyPlan(input.parent,[...input.ranges].reverse()),"custom");
  expect(reversed.revision).not.toBe(revision);expect(reversed.omitted).toEqual(review.omitted);expect(reversed.joins[0]).toMatchObject({fromRangeId:"last",toRangeId:"first"});
  const changedParent={...input.parent,historyRevision:contentHash("different-parent-history")};
  expect(reviewEditAssembly(createEditAssemblyPlan(changedParent,input.ranges),"custom").revision).not.toBe(revision);
});

test("review rejects tampered and resealed invalid plans and unsupported purposes",()=>{
  const input=plan([range("first",0,20),range("last",80,100)]);
  expect(()=>reviewEditAssembly({...input,frames:100},"custom")).toThrow();
  const unsealed=structuredClone(input);unsealed.ranges[0]!.reason="Changed after review";expect(()=>reviewEditAssembly(unsealed,"custom")).toThrow();
  const mutations:((p:EditAssemblyPlan)=>void)[]=[
    p=>{p.frames++;},p=>{p.ranges=[];},p=>{p.ranges[1]!.id=p.ranges[0]!.id;},
    p=>{p.ranges[0]!.fromFrame=.5;},p=>{p.ranges[0]!.toFrame=p.ranges[0]!.fromFrame;},
    p=>{p.ranges[1]!.toFrame=101;},p=>{p.ranges[0]!.reason=" ";},
    p=>{p.parent.timeline.frames--;},p=>{p.parent.sourceReceipts=[];},
  ];
  for(const mutate of mutations){const bad=structuredClone(input);mutate(bad);expect(()=>reviewEditAssembly(reseal(bad),"custom")).toThrow();}
  for(const purpose of ["director","60-second","",null,undefined,{},["custom"],1])expect(()=>reviewEditAssembly(input,purpose as EditAssemblyPurpose)).toThrow();
});

test("review accepts deeply frozen input and does not retain mutable result aliases across calls",()=>{
  const input=plan([range("late",80,100),range("first",10,30)]),before=structuredClone(input);freeze(input);
  const review=reviewEditAssembly(input,"sixty-second"),expected=structuredClone(review);
  review.omitted[0]!.toFrame=99;review.joins[0]!.fromRangeId="changed-result";review.target!.deltaFrames=0;
  expect(input).toEqual(before);expect(reviewEditAssembly(input,"sixty-second")).toEqual(expected);
});
