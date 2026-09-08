import {expect,test} from "bun:test";
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {CAST_INPUT} from "../../../test/fixtures/casting";
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
import type {LivingScriptProposalRequest} from "../../planner/src/living-script-proposals";
import {currentCasting} from "../../planner/src/casting";
import {currentDirection} from "../../planner/src/direction";

const enabled=Boolean(process.env.HV_PG_ADMIN_URL&&process.env.HV_API_DATABASE_URL&&process.env.HV_S3_ENDPOINT&&process.env.HV_S3_BUCKET&&process.env.HV_S3_FLEET_TEST_BUCKET);
function databaseName(name:string):string{if(!/^hv_living_script_[a-f0-9]{32}$/.test(name))throw new Error("Unsafe screenplay fixture database");return name;}
function databaseUrl(value:string,name:string):string{const url=new URL(value);url.pathname="/"+databaseName(name);return url.href;}
function files(root:string):string[]{return readdirSync(root,{withFileTypes:true}).flatMap(entry=>{if(entry.isSymbolicLink())throw new Error("Fixture media cannot contain links");const path=join(root,entry.name);if(entry.isDirectory())return files(path);if(!entry.isFile())throw new Error("Fixture media must be regular files");return [path];});}
function cleanup(root:string){if(!root.startsWith(realpathSync(tmpdir())+sep+"hv-living-pg-")||realpathSync(root)!==root)throw new Error("Unsafe screenplay fixture cleanup");rmSync(root,{recursive:true,force:true});}
async function clearObjects(client:ReturnType<typeof objectClient>,projectId:string):Promise<void>{
  const prefix="v1/"+projectId+"/";for(let page=0;page<100;page++){const entries=(await client.list({prefix,maxKeys:1000})).contents??[];if(!entries.length)return;for(const entry of entries){if(!entry.key.startsWith(prefix))throw new Error("Fixture object escaped its project");await client.file(entry.key).delete();}}throw new Error("Fixture object cleanup exceeded its bound");
}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}

