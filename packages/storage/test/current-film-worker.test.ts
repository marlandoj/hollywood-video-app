import {expect,spyOn,test} from "bun:test";
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import type {PersistedProject} from "../../api/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {createProviderPlan} from "../../generator/src/catalog";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {DeterministicMockProvider,RichAnimaticProvider,type VideoClip} from "../../generator/src/index";
import {currentCasting} from "../../planner/src/casting";
import {currentDirection} from "../../planner/src/direction";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {bootstrapLivingScriptDocument,compileLivingScriptDocument} from "../../planner/src/living-script-document";
import {bootstrapLivingScriptShotPlan} from "../../planner/src/living-script-shot-plan";
import {createLivingScriptStructureBase,compileLivingScriptStructure,livingScriptStructureBoundary} from "../../planner/src/living-script-structure";
import {proposeShotPlanEvolution} from "../../planner/src/living-script-current-plan";
import {createCurrentDirectionRequest} from "../../planner/src/living-script-current-direction";
import {currentScreenplayHead} from "../../planner/src/current-screenplay-library";
import {compileCurrentFilmJob} from "../../planner/src/current-film-jobs";
import {createCurrentFilmPreviewReview,currentFilmRecordedFiles,validateCurrentFilmClips,validateCurrentFilmOutput} from "../../planner/src/current-film-job-context";
import {LeaseError,type Job,type JobInput} from "../../queue/src/index";
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
function databaseName(name:string):string {if(!/^hv_current_worker_[a-f0-9]{32}$/.test(name))throw new Error("Unsafe current-film fixture database");return name;}
function databaseUrl(value:string,name:string):string {const url=new URL(value);url.pathname="/"+databaseName(name);return url.href;}
function files(root:string):string[] {return readdirSync(root,{withFileTypes:true}).flatMap(entry=>{if(entry.isSymbolicLink())throw new Error("Fixture media cannot contain links");const path=join(root,entry.name);if(entry.isDirectory())return files(path);if(!entry.isFile())throw new Error("Fixture media must be regular files");return [path];});}
function removeOwned(path:string,root:string):void {if(!existsSync(path))return;const actual=realpathSync(path);if(actual!==path||!actual.startsWith(root+sep))throw new Error("Unsafe current-film fixture media removal");rmSync(actual,{recursive:true,force:true});}
function cleanup(root:string):void {if(!root.startsWith(realpathSync(tmpdir())+sep+"hv-current-worker-pg-")||realpathSync(root)!==root)throw new Error("Unsafe current-film fixture cleanup");rmSync(root,{recursive:true,force:true});}
async function clearObjects(client:ReturnType<typeof objectClient>,projectId:string):Promise<void> {const prefix="v1/"+projectId+"/";for(let page=0;page<100;page++){const entries=(await client.list({prefix,maxKeys:1000})).contents??[];if(!entries.length)return;for(const entry of entries){if(!entry.key.startsWith(prefix))throw new Error("Fixture object escaped its project");await client.file(entry.key).delete();}}throw new Error("Fixture object cleanup exceeded its bound");}

