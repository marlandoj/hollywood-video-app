import { describe, expect, test } from "bun:test";
import { CapacityController, DurableJobStore, LeaseError, TIERS, fairShareOrder } from "../src/index";

const mkJob = (id: string, over = {}) => ({
  id, idempotencyKey: `key-${id}`, projectId: "p1", tier: "free" as const, stage: "final" as const, scriptVersion: 1,
  totalFrames: 240, retryPolicy: { maxRetries: 2, backoffMs: 100 }, timeoutMs: 120000, costCapUsd: 5,
  scriptText: "INT. ROOM - DAY\n\nA lamp glows.",
  rightsAttestedAt: "2026-08-31T00:00:00.000Z",
  animaticJobId: "animatic-1",
  animaticApprovedAt: "2026-08-31T00:05:00.000Z",
  ...over,
});

describe("durable idempotent jobs (AC-024)", () => {
  test("jobs survive restart via frame-boundary checkpoints", () => {
    const path = `/tmp/hv-queue-${Date.now()}.json`;
    const s1 = new DurableJobStore(path);
    s1.enqueue(mkJob("j1"));
    s1.claimNext(Date.now(), {}, { workerId: "worker-a" });
    s1.checkpoint("j1", "worker-a", 4, 96);
    const s2 = new DurableJobStore(path);
    const j = s2.get("j1")!;
    expect(j.checkpointFrame).toBe(96);
    expect(j.retryPolicy.maxRetries).toBe(2);
    expect(j.timeoutMs).toBe(120000);
  });

  test("enqueue is idempotent on idempotencyKey", () => {
    const s = new DurableJobStore(`/tmp/hv-queue-idem-${Date.now()}.json`);
    const a = s.enqueue(mkJob("j1"));
    const b = s.enqueue(mkJob("j2", { idempotencyKey: "key-j1" }));
    expect(b.id).toBe(a.id);
    expect(s.all().length).toBe(1);
  });

  test("idempotency keys are scoped per project", () => {
    const s = new DurableJobStore(`/tmp/hv-queue-idem-scope-${Date.now()}.json`);
    const a = s.enqueue(mkJob("j1", { projectId: "p1", idempotencyKey: "k" }));
    const b = s.enqueue(mkJob("j2", { projectId: "p2", idempotencyKey: "k" }));
    expect(b.id).toBe("j2");
    expect(b.id).not.toBe(a.id);
    expect(s.all().length).toBe(2);
    expect(s.enqueue(mkJob("j3", { projectId: "p1", idempotencyKey: "k" })).id).toBe("j1");
    expect(s.enqueue(mkJob("j4", { projectId: "p2", idempotencyKey: "k" })).id).toBe("j2");
    expect(s.all().length).toBe(2);
  });

  test("claim, checkpoint, completion, and retry state persist", () => {
    const path = `/tmp/hv-queue-lifecycle-${Date.now()}.json`;
    const store = new DurableJobStore(path);
    store.enqueue(mkJob("j1"));
    expect(store.claimNext(Date.now(), {}, { workerId: "worker-a" })?.status).toBe("running");
    store.checkpoint("j1", "worker-a", 1, 24);
    store.complete("j1", "worker-a", {
      mp4Path: "p1/j1/export.mp4",
      hlsPlaylistPath: "p1/j1/hls/index.m3u8",
      captionsPath: "p1/j1/captions.vtt",
      manifestPath: "p1/j1/provenance.json",
    });
    expect(new DurableJobStore(path).get("j1")?.status).toBe("done");

    store.enqueue(mkJob("j2"));
    store.claimNext(Date.now(), {}, { workerId: "worker-a" });
    const failed = store.fail("j2", "worker-a", "provider timeout");
    expect(failed.status).toBe("queued");
    expect(failed.nextEligibleAt).not.toBeNull();
    expect(new DurableJobStore(path).get("j2")?.failureReason).toContain("timeout");
  });
});

describe("per-job cost cap (AC-010)", () => {
  test("over-cap job is cancelled and user notified; cost fields recorded", () => {
    const s = new DurableJobStore(`/tmp/hv-queue-cap-${Date.now()}.json`);
    s.enqueue(mkJob("j1"));
    s.claimNext(Date.now(), {}, { workerId: "worker-a" });
    const j = s.recordCost("j1", "worker-a", { provider: "mock", model: "m", prompt_tokens: 10, output_frames: 240, gpu_seconds: 12, total_cost_usd: 7.5 });
    expect(j.status).toBe("cancelled");
    expect(j.cancelReason).toContain("$5.00");
    expect(j.costUsd).toBeCloseTo(7.5, 6);
    expect(j.notifications[0]).toContain("cancelled");
    expect(j.cost?.gpu_seconds).toBe(12);
  });
});

