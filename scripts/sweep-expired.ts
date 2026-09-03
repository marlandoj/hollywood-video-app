import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
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

if (import.meta.main) {
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
