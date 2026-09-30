import {afterAll,beforeAll,expect,spyOn,test} from "bun:test";
import {readFileSync,writeFileSync} from "node:fs";
import {currentFilmSourceFixture} from "../../planner/test/current-film-source.fixture";
import {compileCurrentFilmMixedJob,type CurrentFilmJobV3} from "../../planner/src/current-film-mixed-jobs";
import {compileCurrentFilmJob} from "../../planner/src/current-film-jobs";
import {createCurrentFilmPreviewReview} from "../../planner/src/current-film-job-context";
import {createCurrentFilmMixedPreviewReview,type CurrentFilmMixedJob,type CurrentFilmMixedPreviewReview} from "../../planner/src/current-film-mixed-job-context";
import {currentFilmV3Job} from "../../planner/src/current-film-runtime-context";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {editOriginalJob} from "../../planner/src/edit-sources";
import {DELIVERY_KINDS} from "../../planner/src/delivery-jobs";
import {createProviderPlan} from "../../generator/src/catalog";
import {RoutedGenerator} from "../../generator/src/router";
import {verifyCurrentFilmMixedMedia} from "../src/current-film-mixed-media";
import {DurableJobStore,type Job,type JobInput} from "../src/index";
import {processNextJob} from "../src/worker";

/**
 * HV-016-31: the owner's decision on a mixed preview, taken through the API's project service,
 * is the one a mixed final consumes. Everything here is the real local path: the preview and the
 * final are rendered by the worker with mock providers, and the delivery refusal is read back from
 * the running API server.
 */
let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,store:DurableJobStore,preview:CurrentFilmMixedJob,review:CurrentFilmMixedPreviewReview,final:CurrentFilmMixedJob|undefined;
let changesRequestedAt:string;
const pool=process.env.HV_PROVIDER_POOL;

function input(id:string,plan:CurrentFilmJobV3,overrides:Partial<JobInput>={}):JobInput {
  return {id,projectId:plan.projectId,idempotencyKey:id,tier:plan.render.tier,stage:plan.render.stage,scriptVersion:plan.materialization.script.version,
    scriptText:plan.materialization.script.text,casting:plan.target.state.casting.candidate!,providerPlan:plan.render.providerPlan,currentFilm:plan,
    rightsAttestedAt:f.project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:plan.materialization.requestedFrames,
    costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:600000,...overrides};
}
/** An all-fresh mixed final of the preview's exact target, as the PostgreSQL lifecycle admits it. */
function finalPlan():CurrentFilmJobV3 {
  const base=compileCurrentFilmJob(f.saved.library,f.plan.selector,{role:"render",tier:"free",providerPlan:createProviderPlan("final",5,undefined,{...process.env,HV_PROVIDER_POOL:'["mock"]'})});
  return compileCurrentFilmMixedJob(base,{origins:[],choices:[]});
}

beforeAll(async()=>{
  process.env.HV_PROVIDER_POOL='["mock"]';
  f=await currentFilmSourceFixture();
  const ordinal=f.job.currentFilmCheckpoint!.rows.findIndex(row=>Boolean(row.record.clip.speech));
  if(ordinal<0)throw new Error("The mixed approval fixture needs a native speech source.");
  const slot=f.plan.materialization.slots[ordinal]!,record=f.job.currentFilmCheckpoint!.rows[ordinal]!.record;
  const plan=compileCurrentFilmMixedJob(f.plan,{origins:[bindOriginalEditSource(f.receipt)],choices:[{ordinal,inputRevision:slot.inputRevision,originId:f.receipt.revision,
    source:{receiptRevision:f.receipt.revision,ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:record.revision}}]});
  store=DurableJobStore.fromJobs(f.store.all());store.enqueue(input("mixed-approval-preview",plan));
  const done=await processNextJob(store,f.studio.paths.artifactRoot,f.context);
  if(done?.status!=="done")throw new Error("The mixed approval preview failed: "+(done?.failureReason??done?.cancelReason));
  preview=currentFilmV3Job(done);review=createCurrentFilmMixedPreviewReview(preview);
},900000);
afterAll(async()=>{if(pool===undefined)delete process.env.HV_PROVIDER_POOL;else process.env.HV_PROVIDER_POOL=pool;await f?.close();});

