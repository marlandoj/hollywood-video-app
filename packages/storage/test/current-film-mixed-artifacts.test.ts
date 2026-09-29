import {afterAll,afterEach,beforeAll,expect,spyOn,test} from "bun:test";
import type {S3Client,SQL} from "bun";
import {createHash} from "node:crypto";
import {appendFileSync,copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,writeFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {currentFilmSourceFixture} from "../../planner/test/current-film-source.fixture";
import {compileCurrentFilmMixedJob} from "../../planner/src/current-film-mixed-jobs";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {createCurrentFilmMixedCheckpoint,type CurrentFilmMixedCheckpoint,type CurrentFilmMixedCheckpointRow} from "../../planner/src/current-film-mixed-context";
import {compileCurrentFilmOrigins,type CurrentFilmOrigins} from "../../planner/src/current-film-origins";
import {createCurrentFilmMixedAssemblyClock} from "../../planner/src/current-film-mixed-clock";
import {createCurrentFilmMixedOutput,type CurrentFilmMixedJob,type CurrentFilmMixedJobOutput} from "../../planner/src/current-film-mixed-job-context";
import {currentFilmV3Job,currentFilmRuntimeRecordedFiles} from "../../planner/src/current-film-runtime-context";
import {compileCurrentFilmProofClosure} from "../../planner/src/current-film-proof-closure";
import {freezeCurrentFilmProofContext} from "../../planner/src/current-film-proof-copies";
import {compileCurrentFilmProofTarget} from "../../planner/src/current-film-proof-target";
import {currentFilmPreparedProofFiles,type CurrentFilmPreparedProof} from "../../planner/src/current-film-prepared-proof";
import {copyCurrentFilmOrigins} from "../../generator/src/current-film-origins-media";
import {copyCurrentFilmAdoption} from "../../generator/src/current-film-adoption-media";
import {createCurrentFilmPreparedAdoptionReader} from "../../queue/src/current-film-mixed-clips";
import {assembleCurrentFilmMixedAsync} from "../../assembler/src/index";
import {DurableJobStore,type Job,type JobInput} from "../../queue/src/index";
import type {PersistedProject} from "../../api/src/index";
import type {StudioDatabase} from "../src/database";
import {SQLResultFixture} from "./sql-result.fixture";
import {PostgresArtifactStore} from "../src/artifacts";
import {readStateSnapshot,stateSnapshotSchema,validateSnapshot,writeStateSnapshot,type StateSnapshot} from "../src/snapshots";
import {verifyCurrentFilmMixedArchive} from "../../../scripts/verify-current-film-mixed-archive";
import * as proofCopyProfile from "../../generator/src/current-film-proof-copy";
import * as proofMediaProfile from "../../generator/src/current-film-proof-media";
import * as sourceMediaProfile from "../../generator/src/edit-source-media";
import * as authorityProfile from "../../planner/src/current-film-authority";
import * as sourcePermissionProfile from "../../planner/src/current-film-source-permission";
import * as previewProfile from "../../planner/src/current-film-job-context";
import * as mixedProfile from "../../planner/src/current-film-mixed-job-context";
import * as preparedProfile from "../../planner/src/current-film-prepared-proof";
import * as mixedMediaBoundary from "../../queue/src/current-film-mixed-media";

type Row={key:string;object_key:string;project_id:string;job_id:string;sha256:string;bytes:number;content_type:string;backend:string};
type State={project:PersistedProject;jobs:Map<string,Job>;files:Map<string,Row>;events:number;eventRecords:{type:string;body:unknown}[]};
const bunRows=(rows:unknown[])=>new SQLResultFixture(rows);
/** Transactional transport double, not PostgreSQL or S3 service evidence.
 * Real original/adopted/assembled bytes pass production verification unchanged. */
function transport(project:PersistedProject,jobs:Job[]){
  let state:State={project:structuredClone(project),jobs:new Map(jobs.map(job=>[job.id,structuredClone(job)])),files:new Map(),events:0,eventRecords:[]};
  const objects=new Map<string,Uint8Array>();let uploadAttempts=0,forceUpload=false,failUploadAfter:number|undefined,failCompletion:"rollback"|"response"|undefined,failProof=false,onHeldAfterWrite:((state:State)=>void)|undefined;
  const database={sql:(async()=>[{role:"hv_admin"}]) as unknown as SQL,async forProject<T>(_projectId:string,fn:(tx:SQL)=>Promise<T>):Promise<T>{
    const local=structuredClone(state);let written=false,completion=false,preparation=false;
    // HV-016-30: return Bun's result container (an Array subclass with transport
    // fields) and bigint byte counts as strings, as the real driver does. The PR's
    // plain arrays hid a proof publication that refused every real PostgreSQL result.
    const tx=(async(parts:TemplateStringsArray,...values:unknown[])=>bunRows(await query(parts,values))) as unknown as SQL;
    const query=async(parts:TemplateStringsArray,values:unknown[]):Promise<unknown[]>=>{
      const sql=parts.join("?");
      if(sql==="select 1")return [{"?column?":1}];
      if(sql.includes("from hv_projects")){if(written&&onHeldAfterWrite){const callback=onHeldAfterWrite;onHeldAfterWrite=undefined;callback(local);}return [{id:local.project.id,body:local.project}];}
      if(sql.includes("from hv_jobs")){
        if(sql.includes("order by id limit 1025"))return [...local.jobs.values()].filter(job=>job.projectId===values[0]).sort((a,b)=>a.id.localeCompare(b.id)).map(job=>({id:job.id,body:job}));
        const id=String(sql.includes("project_id=? and id=?")?values[1]:values[0]),job=local.jobs.get(id);
        return job?[sql.startsWith("select id,body")?{id:job.id,body:job}:{body:job,lease_version:job.leaseVersion}]:[];
      }
      if(sql.includes("from hv_artifacts")){const keyed=sql.includes("where key = ?"),projectId=String(values[keyed?1:0]),jobId=String(values[keyed?2:1]),key=keyed?values[0]:sql.includes("and key=?")?values[2]:undefined;
        const rows=[...local.files.values()].filter(row=>row.project_id===projectId&&row.job_id===jobId&&(key===undefined||row.key===key)).sort((a,b)=>a.key.localeCompare(b.key));
        return sql.startsWith("select key,sha256,bytes")?rows.map(({key,sha256,bytes})=>({key,sha256,bytes:String(bytes)})):rows.map(row=>({...row,bytes:String(row.bytes)}));
      }
      if(sql.includes("insert into hv_artifacts")){const [key,object_key,project_id,job_id,sha256,bytes,content_type]=values as [string,string,string,string,string,number,string];local.files.set(key,{key,object_key,project_id,job_id,sha256,bytes,content_type,backend:"s3"});written=true;return [];}
      if(sql.includes("update hv_jobs set body")){const job=values[0] as Job;completion=job.status==="done"&&local.jobs.get(job.id)?.status!=="done";preparation=job.currentFilmProof!==undefined&&local.jobs.get(job.id)?.currentFilmProof===undefined;local.jobs.set(job.id,structuredClone(job));written=true;return [];}
      if(sql.includes("insert into hv_outbox")){const type=sql.match(/'([a-z.-]+)'/)?.[1];if(!type)throw new Error("Retain the actual fixture outbox event type.");local.events++;local.eventRecords.push({type,body:structuredClone(values.at(-1))});written=true;return [];}
      throw new Error("Unexpected artifact transaction query: "+sql);
    };
    const result=await fn(tx);if(written){const failure=completion?failCompletion:undefined;if(completion)failCompletion=undefined;
      if(preparation&&failProof){failProof=false;throw new Error("injected proof checkpoint rollback");}
      if(failure==="rollback")throw new Error("injected completion rollback");state=local;
      if(failure==="response")throw new Error("injected lost completion response");
    }return result;
  }} as unknown as StudioDatabase;
  const client={file(key:string){return {async exists(){return !forceUpload&&objects.has(key);},async write(value:Response){uploadAttempts++;if(failUploadAfter!==undefined&&failUploadAfter--===0)throw new Error("injected upload failure");objects.set(key,new Uint8Array(await value.arrayBuffer()));},stream(){const value=objects.get(key);if(!value)throw new Error("missing stored object");return new Blob([new Uint8Array(value)]).stream();}};}} as unknown as S3Client;
  return {database,client,objects,get uploadAttempts(){return uploadAttempts;},get state(){return state;},setState(value:State){state=structuredClone(value);},forceUploads(value:boolean){forceUpload=value;},failUploads(value:boolean){failUploadAfter=value?1:undefined;},failCompletion(value:"rollback"|"response"){failCompletion=value;},failProof(){failProof=true;},onHeldAfterWrite(callback:((state:State)=>void)|undefined){onHeldAfterWrite=callback;}};
}
let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,io:ReturnType<typeof transport>,media:PostgresArtifactStore,job:CurrentFilmMixedJob,root:string;
let origins:CurrentFilmOrigins,adoptedRows:CurrentFilmMixedCheckpointRow[],adoptedCheckpoint:CurrentFilmMixedCheckpoint;
let exportOutput:CurrentFilmMixedJobOutput,exportPaths:string[],exportSegments:string[],completed:CurrentFilmMixedJob;
let restoredRoot:string,destination:ReturnType<typeof transport>,imported:PostgresArtifactStore,importPaths:string[];
const worker="mixed-artifact-worker",leaseMs=300000;
const saved=()=>currentFilmV3Job(io.state.jobs.get(job.id)!);
const targetRows=(state=io.state)=>[...state.files.values()].filter(row=>row.project_id===job.projectId&&row.job_id===job.id);
let artifactProof:CurrentFilmPreparedProof;
type ArtifactCaseState={name:string;controller:AbortController;drained:Promise<void>;finished:boolean};
let artifactCaseFailure:Error|undefined,activeArtifactCase:ArtifactCaseState|undefined,artifactRegistered=0,artifactPassed=0;
let setupActive=false,setupComplete=false,setupAbandoned=false;
function artifactCurrent(state=activeArtifactCase):asserts state is ArtifactCaseState {
  if(!state||state!==activeArtifactCase||artifactCaseFailure||!setupComplete)throw new Error("Refuse dependent artifact changes after an unfinished prerequisite.",{cause:artifactCaseFailure});
  state.controller.signal.throwIfAborted();
}
function artifactCase(name:string,run:()=>Promise<void>,timeout:number):void {
  const ordinal=artifactRegistered++;
  test(name,()=>{
    if(artifactCaseFailure||activeArtifactCase||!setupComplete||ordinal!==artifactPassed)throw new Error("The preceding actual artifact checkpoint must settle successfully before this scenario.",{cause:artifactCaseFailure});
    let finish!:()=>void;const state:ArtifactCaseState={name,controller:new AbortController(),drained:new Promise<void>(resolve=>{finish=resolve;}),finished:false};activeArtifactCase=state;
    const operation=(async()=>{try{await run();artifactCurrent(state);artifactPassed++;}
      catch(error){artifactCaseFailure??=new Error("Artifact prerequisite failed: "+name,{cause:error});throw error;}
      finally{state.finished=true;finish();if(activeArtifactCase===state)activeArtifactCase=undefined;}})();
    void operation.catch(()=>{});return operation;
  },timeout);
}
async function artifactStep<T>(label:string,run:(signal:AbortSignal)=>Promise<T>):Promise<T> {
  artifactCurrent();const state=activeArtifactCase!;
  try{const result=await attempt(label,()=>run(state.controller.signal));artifactCurrent(state);return result;}
  catch(error){artifactCurrent(state);throw error;}
}
async function artifactRefusal(label:string,run:(signal:AbortSignal)=>Promise<unknown>,expected?:string|RegExp):Promise<void> {
  const failure=await artifactStep(label,run).then(()=>undefined,error=>error);artifactCurrent();
  expect(failure).toBeInstanceOf(Error);expect(()=>{throw failure;}).toThrow(expected);
}
afterEach(async()=>{
  const state=activeArtifactCase;if(!state||state.finished)return;
  const reason=new Error("Artifact scenario exceeded its unchanged test deadline: "+state.name);artifactCaseFailure??=reason;state.controller.abort(reason);
  // Cancellation/drain only; never extend the failed operation or renew its lease.
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([state.drained,new Promise<void>(resolve=>{timer=setTimeout(resolve,5000);})]);}
  finally{if(timer!==undefined)clearTimeout(timer);}
  if(!state.finished)throw new Error("Timed-out artifact work did not drain; retain its private fixture.");
});
/** Model the ordinary worker heartbeat between independent scenarios. Never
 * renew inside the operation under test or restore a lease after it expires. */
