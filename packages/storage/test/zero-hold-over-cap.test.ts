/**
 * HV-027-13 — the PostgreSQL ledger refused a reservation that holds nothing once the month was past
 * its cap. See packages/api/test/zero-cost-over-cap.test.ts for the route this stopped.
 *
 * `reserveWithin` checked `spent + held + remaining > cap` with `remaining` $0, which is true exactly
 * when the month is already past the cap. It now lets a $0 reservation through and still refuses one
 * that holds money.
 */
import {afterAll,beforeAll,expect,test} from "bun:test";
import {StudioDatabase} from "../src/database";
import {PostgresCostLedger} from "../src/ledger";

const enabled=Boolean(process.env.HV_PG_ADMIN_URL&&process.env.HV_WORKER_DATABASE_URL),pgtest=enabled?test:test.skip;
const TAG="zero_over_cap_"+crypto.randomUUID().slice(0,8);
let admin:StudioDatabase,worker:StudioDatabase,previousCap:number|null=null,capUsd=0;

beforeAll(async()=>{if(!enabled)return;
  admin=new StudioDatabase(process.env.HV_PG_ADMIN_URL!);await admin.migrate();worker=new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!);
  previousCap=(await admin.sql`select monthly_cap_usd from hv_budget_accounts where id='operator'`)[0]?.monthly_cap_usd??null;
  // One dollar spent this month, and a cap a cent under what is already spent and held.
  await admin.sql`insert into hv_projects (id,body,delete_after) values (${TAG},${{id:TAG}}::jsonb,${new Date(Date.now()+864e5).toISOString()})`;
  await admin.sql`insert into hv_cost_events (id,event_key,project_id,job_id,attempt_id,stage,provider,total_usd,body,created_at) values (${crypto.randomUUID()},${TAG},${TAG},${TAG+"_spent"},${TAG+"_a"},'final','fal',1,${{}}::jsonb,now())`;
  const totals=(await admin.sql`select (select coalesce(sum(total_usd),0) from hv_cost_events where created_at>=now()-interval '30 days') as spent,(select coalesce(sum(remaining_usd),0) from hv_reservations) as held`)[0]!;
  capUsd=Math.max(0.01,Number((Number(totals.spent)+Number(totals.held)-0.01).toFixed(2)));
});
afterAll(async()=>{if(!enabled)return;
  await admin.sql`delete from hv_reservations where job_id like ${TAG+"%"}`;await admin.sql`delete from hv_cost_events where event_key=${TAG}`;await admin.sql`delete from hv_projects where id=${TAG}`;
  if(previousCap===null)await admin.sql`delete from hv_budget_accounts where id='operator'`;else await admin.sql`update hv_budget_accounts set monthly_cap_usd=${previousCap} where id='operator'`;
  await Promise.all([admin.close(),worker.close()]);
});

pgtest("a reservation that holds nothing is made when the month is past its cap; one that holds money is still refused",async()=>{
  const ledger=new PostgresCostLedger(worker);
  await ledger.reserve(TAG+"_free","delivery",0,capUsd);
  expect((await admin.sql`select remaining_usd from hv_reservations where job_id=${TAG+"_free"}`).map((row:{remaining_usd:unknown})=>Number(row.remaining_usd))).toEqual([0]);
  await expect(ledger.reserve(TAG+"_paid","final",0.5,capUsd)).rejects.toThrow("generation capacity is reserved");
});
