import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { BenchmarkMetrics } from "../../packages/benchmarks/src/run";

/**
 * AC-002 blocks a merge on a >5% regression in any benchmark metric. The
 * deterministic metrics (visual quality proxy, continuity, cost per shot,
 * fixture digest, shot count) reproduce on any host, so they are gated against
 * the committed baseline.
 *
 * Latency does not reproduce across hosts: the same commit measured 265 ms per
 * shot on two machines whose CPU calibration differed by 45%, so neither a raw
 * nor a calibration-normalized cross-host comparison can distinguish a code
 * regression from a different machine. The only measurement that answers "did
 * this change slow the pipeline down" is an interleaved A/B of the candidate
 * against its merge base on the same host in the same run. That is what the
 * latency gate does, at the same 5% limit, on the noise floor across rounds.
 * The latency figures in the committed baseline are a record of the host that
 * recorded them and are reported as advisories only.
 */
export const DETERMINISTIC_LIMIT = 0.05;
export const LATENCY_LIMIT = Number(process.env.HV_BENCHMARK_LATENCY_LIMIT ?? 0.05);
export const DEFAULT_ROUNDS = Number(process.env.HV_BENCHMARK_ROUNDS ?? 3);
const BENCHMARK_ENTRY = "packages/benchmarks/src/run.ts";

const LOWER_IS_BETTER: (keyof BenchmarkMetrics)[] = ["costPerShotUsd"];
const HIGHER_IS_BETTER: (keyof BenchmarkMetrics)[] = ["visualQualityProxy", "continuityAvg"];
const LATENCY_KEYS = ["perShotLatencyMsMin", "perShotLatencyMsMedian", "perShotLatencyMsAvg", "perShotLatencyMsP99", "totalPipelineMs"] as const;
const GATED_LATENCY_KEYS = ["perShotLatencyMsMin", "totalPipelineMs"] as const;

export interface CompareResult {
  pass: boolean;
  regressions: string[];
  advisories: string[];
}

function percent(delta: number): string {
  return `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}%`;
}

export function compareDeterministic(baseline: BenchmarkMetrics, candidate: BenchmarkMetrics): CompareResult {
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
      regressions.push(`${key}: ${before.toFixed(2)} -> ${after.toFixed(2)} (${percent((after - before) / before)})`);
    }
  }
  for (const key of HIGHER_IS_BETTER) {
    const before = baseline[key] as number, after = candidate[key] as number;
    if (before > 0 && (before - after) / before > DETERMINISTIC_LIMIT) {
      regressions.push(`${key}: ${before.toFixed(3)} -> ${after.toFixed(3)} (-${(((before - after) / before) * 100).toFixed(1)}%)`);
    }
  }

  for (const key of LATENCY_KEYS) {
    const before = baseline[key], after = candidate[key];
    if (typeof before !== "number" || typeof after !== "number" || before <= 0) continue;
    const delta = (after - before) / before;
    if (Math.abs(delta) > DETERMINISTIC_LIMIT) {
      advisories.push(`${key}: ${before.toFixed(2)} -> ${after.toFixed(2)} (${percent(delta)} vs the recorded baseline host; latency is gated by the same-host A/B, not here)`);
    }
  }

  return { pass: regressions.length === 0, regressions, advisories };
}

export const compare = compareDeterministic;

function floor(runs: BenchmarkMetrics[], key: (typeof GATED_LATENCY_KEYS)[number]): number {
  return Math.min(...runs.map((run) => run[key]));
}

export function compareLatency(baseRuns: BenchmarkMetrics[], candidateRuns: BenchmarkMetrics[], limit = LATENCY_LIMIT): CompareResult {
  const regressions: string[] = [];
  const advisories: string[] = [];
  if (baseRuns.length === 0 || candidateRuns.length === 0) {
    return { pass: true, regressions, advisories: ["no same-host base runs available; latency was not gated"] };
  }
  for (const key of GATED_LATENCY_KEYS) {
    const before = floor(baseRuns, key), after = floor(candidateRuns, key);
    if (!(before > 0) || !Number.isFinite(after)) {
      regressions.push(`${key} is missing from the A/B runs`);
      continue;
    }
    const delta = (after - before) / before;
    const line = `${key} (same-host floor of ${baseRuns.length}x${candidateRuns.length} rounds): base ${before.toFixed(2)} -> candidate ${after.toFixed(2)} (${percent(delta)}, limit ${(limit * 100).toFixed(0)}%)`;
    if (delta > limit) regressions.push(line);
    else advisories.push(line);
  }
  return { pass: regressions.length === 0, regressions, advisories };
}

export type Git = (args: string[], cwd?: string) => { ok: boolean; stdout: string };

export function gitCommand(args: string[], cwd = process.cwd()): { ok: boolean; stdout: string } {
  const proc = Bun.spawnSync(["git", ...args], { cwd, env: { ...process.env } });
  return { ok: proc.exitCode === 0, stdout: proc.stdout.toString().trim() };
}

/**
 * The A/B base is, in order: an explicit HV_BENCHMARK_BASE_REF ("none" skips
 * the A/B), the merge base with origin/main, or the parent commit when HEAD is
 * already on main. Returns null when no usable base commit exists.
 */
