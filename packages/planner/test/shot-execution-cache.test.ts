import {afterAll,beforeAll,expect,spyOn,test} from "bun:test";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {contentHash} from "../../generator/src/capabilities";
import type {Job} from "../../queue/src/index";
import * as shotReuse from "../src/shot-reuse";
import {validateShotExecutionOutput} from "../src/shot-execution-inventory";

let fixture:Awaited<ReturnType<typeof dubStudio>>,original:Job;
const check=(job:Job)=>validateShotExecutionOutput(job,job.output!);
beforeAll(async()=>{
  fixture=await dubStudio();original=JSON.parse(JSON.stringify(fixture.film));
  expect(original.output!.shotExecutions!.every(row=>row.capture!==null)).toBe(true);check(original);
},60000);
afterAll(async()=>{await fixture?.close();});

test("a warmed completed digest rejects omitted-by-JSON undefined plan fields",()=>{
  const before=JSON.stringify(original);check(original);
  for(const target of ["plan","requirements"]){
    const changed=structuredClone(original),object=target==="plan"?changed.providerPlan!:changed.providerPlan!.requirements;
    Object.defineProperty(object,"unreviewed",{enumerable:true,configurable:true,value:undefined});
    expect(JSON.stringify(changed)).toBe(before);
    expect(()=>check(changed)).toThrow();expect(()=>check(changed)).toThrow();
  }
  check(original);expect(JSON.stringify(original)).toBe(before);
});

test("warm validation never accepts changed records, captures, route journals or admitted context",()=>{
  const changes:((job:Job)=>void)[]=[
    job=>{job.scriptText+="\n\nINT. OTHER - DAY\nA clock ticks.";},job=>{job.providerPlan!.pool[0]!.snapshot.model="unreviewed";},
    job=>{job.checkpointFrame++;},job=>{job.checkpointShots--;},job=>{job.routeDecisions=[];},job=>{job.routeDecisions![0]!.candidates[0]!.health.samples++;},
    job=>{job.output!.shotRenders![0]!.clip.seed++;},job=>{job.output!.shotRenders![0]!.files.video.sha256="0".repeat(64);},
    job=>{job.output!.shotExecutions![0]!.capture!.observation.emission.prompt="An unapproved scene.";},
    job=>{job.executionCheckpoints![0]!.recordRevision="0".repeat(64);},job=>{job.output!.shotExecutions!.reverse();},
  ];
  for(const change of changes){check(original);const changed=structuredClone(original);change(changed);expect(()=>check(changed)).toThrow();}
  const changed=structuredClone(original),row=changed.output!.shotExecutions![0]!,capture=row.capture!;
  capture.observation.recipe.dispatch.prompt="A different room glows.";
  const {revision:_recipeRevision,...recipe}=capture.observation.recipe;capture.observation.recipe={...recipe,revision:contentHash(recipe)};
  capture.observation.emission.prompt=capture.observation.recipe.dispatch.prompt;
  const {revision:_captureRevision,...body}=capture;row.capture={...body,revision:contentHash(body)};changed.executionCheckpoints=structuredClone(changed.output!.shotExecutions!);
  expect(()=>check(changed)).toThrow(/admitted screenplay inputs/);check(original);
});

