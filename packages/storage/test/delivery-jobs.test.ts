import {expect,test} from "bun:test";
import {ProjectService} from "../../api/src/index";
import {DurableJobStore,type Job,type JobInput} from "../../queue/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {deliveryBinding,deliveryFileName,deliveryJobPlan,deliveryOutputCeiling,assertDeliverySourceAvailable,
  type DeliveryBinding,type DeliveryJobPlan,type DeliveryOutput} from "../../planner/src/delivery-jobs";
import {stateSnapshotSchema,validateSnapshot,type StateSnapshot} from "../src/snapshots";

const FRAMES=900;
function studio(){
  process.env.HV_TOKEN_SECRET="delivery-fixture-secret-with-at-least-thirty-two-characters";
  const projects=new ProjectService(),owner=projects.createAnonymousProject();
  projects.editScript(owner.token,"EXT. GARDEN - DAY\n\nLeaves turn.");projects.attestRights(owner.token);
  return {projects,owner};
}
const PARTS=15,PART_BYTES=60_000_000;
const at=(path:string,bytes:number)=>({path,sha256:contentHash(path),bytes});
function binding(projectId:string,sourceJobId:string,outputRevision="d".repeat(64)):DeliveryBinding{
  const root=projectId+"/"+sourceJobId+"/export/conform";
  return deliveryBinding({storage:"local",source:{projectId,jobId:sourceJobId,stage:"picture-edit",outputRevision},
    master:at(root+"/export.mp4",4_000_000),
    files:[at(root+"/export.mp4",4_000_000),at(root+"/picture/index.ffconcat",512),at(root+"/audio/final.wav",44+FRAMES*1600*6),
      ...Array.from({length:PARTS},(_,index)=>at(root+"/picture/part-"+String(index).padStart(5,"0")+".mkv",PART_BYTES))],
    conform:{width:1920,height:1080,frames:FRAMES,pictureFramesSha256:"c".repeat(64),pictureBytes:PARTS*PART_BYTES,mixBytes:44+FRAMES*1600*6}});
}
const job=(projectId:string,rightsAttestedAt:string,plan:DeliveryJobPlan,id=crypto.randomUUID()):JobInput=>({
  id,projectId,idempotencyKey:plan.idempotencyKey,tier:"free",stage:"delivery",scriptVersion:0,scriptText:"",
  rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:FRAMES,costCapUsd:0,budgetReservedUsd:0,
  retryPolicy:{maxRetries:2,backoffMs:1000},timeoutMs:120_000,delivery:plan});
function output(target:{projectId:string;id:string},plan:DeliveryJobPlan,overrides:Partial<DeliveryOutput>={}):DeliveryOutput{
  const data={schema:"hv-delivery-output/1" as const,planRevision:plan.revision,resultRevision:"f".repeat(64),
    file:{path:target.projectId+"/"+target.id+"/"+deliveryFileName(plan),sha256:"a".repeat(64),bytes:910_000_000},
    delivered:{width:1920,height:1080,durationSec:FRAMES/30,video:"ffv1",audio:"pcm_s24le"},...overrides};
  const {revision:_ignored,...rest}=data as DeliveryOutput;
  return {...rest,revision:contentHash(rest)} as DeliveryOutput;
}

test("a deliverable is enqueued, checkpointed and completed as its own job",()=>{
  const {projects,owner}=studio(),project=projects.snapshot().projects[0]!;
  const plan=deliveryJobPlan(binding(owner.projectId,crypto.randomUUID()),"mezzanine");
  const store=DurableJobStore.fromJobs([]),input=job(owner.projectId,project.rightsAttestedAt!,plan);
  store.enqueue(input);
  const claimed=store.claimNext(Date.now(),{},{workerId:"delivery-worker"})!;
  expect(claimed.id).toBe(input.id);expect(claimed.stage).toBe("delivery");
  const made=output(input as {projectId:string;id:string},plan);
  store.checkpointDelivery(input.id,"delivery-worker",made);
  // One file means there is no partial progress: the checkpoint is the whole thing, and it is
  // immutable once taken, as every other media checkpoint is.
  expect(store.get(input.id)!.checkpointFrame).toBe(FRAMES);
  expect(()=>store.checkpointDelivery(input.id,"delivery-worker",output(input as {projectId:string;id:string},plan,{resultRevision:"0".repeat(64)})))
    .toThrow("The delivery checkpoint is immutable.");
  const done=store.completeDelivery(input.id,"delivery-worker",made);
  expect(done.status).toBe("done");expect(done.deliveryOutput).toEqual(made);expect(done.costUsd).toBe(0);
  expect(done.notifications.at(-1)).toContain("deliverable is ready");

  // Completing without the retained checkpoint is refused, as it is everywhere else.
  const second=DurableJobStore.fromJobs([]),other=job(owner.projectId,project.rightsAttestedAt!,plan);
  second.enqueue(other);second.claimNext(Date.now(),{},{workerId:"delivery-worker"});
  expect(()=>second.completeDelivery(other.id,"delivery-worker",output(other as {projectId:string;id:string},plan)))
    .toThrow("Complete the retained delivery checkpoint before publishing.");
});

