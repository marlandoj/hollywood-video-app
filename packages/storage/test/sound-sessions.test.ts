import {afterAll,beforeAll,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import {StudioDatabase} from "../src/database";
import {PostgresJobStore} from "../src/jobs";
import {PostgresCostLedger} from "../src/ledger";
import {PostgresReviewQueue} from "../src/reviews";
import {PostgresArtifactStore,objectClient} from "../src/artifacts";
import {SoundBlobStore} from "../src/sound-assets";
import {PostgresRetention} from "../src/retention";
import {exportProjectArchive,importProjectArchive} from "../src/archives";
import {exportStateSnapshot,validateSnapshot} from "../src/snapshots";
import {createApiServer,type ApiServer} from "../../api/src/server";
import {processNextJob} from "../../queue/src/worker";
import {LeaseError} from "../../queue/src/index";
import {soundFixture,soundCue,SOUND_RIGHTS} from "../../../test/fixtures/sound";
import {soundAssetObjectKey} from "../../planner/src/sound-assets";
import {verifySoundMedia} from "../../generator/src/sound-media";
import {outputRevision} from "../../planner/src/dialogue-selection";
const enabled=Boolean(process.env.HV_PG_ADMIN_URL&&process.env.HV_API_DATABASE_URL&&process.env.HV_WORKER_DATABASE_URL&&process.env.HV_S3_ENDPOINT&&process.env.HV_S3_FLEET_TEST_BUCKET),pgtest=enabled?test:test.skip;
const envKeys=["HV_TOKEN_SECRET","HV_NARRATION","HV_ANIMATIC_CAPTIONS","HV_ANIMATIC_PROVIDER_POOL","HV_S3_BUCKET"],old=Object.fromEntries(envKeys.map(k=>[k,process.env[k]])),name="hv_sound_"+crypto.randomUUID().replaceAll("-","");
let admin:StudioDatabase,worker:StudioDatabase,restored:StudioDatabase,root:string,server:ApiServer;const ids:string[]=[],keys=new Set<string>();
const replica=()=>objectClient({...process.env,HV_S3_BUCKET:process.env.HV_S3_FLEET_TEST_BUCKET});
beforeAll(async()=>{if(!enabled)return;root=mkdtempSync(join(tmpdir(),"hv-sound-pg-"));Object.assign(process.env,{HV_TOKEN_SECRET:"postgres-sound-test-at-least-thirty-two-characters",HV_NARRATION:"1",HV_ANIMATIC_CAPTIONS:"0",HV_ANIMATIC_PROVIDER_POOL:'["mock"]'});
  admin=new StudioDatabase(process.env.HV_PG_ADMIN_URL!);worker=new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!);await admin.migrate();await admin.sql.unsafe('CREATE DATABASE "'+name+'"');const url=new URL(process.env.HV_PG_ADMIN_URL!);url.pathname="/"+name;restored=new StudioDatabase(url.href);await restored.migrate();
  server=createApiServer({port:0,hostname:"127.0.0.1",storage:"postgres",artifactStorage:"s3",databaseUrl:process.env.HV_API_DATABASE_URL,artifactRoot:join(root,"api"),rateLimit:{api:{limit:10000,windowMs:60000}}});
});
afterAll(async()=>{if(!enabled)return;await server?.stop(true);
  for(const db of [admin,restored])if(db)for(const id of ids)for(const row of await db.sql`select object_key from hv_artifacts where project_id=${id}`)keys.add(row.object_key);
  for(const key of keys){await objectClient().file(key).delete();await replica().file(key).delete();}
  for(const id of ids){await admin.sql`delete from hv_reservations where job_id in (select id from hv_jobs where project_id=${id})`;for(const table of ["hv_outbox","hv_artifacts","hv_archives","hv_reviews","hv_operator_reviews","hv_cost_events","hv_provider_attempts","hv_jobs","hv_projects"])await admin.sql.unsafe('delete from "'+table+'" where '+(table==="hv_projects"?'id':'project_id')+'=$1',[id]);}
  await worker?.close();await restored?.close();await admin.sql.unsafe('DROP DATABASE "'+name+'" WITH (FORCE)');await admin.close();for(const [k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  if(!resolve(root).startsWith(resolve(tmpdir())+sep+"hv-sound-pg-"))throw new Error("Unexpected sound test root");rmSync(root,{recursive:true,force:true});
});
const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
pgtest("sound sessions resume verified S3 checkpoints, conserve admission, restore alone and enforce library revocation",async()=>{
  const owner=await(await call("/api/projects","POST")).json() as any;ids.push(owner.projectId);const base="/api/projects/"+owner.projectId;
  expect((await call(base+"/script","PUT",{text:"INT. GARDEN - DAY\n\nMarla waves.\n\nMARLA\nWelcome home."},owner.token)).status).toBe(200);expect((await call(base+"/rights","POST",{attested:true},owner.token)).status).toBe(200);
  const queue=new PostgresJobStore(worker).forProject(owner.projectId),ledger=new PostgresCostLedger(worker),aRoot=join(root,"first"),bRoot=join(root,"resumed"),a=new PostgresArtifactStore(worker,aRoot),b=new PostgresArtifactStore(worker,bRoot),context={ledger,reviewQueue:new PostgresReviewQueue(worker)};
  expect((await call(base+"/jobs","POST",{idempotencyKey:"source"},owner.token)).status).toBe(202);const source=(await processNextJob(queue,aRoot,{...context,artifacts:a,workerId:"sound-source"}))!;expect(source.failureReason??source.cancelReason).toBeUndefined();expect(source.status).toBe("done");
  const fixture=soundFixture(owner.projectId),uploaded=await fetch(new URL(base+"/sounds",server.url),{method:"POST",headers:{authorization:"Bearer "+owner.token,"content-type":"audio/wav","x-hv-sound-record":encodeURIComponent(JSON.stringify({label:"Synthetic ambience",rights:SOUND_RIGHTS,expectedVersion:0}))},body:Buffer.from(fixture.wav)});expect(uploaded.status).toBe(201);const asset=(await uploaded.json() as any).asset;for(const kind of ["original","audio"] as const)keys.add(soundAssetObjectKey(asset,kind));
  const conflicts=await Promise.all([call(base+"/sounds/"+asset.id,"PUT",{expectedVersion:1,available:false},owner.token),call(base+"/sounds/"+asset.id,"PUT",{expectedVersion:1,available:false},owner.token)]);expect(conflicts.map(r=>r.status).sort()).toEqual([200,409]);expect((await call(base+"/sounds/"+asset.id,"PUT",{expectedVersion:2,available:true},owner.token)).status).toBe(200);
  const path=base+"/sound-mixes/"+source.id,quote=await(await call(path,"GET",undefined,owner.token)).json() as any;expect(quote.error).toBeUndefined();const {asset:_receipt,...cue}=soundCue(asset),body={idempotencyKey:crypto.randomUUID(),generationApproved:true,sourceRevision:quote.sourceRevision,engineVersion:quote.engineVersion,session:{reviewed:true,finishing:{schema:"hv-sound-finishing/1",mode:"normalize",targetLufs:-23,ceilingDbtp:-2,rangeLu:7},dialogueGainDb:0,narrationGainDb:0,cues:[{...cue,assetId:asset.id,assetRevision:asset.revision,gainDb:-12,duckDb:-18,loop:true,frames:Math.round(quote.durationSec*48000)}]}};
  const replies=await Promise.all([call(path,"POST",body,owner.token),call(path,"POST",body,owner.token)]);expect(replies.map(r=>r.status)).toEqual([202,202]);const values=await Promise.all(replies.map(r=>r.json() as Promise<any>));expect(values[0].jobId).toBe(values[1].jobId);const id=values[0].jobId;
  const checkpoint=a.checkpointSound.bind(a);a.checkpointSound=async(...args)=>{await checkpoint(...args);throw new LeaseError(args[0].id,"lease_expired",args[1]);};
  const partial=(await processNextJob(queue,aRoot,{...context,artifacts:a,workerId:"sound-interrupted"}))!;a.checkpointSound=checkpoint;expect(partial.failureReason??partial.cancelReason).toBeUndefined();expect(partial.status).toBe("running");expect(partial.soundCheckpoint).toBeTruthy();
  const done=(await processNextJob(new PostgresJobStore(worker).forProject(owner.projectId),bRoot,{...context,artifacts:b,workerId:"sound-resumed",now:()=>Date.now()+600000}))!;expect(done.failureReason??done.cancelReason).toBeUndefined();expect(done.status).toBe("done");expect(done.output!.sound!.report.finishing?.settings.mode).toBe("normalize");expect(done.output!.sound!.files.some(f=>f.path.endsWith("/finishing/master.wav"))).toBe(true);expect(done.resumedCount).toBe(1);expect(done.output).toEqual(partial.soundCheckpoint);await expect(queue.complete(id,"sound-interrupted",done.output!)).rejects.toThrow("fence_changed");
  expect(await admin.sql`select id from hv_provider_attempts where job_id=${id}`).toHaveLength(0);expect(await admin.sql`select id from hv_cost_events where job_id=${id}`).toHaveLength(0);expect(await admin.sql`select job_id from hv_reservations where job_id=${id}`).toHaveLength(0);
  await expect(ledger.recordForJob({projectId:owner.projectId,jobId:id,stage:"sound-mix",provider:"fixture",shotId:"sound",model:"fixture",prompt_tokens:0,output_frames:0,gpu_seconds:0,total_cost_usd:.01,at:new Date().toISOString()})).rejects.toThrow("provider costs");
  await b.restoreCheckpoint(done);await verifySoundMedia(done,done.output!,bRoot);const view=await(await call("/api/jobs/"+id,"GET",undefined,owner.token)).json() as any;expect((await fetch(new URL(view.output.mixStemUrl,server.url))).status).toBe(200);
  expect((await call(base+"/dialogue-selection","PUT",{jobId:id,sourceJobId:source.id,expectedVersion:0,expectedOutputRevision:outputRevision(done)},owner.token)).status).toBe(200);
  // Remove the disposable mock source and its mock accounting. The archive must own every required source byte.
  for(const row of await admin.sql`select object_key from hv_artifacts where job_id=${source.id}`)keys.add(row.object_key);
  await admin.sql`delete from hv_reservations where job_id=${source.id}`;for(const table of ["hv_cost_events","hv_provider_attempts","hv_outbox","hv_artifacts"])await admin.sql.unsafe('delete from "'+table+'" where job_id=$1',[source.id]);await admin.sql`delete from hv_jobs where id=${source.id}`;
  const snapshot=await exportStateSnapshot(admin,owner.projectId);expect(snapshot.schema).toBe("hv-state/3");expect(snapshot.jobs).toHaveLength(1);expect(()=>validateSnapshot({...snapshot,schema:"hv-state/2"})).toThrow("schema 3");
  const archive=join(root,"sound.zip"),exported=await exportProjectArchive(admin,owner.projectId,join(root,"portable"),archive);expect(exported.jobs).toBe(1);
  const bucket=process.env.HV_S3_BUCKET;process.env.HV_S3_BUCKET=process.env.HV_S3_FLEET_TEST_BUCKET;try{const imported=await importProjectArchive(restored,archive,join(root,"unpacked"),500);expect(imported.jobs).toBe(1);}finally{process.env.HV_S3_BUCKET=bucket;}
  const restoredJob=(await new PostgresJobStore(restored).get(id))!,readerRoot=join(root,"restored"),reader=new PostgresArtifactStore(restored,readerRoot,replica());await reader.restoreCheckpoint(restoredJob);await verifySoundMedia(restoredJob,restoredJob.output!,readerRoot);expect(restoredJob.output).toEqual(done.output);
  const blobStore=new SoundBlobStore(readerRoot,replica());expect(await blobStore.read(asset,"original")).toEqual(fixture.wav);expect((await exportStateSnapshot(restored,owner.projectId)).projects.projects[0]!.soundLibrary!.events).toHaveLength(3);
  const retention=new PostgresRetention(admin);await retention.collectOrphans(Date.now()+2*86400000);expect(await objectClient().file(soundAssetObjectKey(asset,"audio")).exists()).toBe(true);
  expect((await call(base+"/sounds/"+asset.id,"PUT",{expectedVersion:3,available:false},owner.token)).status).toBe(200);expect((await fetch(new URL(view.output.mixStemUrl,server.url))).status).toBe(404);expect((await call(base+"/dialogue-selection","PUT",{jobId:id,sourceJobId:source.id,expectedVersion:1,expectedOutputRevision:outputRevision(done)},owner.token)).status).toBeOneOf([400,409]);
  const retainedBytes=readFileSync(join(readerRoot,restoredJob.output!.mp4Path));expect(retainedBytes.length).toBeGreaterThan(0);await admin.sql`update hv_projects set taken_down_at=now() where id=${owner.projectId}`;expect(await retention.purgeProject(owner.projectId)).toBe(true);expect((await exportStateSnapshot(admin,owner.projectId)).projects.projects).toHaveLength(0);
},120000);
