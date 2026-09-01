import { describe, expect, test } from "bun:test";
import { CapacityController, DurableJobStore, TIERS, fairShareOrder } from "../src/index";

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
    s1.setStatus("j1", "running");
    s1.checkpoint("j1", 4, 96);
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

  test("claim, checkpoint, completion, and retry state persist", () => {
    const path = `/tmp/hv-queue-lifecycle-${Date.now()}.json`;
    const store = new DurableJobStore(path);
    store.enqueue(mkJob("j1"));
    expect(store.claimNext()?.status).toBe("running");
    store.checkpoint("j1", 1, 24);
    store.complete("j1", {
      mp4Path: "p1/j1/export.mp4",
      hlsPlaylistPath: "p1/j1/hls/index.m3u8",
      captionsPath: "p1/j1/captions.vtt",
      manifestPath: "p1/j1/provenance.json",
    });
    expect(new DurableJobStore(path).get("j1")?.status).toBe("done");

    store.enqueue(mkJob("j2"));
    store.claimNext();
    const failed = store.fail("j2", "provider timeout");
    expect(failed.status).toBe("queued");
    expect(failed.nextEligibleAt).not.toBeNull();
    expect(new DurableJobStore(path).get("j2")?.failureReason).toContain("timeout");
  });
});

describe("per-job cost cap (AC-010)", () => {
  test("over-cap job is cancelled and user notified; cost fields recorded", () => {
    const s = new DurableJobStore(`/tmp/hv-queue-cap-${Date.now()}.json`);
    s.enqueue(mkJob("j1"));
    const j = s.recordCost("j1", { provider: "mock", model: "m", prompt_tokens: 10, output_frames: 240, gpu_seconds: 12, total_cost_usd: 7.5 });
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
    store.claimNext(start);
    store.fail("j1", "provider timeout", start);
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
    store.checkpoint("j1", 2, 48, start + 100, 1000);
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
    store.claimNext(start, {}, { leaseMs: 1000 });
    store.heartbeat("j1", start + 900, 1000);
    expect(store.recoverAbandoned(start + 1500)).toEqual([]);
    expect(store.get("j1")?.status).toBe("running");
  });
});

describe("queue-behind holds a job until the jobs ahead of it finish (AC-011, FR-032)", () => {
  test("a budget-throttled job does not start while any job that was ahead of it is still active", () => {
    const store = new DurableJobStore(`/tmp/hv-queue-behind-${Date.now()}.json`);
    store.enqueue(mkJob("ahead", { projectId: "p1" }));
    const start = Date.now();
    store.claimNext(start, {}, { leaseMs: 60_000 });
    const throttled = store.enqueue(mkJob("throttled", { projectId: "p2", queueAction: "queue_behind", queueReason: "budget_throttle" }));
    expect(throttled.queuedBehind).toEqual(["ahead"]);
    expect(store.claimNext(start + 1, {}, { leaseMs: 60_000 })).toBeUndefined();
    store.complete("ahead", { mp4Path: "a", hlsPlaylistPath: "b", captionsPath: "c", manifestPath: "d" });
    expect(store.claimNext(start + 2, {}, { leaseMs: 60_000 })?.id).toBe("throttled");
  });

  test("a job queued behind its own project's running job starts once that job is done", () => {
    const store = new DurableJobStore(`/tmp/hv-queue-behind-project-${Date.now()}.json`);
    store.enqueue(mkJob("first", { projectId: "p1" }));
    store.enqueue(mkJob("other", { projectId: "p9" }));
    const start = Date.now();
    expect(store.claimNext(start, {}, { leaseMs: 60_000 })?.id).toBe("first");
    const second = store.enqueue(mkJob("second", { projectId: "p1", queueAction: "queue_behind", queueReason: "project_concurrency" }));
    expect(second.queuedBehind).toEqual(["first"]);
    expect(store.claimNext(start + 1, {}, { leaseMs: 60_000 })?.id).toBe("other");
    expect(store.claimNext(start + 2, {}, { leaseMs: 60_000 })).toBeUndefined();
    store.fail("first", "boom", start + 3);
    store.fail("first", "boom", start + 4);
    store.fail("first", "boom", start + 5);
    expect(store.get("first")?.status).toBe("failed");
    expect(store.claimNext(start + 6, {}, { leaseMs: 60_000 })?.id).toBe("second");
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