test("a delivery job carries a deliverable and nothing else, and no other job carries one",()=>{
  const {projects,owner}=studio(),project=projects.snapshot().projects[0]!,rights=project.rightsAttestedAt!;
  const plan=deliveryJobPlan(binding(owner.projectId,crypto.randomUUID()),"reframe-9:16");
  const store=()=>DurableJobStore.fromJobs([]);
  // The stage and the plan are one fact stated twice, so they have to agree.
  expect(()=>store().enqueue({...job(owner.projectId,rights,plan),stage:"animatic"})).toThrow("admitted delivery plan");
  expect(()=>store().enqueue({...job(owner.projectId,rights,plan),delivery:undefined})).toThrow("admitted delivery plan");
  // It dispatches no provider, so it reserves and spends nothing.
  expect(()=>store().enqueue({...job(owner.projectId,rights,plan),costCapUsd:1})).toThrow("reserves and spends nothing");
  expect(()=>store().enqueue({...job(owner.projectId,rights,plan),budgetReservedUsd:1})).toThrow("reserves and spends nothing");
  // It is made from a finished file, so it carries no screenplay and no generation history.
  expect(()=>store().enqueue({...job(owner.projectId,rights,plan),scriptText:"EXT. GARDEN - DAY"})).toThrow("carries no screenplay");
  expect(()=>store().enqueue({...job(owner.projectId,rights,plan),animaticJobId:crypto.randomUUID()})).toThrow("carries no screenplay");
  // It runs exactly as long as the film it is made from.
  expect(()=>store().enqueue({...job(owner.projectId,rights,plan),totalFrames:FRAMES-1})).toThrow("runs exactly as long");
  // A deliverable is a new job beside the film, never the film's own job.
  const self=job(owner.projectId,rights,plan);
  expect(()=>store().enqueue({...self,delivery:deliveryJobPlan(binding(owner.projectId,self.id),"mezzanine")})).toThrow("never the film's own job");
  // It belongs to the project the film belongs to.
  const {owner:stranger}=studio();
  expect(()=>store().enqueue({...job(stranger.projectId,rights,plan)})).toThrow("inside the project the film belongs to");
  // And it retains its own single file and nothing else.
  expect(()=>store().enqueue({...job(owner.projectId,rights,plan),shotTakes:{revision:"a".repeat(64)} as never})).toThrow("its own single file");
  // No other stage's job may carry a finished deliverable.
  const made=output({projectId:owner.projectId,id:crypto.randomUUID()},plan);
  expect(()=>store().enqueue({...job(owner.projectId,rights,plan),stage:"animatic",delivery:undefined,deliveryOutput:made})).toThrow("Only a delivery job can carry a deliverable");
  expect(()=>store().enqueue({...job(owner.projectId,rights,plan),deliveryCheckpoint:made})).toThrow("cannot carry a finished deliverable");
});

test("the same deliverable of the same sealed output is the same job",()=>{
  const {projects,owner}=studio(),rights=projects.snapshot().projects[0]!.rightsAttestedAt!;
  const source=crypto.randomUUID(),plan=deliveryJobPlan(binding(owner.projectId,source),"mezzanine");
  const store=DurableJobStore.fromJobs([]),first=job(owner.projectId,rights,plan);
  store.enqueue(first);
  // Re-admitting under the same key returns the same job rather than making a second deliverable.
  expect(store.enqueue({...first,id:crypto.randomUUID()}).id).toBe(first.id);
  // A different deliverable under the same key is refused rather than silently answered with this one.
  const square=deliveryJobPlan(binding(owner.projectId,source),"reframe-1:1");
  expect(()=>store.enqueue({...job(owner.projectId,rights,square),idempotencyKey:plan.idempotencyKey})).toThrow("belongs to another deliverable");
});

