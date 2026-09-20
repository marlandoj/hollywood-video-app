import {expect,test} from "bun:test";
import {existsSync,mkdtempSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {StudioDatabase} from "../src/database";
import {PostgresProjectService} from "../src/projects";
import {PostgresJobStore} from "../src/jobs";
import {PostgresCostLedger} from "../src/ledger";
import {PostgresReviewQueue} from "../src/reviews";
import {PostgresArtifactStore,objectClient} from "../src/artifacts";
import {exportProjectArchive,importProjectArchive} from "../src/archives";
import {exportStateSnapshot,validateSnapshot} from "../src/snapshots";
import {processNextJob} from "../../queue/src/worker";
import {LeaseError,type JobInput} from "../../queue/src/index";
import {defaultMotionGraphic,motionGraphic} from "../../planner/src/motion-graphics";
import {currentGraphics} from "../../planner/src/graphic-library";
import {graphicJobPlan,assertGraphicPermission} from "../../planner/src/graphic-jobs";
import {contentHash} from "../../generator/src/capabilities";
import {verifyGraphicMedia} from "../../generator/src/graphic-media";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {soundRuntimeRevision} from "../../generator/src/sound-audio";
import {bindOriginalEditSource,bindRetainedEditSource,createEditPlan,editRenderReview} from "../../planner/src/edit-jobs";
import {editHistoryState} from "../../planner/src/edit-history";
import {verifyEditMedia} from "../../generator/src/edit-media";
const enabled=Boolean(process.env.HV_GRAPHICS_CHROME_PATH&&process.env.HV_PG_ADMIN_URL&&process.env.HV_WORKER_DATABASE_URL&&process.env.HV_S3_ENDPOINT&&process.env.HV_S3_FLEET_TEST_BUCKET);
function ownedDatabase(name:string){if(!/^hv_graphics_[a-f0-9]{32}$/.test(name))throw new Error("Unsafe fixture database");return name;}
function ownedKey(key:string,id:string){if(!key.startsWith(`v1/${id}/`))throw new Error("Fixture media escaped its owner");return key;}
function cleanup(root:string){if(!root.startsWith(realpathSync(tmpdir())+sep)||realpathSync(root)!==root)throw new Error("Unsafe fixture cleanup");rmSync(root,{recursive:true,force:true});}
(enabled?test:test.skip)("PostgreSQL graphics serialize saves and admission, fence checkpoints, and restore independent S3 archives",async()=>{
  const secret=process.env.HV_TOKEN_SECRET,sourceBucket=process.env.HV_S3_BUCKET;process.env.HV_TOKEN_SECRET="graphics-storage-fixture-secret-at-least-thirty-two-characters";
  const root=mkdtempSync(join(realpathSync(tmpdir()),"hv-graphics-pg-")),name="hv_graphics_"+crypto.randomUUID().replaceAll("-",""),admin=new StudioDatabase(process.env.HV_PG_ADMIN_URL!),worker=new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!);let restored:StudioDatabase|undefined,id:string|undefined,created=false;
  const sourceClient=objectClient(),destinationClient=objectClient({...process.env,HV_S3_BUCKET:process.env.HV_S3_FLEET_TEST_BUCKET});
  try{
    await admin.migrate();const projects=new PostgresProjectService(admin),owner=await projects.createAnonymousProject();id=owner.projectId;await projects.attestRights(owner.token);
    const {revision:_r,...defaults}=defaultMotionGraphic("lower-third",320,180),plan=motionGraphic({...defaults,text:"Marla",secondary:"Fictional character",frames:4,enterFrames:1,exitFrames:1}),graphicId=crypto.randomUUID();
    const mutations=await Promise.allSettled([projects.saveGraphic(owner.token,{kind:"save",id:graphicId,label:"Opening",plan},0),projects.saveGraphic(owner.token,{kind:"save",id:crypto.randomUUID(),label:"Concurrent",plan},0)]);expect(mutations.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(mutations.filter(r=>r.status==="rejected")).toHaveLength(1);
    const project=(await projects.peekProject(id))!,saved=currentGraphics(project.graphicLibrary,id)[0]!.spec,graphicRender=graphicJobPlan(saved,"s3",contentHash({fixture:"graphic"})),input:JobInput={id:crypto.randomUUID(),projectId:id,idempotencyKey:crypto.randomUUID(),tier:"free",stage:"motion-graphic",scriptVersion:0,scriptText:"",rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:4,costCapUsd:0,budgetReservedUsd:0,retryPolicy:{maxRetries:2,backoffMs:1000},timeoutMs:120000,graphicRender};
    const ledger=new PostgresCostLedger(worker),admitted=await Promise.all([ledger.admit(id,input,500),ledger.admit(id,{...input,id:crypto.randomUUID()},500)]);expect(admitted[0]!.id).toBe(admitted[1]!.id);
    // Either concurrent request can win admission; every later lookup follows the returned job.
    const graphicJobId=admitted[0]!.id,store=new PostgresJobStore(worker).forProject(id),firstRoot=join(root,"first"),firstMedia=new PostgresArtifactStore(worker,firstRoot),original=store.completeGraphic.bind(store);store.completeGraphic=async jobId=>{throw new LeaseError(jobId,"fence_changed","interrupted");};
    // HV-025-04: no in-process project store, as in the production PostgreSQL worker; permission comes from the ledger.
    const context={ledger,reviewQueue:new PostgresReviewQueue(worker)},checkpoint=await processNextJob(store,firstRoot,{...context,artifacts:firstMedia,workerId:"graphics-first"});expect(checkpoint?.id).toBe(graphicJobId);expect(checkpoint?.failureReason??checkpoint?.cancelReason).toBeUndefined();expect(checkpoint?.status).toBe("running");expect(checkpoint?.graphicCheckpoint).toBeDefined();store.completeGraphic=original;
    const resumedStore=new PostgresJobStore(worker).forProject(id),secondRoot=join(root,"second"),secondMedia=new PostgresArtifactStore(worker,secondRoot),resumeAt=Date.parse(checkpoint!.leaseExpiresAt!)+1;
    const done=await processNextJob(resumedStore,secondRoot,{...context,artifacts:secondMedia,graphics:{chromePath:"missing-on-purpose"},workerId:"graphics-fresh",now:()=>resumeAt});expect(done?.id).toBe(graphicJobId);expect(done?.failureReason??done?.cancelReason).toBeUndefined();expect(done?.status).toBe("done");expect(done?.graphicOutput).toEqual(checkpoint!.graphicCheckpoint);expect(done?.costUsd).toBe(0);
    await expect(store.completeGraphic(graphicJobId,"graphics-first",done!.graphicOutput!)).rejects.toBeInstanceOf(LeaseError);
    const counts=await admin.sql`select (select count(*) from hv_provider_attempts where job_id=${graphicJobId}) as attempts,(select count(*) from hv_cost_events where job_id=${graphicJobId}) as costs,(select count(*) from hv_reservations where job_id=${graphicJobId}) as holds`;expect(Number(counts[0].attempts)).toBe(0);expect(Number(counts[0].costs)).toBe(0);expect(Number(counts[0].holds)).toBe(0);
    const source=await inspectEditSource(done!,saved.label,secondRoot,async()=>{},undefined,secondMedia,path=>secondMedia.fileInfo(id!,done!.id,path)),binding=bindOriginalEditSource(source),sequenceId=crypto.randomUUID(),library=await projects.createEditSequence(owner.token,[source],sequenceId,"Graphic assembly",source.facts.id,320,180,0,Date.now(),[binding]);expect(library).not.toBeNull();
    const sequence=library!.sequences[0]!,pictureEdit=createEditPlan(sequence,[binding],soundRuntimeRevision(),"s3",contentHash({fixture:"graphic-edit"}),editRenderReview(editHistoryState(sequence.history).timeline)),editInput:JobInput={id:crypto.randomUUID(),projectId:id,idempotencyKey:crypto.randomUUID(),tier:"free",stage:"picture-edit",scriptVersion:0,scriptText:"",rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:4,costCapUsd:0,budgetReservedUsd:0,retryPolicy:{maxRetries:2,backoffMs:1000},timeoutMs:120000,pictureEdit};
    await ledger.admit(id,editInput,500);const edited=await processNextJob(resumedStore,secondRoot,{...context,artifacts:secondMedia,workerId:"graphic-editorial"});expect(edited?.failureReason??edited?.cancelReason).toBeUndefined();expect(edited?.status).toBe("done");expect(edited?.costUsd).toBe(0);expect(edited!.output!.editorial!.prepared.sources[0]!.media.picture.sha256).toBe(done!.graphicOutput!.report.master.sha256);
    const graphicSnapshot=await exportStateSnapshot(admin,id);expect(graphicSnapshot.schema).toBe("hv-state/5");expect(()=>validateSnapshot({...graphicSnapshot,schema:"hv-state/4"})).toThrow("schema 5");
    const picture=editHistoryState(sequence.history).timeline.clips.find(c=>c.lane==="picture")!;
    let retainedLibrary=(await projects.changeEditSequence(owner.token,sequenceId,{kind:"edit",label:"Mask the graphic",operation:{kind:"composite",clipId:picture.id,composite:{schema:"hv-edit-composite/1",masks:[{id:"subject",label:"Subject",sourceRevision:source.facts.revision,kind:"ellipse",combine:"replace",invert:false,featherQ8:0,keyframes:[{sourceFrame:0,interpolation:"hold",geometry:{xQ16:0,yQ16:0,widthQ16:65536,heightQ16:65536}}]}]}}},library!.version,sequence.history.revision))!;
    retainedLibrary=(await projects.changeEditSequence(owner.token,sequenceId,{kind:"cursor",target:0,reason:"undo",label:"Keep the authored mask branch"},retainedLibrary.version,retainedLibrary.sequences[0]!.history.revision))!;
    expect(editHistoryState(retainedLibrary.sequences[0]!.history).timeline.revision).toBe(sequence.history.root.revision);
    const snapshot=await exportStateSnapshot(admin,id);expect(snapshot.schema).toBe("hv-state/6");expect(()=>validateSnapshot({...snapshot,schema:"hv-state/5"})).toThrow("schema 6");
    const archive=join(root,"graphics.zip");const exported=await exportProjectArchive(admin,id,join(root,"prepared"),archive);expect(exported.jobs).toBe(2);
    if(!/^hv_graphics_[a-f0-9]{32}$/.test(name))throw new Error("Unsafe fixture database");await admin.sql.unsafe('CREATE DATABASE "'+name+'"');created=true;const target=new URL(process.env.HV_PG_ADMIN_URL!);target.pathname="/"+name;restored=new StudioDatabase(target.href);await restored.migrate();
    process.env.HV_S3_BUCKET=process.env.HV_S3_FLEET_TEST_BUCKET;const imported=await importProjectArchive(restored,archive,join(root,"unpacked"),500);expect(imported.jobs).toBe(2);process.env.HV_S3_BUCKET=sourceBucket;
    const restoredProject=(await new PostgresProjectService(restored).peekProject(id))!,restoredJob=(await new PostgresJobStore(restored).forProject(id).get(graphicJobId))!,thirdRoot=join(root,"independent"),thirdMedia=new PostgresArtifactStore(restored,thirdRoot,destinationClient);
    expect(restoredProject.graphicLibrary).toEqual(project.graphicLibrary);expect(restoredJob.graphicOutput).toEqual(done!.graphicOutput);
    const restoredEdit=(await new PostgresJobStore(restored).forProject(id).get(editInput.id))!;expect(restoredEdit.output).toEqual(edited!.output);expect(restoredProject.editLibrary).toEqual(retainedLibrary);expect((await exportStateSnapshot(restored,id)).schema).toBe("hv-state/6");await thirdMedia.restoreCheckpoint(restoredEdit);expect(existsSync(join(thirdRoot,id,graphicJobId))).toBe(false);await verifyEditMedia(restoredEdit,restoredEdit.output!,thirdRoot,async()=>{});expect(existsSync(join(thirdRoot,id,graphicJobId))).toBe(false);
    await thirdMedia.restoreCheckpoint(restoredJob);await verifyGraphicMedia(restoredJob,restoredJob.graphicOutput!,thirdRoot);assertGraphicPermission(restoredJob.graphicRender!,restoredProject);
    const disabled=await projects.saveGraphic(owner.token,{kind:"availability",id:saved.id,available:false},1);expect(disabled!.version).toBe(2);expect(()=>assertGraphicPermission(graphicRender,{...project,graphicLibrary:disabled!})).toThrow("permission");assertGraphicPermission(restoredJob.graphicRender!,restoredProject);
    for(const retained of [binding,bindRetainedEditSource(edited!,source.revision)]){
      const deniedId=crypto.randomUUID(),deniedPlan=createEditPlan(sequence,[retained],soundRuntimeRevision(),"s3",contentHash({fixture:"revoked-graphic-edit",deniedId}),editRenderReview(editHistoryState(sequence.history).timeline));
      await expect(ledger.admit(id,{...editInput,id:deniedId,idempotencyKey:crypto.randomUUID(),pictureEdit:deniedPlan},500)).rejects.toThrow("permission");
      const denied=await admin.sql`select (select count(*) from hv_jobs where id=${deniedId}) as jobs,(select count(*) from hv_reservations where job_id=${deniedId}) as holds`;expect(Number(denied[0].jobs)).toBe(0);expect(Number(denied[0].holds)).toBe(0);
    }
  }finally{
    process.env.HV_S3_BUCKET=sourceBucket;if(id){for(const client of [sourceClient,destinationClient]){for(let i=0;i<10;i++){const objects=(await client.list({prefix:`v1/${id}/`,maxKeys:1000})).contents??[];if(!objects.length)break;for(const object of objects)await client.file(ownedKey(object.key,id)).delete();}}for(const table of ["hv_outbox","hv_artifacts","hv_archives","hv_reviews","hv_operator_reviews","hv_cost_events","hv_provider_attempts","hv_jobs","hv_projects"])await admin.sql.unsafe('delete from "'+table+'" where '+(table==="hv_projects"?'id':'project_id')+'=$1',[id]);}
    await restored?.close();await worker.close();if(created)await admin.sql.unsafe('DROP DATABASE "'+ownedDatabase(name)+'" WITH (FORCE)');await admin.close();if(secret===undefined)delete process.env.HV_TOKEN_SECRET;else process.env.HV_TOKEN_SECRET=secret;
    cleanup(root);
  }
},180000);
