import {afterAll,afterEach,describe,expect,spyOn,test} from "bun:test";
import {createHash} from "node:crypto";
import {existsSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {currentFilmSourceFixture} from "../../planner/test/current-film-source.fixture";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {compileCurrentFilmJob} from "../../planner/src/current-film-jobs";
import {compileCurrentFilmMixedJob,type CurrentFilmJobV3} from "../../planner/src/current-film-mixed-jobs";
import {currentFilmV3Job} from "../../planner/src/current-film-runtime-context";
import {createCurrentFilmMixedPreviewReview,currentFilmMixedRecordedFiles,type CurrentFilmMixedJob} from "../../planner/src/current-film-mixed-job-context";
import {contentHash} from "../../generator/src/capabilities";
import {createProviderPlan} from "../../generator/src/catalog";
import {RoutedGenerator} from "../../generator/src/router";
import {verifyCurrentFilmMixedMedia} from "../../queue/src/current-film-mixed-media";
import {LeaseError,type Job,type JobInput} from "../../queue/src/index";
import {processNextJob as executeWorker,type WorkerContext} from "../../queue/src/worker";
import type {PersistedProject} from "../../api/src/index";
import {StudioDatabase} from "../src/database";
import {PostgresProjectService} from "../src/projects";
import {PostgresJobStore} from "../src/jobs";
import {PostgresCostLedger} from "../src/ledger";
import {PostgresReviewQueue} from "../src/reviews";
import {PostgresArtifactStore,objectClient} from "../src/artifacts";
import {exportProjectArchive,importProjectArchive} from "../src/archives";
import {exportStateSnapshot,importStateSnapshot,readStateSnapshot,validateSnapshot,type StateSnapshot} from "../src/snapshots";

const enabled=Boolean(process.env.HV_PG_ADMIN_URL&&process.env.HV_API_DATABASE_URL&&process.env.HV_WORKER_DATABASE_URL&&process.env.HV_S3_ENDPOINT&&process.env.HV_S3_BUCKET&&process.env.HV_S3_FLEET_TEST_BUCKET);
function databaseName(name:string):string {if(!/^hv_mixed_worker_[a-f0-9]{32}$/.test(name))throw new Error("Unsafe mixed-worker fixture database");return name;}
function databaseUrl(value:string,name:string):string {const url=new URL(value);url.pathname="/"+databaseName(name);return url.href;}
function files(root:string):string[] {return readdirSync(root,{withFileTypes:true}).flatMap(entry=>{
  if(entry.isSymbolicLink())throw new Error("Fixture media cannot contain links");const path=join(root,entry.name);
  if(entry.isDirectory())return files(path);if(!entry.isFile())throw new Error("Fixture media must be regular files");return [path];
});}
function removeOwned(path:string,root:string):void {if(!existsSync(path))return;const actual=realpathSync(path);
  if(actual!==path||!actual.startsWith(realpathSync(root)+sep))throw new Error("Unsafe mixed-worker fixture media removal");rmSync(actual,{recursive:true,force:true});
}
function cleanup(root:string):void {if(!root.startsWith(realpathSync(tmpdir())+sep+"hv-mixed-worker-pg-")||realpathSync(root)!==root)throw new Error("Unsafe mixed-worker fixture cleanup");rmSync(root,{recursive:true,force:true});}
async function clearObjects(client:ReturnType<typeof objectClient>,projectId:string,jobId?:string):Promise<void> {
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)||jobId!==undefined&&!/^[A-Za-z0-9_-]{1,128}$/.test(jobId))throw new Error("Unsafe mixed-worker object scope");
  const prefix="v1/"+projectId+"/"+(jobId?jobId+"/":"");
  for(let page=0;page<100;page++){const entries=(await client.list({prefix,maxKeys:1000})).contents??[];if(!entries.length)return;
    for(const entry of entries){if(!entry.key.startsWith(prefix))throw new Error("Fixture object escaped its project");await client.file(entry.key).delete();}}
  throw new Error("Fixture object cleanup exceeded its bound");
}

