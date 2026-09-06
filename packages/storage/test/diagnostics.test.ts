import { expect, test } from "bun:test";
import { StudioDatabase } from "../src/database";
import { storageDiagnostics } from "../src/diagnostics";

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_API_DATABASE_URL);
(enabled ? test : test.skip)("API-role diagnostics see only operational aggregates and count the latest fresh worker incarnation", async () => {
  const adminUrl = process.env.HV_PG_ADMIN_URL!, apiUrl = process.env.HV_API_DATABASE_URL!;
  if (![adminUrl, apiUrl].every(url => /\/hollywood_video_(?:observability_)?test$/.test(new URL(url).pathname))) throw new Error("diagnostics fixture requires a disposable test database");
  const admin = new StudioDatabase(adminUrl), api = new StudioDatabase(apiUrl), probes = storageDiagnostics(apiUrl, 500, false);
  const prefix = "diagnostics-" + crypto.randomUUID(), projectId = crypto.randomUUID(), jobId = crypto.randomUUID();
  try {
    await admin.migrate();
    const before = await probes.database();
    await admin.sql`insert into hv_projects (id,body,delete_after) values (${projectId}, ${{script: "private-screenplay-sentinel"}}::jsonb, now()+interval '1 day')`;
    await admin.sql`insert into hv_jobs (id,project_id,idempotency_key,stage,status,tier,body) values (${jobId},${projectId},${jobId},'animatic','queued','free','{}'::jsonb)`;
    await admin.sql`insert into hv_cost_events (id,event_key,project_id,provider,total_usd,body,created_at) values (${crypto.randomUUID()},${jobId},${projectId},'fixture',0.144,'{}'::jsonb,now())`;
    await admin.sql`insert into hv_reservations (job_id,stage,amount_usd,remaining_usd,body) values (${jobId},'animatic',7,7,'{}'::jsonb)`;
    const worker = async (suffix: string, name: string, state: string, secondsAgo: number) => {
      await admin.sql`insert into hv_workers (id,classes,body,heartbeat_at) values (${prefix+suffix},'[]'::jsonb,${{name: prefix+name, state}}::jsonb, now()-${secondsAgo}*interval '1 second')`;
    };
    await worker("-old", "-one", "idle", 20); await worker("-new", "-one", "stopped", 1);
    await worker("-two", "-two", "idle", 1); await worker("-three", "-three", "busy", 1);
    await worker("-four", "-four", "idle", 60); await worker("-five", "-five", "draining", 1);
    const value = await probes.database();
    expect(value.queue.queued).toBe(before.queue.queued + 1);
    expect(value.budget.recordedMonthUsd).toBeCloseTo(before.budget.recordedMonthUsd + .144, 6); expect(value.budget.reservedUsd).toBe(before.budget.reservedUsd + 7);
    expect(value.workers!.ready).toBe(before.workers!.ready + 1); expect(value.workers!.busy).toBe(before.workers!.busy + 1);
    expect(value.workers!.draining).toBe(before.workers!.draining + 1); expect(value.workers!.latestProcesses).toBe(before.workers!.latestProcesses + 5);
    expect(JSON.stringify(value)).not.toContain(projectId); expect(JSON.stringify(value)).not.toContain("private-screenplay-sentinel");
    expect(await api.sql`select id from hv_projects where id = ${projectId}`).toHaveLength(0);
    expect(await api.sql`select id from hv_jobs where id = ${jobId}`).toHaveLength(0);
  } finally {
    await admin.sql`delete from hv_workers where id like ${prefix+"%"}`;
    await admin.sql`delete from hv_reservations where job_id = ${jobId}`;
    await admin.sql`delete from hv_cost_events where project_id = ${projectId}`;
    await admin.sql`delete from hv_jobs where id = ${jobId}`;
    await admin.sql`delete from hv_projects where id = ${projectId}`;
    await Promise.all([probes.close(), api.close(), admin.close()]);
  }
});
