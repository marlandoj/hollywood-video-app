import { describe, expect, test } from "bun:test";
import { calibrationMs, runBenchmark, type BenchmarkMetrics } from "../src/run";
import { LATENCY_LIMIT, compare } from "../../../scripts/benchmark/compare";

describe("24-shot benchmark (AC-001)", () => {
  test("fixture plans exactly 24 shots and records all baseline metrics", async () => {
    const m = await runBenchmark(`/tmp/hv-bench-${Date.now()}`);
    expect(m.shots).toBe(24);
    expect(m.perShotLatencyMsAvg).toBeGreaterThan(0);
    expect(m.perShotLatencyMsP99).toBeGreaterThan(0);
    expect(m.perShotLatencyMsMin).toBeGreaterThan(0);
    expect(m.calibrationMs).toBeGreaterThan(0);
    expect(m.normalizedPerShotLatency).toBeGreaterThan(0);
    expect(m.totalPipelineMs).toBeGreaterThan(0);
    expect(m.visualQualityProxy).toBeGreaterThan(0);
    expect(m.continuityAvg).toBeGreaterThan(0);
    expect(m.costPerShotUsd).toBe(0);
    expect(m.fixtureVersion).toBe("1.0.0");
    expect(m.fixtureSha256).toHaveLength(64);
  }, 120000);

  test("the calibration probe is stable enough to normalize against", () => {
    const samples = [calibrationMs(), calibrationMs(), calibrationMs(), calibrationMs(), calibrationMs()];
    for (const sample of samples) expect(sample).toBeGreaterThan(0);
    expect(Math.max(...samples) / Math.min(...samples)).toBeLessThan(1.5);
  });
});

describe("regression gate (AC-002)", () => {
  const base: BenchmarkMetrics = {
    fixtureVersion: "1.0.0",
    fixtureSha256: "x",
    provider: "mock",
    model: "m",
    shots: 24,
    perShotLatencyMsAvg: 100,
    perShotLatencyMsP99: 150,
    perShotLatencyMsMin: 90,
    calibrationMs: 10,
    normalizedPerShotLatency: 9,
    totalPipelineMs: 2400,
    visualQualityProxy: 0.9,
    continuityAvg: 0.8,
    costPerShotUsd: 1,
    recordedAt: "",
  };

  test("blocks on >5% regression in any deterministic metric", () => {
    expect(compare(base, { ...base, continuityAvg: 0.75 }).pass).toBe(false);
    expect(compare(base, { ...base, visualQualityProxy: 0.8 }).pass).toBe(false);
    expect(compare(base, { ...base, costPerShotUsd: 1.06 }).pass).toBe(false);
  });

  test("blocks when the benchmark fixture itself changed", () => {
    expect(compare(base, { ...base, fixtureSha256: "y" }).pass).toBe(false);
    expect(compare(base, { ...base, shots: 12 }).pass).toBe(false);
  });

  test("host wall-clock noise is reported as an advisory, not a merge blocker", () => {
    const noisyHost = { ...base, perShotLatencyMsAvg: 177, perShotLatencyMsP99: 260, totalPipelineMs: 4200 };
    const result = compare(base, noisyHost);
    expect(result.pass).toBe(true);
    expect(result.advisories.length).toBeGreaterThan(0);
    expect(result.advisories.join(" ")).toContain("not gating");
  });

  test("a real latency regression still blocks once normalized against the host", () => {
    const withinBand = base.normalizedPerShotLatency * (1 + LATENCY_LIMIT * 0.5);
    const overBand = base.normalizedPerShotLatency * (1 + LATENCY_LIMIT + 0.5);
    expect(compare(base, { ...base, normalizedPerShotLatency: withinBand }).pass).toBe(true);
    const blocked = compare(base, { ...base, normalizedPerShotLatency: overBand });
    expect(blocked.pass).toBe(false);
    expect(blocked.regressions.join(" ")).toContain("normalizedPerShotLatency");
  });

  test("a baseline recorded before calibration is rejected rather than silently passed", () => {
    const stale = { ...base, normalizedPerShotLatency: undefined as unknown as number };
    const result = compare(stale, base);
    expect(result.pass).toBe(false);
    expect(result.regressions.join(" ")).toContain("re-record the baseline");
  });

  test("passes within limits", () => {
    expect(compare(base, { ...base, continuityAvg: 0.79 }).pass).toBe(true);
  });
});
