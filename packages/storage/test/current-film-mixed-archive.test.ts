import {afterAll,afterEach,beforeAll,expect,spyOn,test} from "bun:test";
import {copyFileSync,existsSync,lstatSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {dirname,join,sep} from "node:path";
import {currentFilmSourceFixture} from "../../planner/test/current-film-source.fixture";
import {compileCurrentFilmMixedJob} from "../../planner/src/current-film-mixed-jobs";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {currentFilmV3Job} from "../../planner/src/current-film-runtime-context";
import {currentFilmMixedRecordedFiles,createCurrentFilmMixedPreviewReview,type CurrentFilmMixedJob} from "../../planner/src/current-film-mixed-job-context";
import {currentFilmPreparedProofFiles} from "../../planner/src/current-film-prepared-proof";
import {DurableJobStore,type JobInput} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {CostLedger} from "../../operator/src/index";
import {verifyCurrentFilmMixedArchive} from "../../../scripts/verify-current-film-mixed-archive";
import {readStateSnapshot,stateSnapshotSchema,validateSnapshot,writeStateSnapshot,type StateSnapshot} from "../src/snapshots";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,job:CurrentFilmMixedJob,snapshot:StateSnapshot,originsBoundary:CurrentFilmMixedJob,originsLedger:StateSnapshot["ledger"];
let prefixBoundary:CurrentFilmMixedJob|undefined,prefixLedger:StateSnapshot["ledger"],originsCancelled:CurrentFilmMixedJob,prefixCancelled:CurrentFilmMixedJob|undefined;
let scenarioFailure:Error|undefined,preserveFixture=false;
let activeScenario:{name:string;controller:AbortController;finished:boolean;drained:Promise<void>}|undefined;
function scenario(name:string,run:()=>Promise<void>):Promise<void> {
  if(scenarioFailure)throw new Error("An earlier archive scenario did not complete; refusing dependent fixture changes.",{cause:scenarioFailure});
  let finish!:()=>void;const state={name,controller:new AbortController(),finished:false,drained:new Promise<void>(resolve=>{finish=resolve;})};activeScenario=state;
  const operation=(async()=>{
    try{await run();}catch(error){scenarioFailure=new Error("Archive prerequisite failed: "+name,{cause:error});throw error;}
    finally{state.finished=true;finish();if(activeScenario===state)activeScenario=undefined;}
  })();
  // Bun still receives the original rejection. Consume a late rejection if its
  // unchanged deadline wins, and never remove files while that work is active.
  void operation.catch(()=>{});return operation;
}
async function phase<T>(run:(signal:AbortSignal)=>Promise<T>):Promise<T> {
  const signal=activeScenario!.controller.signal;signal.throwIfAborted();const value=await run(signal);signal.throwIfAborted();return value;
}
function archiveTest(name:string,run:()=>Promise<void>,timeout:number):void {test(name,()=>scenario(name,run),timeout);}
async function drainScenario():Promise<void> {
  const state=activeScenario;if(!state||state.finished)return;
  const reason=new Error("Archive work exceeded its unchanged deadline: "+state.name);scenarioFailure??=reason;state.controller.abort(reason);
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([state.drained,new Promise<void>(resolve=>{timer=setTimeout(resolve,5000);})]);}
  finally{if(timer!==undefined)clearTimeout(timer);}
  // The worker and historical native bridge expose no caller signal. Preserve
  // their exact fixture if they remain active; this cleanup grants no extra run time.
  if(!state.finished){preserveFixture=true;throw new Error("Timed-out archive work did not drain; retain its private fixture.");}
}
afterEach(drainScenario);
beforeAll(()=>scenario("actual archive fixture setup",async()=>{
  await phase(async()=>{f=await currentFilmSourceFixture();});const ordinal=f.job.currentFilmCheckpoint!.rows.findIndex(row=>Boolean(row.record.files.audio));
  if(ordinal<0)throw new Error("Use a real native speech original for mixed archive qualification.");
  const slot=f.plan.materialization.slots[ordinal]!,record=f.job.currentFilmCheckpoint!.rows[ordinal]!.record;
  const plan=compileCurrentFilmMixedJob(f.plan,{origins:[bindOriginalEditSource(f.receipt)],choices:[{ordinal,inputRevision:slot.inputRevision,originId:f.receipt.revision,
    source:{receiptRevision:f.receipt.revision,ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:record.revision}}]});
  const id="mixed-archive-preview",request:JobInput={id,projectId:plan.projectId,idempotencyKey:id,currentFilm:plan,tier:plan.render.tier,stage:plan.render.stage,
    scriptVersion:plan.materialization.script.version,scriptText:plan.materialization.script.text,casting:plan.target.state.casting.candidate!,providerPlan:plan.render.providerPlan,
    rightsAttestedAt:f.project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:plan.materialization.requestedFrames,costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:600000};
  const store=DurableJobStore.fromJobs(f.store.all());store.enqueue(request);
  const ledgerAtBoundary=():StateSnapshot["ledger"]=>{
    const ledger=JSON.parse(readFileSync(join(f.studio.root,"current-source-ledger.json"),"utf8")) as StateSnapshot["ledger"];
    return structuredClone({...ledger,events:[...f.studio.ledger.all(),...ledger.events]});
  };
  const checkpoint=store.checkpointCurrentFilmOrigins.bind(store),observe=spyOn(store,"checkpointCurrentFilmOrigins").mockImplementation((...args)=>{
    checkpoint(...args);
    originsBoundary=structuredClone(currentFilmV3Job(store.get(args[0])!));
    originsLedger=ledgerAtBoundary();
    originsCancelled=cancelBoundary(originsBoundary);
  });
  const savePrefix=store.checkpoint.bind(store),observePrefix=spyOn(store,"checkpoint").mockImplementation((...args)=>{
    savePrefix(...args);
    if(!prefixBoundary){prefixBoundary=structuredClone(currentFilmV3Job(store.get(args[0])!));prefixLedger=ledgerAtBoundary();prefixCancelled=cancelBoundary(prefixBoundary);}
  });
  let result:Awaited<ReturnType<typeof processNextJob>>;try{result=await phase(()=>processNextJob(store,f.studio.paths.artifactRoot,f.context));}finally{observe.mockRestore();observePrefix.mockRestore();}
  if(result?.status!=="done")throw new Error("Actual V3 archive worker failed: "+(result?.failureReason??result?.cancelReason));
  job=currentFilmV3Job(result);
  f.projects.recordCurrentFilmDecision(f.studio.owner.token,job,createCurrentFilmMixedPreviewReview(job),"approved","Actual mixed archive preview");
  const state=f.projects.snapshot(),accepted=f.accept();accepted.animaticApprovals=state.projects[0]!.animaticApprovals;
  assertOwnedDependencies(job);
  snapshot=JSON.parse(JSON.stringify({schema:"hv-state/15",projects:{...state,projects:[accepted]},jobs:[job],ledger:{events:[...f.studio.ledger.all(),...f.context.ledger.all()],reservations:[]},reviews:[]})) as StateSnapshot;
}),600000);
afterAll(async()=>{await drainScenario();if(preserveFixture)throw new Error("Retain the archive fixture after work outlived cancellation.");await f?.close();});

