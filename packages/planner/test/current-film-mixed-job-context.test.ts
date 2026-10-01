import {afterAll,beforeAll,expect,test} from "bun:test";
import {currentFilmSourceFixture} from "./current-film-source.fixture";
import {compileCurrentFilmMixedJob} from "../src/current-film-mixed-jobs";
import {compileCurrentFilmOrigins} from "../src/current-film-origins";
import {createCurrentFilmMixedCheckpoint} from "../src/current-film-mixed-context";
import {createCurrentFilmMixedAssemblyClock} from "../src/current-film-mixed-clock";
import {advanceCurrentFilmOrigins,assertCurrentFilmMixedAdmission,assertCurrentFilmMixedHeldInputs,createCurrentFilmMixedOutput,currentFilmMixedRecordedFiles,validateCurrentFilmMixedJob,validateCurrentFilmMixedOutput,type CurrentFilmMixedJob,type CurrentFilmMixedJobInput} from "../src/current-film-mixed-job-context";
import {bindOriginalEditSource} from "../src/edit-jobs";
import {compileCurrentFilmJob} from "../src/current-film-jobs";
import {createProviderPlan} from "../../generator/src/catalog";
import {createCurrentFilmPreviewReview} from "../src/current-film-job-context";
import {assertCurrentFilmMixedPreviewApproval,createCurrentFilmMixedPreviewReview,validateCurrentFilmMixedPreviewReview,type CurrentFilmMixedApproval} from "../src/current-film-mixed-job-context";
import {currentFilmRuntimeMode,currentFilmV3HeldJob,assertCurrentFilmRuntimeHeldInputs} from "../src/current-film-runtime-context";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,input:CurrentFilmMixedJobInput,started:CurrentFilmMixedJob,completed:CurrentFilmMixedJob;
beforeAll(async()=>{
  f=await currentFilmSourceFixture();const p=compileCurrentFilmMixedJob(f.plan,{origins:[],choices:[]});
  input={id:f.job.id,projectId:p.projectId,idempotencyKey:"mixed-request",tier:p.render.tier,stage:p.render.stage,scriptVersion:p.materialization.script.version,
    scriptText:p.materialization.script.text,casting:p.target.state.casting.candidate!,providerPlan:p.render.providerPlan,currentFilm:p,rightsAttestedAt:f.project.rightsAttestedAt,
    animaticJobId:null,animaticApprovedAt:null,totalFrames:p.materialization.requestedFrames,costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:300000};
  // Authentic V2 records/probe provide historical facts for V3 envelope tests.
  // This conversion is a format fixture, not evidence of an activated V3 worker.
  const {currentFilm:_old,currentFilmCheckpoint:_checkpoint,output:_output,...base}=f.job;
  started={...base,...input,status:"running",completedAt:null,linkExpiresAt:null,checkpointShots:0,checkpointFrame:0};
  started.currentFilmOrigins=compileCurrentFilmOrigins(p,started.id);
  const rows=f.job.currentFilmCheckpoint!.rows.map(row=>({kind:"generated" as const,...row}));
  completed={...started,currentFilmCheckpoint:createCurrentFilmMixedCheckpoint(started,rows),checkpointShots:rows.length,checkpointFrame:f.job.checkpointFrame};
  const original=f.job.output!.currentFilm!.assembly;
  const clock=createCurrentFilmMixedAssemblyClock(completed,completed.currentFilmCheckpoint!,{sourceFrames:original.spans.map(span=>span.frames),
    effectiveOverlapFrames:original.effectiveOverlapFrames,reason:original.reason,probe:original.probe,video:original.video,captions:{srt:original.captions.srt,vtt:original.captions.vtt}});
  const {mp4Path,hlsPlaylistPath,captionsPath,manifestPath}=f.job.output!;
  completed.output={mp4Path,hlsPlaylistPath,captionsPath,manifestPath,currentFilm:createCurrentFilmMixedOutput(completed,clock)};
},180000);
afterAll(async()=>{await f?.close();});

