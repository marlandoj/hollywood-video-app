import {expect,test} from "bun:test";
import {mkdtempSync,realpathSync,rmSync} from "node:fs";
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
    const store=new PostgresJobStore(worker).forProject(id),firstRoot=join(root,"first"),firstMedia=new PostgresArtifactStore(worker,firstRoot),original=store.completeGraphic.bind(store);store.completeGraphic=async()=>{throw new LeaseError(input.id,"fence_changed","interrupted");};
    const context={projects,ledger,reviewQueue:new PostgresReviewQueue(worker)},checkpoint=await processNextJob(store,firstRoot,{...context,artifacts:firstMedia,workerId:"graphics-first"});expect(checkpoint?.failureReason??checkpoint?.cancelReason).toBeUndefined();expect(checkpoint?.status).toBe("running");expect(checkpoint?.graphicCheckpoint).toBeDefined();store.completeGraphic=original;
    const resumedStore=new PostgresJobStore(worker).forProject(id),secondRoot=join(root,"second"),secondMedia=new PostgresArtifactStore(worker,secondRoot),resumeAt=Date.parse(checkpoint!.leaseExpiresAt!)+1;
    const done=await processNextJob(resumedStore,secondRoot,{...context,artifacts:secondMedia,graphics:{chromePath:"missing-on-purpose"},workerId:"graphics-fresh",now:()=>resumeAt});expect(done?.failureReason??done?.cancelReason).toBeUndefined();expect(done?.status).toBe("done");expect(done?.graphicOutput).toEqual(checkpoint!.graphicCheckpoint);expect(done?.costUsd).toBe(0);
    await expect(store.completeGraphic(input.id,"graphics-first",done!.graphicOutput!)).rejects.toBeInstanceOf(LeaseError);
    const counts=await admin.sql`select (select count(*) from hv_provider_attempts where job_id=${input.id}) as attempts,(select count(*) from hv_cost_events where job_id=${input.id}) as costs,(select count(*) from hv_reservations where job_id=${input.id}) as holds`;expect(Number(counts[0].attempts)).toBe(0);expect(Number(counts[0].costs)).toBe(0);expect(Number(counts[0].holds)).toBe(0);
    const snapshot=await exportStateSnapshot(admin,id);expect(snapshot.schema).toBe("hv-state/5");expect(()=>validateSnapshot({...snapshot,schema:"hv-state/4"})).toThrow("schema 5");
    const archive=join(root,"graphics.zip");const exported=await exportProjectArchive(admin,id,join(root,"prepared"),archive);expect(exported.jobs).toBe(1);
    if(!/^hv_graphics_[a-f0-9]{32}$/.test(name))throw new Error("Unsafe fixture database");await admin.sql.unsafe('CREATE DATABASE "'+name+'"');created=true;const target=new URL(process.env.HV_PG_ADMIN_URL!);target.pathname="/"+name;restored=new StudioDatabase(target.href);await restored.migrate();
    process.env.HV_S3_BUCKET=process.env.HV_S3_FLEET_TEST_BUCKET;const imported=await importProjectArchive(restored,archive,join(root,"unpacked"),500);expect(imported.jobs).toBe(1);process.env.HV_S3_BUCKET=sourceBucket;
    const restoredProject=(await new PostgresProjectService(restored).peekProject(id))!,restoredJob=(await new PostgresJobStore(restored).forProject(id).get(input.id))!,thirdRoot=join(root,"independent"),thirdMedia=new PostgresArtifactStore(restored,thirdRoot,destinationClient);
    expect(restoredProject.graphicLibrary).toEqual(project.graphicLibrary);expect(restoredJob.graphicOutput).toEqual(done!.graphicOutput);await thirdMedia.restoreCheckpoint(restoredJob);await verifyGraphicMedia(restoredJob,restoredJob.graphicOutput!,thirdRoot);assertGraphicPermission(restoredJob.graphicRender!,restoredProject);
    const disabled=await projects.saveGraphic(owner.token,{kind:"availability",id:saved.id,available:false},1);expect(disabled!.version).toBe(2);expect(()=>assertGraphicPermission(graphicRender,{...project,graphicLibrary:disabled!})).toThrow("permission");assertGraphicPermission(restoredJob.graphicRender!,restoredProject);
  }finally{
    process.env.HV_S3_BUCKET=sourceBucket;if(id){for(const client of [sourceClient,destinationClient]){for(let i=0;i<10;i++){const objects=(await client.list({prefix:`v1/${id}/`,maxKeys:1000})).contents??[];if(!objects.length)break;for(const object of objects)await client.file(ownedKey(object.key,id)).delete();}}for(const table of ["hv_outbox","hv_artifacts","hv_archives","hv_reviews","hv_operator_reviews","hv_cost_events","hv_provider_attempts","hv_jobs","hv_projects"])await admin.sql.unsafe('delete from "'+table+'" where '+(table==="hv_projects"?'id':'project_id')+'=$1',[id]);}
    await restored?.close();await worker.close();if(created)await admin.sql.unsafe('DROP DATABASE "'+ownedDatabase(name)+'" WITH (FORCE)');await admin.close();if(secret===undefined)delete process.env.HV_TOKEN_SECRET;else process.env.HV_TOKEN_SECRET=secret;
    cleanup(root);
  }
},180000);
