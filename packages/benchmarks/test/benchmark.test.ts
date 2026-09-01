import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runBenchmark, type BenchmarkMetrics } from "../src/run";
import { LATENCY_LIMIT, compare, compareDeterministic, compareLatency, resolveBaseRef, type Git } from "../../../scripts/benchmark/compare";

const REPO_ROOT = resolve(import.meta.dir, "../../..");

describe("24-shot benchmark (AC-001)", () => {
  test("fixture plans exactly 24 shots and records all baseline metrics", async () => {
    const m = await runBenchmark(`/tmp/hv-bench-${Date.now()}`);
    expect(m.shots).toBe(24);
    expect(m.perShotLatencyMsAvg).toBeGreaterThan(0);
    expect(m.perShotLatencyMsMedian).toBeGreaterThan(0);
    expect(m.perShotLatencyMsP99).toBeGreaterThan(0);
    expect(m.perShotLatencyMsMin).toBeGreaterThan(0);
    expect(m.perShotLatencyMsMin).toBeLessThanOrEqual(m.perShotLatencyMsMedian);
    expect(m.totalPipelineMs).toBeGreaterThan(0);
    expect(m.visualQualityProxy).toBeGreaterThan(0);
    expect(m.continuityAvg).toBeGreaterThan(0);
    expect(m.costPerShotUsd).toBe(0);
    expect(m.fixtureVersion).toBe("1.0.0");
    expect(m.fixtureSha256).toHaveLength(64);
  }, 120000);
});

const base: BenchmarkMetrics = {
  fixtureVersion: "1.0.0",
  fixtureSha256: "x",
  provider: "mock",
  model: "m",
  shots: 24,
  perShotLatencyMsAvg: 100,
  perShotLatencyMsMedian: 95,
  perShotLatencyMsP99: 150,
  perShotLatencyMsMin: 90,
  totalPipelineMs: 2400,
  visualQualityProxy: 0.9,
  continuityAvg: 0.8,
  costPerShotUsd: 1,
  recordedAt: "",
};

describe("deterministic regression gate (AC-002)", () => {
  test("blocks on >5% regression in any deterministic metric", () => {
    expect(compare(base, { ...base, continuityAvg: 0.75 }).pass).toBe(false);
    expect(compare(base, { ...base, visualQualityProxy: 0.8 }).pass).toBe(false);
    expect(compare(base, { ...base, costPerShotUsd: 1.06 }).pass).toBe(false);
  });

  test("blocks when the benchmark fixture itself changed", () => {
    expect(compare(base, { ...base, fixtureSha256: "y" }).pass).toBe(false);
    expect(compare(base, { ...base, shots: 12 }).pass).toBe(false);
  });

  test("passes within limits", () => {
    expect(compare(base, { ...base, continuityAvg: 0.79 }).pass).toBe(true);
  });

  test("latency against the recorded baseline host is an advisory, never a verdict", () => {
    const otherHost = { ...base, perShotLatencyMsAvg: 210, perShotLatencyMsMedian: 200, perShotLatencyMsP99: 320, perShotLatencyMsMin: 190, totalPipelineMs: 5100 };
    const slower = compareDeterministic(base, otherHost);
    expect(slower.pass).toBe(true);
    expect(slower.regressions).toEqual([]);
    expect(slower.advisories.join(" ")).toContain("perShotLatencyMsMin");
    expect(slower.advisories.join(" ")).toContain("same-host A/B");
    const faster = compareDeterministic(otherHost, base);
    expect(faster.pass).toBe(true);
    expect(faster.advisories.length).toBeGreaterThan(0);
  });
});

