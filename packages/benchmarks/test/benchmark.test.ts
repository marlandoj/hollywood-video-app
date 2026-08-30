import { describe, expect, test } from "bun:test";
import { runBenchmark } from "../src/run";
import { compare } from "../../../scripts/benchmark/compare";

describe("24-shot benchmark (AC-001)", () => {
  test("fixture plans exactly 24 shots and records all baseline metrics", async () => {
    const m = await runBenchmark(`/tmp/hv-bench-${Date.now()}`);
    expect(m.shots).toBe(24);
    expect(m.perShotLatencyMsAvg).toBeGreaterThan(0);
    expect(m.perShotLatencyMsP99).toBeGreaterThan(0);
    expect(m.totalPipelineMs).toBeGreaterThan(0);
    expect(m.visualQualityProxy).toBeGreaterThan(0);
    expect(m.continuityAvg).toBeGreaterThan(0);
    expect(m.costPerShotUsd).toBe(0);
    expect(m.fixtureVersion).toBe("1.0.0");
    expect(m.fixtureSha256).toHaveLength(64);
  }, 120000);
});

describe("regression gate (AC-002)", () => {
  const base = { fixtureVersion: "1.0.0", fixtureSha256: "x", provider: "mock", model: "m", shots: 24, perShotLatencyMsAvg: 100, perShotLatencyMsP99: 150, totalPipelineMs: 2400, visualQualityProxy: 0.9, continuityAvg: 0.8, costPerShotUsd: 1, recordedAt: "" };
  test("blocks on >5% regression on any metric", () => {
    expect(compare(base, { ...base, perShotLatencyMsAvg: 106 }).pass).toBe(false);
    expect(compare(base, { ...base, continuityAvg: 0.75 }).pass).toBe(false);
    expect(compare(base, { ...base, costPerShotUsd: 1.06 }).pass).toBe(false);
  });
  test("passes within 5%", () => {
    expect(compare(base, { ...base, perShotLatencyMsAvg: 104, continuityAvg: 0.79 }).pass).toBe(true);
  });
});
