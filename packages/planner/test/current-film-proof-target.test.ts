import {afterAll,beforeAll,expect,test} from "bun:test";
import {contentHash as hash} from "../../generator/src/capabilities";
import {createProviderPlan} from "../../generator/src/catalog";
import {currentFilmSourceFixture} from "./current-film-source.fixture";
import {compileCurrentFilmJob} from "../src/current-film-jobs";
import {compileCurrentFilmMixedJob,type CurrentFilmJobV3} from "../src/current-film-mixed-jobs";
import {createCurrentFilmPreviewReview} from "../src/current-film-job-context";
import {assertCurrentFilmMixedPreviewApproval,assertCurrentFilmMixedPreviewRelationship,type CurrentFilmMixedApproval,type CurrentFilmMixedJob,type CurrentFilmMixedJobInput} from "../src/current-film-mixed-job-context";
import {compileCurrentFilmProofTarget,validateCurrentFilmProofTarget,assertCurrentFilmProofTargetApproval,type CurrentFilmProofTarget} from "../src/current-film-proof-target";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,previewInput:CurrentFilmMixedJobInput,finalInput:CurrentFilmMixedJobInput,
  target:CurrentFilmProofTarget,approval:CurrentFilmMixedApproval,at:number;
const reseal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...body}=value;return {...body,revision:hash(body)} as T;};
function input(plan:CurrentFilmJobV3,id:string):CurrentFilmMixedJobInput {
  return {id,projectId:plan.projectId,idempotencyKey:id,currentFilm:plan,tier:plan.render.tier,stage:plan.render.stage,
    scriptVersion:plan.materialization.script.version,scriptText:plan.materialization.script.text,casting:plan.target.state.casting.candidate!,providerPlan:plan.render.providerPlan,
    rightsAttestedAt:f.project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:plan.materialization.requestedFrames,
    costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:300000};
}
/** Only queue progress is constructed here. The reviewed preview is the actual
 * completed V2 worker film and its saved owner decision, never a relabelled V3
 * output or invented capture. Existing mixed-context tests cover V3 previews. */
function running():CurrentFilmMixedJob {
  const {currentFilm:_plan,currentFilmCheckpoint:_checkpoint,output:_output,...prior}=f.job;
  return {...prior,...finalInput,status:"running",startedAt:new Date(at).toISOString(),completedAt:null,linkExpiresAt:null,
    checkpointShots:0,checkpointFrame:0,routeDecisions:[],claimedBy:"proof-target-holder",leaseVersion:1,leaseExpiresAt:new Date(at+300000).toISOString()};
}
beforeAll(async()=>{
  f=await currentFilmSourceFixture();
  previewInput=input(compileCurrentFilmMixedJob(f.plan,{origins:[],choices:[]}),"proof-target-preview");
  const finalPlan=compileCurrentFilmMixedJob(compileCurrentFilmJob(f.saved.library,f.plan.selector,{role:"render",tier:"free",
    providerPlan:createProviderPlan("final",5,undefined,{...process.env,HV_PROVIDER_POOL:'["mock"]'})}),{origins:[],choices:[]});
  at=Math.max(Date.now(),Date.parse(finalPlan.createdAt)+10);
  const decision=f.projects.recordCurrentFilmDecision(f.studio.owner.token,f.job,createCurrentFilmPreviewReview(f.job),"approved","Actual preview for frozen proof target",at);
  if(!decision)throw new Error("Require the actual saved owner preview decision.");approval=decision.approval;
  finalInput={...input(finalPlan,"proof-target-final"),animaticJobId:f.job.id,animaticApprovedAt:approval.at};
  target=compileCurrentFilmProofTarget(finalInput);
},180000);
afterAll(async()=>{await f?.close();});

