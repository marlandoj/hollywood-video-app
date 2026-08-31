import { readFileSync } from "node:fs";
import type { BenchmarkMetrics } from "../../packages/benchmarks/src/run";

/**
 * Two gates, because the metrics are not equally trustworthy.
 *
 * Deterministic metrics (quality, continuity, cost) are reproducible on any
 * host, so a 5% move is a real regression and blocks the merge.
 *
 * Wall-clock latency on a shared CI host is dominated by process spawn and
 * scheduler noise. The 24-shot benchmark ran 72-77% "slower" on the ZOU-1566
 * review host with byte-identical output, which blocked the merge on host noise
 * rather than on a code change. Latency is therefore gated on the run's noise
 * floor divided by a same-run CPU calibration probe, with a band wide enough to
 * survive host variance and narrow enough to catch an order-of-magnitude change.
 */
export const DETERMINISTIC_LIMIT = 0.05;
export const LATENCY_LIMIT = Number(process.env.HV_BENCHMARK_LATENCY_LIMIT ?? 0.35);

const LOWER_IS_BETTER: (keyof BenchmarkMetrics)[] = ["costPerShotUsd"];
const HIGHER_IS_BETTER: (keyof BenchmarkMetrics)[] = ["visualQualityProxy", "continuityAvg"];

export interface CompareResult {
  pass: boolean;
  regressions: string[];
  advisories: string[];
}

export function compare(baseline: BenchmarkMetrics, candidate: BenchmarkMetrics): CompareResult {
  const regressions: string[] = [];
  const advisories: string[] = [];

  if (baseline.fixtureSha256 !== candidate.fixtureSha256) {
    regressions.push(`fixtureSha256 changed: ${baseline.fixtureSha256} -> ${candidate.fixtureSha256}`);
  }
  if (baseline.shots !== candidate.shots) {
    regressions.push(`shots changed: ${baseline.shots} -> ${candidate.shots}`);
  }

  for (const key of LOWER_IS_BETTER) {
    const before = baseline[key] as number, after = candidate[key] as number;
    if (before > 0 && (after - before) / before > DETERMINISTIC_LIMIT) {
      regressions.push(`${key}: ${before.toFixed(2)} -> ${after.toFixed(2)} (+${(((after - before) / before) * 100).toFixed(1)}%)`);
    }
  }
  for (const key of HIGHER_IS_BETTER) {
    const before = baseline[key] as number, after = candidate[key] as number;
    if (before > 0 && (before - after) / before > DETERMINISTIC_LIMIT) {
      regressions.push(`${key}: ${before.toFixed(3)} -> ${after.toFixed(3)} (-${(((before - after) / before) * 100).toFixed(1)}%)`);
    }
  }

  const baseNormalized = baseline.normalizedPerShotLatency;
  const candidateNormalized = candidate.normalizedPerShotLatency;
  if (!Number.isFinite(baseNormalized) || !Number.isFinite(candidateNormalized) || baseNormalized <= 0) {
    regressions.push("normalizedPerShotLatency is missing; re-record the baseline with the calibrated harness");
  } else {
    const delta = (candidateNormalized - baseNormalized) / baseNormalized;
    if (delta > LATENCY_LIMIT) {
      regressions.push(
        `normalizedPerShotLatency: ${baseNormalized.toFixed(3)} -> ${candidateNormalized.toFixed(3)} `
        + `(+${(delta * 100).toFixed(1)}%, limit ${(LATENCY_LIMIT * 100).toFixed(0)}%)`,
      );
    }
  }

  for (const key of ["perShotLatencyMsAvg", "perShotLatencyMsP99", "totalPipelineMs"] as const) {
    const before = baseline[key], after = candidate[key];
    if (before > 0 && (after - before) / before > DETERMINISTIC_LIMIT) {
      advisories.push(`${key}: ${before.toFixed(2)} -> ${after.toFixed(2)} (+${(((after - before) / before) * 100).toFixed(1)}%, host-sensitive, not gating)`);
    }
  }

  return { pass: regressions.length === 0, regressions, advisories };
}

if (import.meta.main) {
  const [baselinePath, candidatePath] = process.argv.slice(2);
  const baseline = JSON.parse(readFileSync(baselinePath!, "utf8")) as BenchmarkMetrics;
  const candidate = JSON.parse(readFileSync(candidatePath!, "utf8")) as BenchmarkMetrics;
  const result = compare(baseline, candidate);
  for (const line of result.advisories) console.log(`advisory: ${line}`);
  if (!result.pass) {
    console.error("BENCHMARK REGRESSION — blocking merge:");
    for (const line of result.regressions) console.error(`  ${line}`);
    process.exit(1);
  }
  console.log(
    `benchmark within limits (deterministic ${(DETERMINISTIC_LIMIT * 100).toFixed(0)}%, `
    + `calibrated latency ${(LATENCY_LIMIT * 100).toFixed(0)}%)`,
  );
}