(enabled?test:test.skip)("actual PostgreSQL V2 film has atomic admission, fenced speech checkpoints and independent schema-twelve S3 recovery",async()=>{
  const root=realpathSync(mkdtempSync(join(realpathSync(tmpdir()),"hv-current-worker-pg-"))),sourceName=databaseName("hv_current_worker_"+crypto.randomUUID().replaceAll("-","")),restoreName=databaseName("hv_current_worker_"+crypto.randomUUID().replaceAll("-",""));
  const control=new StudioDatabase(process.env.HV_PG_ADMIN_URL!),created:string[]=[],bucket=process.env.HV_S3_BUCKET,sourceClient=objectClient(),destinationClient=objectClient({...process.env,HV_S3_BUCKET:process.env.HV_S3_FLEET_TEST_BUCKET});
  let studio:Awaited<ReturnType<typeof dubStudio>>|undefined,admin:StudioDatabase|undefined,api:StudioDatabase|undefined,worker:StudioDatabase|undefined,restored:StudioDatabase|undefined,projectId:string|undefined;
  try{
    expect(bucket).not.toBe(process.env.HV_S3_FLEET_TEST_BUCKET);const studioRoot=join(root,"studio");mkdirSync(studioRoot);
    studio=await dubStudio(studioRoot,"INT. FIRST - DAY\nSpud waves.\n\nSPUD\nWelcome, friend.\nCome inside.\n\nINT. SECOND - NIGHT\nSpud opens a gate.\n\nSPUD\nThe garden is ready.\n");projectId=studio.owner.projectId;
    const original=(JSON.parse(readFileSync(studio.paths.queuePath,"utf8")) as Job[]).find(job=>job.id===studio!.film.id)!,originalBytes=readFileSync(join(studio.paths.artifactRoot,original.output!.mp4Path));
    const source=await inspectEditSource(original,"Current-film retained original",studio.paths.artifactRoot,async()=>{}),project=studio.projects.snapshot().projects[0]!,script=project.versions.at(-1)!;
    const base=createLivingScriptStructureBase({projectId,version:script.version,text:script.text,locks:[]}),documentSource=bootstrapLivingScriptDocument(source,{base,ancestry:[]});
    const origin=studio.projects.bootstrapCurrentScreenplay(studio.owner.token,{id:"worker-origin",label:"Current-film original",script,source,documentSource,originalPlan:bootstrapLivingScriptShotPlan(source,documentSource),baseline:{casting:currentCasting(projectId,project.castingHistory),direction:currentDirection(projectId,project.directionHistory)}},0,{binding:bindOriginalEditSource(source),current:original})!;
    const head=currentScreenplayHead(origin.library)!,context=head.state.context,patch=compileLivingScriptStructure(base,{baseRevision:base.revision,operations:[{id:"insert-scene",kind:"insert",at:livingScriptStructureBoundary(base,1),text:"EXT. NEW - NIGHT\nA blue lantern glows.\n\n"}]}),afterDocument=compileLivingScriptDocument({base:patch.after,ancestry:[patch]}),capacity={tier:"free" as const,maxShots:24 as const};
    const evolution=proposeShotPlanEvolution({previous:context.plan,lineage:context.lineage,originals:context.originals,beforeDocument:context.plan.document,afterDocument,capacity,requestId:"worker-evolution"});expect(evolution.review.conflicts).toEqual([]);
    const saved=studio.projects.saveCurrentScreenplayProposal(studio.owner.token,{id:"worker-pending",label:"New scene before retained scenes",expectedHeadRevision:head.revision,beforeStateRevision:head.state.revision,afterDocument,planRequest:evolution.request,capacity,directionRequest:createCurrentDirectionRequest(head.state.direction,evolution.review.candidate!,{id:"worker-direction",settings:[],lines:[],retired:[]})},origin.library.version)!;
    const plan=compileCurrentFilmJob(saved.library,{kind:"proposal",revision:saved.proposal.revision},{role:"preview",tier:"free",providerPlan:createProviderPlan("animatic",5)}),opaque=plan.materialization.slots.find(slot=>slot.original===null)!.renderId;
    expect(opaque).toMatch(/^shot-v2-[a-f0-9]{40}$/);expect(plan.materialization.script.text).not.toBe(script.text);
    await control.sql.unsafe('CREATE DATABASE "'+sourceName+'"');created.push(sourceName);admin=new StudioDatabase(databaseUrl(process.env.HV_PG_ADMIN_URL!,sourceName));await admin.migrate();
    const initial:StateSnapshot={schema:"hv-state/12",projects:studio.projects.snapshot(),jobs:[original],ledger:JSON.parse(readFileSync(studio.paths.costLedgerPath,"utf8")),reviews:[]};validateSnapshot(initial);await importStateSnapshot(admin,initial,500);
    const originalMedia=new PostgresArtifactStore(admin,studio.paths.artifactRoot,sourceClient);expect((await originalMedia.importCompletedJob(original,files(join(studio.paths.artifactRoot,projectId,original.id)))).files).toBeGreaterThan(0);
    api=new StudioDatabase(databaseUrl(process.env.HV_API_DATABASE_URL!,sourceName));worker=new StudioDatabase(databaseUrl(process.env.HV_WORKER_DATABASE_URL!,sourceName));
    const projects=new PostgresProjectService(api),ledger=new PostgresCostLedger(worker),workerContext={projects,ledger,reviewQueue:new PostgresReviewQueue(worker)};
    const row=async()=>{const value=(await admin!.sql`select body,version from hv_projects where id=${projectId!}`)[0];return {body:value.body as PersistedProject,version:Number(value.version)};};
    const counts=async()=>{const value=(await admin!.sql`select (select count(*) from hv_jobs where project_id=${projectId!}) as jobs,(select count(*) from hv_cost_events where project_id=${projectId!}) as costs,(select count(*) from hv_provider_attempts where project_id=${projectId!}) as attempts,(select count(*) from hv_reservations where job_id in (select id from hv_jobs where project_id=${projectId!})) as holds,(select count(*) from hv_outbox where project_id=${projectId!}) as events`)[0];return [value.jobs,value.costs,value.attempts,value.holds,value.events].map(Number);};
    const input=(retries:number,jobPlan=plan):JobInput=>({id:crypto.randomUUID(),projectId:projectId!,idempotencyKey:crypto.randomUUID(),tier:jobPlan.render.tier,stage:jobPlan.render.stage,scriptVersion:jobPlan.materialization.script.version,scriptText:jobPlan.materialization.script.text,casting:jobPlan.target.state.casting.candidate!,providerPlan:jobPlan.render.providerPlan,currentFilm:jobPlan,rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:jobPlan.materialization.requestedFrames,costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:retries,backoffMs:0},timeoutMs:300000});
    const before=await row(),beforeCounts=await counts(),request=input(1);
    await admin.sql`update hv_projects set body=${{...before.body,rightsAttestedAt:null}}::jsonb where id=${projectId}`;
    try{await expect(ledger.admit(projectId,request,500)).rejects.toThrow(/rights/);expect(await counts()).toEqual(beforeCounts);}finally{await admin.sql`update hv_projects set body=${before.body}::jsonb where id=${projectId}`;}
    const stale={...before.body,versions:before.body.versions.map((version,index)=>index===before.body.versions.length-1?{...version,text:version.text+"\nAn external screenplay change."}:version)};
    await admin.sql`update hv_projects set body=${stale}::jsonb where id=${projectId}`;
    try{await expect(ledger.admit(projectId,request,500)).rejects.toThrow();expect(await counts()).toEqual(beforeCounts);}finally{await admin.sql`update hv_projects set body=${before.body}::jsonb where id=${projectId}`;}
    await expect(ledger.admit(crypto.randomUUID(),request,500)).rejects.toThrow();expect(await counts()).toEqual(beforeCounts);
    const admissions=await Promise.all([ledger.admit(projectId,request,500),ledger.admit(projectId,{...request,id:crypto.randomUUID()},500)]);expect(admissions[0]!.id).toBe(admissions[1]!.id);const jobId=admissions[0]!.id;
    const admitted=await counts();expect(admitted[0]).toBe(beforeCounts[0]!+1);expect(admitted[3]).toBe(beforeCounts[3]!+1);expect(admitted[4]).toBe(beforeCounts[4]!+1);
    const reservation=(await admin.sql`select * from hv_reservations where job_id=${jobId}`)[0],initialJob=admissions[0]!;
    expect((await ledger.admit(projectId,{...request,id:crypto.randomUUID()},500))).toEqual(initialJob);expect((await admin.sql`select * from hv_reservations where job_id=${jobId}`)[0]).toEqual(reservation);expect(await counts()).toEqual(admitted);expect(await row()).toEqual(before);
    await expect(ledger.admit(projectId,{...request,costCapUsd:4},500)).rejects.toThrow();expect(await counts()).toEqual(admitted);

    const firstRoot=join(root,"first"),firstMedia=new PostgresArtifactStore(worker,firstRoot,sourceClient),firstStore=new PostgresJobStore(worker).forProject(projectId),begin=ledger.beginAttempt.bind(ledger);
    let dispatchChecked=false,checkpointed=false,savedPrefix:Job|undefined;
    const dispatch=spyOn(ledger,"beginAttempt").mockImplementation(async(...args:Parameters<typeof begin>)=>{
      if(dispatchChecked)return begin(...args);dispatchChecked=true;const attempt=args[0],beforeAttempt=await counts();
      await expect(begin({...attempt,leaseVersion:attempt.leaseVersion+1})).rejects.toBeInstanceOf(LeaseError);expect(await counts()).toEqual(beforeAttempt);
      await admin!.sql`update hv_projects set body=${{...before.body,rightsAttestedAt:null}}::jsonb where id=${projectId!}`;
      try{await expect(begin(...args)).rejects.toThrow(/rights/);expect(await counts()).toEqual(beforeAttempt);}finally{await admin!.sql`update hv_projects set body=${before.body}::jsonb where id=${projectId!}`;}
      const attempts=await Promise.allSettled([begin(...args),begin(...args)]);expect(attempts.filter(value=>value.status==="fulfilled")).toHaveLength(1);expect(attempts.filter(value=>value.status==="rejected")).toHaveLength(1);expect((await counts())[2]).toBe(beforeAttempt[2]!+1);
    });
    const checkpoint=firstMedia.checkpoint.bind(firstMedia),interrupt=spyOn(firstMedia,"checkpoint").mockImplementation(async(...args:Parameters<typeof checkpoint>)=>{
      if(checkpointed)return checkpoint(...args);const beforeCheckpoint=(await firstStore.get(jobId))!,checkpointCounts=await counts();
      await expect(checkpoint({...args[0],leaseVersion:args[0].leaseVersion!+1},...args.slice(1) as Parameters<typeof checkpoint> extends [Job,...infer Rest]?Rest:never)).rejects.toBeInstanceOf(LeaseError);
      expect(await firstStore.get(jobId)).toEqual(beforeCheckpoint);expect(await counts()).toEqual(checkpointCounts);
      await checkpoint(...args);savedPrefix=(await firstStore.get(jobId))!;checkpointed=true;throw new Error("Injected loss after durable current-film prefix");
    });
    let paused:Job;
    try{paused=(await processNextJob(firstStore,firstRoot,{...workerContext,artifacts:firstMedia,workerId:"current-first"}))!;}finally{interrupt.mockRestore();dispatch.mockRestore();}
    expect(dispatchChecked).toBe(true);expect(checkpointed).toBe(true);expect(paused!.id).toBe(jobId);expect(paused!.status).toBe("queued");expect(paused!.checkpointShots).toBe(1);expect(paused!.currentFilmCheckpoint!.rows[0]!.renderId).toBe(opaque);expect(existsSync(join(firstRoot,projectId,jobId))).toBe(false);await expect(exportStateSnapshot(admin,projectId)).rejects.toThrow("drained");
    const secondRoot=join(root,"resumed"),secondMedia=new PostgresArtifactStore(worker,secondRoot,sourceClient),secondStore=new PostgresJobStore(worker).forProject(projectId);
    await secondMedia.restoreCheckpoint(paused!);const prefix=JSON.parse(readFileSync(join(secondRoot,projectId,jobId,"clips/manifest.json"),"utf8")) as VideoClip[],prefixBytes=readFileSync(prefix[0]!.path);
    expect(validateCurrentFilmClips(paused!,prefix)).toEqual(paused!.currentFilmCheckpoint!);
    const generate=RichAnimaticProvider.prototype.generate,calls:string[]=[],provider=spyOn(RichAnimaticProvider.prototype,"generate").mockImplementation(function(this:RichAnimaticProvider,...args:Parameters<typeof generate>){calls.push(args[2].shotId!);return generate.apply(this,args);});
    let completionChecked=false,done:Job;const complete=secondStore.complete.bind(secondStore),completion=spyOn(secondStore,"complete").mockImplementation(async(...args:Parameters<typeof complete>)=>{
      const beforeFinish=(await secondStore.get(jobId))!,file=args[2].currentFilm!.records[0]!.record.files.video;
      await admin!.sql`update hv_artifacts set bytes=bytes+1 where key=${file.path}`;
      try{await expect(complete(...args)).rejects.toThrow("exact published current-film media");expect(await secondStore.get(jobId)).toEqual(beforeFinish);}finally{await admin!.sql`update hv_artifacts set bytes=${file.bytes} where key=${file.path}`;}
      const results=await Promise.allSettled([complete(...args),complete(...args)]);expect(results.filter(value=>value.status==="fulfilled")).toHaveLength(1);expect(results.filter(value=>value.status==="rejected")).toHaveLength(1);completionChecked=true;const result=results.find(value=>value.status==="fulfilled");if(!result||result.status!=="fulfilled")throw new Error("Current-film completion did not commit");return result.value;
    });
    try{done=(await processNextJob(secondStore,secondRoot,{...workerContext,artifacts:secondMedia,workerId:"current-resumed"}))!;}finally{provider.mockRestore();completion.mockRestore();}
    expect(done!.failureReason??done!.cancelReason).toBeUndefined();expect(done!.status).toBe("done");expect(completionChecked).toBe(true);expect(done!.retriesUsed).toBe(1);expect(done!.startedAt).toBe(savedPrefix!.startedAt);expect(done!.currentFilmCheckpoint!.rows[0]).toEqual(savedPrefix!.currentFilmCheckpoint!.rows[0]);
    expect(calls).not.toContain(opaque);expect([...new Set(calls)]).toEqual(plan.materialization.slots.slice(1).map(slot=>slot.renderId));expect(done!.executionCheckpoints).toBeUndefined();expect(done!.output!.shotExecutions).toBeUndefined();validateCurrentFilmOutput(done!,done!.output!);
    expect(done!.output!.currentFilm!.assembly.reason).toBe("measured-speech");expect(done!.output!.currentFilm!.assembly.frames).toBe(done!.checkpointFrame);expect(done!.output!.currentFilm!.assembly.probe.audio.sampleRate).toBe(44100);expect(done!.currentFilmCheckpoint!.rows.some(value=>value.record.clip.speech?.lines.length)).toBe(true);
    await secondMedia.restoreCheckpoint(done!);expect(readFileSync(prefix[0]!.path)).toEqual(prefixBytes);const exportedBytes=readFileSync(join(secondRoot,done!.output!.mp4Path));
    expect(contentHash((await secondStore.get(jobId))!.currentFilmCheckpoint)).toBe(contentHash(done!.currentFilmCheckpoint));expect(await row()).toEqual(before);expect(await ledger.monthSpend()).toBe(0);
    for(const path of [join(secondRoot,projectId,jobId,"clips/manifest.json"),join(secondRoot,done!.output!.manifestPath)]){expect(readFileSync(path,"utf8")).not.toContain("hv-shot-execution-capture/1");expect(readFileSync(path,"utf8")).not.toContain("hv-current-film-job/2");}
    await expect(firstStore.complete(jobId,"current-first",done!.output!)).rejects.toBeInstanceOf(LeaseError);

    // An exact lost-response retry remains historical; fresh dispatch still requires rights.
    const withheld=input(0),withheldJob=await ledger.admit(projectId,withheld,500);await admin.sql`update hv_projects set body=${{...before.body,rightsAttestedAt:null}}::jsonb where id=${projectId}`;
    const withheldCounts=await counts(),noDispatch=spyOn(RichAnimaticProvider.prototype,"generate");
    try{expect((await ledger.admit(projectId,{...withheld,id:crypto.randomUUID()},500)).id).toBe(withheldJob.id);expect(await counts()).toEqual(withheldCounts);
      const refused=(await processNextJob(new PostgresJobStore(worker).forProject(projectId),secondRoot,{...workerContext,artifacts:secondMedia,workerId:"current-withheld"}))!;expect(refused.id).toBe(withheldJob.id);expect(refused.status).toBe("failed");expect(refused.checkpointShots).toBe(0);expect(noDispatch).not.toHaveBeenCalled();expect((await counts()).slice(1,3)).toEqual(withheldCounts.slice(1,3));
    }finally{noDispatch.mockRestore();await admin.sql`update hv_projects set body=${before.body}::jsonb where id=${projectId}`;}
    const failedRequest=input(0),failedJob=await ledger.admit(projectId,failedRequest,500),save=secondMedia.checkpoint.bind(secondMedia),terminal=spyOn(secondMedia,"checkpoint").mockImplementation(async(...args:Parameters<typeof save>)=>{await save(...args);throw new Error("Injected terminal loss after durable V2 prefix");});
    let failed:Job;try{failed=(await processNextJob(new PostgresJobStore(worker).forProject(projectId),secondRoot,{...workerContext,artifacts:secondMedia,workerId:"current-terminal"}))!;}finally{terminal.mockRestore();}
    expect(failed!.id).toBe(failedJob.id);expect(failed!.status).toBe("failed");expect(failed!.checkpointShots).toBe(1);expect(failed!.currentFilmCheckpoint!.rows[0]!.capture).toBeDefined();expect(failed!.output).toBeUndefined();
    const review=createCurrentFilmPreviewReview(done!),reviewCounts=await counts(),decision=()=>projects.recordCurrentFilmDecision(studio!.owner.token,done!,review,"approved","Use this complete pending film");
    const decisions=await Promise.all([decision(),decision()]);expect(decisions.map(value=>value!.replayed).sort()).toEqual([false,true]);expect(decisions[0]!.approval).toEqual(decisions[1]!.approval);
    const approved=await row();expect(approved.version).toBe(before.version+1);expect(approved.body.versions).toEqual(before.body.versions);expect(approved.body.currentScreenplay).toEqual(before.body.currentScreenplay);expect(approved.body.animaticApprovals.find(value=>value.animaticJobId===jobId)!.currentFilmReview).toEqual(review);expect(await counts()).toEqual(reviewCounts);
    expect((await decision())!.replayed).toBe(true);expect(await row()).toEqual(approved);expect(await projects.recordCurrentFilmDecision("invalid",done!,review,"approved","Use this complete pending film")).toBeNull();
    const reviewedFile=currentFilmRecordedFiles(done!)[0]!;await admin.sql`update hv_artifacts set bytes=bytes+1 where key=${reviewedFile.path}`;
    try{await expect(decision()).rejects.toThrow("preview artifacts changed");expect(await row()).toEqual(approved);expect(await counts()).toEqual(reviewCounts);}finally{await admin.sql`update hv_artifacts set bytes=${reviewedFile.bytes} where key=${reviewedFile.path}`;}
    await admin.sql`update hv_projects set body=${{...approved.body,rightsAttestedAt:null}}::jsonb where id=${projectId}`;
    try{await expect(decision()).rejects.toThrow(/rights/);expect(await counts()).toEqual(reviewCounts);}finally{await admin.sql`update hv_projects set body=${approved.body}::jsonb where id=${projectId}`;}
    // The final is a separate, real provider/assembler execution authorized by this exact
    // saved V2 preview, with its own crossfade clock and no screenplay publication.
    const render=compileCurrentFilmJob(plan.library,plan.selector,{...plan.request,role:"render",providerPlan:createProviderPlan("final",5,undefined,{...process.env,HV_PROVIDER_POOL:'["mock"]'})});
    const finalRequest={...input(0,render),animaticJobId:done!.id,animaticApprovedAt:decisions[0]!.approval.at},oldPool=process.env.HV_PROVIDER_POOL;
    const finalRoot=join(root,"final"),finalMedia=new PostgresArtifactStore(worker,finalRoot,sourceClient),finalStore=new PostgresJobStore(worker).forProject(projectId);let final:Job,finalDispatchChecked=false,finalPublishChecked=false;
    const unapproved={...approved.body,animaticApprovals:approved.body.animaticApprovals.filter(value=>value.animaticJobId!==done!.id)},beforeFinal=await counts();
    await admin.sql`update hv_projects set body=${unapproved}::jsonb where id=${projectId}`;
    try{await expect(ledger.admit(projectId,finalRequest,500)).rejects.toThrow(/approval|preview/);expect(await counts()).toEqual(beforeFinal);}finally{await admin.sql`update hv_projects set body=${approved.body}::jsonb where id=${projectId}`;}
    process.env.HV_PROVIDER_POOL='["mock"]';
    try{
      const admittedFinals=await Promise.all([ledger.admit(projectId,finalRequest,500),ledger.admit(projectId,{...finalRequest,id:crypto.randomUUID()},500)]);expect(admittedFinals[0]!.id).toBe(admittedFinals[1]!.id);const finalId=admittedFinals[0]!.id,finalAdmissionCounts=await counts();
      expect(finalAdmissionCounts[0]).toBe(beforeFinal[0]!+1);expect(finalAdmissionCounts[3]).toBe(beforeFinal[3]!+1);expect((await ledger.admit(projectId,{...finalRequest,id:crypto.randomUUID()},500)).id).toBe(finalId);expect(await counts()).toEqual(finalAdmissionCounts);
      const finalBegin=ledger.beginAttempt.bind(ledger),heldFinal=spyOn(ledger,"beginAttempt").mockImplementation(async(...args:Parameters<typeof finalBegin>)=>{
        if(!finalDispatchChecked){const beforeAttempt=await counts();await admin!.sql`update hv_projects set body=${unapproved}::jsonb where id=${projectId!}`;
          try{await expect(finalBegin(...args)).rejects.toThrow(/approval|preview/);expect(await counts()).toEqual(beforeAttempt);}finally{await admin!.sql`update hv_projects set body=${approved.body}::jsonb where id=${projectId!}`;}finalDispatchChecked=true;}
        return finalBegin(...args);
      });
      const publish=finalMedia.publishExport.bind(finalMedia),heldPublish=spyOn(finalMedia,"publishExport").mockImplementation(async(...args:Parameters<typeof publish>)=>{
        const beforePublish=(await finalStore.get(finalId))!,publishCounts=await counts();await admin!.sql`update hv_projects set body=${unapproved}::jsonb where id=${projectId!}`;
        try{await expect(publish(...args)).rejects.toThrow(/approval|preview/);expect(await finalStore.get(finalId)).toEqual(beforePublish);expect(await counts()).toEqual(publishCounts);}finally{await admin!.sql`update hv_projects set body=${approved.body}::jsonb where id=${projectId!}`;}
        finalPublishChecked=true;await publish(...args);
      });
      const mockGenerate=DeterministicMockProvider.prototype.generate,finalCalls:string[]=[],mock=spyOn(DeterministicMockProvider.prototype,"generate").mockImplementation(function(this:DeterministicMockProvider,...args:Parameters<typeof mockGenerate>){finalCalls.push(args[2].shotId!);return mockGenerate.apply(this,args);});
      try{final=(await processNextJob(finalStore,finalRoot,{...workerContext,artifacts:finalMedia,workerId:"current-final"}))!;}finally{heldFinal.mockRestore();heldPublish.mockRestore();mock.mockRestore();}
      expect(final!.id).toBe(finalId);expect(final!.failureReason??final!.cancelReason).toBeUndefined();expect(final!.status).toBe("done");expect(finalDispatchChecked).toBe(true);expect(finalPublishChecked).toBe(true);expect([...new Set(finalCalls)]).toEqual(render.materialization.slots.map(slot=>slot.renderId));
      validateCurrentFilmOutput(final!,final!.output!);expect(final!.output!.currentFilm!.assembly).toMatchObject({requestedOverlapFrames:15,effectiveOverlapFrames:15,reason:"requested-crossfade"});expect(final!.output!.currentFilm!.assembly.frames).toBe(final!.checkpointFrame-15*(render.materialization.slots.length-1));expect(final!.costUsd).toBe(0);expect(await ledger.monthSpend()).toBe(0);expect(await row()).toEqual(approved);
      await finalMedia.restoreCheckpoint(final!);
    }finally{if(oldPool===undefined)delete process.env.HV_PROVIDER_POOL;else process.env.HV_PROVIDER_POOL=oldPool;}
    const finalBytes=readFileSync(join(finalRoot,final!.output!.mp4Path));
    const snapshot=await exportStateSnapshot(admin,projectId);expect(snapshot.schema).toBe("hv-state/12");expect(snapshot.jobs.filter(job=>job.currentFilm)).toHaveLength(4);expect(snapshot.projects.projects[0]!.versions).toEqual(before.body.versions);expect(snapshot.projects.projects[0]!.currentScreenplay).toEqual(before.body.currentScreenplay!);expect(()=>validateSnapshot({...snapshot,schema:"hv-state/11"})).toThrow("schema 12");
    const archive=join(root,"current-worker.zip"),prepared=join(root,"prepared"),unpacked=join(root,"unpacked"),exported=await exportProjectArchive(admin,projectId,prepared,archive);expect(exported.jobs).toBe(5);expect(readStateSnapshot(prepared)).toEqual(snapshot);
    await control.sql.unsafe('CREATE DATABASE "'+restoreName+'"');created.push(restoreName);restored=new StudioDatabase(databaseUrl(process.env.HV_PG_ADMIN_URL!,restoreName));await restored.migrate();
    try{process.env.HV_S3_BUCKET=process.env.HV_S3_FLEET_TEST_BUCKET;const imported=await importProjectArchive(restored,archive,unpacked,500);expect(imported.archiveSha256).toBe(exported.archiveSha256);expect(imported.mediaFiles).toBeGreaterThan(0);expect(imported.mediaBytes).toBeGreaterThan(0);}finally{process.env.HV_S3_BUCKET=bucket;}
    expect(readStateSnapshot(unpacked)).toEqual(snapshot);expect(readFileSync(join(prepared,"state/projects.json"))).toEqual(readFileSync(join(unpacked,"state/projects.json")));
    await clearObjects(sourceClient,projectId);expect((await sourceClient.list({prefix:"v1/"+projectId+"/",maxKeys:1})).contents??[]).toHaveLength(0);
    for(const mediaRoot of [studio.paths.artifactRoot,firstRoot,secondRoot,finalRoot])removeOwned(join(mediaRoot,projectId),root);
    const independentRoot=join(root,"independent"),independent=new PostgresArtifactStore(restored,independentRoot,destinationClient),restoredJobs=new PostgresJobStore(restored).forProject(projectId);expect(existsSync(join(independentRoot,projectId))).toBe(false);
    for(const expected of [original,done!,failed!,final!]){const job=(await restoredJobs.get(expected.id))!;expect(job.currentFilm).toEqual(expected.currentFilm);expect(job.currentFilmCheckpoint).toEqual(expected.currentFilmCheckpoint);await independent.restoreCheckpoint(job);
      const retainedFiles=job.currentFilm?currentFilmRecordedFiles(job):source.files;
      for(const file of retainedFiles){expect(await independent.fileInfo(projectId,job.id,file.path)).toEqual(file);expect(readFileSync(join(independentRoot,file.path))).toEqual(readFileSync(join(unpacked,"artifacts",file.path)));}
      if(job.currentFilm){const clips=JSON.parse(readFileSync(join(independentRoot,projectId,job.id,"clips/manifest.json"),"utf8")) as VideoClip[];expect(validateCurrentFilmClips(job,clips)).toEqual(job.currentFilmCheckpoint!);if(job.output)validateCurrentFilmOutput(job,job.output);}
    }
    expect(readFileSync(join(independentRoot,original.output!.mp4Path))).toEqual(originalBytes);expect(readFileSync(join(independentRoot,done!.output!.mp4Path))).toEqual(exportedBytes);expect(readFileSync(join(independentRoot,final!.output!.mp4Path))).toEqual(finalBytes);
    const restoredProjects=new PostgresProjectService(restored),restoredProject=(await restoredProjects.peekProject(projectId))!;expect(restoredProject.versions.history()).toEqual(before.body.versions);expect(restoredProject.animaticApprovals.find(value=>value.animaticJobId===jobId)!.currentFilmReview).toEqual(review);
    const beforeReviewRetry=(await restored.sql`select body,version from hv_projects where id=${projectId}`)[0];expect((await restoredProjects.recordCurrentFilmDecision(studio.owner.token,(await restoredJobs.get(jobId))!,review,"approved","Use this complete pending film"))!.replayed).toBe(true);expect((await restored.sql`select body,version from hv_projects where id=${projectId}`)[0]).toEqual(beforeReviewRetry);
    // Corrupt or missing actual objects fail even when the database and sealed metadata agree.
    const restoredFailed=(await restoredJobs.get(failed!.id))!,file=currentFilmRecordedFiles(restoredFailed)[0]!,record=(await restored.sql`select object_key from hv_artifacts where project_id=${projectId} and job_id=${failed!.id} and key=${file.path}`)[0],object=destinationClient.file(String(record.object_key)),bytes=readFileSync(join(independentRoot,file.path));
    const restoreCounts=await restored.sql`select (select count(*) from hv_provider_attempts) as attempts,(select count(*) from hv_cost_events) as costs,(select count(*) from hv_outbox) as events`;
    try{await object.write(new Uint8Array(bytes.length));await expect(new PostgresArtifactStore(restored,join(root,"corrupt"),destinationClient).restoreCheckpoint(restoredFailed)).rejects.toThrow(/checksum/);
      await object.delete();await expect(new PostgresArtifactStore(restored,join(root,"missing"),destinationClient).restoreCheckpoint(restoredFailed)).rejects.toThrow();
    }finally{await object.write(bytes);}
    expect(await restored.sql`select (select count(*) from hv_provider_attempts) as attempts,(select count(*) from hv_cost_events) as costs,(select count(*) from hv_outbox) as events`).toEqual(restoreCounts);
    await new PostgresArtifactStore(restored,join(root,"repaired"),destinationClient).restoreCheckpoint(restoredFailed);expect((await exportStateSnapshot(restored,projectId)).schema).toBe("hv-state/12");
  }finally{
    if(bucket===undefined)delete process.env.HV_S3_BUCKET;else process.env.HV_S3_BUCKET=bucket;
    if(projectId)for(const client of [sourceClient,destinationClient])await clearObjects(client,projectId);
    await api?.close();await worker?.close();await admin?.close();await restored?.close();for(const name of created)await control.sql.unsafe('DROP DATABASE "'+databaseName(name)+'" WITH (FORCE)');await control.close();await studio?.close(false);cleanup(root);
  }
},480000);
