// PRIVATE, UNAPPLIED, UNEXECUTED qualification overlay.
// Intended path: packages/storage/test/current-film-mixed-final-source-projects.test.ts
// Requires the coordinated receipt4/library2/state16/nested-proof/native patches.
import {afterAll,afterEach,describe,expect,spyOn,test} from "bun:test";
import {createHash} from "node:crypto";
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import {prepareCurrentFilmMixedSourceFixture} from "../../planner/test/current-film-mixed-source.fixture";
import {compileCurrentFilmJob} from "../../planner/src/current-film-jobs";
import {compileCurrentFilmMixedJob} from "../../planner/src/current-film-mixed-jobs";
import {currentFilmV3Job} from "../../planner/src/current-film-runtime-context";
import {createCurrentFilmMixedPreviewReview} from "../../planner/src/current-film-mixed-job-context";
import {bindOriginalEditSource,bindRetainedEditSource,assertEditBindingAvailable,assertEditPermission,createEditPlan,editRenderReview,type EditSourceBinding} from "../../planner/src/edit-jobs";
import {assertEditOriginalSelection,type EditSourceReceipt} from "../../planner/src/edit-sources";
import {editHistoryState} from "../../planner/src/edit-history";
import {compileEditScriptSource,resolveEditCurrentFilmMixedScriptSource} from "../../planner/src/edit-script-source";
import {parseEditCaptions} from "../../planner/src/edit-captions";
import {contentHash as hash} from "../../generator/src/capabilities";
import {createProviderPlan} from "../../generator/src/catalog";
import {RoutedGenerator} from "../../generator/src/router";
import {inspectEditSource,verifyEditSourceReceiptMedia} from "../../generator/src/edit-source-media";
import {verifyEditMedia} from "../../generator/src/edit-media";
import {soundRuntimeRevision} from "../../generator/src/sound-audio";
import {verifyCurrentFilmMixedMedia} from "../../queue/src/current-film-mixed-media";
import {processNextJob,type WorkerContext} from "../../queue/src/worker";
import type {Job,JobInput} from "../../queue/src/index";
import type {PersistedProject} from "../../api/src/index";
import {StudioDatabase} from "../src/database";
import {PostgresProjectService} from "../src/projects";
import {PostgresJobStore} from "../src/jobs";
import {PostgresCostLedger} from "../src/ledger";
import {PostgresReviewQueue} from "../src/reviews";
import {PostgresArtifactStore,objectClient} from "../src/artifacts";
import {exportProjectArchive,importProjectArchive} from "../src/archives";
import {exportStateSnapshot,importStateSnapshot,readStateSnapshot,stateSnapshotSchema,validateSnapshot,type StateSnapshot} from "../src/snapshots";

const enabled=Boolean(process.env.HV_PG_ADMIN_URL&&process.env.HV_API_DATABASE_URL&&process.env.HV_WORKER_DATABASE_URL&&process.env.HV_S3_ENDPOINT&&process.env.HV_S3_BUCKET&&process.env.HV_S3_FLEET_TEST_BUCKET);
function databaseName(value:string):string {if(!/^hv_final_source_[a-f0-9]{32}$/.test(value))throw new Error("Unsafe final-source database identity.");return value;}
function databaseUrl(value:string,name:string):string {const url=new URL(value);url.pathname="/"+databaseName(name);return url.href;}
function files(root:string):string[] {
  const pending=[root],out:string[]=[];let nodes=0;
  while(pending.length){const current=pending.pop()!;for(const entry of readdirSync(current,{withFileTypes:true})){
    if(++nodes>100000)throw new Error("Fixture inventory exceeds its complete-file bound.");
    const path=join(current,entry.name);if(entry.isSymbolicLink())throw new Error("Fixture inventory refuses links.");
    if(entry.isDirectory())pending.push(path);else if(entry.isFile())out.push(path);else throw new Error("Fixture inventory requires regular files.");
  }}return out.sort();
}
function removeOwned(path:string,root:string):void {
  if(!existsSync(path))return;const actual=realpathSync(path),owner=realpathSync(root);
  if(lstatSync(path).isSymbolicLink()||actual!==resolve(path)||!actual.startsWith(owner+sep))throw new Error("Unsafe final-source fixture removal.");
  rmSync(actual,{recursive:true,force:true});
}
function cleanup(root:string):void {
  if(lstatSync(root).isSymbolicLink()||root!==realpathSync(root)||!root.startsWith(realpathSync(tmpdir())+sep+"hv-final-source-pg-"))throw new Error("Unsafe final-source root cleanup.");
  rmSync(root,{recursive:true,force:true});
}
async function clearObjects(client:ReturnType<typeof objectClient>,projectId:string,jobId?:string):Promise<void> {
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)||jobId!==undefined&&!/^[A-Za-z0-9_-]{1,128}$/.test(jobId))throw new Error("Unsafe final-source object scope.");
  const prefix="v1/"+projectId+"/"+(jobId?jobId+"/":"");
  for(let page=0;page<100;page++){const rows=(await client.list({prefix,maxKeys:1000})).contents??[];if(!rows.length)return;
    for(const row of rows){if(!row.key.startsWith(prefix))throw new Error("Fixture object escaped its owner.");await client.file(row.key).delete();}}
  throw new Error("Final-source object cleanup exceeded its bound.");
}
function originalNamespace(binding:EditSourceBinding,artifactRoot:string):string {
  const original=binding.source.files[0],copy=binding.files[0];
  if(!original||!copy||!copy.path.endsWith(original.path)||binding.files.length!==binding.source.files.length)throw new Error("Missing complete retained namespace.");
  const prefix=copy.path.slice(0,-original.path.length);if(!prefix.endsWith("/"))throw new Error("Invalid retained namespace prefix.");
  for(const [i,file]of binding.files.entries()){const source=binding.source.files[i]!;
    if(file.path!==prefix+source.path||file.sha256!==source.sha256||file.bytes!==source.bytes)throw new Error("Retained namespace changed an exact ordered copy.");}
  const root=realpathSync(artifactRoot),namespace=realpathSync(join(root,prefix));
  if(!namespace.startsWith(root+sep))throw new Error("Retained namespace escaped the target owner.");return namespace;
}
function measured(path:string){const data=readFileSync(path);return {bytes:data.length,sha256:createHash("sha256").update(data).digest("hex")};}