function assertOwnedDependencies(mixed:CurrentFilmMixedJob):void {
  const proof=mixed.currentFilmProof;if(!proof)throw new Error("Removing original jobs requires actual complete prepared proof.");
  const files=currentFilmPreparedProofFiles(proof,mixed),owned=new Set(files.map(file=>file.path));
  for(const receipt of [f.receipt,f.plan.library.origin!.request.source]){
    const carrier=proof.specification.carriers.find(value=>value.receiptRevision===receipt.revision);
    if(!carrier)throw new Error("Prepared proof must retain both direct-source and bootstrap receipts.");
    expect(carrier.copies.map(copy=>copy.original).sort((a,b)=>a.path.localeCompare(b.path))).toEqual([...receipt.files].sort((a,b)=>a.path.localeCompare(b.path)));
    expect(carrier.copies.every(copy=>owned.has(copy.owned.path))).toBe(true);
  }
}

function prepared(name:string,state=snapshot):string {
  const root=join(f.studio.root,name);writeStateSnapshot(root,state);
  const mixed=currentFilmV3Job(state.jobs.find(value=>value.id===job.id)!);
  assertOwnedDependencies(mixed);expect(state.jobs.map(value=>value.id)).toEqual([mixed.id]);
  const files=new Set(currentFilmMixedRecordedFiles(mixed).map(file=>file.path));
  if(mixed.output){
    files.add(mixed.output.manifestPath);files.add(mixed.output.hlsPlaylistPath);
    const prefix=mixed.output.hlsPlaylistPath.slice(0,-"index.m3u8".length);
    for(const name of readFileSync(join(f.studio.paths.artifactRoot,mixed.output.hlsPlaylistPath),"utf8").split(/\r?\n/).map(value=>value.trim()).filter(value=>value&&!value.startsWith("#")))files.add(prefix+name);
  }
  for(const key of files){
    activeScenario!.controller.signal.throwIfAborted();
    expect(key.startsWith(`${mixed.projectId}/${mixed.id}/`)).toBe(true);
    const target=join(root,"artifacts",key);mkdirSync(dirname(target),{recursive:true});copyFileSync(join(f.studio.paths.artifactRoot,key),target);
  }
  for(const original of [f.job,f.studio.film])expect(existsSync(join(root,"artifacts",original.projectId,original.id))).toBe(false);
  return root;
}
async function python(args:string[]){
  return phase(async signal=>{
    const child=Bun.spawn(["python",join(import.meta.dir,"../../../scripts/archive-package.py"),...args],{stdout:"pipe",stderr:"pipe",env:{...process.env,HV_BUN_PATH:process.execPath}});
    // Python can itself own a native/Bun verifier. Killing this exact child
    // cannot prove every descendant exited, so retain the fixture on abort.
    const abort=()=>{preserveFixture=true;child.kill();};signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
    try{const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {code,stdout,stderr};}
    finally{signal.removeEventListener("abort",abort);}
  });
}
async function refuseArchive(value:CurrentFilmMixedJob,root:string,message?:string):Promise<void> {
  let refusal:unknown;try{await phase(()=>verifyCurrentFilmMixedArchive(value,root));}catch(error){refusal=error;}
  // A deadline remains a failed scenario, not a successful corruption assertion.
  activeScenario!.controller.signal.throwIfAborted();expect(refusal).toBeInstanceOf(Error);
  if(message)expect((refusal as Error).message).toContain(message);
}
function cancelBoundary(boundary:CurrentFilmMixedJob):CurrentFilmMixedJob {
  if(!boundary.claimedBy)throw new Error("Cancel only an actual held checkpoint.");
  // Execute cancellation while the observed lease is still valid, on an
  // isolated store. The original worker continues from its unchanged holder.
  const domain=DurableJobStore.fromJobs([boundary]);return currentFilmV3Job(domain.cancel(boundary.id,boundary.claimedBy,"Archive this actual checkpoint",Date.now()));
}
function drainedBoundary(boundary:CurrentFilmMixedJob,prefix:CurrentFilmMixedJob,ledger:StateSnapshot["ledger"],name:string):StateSnapshot {
  const state=structuredClone(snapshot);
  expect(prefix.status).toBe("cancelled");expect(prefix.cancelReason).toBe("Archive this actual checkpoint");expect(prefix.completedAt).not.toBeNull();
  expect(prefix.startedAt).toBe(boundary.startedAt);expect(prefix.currentFilmProof).toEqual(boundary.currentFilmProof);
  expect(prefix.currentFilmOrigins).toEqual(boundary.currentFilmOrigins);expect(prefix.currentFilmCheckpoint).toEqual(boundary.currentFilmCheckpoint);
  expect(prefix.claimedBy).toBeNull();expect(prefix.leaseExpiresAt).toBeNull();
  state.jobs=state.jobs.map(value=>value.id===job.id?prefix:value);
  const ledgerPath=join(f.studio.root,name+"-drained-ledger.json");writeFileSync(ledgerPath,JSON.stringify(ledger));new CostLedger(ledgerPath).release(job.id);
  state.ledger=JSON.parse(readFileSync(ledgerPath,"utf8")) as StateSnapshot["ledger"];
  expect(state.ledger.events).toEqual(ledger.events);expect(state.ledger.reservations).toEqual([]);
  state.projects.projects[0]!.animaticApprovals=state.projects.projects[0]!.animaticApprovals.filter(value=>value.animaticJobId!==job.id);
  return state;
}

