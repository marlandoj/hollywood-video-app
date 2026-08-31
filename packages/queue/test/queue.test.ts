import { describe, expect, test } from "bun:test";
import { CapacityController, DurableJobStore, TIERS, fairShareOrder } from "../src/index";

const mkJob = (id: string, over = {}) => ({
  id, idempotencyKey: `key-${id}`, projectId: "p1", tier: "free" as const,
  totalFrames: 240, retryPolicy: { maxRetries: 2, backoffMs: 100 }, timeoutMs: 120000, costCapUsd: 5,
  scriptText: "INT. ROOM - DAY\n\nA lamp glows.", ...over,
});

describe("durable idempotent jobs (AC-024)", () => {
  test("jobs survive restart via frame-boundary checkpoints", () => {
    const path = `/tmp/hv-queue-${Date.now()}.json`;
    const s1 = new DurableJobStore(path);
    s1.enqueue(mkJob("j1"));
    s1.setStatus("j1", "running");
    s1.checkpoint("j1", 96);
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
    store.checkpoint("j1", 24);
    store.complete("j1", {
      mp4Path: "p1/j1/export.mp4",
      hlsPlaylistPath: "p1/j1/hls/index.m3u8",
      captionsPath: "p1/j1/captions.vtt",
      manifestPath: "p1/j1/provenance.json",
    });
    expect(new DurableJobStore(path).get("j1")?.status).toBe("done");

    store.enqueue(mkJob("j2"));
    store.claimNext();
    expect(store.fail("j2", "provider timeout").status).toBe("queued");
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
