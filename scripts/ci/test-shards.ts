/**
 * HV-016-36: split the unit + integration suite across parallel CI jobs.
 *
 * CI used to run `bun test packages test` as one step of one job, about 3.5 hours. This script
 * finds the same test files that command runs and deals them into N shards, so N jobs can run them
 * side by side. Every file goes to exactly one shard. Each shard still runs whole files with
 * `bun test`, so no test changes what it proves.
 *
 * Usage:
 *   bun scripts/ci/test-shards.ts list <shard> <total>   print shard <shard>'s files, one per line
 *   bun scripts/ci/test-shards.ts check <total>          prove the shards cover the suite once each
 *   bun scripts/ci/test-shards.ts measure <log> <source>  print new measurements from CI job logs
 *
 * Shards are balanced by the measured seconds in `scripts/ci/test-durations.json`. A file with no
 * measurement gets DEFAULT_SECONDS. A stale or missing measurement can only change the balance,
 * never which files run.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const REPO = resolve(import.meta.dir, "..", "..");
/** The path filters CI's old single step passed to `bun test` (package.json's "test" script). */
export const SUITE_FILTERS = ["packages", "test"] as const;
/** Seconds assumed for a test file CI has not measured yet. */
export const DEFAULT_SECONDS = 10;

/**
 * Bun's default test-file names: `*.test.*`, `*_test.*`, `*.spec.*` and `*_spec.*`, with a
 * JavaScript or TypeScript extension. The `[cm]` forms are included so that a module-typed test
 * file is never silently left out of every shard.
 */
const TEST_FILE = /(?:^|\/)[^/]+(?:\.test|_test|\.spec|_spec)\.(?:[cm]?[jt]s|[jt]sx)$/;

/** The test files `bun test packages test` runs, from a list of repository paths. Sorted. */
export function discoverTestFiles(paths: readonly string[]): string[] {
  return [...new Set(paths)]
    .filter((path) => !path.split("/").includes("node_modules"))
    .filter((path) => TEST_FILE.test(path))
    .filter((path) => SUITE_FILTERS.some((filter) => path.includes(filter)))
    .sort();
}