describe("actual PostgreSQL/S3 approved-final receipt four recovery",()=>{
  type Phase={ordinal:number;controller:AbortController;promise:Promise<void>;finished:boolean};
  type Held={store:PostgresJobStore;job:Job;cancelRequested:boolean};
  let active:Phase|undefined,held:Held|undefined,completed=0,failed=false;
  const cancellations=new Set<Promise<void>>();
  function current():void {if(failed||!active||active.finished||active.controller.signal.aborted)throw new Error("Final-source service phase is no longer active.");}
  function signal():AbortSignal {current();return active!.controller.signal;}
  async function checked<T>(run:()=>PromiseLike<T>|T):Promise<T>{current();const value=await run();current();return value;}
  function cancelObservedWorker():void {
    const value=held;if(!value||value.cancelRequested)return;value.cancelRequested=true;
    const task=(async()=>{const saved=await value.store.get(value.job.id);
      if(saved?.status==="running"&&saved.projectId===value.job.projectId&&saved.claimedBy===value.job.claimedBy&&saved.leaseVersion===value.job.leaseVersion)
        await value.store.cancel(saved.id,saved.claimedBy!,"Final-source service phase ended.");
    })().then(()=>{},()=>{}).finally(()=>{cancellations.delete(task);});cancellations.add(task);
  }
  async function execute(store:PostgresJobStore,root:string,context:WorkerContext):Promise<{job:Job;calls:string[]}> {
    current();const calls:string[]=[],generate=RoutedGenerator.prototype.generate;
    const observe=spyOn(RoutedGenerator.prototype,"generate").mockImplementation(function(this:RoutedGenerator,...args:Parameters<typeof generate>){current();calls.push(args[2].shotId!);return generate.apply(this,args);});
    try{const result=await processNextJob(store,root,{...context,onJobStarted:async job=>{
      held={store,job:structuredClone(job),cancelRequested:false};
      if(failed||active?.controller.signal.aborted){cancelObservedWorker();throw new Error("Final-source phase stopped after claim.");}
      current();await context.onJobStarted?.(job);current();
    }});current();if(!result)throw new Error("The actual admitted worker returned no job.");return {job:result,calls};}
    finally{held=undefined;observe.mockRestore();}
  }
  async function settledWithin(promise:Promise<unknown>,milliseconds:number):Promise<boolean>{let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([promise.then(()=>true,()=>true),new Promise<boolean>(resolve=>{timer=setTimeout(()=>resolve(false),milliseconds);})]);}
    finally{if(timer!==undefined)clearTimeout(timer);}
  }
  function failStop():never {
    process.stderr.write("Final-source service fixture did not drain; preserving resources and stopping this failed runner.\n");process.exit(1);
  }

  async function* lifecycle():AsyncGenerator<number,void,void>{
    const root=realpathSync(mkdtempSync(join(realpathSync(tmpdir()),"hv-final-source-pg-"))),sourceName=databaseName("hv_final_source_"+crypto.randomUUID().replaceAll("-","")),restoreName=databaseName("hv_final_source_"+crypto.randomUUID().replaceAll("-",""));
    const savedBucket=process.env.HV_S3_BUCKET,savedPool=process.env.HV_PROVIDER_POOL,created=new Set<string>();
    let control:StudioDatabase|undefined,admin:StudioDatabase|undefined,api:StudioDatabase|undefined,worker:StudioDatabase|undefined,restored:StudioDatabase|undefined;
    let sourceClient:ReturnType<typeof objectClient>|undefined,destinationClient:ReturnType<typeof objectClient>|undefined;
    let fixture:Awaited<ReturnType<typeof prepareCurrentFilmMixedSourceFixture>>|undefined,cleanupProjectId:string|undefined;
    try{
      expect(savedBucket).not.toBe(process.env.HV_S3_FLEET_TEST_BUCKET);process.env.HV_PROVIDER_POOL='["mock"]';
      control=new StudioDatabase(process.env.HV_PG_ADMIN_URL!);sourceClient=objectClient();destinationClient=objectClient({...process.env,HV_S3_BUCKET:process.env.HV_S3_FLEET_TEST_BUCKET});
      const sourceObjects=sourceClient,destinationObjects=destinationClient,controller=control;
      expect((await checked(()=>destinationObjects.list({maxKeys:1}))).contents??[]).toHaveLength(0);
      const f=await checked(async()=>{const acquired=await prepareCurrentFilmMixedSourceFixture();fixture=acquired;cleanupProjectId=acquired.plan.projectId;return acquired;});
      const projectId=f.plan.projectId,token=f.f.studio.owner.token,sourceHash=hash(f.f.job),originals=f.store.all();
      expect(originals.some(job=>job.id===f.f.studio.film.id)).toBe(true);expect(originals.some(job=>job.id===f.f.job.id)).toBe(true);
      expect(f.plan.selection.some(row=>row.kind==="reuse")).toBe(true);expect(f.plan.selection.some(row=>row.kind==="generate")).toBe(true);
      expect(f.ordinal).not.toBe(f.sourceOrdinal);
      const originalBytes=new Map(f.f.receipt.files.map(file=>[file.path,readFileSync(join(f.root,file.path))]));
      const sourceAudio=f.f.job.currentFilmCheckpoint!.rows[f.sourceOrdinal]!.record.files.audio!;expect(sourceAudio).toBeDefined();
      await checked(async()=>{await controller.sql.unsafe('CREATE DATABASE "'+sourceName+'"');created.add(sourceName);});
      admin=new StudioDatabase(databaseUrl(process.env.HV_PG_ADMIN_URL!,sourceName));const sourceAdmin=admin;await checked(()=>sourceAdmin.migrate());
      const initial:StateSnapshot={schema:stateSnapshotSchema(f.context.projects.snapshot(),originals),projects:f.context.projects.snapshot(),jobs:originals,
        ledger:{events:[...f.f.studio.ledger.all(),...f.context.ledger.all()],reservations:[]},reviews:[]};
      expect(initial.schema).toBe("hv-state/12");validateSnapshot(initial);await checked(()=>importStateSnapshot(sourceAdmin,initial,500));
      const initialMedia=new PostgresArtifactStore(sourceAdmin,f.root,sourceObjects);
      for(const original of originals)expect((await checked(()=>initialMedia.importCompletedJob(original,files(join(f.root,projectId,original.id))))).files).toBeGreaterThan(0);
      api=new StudioDatabase(databaseUrl(process.env.HV_API_DATABASE_URL!,sourceName));worker=new StudioDatabase(databaseUrl(process.env.HV_WORKER_DATABASE_URL!,sourceName));
      const workerDatabase=worker,projects=new PostgresProjectService(api),ledger=new PostgresCostLedger(workerDatabase),store=new PostgresJobStore(workerDatabase).forProject(projectId);
      const context={projects,ledger,reviewQueue:new PostgresReviewQueue(workerDatabase)};
      const projectRow=async()=>{const row=(await checked(()=>sourceAdmin.sql`select body,version from hv_projects where id=${projectId}`))[0];return {body:row.body as PersistedProject,version:Number(row.version)};};
      const counts=async(database:StudioDatabase)=>{const row=(await checked(()=>database.sql`select (select count(*) from hv_jobs where project_id=${projectId}) as jobs,(select count(*) from hv_provider_attempts where project_id=${projectId}) as attempts,(select count(*) from hv_cost_events where project_id=${projectId}) as costs,(select count(*) from hv_reservations where job_id in (select id from hv_jobs where project_id=${projectId})) as holds,(select count(*) from hv_outbox where project_id=${projectId}) as events`))[0];return [row.jobs,row.attempts,row.costs,row.holds,row.events].map(Number);};
      const savedInitialProject=await projectRow();expect(savedInitialProject.body.currentScreenplay).toEqual(f.saved.library);
      current();yield 1;

      const beforePreview=await counts(sourceAdmin),admittedPreview=await checked(()=>ledger.admit(projectId,f.request,500));
      expect(admittedPreview.currentFilm).toEqual(f.plan);expect(admittedPreview.status).toBe("queued");expect(admittedPreview.timeoutMs).toBe(600000);
      const admittedCounts=await counts(sourceAdmin);expect(admittedCounts[0]).toBe(beforePreview[0]!+1);
      expect((await checked(()=>ledger.admit(projectId,{...f.request,id:crypto.randomUUID()},500))).id).toBe(admittedPreview.id);expect(await counts(sourceAdmin)).toEqual(admittedCounts);
      current();yield 2;

      const previewRoot=join(root,"preview"),previewMedia=new PostgresArtifactStore(workerDatabase,previewRoot,sourceObjects);
      const previewExecution=await checked(()=>execute(store,previewRoot,{...context,artifacts:previewMedia,workerId:"final-source-preview"}));
      expect(previewExecution.job.id).toBe(admittedPreview.id);expect(previewExecution.job.failureReason??previewExecution.job.cancelReason).toBeUndefined();expect(previewExecution.job.status).toBe("done");
      current();yield 3;

      const preview=currentFilmV3Job(previewExecution.job),previewPlan=preview.currentFilm;
      expect(preview.stage).toBe("animatic");expect(preview.timeoutMs).toBe(600000);expect(preview.retriesUsed).toBe(0);
      expect([...new Set(previewExecution.calls)]).toEqual(previewPlan.selection.filter(row=>row.kind==="generate").map(row=>row.renderId));
      const adopted=preview.currentFilmCheckpoint!.rows[f.ordinal]!;if(adopted.kind!=="reused")throw new Error("The moved native source must be actually adopted.");
      expect(adopted.adoption.sourceSelector.ordinal).toBe(f.sourceOrdinal);expect(adopted.adoption.target.ordinal).toBe(f.ordinal);
      expect(adopted.adoption.captureRevision).toBe(f.f.job.currentFilmCheckpoint!.rows[f.sourceOrdinal]!.capture.revision);
      const adoptedAudio=adopted.adoption.copies.find(copy=>copy.role==="audio")!;expect(adoptedAudio).toBeDefined();
      expect(readFileSync(join(previewRoot,adoptedAudio.owned.path))).toEqual(originalBytes.get(sourceAudio.path)!);
      for(const selection of previewPlan.selection.filter(row=>row.kind==="reuse")){
        expect(await checked(()=>sourceAdmin.sql`select id from hv_provider_attempts where job_id=${preview.id} and shot_id=${selection.renderId}`)).toHaveLength(0);
        expect(await checked(()=>sourceAdmin.sql`select id from hv_cost_events where job_id=${preview.id} and body->>'shotId'=${selection.renderId}`)).toHaveLength(0);
      }
      await checked(()=>verifyCurrentFilmMixedMedia(preview,previewRoot,async()=>{current();},signal()));
      expect((await checked(()=>store.get(preview.id)))!.output).toEqual(preview.output);expect(await projectRow()).toEqual(savedInitialProject);
      const review=createCurrentFilmMixedPreviewReview(preview),decision=(await checked(()=>projects.recordCurrentFilmDecision(token,preview,review,"approved","Retain this exact moved preview")))!;
      expect(decision.approval.currentFilmReview).toEqual(review);const approved=await projectRow();
      expect((await checked(()=>projects.recordCurrentFilmDecision(token,preview,review,"approved","Retain this exact moved preview")))!.replayed).toBe(true);expect(await projectRow()).toEqual(approved);
      current();yield 4;

      const renderBase=compileCurrentFilmJob(f.saved.library,f.plan.selector,{role:"render",tier:"free",providerPlan:createProviderPlan("final",5,undefined,process.env)});
      const render=compileCurrentFilmMixedJob(renderBase,{origins:[],choices:[]});
      const finalInput:JobInput={...f.request,id:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),currentFilm:render,stage:render.render.stage,tier:render.render.tier,
        scriptVersion:render.materialization.script.version,scriptText:render.materialization.script.text,casting:render.target.state.casting.candidate!,providerPlan:render.render.providerPlan,
        totalFrames:render.materialization.requestedFrames,animaticJobId:preview.id,animaticApprovedAt:decision.approval.at,timeoutMs:600000};
      expect(render.target).toEqual(preview.currentFilm.target);expect(render.render.role).toBe("render");expect(render.render.stage).toBe("final");expect(render.revision).not.toBe(preview.currentFilm.revision);
      const beforeFinal=await counts(sourceAdmin),withoutApproval={...approved.body,animaticApprovals:approved.body.animaticApprovals.filter(row=>row.animaticJobId!==preview.id)};
      await checked(()=>sourceAdmin.sql`update hv_projects set body=${withoutApproval}::jsonb where id=${projectId}`);
      try{await checked(()=>expect(ledger.admit(projectId,finalInput,500)).rejects.toThrow(/preview|approval|decision/));expect(await counts(sourceAdmin)).toEqual(beforeFinal);}
      finally{await sourceAdmin.sql`update hv_projects set body=${approved.body}::jsonb where id=${projectId}`;}
      const admittedFinal=await checked(()=>ledger.admit(projectId,finalInput,500)),finalCounts=await counts(sourceAdmin);
      expect(admittedFinal.timeoutMs).toBe(600000);expect((await checked(()=>ledger.admit(projectId,{...finalInput,id:crypto.randomUUID()},500))).id).toBe(admittedFinal.id);expect(await counts(sourceAdmin)).toEqual(finalCounts);
      current();yield 5;

      const finalRoot=join(root,"final"),finalMedia=new PostgresArtifactStore(workerDatabase,finalRoot,sourceObjects);
      const finalExecution=await checked(()=>execute(store,finalRoot,{...context,artifacts:finalMedia,workerId:"final-source-render"}));
      expect(finalExecution.job.id).toBe(admittedFinal.id);expect(finalExecution.job.failureReason??finalExecution.job.cancelReason).toBeUndefined();expect(finalExecution.job.status).toBe("done");
      current();yield 6;

      const final=currentFilmV3Job(finalExecution.job);expect(final.stage).toBe("final");expect(final.currentFilm.render.role).toBe("render");expect(final.timeoutMs).toBe(600000);expect(final.retriesUsed).toBe(0);
      expect(final.currentFilmCheckpoint!.rows.every(row=>row.kind==="generated")).toBe(true);
      expect([...new Set(finalExecution.calls)]).toEqual(render.selection.map(row=>row.renderId));
      expect(final.currentFilmProof!.specification.target!.animaticJobId).toBe(preview.id);expect(final.currentFilmProof!.specification.target!.animaticApprovedAt).toBe(decision.approval.at);
      expect(final.currentFilmProof!.specification.previews.some(row=>row.jobId===preview.id)).toBe(true);
      expect(final.currentFilmProof!.specification.frozenContext.jobs.find(job=>job.id===preview.id)).toEqual(preview);
      for(const row of final.currentFilmCheckpoint!.rows){if(row.kind!=="generated")throw new Error("The final must contain actual generated records.");expect(row.capture).toBeDefined();expect(row.record.revision).toMatch(/^[a-f0-9]{64}$/);}
      expect(final.routeDecisions!.length).toBeGreaterThan(0);expect(final.costUsd).toBe(0);expect(await checked(()=>ledger.monthSpend())).toBe(0);
      await checked(()=>verifyCurrentFilmMixedMedia(final,finalRoot,async()=>{current();},signal()));
      const committed=(await checked(()=>sourceAdmin.sql`select body,status,claimed_by,lease_expires_at from hv_jobs where id=${final.id}`))[0];
      expect(committed).toMatchObject({body:final,status:"done",claimed_by:null,lease_expires_at:null});
      expect(Array.from(await checked(()=>sourceAdmin.sql`select event_type from hv_outbox where job_id=${final.id} and event_type in ('artifacts.exported','job.completed') order by event_type`))).toEqual([{event_type:"artifacts.exported"},{event_type:"job.completed"}]);
      expect(await checked(()=>sourceAdmin.sql`select job_id from hv_reservations where job_id=${final.id}`)).toHaveLength(0);
      expect(hash(f.f.job)).toBe(sourceHash);for(const file of f.f.receipt.files)expect(readFileSync(join(f.root,file.path))).toEqual(originalBytes.get(file.path)!);
      current();yield 7;

      const sourceAccess=async()=>{current();const project=await projects.authorize(token),saved=await store.get(final.id);current();assertEditOriginalSelection(final,saved,project);};
      const receipt:EditSourceReceipt=await checked(()=>inspectEditSource(final,"Actual approved final via PostgreSQL",finalRoot,sourceAccess,signal(),finalMedia,path=>finalMedia.fileInfo(projectId,final.id,path)));
      expect(receipt.schema).toBe("hv-edit-source/4");expect(receipt.job).toEqual(final);expect(receipt.audio.dialogue).toEqual({kind:"mixed-film-dialogue"});
      if(!receipt.delivery)throw new Error("The actual final receipt must retain its complete ordered delivery.");
      expect(receipt.delivery.segments.length).toBeGreaterThan(0);
      expect(receipt.facts.captions).toEqual(parseEditCaptions(readFileSync(join(finalRoot,final.output!.captionsPath),"utf8"),receipt.facts.frames));
      const expectedIndex=compileEditScriptSource(receipt);expect(resolveEditCurrentFilmMixedScriptSource(receipt).index).toEqual(expectedIndex);
      expect(expectedIndex.scriptText).toBe(final.currentFilm.target.state.context.plan.document.context.base.text);
      for(const file of receipt.files)expect(await checked(()=>finalMedia.fileInfo(projectId,final.id,file.path))).toEqual(file);
      const receiptBytes=new Map(receipt.files.map(file=>[file.path,readFileSync(join(finalRoot,file.path))]));
      current();yield 8;

      const binding=bindOriginalEditSource(receipt),beforeLibrary=await projectRow(),libraryCounts=await counts(sourceAdmin),sequenceId="final-source-carrier";
      const firstReceiptFile=receipt.files[0]!,badIndex=(await checked(()=>sourceAdmin.sql`select sha256,bytes from hv_artifacts where project_id=${projectId} and job_id=${final.id} and key=${firstReceiptFile.path}`))[0];
      await checked(()=>sourceAdmin.sql`update hv_artifacts set bytes=bytes+1 where project_id=${projectId} and job_id=${final.id} and key=${firstReceiptFile.path}`);
      try{await checked(()=>expect(projects.createEditSequence(token,[receipt],sequenceId,"Retained approved final",final.id,320,180,beforeLibrary.body.editLibrary?.version??0,Date.now(),[binding])).rejects.toThrow());expect(await projectRow()).toEqual(beforeLibrary);expect(await counts(sourceAdmin)).toEqual(libraryCounts);}
      finally{await sourceAdmin.sql`update hv_artifacts set bytes=${badIndex.bytes} where project_id=${projectId} and job_id=${final.id} and key=${firstReceiptFile.path}`;}
      let library=(await checked(()=>projects.createEditSequence(token,[receipt],sequenceId,"Retained approved final",final.id,320,180,beforeLibrary.body.editLibrary?.version??0,Date.now(),[binding])))!;
      expect(library.schema).toBe("hv-edit-library/2");
      library=(await checked(()=>projects.changeEditSequence(token,sequenceId,{kind:"edit",label:"One second retaining every original handle",operation:{kind:"trim",clipId:"initial-0",linked:true,edge:"out",delta:30-receipt.facts.frames,ripple:true}},library.version,library.sequences[0]!.history.revision)))!;
      const sequence=library.sequences[0]!,timeline=editHistoryState(sequence.history).timeline;expect(timeline.frames).toBe(30);
      const pictureEdit=createEditPlan(sequence,[binding],soundRuntimeRevision(),"s3",hash("approved-final-source-carrier"),editRenderReview(timeline));
      const carrierInput:JobInput={id:crypto.randomUUID(),projectId,idempotencyKey:crypto.randomUUID(),tier:"free",stage:"picture-edit",scriptVersion:final.scriptVersion,scriptText:final.scriptText,
        rightsAttestedAt:beforeLibrary.body.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:30,costCapUsd:0,budgetReservedUsd:0,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:180000,pictureEdit};
      const admittedCarrier=await checked(()=>ledger.admit(projectId,carrierInput,500)),providerBefore=(await counts(sourceAdmin)).slice(1,3);
      expect((await projectRow()).body.editLibrary).toEqual(library);
      current();yield 9;

      const carrierRoot=join(root,"carrier"),carrierMedia=new PostgresArtifactStore(workerDatabase,carrierRoot,sourceObjects);
      const carrierExecution=await checked(()=>execute(store,carrierRoot,{...context,artifacts:carrierMedia,workerId:"final-source-carrier"})),carrier=carrierExecution.job;
      expect(carrier.id).toBe(admittedCarrier.id);expect(carrier.failureReason??carrier.cancelReason).toBeUndefined();expect(carrier.status).toBe("done");expect(carrier.timeoutMs).toBe(180000);
      expect(carrierExecution.calls).toEqual([]);expect((await counts(sourceAdmin)).slice(1,3)).toEqual(providerBefore);expect(carrier.costUsd).toBe(0);
      current();yield 10;

      expect(carrier.output).toEqual(carrier.editCheckpoint);expect(carrier.output!.editorial!.conform.pictureFrames).toHaveLength(30);
      await checked(()=>verifyEditMedia(carrier,carrier.output!,carrierRoot,async()=>{current();},signal()));
      const retained=bindRetainedEditSource(carrier,receipt.revision);assertEditBindingAvailable(retained,carrier);expect(retained.source).toEqual(receipt);
      expect(compileEditScriptSource(retained.source)).toEqual(expectedIndex);
      const allCarrierBytes=new Map(carrier.output!.editorial!.files.map(file=>[file.path,readFileSync(join(carrierRoot,file.path))]));
      for(const [i,file]of retained.files.entries())expect(readFileSync(join(carrierRoot,file.path))).toEqual(receiptBytes.get(receipt.files[i]!.path)!);
      const oldOwners=[...new Set([...originals.map(job=>job.id),preview.id,final.id])];
      const completeBeforeRemoval=await checked(()=>exportStateSnapshot(sourceAdmin,projectId));expect(completeBeforeRemoval.ledger.reservations).toHaveLength(0);
      expect(completeBeforeRemoval.projects.projects[0]!.animaticApprovals.some(row=>row.animaticJobId===preview.id)).toBe(true);
      current();yield 11;

      for(const id of oldOwners){
        await checked(()=>clearObjects(sourceObjects,projectId,id));
        await checked(()=>sourceAdmin.forProject(projectId,async tx=>{
          await tx`delete from hv_outbox where job_id=${id}`;await tx`delete from hv_artifacts where job_id=${id}`;await tx`delete from hv_jobs where id=${id}`;
        }));
        for(const base of [f.root,previewRoot,finalRoot,carrierRoot])removeOwned(join(base,projectId,id),base===f.root?f.f.studio.root:root);
        expect(await checked(()=>store.get(id))).toBeUndefined();expect((await checked(()=>sourceObjects.list({prefix:"v1/"+projectId+"/"+id+"/",maxKeys:1}))).contents??[]).toHaveLength(0);
      }
      const snapshot=await checked(()=>exportStateSnapshot(sourceAdmin,projectId));expect(snapshot.schema).toBe("hv-state/16");expect(snapshot.jobs.map(job=>job.id)).toEqual([carrier.id]);
      expect(snapshot.projects).toEqual(completeBeforeRemoval.projects);expect(snapshot.ledger).toEqual(completeBeforeRemoval.ledger);expect(snapshot.reviews).toEqual(completeBeforeRemoval.reviews);
      validateSnapshot(snapshot);expect(()=>validateSnapshot({...snapshot,schema:"hv-state/15"})).toThrow(/schema 16/);
      expect(bindRetainedEditSource(snapshot.jobs[0]!,receipt.revision).source.job.currentFilmProof).toEqual(final.currentFilmProof);
      current();yield 12;

      const archive=join(root,"approved-final.zip"),prepared=join(root,"prepared"),unpacked=join(root,"unpacked");
      // These production archive APIs are signalless. The phase runner drains or
      // stops its failed runner; it never deletes their live files or switches env.
      const exported=await checked(()=>exportProjectArchive(sourceAdmin,projectId,prepared,archive));
      expect(exported.jobs).toBe(1);expect(readStateSnapshot(prepared)).toEqual(snapshot);
      for(const id of oldOwners)expect(existsSync(join(prepared,"artifacts",projectId,id))).toBe(false);
      current();yield 13;

      await checked(async()=>{await controller.sql.unsafe('CREATE DATABASE "'+restoreName+'"');created.add(restoreName);});
      restored=new StudioDatabase(databaseUrl(process.env.HV_PG_ADMIN_URL!,restoreName));const independentDatabase=restored;await checked(()=>independentDatabase.migrate());
      try{process.env.HV_S3_BUCKET=process.env.HV_S3_FLEET_TEST_BUCKET;
        const imported=await checked(()=>importProjectArchive(independentDatabase,archive,unpacked,500));
        expect(imported.jobs).toBe(1);expect(imported.archiveSha256).toBe(exported.archiveSha256);expect(imported.mediaFiles).toBe(carrier.output!.editorial!.files.length);
      }finally{if(savedBucket===undefined)delete process.env.HV_S3_BUCKET;else process.env.HV_S3_BUCKET=savedBucket;}
      expect(readStateSnapshot(unpacked)).toEqual(snapshot);expect(readFileSync(join(unpacked,"state/projects.json"))).toEqual(readFileSync(join(prepared,"state/projects.json")));
      current();yield 14;

      await checked(()=>clearObjects(sourceObjects,projectId));
      await checked(async()=>{await api!.close();api=undefined;});await checked(async()=>{await worker!.close();worker=undefined;});await checked(async()=>{await sourceAdmin.close();admin=undefined;});
      await checked(async()=>{await controller.sql.unsafe('DROP DATABASE "'+sourceName+'" WITH (FORCE)');created.delete(sourceName);});
      for(const path of [previewRoot,finalRoot,carrierRoot,join(prepared,"artifacts"),join(unpacked,"artifacts")])removeOwned(path,root);
      removeOwned(join(f.root,projectId),f.f.studio.root);
      const independentRoot=join(root,"independent"),independentMedia=new PostgresArtifactStore(independentDatabase,independentRoot,destinationObjects),restoredStore=new PostgresJobStore(independentDatabase).forProject(projectId),restoredProjects=new PostgresProjectService(independentDatabase);
      const restoredJob=(await checked(()=>restoredStore.get(carrier.id)))!;expect(restoredJob).toEqual(carrier);
      for(const id of oldOwners)expect(await checked(()=>restoredStore.get(id))).toBeUndefined();
      await checked(()=>independentMedia.restoreCheckpoint(restoredJob,signal()));
      const restoredBinding=bindRetainedEditSource(restoredJob,receipt.revision);expect(restoredBinding).toEqual(retained);assertEditBindingAvailable(restoredBinding,restoredJob);
      for(const file of restoredJob.output!.editorial!.files){expect(await checked(()=>independentMedia.fileInfo(projectId,carrier.id,file.path))).toEqual(file);expect(readFileSync(join(independentRoot,file.path))).toEqual(allCarrierBytes.get(file.path)!);expect(measured(join(independentRoot,file.path))).toEqual({bytes:file.bytes,sha256:file.sha256});}
      const probe=join(root,"independent-receipt-probe");mkdirSync(probe);
      await checked(()=>verifyEditSourceReceiptMedia(restoredBinding.source,originalNamespace(restoredBinding,independentRoot),probe,async()=>{current();},signal()));
      await checked(()=>verifyEditMedia(restoredJob,restoredJob.output!,independentRoot,async()=>{current();},signal()));
      expect(compileEditScriptSource(restoredBinding.source)).toEqual(expectedIndex);expect(resolveEditCurrentFilmMixedScriptSource(restoredBinding.source).documentRevision).toBe(final.currentFilm.target.state.context.plan.document.revision);
      expect(restoredBinding.source.delivery).toEqual(receipt.delivery);expect(restoredBinding.source.job.currentFilmProof).toEqual(final.currentFilmProof);expect(restoredBinding.source.job.currentFilmCheckpoint).toEqual(final.currentFilmCheckpoint);
      expect(await checked(()=>exportStateSnapshot(independentDatabase,projectId))).toEqual(snapshot);
      for(const id of oldOwners)expect(existsSync(join(independentRoot,projectId,id))).toBe(false);
      current();yield 15;

      const nextPlan=createEditPlan(sequence,[restoredBinding],soundRuntimeRevision(),"s3",hash("continue-approved-final-carrier"),editRenderReview(timeline));
      assertEditPermission(nextPlan,await checked(()=>restoredProjects.peekProject(projectId)));
      const beforeRights=(await checked(()=>independentDatabase.sql`select body,version from hv_projects where id=${projectId}`))[0],rightsCounts=await counts(independentDatabase);
      await checked(()=>independentDatabase.sql`update hv_projects set body=${{...beforeRights.body,rightsAttestedAt:null}}::jsonb where id=${projectId}`);
      try{await checked(()=>expect(new PostgresCostLedger(independentDatabase).admit(projectId,{...carrierInput,id:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),pictureEdit:nextPlan},500)).rejects.toThrow(/rights|permission/));expect(await counts(independentDatabase)).toEqual(rightsCounts);}
      finally{await independentDatabase.sql`update hv_projects set body=${beforeRights.body}::jsonb where id=${projectId}`;}
      expect((await checked(()=>independentDatabase.sql`select body,version from hv_projects where id=${projectId}`))[0]).toEqual(beforeRights);
      expect(await checked(()=>exportStateSnapshot(independentDatabase,projectId))).toEqual(snapshot);
      current();yield 16;

      const native=final.currentFilmCheckpoint!.rows.find(row=>row.kind==="generated"&&row.record.files.audio);
      if(!native||native.kind!=="generated"||!native.record.files.audio)throw new Error("The final source must retain actual native PCM.");
      const nativeIndex=receipt.files.findIndex(file=>file.path===native.record.files.audio!.path),nativeCopy=restoredBinding.files[nativeIndex]!;
      const segmentIndex=receipt.files.findIndex(file=>file.path===receipt.delivery!.segments[0]),segmentCopy=restoredBinding.files[segmentIndex]!;
      expect(nativeIndex).toBeGreaterThanOrEqual(0);expect(segmentIndex).toBeGreaterThanOrEqual(0);
      const objectRow=async(path:string)=>(await checked(()=>independentDatabase.sql`select object_key,sha256,bytes from hv_artifacts where project_id=${projectId} and job_id=${carrier.id} and key=${path}`))[0];
      const nativeRow=await objectRow(nativeCopy.path),segmentRow=await objectRow(segmentCopy.path),nativeObject=destinationObjects.file(String(nativeRow.object_key)),segmentObject=destinationObjects.file(String(segmentRow.object_key));
      const nativeBytes=allCarrierBytes.get(nativeCopy.path)!,segmentBytes=allCarrierBytes.get(segmentCopy.path)!,beforeCorruption=await counts(independentDatabase);
      const corrupt=Buffer.from(nativeBytes);expect(corrupt.length).toBeGreaterThan(48);corrupt[48]^=1;
      try{await checked(()=>nativeObject.write(corrupt));await checked(()=>expect(new PostgresArtifactStore(independentDatabase,join(root,"bad-native"),destinationObjects).restoreCheckpoint(restoredJob,signal())).rejects.toThrow(/checksum|corrupt|changed/));}
      finally{await nativeObject.write(nativeBytes);}
      try{await checked(()=>segmentObject.delete());await checked(()=>expect(new PostgresArtifactStore(independentDatabase,join(root,"missing-segment"),destinationObjects).restoreCheckpoint(restoredJob,signal())).rejects.toThrow());}
      finally{await segmentObject.write(segmentBytes);}
      await checked(()=>independentDatabase.sql`update hv_artifacts set bytes=bytes+1 where project_id=${projectId} and job_id=${carrier.id} and key=${nativeCopy.path}`);
      try{await checked(()=>expect(new PostgresArtifactStore(independentDatabase,join(root,"bad-index"),destinationObjects).restoreCheckpoint(restoredJob,signal())).rejects.toThrow());}
      finally{await independentDatabase.sql`update hv_artifacts set bytes=${nativeRow.bytes} where project_id=${projectId} and job_id=${carrier.id} and key=${nativeCopy.path}`;}
      expect(await counts(independentDatabase)).toEqual(beforeCorruption);expect(await checked(()=>exportStateSnapshot(independentDatabase,projectId))).toEqual(snapshot);
      const repairedRoot=join(root,"repaired"),repaired=new PostgresArtifactStore(independentDatabase,repairedRoot,destinationObjects);await checked(()=>repaired.restoreCheckpoint(restoredJob,signal()));
      expect(readFileSync(join(repairedRoot,nativeCopy.path))).toEqual(nativeBytes);expect(readFileSync(join(repairedRoot,segmentCopy.path))).toEqual(segmentBytes);
      for(const id of oldOwners)expect(existsSync(join(repairedRoot,projectId,id))).toBe(false);
      current();yield 17;
    }finally{
      // All operations, including signal-less worker/archive calls, settle before
      // this finalizer. It never runs concurrently with another fixture phase.
      await Promise.allSettled([...cancellations]);const errors:unknown[]=[];
      const clean=async(run:()=>PromiseLike<unknown>|unknown)=>{try{await run();}catch(error){errors.push(error);}};
      if(cleanupProjectId)for(const client of [sourceClient,destinationClient])if(client)await clean(()=>clearObjects(client,cleanupProjectId!));
      for(const database of [api,worker,admin,restored])if(database)await clean(()=>database.close());
      if(control){for(const name of created)await clean(()=>control!.sql.unsafe('DROP DATABASE "'+databaseName(name)+'" WITH (FORCE)'));await clean(()=>control!.close());}
      await clean(()=>fixture?.close());
      if(savedBucket===undefined)delete process.env.HV_S3_BUCKET;else process.env.HV_S3_BUCKET=savedBucket;
      if(savedPool===undefined)delete process.env.HV_PROVIDER_POOL;else process.env.HV_PROVIDER_POOL=savedPool;
      // Preserve media for diagnosis if any service cleanup failed. No raw URL,
      // driver error, token, project body or capability appears in this message.
      if(errors.length)throw new Error("Final-source service cleanup failed; retain its private resources.");cleanup(root);
    }
  }
  const iterator=lifecycle();
  const phases=[
    ["imports actual moved-source bootstrap and V2 media into PostgreSQL/S3",600000],
    ["admits the exact moved mixed preview once",600000],
    ["runs the actual preview under its unchanged 600s worker limit",900000],
    ["verifies selective native reuse and records the exact owner decision",600000],
    ["admits a separate genuine final only with its exact preview approval",600000],
    ["runs the actual final under its unchanged 600s worker limit",900000],
    ["verifies completed final records and the owned preview proof",600000],
    ["inspects the final as receipt four with actual indexed delivery and navigation",600000],
    ["atomically saves library two and admits the provider-free carrier",600000],
    ["renders the real editorial carrier under its unchanged 180s worker limit",300000],
    ["verifies complete retained originals and captures exact durable history",600000],
    ["removes every outer source preview and final owner before state16 export",600000],
    ["packs a genuine carrier-only project from source bucket custody",600000],
    ["imports the carrier-only archive into an independent database and bucket",600000],
    ["deletes source services and restores native proof solely from the new bucket",600000],
    ["retains fresh rights refusal after historical recovery without writes",300000],
    ["refuses native segment and index corruption then restores exact repaired custody",600000],
  ] as const;
  for(const [index,[name,timeout]]of phases.entries())(enabled?test:test.skip)(name,async()=>{
    if(failed||completed!==index||active&&!active.finished)throw new Error("The prior final-source service phase did not settle successfully.");
    const scope:Phase={ordinal:index+1,controller:new AbortController(),promise:Promise.resolve(),finished:false};active=scope;
    scope.promise=(async()=>{const result=await iterator.next();current();expect(result.done).toBe(false);expect(result.value).toBe(scope.ordinal);completed++;})()
      .catch(error=>{failed=true;throw error;}).finally(()=>{scope.finished=true;});void scope.promise.catch(()=>{});await scope.promise;
  },timeout);
  afterEach(async()=>{if(!active||active.finished)return;failed=true;active.controller.abort(new Error("Final-source service phase timed out."));cancelObservedWorker();await settledWithin(active.promise,5000);},6000);
  afterAll(async()=>{
    if(!enabled)return;
    if(active&&!active.finished){failed=true;active.controller.abort(new Error("Final-source service teardown."));cancelObservedWorker();if(!await settledWithin(active.promise,5000))failStop();}
    if(cancellations.size&&!await settledWithin(Promise.allSettled([...cancellations]),5000))failStop();
    const closing=iterator.return();void closing.catch(()=>{});if(!await settledWithin(closing,10000)){failed=true;failStop();}await closing;
  },25000);
});