describe("capacity tiers + auto-throttle (AC-011)", () => {
  const c = new CapacityController(5000);
  test("tier limits enforced", () => {
    expect(TIERS.free).toEqual({ maxConcurrent: 1, maxShots: 24, maxResolution: "1280x720" });
    expect(TIERS.elevated).toEqual({ maxConcurrent: 3, maxShots: 60, maxResolution: "1920x1080" });
    expect(c.decide({ tier: "free", runningForProject: 0, requestedShots: 25, monthSpendUsd: 0 }).action).toBe("reject");
    expect(c.decide({ tier: "free", runningForProject: 1, requestedShots: 10, monthSpendUsd: 0 }).action).toBe("queue_behind");
    expect(c.decide({ tier: "elevated", runningForProject: 2, requestedShots: 60, monthSpendUsd: 0 }).action).toBe("run");
  });
  test("80% budget queues behind; 100% rejects with capacity message", () => {
    expect(c.decide({ tier: "free", runningForProject: 0, requestedShots: 5, monthSpendUsd: 4000 }).action).toBe("queue_behind");
    const full = c.decide({ tier: "free", runningForProject: 0, requestedShots: 5, monthSpendUsd: 5000 });
    expect(full.action).toBe("reject");
    expect(full.message).toContain("capacity");
  });
});

describe("weighted fair share (AC-025)", () => {
  test("least-served project goes first; no starvation", () => {
    const order = fairShareOrder([
      { jobId: "a", projectId: "p1", gpuSecondsUsed: 500 },
      { jobId: "b", projectId: "p2", gpuSecondsUsed: 0 },
      { jobId: "c", projectId: "p3", gpuSecondsUsed: 20 },
    ]);
    expect(order).toEqual(["b", "c", "a"]);
  });
});

describe("retry backoff and fair-share claim order (AC-025, AC-026)", () => {
  test("a failed job is not re-claimable until its backoff elapses", () => {
    const store = new DurableJobStore(`/tmp/hv-queue-backoff-${Date.now()}.json`);
    store.enqueue(mkJob("j1", { retryPolicy: { maxRetries: 2, backoffMs: 5000 } }));
    const start = Date.now();
    store.claimNext(start, {}, { workerId: "worker-a" });
    store.fail("j1", "worker-a", "provider timeout", start);
    expect(store.claimNext(start + 1000)).toBeUndefined();
    expect(store.claimNext(start + 6000)?.id).toBe("j1");
  });

  test("claimNext serves the least-served project first", () => {
    const store = new DurableJobStore(`/tmp/hv-queue-fair-${Date.now()}.json`);
    store.enqueue(mkJob("j-heavy", { projectId: "busy" }));
    store.enqueue(mkJob("j-light", { projectId: "quiet" }));
    const claimed = store.claimNext(Date.now(), { busy: 900, quiet: 5 });
    expect(claimed?.id).toBe("j-light");
  });

  test("elevated tier is served ahead of free tier at equal usage", () => {
    const store = new DurableJobStore(`/tmp/hv-queue-priority-${Date.now()}.json`);
    store.enqueue(mkJob("a-free"));
    store.enqueue(mkJob("b-elevated", { tier: "elevated" as const, projectId: "p2" }));
    expect(store.claimNext(Date.now())?.id).toBe("b-elevated");
  });
});

