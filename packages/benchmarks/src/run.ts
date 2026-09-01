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
  perShotLatencyMsMedian: number;
  perShotLatencyMsP99: number;
  perShotLatencyMsMin: number;
  totalPipelineMs: number;
  visualQualityProxy: number;
  continuityAvg: number;
  costPerShotUsd: number;
  recordedAt: string;
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
  return {
    fixtureVersion: "1.0.0",
    fixtureSha256,
    provider: provider.name,
    model: provider.model,
    shots: shots.length,
    perShotLatencyMsAvg: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    perShotLatencyMsMedian: sorted[Math.floor(sorted.length / 2)]!,
    perShotLatencyMsP99: sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)]!,
    perShotLatencyMsMin: sorted[0]!,
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
