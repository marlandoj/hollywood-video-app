import { readFileSync } from "node:fs";
import type { BenchmarkMetrics } from "../../packages/benchmarks/src/run";

const REGRESSION_LIMIT = 0.05;

const LOWER_IS_BETTER: (keyof BenchmarkMetrics)[] = ["perShotLatencyMsAvg", "perShotLatencyMsP99", "totalPipelineMs", "costPerShotUsd"];
const HIGHER_IS_BETTER: (keyof BenchmarkMetrics)[] = ["visualQualityProxy", "continuityAvg"];

export function compare(baseline: BenchmarkMetrics, candidate: BenchmarkMetrics): { pass: boolean; regressions: string[] } {
  const regressions: string[] = [];
  for (const k of LOWER_IS_BETTER) {
    const b = baseline[k] as number, c = candidate[k] as number;
    if (b > 0 && (c - b) / b > REGRESSION_LIMIT) regressions.push(`${k}: ${b.toFixed(2)} -> ${c.toFixed(2)} (+${(((c - b) / b) * 100).toFixed(1)}%)`);
  }
  for (const k of HIGHER_IS_BETTER) {
    const b = baseline[k] as number, c = candidate[k] as number;
    if (b > 0 && (b - c) / b > REGRESSION_LIMIT) regressions.push(`${k}: ${b.toFixed(3)} -> ${c.toFixed(3)} (-${(((b - c) / b) * 100).toFixed(1)}%)`);
  }
  return { pass: regressions.length === 0, regressions };
}

if (import.meta.main) {
  const [baselinePath, candidatePath] = process.argv.slice(2);
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const candidate = JSON.parse(readFileSync(candidatePath, "utf8"));
  const r = compare(baseline, candidate);
  if (!r.pass) {
    console.error("BENCHMARK REGRESSION > 5% — blocking merge:");
    for (const line of r.regressions) console.error("  " + line);
    process.exit(1);
  }
  console.log("benchmark within 5% of baseline");
}