archiveTest("actual mixed worker output survives schema15 pack/unpack with original source jobs and paths absent",async()=>{
  expect(job.currentFilmProof).toBeDefined();expect(job.currentFilmProof!.specification.target?.jobId).toBe(job.id);
  expect(stateSnapshotSchema(snapshot.projects,snapshot.jobs)).toBe("hv-state/15");expect(validateSnapshot(snapshot)).toBe(snapshot);
  expect(()=>validateSnapshot({...snapshot,schema:"hv-state/14"})).toThrow("schema 15");
  expect(snapshot.jobs.map(value=>value.id)).toEqual([job.id]);expect(snapshot.ledger.events.some(event=>event.jobId===f.job.id)).toBe(true);
  expect(snapshot.ledger.events.some(event=>event.jobId===f.studio.film.id)).toBe(true);
  expect(job.currentFilmCheckpoint!.rows.some(row=>row.kind==="generated")).toBe(true);expect(job.currentFilmCheckpoint!.rows.some(row=>row.kind==="reused")).toBe(true);
  const source=prepared("mixed-archive-source"),archive=join(f.studio.root,"mixed-real.zip"),restored=join(f.studio.root,"mixed-restored");
  expect(existsSync(join(source,"artifacts",f.job.projectId,f.job.id))).toBe(false);expect(existsSync(join(source,"artifacts",job.projectId,job.id,"clips/manifest.json"))).toBe(false);
  expect(existsSync(join(source,"artifacts",f.studio.film.projectId,f.studio.film.id))).toBe(false);
  const expected=new Map(currentFilmMixedRecordedFiles(job).map(file=>[file.path,readFileSync(join(source,"artifacts",file.path))]));
  // Remove the actual old owners as well as omitting them from the archive input.
  // Later cases can use only the mixed target's independently retained proof.
  for(const original of [f.job,f.studio.film]){
    const path=join(f.studio.paths.artifactRoot,original.projectId,original.id),actual=realpathSync(path),root=realpathSync(f.studio.paths.artifactRoot);
    if(lstatSync(path).isSymbolicLink()||!actual.startsWith(root+sep)||!actual.startsWith(realpathSync(f.studio.root)+sep))throw new Error("Unsafe original fixture cleanup.");
    rmSync(actual,{recursive:true});expect(existsSync(path)).toBe(false);
  }
  const packed=await python(["pack","--source",source,"--output",archive,"--project",job.projectId]);expect(packed.stderr).toBe("");expect(packed.code).toBe(0);
  const removed=realpathSync(join(source,"artifacts"));if(!removed.startsWith(realpathSync(f.studio.root)+sep))throw new Error("Unsafe mixed fixture cleanup.");rmSync(removed,{recursive:true});
  const unpacked=await python(["unpack","--source",archive,"--output",restored]);expect(unpacked.stderr).toBe("");expect(unpacked.code).toBe(0);
  expect(readStateSnapshot(restored)).toEqual(snapshot);
  for(const original of [f.job,f.studio.film])expect(existsSync(join(restored,"artifacts",original.projectId,original.id))).toBe(false);
  await phase(()=>verifyCurrentFilmMixedArchive(job,join(restored,"artifacts")));
  for(const [path,bytes]of expected)expect(readFileSync(join(restored,"artifacts",path))).toEqual(bytes);
},240000);

