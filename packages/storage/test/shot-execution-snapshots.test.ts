import {afterAll,beforeAll,expect,test} from "bun:test";
import {cpSync,existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {join,sep} from "node:path";
import {tmpdir} from "node:os";
import {ProjectService} from "../../api/src/index";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {DurableJobStore,type Job} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {createProviderPlan} from "../../generator/src/catalog";
import {contentHash} from "../../generator/src/capabilities";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {createEditSequence,emptyEditLibrary} from "../../planner/src/edit-library";
import {validateShotExecutionClips,validateShotExecutionInventoryMetadata} from "../../planner/src/shot-execution-inventory";
import {readStateSnapshot,stateSnapshotSchema,validateSnapshot,writeStateSnapshot,type StateSnapshot} from "../src/snapshots";

function scratch(){const root=realpathSync(mkdtempSync(join(realpathSync(tmpdir()),"hv-execution-snapshot-")));return {root,close(){if(!root.startsWith(realpathSync(tmpdir())+sep+"hv-execution-snapshot-")||realpathSync(root)!==root)throw new Error("Unsafe execution fixture cleanup");rmSync(root,{recursive:true,force:true});}};}
const f=scratch(),media=join(f.root,"media"),prior=process.env.HV_TOKEN_SECRET;
let base:StateSnapshot,film:Job,clips:any[],source:Awaited<ReturnType<typeof inspectEditSource>>;
beforeAll(async()=>{
  process.env.HV_TOKEN_SECRET="execution-snapshot-fixture-secret-at-least-thirty-two-characters";
  const projects=new ProjectService(),owner=projects.createAnonymousProject(),script="INT. ROOM - DAY\nA lamp glows.\n\nINT. HALL - NIGHT\nA door opens.";
  projects.editScript(owner.token,script);projects.attestRights(owner.token);
  const store=DurableJobStore.fromJobs([]),ledger=new CostLedger(),reviewQueue=new OperatorReviewQueue();
  store.enqueue({id:crypto.randomUUID(),projectId:owner.projectId,idempotencyKey:"actual-execution",tier:"free",stage:"animatic",scriptVersion:1,scriptText:script,providerPlan:createProviderPlan("animatic",1,undefined,{HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0"}),totalFrames:120,costCapUsd:1,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:60000,rightsAttestedAt:new Date().toISOString(),animaticJobId:null,animaticApprovedAt:null});
  film=(await processNextJob(store,media,{projects,ledger,reviewQueue}))!;expect(film.failureReason).toBeUndefined();expect(film.status).toBe("done");
  expect(film.executionCheckpoints).toHaveLength(2);expect(film.executionCheckpoints!.every(row=>row.capture!==null)).toBe(true);expect(film.output!.shotExecutions).toEqual(film.executionCheckpoints);
  clips=JSON.parse(readFileSync(join(media,film.projectId,film.id,"clips/manifest.json"),"utf8"));validateShotExecutionClips(film,clips);
  source=await inspectEditSource(film,"Captured original",media,async()=>{});
  base={schema:"hv-state/11",projects:projects.snapshot(),jobs:[film],ledger:{events:ledger.all(),reservations:[]},reviews:reviewQueue.pending()};validateSnapshot(base);
},60000);
afterAll(()=>{f.close();if(prior===undefined)delete process.env.HV_TOKEN_SECRET;else process.env.HV_TOKEN_SECRET=prior;});
const fixture=()=>structuredClone(base);
function reordered(value:unknown):unknown{return Array.isArray(value)?value.map(reordered):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reordered(item)])):value;}
function reseal<T extends {revision:string}>(value:T):T{const {revision:_revision,...data}=value;return {...data,revision:contentHash(data)} as T;}
function failed(status:"failed"|"cancelled"="failed"):StateSnapshot{const snapshot=fixture(),job=snapshot.jobs[0]!;job.status=status;delete job.output;job.checkpointShots=1;job.checkpointFrame=Math.round(clips[0].durationSec*30);job.executionCheckpoints=job.executionCheckpoints!.slice(0,1);return snapshot;}
async function python(args:string[]){const child=Bun.spawn(["python",join(import.meta.dir,"../../../scripts/archive-package.py"),...args],{stdout:"pipe",stderr:"pipe",env:{...process.env,HV_BUN_PATH:process.execPath}});const [status,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {status,stdout,stderr};}
function prepare(root:string,snapshot:StateSnapshot){writeStateSnapshot(root,snapshot);mkdirSync(join(root,"artifacts",film.projectId),{recursive:true});cpSync(join(media,film.projectId,film.id),join(root,"artifacts",film.projectId,film.id),{recursive:true});}

test("actual captured output selects schema eleven and survives reordered JSON without changed seals",()=>{
  const snapshot=reordered(fixture()) as StateSnapshot,before=JSON.stringify(snapshot);expect(stateSnapshotSchema(snapshot.projects,snapshot.jobs)).toBe("hv-state/11");expect(validateSnapshot(snapshot)).toBe(snapshot);expect(JSON.stringify(snapshot)).toBe(before);
  for(let version=1;version<=10;version++)expect(()=>validateSnapshot({...snapshot,schema:`hv-state/${version}` as StateSnapshot["schema"]})).toThrow(/schema 11/);
  const path=join(f.root,"captured-snapshot");writeStateSnapshot(path,snapshot);expect(readStateSnapshot(path)).toEqual(snapshot);expect(contentHash(readStateSnapshot(path).jobs[0]!.executionCheckpoints)).toBe(contentHash(film.executionCheckpoints));
});

test("explicit historical absence preserves old schemas and original media record hashes",()=>{
  // This detached compatibility fixture represents an already completed pre-capture job.
  const snapshot=fixture(),job=snapshot.jobs[0]!,records=contentHash(job.output!.shotRenders);delete job.executionCheckpoints;delete job.output!.shotExecutions;snapshot.schema="hv-state/1";
  const before=JSON.stringify(snapshot);expect(stateSnapshotSchema(snapshot.projects,snapshot.jobs)).toBe("hv-state/1");expect(validateSnapshot(snapshot)).toBe(snapshot);expect(JSON.stringify(snapshot)).toBe(before);expect(contentHash(job.output!.shotRenders)).toBe(records);
  const path=join(f.root,"legacy-snapshot");writeStateSnapshot(path,snapshot);expect(readStateSnapshot(path)).toEqual(snapshot);
});

test("failed and cancelled checkpoints retain exact private envelopes without claiming record verification",()=>{
  for(const status of ["failed","cancelled"] as const){const snapshot=failed(status),job=snapshot.jobs[0]!;expect(validateSnapshot(snapshot)).toBe(snapshot);expect(stateSnapshotSchema(snapshot.projects,snapshot.jobs)).toBe("hv-state/11");expect(validateShotExecutionInventoryMetadata(job.executionCheckpoints!,job)).toEqual(job.executionCheckpoints!);}
  for(const change of [(job:Job)=>{job.executionCheckpoints![0]!.recordRevision="a".repeat(64);},(job:Job)=>{job.executionCheckpoints![0]!.capture!.jobId="foreign";},(job:Job)=>{job.executionCheckpoints![0]!.capture!.revision="b".repeat(64);},(job:Job)=>{job.checkpointShots++;},(job:Job)=>{job.executionCheckpoints=[];job.checkpointShots=0;job.checkpointFrame=1;}]){const snapshot=failed();change(snapshot.jobs[0]!);expect(()=>validateSnapshot(snapshot)).toThrow();}
  const changed=failed(),job=changed.jobs[0]!;job.executionCheckpoints![0]!.capture!.observation.attempt++;job.executionCheckpoints![0]!.capture=reseal(job.executionCheckpoints![0]!.capture!);
  expect(validateSnapshot(changed)).toBe(changed);expect(()=>validateShotExecutionClips(job,clips.slice(0,1))).toThrow();
});

test("retained-only originals and abandoned nested branches cannot hide captures or their owner binding",()=>{
  const snapshot=fixture(),project=snapshot.projects.projects[0]!;project.editLibrary=createEditSequence(emptyEditLibrary(),project.id,[source],"captured","Retained cut",source.facts.id,320,180,0,Date.now());snapshot.jobs=[];
  expect(stateSnapshotSchema(snapshot.projects,[])).toBe("hv-state/11");expect(validateSnapshot(snapshot)).toBe(snapshot);
  const orphan=fixture();Object.assign(orphan.projects.projects[0]!,{abandoned:{branch:{capture:film.executionCheckpoints![0]!.capture}}});expect(stateSnapshotSchema(orphan.projects,orphan.jobs)).toBe("hv-state/11");expect(()=>validateSnapshot(orphan)).toThrow(/owning job/);
  const hidden=fixture();let reads=0;Object.defineProperty(hidden.projects.projects[0]!,"retained",{get(){reads++;return film;}});expect(()=>stateSnapshotSchema(hidden.projects,hidden.jobs)).toThrow(/accessor/);expect(reads).toBe(0);
  const altered=fixture();altered.jobs[0]!.output!.shotExecutions![0]!.capture!.observation.attempt++;altered.jobs[0]!.output!.shotExecutions![0]!.capture=reseal(altered.jobs[0]!.output!.shotExecutions![0]!.capture!);expect(()=>validateSnapshot(altered)).toThrow();
});

test("Python archives preserve actual captures and independent media while rejecting missing or forged checkpoints",async()=>{
  const sourcePath=join(f.root,"archive-source"),archive=join(f.root,"captured.zip"),target=join(f.root,"restored");prepare(sourcePath,fixture());
  const pack=await python(["pack","--source",sourcePath,"--output",archive,"--project",film.projectId]);expect(pack.stderr).toBe("");expect(pack.status).toBe(0);
  const unpack=await python(["unpack","--source",archive,"--output",target]);expect(unpack.stderr).toBe("");expect(unpack.status).toBe(0);expect(readStateSnapshot(target)).toEqual(base);
  for(const record of film.output!.shotRenders!)for(const file of Object.values(record.files))expect(readFileSync(join(target,"artifacts",file.path))).toEqual(readFileSync(join(media,file.path)));
  expect(readFileSync(join(target,"artifacts",film.projectId,film.id,"clips/manifest.json"),"utf8")).not.toContain("hv-shot-execution-capture");
  const checkpoint=join(f.root,"failed-source"),snapshot=failed();prepare(checkpoint,snapshot);const manifest=join(checkpoint,"artifacts",film.projectId,film.id,"clips/manifest.json"),body=JSON.stringify({schema:"hv-clips/1",clips:clips.slice(0,1)});writeFileSync(manifest,body);
  const accepted=await python(["pack","--source",checkpoint,"--output",join(f.root,"failed.zip"),"--project",film.projectId]);expect(accepted.stderr).toBe("");expect(accepted.status).toBe(0);
  const reject=async(name:string,reason:string)=>{const path=join(f.root,name+".zip"),result=await python(["pack","--source",checkpoint,"--output",path,"--project",film.projectId]);expect(result.status).not.toBe(0);expect(result.stderr).toContain(reason);expect(existsSync(path)).toBe(false);};
  rmSync(manifest);await reject("missing","checkpoint manifest is missing");writeFileSync(manifest,body);
  const bad=structuredClone(clips.slice(0,1));bad[0].renderRecord.inputHash="a".repeat(64);writeFileSync(manifest,JSON.stringify(bad));await reject("record","invalid sealed execution checkpoint");writeFileSync(manifest,body);
  const missingJournal=structuredClone(snapshot);missingJournal.jobs[0]!.routeDecisions=[];expect(validateSnapshot(missingJournal)).toBe(missingJournal);writeFileSync(join(checkpoint,"queue/jobs.json"),JSON.stringify(missingJournal.jobs));await reject("journal","invalid sealed execution checkpoint");writeFileSync(join(checkpoint,"queue/jobs.json"),JSON.stringify(snapshot.jobs));
  const file=film.output!.shotRenders![0]!.files.video,path=join(checkpoint,"artifacts",file.path);writeFileSync(path,"corrupt");await reject("corrupt","checkpoint media is missing or corrupt");
},120000);