test("complete V3 request and output bind authentic frame facts, exact journal and prepared-original metadata",()=>{
  expect(()=>assertCurrentFilmMixedAdmission(input,undefined,Date.now())).not.toThrow();
  expect(()=>assertCurrentFilmMixedAdmission({...input,id:"retry-request-owner"},started,Date.now())).not.toThrow();
  expect(validateCurrentFilmMixedJob(started)).toEqual(input.currentFilm);
  expect(advanceCurrentFilmOrigins(started,started.currentFilmOrigins!)).toEqual(started.currentFilmOrigins!);
  expect(()=>validateCurrentFilmMixedOutput(completed,completed.output!)).not.toThrow();
  const files=currentFilmMixedRecordedFiles(completed);
  expect(files).toContainEqual({path:completed.output!.mp4Path,...completed.output!.currentFilm.assembly.video});
  expect(files).toContainEqual({path:completed.output!.captionsPath.slice(0,-4)+".srt",...completed.output!.currentFilm.assembly.captions.srt});
  expect(files.filter(file=>file.path.includes("/clips/"))).toHaveLength(f.job.currentFilmCheckpoint!.rows.flatMap(row=>Object.values(row.record.files)).length);
},90000);

test("V3 admission and held input checks reject forged progress and changed request mirrors",()=>{
  for(const key of ["currentFilmOrigins","currentFilmCheckpoint","output","routeDecisions"]){
    expect(()=>assertCurrentFilmMixedAdmission({...input,[key]:undefined})).toThrow("cannot supply");
  }
  for(const routeDecisions of [undefined,[],[{id:"forged"}],"malformed"]){
    const forged={...input,routeDecisions} as unknown as CurrentFilmMixedJobInput;
    expect(()=>assertCurrentFilmMixedAdmission(forged)).toThrow("cannot supply");
    expect(()=>assertCurrentFilmMixedAdmission(forged,started)).toThrow("cannot supply");
  }
  for(const modify of [
    (job:CurrentFilmMixedJobInput)=>{job.scriptText+="\nChanged";},
    (job:CurrentFilmMixedJobInput)=>{job.totalFrames++;},
    (job:CurrentFilmMixedJobInput)=>{job.retryPolicy.maxRetries=-1;},
    (job:CurrentFilmMixedJobInput)=>{job.timeoutMs=0;},
    (job:CurrentFilmMixedJobInput)=>{job.budgetReservedUsd=6;},
    (job:CurrentFilmMixedJobInput)=>{job.animaticJobId="unreviewed-final";},
    (job:CurrentFilmMixedJobInput)=>{job.currentFilm.selection.reverse();},
  ]){const changed=structuredClone(input);modify(changed);expect(()=>assertCurrentFilmMixedAdmission(changed)).toThrow();}
  expect(()=>assertCurrentFilmMixedHeldInputs(started,{...started,timeoutMs:started.timeoutMs+1})).toThrow("admitted job");
  expect(()=>assertCurrentFilmMixedAdmission({...input,timeoutMs:input.timeoutMs+1},started)).toThrow("different admitted");
  expect(()=>validateCurrentFilmMixedJob({...started,startedAt:"2000-01-01T00:00:00.000Z"})).toThrow("precede");
  expect(()=>validateCurrentFilmMixedJob({...started,executionCheckpoints:[]})).toThrow("another job mode");
},90000);

