import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(process.env.HV_ARTIFACT_ROOT ?? "/data/artifacts");
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

if (import.meta.main) {
  while (true) {
    console.log(JSON.stringify({ sweptAt: new Date().toISOString(), removed: sweepExpiredArtifacts() }));
    await Bun.sleep(24 * 60 * 60 * 1000);
  }
}