describe("abandoned running jobs resume from their checkpoint (AC-024)", () => {
  test("a running job whose lease lapsed is returned to the queue and re-claimed", () => {
    const store = new DurableJobStore(`/tmp/hv-queue-lease-${Date.now()}.json`);
    store.enqueue(mkJob("j1"));
    const start = Date.now();
    const claimed = store.claimNext(start, {}, { workerId: "worker-a", leaseMs: 1000 })!;
    expect(claimed.status).toBe("running");
    expect(claimed.claimedBy).toBe("worker-a");
    store.checkpoint("j1", "worker-a", 2, 48, start + 100, 1000);
    expect(store.claimNext(start + 500, {}, { workerId: "worker-b" })).toBeUndefined();
    const resumed = store.claimNext(start + 1200, {}, { workerId: "worker-b", leaseMs: 1000 })!;
    expect(resumed.id).toBe("j1");
    expect(resumed.claimedBy).toBe("worker-b");
    expect(resumed.resumedCount).toBe(1);
    expect(resumed.checkpointShots).toBe(2);
    expect(resumed.checkpointFrame).toBe(48);
  });

  test("recoverAbandoned at worker start requeues stale running jobs but leaves live ones alone", () => {
    const store = new DurableJobStore(`/tmp/hv-queue-recover-${Date.now()}.json`);
    store.enqueue(mkJob("a-stale", { projectId: "p1" }));
    store.enqueue(mkJob("b-live", { projectId: "p2" }));
    const start = Date.now();
    expect(store.claimNext(start, {}, { workerId: "dead", leaseMs: 1000 })?.id).toBe("a-stale");
    expect(store.claimNext(start, {}, { workerId: "alive", leaseMs: 60_000 })?.id).toBe("b-live");
    const recovered = store.recoverAbandoned(start + 5000);
    expect(recovered.map((job) => job.id)).toEqual(["a-stale"]);
    expect(store.get("a-stale")?.status).toBe("queued");
    expect(store.get("a-stale")?.notifications[0]).toContain("resume");
    expect(store.get("b-live")?.status).toBe("running");
  });

  test("a heartbeat keeps a long-running job from being mistaken for abandoned", () => {
    const store = new DurableJobStore(`/tmp/hv-queue-heartbeat-${Date.now()}.json`);
    store.enqueue(mkJob("j1"));
    const start = Date.now();
    store.claimNext(start, {}, { workerId: "worker-a", leaseMs: 1000 });
    store.heartbeat("j1", "worker-a", start + 900, 1000);
    expect(store.recoverAbandoned(start + 1500)).toEqual([]);
    expect(store.get("j1")?.status).toBe("running");
  });
});

describe("running-job mutations are bound to the lease holder (AC-024)", () => {
  const output = { mp4Path: "a", hlsPlaylistPath: "b", captionsPath: "c", manifestPath: "d" };
  const cost = { provider: "mock", model: "m", prompt_tokens: 10, output_frames: 24, gpu_seconds: 1, total_cost_usd: 0.5 };

  function reassigned(name: string) {
    const path = `/tmp/hv-queue-${name}-${Date.now()}.json`;
    const store = new DurableJobStore(path);
    store.enqueue(mkJob("j1"));
    const start = Date.now();
    store.claimNext(start, {}, { workerId: "worker-a", leaseMs: 1000 });
    store.checkpoint("j1", "worker-a", 1, 24, start + 100, 1000);
    const resumed = store.claimNext(start + 2000, {}, { workerId: "worker-b", leaseMs: 1000 })!;
    expect(resumed.claimedBy).toBe("worker-b");
    return { store, path, now: start + 2100 };
  }

  function snapshot(store: DurableJobStore) {
    const job = store.get("j1")!;
    return {
      status: job.status, claimedBy: job.claimedBy, leaseExpiresAt: job.leaseExpiresAt, checkpointShots: job.checkpointShots,
      checkpointFrame: job.checkpointFrame, costUsd: job.costUsd, retriesUsed: job.retriesUsed, output: job.output, failureReason: job.failureReason,
    };
  }

  test("a worker whose expired lease was reassigned cannot checkpoint, heartbeat, charge, complete, or fail the job", () => {
    const { store, path, now } = reassigned("stale");
    const before = snapshot(store);
    const attempts: (() => unknown)[] = [
      () => store.checkpoint("j1", "worker-a", 9, 999, now, 1000),
      () => store.heartbeat("j1", "worker-a", now, 1000),
      () => store.recordCost("j1", "worker-a", cost, now),
      () => store.complete("j1", "worker-a", output, now),
      () => store.fail("j1", "worker-a", "late failure", now),
    ];
    for (const attempt of attempts) {
      let caught: unknown;
      try { attempt(); } catch (error) { caught = error; }
      expect(caught).toBeInstanceOf(LeaseError);
      expect((caught as LeaseError).reason).toBe("wrong_worker");
      expect((caught as LeaseError).claimedBy).toBe("worker-b");
      expect(snapshot(new DurableJobStore(path))).toEqual(before);
    }
  });

  test("the current holder still can", () => {
    const { store, now } = reassigned("holder");
    store.heartbeat("j1", "worker-b", now, 1000);
    store.checkpoint("j1", "worker-b", 2, 48, now + 1, 1000);
    const priced = store.recordCost("j1", "worker-b", cost, now + 2);
    expect(priced.costUsd).toBeCloseTo(0.5, 6);
    const done = store.complete("j1", "worker-b", output, now + 3);
    expect(done.status).toBe("done");
    expect(done.checkpointShots).toBe(2);
    expect(done.checkpointFrame).toBe(48);
  });

  test("the holder can fail its own job", () => {
    const { store, now } = reassigned("holder-fail");
    expect(store.fail("j1", "worker-b", "boom", now).retriesUsed).toBe(1);
  });

  test("a holder whose lease lapsed is refused even before anyone reclaims the job", () => {
    const store = new DurableJobStore(`/tmp/hv-queue-lapsed-${Date.now()}.json`);
    store.enqueue(mkJob("j1"));
    const start = Date.now();
    store.claimNext(start, {}, { workerId: "worker-a", leaseMs: 1000 });
    expect(() => store.complete("j1", "worker-a", output, start + 1000)).toThrow(LeaseError);
    expect(() => store.checkpoint("j1", "worker-a", 1, 24, start + 1000, 1000)).toThrow(LeaseError);
    const job = store.get("j1")!;
    expect(job.status).toBe("running");
    expect(job.checkpointShots).toBe(0);
    expect(job.output).toBeUndefined();
  });

  test("a job that is not running cannot be completed, failed, or charged", () => {
    const store = new DurableJobStore(`/tmp/hv-queue-notrunning-${Date.now()}.json`);
    store.enqueue(mkJob("j1"));
    expect(() => store.complete("j1", "worker-a", output)).toThrow(LeaseError);
    expect(() => store.fail("j1", "worker-a", "boom")).toThrow(LeaseError);
    expect(() => store.recordCost("j1", "worker-a", cost)).toThrow(LeaseError);
    expect(store.get("j1")).toMatchObject({ status: "queued", retriesUsed: 0, costUsd: 0 });
  });

  test("a claim without a worker id still binds the job to a generated holder", () => {
    const store = new DurableJobStore(`/tmp/hv-queue-anon-${Date.now()}.json`);
    store.enqueue(mkJob("j1"));
    const claimed = store.claimNext()!;
    expect(claimed.claimedBy).toBeString();
    expect(() => store.complete("j1", "someone-else", output)).toThrow(LeaseError);
    expect(store.complete("j1", claimed.claimedBy!, output).status).toBe("done");
  });
});

