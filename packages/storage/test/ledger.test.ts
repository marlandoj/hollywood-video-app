import { afterAll, beforeAll, expect, test } from "bun:test";
import { PostgresCostLedger } from "../src/ledger";
import { PostgresJobStore } from "../src/jobs";
import { StudioDatabase } from "../src/database";
import type { CostEvent } from "../../operator/src/index";

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_WORKER_DATABASE_URL);
const pgtest = enabled ? test : test.skip;
let admin: StudioDatabase, database: StudioDatabase, ledger: PostgresCostLedger;
let priorCap: string | null = null;
const projectId = crypto.randomUUID();
const ids: string[] = [];
const id = () => { const value = crypto.randomUUID(); ids.push(value); return value; };
beforeAll(async () => {
  if (!enabled) return;
  admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!);
  database = new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!);
  ledger = new PostgresCostLedger(database);
  await admin.migrate();
  priorCap = (await admin.sql`select monthly_cap_usd from hv_budget_accounts where id = 'operator'`)[0]?.monthly_cap_usd ?? null;
});
afterAll(async () => {
  if (!enabled) return;
  for (const value of ids) await admin.sql`delete from hv_reservations where job_id = ${value}`;
  await admin.sql`delete from hv_cost_events where project_id = ${projectId}`;
  await admin.sql`delete from hv_provider_attempts where project_id = ${projectId}`;
  await admin.sql`delete from hv_outbox where project_id = ${projectId}`;
  await admin.sql`delete from hv_jobs where project_id = ${projectId}`;
  if (priorCap !== null) await admin.sql`update hv_budget_accounts set monthly_cap_usd = ${priorCap} where id = 'operator'`;
  else await admin.sql`delete from hv_budget_accounts where id = 'operator'`;
  await Promise.all([admin.close(), database.close()]);
});

pgtest("concurrent budget reservations never exceed shared monthly capacity", async () => {
  const result = await Promise.allSettled(Array.from({length: 20}, () => ledger.reserve(id(), "animatic", 0.01, 0.06)));
  expect(result.filter(value => value.status === "fulfilled")).toHaveLength(6);
  expect(result.filter(value => value.status === "rejected")).toHaveLength(14);
  expect(await ledger.reservedUsd()).toBeCloseTo(0.06, 6);
  for (const value of ids) await ledger.release(value);
  expect(await ledger.reservedUsd()).toBe(0);
});

pgtest("attempt holds survive uncertain failures, costs replay once, and stale workers cannot dispatch", async () => {
  const store = new PostgresJobStore(database);
  const jobId = id();
  await store.enqueue({id: jobId, idempotencyKey: jobId, projectId, tier: "free", stage: "animatic", scriptVersion: 1,
    totalFrames: 30, retryPolicy: {maxRetries: 1, backoffMs: 1}, timeoutMs: 60_000, costCapUsd: 0.03,
    scriptText: "EXT. FIELD - DAY\n\nGrass bends.", rightsAttestedAt: new Date().toISOString(),
    animaticJobId: null, animaticApprovedAt: null});
  await ledger.reserve(jobId, "animatic", 0.03, 0.06);
  const now = Date.now();
  const claimed = (await store.claimNext(now, {}, {workerId: "billing-fixture", leaseMs: 1000}))!;
  const attempt = {id: crypto.randomUUID(), projectId, jobId, shotId: "shot-1", provider: "fixture",
    workerId: "billing-fixture", leaseVersion: claimed.leaseVersion!, estimateUsd: 0.02};
  await ledger.beginAttempt(attempt, now + 10);
  await expect(ledger.beginAttempt(attempt, now + 20)).rejects.toThrow("already been dispatched");
  await expect(ledger.beginAttempt({...attempt, id: crypto.randomUUID()}, now + 20)).rejects.toThrow("budget");
  await ledger.finishAttempt(attempt.id, "unknown");
  await ledger.release(jobId);
  expect(await ledger.reservedUsd()).toBeCloseTo(0.02, 6);
  const second = new PostgresJobStore(database);
  await second.claimNext(now + 1100, {}, {workerId: "replacement", leaseMs: 1000});
  await expect(ledger.beginAttempt({...attempt, id: crypto.randomUUID()}, now + 1200)).rejects.toMatchObject({reason: "wrong_worker"});
  const event: CostEvent = {eventId: attempt.id + ":0", attemptId: attempt.id, at: new Date(now).toISOString(),
    projectId, jobId, shotId: "shot-1", stage: "animatic", provider: "fixture", model: "mock-bill",
    prompt_tokens: 1, output_frames: 30, gpu_seconds: 0.1, total_cost_usd: 0.02};
  await Promise.all(Array.from({length: 8}, () => ledger.record(event)));
  expect(await ledger.jobSpend(jobId)).toBe(0.02);
  expect((await store.get(jobId))!.costUsd).toBe(0.02);
  expect((await store.get(jobId))!.claimedBy).toBe("replacement");
  expect((await ledger.all()).filter(value => value.jobId === jobId)).toHaveLength(1);
  await ledger.finishAttempt(attempt.id, "failed");
  await second.setStatus(jobId, "cancelled");
  await ledger.release(jobId);
  expect(await ledger.reservedUsd()).toBe(0);
});