archiveTest("origins-only drained archive verifies all original roles before any selected slot exists",async()=>{
  // Observe the real durable save before any selected slot dispatch. Drain an
  // isolated copy of that boundary, preserving its original journal and costs.
  expect(originsBoundary.status).toBe("running");expect(originsBoundary.currentFilmOrigins).toBeDefined();
  expect(originsBoundary.currentFilmProof).toEqual(job.currentFilmProof);
  expect(originsBoundary.currentFilmCheckpoint).toBeUndefined();expect(originsBoundary.output).toBeUndefined();
  expect(originsBoundary.checkpointShots).toBe(0);expect(originsBoundary.checkpointFrame).toBe(0);expect(originsBoundary.routeDecisions??[]).toEqual([]);
  expect(originsLedger.events.some(event=>event.jobId===job.id)).toBe(false);expect(originsLedger.reservations.map(value=>value.jobId)).toEqual([job.id]);
  const state=drainedBoundary(originsBoundary,originsCancelled,originsLedger,"mixed-origins"),prefix=currentFilmV3Job(state.jobs.find(value=>value.id===job.id)!);
  const source=prepared("mixed-origins-only",state),archive=join(f.studio.root,"mixed-origins-only.zip");
  expect(validateSnapshot(state)).toBe(state);await phase(()=>verifyCurrentFilmMixedArchive(prefix,join(source,"artifacts")));
  const packed=await python(["pack","--source",source,"--output",archive,"--project",job.projectId]);expect(packed.stderr).toBe("");expect(packed.code).toBe(0);
  const unselected=prefix.currentFilmOrigins!.origins[0]!.copies.find(copy=>copy.original.path===f.job.output!.mp4Path)!;
  const path=join(source,"artifacts",unselected.owned.path),bytes=readFileSync(path);bytes[bytes.length-1]^=1;writeFileSync(path,bytes);
  await refuseArchive(prefix,join(source,"artifacts"));
},180000);