describe("queue-behind holds a job until the jobs ahead of it finish (AC-011, FR-032)", () => {
  test("a budget-throttled job does not start while any job that was ahead of it is still active", () => {
    const store = new DurableJobStore(`/tmp/hv-queue-behind-${Date.now()}.json`);
    store.enqueue(mkJob("ahead", { projectId: "p1" }));
    const start = Date.now();
    store.claimNext(start, {}, { workerId: "worker-a", leaseMs: 60_000 });
    const throttled = store.enqueue(mkJob("throttled", { projectId: "p2", queueAction: "queue_behind", queueReason: "budget_throttle" }));
    expect(throttled.queuedBehind).toEqual(["ahead"]);
    expect(store.claimNext(start + 1, {}, { leaseMs: 60_000 })).toBeUndefined();
    store.complete("ahead", "worker-a", { mp4Path: "a", hlsPlaylistPath: "b", captionsPath: "c", manifestPath: "d" });
    expect(store.claimNext(start + 2, {}, { leaseMs: 60_000 })?.id).toBe("throttled");
  });

  test("a job queued behind its own project's running job starts once that job is done", () => {
    const store = new DurableJobStore(`/tmp/hv-queue-behind-project-${Date.now()}.json`);
    store.enqueue(mkJob("first", { projectId: "p1" }));
    store.enqueue(mkJob("other", { projectId: "p9" }));
    const start = Date.now();
    const claim = { workerId: "worker-a", leaseMs: 60_000 };
    expect(store.claimNext(start, {}, claim)?.id).toBe("first");
    const second = store.enqueue(mkJob("second", { projectId: "p1", queueAction: "queue_behind", queueReason: "project_concurrency" }));
    expect(second.queuedBehind).toEqual(["first"]);
    expect(store.claimNext(start + 1, {}, claim)?.id).toBe("other");
    expect(store.claimNext(start + 2, {}, claim)).toBeUndefined();
    store.fail("first", "worker-a", "boom", start + 3);
    expect(store.claimNext(start + 200, {}, claim)?.id).toBe("first");
    store.fail("first", "worker-a", "boom", start + 201);
    expect(store.claimNext(start + 500, {}, claim)?.id).toBe("first");
    store.fail("first", "worker-a", "boom", start + 501);
    expect(store.get("first")?.status).toBe("failed");
    expect(store.claimNext(start + 600, {}, claim)?.id).toBe("second");
  });

  test("the worker enforces the tier's concurrency limit at claim time", () => {
    const store = new DurableJobStore(`/tmp/hv-queue-concurrency-${Date.now()}.json`);
    store.enqueue(mkJob("free-1", { projectId: "free" }));
    store.enqueue(mkJob("free-2", { projectId: "free" }));
    store.enqueue(mkJob("el-1", { projectId: "el", tier: "elevated" as const }));
    store.enqueue(mkJob("el-2", { projectId: "el", tier: "elevated" as const }));
    store.enqueue(mkJob("el-3", { projectId: "el", tier: "elevated" as const }));
    store.enqueue(mkJob("el-4", { projectId: "el", tier: "elevated" as const }));
    const start = Date.now();
    const claimed: string[] = [];
    for (;;) {
      const job = store.claimNext(start, {}, { leaseMs: 60_000 });
      if (!job) break;
      claimed.push(job.id);
    }
    expect(claimed.sort()).toEqual(["el-1", "el-2", "el-3", "free-1"]);
  });
});

