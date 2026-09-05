import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { StudioDatabase } from "../packages/storage/src/database";
import { objectClient } from "../packages/storage/src/artifacts";
import { createApiServer, type ApiServer } from "../packages/api/src/server";

const bucket=process.env.HV_S3_FLEET_TEST_BUCKET;
if (!/^rough-cut-fleet-test(?:-ci)?$/.test(bucket ?? "")) throw new Error("configure a dedicated fleet fixture bucket");
const adminUrl=process.env.HV_PG_ADMIN_URL;
if (!adminUrl || !process.env.HV_WORKER_DATABASE_URL || !process.env.HV_API_DATABASE_URL) throw new Error("fleet fixture database credentials missing");
const name="hv_fleet_test_"+crypto.randomUUID().replaceAll("-","");
if (!/^hv_fleet_test_[a-f0-9]{32}$/.test(name)) throw new Error("unexpected fleet fixture database");
const root=mkdtempSync(resolve(tmpdir(),"hv-fleet-")),barrier=resolve(root,"barrier");mkdirSync(barrier);
const scoped=(url: string)=>{const parsed=new URL(url);parsed.pathname="/"+name;return parsed.href;};
process.env.HV_S3_BUCKET=bucket;
process.env.HV_TOKEN_SECRET="fleet-fixture-"+crypto.randomUUID()+crypto.randomUUID();
process.env.HV_MONTHLY_BUDGET_USD="500";
process.env.HV_PROVIDER_PRIMARY="mock";process.env.HV_PROVIDER_SECONDARY="mock";process.env.HV_ANIMATIC_PROVIDER="mock";
const client=objectClient(),admin=new StudioDatabase(adminUrl);
let database: StudioDatabase | undefined,server: ApiServer | undefined,createdDatabase=false;
const children: {child: ReturnType<typeof Bun.spawn>; log: string; slot: number}[]=[];
const started=performance.now();
function assert(condition: unknown,reason: string): asserts condition {if (!condition) throw new Error(reason);}
async function until(predicate: ()=>Promise<boolean>|boolean,reason: string,timeout=90_000): Promise<void> {
  const deadline=Date.now()+timeout;
  while (Date.now()<deadline) {if (await predicate()) return;await Bun.sleep(100);}
  throw new Error(reason);
}
function spawnWorker(slot: number) {
  const log=resolve(root,"worker-"+slot+".log");
  const child=Bun.spawn([process.execPath,resolve(import.meta.dir,"fixtures/fleet-worker.ts")],{
    env:{...process.env,FAL_KEY:"",HV_STORAGE:"postgres",HV_ARTIFACT_STORAGE:"s3",HV_WORKER_DATABASE_URL:scoped(process.env.HV_WORKER_DATABASE_URL!),
      HV_ARTIFACT_ROOT:resolve(root,"worker-cache"),HV_WORKER_ID:"fleet-worker-"+slot,HV_WORKER_POLL_MS:"50",HV_JOB_LEASE_MS:"120000",HV_NARRATION:"0",
      HV_FLEET_SLOT:String(slot),HV_FLEET_BARRIER_ROOT:barrier},stdout:Bun.file(log),stderr:Bun.file(log)});
  const entry={child,log,slot};children.push(entry);return entry;
}
async function request(path: string,options: {method?:string;token?:string;body?:unknown;expected?:number}={}) {
  const response=await fetch(new URL(path,server!.url),{method:options.method,
    headers:{...(options.token?{authorization:"Bearer "+options.token}:{}),...(options.body?{"content-type":"application/json"}:{})},
    body:options.body?JSON.stringify(options.body):undefined});
  assert(!response.headers.has("set-cookie"),"anonymous fleet requests must remain cookie-free");
  assert(options.expected===undefined?response.ok:response.status===options.expected,"unexpected API status for "+path+": "+response.status);
  return response;
}
type Owner={projectId:string;token:string;animaticJobId?:string;finalJobId?:string};
async function waitJobs(ids: string[]) {
  await until(async()=>{
    const rows: {id:string;status:string;reason:string|null}[]=await database!.sql`select id,status,body->>'failureReason' as reason from hv_jobs where id in ${database!.sql(ids)}`;
    if (rows.some(row=>["failed","cancelled"].includes(row.status))) throw new Error("fleet job failed: "+rows.find(row=>row.reason)?.reason);
    return rows.length===ids.length&&rows.every(row=>row.status==="done");
  },"fleet jobs did not complete",180_000);
}
try {
  assert(!(await client.list({maxKeys:1})).contents?.length,"fleet fixture bucket must be empty");
  await admin.sql.unsafe('CREATE DATABASE "'+name+'"');createdDatabase=true;
  database=new StudioDatabase(scoped(adminUrl));await database.migrate();
  server=createApiServer({port:0,hostname:"127.0.0.1",tls:null,storage:"postgres",artifactStorage:"s3",
    databaseUrl:scoped(process.env.HV_API_DATABASE_URL!),artifactRoot:resolve(root,"api-cache")});
  const initial=[spawnWorker(0),spawnWorker(1),spawnWorker(2)];
  await until(async()=>Number((await database!.sql`select count(*) as count from hv_workers where body->>'state'='idle'`)[0].count)===3,
    "three worker processes did not register",30_000);
  assert(new Set(initial.map(entry=>entry.child.pid)).size===3,"fleet must use three separate processes");
  const owners: Owner[]=[];
  for (let index=0;index<3;index++) {
    const owner=await (await request("/api/projects",{method:"POST"})).json() as Owner;owners.push(owner);
    await request(`/api/projects/${owner.projectId}/script`,{method:"PUT",token:owner.token,body:{text:`EXT. GARDEN ${index+1} - DAY\n\nA paper lantern sways above a quiet path.`}});
    await request(`/api/projects/${owner.projectId}/rights`,{method:"POST",token:owner.token,body:{attested:true}});
    const job=await (await request(`/api/projects/${owner.projectId}/jobs`,{method:"POST",token:owner.token,body:{idempotencyKey:crypto.randomUUID()}})).json() as {jobId:string};
    owner.animaticJobId=job.jobId;
  }
  await until(()=>initial.every(entry=>existsSync(resolve(barrier,"claim-"+entry.slot+".json"))),"workers did not claim distinct jobs",30_000);
  const claims=initial.map(entry=>JSON.parse(readFileSync(resolve(barrier,"claim-"+entry.slot+".json"),"utf8")) as {jobId:string;projectId:string});
  assert(new Set(claims.map(claim=>claim.jobId)).size===3,"workers duplicated a job claim");
  const live: {id:string;active_job_id:string}[]=await database.sql`select id,active_job_id,body from hv_workers where body->>'state'='busy'`;
  assert(live.length===3&&new Set(live.map(row=>row.active_job_id)).size===3,"heartbeat registry must show three distinct active jobs");
  const outbox: {worker:string}[]=await database.sql`select body->>'workerId' as worker from hv_outbox where event_type='job.claimed'`;
  assert(new Set(outbox.map(row=>row.worker)).size===3,"claim events must identify three process incarnations");
  initial[0]!.child.kill("SIGTERM");
  writeFileSync(resolve(barrier,"release"),"release",{mode:0o600});
  await waitJobs(owners.map(owner=>owner.animaticJobId!));
  await until(()=>initial[0]!.child.exitCode!==null,"draining worker did not exit",20_000);
  assert(initial[0]!.child.exitCode===0,"graceful drain did not finish its current job successfully");
  const stopped=await database.sql`select active_job_id,body from hv_workers where body->>'name'='fleet-worker-0'`;
  assert(stopped[0]?.body.state==="stopped"&&stopped[0].active_job_id===null,"drained worker must be recorded as stopped");
  spawnWorker(3);
  await until(async()=>Number((await database!.sql`select count(*) as count from hv_workers where body->>'state'='idle'`)[0].count)===3,"replacement worker did not register",30_000);

  await request(`/api/projects/${owners[0]!.projectId}/jobs`,{method:"POST",token:owners[0]!.token,
    body:{stage:"final",animaticJobId:owners[0]!.animaticJobId,idempotencyKey:crypto.randomUUID()},expected:403});
  await request(`/api/projects/${owners[0]!.projectId}`,{token:owners[1]!.token,expected:401});
  for (const owner of owners) {
    await request(`/api/projects/${owner.projectId}/animatic/decision`,{method:"POST",token:owner.token,body:{animaticJobId:owner.animaticJobId,decision:"approved"}});
    const final=await (await request(`/api/projects/${owner.projectId}/jobs`,{method:"POST",token:owner.token,
      body:{stage:"final",animaticJobId:owner.animaticJobId,idempotencyKey:crypto.randomUUID()}})).json() as {jobId:string};owner.finalJobId=final.jobId;
  }
  await waitJobs(owners.map(owner=>owner.finalJobId!));
  await server.stop(true);
  server=createApiServer({port:0,hostname:"127.0.0.1",tls:null,storage:"postgres",artifactStorage:"s3",
    databaseUrl:scoped(process.env.HV_API_DATABASE_URL!),artifactRoot:resolve(root,"fresh-api-cache")});
  for (const owner of owners) {
    const status=await (await request(`/api/jobs/${owner.finalJobId}`,{token:owner.token})).json() as {status:string;output:{mp4Url:string;hlsUrl:string;captionsUrl:string}};
    assert(status.status==="done","final status did not survive API restart");
    const video=await fetch(new URL(status.output.mp4Url,server.url),{headers:{range:"bytes=0-31"}});
    assert(video.status===206&&(await video.arrayBuffer()).byteLength===32,"fresh API cache could not serve a video range");
    const hls=await (await request(status.output.hlsUrl)).text();assert(hls.startsWith("#EXTM3U"),"invalid HLS after restart");
    const segment=hls.split("\n").find(line=>line&&!line.startsWith("#"));assert(segment,"HLS segment missing");
    const segmentResponse=await request(new URL(segment,new URL(status.output.hlsUrl,server.url)).pathname);
    assert((await segmentResponse.arrayBuffer()).byteLength>0,"HLS segment is empty");
    assert((await (await request(status.output.captionsUrl)).text()).startsWith("WEBVTT"),"captions missing after restart");
  }
  const counts=(await database.sql`select (select count(*) from hv_jobs where status='done') as completed,
    (select count(*) from hv_artifacts) as artifacts,(select coalesce(sum(total_usd),0) from hv_cost_events) as cost,
    (select coalesce(sum(remaining_usd),0) from hv_reservations) as held`)[0];
  assert(Number(counts.completed)===6&&Number(counts.cost)===0&&Number(counts.held)===0,"fleet completion/accounting mismatch");
  const report={schema:"hv-fleet-smoke/1",recordedAt:new Date().toISOString(),processes:initial.length,concurrentClaims:claims.length,
    completedAnimatics:3,completedFinals:3,gracefulDrain:true,replacementWorker:true,apiRestart:true,independentCachePlayback:true,
    capabilitiesIsolated:true,unapprovedFinalRefused:true,artifactRecords:Number(counts.artifacts),recordedCostUsd:0,openReservationUsd:0,
    elapsedSeconds:Math.round((performance.now()-started)/100)/10};
  if (process.env.HV_FLEET_REPORT) writeFileSync(process.env.HV_FLEET_REPORT,JSON.stringify(report,null,2)+"\n");
  console.log(JSON.stringify(report));
} catch (error) {
  for (const entry of children) if (existsSync(entry.log)) console.error(readFileSync(entry.log,"utf8").slice(-2500));
  throw error;
} finally {
  // Release a fixture barrier before asking each process to drain on failures.
  writeFileSync(resolve(barrier,"release"),"release");
  for (const entry of children) if (entry.child.exitCode===null) entry.child.kill("SIGTERM");
  await Promise.all(children.map(async entry=>{
    const timeout=setTimeout(()=>entry.child.kill("SIGKILL"),20_000);
    try {await entry.child.exited;} finally {clearTimeout(timeout);}
  }));
  await server?.stop(true);await database?.close();
  if (createdDatabase) {
    await admin.sql.unsafe('DROP DATABASE "'+name+'"');
  }
  await admin.close();
  if (createdDatabase) {
    for (let page=0;page<100;page++) {
      const entries=(await client.list({maxKeys:1000})).contents ?? [];
      if (!entries.length) break;
      for (const entry of entries) await client.file(entry.key).delete();
    }
  }
  rmSync(root,{recursive:true,force:true});
}