test("historical job cache rechecks content, descriptors and caller time and returns isolated plans",()=>{
  const replay=structuredClone(started),created=Date.parse(replay.currentFilm.createdAt);
  validateCurrentFilmMixedJob(replay,created);
  const returned=validateCurrentFilmMixedJob(replay,created);returned.selection.reverse();
  expect(validateCurrentFilmMixedJob(replay,created)).toEqual(started.currentFilm);
  expect(()=>validateCurrentFilmMixedJob(replay,created-1)).toThrow("precede");
  replay.timeoutMs=0;expect(()=>validateCurrentFilmMixedJob(replay,created)).toThrow("timeout");
  replay.timeoutMs=started.timeoutMs;validateCurrentFilmMixedJob(replay,created);
  let reads=0;Object.defineProperty(replay,"timeoutMs",{enumerable:true,get(){reads++;return started.timeoutMs;}});
  expect(()=>validateCurrentFilmMixedJob(replay,created)).toThrow("portable");expect(reads).toBe(0);
  const hidden=structuredClone(started);Object.defineProperty(hidden,"unreviewed",{value:undefined,enumerable:false});
  expect(()=>validateCurrentFilmMixedJob(hidden,created)).toThrow("portable");
},90000);

test("held comparison exposes no plan and still validates both complete cached envelopes",()=>{
  const current=structuredClone(started),claimed=structuredClone(started);
  validateCurrentFilmMixedJob(current);validateCurrentFilmMixedJob(claimed);
  expect(assertCurrentFilmMixedHeldInputs(current,claimed)).toBeUndefined();
  const first=validateCurrentFilmMixedJob(current),second=validateCurrentFilmMixedJob(current);
  expect(first).not.toBe(current.currentFilm);expect(second).not.toBe(first);
  expect(first.materialization).not.toBe(current.currentFilm.materialization);
  first.selection[0]!.inputRevision="a".repeat(64);second.materialization.slots[0]!.inputRevision="b".repeat(64);
  expect(current.currentFilm).toEqual(started.currentFilm);
  expect(assertCurrentFilmMixedHeldInputs(current,claimed)).toBeUndefined();
  expect(validateCurrentFilmMixedJob(current)).toEqual(started.currentFilm);

  const omitted=structuredClone(current);Object.defineProperty(omitted,"currentFilmProof",{value:undefined,enumerable:true});
  expect(JSON.stringify(omitted)).toBe(JSON.stringify(current));
  for(const pair of [[omitted,claimed],[current,omitted]] as const)
    expect(()=>assertCurrentFilmMixedHeldInputs(...pair)).toThrow("prepared-proof");
  // The existing explicit optional provider field remains valid; the optimization
  // must preserve its distinction from an injected own-undefined proof marker.
  expect(()=>assertCurrentFilmMixedHeldInputs({...current,providerSpec:undefined},claimed)).not.toThrow();

  let reads=0;const getter=structuredClone(current);
  Object.defineProperty(getter.retryPolicy,"maxRetries",{enumerable:true,get(){reads++;return current.retryPolicy.maxRetries;}});
  const hidden=structuredClone(current);Object.defineProperty(hidden,"leaseExpiresAt",{value:hidden.leaseExpiresAt,enumerable:false});
  const changed=structuredClone(current);changed.currentFilm.selection[0]!.inputRevision="c".repeat(64);
  expect(changed.currentFilm.revision).toBe(current.currentFilm.revision);
  for(const invalid of [getter,hidden,changed]){
    expect(()=>assertCurrentFilmMixedHeldInputs(invalid,claimed)).toThrow();
    expect(()=>assertCurrentFilmMixedHeldInputs(current,invalid)).toThrow();
  }
  expect(reads).toBe(0);
  expect(current).toEqual(started);expect(claimed).toEqual(started);
},90000);

