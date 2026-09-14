import { expect, test } from "bun:test";
import { StudioDatabase } from "../src/database";
import { storageDiagnostics } from "../src/diagnostics";
import { PostgresWorkerRegistry } from "../src/workers";
import { ProviderHealth } from "../../generator/src/router";

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

const registryEnabled = enabled && Boolean(process.env.HV_WORKER_DATABASE_URL);
(registryEnabled ? test : test.skip)("worker circuit summaries and per-provider cost windows survive one read-only diagnostics transaction", async () => {
  const adminUrl = process.env.HV_PG_ADMIN_URL!, apiUrl = process.env.HV_API_DATABASE_URL!;
  const admin = new StudioDatabase(adminUrl), worker = new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!), probes = storageDiagnostics(apiUrl, 500, false);
  const prefix = "reliability-" + crypto.randomUUID(), projectId = crypto.randomUUID(), jobId = crypto.randomUUID();
  const health = new ProviderHealth();
  try {
    await admin.migrate();
    const before = await probes.database();
    const key = "capability-revision-fixture";
    for (let i = 0; i < 3; i++) health.record(key, false, 40);
    const summary = health.summary([{stage: "final", provider: "mock", id: "mock", key}, {stage: "animatic", provider: "other", id: "legacy-mock", key: "cold"}]);
    await new PostgresWorkerRegistry(worker, prefix + "-live-" + crypto.randomUUID(), prefix + "-live").heartbeat("idle", null, summary);
    // A stale incarnation, a stopped process and a malformed body must not become evidence.
    await admin.sql`insert into hv_workers (id,classes,body,heartbeat_at) values (${prefix + "-stale"},'[]'::jsonb,${{name: prefix + "-stale", state: "idle", providers: summary}}::jsonb, now()-interval '90 seconds')`;
    await admin.sql`insert into hv_workers (id,classes,body,heartbeat_at) values (${prefix + "-stopped"},'[]'::jsonb,${{name: prefix + "-stopped", state: "stopped", providers: summary}}::jsonb, now())`;
    await admin.sql`insert into hv_workers (id,classes,body,heartbeat_at) values (${prefix + "-bad"},'[]'::jsonb,${{name: prefix + "-bad", state: "busy", providers: [{stage: "final", provider: "mock", id: "https://vendor.invalid/x", state: "open", consecutiveFailures: -1, samples: 0, latencyMs: null, lastOutcome: null, observedAt: null}]}}::jsonb, now())`;
    // A `providers` body that is not an array must reach the validator and be counted, not be filtered away in SQL.
    await admin.sql`insert into hv_workers (id,classes,body,heartbeat_at) values (${prefix + "-shape"},'[]'::jsonb,${{name: prefix + "-shape", state: "idle", providers: {stage: "final"}}}::jsonb, now())`;
    await admin.sql`insert into hv_projects (id,body,delete_after) values (${projectId}, ${{script: "private-screenplay-sentinel"}}::jsonb, now()+interval '1 day')`;
    await admin.sql`insert into hv_jobs (id,project_id,idempotency_key,stage,status,tier,body) values (${jobId},${projectId},${jobId},'animatic','done','free','{}'::jsonb)`;
    const event = async (provider: string, usd: number, ago: string) => {
      await admin.sql`insert into hv_cost_events (id,event_key,project_id,provider,total_usd,body,created_at)
        values (${crypto.randomUUID()},${crypto.randomUUID()},${projectId},${provider},${usd},'{}'::jsonb,now()-${ago}::interval)`;
    };
    await event("mock", 1, "1 hour"); await event("mock", 2, "3 days"); await event("mock", 4, "20 days"); await event("fixture-two", 8, "3 days");
    const value = await probes.database();
    const live = value.providers!.entries.filter(entry => entry.worker.startsWith(prefix));
    expect(live.map(entry => entry.worker)).toEqual([prefix + "-live", prefix + "-live"]);
    expect(live[0]).toMatchObject({stage: "final", provider: "mock", id: "mock", state: "open", consecutiveFailures: 3, lastOutcome: "error"});
    expect(live[1]).toMatchObject({stage: "animatic", provider: "other", id: "legacy-mock", state: "unknown", consecutiveFailures: 0, observedAt: null});
    expect(value.providers!.dropped).toBeGreaterThanOrEqual(2); expect(value.providers!.truncated).toBe(false);
    expect(value.providers!.entries.some(entry => entry.worker === prefix + "-stale" || entry.worker === prefix + "-stopped" || entry.worker === prefix + "-bad")).toBe(false);
    const mock = value.costs!.byProvider.find(row => row.provider === "mock")!, other = value.costs!.byProvider.find(row => row.provider === "fixture-two")!;
    expect(mock.dayUsd - (before.costs!.byProvider.find(row => row.provider === "mock")?.dayUsd ?? 0)).toBeCloseTo(1, 6);
    expect(mock.weekUsd - (before.costs!.byProvider.find(row => row.provider === "mock")?.weekUsd ?? 0)).toBeCloseTo(3, 6);
    expect(mock.monthUsd - (before.costs!.byProvider.find(row => row.provider === "mock")?.monthUsd ?? 0)).toBeCloseTo(7, 6);
    expect(other).toMatchObject({dayUsd: 0, weekUsd: 8, monthUsd: 8, events: 1});
    expect(value.costs!.totals.monthUsd).toBeCloseTo(value.budget.recordedMonthUsd, 6);
    expect(value.costs!.dailyAverageUsd).toBeCloseTo(value.costs!.totals.monthUsd / 30, 9);
    expect(value.costs!.lastDayVsAverage).toBeCloseTo(value.costs!.totals.dayUsd / (value.costs!.totals.monthUsd / 30), 6);
    const serialized = JSON.stringify(value);
    expect(serialized).not.toContain(projectId); expect(serialized).not.toContain(jobId); expect(serialized).not.toContain("private-screenplay-sentinel");
  } finally {
    await admin.sql`delete from hv_workers where id like ${prefix + "%"} or body->>'name' like ${prefix + "%"}`;
    await admin.sql`delete from hv_cost_events where project_id = ${projectId}`;
    await admin.sql`delete from hv_jobs where id = ${jobId}`;
    await admin.sql`delete from hv_projects where id = ${projectId}`;
    await Promise.all([probes.close(), worker.close(), admin.close()]);
  }
});