// This case requires actual PostgreSQL and S3. The local transport-double suite
// cannot qualify admission locks, durable checkpoints or independent restoration.
describe("real PostgreSQL/S3 mixed-worker lifecycle",()=>{
  type Phase={ordinal:number;controller:AbortController;promise:Promise<void>;finished:boolean};
  type ActiveWorker={store:PostgresJobStore;job:Job;cancelRequested:boolean};
  let active:Phase|undefined,activeWorker:ActiveWorker|undefined,failed=false,completed=0;
  const cancellations=new Set<Promise<void>>();
  function current():void {
    if(failed||!active||active.finished||active.controller.signal.aborted)throw new Error("Mixed-worker service phase is no longer active.");
  }
  function signal():AbortSignal {current();return active!.controller.signal;}
  async function checked<T>(run:()=>PromiseLike<T>|T):Promise<T> {current();const value=await run();current();return value;}
  async function settleAdmissions<T>(operations:Promise<T>[]):Promise<T[]> {
    // A rejected sibling must not start fixture cleanup while another write lives.
    const results=await Promise.allSettled(operations);
    return results.map(result=>{if(result.status==="rejected")throw result.reason;return result.value;});
  }
  function cancelObservedWorker():void {
    const observed=activeWorker;if(!observed||observed.cancelRequested)return;observed.cancelRequested=true;
    const task=(async()=>{
      const saved=await observed.store.get(observed.job.id);
      if(saved?.status==="running"&&saved.projectId===observed.job.projectId&&saved.claimedBy===observed.job.claimedBy&&saved.leaseVersion===observed.job.leaseVersion)
        await observed.store.cancel(saved.id,saved.claimedBy!,"Service fixture phase failed or timed out");
    })().then(()=>{},()=>{}).finally(()=>{cancellations.delete(task);});
    cancellations.add(task);
  }
  async function processNextJob(store:PostgresJobStore,artifactRoot:string,context:WorkerContext):ReturnType<typeof executeWorker> {
    current();
    try {
      return await executeWorker(store,artifactRoot,{...context,onJobStarted:async job=>{
        activeWorker={store,job:structuredClone(job),cancelRequested:false};
        if(failed||active?.controller.signal.aborted){cancelObservedWorker();throw new Error("Service fixture stopped after claim.");}
        current();await context.onJobStarted?.(job);current();
      }});
    } finally {activeWorker=undefined;}
  }
  async function settledWithin(promise:Promise<unknown>,milliseconds:number):Promise<boolean> {
    let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([promise.then(()=>true,()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),milliseconds);})]);}
    finally{if(timer!==undefined)clearTimeout(timer);}
  }
  function failStop():never {
    // Signalless work still owns process.env/resources. Do not run another file,
    // restore global environment, or delete a live worker/archive's fixture.
    process.stderr.write("Mixed-worker service fixture did not drain after failure; preserving resources and stopping this failed test runner.\n");
    process.exit(1);
  }
  async function* lifecycle():AsyncGenerator<number,void,void>{

const root=realpathSync(mkdtempSync(join(realpathSync(tmpdir()),"hv-mixed-worker-pg-"))),sourceName=databaseName("hv_mixed_worker_"+crypto.randomUUID().replaceAll("-","")),restoreName=databaseName("hv_mixed_worker_"+crypto.randomUUID().replaceAll("-",""));
  const control=new StudioDatabase(process.env.HV_PG_ADMIN_URL!),created=new Set<string>(),bucket=process.env.HV_S3_BUCKET,oldPool=process.env.HV_PROVIDER_POOL;
  const sourceClient=objectClient(),destinationClient=objectClient({...process.env,HV_S3_BUCKET:process.env.HV_S3_FLEET_TEST_BUCKET});
  let fixture:Awaited<ReturnType<typeof currentFilmSourceFixture>>|undefined,admin:StudioDatabase|undefined,api:StudioDatabase|undefined,worker:StudioDatabase|undefined,restored:StudioDatabase|undefined,cleanupProjectId:string|undefined;
  try{
    expect(bucket).not.toBe(process.env.HV_S3_FLEET_TEST_BUCKET);process.env.HV_PROVIDER_POOL='["mock"]';const f=await checked(async()=>{const acquired=await currentFilmSourceFixture();fixture=acquired;cleanupProjectId=acquired.job.projectId;return acquired;});const projectId=f.job.projectId;
    const ordinal=f.job.currentFilmCheckpoint!.rows.findIndex(row=>Boolean(row.record.files.audio));if(ordinal<0)throw new Error("The service fixture needs actual native speech.");
    const sourceRow=f.job.currentFilmCheckpoint!.rows[ordinal]!,slot=f.plan.materialization.slots[ordinal]!,native=sourceRow.record.files.audio!,sourceBefore=contentHash(f.job);
    const originalBytes=new Map(f.receipt.files.map(file=>[file.path,readFileSync(join(f.studio.paths.artifactRoot,file.path))]));
    const plan=compileCurrentFilmMixedJob(f.plan,{origins:[bindOriginalEditSource(f.receipt)],choices:[{ordinal,inputRevision:slot.inputRevision,originId:f.receipt.revision,
      source:{receiptRevision:f.receipt.revision,ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:sourceRow.record.revision}}]});
    await checked(async()=>{await control.sql.unsafe('CREATE DATABASE "'+sourceName+'"');created.add(sourceName);});admin=new StudioDatabase(databaseUrl(process.env.HV_PG_ADMIN_URL!,sourceName));await checked(async()=> (admin!.migrate()));
    const initial:StateSnapshot={schema:"hv-state/12",projects:f.projects.snapshot(),jobs:[f.studio.film,f.job],ledger:{events:[...f.studio.ledger.all(),...f.context.ledger.all()],reservations:[]},reviews:[]};
    validateSnapshot(initial);await checked(async()=> (importStateSnapshot(admin!,initial,500)));
    const importedMedia=new PostgresArtifactStore(admin,f.studio.paths.artifactRoot,sourceClient);
    for(const original of initial.jobs)expect((await checked(async()=> (importedMedia.importCompletedJob(original,files(join(f.studio.paths.artifactRoot,projectId,original.id)))))).files).toBeGreaterThan(0);
    api=new StudioDatabase(databaseUrl(process.env.HV_API_DATABASE_URL!,sourceName));worker=new StudioDatabase(databaseUrl(process.env.HV_WORKER_DATABASE_URL!,sourceName));
    const projects=new PostgresProjectService(api),ledger=new PostgresCostLedger(worker),store=new PostgresJobStore(worker).forProject(projectId),context={projects,ledger,reviewQueue:new PostgresReviewQueue(worker)};
    const counts=async()=>{const row=(await checked(async()=> (admin!.sql`select (select count(*) from hv_jobs where project_id=${projectId}) as jobs,(select count(*) from hv_provider_attempts where project_id=${projectId}) as attempts,(select count(*) from hv_cost_events where project_id=${projectId}) as costs,(select count(*) from hv_reservations where job_id in (select id from hv_jobs where project_id=${projectId})) as holds,(select count(*) from hv_outbox where project_id=${projectId}) as events`)))[0];return [row.jobs,row.attempts,row.costs,row.holds,row.events].map(Number);};
    const projectRow=async()=>{const row=(await checked(async()=> (admin!.sql`select body,version from hv_projects where id=${projectId}`)))[0];return {body:row.body as PersistedProject,version:Number(row.version)};};
    const input=(value:CurrentFilmJobV3,retries=0):JobInput=>({id:crypto.randomUUID(),projectId:projectId,idempotencyKey:crypto.randomUUID(),currentFilm:value,tier:value.render.tier,stage:value.render.stage,
      scriptVersion:value.materialization.script.version,scriptText:value.materialization.script.text,casting:value.target.state.casting.candidate!,providerPlan:value.render.providerPlan,
      rightsAttestedAt:f.project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:value.materialization.requestedFrames,costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:retries,backoffMs:0},timeoutMs:600000});
    const request=input(plan,1),before=await checked(async()=> (projectRow())),beforeCounts=await checked(async()=> (counts()));
    await checked(async()=> (expect(ledger.admit(crypto.randomUUID(),request,500)).rejects.toThrow()));
    await checked(async()=> (admin!.sql`update hv_projects set body=${{...before.body,rightsAttestedAt:null}}::jsonb where id=${projectId}`));
    try{await checked(async()=> (expect(ledger.admit(projectId,request,500)).rejects.toThrow(/rights|permission/)));expect(await checked(async()=> (counts()))).toEqual(beforeCounts);}finally{await admin!.sql`update hv_projects set body=${before.body}::jsonb where id=${projectId}`;}
    const originalCarrier=(await checked(async()=> (admin!.sql`select body from hv_jobs where id=${f.job.id}`)))[0].body as Job;
    await checked(async()=> (admin!.sql`update hv_jobs set body=${{...originalCarrier,linkExpiresAt:new Date(0).toISOString()}}::jsonb where id=${f.job.id}`));
    try{await checked(async()=> (expect(ledger.admit(projectId,request,500)).rejects.toThrow()));expect(await checked(async()=> (counts()))).toEqual(beforeCounts);}finally{await admin!.sql`update hv_jobs set body=${originalCarrier}::jsonb where id=${f.job.id}`;}
    const admissions=await checked(async()=> (settleAdmissions([ledger.admit(projectId,request,500),ledger.admit(projectId,{...request,id:crypto.randomUUID()},500)]))),admitted=admissions[0]!;
    expect(admissions[1]!.id).toBe(admitted.id);const jobId=admitted.id,afterAdmission=await checked(async()=> (counts())),reservation=(await checked(async()=> (admin!.sql`select * from hv_reservations where job_id=${jobId}`)))[0];
    expect(afterAdmission[0]).toBe(beforeCounts[0]!+1);expect(afterAdmission[3]).toBe(beforeCounts[3]!+1);
    expect((await checked(async()=> (ledger.admit(projectId,{...request,id:crypto.randomUUID()},500)))).id).toBe(jobId);expect(await checked(async()=> (counts()))).toEqual(afterAdmission);
    expect((await checked(async()=> (admin!.sql`select * from hv_reservations where job_id=${jobId}`)))[0]).toEqual(reservation);await checked(async()=> (expect(ledger.admit(projectId,{...request,costCapUsd:4},500)).rejects.toThrow()));expect(await checked(async()=> (projectRow()))).toEqual(before);

    current();yield 1;
    const firstRoot=join(root,"first"),firstMedia=new PostgresArtifactStore(worker,firstRoot,sourceClient),checkpoint=firstMedia.checkpointCurrentFilmOrigins.bind(firstMedia);let boundary:CurrentFilmMixedJob|undefined,checkpointChecksComplete=false;
    const interrupt=spyOn(firstMedia,"checkpointCurrentFilmOrigins").mockImplementation(async(...args:Parameters<typeof checkpoint>)=>{current();
      const untouched=await checked(async()=> (counts()));await checked(async()=> (expect(checkpoint({...args[0],leaseVersion:args[0].leaseVersion!+1},args[1],args[2],args[3],args[4])).rejects.toBeInstanceOf(LeaseError)));expect(await checked(async()=> (counts()))).toEqual(untouched);
      await checked(async()=> (checkpoint(...args)));const heldBoundary=currentFilmV3Job((await checked(async()=> (store.get(jobId))))!);boundary=heldBoundary;expect(heldBoundary.checkpointShots).toBe(0);expect(heldBoundary.currentFilmCheckpoint).toBeUndefined();
      expect(heldBoundary.currentFilmProof).toBeDefined();expect(heldBoundary.currentFilmProof!.specification.target?.jobId).toBe(jobId);
      const held=await checked(async()=> (counts()));await checked(async()=> (expect(ledger.beginAttempt({id:crypto.randomUUID(),projectId:projectId,jobId,shotId:slot.renderId,provider:"mock",workerId:args[1],leaseVersion:heldBoundary.leaseVersion!,estimateUsd:0,shotCapUsd:5})).rejects.toThrow("selected for generation")));expect(await checked(async()=> (counts()))).toEqual(held);
      const copy=heldBoundary.currentFilmOrigins!.origins[0]!.copies[0]!.owned;
      await checked(async()=> (admin!.sql`update hv_artifacts set bytes=bytes+1 where key=${copy.path}`));
      try{await checked(async()=> (expect(ledger.assertCurrentFilmContext(heldBoundary,args[1])).rejects.toThrow(/artifact index/)));expect(await checked(async()=> (counts()))).toEqual(held);}finally{await admin!.sql`update hv_artifacts set bytes=${copy.bytes} where key=${copy.path}`;}
      checkpointChecksComplete=true;throw new Error("Injected process loss after actual S3 original custody");
    });
    let paused:CurrentFilmMixedJob;try{paused=currentFilmV3Job((await checked(async()=> (processNextJob(store,firstRoot,{...context,artifacts:firstMedia,workerId:"mixed-first"}))))!);}finally{interrupt.mockRestore();}
    expect(checkpointChecksComplete).toBe(true);expect(boundary).toBeDefined();expect(paused.status).toBe("queued");expect(paused.checkpointShots).toBe(0);expect(paused.currentFilmOrigins).toEqual(boundary!.currentFilmOrigins);expect(paused.startedAt).toBe(boundary!.startedAt);
    expect(paused.currentFilmProof).toEqual(boundary!.currentFilmProof);
    expect((await checked(async()=> (admin!.sql`select id from hv_provider_attempts where job_id=${jobId}`)))).toHaveLength(0);await checked(async()=> (expect(exportStateSnapshot(admin!,projectId)).rejects.toThrow("drained")));
    current();yield 2;
    expect(existsSync(join(firstRoot,projectId,jobId))).toBe(true);removeOwned(join(firstRoot,projectId,jobId),root);
    // Preparation is now independently indexed. Remove the old V2 source while
    // retaining the explicit historical bootstrap and all source billing events.
    await checked(async()=> (clearObjects(sourceClient,projectId,f.job.id)));await checked(async()=> (admin!.sql`delete from hv_outbox where job_id=${f.job.id}`));await checked(async()=> (admin!.sql`delete from hv_artifacts where job_id=${f.job.id}`));await checked(async()=> (admin!.sql`delete from hv_jobs where id=${f.job.id}`));
    removeOwned(join(f.studio.paths.artifactRoot,projectId,f.job.id),f.studio.root);expect(await checked(async()=> (store.get(f.job.id)))).toBeUndefined();
    const secondRoot=join(root,"resumed"),secondMedia=new PostgresArtifactStore(worker,secondRoot,sourceClient);
    await checked(async()=> (secondMedia.restoreCheckpoint(paused,signal())));expect(existsSync(join(secondRoot,projectId,f.job.id))).toBe(false);expect(existsSync(join(secondRoot,projectId,jobId,"clips/manifest.json"))).toBe(false);
    for(const copy of paused.currentFilmOrigins!.origins[0]!.copies)expect(readFileSync(join(secondRoot,copy.owned.path))).toEqual(originalBytes.get(copy.original.path)!);
    current();yield 3;
    const calls:string[]=[],generate=RoutedGenerator.prototype.generate,observe=spyOn(RoutedGenerator.prototype,"generate").mockImplementation(function(this:RoutedGenerator,...args:Parameters<typeof generate>){calls.push(args[2].shotId!);return generate.apply(this,args);});
    let preview:CurrentFilmMixedJob;try{preview=currentFilmV3Job((await checked(async()=> (processNextJob(store,secondRoot,{...context,artifacts:secondMedia,workerId:"mixed-resumed"}))))!);}finally{observe.mockRestore();}
    expect(preview.failureReason??preview.cancelReason).toBeUndefined();expect(preview.status).toBe("done");expect(preview.retriesUsed).toBe(1);expect(preview.startedAt).toBe(boundary!.startedAt);
    const committedPreview=(await checked(async()=> (admin!.sql`select body,status,claimed_by,lease_expires_at,next_eligible_at,lease_version from hv_jobs where id=${jobId}`)))[0];
    expect(committedPreview.body).toEqual(preview);expect(committedPreview).toMatchObject({status:"done",claimed_by:null,lease_expires_at:null,next_eligible_at:null,lease_version:preview.leaseVersion});
    expect(Array.from(await checked(async()=> (admin!.sql`select event_type from hv_outbox where job_id=${jobId} and event_type in ('artifacts.exported','job.completed') order by event_type`)))).toEqual([{event_type:"artifacts.exported"},{event_type:"job.completed"}]);
    expect(preview.currentFilmOrigins).toEqual(boundary!.currentFilmOrigins);expect([...new Set(calls)]).toEqual(plan.selection.filter(value=>value.kind==="generate").map(value=>value.renderId));
    expect(preview.currentFilmProof).toEqual(boundary!.currentFilmProof);
    expect((await checked(async()=> (admin!.sql`select id from hv_provider_attempts where job_id=${jobId} and shot_id=${slot.renderId}`)))).toHaveLength(0);expect((await checked(async()=> (admin!.sql`select id from hv_cost_events where job_id=${jobId} and body->>'shotId'=${slot.renderId}`)))).toHaveLength(0);
    const attempted=await checked(async()=> (admin!.sql`select distinct shot_id from hv_provider_attempts where job_id=${jobId} order by shot_id`));
    expect(attempted.map((value:{shot_id:string})=>value.shot_id)).toEqual(plan.selection.filter(value=>value.kind==="generate").map(value=>value.renderId).sort());
    expect(preview.routeDecisions!.every(value=>plan.selection.some(selected=>selected.kind==="generate"&&selected.renderId===value.shotId))).toBe(true);
    expect(contentHash(f.job)).toBe(sourceBefore);expect(await checked(async()=> (projectRow()))).toEqual(before);expect(await checked(async()=> (ledger.monthSpend()))).toBe(0);
    current();yield 4;
    await checked(async()=> (secondMedia.restoreCheckpoint(preview,signal())));await checked(async()=> (verifyCurrentFilmMixedMedia(preview,secondRoot,async()=>{current();},signal())));
    const adoption=preview.currentFilmCheckpoint!.rows[ordinal]!;if(adoption.kind!=="reused")throw new Error("Actual native speech must be adopted.");
    const nativeCopy=adoption.adoption.copies.find(copy=>copy.role==="audio")!;expect(readFileSync(join(secondRoot,nativeCopy.owned.path))).toEqual(originalBytes.get(native.path)!);
    const review=createCurrentFilmMixedPreviewReview(preview),decision=(await checked(async()=> (projects.recordCurrentFilmDecision(f.studio.owner.token,preview,review,"approved","Use exact mixed preview"))))!;
    expect(decision.approval.currentFilmReview).toEqual(review);const approved=await checked(async()=> (projectRow()));expect((await checked(async()=> (projects.recordCurrentFilmDecision(f.studio.owner.token,preview,review,"approved","Use exact mixed preview"))))!.replayed).toBe(true);expect(await checked(async()=> (projectRow()))).toEqual(approved);

    current();yield 5;
    // Render-stage recipes differ from preview recipes: generate a genuine V3
    // final of this reviewed target instead of relabelling preview source takes.
    const renderBase=compileCurrentFilmJob(f.saved.library,f.plan.selector,{role:"render",tier:"free",providerPlan:createProviderPlan("final",5,undefined,{...process.env,HV_PROVIDER_POOL:'["mock"]'})}),render=compileCurrentFilmMixedJob(renderBase,{origins:[],choices:[]});
    const finalInput={...input(render),animaticJobId:preview.id,animaticApprovedAt:decision.approval.at},beforeFinal=await checked(async()=> (counts())),unapproved={...approved.body,animaticApprovals:approved.body.animaticApprovals.filter(value=>value.animaticJobId!==preview.id)};
    await checked(async()=> (admin!.sql`update hv_projects set body=${unapproved}::jsonb where id=${projectId}`));
    try{await checked(async()=> (expect(ledger.admit(projectId,finalInput,500)).rejects.toThrow(/preview|approval|decision/)));expect(await checked(async()=> (counts()))).toEqual(beforeFinal);}finally{await admin!.sql`update hv_projects set body=${approved.body}::jsonb where id=${projectId}`;}
    const finalAdmitted=await checked(async()=> (ledger.admit(projectId,finalInput,500))),finalCounts=await checked(async()=> (counts()));expect((await checked(async()=> (ledger.admit(projectId,{...finalInput,id:crypto.randomUUID()},500)))).id).toBe(finalAdmitted.id);expect(await checked(async()=> (counts()))).toEqual(finalCounts);
    const finalRoot=join(root,"final"),finalMedia=new PostgresArtifactStore(worker,finalRoot,sourceClient),final=currentFilmV3Job((await checked(async()=> (processNextJob(store,finalRoot,{...context,artifacts:finalMedia,workerId:"mixed-final"}))))!);
    expect(final.id).toBe(finalAdmitted.id);expect(final.failureReason??final.cancelReason).toBeUndefined();expect(final.status).toBe("done");expect(final.currentFilmCheckpoint!.rows.every(row=>row.kind==="generated")).toBe(true);
    expect(final.currentFilmProof!.specification.target?.animaticJobId).toBe(preview.id);expect(final.currentFilmProof!.specification.target?.animaticApprovedAt).toBe(decision.approval.at);
    expect(final.currentFilmProof!.specification.previews.some(value=>value.jobId===preview.id)).toBe(true);
    expect((await checked(async()=> (admin!.sql`select body,status,claimed_by,lease_expires_at from hv_jobs where id=${final.id}`)))[0]).toMatchObject({body:final,status:"done",claimed_by:null,lease_expires_at:null});
    expect(Array.from(await checked(async()=> (admin!.sql`select event_type from hv_outbox where job_id=${final.id} and event_type in ('artifacts.exported','job.completed') order by event_type`)))).toEqual([{event_type:"artifacts.exported"},{event_type:"job.completed"}]);
    expect(final.output!.currentFilm.assembly.probe.video.frames).toBe(final.output!.currentFilm.assembly.frames);expect(final.costUsd).toBe(0);await checked(async()=> (finalMedia.restoreCheckpoint(final,signal())));
    current();yield 6;
    const expectedJobs=[preview,final],expectedFiles=new Map<string,Buffer>();
    for(const value of expectedJobs){
      const indexed=await checked(async()=> (admin!.sql`select key from hv_artifacts where project_id=${projectId} and job_id=${value.id} order by key`));
      for(const row of indexed)expectedFiles.set(String(row.key),readFileSync(join(value.id===preview.id?secondRoot:finalRoot,String(row.key))));
    }
    const accepted=(await checked(async()=> (projects.acceptCurrentScreenplayProposal(f.studio.owner.token,{id:"accept-mixed-pg",proposalRevision:f.saved.proposal.revision,expectedHeadRevision:f.saved.library.headRevision!},f.saved.library.version))))!;
    expect(accepted.library.headRevision).not.toBe(f.plan.baseline.headRevision);
    const snapshot=await checked(async()=> (exportStateSnapshot(admin!,projectId)));expect(snapshot.schema).toBe("hv-state/15");expect(snapshot.jobs.map(value=>value.id).sort()).toEqual([f.studio.film.id,preview.id,final.id].sort());
    expect(snapshot.ledger.events.some(value=>value.jobId===f.job.id)).toBe(true);expect(()=>validateSnapshot({...snapshot,schema:"hv-state/14"})).toThrow("schema 15");
    const archive=join(root,"mixed.zip"),prepared=join(root,"prepared"),unpacked=join(root,"unpacked"),exported=await checked(async()=> (exportProjectArchive(admin!,projectId,prepared,archive)));
    expect(exported.jobs).toBe(3);expect(readStateSnapshot(prepared)).toEqual(snapshot);expect(existsSync(join(prepared,"artifacts",projectId,f.job.id))).toBe(false);
    await checked(async()=>{await control.sql.unsafe('CREATE DATABASE "'+restoreName+'"');created.add(restoreName);});restored=new StudioDatabase(databaseUrl(process.env.HV_PG_ADMIN_URL!,restoreName));const restoredDatabase=restored;await checked(async()=> (restoredDatabase.migrate()));
    try{process.env.HV_S3_BUCKET=process.env.HV_S3_FLEET_TEST_BUCKET;const imported=await checked(async()=> (importProjectArchive(restoredDatabase,archive,unpacked,500)));expect(imported.jobs).toBe(3);expect(imported.archiveSha256).toBe(exported.archiveSha256);}finally{process.env.HV_S3_BUCKET=bucket;}
    expect(readStateSnapshot(unpacked)).toEqual(snapshot);expect(readFileSync(join(prepared,"state/projects.json"))).toEqual(readFileSync(join(unpacked,"state/projects.json")));
    current();yield 7;
    await checked(async()=> (clearObjects(sourceClient,projectId)));await checked(async()=>{await api!.close();api=undefined;});await checked(async()=>{await worker!.close();worker=undefined;});await checked(async()=>{await admin!.close();admin=undefined;});
    await checked(async()=>{await control.sql.unsafe('DROP DATABASE "'+sourceName+'" WITH (FORCE)');created.delete(sourceName);});
    for(const path of [firstRoot,secondRoot,finalRoot,join(prepared,"artifacts"),join(unpacked,"artifacts")])removeOwned(path,root);removeOwned(join(f.studio.paths.artifactRoot,projectId),f.studio.root);
    const independentRoot=join(root,"independent"),independent=new PostgresArtifactStore(restoredDatabase,independentRoot,destinationClient),restoredStore=new PostgresJobStore(restoredDatabase).forProject(projectId);
    expect(await checked(async()=> (restoredStore.get(f.job.id)))).toBeUndefined();await checked(async()=> (independent.restoreCheckpoint((await checked(async()=> (restoredStore.get(f.studio.film.id))))!,signal())));
    for(const expected of expectedJobs){const actual=currentFilmV3Job((await checked(async()=> (restoredStore.get(expected.id))))!);expect(actual.currentFilm).toEqual(expected.currentFilm);expect(actual.currentFilmOrigins).toEqual(expected.currentFilmOrigins);expect(actual.currentFilmCheckpoint).toEqual(expected.currentFilmCheckpoint);expect(actual.output).toEqual(expected.output);
      expect(actual.currentFilmProof).toEqual(expected.currentFilmProof);
      await checked(async()=> (independent.restoreCheckpoint(actual,signal())));await checked(async()=> (verifyCurrentFilmMixedMedia(actual,independentRoot,async()=>{current();},signal())));
      for(const file of currentFilmMixedRecordedFiles(actual)){expect(await checked(async()=> (independent.fileInfo(projectId,actual.id,file.path)))).toEqual(file);const bytes=readFileSync(join(independentRoot,file.path));expect(bytes.equals(expectedFiles.get(file.path)!)).toBe(true);expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);}
      // Include the actual delivery index, not only the private original/row/clock
      // inventory: every playlist, segment and public manifest stays byte-exact.
      for(const [path,bytes]of expectedFiles)if(path.startsWith(projectId+"/"+actual.id+"/")){
        expect(readFileSync(join(independentRoot,path)).equals(bytes)).toBe(true);expect(await checked(async()=> (independent.fileInfo(projectId,actual.id,path)))).toEqual({path,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")});
      }
      expect(existsSync(join(independentRoot,projectId,actual.id,"clips/manifest.json"))).toBe(false);
    }
    expect(existsSync(join(independentRoot,projectId,f.job.id))).toBe(false);expect(readFileSync(join(independentRoot,nativeCopy.owned.path))).toEqual(originalBytes.get(native.path)!);
    const restoredProjects=new PostgresProjectService(restoredDatabase),reviewRow=(await checked(async()=> (restoredDatabase.sql`select body,version from hv_projects where id=${projectId}`)))[0];
    expect((await checked(async()=> (restoredProjects.recordCurrentFilmDecision(f.studio.owner.token,(await checked(async()=> (restoredStore.get(preview.id))))!,review,"approved","Use exact mixed preview"))))!.replayed).toBe(true);
    expect((await checked(async()=> (restoredDatabase.sql`select body,version from hv_projects where id=${projectId}`)))[0]).toEqual(reviewRow);
    current();yield 8;
    const stable=await checked(async()=> (exportStateSnapshot(restoredDatabase,projectId))),indexed=(await checked(async()=> (restoredDatabase.sql`select object_key from hv_artifacts where key=${nativeCopy.owned.path}`)))[0],object=destinationClient.file(String(indexed.object_key)),nativeBytes=originalBytes.get(native.path)!;
    await checked(async()=> (restoredDatabase.sql`update hv_artifacts set bytes=bytes+1 where key=${nativeCopy.owned.path}`));
    try{await checked(async()=> (expect(new PostgresArtifactStore(restoredDatabase,join(root,"bad-index"),destinationClient).restoreCheckpoint(preview,signal())).rejects.toThrow()));}finally{await restoredDatabase.sql`update hv_artifacts set bytes=${nativeCopy.owned.bytes} where key=${nativeCopy.owned.path}`;}
    const corrupt=Buffer.from(nativeBytes);corrupt[44]^=1;
    try{await checked(async()=> (object.write(corrupt)));await checked(async()=> (expect(new PostgresArtifactStore(restoredDatabase,join(root,"bad-object"),destinationClient).restoreCheckpoint(preview,signal())).rejects.toThrow(/checksum|corrupt/)));
      await checked(async()=> (object.delete()));await checked(async()=> (expect(new PostgresArtifactStore(restoredDatabase,join(root,"missing-object"),destinationClient).restoreCheckpoint(preview,signal())).rejects.toThrow()));
    }finally{await object.write(nativeBytes);}
    expect(await checked(async()=> (exportStateSnapshot(restoredDatabase,projectId)))).toEqual(stable);await checked(async()=> (new PostgresArtifactStore(restoredDatabase,join(root,"repaired"),destinationClient).restoreCheckpoint(preview,signal())));
    current();yield 9;
  }finally{
    // All awaited phase work has settled before the generator enters cleanup.
    // Also drain any exact-claim cancellation started by the timeout hook.
    await Promise.allSettled([...cancellations]);
    if(bucket===undefined)delete process.env.HV_S3_BUCKET;else process.env.HV_S3_BUCKET=bucket;if(oldPool===undefined)delete process.env.HV_PROVIDER_POOL;else process.env.HV_PROVIDER_POOL=oldPool;
    if(cleanupProjectId)for(const client of [sourceClient,destinationClient])await clearObjects(client,cleanupProjectId);
    await api?.close();await worker?.close();await admin?.close();await restored?.close();for(const name of created)await control.sql.unsafe('DROP DATABASE "'+databaseName(name)+'" WITH (FORCE)');await control.close();await fixture?.close();cleanup(root);
  }
  }
  const iterator=lifecycle();
  const phases=[
    ["imports actual source media and qualifies atomic admission",600000],
    ["settles the first worker at actual proof/origins custody",900000],
    ["removes the old source and restores the paused owned inventory",600000],
    ["resumes the exact admitted preview and checks selective dispatch",900000],
    ["verifies preview bytes and records the exact owner decision",600000],
    ["admits and completes the genuine approved final",900000],
    ["exports and imports into an independent database and bucket",600000],
    ["removes original owners and verifies independent restored media",600000],
    ["rejects index/object corruption and restores repaired custody",600000],
  ] as const;
  for(const [index,[name,timeout]]of phases.entries())(enabled?test:test.skip)(name,async()=>{
    // An earlier failed/unfinished phase cannot be resumed by another test.
    if(failed||completed!==index||active&&!active.finished)throw new Error("Required service phase did not settle successfully.");
    const phase:Phase={ordinal:index+1,controller:new AbortController(),promise:Promise.resolve(),finished:false};active=phase;
    phase.promise=(async()=>{
      const next=await iterator.next();
      current();expect(next.done).toBe(false);expect(next.value).toBe(phase.ordinal);completed++;
    })().catch(error=>{failed=true;throw error;}).finally(()=>{phase.finished=true;});
    // Attach a rejection observer even if Bun abandons its own test wait.
    void phase.promise.catch(()=>{});await phase.promise;
  },timeout);
  afterEach(async()=>{
    if(!active||active.finished)return;
    failed=true;active.controller.abort(new Error("Service phase timed out or was abandoned."));cancelObservedWorker();
    await settledWithin(active.promise,5000);
  },6000);
  afterAll(async()=>{
    if(!enabled)return;
    if(active&&!active.finished){
      failed=true;active.controller.abort(new Error("Service fixture teardown."));cancelObservedWorker();
      if(!await settledWithin(active.promise,5000))failStop();
    }
    if(cancellations.size&&!await settledWithin(Promise.allSettled([...cancellations]),5000))failStop();
    // Normal completed phases are suspended only at authentic settled yields.
    // return() runs the original environment/database/object/media finalizer.
    const closing=iterator.return();void closing.catch(()=>{});
    if(!await settledWithin(closing,10000)){failed=true;failStop();}
    await closing;
  },25000);
});
