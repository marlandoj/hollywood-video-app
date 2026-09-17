/**
 * HV-031-01. A takedown used to be a read-side 404.
 *
 * `ProjectService.takedown` removed the project from `authorize` and
 * `peekProject`, so no new job could be admitted — and did nothing else.
 * `packages/queue` contained no occurrence of the word "takedown" at all, so a
 * project's already-queued jobs stayed claimable and its running job kept
 * calling a provider. A takedown that does not stop generation is a 404, not a
 * revocation, and P14's "revocation stops future generation without falsifying
 * history" needs both halves: generation stops, and delivered records are not
 * rewritten.
 *
 * These tests are written against the queue and the worker rather than against
 * a route, because there is no takedown route to write them against — the
 * primitive is library-only today, which is exactly why it has to be correct
 * before an operator surface lands on it.
 */
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectService } from "../../api/src/index";
import { CostLedger, OperatorReviewQueue } from "../../operator/src/index";
import type { GenParams, ProviderAdapter, VideoClip } from "../../generator/src/index";
import { DeterministicMockProvider } from "../../generator/src/index";
import { DurableJobStore, GENERATION_REVOKED_NOTICE, LeaseError } from "../src/index";
import { processNextJob, type WorkerContext } from "../src/worker";

const SCRIPT = "INT. ROOM - DAY\n\nA lamp glows.";
process.env.HV_TOKEN_SECRET ??= "test-secret-that-is-at-least-thirty-two-characters";
const roots: string[] = [];
const newRoot = () => { const root = mkdtempSync(join(tmpdir(), "hv-revocation-")); roots.push(root); return root; };
const cleanup = () => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); };

function job(over: Record<string, unknown> = {}) {
  return {
    id: "job-1", idempotencyKey: "job-1", projectId: "project-1", tier: "free" as const,
    stage: "final" as const, scriptVersion: 1, totalFrames: 60,
    retryPolicy: { maxRetries: 1, backoffMs: 10 }, timeoutMs: 120000, costCapUsd: 5,
    scriptText: SCRIPT, rightsAttestedAt: "2026-08-31T00:00:00.000Z",
    animaticJobId: "animatic-1", animaticApprovedAt: "2026-08-31T00:05:00.000Z",
    ...over,
  } as Parameters<DurableJobStore["enqueue"]>[0];
}

/** Claims and completes one job so the fixture has a delivered record to protect. */
function deliver(store: DurableJobStore, id: string, projectId = "project-1"): void {
  store.claimNext(Date.now(), {}, { workerId: `seed-${id}` });
  store.complete(id, `seed-${id}`, {
    mp4Path: `${projectId}/${id}/export.mp4`,
    hlsPlaylistPath: `${projectId}/${id}/hls/index.m3u8`,
    captionsPath: `${projectId}/${id}/captions.vtt`,
    manifestPath: `${projectId}/${id}/provenance.json`,
  });
}

test("a takedown stops the project's queued generation and leaves every other project alone", async () => {
  const root = newRoot();
  const store = new DurableJobStore(join(root, "jobs.json"));
  const projects = new ProjectService(join(root, "projects.json"));
  const taken = projects.createAnonymousProject();
  const other = projects.createAnonymousProject();

  store.enqueue(job({ id: "delivered", idempotencyKey: "delivered", stage: "animatic", projectId: taken.projectId, animaticJobId: null, animaticApprovedAt: null }));
  deliver(store, "delivered", taken.projectId);
  store.enqueue(job({ id: "queued-a", idempotencyKey: "queued-a", projectId: taken.projectId }));
  store.enqueue(job({ id: "queued-b", idempotencyKey: "queued-b", projectId: taken.projectId }));
  store.enqueue(job({ id: "other-1", idempotencyKey: "other-1", projectId: other.projectId }));

  expect(await projects.takedown(taken.projectId, "verified request #1", store)).toBe(true);

  // Every non-terminal job of the taken-down project is stopped, with a notice
  // that carries no part of the operator's stated reason.
  for (const id of ["queued-a", "queued-b"]) {
    const stopped = store.get(id)!;
    expect({ id, status: stopped.status, reason: stopped.cancelReason }).toEqual({ id, status: "cancelled", reason: GENERATION_REVOKED_NOTICE });
    expect(stopped.claimedBy).toBeNull();
    expect(stopped.leaseExpiresAt).toBeNull();
    expect(stopped.notifications.at(-1)).toBe(GENERATION_REVOKED_NOTICE);
  }
  // The operator's stated reason is recorded where it belongs and nowhere else:
  // comparing the module constant to a literal would have tested nothing.
  expect(projects.takedownLog.map(entry => entry.reason)).toContain("verified request #1");
  for (const value of store.all()) {
    expect({ id: value.id, leaks: JSON.stringify(value).includes("verified request") }).toEqual({ id: value.id, leaks: false });
  }

  // The delivered record is untouched. Revocation stops future generation; it
  // does not rewrite what was already made.
  const delivered = store.get("delivered")!;
  expect(delivered.status).toBe("done");
  expect(delivered.cancelReason).toBeUndefined();
  expect(delivered.output?.mp4Path).toBe(`${taken.projectId}/delivered/export.mp4`);

  // Nothing of the taken-down project is claimable again, ever; the other
  // project's work is the only thing the queue will still hand out.
  const claims: (string | undefined)[] = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const claimed = store.claimNext(Date.now(), {}, { workerId: `w-${attempt}` });
    claims.push(claimed?.id);
    if (claimed) store.cancel(claimed.id, `w-${attempt}`, "test drain");
  }
  expect(claims).toEqual(["other-1", undefined, undefined, undefined]);

  // A second takedown reports no change and makes none. The earlier draft of
  // this check compared the two stopped jobs' completedAt to each other, which
  // is equal by construction because one call stopped both: it would have
  // passed even if the second takedown had re-stamped them.
  const before = store.all().map(value => ({ id: value.id, status: value.status, completedAt: value.completedAt ?? null, notifications: value.notifications.length }));
  expect(await projects.takedown(taken.projectId, "again", store)).toBe(false);
  expect(store.all().map(value => ({ id: value.id, status: value.status, completedAt: value.completedAt ?? null, notifications: value.notifications.length }))).toEqual(before);
  cleanup();
});

