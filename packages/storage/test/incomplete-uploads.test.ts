import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { SQL } from "bun";
import { StudioDatabase } from "../src/database";
import { PostgresProjectService } from "../src/projects";
import { PostgresJobStore } from "../src/jobs";
import { PostgresRetention } from "../src/retention";
import { S3RequestError, multipartClient, type MultipartUpload, type MultipartUploadClient, type MultipartUploadListing } from "../src/s3-requests";

const DAY = 864e5;

/** Answers the three retention queries from an in-memory project table; no PostgreSQL needed. */
function fakeDatabase(projects: Record<string,{active: boolean}>): StudioDatabase {
  return {forProject: async <T>(projectId: string, fn: (tx: SQL) => Promise<T>): Promise<T> => {
    const tx = async (strings: TemplateStringsArray): Promise<Record<string,unknown>[]> => {
      const text = strings.join("?");
      if (text.includes("pg_try_advisory_xact_lock")) return [{acquired: true}];
      if (text.includes("from hv_projects")) return projectId in projects ? [{id: projectId}] : [];
      if (text.includes("from hv_jobs")) return projects[projectId]?.active ? [{id: "job"}] : [];
      throw new Error("unexpected retention query: " + text);
    };
    return fn(tx as unknown as SQL);
  }} as unknown as StudioDatabase;
}
class FakeMultipartClient implements MultipartUploadClient {
  readonly calls: {prefix: string; keyMarker?: string; uploadIdMarker?: string}[] = [];
  readonly aborted: string[] = [];
  readonly failing = new Set<string>();
  unsupported: S3RequestError | Error | null = null;
  constructor(readonly uploads: MultipartUpload[], private readonly pageSize = 1000) {}
  async listMultipartUploads(input: {prefix: string; keyMarker?: string; uploadIdMarker?: string}): Promise<MultipartUploadListing> {
    this.calls.push({prefix: input.prefix, keyMarker: input.keyMarker, uploadIdMarker: input.uploadIdMarker});
    if (this.unsupported) throw this.unsupported;
    const ordered = this.uploads.filter(upload => upload.key.startsWith(input.prefix))
      .sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : a.uploadId < b.uploadId ? -1 : 1)
      .filter(upload => input.keyMarker === undefined || upload.key > input.keyMarker || (upload.key === input.keyMarker && upload.uploadId > (input.uploadIdMarker ?? "")));
    const page = ordered.slice(0, this.pageSize), isTruncated = ordered.length > page.length;
    return {uploads: page, isTruncated, nextKeyMarker: isTruncated ? page.at(-1)!.key : undefined, nextUploadIdMarker: isTruncated ? page.at(-1)!.uploadId : undefined};
  }
  async abortMultipartUpload(key: string, uploadId: string): Promise<void> {
    if (this.failing.has(uploadId)) throw new Error("injected abort failure");
    const index = this.uploads.findIndex(upload => upload.key === key && upload.uploadId === uploadId);
    if (index < 0) throw new S3RequestError("object store DELETE returned HTTP 404", 404, "NoSuchUpload");
    this.uploads.splice(index, 1); this.aborted.push(uploadId);
  }
}
const stale = (key: string, uploadId: string, now: number): MultipartUpload => ({key, uploadId, initiated: new Date(now - 2 * DAY).toISOString()});

test("an abort failure is counted, does not stop the pass, and is retried by the next pass", async () => {
  const now = Date.now();
  const client = new FakeMultipartClient([stale("v1/idle/j/a.bin", "u1", now), stale("v1/idle/j/b.bin", "u2", now), stale("archives/idle/c.zip", "u3", now)]);
  client.failing.add("u2");
  const retention = new PostgresRetention(fakeDatabase({idle: {active: false}}), undefined, client);
  expect(await retention.collectIncompleteUploads(now)).toEqual({aborted: 2, retained: 0, failed: 1, supported: true});
  expect(client.aborted).toEqual(["u1", "u3"]);
  expect(client.uploads.map(upload => upload.uploadId)).toEqual(["u2"]);
  client.failing.clear();
  expect(await retention.collectIncompleteUploads(now)).toEqual({aborted: 1, retained: 0, failed: 0, supported: true});
  expect(client.uploads).toEqual([]);
  expect(await retention.collectIncompleteUploads(now)).toEqual({aborted: 0, retained: 0, failed: 0, supported: true});
});

