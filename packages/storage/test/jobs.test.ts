import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { PostgresJobStore } from "../src/jobs";
import { StudioDatabase } from "../src/database";
import type { Job, JobInput } from "../../queue/src/index";

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_API_DATABASE_URL && process.env.HV_WORKER_DATABASE_URL);
const pgtest = enabled ? test : test.skip;
let admin: StudioDatabase, api: StudioDatabase, worker: StudioDatabase;
const projectIds = Array.from({length: 5}, () => crypto.randomUUID());
function input(projectId: string, id = crypto.randomUUID()): JobInput {
  return {id, projectId, idempotencyKey: id, tier: "free", stage: "animatic", scriptVersion: 1,
    scriptText: "EXT. GARDEN - DAY\n\nA leaf falls.", rightsAttestedAt: new Date().toISOString(),
    animaticJobId: null, animaticApprovedAt: null, totalFrames: 240, retryPolicy: {maxRetries: 1, backoffMs: 10},
    timeoutMs: 60_000, costCapUsd: 1};
}
beforeAll(async () => {
  if (!enabled) return;
  admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!);
  api = new StudioDatabase(process.env.HV_API_DATABASE_URL!);
  worker = new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!);
  await admin.migrate();
});
afterAll(async () => {
  if (!enabled) return;
  for (const projectId of projectIds) {
    await admin.sql`delete from hv_outbox where project_id = ${projectId}`;
    await admin.sql`delete from hv_jobs where project_id = ${projectId}`;
  }
  await Promise.all([admin.close(), api.close(), worker.close()]);
});

pgtest("concurrent job admission is idempotent and capability-scoped", async () => {
  const scoped = new PostgresJobStore(api).forProject(projectIds[0]!);
  const job = input(projectIds[0]!);
  const admitted = await Promise.all(Array.from({length: 12}, () => scoped.enqueue({...job, id: crypto.randomUUID()})));
  expect(new Set(admitted.map(value => value.id)).size).toBe(1);
  expect(await scoped.all()).toHaveLength(1);
  expect(await new PostgresJobStore(api).all()).toHaveLength(0);
  expect(await new PostgresJobStore(api).forProject(projectIds[1]!).get(admitted[0]!.id)).toBeUndefined();
  await expect(new PostgresJobStore(api).forProject(projectIds[1]!).enqueue(input(projectIds[0]!))).rejects.toThrow();
  await scoped.setStatus(admitted[0]!.id, "cancelled");
});

pgtest("separate PostgreSQL worker processes claim distinct jobs and respect per-project capacity", async () => {
  const store = new PostgresJobStore(worker);
  for (const projectId of projectIds.slice(1, 4)) {
    for (let i = 0; i < 3; i++) await store.enqueue(input(projectId));
  }
  const fixture = resolve(import.meta.dir, "fixtures", "claimer.ts");
  const claims = await Promise.all(Array.from({length: 6}, async (_, index) => {
    const child = Bun.spawn([process.execPath, fixture, "pg-worker-" + index], {stdout: "pipe", stderr: "pipe", env: process.env});
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (code !== 0) throw new Error("worker fixture failed: " + stderr);
    return JSON.parse(stdout) as Job | null;
  }));
  const running = claims.filter((job): job is Job => Boolean(job));
  expect(running).toHaveLength(3);
  expect(new Set(running.map(job => job.id)).size).toBe(3);
  expect(new Set(running.map(job => job.projectId)).size).toBe(3);
  expect(running.every(job => job.leaseVersion === 1)).toBe(true);
  for (const job of await store.all()) if (projectIds.slice(1, 4).includes(job.projectId as typeof projectIds[number])) await store.setStatus(job.id, "cancelled");
}, 20_000);

pgtest("reclaimed jobs preserve checkpoints and reject an old instance even with the same worker name", async () => {
  const first = new PostgresJobStore(worker), next = new PostgresJobStore(worker);
  const job = await first.enqueue(input(projectIds[4]!));
  const now = Date.now();
  expect((await first.claimNext(now, {}, {workerId: "same-name", leaseMs: 1000}))!.id).toBe(job.id);
  await first.checkpoint(job.id, "same-name", 2, 48, now + 100, 1000);
  const reclaimed = (await next.claimNext(now + 1200, {}, {workerId: "same-name", leaseMs: 1000}))!;
  expect(reclaimed.id).toBe(job.id);
  expect(reclaimed.checkpointShots).toBe(2);
  expect(reclaimed.leaseVersion).toBe(2);
  expect(reclaimed.resumedCount).toBe(1);
  const output = {mp4Path: "fixture.mp4", hlsPlaylistPath: "fixture.m3u8", captionsPath: "fixture.vtt", manifestPath: "fixture.json"};
  await expect(first.complete(job.id, "same-name", output, now + 1250)).rejects.toMatchObject({reason: "fence_changed"});
  await expect(first.heartbeat(job.id, "same-name", now + 1250)).rejects.toMatchObject({reason: "fence_changed"});
  expect((await next.complete(job.id, "same-name", output, now + 1300)).status).toBe("done");
  const events = await admin.sql`select event_type from hv_outbox where job_id = ${job.id} order by created_at`;
  expect(events.map((row: {event_type: string}) => row.event_type)).toEqual(["job.queued", "job.claimed", "job.checkpoint", "job.resumed", "job.claimed", "job.completed"]);
});