archiveTest("actual positive mixed prefix retains its journal, accounting and owned roles without a legacy manifest",async()=>{
  if(!prefixBoundary||!prefixCancelled)throw new Error("The worker must persist a real selected slot before completing.");
  expect(prefixBoundary.status).toBe("running");expect(prefixBoundary.currentFilmCheckpoint!.rows).toHaveLength(1);expect(prefixBoundary.output).toBeUndefined();
  expect(prefixBoundary.currentFilmProof).toEqual(job.currentFilmProof);
  const state=drainedBoundary(prefixBoundary,prefixCancelled,prefixLedger,"mixed-prefix"),prefix=currentFilmV3Job(state.jobs.find(value=>value.id===job.id)!);
  expect(prefix.routeDecisions).toEqual(prefixBoundary.routeDecisions);expect(prefix.costUsd).toBe(prefixBoundary.costUsd);
  const source=prepared("mixed-positive-prefix",state),archive=join(f.studio.root,"mixed-positive-prefix.zip"),restored=join(f.studio.root,"mixed-prefix-restored");
  expect(existsSync(join(source,"artifacts",job.projectId,job.id,"clips/manifest.json"))).toBe(false);
  expect(validateSnapshot(state)).toBe(state);await phase(()=>verifyCurrentFilmMixedArchive(prefix,join(source,"artifacts")));
  const packed=await python(["pack","--source",source,"--output",archive,"--project",job.projectId]);expect(packed.stderr).toBe("");expect(packed.code).toBe(0);
  const unpacked=await python(["unpack","--source",archive,"--output",restored]);expect(unpacked.stderr).toBe("");expect(unpacked.code).toBe(0);
  const roundtrip=readStateSnapshot(restored);expect(roundtrip).toEqual(JSON.parse(JSON.stringify(state)));
  for(const original of [f.job,f.studio.film])expect(existsSync(join(restored,"artifacts",original.projectId,original.id))).toBe(false);
  await phase(()=>verifyCurrentFilmMixedArchive(currentFilmV3Job(roundtrip.jobs.find(value=>value.id===job.id)!),join(restored,"artifacts")));
},240000);

archiveTest("archive media verification rejects unindexed role files and altered public provenance",async()=>{
  const source=prepared("mixed-archive-adversarial"),root=join(source,"artifacts"),unknown=join(root,job.projectId,job.id,"unindexed.wav");writeFileSync(unknown,"not an owned role");
  await refuseArchive(job,root,"complete owned inventory");rmSync(unknown);
  const path=join(root,job.output!.manifestPath),manifest=JSON.parse(readFileSync(path,"utf8"));manifest.videoSha256="f".repeat(64);writeFileSync(path,JSON.stringify(manifest));
  await refuseArchive(job,root,"public mixed provenance");
},120000);
