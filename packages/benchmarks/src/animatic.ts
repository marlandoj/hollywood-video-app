import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RichAnimaticProvider, DeterministicMockImageProvider } from "../../generator/src/index";
import { parseFountain } from "../../parser/src/index";
import { planShots } from "../../planner/src/index";
import { benchmarkFieldsOf, type BenchmarkFieldRule } from "./run";

export interface AnimaticMetrics {
  fixtureVersion: string;
  fixtureSha256: string;
  shots: number;
  posters: number;
  frames: number;
  costUsd: number;
  latencyMs: number;
}

/**
 * The animatic gate's classification, in the same shape as `BENCHMARK_FIELDS`
 * and for the same reason. Its comparison was a hand-written key list beside
 * the record it compares, with nothing checking the two agreed -- the identical
 * defect HV-037-01 repairs in `compare.ts`, in the same package, in the file
 * where a loudness or QC metric would most plausibly land. `latencyMs` is wall
 * clock and is deliberately not gated here; the deterministic gate's own
 * latency fields carry the same classification for the same reason.
 */
export const ANIMATIC_FIELDS: Record<keyof AnimaticMetrics, BenchmarkFieldRule> = {
  fixtureVersion: { kind: "exact" },
  fixtureSha256: { kind: "exact" },
  shots: { kind: "exact" },
  posters: { kind: "exact" },
  frames: { kind: "exact" },
  costUsd: { kind: "exact" },
  latencyMs: { kind: "latency-note" },
};

/** Exercise the new renderer independently of the unchanged legacy latency A/B. */
export async function runAnimaticBenchmark(): Promise<AnimaticMetrics> {
  const text = readFileSync(new URL("../fixtures/benchmark-24shot.fountain", import.meta.url), "utf8");
  const shots = planShots(parseFountain(text), 1000);
  const root = mkdtempSync(join(tmpdir(), "hv-animatic-benchmark-"));
  const provider = new RichAnimaticProvider(new DeterministicMockImageProvider());
  let frames = 0, costUsd = 0, posters = 0;
  const start = performance.now();
  try {
    mkdirSync(root, { recursive: true });
    for (const shot of shots) {
      const clip = await provider.generate(shot.prompt, shot.seed,
        { ...shot, durationSec: 1, fps: 30, widthxheight: "320x180", shotId: shot.id }, join(root, shot.id + ".mp4"));
      const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=nb_frames", "-of", "default=noprint_wrappers=1:nokey=1", clip.path]);
      if (probe.exitCode) throw new Error("animatic benchmark probe failed");
      frames += Number(probe.stdout.toString().trim());
      costUsd += clip.cost.total_cost_usd;
      if (clip.posterPath && readFileSync(clip.posterPath).byteLength > 100) posters++;
    }
    return { fixtureVersion: "animatic-1.0.0", fixtureSha256: createHash("sha256").update(text).digest("hex"),
      shots: shots.length, posters, frames, costUsd, latencyMs: performance.now() - start };
  } finally { rmSync(root, { recursive: true, force: true }); }
}
if (import.meta.main) {
  const actual = await runAnimaticBenchmark();
  const expected = JSON.parse(readFileSync(new URL("../animatic-baseline.json", import.meta.url), "utf8"));
  for (const key of benchmarkFieldsOf("exact", ANIMATIC_FIELDS)) {
    if (actual[key] !== expected[key]) throw new Error(`animatic ${key}: expected ${expected[key]}, got ${actual[key]}`);
  }
  process.stdout.write(JSON.stringify(actual) + "\n");
}
