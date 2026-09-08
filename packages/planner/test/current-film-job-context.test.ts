import {afterAll,beforeAll,expect,test} from "bun:test";
import {contentHash} from "../../generator/src/capabilities";
import {DurableJobStore,type JobInput} from "../../queue/src/index";
import {validateCurrentFilmJob,assertCurrentFilmIdempotency,assertCurrentFilmHeldInputs,createCurrentFilmCheckpoint,advanceCurrentFilmCheckpoint,validateCurrentFilmOutput} from "../src/current-film-job-context";
import {currentFilmAuthorityFixture} from "./current-film-authority.fixture";

let fixture:Awaited<ReturnType<typeof currentFilmAuthorityFixture>>;
beforeAll(async()=>{fixture=await currentFilmAuthorityFixture();},180000);
afterAll(async()=>{await fixture?.studio.close();});
function input():JobInput {const {plan,project}=fixture;return {id:crypto.randomUUID(),projectId:plan.projectId,idempotencyKey:crypto.randomUUID(),tier:plan.render.tier,stage:plan.render.stage,scriptVersion:plan.materialization.script.version,scriptText:plan.materialization.script.text,
  currentFilm:plan,casting:plan.target.state.casting.candidate!,providerPlan:plan.render.providerPlan,totalFrames:plan.materialization.requestedFrames,rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:1,backoffMs:0},timeoutMs:300000};}

test("current-film admission binds all mirrors and rejects mixed modes without adding a job",()=>{
  const original=input();expect(validateCurrentFilmJob(original)).toEqual(fixture.plan);
  const mutations:((job:JobInput)=>void)[]=[j=>{j.scriptText+="\nChanged";},j=>{j.scriptVersion++;},j=>{j.totalFrames++;},j=>{j.tier="elevated";},j=>{j.stage="final";},j=>{j.casting=undefined;},j=>{j.direction=fixture.project.currentScreenplay!.origin!.request.baseline.direction;},j=>{j.shotReuse={schema:"hv-shot-reuse/1",projectId:j.projectId,revision:"a".repeat(64),shots:[],forceShotIds:[]};},j=>{j.providerSpec="unapproved";},j=>{j.costCapUsd=0;},j=>{j.budgetReservedUsd=6;},j=>{j.retryPolicy.maxRetries=-1;},j=>{j.animaticApprovedAt=new Date().toISOString();}];
  for(const change of mutations){const store=new DurableJobStore(null),job=structuredClone(original);change(job);expect(()=>store.enqueue(job)).toThrow();expect(store.get(job.id)).toBeUndefined();}
},60000);

test("exact retries survive JSON transport but changed settings and injected outputs fail before replay",()=>{
  const store=new DurableJobStore(null),job=input(),queued=store.enqueue(job),before=contentHash(queued);
  expect(store.enqueue({...JSON.parse(JSON.stringify(job)),providerSpec:undefined})).toEqual(queued);
  for(const change of [(j:JobInput)=>{j.timeoutMs++;},(j:JobInput)=>{j.costCapUsd++;},(j:JobInput)=>{j.retryPolicy.backoffMs++;},(j:JobInput)=>{j.budgetReservedUsd=4;}]){const changed=structuredClone(job);change(changed);expect(()=>store.enqueue(changed)).toThrow(/request key/);}
  const checkpoint=createCurrentFilmCheckpoint(queued,[]);
  expect(()=>store.enqueue({...job,currentFilmCheckpoint:checkpoint} as JobInput)).toThrow(/evidence/);
  const claimed={...queued,currentFilmCheckpoint:checkpoint};expect(()=>assertCurrentFilmHeldInputs(claimed,claimed)).not.toThrow();
  expect(()=>assertCurrentFilmHeldInputs(claimed,{...claimed,costCapUsd:6})).toThrow(/held/);
  expect(()=>assertCurrentFilmIdempotency(queued,{...job,output:{mp4Path:"x",hlsPlaylistPath:"y",captionsPath:"z",manifestPath:"m"}})).toThrow(/evidence/);
  const ordinary={...job,currentFilm:undefined};expect(()=>store.enqueue(ordinary)).toThrow();expect(contentHash(store.get(job.id))).toBe(before);
},60000);

test("unowned private evidence, missing prefix and stale holders cannot manufacture checkpoint custody",()=>{
  const store=new DurableJobStore(null),job=input();store.enqueue(job);const now=Math.max(Date.now(),fixture.at+10),held=store.claimNext(now,{}, {workerId:"current-owner"})!,empty=createCurrentFilmCheckpoint(held,[]);
  expect(()=>store.checkpoint(job.id,"wrong-owner",0,0,now,60000,empty)).toThrow(/held/);
  expect(()=>store.checkpoint(job.id,"current-owner",0,1,now,60000,empty)).toThrow(/progress/);
  expect(()=>advanceCurrentFilmCheckpoint({...held,checkpointShots:1,checkpointFrame:30},empty,0,0)).toThrow(/truncate/);
  expect(()=>advanceCurrentFilmCheckpoint({...held,checkpointShots:0,checkpointFrame:30},empty,0,0)).toThrow(/missing/);
  const ordinary={...held,currentFilm:undefined};expect(()=>validateCurrentFilmOutput({...ordinary,currentFilmCheckpoint:empty},{mp4Path:"x",hlsPlaylistPath:"y",captionsPath:"z",manifestPath:"m"})).toThrow(/owning/);
  expect(store.get(job.id)!.checkpointShots).toBe(0);expect(store.get(job.id)!.currentFilmCheckpoint).toBeUndefined();
},60000);

test("accessors and cyclic context fail before invocation or serialization",()=>{
  let reads=0;const job=input();Object.defineProperty(job,"currentFilm",{enumerable:true,get(){reads++;return fixture.plan;}});
  expect(()=>validateCurrentFilmJob(job)).toThrow(/accessors/);expect(reads).toBe(0);
  const cyclic=input();Object.assign(cyclic,{extra:cyclic});expect(()=>validateCurrentFilmJob(cyclic)).toThrow(/portable/);
  const invalid={...input(),currentFilm:null} as unknown as JobInput;expect(()=>new DurableJobStore(null).enqueue(invalid)).toThrow(/discriminator/);
  const store=new DurableJobStore(null),normal=input();store.enqueue(normal);const saved=structuredClone(store.get(normal.id)!);delete saved.currentFilm;
  saved.currentFilmCheckpoint=createCurrentFilmCheckpoint(store.get(normal.id)!,[]);
  const orphan=DurableJobStore.fromJobs([saved]);expect(()=>orphan.claimNext(Date.now(),{},{workerId:"never-dispatch"})).toThrow(/owning/);expect(orphan.get(saved.id)!.status).toBe("queued");
});