function heartbeat():CurrentFilmMixedJob {
  const prior=saved(),domain=DurableJobStore.fromJobs([prior]);domain.heartbeat(prior.id,worker,Date.now(),leaseMs);
  const updated=currentFilmV3Job(domain.get(prior.id)!);
  if(updated.claimedBy!==prior.claimedBy||updated.leaseVersion!==prior.leaseVersion)throw new Error("A scenario heartbeat must retain the actual holder and fence.");
  io.state.jobs.set(updated.id,updated);return updated;
}
/** Optional private qualification log; ordinary test output stays quiet. */
const profileOriginals=new WeakMap<object,Map<string,(...args:unknown[])=>unknown>>();
let activeProofProfile:(()=>void)|undefined;
let proofCaseFailure:Error|undefined;
let activeProofCase:{name:string;controller:AbortController;drained:Promise<void>;finished:boolean}|undefined;
const rollbackCase="proof-only preparation rollback leaves actual target and index unchanged";
/** Diagnostic mode intentionally runs only the first proof scenario. Normal
 * qualification retains every case and fails dependent cases before mutation
 * when an earlier prerequisite did not complete. */
function proofCase(name:string,run:()=>Promise<void>,timeout:number):void {
  const register=process.env.HV_CURRENT_FILM_ARTIFACT_DIAGNOSTIC==="rollback"&&name!==rollbackCase?test.skip:test;
  register(name,()=>{
    if(artifactCaseFailure||activeArtifactCase&&!activeArtifactCase.finished)throw new Error("An earlier artifact operation failed or is still active; refuse proof-only fixture changes.",{cause:artifactCaseFailure});
    if(proofCaseFailure)throw new Error("An earlier proof scenario did not complete; refusing dependent fixture changes.",{cause:proofCaseFailure});
    let finish!:()=>void;const state={name,controller:new AbortController(),drained:new Promise<void>(resolve=>{finish=resolve;}),finished:false};activeProofCase=state;
    const operation=(async()=>{
      try{await run();}catch(error){proofCaseFailure=new Error("Proof prerequisite failed: "+name,{cause:error});throw error;}
      finally{state.finished=true;finish();if(activeProofCase===state)activeProofCase=undefined;}
    })();
    // Preserve rejection for Bun while also consuming late failure if its test
    // deadline wins first. Cancellation cleanup still waits for this operation.
    void operation.catch(()=>{});return operation;
  },timeout);
}
afterEach(async()=>{
  const state=activeProofCase;
  if(state&&!state.finished){
    const reason=new Error("Proof scenario exceeded its unchanged test deadline: "+state.name);proofCaseFailure??=reason;state.controller.abort(reason);
  }
  activeProofProfile?.();
  if(state&&!state.finished){
    // This bounded cleanup cancels the already-failed operation; it does not
    // extend the test or renew its worker lease. Later cases cannot touch it.
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{await Promise.race([state.drained,new Promise<void>(resolve=>{timer=setTimeout(resolve,5000);})]);}
    finally{if(timer!==undefined)clearTimeout(timer);}
    if(!state.finished)throw new Error("Timed-out proof work did not drain after cancellation; retain its private fixture.");
  }
});
function proofProfile(label:string):()=>void {
  const destination=process.env.HV_CURRENT_FILM_ARTIFACT_PROFILE;
  if(!destination||!label.startsWith("proof-"))return ()=>{};
  if(activeProofProfile)throw new Error("The previous proof diagnostic still owns its instrumentation.");
  const started=performance.now(),stats:Record<string,{calls:number;inclusiveMs:number;maximumMs:number;active:number}>={},spies:{mockRestore():void}[]=[];
  let stopped=false,copyInventory:{files:number;bytes:number}|undefined;
  const log=(phase:string)=>appendFileSync(destination,JSON.stringify({label,phase,at:new Date().toISOString(),elapsedMs:performance.now()-started,copyInventory,stats})+"\n");
  const stop=()=>{if(stopped)return;stopped=true;try{log("end");}finally{
    for(const spy of spies.reverse())spy.mockRestore();if(activeProofProfile===stop)activeProofProfile=undefined;
  }};
  activeProofProfile=stop;
  const watch=(target:object,key:string,name:string,phase=false)=>{
    const object=target as Record<string,(...args:unknown[])=>unknown>;
    let originals=profileOriginals.get(target);if(!originals){originals=new Map();profileOriginals.set(target,originals);}
    // Keep the pristine callable: Bun can reuse a spy object when a later phase
    // instruments the same key, including after a timed-out test.
    const original=originals.get(key)??object[key];
    if(typeof original!=="function")throw new Error("Private proof profiler method missing: "+name);
    originals.set(key,original);
    const stat=stats[name]={calls:0,inclusiveMs:0,maximumMs:0,active:0};
    spies.push(spyOn(object,key).mockImplementation(function(this:unknown,...args:unknown[]){
      if(name==="copy"&&args[0]&&typeof args[0]==="object"){
        const files=Object.getOwnPropertyDescriptor(args[0],"files")?.value,bytes=Object.getOwnPropertyDescriptor(args[0],"bytes")?.value;
        if(Number.isSafeInteger(files)&&files>=0&&Number.isSafeInteger(bytes)&&bytes>=0)copyInventory={files,bytes};
      }
      const start=performance.now();stat.active++;if(phase)log(name+":start");
      const finish=()=>{if(stopped)return;const elapsed=performance.now()-start;stat.calls++;stat.active--;stat.inclusiveMs+=elapsed;stat.maximumMs=Math.max(stat.maximumMs,elapsed);
        if(phase)log(name+":end");else if(name==="held"&&stat.calls%10===0)log("held:sample");};
      try{const result=Reflect.apply(original,this,args);
        if(result&&typeof result==="object"&&"then" in result&&typeof result.then==="function")return Promise.resolve(result).then(value=>{finish();return value;},error=>{finish();throw error;});
        finish();return result;
      }catch(error){finish();throw error;}
    }));
  };
  try{
    for(const key of ["resolveProof","checkpointCurrentFilmProof","uploadMixedFiles","assertProofSelection"])watch(PostgresArtifactStore.prototype,key,key,true);
    for(const key of ["held","upload","measuredArtifact","persist"])watch(PostgresArtifactStore.prototype,key,key);
    watch(proofCopyProfile,"prepareCurrentFilmProofCopies","copy",true);watch(proofMediaProfile,"verifyCurrentFilmProofMedia","native",true);
    watch(sourceMediaProfile,"verifyEditOriginalMedia","original-native");watch(sourceMediaProfile,"verifyEditOriginalSemantics","original-semantics");
    watch(sourceMediaProfile,"measureEditSourceFacts","source-facts");
    watch(authorityProfile,"assertCurrentFilmGenerationCurrent","target-current");
    watch(sourcePermissionProfile,"assertCurrentFilmSourcePermission","source-current");
    watch(previewProfile,"createCurrentFilmPreviewReview","preview-review");watch(previewProfile,"validateCurrentFilmOutput","preview-output");
    watch(mixedProfile,"assertCurrentFilmMixedPreviewRelationship","preview-relation");watch(mixedProfile,"validateCurrentFilmMixedJob","mixed-historical");
    watch(preparedProfile,"validateCurrentFilmPreparedProof","proof-historical");log("start");
  }catch(error){stop();throw error;}
  // Inclusive nested timings identify dominant call paths; never sum these as
  // separate wall-clock costs. No payload, owner token or media is logged.
  return stop;
}
async function attempt<T>(label:string,run:(signal?:AbortSignal)=>Promise<T>):Promise<T>{
  const startedAt=new Date().toISOString(),started=performance.now(),stop=proofProfile(label);let outcome="returned";
  try{return await run(label.startsWith("proof-")?activeProofCase?.controller.signal:undefined);}catch(error){outcome="threw";throw error;}finally{
    stop();
    const destination=process.env.HV_CURRENT_FILM_ARTIFACT_TIMINGS;
    if(destination)appendFileSync(destination,JSON.stringify({label,startedAt,endedAt:new Date().toISOString(),elapsedMs:performance.now()-started,outcome})+"\n");
  }
}
beforeAll(async()=>{
  setupActive=true;try{
  f=await currentFilmSourceFixture();if(setupAbandoned)throw new Error("Retain a source fixture that finished after its setup deadline.");root=f.studio.paths.artifactRoot;
  const plan=compileCurrentFilmMixedJob(f.plan,{origins:[bindOriginalEditSource(f.receipt)],choices:f.plan.materialization.slots.map((slot,ordinal)=>({ordinal,inputRevision:slot.inputRevision,originId:f.receipt.revision,
    source:{receiptRevision:f.receipt.revision,ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:f.job.currentFilmCheckpoint!.rows[ordinal]!.record.revision}}))});
  const id="mixed-artifact-originals",input:JobInput={id,projectId:plan.projectId,idempotencyKey:id,currentFilm:plan,tier:plan.render.tier,stage:plan.render.stage,scriptVersion:plan.materialization.script.version,
    scriptText:plan.materialization.script.text,casting:plan.target.state.casting.candidate!,providerPlan:plan.render.providerPlan,rightsAttestedAt:f.project.rightsAttestedAt,
    animaticJobId:null,animaticApprovedAt:null,totalFrames:plan.materialization.requestedFrames,costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:1,backoffMs:0},timeoutMs:300000};
  const domain=DurableJobStore.fromJobs([]);domain.enqueue(input);job=currentFilmV3Job(domain.claimNext(Date.now(),{},{workerId:worker,leaseMs})!);
  // The SQL job adapter supplies the fence; the local domain store does not.
  job.leaseVersion=1;
  io=transport(f.project,[...f.store.all(),job]);media=new PostgresArtifactStore(io.database,root,io.client);setupComplete=true;
  }finally{setupActive=false;}
},180000);
afterAll(async()=>{
  if(setupActive||activeArtifactCase&&!activeArtifactCase.finished||activeProofCase&&!activeProofCase.finished){
    if(setupActive)setupAbandoned=true;
    // A failed hook does not isolate unfinished work from later test files.
    // Keep its files and stop only this runner instead of racing global state.
    console.error("Artifact fixture still owns unfinished asynchronous work; stopping the test runner and retaining its files.");
    process.exit(1);
  }
  await f?.close();
});

