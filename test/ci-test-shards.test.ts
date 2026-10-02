import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  DEFAULT_SECONDS,
  REPO,
  assignShards,
  discoverTestFiles,
  measureLog,
  planShards,
  readDurations,
  trackedFiles,
  verifyPartition,
} from "../scripts/ci/test-shards";

/**
 * HV-016-36: the unit + integration suite runs as parallel shards. These tests hold the two things
 * that make that safe: every test file runs in exactly one shard, and the CI workflow runs every
 * shard it plans.
 */
const SHARDS = 4;
const SCRIPT = resolve(REPO, "scripts/ci/test-shards.ts");
const run = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { cwd: REPO, encoding: "utf8" });

type Step = { name?: string; run?: string; uses?: string; with?: Record<string, unknown> };
type Job = { name?: string; needs?: string | string[]; services?: Record<string, unknown>; env?: Record<string, string>; steps: Step[]; strategy?: { matrix?: { shard?: unknown } } };
const workflow = Bun.YAML.parse(readFileSync(resolve(REPO, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, Job> };
const jobs = workflow.jobs;
const runs = (job: Job) => job.steps.map((step) => step.run ?? "").join("\n");

describe("which files the suite holds", () => {
  test("finds bun's test-file names and nothing else", () => {
    const found = discoverTestFiles([
      "packages/a/test/one.test.ts",
      "packages/a/test/two_test.js",
      "packages/a/test/three.spec.tsx",
      "packages/a/test/four_spec.mjs",
      "test/five.test.cts",
      "packages/a/test/helpers.ts",
      "packages/a/test/fixtures/data.test.json",
      "packages/a/test/one.test.ts.snap",
      "packages/a/node_modules/dep/x.test.ts",
      "node_modules/dep/y.test.js",
      "scripts/z.spec.ts",
      "packages/a/test/one.test.ts",
    ]);
    // `scripts/z.spec.ts` contains neither "packages" nor "test", so `bun test packages test` never ran it.
    expect(found).toEqual([
      "packages/a/test/four_spec.mjs",
      "packages/a/test/one.test.ts",
      "packages/a/test/three.spec.tsx",
      "packages/a/test/two_test.js",
      "test/five.test.cts",
    ]);
  });

  test("the repository's suite includes this file, and every measured file still exists", () => {
    const suite = discoverTestFiles(trackedFiles());
    expect(suite).toContain("test/ci-test-shards.test.ts");
    expect(suite).toContain("packages/storage/test/current-film-mixed-worker.test.ts");
    expect(suite.length).toBeGreaterThan(500);
    // A measurement for a file that is gone is harmless to coverage, but it means the table is stale.
    const stale = Object.keys(readDurations()).filter((file) => !suite.includes(file));
    expect(stale).toEqual([]);
  });
});

describe("dealing files into shards", () => {
  const seconds = { "a.test.ts": 100, "b.test.ts": 60, "c.test.ts": 50, "d.test.ts": 40, "e.test.ts": 5 };
  const files = Object.keys(seconds);

  test("each file lands in exactly one shard, for every shard count", () => {
    for (let total = 1; total <= 6; total++) {
      const shards = assignShards(files, seconds, total);
      expect(shards.map((shard) => shard.index)).toEqual(Array.from({ length: total }, (_, i) => i + 1));
      expect(shards.flatMap((shard) => shard.files).sort()).toEqual([...files].sort());
    }
  });

  test("heaviest first, into the lightest shard", () => {
    const shards = assignShards(files, seconds, 2);
    expect(shards.map((shard) => [shard.files, shard.seconds])).toEqual([
      [["a.test.ts", "d.test.ts"], 140],
      [["b.test.ts", "c.test.ts", "e.test.ts"], 115],
    ]);
  });

  test("an unmeasured file counts as the default, and order of input does not matter", () => {
    const withNew = [...files, "new.test.ts"];
    const forward = assignShards(withNew, seconds, 3);
    const backward = assignShards([...withNew].reverse(), seconds, 3);
    expect(backward).toEqual(forward);
    const home = forward.find((shard) => shard.files.includes("new.test.ts"))!;
    expect(home.seconds).toBe(home.files.reduce((sum, file) => sum + ((seconds as Record<string, number>)[file] ?? DEFAULT_SECONDS), 0));
  });

  test("a bad shard count is refused", () => {
    for (const total of [0, -1, 1.5, 65, Number.NaN]) expect(() => assignShards(files, seconds, total)).toThrow(/shard total/);
  });

  test("the partition check catches a lost, doubled, foreign or empty shard", () => {
    const suite = ["a", "b", "c"];
    expect(() => verifyPartition(suite, [{ index: 1, seconds: 0, files: ["a", "b"] }, { index: 2, seconds: 0, files: ["c"] }])).not.toThrow();
    expect(() => verifyPartition(suite, [{ index: 1, seconds: 0, files: ["a"] }, { index: 2, seconds: 0, files: ["c"] }])).toThrow("in no shard: b");
    expect(() => verifyPartition(suite, [{ index: 1, seconds: 0, files: ["a", "b"] }, { index: 2, seconds: 0, files: ["b", "c"] }])).toThrow("b is in shard 1 and shard 2");
    expect(() => verifyPartition(suite, [{ index: 1, seconds: 0, files: ["a", "b", "c", "z"] }, { index: 2, seconds: 0, files: [] }])).toThrow("not in the suite: z");
    expect(() => verifyPartition(suite, [{ index: 1, seconds: 0, files: ["a", "b", "c"] }, { index: 2, seconds: 0, files: [] }])).toThrow("a shard has no files");
  });

  test(`the real suite in ${SHARDS} shards: the longest file runs alone and no shard outlasts it`, () => {
    const { suite, shards } = planShards(SHARDS);
    const durations = readDurations();
    const heaviest = suite.reduce((a, b) => ((durations[a] ?? 0) >= (durations[b] ?? 0) ? a : b));
    expect(shards[0]!.files).toEqual([heaviest]);
    for (const shard of shards.slice(1)) expect(shard.seconds).toBeLessThan(shards[0]!.seconds);
  });
});

describe("the command line", () => {
  test("list prints ./ paths that together are the suite, once each", () => {
    const listed: string[] = [];
    for (let shard = 1; shard <= SHARDS; shard++) {
      const result = run("list", String(shard), String(SHARDS));
      expect(result.status).toBe(0);
      const lines = result.stdout.trim().split("\n");
      for (const line of lines) expect(line.startsWith("./")).toBe(true);
      listed.push(...lines.map((line) => line.slice(2)));
    }
    expect(listed.sort()).toEqual(discoverTestFiles(trackedFiles()));
  });

  test("check passes and reports each shard; bad arguments fail", () => {
    const ok = run("check", String(SHARDS));
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain(`in ${SHARDS} shards, each exactly once`);
    expect(run("list", "0", "4").status).toBe(1);
    expect(run("list", "5", "4").status).toBe(1);
    expect(run("check", "0").status).toBe(1);
    expect(run("shuffle").status).toBe(2);
  });
});

describe("measuring a CI log", () => {
  test("each file runs from its header to the next, the last to the summary; other groups are ignored", () => {
    const log = [
      "2026-10-01T23:55:59.0000000Z ##[group]Run bun test",
      "2026-10-01T23:56:01.1524030Z ##[group]test/a.test.ts:",
      "2026-10-01T23:56:01.2000000Z (pass) a [1.00ms]",
      "2026-10-01T23:56:11.1524030Z ##[group]./packages/x/test/b.test.js:",
      "2026-10-01T23:58:11.2000000Z ##[group]not-a-test-file.ts:",
      "2026-10-01T23:58:11.2524030Z  3 pass",
      "2026-10-01T23:58:11.2524030Z Ran 3 tests across 2 files. [130.10s]",
      "2026-10-01T23:59:00.0000000Z ##[group]test/after-summary.test.ts:",
    ].join("\n");
    expect(measureLog(log)).toEqual({ "test/a.test.ts": 10, "packages/x/test/b.test.js": 120.1 });
  });

  test("measure writes the table's shape, and refuses a log with no test files", () => {
    const dir = mkdtempSync(join(tmpdir(), "hv-shards-"));
    const good = join(dir, "good.log"), bad = join(dir, "bad.log");
    writeFileSync(good, "2026-10-01T00:00:00Z ##[group]test/a.test.ts:\n2026-10-01T00:00:05Z Ran 1 test across 1 file. [5s]\n");
    writeFileSync(bad, "nothing here\n");
    const ok = run("measure", good, "run 1");
    expect(ok.status).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual({ seconds: { "test/a.test.ts": 5 }, source: "run 1" });
    expect(run("measure", bad, "run 1").status).toBe(1);
  });
});

describe("the CI workflow runs what is planned", () => {
  const tests = jobs.tests!;
  const quality = jobs.quality!;

  test(`the tests job is a matrix of shards 1 to ${SHARDS}, each running its own list`, () => {
    expect(tests.strategy?.matrix?.shard).toEqual(Array.from({ length: SHARDS }, (_, i) => i + 1));
    expect(tests.name).toBe(`tests (\${{ matrix.shard }}/${SHARDS})`);
    expect(runs(tests)).toContain(`bun scripts/ci/test-shards.ts list \${{ matrix.shard }} ${SHARDS}`);
    expect(runs(tests)).toContain('bun test "${files[@]}"');
  });

  test("quality proves the same shard count covers the suite, and no longer runs the suite itself", () => {
    expect(runs(quality)).toContain(`bun scripts/ci/test-shards.ts check ${SHARDS}`);
    for (const job of Object.values(jobs)) expect(runs(job)).not.toContain("bun test packages test");
  });

  test("each shard has the services, settings and setup the single step had", () => {
    expect(tests.services).toEqual(quality.services);
    expect(tests.env).toEqual(quality.env);
    const setup = ["bun install --frozen-lockfile", "bun scripts/storage-ci-roles.ts", "scripts/prepare-object-bucket.py", "ffmpeg espeak-ng fonts-dejavu-core"];
    for (const command of setup) expect(runs(tests)).toContain(command);
    const checkout = tests.steps.find((step) => step.uses === "actions/checkout@v4");
    expect(checkout?.with?.["fetch-depth"]).toBe(0);
  });

  test("a package-mirror stall is bounded and retried wherever ffmpeg is installed", () => {
    for (const name of ["quality", "tests", "benchmark-gate"]) {
      const step = jobs[name]!.steps.find((s) => s.name === "install ffmpeg");
      expect(step?.run).toContain("timeout 300 sudo apt-get update");
      expect(step?.run).toContain("for attempt in 1 2 3");
    }
  });
});