describe("claims are atomic across processes", () => {
  test("four worker processes draining one queue file claim every job exactly once", async () => {
    const path = `/tmp/hv-queue-multi-${Date.now()}/jobs.json`;
    const store = new DurableJobStore(path);
    const ids = Array.from({ length: 40 }, (_, index) => `job-${String(index).padStart(2, "0")}`);
    for (const id of ids) store.enqueue(mkJob(id, { projectId: id, tier: "elevated" as const }));
    const workers = ["a", "b", "c", "d"].map((name) => Bun.spawn(
      ["bun", `${import.meta.dir}/fixtures/claimer.ts`, path, name],
      { stdout: "pipe", stderr: "pipe", env: { ...process.env } },
    ));
    const outputs = await Promise.all(workers.map(async (worker) => {
      const [text, code] = await Promise.all([new Response(worker.stdout).text(), worker.exited]);
      expect(code).toBe(0);
      return text.split("\n").filter(Boolean);
    }));
    const claimed = outputs.flat();
    expect(claimed.length).toBe(ids.length);
    expect(new Set(claimed).size).toBe(ids.length);
    expect(outputs.filter((list) => list.length > 0).length).toBeGreaterThan(1);
    expect(store.all().every((job) => job.status === "done")).toBe(true);
  }, 60000);
});

describe("content-policy refusal is terminal and never retried (FR-054, AC-009)", () => {
  test("refuse() fails the job without consuming a retry, and it is never re-claimable", () => {
    const path = `/tmp/hv-queue-refuse-${Date.now()}.json`;
    const store = new DurableJobStore(path);
    store.enqueue(mkJob("j1"));
    expect(store.claimNext(1000, {}, { workerId: "worker-a" })?.status).toBe("running");

    const refused = store.refuse("j1", "worker-a", "We can't generate this shot. The request appears to fall outside our content policy.", 2000);
    expect(refused.status).toBe("failed");
    expect(refused.failureKind).toBe("policy_refusal");
    expect(refused.failureReason).toContain("content policy");
    expect(refused.retriesUsed).toBe(0);
    expect(refused.nextEligibleAt).toBeNull();
    expect(refused.leaseExpiresAt).toBeNull();
    expect(refused.claimedBy).toBeNull();
    expect(refused.notifications).toContain(refused.failureReason!);

    const persisted = new DurableJobStore(path);
    expect(persisted.get("j1")?.status).toBe("failed");
    expect(persisted.get("j1")?.failureKind).toBe("policy_refusal");
    expect(persisted.recoverAbandoned(10 ** 12)).toHaveLength(0);
    expect(persisted.claimNext(10 ** 12)).toBeUndefined();
    expect(persisted.get("j1")?.status).toBe("failed");
  });

  test("an ordinary failure is still retried with backoff and carries no refusal kind", () => {
    const store = new DurableJobStore(`/tmp/hv-queue-refuse-contrast-${Date.now()}.json`);
    store.enqueue(mkJob("j1"));
    store.claimNext(1000, {}, { workerId: "worker-a" });
    const failed = store.fail("j1", "worker-a", "provider timeout", 2000);
    expect(failed.status).toBe("queued");
    expect(failed.retriesUsed).toBe(1);
    expect(failed.failureKind).toBeUndefined();
  });
});
