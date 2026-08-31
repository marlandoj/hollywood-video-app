import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { assemble } from "../../assembler/src/index";
import {
  DeterministicMockProvider,
  FailoverGenerator,
  repairLoop,
  type ProviderAdapter,
  type VideoClip,
} from "../../generator/src/index";
import { CostLedger, OperatorReviewQueue } from "../../operator/src/index";
import { attestRights, generateBible, planShots } from "../../planner/src/index";
import { parseFountain } from "../../parser/src/index";
import { checkPrompt } from "../../safety/src/index";
import { readJsonFile, writeJsonFile } from "./persist";
import { DurableJobStore, TIERS, type Job } from "./index";

export interface WorkerOptions {
  queuePath?: string;
  artifactRoot?: string;
  pollMs?: number;
  ledgerPath?: string;
  reviewQueuePath?: string;
}

export interface WorkerContext {
  ledger: CostLedger;
  reviewQueue: OperatorReviewQueue;
  primary?: ProviderAdapter;
  secondary?: ProviderAdapter;
  providerTimeoutMs?: number;
  now?: () => number;
}

const ANIMATIC_SIZE = "640x360";
const ANIMATIC_DURATION_SEC = 1;

function clipManifestPath(outputDirectory: string): string {
  return `${outputDirectory}/clips/manifest.json`;
}

function loadCompletedClips(outputDirectory: string, upTo: number): VideoClip[] {
  if (upTo <= 0) return [];
  const clips = readJsonFile<VideoClip[]>(clipManifestPath(outputDirectory)) ?? [];
  return clips.slice(0, upTo);
}

export async function processNextJob(
  store: DurableJobStore,
  artifactRoot: string,
  context: WorkerContext,
): Promise<Job | null> {
  const now = context.now ?? Date.now;
  const job = store.claimNext(now(), context.ledger.gpuSecondsByProject());
  if (!job) return null;

  const deadline = now() + job.timeoutMs;
  const assertWithinDeadline = () => {
    if (now() > deadline) throw new Error(`job exceeded its ${Math.round(job.timeoutMs / 1000)}s timeout`);
  };

  try {
    if (!job.rightsAttestedAt) throw new Error("rights attestation is required before generation");
    if (job.stage === "final" && !job.animaticApprovedAt) {
      throw new Error("the animatic must be approved before final generation");
    }

    const parsed = parseFountain(job.scriptText);
    if (parsed.rejected || parsed.scenes.length === 0) {
      throw new Error(parsed.rejectionReason ?? "screenplay contains no parseable scenes");
    }

    const shots = planShots(parsed, 7000);
    if (shots.length > TIERS[job.tier].maxShots) {
      throw new Error(`${job.tier} tier allows at most ${TIERS[job.tier].maxShots} shots`);
    }
    for (const shot of shots) {
      const safety = checkPrompt(shot.prompt);
      if (!safety.allowed) throw new Error(safety.refusal ?? "content policy refusal");
    }

    attestRights(generateBible(job.projectId, parsed), job.rightsAttestedAt);

    const outputDirectory = resolve(artifactRoot, job.projectId, job.id);
    mkdirSync(outputDirectory, { recursive: true });

    const primary = context.primary ?? new DeterministicMockProvider();
    const secondary = context.secondary ?? new DeterministicMockProvider();
    const generator = new FailoverGenerator(primary, secondary, context.providerTimeoutMs ?? 30_000);

    const isAnimatic = job.stage === "animatic";
    const size = isAnimatic ? ANIMATIC_SIZE : TIERS[job.tier].maxResolution;
    const resumeFrom = Math.min(job.checkpointShots, shots.length);
    const clips: VideoClip[] = loadCompletedClips(outputDirectory, resumeFrom);
    const resumed = clips.length;
    const shotReviews: { shotId: string; score: number }[] = [];
    const degradedShots: string[] = [];
    let previous: VideoClip | null = clips.length ? clips[clips.length - 1]! : null;
    let frames = job.checkpointFrame;

    for (const [index, shot] of shots.entries()) {
      if (index < resumed) continue;
      assertWithinDeadline();
      const durationSec = isAnimatic ? ANIMATIC_DURATION_SEC : shot.durationSec;
      const generated = await repairLoop(
        shot.id,
        previous,
        (attempt) => generator.generate(
          shot.prompt,
          shot.seed + attempt * 10000,
          { seed: shot.seed, durationSec, fps: 30, widthxheight: size },
          `${outputDirectory}/clips/${shot.id}-a${attempt}.mp4`,
        ),
        shotReviews,
      );
      clips.push(generated.clip);
      previous = generated.clip;
      if (generated.outcome.status === "degraded") degradedShots.push(shot.id);

      context.ledger.record({
        ...generated.clip.cost,
        at: new Date(now()).toISOString(),
        projectId: job.projectId,
        shotId: shot.id,
        jobId: job.id,
      });
      const priced = store.recordCost(job.id, generated.clip.cost);
      if (priced.status === "cancelled") {
        writeJsonFile(clipManifestPath(outputDirectory), clips);
        return priced;
      }

      frames += Math.round(durationSec * 30);
      writeJsonFile(clipManifestPath(outputDirectory), clips);
      store.checkpoint(job.id, index + 1, frames);
    }

    for (const flagged of shotReviews) {
      context.reviewQueue.flag(flagged.shotId, job.projectId, flagged.score);
    }

    assertWithinDeadline();
    const exportResult = assemble(
      clips,
      shots,
      outputDirectory,
      { crossfadeSec: isAnimatic ? 0 : 0.5, fps: 30, size },
      degradedShots,
    );
    const relative = (path: string) => path.slice(resolve(artifactRoot).length + 1);
    return store.complete(job.id, {
      mp4Path: relative(exportResult.mp4Path),
      hlsPlaylistPath: relative(exportResult.hlsPlaylistPath),
      captionsPath: relative(exportResult.vttPath),
      manifestPath: relative(exportResult.manifestPath),
    });
  } catch (error) {
    return store.fail(job.id, error instanceof Error ? error.message : String(error), now());
  }
}

export async function runWorker(options: WorkerOptions = {}): Promise<never> {
  const queuePath = options.queuePath ?? process.env.HV_QUEUE_PATH ?? "/data/queue/jobs.json";
  const artifactRoot = options.artifactRoot ?? process.env.HV_ARTIFACT_ROOT ?? "/data/artifacts";
  const pollMs = options.pollMs ?? Number(process.env.HV_WORKER_POLL_MS ?? 1000);
  const store = new DurableJobStore(queuePath);
  const context: WorkerContext = {
    ledger: new CostLedger(options.ledgerPath ?? process.env.HV_COST_LEDGER_PATH ?? "/data/state/cost-ledger.json"),
    reviewQueue: new OperatorReviewQueue(
      options.reviewQueuePath ?? process.env.HV_REVIEW_QUEUE_PATH ?? "/data/state/operator-review-queue.json",
    ),
    providerTimeoutMs: Number(process.env.HV_PROVIDER_TIMEOUT_MS ?? 30_000),
  };

  while (true) {
    const processed = await processNextJob(store, artifactRoot, context);
    await Bun.sleep(processed ? 10 : pollMs);
  }
}

if (import.meta.main) {
  await runWorker();
}