test("large object metadata is allowed only for the exact measured V3 final MP4",async()=>{
  // Metadata-reader qualification only. This explicit format/size envelope does
  // not claim a large file exists or that the V3 worker rendered these V2 bytes.
  const plan=compileCurrentFilmMixedJob(f.plan,{origins:[],choices:[]});
  const {currentFilmCheckpoint:_checkpoint,output:_output,...prior}=f.job;
  const base:CurrentFilmMixedJob={...prior,currentFilm:plan,currentFilmOrigins:compileCurrentFilmOrigins(plan,prior.id),status:"running",completedAt:null,linkExpiresAt:null,checkpointShots:0,checkpointFrame:0};
  const rows=f.job.currentFilmCheckpoint!.rows.map(row=>({kind:"generated" as const,...row}));
  base.currentFilmCheckpoint=createCurrentFilmMixedCheckpoint(base,rows);base.checkpointShots=rows.length;base.checkpointFrame=f.job.checkpointFrame;
  const old=f.job.output!.currentFilm!.assembly,bytes=10*1024**3,clock=createCurrentFilmMixedAssemblyClock(base,base.currentFilmCheckpoint,{sourceFrames:old.spans.map(span=>span.frames),effectiveOverlapFrames:old.effectiveOverlapFrames,reason:old.reason,probe:old.probe,video:{...old.video,bytes},captions:{vtt:old.captions.vtt,srt:old.captions.srt}});
  const {mp4Path,hlsPlaylistPath,captionsPath,manifestPath}=f.job.output!;base.output={mp4Path,hlsPlaylistPath,captionsPath,manifestPath,currentFilm:createCurrentFilmMixedOutput(base,clock,[])};
  base.status="done";base.completedAt=f.job.completedAt;base.linkExpiresAt=f.job.linkExpiresAt;
  const large=transport(f.project,[base]),store=new PostgresArtifactStore(large.database,root,large.client),row:Row={key:mp4Path,project_id:base.projectId,job_id:base.id,sha256:clock.video.sha256,bytes,content_type:"video/mp4",backend:"s3",object_key:`v1/${base.projectId}/${base.id}/${clock.video.sha256}/${mp4Path.split("/").at(-1)}`};
  large.state.files.set(row.key,row);expect(await store.fileInfo(base.projectId,base.id,row.key)).toEqual({path:row.key,sha256:row.sha256,bytes});
  const unmeasured=[hlsPlaylistPath,...["wav","json","ts"].map(extension=>`${base.projectId}/${base.id}/unmeasured.${extension}`)];
  for(const change of [{bytes:9*1024**3},{bytes:bytes+1},{sha256:"a".repeat(64)},...unmeasured.map(key=>({key}))]){
    const changed={...row,...change};large.state.files.clear();large.state.files.set(changed.key,changed);
    await expect(store.fileInfo(base.projectId,base.id,changed.key)).rejects.toThrow(/exact measured|invalid stored/);
  }
},90000);

