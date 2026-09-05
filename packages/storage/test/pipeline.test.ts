import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer, type ApiServer } from "../../api/src/server";
import { PostgresProjectService } from "../src/projects";
import { PostgresJobStore } from "../src/jobs";
import { PostgresCostLedger } from "../src/ledger";
import { PostgresReviewQueue } from "../src/reviews";
import { StudioDatabase } from "../src/database";
import { processNextJob } from "../../queue/src/worker";
import type { Job } from "../../queue/src/index";

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_API_DATABASE_URL && process.env.HV_WORKER_DATABASE_URL);
const pgtest = enabled ? test : test.skip;
let admin: StudioDatabase, database: StudioDatabase, server: ApiServer;
let root: string;
const ids: string[] = [];
let initialCap: string | null;
beforeAll(async () => {
  if (!enabled) return;
  process.env.HV_TOKEN_SECRET = "postgres-e2e-fixture-secret-of-at-least-thirty-two-characters";
  root = mkdtempSync(join(tmpdir(), "hv-pg-e2e-"));
  admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!);
  database = new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!);
  await admin.migrate();
  initialCap = (await admin.sql`select monthly_cap_usd from hv_budget_accounts where id = 'operator'`)[0]?.monthly_cap_usd ?? null;
});
afterAll(async () => {
  if (!enabled) return;
  await server?.stop(true);
  for (const id of ids) {
    await admin.sql`delete from hv_reservations where job_id in (select id from hv_jobs where project_id = ${id})`;
    await admin.sql`delete from hv_cost_events where project_id = ${id}`;
    await admin.sql`delete from hv_provider_attempts where project_id = ${id}`;
    await admin.sql`delete from hv_outbox where project_id = ${id}`;
    await admin.sql`delete from hv_operator_reviews where project_id = ${id}`;
    await admin.sql`delete from hv_jobs where project_id = ${id}`;
    await admin.sql`delete from hv_reviews where project_id = ${id}`;
    await admin.sql`delete from hv_projects where id = ${id}`;
  }
  if (initialCap === null) await admin.sql`delete from hv_budget_accounts where id = 'operator'`;
  else await admin.sql`update hv_budget_accounts set monthly_cap_usd = ${initialCap} where id = 'operator'`;
  await Promise.all([admin.close(), database.close()]);
  rmSync(root, {recursive: true, force: true});
});
const start = () => createApiServer({port: 0, hostname: "127.0.0.1", storage: "postgres", tls: null,
  databaseUrl: process.env.HV_API_DATABASE_URL, artifactRoot: root,
  rateLimit: {api: {limit: 1000, windowMs: 60_000}}});
async function request(path: string, method = "GET", body?: unknown, token?: string): Promise<Response> {
  const options: RequestInit = {method, headers: {
    ...(token ? {authorization: "Bearer " + token} : {}),
    ...(body === undefined ? {} : {"content-type": "application/json"}),
  }};
  if (body !== undefined) options.body = JSON.stringify(body);
  return fetch(new URL(path, server.url), options);
}

