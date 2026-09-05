import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { StudioDatabase } from "../packages/storage/src/database";
import { PostgresRetention } from "../packages/storage/src/retention";
import { ProjectService } from "../packages/api/src/index";

const root = resolve(process.env.HV_ARTIFACT_ROOT ?? "/data/artifacts");
const statePath = process.env.HV_PROJECT_STATE_PATH ?? "/data/state/projects.json";
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
  for (const projectId of removed) {
    rmSync(join(root, projectId), { recursive: true, force: true });
  }
  return removed;
}

if (import.meta.main && process.env.HV_STORAGE === "postgres") {
  const database = new StudioDatabase(process.env.HV_WORKER_DATABASE_URL ?? "");
  const retention = new PostgresRetention(database);
  let lastOrphans = 0;
  while (true) {
    try {
      const removedProjects = await retention.sweep();
      let localCacheDirectories: number | null = null;
      try {localCacheDirectories = await retention.clearLocalCaches(root);}
      catch {console.error(JSON.stringify({event:"retention.cache_cleanup_failed",retryInSeconds:60}));}
      const storage = await retention.drain();
      let orphanObjects = 0;
      if (Date.now()-lastOrphans > 3600e3) {orphanObjects = await retention.collectOrphans();lastOrphans=Date.now();}
      console.log(JSON.stringify({sweptAt:new Date().toISOString(),removedProjects,localCacheDirectories,storage,orphanObjects}));
    } catch {console.error(JSON.stringify({event:"retention.failed",retryInSeconds:60}));}
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
