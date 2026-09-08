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
import type {JobInput} from "../../queue/src/index";
import {defaultMotionGraphic,motionGraphic} from "../../planner/src/motion-graphics";
import {currentGraphics} from "../../planner/src/graphic-library";
import {graphicJobPlan} from "../../planner/src/graphic-jobs";
import {contentHash} from "../../generator/src/capabilities";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {verifyGraphicMedia} from "../../generator/src/graphic-media";
import {graphicDecodedHashes} from "../../generator/src/graphic-render";
import {soundProcessingCommand} from "../../generator/src/sound-finishing";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {editHistoryState} from "../../planner/src/edit-history";
import type {EditAssemblyCarrier} from "../../planner/src/edit-assembly-parent";

const enabled=Boolean(process.env.HV_GRAPHICS_CHROME_PATH&&process.env.HV_PG_ADMIN_URL&&process.env.HV_API_DATABASE_URL&&process.env.HV_WORKER_DATABASE_URL&&process.env.HV_S3_ENDPOINT&&process.env.HV_S3_BUCKET&&process.env.HV_S3_FLEET_TEST_BUCKET);
function cleanup(root:string){if(!root.startsWith(realpathSync(tmpdir())+sep)||realpathSync(root)!==root)throw new Error("Unsafe assembly fixture cleanup");rmSync(root,{recursive:true,force:true});}
function ownedKey(key:string,prefix:string):string {if(!key.startsWith(prefix))throw new Error("Assembly fixture object escaped its project");return key;}
function ownedDatabase(name:string):string {if(!/^hv_assemblies_[a-f0-9]{32}$/.test(name))throw new Error("Unsafe assembly fixture database");return name;}
async function clearObjects(client:ReturnType<typeof objectClient>,id:string):Promise<void>{
  const prefix=`v1/${id}/`;for(let page=0;page<100;page++){const objects=(await client.list({prefix,maxKeys:1000})).contents??[];if(!objects.length)return;for(const object of objects)await client.file(ownedKey(object.key,prefix)).delete();}throw new Error("Assembly fixture object cleanup exceeded its bound");
}
(enabled?test:test.skip)("PostgreSQL assembly proposals serialize acceptance, recheck carriers, and restore independent S3 archives",async()=>{
  const priorSecret=process.env.HV_TOKEN_SECRET,sourceBucket=process.env.HV_S3_BUCKET;process.env.HV_TOKEN_SECRET="assembly-storage-fixture-secret-at-least-thirty-two-characters";
  const root=realpathSync(mkdtempSync(join(realpathSync(tmpdir()),"hv-assembly-pg-"))),name=ownedDatabase("hv_assemblies_"+crypto.randomUUID().replaceAll("-","")),admin=new StudioDatabase(process.env.HV_PG_ADMIN_URL!),api=new StudioDatabase(process.env.HV_API_DATABASE_URL!),worker=new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!),client=objectClient(),destinationClient=objectClient({...process.env,HV_S3_BUCKET:process.env.HV_S3_FLEET_TEST_BUCKET}),ids:string[]=[];
  let restored:StudioDatabase|undefined,createdDatabase=false;
  try{
    expect(process.env.HV_S3_FLEET_TEST_BUCKET).not.toBe(sourceBucket);
    await admin.migrate();const projects=new PostgresProjectService(api),owner=await projects.createAnonymousProject();ids.push(owner.projectId);await projects.attestRights(owner.token);
    const {revision:_revision,...defaults}=defaultMotionGraphic("lower-third",320,180),plan=motionGraphic({...defaults,text:"Retained title",secondary:"Assembly source",frames:4,enterFrames:1,exitFrames:1}),graphicId=crypto.randomUUID();await projects.saveGraphic(owner.token,{kind:"save",id:graphicId,label:"Opening",plan},0);
    const project=(await projects.peekProject(owner.projectId))!,spec=currentGraphics(project.graphicLibrary,project.id)[0]!.spec,graphicRender=graphicJobPlan(spec,"s3",contentHash("assembly-source")),input:JobInput={id:crypto.randomUUID(),projectId:project.id,idempotencyKey:crypto.randomUUID(),tier:"free",stage:"motion-graphic",scriptVersion:0,scriptText:"",rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:4,costCapUsd:0,budgetReservedUsd:0,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:120000,graphicRender},ledger=new PostgresCostLedger(worker);
    const admitted=await ledger.admit(project.id,input,500),store=new PostgresJobStore(worker).forProject(project.id),mediaRoot=join(root,"source"),media=new PostgresArtifactStore(worker,mediaRoot),done=(await processNextJob(store,mediaRoot,{projects,ledger,reviewQueue:new PostgresReviewQueue(worker),artifacts:media,workerId:"assembly-source"}))!;expect(done.id).toBe(admitted.id);expect(done.failureReason??done.cancelReason).toBeUndefined();expect(done.status).toBe("done");
    const source=await inspectEditSource(done,spec.label,mediaRoot,async()=>{},undefined,media,path=>media.fileInfo(project.id,done.id,path)),binding=bindOriginalEditSource(source),sequenceId="parent",editorial=(await projects.createEditSequence(owner.token,[source],sequenceId,"Parent graphic",source.facts.id,320,180,0,Date.now(),[binding]))!,history=editorial.sequences[0]!.history.revision,carriers:EditAssemblyCarrier[]=[{binding,current:done}],proposal={id:"proposal",label:"Trailer",purpose:"trailer" as const,ranges:[{id:"selected",fromFrame:1,toFrame:4,reason:"Retain the title."}]};
    const row=async()=>{const current=(await admin.sql`select body,version from hv_projects where id=${project.id}`)[0];return {body:current.body,version:Number(current.version)};};
    const concurrentCreates=await Promise.allSettled([projects.createAssemblyProposal(owner.token,sequenceId,proposal,{libraryVersion:0,historyRevision:history},carriers),projects.createAssemblyProposal(owner.token,sequenceId,proposal,{libraryVersion:0,historyRevision:history},carriers)]);expect(concurrentCreates.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(concurrentCreates.filter(r=>r.status==="rejected")).toHaveLength(1);
    const created=(await projects.peekProject(project.id))!.assemblyLibrary,original=created.proposals[0]!,revisionInput={label:"Revised trailer",purpose:"trailer" as const,ranges:[{...proposal.ranges[0]!,fromFrame:0}]},expected={libraryVersion:1,historyRevision:history,proposalRevision:original.revision};
    const concurrentRevisions=await Promise.allSettled([projects.reviseAssemblyProposal(owner.token,original.id,revisionInput,expected,carriers),projects.reviseAssemblyProposal(owner.token,original.id,{...revisionInput,label:"Another revision"},expected,carriers)]);expect(concurrentRevisions.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(concurrentRevisions.filter(r=>r.status==="rejected")).toHaveLength(1);
    const revised=(await projects.peekProject(project.id))!.assemblyLibrary,reviewed=revised.proposals[0]!,acceptExpected={libraryVersion:2,historyRevision:history},accepted=await Promise.all([projects.acceptAssemblyProposal(owner.token,reviewed.id,reviewed.revision,"assembly",acceptExpected,carriers),projects.acceptAssemblyProposal(owner.token,reviewed.id,reviewed.revision,"assembly",acceptExpected,carriers)]);expect(accepted.map(r=>r!.replayed).sort()).toEqual([false,true]);expect(accepted[0]!.assembly).toEqual(accepted[1]!.assembly);expect(accepted[0]!.library.version).toBe(3);
    const unchanged=await row();await projects.acceptAssemblyProposal(owner.token,reviewed.id,reviewed.revision,"assembly",acceptExpected,carriers);expect(await row()).toEqual(unchanged);await expect(projects.acceptAssemblyProposal(owner.token,reviewed.id,reviewed.revision,"different",{libraryVersion:3,historyRevision:history},carriers)).rejects.toThrow();expect(await row()).toEqual(unchanged);
    // The archive must retain an accepted older proposal revision independently of the current proposal.
    const later=(await projects.reviseAssemblyProposal(owner.token,reviewed.id,{label:"Later proposal",purpose:"custom",ranges:[{id:"middle",fromFrame:1,toFrame:3,reason:"Review a shorter title."}]},{libraryVersion:3,historyRevision:history,proposalRevision:reviewed.revision},carriers))!;
    expect(later.proposals[0]!.revision).not.toBe(later.assemblies[0]!.proposalRevision);expect(later.assemblies[0]!).toEqual(accepted[0]!.assembly);
    const changed=await projects.changeEditSequence(owner.token,sequenceId,{kind:"edit",label:"Parent edit after acceptance",operation:{kind:"marker",marker:{id:"mark",frame:0,label:"New marker"}}},editorial.version,history);expect(changed).not.toBeNull();const afterParent=await row();expect((await projects.acceptAssemblyProposal(owner.token,reviewed.id,reviewed.revision,"assembly",acceptExpected,carriers))!.replayed).toBe(true);expect(await row()).toEqual(afterParent);
    // A caller's stale healthy Job cannot override current storage metadata, including on an exact retry.
    await admin.sql`update hv_jobs set body=${{...done,status:"cancelled"}}::jsonb,status='cancelled' where id=${done.id}`;
    await expect(projects.acceptAssemblyProposal(owner.token,reviewed.id,reviewed.revision,"assembly",acceptExpected,carriers)).rejects.toThrow("carrier changed");expect(await row()).toEqual(afterParent);await admin.sql`update hv_jobs set body=${done}::jsonb,status='done' where id=${done.id}`;
    const file=binding.files[0]!;await admin.sql`update hv_artifacts set bytes=bytes+1 where project_id=${project.id} and job_id=${done.id} and key=${file.path}`;
    await expect(projects.acceptAssemblyProposal(owner.token,reviewed.id,reviewed.revision,"assembly",acceptExpected,carriers)).rejects.toThrow("artifact changed");expect(await row()).toEqual(afterParent);await admin.sql`update hv_artifacts set bytes=${file.bytes} where project_id=${project.id} and job_id=${done.id} and key=${file.path}`;
    expect((await projects.acceptAssemblyProposal(owner.token,reviewed.id,reviewed.revision,"assembly",acceptExpected,[{binding,current:undefined}]))!.replayed).toBe(true);expect(await row()).toEqual(afterParent);
    const other=await projects.createAnonymousProject();ids.push(other.projectId);const otherBefore=(await projects.peekProject(other.projectId))!.assemblyLibrary;await expect(projects.createAssemblyProposal(other.token,sequenceId,proposal,{libraryVersion:0,historyRevision:history},carriers)).rejects.toThrow("from this project");expect((await projects.peekProject(other.projectId))!.assemblyLibrary).toEqual(otherBefore);
    const archiveProject=(await projects.peekProject(project.id))!,snapshot=await exportStateSnapshot(admin,project.id);
    expect(snapshot.schema).toBe("hv-state/7");expect(snapshot.jobs).toHaveLength(1);expect(snapshot.jobs[0]!.stage).toBe("motion-graphic");expect(()=>validateSnapshot({...snapshot,schema:"hv-state/6"})).toThrow("schema 7");
    const frozen=archiveProject.assemblyLibrary.assemblies[0]!.plan.parent;expect(frozen.historyRevision).toBe(history);expect(archiveProject.editLibrary.sequences[0]!.history.revision).not.toBe(history);expect(frozen.timeline.revision).not.toBe(editHistoryState(archiveProject.editLibrary.sequences[0]!.history).timeline.revision);
    await media.restoreCheckpoint(done);const expectedBytes=new Map(done.graphicOutput!.files.map(file=>[file.path,readFileSync(join(mediaRoot,file.path))])),archive=join(root,"assemblies.zip"),prepared=join(root,"prepared"),unpacked=join(root,"unpacked");
    const exported=await exportProjectArchive(admin,project.id,prepared,archive);expect(exported.jobs).toBe(1);expect(exported.bytes).toBeGreaterThan(0);expect(readStateSnapshot(prepared)).toEqual(snapshot);
    await admin.sql.unsafe('CREATE DATABASE "'+ownedDatabase(name)+'"');createdDatabase=true;const target=new URL(process.env.HV_PG_ADMIN_URL!);target.pathname="/"+name;restored=new StudioDatabase(target.href);await restored.migrate();
    let imported:Awaited<ReturnType<typeof importProjectArchive>>;
    try{process.env.HV_S3_BUCKET=process.env.HV_S3_FLEET_TEST_BUCKET;imported=await importProjectArchive(restored,archive,unpacked,500);}finally{process.env.HV_S3_BUCKET=sourceBucket;}
    expect(imported.jobs).toBe(1);expect(imported.archiveSha256).toBe(exported.archiveSha256);expect(imported.mediaFiles).toBe(done.graphicOutput!.files.length);expect(imported.mediaBytes).toBe(done.graphicOutput!.files.reduce((sum,file)=>sum+file.bytes,0));expect(readStateSnapshot(unpacked)).toEqual(snapshot);
    const restoredProjects=new PostgresProjectService(restored),restoredProject=(await restoredProjects.authorize(owner.token))!,restoredJob=(await new PostgresJobStore(restored).forProject(project.id).get(done.id))!;
    expect(restoredProject.id).toBe(project.id);expect(restoredProject.assemblyLibrary).toEqual(archiveProject.assemblyLibrary);expect(restoredProject.editLibrary).toEqual(archiveProject.editLibrary);expect(restoredProject.graphicLibrary).toEqual(archiveProject.graphicLibrary);expect(restoredJob.graphicOutput).toEqual(done.graphicOutput);expect(restoredJob.status).toBe("done");expect((await exportStateSnapshot(restored,project.id)).schema).toBe("hv-state/7");
    for(const item of [...restoredProject.assemblyLibrary.proposals,...restoredProject.assemblyLibrary.assemblies]){
      expect(item.plan.parent.sourceReceipts).toEqual([{sourceId:source.facts.id,receiptRevision:source.revision}]);const receipt=restoredProject.editLibrary.sources.find(candidate=>candidate.revision===item.plan.parent.sourceReceipts[0]!.receiptRevision)!;expect(receipt).toEqual(source);expect(receipt.job.projectId).toBe(restoredProject.id);expect(item.plan.parent.timeline.sources).toEqual([receipt.facts]);
    }
    // A fresh reader has neither the source bucket nor any pre-existing local cache to fall back to.
    expect((await client.list({prefix:`v1/${project.id}/`,maxKeys:1000})).contents!.length).toBeGreaterThan(0);await clearObjects(client,project.id);expect((await client.list({prefix:`v1/${project.id}/`,maxKeys:1})).contents??[]).toHaveLength(0);
    const independentRoot=join(root,"independent");expect(existsSync(independentRoot)).toBe(false);const independentMedia=new PostgresArtifactStore(restored,independentRoot,destinationClient);await independentMedia.restoreCheckpoint(restoredJob);await verifyGraphicMedia(restoredJob,restoredJob.graphicOutput!,independentRoot);
    for(const file of done.graphicOutput!.files){expect(await independentMedia.fileInfo(project.id,done.id,file.path)).toEqual(file);expect(readFileSync(join(independentRoot,file.path))).toEqual(expectedBytes.get(file.path)!);}
    const decoded=join(independentRoot,"decoded-rgba.txt");await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-threads","1","-i",join(independentRoot,restoredJob.graphicOutput!.masterPath),"-map","0:v:0","-an","-c:v","rawvideo","-threads","1","-pix_fmt","rgba","-fps_mode","passthrough","-f","framehash",decoded],independentRoot,async()=>{});expect(graphicDecodedHashes(readFileSync(decoded,"utf8"),plan)).toEqual(done.graphicOutput!.report.frames.map(frame=>frame.rgbaSha256));
    const reinspected=await inspectEditSource(restoredJob,source.facts.label,independentRoot,async()=>{},undefined,independentMedia,path=>independentMedia.fileInfo(project.id,done.id,path));expect(reinspected.facts).toEqual(source.facts);expect(reinspected.files).toEqual(source.files);expect(reinspected.facts.media).toBe("graphic-rgba");
    await projects.saveGraphic(owner.token,{kind:"availability",id:spec.id,available:false},project.graphicLibrary.version);const revoked=await row();await expect(projects.acceptAssemblyProposal(owner.token,reviewed.id,reviewed.revision,"assembly",acceptExpected,carriers)).rejects.toThrow("permission");expect(await row()).toEqual(revoked);
    const restoredBefore=(await restored.sql`select body,version from hv_projects where id=${project.id}`)[0],restoredRetry=await restoredProjects.acceptAssemblyProposal(owner.token,reviewed.id,reviewed.revision,"assembly",acceptExpected,[{binding:bindOriginalEditSource(restoredProject.editLibrary.sources[0]!),current:restoredJob}]);expect(restoredRetry!.replayed).toBe(true);expect(restoredRetry!.assembly).toEqual(accepted[0]!.assembly);expect((await restored.sql`select body,version from hv_projects where id=${project.id}`)[0]).toEqual(restoredBefore);
    const counts=(await admin.sql`select (select count(*) from hv_jobs where project_id=${project.id}) as jobs,(select count(*) from hv_cost_events where project_id=${project.id}) as costs,(select count(*) from hv_provider_attempts where project_id=${project.id}) as attempts,(select count(*) from hv_reservations where job_id=${done.id}) as holds`)[0];expect([Number(counts.jobs),Number(counts.costs),Number(counts.attempts),Number(counts.holds)]).toEqual([1,0,0,0]);
  }finally{
    if(sourceBucket===undefined)delete process.env.HV_S3_BUCKET;else process.env.HV_S3_BUCKET=sourceBucket;
    for(const id of ids){for(const objects of [client,destinationClient])await clearObjects(objects,id);
      await admin.sql`delete from hv_reservations where job_id in (select id from hv_jobs where project_id=${id})`;for(const table of ["hv_outbox","hv_artifacts","hv_archives","hv_reviews","hv_operator_reviews","hv_cost_events","hv_provider_attempts","hv_jobs","hv_projects"])await admin.sql.unsafe('delete from "'+table+'" where '+(table==="hv_projects"?'id':'project_id')+'=$1',[id]);}
    await restored?.close();await api.close();await worker.close();if(createdDatabase)await admin.sql.unsafe('DROP DATABASE "'+ownedDatabase(name)+'" WITH (FORCE)');await admin.close();if(priorSecret===undefined)delete process.env.HV_TOKEN_SECRET;else process.env.HV_TOKEN_SECRET=priorSecret;cleanup(root);
  }
},180000);