test("a takedown stops a job that is already running, mid-provider-call", async () => {
  const root = newRoot();
  const store = new DurableJobStore(join(root, "jobs.json"));
  const projects = new ProjectService(join(root, "projects.json"));
  const created = projects.createAnonymousProject();
  store.enqueue(job({ id: "animatic-1", idempotencyKey: "animatic-1", stage: "animatic", projectId: created.projectId, animaticJobId: null, animaticApprovedAt: null }));
  deliver(store, "animatic-1", created.projectId);
  store.enqueue(job({ projectId: created.projectId }));

  let started: () => void;
  const inFlight = new Promise<void>(resolve => { started = resolve; });
  let aborted: unknown;
  const mock = new DeterministicMockProvider();
  // Blocks inside the provider call until its abort signal fires, which is what
  // a real provider request looks like from the worker's point of view.
  const provider: ProviderAdapter = {
    ...mock,
    generate: (prompt: string, seed: number, params: GenParams, _outPath: string): Promise<VideoClip> => new Promise((_resolve, reject) => {
      started();
      params.signal?.addEventListener("abort", () => { aborted = params.signal?.reason; reject(params.signal?.reason ?? new Error("aborted")); }, { once: true });
    }),
  } as ProviderAdapter;

  const context: WorkerContext = {
    ledger: new CostLedger(join(root, "cost-ledger.json")),
    reviewQueue: new OperatorReviewQueue(join(root, "review-queue.json")),
    primary: provider, animaticProvider: provider,
    workerId: "worker-a",
    // Long enough that the lease cannot lapse on its own under load — a lapse
    // would stop the job for the wrong reason — and short enough that the
    // refresh timer (leaseMs / 3) runs while the provider call is outstanding.
    // Production runs a 5-minute lease, so the real detection window is up to
    // 100 seconds; this compresses it, and the increment doc says so.
    leaseMs: 1_500,
  };
  const running = processNextJob(store, join(root, "artifacts"), context);
  await inFlight;
  expect(store.get("job-1")!.status).toBe("running");

  expect(await projects.takedown(created.projectId, "verified request #2", store)).toBe(true);

  // The worker's next lease refresh no longer holds the job, which aborts the
  // in-flight provider call. No second attempt is made.
  const settled = await running;
  expect(aborted).toBeInstanceOf(LeaseError);
  expect((aborted as LeaseError).reason).toBe("not_running");
  expect(settled?.status).toBe("cancelled");
  expect(settled?.cancelReason).toBe(GENERATION_REVOKED_NOTICE);
  cleanup();
});