test("submitted comparison uses only fully validated plan seals and rejects changed valid plans",()=>{
  const {currentFilmOrigins:_origins,...unprepared}=started,original:CurrentFilmMixedJob={...unprepared,id:"mixed-comparison-owner"};
  const request={...input,id:original.id};
  // Warm both exact-content validators before modifying a nested plan while
  // retaining the old seal; neither held nor retry comparison may trust it.
  expect(()=>assertCurrentFilmMixedHeldInputs(original,structuredClone(original))).not.toThrow();
  expect(()=>assertCurrentFilmMixedAdmission(request,original)).not.toThrow();
  const altered=structuredClone(original);altered.currentFilm.selection[0]!.inputRevision="f".repeat(64);
  expect(altered.currentFilm.revision).toBe(original.currentFilm.revision);
  expect(()=>assertCurrentFilmMixedHeldInputs(original,altered)).toThrow();
  expect(()=>assertCurrentFilmMixedHeldInputs(altered,original)).toThrow();
  expect(()=>assertCurrentFilmMixedAdmission({...request,currentFilm:altered.currentFilm},original)).toThrow();
  expect(()=>assertCurrentFilmMixedAdmission(request,altered)).toThrow();
  const ordinal=1,slot=f.plan.materialization.slots[ordinal]!,row=f.job.currentFilmCheckpoint!.rows[ordinal]!;
  const changedPlan=compileCurrentFilmMixedJob(f.plan,{origins:[bindOriginalEditSource(f.receipt)],choices:[{ordinal,inputRevision:slot.inputRevision,originId:f.receipt.revision,
    source:{receiptRevision:f.receipt.revision,ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:row.record.revision}}]});
  const changed={...original,currentFilm:changedPlan},changedRequest={...request,currentFilm:changedPlan};
  expect(validateCurrentFilmMixedJob(changed)).toEqual(changedPlan);expect(validateCurrentFilmMixedJob(changedRequest)).toEqual(changedPlan);
  expect(changedPlan.revision).not.toBe(original.currentFilm.revision);
  expect(()=>assertCurrentFilmMixedHeldInputs(original,changed)).toThrow("admitted job");
  expect(()=>assertCurrentFilmMixedAdmission(changedRequest,original)).toThrow("different admitted");
  expect(()=>assertCurrentFilmMixedAdmission(request,changed)).toThrow("different admitted");
  for(const update of [{costCapUsd:6},{timeoutMs:original.timeoutMs+1},{retryPolicy:{...original.retryPolicy,backoffMs:1}},{idempotencyKey:"different-request"}]){
    const claim={...original,...update};expect(()=>validateCurrentFilmMixedJob(claim)).not.toThrow();
    expect(()=>assertCurrentFilmMixedHeldInputs(original,claim)).toThrow("admitted job");
    expect(()=>assertCurrentFilmMixedAdmission({...request,...update},original)).toThrow("different admitted");
  }
},90000);

test("runtime held views reject version changes, mismatched siblings and hostile markers before field reads",()=>{
  expect(currentFilmRuntimeMode(f.job)).toBe("v2");expect(currentFilmRuntimeMode(started)).toBe("v3");
  expect(currentFilmV3HeldJob(started,structuredClone(started))).toBe(started);
  expect(()=>currentFilmV3HeldJob(started,f.job)).toThrow("version changed");
  expect(()=>assertCurrentFilmRuntimeHeldInputs(started,f.job)).toThrow("version changed");
  expect(()=>currentFilmV3HeldJob({...started,costCapUsd:6},started)).toThrow("admitted job");
  expect(()=>currentFilmRuntimeMode({...started,currentFilmCheckpoint:f.job.currentFilmCheckpoint})).toThrow("version-three");
  expect(()=>currentFilmRuntimeMode({...started,output:f.job.output})).toThrow("version-three");
  let reads=0;const hostile=structuredClone(started);
  Object.defineProperty(hostile.currentFilm,"schema",{enumerable:true,get(){reads++;return "hv-current-film-job/3";}});
  expect(()=>currentFilmV3HeldJob(hostile,started)).toThrow("accessors");expect(reads).toBe(0);
  for(const check of [currentFilmV3HeldJob,assertCurrentFilmRuntimeHeldInputs]){
    expect(()=>check({...started,currentFilmCheckpoint:f.job.currentFilmCheckpoint},started)).toThrow("version-three");
    expect(()=>check(started,{...started,output:f.job.output})).toThrow("version-three");
    const nested=structuredClone(started);
    Object.defineProperty(nested.retryPolicy,"maxRetries",{enumerable:true,get(){reads++;return 0;}});
    expect(()=>check(nested,started)).toThrow("portable");expect(reads).toBe(0);
    expect(()=>check(started,nested)).toThrow("portable");expect(reads).toBe(0);
    const hidden=structuredClone(started);Object.defineProperty(hidden,"unreviewed",{value:undefined,enumerable:false});
    expect(()=>check(hidden,started)).toThrow("portable");
  }
},90000);