test("live, foreign and out-of-namespace uploads are retained and only the two namespaces are listed", async () => {
  const now = Date.now();
  const client = new FakeMultipartClient([
    {key: "v1/idle/j/fresh.bin", uploadId: "fresh", initiated: new Date(now - 3600e3).toISOString()},
    stale("v1/busy/j/active.bin", "active", now),
    stale("v1/unknown-project/j/foreign.bin", "foreign", now),
    stale("scratch/idle/outside.bin", "outside", now),
    {key: "v1/idle/j/unparsable.bin", uploadId: "unparsable", initiated: "not a date"},
    stale("v1/../escape.bin", "escape", now),
    stale("v1/idle/j/old.bin", "old", now),
  ]);
  const retention = new PostgresRetention(fakeDatabase({idle: {active: false}, busy: {active: true}}), undefined, client);
  expect(await retention.collectIncompleteUploads(now)).toEqual({aborted: 1, retained: 5, failed: 0, supported: true});
  expect(client.aborted).toEqual(["old"]);
  expect(client.calls.map(call => call.prefix)).toEqual(["v1/", "archives/"]);
  expect(client.uploads.map(upload => upload.uploadId).sort()).toEqual(["active", "escape", "foreign", "fresh", "outside", "unparsable"]);
  // The grace is measured against the pass clock: two days later the fresh upload is stale and its idle project releases it.
  expect(await retention.collectIncompleteUploads(now + 2 * DAY)).toEqual({aborted: 1, retained: 4, failed: 0, supported: true});
  expect(client.aborted).toEqual(["old", "fresh"]);
  await expect(retention.collectIncompleteUploads(now, 3600e3 - 1)).rejects.toThrow("invalid incomplete upload collection bounds");
  for (const maxPages of [0, 1001, 1.5, Number.NaN]) await expect(retention.collectIncompleteUploads(now, DAY, maxPages)).rejects.toThrow("bounds");
  expect(await retention.collectIncompleteUploads(now, 3600e3, 1000)).toEqual({aborted: 0, retained: 4, failed: 0, supported: true});
  expect(client.uploads.map(upload => upload.uploadId).sort()).toEqual(["active", "escape", "foreign", "outside", "unparsable"]);
});

test("a store without ListMultipartUploads reports supported=false without throwing; other errors propagate", async () => {
  const now = Date.now();
  for (const error of [new S3RequestError("object store GET returned HTTP 501", 501, null), new S3RequestError("object store GET returned HTTP 400", 400, "NotImplemented"),
    new S3RequestError("object store GET returned HTTP 405", 405, "MethodNotAllowed")]) {
    const client = new FakeMultipartClient([stale("v1/idle/j/a.bin", "u1", now)]);
    client.unsupported = error;
    const retention = new PostgresRetention(fakeDatabase({idle: {active: false}}), undefined, client);
    expect(await retention.collectIncompleteUploads(now)).toEqual({aborted: 0, retained: 0, failed: 0, supported: false});
    expect(client.uploads.length).toBe(1);
  }
  const outage = new FakeMultipartClient([stale("v1/idle/j/a.bin", "u1", now)]);
  outage.unsupported = new S3RequestError("object store GET returned HTTP 503", 503, "SlowDown");
  await expect(new PostgresRetention(fakeDatabase({idle: {active: false}}), undefined, outage).collectIncompleteUploads(now)).rejects.toThrow("HTTP 503");
  const network = new FakeMultipartClient([stale("v1/idle/j/a.bin", "u1", now)]);
  network.unsupported = new Error("connection refused");
  await expect(new PostgresRetention(fakeDatabase({idle: {active: false}}), undefined, network).collectIncompleteUploads(now)).rejects.toThrow("connection refused");
});

