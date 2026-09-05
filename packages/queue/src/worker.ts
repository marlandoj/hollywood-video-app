import { PostgresArtifactStore } from "../../storage/src/artifacts";
import { StudioDatabase } from "../../storage/src/database";
import { PostgresJobStore } from "../../storage/src/jobs";
import { PostgresCostLedger } from "../../storage/src/ledger";
import { PostgresReviewQueue } from "../../storage/src/reviews";
import { mkdirSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { assembleAsync } from "../../assembler/src/index";
import {
  DEFAULT_FAL_MAX_WAIT_MS,
  DeterministicMockProvider,
  FailoverGenerator,
  providerUsesPaidInference,
  repairLoop,
  resolveProvider,
  resolveAnimaticProvider,
  RichAnimaticProvider,
  type CostRecord,
  type ProviderAdapter,
  type VideoClip,
} from "../../generator/src/index";
import { BudgetError, CostLedger, OperatorReviewQueue } from "../../operator/src/index";
import { attestRights, generateBible, planShots } from "../../planner/src/index";
import { parseFountain } from "../../parser/src/index";
import { SafetyRefusalError, checkShot } from "../../safety/src/index";
import { readJsonFile, writeJsonFile } from "./persist";
import { DEFAULT_LEASE_MS, DurableJobStore, LeaseError, TIERS, type Job } from "./index";

export interface WorkerOptions {
  queuePath?: string;
  artifactRoot?: string;
  pollMs?: number;
  ledgerPath?: string;
  reviewQueuePath?: string;
  workerId?: string;
  leaseMs?: number;
}

export interface WorkerContext {
  artifacts?: PostgresArtifactStore;
  ledger: CostLedger | PostgresCostLedger;
  reviewQueue: OperatorReviewQueue | PostgresReviewQueue;
  primary?: ProviderAdapter;
  secondary?: ProviderAdapter;
  // Animatics are a pacing check the user reviews before paying for real
  // generation, so they render on this provider (the placeholder by default)
  // regardless of what primary/secondary are.
  animaticProvider?: ProviderAdapter;
  providerTimeoutMs?: number;
  now?: () => number;
  workerId?: string;
  leaseMs?: number;
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
  store: DurableJobStore | PostgresJobStore,
  artifactRoot: string,
  context: WorkerContext,
): Promise<Job | null> {
  const now = context.now ?? Date.now;
  const leaseMs = context.leaseMs ?? DEFAULT_LEASE_MS;
  const workerId = context.workerId ?? crypto.randomUUID();
  const job = await store.claimNext(now(), await context.ledger.gpuSecondsByProject(), { workerId, leaseMs });
  if (!job) return null;

  const deadline = now() + job.timeoutMs;
  // A real provider can take minutes per shot (up to three attempts each) and
  // assembly of a long cut is not instant, so the lease is refreshed on a timer
  // while those steps run rather than only between shots.
  const jobAbort = new AbortController();
  const keepingLease = async <T>(step: () => Promise<T>): Promise<T> => {
    await store.heartbeat(job.id, workerId, now(), leaseMs);
    let pending: Promise<void> | undefined;
    const timer = setInterval(() => {
      if (pending) return;
      pending = Promise.resolve().then(() => store.heartbeat(job.id, workerId, now(), leaseMs))
        .catch(error => { jobAbort.abort(error); })
        .finally(() => { pending = undefined; });
    }, Math.max(50, Math.floor(leaseMs / 3)));
    try {
      const result = await step();
      jobAbort.signal.throwIfAborted();
      return result;
    } finally {
      clearInterval(timer);
      await pending;
    }
  };
  const assertWithinDeadline = () => {
    if (now() > deadline) throw new Error(`job exceeded its ${Math.round(job.timeoutMs / 1000)}s timeout`);
  };
  let currentShotId = "";
  let attemptId = "", attemptCostIndex = 0, attemptEstimate = 0;
  const chargeCost = async (cost: CostRecord): Promise<Job> => {
    const event = {...cost, eventId: attemptId + ":" + attemptCostIndex++, attemptId,
      at: new Date(now()).toISOString(), projectId: job.projectId, shotId: currentShotId, jobId: job.id, stage: job.stage};
    if (context.ledger instanceof PostgresCostLedger) {
      const updated = await context.ledger.recordForJob(event);
      if (!updated) throw new LeaseError(job.id, "not_running", null);
      return updated;
    }
    await context.ledger.record(event);
    return await store.recordCost(job.id, workerId, cost, now());
  };

  try {
    await context.ledger.reserve(job.id, job.stage, job.budgetReservedUsd ?? job.costCapUsd, Number(process.env.HV_MONTHLY_BUDGET_USD ?? 5000));
    if (!job.rightsAttestedAt) throw new Error("rights attestation is required before generation");
    if (job.stage === "final") {
      if (!job.animaticApprovedAt) throw new Error("the animatic must be approved before final generation");
      const animatic = job.animaticJobId ? await store.get(job.animaticJobId) : undefined;
      if (!animatic || animatic.projectId !== job.projectId || animatic.stage !== "animatic" || animatic.status !== "done") {
        throw new Error("final generation requires a finished animatic from the same project");
      }
      if (animatic.scriptVersion !== job.scriptVersion) {
        throw new Error("the screenplay changed after the animatic rendered; approve a new animatic first");
      }
    }

    const parsed = parseFountain(job.scriptText);
    if (parsed.rejected || parsed.scenes.length === 0) {
      throw new Error(parsed.rejectionReason ?? "screenplay contains no parseable scenes");
    }

    const shots = planShots(parsed, 7000, TIERS[job.tier].maxShots);
    if (shots.length > TIERS[job.tier].maxShots) {
      throw new Error(`${job.tier} tier allows at most ${TIERS[job.tier].maxShots} shots`);
    }
    for (const shot of shots) {
      const safety = checkShot(shot);
      if (!safety.allowed) throw new SafetyRefusalError(safety);
    }

    attestRights(generateBible(job.projectId, parsed), job.rightsAttestedAt);

    const outputDirectory = resolve(artifactRoot, job.projectId, job.id);
    mkdirSync(outputDirectory, { recursive: true });

    const isAnimatic = job.stage === "animatic";
    const stageProvider = isAnimatic ? (job.providerSpec ? resolveAnimaticProvider(job.providerSpec) : context.animaticProvider) : undefined;
    const primary = stageProvider ?? context.primary ?? new DeterministicMockProvider();
    const secondary = stageProvider ?? context.secondary ?? new DeterministicMockProvider();
    const generator = new FailoverGenerator(primary, secondary, context.providerTimeoutMs ?? 30_000);

    const size = isAnimatic ? ANIMATIC_SIZE : TIERS[job.tier].maxResolution;
    if (context.artifacts) await keepingLease(() => context.artifacts!.restoreCheckpoint(job, jobAbort.signal));
    const resumeFrom = Math.min(job.checkpointShots, shots.length);
    const clips: VideoClip[] = loadCompletedClips(outputDirectory, resumeFrom);
    const resumed = clips.length;
    const shotReviews: { shotId: string; score: number }[] = [];
    const degradedShots: string[] = [];
    let previous: VideoClip | null = clips.length ? clips[clips.length - 1]! : null;
    let frames = job.checkpointFrame;

    for (const [index, shot] of shots.entries()) {
      if (index < resumed) continue;
      currentShotId = shot.id;
      assertWithinDeadline();
      await store.heartbeat(job.id, workerId, now(), leaseMs);
      const durationSec = isAnimatic && !(primary instanceof RichAnimaticProvider) ? ANIMATIC_DURATION_SEC : shot.durationSec;
      const generated = await keepingLease(() => repairLoop(
        shot.id,
        previous,
        (attempt) => generator.generate(
          shot.prompt,
          shot.seed + attempt * 10000,
          { seed: shot.seed, durationSec, fps: 30, widthxheight: size, shotId: shot.id, dialogue: shot.dialogue,
            sceneHeading: parsed.scenes[shot.sceneIndex]?.heading, action: shot.prompt,
            signal: jobAbort.signal,
            beforeAttempt: async (provider) => {
              const estimate = provider instanceof RichAnimaticProvider
                ? provider.estimateShotUsd({ seed: shot.seed, widthxheight: size })
                : provider.name === "fal" ? Number(process.env.HV_COST_CAP_PER_SHOT_USD ?? 5) : 0;
              attemptId = crypto.randomUUID(); attemptCostIndex = 0; attemptEstimate = estimate;
              await store.heartbeat(job.id, workerId, now(), leaseMs);
              if (context.ledger instanceof PostgresCostLedger) await context.ledger.beginAttempt({
                id: attemptId, projectId: job.projectId, jobId: job.id, shotId: shot.id, provider: provider.name,
                workerId, leaseVersion: job.leaseVersion!, estimateUsd: estimate,
              }, now());
              else await context.ledger.assertCanSpend(job.id, estimate);
              const dispatchedAttemptId = attemptId;
              return {onProviderRequest: async receipt => {
                if (context.ledger instanceof PostgresCostLedger) {
                  try {await context.ledger.attachRequest(dispatchedAttemptId,workerId,job.leaseVersion!,receipt);}
                  catch {throw new BudgetError("Provider request tracking is temporarily unavailable; generation is paused.");}
                }
              }};
            },
            onAttemptCost: async cost => { await chargeCost(cost); },
            afterAttempt: async outcome => {
              if (context.ledger instanceof PostgresCostLedger) {
                const ambiguous = outcome.accountingError || (outcome.dispatched && outcome.error && attemptEstimate > 0
                  && outcome.costs.length === 0 && (outcome.error as Error).name !== "SafetyRefusal");
                await context.ledger.finishAttempt(attemptId, ambiguous ? "unknown" : outcome.error ? "failed" : "succeeded");
              }
              const priced = await store.get(job.id);
              if (priced?.status === "cancelled") throw new BudgetError(priced.cancelReason ?? "generation budget exceeded");
            },
          },
          `${outputDirectory}/clips/${shot.id}-a${attempt}.mp4`,
        ),
        shotReviews,
      ));
      clips.push(generated.clip);
      previous = generated.clip;
      if (generated.outcome.status === "degraded") degradedShots.push(shot.id);


      frames += Math.round(generated.clip.durationSec * 30);
      writeJsonFile(clipManifestPath(outputDirectory), clips);
      if (context.artifacts) await keepingLease(() => context.artifacts!.checkpoint(job, workerId, clips, frames, leaseMs, jobAbort.signal));
      else await store.checkpoint(job.id, workerId, index + 1, frames, now(), leaseMs);
    }

    for (const flagged of shotReviews) {
      await context.reviewQueue.flag(flagged.shotId, job.projectId, flagged.score);
    }

    assertWithinDeadline();
    await store.heartbeat(job.id, workerId, now(), leaseMs);
    const exportResult = await keepingLease(() => assembleAsync(
      clips,
      shots,
      outputDirectory,
      { crossfadeSec: isAnimatic ? 0 : 0.5, fps: 30, size, projectId: job.projectId, signal: jobAbort.signal },
      degradedShots,
    ));
    if (context.artifacts) {
      const paths = [exportResult.mp4Path, exportResult.hlsPlaylistPath, exportResult.srtPath, exportResult.vttPath, exportResult.manifestPath,
        ...readdirSync(dirname(exportResult.hlsPlaylistPath)).filter(name => name.endsWith(".ts")).map(name => resolve(dirname(exportResult.hlsPlaylistPath), name))];
      await keepingLease(() => context.artifacts!.publishExport(job, workerId, paths, jobAbort.signal));
    }
    const relative = (path: string) => path.slice(resolve(artifactRoot).length + 1);
    return await store.complete(job.id, workerId, {
      mp4Path: relative(exportResult.mp4Path),
      hlsPlaylistPath: relative(exportResult.hlsPlaylistPath),
      captionsPath: relative(exportResult.vttPath),
      manifestPath: relative(exportResult.manifestPath),
      storyboard: clips.flatMap((clip, index) => clip.posterPath ? [{ shotId: shots[index]!.id,
        path: relative(clip.posterPath), caption: shots[index]!.prompt }] : []),
    }, now());
  } catch (error) {
    // A LeaseError means this worker no longer holds the job (its lease lapsed
    // and another worker may have resumed it), so it must not fail, refuse, or
    // requeue it; report the job as the store currently records it.
    if (error instanceof LeaseError) return await store.get(job.id) ?? null;
    const reason = error instanceof Error ? error.message : String(error);
    try {
      if (error instanceof BudgetError) {
        const current = await store.get(job.id);
        return current?.status === "cancelled" ? current : await store.cancel(job.id, workerId, reason, now());
      }
      if (error instanceof Error && error.name === "SafetyRefusal") return await store.refuse(job.id, workerId, reason, now());
      return await store.fail(job.id, workerId, reason, now());
    } catch (failure) {
      if (failure instanceof LeaseError) return await store.get(job.id) ?? null;
      throw failure;
    }
  } finally {
    try {
      const latest = await store.get(job.id);
      if (latest && ["done", "failed", "cancelled"].includes(latest.status)) await context.ledger.release(job.id);
    } finally { context.artifacts?.removeCache(job); }
  }
}

export async function runWorker(options: WorkerOptions = {}): Promise<never> {
  const queuePath = options.queuePath ?? process.env.HV_QUEUE_PATH ?? "/data/queue/jobs.json";
  const artifactBase = options.artifactRoot ?? process.env.HV_ARTIFACT_ROOT ?? "/data/artifacts";
  const pollMs = options.pollMs ?? Number(process.env.HV_WORKER_POLL_MS ?? 1000);
  const database = process.env.HV_STORAGE === "postgres" ? new StudioDatabase(process.env.HV_WORKER_DATABASE_URL ?? "") : undefined;
  const store = database ? new PostgresJobStore(database) : new DurableJobStore(queuePath);
  const workerId = options.workerId ?? process.env.HV_WORKER_ID ?? `${Bun.env.HOSTNAME ?? "worker"}-${process.pid}`;
  const sharedArtifacts = process.env.HV_ARTIFACT_STORAGE === "s3";
  if (sharedArtifacts && !database) throw new Error("shared artifacts require PostgreSQL metadata");
  const artifactRoot = sharedArtifacts ? resolve(artifactBase, ".workers", crypto.randomUUID()) : artifactBase;
  const leaseMs = options.leaseMs ?? Number(process.env.HV_JOB_LEASE_MS ?? DEFAULT_LEASE_MS);
  const primarySpec = process.env.HV_PROVIDER_PRIMARY ?? "mock";
  const secondarySpec = process.env.HV_PROVIDER_SECONDARY ?? "mock";
  const animaticSpec = process.env.HV_ANIMATIC_PROVIDER ?? "mock";
  const paid = [primarySpec, secondarySpec, animaticSpec].some(providerUsesPaidInference);
  const context: WorkerContext = {
    artifacts: sharedArtifacts ? new PostgresArtifactStore(database!, artifactRoot) : undefined,
    workerId,
    leaseMs,
    primary: resolveProvider(primarySpec),
    secondary: resolveProvider(secondarySpec),
    animaticProvider: resolveAnimaticProvider(animaticSpec),
    ledger: database ? new PostgresCostLedger(database) : new CostLedger(options.ledgerPath ?? process.env.HV_COST_LEDGER_PATH ?? "/data/state/cost-ledger.json"),
    reviewQueue: database ? new PostgresReviewQueue(database) : new OperatorReviewQueue(
      options.reviewQueuePath ?? process.env.HV_REVIEW_QUEUE_PATH ?? "/data/state/operator-review-queue.json",
    ),
    // The outer timeout must outlast the fal wait budget so the adapter, which
    // knows whether the abandoned request still bills, is the one that gives up.
    providerTimeoutMs: Number(process.env.HV_PROVIDER_TIMEOUT_MS ?? (paid ? DEFAULT_FAL_MAX_WAIT_MS + 60_000 : 30_000)),
  };

  // A job left `running` by a worker that died resumes from its checkpoint
  // rather than waiting forever (AC-024). The claim path repeats this check
  // on every poll so a lease that lapses later is recovered too.
  await store.recoverAbandoned(Date.now());

  while (true) {
    await context.ledger.reconcile(new Set((await store.all()).filter(j => j.status === "queued" || j.status === "running").map(j => j.id)));
    const processed = await processNextJob(store, artifactRoot, context);
    await Bun.sleep(processed ? 10 : pollMs);
  }
}

if (import.meta.main) {
  await runWorker();
}