artifactCase("actual prepared proof precedes the original and delivery artifact lifecycle",async()=>{
  const base=heartbeat(),project=io.state.project,jobs=[...io.state.jobs.values()],closure=compileCurrentFilmProofClosure(base.currentFilm,freezeCurrentFilmProofContext({project,jobs}),compileCurrentFilmProofTarget(base)),paths=new Set<string>();
  expect(jobs.some(owner=>owner.id===f.studio.film.id)).toBe(true);expect(jobs.some(owner=>owner.id===f.job.id)).toBe(true);
  for(const {receipt}of closure.receipts)for(const file of receipt.files)paths.add(file.path);
  for(const {job:preview}of closure.previews){
    const output=preview.output!;for(const file of currentFilmRuntimeRecordedFiles(preview))paths.add(file.path);
    for(const path of [output.mp4Path,output.hlsPlaylistPath,output.captionsPath,output.captionsPath.slice(0,-4)+".srt",output.manifestPath,`${preview.projectId}/${preview.id}/clips/manifest.json`])paths.add(path);
    const prefix=output.hlsPlaylistPath.slice(0,-"index.m3u8".length);for(const name of readdirSync(join(root,dirname(output.hlsPlaylistPath))))paths.add(prefix+name);
  }
  // Index authentic files under their original owners. No substitute completed
  // job, capture, clip manifest or worker-owned proof marker is manufactured.
  for(const key of paths){
    artifactCurrent();const bytes=readFileSync(join(root,key)),sha256=createHash("sha256").update(bytes).digest("hex"),owner=key.split("/")[1]!;
    if(!jobs.some(value=>value.id===owner))throw new Error("The actual proof artifact lost its original owner.");
    const object_key=`v1/${base.projectId}/${owner}/${sha256}/${key.split("/").at(-1)}`;
    io.state.files.set(key,{key,object_key,project_id:base.projectId,job_id:owner,sha256,bytes:bytes.length,content_type:"application/octet-stream",backend:"s3"});io.objects.set(object_key,new Uint8Array(bytes));
  }
  const before=structuredClone(io.state),prepared=await artifactStep("artifact-proof-preparation",signal=>media.prepareCurrentFilmProof(base,worker,leaseMs,signal)),current=saved(),files=currentFilmPreparedProofFiles(prepared,current);
  expect(current.currentFilmProof).toEqual(prepared);expect(current.currentFilmOrigins).toBeUndefined();expect(current.currentFilmCheckpoint).toBeUndefined();expect(current.output).toBeUndefined();
  expect(current.status).toBe("running");expect(current.startedAt).toBe(base.startedAt);expect(current.currentFilm).toEqual(base.currentFilm);expect(current.checkpointShots).toBe(0);expect(current.checkpointFrame).toBe(0);
  expect(current.costUsd).toBe(base.costUsd);expect(current.routeDecisions??[]).toEqual([]);expect(prepared.specification.target?.jobId).toBe(base.id);
  expect(targetRows()).toHaveLength(files.length);expect(io.state.files.size-before.files.size).toBe(files.length);
  for(const file of files){const row=io.state.files.get(file.path)!;expect(row.sha256).toBe(file.sha256);expect(row.bytes).toBe(file.bytes);expect(new Uint8Array(readFileSync(join(root,file.path)))).toEqual(new Uint8Array(io.objects.get(row.object_key)!));}
  for(const [key,row]of before.files)expect(io.state.files.get(key)).toEqual(row);
  expect(io.state.project).toEqual(before.project);for(const [id,owner]of before.jobs)if(id!==base.id)expect(io.state.jobs.get(id)).toEqual(owner);
  expect(io.state.events).toBe(before.events+1);expect(io.state.eventRecords.at(-1)).toEqual({type:"current-film.proof",body:{revision:prepared.revision,files:files.length}});artifactProof=prepared;
},300000);

artifactCase("failed partial upload and foreign lease cannot publish original preparation",async()=>{
  origins=await artifactStep("origins-local-copy",signal=>copyCurrentFilmOrigins(saved().currentFilm,job.id,root,async()=>{signal.throwIfAborted();},signal));
  const base=heartbeat(),before=structuredClone(io.state),objects=structuredClone(io.objects),uploads=io.uploadAttempts;
  await artifactRefusal("origins-foreign-fence",signal=>media.checkpointCurrentFilmOrigins({...base,leaseVersion:base.leaseVersion!+1},worker,origins,leaseMs,signal),"fence_changed");expect(io.state).toEqual(before);expect(io.uploadAttempts).toBe(uploads);
  // Explicit HEAD-miss injection exercises two real upload calls even when proof
  // already owns every content-addressed object. Existing bytes remain present.
  io.forceUploads(true);io.failUploads(true);
  try{await artifactRefusal("origins-partial-upload-failure",signal=>media.checkpointCurrentFilmOrigins(base,worker,origins,leaseMs,signal),"upload failure");}
  finally{io.failUploads(false);io.forceUploads(false);}
  expect(io.state).toEqual(before);expect(io.uploadAttempts-uploads).toBe(2);expect(saved().currentFilmProof).toEqual(artifactProof);
  // Proof and originals may share a target/hash/basename object key. The real
  // second-write failure proves the partial upload; object-count growth does not.
  for(const [key,bytes]of objects)expect(io.objects.get(key)).toEqual(bytes);
},300000);

artifactCase("origins transaction rolls back coherent staged custody when the original lease expires or current rights change",async()=>{
  const base=heartbeat(),before=structuredClone(io.state),objects=structuredClone(io.objects);
  // Transaction-boundary evidence only: these two negative variants bypass
  // native verification. Surrounding real-media cases retain that qualification.
  const verify=spyOn(mixedMediaBoundary,"verifyCurrentFilmMixedMedia").mockImplementation(async()=>{});
  try{for(const kind of ["expiry","rights"] as const){
    const originalExpiry=Date.parse(base.leaseExpiresAt!);
    let now=originalExpiry-leaseMs+10000,observed:{lease:string|null;origins:unknown;proof:unknown;indexPaths:string[]}|undefined;
    expect(originalExpiry+1).toBeLessThan(now+leaseMs);
    const clock=spyOn(Date,"now").mockImplementation(()=>now);
    io.onHeldAfterWrite(local=>{
      const staged=local.jobs.get(base.id)!;
      observed={lease:staged.leaseExpiresAt,origins:staged.currentFilmOrigins,proof:staged.currentFilmProof,
        indexPaths:[...local.files.values()].filter(row=>row.job_id===base.id).map(row=>row.key)};
      if(kind==="expiry")now=originalExpiry+1;else local.project.rightsAttestedAt=null;
    });
    try{
      await artifactRefusal("origins-staged-"+kind,signal=>media.checkpointCurrentFilmOrigins(base,worker,origins,leaseMs,signal),kind==="expiry"?"lease_expired":/rights|permission/);
      expect(observed).toBeDefined();expect(observed!.lease).toBe(base.leaseExpiresAt);expect(observed!.origins).toEqual(origins);expect(observed!.proof).toEqual(artifactProof);
      for(const copy of origins.origins.flatMap(origin=>origin.copies))expect(observed!.indexPaths).toContain(copy.owned.path);
      expect(io.state).toEqual(before);for(const [key,bytes]of objects)expect(io.objects.get(key)).toEqual(bytes);
    }finally{io.onHeldAfterWrite(undefined);clock.mockRestore();}
  }}finally{verify.mockRestore();}
},90000);

