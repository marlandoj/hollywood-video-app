import {expect,test} from "bun:test";
import {existsSync,mkdtempSync,readFileSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {StudioDatabase} from "../src/database";
import {PostgresProjectService} from "../src/projects";
import {PostgresJobStore} from "../src/jobs";
import {PostgresCostLedger} from "../src/ledger";
import {PostgresReviewQueue} from "../src/reviews";
import {PostgresArtifactStore,objectClient} from "../src/artifacts";
import {exportProjectArchive,importProjectArchive} from "../src/archives";
import {exportStateSnapshot,readStateSnapshot,validateSnapshot} from "../src/snapshots";
import {processNextJob} from "../../queue/src/worker";
import {LeaseError,type JobInput} from "../../queue/src/index";
import {defaultMotionGraphic,motionGraphic} from "../../planner/src/motion-graphics";
import {currentGraphics} from "../../planner/src/graphic-library";
import {graphicJobPlan} from "../../planner/src/graphic-jobs";
import {createEditAssemblyRenderPlan,editAssemblyRenderReview} from "../../planner/src/edit-assembly-jobs";
import {emptyEditAssemblyLibrary} from "../../planner/src/edit-assembly-proposals";
import {bindOriginalEditSource,bindRetainedEditSource,assertEditBindingAvailable} from "../../planner/src/edit-jobs";
import {contentHash} from "../../generator/src/capabilities";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {soundRuntimeRevision} from "../../generator/src/sound-audio";
import {verifyEditAssemblyMedia} from "../../generator/src/edit-assembly-media";

const enabled=Boolean(process.env.HV_GRAPHICS_CHROME_PATH&&process.env.HV_PG_ADMIN_URL&&process.env.HV_API_DATABASE_URL&&process.env.HV_WORKER_DATABASE_URL&&process.env.HV_S3_ENDPOINT&&process.env.HV_S3_BUCKET&&process.env.HV_S3_FLEET_TEST_BUCKET);
function databaseName(name:string):string {if(!/^hv_assembly_render_[a-f0-9]{32}$/.test(name))throw new Error("Unsafe assembly render fixture database");return name;}
function cleanup(root:string):void {if(!root.startsWith(realpathSync(tmpdir())+sep+"hv-assembly-render-")||realpathSync(root)!==root)throw new Error("Unsafe assembly render cleanup");rmSync(root,{recursive:true,force:true});}
async function clearObjects(client:ReturnType<typeof objectClient>,projectId:string,jobId?:string):Promise<void>{
  if(!/^[A-Za-z0-9_-]+$/.test(projectId)||jobId!==undefined&&!/^[A-Za-z0-9_-]+$/.test(jobId))throw new Error("Unsafe assembly object scope");const prefix=`v1/${projectId}/`+(jobId?jobId+"/":"");
  for(let page=0;page<100;page++){const objects=(await client.list({prefix,maxKeys:1000})).contents??[];if(!objects.length)return;for(const object of objects){if(!object.key.startsWith(prefix))throw new Error("Assembly object escaped its fixture");await client.file(object.key).delete();}}throw new Error("Assembly object cleanup exceeded its bound");
}

(enabled?test:test.skip)("PostgreSQL assembly exports fence checkpoints, retain originals independently, and restore a separate S3 archive",async()=>{
  const secret=process.env.HV_TOKEN_SECRET,sourceBucket=process.env.HV_S3_BUCKET;process.env.HV_TOKEN_SECRET="assembly-render-storage-fixture-secret-at-least-thirty-two-characters";
  const root=realpathSync(mkdtempSync(join(realpathSync(tmpdir()),"hv-assembly-render-"))),name=databaseName("hv_assembly_render_"+crypto.randomUUID().replaceAll("-","")),admin=new StudioDatabase(process.env.HV_PG_ADMIN_URL!),api=new StudioDatabase(process.env.HV_API_DATABASE_URL!),worker=new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!),sourceClient=objectClient(),destinationClient=objectClient({...process.env,HV_S3_BUCKET:process.env.HV_S3_FLEET_TEST_BUCKET});let projectId:string|undefined,restored:StudioDatabase|undefined,created=false;
  try{
    expect(sourceBucket).not.toBe(process.env.HV_S3_FLEET_TEST_BUCKET);await admin.migrate();const projects=new PostgresProjectService(api),owner=await projects.createAnonymousProject();projectId=owner.projectId;await projects.attestRights(owner.token);
    const {revision:_revision,...defaults}=defaultMotionGraphic("lower-third",320,180),graphic=motionGraphic({...defaults,text:"Original title",secondary:"Independent assembly",frames:4,enterFrames:1,exitFrames:1});await projects.saveGraphic(owner.token,{kind:"save",id:crypto.randomUUID(),label:"Title",plan:graphic},0);
    const project=(await projects.peekProject(projectId))!,spec=currentGraphics(project.graphicLibrary,projectId)[0]!.spec,ledger=new PostgresCostLedger(worker),firstRoot=join(root,"first"),firstMedia=new PostgresArtifactStore(worker,firstRoot),context={projects,ledger,reviewQueue:new PostgresReviewQueue(worker)};
    const sourceInput:JobInput={id:crypto.randomUUID(),projectId,idempotencyKey:crypto.randomUUID(),tier:"free",stage:"motion-graphic",scriptVersion:0,scriptText:"",rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:4,costCapUsd:0,budgetReservedUsd:0,retryPolicy:{maxRetries:2,backoffMs:1000},timeoutMs:120000,graphicRender:graphicJobPlan(spec,"s3",contentHash("assembly-render-original"))};
    const admittedSource=await ledger.admit(projectId,sourceInput,500),original=(await processNextJob(new PostgresJobStore(worker).forProject(projectId),firstRoot,{...context,artifacts:firstMedia,workerId:"assembly-original"}))!;expect(original.id).toBe(admittedSource.id);expect(original.failureReason??original.cancelReason).toBeUndefined();expect(original.status).toBe("done");
    const source=await inspectEditSource(original,spec.label,firstRoot,async()=>{},undefined,firstMedia,path=>firstMedia.fileInfo(projectId!,original.id,path)),binding=bindOriginalEditSource(source),sequenceId="parent",editorial=(await projects.createEditSequence(owner.token,[source],sequenceId,"Range parent",source.facts.id,64,48,0,Date.now(),[binding]))!,history=editorial.sequences[0]!.history.revision;
    const proposals=(await projects.createAssemblyProposal(owner.token,sequenceId,{id:"proposal",label:"Reordered title",purpose:"custom",ranges:[{id:"later",fromFrame:1,toFrame:4,reason:"Show the held title first."},{id:"opening",fromFrame:0,toFrame:1,reason:"Return to the entrance."}]},{libraryVersion:0,historyRevision:history},[{binding,current:original}]))!,proposal=proposals.proposals[0]!,accepted=(await projects.acceptAssemblyProposal(owner.token,proposal.id,proposal.revision,"accepted",{libraryVersion:1,historyRevision:history},[{binding,current:original}]))!.assembly;
    const assemblyEdit=createEditAssemblyRenderPlan(accepted,[binding],soundRuntimeRevision(),"s3",contentHash("assembly-render-request"),editAssemblyRenderReview(accepted,[binding])),input:JobInput={...sourceInput,id:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),stage:"assembly-edit",graphicRender:undefined,assemblyEdit};delete input.graphicRender;
    const saved=(await admin.sql`select body,version from hv_projects where id=${projectId}`)[0],assertAbsent=async()=>{expect(Number((await admin.sql`select count(*) as count from hv_jobs where project_id=${projectId} and stage='assembly-edit'`)[0].count)).toBe(0);expect(Number((await admin.sql`select count(*) as count from hv_reservations where job_id=${input.id}`)[0].count)).toBe(0);};
    await admin.sql`update hv_projects set body=${{...saved.body,assemblyLibrary:emptyEditAssemblyLibrary()}}::jsonb where id=${projectId}`;await expect(ledger.admit(projectId,input,500)).rejects.toThrow("current saved accepted");await assertAbsent();await admin.sql`update hv_projects set body=${saved.body}::jsonb where id=${projectId}`;
    await admin.sql`update hv_jobs set body=${{...original,status:"cancelled"}}::jsonb,status='cancelled' where id=${original.id}`;await expect(ledger.admit(projectId,input,500)).rejects.toThrow();await assertAbsent();await admin.sql`update hv_jobs set body=${original}::jsonb,status='done' where id=${original.id}`;
    const carrierFile=binding.files[0]!;await admin.sql`update hv_artifacts set bytes=bytes+1 where key=${carrierFile.path}`;await expect(ledger.admit(projectId,input,500)).rejects.toThrow("source artifact changed");await assertAbsent();await admin.sql`update hv_artifacts set bytes=${carrierFile.bytes} where key=${carrierFile.path}`;
    const admissions=await Promise.all([ledger.admit(projectId,input,500),ledger.admit(projectId,{...input,id:crypto.randomUUID()},500)]);expect(admissions[0]!.id).toBe(admissions[1]!.id);const jobId=admissions[0]!.id;
    const first=new PostgresJobStore(worker).forProject(projectId),complete=first.complete.bind(first);first.complete=async id=>{throw new LeaseError(id,"fence_changed","interrupted-after-checkpoint");};
    // HV-025-06: the assembly worker verifies every retained file, and the lease and permission
    // check behind it runs at most once a second (plus admission, checkpoint and completion).
    const heartbeat=first.heartbeat.bind(first);let heartbeats=0;first.heartbeat=(...args:Parameters<typeof heartbeat>)=>{heartbeats++;return heartbeat(...args);};
    const startedAt=performance.now();
    const checkpoint=(await processNextJob(first,firstRoot,{...context,artifacts:firstMedia,workerId:"assembly-interrupted"}))!;first.complete=complete;first.heartbeat=heartbeat;
    expect(heartbeats).toBeLessThanOrEqual(Math.ceil((performance.now()-startedAt)/1000)+8);expect(checkpoint.id).toBe(jobId);expect(checkpoint.failureReason??checkpoint.cancelReason).toBeUndefined();expect(checkpoint.status).toBe("running");expect(checkpoint.assemblyCheckpoint?.assembly?.conform.picture.pictureFrames).toHaveLength(4);expect(checkpoint.output).toBeUndefined();
    await expect(exportStateSnapshot(admin,projectId)).rejects.toThrow("drained");
    // Checkpoint-only failures remain portable, and do not silently disappear from recovery state.
    await ledger.release(jobId);
    for(const status of ["failed","cancelled"] as const){await admin.sql`update hv_jobs set status=${status},body=${{...checkpoint,status}}::jsonb where id=${jobId}`;const snapshot=await exportStateSnapshot(admin,projectId);expect(snapshot.schema).toBe("hv-state/7");expect(snapshot.jobs.find(job=>job.id===jobId)!.assemblyCheckpoint).toEqual(checkpoint.assemblyCheckpoint);expect(()=>validateSnapshot({...snapshot,schema:"hv-state/6"})).toThrow("schema 7");}await admin.sql`update hv_jobs set status='running',body=${checkpoint}::jsonb where id=${jobId}`;
    await clearObjects(sourceClient,projectId,original.id);await admin.sql`delete from hv_outbox where job_id=${original.id}`;await admin.sql`delete from hv_artifacts where job_id=${original.id}`;await admin.sql`delete from hv_jobs where id=${original.id}`;
    const secondRoot=join(root,"second"),second=new PostgresJobStore(worker).forProject(projectId),secondMedia=new PostgresArtifactStore(worker,secondRoot),resumeAt=Date.parse(checkpoint.leaseExpiresAt!)+1,done=(await processNextJob(second,secondRoot,{...context,artifacts:secondMedia,workerId:"assembly-recovered",now:()=>resumeAt}))!;
    expect(done.id).toBe(jobId);expect(done.failureReason??done.cancelReason).toBeUndefined();expect(done.status).toBe("done");expect(done.resumedCount).toBe(1);expect(done.output).toEqual(checkpoint.assemblyCheckpoint);expect(done.costUsd).toBe(0);expect((await ledger.admit(projectId,input,500)).id).toBe(jobId);await expect(first.complete(jobId,"assembly-interrupted",done.output!)).rejects.toBeInstanceOf(LeaseError);
    await expect(ledger.beginAttempt({id:crypto.randomUUID(),projectId,jobId,shotId:"invalid",provider:"invalid",workerId:"assembly-recovered",leaseVersion:done.leaseVersion!,estimateUsd:1})).rejects.toThrow("do not dispatch providers");
    await expect(ledger.record({projectId,jobId,stage:"assembly-edit",shotId:"invalid",provider:"invalid",model:"invalid",at:new Date().toISOString(),total_cost_usd:1,gpu_seconds:0,prompt_tokens:0,output_frames:0})).rejects.toThrow("do not incur provider costs");
    const retained=bindRetainedEditSource(done,source.revision);assertEditBindingAvailable(retained,done);expect(retained.source).toEqual(source);
    await secondMedia.restoreCheckpoint(done);const expectedBytes=new Map(done.output!.assembly!.files.map(file=>[file.path,readFileSync(join(secondRoot,file.path))]));expect(existsSync(join(secondRoot,projectId,original.id))).toBe(false);
    const archive=join(root,"assembly-export.zip"),prepared=join(root,"prepared"),exported=await exportProjectArchive(admin,projectId,prepared,archive);expect(exported.jobs).toBe(1);const snapshot=readStateSnapshot(prepared);expect(snapshot.schema).toBe("hv-state/7");expect(snapshot.jobs[0]!.id).toBe(jobId);expect(snapshot.projects.projects[0]!.assemblyLibrary!.assemblies[0]).toEqual(accepted);
    await admin.sql.unsafe('CREATE DATABASE "'+databaseName(name)+'"');created=true;const target=new URL(process.env.HV_PG_ADMIN_URL!);target.pathname="/"+name;restored=new StudioDatabase(target.href);await restored.migrate();
    let imported:Awaited<ReturnType<typeof importProjectArchive>>;try{process.env.HV_S3_BUCKET=process.env.HV_S3_FLEET_TEST_BUCKET;imported=await importProjectArchive(restored,archive,join(root,"unpacked"),500);}finally{process.env.HV_S3_BUCKET=sourceBucket;}
    expect(imported.jobs).toBe(1);expect(imported.archiveSha256).toBe(exported.archiveSha256);expect(imported.mediaFiles).toBe(done.output!.assembly!.files.length);expect(imported.mediaBytes).toBe([...expectedBytes.values()].reduce((sum,bytes)=>sum+bytes.length,0));await clearObjects(sourceClient,projectId);
    const restoredProjects=new PostgresProjectService(restored),restoredProject=(await restoredProjects.authorize(owner.token))!,restoredJob=(await new PostgresJobStore(restored).forProject(projectId).get(jobId))!,thirdRoot=join(root,"independent"),thirdMedia=new PostgresArtifactStore(restored,thirdRoot,destinationClient);expect(restoredJob.output).toEqual(done.output);expect(restoredProject.assemblyLibrary).toEqual(snapshot.projects.projects[0]!.assemblyLibrary!);expect(restoredProject.editLibrary.sources[0]).toEqual(source);expect((await exportStateSnapshot(restored,projectId)).schema).toBe("hv-state/7");
    await thirdMedia.restoreCheckpoint(restoredJob);expect(existsSync(join(thirdRoot,projectId,original.id))).toBe(false);await verifyEditAssemblyMedia({...restoredJob,assemblyEdit:restoredJob.assemblyEdit!},{...restoredJob.output!,assembly:restoredJob.output!.assembly!},thirdRoot,async()=>{});
    for(const file of restoredJob.output!.assembly!.files){expect(await thirdMedia.fileInfo(projectId,jobId,file.path)).toEqual(file);expect(readFileSync(join(thirdRoot,file.path))).toEqual(expectedBytes.get(file.path)!);}assertEditBindingAvailable(bindRetainedEditSource(restoredJob,source.revision),restoredJob);
    await projects.saveGraphic(owner.token,{kind:"availability",id:spec.id,available:false},project.graphicLibrary.version);await expect(ledger.admit(projectId,input,500)).rejects.toThrow("permission");expect((await new PostgresCostLedger(restored).admit(projectId,input,500)).id).toBe(jobId);
    const counts=(await admin.sql`select (select count(*) from hv_jobs where project_id=${projectId}) as jobs,(select count(*) from hv_reservations where job_id=${jobId}) as holds,(select count(*) from hv_cost_events where project_id=${projectId}) as costs,(select count(*) from hv_provider_attempts where project_id=${projectId}) as attempts`)[0];expect([Number(counts.jobs),Number(counts.holds),Number(counts.costs),Number(counts.attempts)]).toEqual([1,0,0,0]);
    const missing=restoredJob.output!.assembly!.files[0]!;await restored.sql`delete from hv_artifacts where key=${missing.path}`;await expect(new PostgresArtifactStore(restored,join(root,"missing-record"),destinationClient).restoreCheckpoint(restoredJob)).rejects.toThrow("Stored assembly media differs");
  }finally{
    if(sourceBucket===undefined)delete process.env.HV_S3_BUCKET;else process.env.HV_S3_BUCKET=sourceBucket;
    if(projectId){for(const client of [sourceClient,destinationClient])await clearObjects(client,projectId);await admin.sql`delete from hv_reservations where job_id in (select id from hv_jobs where project_id=${projectId})`;for(const table of ["hv_outbox","hv_artifacts","hv_archives","hv_reviews","hv_operator_reviews","hv_cost_events","hv_provider_attempts","hv_jobs","hv_projects"])await admin.sql.unsafe('delete from "'+table+'" where '+(table==="hv_projects"?'id':'project_id')+'=$1',[projectId]);}
    await restored?.close();await api.close();await worker.close();if(created)await admin.sql.unsafe('DROP DATABASE "'+databaseName(name)+'" WITH (FORCE)');await admin.close();if(secret===undefined)delete process.env.HV_TOKEN_SECRET;else process.env.HV_TOKEN_SECRET=secret;cleanup(root);
  }
},240000);
