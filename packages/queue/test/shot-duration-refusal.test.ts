import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { CostLedger, OperatorReviewQueue } from "../../operator/src/index";
import { DeterministicMockProvider, type VideoClip } from "../../generator/src/index";
import { ShotDurationError } from "../../generator/src/animatic";
import { DurableJobStore } from "../src/index";
import { processNextJob } from "../src/worker";

/**
 * HV-030-05: a shot whose temporary dialogue will not fit its set duration is refused before any
 * image is requested, and the job is cancelled rather than retried — nothing was spent, and a retry
 * would refuse again. What the creator then reads is the cancellation, so it has to say which shot.
 */
const SCRIPT = "INT. ROOM - DAY\n\nA lamp glows.\n\nNORA\nOne more night, old friend.";
const MEASURED = "Temporary dialogue needs 12.4 s and this shot is set to 10.0 s. "
  + "Set the duration to at least 12.4 s, shorten the dialogue, or use automatic duration; no image was requested.";

function job(over: Record<string, unknown> = {}) {
  return {id: "job-1", idempotencyKey: "job-1", projectId: "project-1", tier: "free" as const, stage: "final" as const,
    scriptVersion: 1, totalFrames: 60, retryPolicy: {maxRetries: 2, backoffMs: 1}, timeoutMs: 120000, costCapUsd: 5,
    scriptText: SCRIPT, rightsAttestedAt: "2026-08-31T00:00:00.000Z", animaticJobId: "animatic-1",
    animaticApprovedAt: "2026-08-31T00:05:00.000Z", ...over};
}
function seedFinishedAnimatic(store: DurableJobStore): void {
  store.enqueue({...job({id: "animatic-1", idempotencyKey: "animatic-1", stage: "animatic", animaticJobId: null, animaticApprovedAt: null})} as Parameters<DurableJobStore["enqueue"]>[0]);
  store.claimNext(Date.now(), {}, {workerId: "seed"});
  store.complete("animatic-1", "seed", {mp4Path: "project-1/animatic-1/export.mp4", hlsPlaylistPath: "project-1/animatic-1/hls/index.m3u8",
    captionsPath: "project-1/animatic-1/captions.vtt", manifestPath: "project-1/animatic-1/provenance.json"});
}

test("a duration refusal cancels once, names its shot, and keeps the measurement the creator needs", async () => {
  const root = `/tmp/hv-shot-duration-${Date.now()}`, store = new DurableJobStore(root + "/jobs.json");
  try {
    seedFinishedAnimatic(store);
    store.enqueue(job());
    let calls = 0;
    const refusing = new (class extends DeterministicMockProvider {
      override async generate(): Promise<VideoClip> { calls++; throw new ShotDurationError(MEASURED); }
    })();
    const result = await processNextJob(store, root + "/artifacts", {ledger: new CostLedger(root + "/cost-ledger.json"),
      reviewQueue: new OperatorReviewQueue(root + "/review-queue.json"), primary: refusing, secondary: refusing});
    expect(result?.status).toBe("cancelled");
    // Named, so a creator with up to sixty shots is not left to find which one.
    expect(result?.cancelReason).toMatch(/^Shot \S+: Temporary dialogue needs 12\.4 s and this shot is set to 10\.0 s\./);
    expect(result?.cancelReason).toContain("use automatic duration");
    // One attempt, nothing spent: a second attempt would refuse identically.
    expect(calls).toBe(1);
    expect(result?.costUsd).toBe(0);
  } finally { rmSync(root, {recursive: true, force: true}); }
}, 30000);