artifactCase("complete actual origins publish atomically after an ordinary heartbeat",async()=>{
  const base=heartbeat(),before=structuredClone(io.state),uploads=io.uploadAttempts,
    objectKeys=new Set(origins.origins.flatMap(origin=>origin.copies.map(copy=>`v1/${base.projectId}/${base.id}/${copy.owned.sha256}/${copy.owned.path.split("/").at(-1)}`))),
    missing=[...objectKeys].filter(key=>!io.objects.has(key));
  await artifactStep("origins-valid-publication",signal=>media.checkpointCurrentFilmOrigins(base,worker,origins,leaseMs,signal));
  expect(saved().currentFilmOrigins).toEqual(origins);expect(saved().checkpointShots).toBe(0);expect(saved().startedAt).toBe(job.startedAt);
  expect(saved().currentFilmProof).toEqual(artifactProof);expect(targetRows().length-targetRows(before).length).toBe(origins.origins.flatMap(origin=>origin.copies).length);expect(io.state.events).toBe(before.events+1);
  expect(io.uploadAttempts-uploads).toBe(missing.length);
  for(const [key,row]of before.files)expect(io.state.files.get(key)).toEqual(row);
  expect(io.state.files.has(`${job.projectId}/${job.id}/clips/manifest.json`)).toBe(false);
},300000);

artifactCase("origins-only restore needs no old carrier or clip manifest; corrupt stored objects refuse",async()=>{
  for(const id of io.state.jobs.keys())if(id!==job.id)io.state.jobs.delete(id);
  for(const [key,row]of io.state.files)if(row.job_id!==job.id){io.state.files.delete(key);if(![...io.state.files.values()].some(value=>value.object_key===row.object_key))io.objects.delete(row.object_key);}
  const initial=structuredClone(io.state),sourceJob=f.job.id;expect([...io.state.jobs.keys()]).toEqual([job.id]);expect(saved().currentFilmProof).toEqual(artifactProof);
  const restored=mkdtempSync(join(f.studio.root,"mixed-origins-restored-")),store=new PostgresArtifactStore(io.database,restored,io.client);
  await artifactStep("origins-owned-only-restore",signal=>store.restoreCheckpoint(saved(),signal));expect(existsSync(join(restored,job.projectId,sourceJob))).toBe(false);
  expect(existsSync(join(restored,job.projectId,f.studio.film.id))).toBe(false);
  expect(existsSync(join(restored,job.projectId,job.id,"clips","manifest.json"))).toBe(false);
  for(const row of targetRows())expect(new Uint8Array(readFileSync(join(restored,row.key)))).toEqual(new Uint8Array(io.objects.get(row.object_key)!));
  const row=io.state.files.get(origins.origins[0]!.copies.at(-1)!.owned.path)!,bytes=io.objects.get(row.object_key)!,changed=new Uint8Array(bytes);changed[changed.length-1]^=1;io.objects.set(row.object_key,changed);
  try{await artifactRefusal("origins-corrupt-stored-role",signal=>new PostgresArtifactStore(io.database,mkdtempSync(join(f.studio.root,"mixed-corrupt-")),io.client).restoreCheckpoint(saved(),signal),"checksum");}finally{io.objects.set(row.object_key,bytes);}
  const missing=structuredClone(io.state);missing.files.delete(row.key);io.setState(missing);try{await artifactRefusal("origins-missing-indexed-role",signal=>store.restoreCheckpoint(saved(),signal),/Stored mixed|evidence/);}finally{io.setState(initial);}
},180000);

artifactCase("adopted prefix refuses changed complete original inventory without publication",async()=>{
  const source=saved();adoptedRows=[];
  await artifactStep("prefix-local-copy",async signal=>{
    const access=async()=>{signal.throwIfAborted();},reader=createCurrentFilmPreparedAdoptionReader(source,root,access,signal);
    for(const slot of source.currentFilm.materialization.slots){const adoption=await copyCurrentFilmAdoption(source.currentFilm,source.id,slot.ordinal,root,access,signal,reader);artifactCurrent();adoptedRows.push({kind:"reused",ordinal:slot.ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,adoption});}
  });
  adoptedCheckpoint=createCurrentFilmMixedCheckpoint(source,adoptedRows);
  const base=heartbeat(),original=base.currentFilmOrigins!.origins[0]!.copies.at(-1)!,path=join(root,original.owned.path),bytes=readFileSync(path),changed=Buffer.from(bytes);changed[changed.length-1]^=1;
  writeFileSync(path,changed);const before=structuredClone(io.state);try{await artifactRefusal("prefix-corrupt-original",signal=>media.checkpointCurrentFilmMixed(base,worker,adoptedCheckpoint,leaseMs,signal),"checksum");expect(io.state).toEqual(before);}finally{writeFileSync(path,bytes);}
},300000);

artifactCase("adopted prefix refuses same-size native PCM corruption without publication",async()=>{
  const base=heartbeat(),before=structuredClone(io.state);
  const native=adoptedRows.flatMap(row=>row.kind==="reused"?row.adoption.copies:[]).find(copy=>copy.role==="audio");expect(native).toBeDefined();if(!native)throw new Error("The fixture must retain actual native dialogue.");
  const nativePath=join(root,native.owned.path),nativeBytes=readFileSync(nativePath),corruptNative=Buffer.from(nativeBytes);corruptNative[44]^=1;writeFileSync(nativePath,corruptNative);
  try{await artifactRefusal("prefix-corrupt-adopted-pcm",signal=>media.checkpointCurrentFilmMixed(base,worker,adoptedCheckpoint,leaseMs,signal),"checksum");expect(io.state).toEqual(before);}finally{writeFileSync(nativePath,nativeBytes);}
},300000);

artifactCase("exact adopted prefix publishes without renamed records after an ordinary heartbeat",async()=>{
  const base=heartbeat();await artifactStep("prefix-valid-publication",signal=>media.checkpointCurrentFilmMixed(base,worker,adoptedCheckpoint,leaseMs,signal));
  expect(saved().currentFilmCheckpoint).toEqual(adoptedCheckpoint);expect(saved().checkpointShots).toBe(adoptedRows.length);
  expect(saved().routeDecisions??[]).toEqual([]);expect(io.state.files.has(`${job.projectId}/${job.id}/clips/manifest.json`)).toBe(false);
  expect(saved().currentFilmProof).toEqual(artifactProof);const restored=mkdtempSync(join(f.studio.root,"mixed-prefix-restored-"));await artifactStep("prefix-owned-only-restore",signal=>new PostgresArtifactStore(io.database,restored,io.client).restoreCheckpoint(saved(),signal));
  for(const row of adoptedRows)if(row.kind==="reused")for(const copy of row.adoption.copies)expect(new Uint8Array(readFileSync(join(restored,copy.owned.path)))).toEqual(new Uint8Array(readFileSync(join(root,copy.owned.path))));
},300000);

