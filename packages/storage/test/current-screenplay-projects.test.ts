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
import type {Job} from "../../queue/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {currentCasting} from "../../planner/src/casting";
import {currentDirection} from "../../planner/src/direction";
import {bootstrapLivingScriptDocument,compileLivingScriptDocument} from "../../planner/src/living-script-document";
import {bootstrapLivingScriptShotPlan} from "../../planner/src/living-script-shot-plan";
import {createLivingScriptStructureBase,compileLivingScriptStructure,livingScriptStructureBlock} from "../../planner/src/living-script-structure";
import {proposeShotPlanEvolution} from "../../planner/src/living-script-current-plan";
import {createCurrentDirectionRequest} from "../../planner/src/living-script-current-direction";
import {currentScreenplayHead,type CurrentScreenplayLibrary,type CurrentScreenplayBootstrapRequest,type CurrentScreenplayProposalRequest} from "../../planner/src/current-screenplay-library";

const enabled=Boolean(process.env.HV_PG_ADMIN_URL&&process.env.HV_API_DATABASE_URL&&process.env.HV_S3_ENDPOINT&&process.env.HV_S3_BUCKET&&process.env.HV_S3_FLEET_TEST_BUCKET);
function databaseName(name:string):string {if(!/^hv_current_[a-f0-9]{32}$/.test(name))throw new Error("Unsafe current screenplay fixture database");return name;}
function databaseUrl(value:string,name:string):string {const url=new URL(value);url.pathname="/"+databaseName(name);return url.href;}
function files(root:string):string[] {return readdirSync(root,{withFileTypes:true}).flatMap(entry=>{if(entry.isSymbolicLink())throw new Error("Fixture media cannot contain links");const path=join(root,entry.name);if(entry.isDirectory())return files(path);if(!entry.isFile())throw new Error("Fixture media must be regular files");return [path];});}
function cleanup(root:string):void {if(!root.startsWith(realpathSync(tmpdir())+sep+"hv-current-pg-")||realpathSync(root)!==root)throw new Error("Unsafe current screenplay fixture cleanup");rmSync(root,{recursive:true,force:true});}
async function clearObjects(client:ReturnType<typeof objectClient>,projectId:string):Promise<void> {
  const prefix="v1/"+projectId+"/";for(let page=0;page<100;page++){const entries=(await client.list({prefix,maxKeys:1000})).contents??[];if(!entries.length)return;for(const entry of entries){if(!entry.key.startsWith(prefix))throw new Error("Fixture object escaped its project");await client.file(entry.key).delete();}}throw new Error("Fixture object cleanup exceeded its bound");
}
function proposal(library:CurrentScreenplayLibrary,id:string,text:string):CurrentScreenplayProposalRequest {
  const head=currentScreenplayHead(library)!,context=head.state.context,document=context.plan.document,line=document.lines.find(row=>row.id===context.plan.shots[0]!.recipe.dialogue[0]!.lineIds[0])!,base=document.context.base;
  const patch=compileLivingScriptStructure(base,{baseRevision:base.revision,operations:[{id:"physical-"+id,kind:"replace",block:livingScriptStructureBlock(base,line.line,line.line+1),text}]}),afterDocument=compileLivingScriptDocument({base:patch.after,ancestry:[...document.context.ancestry,patch]}),capacity={tier:"free" as const,maxShots:24 as const};
  const plan=proposeShotPlanEvolution({previous:context.plan,lineage:context.lineage,originals:context.originals,beforeDocument:document,afterDocument,capacity,requestId:id+"-plan"});expect(plan.review.conflicts).toEqual([]);
  return {id,label:"Review "+id,expectedHeadRevision:head.revision,beforeStateRevision:head.state.revision,afterDocument,planRequest:plan.request,capacity,directionRequest:createCurrentDirectionRequest(head.state.direction,plan.review.candidate!,{id:id+"-direction",settings:[],lines:[],retired:[]})};
}