test("exact target projection is stable across actual input and worker progress without a whole-job identity",()=>{
  const job=running(),before=hash(job);
  expect(target).toEqual(reseal({schema:"hv-current-film-proof-target/1" as const,projectId:finalInput.projectId,jobId:finalInput.id,
    jobPlanRevision:finalInput.currentFilm.revision,stage:"final" as const,animaticJobId:f.job.id,animaticApprovedAt:approval.at,revision:""}));
  expect(compileCurrentFilmProofTarget(job)).toEqual(target);
  job.claimedBy="new-holder";job.leaseVersion=(job.leaseVersion??0)+1;job.leaseExpiresAt=new Date(at+600000).toISOString();job.costUsd=1;
  expect(compileCurrentFilmProofTarget(job)).toEqual(target);expect(hash(job)).not.toBe(before);
  expect(validateCurrentFilmProofTarget(target,finalInput.currentFilm,finalInput.id)).toEqual(target);
  const copy=compileCurrentFilmProofTarget(finalInput);copy.jobId="returned-mutation";
  expect(compileCurrentFilmProofTarget(finalInput)).toEqual(target);
  expect(()=>compileCurrentFilmProofTarget({...finalInput,scriptText:finalInput.scriptText+"\nchanged"})).toThrow("admitted");
  expect(()=>compileCurrentFilmProofTarget(f.job)).toThrow("explicit mixed");
},90000);

test("authentic saved preview approval has the same exact relationship through projected and full targets",()=>{
  const binding=assertCurrentFilmProofTargetApproval(target,finalInput.currentFilm,f.job,approval,at)!;
  expect(binding).toEqual(reseal({targetRevision:target.revision,previewJobId:f.job.id,previewRevision:hash(f.job),approval,revision:""}));
  expect(()=>assertCurrentFilmMixedPreviewApproval(finalInput,f.job,approval,at)).not.toThrow();
  expect(()=>assertCurrentFilmMixedPreviewApproval(running(),f.job,approval,at)).not.toThrow();
  binding.approval.note="mutated returned decision";expect(approval.note).toBe("Actual preview for frozen proof target");
  expect(assertCurrentFilmProofTargetApproval(target,finalInput.currentFilm,f.job,approval,at)!.approval).toEqual(approval);
  // The pure relationship cannot decide which saved note is authoritative;
  // it seals the complete supplied decision so that the held caller can compare.
  const changed=assertCurrentFilmProofTargetApproval(target,finalInput.currentFilm,f.job,{...approval,note:"Another saved note"},at)!;
  expect(changed.revision).not.toBe(binding.revision);
},90000);

test("preview targets have no final dependency and cannot silently retain a supplied approval",()=>{
  const value=compileCurrentFilmProofTarget(previewInput);
  expect(assertCurrentFilmProofTargetApproval(value,previewInput.currentFilm,undefined,null,at)).toBeNull();
  expect(()=>assertCurrentFilmProofTargetApproval(value,previewInput.currentFilm,f.job,approval,at)).toThrow("no target approval");
  const forged=reseal({...value,animaticJobId:f.job.id,animaticApprovedAt:approval.at});
  expect(()=>validateCurrentFilmProofTarget(forged,previewInput.currentFilm,previewInput.id)).toThrow("cannot contain");
},90000);

test("resealed target changes refuse mismatched plan, exact owner, stage and preview relationships",()=>{
  for(const change of [
    {projectId:"foreign-project"},{jobId:"different-target"},{jobPlanRevision:"a".repeat(64)},{stage:"animatic" as const},
    {animaticJobId:finalInput.id},{animaticApprovedAt:"2026-01-01"},
  ])expect(()=>validateCurrentFilmProofTarget(reseal({...target,...change}),finalInput.currentFilm,finalInput.id)).toThrow();
  expect(()=>validateCurrentFilmProofTarget({...target,revision:"b".repeat(64)},finalInput.currentFilm,finalInput.id)).toThrow("seal");
  expect(()=>validateCurrentFilmProofTarget(target,finalInput.currentFilm,"wrong-held-target")).toThrow("owner");
  const otherPreview=reseal({...target,animaticJobId:"another-real-preview"});
  expect(()=>assertCurrentFilmProofTargetApproval(otherPreview,finalInput.currentFilm,f.job,approval,at)).toThrow("final target");
  const otherTime=reseal({...target,animaticApprovedAt:new Date(at+1).toISOString()});
  expect(()=>assertCurrentFilmProofTargetApproval(otherTime,finalInput.currentFilm,f.job,approval,at+1)).toThrow("admission");
},90000);

