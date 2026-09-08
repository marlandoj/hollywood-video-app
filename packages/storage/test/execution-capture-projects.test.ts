import {expect,test,spyOn} from "bun:test";
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
import {exportStateSnapshot,validateSnapshot} from "../src/snapshots";
import {createProviderPlan} from "../../generator/src/catalog";
import {contentHash} from "../../generator/src/capabilities";
import {validateShotExecutionClips,validateShotExecutionOutput} from "../../planner/src/shot-execution-inventory";
import {LeaseError,type Job,type JobInput} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";

const enabled=Boolean(process.env.HV_PG_ADMIN_URL&&process.env.HV_API_DATABASE_URL&&process.env.HV_WORKER_DATABASE_URL&&process.env.HV_S3_ENDPOINT&&process.env.HV_S3_BUCKET&&process.env.HV_S3_FLEET_TEST_BUCKET);
function databaseName(name:string):string{if(!/^hv_capture_[a-f0-9]{32}$/.test(name))throw new Error("Unsafe capture fixture database");return name;}
function databaseUrl(value:string,name:string):string{const url=new URL(value);url.pathname="/"+databaseName(name);return url.href;}
function cleanup(root:string):void{if(!root.startsWith(realpathSync(tmpdir())+sep+"hv-capture-pg-")||realpathSync(root)!==root)throw new Error("Unsafe capture fixture cleanup");rmSync(root,{recursive:true,force:true});}
async function clearObjects(client:ReturnType<typeof objectClient>,projectId:string):Promise<void>{const prefix="v1/"+projectId+"/";for(let page=0;page<100;page++){const entries=(await client.list({prefix,maxKeys:1000})).contents??[];if(!entries.length)return;for(const entry of entries){if(!entry.key.startsWith(prefix))throw new Error("Fixture object escaped its project");await client.file(entry.key).delete();}}throw new Error("Fixture cleanup exceeded its bound");}