test("a takedown whose revocation failed can be retried, and revocation clears the lease fields", async () => {
  const root = newRoot();
  const store = new DurableJobStore(join(root, "jobs.json"));
  const projects = new ProjectService(join(root, "projects.json"));
  const created = projects.createAnonymousProject();
  store.enqueue(job({ id: "queued-a", idempotencyKey: "queued-a", projectId: created.projectId }));
  store.enqueue(job({ id: "queued-b", idempotencyKey: "queued-b", projectId: created.projectId }));
  const running = store.claimNext(Date.now(), {}, { workerId: "worker-a", leaseMs: 60_000 })!;
  expect(running.claimedBy).toBe("worker-a");
  expect(running.leaseExpiresAt).not.toBeNull();

  // On the JSON path the tombstone and the revocation are separate writes, so a
  // revoker that throws leaves the project down and its jobs alive. That window
  // is real and is declared; what must not happen is that it becomes permanent
  // because the retry short-circuits on "already taken down".
  const broken = { revokeProject: () => { throw new Error("queue unavailable"); } };
  await expect(projects.takedown(created.projectId, "verified request #4", broken)).rejects.toThrow("queue unavailable");
  expect(projects.isTakenDown(created.projectId)).toBe(true);
  expect(store.all().every(value => value.status !== "cancelled")).toBe(true);

  // The retry reports no change to the project — the tombstone was already
  // written — and still stops the generation.
  expect(await projects.takedown(created.projectId, "verified request #4", store)).toBe(false);
  for (const value of store.all()) {
    expect({ id: value.id, status: value.status, claimedBy: value.claimedBy, lease: value.leaseExpiresAt }).toEqual({ id: value.id, status: "cancelled", claimedBy: null, lease: null });
  }
  cleanup();
});

test("a provider that ignores its abort signal still cannot deliver a revoked job", async () => {
  // Aborting is delivery, not enforcement: `keepingLease` awaits the step and
  // only rethrows afterwards, so an adapter that ignores `params.signal` runs to
  // completion. What the revocation guarantees is narrower and worth stating
  // separately -- no revoked job can produce a deliverable, because every write
  // that finishes one goes through `holder()`, which the revocation broke.
  const root = newRoot();
  const store = new DurableJobStore(join(root, "jobs.json"));
  const projects = new ProjectService(join(root, "projects.json"));
  const created = projects.createAnonymousProject();
  store.enqueue(job({ id: "animatic-1", idempotencyKey: "animatic-1", stage: "animatic", projectId: created.projectId, animaticJobId: null, animaticApprovedAt: null }));
  deliver(store, "animatic-1", created.projectId);
  store.enqueue(job({ projectId: created.projectId }));

  let started: () => void;
  const inFlight = new Promise<void>(resolve => { started = resolve; });
  let release: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const mock = new DeterministicMockProvider();
  let ignoredAbort = false;
  const stubborn: ProviderAdapter = {
    ...mock,
    generate: async (prompt: string, seed: number, params: GenParams, outPath: string): Promise<VideoClip> => {
      started();
      await held;
      ignoredAbort = params.signal?.aborted === true;
      return mock.generate(prompt, seed, { ...params, signal: undefined }, outPath);
    },
  } as ProviderAdapter;

  const running = processNextJob(store, join(root, "artifacts"), {
    ledger: new CostLedger(join(root, "cost-ledger.json")),
    reviewQueue: new OperatorReviewQueue(join(root, "review-queue.json")),
    primary: stubborn, animaticProvider: stubborn, workerId: "worker-a", leaseMs: 1_500,
  });
  await inFlight;
  expect(await projects.takedown(created.projectId, "verified request #3", store)).toBe(true);
  await new Promise(resolve => setTimeout(resolve, 700));
  release!();

  const settled = await running;
  expect(ignoredAbort).toBe(true);
  expect(settled?.status).toBe("cancelled");
  expect(settled?.cancelReason).toBe(GENERATION_REVOKED_NOTICE);
  expect(settled?.output).toBeUndefined();
  cleanup();
});

test("the lease is what stops a running worker, and it stops it for the right reason", async () => {
  const root = newRoot();
  const store = new DurableJobStore(join(root, "jobs.json"));
  store.enqueue(job());
  const claimed = store.claimNext(Date.now(), {}, { workerId: "worker-a", leaseMs: 60_000 })!;
  expect(claimed.id).toBe("job-1");

  // Before: the holder can refresh, checkpoint and complete.
  store.heartbeat("job-1", "worker-a");
  store.revokeProject("project-1", GENERATION_REVOKED_NOTICE);

  // After: every fenced write by the holder fails, and it fails as not_running
  // rather than as a lapsed lease, so the worker logs a revocation rather than
  // an infrastructure wobble.
  for (const write of [
    () => store.heartbeat("job-1", "worker-a"),
    () => store.checkpoint("job-1", "worker-a", 1, 24),
    () => store.cancel("job-1", "worker-a", "should not reach"),
  ]) {
    expect(write).toThrow(LeaseError);
    try { write(); } catch (error) { expect((error as LeaseError).reason).toBe("not_running"); }
  }

  // Revocation of a project with nothing to revoke is not an error and reports
  // an empty result, so a caller cannot read "did something" into it.
  expect(store.revokeProject("project-1", GENERATION_REVOKED_NOTICE)).toEqual([]);
  expect(store.revokeProject("no-such-project", GENERATION_REVOKED_NOTICE)).toEqual([]);
  cleanup();
});