describe("same-host latency A/B gate (AC-002)", () => {
  test("blocks a latency regression over the limit on the same host", () => {
    const slower = { ...base, perShotLatencyMsMin: base.perShotLatencyMsMin * (1 + LATENCY_LIMIT + 0.02) };
    const blocked = compareLatency([base], [slower]);
    expect(blocked.pass).toBe(false);
    expect(blocked.regressions.join(" ")).toContain("perShotLatencyMsMin");
    const slowerPipeline = { ...base, totalPipelineMs: base.totalPipelineMs * (1 + LATENCY_LIMIT + 0.02) };
    expect(compareLatency([base], [slowerPipeline]).pass).toBe(false);
  });

  test("passes inside the limit and when the candidate is faster", () => {
    const inside = { ...base, perShotLatencyMsMin: base.perShotLatencyMsMin * (1 + LATENCY_LIMIT * 0.5) };
    expect(compareLatency([base], [inside]).pass).toBe(true);
    const faster = { ...base, perShotLatencyMsMin: 50, totalPipelineMs: 1200 };
    expect(compareLatency([base], [faster]).pass).toBe(true);
  });

  test("gates on the noise floor across rounds so one disturbed run does not decide", () => {
    const baseRuns = [{ ...base, perShotLatencyMsMin: 100 }, { ...base, perShotLatencyMsMin: 140 }];
    const candidateRuns = [{ ...base, perShotLatencyMsMin: 160 }, { ...base, perShotLatencyMsMin: 101 }];
    expect(compareLatency(baseRuns, candidateRuns).pass).toBe(true);
    const consistentlySlower = [{ ...base, perShotLatencyMsMin: 130 }, { ...base, perShotLatencyMsMin: 125 }];
    expect(compareLatency(baseRuns, consistentlySlower).pass).toBe(false);
  });

  test("reports, rather than fails, when no same-host base run exists", () => {
    const result = compareLatency([], [base]);
    expect(result.pass).toBe(true);
    expect(result.advisories.join(" ")).toContain("not gated");
  });

  test("a base run missing the gated fields is a failure, not a silent pass", () => {
    const stale = { ...base, perShotLatencyMsMin: undefined as unknown as number };
    expect(compareLatency([stale], [base]).pass).toBe(false);
  });
});

describe("base commit resolution for the A/B", () => {
  function fakeGit(answers: Record<string, string | null>): Git {
    return (args) => {
      const key = args.join(" ");
      const answer = answers[key];
      return answer == null ? { ok: false, stdout: "" } : { ok: true, stdout: answer };
    };
  }

  test("an explicit ref wins, and 'none' disables the A/B", () => {
    const git = fakeGit({ "rev-parse --verify abc123^{commit}": "abc123full" });
    expect(resolveBaseRef({ HV_BENCHMARK_BASE_REF: "abc123" }, git)).toBe("abc123full");
    expect(resolveBaseRef({ HV_BENCHMARK_BASE_REF: "none" }, git)).toBeNull();
    expect(() => resolveBaseRef({ HV_BENCHMARK_BASE_REF: "missing" }, git)).toThrow("not a commit");
  });

  test("a feature branch compares against its merge base with origin/main", () => {
    const git = fakeGit({ "rev-parse HEAD": "head", "merge-base HEAD origin/main": "mergebase" });
    expect(resolveBaseRef({}, git)).toBe("mergebase");
  });

  test("a commit on main compares against its parent", () => {
    const git = fakeGit({ "rev-parse HEAD": "head", "merge-base HEAD origin/main": "head", "rev-parse --verify HEAD~1^{commit}": "parent" });
    expect(resolveBaseRef({}, git)).toBe("parent");
  });

  test("a repository with no history to compare against yields no base", () => {
    expect(resolveBaseRef({}, fakeGit({ "rev-parse HEAD": "head" }))).toBeNull();
  });
});

describe("benchmark:compare command line", () => {
  test("runs the gate without positional arguments", () => {
    const proc = Bun.spawnSync(["bun", "scripts/benchmark/compare.ts"], {
      cwd: REPO_ROOT,
      env: { ...process.env, HV_BENCHMARK_ROUNDS: "1", HV_BENCHMARK_BASE_REF: "none" },
    });
    expect(proc.exitCode).toBe(0);
    expect(proc.stdout.toString()).toContain("benchmark within limits");
  }, 120000);

  test("still accepts explicit baseline and candidate files", () => {
    const scratch = mkdtempSync(join(tmpdir(), "hv-compare-cli-"));
    try {
      writeFileSync(join(scratch, "base.json"), JSON.stringify(base));
      writeFileSync(join(scratch, "regressed.json"), JSON.stringify({ ...base, continuityAvg: 0.5 }));
      const pass = Bun.spawnSync(["bun", "scripts/benchmark/compare.ts", join(scratch, "base.json"), join(scratch, "base.json")], { cwd: REPO_ROOT, env: { ...process.env } });
      expect(pass.exitCode).toBe(0);
      const fail = Bun.spawnSync(["bun", "scripts/benchmark/compare.ts", join(scratch, "base.json"), join(scratch, "regressed.json")], { cwd: REPO_ROOT, env: { ...process.env } });
      expect(fail.exitCode).toBe(1);
      expect(fail.stderr.toString()).toContain("continuityAvg");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  test("rejects a malformed invocation with usage instead of crashing", () => {
    const proc = Bun.spawnSync(["bun", "scripts/benchmark/compare.ts", "only-one.json"], { cwd: REPO_ROOT, env: { ...process.env } });
    expect(proc.exitCode).toBe(2);
    expect(proc.stderr.toString()).toContain("usage");
  });
});
