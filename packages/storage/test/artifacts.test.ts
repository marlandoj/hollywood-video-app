import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PostgresArtifactStore, artifactKey, byteRange, objectClient } from "../src/artifacts";
import { StudioDatabase } from "../src/database";
import { PostgresProjectService } from "../src/projects";
import { PostgresJobStore } from "../src/jobs";
import { PostgresCostLedger } from "../src/ledger";
import { PostgresReviewQueue } from "../src/reviews";
import { createApiServer, type ApiServer } from "../../api/src/server";
import { DeterministicMockProvider } from "../../generator/src/index";
import { processNextJob } from "../../queue/src/worker";
import { parseFountain } from "../../parser/src/index";
import { planShots } from "../../planner/src/index";

test("artifact keys and ranges reject traversal, cross-job access and invalid byte windows", () => {
  expect(artifactKey("p/j/clips/a.mp4", "p", "j")).toBe("p/j/clips/a.mp4");
  for (const key of ["p/j/../../secret", "p/j//a", "p/other/a.mp4", "/p/j/a", "p/j/%2e%2e/a", "p/j/./a", "p/j/a\\b"])
    expect(() => artifactKey(key, "p", "j")).toThrow();
  expect(byteRange("bytes=0-9", 100)).toEqual({start: 0, end: 9});
  expect(byteRange("bytes=-10", 100)).toEqual({start: 90, end: 99});
  expect(byteRange("bytes=50-", 100)).toEqual({start: 50, end: 99});
  expect(byteRange("bytes=50-999", 100)).toEqual({start: 50, end: 99});
  for (const value of ["bytes=100-", "bytes=-0", "bytes=9-0", "bytes=0-1,3-4", "garbage"])
    expect(() => byteRange(value, 100)).toThrow();
});
const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_API_DATABASE_URL && process.env.HV_WORKER_DATABASE_URL && process.env.HV_S3_ENDPOINT);
const s3test = enabled ? test : test.skip;
let admin: StudioDatabase, api: StudioDatabase, worker: StudioDatabase, root: string, projectId: string, server: ApiServer;
beforeAll(async () => {
  if (!enabled) return;
  process.env.HV_TOKEN_SECRET = "postgres-s3-fixture-secret-of-at-least-thirty-two-characters";
  admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!);
  api = new StudioDatabase(process.env.HV_API_DATABASE_URL!);
  worker = new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!);
  root = mkdtempSync(join(tmpdir(), "hv-s3-test-"));
  await admin.migrate();
});
afterAll(async () => {
  if (!enabled) return;
  await server?.stop(true);
  if (projectId) {
    const objects = await admin.sql`select object_key from hv_artifacts where project_id = ${projectId}`;
    for (const object of objects) await objectClient().file(object.object_key).delete();
    await admin.sql`delete from hv_reservations where job_id in (select id from hv_jobs where project_id = ${projectId})`;
    await admin.sql`delete from hv_cost_events where project_id = ${projectId}`;
    await admin.sql`delete from hv_provider_attempts where project_id = ${projectId}`;
    await admin.sql`delete from hv_outbox where project_id = ${projectId}`;
    await admin.sql`delete from hv_operator_reviews where project_id = ${projectId}`;
    await admin.sql`delete from hv_jobs where project_id = ${projectId}`;
    await admin.sql`delete from hv_reviews where project_id = ${projectId}`;
    await admin.sql`delete from hv_artifacts where project_id = ${projectId}`;
    await admin.sql`delete from hv_projects where id = ${projectId}`;
  }
  await Promise.all([admin.close(), api.close(), worker.close()]);
  rmSync(root, {recursive: true, force: true});
});
s3test("S3 multipart objects stay private and a replacement worker resumes verified clips in a different cache", async () => {
  const projects = new PostgresProjectService(api);
  const owner = await projects.createAnonymousProject(); projectId = owner.projectId;
  const script = "INT. ROOM - DAY\n\nA lamp glows.\n\nEXT. GARDEN - DAY\n\nA leaf falls.";
  await projects.editScript(owner.token, script); await projects.attestRights(owner.token);
  const first = new PostgresJobStore(worker), next = new PostgresJobStore(worker);
  const id = crypto.randomUUID();
  await first.enqueue({id, idempotencyKey: id, projectId, stage: "animatic", tier: "free", scriptVersion: 1,
    totalFrames: 60, retryPolicy: {maxRetries: 1, backoffMs: 0}, timeoutMs: 60_000, costCapUsd: 1, budgetReservedUsd: 0,
    scriptText: script, rightsAttestedAt: new Date().toISOString(), animaticJobId: null, animaticApprovedAt: null});
  const job = (await first.claimNext(Date.now(), {}, {workerId: "original", leaseMs: 60_000}))!;
  const cacheA = join(root, "worker-a"), cacheB = join(root, "worker-b");
  const artifactsA = new PostgresArtifactStore(worker, cacheA), artifactsB = new PostgresArtifactStore(worker, cacheB);
  const dir = join(cacheA, projectId, id, "clips"); mkdirSync(dir, {recursive: true});
  const planned = planShots(parseFountain(script), 7000, 24);
  const provider = new DeterministicMockProvider();
  const firstClip = await provider.generate(planned[0]!.prompt, planned[0]!.seed, {seed: planned[0]!.seed, durationSec: 1, widthxheight: "640x360"}, join(dir, "first.mp4"));
  const largePath = join(cacheA, projectId, id, "multipart.bin");
  writeFileSync(largePath, Buffer.alloc(10 * 1024 ** 2, 0x61));
  await artifactsA.publishExport(job, "original", [largePath]);
  const large = (await admin.sql`select object_key, bytes from hv_artifacts where key = ${projectId + "/" + id + "/multipart.bin"}`)[0];
  expect(Number(large.bytes)).toBe(10 * 1024 ** 2);
  const anonymous = await fetch(process.env.HV_S3_ENDPOINT + "/" + process.env.HV_S3_BUCKET + "/" + large.object_key);
  expect(anonymous.status).toBe(403); await anonymous.text();
  await artifactsA.checkpoint(job, "original", [firstClip], 30, 300);
  const localBytes = readFileSync(firstClip.path);
  rmSync(cacheA, {recursive: true, force: true});
  await Bun.sleep(400);
  let generated = 0;
  const resumedProvider = {name: "resume-fixture", model: "mock", generate: (...args: Parameters<DeterministicMockProvider["generate"]>) => {
    generated++; return provider.generate(...args);
  }};
  const completed = await processNextJob(next, cacheB, {workerId: "replacement", artifacts: artifactsB,
    ledger: new PostgresCostLedger(worker), reviewQueue: new PostgresReviewQueue(worker), animaticProvider: resumedProvider});
  expect(completed?.status).toBe("done");
  expect(completed?.resumedCount).toBe(1);
  expect(completed?.checkpointShots).toBe(2);
  expect(generated).toBe(1);
  expect(existsSync(join(cacheB,projectId,id))).toBe(false);
  await artifactsB.restoreCheckpoint(completed!);
  expect(readFileSync(join(cacheB, projectId, id, "clips/first.mp4"))).toEqual(localBytes);
  await expect(first.heartbeat(id, "original")).rejects.toMatchObject({reason: "fence_changed"});
  server = createApiServer({port: 0, hostname: "127.0.0.1", storage: "postgres", artifactStorage: "s3", tls: null,
    databaseUrl: process.env.HV_API_DATABASE_URL, artifactRoot: join(root, "api-cache")});
  const view = await fetch(new URL("/api/jobs/" + id, server.url), {headers: {authorization: "Bearer " + owner.token}});
  const body = await view.json() as {output: {mp4Url: string; captionsUrl: string; hlsUrl: string}};
  const range = await fetch(new URL(body.output.mp4Url, server.url), {headers: {range: "bytes=0-31"}});
  expect(range.status).toBe(206); expect((await range.arrayBuffer()).byteLength).toBe(32);
  expect(range.headers.get("cache-control")).toBe("private, no-store");
  expect((await fetch(new URL(body.output.mp4Url, server.url), {headers: {range: "bytes=99999999999-"}})).status).toBe(416);
  const captions = await fetch(new URL(body.output.captionsUrl, server.url));
  expect(captions.status).toBe(200); expect(await captions.text()).toContain("WEBVTT");
  const hls = await fetch(new URL(body.output.hlsUrl, server.url));
  expect(hls.status).toBe(200); expect(await hls.text()).toContain("#EXTM3U");
  await projects.takedown(projectId, "fixture cleanup");
  expect((await fetch(new URL(body.output.mp4Url, server.url))).status).toBe(404);
}, 60_000);
