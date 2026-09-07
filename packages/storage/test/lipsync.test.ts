import {afterAll,beforeAll,expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import {StudioDatabase} from "../src/database";
import {PostgresJobStore} from "../src/jobs";
import {PostgresLipSyncLedger,type LipSyncInvoice} from "../src/lipsync-ledger";
import {PostgresArtifactStore,objectClient} from "../src/artifacts";
import {PostgresReviewQueue} from "../src/reviews";
import {PostgresRetention} from "../src/retention";
import {exportProjectArchive,importProjectArchive} from "../src/archives";
import {exportStateSnapshot,importStateSnapshot} from "../src/snapshots";
import {createApiServer,type ApiServer} from "../../api/src/server";
import {processNextJob} from "../../queue/src/worker";
import {SyncLipSyncProvider} from "../../generator/src/sync-lipsync";
import {verifyLipSyncMedia,verifyLipSyncPrepared} from "../../generator/src/lipsync-media";
import {contentHash} from "../../generator/src/capabilities";
import {createLipSyncFixture,LIPSYNC_POLICY} from "../../../test/fixtures/lipsync";
import {lipSyncPreparedFiles} from "../../planner/src/lipsync";
const enabled=Boolean(process.env.HV_PG_ADMIN_URL&&process.env.HV_API_DATABASE_URL&&process.env.HV_WORKER_DATABASE_URL&&process.env.HV_S3_ENDPOINT&&process.env.HV_S3_FLEET_TEST_BUCKET),pgtest=enabled?test:test.skip;
const envKeys=["HV_TOKEN_SECRET","HV_NARRATION","HV_ANIMATIC_CAPTIONS","HV_ANIMATIC_PROVIDER_POOL","HV_AUDIO_POLICY_FILE","HV_LIPSYNC_POLICY_FILE","HV_S3_BUCKET"],old=Object.fromEntries(envKeys.map(k=>[k,process.env[k]])),name="hv_lip_"+crypto.randomUUID().replaceAll("-",""),projects:string[]=[],keys=new Set<string>();
let root:string,admin:StudioDatabase,worker:StudioDatabase,restored:StudioDatabase,purged:StudioDatabase,server:ApiServer;
const replica=()=>objectClient({...process.env,HV_S3_BUCKET:process.env.HV_S3_FLEET_TEST_BUCKET});
beforeAll(async()=>{if(!enabled)return;root=mkdtempSync(join(tmpdir(),"hv-lipsync-pg-"));Object.assign(process.env,{HV_TOKEN_SECRET:"lipsync-pg-fixture-secret-at-least-thirty-two-characters",HV_NARRATION:"1",HV_ANIMATIC_CAPTIONS:"0",HV_ANIMATIC_PROVIDER_POOL:'["mock"]'});
  admin=new StudioDatabase(process.env.HV_PG_ADMIN_URL!);worker=new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!);await admin.migrate();
  await admin.sql.unsafe('CREATE DATABASE "'+name+'"');await admin.sql.unsafe('CREATE DATABASE "'+name+'_purged"');const url=new URL(process.env.HV_PG_ADMIN_URL!);url.pathname="/"+name;restored=new StudioDatabase(url.href);await restored.migrate();url.pathname="/"+name+"_purged";purged=new StudioDatabase(url.href);await purged.migrate();
  server=createApiServer({port:0,hostname:"127.0.0.1",storage:"postgres",artifactStorage:"s3",databaseUrl:process.env.HV_API_DATABASE_URL,artifactRoot:join(root,"api"),rateLimit:{api:{limit:10000,windowMs:60000}}});
});
afterAll(async()=>{if(!enabled)return;await server?.stop(true);
  for(const db of [admin,restored])if(db)for(const id of projects)for(const row of await db.sql`select object_key from hv_artifacts where project_id=${id}`)keys.add(row.object_key);
  for(const key of keys){await objectClient().file(key).delete();await replica().file(key).delete();}
  for(const id of projects){await admin.sql`delete from hv_reservations where job_id in (select job_id from hv_provider_attempts where project_id=${id})`;for(const table of ["hv_outbox","hv_artifacts","hv_archives","hv_reviews","hv_operator_reviews","hv_cost_events","hv_provider_attempts","hv_jobs","hv_projects"])await admin.sql.unsafe('delete from "'+table+'" where '+(table==="hv_projects"?'id':'project_id')+'=$1',[id]);}
  await worker?.close();await restored?.close();await purged?.close();await admin.sql.unsafe('DROP DATABASE "'+name+'" WITH (FORCE)');await admin.sql.unsafe('DROP DATABASE "'+name+'_purged" WITH (FORCE)');await admin.close();
  for(const [k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}if(!resolve(root).startsWith(resolve(tmpdir())+sep+"hv-lipsync-pg-"))throw new Error("Unexpected test root");rmSync(root,{recursive:true,force:true});
});
async function seed(){const folder=join(root,crypto.randomUUID());mkdirSync(folder);const f=await createLipSyncFixture(folder);projects.push(f.project.id);process.env.HV_AUDIO_POLICY_FILE=join(folder,"audio-policy.json");process.env.HV_LIPSYNC_POLICY_FILE=join(folder,"lipsync-policy.json");
  await admin.sql`insert into hv_projects (id,body,created_at,delete_after) values (${f.project.id},${f.project}::jsonb,${f.project.createdAt},${f.project.deleteAfter})`;
  const j=f.dialogue;await admin.sql`insert into hv_jobs (id,project_id,idempotency_key,stage,status,tier,body,lease_version) values (${j.id},${j.projectId},${j.idempotencyKey},${j.stage},${j.status},${j.tier},${j}::jsonb,${j.leaseVersion??0})`;
  await new PostgresArtifactStore(admin,f.artifacts).importCompletedJob(j,j.output!.dialogue!.files.map(file=>join(f.artifacts,file.path)));return f;
}
const call=(f:Awaited<ReturnType<typeof seed>>,path:string,method="GET",body?:unknown)=>fetch(new URL(path,server.url),{method,headers:{authorization:"Bearer "+f.owner.token,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
async function admit(f:Awaited<ReturnType<typeof seed>>){const base="/api/projects/"+f.project.id+"/lip-sync",catalogue=await(await call(f,base)).json() as any,quote=await(await call(f,base+"/"+f.dialogue.id)).json() as any,line=quote.lines[0],preview=await(await call(f,base+"/"+f.dialogue.id+"/preview","POST",{sourceRevision:quote.sourceRevision,shotId:line.shotId,lineIndex:line.lineIndex,frame:0})).json() as any;
  expect(preview.rgbSha256).toBe(f.preview.rgbSha256);const body={idempotencyKey:crypto.randomUUID(),generationApproved:true,sourceRevision:quote.sourceRevision,policyRevision:catalogue.policy.revision,capabilityRevision:catalogue.capabilityRevision,shotId:line.shotId,lineIndex:line.lineIndex,selection:{frame:preview.frame,width:preview.width,height:preview.height,rgbSha256:preview.rgbSha256,x:100,y:100}},responses=await Promise.all([call(f,base+"/"+f.dialogue.id,"POST",body),call(f,base+"/"+f.dialogue.id,"POST",body)]),values=await Promise.all(responses.map(r=>r.json() as Promise<any>));
  expect(values.map(v=>v.error)).toEqual([undefined,undefined]);expect(responses.map(r=>r.status)).toEqual([202,202]);expect(values[0].jobId).toBe(values[1].jobId);expect((await call(f,base+"/"+f.dialogue.id,"POST",{...body,selection:{...body.selection,x:101}})).status).toBe(409);return values[0].jobId as string;
}
pgtest("PostgreSQL/S3 resumes one generation on a fresh worker, conserves invoice holds and restores an independent reviewed export",async()=>{
  const f=await seed(),id=await admit(f),ledger=new PostgresLipSyncLedger(worker),operator=new PostgresLipSyncLedger(admin);let submissions=0,downloads=0,bytes:Uint8Array|undefined,failOnce=true;const generation=crypto.randomUUID();
  const wire=Bun.serve({port:0,hostname:"127.0.0.1",async fetch(req){if(req.method==="POST"){submissions++;const form=await req.formData();bytes=new Uint8Array(await(form.get("video") as File).arrayBuffer());return Response.json({id:generation,model:"sync-3",createdAt:new Date().toISOString(),status:"PENDING"},{status:201});}if(new URL(req.url).pathname==="/clip.mp4"){downloads++;expect(req.headers.has("x-api-key")).toBe(false);return new Response(bytes?Buffer.from(bytes):undefined);}return Response.json({id:generation,model:"sync-3",createdAt:created,status:"COMPLETED",outputUrl:"https://output.sync.so/clip.mp4"});}});let created="";
  const provider=new SyncLipSyncProvider({apiKey:"closed-pg-fixture",pollMs:1,fetchImpl:(async(url:unknown,init?:RequestInit)=>{const u=new URL(String(url)),response=await fetch(new URL(u.pathname+u.search,wire.url),init);if(init?.method==="POST")created=(await response.clone().json() as any).createdAt;return response;}) as typeof fetch}),record=ledger.recordLipSyncReceipt.bind(ledger);
  ledger.recordLipSyncReceipt=async(job,workerId,receipt)=>{await record(job,workerId,receipt);if(receipt.remote&&failOnce){failOnce=false;throw new Error("Closed fixture worker interruption after durable generation ID.");}};
  try{
    const firstRoot=join(root,"worker-one"),first=(await processNextJob(new PostgresJobStore(worker).forProject(f.project.id),firstRoot,{ledger,reviewQueue:new PostgresReviewQueue(worker),artifacts:new PostgresArtifactStore(worker,firstRoot),lipSync:{provider,ledger,policy:()=>LIPSYNC_POLICY},workerId:"lip-first"}))!;
    expect(first.status).toBe("queued");expect(submissions).toBe(1);const attempt=(await ledger.lipSyncAttempt(id))!;expect(attempt.lipSync.receipt!.remote!.id).toBe(generation);expect(attempt.actualUsd).toBeNull();expect(first.lipSyncPrepared).toBeTruthy();expect(first.output).toBeUndefined();
    await Bun.sleep(1600);const secondRoot=join(root,"worker-two"),store=new PostgresJobStore(worker).forProject(f.project.id),artifacts=new PostgresArtifactStore(worker,secondRoot),done=(await processNextJob(store,secondRoot,{ledger,reviewQueue:new PostgresReviewQueue(worker),artifacts,lipSync:{provider,ledger,policy:()=>LIPSYNC_POLICY},workerId:"lip-second"}))!;
    expect(done?.failureReason??done?.cancelReason).toBeUndefined();expect(done.status).toBe("done");expect(submissions).toBe(1);expect(downloads).toBe(1);await artifacts.restoreCheckpoint(done);await verifyLipSyncPrepared(done,done.lipSyncPrepared!,secondRoot);await verifyLipSyncMedia(done,done.output!,secondRoot);expect(readFileSync(join(secondRoot,done.output!.lipSync!.wavPath))).toEqual(readFileSync(join(f.artifacts,f.dialogue.output!.dialogue!.wavPath)));
    const revision=contentHash(done.output),review={mouthSync:4,faceStability:4,expression:4,decision:"accept",notes:"Closed fixture only; no speech quality claim.",expectedVersion:0,expectedOutputRevision:revision};expect((await call(f,"/api/projects/"+f.project.id+"/lip-sync/"+id+"/review","PUT",review)).status).toBe(200);
    expect((await call(f,"/api/projects/"+f.project.id+"/dialogue-selection","PUT",{jobId:id,sourceJobId:f.film.id,expectedVersion:0,expectedOutputRevision:revision})).status).toBe(200);
    const snapshot=await exportStateSnapshot(admin,f.project.id);expect(snapshot.schema).toBe("hv-state/2");expect(snapshot.ledger.reservations).toHaveLength(1);expect(snapshot.ledger.lipSyncAttempts![0]!.lipSync.receipt!.remote!.id).toBe(generation);
    const archive=join(root,"lip.zip");await exportProjectArchive(admin,f.project.id,join(root,"portable"),archive);
    const bucket=process.env.HV_S3_BUCKET;process.env.HV_S3_BUCKET=process.env.HV_S3_FLEET_TEST_BUCKET;try{await importProjectArchive(restored,archive,join(root,"unpacked"),500);}finally{process.env.HV_S3_BUCKET=bucket;}
    const copied=(await new PostgresJobStore(restored).get(id))!,readerRoot=join(root,"restored"),reader=new PostgresArtifactStore(restored,readerRoot,replica());await reader.restoreCheckpoint(copied);await verifyLipSyncPrepared(copied,copied.lipSyncPrepared!,readerRoot);await verifyLipSyncMedia(copied,copied.output!,readerRoot);expect(copied.lipSyncReviews!.entries[0]!.decision).toBe("accept");expect((await new PostgresLipSyncLedger(restored).lipSyncAttempt(id))!.actualUsd).toBeNull();
    const allocation={schema:"hv-lipsync-invoice-allocation/1" as const,documentSha256:contentHash({invoice:id}),accountRevision:LIPSYNC_POLICY.accountRevision,totalUsd:.37,at:new Date().toISOString(),allocations:[{attemptId:attempt.id,usd:.37}]},invoice:LipSyncInvoice={...allocation,revision:contentHash(allocation)};
    await expect(ledger.settleLipSyncInvoice(invoice)).rejects.toThrow("operator");await operator.settleLipSyncInvoice(invoice);await operator.settleLipSyncInvoice(invoice);await new PostgresLipSyncLedger(restored).settleLipSyncInvoice(invoice);
    expect((await operator.lipSyncAttempt(id))!.actualUsd).toBe(.37);expect((await admin.sql`select job_id from hv_reservations where job_id=${id}`).length).toBe(0);expect((await admin.sql`select id from hv_cost_events where attempt_id=${attempt.id}`).length).toBe(1);
    const view=await(await call(f,"/api/jobs/"+id)).json() as any;expect(view.lipSyncBilling.actualUsd).toBe(.37);expect((await fetch(new URL(view.output.mp4Url,server.url))).status).toBe(200);
    const preparedPath=lipSyncPreparedFiles(copied.lipSyncPrepared!)[0]!,bad=readFileSync(join(readerRoot,preparedPath.path));bad[bad.length-20]^=1;writeFileSync(join(readerRoot,preparedPath.path),bad);await expect(verifyLipSyncPrepared(copied,copied.lipSyncPrepared!,readerRoot)).rejects.toThrow("checksum");
    expect(submissions).toBe(1);
  }finally{await wire.stop(true);}
},120000);
pgtest("ambiguous generation survives purge and scoped restore, then settles from the original invoice without redispatch",async()=>{
  const f=await seed(),id=await admit(f),ledger=new PostgresLipSyncLedger(worker),store=new PostgresJobStore(worker).forProject(f.project.id),cache=join(root,"ambiguous");let submissions=0;
  const provider=new SyncLipSyncProvider({apiKey:"closed-failure-fixture",pollMs:1,fetchImpl:((..._args:unknown[])=>{submissions++;return Promise.reject(new Error("Closed fixture lost acknowledgement"));}) as typeof fetch});
  const context={ledger,reviewQueue:new PostgresReviewQueue(worker),artifacts:new PostgresArtifactStore(worker,cache),lipSync:{provider,ledger,policy:()=>LIPSYNC_POLICY},workerId:"lip-ambiguous"};
  const first=(await processNextJob(store,cache,context))!;expect(first.status).toBe("queued");await Bun.sleep(1600);const stopped=(await processNextJob(new PostgresJobStore(worker).forProject(f.project.id),cache,context))!;expect(stopped.status).toBe("cancelled");expect(submissions).toBe(1);const attempt=(await ledger.lipSyncAttempt(id))!;expect(attempt.actualUsd).toBeNull();expect(attempt.lipSync.receipt!.remote).toBeNull();
  for(const row of await admin.sql`select object_key from hv_artifacts where project_id=${f.project.id}`)keys.add(row.object_key);
  await admin.sql`update hv_projects set taken_down_at=now() where id=${f.project.id}`;expect(await new PostgresRetention(admin).purgeProject(f.project.id)).toBe(true);
  const snapshot=await exportStateSnapshot(admin,f.project.id);expect(snapshot.jobs).toHaveLength(0);expect(snapshot.schema).toBe("hv-state/2");expect(snapshot.ledger.reservations).toHaveLength(1);expect(snapshot.ledger.lipSyncAttempts![0]!.id).toBe(attempt.id);expect(JSON.stringify(snapshot)).not.toContain(f.film.scriptText);
  await importStateSnapshot(purged,snapshot,500);const operator=new PostgresLipSyncLedger(purged),bill={schema:"hv-lipsync-invoice-allocation/1" as const,documentSha256:contentHash({late:id}),accountRevision:LIPSYNC_POLICY.accountRevision,totalUsd:.2,at:new Date().toISOString(),allocations:[{attemptId:attempt.id,usd:.2}]};await operator.settleLipSyncInvoice({...bill,revision:contentHash(bill)});expect((await exportStateSnapshot(purged,f.project.id)).ledger.reservations).toEqual([]);expect((await operator.lipSyncAttempt(id))!.actualUsd).toBe(.2);expect(submissions).toBe(1);
},90000);