(enabled?test:test.skip)("actual worker captures survive fenced S3 resume, failed checkpoints and an independent schema-eleven archive",async()=>{
  const root=realpathSync(mkdtempSync(join(realpathSync(tmpdir()),"hv-capture-pg-"))),sourceName=databaseName("hv_capture_"+crypto.randomUUID().replaceAll("-","")),restoreName=databaseName("hv_capture_"+crypto.randomUUID().replaceAll("-",""));
  const control=new StudioDatabase(process.env.HV_PG_ADMIN_URL!),created:string[]=[],bucket=process.env.HV_S3_BUCKET,sourceClient=objectClient(),destinationClient=objectClient({...process.env,HV_S3_BUCKET:process.env.HV_S3_FLEET_TEST_BUCKET});
  const config={HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0"},previous=Object.fromEntries(Object.keys(config).map(key=>[key,process.env[key]]));
  let admin:StudioDatabase|undefined,api:StudioDatabase|undefined,worker:StudioDatabase|undefined,restored:StudioDatabase|undefined,projectId:string|undefined;
  try{
    Object.assign(process.env,config);
    expect(bucket).not.toBe(process.env.HV_S3_FLEET_TEST_BUCKET);
    await control.sql.unsafe('CREATE DATABASE "'+sourceName+'"');created.push(sourceName);admin=new StudioDatabase(databaseUrl(process.env.HV_PG_ADMIN_URL!,sourceName));await admin.migrate();
    api=new StudioDatabase(databaseUrl(process.env.HV_API_DATABASE_URL!,sourceName));worker=new StudioDatabase(databaseUrl(process.env.HV_WORKER_DATABASE_URL!,sourceName));
    const projects=new PostgresProjectService(api),owner=await projects.createAnonymousProject();projectId=owner.projectId;
    const script="INT. ROOM - DAY\nA lamp glows.\n\nINT. HALL - NIGHT\nA door opens.";await projects.editScript(owner.token,script);await projects.attestRights(owner.token);
    const plan=createProviderPlan("animatic",1,undefined,{HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0"}),ledger=new PostgresCostLedger(worker),context={projects,ledger,reviewQueue:new PostgresReviewQueue(worker)};
    const input=(retries:number):JobInput=>({id:crypto.randomUUID(),projectId:projectId!,idempotencyKey:crypto.randomUUID(),stage:"animatic",tier:"free",scriptVersion:1,scriptText:script,providerPlan:plan,totalFrames:120,retryPolicy:{maxRetries:retries,backoffMs:0},timeoutMs:120000,costCapUsd:1,budgetReservedUsd:0,rightsAttestedAt:new Date().toISOString(),animaticJobId:null,animaticApprovedAt:null});
    const originalInput=input(1);await ledger.admit(projectId,originalInput,500);
    const firstRoot=join(root,"first"),firstMedia=new PostgresArtifactStore(worker,firstRoot,sourceClient),firstStore=new PostgresJobStore(worker).forProject(projectId),checkpoint=firstMedia.checkpoint.bind(firstMedia);
    const body=async()=>{const row=(await admin!.sql`select body from hv_jobs where id=${originalInput.id}`)[0].body;const outbox=(await admin!.sql`select count(*)::int as count from hv_outbox where job_id=${originalInput.id}`)[0].count;return {row,outbox};};
    let saved:Job|undefined,interrupted=false;
    const stop=spyOn(firstMedia,"checkpoint").mockImplementation(async(...args:Parameters<typeof checkpoint>)=>{
      if(!interrupted){
        const before=await body();await expect(checkpoint({...args[0],leaseVersion:args[0].leaseVersion!+1},...args.slice(1) as Parameters<typeof checkpoint> extends [Job,...infer Rest]?Rest:never)).rejects.toBeInstanceOf(LeaseError);expect(await body()).toEqual(before);
        await checkpoint(...args);saved=(await firstStore.get(originalInput.id))!;expect(saved.executionCheckpoints).toHaveLength(1);expect(saved.executionCheckpoints![0]!.capture).not.toBeNull();interrupted=true;throw new Error("Injected process loss after durable execution capture");
      }
      await checkpoint(...args);
    });
    let paused:Job|null;
    try{paused=await processNextJob(firstStore,firstRoot,{...context,artifacts:firstMedia,workerId:"capture-first"});}finally{stop.mockRestore();}
    expect(paused!.status).toBe("queued");expect(paused!.checkpointShots).toBe(1);expect(existsSync(join(firstRoot,projectId,originalInput.id))).toBe(false);
    const secondRoot=join(root,"resumed"),secondMedia=new PostgresArtifactStore(worker,secondRoot,sourceClient),secondStore=new PostgresJobStore(worker).forProject(projectId);
    const done=(await processNextJob(secondStore,secondRoot,{...context,artifacts:secondMedia,workerId:"capture-resumed"}))!;
    expect(done.failureReason??done.cancelReason).toBeUndefined();expect(done.status).toBe("done");expect(done.resumedCount).toBe(1);expect(done.output!.shotExecutions).toHaveLength(2);expect(done.output!.shotExecutions![0]).toEqual(saved!.executionCheckpoints![0]);validateShotExecutionOutput(done,done.output!);
    await secondMedia.restoreCheckpoint(done);const clips=JSON.parse(readFileSync(join(secondRoot,projectId,done.id,"clips/manifest.json"),"utf8"));validateShotExecutionClips(done,clips);
    const exportedBytes=readFileSync(join(secondRoot,done.output!.mp4Path)),publicManifest=readFileSync(join(secondRoot,done.output!.manifestPath),"utf8"),clipManifest=JSON.stringify(clips);
    expect(publicManifest).not.toContain("hv-shot-execution-capture");expect(clipManifest).not.toContain("hv-shot-execution-capture");
    // PostgreSQL JSONB changes key order. Canonical evidence must remain identical.
    const persisted=(await secondStore.get(done.id))!;expect(contentHash(persisted.executionCheckpoints)).toBe(contentHash(done.executionCheckpoints));validateShotExecutionOutput(persisted,persisted.output!);

    const failedInput=input(0);await ledger.admit(projectId,failedInput,500);const failCheckpoint=secondMedia.checkpoint.bind(secondMedia);
    const fail=spyOn(secondMedia,"checkpoint").mockImplementation(async(...args:Parameters<typeof failCheckpoint>)=>{await failCheckpoint(...args);throw new Error("Injected terminal process failure after captured prefix");});
    let failed:Job|null;try{failed=await processNextJob(secondStore,secondRoot,{...context,artifacts:secondMedia,workerId:"capture-failed"});}finally{fail.mockRestore();}
    expect(failed!.status).toBe("failed");expect(failed!.checkpointShots).toBe(1);expect(failed!.executionCheckpoints![0]!.capture).not.toBeNull();expect(failed!.output).toBeUndefined();
    const snapshot=await exportStateSnapshot(admin,projectId);expect(snapshot.schema).toBe("hv-state/11");validateSnapshot(snapshot);expect(()=>validateSnapshot({...snapshot,schema:"hv-state/10"})).toThrow(/schema 11/);
    const archive=join(root,"capture.zip"),prepared=join(root,"prepared"),unpacked=join(root,"unpacked"),exported=await exportProjectArchive(admin,projectId,prepared,archive);
    await control.sql.unsafe('CREATE DATABASE "'+restoreName+'"');created.push(restoreName);restored=new StudioDatabase(databaseUrl(process.env.HV_PG_ADMIN_URL!,restoreName));await restored.migrate();
    try{process.env.HV_S3_BUCKET=process.env.HV_S3_FLEET_TEST_BUCKET;const imported=await importProjectArchive(restored,archive,unpacked,500);expect(imported.archiveSha256).toBe(exported.archiveSha256);}finally{process.env.HV_S3_BUCKET=bucket;}
    await clearObjects(sourceClient,projectId);expect((await sourceClient.list({prefix:"v1/"+projectId+"/",maxKeys:1})).contents??[]).toHaveLength(0);
    const independentRoot=join(root,"independent"),independent=new PostgresArtifactStore(restored,independentRoot,destinationClient),restoredJobs=new PostgresJobStore(restored).forProject(projectId);
    for(const expected of [done,failed!]){const job=(await restoredJobs.get(expected.id))!;expect(job.executionCheckpoints).toEqual(expected.executionCheckpoints);await independent.restoreCheckpoint(job);const restoredClips=JSON.parse(readFileSync(join(independentRoot,projectId,job.id,"clips/manifest.json"),"utf8"));validateShotExecutionClips(job,restoredClips);for(const clip of restoredClips)for(const file of Object.values(clip.renderRecord.files) as {path:string;sha256:string;bytes:number}[]){expect(await independent.fileInfo(projectId,job.id,file.path)).toEqual(file);expect(Buffer.compare(readFileSync(join(independentRoot,file.path)),readFileSync(join(unpacked,"artifacts",file.path)))).toBe(0);}}
    expect(Buffer.compare(readFileSync(join(independentRoot,done.output!.mp4Path)),exportedBytes)).toBe(0);
  }finally{
    if(bucket===undefined)delete process.env.HV_S3_BUCKET;else process.env.HV_S3_BUCKET=bucket;
    for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
    if(projectId)for(const client of [sourceClient,destinationClient])await clearObjects(client,projectId);
    await api?.close();await worker?.close();await admin?.close();await restored?.close();for(const name of created)await control.sql.unsafe('DROP DATABASE "'+databaseName(name)+'" WITH (FORCE)');await control.close();
    cleanup(root);
  }
},300000);
