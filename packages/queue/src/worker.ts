import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { assemble } from "../../assembler/src/index";
import { DeterministicMockProvider, repairLoop } from "../../generator/src/index";
import { attestRights, generateBible, planShots } from "../../planner/src/index";
import { parseFountain } from "../../parser/src/index";
import { checkPrompt } from "../../safety/src/index";
import { DurableJobStore, TIERS, type Job } from "./index";

export interface WorkerOptions {
  queuePath?: string;
  artifactRoot?: string;
  pollMs?: number;
}

export async function processNextJob(store: DurableJobStore, artifactRoot: string): Promise<Job | null> {
  const job = store.claimNext();
  if (!job) return null;

  try {
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

    attestRights(generateBible(job.projectId, parsed));
    const outputDirectory = resolve(artifactRoot, job.projectId, job.id);
    mkdirSync(outputDirectory, { recursive: true });
    const provider = new DeterministicMockProvider();
    const clips = [];
    const reviewQueue: { shotId: string; score: number }[] = [];
    const degradedShots: string[] = [];
    let previous = null;
    const size = TIERS[job.tier].maxResolution;

    for (const [index, shot] of shots.entries()) {
      const generated = await repairLoop(
        shot.id,
        previous,
        (attempt) => provider.generate(
          shot.prompt,
          shot.seed + attempt * 10000,
          { seed: shot.seed, durationSec: shot.durationSec, fps: 30, widthxheight: size },
          `${outputDirectory}/clips/${shot.id}-a${attempt}.mp4`,
        ),
        reviewQueue,
      );
      clips.push(generated.clip);
      previous = generated.clip;
      if (generated.outcome.status === "degraded") degradedShots.push(shot.id);
      store.checkpoint(job.id, index + 1);
    }

    const exportResult = assemble(clips, shots, outputDirectory, { crossfadeSec: 0.5, fps: 30, size }, degradedShots);
    const relative = (path: string) => path.slice(resolve(artifactRoot).length + 1);
    return store.complete(job.id, {
      mp4Path: relative(exportResult.mp4Path),
      hlsPlaylistPath: relative(exportResult.hlsPlaylistPath),
      captionsPath: relative(exportResult.vttPath),
      manifestPath: relative(exportResult.manifestPath),
    });
  } catch (error) {
    return store.fail(job.id, error instanceof Error ? error.message : String(error));
  }
}

export async function runWorker(options: WorkerOptions = {}): Promise<never> {
  const queuePath = options.queuePath ?? process.env.HV_QUEUE_PATH ?? "/data/queue/jobs.json";
  const artifactRoot = options.artifactRoot ?? process.env.HV_ARTIFACT_ROOT ?? "/data/artifacts";
  const pollMs = options.pollMs ?? Number(process.env.HV_WORKER_POLL_MS ?? 1000);
  const store = new DurableJobStore(queuePath);

  while (true) {
    const processed = await processNextJob(store, artifactRoot);
    await Bun.sleep(processed ? 10 : pollMs);
  }
}

if (import.meta.main) {
  await runWorker();
}