pgtest("PostgreSQL API and worker preserve a complete reviewed export across API restart", async () => {
  server = start();
  const project = await (await request("/api/projects", "POST")).json() as {projectId: string; token: string};
  ids.push(project.projectId);
  const base = "/api/projects/" + project.projectId;
  const script = "INT. ROOM - DAY\n\nA lamp glows.\n\nSAM\nHello there.";
  expect((await request(base + "/script", "PUT", {text: script}, project.token)).status).toBe(200);
  expect((await request(base + "/rights", "POST", {attested: true}, project.token)).status).toBe(200);
  const admitted = await Promise.all(Array.from({length: 4}, async () => {
    const response = await request(base + "/jobs", "POST", {stage: "animatic", idempotencyKey: "preview"}, project.token);
    expect(response.status).toBe(202);
    return await response.json() as {jobId: string};
  }));
  expect(new Set(admitted.map(result => result.jobId)).size).toBe(1);
  const jobId = admitted[0]!.jobId;
  const store = new PostgresJobStore(database);
  const context = {ledger: new PostgresCostLedger(database), reviewQueue: new PostgresReviewQueue(database), workerId: "e2e-preview"};
  const preview = await processNextJob(store, root, context);
  expect(preview?.id).toBe(jobId);
  expect(preview?.status).toBe("done");
  expect(preview?.checkpointShots).toBe(1);
  await server.stop(true);
  server = start();
  const restored = await (await request(base, "GET", undefined, project.token)).json() as {script: string; jobs: Job[]};
  expect(restored.script).toBe(script);
  expect(restored.jobs.some(job => job.id === jobId && job.status === "done")).toBe(true);
  const other = await (await request("/api/projects", "POST")).json() as {projectId: string; token: string};
  ids.push(other.projectId);
  expect((await request("/api/jobs/" + jobId, "GET", undefined, other.token)).status).toBe(404);
  expect((await request(base + "/animatic/decision", "POST", {animaticJobId: jobId, decision: "approved"}, project.token)).status).toBe(201);
  const finalResponse = await request(base + "/jobs", "POST", {stage: "final", animaticJobId: jobId}, project.token);
  expect(finalResponse.status).toBe(202);
  const finalId = (await finalResponse.json() as {jobId: string}).jobId;
  const final = await processNextJob(store, root, {...context, workerId: "e2e-final"});
  expect(final?.id).toBe(finalId);
  expect(final?.status).toBe("done");
  const published = await (await request("/api/jobs/" + finalId, "GET", undefined, project.token)).json() as {output: {mp4Url: string; captionsUrl: string}};
  const video = await request(published.output.mp4Url);
  expect(video.status).toBe(200);
  expect(video.headers.get("content-type")).toBe("video/mp4");
  await video.arrayBuffer();
  const captions = await request(published.output.captionsUrl);
  expect(captions.status).toBe(200);
  expect(await captions.text()).toContain("Hello there.");
  expect(await context.ledger.reservedUsd()).toBe(0);
  const attempts = await admin.sql`select status from hv_provider_attempts where project_id = ${project.projectId}`;
  expect(attempts).toHaveLength(2);
  expect(attempts.every((row: {status: string}) => row.status === "succeeded")).toBe(true);
  const health = await (await request("/health")).json() as {status: string; queueDepth: number; runningJobs: number};
  expect(health).toMatchObject({status: "healthy", queueDepth: 0, runningJobs: 0});
  await new PostgresProjectService(database).takedown(project.projectId, "fixture cleanup");
  expect((await request(published.output.mp4Url)).status).toBe(404);
  expect((await request(base, "GET", undefined, project.token)).status).toBe(401);
}, 60_000);

pgtest("lease loss aborts the active provider and prevents secondary inference", async () => {
  const {projectId} = await new PostgresProjectService(database).createAnonymousProject(); ids.push(projectId);
  const id = crypto.randomUUID();
  const store = new PostgresJobStore(database), replacement = new PostgresJobStore(database);
  await store.enqueue({id, idempotencyKey: id, projectId, tier: "free", stage: "animatic", scriptVersion: 1,
    totalFrames: 30, retryPolicy: {maxRetries: 1, backoffMs: 1}, timeoutMs: 60_000, costCapUsd: 1, budgetReservedUsd: 0,
    scriptText: "EXT. GARDEN - DAY\n\nA leaf falls.", rightsAttestedAt: new Date().toISOString(),
    animaticJobId: null, animaticApprovedAt: null});
  let now = Date.now(), aborted = false, calls = 0;
  let started!: () => void;
  const active = new Promise<void>(resolve => { started = resolve; });
  const provider = {name: "lease-fixture", model: "abortable", async generate(_prompt: string, _seed: number, params: {signal?: AbortSignal}): Promise<never> {
    calls++; started();
    return new Promise((_, reject) => params.signal!.addEventListener("abort", () => {aborted = true; reject(params.signal!.reason);}, {once: true}));
  }};
  const processing = processNextJob(store, root, {ledger: new PostgresCostLedger(database), reviewQueue: new PostgresReviewQueue(database),
    workerId: "old-worker", leaseMs: 150, now: () => now, animaticProvider: provider});
  await active;
  now += 500;
  expect((await replacement.claimNext(now, {}, {workerId: "new-worker", leaseMs: 1000}))!.id).toBe(id);
  expect((await processing)!.claimedBy).toBe("new-worker");
  expect(aborted).toBe(true);
  expect(calls).toBe(1);
  expect((await replacement.get(id))!.status).toBe("running");
  await replacement.setStatus(id, "cancelled");
  await new PostgresCostLedger(database).release(id);
}, 10_000);