test("the API records an exact mixed preview decision, replays it, and refuses a changed or wrongly shaped review",async()=>{
  const token=f.studio.owner.token,approvals=()=>f.projects.snapshot().projects.find(value=>value.id===preview.projectId)!.animaticApprovals.length;
  expect(review.schema).toBe("hv-current-film-preview-review/3");expect(review.jobId).toBe(preview.id);
  // A review opened on other output, or a version-two review of a mixed preview, is refused before anything is saved.
  const before=approvals();
  expect(()=>f.projects.recordCurrentFilmDecision(token,preview,{...review,outputRevision:"0".repeat(64)},"approved","")).toThrow(/mixed current-film preview changed/);
  expect(()=>f.projects.recordCurrentFilmDecision(token,preview,createCurrentFilmPreviewReview(f.job) as never,"approved","")).toThrow();
  expect(f.projects.recordCurrentFilmDecision("not-a-token",preview,review,"approved","")).toBeNull();
  expect(approvals()).toBe(before);
  const rejected=f.projects.recordCurrentFilmDecision(token,preview,review,"changes_requested","Another pass on the lantern")!;
  expect(rejected.replayed).toBe(false);expect(rejected.approval.currentFilmReview).toEqual(review);expect(rejected.approval.decision).toBe("changes_requested");
  expect(approvals()).toBe(before+1);changesRequestedAt=rejected.approval.at;
  // The same decision again is the same saved decision, not a second one.
  const replay=f.projects.recordCurrentFilmDecision(token,preview,review,"changes_requested","Another pass on the lantern")!;
  expect(replay.replayed).toBe(true);expect(replay.approval).toEqual(rejected.approval);expect(approvals()).toBe(before+1);
},120000);

test("a mixed final on a changes-requested decision is refused before any proof, original copy or dispatch",async()=>{
  expect(changesRequestedAt).toBeDefined();
  const generate=spyOn(RoutedGenerator.prototype,"generate");
  try{
    store.enqueue(input("mixed-approval-final-refused",finalPlan(),{animaticJobId:preview.id,animaticApprovedAt:changesRequestedAt}));
    const refused=(await processNextJob(store,f.studio.paths.artifactRoot,f.context))!;
    expect(refused.id).toBe("mixed-approval-final-refused");expect(refused.status).toBe("failed");
    expect(refused.failureReason).toMatch(/exact mixed current-film preview decision/);
    expect(generate).not.toHaveBeenCalled();expect(refused.currentFilmProof).toBeUndefined();expect(refused.currentFilmOrigins).toBeUndefined();
  }finally{generate.mockRestore();}
},600000);

test("an approval taken through the API runs the mixed final, which keeps the reviewed preview as its proof",async()=>{
  await Bun.sleep(5);
  const approved=f.projects.recordCurrentFilmDecision(f.studio.owner.token,preview,review,"approved","Use this mixed preview")!;
  expect(approved.replayed).toBe(false);expect(approved.approval.decision).toBe("approved");
  // Slow by design: the final's proof keeps the mixed preview, and every verification of the final
  // re-verifies that preview and its own proof. About 30 minutes on a loaded 2-core host.
  store.enqueue(input("mixed-approval-final",finalPlan(),{timeoutMs:3000000,animaticJobId:preview.id,animaticApprovedAt:approved.approval.at}));
  const done=(await processNextJob(store,f.studio.paths.artifactRoot,f.context))!;
  expect(done.failureReason??done.cancelReason).toBeUndefined();expect(done.status).toBe("done");
  final=currentFilmV3Job(done);
  expect(final.stage).toBe("final");expect(final.currentFilmCheckpoint!.rows.every(row=>row.kind==="generated")).toBe(true);
  const target=final.currentFilmProof!.specification.target;
  expect(target?.animaticJobId).toBe(preview.id);expect(target?.animaticApprovedAt).toBe(approved.approval.at);
  expect(final.currentFilmProof!.specification.previews.some(value=>value.jobId===preview.id)).toBe(true);
  expect(final.output!.currentFilm.schema).toBe("hv-current-film-output/3");expect(final.costUsd).toBe(0);
  await verifyCurrentFilmMixedMedia(final,f.studio.paths.artifactRoot,async()=>{});
},3100000);

test("the running API hides a finished mixed film's custody and refuses it by name for delivery and editing",async()=>{
  expect(final?.status).toBe("done");const film=final!,path=f.studio.paths.queuePath,saved=readFileSync(path);
  // Put the real finished final in front of the running API server, beside the studio's own film.
  writeFileSync(path,JSON.stringify([...JSON.parse(saved.toString("utf8")) as Job[],film]));
  try{
    const base="/api/projects/"+film.projectId,token=f.studio.owner.token;
    const view=await f.studio.call("/api/jobs/"+film.id,"GET",undefined,token);expect(view.status).toBe(200);
    const text=await view.text();
    for(const forbidden of ['"currentFilmOrigins"','"currentFilmProof"','"currentFilmCheckpoint"','"hv-current-film-job/3"'])expect(text).not.toContain(forbidden);
    // Every kind, including HV-027-15's burned-caption ones, is refused by the source before its kind matters.
    const probes:[string,string|undefined][]=[["GET",undefined],...DELIVERY_KINDS.map((kind):[string,string]=>["POST",kind])];
    for(const [method,kind] of probes){
      const response=await f.studio.call(base+"/deliveries/"+film.id,method,kind?{idempotencyKey:crypto.randomUUID(),kind}:undefined,token);
      expect(response.status).toBe(409);expect(((await response.json()) as {error:string}).error).toMatch(/mixed film.*cannot be delivered from yet/);
    }
  }finally{writeFileSync(path,saved);}
  expect(()=>editOriginalJob(film as unknown as Job)).toThrow(/mixed film.*cannot be used as an editorial source/);
},120000);
