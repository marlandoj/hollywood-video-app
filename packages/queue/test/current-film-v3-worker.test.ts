import {afterAll,afterEach,beforeAll,expect,spyOn,test} from "bun:test";
import {appendFileSync,copyFileSync,readFileSync,existsSync,writeFileSync,mkdirSync,mkdtempSync,statSync} from "node:fs";
import {createHash} from "node:crypto";
import {dirname,join} from "node:path";
import {currentFilmSourceFixture} from "../../planner/test/current-film-source.fixture";
import {compileCurrentFilmMixedJob,type CurrentFilmJobV3} from "../../planner/src/current-film-mixed-jobs";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {contentHash} from "../../generator/src/capabilities";
import {RoutedGenerator} from "../../generator/src/router";
import * as providerCatalog from "../../generator/src/catalog";
import {currentFilmV3Job,createCurrentFilmRuntimePreviewReview} from "../../planner/src/current-film-runtime-context";
import {createCurrentFilmMixedPreviewReview} from "../../planner/src/current-film-mixed-job-context";
import {currentFilmPreparedProofFiles} from "../../planner/src/current-film-prepared-proof";
import {verifyCurrentFilmMixedMedia} from "../src/current-film-mixed-media";
import * as mixedNative from "../src/current-film-mixed-media";
import * as assembler from "../../assembler/src/index";
import {DurableJobStore,type JobInput} from "../src/index";
import {processNextJob,type WorkerContext} from "../src/worker";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,plan:CurrentFilmJobV3,ordinal:number;
type Scope={name:string;finished:boolean;abandoned:boolean;restore:(()=>void)[];nativeProfiled?:boolean};
type Restorable={mockRestore():void};
let activeScope:Scope|undefined,scopeFailure:Error|undefined;
const workers=new Set<Promise<Awaited<ReturnType<typeof processNextJob>>>>(),restorers=new WeakMap<Restorable,()=>void>(),observedStores=new WeakMap<DurableJobStore,Set<string>>();
const profilePath=process.env.HV_CURRENT_FILM_V3_WORKER_PROFILE,profileStarted=performance.now();
let profileRows=0,profileBytes=profilePath&&existsSync(profilePath)?statSync(profilePath).size:0;
function event(scope:Scope,phase:string,event:string,fields:Record<string,string|number|boolean>={}):void {
  if(!profilePath||profileRows>=10000)return;
  const line=JSON.stringify({at:new Date().toISOString(),elapsedMs:performance.now()-profileStarted,pid:process.pid,scope:scope.name,phase,event,abandoned:scope.abandoned,...fields})+"\n";
  const bytes=Buffer.byteLength(line);if(profileBytes+bytes>4*1024**2)return;
  appendFileSync(profilePath,line);profileBytes+=bytes;profileRows++;
}
function current(scope=activeScope):asserts scope is Scope {
  if(!scope||scope.abandoned||activeScope!==scope||scopeFailure)throw new Error("Refuse late worker-test assertions or fixture changes after an unfinished scenario.",{cause:scopeFailure});
}
function trackSpy<T extends Restorable>(spy:T,store?:DurableJobStore,key?:string):T {
  current();const scope=activeScope!;let restored=false;
  if(store&&key){const keys=observedStores.get(store)??new Set<string>();keys.add(key);observedStores.set(store,keys);}
  const restore=()=>{if(restored)return;restored=true;spy.mockRestore();if(store&&key)observedStores.get(store)?.delete(key);};
  restorers.set(spy,restore);scope.restore.push(restore);return spy;
}
function restoreSpy(spy:Restorable):void {restorers.get(spy)!();}
function scenario(name:string,run:()=>Promise<void>):Promise<void> {
  if(scopeFailure||activeScope&&!activeScope.finished)throw new Error("An earlier worker test did not finish; preserve its fixture and refuse another scenario.",{cause:scopeFailure});
  const scope:Scope={name,finished:false,abandoned:false,restore:[]};activeScope=scope;event(scope,"scenario","start");
  const operation=(async()=>{
    try{await run();current(scope);event(scope,"scenario","end");}
    catch(error){scopeFailure??=new Error("Worker scenario failed: "+name,{cause:error});event(scope,"scenario","rejected");throw error;}
    finally{for(const restore of scope.restore)restore();scope.finished=true;if(activeScope===scope)activeScope=undefined;}
  })();
  // Keep the rejection for Bun; also observe a late failure after its unchanged deadline.
  void operation.catch(()=>{});return operation;
}
function workerTest(name:string,run:()=>Promise<void>,timeout:number):void {test(name,()=>scenario(name,run),timeout);}
function abandon():void {
  const scope=activeScope;if(!scope||scope.finished)return;
  scope.abandoned=true;scopeFailure??=new Error("Worker scenario exceeded its unchanged deadline: "+scope.name);
  event(scope,"scenario","deadline",{pendingWorkers:workers.size});for(const restore of scope.restore)restore();
}
afterEach(abandon);
async function trace<T>(scope:Scope,name:string,run:()=>Promise<T>,fields:Record<string,string|number|boolean>={}):Promise<T> {
  const start=performance.now();event(scope,name,"start",fields);
  try{const value=await run();event(scope,name,"end",{...fields,durationMs:performance.now()-start});return value;}
  catch(error){event(scope,name,"rejected",{...fields,durationMs:performance.now()-start});throw error;}
}
async function phase<T>(name:string,run:()=>Promise<T>):Promise<T> {
  current();const scope=activeScope!,value=await trace(scope,name,run);current(scope);return value;
}
function checkpointTrace<T>(name:string,run:()=>T,fields:Record<string,string|number|boolean>={}):T {
  current();const scope=activeScope!,start=performance.now();event(scope,name,"start",fields);
  try{const value=run();event(scope,name,"end",{...fields,durationMs:performance.now()-start});return value;}
  catch(error){event(scope,name,"rejected",{...fields,durationMs:performance.now()-start});throw error;}
}
/** Each actual fault spy registers its method here, so profiling never wraps an
 * existing Bun spy with another spy or captures its mutable dispatcher. */
