import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { StudioDatabase } from "../packages/storage/src/database";
import { PostgresRetention, type IncompleteUploadCollection } from "../packages/storage/src/retention";
import { ProjectService } from "../packages/api/src/index";
import { DurableJobStore } from "../packages/queue/src/index";
import { loggerFromEnv } from "../packages/observability/src/logs";

const root = resolve(process.env.HV_ARTIFACT_ROOT ?? "/data/artifacts");
const statePath = process.env.HV_PROJECT_STATE_PATH ?? "/data/state/projects.json";
const queuePath = process.env.HV_QUEUE_PATH ?? "/data/queue/jobs.json";
/** Why a swept project's unfinished jobs stop: its retention ended, which is not a takedown. */
export const RETENTION_ENDED_NOTICE = "Generation stopped: this project reached the end of its 30-day retention and was deleted. Nothing further will be rendered.";
const retentionMs = 30 * 24 * 60 * 60 * 1000;

export function sweepExpiredArtifacts(now = Date.now()): string[] {
  mkdirSync(root, { recursive: true });
  const removed: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const path = join(root, entry.name);
    if (now - statSync(path).mtimeMs < retentionMs) continue;
    rmSync(path, { recursive: true });
    removed.push(entry.name);
  }
  return removed;
}

/**
 * Retention is only real if both halves expire: the rendered artifacts on disk
 * and the project record that still authorizes a token against them.
 */
export function sweepExpiredProjects(now = Date.now()): string[] {
  const removed = new ProjectService(statePath).sweepExpired(now);
  // HV-031-11: a job the project queued before it expired is stopped, as a takedown stops it, before
  // its media goes. Left queued, the worker rendered it -- spending on a project retention had erased
  // and writing its media folder back.
  const queue = removed.length ? new DurableJobStore(queuePath) : null;
  for (const projectId of removed) {
    queue!.revokeProject(projectId, RETENTION_ENDED_NOTICE, now);
    rmSync(join(root, projectId), { recursive: true, force: true });
  }
  return removed;
}

if (import.meta.main && process.env.HV_STORAGE === "postgres") {
  const database = new StudioDatabase(process.env.HV_WORKER_DATABASE_URL ?? "");
  const retention = new PostgresRetention(database);
  const logger = loggerFromEnv("retention");
  let lastOrphans = 0, lastIncompleteUploads = 0;
  // The last hourly multipart result stays on every per-minute status line until the next pass.
  let incompleteUploads: IncompleteUploadCollection | null = null;
  while (true) {
    try {
      const removedProjects = await retention.sweep();
      let localCacheDirectories: number | null = null;
      try {localCacheDirectories = await retention.clearLocalCaches(root);}
      catch {logger.error("retention.cache_cleanup_failed",{retryInSeconds:60});}
      const storage = await retention.drain();
      let orphanObjects = 0;
      if (Date.now()-lastOrphans > 3600e3) {orphanObjects = await retention.collectOrphans();lastOrphans=Date.now();}
      if (Date.now()-lastIncompleteUploads > 3600e3) {
        // A multipart failure never blocks purge, cache cleanup, S3 deletion or object orphan collection above.
        try {incompleteUploads = await retention.collectIncompleteUploads();lastIncompleteUploads=Date.now();}
        catch {logger.error("retention.incomplete_uploads_failed",{retryInSeconds:60});}
      }
      console.log(JSON.stringify({sweptAt:new Date().toISOString(),removedProjects,localCacheDirectories,storage,orphanObjects,incompleteUploads}));
    } catch {logger.error("retention.failed",{retryInSeconds:60});}
    await Bun.sleep(60_000);
  }
} else if (import.meta.main) {
  while (true) {
    const now = Date.now();
    console.log(JSON.stringify({
      sweptAt: new Date(now).toISOString(),
      removedArtifactDirectories: sweepExpiredArtifacts(now),
      removedProjects: sweepExpiredProjects(now),
    }));
    await Bun.sleep(24 * 60 * 60 * 1000);
  }
}
