import { describe, expect, test } from "bun:test";
import { CapacityController, DurableJobStore, TIERS, fairShareOrder } from "../src/index";

const mkJob = (id: string, over = {}) => ({
  id, idempotencyKey: `key-${id}`, projectId: "p1", tier: "free" as const, stage: "final" as const,
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
