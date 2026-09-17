/**
 * HV-032-02 — the weight the scheduler receives is the one the ledger computed.
 *
 * The horizon is only worth having if it reaches `claimNext`. It is computed in
 * a cost ledger and consumed in a job store, and the parameter defaults to `{}`
 * — so "the worker supplied no weights" and "every project is at zero" are the
 * same value, and every one of the roughly forty `claimNext` calls in this
 * repository's tests passes `{}`. Replacing the worker's
 * `await context.ledger.fairShareWeights(now())` with `{}` therefore disabled
 * fair share outright in production while every suite, the type checker and the
 * linter stayed green: the critic pass on this increment did exactly that and
 * measured it. This file is that link's only guard.
 *
 * The store here refuses to hand out a job, so `processNextJob` returns before
 * any provider work; what is under test is the argument, not the render.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CostLedger, OperatorReviewQueue } from "../../operator/src/index";
import { DurableJobStore, FAIR_SHARE_WINDOW_MS, type ClaimOptions, type Job } from "../src/index";
import { processNextJob } from "../src/worker";

const root = mkdtempSync(join(tmpdir(), "hv-fair-share-wiring-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const NOW = Date.parse("2026-09-17T12:00:00.000Z");
const event = (projectId: string, seconds: number, at: number) => ({
  jobId: `${projectId}-${at}`, at: new Date(at).toISOString(), projectId, shotId: "s",
  stage: "animatic" as const, provider: "test", model: "m",
  prompt_tokens: 1, output_frames: 1, gpu_seconds: seconds, total_cost_usd: 0,
});

/** Records what `claimNext` was given and offers nothing, so nothing renders. */
class ObservingStore extends DurableJobStore {
  readonly seen: { now: number; weights: Record<string, number> }[] = [];
  override claimNext(now: number, weights: Record<string, number> = {}, _options: ClaimOptions = {}): Job | undefined {
    this.seen.push({ now, weights: structuredClone(weights) });
    return undefined;
  }
}

test("the worker hands claimNext the ledger's windowed weights, at the same instant", async () => {
  const ledger = new CostLedger(join(root, "cost-ledger.json"));
  ledger.record(event("busy", 900, NOW - 3_600_000));
  ledger.record(event("busy", 100, NOW - 60_000));
  ledger.record(event("quiet", 5, NOW - 120_000));
  // Aged out: this is the history that used to be a permanent handicap.
  ledger.record(event("quiet", 50_000, NOW - FAIR_SHARE_WINDOW_MS - 1));

  const store = new ObservingStore(join(root, "jobs.json"));
  const claimed = await processNextJob(store, join(root, "media"), {
    ledger,
    reviewQueue: new OperatorReviewQueue(join(root, "review-queue.json")),
    now: () => NOW,
  });
  expect(claimed).toBeNull();

  // Exactly one claim, with the ledger's own answer for that instant -- not
  // `{}`, and not a lifetime total.
  expect(store.seen).toHaveLength(1);
  expect(store.seen[0]!.now).toBe(NOW);
  expect(store.seen[0]!.weights).toEqual(ledger.fairShareWeights(NOW));
  expect(store.seen[0]!.weights).toEqual({ busy: 1_000, quiet: 5 });
  // Stated separately from the deep-equal above, because `{}` would satisfy
  // "equal to the ledger" if the ledger were also empty, and would satisfy
  // neither of these.
  expect(Object.keys(store.seen[0]!.weights).length).toBeGreaterThan(0);
  expect(store.seen[0]!.weights.quiet).toBeLessThan(store.seen[0]!.weights.busy!);
});

test("the in-memory store orders the claim by the weight it was handed", () => {
  // The other half of the link: that a non-empty map actually changes who is
  // served. `packages/queue/test/queue.test.ts:133` covers this for the
  // in-memory store; it is repeated here against weights taken from a real
  // ledger rather than written by hand, so the two halves meet.
  const ledger = new CostLedger(join(root, "order-ledger.json"));
  ledger.record(event("busy", 900, NOW - 60_000));
  ledger.record(event("quiet", 5, NOW - 60_000));

  const store = new DurableJobStore(join(root, "order-jobs.json"));
  const base = {
    tier: "free" as const, stage: "animatic" as const, scriptVersion: 1, totalFrames: 60,
    retryPolicy: { maxRetries: 1, backoffMs: 10 }, timeoutMs: 120_000, costCapUsd: 5,
    scriptText: "INT. ROOM - DAY\n\nA lamp glows.", rightsAttestedAt: "2026-08-31T00:00:00.000Z",
    animaticJobId: null, animaticApprovedAt: null,
  };
  // Ids chosen so the alphabetical tie-break would serve `busy` first, which
  // makes the assertion about the weight rather than about the id order.
  store.enqueue({ ...base, id: "a-busy", idempotencyKey: "a-busy", projectId: "busy" } as never);
  store.enqueue({ ...base, id: "z-quiet", idempotencyKey: "z-quiet", projectId: "quiet" } as never);

  expect(store.claimNext(NOW, ledger.fairShareWeights(NOW), { workerId: "w1" })?.id).toBe("z-quiet");
  // And with no weights at all the tie-break decides, which is the state the
  // worker would be in if it stopped consulting the ledger.
  const bare = new DurableJobStore(join(root, "bare-jobs.json"));
  bare.enqueue({ ...base, id: "a-busy", idempotencyKey: "a-busy", projectId: "busy" } as never);
  bare.enqueue({ ...base, id: "z-quiet", idempotencyKey: "z-quiet", projectId: "quiet" } as never);
  expect(bare.claimNext(NOW, {}, { workerId: "w2" })?.id).toBe("a-busy");
});