(enabled?test:test.skip)("PostgreSQL canonical screenplay history serializes owner acceptance and restores an independent schema-twelve next proposal",async()=>{
  const root=realpathSync(mkdtempSync(join(realpathSync(tmpdir()),"hv-current-pg-"))),originName=databaseName("hv_current_"+crypto.randomUUID().replaceAll("-","")),restoreName=databaseName("hv_current_"+crypto.randomUUID().replaceAll("-",""));
  const bucket=process.env.HV_S3_BUCKET,control=new StudioDatabase(process.env.HV_PG_ADMIN_URL!),created:string[]=[],sourceClient=objectClient(),destinationClient=objectClient({...process.env,HV_S3_BUCKET:process.env.HV_S3_FLEET_TEST_BUCKET});
  let studio:Awaited<ReturnType<typeof dubStudio>>|undefined,admin:StudioDatabase|undefined,api:StudioDatabase|undefined,restored:StudioDatabase|undefined,projectId:string|undefined;
  try{
    expect(process.env.HV_S3_FLEET_TEST_BUCKET).not.toBe(bucket);const studioRoot=join(root,"studio");mkdirSync(studioRoot);studio=await dubStudio(studioRoot);projectId=studio.owner.projectId;
    await control.sql.unsafe('CREATE DATABASE "'+originName+'"');created.push(originName);admin=new StudioDatabase(databaseUrl(process.env.HV_PG_ADMIN_URL!,originName));await admin.migrate();
    // Use the actual persisted worker Job, not its returned in-memory object with optional undefined fields.
    const recorded=(JSON.parse(readFileSync(studio.paths.queuePath,"utf8")) as Job[]).find(value=>value.id===studio!.film.id)!;
    const initial:StateSnapshot={schema:"hv-state/11",projects:studio.projects.snapshot(),jobs:[recorded],ledger:JSON.parse(readFileSync(studio.paths.costLedgerPath,"utf8")),reviews:[]};validateSnapshot(initial);await importStateSnapshot(admin,initial,500);
    const film=(await new PostgresJobStore(admin).forProject(projectId).get(recorded.id))!,media=new PostgresArtifactStore(admin,studio.paths.artifactRoot,sourceClient),imported=await media.importCompletedJob(film,files(join(studio.paths.artifactRoot,projectId,film.id)));
    expect(imported.files).toBeGreaterThan(0);expect(imported.bytes).toBeGreaterThan(0);expect(film.executionCheckpoints).toEqual(recorded.executionCheckpoints!);expect(film.output!.shotExecutions).toEqual(recorded.output!.shotExecutions!);
    const source=await inspectEditSource(film,"Canonical current screenplay original",studio.paths.artifactRoot,async()=>{},undefined,media,path=>media.fileInfo(projectId!,film.id,path)),binding=bindOriginalEditSource(source),carrier={binding,current:film};
    api=new StudioDatabase(databaseUrl(process.env.HV_API_DATABASE_URL!,originName));const projects=new PostgresProjectService(api),owner=studio.owner,current=(await projects.peekProject(projectId))!,script=current.versions.latest()!,base=createLivingScriptStructureBase({projectId,version:script.version,text:script.text,locks:[]}),documentSource=bootstrapLivingScriptDocument(source,{base,ancestry:[]});
    const request:CurrentScreenplayBootstrapRequest={id:"origin",label:"Original current screenplay",script,source,documentSource,originalPlan:bootstrapLivingScriptShotPlan(source,documentSource),baseline:{casting:currentCasting(projectId,current.castingHistory),direction:currentDirection(projectId,current.directionHistory)}};
    const row=async()=>{const value=(await admin!.sql`select body,version from hv_projects where id=${projectId!}`)[0];return {body:value.body as PersistedProject,version:Number(value.version)};},jobRows=async()=>await admin!.sql`select id,body,status from hv_jobs where project_id=${projectId!} order by id`;
    const counts=async()=>{const value=(await admin!.sql`select (select count(*) from hv_jobs where project_id=${projectId!}) as jobs,(select count(*) from hv_cost_events where project_id=${projectId!}) as costs,(select count(*) from hv_provider_attempts where project_id=${projectId!}) as attempts,(select count(*) from hv_reservations where job_id in (select id from hv_jobs where project_id=${projectId!})) as holds`)[0];return [value.jobs,value.costs,value.attempts,value.holds].map(Number);};
    const original=await row(),originalJobs=await jobRows(),originalCounts=await counts(),sourceHash=contentHash(source),expectedMp4=readFileSync(join(studio.paths.artifactRoot,film.output!.mp4Path));
    const boots=await Promise.all([projects.bootstrapCurrentScreenplay(owner.token,request,0,carrier),projects.bootstrapCurrentScreenplay(owner.token,request,0,carrier)]);
    expect(boots.map(result=>result!.replayed).sort()).toEqual([false,true]);expect(boots[0]!.origin).toEqual(boots[1]!.origin);
    const booted=await row();expect(booted.version).toBe(original.version+1);expect(booted.body.currentScreenplay!.version).toBe(1);expect(booted.body.versions).toEqual(original.body.versions);expect(booted.body.castingHistory).toEqual(original.body.castingHistory);
    expect((await projects.bootstrapCurrentScreenplay(owner.token,request,0,{binding,current:undefined}))!.replayed).toBe(true);expect(await row()).toEqual(booted);
    await expect(projects.bootstrapCurrentScreenplay(owner.token,{...request,label:"Different exact bootstrap"},1,carrier)).rejects.toThrow();expect(await row()).toEqual(booted);
    const input=proposal(booted.body.currentScreenplay!,"multiline","Welcome home.\nStay for a while.\n"),saved=(await projects.saveCurrentScreenplayProposal(owner.token,input,1))!,pending=await row();
    expect(saved.proposal.candidate).not.toBeNull();expect(pending.version).toBe(booted.version+1);expect(pending.body.versions).toEqual(original.body.versions);expect(pending.body.currentScreenplay!.headRevision).toBe(boots[0]!.origin.revision);
    expect((await projects.saveCurrentScreenplayProposal(owner.token,input,0))!.replayed).toBe(true);expect(await row()).toEqual(pending);
    for(const [asked,version]of [[{...input,id:"stale-version"},1],[{...input,label:"Different same ID"},2]] as const){await expect(projects.saveCurrentScreenplayProposal(owner.token,asked,version)).rejects.toThrow();expect(await row()).toEqual(pending);}
    const acceptance={id:"accepted-multiline",proposalRevision:saved.proposal.revision,expectedHeadRevision:booted.body.currentScreenplay!.headRevision!};
    await admin.sql`update hv_projects set body=${{...pending.body,rightsAttestedAt:null}}::jsonb where id=${projectId}`;const withdrawn=await row();await expect(projects.acceptCurrentScreenplayProposal(owner.token,acceptance,2)).rejects.toThrow();expect(await row()).toEqual(withdrawn);await admin.sql`update hv_projects set body=${pending.body}::jsonb where id=${projectId}`;
    const external={...pending.body,versions:[...pending.body.versions,{version:script.version+1,parentVersion:script.version,text:script.text+"\nA direct edit outside ancestry.",createdAt:new Date().toISOString()}]};await admin.sql`update hv_projects set body=${external}::jsonb where id=${projectId}`;const changed=await row();await expect(projects.acceptCurrentScreenplayProposal(owner.token,acceptance,2)).rejects.toThrow();expect(await row()).toEqual(changed);await admin.sql`update hv_projects set body=${pending.body}::jsonb where id=${projectId}`;
    const accepted=await Promise.all([projects.acceptCurrentScreenplayProposal(owner.token,acceptance,2),projects.acceptCurrentScreenplayProposal(owner.token,acceptance,2)]);expect(accepted.map(result=>result!.replayed).sort()).toEqual([false,true]);expect(accepted[0]!.acceptance).toEqual(accepted[1]!.acceptance);
    const final=await row(),receipt=accepted[0]!.acceptance;expect(final.version).toBe(pending.version+1);expect(final.body.currentScreenplay!.version).toBe(3);expect(final.body.currentScreenplay!.headRevision).toBe(receipt.revision);
    expect(final.body.versions).toEqual([...original.body.versions,...receipt.versions]);expect(final.body.versions.at(-1)!.text).toContain("Welcome home.\nStay for a while.");expect(currentCasting(projectId,final.body.castingHistory)).toEqual(receipt.state.casting.candidate!);
    expect(final.body.editLibrary).toEqual(original.body.editLibrary);expect(final.body.dialogueSelections).toEqual(original.body.dialogueSelections);expect(await jobRows()).toEqual(originalJobs);expect(await counts()).toEqual(originalCounts);expect(contentHash(source)).toBe(sourceHash);
    expect((await projects.acceptCurrentScreenplayProposal(owner.token,acceptance,0))!.replayed).toBe(true);expect(await row()).toEqual(final);
    await expect(projects.acceptCurrentScreenplayProposal(owner.token,{...acceptance,proposalRevision:"0".repeat(64)},3)).rejects.toThrow();expect(await row()).toEqual(final);
    await expect(projects.saveCurrentScreenplayProposal(owner.token,{...input,id:"stale-head"},3)).rejects.toThrow();expect(await row()).toEqual(final);
    expect(await projects.acceptCurrentScreenplayProposal("invalid",acceptance,3)).toBeNull();expect(await row()).toEqual(final);

    const snapshot=await exportStateSnapshot(admin,projectId);expect(snapshot.schema).toBe("hv-state/12");expect(snapshot.jobs).toHaveLength(1);expect(snapshot.jobs[0]!.executionCheckpoints).toEqual(film.executionCheckpoints!);expect(snapshot.projects.projects[0]!.currentScreenplay).toEqual(final.body.currentScreenplay!);expect(()=>validateSnapshot({...snapshot,schema:"hv-state/11"})).toThrow("schema 12");
    const archive=join(root,"current.zip"),prepared=join(root,"prepared"),unpacked=join(root,"unpacked"),exported=await exportProjectArchive(admin,projectId,prepared,archive);expect(exported.jobs).toBe(1);expect(readStateSnapshot(prepared)).toEqual(snapshot);
    await control.sql.unsafe('CREATE DATABASE "'+restoreName+'"');created.push(restoreName);restored=new StudioDatabase(databaseUrl(process.env.HV_PG_ADMIN_URL!,restoreName));await restored.migrate();
    try{process.env.HV_S3_BUCKET=process.env.HV_S3_FLEET_TEST_BUCKET;const imported=await importProjectArchive(restored,archive,unpacked,500);expect(imported.archiveSha256).toBe(exported.archiveSha256);expect(imported.mediaFiles).toBeGreaterThan(0);expect(imported.mediaBytes).toBeGreaterThan(0);}finally{process.env.HV_S3_BUCKET=bucket;}
    expect(readStateSnapshot(unpacked)).toEqual(snapshot);expect(readFileSync(join(unpacked,"state/projects.json")).equals(readFileSync(join(prepared,"state/projects.json")))).toBe(true);
    await clearObjects(sourceClient,projectId);expect((await sourceClient.list({prefix:"v1/"+projectId+"/",maxKeys:1})).contents??[]).toHaveLength(0);
    const originalDirectory=realpathSync(join(studio.paths.artifactRoot,projectId,film.id)),ownedDirectory=realpathSync(join(studio.paths.artifactRoot,projectId))+sep;if(!originalDirectory.startsWith(ownedDirectory)||!originalDirectory.startsWith(root+sep))throw new Error("Unsafe original fixture media removal");rmSync(originalDirectory,{recursive:true});
    const independentRoot=join(root,"independent");expect(existsSync(independentRoot)).toBe(false);const independent=new PostgresArtifactStore(restored,independentRoot,destinationClient),restoredFilm=(await new PostgresJobStore(restored).forProject(projectId).get(film.id))!;await independent.restoreCheckpoint(restoredFilm);
    expect(readFileSync(join(independentRoot,film.output!.mp4Path)).equals(expectedMp4)).toBe(true);for(const record of source.files){expect(await independent.fileInfo(projectId,film.id,record.path)).toEqual(record);expect(readFileSync(join(independentRoot,record.path)).equals(readFileSync(join(unpacked,"artifacts",record.path)))).toBe(true);}
    const measured=await inspectEditSource(restoredFilm,source.facts.label,independentRoot,async()=>{},undefined,independent,path=>independent.fileInfo(projectId!,film.id,path));expect(measured).toEqual(source);
    const restoredProjects=new PostgresProjectService(restored),retained=(await restoredProjects.peekProject(projectId))!;expect(retained.currentScreenplay).toEqual(final.body.currentScreenplay!);expect(retained.versions.history()).toEqual(final.body.versions);expect(currentCasting(projectId,retained.castingHistory)).toEqual(receipt.state.casting.candidate!);
    const beforeRetry=(await restored.sql`select body,version from hv_projects where id=${projectId}`)[0];expect((await restoredProjects.acceptCurrentScreenplayProposal(owner.token,acceptance,0))!.replayed).toBe(true);expect((await restored.sql`select body,version from hv_projects where id=${projectId}`)[0]).toEqual(beforeRetry);
    const next=proposal(retained.currentScreenplay,"after-restore","A second forward revision after independent restore.\n"),nextSaved=(await restoredProjects.saveCurrentScreenplayProposal(owner.token,next,retained.currentScreenplay.version))!;
    expect(nextSaved.proposal.candidate!.context.plan.document.context.base.text).toContain("A second forward revision after independent restore.");expect(nextSaved.proposal.request.expectedHeadRevision).toBe(receipt.revision);expect((await restoredProjects.peekProject(projectId))!.versions.history()).toEqual(final.body.versions);expect((await exportStateSnapshot(restored,projectId)).schema).toBe("hv-state/12");
  }finally{
    if(bucket===undefined)delete process.env.HV_S3_BUCKET;else process.env.HV_S3_BUCKET=bucket;
    if(projectId)for(const client of [sourceClient,destinationClient])await clearObjects(client,projectId);
    await api?.close();await admin?.close();await restored?.close();for(const name of created)await control.sql.unsafe('DROP DATABASE "'+databaseName(name)+'" WITH (FORCE)');await control.close();await studio?.close(false);cleanup(root);
  }
},300000);
