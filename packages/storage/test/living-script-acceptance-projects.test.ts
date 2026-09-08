import {expect,test} from "bun:test";
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {StudioDatabase} from "../src/database";
import {PostgresProjectService} from "../src/projects";
import {PostgresJobStore} from "../src/jobs";
import {PostgresArtifactStore,objectClient} from "../src/artifacts";
import {exportProjectArchive,importProjectArchive} from "../src/archives";
import {exportStateSnapshot,importStateSnapshot,readStateSnapshot,validateSnapshot,type StateSnapshot} from "../src/snapshots";
import type {PersistedProject} from "../../api/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {deriveEditAssemblyParent,type EditAssemblyCarrier} from "../../planner/src/edit-assembly-parent";
import {compileEditScriptSource} from "../../planner/src/edit-script-source";
import {projectEditScriptNavigation} from "../../planner/src/edit-script-projection";
import {compileLivingScriptPatch} from "../../planner/src/living-script-patch";
import {compileLivingScriptGenerationImpact} from "../../planner/src/living-script-generation";
import {compileLivingScriptSourceMap} from "../../planner/src/living-script-source-map";
import {compileLivingScriptRecut,type LivingScriptRecutInput} from "../../planner/src/living-script-recut";
import type {LivingScriptAcceptanceRequest} from "../../planner/src/living-script-acceptance";
import {currentCasting} from "../../planner/src/casting";
import {currentDirection,type DirectionSnapshot,type DirectionEntry} from "../../planner/src/direction";

const enabled=Boolean(process.env.HV_PG_ADMIN_URL&&process.env.HV_API_DATABASE_URL&&process.env.HV_S3_ENDPOINT&&process.env.HV_S3_BUCKET&&process.env.HV_S3_FLEET_TEST_BUCKET);
function databaseName(name:string):string{if(!/^hv_linked_acceptance_[a-f0-9]{32}$/.test(name))throw new Error("Unsafe linked acceptance fixture database");return name;}
function databaseUrl(value:string,name:string):string{const url=new URL(value);url.pathname="/"+databaseName(name);return url.href;}
function files(root:string):string[]{return readdirSync(root,{withFileTypes:true}).flatMap(entry=>{if(entry.isSymbolicLink())throw new Error("Fixture media cannot contain links");const path=join(root,entry.name);if(entry.isDirectory())return files(path);if(!entry.isFile())throw new Error("Fixture media must be regular files");return [path];});}
function cleanup(root:string){if(!root.startsWith(realpathSync(tmpdir())+sep+"hv-linked-pg-")||realpathSync(root)!==root)throw new Error("Unsafe linked acceptance fixture cleanup");rmSync(root,{recursive:true,force:true});}
async function clearObjects(client:ReturnType<typeof objectClient>,projectId:string):Promise<void>{const prefix="v1/"+projectId+"/";for(let page=0;page<100;page++){const entries=(await client.list({prefix,maxKeys:1000})).contents??[];if(!entries.length)return;for(const entry of entries){if(!entry.key.startsWith(prefix))throw new Error("Fixture object escaped its project");await client.file(entry.key).delete();}}throw new Error("Fixture object cleanup exceeded its bound");}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function pinDuration(studio:Awaited<ReturnType<typeof dubStudio>>):Promise<DirectionSnapshot>{const review=await(await studio.call(studio.base+"/direction","GET",undefined,studio.owner.token)).json() as {direction:DirectionSnapshot;scriptVersion:number;plan:DirectionEntry[]},entry=review.plan.find(entry=>entry.source.id==="shot-1-1")!;const saved=await studio.call(studio.base+"/direction/shot-1-1","PUT",{settings:{durationFrames:180},expectedVersion:review.direction.version,expectedScriptVersion:review.scriptVersion,sourceHash:entry.sourceHash},studio.owner.token);expect(saved.status).toBe(200);return (await saved.json() as {direction:DirectionSnapshot}).direction;}

