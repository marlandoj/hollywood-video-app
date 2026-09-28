/**
 * HV-022-17 — the voice vendor's $25 line was each project's own, and forgot a project once purged.
 *
 * G14 gives ElevenLabs a $25 line for the whole studio. `voiceVendorSpend` summed it as
 *
 *     sum(e.total_usd) from hv_cost_events e join hv_jobs j on j.id = e.job_id where <j's vendor>
 *     sum(r.remaining_usd) from hv_reservations r join hv_jobs j on j.id = r.job_id where <j's vendor>
 *
 * and both joins went through `hv_jobs`. Two things follow:
 *
 * - Admission reads the line as hv_api inside `forProject`, and hv_jobs is row-secured to the
 *   admitting project. Every other project's takes were invisible, so the line was $25 per project.
 *   The existing tests read it as hv_worker, which sees every row, and so never saw this.
 * - `PostgresRetention.purgeProject` deletes a project's jobs and keeps its receipts, attempts and
 *   holds on purpose. After a purge the line forgot that project: $20 spent and $4 held read $0, and
 *   a new $20 take was admitted on a $25 line.
 *
 * The line is now read from the rows that say which vendor they belong to and that every role can
 * read across projects: a cost event by its provider column, a hold by the provider its admission
 * writes into it.
 */
import {afterAll,beforeAll,expect,test} from "bun:test";
import {StudioDatabase} from "../src/database";
import {PostgresAudioLedger} from "../src/audio-ledger";
import {PostgresRetention} from "../src/retention";

const enabled=Boolean(process.env.HV_PG_ADMIN_URL&&process.env.HV_API_DATABASE_URL&&process.env.HV_WORKER_DATABASE_URL),pgtest=enabled?test:test.skip;
// A vendor name no other test uses, so this line holds only what this file puts on it.
const VENDOR="vendor-"+crypto.randomUUID().slice(0,8),A="line_a_"+crypto.randomUUID().slice(0,8),B="line_b_"+crypto.randomUUID().slice(0,8);
let admin:StudioDatabase,api:StudioDatabase,worker:StudioDatabase;

/** Opens reservations the way admission does, as the worker role the other ledger tests use. */
class Holding extends PostgresAudioLedger {
  hold(jobId:string,projectId:string,usd:number,provider?:string){return this.locked((tx,cap)=>this.reserveWithin(tx,cap,jobId,"audio-take",usd,5000,new Date(),projectId,provider),5000);}
}

beforeAll(async()=>{if(!enabled)return;
  admin=new StudioDatabase(process.env.HV_PG_ADMIN_URL!);await admin.migrate();api=new StudioDatabase(process.env.HV_API_DATABASE_URL!);worker=new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!);
  const past=new Date(Date.now()-864e5).toISOString(),future=new Date(Date.now()+864e5).toISOString();
  for(const [project,deleteAfter] of [[A,past],[B,future]] as const)await admin.sql`insert into hv_projects (id,body,delete_after) values (${project},${{id:project}}::jsonb,${deleteAfter})`;
  const job=(id:string,project:string)=>admin.sql`insert into hv_jobs (id,project_id,idempotency_key,stage,status,tier,body) values (${id},${project},${id},'audio-take','done','free',${{id,projectId:project,stage:"audio-take",status:"done",audioTake:{policy:{provider:VENDOR}}}}::jsonb)`;
  await job(A+"_paid",A);await job(A+"_held",A);
  // Project A: a take invoiced at $20, and a dispatched take whose $4 hold is still open.
  await admin.sql`insert into hv_cost_events (id,event_key,project_id,job_id,attempt_id,stage,provider,total_usd,body,created_at) values (${crypto.randomUUID()},${"audio:"+A},${A},${A+"_paid"},${A+"_a1"},'audio-take',${VENDOR},20,${{}}::jsonb,now())`;
  await new Holding(worker).hold(A+"_held",A,4,VENDOR);
  // Dispatched, not yet invoiced: an unknown liability, which retention keeps as a hold.
  await admin.sql`insert into hv_provider_attempts (id,project_id,job_id,shot_id,provider,worker_id,lease_version,status,estimated_usd,actual_usd,body) values (${A+"_a2"},${A},${A+"_held"},'audio-line',${VENDOR},'w',1,'unknown',4,null,${{audio:{}}}::jsonb)`;
});
afterAll(async()=>{if(!enabled)return;
  for(const project of [A,B]){await admin.sql`delete from hv_provider_attempts where project_id=${project}`;await admin.sql`delete from hv_reservations where project_id=${project}`;await admin.sql`delete from hv_cost_events where project_id=${project}`;await admin.sql`delete from hv_jobs where project_id=${project}`;await admin.sql`delete from hv_projects where id=${project}`;}
  await admin.sql`delete from hv_reservations where job_id like ${B+"%"}`;
  await Promise.all([admin.close(),api.close(),worker.close()]);
});

/** The line as admission reads it: hv_api, inside the admitting project's transaction. */
const lineFor=(project:string)=>api.forProject(project,tx=>new PostgresAudioLedger(api).voiceVendorSpend(VENDOR,tx));

pgtest("another project's takes are on the line when a project admits against it",async()=>{
  expect(await new PostgresAudioLedger(worker).voiceVendorSpend(VENDOR)).toEqual({spentUsd:20,heldUsd:4});
  // Project B has no takes of its own; the studio's line still holds A's $24.
  expect(await lineFor(B)).toEqual({spentUsd:20,heldUsd:4});
});

pgtest("and they stay on it after that project's content is purged",async()=>{
  expect(await new PostgresRetention(admin).purgeProject(A)).toBe(true);
  expect((await admin.sql`select count(*)::int as n from hv_jobs where project_id=${A}`)[0]!.n).toBe(0);
  expect(await new PostgresAudioLedger(worker).voiceVendorSpend(VENDOR)).toEqual({spentUsd:20,heldUsd:4});
  expect(await lineFor(B)).toEqual({spentUsd:20,heldUsd:4});
});

pgtest("a hold admission writes says whose it is; one from before that says nothing is still found through its own project",async()=>{
  const ledger=new Holding(worker);
  await ledger.hold(B+"_new",B,1,VENDOR);
  expect((await admin.sql`select body->>'provider' as provider from hv_reservations where job_id=${B+"_new"}`)[0]!.provider).toBe(VENDOR);
  // A hold written before this increment has no provider; its job, in the admitting project, names it.
  await admin.sql`insert into hv_jobs (id,project_id,idempotency_key,stage,status,tier,body) values (${B+"_old"},${B},${B+"_old"},'audio-take','queued','free',${{id:B+"_old",projectId:B,stage:"audio-take",audioTake:{policy:{provider:VENDOR}}}}::jsonb)`;
  await ledger.hold(B+"_old",B,2);
  expect(await lineFor(B)).toEqual({spentUsd:20,heldUsd:7});
  // Another vendor's line is untouched by any of it.
  expect(await api.forProject(B,tx=>new PostgresAudioLedger(api).voiceVendorSpend("another-"+VENDOR,tx))).toEqual({spentUsd:0,heldUsd:0});
});