artifactCase("actual mixed export refuses an incomplete delivery inventory before publication",async()=>{
  const base=saved(),result=await artifactStep("export-actual-assembly",signal=>assembleCurrentFilmMixedAsync(base,base.currentFilmCheckpoint!,root,join(root,base.projectId,base.id),{assembledAt:"2026-09-17T10:00:00.000Z",access:async()=>{signal.throwIfAborted();},signal}));
  const output={mp4Path:`${base.projectId}/${base.id}/export.mp4`,hlsPlaylistPath:`${base.projectId}/${base.id}/hls/index.m3u8`,captionsPath:`${base.projectId}/${base.id}/captions.vtt`,manifestPath:`${base.projectId}/${base.id}/provenance.json`,currentFilm:createCurrentFilmMixedOutput(base,result.currentFilmMixedClock,[])};
  // Kernel paths are the authoritative export locations; never infer a different filename.
  output.mp4Path=result.mp4Path.slice(root.length+1).replaceAll("\\","/");output.hlsPlaylistPath=result.hlsPlaylistPath.slice(root.length+1).replaceAll("\\","/");
  output.captionsPath=result.vttPath.slice(root.length+1).replaceAll("\\","/");output.manifestPath=result.manifestPath.slice(root.length+1).replaceAll("\\","/");
  const playlist=readFileSync(join(root,output.hlsPlaylistPath),"utf8"),segments=playlist.split(/\r?\n/).filter(line=>line&&!line.startsWith("#")).map(name=>join(dirname(join(root,output.hlsPlaylistPath)),name));
  exportOutput=output;exportSegments=segments;exportPaths=[result.mp4Path,result.hlsPlaylistPath,result.vttPath,result.srtPath,result.manifestPath,...segments];
  const current=heartbeat(),before=structuredClone(io.state);
  await artifactRefusal("export-reject-legacy-publication",signal=>media.publishExport(current,worker,exportPaths,signal,output),"completeCurrentFilmMixedExport");expect(io.state).toEqual(before);
  let accessorReads=0;const accessorOutput={...output};Object.defineProperty(accessorOutput,"mp4Path",{enumerable:true,get(){accessorReads++;return output.mp4Path;}});
  await artifactRefusal("export-accessor-output",signal=>media.completeCurrentFilmMixedExport(current,worker,exportPaths,accessorOutput,signal),"portable");expect(accessorReads).toBe(0);expect(io.state).toEqual(before);
  const accessorPaths=exportPaths.slice();Object.defineProperty(accessorPaths,"0",{enumerable:true,get(){accessorReads++;return exportPaths[0];}});
  await artifactRefusal("export-accessor-paths",signal=>media.completeCurrentFilmMixedExport(current,worker,accessorPaths,output,signal),"portable");expect(accessorReads).toBe(0);expect(io.state).toEqual(before);
  const accessorJob={...current};Object.defineProperty(accessorJob,"id",{enumerable:true,get(){accessorReads++;return current.id;}});
  await artifactRefusal("export-accessor-job",signal=>media.completeCurrentFilmMixedExport(accessorJob,worker,exportPaths,output,signal),"portable");expect(accessorReads).toBe(0);expect(io.state).toEqual(before);
  await artifactRefusal("export-incomplete-inventory",signal=>media.completeCurrentFilmMixedExport(current,worker,exportPaths.filter(path=>path!==segments[0]),output,signal),"every exact");expect(io.state).toEqual(before);
},300000);

artifactCase("mixed completion rollback leaves the exact resumable prefix without delivery rows or completion events",async()=>{
  const base=heartbeat(),before=structuredClone(io.state),objects=structuredClone(io.objects);io.failCompletion("rollback");
  await artifactRefusal("export-completion-rollback",signal=>media.completeCurrentFilmMixedExport(base,worker,exportPaths,exportOutput,signal),"injected completion rollback");
  expect(io.state).toEqual(before);expect(saved().status).toBe("running");expect(saved().output).toBeUndefined();
  expect(saved().currentFilmCheckpoint).toEqual(base.currentFilmCheckpoint);expect(saved().currentFilmOrigins).toEqual(base.currentFilmOrigins);expect(saved().currentFilmProof).toEqual(artifactProof);
  for(const [key,bytes]of objects)expect(io.objects.get(key)).toEqual(bytes);
  expect(exportPaths.every(path=>!io.state.files.has(path.slice(root.length+1).replaceAll("\\","/")))).toBe(true);
  expect(io.state.eventRecords.some(value=>["artifacts.exported","job.completed"].includes(value.type))).toBe(false);
},300000);

artifactCase("rolled-back completion restores the exact owned prefix after an ordinary heartbeat",async()=>{
  const base=heartbeat(),before=structuredClone(io.state);
  const restored=mkdtempSync(join(f.studio.root,"mixed-completion-rollback-"));
  await artifactStep("export-rollback-prefix-restore",signal=>new PostgresArtifactStore(io.database,restored,io.client).restoreCheckpoint(base,signal));
  expect(io.state).toEqual(before);expect(saved().status).toBe("running");expect(saved().output).toBeUndefined();
  expect(existsSync(join(restored,exportOutput.mp4Path))).toBe(false);
},300000);

artifactCase("lost completion response leaves exact indexed delivery and completed job in the same commit",async()=>{
  const base=heartbeat(),before=structuredClone(io.state);io.failCompletion("response");
  const suppliedJob=structuredClone(base),suppliedOutput=structuredClone(exportOutput),suppliedPaths=exportPaths.slice();let mutated=false;
  io.onHeldAfterWrite(()=>{mutated=true;suppliedJob.id="caller-changed-job";suppliedJob.projectId="caller-changed-project";suppliedJob.leaseVersion=base.leaseVersion!+1;suppliedOutput.mp4Path=`${base.projectId}/${base.id}/unverified.mp4`;suppliedPaths[0]=join(root,suppliedOutput.mp4Path);});
  await artifactRefusal("export-lost-completion-response",signal=>media.completeCurrentFilmMixedExport(suppliedJob,worker,suppliedPaths,suppliedOutput,signal),"injected lost completion response");expect(mutated).toBe(true);
  completed=saved();expect(completed.status).toBe("done");expect(completed.output).toEqual(exportOutput);expect(completed.claimedBy).toBeNull();expect(completed.leaseExpiresAt).toBeNull();expect(completed.nextEligibleAt).toBeNull();
  expect(completed.leaseVersion).toBe(base.leaseVersion);expect(completed.startedAt).toBe(base.startedAt);expect(Date.parse(completed.completedAt!)).toBeGreaterThanOrEqual(Date.parse(base.startedAt!));expect(Date.parse(completed.linkExpiresAt!)).toBeGreaterThan(Date.parse(completed.completedAt!));
  expect(completed.currentFilmOrigins).toEqual(base.currentFilmOrigins);expect(completed.currentFilmCheckpoint).toEqual(base.currentFilmCheckpoint);expect(completed.currentFilmProof).toEqual(artifactProof);expect(completed.costUsd).toBe(base.costUsd);expect(completed.notifications).toEqual(base.notifications);
  expect(io.state.project).toEqual(before.project);expect(io.state.events).toBe(before.events+2);
  expect(io.state.eventRecords.slice(before.eventRecords.length).map(value=>value.type)).toEqual(["artifacts.exported","job.completed"]);
  expect(io.state.eventRecords.at(-1)!.body).toEqual({status:"done",workerId:worker,leaseVersion:completed.leaseVersion,checkpointShots:completed.checkpointShots});
  expect(exportSegments.every(path=>io.state.files.has(path.slice(root.length+1).replaceAll("\\","/")))).toBe(true);
  expect(exportPaths.every(path=>io.state.files.has(path.slice(root.length+1).replaceAll("\\","/")))).toBe(true);
  const committed=structuredClone(io.state);await artifactRefusal("export-completed-holder-refusal",signal=>media.completeCurrentFilmMixedExport(base,worker,exportPaths,exportOutput,signal),"not_running");expect(io.state).toEqual(committed);
},300000);

artifactCase("completed output restores from owned objects with exact MP4 bytes",async()=>{
  const output=exportOutput;restoredRoot=mkdtempSync(join(f.studio.root,"mixed-export-restored-"));
  await artifactStep("export-owned-only-restore",signal=>new PostgresArtifactStore(io.database,restoredRoot,io.client).restoreCheckpoint(completed,signal));
  for(const original of [f.job,f.studio.film])expect(existsSync(join(restoredRoot,job.projectId,original.id))).toBe(false);
  for(const file of currentFilmPreparedProofFiles(artifactProof,completed))expect(new Uint8Array(readFileSync(join(restoredRoot,file.path)))).toEqual(new Uint8Array(readFileSync(join(root,file.path))));
  expect(readFileSync(join(restoredRoot,output.mp4Path)).equals(readFileSync(join(root,output.mp4Path)))).toBe(true);
},300000);

artifactCase("independent completed import preserves the complete actual delivery index",async()=>{
  destination=transport(io.state.project,[completed]);imported=new PostgresArtifactStore(destination.database,restoredRoot,destination.client);
  importPaths=targetRows().map(row=>join(restoredRoot,row.key));
  // importCompletedJob has no signal parameter. Track it to settlement and keep
  // the fixture intact if it outlives this test; do not invent cancellation.
  await artifactStep("export-independent-import",()=>imported.importCompletedJob(completed,importPaths));expect(destination.state.files.size).toBe(targetRows().length);
  expect([...destination.state.jobs.keys()]).toEqual([completed.id]);expect(destination.state.jobs.get(completed.id)!.currentFilmProof).toEqual(artifactProof);
  for(const row of targetRows()){const actual=destination.state.files.get(row.key)!;expect(actual.sha256).toBe(row.sha256);expect(actual.bytes).toBe(row.bytes);expect(destination.objects.get(actual.object_key)).toEqual(io.objects.get(row.object_key)!);}
},300000);

