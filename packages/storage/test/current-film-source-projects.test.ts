import {expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {existsSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {currentFilmSourceFixture} from "../../planner/test/current-film-source.fixture";
import {bindOriginalEditSource,bindRetainedEditSource,assertEditBindingAvailable,assertEditPermission,createEditPlan,editRenderReview} from "../../planner/src/edit-jobs";
import {editHistoryState} from "../../planner/src/edit-history";
import {compileEditScriptSource} from "../../planner/src/edit-script-source";
import {contentHash} from "../../generator/src/capabilities";
import {soundRuntimeRevision} from "../../generator/src/sound-audio";
import {verifyEditMedia} from "../../generator/src/edit-media";
import type {PersistedProject} from "../../api/src/index";
import type {JobInput} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {StudioDatabase} from "../src/database";
import {PostgresProjectService} from "../src/projects";
import {PostgresJobStore} from "../src/jobs";
import {PostgresCostLedger} from "../src/ledger";
import {PostgresReviewQueue} from "../src/reviews";
import {PostgresArtifactStore,objectClient} from "../src/artifacts";
import {exportProjectArchive,importProjectArchive} from "../src/archives";
import {exportStateSnapshot,importStateSnapshot,readStateSnapshot,validateSnapshot,type StateSnapshot} from "../src/snapshots";

const enabled=Boolean(process.env.HV_PG_ADMIN_URL&&process.env.HV_API_DATABASE_URL&&process.env.HV_WORKER_DATABASE_URL&&process.env.HV_S3_ENDPOINT&&process.env.HV_S3_BUCKET&&process.env.HV_S3_FLEET_TEST_BUCKET);
function databaseName(name:string):string {if(!/^hv_current_source_[a-f0-9]{32}$/.test(name))throw new Error("Unsafe current-source fixture database");return name;}
function databaseUrl(value:string,name:string):string {const url=new URL(value);url.pathname="/"+databaseName(name);return url.href;}
function files(root:string):string[] {return readdirSync(root,{withFileTypes:true}).flatMap(entry=>{
  if(entry.isSymbolicLink())throw new Error("Source fixture media cannot contain links");const path=join(root,entry.name);
  if(entry.isDirectory())return files(path);if(!entry.isFile())throw new Error("Source fixture media must be regular files");return [path];
});}
function removeOwned(path:string,root:string):void {if(!existsSync(path))return;const actual=realpathSync(path);
  if(actual!==path||!actual.startsWith(realpathSync(root)+sep))throw new Error("Unsafe current-source fixture media removal");rmSync(actual,{recursive:true,force:true});
}
function cleanup(root:string):void {if(!root.startsWith(realpathSync(tmpdir())+sep+"hv-current-source-pg-")||realpathSync(root)!==root)throw new Error("Unsafe current-source fixture cleanup");rmSync(root,{recursive:true,force:true});}
async function clearObjects(client:ReturnType<typeof objectClient>,projectId:string,jobId?:string):Promise<void> {
  if(!/^[A-Za-z0-9_-]+$/.test(projectId)||jobId!==undefined&&!/^[A-Za-z0-9_-]+$/.test(jobId))throw new Error("Unsafe current-source object scope");
  const prefix="v1/"+projectId+"/"+(jobId?jobId+"/":"");
  for(let page=0;page<100;page++){const entries=(await client.list({prefix,maxKeys:1000})).contents??[];if(!entries.length)return;
    for(const entry of entries){if(!entry.key.startsWith(prefix))throw new Error("Source object escaped its fixture");await client.file(entry.key).delete();}}
  throw new Error("Source object cleanup exceeded its bound");
}

(enabled?test:test.skip)("PostgreSQL editorial carrier restores exact V2 sources in an independent database and bucket after both originals are gone",async()=>{
  const root=realpathSync(mkdtempSync(join(realpathSync(tmpdir()),"hv-current-source-pg-"))),sourceName=databaseName("hv_current_source_"+crypto.randomUUID().replaceAll("-","")),restoreName=databaseName("hv_current_source_"+crypto.randomUUID().replaceAll("-",""));
  const control=new StudioDatabase(process.env.HV_PG_ADMIN_URL!),created=new Set<string>(),bucket=process.env.HV_S3_BUCKET;
  const sourceClient=objectClient(),destinationClient=objectClient({...process.env,HV_S3_BUCKET:process.env.HV_S3_FLEET_TEST_BUCKET});
  let fixture:Awaited<ReturnType<typeof currentFilmSourceFixture>>|undefined,admin:StudioDatabase|undefined,api:StudioDatabase|undefined,worker:StudioDatabase|undefined,restored:StudioDatabase|undefined,projectId:string|undefined;
  try{
    expect(bucket).not.toBe(process.env.HV_S3_FLEET_TEST_BUCKET);fixture=await currentFilmSourceFixture();const f=fixture;projectId=f.job.projectId;
    const origin=f.project.currentScreenplay!.origin!.request.source,originals=[f.studio.film,f.job],bindings=[bindOriginalEditSource(f.receipt),bindOriginalEditSource(origin)];
    const sourceIndex=compileEditScriptSource(f.receipt),originalBytes=new Map(f.receipt.files.map(file=>[file.path,readFileSync(join(f.studio.paths.artifactRoot,file.path))]));
    expect(f.receipt.schema).toBe("hv-edit-source/3");expect(f.job.currentFilmCheckpoint!.rows.every(row=>Boolean(row.capture))).toBe(true);
    const native=f.job.output!.currentFilm!.records.find(row=>row.record.files.audio)!.record.files.audio!;
    expect(native).toBeDefined();expect(f.receipt.audio.dialogue).toEqual({kind:"current-film-dialogue"});

    await control.sql.unsafe('CREATE DATABASE "'+sourceName+'"');created.add(sourceName);
    admin=new StudioDatabase(databaseUrl(process.env.HV_PG_ADMIN_URL!,sourceName));await admin.migrate();
    const initial:StateSnapshot={schema:"hv-state/12",projects:f.projects.snapshot(),jobs:originals,ledger:JSON.parse(readFileSync(f.studio.paths.costLedgerPath,"utf8")),reviews:[]};
    validateSnapshot(initial);await importStateSnapshot(admin,initial,500);
    const importedMedia=new PostgresArtifactStore(admin,f.studio.paths.artifactRoot,sourceClient);
    for(const original of originals)expect((await importedMedia.importCompletedJob(original,files(join(f.studio.paths.artifactRoot,projectId,original.id)))).files).toBeGreaterThan(0);
    api=new StudioDatabase(databaseUrl(process.env.HV_API_DATABASE_URL!,sourceName));worker=new StudioDatabase(databaseUrl(process.env.HV_WORKER_DATABASE_URL!,sourceName));
    const projects=new PostgresProjectService(api),ledger=new PostgresCostLedger(worker),store=new PostgresJobStore(worker).forProject(projectId),firstRoot=join(root,"carrier"),media=new PostgresArtifactStore(worker,firstRoot,sourceClient);
    let library=(await projects.createEditSequence(f.studio.owner.token,[f.receipt,origin],"source-carrier","Canonical retained source",f.job.id,320,180,0,Date.now(),bindings))!;
    library=(await projects.changeEditSequence(f.studio.owner.token,"source-carrier",{kind:"edit",label:"One second with full original handles",operation:{kind:"trim",clipId:"initial-0",linked:true,edge:"out",delta:30-f.receipt.facts.frames,ripple:true}},library.version,library.sequences[0]!.history.revision))!;
    const sequence=library.sequences[0]!,timeline=editHistoryState(sequence.history).timeline,ordered=sequence.sourceRevisions.map(revision=>bindings.find(binding=>binding.source.revision===revision)!);
    expect(timeline.frames).toBe(30);
    const pictureEdit=createEditPlan(sequence,ordered,soundRuntimeRevision(),"s3",contentHash("current-source-pg-carrier"),editRenderReview(timeline)),firstSource=ordered[0]!.source.job;
    const input:JobInput={id:crypto.randomUUID(),projectId,idempotencyKey:crypto.randomUUID(),tier:"free",stage:"picture-edit",scriptVersion:firstSource.scriptVersion,scriptText:firstSource.scriptText,rightsAttestedAt:f.project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:30,costCapUsd:0,budgetReservedUsd:0,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:180000,pictureEdit};
    const providerCounts=await admin.sql`select (select count(*) from hv_provider_attempts where project_id=${projectId}) as attempts,(select count(*) from hv_cost_events where project_id=${projectId}) as costs`;
    const admitted=await ledger.admit(projectId,input,500),carrier=(await processNextJob(store,firstRoot,{projects,ledger,reviewQueue:new PostgresReviewQueue(worker),artifacts:media,workerId:"current-source-carrier"}))!;
    expect(carrier.id).toBe(admitted.id);expect(carrier.failureReason??carrier.cancelReason).toBeUndefined();expect(carrier.status).toBe("done");expect(carrier.timeoutMs).toBe(180000);
    expect(carrier.output).toEqual(carrier.editCheckpoint);expect(carrier.output!.editorial!.conform.pictureFrames).toHaveLength(30);expect(carrier.costUsd).toBe(0);
    expect(await admin.sql`select (select count(*) from hv_provider_attempts where project_id=${projectId}) as attempts,(select count(*) from hv_cost_events where project_id=${projectId}) as costs`).toEqual(providerCounts);
    await media.restoreCheckpoint(carrier);const retained=bindRetainedEditSource(carrier,f.receipt.revision),carrierBytes=readFileSync(join(firstRoot,carrier.output!.mp4Path));
    assertEditBindingAvailable(retained,carrier);expect(retained.source).toEqual(f.receipt);expect(compileEditScriptSource(retained.source)).toEqual(sourceIndex);
    expect(existsSync(join(firstRoot,projectId,f.job.id))).toBe(false);
    // Accept the real saved structural proposal after rendering. The original source
    // remains tied to its physical identities while the project's current head advances.
    const accepted=(await projects.acceptCurrentScreenplayProposal(f.studio.owner.token,{id:"accept-source-pg",proposalRevision:f.saved.proposal.revision,expectedHeadRevision:f.saved.library.headRevision!},f.saved.library.version))!;
    expect(accepted.library.headRevision).not.toBe(f.job.currentFilm!.baseline.headRevision);

    // Neither original Job nor original directory/object is available to archive export.
    for(const original of originals){await clearObjects(sourceClient,projectId,original.id);
      await admin.sql`delete from hv_outbox where job_id=${original.id}`;await admin.sql`delete from hv_artifacts where job_id=${original.id}`;await admin.sql`delete from hv_jobs where id=${original.id}`;
      removeOwned(join(f.studio.paths.artifactRoot,projectId,original.id),f.studio.root);
      expect(await store.get(original.id)).toBeUndefined();expect((await sourceClient.list({prefix:"v1/"+projectId+"/"+original.id+"/",maxKeys:1})).contents??[]).toHaveLength(0);
    }
    const snapshot=await exportStateSnapshot(admin,projectId);expect(snapshot.schema).toBe("hv-state/13");expect(snapshot.jobs.map(job=>job.id)).toEqual([carrier.id]);
    expect(()=>validateSnapshot({...snapshot,schema:"hv-state/12"})).toThrow("schema 13");
    const archive=join(root,"retained-current-source.zip"),prepared=join(root,"prepared"),unpacked=join(root,"unpacked"),exported=await exportProjectArchive(admin,projectId,prepared,archive);
    expect(exported.jobs).toBe(1);expect(readStateSnapshot(prepared)).toEqual(snapshot);
    for(const original of originals)expect(existsSync(join(prepared,"artifacts",projectId,original.id))).toBe(false);
    await control.sql.unsafe('CREATE DATABASE "'+restoreName+'"');created.add(restoreName);restored=new StudioDatabase(databaseUrl(process.env.HV_PG_ADMIN_URL!,restoreName));await restored.migrate();
    try{process.env.HV_S3_BUCKET=process.env.HV_S3_FLEET_TEST_BUCKET;const result=await importProjectArchive(restored,archive,unpacked,500);
      expect(result.jobs).toBe(1);expect(result.archiveSha256).toBe(exported.archiveSha256);expect(result.mediaFiles).toBe(carrier.output!.editorial!.files.length);
    }finally{process.env.HV_S3_BUCKET=bucket;}
    expect(readStateSnapshot(unpacked)).toEqual(snapshot);expect(readFileSync(join(prepared,"state/projects.json"))).toEqual(readFileSync(join(unpacked,"state/projects.json")));
    // Remove every source-side service and all extracted media before reading the new bucket.
    await clearObjects(sourceClient,projectId);await api.close();api=undefined;await worker.close();worker=undefined;await admin.close();admin=undefined;
    await control.sql.unsafe('DROP DATABASE "'+sourceName+'" WITH (FORCE)');created.delete(sourceName);
    for(const path of [firstRoot,join(prepared,"artifacts"),join(unpacked,"artifacts")])removeOwned(path,root);
    const independentRoot=join(root,"independent"),independent=new PostgresArtifactStore(restored,independentRoot,destinationClient),restoredStore=new PostgresJobStore(restored).forProject(projectId),restoredProjects=new PostgresProjectService(restored),restoredJob=(await restoredStore.get(carrier.id))!;
    expect(restoredJob.output).toEqual(carrier.output);for(const original of originals)expect(await restoredStore.get(original.id)).toBeUndefined();
    await independent.restoreCheckpoint(restoredJob);await verifyEditMedia(restoredJob,restoredJob.output!,independentRoot,async()=>{});
    expect(readFileSync(join(independentRoot,restoredJob.output!.mp4Path))).toEqual(carrierBytes);
    const restoredBinding=bindRetainedEditSource(restoredJob,f.receipt.revision);assertEditBindingAvailable(restoredBinding,restoredJob);expect(restoredBinding).toEqual(retained);
    expect(compileEditScriptSource(restoredBinding.source)).toEqual(sourceIndex);
    for(const [i,file]of restoredBinding.files.entries()){expect(await independent.fileInfo(projectId,carrier.id,file.path)).toEqual(file);expect(readFileSync(join(independentRoot,file.path))).toEqual(originalBytes.get(f.receipt.files[i]!.path)!);}
    for(const file of restoredJob.output!.editorial!.files){const bytes=readFileSync(join(independentRoot,file.path));expect(bytes.length).toBe(file.bytes);expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.sha256);}
    for(const original of originals)expect(existsSync(join(independentRoot,projectId,original.id))).toBe(false);

    // Warm historical validation never grants fresh use after current project rights change.
    const retainedBindings=sequence.sourceRevisions.map(revision=>bindRetainedEditSource(restoredJob,revision)),nextPlan=createEditPlan(sequence,retainedBindings,soundRuntimeRevision(),"s3",contentHash("current-source-pg-continued"),editRenderReview(timeline));
    const row=(await restored.sql`select body,version from hv_projects where id=${projectId}`)[0],saved=row.body as PersistedProject;
    assertEditPermission(nextPlan,await restoredProjects.peekProject(projectId));
    const counts=()=>restored!.sql`select (select count(*) from hv_jobs) as jobs,(select count(*) from hv_reservations) as holds,(select count(*) from hv_provider_attempts) as attempts,(select count(*) from hv_cost_events) as costs,(select count(*) from hv_outbox) as events`,before=await counts();
    await restored.sql`update hv_projects set body=${{...saved,rightsAttestedAt:null}}::jsonb where id=${projectId}`;
    try{await expect(new PostgresCostLedger(restored).admit(projectId,{...input,id:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),pictureEdit:nextPlan},500)).rejects.toThrow(/rights|permission/);expect(await counts()).toEqual(before);
    }finally{await restored.sql`update hv_projects set body=${saved}::jsonb where id=${projectId}`;}
    expect((await restored.sql`select body,version from hv_projects where id=${projectId}`)[0]).toEqual(row);
    // Corrupt native source PCM in the bucket, keeping every database receipt unchanged.
    const nativeCopy=restoredBinding.files[f.receipt.files.findIndex(file=>file.path===native.path)]!,objectRow=(await restored.sql`select object_key from hv_artifacts where key=${nativeCopy.path} and project_id=${projectId} and job_id=${carrier.id}`)[0];
    const object=destinationClient.file(String(objectRow.object_key)),nativeBytes=readFileSync(join(independentRoot,nativeCopy.path)),corrupt=Buffer.from(nativeBytes);corrupt[48]^=1;
    try{await object.write(corrupt);await expect(new PostgresArtifactStore(restored,join(root,"corrupt"),destinationClient).restoreCheckpoint(restoredJob)).rejects.toThrow(/checksum|corrupt|changed/);
      await object.delete();await expect(new PostgresArtifactStore(restored,join(root,"missing"),destinationClient).restoreCheckpoint(restoredJob)).rejects.toThrow();
    }finally{await object.write(nativeBytes);}
    expect(await counts()).toEqual(before);expect((await restoredStore.get(carrier.id))!.output).toEqual(carrier.output);
    await new PostgresArtifactStore(restored,join(root,"repaired"),destinationClient).restoreCheckpoint(restoredJob);expect((await exportStateSnapshot(restored,projectId)).schema).toBe("hv-state/13");
  }finally{
    if(bucket===undefined)delete process.env.HV_S3_BUCKET;else process.env.HV_S3_BUCKET=bucket;
    if(projectId)for(const client of [sourceClient,destinationClient])await clearObjects(client,projectId);
    await api?.close();await worker?.close();await admin?.close();await restored?.close();for(const name of created)await control.sql.unsafe('DROP DATABASE "'+databaseName(name)+'" WITH (FORCE)');await control.close();await fixture?.close();cleanup(root);
  }
},480000);