function profileStore(store:DurableJobStore):void {
  if(!profilePath)return;
  if(!observedStores.get(store)?.has("checkpointCurrentFilmProof")){
    const original=store.checkpointCurrentFilmProof.bind(store);
    trackSpy(spyOn(store,"checkpointCurrentFilmProof").mockImplementation((...args:Parameters<typeof original>)=>checkpointTrace("checkpoint.proof",()=>original(...args),{files:args[2].specification.files,bytes:args[2].specification.bytes})),store,"checkpointCurrentFilmProof");
  }
  if(!observedStores.get(store)?.has("checkpointCurrentFilmOrigins")){
    const original=store.checkpointCurrentFilmOrigins.bind(store);
    trackSpy(spyOn(store,"checkpointCurrentFilmOrigins").mockImplementation((...args:Parameters<typeof original>)=>checkpointTrace("checkpoint.origins",()=>original(...args),{origins:args[2].origins.length})),store,"checkpointCurrentFilmOrigins");
  }
  if(!observedStores.get(store)?.has("checkpoint")){
    const original=store.checkpoint.bind(store);
    trackSpy(spyOn(store,"checkpoint").mockImplementation((...args:Parameters<typeof original>)=>checkpointTrace("checkpoint.slot",()=>original(...args),{shots:args[2],frames:args[3]})),store,"checkpoint");
  }
}
async function runWorker(store:DurableJobStore,root:string,context:WorkerContext,label="worker"):Promise<Awaited<ReturnType<typeof processNextJob>>> {
  current();const scope=activeScope!;profileStore(store);
  if(profilePath&&!scope.nativeProfiled){
    scope.nativeProfiled=true;
    const verify=mixedNative.verifyCurrentFilmMixedMedia.bind(mixedNative),assemble=assembler.assembleCurrentFilmMixedAsync.bind(assembler);
    // One wrapper per scope, shared by interruption and resume. Nested phase
    // durations are diagnostic spans and must not be summed as independent work.
    trackSpy(spyOn(mixedNative,"verifyCurrentFilmMixedMedia").mockImplementation((...args:Parameters<typeof verify>)=>trace(scope,"media.verify",()=>verify(...args),{shots:args[0].checkpointShots,completed:Boolean(args[0].output)})));
    trackSpy(spyOn(assembler,"assembleCurrentFilmMixedAsync").mockImplementation((...args:Parameters<typeof assemble>)=>trace(scope,"media.assemble",()=>assemble(...args),{shots:args[1].rows.length})));
  }
  const onJobStarted=context.onJobStarted,checkedContext=onJobStarted?{...context,onJobStarted:async(job:Parameters<NonNullable<WorkerContext["onJobStarted"]>>[0])=>{current(scope);await onJobStarted(job);current(scope);}}:context;
  const operation=trace(scope,label,()=>processNextJob(store,root,checkedContext));workers.add(operation);void operation.catch(()=>{});
  try{const value=await operation;current(scope);return value;}finally{workers.delete(operation);}
}
function generation(owner:RoutedGenerator,original:RoutedGenerator["generate"],args:Parameters<RoutedGenerator["generate"]>,calls:string[]):ReturnType<RoutedGenerator["generate"]> {
  current();const scope=activeScope!;calls.push(args[2].shotId!);return trace(scope,"generation",()=>original.apply(owner,args),{call:calls.length});
}
beforeAll(()=>scenario("fixture setup",async()=>{
  await phase("fixture",async()=>{f=await currentFilmSourceFixture();});ordinal=f.job.currentFilmCheckpoint!.rows.findIndex(row=>Boolean(row.record.clip.speech));
  if(ordinal<0)throw new Error("The actual mixed worker fixture needs a native speech source.");
  const slot=f.plan.materialization.slots[ordinal]!,record=f.job.currentFilmCheckpoint!.rows[ordinal]!.record;
  plan=compileCurrentFilmMixedJob(f.plan,{origins:[bindOriginalEditSource(f.receipt)],choices:[{ordinal,inputRevision:slot.inputRevision,originId:f.receipt.revision,
    source:{receiptRevision:f.receipt.revision,ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:record.revision}}]});
}),180000);
afterAll(async()=>{abandon();if(workers.size||activeScope&&!activeScope.finished)throw new Error("Worker or fixture work is still active; retain its private files.");await f?.close();});
function input(id:string):JobInput {const p=plan;return {id,projectId:p.projectId,idempotencyKey:id,tier:p.render.tier,stage:p.render.stage,scriptVersion:p.materialization.script.version,
  scriptText:p.materialization.script.text,casting:p.target.state.casting.candidate!,providerPlan:p.render.providerPlan,currentFilm:p,rightsAttestedAt:f.project.rightsAttestedAt,
  animaticJobId:null,animaticApprovedAt:null,totalFrames:p.materialization.requestedFrames,costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:1,backoffMs:0},timeoutMs:600000};}