artifactCase("completed restore refuses a missing indexed delivery segment",async()=>{
  const segmentKey=exportSegments[0]!.slice(root.length+1).replaceAll("\\","/"),segment=destination.state.files.get(segmentKey)!;destination.state.files.delete(segmentKey);
  try{await artifactRefusal("export-missing-indexed-segment",signal=>new PostgresArtifactStore(destination.database,mkdtempSync(join(f.studio.root,"mixed-segment-missing-")),destination.client).restoreCheckpoint(completed,signal));}
  finally{destination.state.files.set(segmentKey,segment);}
},300000);

artifactCase("completed import refuses changed delivery bytes even when the upload list omits them",async()=>{
  const segmentKey=exportSegments[0]!.slice(root.length+1).replaceAll("\\","/"),path=join(restoredRoot,segmentKey),old=readFileSync(path);writeFileSync(path,Buffer.concat([old,Buffer.from([0])]));
  try{await artifactRefusal("export-changed-delivery-segment",()=>imported.importCompletedJob(completed,importPaths.filter(value=>value!==path)),/delivery|segment|indexed/);}
  finally{writeFileSync(path,old);}
},300000);

let proofIo:ReturnType<typeof transport>,proofMedia:PostgresArtifactStore,proofJob:CurrentFilmMixedJob,preparedProof:CurrentFilmPreparedProof;
let proofRestoredRoot:string;
const proofSaved=()=>currentFilmV3Job(proofIo.state.jobs.get(proofJob.id)!);
function proofHeartbeat():CurrentFilmMixedJob {
  const prior=proofSaved(),domain=DurableJobStore.fromJobs([prior]);domain.heartbeat(prior.id,worker,Date.now(),leaseMs);
  const next=currentFilmV3Job(domain.get(prior.id)!);
  if(next.claimedBy!==prior.claimedBy||next.leaseVersion!==prior.leaseVersion)throw new Error("Proof scenario heartbeat changed its real holder.");
  proofIo.state.jobs.set(next.id,next);return next;
}
async function proofFixture():Promise<void> {
  const final=await f.renderFinal(),base=final.job.currentFilm;
  if(!base)throw new Error("Retain the actual final film plan.");
  const plan=compileCurrentFilmMixedJob(base,{origins:[bindOriginalEditSource(final.receipt)],choices:base.materialization.slots.map((slot,ordinal)=>({
    ordinal,inputRevision:slot.inputRevision,originId:final.receipt.revision,source:{receiptRevision:final.receipt.revision,ordinal,
      logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:final.job.currentFilmCheckpoint!.rows[ordinal]!.record.revision}}))}),
    id="mixed-artifact-proof-only",input:JobInput={id,projectId:plan.projectId,idempotencyKey:id,currentFilm:plan,tier:plan.render.tier,stage:plan.render.stage,
      scriptVersion:plan.materialization.script.version,scriptText:plan.materialization.script.text,casting:plan.target.state.casting.candidate!,providerPlan:plan.render.providerPlan,
      rightsAttestedAt:f.project.rightsAttestedAt,animaticJobId:final.job.animaticJobId,animaticApprovedAt:final.job.animaticApprovedAt,
      totalFrames:plan.materialization.requestedFrames,costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:1,backoffMs:0},timeoutMs:300000};
  const domain=DurableJobStore.fromJobs([]);domain.enqueue(input);proofJob=currentFilmV3Job(domain.claimNext(Date.now(),{},{workerId:worker,leaseMs})!);
  // Model the SQL adapter's first fence, without changing execution/status.
  proofJob.leaseVersion=1;
  const project=f.projects.snapshot().projects[0]!,jobs=[f.studio.film,f.job,final.job,proofJob];
  proofIo=transport(project,jobs);proofMedia=new PostgresArtifactStore(proofIo.database,root,proofIo.client);
  const closure=compileCurrentFilmProofClosure(plan,freezeCurrentFilmProofContext({project,jobs}),compileCurrentFilmProofTarget(proofJob)),paths=new Set<string>();
  for(const {receipt}of closure.receipts)for(const file of receipt.files)paths.add(file.path);
  for(const {job:preview}of closure.previews){
    const output=preview.output!;
    for(const file of currentFilmRuntimeRecordedFiles(preview))paths.add(file.path);
    for(const path of [output.mp4Path,output.hlsPlaylistPath,output.captionsPath,output.captionsPath.slice(0,-4)+".srt",output.manifestPath,`${preview.projectId}/${preview.id}/clips/manifest.json`])paths.add(path);
    const prefix=output.hlsPlaylistPath.slice(0,-"index.m3u8".length);
    for(const name of readdirSync(join(root,dirname(output.hlsPlaylistPath))))paths.add(prefix+name);
  }
  // The transport double indexes the actual source files without converting
  // their manifests or constructing substitute completed-job metadata.
  for(const key of paths){
    const bytes=readFileSync(join(root,key)),sha256=createHash("sha256").update(bytes).digest("hex"),owner=key.split("/")[1]!;
    if(!jobs.some(job=>job.id===owner))throw new Error("The fixture artifact lost its original owner.");
    const object_key=`v1/${proofJob.projectId}/${owner}/${sha256}/${key.split("/").at(-1)}`;
    proofIo.state.files.set(key,{key,object_key,project_id:proofJob.projectId,job_id:owner,sha256,bytes:bytes.length,content_type:"application/octet-stream",backend:"s3"});
    proofIo.objects.set(object_key,new Uint8Array(bytes));
  }
}

proofCase(rollbackCase,async()=>{
  await attempt("proof-fixture-create",()=>proofFixture());const base=proofHeartbeat(),before=structuredClone(proofIo.state);proofIo.failProof();
  const failure=await attempt("proof-only-checkpoint-rollback",signal=>proofMedia.prepareCurrentFilmProof(base,worker,leaseMs,signal)).then(()=>undefined,error=>error);
  // A Bun test timeout remains the real failure. Do not create a late async
  // rejects matcher after cancellation; ordinary completion still asserts the
  // exact injected transaction failure and every unchanged-state condition.
  activeProofCase?.controller.signal.throwIfAborted();expect(failure).toBeInstanceOf(Error);expect((failure as Error).message).toContain("injected proof checkpoint rollback");
  expect(proofIo.state).toEqual(before);expect(proofSaved().currentFilmProof).toBeUndefined();expect(proofSaved().currentFilmOrigins).toBeUndefined();
  expect(proofSaved().status).toBe("running");expect(proofSaved().checkpointShots).toBe(0);expect(proofSaved().costUsd).toBe(0);
  expect([...proofIo.state.files.values()].some(row=>row.job_id===proofJob.id)).toBe(false);
  expect(proofIo.state.eventRecords.some(row=>row.type==="current-film.proof")).toBe(false);
},300000);

proofCase("proof-only preparation publishes exact real preview and original index atomically",async()=>{
  const base=proofHeartbeat(),before=structuredClone(proofIo.state);
  preparedProof=await attempt("proof-only-valid-publication",signal=>proofMedia.prepareCurrentFilmProof(base,worker,leaseMs,signal));
  const current=proofSaved(),files=currentFilmPreparedProofFiles(preparedProof,current);
  expect(current.currentFilmProof).toEqual(preparedProof);expect(current.currentFilmOrigins).toBeUndefined();expect(current.currentFilmCheckpoint).toBeUndefined();
  expect(current.status).toBe("running");expect(current.output).toBeUndefined();expect(current.startedAt).toBe(base.startedAt);expect(current.checkpointShots).toBe(0);expect(current.checkpointFrame).toBe(0);
  expect(current.costUsd).toBe(base.costUsd);expect(current.routeDecisions??[]).toEqual([]);
  expect(preparedProof.specification.previews.map(row=>row.jobId)).toEqual([f.job.id]);
  expect(files.length).toBe(preparedProof.specification.files);expect(proofIo.state.files.size-before.files.size).toBe(files.length);
  for(const file of files){const indexed=proofIo.state.files.get(file.path)!;expect(indexed.sha256).toBe(file.sha256);expect(indexed.bytes).toBe(file.bytes);}
  expect(proofIo.state.events).toBe(before.events+1);expect(proofIo.state.eventRecords.at(-1)).toEqual({type:"current-film.proof",body:{revision:preparedProof.revision,files:files.length}});
},300000);

