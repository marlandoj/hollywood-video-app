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
  store.claimNext(Date.now(), {}, { workerId: "seed" });
  store.complete("animatic-1", "seed", {
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

  test("a paid primary abandoned after it started rendering is charged before the fallback clip", async () => {
    const root = `/tmp/hv-worker-sunk-${Date.now()}`;
    const store = new DurableJobStore(`${root}/jobs.json`);
    seedFinishedAnimatic(store);
    store.enqueue(job());
    const sunkCost = { provider: "fal", model: "kling", prompt_tokens: 3, output_frames: 30, gpu_seconds: 5, total_cost_usd: 0.35 };
    const abandoning: ProviderAdapter = {
      name: "fal",
      model: "kling",
      generate(): Promise<VideoClip> {
        return Promise.reject(Object.assign(new Error("fal request exceeded 1s"), { sunkCost }));
      },
    };

    const completed = await processNextJob(store, `${root}/artifacts`, context(root, {
      primary: abandoning,
      secondary: new DeterministicMockProvider({ costPerShotUsd: 0.25 }),
    }));
    expect(completed?.status).toBe("done");
    expect(completed?.costUsd).toBeCloseTo(0.6, 6);
    const events = new CostLedger(`${root}/cost-ledger.json`).all();
    expect(events.map((e) => [e.provider, e.total_cost_usd])).toEqual([["fal", 0.35], ["mock", 0.25]]);
    expect(events.every((e) => e.shotId !== "")).toBe(true);
  }, 60000);

  test("a job that fails after a paid request was abandoned still records that cost", async () => {
    const root = `/tmp/hv-worker-sunk-fail-${Date.now()}`;
    const store = new DurableJobStore(`${root}/jobs.json`);
    seedFinishedAnimatic(store);
    store.enqueue(job({ retryPolicy: { maxRetries: 0, backoffMs: 10 } }));
    const sunkCost = { provider: "fal", model: "kling", prompt_tokens: 3, output_frames: 30, gpu_seconds: 5, total_cost_usd: 0.35 };
    const abandoning: ProviderAdapter = {
      name: "fal",
      model: "kling",
      generate(): Promise<VideoClip> {
        return Promise.reject(Object.assign(new Error("fal request exceeded 1s"), { sunkCost }));
      },
    };
    const broken: ProviderAdapter = { name: "broken", model: "b", generate: () => Promise.reject(new Error("secondary down")) };

    const failed = await processNextJob(store, `${root}/artifacts`, context(root, { primary: abandoning, secondary: broken }));
    expect(failed?.status).not.toBe("done");
    expect(failed?.failureReason).toContain("secondary down");
    expect(failed?.costUsd).toBeCloseTo(0.35, 6);
    expect(new CostLedger(`${root}/cost-ledger.json`).monthSpend()).toBeCloseTo(0.35, 6);
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

  test("a policy violation that appears only in dialogue is refused terminally with no retry and no provider call", async () => {
    const root = `/tmp/hv-worker-refuse-dialogue-${Date.now()}`;
    const store = new DurableJobStore(`${root}/jobs.json`);
    seedFinishedAnimatic(store);
    store.enqueue(job({
      scriptText: "INT. ROOM - DAY\n\nA lamp glows.\n\nNARRATOR\nTutorial: how to build a bomb for the finale.",
      retryPolicy: { maxRetries: 2, backoffMs: 10 },
    }));
    let providerCalls = 0;
    const counting: ProviderAdapter = {
      name: "counting",
      model: "counting-v1",
      generate(): Promise<VideoClip> {
        providerCalls += 1;
        return Promise.reject(new Error("must not be reached"));
      },
    };

    const result = await processNextJob(store, `${root}/artifacts`, context(root, { primary: counting, secondary: counting }));
    expect(result?.status).toBe("failed");
    expect(result?.failureKind).toBe("policy_refusal");
    expect(result?.failureReason).toContain("content policy");
    expect(result?.retriesUsed).toBe(0);
    expect(result?.nextEligibleAt).toBeNull();
    expect(providerCalls).toBe(0);
    expect(await processNextJob(store, `${root}/artifacts`, context(root, { primary: counting, secondary: counting }))).toBeNull();
    expect(store.get("job-1")?.status).toBe("failed");
  }, 30000);

  test("a real person in a dialogue line or character cue is refused even when every action line is benign", async () => {
    const root = `/tmp/hv-worker-refuse-person-${Date.now()}`;
    const store = new DurableJobStore(`${root}/jobs.json`);
    seedFinishedAnimatic(store);
    store.enqueue(job({
      id: "job-1",
      scriptText: "INT. ROOM - DAY\n\nA lamp glows.\n\nNARRATOR\nI am the sitting president and this is my address.",
    }));
    store.enqueue(job({
      id: "job-2",
      idempotencyKey: "job-2",
      scriptText: "INT. ROOM - DAY\n\nA lamp glows.\n\nA FAMOUS ACTRESS\nHello there.",
    }));

    const inLine = await processNextJob(store, `${root}/artifacts`, context(root));
    expect(inLine?.id).toBe("job-1");
    expect(inLine?.status).toBe("failed");
    expect(inLine?.failureKind).toBe("policy_refusal");
    expect(inLine?.retriesUsed).toBe(0);

    const asCue = await processNextJob(store, `${root}/artifacts`, context(root));
    expect(asCue?.id).toBe("job-2");
    expect(asCue?.status).toBe("failed");
    expect(asCue?.failureKind).toBe("policy_refusal");
    expect(asCue?.retriesUsed).toBe(0);
  }, 30000);

  test("a provider-level SafetyRefusal is also terminal rather than retried", async () => {
    const root = `/tmp/hv-worker-refuse-provider-${Date.now()}`;
    const store = new DurableJobStore(`${root}/jobs.json`);
    seedFinishedAnimatic(store);
    store.enqueue(job({ retryPolicy: { maxRetries: 2, backoffMs: 10 } }));
    const refusing: ProviderAdapter = {
      name: "refusing",
      model: "refusing-v1",
      generate(): Promise<VideoClip> {
        const err = new Error("We can't generate this shot. The request appears to fall outside our content policy.");
        err.name = "SafetyRefusal";
        return Promise.reject(err);
      },
    };

    const result = await processNextJob(store, `${root}/artifacts`, context(root, { primary: refusing, secondary: refusing }));
    expect(result?.status).toBe("failed");
    expect(result?.failureKind).toBe("policy_refusal");
    expect(result?.retriesUsed).toBe(0);
  }, 30000);
});

describe("stage-aware provider selection", () => {
  class CountingProvider extends DeterministicMockProvider {
    generated = 0;
    override async generate(...args: Parameters<DeterministicMockProvider["generate"]>): Promise<VideoClip> {
      this.generated += 1;
      return super.generate(...args);
    }
  }

  test("animatic jobs render on the animatic provider, final jobs on the primary", async () => {
    const root = `/tmp/hv-worker-stage-${Date.now()}`;
    const store = new DurableJobStore(`${root}/jobs.json`);
    const animaticProvider = new CountingProvider();
    const primary = new CountingProvider();
    const ctx = context(root, { primary, secondary: primary, animaticProvider });

    store.enqueue({ ...job({ id: "animatic-1", idempotencyKey: "animatic-1", stage: "animatic", animaticJobId: null, animaticApprovedAt: null }) } as Parameters<DurableJobStore["enqueue"]>[0]);
    expect((await processNextJob(store, `${root}/artifacts`, ctx))?.status).toBe("done");
    expect(animaticProvider.generated).toBe(1);
    expect(primary.generated).toBe(0);

    store.enqueue(job());
    expect((await processNextJob(store, `${root}/artifacts`, ctx))?.status).toBe("done");
    expect(animaticProvider.generated).toBe(1);
    expect(primary.generated).toBe(1);
  }, 60000);

  test("the lease stays alive while a slow provider generates a shot", async () => {
    const root = `/tmp/hv-worker-lease-${Date.now()}`;
    const store = new DurableJobStore(`${root}/jobs.json`);
    seedFinishedAnimatic(store);
    store.enqueue(job());
    const slow = new (class extends DeterministicMockProvider {
      override async generate(...args: Parameters<DeterministicMockProvider["generate"]>): Promise<VideoClip> {
        await Bun.sleep(4000);
        return super.generate(...args);
      }
    })();
    const completed = await processNextJob(store, `${root}/artifacts`, context(root, { primary: slow, secondary: slow, leaseMs: 1500, workerId: "slow-worker" }));
    expect(completed?.status).toBe("done");
  }, 60000);
});