test("changed review, decision, screenplay settings and late approval fail while historical replay survives later expiry",()=>{
  for(const change of [
    {decision:"changes_requested" as const},{animaticJobId:"wrong-preview"},{scriptVersion:approval.scriptVersion+1},
    {castingRevision:"c".repeat(64)},{directionRevision:"d".repeat(64)},{takeRevision:"e".repeat(64)},
    {at:new Date(at+1).toISOString()},{currentFilmReview:{...createCurrentFilmPreviewReview(f.job),outputRevision:"f".repeat(64)}},
  ]){
    expect(()=>assertCurrentFilmProofTargetApproval(target,finalInput.currentFilm,f.job,{...approval,...change},at)).toThrow();
    expect(()=>assertCurrentFilmMixedPreviewApproval(finalInput,f.job,{...approval,...change},at)).toThrow();
  }
  expect(()=>assertCurrentFilmProofTargetApproval(target,finalInput.currentFilm,{...f.job,status:"running"},approval,at)).toThrow("completed");
  expect(()=>assertCurrentFilmProofTargetApproval(target,finalInput.currentFilm,f.job,approval,at-1)).toThrow("late");
  expect(()=>assertCurrentFilmProofTargetApproval(target,finalInput.currentFilm,f.job,approval,Date.parse(f.job.linkExpiresAt!))).toThrow("expired");
  expect(assertCurrentFilmProofTargetApproval(target,finalInput.currentFilm,f.job,approval,at)).not.toBeNull();
  // Full Job checking retains the start-time fence absent from this projection.
  expect(()=>assertCurrentFilmMixedPreviewApproval({...running(),startedAt:new Date(at-1).toISOString()},f.job,approval,at)).toThrow("late");
},90000);

test("portable bounds precede getter reads for job, target, plan, preview and decision",()=>{
  let reads=0;const getter=()=>{reads++;return finalInput.id;},job=structuredClone(finalInput);
  Object.defineProperty(job,"id",{enumerable:true,get:getter});expect(()=>compileCurrentFilmProofTarget(job)).toThrow("portable");
  const value=structuredClone(target);Object.defineProperty(value,"jobId",{enumerable:true,get:getter});
  expect(()=>assertCurrentFilmProofTargetApproval(value,finalInput.currentFilm,f.job,approval,at)).toThrow("portable");
  const plan=structuredClone(finalInput.currentFilm);Object.defineProperty(plan,"revision",{enumerable:true,get:getter});
  expect(()=>validateCurrentFilmProofTarget(target,plan,finalInput.id)).toThrow("portable");
  const preview=structuredClone(f.job);Object.defineProperty(preview,"id",{enumerable:true,get:getter});
  expect(()=>assertCurrentFilmProofTargetApproval(target,finalInput.currentFilm,preview,approval,at)).toThrow("portable");
  const decision=structuredClone(approval);Object.defineProperty(decision,"note",{enumerable:true,get:getter});
  expect(()=>assertCurrentFilmProofTargetApproval(target,finalInput.currentFilm,f.job,decision,at)).toThrow("portable");
  const oversized={...target,extra:"x".repeat(16385)};
  expect(()=>validateCurrentFilmProofTarget(oversized,plan,finalInput.id)).toThrow("portable");
  expect(reads).toBe(0);
},90000);

test("warm preview relationships still inspect complete current bodies and every time boundary",()=>{
  const projected={projectId:target.projectId,jobId:target.jobId,stage:target.stage,animaticJobId:target.animaticJobId,animaticApprovedAt:target.animaticApprovedAt};
  const check=(preview=f.job,decision=approval,now=at,plan=finalInput.currentFilm)=>assertCurrentFilmMixedPreviewRelationship(projected,plan,preview,decision,now);
  expect(()=>check()).not.toThrow();expect(()=>check(structuredClone(f.job),structuredClone(approval),at+1)).not.toThrow();
  for(const now of [at-1,Date.parse(f.job.linkExpiresAt!),NaN,Infinity,at+.5])expect(()=>check(f.job,approval,now)).toThrow("late");
  expect(()=>check(f.job,{...approval,decision:"changes_requested"})).toThrow("decision");
  const changed=structuredClone(f.job);changed.output!.mp4Path=`${f.job.projectId}/${f.job.id}/alternate.mp4`;
  expect(()=>check(changed)).toThrow("decision");
  const changedPlan=structuredClone(finalInput.currentFilm);changedPlan.materialization.requestedFrames++;
  expect(()=>check(f.job,approval,at,changedPlan)).toThrow();
  let reads=0;const accessed=structuredClone(approval);
  Object.defineProperty(accessed,"note",{enumerable:true,get(){reads++;return approval.note;}});
  expect(()=>check(f.job,accessed)).toThrow("portable");expect(reads).toBe(0);
  expect(()=>check()).not.toThrow();
},90000);