(enabled?test:test.skip)("PostgreSQL linked acceptance atomically adopts script cut settings and ledger, fences races and restores independent schema nine media",async()=>{
  const root=realpathSync(mkdtempSync(join(realpathSync(tmpdir()),"hv-linked-pg-"))),originName=databaseName("hv_linked_acceptance_"+crypto.randomUUID().replaceAll("-","")),restoreName=databaseName("hv_linked_acceptance_"+crypto.randomUUID().replaceAll("-",""));
  const sourceBucket=process.env.HV_S3_BUCKET,control=new StudioDatabase(process.env.HV_PG_ADMIN_URL!),created:string[]=[],sourceClient=objectClient(),destinationClient=objectClient({...process.env,HV_S3_BUCKET:process.env.HV_S3_FLEET_TEST_BUCKET});
  let studio:Awaited<ReturnType<typeof dubStudio>>|undefined,admin:StudioDatabase|undefined,api:StudioDatabase|undefined,restored:StudioDatabase|undefined,projectId:string|undefined;
  try{
    expect(process.env.HV_S3_FLEET_TEST_BUCKET).not.toBe(sourceBucket);const studioRoot=join(root,"studio");mkdirSync(studioRoot);studio=await dubStudio(studioRoot);projectId=studio.owner.projectId;await pinDuration(studio);
    expect((await studio.call(studio.base+"/jobs","POST",{idempotencyKey:crypto.randomUUID(),reuseUnchanged:true},studio.owner.token)).status).toBe(202);
    const originalFilm=(await studio.worker())!;expect(originalFilm.failureReason??originalFilm.cancelReason).toBeUndefined();expect(originalFilm.status).toBe("done");const originalProjects=studio.projects.snapshot();
    const originalSource=await inspectEditSource(originalFilm,"Retained original screenplay",studio.paths.artifactRoot,async()=>{}),index=compileEditScriptSource(originalSource),entry=index.entries.find(entry=>entry.kind==="dialogue")!;
    const patch=compileLivingScriptPatch(originalSource,{entryId:entry.id,indexRevision:index.revision,currentScript:{version:originalFilm.scriptVersion,text:originalFilm.scriptText},replacement:"Welcome back to the garden.",protectedLines:[1]});
    // Only this isolated media factory commits the proposed text early. The PostgreSQL project
    // imports the true pre-patch state and must adopt every reviewed member in one transaction.
    expect((await studio.call(studio.base+"/script","PUT",{text:patch.after.text},studio.owner.token)).status).toBe(200);const candidateDirection=await pinDuration(studio),impact=compileLivingScriptGenerationImpact(originalSource,patch,{...originalFilm,scriptVersion:patch.after.version,scriptText:patch.after.text,direction:candidateDirection});
    expect((await studio.call(studio.base+"/jobs","POST",{idempotencyKey:crypto.randomUUID(),reuseUnchanged:true},studio.owner.token)).status).toBe(202);
    const generatedFilm=(await studio.worker())!;expect(generatedFilm.failureReason??generatedFilm.cancelReason).toBeUndefined();expect(generatedFilm.status).toBe("done");
    await control.sql.unsafe('CREATE DATABASE "'+databaseName(originName)+'"');created.push(originName);admin=new StudioDatabase(databaseUrl(process.env.HV_PG_ADMIN_URL!,originName));await admin.migrate();
    const initial:StateSnapshot={schema:"hv-state/1",projects:originalProjects,jobs:[originalFilm,generatedFilm],ledger:JSON.parse(readFileSync(studio.paths.costLedgerPath,"utf8")),reviews:[]};validateSnapshot(initial);await importStateSnapshot(admin,initial,500);
    const jobs=new PostgresJobStore(admin).forProject(projectId),film=(await jobs.get(originalFilm.id))!,freshFilm=(await jobs.get(generatedFilm.id))!,media=new PostgresArtifactStore(admin,studio.paths.artifactRoot,sourceClient);
    for(const job of [film,freshFilm]){const uploaded=await media.importCompletedJob(job,files(join(studio.paths.artifactRoot,projectId,job.id)));expect(uploaded.files).toBeGreaterThan(0);expect(uploaded.bytes).toBeGreaterThan(0);}
    const source=await inspectEditSource(film,originalSource.facts.label,studio.paths.artifactRoot,async()=>{},undefined,media,path=>media.fileInfo(projectId!,film.id,path));expect(source).toEqual(originalSource);
    const generated=await inspectEditSource(freshFilm,"Reviewed generated screenplay",studio.paths.artifactRoot,async()=>{},undefined,media,path=>media.fileInfo(projectId!,freshFilm.id,path)),sourceMap=compileLivingScriptSourceMap(source,patch,impact,generated),bindings=[bindOriginalEditSource(source),bindOriginalEditSource(generated)],carriers:EditAssemblyCarrier[]=bindings.map(binding=>({binding,current:binding.owner.jobId===film.id?film:freshFilm}));
    api=new StudioDatabase(databaseUrl(process.env.HV_API_DATABASE_URL!,originName));const projects=new PostgresProjectService(api),owner=studio.owner;
    const editorial=(await projects.createEditSequence(owner.token,[source],"parent","Original saved cut",source.facts.id,320,180,0,Date.now(),[bindings[0]!]))!,parent=deriveEditAssemblyParent(projectId,editorial,"parent"),navigation=projectEditScriptNavigation(parent.sequenceId,parent.historyRevision,parent.timeline,[index]),current=(await projects.peekProject(projectId))!,baseline={casting:currentCasting(projectId,current.castingHistory),direction:currentDirection(projectId,current.directionHistory)};
    const proposal=(await projects.createLivingScriptProposal(owner.token,{id:"line-proposal",label:"Review the greeting",sequenceId:parent.sequenceId,historyRevision:parent.historyRevision,editorialRevision:editorial.revision,navigationRevision:navigation.revision,patch,candidate:impact.candidateInputs,baseline},0,[carriers[0]!]))!.proposal,reviewTime=Date.now();
    const input:LivingScriptRecutInput={projectId,library:editorial,sequenceId:parent.sequenceId,historyRevision:parent.historyRevision,navigationRevision:navigation.revision,patch,candidate:impact.candidateInputs,generated,sourceMap,operations:[{kind:"replace",clipId:"initial-0",linked:true,sourceId:generated.facts.id,from:0,frames:generated.facts.frames,timing:"preserve",ripple:false}],newSequenceId:"accepted-cut"};
    const request=(id:string,sequenceId:string):LivingScriptAcceptanceRequest=>{const recutInput={...input,newSequenceId:sequenceId},recut=compileLivingScriptRecut(recutInput,reviewTime);return {id,name:"Reviewed linked cut "+id,reviewRevision:recut.revision,baseline,recutInput,recut};};
    const row=async()=>{const value=(await admin!.sql`select body,version from hv_projects where id=${projectId!}`)[0];return {body:value.body as PersistedProject,version:Number(value.version)};};
    const jobRows=async()=>await admin!.sql`select id,body,status from hv_jobs where project_id=${projectId!} order by id`;
    const counts=async()=>{const value=(await admin!.sql`select (select count(*) from hv_jobs where project_id=${projectId!}) as jobs,(select count(*) from hv_cost_events where project_id=${projectId!}) as costs,(select count(*) from hv_provider_attempts where project_id=${projectId!}) as attempts,(select count(*) from hv_reservations where job_id in (select id from hv_jobs where project_id=${projectId!})) as holds`)[0];return [value.jobs,value.costs,value.attempts,value.holds].map(Number);};
    const accept=(body:LivingScriptAcceptanceRequest,version=0,selected=carriers)=>projects.acceptLivingScriptProposal(owner.token,proposal.request.id,proposal.revision,body,version,selected);
    const before=await row(),beforeJobs=await jobRows(),beforeCounts=await counts(),identical=request("identical","identical-cut");
    const same=await Promise.all([accept(identical),accept(identical)]);expect(same.map(result=>result!.replayed).sort()).toEqual([false,true]);expect(same[0]!.record).toEqual(same[1]!.record);
    const fresh=same.find(result=>result?.replayed===false)!;if(fresh.replayed)throw new Error("Missing fresh identical acceptance.");const adopted=await row();expect(adopted.version).toBe(before.version+1);expect(adopted.body.versions).toEqual([...before.body.versions,fresh.bundle.nextScript]);expect(adopted.body.editLibrary).toEqual(fresh.bundle.nextEditLibrary);expect(adopted.body.livingScriptAcceptances).toEqual(fresh.library);
    expect(adopted.body.castingHistory).toEqual(before.body.castingHistory);expect(adopted.body.directionHistory).toEqual([...before.body.directionHistory!,fresh.bundle.nextDirection]);expect(adopted.body.livingScriptProposals).toEqual(before.body.livingScriptProposals);expect(adopted.body.animaticApprovals).toEqual(before.body.animaticApprovals);expect(adopted.body.dialogueSelections).toEqual(before.body.dialogueSelections);expect(await jobRows()).toEqual(beforeJobs);expect(await counts()).toEqual(beforeCounts);
    expect((await accept(identical))!.replayed).toBe(true);expect(await row()).toEqual(adopted);
    // Reset only this dedicated fixture row to the frozen pre-acceptance body for a separate
    // competing-body race. Its row version still advances; no production reset path is used.
    await admin.sql`update hv_projects set body=${before.body}::jsonb,version=version+1 where id=${projectId}`;const raceBefore=await row(),a=request("race-a","cut-a"),b=request("race-b","cut-b"),outcomes=await Promise.allSettled([accept(a),accept(b)]);
    expect(outcomes.filter(result=>result.status==="fulfilled")).toHaveLength(1);expect(outcomes.filter(result=>result.status==="rejected")).toHaveLength(1);
    const fulfilled=outcomes.find(result=>result.status==="fulfilled");if(!fulfilled||fulfilled.status!=="fulfilled"||!fulfilled.value||fulfilled.value.replayed)throw new Error("Competing race did not produce one fresh acceptance.");const winner=fulfilled.value,winningRequest=[a,b].find(body=>body.id===winner.record.request.id)!;expect(winningRequest).toBeDefined();const accepted=await row();
    expect(accepted.version).toBe(raceBefore.version+1);expect(accepted.body.livingScriptAcceptances!.records).toEqual([winner.record]);expect(accepted.body.versions).toEqual([...raceBefore.body.versions,winner.bundle.nextScript]);expect(accepted.body.editLibrary).toEqual(winner.bundle.nextEditLibrary);expect(accepted.body.directionHistory).toEqual([...raceBefore.body.directionHistory!,winner.bundle.nextDirection]);
    expect(contentHash(accepted.body.livingScriptAcceptances)).toBe(contentHash(winner.library));expect(JSON.stringify(accepted.body.livingScriptAcceptances)).not.toBe(JSON.stringify(winner.library));
    for(const body of [{...winningRequest,name:"Changed retry"},{...winningRequest,id:"another-acceptance"}]){await expect(accept(body,1)).rejects.toThrow();expect(await row()).toEqual(accepted);}
    // Prove each original AND generated carrier is locked, then withdrawn while a retry waits.
    for(const carrier of carriers){const job=carrier.current!,locked=deferred<number>(),release=deferred<void>(),transaction=admin.sql.begin(async tx=>{const pid=Number((await tx`select pg_backend_pid() as pid`)[0].pid);await tx`select id from hv_jobs where id=${job.id} for update`;locked.resolve(pid);await release.promise;await tx`update hv_jobs set body=${{...job,status:"cancelled"}}::jsonb,status='cancelled' where id=${job.id}`;}).catch(error=>{locked.reject(error);throw error;});
      const blocker=await locked.promise,pending=accept(winningRequest).then(value=>({value,error:null}),error=>({value:null,error}));
      try{let observed=false;const deadline=Date.now()+10000;while(Date.now()<deadline){observed=Boolean((await admin.sql`select exists(select 1 from pg_stat_activity where ${blocker}::int=any(pg_blocking_pids(pid))) as blocked`)[0].blocked);if(observed)break;await new Promise(resolve=>setTimeout(resolve,20));}expect(observed).toBe(true);}finally{release.resolve();await transaction;await pending;}
      const withdrawn=await pending;expect(withdrawn.error).toBeInstanceOf(Error);expect(String(withdrawn.error)).toContain("carrier changed");expect(await row()).toEqual(accepted);await admin.sql`update hv_jobs set body=${job}::jsonb,status='done' where id=${job.id}`;
      const file=carrier.binding.files[0]!;await admin.sql`update hv_artifacts set bytes=bytes+1 where project_id=${projectId} and job_id=${job.id} and key=${file.path}`;await expect(accept(winningRequest)).rejects.toThrow("artifact changed");expect(await row()).toEqual(accepted);await admin.sql`update hv_artifacts set bytes=${file.bytes} where project_id=${projectId} and job_id=${job.id} and key=${file.path}`;
    }
    await admin.sql`update hv_projects set body=${{...accepted.body,rightsAttestedAt:null}}::jsonb where id=${projectId}`;const revoked=await row();await expect(accept(winningRequest)).rejects.toThrow();expect(await row()).toEqual(revoked);await admin.sql`update hv_projects set body=${accepted.body}::jsonb where id=${projectId}`;
    expect(await projects.acceptLivingScriptProposal("invalid",proposal.request.id,proposal.revision,winningRequest,0,carriers)).toBeNull();expect(await row()).toEqual(accepted);
    const other=await projects.createAnonymousProject();await expect(projects.acceptLivingScriptProposal(other.token,proposal.request.id,proposal.revision,winningRequest,0,carriers)).rejects.toThrow("from this project");expect(await row()).toEqual(accepted);
    await projects.editScript(owner.token,patch.after.text+"\n\nThe garden rests.");for(const id of ["parent",winner.bundle.acceptance.sequence.id]){const value=(await projects.peekProject(projectId))!.editLibrary,sequence=value.sequences.find(sequence=>sequence.id===id)!;await projects.changeEditSequence(owner.token,id,{kind:"edit",label:"Later note",operation:{kind:"marker",marker:{id:"later",frame:1,label:"Later saved edit"}}},value.version,sequence.history.revision);}
    const later=await row();expect((await accept(winningRequest,0))!.record).toEqual(winner.record);expect(await row()).toEqual(later);expect(await jobRows()).toEqual(beforeJobs);expect(await counts()).toEqual(beforeCounts);
    const snapshot=await exportStateSnapshot(admin,projectId);expect(snapshot.schema).toBe("hv-state/9");expect(snapshot.jobs).toHaveLength(2);expect(snapshot.projects.projects[0]!.livingScriptAcceptances).toEqual(accepted.body.livingScriptAcceptances);expect(()=>validateSnapshot({...snapshot,schema:"hv-state/8"})).toThrow("schema 9");
    const archive=join(root,"accepted.zip"),prepared=join(root,"prepared"),unpacked=join(root,"unpacked"),exported=await exportProjectArchive(admin,projectId,prepared,archive);expect(exported.jobs).toBe(2);expect(readStateSnapshot(prepared)).toEqual(snapshot);
    await control.sql.unsafe('CREATE DATABASE "'+databaseName(restoreName)+'"');created.push(restoreName);restored=new StudioDatabase(databaseUrl(process.env.HV_PG_ADMIN_URL!,restoreName));await restored.migrate();
    let imported:Awaited<ReturnType<typeof importProjectArchive>>;try{process.env.HV_S3_BUCKET=process.env.HV_S3_FLEET_TEST_BUCKET;imported=await importProjectArchive(restored,archive,unpacked,500);}finally{process.env.HV_S3_BUCKET=sourceBucket;}
    expect(imported.archiveSha256).toBe(exported.archiveSha256);expect(imported.mediaFiles).toBeGreaterThan(0);expect(imported.mediaBytes).toBeGreaterThan(0);expect(readStateSnapshot(unpacked)).toEqual(snapshot);expect(readFileSync(join(prepared,"state/projects.json"))).toEqual(readFileSync(join(unpacked,"state/projects.json")));
    const restoredProjects=new PostgresProjectService(restored),retained=(await restoredProjects.authorize(owner.token))!;expect(retained.livingScriptAcceptances).toEqual(accepted.body.livingScriptAcceptances!);expect(retained.versions.history()).toEqual(later.body.versions);expect(retained.editLibrary).toEqual(later.body.editLibrary!);expect((await exportStateSnapshot(restored,projectId)).schema).toBe("hv-state/9");
    await clearObjects(sourceClient,projectId);expect((await sourceClient.list({prefix:"v1/"+projectId+"/",maxKeys:1})).contents??[]).toHaveLength(0);
    const independentRoot=join(root,"independent");expect(existsSync(independentRoot)).toBe(false);const independentMedia=new PostgresArtifactStore(restored,independentRoot,destinationClient),restoredCarriers:EditAssemblyCarrier[]=[];
    for(const receipt of [source,generated]){const job=(await new PostgresJobStore(restored).forProject(projectId).get(receipt.job.id))!;await independentMedia.restoreCheckpoint(job);
      for(const file of receipt.files){expect(await independentMedia.fileInfo(projectId,job.id,file.path)).toEqual(file);expect(readFileSync(join(independentRoot,file.path))).toEqual(readFileSync(join(studio.paths.artifactRoot,file.path)));}
      const measured=await inspectEditSource(job,receipt.facts.label,independentRoot,async()=>{},undefined,independentMedia,path=>independentMedia.fileInfo(projectId!,job.id,path));expect(measured).toEqual(receipt);restoredCarriers.push({binding:bindOriginalEditSource(measured),current:job});
    }
    const beforeRetry=(await restored.sql`select body,version from hv_projects where id=${projectId}`)[0],replay=await restoredProjects.acceptLivingScriptProposal(owner.token,proposal.request.id,proposal.revision,winningRequest,0,restoredCarriers);expect(replay!.replayed).toBe(true);expect(replay!.record).toEqual(winner.record);expect(replay!.bundle).toBeUndefined();expect((await restored.sql`select body,version from hv_projects where id=${projectId}`)[0]).toEqual(beforeRetry);
  }finally{
    if(sourceBucket===undefined)delete process.env.HV_S3_BUCKET;else process.env.HV_S3_BUCKET=sourceBucket;
    if(projectId)for(const client of [sourceClient,destinationClient])await clearObjects(client,projectId);
    await api?.close();await admin?.close();await restored?.close();for(const name of created)await control.sql.unsafe('DROP DATABASE "'+databaseName(name)+'" WITH (FORCE)');await control.close();await studio?.close(false);cleanup(root);
  }
},240000);