workerTest("actual V3 worker copies complete originals, adopts native speech without dispatch and publishes an independently verifiable preview",async()=>{
  const store=DurableJobStore.fromJobs(f.store.all());
  const request=input("actual-mixed-preview"),sourceBefore=contentHash(f.job),calls:string[]=[],generate=RoutedGenerator.prototype.generate;
  const spy=trackSpy(spyOn(RoutedGenerator.prototype,"generate").mockImplementation(function(this:RoutedGenerator,...args:Parameters<typeof generate>){return generation(this,generate,args,calls);}));
  let result;try{store.enqueue(request);result=await runWorker(store,f.studio.paths.artifactRoot,f.context);}finally{restoreSpy(spy);}
  expect(result?.failureReason??result?.cancelReason).toBeUndefined();expect(result?.status).toBe("done");
  const job=currentFilmV3Job(result!),selected=plan.materialization.slots[ordinal]!;
  expect(calls).not.toContain(selected.renderId);expect([...new Set(calls)]).toEqual(plan.selection.filter(slot=>slot.kind==="generate").map(slot=>slot.renderId));
  expect(f.context.ledger.all().filter(row=>row.jobId===job.id&&row.shotId===selected.renderId)).toEqual([]);
  expect(job.routeDecisions?.every(route=>!f.job.routeDecisions!.some(source=>source.id===route.id))).toBe(true);
  expect(job.currentFilmOrigins!.origins[0]!.copies).toHaveLength(f.receipt.files.length);
  expect(job.currentFilmCheckpoint!.rows[ordinal]!.kind).toBe("reused");expect(job.currentFilmCheckpoint!.rows.filter(row=>row.kind==="generated")).toHaveLength(plan.selection.length-1);
  expect(job.output!.currentFilm!.schema).toBe("hv-current-film-output/3");expect(existsSync(join(f.studio.paths.artifactRoot,job.projectId,job.id,"clips/manifest.json"))).toBe(false);
  expect(contentHash(f.job)).toBe(sourceBefore);await phase("verification",()=>verifyCurrentFilmMixedMedia(job,f.studio.paths.artifactRoot,async()=>{}));
  const manifest=readFileSync(join(f.studio.paths.artifactRoot,job.output!.manifestPath),"utf8");
  for(const forbidden of ["hv-current-film-job/3","hv-shot-execution-capture/1","routeDecisions","binding"])expect(manifest).not.toContain(forbidden);
  const review=createCurrentFilmMixedPreviewReview(job);expect(createCurrentFilmRuntimePreviewReview(job)).toEqual(review);
  const decision=f.projects.recordCurrentFilmDecision(f.studio.owner.token,job,review,"approved","Actual mixed preview");expect(decision?.approval.currentFilmReview?.schema).toBe("hv-current-film-preview-review/3");
},600000);