test("a retained deliverable is re-derived from its plan and refused when it does not match",()=>{
  const {projects,owner}=studio(),rights=projects.snapshot().projects[0]!.rightsAttestedAt!;
  const plan=deliveryJobPlan(binding(owner.projectId,crypto.randomUUID()),"reframe-9:16");
  const store=DurableJobStore.fromJobs([]),input=job(owner.projectId,rights,plan);
  store.enqueue(input);store.claimNext(Date.now(),{},{workerId:"delivery-worker"});
  const target=input as {projectId:string;id:string};
  const reframe={width:608,height:1080,durationSec:FRAMES/30,video:"h264",audio:"aac"};
  const good=output(target,plan,{delivered:reframe,file:{path:target.projectId+"/"+target.id+"/reframe-9x16.mp4",sha256:"a".repeat(64),bytes:4_000_000}});
  store.checkpointDelivery(input.id,"delivery-worker",good);
  // A deliverable is retained under its own job and nowhere else.
  expect(()=>store.completeDelivery(input.id,"delivery-worker",output(target,plan,{delivered:reframe,file:{path:target.projectId+"/elsewhere/reframe-9x16.mp4",sha256:"a".repeat(64),bytes:1}})))
    .toThrow("retained under its own job");
  // A reframe is H.264 and AAC; a mezzanine is FFV1 and PCM. Neither may claim the other's codecs.
  expect(()=>store.completeDelivery(input.id,"delivery-worker",output(target,plan,{delivered:{...reframe,video:"ffv1"},file:good.file})))
    .toThrow("delivered as h264 and aac");
  // And it is the size the plan asked for.
  expect(()=>store.completeDelivery(input.id,"delivery-worker",output(target,plan,{delivered:{...reframe,width:1080},file:good.file})))
    .toThrow("the plan asked for 608 by 1080");
  expect(()=>store.completeDelivery(input.id,"delivery-worker",output(target,plan,{delivered:{...reframe,durationSec:2},file:good.file})))
    .toThrow("runs 2 s and the film runs 30 s");
  // The ceiling is the plan's own for a mezzanine and a fixed bound for a reframe.
  const mezzanine=deliveryJobPlan(binding(owner.projectId,crypto.randomUUID()),"mezzanine");
  expect(deliveryOutputCeiling(mezzanine)).toBe(mezzanine.mezzanine!.estimatedBytes);
  expect(deliveryOutputCeiling(plan)).toBe(8*1024**3);
});

test("the film a deliverable names is still that film, at admission",()=>{
  const projectId=crypto.randomUUID(),sourceJobId=crypto.randomUUID(),bound=binding(projectId,sourceJobId);
  const sealed={revision:bound.source.outputRevision,files:bound.files};
  const source={id:sourceJobId,projectId,stage:"picture-edit",status:"done",output:{editorial:sealed}} as unknown as Job;
  expect(()=>assertDeliverySourceAvailable(bound,source)).not.toThrow();
  expect(()=>assertDeliverySourceAvailable(bound,undefined)).toThrow("no longer available");
  expect(()=>assertDeliverySourceAvailable(bound,{...source,status:"running"} as Job)).toThrow("no longer available");
  expect(()=>assertDeliverySourceAvailable(bound,{...source,stage:"assembly-edit"} as Job)).toThrow("no longer available");
  // A film rendered again since the deliverable was planned is refused by name, not delivered from
  // the old bytes under the new film's name.
  expect(()=>assertDeliverySourceAvailable(bound,{...source,output:{editorial:{...sealed,revision:"9".repeat(64)}}} as unknown as Job))
    .toThrow("rendered again since the deliverable was planned");
  // And the master has to be in the inventory the revision vouches for.
  expect(()=>assertDeliverySourceAvailable(bound,{...source,output:{editorial:{...sealed,files:[]}}} as unknown as Job))
    .toThrow("not in the film's sealed inventory");
});

test("a snapshot holding a deliverable needs a reader that knows what one is",()=>{
  const {projects,owner}=studio(),rights=projects.snapshot().projects[0]!.rightsAttestedAt!;
  const plan=deliveryJobPlan(binding(owner.projectId,crypto.randomUUID()),"mezzanine");
  const store=DurableJobStore.fromJobs([]),input=job(owner.projectId,rights,plan);
  store.enqueue(input);store.claimNext(Date.now(),{},{workerId:"delivery-worker"});
  const made=output(input as {projectId:string;id:string},plan);
  store.checkpointDelivery(input.id,"delivery-worker",made);store.completeDelivery(input.id,"delivery-worker",made);
  const jobs=store.all(),state=projects.snapshot();
  expect(stateSnapshotSchema(state,jobs)).toBe("hv-state/14");
  const snapshot:StateSnapshot={schema:"hv-state/14",projects:state,jobs,ledger:{events:[],reservations:[]},reviews:[]};
  expect(()=>validateSnapshot(snapshot)).not.toThrow();
  // An older reader would drop the plan and the retained file from the job body and write it back
  // without them, silently turning a finished deliverable into a job that never had one.
  expect(()=>validateSnapshot({...snapshot,schema:"hv-state/13"})).toThrow("Deliverable recovery requires state schema 14");
  // A deliverable dispatches no provider, so a charge attributed to one is a charge on nothing.
  const charge={at:new Date().toISOString(),projectId:owner.projectId,jobId:input.id,shotId:"shot-1",stage:"delivery" as const,
    provider:"fixture",model:"fixture",prompt_tokens:0,output_frames:0,gpu_seconds:0,total_cost_usd:0.01};
  expect(()=>validateSnapshot({...snapshot,ledger:{events:[charge],reservations:[]}})).toThrow("Deliverables cannot carry provider charges");
});