test("a truncated listing resumes from the retained key and upload-id markers within and across passes", async () => {
  const now = Date.now();
  const uploads = () => ["a", "b", "c", "d", "e"].map(name => stale(`v1/idle/j/${name}.bin`, "u-" + name, now));
  const paged = new FakeMultipartClient(uploads(), 2);
  const retention = new PostgresRetention(fakeDatabase({idle: {active: false}}), undefined, paged);
  expect(await retention.collectIncompleteUploads(now, DAY, 100)).toEqual({aborted: 5, retained: 0, failed: 0, supported: true});
  expect(paged.calls.filter(call => call.prefix === "v1/").map(call => call.keyMarker)).toEqual([undefined, "v1/idle/j/b.bin", "v1/idle/j/d.bin"]);
  expect(paged.calls.filter(call => call.prefix === "v1/").map(call => call.uploadIdMarker)).toEqual([undefined, "u-b", "u-d"]);
  expect(paged.calls.filter(call => call.prefix === "archives/").length).toBe(1);
  const bounded = new FakeMultipartClient(uploads(), 2);
  const resumable = new PostgresRetention(fakeDatabase({idle: {active: false}}), undefined, bounded);
  expect(await resumable.collectIncompleteUploads(now, DAY, 1)).toEqual({aborted: 2, retained: 0, failed: 0, supported: true});
  expect(await resumable.collectIncompleteUploads(now, DAY, 1)).toEqual({aborted: 2, retained: 0, failed: 0, supported: true});
  expect(bounded.calls.filter(call => call.prefix === "v1/").map(call => call.keyMarker)).toEqual([undefined, "v1/idle/j/b.bin"]);
  expect(await resumable.collectIncompleteUploads(now, DAY, 1)).toEqual({aborted: 1, retained: 0, failed: 0, supported: true});
  expect(bounded.uploads).toEqual([]);
  expect(await resumable.collectIncompleteUploads(now, DAY, 1)).toEqual({aborted: 0, retained: 0, failed: 0, supported: true});
  expect(bounded.calls.filter(call => call.prefix === "v1/").at(-1)!.keyMarker).toBeUndefined(); // Cursor cleared after the listing ends.
});

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_WORKER_DATABASE_URL && process.env.HV_S3_ENDPOINT);
const s3test = enabled ? test : test.skip;
const name = "hv_lifecycle_test_" + crypto.randomUUID().replaceAll("-", "");
let admin: StudioDatabase, database: StudioDatabase;
const seeded: {key: string; uploadId: string}[] = [];
beforeAll(async () => {
  if (!enabled) return;
  process.env.HV_TOKEN_SECRET = ["lifecycle-fixture", "at-least-thirty-two-characters-long"].join("-");
  admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!);
  await admin.sql.unsafe('CREATE DATABASE "' + name + '"');
  const url = new URL(process.env.HV_PG_ADMIN_URL!); url.pathname = "/" + name;
  const migration = new StudioDatabase(url.href); await migration.migrate(); await migration.close();
  const workerUrl = new URL(process.env.HV_WORKER_DATABASE_URL!); workerUrl.pathname = "/" + name;
  database = new StudioDatabase(workerUrl.href);
});
afterAll(async () => {
  if (!enabled) return;
  const client = multipartClient();
  for (const upload of seeded) await client.abortMultipartUpload(upload.key, upload.uploadId).catch(() => {});
  await database?.close();
  if (!/^hv_lifecycle_test_[a-f0-9]{32}$/.test(name)) throw new Error("unexpected lifecycle fixture database");
  await admin.sql.unsafe('DROP DATABASE "' + name + '"'); await admin.close();
});
s3test("stale incomplete uploads are aborted only for idle known projects; fresh, active, foreign and outside uploads survive", async () => {
  expect((await database.sql`select current_user as role`)[0].role).toBe("hv_worker");
  const projects = new PostgresProjectService(database), store = new PostgresJobStore(database), client = multipartClient();
  const retention = new PostgresRetention(database, undefined, client);
  const idle = await projects.createAnonymousProject(), busy = await projects.createAnonymousProject();
  const foreignProject = crypto.randomUUID(), outsideRun = crypto.randomUUID();
  const seed = async (key: string) => { const uploadId = await client.createMultipartUpload(key); seeded.push({key, uploadId}); await client.uploadPart(key, uploadId, 1, new Uint8Array(512).fill(0x62)); return {key, uploadId}; };
  await seed(`v1/${idle.projectId}/${crypto.randomUUID()}/${"a".repeat(64)}/stale.bin`); // (a) stale for an idle project
  const c = await seed(`archives/${busy.projectId}/${crypto.randomUUID()}/${"c".repeat(64)}.zip`);
  const d = await seed(`v1/${foreignProject}/${crypto.randomUUID()}/${"d".repeat(64)}/foreign.bin`);
  const e = await seed(`scratch/${outsideRun}/outside.bin`);
  const jobId = crypto.randomUUID();
  await store.enqueue({id: jobId, idempotencyKey: jobId, projectId: busy.projectId, stage: "animatic", tier: "free", scriptVersion: 1,
    scriptText: "Private screenplay fixture.", rightsAttestedAt: new Date().toISOString(), animaticJobId: null, animaticApprovedAt: null,
    totalFrames: 30, retryPolicy: {maxRetries: 0, backoffMs: 0}, timeoutMs: 60_000, costCapUsd: 0.03});
  expect((await store.claimNext(Date.now(), {}, {workerId: "lifecycle", leaseMs: 60_000}))?.id).toBe(jobId);
  const listed = async (prefix: string) => (await client.listMultipartUploads({prefix})).uploads.map(upload => upload.uploadId);
  const initiated = (await client.listMultipartUploads({prefix: `v1/${idle.projectId}/`})).uploads[0]!.initiated;
  expect(Number.isFinite(Date.parse(initiated))).toBe(true);
  const future = Date.now() + 2 * DAY;
  const fresh = await retention.collectIncompleteUploads();
  expect(fresh.aborted).toBe(0); expect(fresh.supported).toBe(true); expect(fresh.retained).toBeGreaterThanOrEqual(3);
  const first = await retention.collectIncompleteUploads(future);
  expect(first.aborted).toBe(1); expect(first.failed).toBe(0); expect(first.retained).toBeGreaterThanOrEqual(2);
  expect(await listed(`v1/${idle.projectId}/`)).toEqual([]);
  expect(await listed(`archives/${busy.projectId}/`)).toEqual([c.uploadId]);
  expect(await listed(`v1/${foreignProject}/`)).toEqual([d.uploadId]);
  expect(await listed(`scratch/${outsideRun}/`)).toEqual([e.uploadId]);
  const second = await retention.collectIncompleteUploads(future);
  expect(second.aborted).toBe(0); expect(second.failed).toBe(0);
  await store.setStatus(jobId, "done");
  const third = await retention.collectIncompleteUploads(future);
  expect(third.aborted).toBe(1);
  expect(await listed(`archives/${busy.projectId}/`)).toEqual([]);
  expect(await listed(`v1/${foreignProject}/`)).toEqual([d.uploadId]);
  const b = await seed(`v1/${idle.projectId}/${crypto.randomUUID()}/${"b".repeat(64)}/fresh.bin`);
  const current = await retention.collectIncompleteUploads();
  expect(current.aborted).toBe(0);
  expect(await listed(`v1/${idle.projectId}/`)).toEqual([b.uploadId]);
  // Injected failure against the real store: the abort throws once, is counted, and the retry succeeds.
  const flaky = await seed(`v1/${idle.projectId}/${crypto.randomUUID()}/${"f".repeat(64)}/flaky.bin`);
  let injected = 0;
  const flakyClient: MultipartUploadClient = {listMultipartUploads: input => client.listMultipartUploads(input),
    abortMultipartUpload: async (key, uploadId) => { if (uploadId === flaky.uploadId && injected++ === 0) throw new Error("injected abort outage"); return client.abortMultipartUpload(key, uploadId); }};
  const flakyRetention = new PostgresRetention(database, undefined, flakyClient);
  const failedPass = await flakyRetention.collectIncompleteUploads(future);
  expect(failedPass.failed).toBe(1); expect(failedPass.aborted).toBe(1); // b is aborted, flaky is counted as failed.
  const retryPass = await flakyRetention.collectIncompleteUploads(future);
  expect(retryPass.failed).toBe(0); expect(retryPass.aborted).toBe(1);
  expect(await listed(`v1/${idle.projectId}/`)).toEqual([]);
  await expect(retention.collectIncompleteUploads(future, 3600e3 - 1)).rejects.toThrow("bounds");
  await expect(retention.collectIncompleteUploads(future, DAY, 0)).rejects.toThrow("bounds");
  await expect(retention.collectIncompleteUploads(future, DAY, 1001)).rejects.toThrow("bounds");
  if (process.env.HV_OBJECT_LIFECYCLE_EVIDENCE) {
    // Drill record for docs/evidence/hv040-storage/object-lifecycle.json; only ever written from a real run.
    const path = resolve(process.env.HV_OBJECT_LIFECYCLE_EVIDENCE);
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, JSON.stringify({schema: "hv-object-lifecycle-drill/1", recordedAt: new Date().toISOString(),
      bucket: process.env.HV_S3_BUCKET, database: name, storeVersion: process.env.HV_OBJECT_LIFECYCLE_STORE_VERSION ?? null,
      seeded: {a: 1, b: 1, c: 1, d: 1, e: 1}, graceMs: DAY,
      freshPass: fresh, firstPass: first, secondPassAborted: second.aborted, afterJobCompleted: third, currentNowPass: current,
      failedInjected: {failed: failedPass.failed, aborted: failedPass.aborted, retry: retryPass},
      prepareObjectBucket: process.env.HV_OBJECT_LIFECYCLE_BUCKET_REPORT ? JSON.parse(process.env.HV_OBJECT_LIFECYCLE_BUCKET_REPORT) : null,
      newProviderSpendUsd: 0}, null, 2) + "\n");
  }
}, 120_000);
