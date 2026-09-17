import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
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

/**
 * How the merge gate treats each recorded field.
 *
 * - `exact`        must be identical to the baseline, or the comparison is
 *                  between two different things.
 * - `lower`        a regression is an increase beyond the allowed variance.
 *                  `floor` is an absolute allowance in the field's own units,
 *                  which is what makes a gate fire from a zero baseline.
 * - `higher`       a regression is a decrease beyond the allowed variance.
 * - `latency-ab`   gated, but only by the same-host interleaved A/B, never
 *                  against the committed baseline.
 * - `latency-note` reported against the baseline as an advisory, never gated.
 * - `note`         deliberately not gated, and named here so that "not gated"
 *                  is a decision on the record rather than an omission.
 *
 * This table is the single classification. `scripts/benchmark/compare.ts`
 * consumed three hand-written arrays instead, and `BenchmarkMetrics` is a
 * closed set in this file, so a field added here shipped silently ungated --
 * and every remaining §8 clause (identity similarity, palette match,
 * composition, caption alignment, loudness compliance, QC pass rate, provider
 * success rate) is a field added here. A test fails when any recorded field is
 * missing from this table or any entry here is not a recorded field.
 */
export type BenchmarkFieldRule =
  | { kind: "exact" }
  | { kind: "lower"; limit: number; floor: number }
  | { kind: "higher"; limit: number; floor: number }
  | { kind: "latency-ab"; limit: number }
  | { kind: "latency-note" }
  | { kind: "note" };

export const BENCHMARK_FIELDS: Record<keyof BenchmarkMetrics, BenchmarkFieldRule> = {
  fixtureVersion: { kind: "exact" },
  fixtureSha256: { kind: "exact" },
  shots: { kind: "exact" },
  // Which provider produced the record is part of what makes two records
  // comparable, so it is gated like the fixture digest. It was ungated, which
  // meant a candidate that swapped the mock provider for a faster or cheaper
  // one passed the deterministic gate in silence.
  provider: { kind: "exact" },
  model: { kind: "exact" },
  // The only field that legitimately differs on every run.
  recordedAt: { kind: "note" },
  // FULL-SCOPE §8: "cost variance (≤ 5 % or $0.05)". The absolute floor is the
  // half that matters here, because the mock provider records $0.00 per shot
  // and a purely proportional limit can never fire from a zero baseline.
  costPerShotUsd: { kind: "lower", limit: 0.05, floor: 0.05 },
  visualQualityProxy: { kind: "higher", limit: 0.05, floor: 0.05 },
  continuityAvg: { kind: "higher", limit: 0.05, floor: 0.05 },
  perShotLatencyMsMin: { kind: "latency-ab", limit: 0.05 },
  totalPipelineMs: { kind: "latency-ab", limit: 0.05 },
  perShotLatencyMsAvg: { kind: "latency-note" },
  perShotLatencyMsMedian: { kind: "latency-note" },
  perShotLatencyMsP99: { kind: "latency-note" },
};

/**
 * The fields of one classification, in the table's own order. Defaults to this
 * benchmark's table; `packages/benchmarks/src/animatic.ts` passes its own.
 */
export function benchmarkFieldsOf(kind: BenchmarkFieldRule["kind"]): (keyof BenchmarkMetrics)[];
export function benchmarkFieldsOf<T extends Record<string, BenchmarkFieldRule>>(kind: BenchmarkFieldRule["kind"], table: T): (keyof T)[];
export function benchmarkFieldsOf(kind: BenchmarkFieldRule["kind"], table: Record<string, BenchmarkFieldRule> = BENCHMARK_FIELDS): string[] {
  return Object.keys(table).filter(field => table[field]!.kind === kind);
}

export async function runBenchmark(outDir = "/tmp/hv-benchmark"): Promise<BenchmarkMetrics> {
  // `URL.pathname` is percent-encoded, so a checkout under a path containing a
  // space resolved to a file that does not exist.
  const fixturePath = fileURLToPath(new URL("../fixtures/benchmark-24shot.fountain", import.meta.url));
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