/** The repository's tracked files. A CI checkout holds exactly these. */
export function trackedFiles(repo = REPO): string[] {
  const result = spawnSync("git", ["ls-files", "-z"], { cwd: repo, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ls-files failed: ${result.stderr}`);
  return result.stdout.split("\0").filter(Boolean);
}

export function readDurations(repo = REPO): Record<string, number> {
  const parsed = JSON.parse(readFileSync(resolve(repo, "scripts/ci/test-durations.json"), "utf8")) as { seconds?: unknown };
  const seconds = parsed.seconds;
  if (!seconds || typeof seconds !== "object" || Array.isArray(seconds)) throw new Error("test-durations.json has no `seconds` map");
  const out: Record<string, number> = {};
  for (const [path, value] of Object.entries(seconds)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new Error(`test-durations.json: bad seconds for ${path}`);
    out[path] = value;
  }
  return out;
}

export type Shard = { index: number; seconds: number; files: string[] };

export function parseTotal(value: string | undefined): number {
  const total = Number(value);
  if (!Number.isInteger(total) || total < 1 || total > 64) throw new Error(`shard total must be an integer from 1 to 64, got ${value}`);
  return total;
}

/**
 * Longest-processing-time-first: the heaviest file goes to the lightest shard, ties broken by
 * path and then by the lower shard number, so the result depends only on the set of files and
 * the measurements, never on input order.
 */
export function assignShards(files: readonly string[], seconds: Readonly<Record<string, number>>, total: number): Shard[] {
  parseTotal(String(total));
  const weight = (file: string) => seconds[file] ?? DEFAULT_SECONDS;
  const ordered = [...new Set(files)].sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : a > b ? 1 : 0));
  const shards: Shard[] = Array.from({ length: total }, (_, i) => ({ index: i + 1, seconds: 0, files: [] }));
  for (const file of ordered) {
    let lightest = shards[0]!;
    for (const shard of shards) if (shard.seconds < lightest.seconds) lightest = shard;
    lightest.files.push(file);
    lightest.seconds += weight(file);
  }
  for (const shard of shards) shard.files.sort();
  return shards;
}

/** Throws unless every suite file is in exactly one shard and no shard holds anything else. */
export function verifyPartition(suite: readonly string[], shards: readonly Shard[]): void {
  const seen = new Map<string, number>();
  for (const shard of shards) {
    for (const file of shard.files) {
      const before = seen.get(file);
      if (before !== undefined) throw new Error(`${file} is in shard ${before} and shard ${shard.index}`);
      seen.set(file, shard.index);
    }
  }
  const missing = suite.filter((file) => !seen.has(file));
  if (missing.length) throw new Error(`in no shard: ${missing.join(", ")}`);
  const extra = [...seen.keys()].filter((file) => !suite.includes(file));
  if (extra.length) throw new Error(`not in the suite: ${extra.join(", ")}`);
  if (shards.some((shard) => shard.files.length === 0)) throw new Error("a shard has no files");
}

export function planShards(total: number, repo = REPO): { suite: string[]; shards: Shard[] } {
  const suite = discoverTestFiles(trackedFiles(repo));
  if (suite.length === 0) throw new Error("no test files found");
  const shards = assignShards(suite, readDurations(repo), total);
  verifyPartition(suite, shards);
  return { suite, shards };
}

/**
 * Seconds per test file from a GitHub Actions job log of `bun test`. Bun opens a `##[group]<file>:`
 * line as each file starts; a file's time runs from its header to the next header, and the last
 * file's to the `Ran N tests across M files` line. Logs from several shards can be concatenated.
 */
export function measureLog(log: string): Record<string, number> {
  const header = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?)Z ##\[group\](\S+):\s*$/;
  const finished = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?)Z Ran \d+ tests? across \d+ files?\./;
  const at = (stamp: string) => Date.parse(stamp.slice(0, 23) + "Z") / 1000;
  const out: Record<string, number> = {};
  let open: { file: string; start: number } | null = null;
  const close = (end: number) => {
    if (open) out[open.file] = Math.round((end - open.start) * 10) / 10;
    open = null;
  };
  for (const line of log.split(/\r?\n/)) {
    const started = header.exec(line);
    if (started && TEST_FILE.test(started[2]!)) {
      close(at(started[1]!));
      open = { file: started[2]!.replace(/^\.\//, ""), start: at(started[1]!) };
      continue;
    }
    const done = finished.exec(line);
    if (done) close(at(done[1]!));
  }
  return out;
}

/** `./`-prefixed, so `bun test` reads each argument as a path rather than a name filter. */
export const asBunPath = (file: string) => `./${file}`;

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === "list" && rest.length === 2) {
    const total = parseTotal(rest[1]);
    const index = Number(rest[0]);
    if (!Number.isInteger(index) || index < 1 || index > total) throw new Error(`shard must be from 1 to ${total}, got ${rest[0]}`);
    const { shards } = planShards(total);
    for (const file of shards[index - 1]!.files) console.log(asBunPath(file));
    return 0;
  }
  if (command === "check" && rest.length === 1) {
    const { suite, shards } = planShards(parseTotal(rest[0]));
    console.log(`${suite.length} test files in ${shards.length} shards, each exactly once`);
    for (const shard of shards) console.log(`shard ${shard.index}: ${shard.files.length} files, about ${Math.round(shard.seconds / 60)} min measured`);
    return 0;
  }
  if (command === "measure" && rest.length >= 2) {
    const source = rest[rest.length - 1]!;
    const seconds: Record<string, number> = {};
    for (const path of rest.slice(0, -1)) Object.assign(seconds, measureLog(readFileSync(path, "utf8")));
    if (Object.keys(seconds).length === 0) throw new Error("no bun test-file headers found in the log");
    const sorted = Object.fromEntries(Object.entries(seconds).sort(([a], [b]) => (a < b ? -1 : 1)));
    console.log(JSON.stringify({ seconds: sorted, source }, null, 2));
    return 0;
  }
  console.error("usage: test-shards.ts list <shard> <total> | check <total> | measure <log>... <source>");
  return 2;
}

if (import.meta.main) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
