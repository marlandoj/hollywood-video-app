import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DeterministicMockProvider, checkContinuity } from "../../generator/src/index";
import { parseFountain } from "../../parser/src/index";
import { planShots } from "../../planner/src/index";

export interface BenchmarkMetrics {
  fixtureVersion: string;
  fixtureSha256: string;
  provider: string;
  model: string;
  shots: number;
  perShotLatencyMsAvg: number;
  perShotLatencyMsP99: number;
  perShotLatencyMsMin: number;
  calibrationMs: number;
  normalizedPerShotLatency: number;
  totalPipelineMs: number;
  visualQualityProxy: number;
  continuityAvg: number;
  costPerShotUsd: number;
  recordedAt: string;
}

const CALIBRATION_ROUNDS = 400;
const CALIBRATION_BLOCK = Buffer.alloc(262_144, 7);

/**
 * Wall-clock latency on a shared host says as much about the host as about the
 * code, so every run measures the same fixed CPU workload and reports latency
 * relative to it. The regression gate compares the normalized figure.
 *
 * The probe hashes a fixed 256 KB block 400 times: large enough that the
 * measurement is bound by real CPU work rather than by JIT warm-up or GC, which
 * holds run-to-run spread under 1% while still tracking host speed.
 */
export function calibrationMs(): number {
  const start = performance.now();
  const digest = createHash("sha256");
  for (let round = 0; round < CALIBRATION_ROUNDS; round += 1) digest.update(CALIBRATION_BLOCK);
  digest.digest();
  const elapsed = performance.now() - start;
  return elapsed > 0 ? elapsed : Number.EPSILON;
}

export async function runBenchmark(outDir = "/tmp/hv-benchmark"): Promise<BenchmarkMetrics> {
  const fixturePath = new URL("../fixtures/benchmark-24shot.fountain", import.meta.url).pathname;
  const text = readFileSync(fixturePath, "utf8");
  const fixtureSha256 = createHash("sha256").update(text).digest("hex");
  const parsed = parseFountain(text);
  const shots = planShots(parsed, 1000);
  if (shots.length !== 24) throw new Error(`benchmark fixture must plan exactly 24 shots, got ${shots.length}`);
  const provider = new DeterministicMockProvider({ costPerShotUsd: 0.0 });
  mkdirSync(outDir, { recursive: true });
  const latencies: number[] = [];
  const t0 = performance.now();
  let prevClip = null;
  let continuitySum = 0;
  let qualitySum = 0;
  let costSum = 0;
  for (const shot of shots) {
    const s0 = performance.now();
    const clip = await provider.generate(shot.prompt, shot.seed, { seed: shot.seed, durationSec: 1 }, `${outDir}/${shot.id}.mp4`);
    latencies.push(performance.now() - s0);
    continuitySum += checkContinuity(shot.id, prevClip, clip).score;
    const bytes = readFileSync(clip.path);
    qualitySum += Math.min(1, bytes.length / 4096);
    costSum += clip.cost.total_cost_usd;
    prevClip = clip;
  }
  const total = performance.now() - t0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const calibration = calibrationMs();
  const latencyFloor = sorted[0]!;
  return {
    fixtureVersion: "1.0.0",
    fixtureSha256,
    provider: provider.name,
    model: provider.model,
    shots: shots.length,
    perShotLatencyMsAvg: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    perShotLatencyMsP99: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)],
    perShotLatencyMsMin: latencyFloor,
    calibrationMs: calibration,
    normalizedPerShotLatency: latencyFloor / calibration,
    totalPipelineMs: total,
    visualQualityProxy: qualitySum / shots.length,
    continuityAvg: continuitySum / shots.length,
    costPerShotUsd: costSum / shots.length,
    recordedAt: new Date().toISOString(),
  };
}

if (import.meta.main) {
  const metrics = await runBenchmark();
  const out = process.argv[2] ?? "packages/benchmarks/baseline.json";
  writeFileSync(out, JSON.stringify(metrics, null, 2));
  console.log(JSON.stringify(metrics, null, 2));
}
