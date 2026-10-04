import {afterAll,expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {mkdirSync,mkdtempSync,readFileSync,rmSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ProjectService} from "../../api/src/index";
import {DurableJobStore,type JobInput} from "../../queue/src/index";
import {DeterministicMockProvider} from "../../generator/src/index";
import {renderHeroChain,sealHeroJob} from "../../generator/src/hero-chain";
import {contentHash} from "../../generator/src/capabilities";
import {heroChainRequests,heroJobPlan,heroShotBinding,heroTotalFrames,type HeroDeliveryOutput} from "../../planner/src/hero-chain";
import {stateSnapshotSchema,validateSnapshot,type StateSnapshot} from "../src/snapshots";

/**
 * HV-019-15: a finished hero render survives the job store and a state snapshot as the deliverable
 * it is -- checkpointed and completed once, recovered at the delivery tiers, and refused when its
 * chain was edited.
 */
const ROOT=mkdtempSync(join(tmpdir(),"hv-hero-recovery-"));
afterAll(()=>rmSync(ROOT,{recursive:true,force:true}));

test("a hero render is checkpointed, completed and recovered as a deliverable, and an edited chain is refused",async()=>{
  process.env.HV_TOKEN_SECRET="hero-recovery-fixture-secret-with-at-least-thirty-two";
  const projects=new ProjectService(),owner=projects.createAnonymousProject();
  projects.editScript(owner.token,"EXT. GARDEN - DAY\n\nLeaves turn.");projects.attestRights(owner.token);
  const project=projects.snapshot().projects[0]!,filmId=crypto.randomUUID(),artifacts=join(ROOT,"artifacts"),work=join(artifacts,".work");
  const relative=owner.projectId+"/"+filmId+"/clips/shot-1-1.mp4",clip=join(artifacts,relative);
  mkdirSync(join(artifacts,owner.projectId,filmId,"clips"),{recursive:true});mkdirSync(work,{recursive:true});
  await new DeterministicMockProvider().generate("Leaves turn.",3,{seed:3,widthxheight:"320x180",fps:30,durationSec:1},clip);
  const binding=heroShotBinding({storage:"local",source:{projectId:owner.projectId,jobId:filmId,stage:"final",outputRevision:"a".repeat(64),shotId:"shot-1-1"},
    shot:{renderRevision:"b".repeat(64),inputHash:"c".repeat(64),provider:"mock",model:"mock-deterministic-v1",durationSec:1,
      video:{path:relative,sha256:createHash("sha256").update(readFileSync(clip)).digest("hex"),bytes:statSync(clip).size}}});
  const plan=heroJobPlan(binding,heroChainRequests({fps:60,height:720}));
  const input:JobInput={id:crypto.randomUUID(),projectId:owner.projectId,idempotencyKey:plan.idempotencyKey,tier:"free",stage:"delivery",scriptVersion:0,scriptText:"",
    rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:heroTotalFrames(plan),costCapUsd:0,budgetReservedUsd:0,
    retryPolicy:{maxRetries:2,backoffMs:1000},timeoutMs:1_800_000,delivery:plan};
  const noop=async()=>{};
  const made=await sealHeroJob(input,artifacts,await renderHeroChain(input,clip,artifacts,work,noop),noop);

  const store=DurableJobStore.fromJobs([]);store.enqueue(input);store.claimNext(Date.now(),{},{workerId:"hero-worker"});
  store.checkpointDelivery(input.id,"hero-worker",made);
  expect(store.get(input.id)!.checkpointFrame).toBe(60);
  // The checkpoint is the whole render, immutable once taken.
  const other={...made,revision:"0".repeat(64)} as HeroDeliveryOutput;
  expect(()=>store.checkpointDelivery(input.id,"hero-worker",other)).toThrow();
  const done=store.completeDelivery(input.id,"hero-worker",made);
  expect({status:done.status,costUsd:done.costUsd}).toEqual({status:"done",costUsd:0});

  // Recovered at the tier that knows a deliverable's measurement, and refused by an older reader.
  const jobs=store.all(),state=projects.snapshot();
  expect(stateSnapshotSchema(state,jobs)).toBe("hv-state/15");
  const snapshot:StateSnapshot={schema:"hv-state/15",projects:state,jobs,ledger:{events:[],reservations:[]},reviews:[]};
  expect(()=>validateSnapshot(snapshot)).not.toThrow();
  expect(()=>validateSnapshot({...snapshot,schema:"hv-state/13"})).toThrow("requires state schema 15");
  // A chain whose stage was edited -- even under fresh revisions -- does not load.
  const edited=structuredClone(made);edited.chain.stages[1]!.filter="minterpolate=fps=60";
  const {revision:_s,...stage}=edited.chain.stages[1]!;edited.chain.stages[1]!.revision=contentHash(stage);
  const {revision:_c,...chain}=edited.chain;edited.chain.revision=contentHash(chain);
  const {revision:_o,...output}=edited;edited.revision=contentHash(output);
  const tampered=jobs.map(job=>job.id===input.id?{...job,deliveryCheckpoint:edited,deliveryOutput:edited}:job);
  expect(()=>validateSnapshot({...snapshot,jobs:tampered})).toThrow("names a filter its plan does not derive");
},120_000);