test("mixed output cannot omit prepared origins, alter counts, lose journal custody or replace output identities",()=>{
  for(const modify of [
    (job:CurrentFilmMixedJob)=>{delete job.currentFilmOrigins;},
    (job:CurrentFilmMixedJob)=>{delete job.currentFilmCheckpoint;},
    (job:CurrentFilmMixedJob)=>{job.checkpointFrame++;},
    (job:CurrentFilmMixedJob)=>{job.routeDecisions=[];},
    (job:CurrentFilmMixedJob)=>{job.output!.currentFilm.originsRevision="a".repeat(64);},
    (job:CurrentFilmMixedJob)=>{job.output!.mp4Path="other-project/other-job/video.mp4";},
    (job:CurrentFilmMixedJob)=>{job.output!.shotRenders=[];},
    (job:CurrentFilmMixedJob)=>{job.output!.storyboard=[{shotId:"other",path:"other-project/secret.png",caption:"forged"}];},
    (job:CurrentFilmMixedJob)=>{job.output!.picturePerformances=[];},
    (job:CurrentFilmMixedJob)=>{job.output!.cameraPathRenders=[];},
    (job:CurrentFilmMixedJob)=>{job.output!.frameAnchorRenders=[];},
    (job:CurrentFilmMixedJob)=>{job.output!.currentFilm.degradedShots=["other-shot"];},
    (job:CurrentFilmMixedJob)=>{job.output!.currentFilm.degradedShots=[job.currentFilm.selection[0]!.renderId,job.currentFilm.selection[0]!.renderId];},
  ]){const changed=structuredClone(completed);modify(changed);expect(()=>validateCurrentFilmMixedOutput(changed,changed.output!)).toThrow();}
  const isolated=currentFilmMixedRecordedFiles(completed);isolated[0]!.path="changed-return-copy";
  expect(currentFilmMixedRecordedFiles(completed)[0]!.path).not.toBe("changed-return-copy");
},90000);

/** HV-031-15: a signed mixed export's sidecar is an owned output, and it sits beside its own record. */
test("mixed output accepts a C2PA sidecar beside its record and refuses one anywhere else",()=>{
  const beside=structuredClone(completed);beside.output!.c2paPath=beside.output!.manifestPath.slice(0,-"provenance.json".length)+"provenance.c2pa";
  expect(()=>validateCurrentFilmMixedOutput(beside,beside.output!)).not.toThrow();
  for(const path of [beside.output!.manifestPath.slice(0,-"provenance.json".length)+"other.c2pa","other-project/other-job/provenance.c2pa",beside.output!.manifestPath]){
    const changed=structuredClone(beside);changed.output!.c2paPath=path;expect(()=>validateCurrentFilmMixedOutput(changed,changed.output!)).toThrow();
  }
});