test("descriptor and portable checks precede warmed hits and execute no hostile accessors",()=>{
  let reads=0;const accessor=(value:object,key:string)=>Object.defineProperty(value,key,{enumerable:true,configurable:true,get(){reads++;return undefined;}});
  const changes:((job:Job)=>void)[]=[
    job=>{accessor(job,"scriptText");},job=>{accessor(job,"providerPlan");},job=>{accessor(job.providerPlan!,"revision");},
    job=>{accessor(job.output!,"shotRenders");},job=>{accessor(job.output!.shotRenders![0]!,"clip");},
    job=>{accessor(job.executionCheckpoints![0]!,"capture");},job=>{accessor(job.output!.shotExecutions![0]!.capture!.observation.emission.params,"seed");},
    job=>{accessor(job.routeDecisions![0]!,"candidates");},
  ];
  for(const change of changes){check(original);const changed=structuredClone(original);change(changed);reads=0;expect(()=>check(changed)).toThrow(/accessor|hidden/);expect(reads).toBe(0);}
  const invalid:((job:Job)=>void)[]=[job=>{Object.defineProperty(job.providerPlan!,"hidden",{value:1,enumerable:false});},job=>{Object.defineProperty(job.providerPlan!,Symbol("hidden"),{value:1,enumerable:true});},job=>{Object.setPrototypeOf(job.providerPlan!,{unexpected:true});}];
  for(const change of invalid){const changed=structuredClone(original);change(changed);expect(()=>check(changed)).toThrow();}
});

test("JSONB object reordering reaches the same validated digest without changing array order",()=>{
  function reorder(value:unknown):unknown {return Array.isArray(value)?value.map(reorder):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reorder(item)])):value;}
  check(original);const reordered=reorder(original) as Job;expect(JSON.stringify(reordered)).not.toBe(JSON.stringify(original));expect(contentHash(reordered)).toBe(contentHash(original));
  const spy=spyOn(shotReuse,"renderShots");try{check(reordered);expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}
  expect(reordered.output!.shotRenders!.map(record=>record.shotId)).toEqual(original.output!.shotRenders!.map(record=>record.shotId));
});

test("failed validation is never cached and changing a previously warm caller still revalidates",()=>{
  const changed=structuredClone(original);check(changed);changed.providerPlan!.revision="0".repeat(64);
  const spy=spyOn(shotReuse,"renderShots");try{
    expect(()=>check(changed)).toThrow();expect(()=>check(changed)).toThrow();expect(spy).toHaveBeenCalledTimes(2);
    changed.providerPlan=structuredClone(original.providerPlan!);check(changed);expect(spy).toHaveBeenCalledTimes(2);
  }finally{spy.mockRestore();}
});

test("the digest cache retains only its bounded recent historical contexts",()=>{
  check(original);const base=Date.parse(original.startedAt!);
  for(let i=0;i<65;i++){const different=structuredClone(original);different.startedAt=new Date(base+1000+i).toISOString();check(different);}
  const spy=spyOn(shotReuse,"renderShots");try{check(original);expect(spy).toHaveBeenCalled();spy.mockClear();check(original);expect(spy).not.toHaveBeenCalled();}finally{spy.mockRestore();}
},30000);

test("a historical cache hit confers no renewed source access or current carrier status",()=>{
  check(original);const record=original.output!.shotRenders![0]!,expired=structuredClone(original);expired.linkExpiresAt=new Date(0).toISOString();
  check(expired);expect(()=>shotReuse.sourceRenderRecord(expired,record,Date.now())).toThrow(/unavailable/);
  const withdrawn=structuredClone(original);withdrawn.status="cancelled";check(withdrawn);expect(()=>shotReuse.sourceRenderRecord(withdrawn,record,Date.now())).toThrow(/unavailable/);
});

test("measure repeated actual-source historical validation without a timing acceptance threshold",()=>{
  const base=Date.parse(original.startedAt!),misses=Array.from({length:100},(_,i)=>({...structuredClone(original),startedAt:new Date(base+2000+i).toISOString()}));
  const coldStart=performance.now();for(const value of misses)check(value);const missesMs=performance.now()-coldStart;
  check(original);const warmStart=performance.now();for(let i=0;i<100;i++)check(original);const hitsMs=performance.now()-warmStart;
  expect(Number.isFinite(missesMs)&&Number.isFinite(hitsMs)).toBe(true);
  console.info(JSON.stringify({measurement:"actual-source validation; distinct valid historical contexts versus exact warmed repeats",repeats:100,shots:original.output!.shotRenders!.length,coldContextTotalMs:Math.round(missesMs),warmRepeatTotalMs:Math.round(hitsMs)}));
},30000);