(registryEnabled ? test : test.skip)("an oversized circuit summary is dropped from the heartbeat body rather than truncated into it", async () => {
  const admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!), worker = new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!);
  const prefix = "heartbeat-" + crypto.randomUUID(), health = new ProviderHealth();
  try {
    await admin.migrate();
    const pool = (index: number) => ({stage: "final", provider: "mock", id: "pool-" + index, key: "revision-" + index});
    for (let index = 0; index < 24; index++) health.record("revision-" + index, true, 30);
    const normal = health.summary(Array.from({length: 24}, (_, index) => pool(index)));
    expect(normal).toHaveLength(24); expect(JSON.stringify(normal).length).toBeLessThanOrEqual(8192);
    const id = prefix + "-a-" + crypto.randomUUID();
    await new PostgresWorkerRegistry(worker, id, prefix + "-a").heartbeat("idle", null, normal);
    expect((await admin.sql`select body from hv_workers where id = ${id}`)[0].body.providers).toHaveLength(24);
    // Even 24 rows at the maximum 80-character pool id stay well inside the cap, so a worker's own summary never trips it.
    const widest = health.summary(Array.from({length: 24}, (_, index) => ({...pool(index), id: String(index).padStart(80, "x")})));
    expect(JSON.stringify(widest).length).toBeLessThanOrEqual(8192);
    // The cap exists for anything else that reaches the heartbeat: an oversized body is dropped whole, never truncated into the row.
    const wide = Array.from({length: 64}, (_, index) => ({...normal[0]!, id: String(index).padStart(200, "x")}));
    expect(JSON.stringify(wide).length).toBeGreaterThan(8192);
    const wideId = prefix + "-b-" + crypto.randomUUID();
    await new PostgresWorkerRegistry(worker, wideId, prefix + "-b").heartbeat("busy", null, wide);
    const stored = (await admin.sql`select body from hv_workers where id = ${wideId}`)[0].body;
    expect(stored.providers).toBeUndefined(); expect(stored.state).toBe("busy"); expect(stored.name).toBe(prefix + "-b");
    const emptyId = prefix + "-c-" + crypto.randomUUID();
    await new PostgresWorkerRegistry(worker, emptyId, prefix + "-c").heartbeat("idle", null, []);
    expect((await admin.sql`select body from hv_workers where id = ${emptyId}`)[0].body.providers).toBeUndefined();
  } finally {
    await admin.sql`delete from hv_workers where id like ${prefix + "%"}`;
    await Promise.all([worker.close(), admin.close()]);
  }
});