test("mixed final approval binds explicit V2 or V3 completed previews and rejects changed decisions",()=>{
  const preview:CurrentFilmMixedJob={...completed,status:"done",completedAt:f.job.completedAt,linkExpiresAt:f.job.linkExpiresAt};
  const review=createCurrentFilmMixedPreviewReview(preview);
  expect(validateCurrentFilmMixedPreviewReview(preview,review)).toEqual(review);
  const finalPlan=compileCurrentFilmMixedJob(compileCurrentFilmJob(f.saved.library,f.plan.selector,{role:"render",tier:"free",providerPlan:createProviderPlan("final",5,undefined,{...process.env,HV_PROVIDER_POOL:'["mock"]'})}),{origins:[],choices:[]});
  const at=new Date().toISOString(),cast=finalPlan.target.state.casting.candidate!,direction=finalPlan.library.origin!.request.baseline.direction;
  const final:CurrentFilmMixedJobInput={...input,id:"mixed-final-approved",currentFilm:finalPlan,stage:"final",providerPlan:finalPlan.render.providerPlan,
    totalFrames:finalPlan.materialization.requestedFrames,animaticJobId:preview.id,animaticApprovedAt:at};
  const approval:CurrentFilmMixedApproval={animaticJobId:preview.id,scriptVersion:final.scriptVersion,decision:"approved",note:"Fixture decision",at,
    castingVersion:cast.version,castingRevision:cast.revision,directionVersion:direction.version,directionRevision:direction.revision,currentFilmReview:review};
  expect(()=>assertCurrentFilmMixedPreviewApproval(final,preview,approval)).not.toThrow();
  expect(()=>assertCurrentFilmMixedPreviewApproval(final,f.job,{...approval,currentFilmReview:createCurrentFilmPreviewReview(f.job)})).not.toThrow();
  expect(()=>validateCurrentFilmMixedPreviewReview(preview,{...review,outputRevision:"a".repeat(64)})).toThrow("changed");
  expect(()=>createCurrentFilmMixedPreviewReview({...preview,status:"running"})).toThrow("completed");
  for(const change of [
    {currentFilmReview:createCurrentFilmPreviewReview(f.job)},
    {decision:"changes_requested" as const},
    {castingRevision:"a".repeat(64)},
    {directionRevision:"a".repeat(64)},
    {takeRevision:"a".repeat(64)},
    {at:new Date(Date.parse(at)+1000).toISOString()},
  ])expect(()=>assertCurrentFilmMixedPreviewApproval(final,preview,{...approval,...change})).toThrow();
  expect(()=>assertCurrentFilmMixedPreviewApproval(final,preview,approval,Date.parse(preview.linkExpiresAt!))).toThrow("expired");
  expect(()=>assertCurrentFilmMixedPreviewApproval({...final,animaticJobId:"other-preview"},preview,approval)).toThrow("target");
},120000);

test("direct source inventory is required before any reused progress and includes the entire original film",()=>{
  const ordinal=1,slot=f.plan.materialization.slots[ordinal]!,row=f.job.currentFilmCheckpoint!.rows[ordinal]!;
  const plan=compileCurrentFilmMixedJob(f.plan,{origins:[bindOriginalEditSource(f.receipt)],choices:[{ordinal,inputRevision:slot.inputRevision,originId:f.receipt.revision,
    source:{receiptRevision:f.receipt.revision,ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:row.record.revision}}]});
  const {currentFilmOrigins:_origins,...base}=started,job:CurrentFilmMixedJob={...base,id:"mixed-source-owner",currentFilm:plan};
  expect(()=>validateCurrentFilmMixedJob(job)).not.toThrow();expect(()=>currentFilmMixedRecordedFiles(job)).toThrow("original inventory");
  job.currentFilmOrigins=advanceCurrentFilmOrigins(job,compileCurrentFilmOrigins(plan,job.id));
  expect(currentFilmMixedRecordedFiles(job)).toHaveLength(f.receipt.files.length);
  expect(currentFilmMixedRecordedFiles(job).some(file=>file.path.endsWith(f.job.output!.manifestPath))).toBe(true);
  expect(()=>validateCurrentFilmMixedJob({...job,id:f.job.id})).toThrow("independent");
  let reads=0;const hostile=structuredClone(job);Object.defineProperty(hostile,"currentFilmOrigins",{enumerable:true,get(){reads++;return job.currentFilmOrigins;}});
  expect(()=>validateCurrentFilmMixedJob(hostile)).toThrow("portable");expect(reads).toBe(0);
},90000);