workerTest("origins-only interruption resumes with original execution time and refuses replayed worker state",async()=>{
  const store=DurableJobStore.fromJobs(f.store.all());
  const request=input("actual-mixed-origins-resume"),checkpoint=store.checkpointCurrentFilmOrigins.bind(store);let stopped=false;
  const fault=trackSpy(spyOn(store,"checkpointCurrentFilmOrigins").mockImplementation((...args:Parameters<typeof checkpoint>)=>{const value=checkpointTrace("checkpoint.origins",()=>checkpoint(...args),{origins:args[2].origins.length});if(!stopped){stopped=true;throw new Error("Fixture interruption after held originals");}return value;}),store,"checkpointCurrentFilmOrigins");
  let interrupted;try{store.enqueue(request);interrupted=await runWorker(store,f.studio.paths.artifactRoot,f.context,"worker.interrupted");}finally{restoreSpy(fault);}
  expect(stopped).toBe(true);expect(interrupted?.status).toBe("queued");const original=currentFilmV3Job(interrupted!);expect(original.checkpointShots).toBe(0);expect(original.currentFilmOrigins).toBeDefined();expect(original.startedAt).not.toBeNull();
  const requestWithProgress={...request,currentFilmOrigins:original.currentFilmOrigins};expect(()=>store.enqueue(requestWithProgress)).toThrow();
  const restored=DurableJobStore.fromJobs(store.all());const done=await runWorker(restored,f.studio.paths.artifactRoot,f.context,"worker.resumed");
  expect(done?.failureReason??done?.cancelReason).toBeUndefined();expect(done?.status).toBe("done");expect(done?.startedAt).toBe(original.startedAt);
  const completed=currentFilmV3Job(done!);expect(completed.currentFilmOrigins).toEqual(original.currentFilmOrigins);
  expect(completed.output!.mp4Path).toMatch(/\/exports\/[a-f0-9-]{36}\/export\.mp4$/);
  for(const row of completed.currentFilmCheckpoint!.rows)if(row.kind==="generated")expect(row.record.files.video.path).toMatch(/\/clips\/attempts\/[a-f0-9-]{36}\//);
},600000);

let proofResume:{store:DurableJobStore;queued:ReturnType<typeof currentFilmV3Job>;savedRevision:string;sourceRoot:string;sourceBefore:string;sourceFiles:Map<string,{bytes:number;sha256:string}>}|undefined;
workerTest("proof-only interruption settles an actual queued checkpoint before any originals, slots or dispatch",async()=>{
  const store=DurableJobStore.fromJobs(f.store.all()),request=input("actual-mixed-proof-only-resume"),sourceRoot=f.studio.paths.artifactRoot,
    sourceBefore=contentHash({source:f.job,bootstrap:f.studio.film}),sourceFiles=new Map([...f.receipt.files,...plan.library.origin!.request.source.files]
      .map(file=>{const bytes=readFileSync(join(sourceRoot,file.path));return [file.path,{bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")}] as const;})),calls:string[]=[],generate=RoutedGenerator.prototype.generate,
    checkpoint=store.checkpointCurrentFilmProof.bind(store);
  let stopped=false;
  const observe=trackSpy(spyOn(RoutedGenerator.prototype,"generate").mockImplementation(function(this:RoutedGenerator,...args:Parameters<typeof generate>){
    return generation(this,generate,args,calls);
  }));
  const fault=trackSpy(spyOn(store,"checkpointCurrentFilmProof").mockImplementation((...args:Parameters<typeof checkpoint>)=>{
    const result=checkpointTrace("checkpoint.proof",()=>checkpoint(...args),{files:args[2].specification.files,bytes:args[2].specification.bytes});if(!stopped){stopped=true;throw new Error("Fixture interruption after actual proof custody");}return result;
  }),store,"checkpointCurrentFilmProof");
  try{
    store.enqueue(request);let interrupted;
    try{interrupted=await runWorker(store,sourceRoot,f.context,"worker.interrupted");}finally{restoreSpy(fault);}
    expect(stopped).toBe(true);expect(interrupted?.status).toBe("queued");expect(calls).toEqual([]);
    const queued=currentFilmV3Job(interrupted!),proof=queued.currentFilmProof!;
    expect(proof).toBeDefined();expect(queued.currentFilmOrigins).toBeUndefined();expect(queued.currentFilmCheckpoint).toBeUndefined();
    expect(queued.output).toBeUndefined();expect(queued.checkpointShots).toBe(0);expect(queued.checkpointFrame).toBe(0);
    expect(queued.startedAt).not.toBeNull();expect(queued.retriesUsed).toBe(1);expect(queued.routeDecisions??[]).toEqual([]);
    expect(f.context.ledger.all().filter(event=>event.jobId===queued.id)).toEqual([]);
    expect(contentHash({source:f.job,bootstrap:f.studio.film})).toBe(sourceBefore);
    const savedRevision=contentHash(queued);expect(contentHash(store.get(queued.id))).toBe(savedRevision);
    // The dependent case resumes this exact target-only restored store. It does
    // not enqueue again or rebuild the plan, proof, retry state or execution time.
    const independent=DurableJobStore.fromJobs([queued]);expect(independent.all().map(job=>job.id)).toEqual([queued.id]);
    expect(contentHash(independent.get(queued.id))).toBe(savedRevision);
    proofResume={store:independent,queued,savedRevision,sourceRoot,sourceBefore,sourceFiles};
  }finally{restoreSpy(fault);restoreSpy(observe);}
},600000);

workerTest("proof-only saved checkpoint resumes from independent owned files with no original jobs or directories",async()=>{
  // A filtered second case must fail before creating files or starting a worker.
  if(!proofResume)throw new Error("The actual proof-only interruption must succeed before independent resume.");
  const {store:independent,queued,savedRevision,sourceRoot,sourceBefore,sourceFiles}=proofResume,proof=queued.currentFilmProof!,calls:string[]=[],generate=RoutedGenerator.prototype.generate;
  expect(contentHash(queued)).toBe(savedRevision);expect(contentHash(independent.get(queued.id))).toBe(savedRevision);
  expect(independent.all().map(job=>job.id)).toEqual([queued.id]);expect(queued.retriesUsed).toBe(1);
  const observe=trackSpy(spyOn(RoutedGenerator.prototype,"generate").mockImplementation(function(this:RoutedGenerator,...args:Parameters<typeof generate>){
    return generation(this,generate,args,calls);
  }));
  try{
    const independentRoot=mkdtempSync(join(f.studio.root,"mixed-proof-only-independent-")),files=currentFilmPreparedProofFiles(proof,queued);
    expect(files.length).toBe(proof.specification.files);
    checkpointTrace("independent.copy",()=>{for(const file of files){
      current();expect(file.path.startsWith(`${queued.projectId}/${queued.id}/proof/`)).toBe(true);
      const destination=join(independentRoot,file.path);mkdirSync(dirname(destination),{recursive:true});copyFileSync(join(sourceRoot,file.path),destination);
    }},{files:files.length,bytes:files.reduce((total,file)=>total+file.bytes,0)});
    expect(independent.all().map(job=>job.id)).toEqual([queued.id]);
    expect(existsSync(join(independentRoot,queued.projectId,f.job.id))).toBe(false);
    expect(existsSync(join(independentRoot,queued.projectId,f.studio.film.id))).toBe(false);
    expect(existsSync(join(independentRoot,queued.projectId,queued.id,"originals"))).toBe(false);
    const result=await runWorker(independent,independentRoot,f.context,"worker.resumed");
    expect(result?.failureReason??result?.cancelReason).toBeUndefined();expect(result?.status).toBe("done");
    const completed=currentFilmV3Job(result!),selected=plan.materialization.slots[ordinal]!;
    expect(completed.startedAt).toBe(queued.startedAt);expect(completed.currentFilmProof).toEqual(proof);expect(completed.retriesUsed).toBe(1);
    expect(completed.currentFilm).toEqual(queued.currentFilm);expect(completed.timeoutMs).toBe(queued.timeoutMs);
    expect(completed.currentFilmCheckpoint!.rows[ordinal]!.kind).toBe("reused");
    expect(calls).not.toContain(selected.renderId);expect([...new Set(calls)]).toEqual(plan.selection.filter(slot=>slot.kind==="generate").map(slot=>slot.renderId));
    const costs=f.context.ledger.all().filter(event=>event.jobId===completed.id),fresh=new Set(plan.selection.filter(slot=>slot.kind==="generate").map(slot=>slot.renderId));
    expect(costs.filter(event=>event.shotId===selected.renderId)).toEqual([]);expect(costs.every(event=>fresh.has(event.shotId))).toBe(true);
    expect(independent.all().map(job=>job.id)).toEqual([completed.id]);
    await phase("verification",()=>verifyCurrentFilmMixedMedia(completed,independentRoot,async()=>{}));
    for(const file of files)expect(readFileSync(join(independentRoot,file.path)).equals(readFileSync(join(sourceRoot,file.path)))).toBe(true);
    expect(existsSync(join(independentRoot,completed.projectId,f.job.id))).toBe(false);
    expect(existsSync(join(independentRoot,completed.projectId,f.studio.film.id))).toBe(false);
    expect(existsSync(join(independentRoot,completed.projectId,completed.id,"clips","manifest.json"))).toBe(false);
    const manifest=readFileSync(join(independentRoot,completed.output!.manifestPath),"utf8");
    for(const privateValue of ["hv-current-film-prepared-proof/1","hv-current-film-proof-copies/1","hv-shot-execution-capture/1","frozenContext"])expect(manifest).not.toContain(privateValue);
    expect(contentHash({source:f.job,bootstrap:f.studio.film})).toBe(sourceBefore);
    for(const [path,expected]of sourceFiles){const bytes=readFileSync(join(sourceRoot,path));expect(bytes.length).toBe(expected.bytes);expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected.sha256);}
  }finally{restoreSpy(observe);}
},600000);

let adoptedResume:{store:DurableJobStore;queued:ReturnType<typeof currentFilmV3Job>;savedRevision:string;storeRevision:string;sourceRoot:string;sourceBefore:string;sourceFiles:Map<string,{bytes:number;sha256:string}>}|undefined;
workerTest("a fully adopted film settles its complete queued prefix without constructing providers or recording generation costs",async()=>{
  const store=DurableJobStore.fromJobs(f.store.all());
  const allReuse=compileCurrentFilmMixedJob(f.plan,{origins:[bindOriginalEditSource(f.receipt)],choices:f.plan.materialization.slots.map((slot,index)=>({
    ordinal:index,inputRevision:slot.inputRevision,originId:f.receipt.revision,source:{receiptRevision:f.receipt.revision,ordinal:index,logicalShotId:slot.logicalShotId,
      renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:f.job.currentFilmCheckpoint!.rows[index]!.record.revision}}))});
  const request={...input("actual-mixed-all-reuse"),currentFilm:allReuse},sourceRoot=f.studio.paths.artifactRoot,
    sourceBefore=contentHash({source:f.job,bootstrap:f.studio.film}),sourceFiles=new Map([...f.receipt.files,...allReuse.library.origin!.request.source.files]
      .map(file=>{const bytes=readFileSync(join(sourceRoot,file.path));return [file.path,{bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")}] as const;})),
    calls:string[]=[],generate=RoutedGenerator.prototype.generate;
  const instantiate=trackSpy(spyOn(providerCatalog,"instantiateProviderPlan").mockImplementation(()=>{throw new Error("No provider should be constructed for adopted media");}));
  const observe=trackSpy(spyOn(RoutedGenerator.prototype,"generate").mockImplementation(function(this:RoutedGenerator,...args:Parameters<typeof generate>){
    return generation(this,generate,args,calls);
  }));
  const checkpoint=store.checkpoint.bind(store);let stopped=false;
  const fault=trackSpy(spyOn(store,"checkpoint").mockImplementation((...args:Parameters<typeof checkpoint>)=>{
    const value=checkpointTrace("checkpoint.slot",()=>checkpoint(...args),{shots:args[2],frames:args[3]}),held=store.get(request.id);
    if(!stopped&&held?.checkpointShots===allReuse.selection.length){stopped=true;throw new Error("Fixture interruption after complete adopted prefix");}return value;
  }),store,"checkpoint");
  try{
    store.enqueue(request);let interrupted;try{interrupted=await runWorker(store,sourceRoot,f.context,"worker.interrupted");}finally{restoreSpy(fault);}
    expect(stopped).toBe(true);expect(interrupted?.status).toBe("queued");expect(interrupted?.checkpointShots).toBe(allReuse.selection.length);
    const queued=currentFilmV3Job(interrupted!);
    expect(queued.startedAt).not.toBeNull();expect(queued.retriesUsed).toBe(1);expect(queued.currentFilm).toEqual(allReuse);
    expect(queued.currentFilmProof).toBeDefined();expect(queued.currentFilmOrigins).toBeDefined();expect(queued.output).toBeUndefined();
    expect(queued.currentFilmCheckpoint!.rows).toHaveLength(allReuse.selection.length);expect(queued.currentFilmCheckpoint!.rows.every(row=>row.kind==="reused")).toBe(true);
    expect(instantiate).not.toHaveBeenCalled();expect(calls).toEqual([]);expect(queued.routeDecisions??[]).toEqual([]);
    expect(f.context.ledger.all().filter(row=>row.jobId===queued.id)).toEqual([]);
    expect(contentHash({source:f.job,bootstrap:f.studio.film})).toBe(sourceBefore);
    for(const [path,expected]of sourceFiles){const bytes=readFileSync(join(sourceRoot,path));expect(bytes.length).toBe(expected.bytes);expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected.sha256);}
    const savedRevision=contentHash(queued),storeRevision=contentHash(store.all());expect(contentHash(store.get(queued.id))).toBe(savedRevision);
    // Retain one exact restored store at the settled boundary. The dependent case
    // performs no new admission and keeps the original plan, retry and start time.
    const restored=DurableJobStore.fromJobs(store.all());expect(contentHash(restored.all())).toBe(storeRevision);expect(contentHash(restored.get(queued.id))).toBe(savedRevision);
    adoptedResume={store:restored,queued,savedRevision,storeRevision,sourceRoot,sourceBefore,sourceFiles};
  }finally{restoreSpy(fault);restoreSpy(observe);restoreSpy(instantiate);}
},600000);

workerTest("a fully adopted film resumes its saved complete prefix without constructing providers or recording generation costs",async()=>{
  if(!adoptedResume)throw new Error("The actual fully adopted complete-prefix interruption must succeed before resume.");
  const {store,queued,savedRevision,storeRevision,sourceRoot,sourceBefore,sourceFiles}=adoptedResume,calls:string[]=[],generate=RoutedGenerator.prototype.generate;
  expect(contentHash(queued)).toBe(savedRevision);expect(contentHash(store.get(queued.id))).toBe(savedRevision);expect(contentHash(store.all())).toBe(storeRevision);
  expect(queued.retriesUsed).toBe(1);
  const instantiate=trackSpy(spyOn(providerCatalog,"instantiateProviderPlan").mockImplementation(()=>{throw new Error("No provider should be constructed for adopted media");}));
  const observe=trackSpy(spyOn(RoutedGenerator.prototype,"generate").mockImplementation(function(this:RoutedGenerator,...args:Parameters<typeof generate>){
    return generation(this,generate,args,calls);
  }));
  try{
    const result=await runWorker(store,sourceRoot,f.context,"worker.resumed");
    expect(result?.failureReason??result?.cancelReason).toBeUndefined();expect(result?.status).toBe("done");
    const job=currentFilmV3Job(result!);expect(job.startedAt).toBe(queued.startedAt);expect(job.retriesUsed).toBe(1);
    expect(job.currentFilm).toEqual(queued.currentFilm);expect(job.timeoutMs).toBe(queued.timeoutMs);
    expect(job.currentFilmProof).toEqual(queued.currentFilmProof);expect(job.currentFilmOrigins).toEqual(queued.currentFilmOrigins);
    expect(job.currentFilmCheckpoint).toEqual(queued.currentFilmCheckpoint);expect(job.checkpointShots).toBe(queued.checkpointShots);expect(job.checkpointFrame).toBe(queued.checkpointFrame);
    expect(job.currentFilmCheckpoint!.rows.every(row=>row.kind==="reused")).toBe(true);
    expect(job.output!.mp4Path).toMatch(/\/exports\/[a-f0-9-]{36}\/export\.mp4$/);
    expect(instantiate).not.toHaveBeenCalled();expect(calls).toEqual([]);expect(job.routeDecisions??[]).toEqual([]);
    expect(f.context.ledger.all().filter(row=>row.jobId===job.id)).toEqual([]);
    await phase("verification",()=>verifyCurrentFilmMixedMedia(job,sourceRoot,async()=>{}));
    expect(contentHash({source:f.job,bootstrap:f.studio.film})).toBe(sourceBefore);
    for(const [path,expected]of sourceFiles){const bytes=readFileSync(join(sourceRoot,path));expect(bytes.length).toBe(expected.bytes);expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected.sha256);}
  }finally{restoreSpy(observe);restoreSpy(instantiate);}
},600000);

workerTest("expired mixed execution stops before any original copy or provider generation",async()=>{
  const store=DurableJobStore.fromJobs(f.store.all());
  const request={...input("actual-mixed-expired"),timeoutMs:1000,retryPolicy:{maxRetries:0,backoffMs:0}};let clock=Date.now();
  const generate=trackSpy(spyOn(RoutedGenerator.prototype,"generate").mockImplementation(async()=>{throw new Error("Expired jobs cannot dispatch");}));
  let result;try{store.enqueue(request);result=await runWorker(store,f.studio.paths.artifactRoot,{...f.context,now:()=>clock,onJobStarted:async()=>{clock+=1001;}});
    expect(generate).not.toHaveBeenCalled();}finally{restoreSpy(generate);}
  expect(result?.status).toBe("failed");expect(result?.failureReason).toContain("timeout");expect(result?.currentFilmOrigins).toBeUndefined();
},30000);

workerTest("mixed execution refuses a changed workspace owner before reservation or provider dispatch",async()=>{
  const store=DurableJobStore.fromJobs(f.store.all()),request={...input("actual-mixed-workspace-conflict"),retryPolicy:{maxRetries:0,backoffMs:0}};
  const path=join(f.studio.paths.artifactRoot,request.projectId,request.id);writeFileSync(path,"existing unrelated file");
  const generate=trackSpy(spyOn(RoutedGenerator.prototype,"generate").mockImplementation(async()=>{throw new Error("Invalid workspaces cannot dispatch");}));
  const reserve=trackSpy(spyOn(f.context.ledger,"reserve"));
  let result;try{store.enqueue(request);result=await runWorker(store,f.studio.paths.artifactRoot,f.context);
    expect(generate).not.toHaveBeenCalled();expect(reserve).not.toHaveBeenCalled();
  }finally{restoreSpy(generate);restoreSpy(reserve);}
  expect(result?.status).toBe("failed");expect(result?.failureReason).toContain("workspace ownership");
  expect(result?.currentFilmOrigins).toBeUndefined();expect(readFileSync(path,"utf8")).toBe("existing unrelated file");
},30000);

workerTest("a stale mixed worker cannot evict a replacement holder's local files",async()=>{
  const store=DurableJobStore.fromJobs(f.store.all()),request=input("actual-mixed-replacement-cache"),leaseMs=1000;
  let clock=Date.now(),evictions=0;const directory=join(f.studio.paths.artifactRoot,request.projectId,request.id),sentinel=join(directory,"replacement-owned.bin");
  const artifacts={removeCache(){evictions++;writeFileSync(sentinel,"evicted");}} as unknown as NonNullable<WorkerContext["artifacts"]>;
  const generate=trackSpy(spyOn(RoutedGenerator.prototype,"generate").mockImplementation(async()=>{throw new Error("A stale holder cannot dispatch");}));
  let result;try{store.enqueue(request);result=await runWorker(store,f.studio.paths.artifactRoot,{...f.context,artifacts,workerId:"stale-mixed-worker",leaseMs,now:()=>clock,
    onJobStarted:async()=>{
      clock+=leaseMs+1;const replacement=store.claimNext(clock,{},{workerId:"replacement-mixed-worker",leaseMs});
      expect(replacement?.id).toBe(request.id);mkdirSync(directory,{recursive:true});writeFileSync(sentinel,"replacement retained");
    }});expect(generate).not.toHaveBeenCalled();
  }finally{restoreSpy(generate);}
  expect(result?.status).toBe("running");expect(result?.claimedBy).toBe("replacement-mixed-worker");expect(evictions).toBe(0);
  expect(readFileSync(sentinel,"utf8")).toBe("replacement retained");
},30000);