proofCase("proof-only exact retry uses owned bytes after original and preview jobs and objects are removed",async()=>{
  const base=proofHeartbeat();
  for(const id of proofIo.state.jobs.keys())if(id!==base.id)proofIo.state.jobs.delete(id);
  for(const [key,row]of proofIo.state.files)if(row.job_id!==base.id){proofIo.state.files.delete(key);proofIo.objects.delete(row.object_key);}
  const before=structuredClone(proofIo.state),objects=proofIo.objects.size;
  const retried=await attempt("proof-only-owned-retry",signal=>proofMedia.prepareCurrentFilmProof(base,worker,leaseMs,signal));
  expect(retried).toEqual(preparedProof);expect(proofIo.state).toEqual(before);expect(proofIo.objects.size).toBe(objects);
},300000);

proofCase("proof-only checkpoint restores independently without original directories or a target clip manifest",async()=>{
  const base=proofHeartbeat();proofRestoredRoot=mkdtempSync(join(f.studio.root,"mixed-proof-owned-restored-"));
  const independent=transport(proofIo.state.project,[base]);
  for(const [key,row]of proofIo.state.files)independent.state.files.set(key,structuredClone(row));
  for(const [key,bytes]of proofIo.objects)independent.objects.set(key,new Uint8Array(bytes));
  await attempt("proof-only-independent-restore",signal=>new PostgresArtifactStore(independent.database,proofRestoredRoot,independent.client).restoreCheckpoint(base,signal));
  expect(independent.state.jobs.size).toBe(1);expect(existsSync(join(proofRestoredRoot,base.projectId,f.job.id))).toBe(false);
  expect(existsSync(join(proofRestoredRoot,base.projectId,f.studio.film.id))).toBe(false);
  expect(existsSync(join(proofRestoredRoot,base.projectId,base.id,"clips","manifest.json"))).toBe(false);
  for(const file of currentFilmPreparedProofFiles(preparedProof,base))expect(new Uint8Array(readFileSync(join(proofRestoredRoot,file.path)))).toEqual(new Uint8Array(readFileSync(join(root,file.path))));
  expect(independent.state.jobs.get(base.id)).toEqual(base);
},300000);

proofCase("proof-only restoration refuses missing indexed roles and corrupted native objects",async()=>{
  const base=proofHeartbeat(),file=currentFilmPreparedProofFiles(preparedProof,base).find(file=>file.path.endsWith(".wav"))!,row=proofIo.state.files.get(file.path)!;
  proofIo.state.files.delete(file.path);
  try{await expect(proofMedia.restoreCheckpoint(base,activeProofCase?.controller.signal)).rejects.toThrow(/Stored mixed|evidence/);}finally{proofIo.state.files.set(file.path,row);}
  const bytes=proofIo.objects.get(row.object_key)!,changed=new Uint8Array(bytes);changed[44]^=1;proofIo.objects.set(row.object_key,changed);
  try{await expect(attempt("proof-only-corrupt-native-restore",signal=>new PostgresArtifactStore(proofIo.database,mkdtempSync(join(f.studio.root,"mixed-proof-corrupt-")),proofIo.client).restoreCheckpoint(base,signal))).rejects.toThrow("checksum");}
  finally{proofIo.objects.set(row.object_key,bytes);}
  expect(proofSaved().currentFilmProof).toEqual(preparedProof);expect(proofSaved().status).toBe("running");
},300000);

let proofArchiveSnapshot:StateSnapshot,proofArchiveSource:string,proofArchiveZip:string,cancelledProof:CurrentFilmMixedJob;
async function proofArchiveCommand(args:string[],signal?:AbortSignal):Promise<{code:number;stdout:string;stderr:string}> {
  signal?.throwIfAborted();
  const child=Bun.spawn(["python",join(import.meta.dir,"../../../scripts/archive-package.py"),...args],{
    stdout:"pipe",stderr:"pipe",env:{...process.env,HV_BUN_PATH:process.execPath}});
  const abort=()=>{child.kill();};signal?.addEventListener("abort",abort,{once:true});if(signal?.aborted)abort();
  try{const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);signal?.throwIfAborted();return {code,stdout,stderr};}
  finally{signal?.removeEventListener("abort",abort);}
}
proofCase("proof-only actual cancelled checkpoint validates and packs a complete schema 16 archive from restored files",async()=>{
  const base=proofHeartbeat(),domain=DurableJobStore.fromJobs([base]);
  cancelledProof=currentFilmV3Job(domain.cancel(base.id,worker,"Archive the actual prepared proof boundary",Date.now()));
  expect(cancelledProof.status).toBe("cancelled");expect(cancelledProof.currentFilmProof).toEqual(preparedProof);expect(cancelledProof.startedAt).toBe(base.startedAt);
  expect(cancelledProof.currentFilmOrigins).toBeUndefined();expect(cancelledProof.output).toBeUndefined();
  const events=f.context.ledger.all();f.context.ledger.release(base.id);
  const ledger=JSON.parse(readFileSync(join(f.studio.root,"current-source-ledger.json"),"utf8")) as StateSnapshot["ledger"];
  expect(ledger.events).toEqual(events);expect(ledger.reservations).toEqual([]);
  const projectState={...f.projects.snapshot(),projects:[proofIo.state.project]};
  proofArchiveSnapshot=JSON.parse(JSON.stringify({schema:"hv-state/16",projects:projectState,jobs:[cancelledProof],
    ledger:{...ledger,events:[...f.studio.ledger.all(),...ledger.events]},reviews:[]})) as StateSnapshot;
  expect(stateSnapshotSchema(proofArchiveSnapshot.projects,proofArchiveSnapshot.jobs)).toBe("hv-state/16");
  expect(validateSnapshot(proofArchiveSnapshot)).toEqual(proofArchiveSnapshot);expect(proofArchiveSnapshot.jobs.map(job=>job.id)).toEqual([cancelledProof.id]);
  // Optional private qualification output retains the actual validated state
  // and independent bytes when a later archive bridge fails. The snapshot
  // writer requires an absent destination and never overwrites an old run.
  proofArchiveSource=process.env.HV_CURRENT_FILM_ARTIFACT_ARCHIVE_SOURCE??join(f.studio.root,"mixed-proof-archive-source-"+crypto.randomUUID());
  proofArchiveZip=join(f.studio.root,"mixed-proof-only.zip");
  writeStateSnapshot(proofArchiveSource,proofArchiveSnapshot);
  const artifactRoot=join(proofArchiveSource,"artifacts");mkdirSync(artifactRoot);
  for(const file of currentFilmPreparedProofFiles(preparedProof,cancelledProof)){
    const destination=join(artifactRoot,file.path);mkdirSync(dirname(destination),{recursive:true});copyFileSync(join(proofRestoredRoot,file.path),destination);
  }
  expect(existsSync(join(artifactRoot,base.projectId,f.job.id))).toBe(false);expect(existsSync(join(artifactRoot,base.projectId,f.studio.film.id))).toBe(false);
  const packed=await attempt("proof-only-schema16-pack",signal=>proofArchiveCommand(["pack","--source",proofArchiveSource,"--output",proofArchiveZip,"--project",base.projectId],signal));
  expect(packed.stderr).toBe("");expect(packed.code).toBe(0);
},300000);

proofCase("proof-only archive independently unpacks exact snapshot and native media without source jobs",async()=>{
  const destination=join(f.studio.root,"mixed-proof-only-unpacked");
  const result=await attempt("proof-only-schema16-unpack",signal=>proofArchiveCommand(["unpack","--source",proofArchiveZip,"--output",destination],signal));
  expect(result.stderr).toBe("");expect(result.code).toBe(0);expect(readStateSnapshot(destination)).toEqual(proofArchiveSnapshot);
  expect(readFileSync(join(destination,"state","projects.json"))).toEqual(readFileSync(join(proofArchiveSource,"state","projects.json")));
  const root=join(destination,"artifacts");await verifyCurrentFilmMixedArchive(cancelledProof,root);
  expect(existsSync(join(root,cancelledProof.projectId,f.job.id))).toBe(false);
  expect(existsSync(join(root,cancelledProof.projectId,f.studio.film.id))).toBe(false);
  for(const file of currentFilmPreparedProofFiles(preparedProof,cancelledProof))expect(new Uint8Array(readFileSync(join(root,file.path)))).toEqual(new Uint8Array(readFileSync(join(proofRestoredRoot,file.path))));
},300000);