(enabled?test:test.skip)("PostgreSQL screenplay proposals serialize exact retries, fence live carriers, and restore independent schema eleven archives",async()=>{
  const root=realpathSync(mkdtempSync(join(realpathSync(tmpdir()),"hv-living-pg-"))),originName=databaseName("hv_living_script_"+crypto.randomUUID().replaceAll("-","")),restoreName=databaseName("hv_living_script_"+crypto.randomUUID().replaceAll("-",""));
  const sourceBucket=process.env.HV_S3_BUCKET,control=new StudioDatabase(process.env.HV_PG_ADMIN_URL!),created:string[]=[],sourceClient=objectClient(),destinationClient=objectClient({...process.env,HV_S3_BUCKET:process.env.HV_S3_FLEET_TEST_BUCKET});
  let studio:Awaited<ReturnType<typeof dubStudio>>|undefined,admin:StudioDatabase|undefined,api:StudioDatabase|undefined,restored:StudioDatabase|undefined,projectId:string|undefined;
  try{
    expect(process.env.HV_S3_FLEET_TEST_BUCKET).not.toBe(sourceBucket);const studioRoot=join(root,"studio");mkdirSync(studioRoot);studio=await dubStudio(studioRoot);projectId=studio.owner.projectId;
    await control.sql.unsafe('CREATE DATABASE "'+databaseName(originName)+'"');created.push(originName);admin=new StudioDatabase(databaseUrl(process.env.HV_PG_ADMIN_URL!,originName));await admin.migrate();
    const initial:StateSnapshot={schema:"hv-state/11",projects:studio.projects.snapshot(),jobs:[structuredClone(studio.film)],ledger:JSON.parse(readFileSync(studio.paths.costLedgerPath,"utf8")),reviews:[]};
    validateSnapshot(initial);await importStateSnapshot(admin,initial,500);
    const media=new PostgresArtifactStore(admin,studio.paths.artifactRoot,sourceClient),film=(await new PostgresJobStore(admin).forProject(projectId).get(studio.film.id))!;
    expect(film.output).toEqual(studio.film.output);const importedMedia=await media.importCompletedJob(film,files(join(studio.paths.artifactRoot,projectId,film.id)));expect(importedMedia.files).toBeGreaterThan(0);expect(importedMedia.bytes).toBeGreaterThan(0);
    const source=await inspectEditSource(film,"Retained film",studio.paths.artifactRoot,async()=>{},undefined,media,path=>media.fileInfo(projectId!,film.id,path)),binding=bindOriginalEditSource(source),carriers:EditAssemblyCarrier[]=[{binding,current:film}];
    api=new StudioDatabase(databaseUrl(process.env.HV_API_DATABASE_URL!,originName));const projects=new PostgresProjectService(api),owner=studio.owner;
    const editorial=(await projects.createEditSequence(owner.token,[source],"cut","Saved cut",source.facts.id,320,180,0,Date.now(),[binding]))!,parent=deriveEditAssemblyParent(projectId,editorial,"cut"),index=compileEditScriptSource(source),entry=index.entries.find(value=>value.kind==="dialogue")!;
    const patch=compileLivingScriptPatch(source,{entryId:entry.id,indexRevision:index.revision,currentScript:{version:film.scriptVersion,text:film.scriptText},replacement:"Welcome back to the garden."}),candidate=compileLivingScriptGenerationImpact(source,patch,{...film,scriptVersion:patch.after.version,scriptText:patch.after.text}).candidateInputs,navigation=projectEditScriptNavigation("cut",parent.historyRevision,parent.timeline,[index]);
    const current=(await projects.peekProject(projectId))!,input:LivingScriptProposalRequest={id:"line-review",label:"Review greeting",sequenceId:"cut",historyRevision:parent.historyRevision,editorialRevision:editorial.revision,navigationRevision:navigation.revision,patch,candidate,baseline:{casting:currentCasting(projectId,current.castingHistory),direction:currentDirection(projectId,current.directionHistory)}};
    const row=async()=>{const value=(await admin!.sql`select body,version from hv_projects where id=${projectId!}`)[0];return {body:value.body as PersistedProject,version:Number(value.version)};};
    const jobRows=async()=>await admin!.sql`select id,body,status from hv_jobs where project_id=${projectId!} order by id`;
    const counts=async()=>{const value=(await admin!.sql`select (select count(*) from hv_jobs where project_id=${projectId!}) as jobs,(select count(*) from hv_cost_events where project_id=${projectId!}) as costs,(select count(*) from hv_provider_attempts where project_id=${projectId!}) as attempts,(select count(*) from hv_reservations where job_id in (select id from hv_jobs where project_id=${projectId!})) as holds`)[0];return [value.jobs,value.costs,value.attempts,value.holds].map(Number);};
    const save=(request=input,version=0,selected=carriers)=>projects.createLivingScriptProposal(owner.token,request,version,selected);
    const original=await row(),originalJobs=await jobRows(),originalCounts=await counts();
    const copies=await Promise.all([save(),save()]);expect(copies.map(value=>value!.replayed).sort()).toEqual([false,true]);expect(copies[0]!.proposal).toEqual(copies[1]!.proposal);
    const first=await row();expect(first.version).toBe(original.version+1);expect(first.body.livingScriptProposals!.version).toBe(1);expect(first.body.versions).toEqual(original.body.versions);expect(first.body.editLibrary).toEqual(original.body.editLibrary);expect(await jobRows()).toEqual(originalJobs);expect(await counts()).toEqual(originalCounts);
    expect((await save())!.replayed).toBe(true);expect(await row()).toEqual(first);expect((await save(input,0,[{binding,current:undefined}]))!.replayed).toBe(true);expect(await row()).toEqual(first);
    expect(contentHash(first.body.livingScriptProposals)).toBe(contentHash(copies[0]!.library));expect(JSON.stringify(first.body.livingScriptProposals)).not.toBe(JSON.stringify(copies.find(value=>value?.replayed===false)!.library));
    const competing=await Promise.allSettled([save({...input,id:"second-a"},1),save({...input,id:"second-b"},1)]);expect(competing.filter(value=>value.status==="fulfilled")).toHaveLength(1);expect(competing.filter(value=>value.status==="rejected")).toHaveLength(1);const second=await row();expect(second.version).toBe(first.version+1);expect(second.body.livingScriptProposals!.version).toBe(2);expect(second.body.livingScriptProposals!.proposals).toHaveLength(2);
    for(const request of [{...input,label:"Changed exact retry"},{...input,id:"malformed",unexpected:true} as LivingScriptProposalRequest]){await expect(save(request,2)).rejects.toThrow();expect(await row()).toEqual(second);}
    // Observe PostgreSQL blocking, then commit a carrier withdrawal while the request is waiting.
    const locked=deferred<number>(),release=deferred<void>();const transaction=admin.sql.begin(async tx=>{const pid=Number((await tx`select pg_backend_pid() as pid`)[0].pid);await tx`select id from hv_jobs where id=${film.id} for update`;locked.resolve(pid);await release.promise;await tx`update hv_jobs set body=${{...film,status:"cancelled"}}::jsonb,status='cancelled' where id=${film.id}`;}).catch(error=>{locked.reject(error);throw error;});
    const blocker=await locked.promise,pending=save().then(value=>({value,error:null}),error=>({value:null,error}));
    try{let observed=false;const deadline=Date.now()+10000;while(Date.now()<deadline){observed=Boolean((await admin.sql`select exists(select 1 from pg_stat_activity where ${blocker}::int=any(pg_blocking_pids(pid))) as blocked`)[0].blocked);if(observed)break;await new Promise(resolve=>setTimeout(resolve,20));}expect(observed).toBe(true);}finally{release.resolve();await transaction;await pending;}
    const withdrawn=await pending;expect(withdrawn.error).toBeInstanceOf(Error);expect(String(withdrawn.error)).toContain("carrier changed");expect(await row()).toEqual(second);
    await expect(save({...input,id:"withdrawn-new"},2)).rejects.toThrow("carrier changed");expect(await row()).toEqual(second);await admin.sql`update hv_jobs set body=${film}::jsonb,status='done' where id=${film.id}`;
    const file=binding.files[0]!;await admin.sql`update hv_artifacts set bytes=bytes+1 where project_id=${projectId} and job_id=${film.id} and key=${file.path}`;
    for(const request of [input,{...input,id:"changed-artifact-new"}]){await expect(save(request,2)).rejects.toThrow("artifact changed");expect(await row()).toEqual(second);}await admin.sql`update hv_artifacts set bytes=${file.bytes} where project_id=${projectId} and job_id=${film.id} and key=${file.path}`;
    await admin.sql`update hv_projects set body=${{...second.body,rightsAttestedAt:null}}::jsonb where id=${projectId}`;const noRights=await row();for(const request of [input,{...input,id:"no-rights"}]){await expect(save(request,2)).rejects.toThrow();expect(await row()).toEqual(noRights);}await admin.sql`update hv_projects set body=${second.body}::jsonb where id=${projectId}`;
    const other=await projects.createAnonymousProject(),otherBefore=(await projects.peekProject(other.projectId))!.livingScriptProposals;await expect(projects.createLivingScriptProposal(other.token,input,0,carriers)).rejects.toThrow("from this project");expect((await projects.peekProject(other.projectId))!.livingScriptProposals).toEqual(otherBefore);expect(await row()).toEqual(second);expect(await projects.createLivingScriptProposal("invalid",input,0,carriers)).toBeNull();
    await projects.saveCharacter(owner.token,studio.id,{...CAST_INPUT,appearance:"A russet potato with larger round glasses."},input.baseline.casting.version);const changedCast=await row();await expect(save({...input,id:"old-baseline"},2)).rejects.toThrow("current cast or direction changed");expect(await row()).toEqual(changedCast);expect((await save())!.replayed).toBe(true);expect(await row()).toEqual(changedCast);
    await projects.editScript(owner.token,input.patch.before.text+"\n\nThe gate closes.");await projects.changeEditSequence(owner.token,"cut",{kind:"edit",label:"Later cut note",operation:{kind:"marker",marker:{id:"later",frame:0,label:"Later edit"}}},editorial.version,input.historyRevision);const later=await row();
    expect((await save())!.proposal).toEqual(copies[0]!.proposal);expect(await row()).toEqual(later);await expect(save({...input,id:"stale-cut"},2)).rejects.toThrow();expect(await row()).toEqual(later);expect(await jobRows()).toEqual(originalJobs);expect(await counts()).toEqual(originalCounts);
    const snapshot=await exportStateSnapshot(admin,projectId);expect(snapshot.schema).toBe("hv-state/11");expect(snapshot.jobs).toHaveLength(1);expect(snapshot.jobs[0]!.executionCheckpoints).toEqual(film.executionCheckpoints!);expect(snapshot.projects.projects[0]!.livingScriptProposals).toEqual(second.body.livingScriptProposals);expect(()=>validateSnapshot({...snapshot,schema:"hv-state/10"})).toThrow("schema 11");
    const archive=join(root,"review.zip"),prepared=join(root,"prepared"),unpacked=join(root,"unpacked"),exported=await exportProjectArchive(admin,projectId,prepared,archive);expect(exported.jobs).toBe(1);expect(readStateSnapshot(prepared)).toEqual(snapshot);
    await control.sql.unsafe('CREATE DATABASE "'+databaseName(restoreName)+'"');created.push(restoreName);restored=new StudioDatabase(databaseUrl(process.env.HV_PG_ADMIN_URL!,restoreName));await restored.migrate();
    let imported:Awaited<ReturnType<typeof importProjectArchive>>;try{process.env.HV_S3_BUCKET=process.env.HV_S3_FLEET_TEST_BUCKET;imported=await importProjectArchive(restored,archive,unpacked,500);}finally{process.env.HV_S3_BUCKET=sourceBucket;}
    expect(imported.archiveSha256).toBe(exported.archiveSha256);expect(imported.mediaFiles).toBeGreaterThan(0);expect(imported.mediaBytes).toBeGreaterThan(0);expect(readStateSnapshot(unpacked)).toEqual(snapshot);
    const restoredProjects=new PostgresProjectService(restored),retained=(await restoredProjects.authorize(owner.token))!,restoredFilm=(await new PostgresJobStore(restored).forProject(projectId).get(film.id))!;
    expect(retained.livingScriptProposals).toEqual(second.body.livingScriptProposals!);expect(contentHash(retained.livingScriptProposals)).toBe(contentHash(second.body.livingScriptProposals));expect((await exportStateSnapshot(restored,projectId)).schema).toBe("hv-state/11");
    await clearObjects(sourceClient,projectId);expect((await sourceClient.list({prefix:"v1/"+projectId+"/",maxKeys:1})).contents??[]).toHaveLength(0);
    const independentRoot=join(root,"independent");expect(existsSync(independentRoot)).toBe(false);const independentMedia=new PostgresArtifactStore(restored,independentRoot,destinationClient);await independentMedia.restoreCheckpoint(restoredFilm);
    for(const record of source.files){expect(await independentMedia.fileInfo(projectId,film.id,record.path)).toEqual(record);expect(readFileSync(join(independentRoot,record.path))).toEqual(readFileSync(join(studio.paths.artifactRoot,record.path)));}
    const measured=await inspectEditSource(restoredFilm,source.facts.label,independentRoot,async()=>{},undefined,independentMedia,path=>independentMedia.fileInfo(projectId!,film.id,path));expect(measured.facts).toEqual(source.facts);expect(measured.revision).toBe(source.revision);
    const beforeRetry=(await restored.sql`select body,version from hv_projects where id=${projectId}`)[0];expect((await restoredProjects.createLivingScriptProposal(owner.token,input,0,[{binding:bindOriginalEditSource(measured),current:restoredFilm}]))!.replayed).toBe(true);expect((await restored.sql`select body,version from hv_projects where id=${projectId}`)[0]).toEqual(beforeRetry);
    expect((await restoredProjects.peekProject(projectId))!.livingScriptProposals.proposals[0]!.request.baseline).toEqual(input.baseline);
  }finally{
    if(sourceBucket===undefined)delete process.env.HV_S3_BUCKET;else process.env.HV_S3_BUCKET=sourceBucket;
    if(projectId)for(const client of [sourceClient,destinationClient])await clearObjects(client,projectId);
    await api?.close();await admin?.close();await restored?.close();for(const name of created)await control.sql.unsafe('DROP DATABASE "'+databaseName(name)+'" WITH (FORCE)');await control.close();await studio?.close(false);
    cleanup(root);
  }
},180000);
