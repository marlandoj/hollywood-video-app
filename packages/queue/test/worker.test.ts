import { describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { CostLedger, OperatorReviewQueue } from "../../operator/src/index";
import { DeterministicMockProvider, type ProviderAdapter, type VideoClip } from "../../generator/src/index";
import { DurableJobStore } from "../src/index";
import { processNextJob, type WorkerContext } from "../src/worker";

const SCRIPT = "INT. ROOM - DAY\n\nA lamp glows.";

function context(root: string, over: Partial<WorkerContext> = {}): WorkerContext {
  return {
    ledger: new CostLedger(`${root}/cost-ledger.json`),
    reviewQueue: new OperatorReviewQueue(`${root}/review-queue.json`),
    ...over,
  };
}

function job(over: Record<string, unknown> = {}) {
  return {
    id: "job-1",
    idempotencyKey: "job-1",
    projectId: "project-1",
    tier: "free" as const,
    stage: "final" as const,
    scriptVersion: 1,
    totalFrames: 60,
    retryPolicy: { maxRetries: 1, backoffMs: 10 },
    timeoutMs: 120000,
    costCapUsd: 5,
    scriptText: SCRIPT,
    rightsAttestedAt: "2026-08-31T00:00:00.000Z",
    animaticJobId: "animatic-1",
    animaticApprovedAt: "2026-08-31T00:05:00.000Z",
    ...over,
  };
}

function seedFinishedAnimatic(store: DurableJobStore, scriptVersion = 1): void {
  store.enqueue({ ...job({ id: "animatic-1", idempotencyKey: "animatic-1", stage: "animatic", scriptVersion, animaticJobId: null, animaticApprovedAt: null }) } as Parameters<DurableJobStore["enqueue"]>[0]);
  store.complete("animatic-1", {
    mp4Path: "project-1/animatic-1/export.mp4",
    hlsPlaylistPath: "project-1/animatic-1/hls/index.m3u8",
    captionsPath: "project-1/animatic-1/captions.vtt",
    manifestPath: "project-1/animatic-1/provenance.json",
  });
}

describe("reachable generation worker", () => {
  test("claims a persisted job and produces MP4, HLS, captions, and provenance", async () => {
    const root = `/tmp/hv-worker-${Date.now()}`;
    const store = new DurableJobStore(`${root}/jobs.json`);
    seedFinishedAnimatic(store);
    store.enqueue(job());

    const completed = await processNextJob(store, `${root}/artifacts`, context(root));
    expect(completed?.status).toBe("done");
    expect(completed?.checkpointShots).toBe(1);
    expect(existsSync(`${root}/artifacts/${completed?.output?.mp4Path}`)).toBe(true);
    expect(existsSync(`${root}/artifacts/${completed?.output?.hlsPlaylistPath}`)).toBe(true);
    expect(existsSync(`${root}/artifacts/${completed?.output?.captionsPath}`)).toBe(true);
    expect(existsSync(`${root}/artifacts/${completed?.output?.manifestPath}`)).toBe(true);
  }, 60000);

  test("records a cost event per shot into the durable ledger (AC-010)", async () => {
    const root = `/tmp/hv-worker-cost-${Date.now()}`;
    const store = new DurableJobStore(`${root}/jobs.json`);
    seedFinishedAnimatic(store);
    store.enqueue(job());
    const ctx = context(root, {
      primary: new DeterministicMockProvider({ costPerShotUsd: 0.25 }),
      secondary: new DeterministicMockProvider({ costPerShotUsd: 0.25 }),
    });

    const completed = await processNextJob(store, `${root}/artifacts`, ctx);
    expect(completed?.status).toBe("done");
    expect(completed?.costUsd).toBeCloseTo(0.25, 6);
    const events = new CostLedger(`${root}/cost-ledger.json`).all();
    expect(events.length).toBe(1);
    expect(events[0]!.projectId).toBe("project-1");
    expect(events[0]!.jobId).toBe("job-1");
    expect(new CostLedger(`${root}/cost-ledger.json`).monthSpend()).toBeCloseTo(0.25, 6);
  }, 60000);

  test("refuses generation without a recorded rights attestation (FR-017)", async () => {
    const root = `/tmp/hv-worker-rights-${Date.now()}`;
    const store = new DurableJobStore(`${root}/jobs.json`);
    seedFinishedAnimatic(store);
    store.enqueue(job({ rightsAttestedAt: null }));

    const result = await processNextJob(store, `${root}/artifacts`, context(root));
    expect(result?.status).toBe("queued");
    expect(result?.failureReason).toContain("rights attestation is required");
  }, 30000);

  test("refuses final generation until the animatic is approved (FR-023)", async () => {
    const root = `/tmp/hv-worker-gate-${Date.now()}`;
    const store = new DurableJobStore(`${root}/jobs.json`);
    seedFinishedAnimatic(store);
    store.enqueue(job({ animaticApprovedAt: null }));

    const result = await processNextJob(store, `${root}/artifacts`, context(root));
    expect(result?.status).toBe("queued");
    expect(result?.failureReason).toContain("animatic must be approved");
  }, 30000);

  test("fails the job when it outlives its timeout budget", async () => {
    const root = `/tmp/hv-worker-timeout-${Date.now()}`;
    const store = new DurableJobStore(`${root}/jobs.json`);
    seedFinishedAnimatic(store);
    store.enqueue(job({ timeoutMs: 1 }));
    let tick = Date.now();
    const ctx = context(root, { now: () => (tick += 1000) });

    const result = await processNextJob(store, `${root}/artifacts`, ctx);
    expect(result?.status).toBe("queued");
    expect(result?.failureReason).toContain("timeout");
  }, 30000);

  test("fails over to the secondary provider when the primary throws", async () => {
    const root = `/tmp/hv-worker-failover-${Date.now()}`;
    const store = new DurableJobStore(`${root}/jobs.json`);
    seedFinishedAnimatic(store);
    store.enqueue(job());
    let primaryCalls = 0;
    const brokenPrimary: ProviderAdapter = {
      name: "broken",
      model: "broken-v1",
      generate(): Promise<VideoClip> {
        primaryCalls += 1;
        return Promise.reject(new Error("primary provider is down"));
      },
    };

    const completed = await processNextJob(store, `${root}/artifacts`, context(root, {
      primary: brokenPrimary,
      secondary: new DeterministicMockProvider(),
    }));
    expect(primaryCalls).toBeGreaterThan(0);
    expect(completed?.status).toBe("done");
  }, 60000);

  test("resumes a crashed job from its checkpoint instead of regenerating", async () => {
    const root = `/tmp/hv-worker-resume-${Date.now()}`;
    const store = new DurableJobStore(`${root}/jobs.json`);
    seedFinishedAnimatic(store);
    store.enqueue(job({ scriptText: "INT. ROOM - DAY\n\nA lamp glows.\n\nA kettle sings.\n\nThe door opens." }));

    let generated = 0;
    const counting = (): WorkerContext => context(root, {
      primary: new (class extends DeterministicMockProvider {
        override generate(prompt: string, seed: number, params: Parameters<DeterministicMockProvider["generate"]>[2], outPath: string) {
          generated += 1;
          return super.generate(prompt, seed, params, outPath);
        }
      })(),
    });

    const first = await processNextJob(store, `${root}/artifacts`, counting());
    expect(first?.status).toBe("done");
    const shotsGenerated = generated;
    expect(shotsGenerated).toBeGreaterThan(1);

    store.setStatus("job-1", "queued");
    rmSync(`${root}/artifacts/project-1/job-1/export.mp4`, { force: true });
    generated = 0;
    const resumed = await processNextJob(store, `${root}/artifacts`, counting());
    expect(resumed?.status).toBe("done");
    expect(generated).toBe(0);
  }, 90000);

  test("refuses final generation when the animatic rendered against a different screenplay version", async () => {
    const root = `/tmp/hv-worker-stale-${Date.now()}`;
    const store = new DurableJobStore(`${root}/jobs.json`);
    seedFinishedAnimatic(store, 1);
    store.enqueue(job({ scriptVersion: 2 }));

    const result = await processNextJob(store, `${root}/artifacts`, context(root));
    expect(result?.status).toBe("queued");
    expect(result?.failureReason).toContain("screenplay changed after the animatic");
  }, 30000);

  test("refuses final generation whose animatic does not exist in the queue", async () => {
    const root = `/tmp/hv-worker-orphan-${Date.now()}`;
    const store = new DurableJobStore(`${root}/jobs.json`);
    store.enqueue(job({ animaticJobId: "never-rendered" }));

    const result = await processNextJob(store, `${root}/artifacts`, context(root));
    expect(result?.status).toBe("queued");
    expect(result?.failureReason).toContain("finished animatic");
  }, 30000);
});