export function resolveBaseRef(env: Record<string, string | undefined>, git: Git): string | null {
  const explicit = env.HV_BENCHMARK_BASE_REF?.trim();
  if (explicit === "none") return null;
  if (explicit) {
    const commit = git(["rev-parse", "--verify", `${explicit}^{commit}`]);
    if (!commit.ok) throw new Error(`HV_BENCHMARK_BASE_REF ${explicit} is not a commit`);
    return commit.stdout;
  }
  const head = git(["rev-parse", "HEAD"]);
  if (!head.ok) return null;
  for (const mainRef of ["origin/main", "main"]) {
    const base = git(["merge-base", "HEAD", mainRef]);
    if (!base.ok) continue;
    if (base.stdout !== head.stdout) return base.stdout;
    const parent = git(["rev-parse", "--verify", "HEAD~1^{commit}"]);
    return parent.ok ? parent.stdout : null;
  }
  const parent = git(["rev-parse", "--verify", "HEAD~1^{commit}"]);
  return parent.ok ? parent.stdout : null;
}

function runBenchmarkIn(cwd: string, outPath: string): BenchmarkMetrics {
  const proc = Bun.spawnSync(["bun", BENCHMARK_ENTRY, outPath], { cwd, env: { ...process.env } });
  if (proc.exitCode !== 0) throw new Error(`benchmark failed in ${cwd}: ${proc.stderr.toString().slice(-600)}`);
  return JSON.parse(readFileSync(outPath, "utf8")) as BenchmarkMetrics;
}

export interface GateReport {
  deterministic: CompareResult;
  latency: CompareResult;
  baseRef: string | null;
  candidate: BenchmarkMetrics;
  pass: boolean;
}

/**
 * Runs the full gate for the working tree: the deterministic comparison against
 * the committed baseline, then the interleaved same-host latency A/B against the
 * merge base. The base commit is checked out into a temporary worktree; if it
 * predates the benchmark harness there is nothing to compare and latency is not
 * gated.
 */
export async function runGate(options: {
  repoRoot?: string;
  baselinePath?: string;
  rounds?: number;
  env?: Record<string, string | undefined>;
  git?: Git;
  log?: (line: string) => void;
} = {}): Promise<GateReport> {
  const repoRoot = resolve(options.repoRoot ?? process.cwd());
  const baselinePath = options.baselinePath ?? join(repoRoot, "packages/benchmarks/baseline.json");
  const rounds = Math.max(1, options.rounds ?? DEFAULT_ROUNDS);
  const env = options.env ?? process.env;
  const git: Git = options.git ?? ((args, cwd) => gitCommand(args, cwd ?? repoRoot));
  const log = options.log ?? (() => {});
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8")) as BenchmarkMetrics;

  const scratch = mkdtempSync(join(tmpdir(), "hv-benchmark-gate-"));
  const candidateRuns: BenchmarkMetrics[] = [];
  const baseRuns: BenchmarkMetrics[] = [];
  let baseRef: string | null = null;
  let baseTree: string | null = null;
  try {
    baseRef = resolveBaseRef(env, git);
    if (baseRef) {
      baseTree = join(scratch, "base");
      const added = git(["worktree", "add", "--detach", baseTree, baseRef]);
      if (!added.ok) throw new Error(`could not check out base commit ${baseRef} for the latency A/B`);
      if (!existsSync(join(baseTree, BENCHMARK_ENTRY))) {
        log(`base ${baseRef.slice(0, 8)} predates the benchmark harness; latency A/B skipped`);
        baseTree = null;
      }
    }

    for (let round = 1; round <= rounds; round += 1) {
      log(`round ${round}/${rounds}: candidate`);
      candidateRuns.push(runBenchmarkIn(repoRoot, join(scratch, `candidate-${round}.json`)));
      if (baseTree) {
        log(`round ${round}/${rounds}: base ${baseRef!.slice(0, 8)}`);
        baseRuns.push(runBenchmarkIn(baseTree, join(scratch, `base-${round}.json`)));
      }
    }
  } finally {
    if (baseTree) git(["worktree", "remove", "--force", baseTree]);
    rmSync(scratch, { recursive: true, force: true });
  }

  const candidate = candidateRuns[0]!;
  const deterministic = compareDeterministic(baseline, candidate);
  const latency = compareLatency(baseRuns, candidateRuns);
  return { deterministic, latency, baseRef, candidate, pass: deterministic.pass && latency.pass };
}

function report(label: string, result: CompareResult): void {
  for (const line of result.advisories) console.log(`advisory (${label}): ${line}`);
  for (const line of result.regressions) console.error(`REGRESSION (${label}): ${line}`);
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length === 2) {
    const baseline = JSON.parse(readFileSync(args[0]!, "utf8")) as BenchmarkMetrics;
    const candidate = JSON.parse(readFileSync(args[1]!, "utf8")) as BenchmarkMetrics;
    const result = compareDeterministic(baseline, candidate);
    report("deterministic", result);
    if (!result.pass) {
      console.error("BENCHMARK REGRESSION — blocking merge");
      process.exit(1);
    }
    console.log(`benchmark within limits (deterministic ${(DETERMINISTIC_LIMIT * 100).toFixed(0)}%); run without arguments for the same-host latency A/B`);
  } else if (args.length === 0) {
    const gate = await runGate({ log: (line) => console.log(line) });
    report("deterministic", gate.deterministic);
    report("latency", gate.latency);
    if (!gate.pass) {
      console.error("BENCHMARK REGRESSION — blocking merge");
      process.exit(1);
    }
    console.log(
      `benchmark within limits (deterministic ${(DETERMINISTIC_LIMIT * 100).toFixed(0)}%, `
      + `same-host latency ${(LATENCY_LIMIT * 100).toFixed(0)}%`
      + `${gate.baseRef ? ` against ${gate.baseRef.slice(0, 8)}` : ""})`,
    );
  } else {
    console.error("usage: bun scripts/benchmark/compare.ts            # gate the working tree against the baseline and its merge base");
    console.error("       bun scripts/benchmark/compare.ts <baseline.json> <candidate.json>");
    process.exit(2);
  }
}
