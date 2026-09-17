/**
 * HV-037-01. Two defects in the merge gate, both of them about a rule that
 * lives in more than one place, or in no place at all.
 *
 * 1. **`compareDeterministic`'s cost gate could never fire.** It guarded the
 *    lower-is-better comparison with `before > 0`, and `runBenchmark`
 *    constructs `new DeterministicMockProvider({ costPerShotUsd: 0.0 })`, so
 *    the committed baseline records `0`. FULL-SCOPE §8 asks for "cost variance
 *    (≤ 5 % or $0.05)" — the absolute half is exactly what makes such a gate
 *    work from a zero baseline, and it was not implemented. (The animatic
 *    benchmark's own exact-compare of `costUsd` could fire, so this is a claim
 *    about `compareDeterministic`, not about the program.)
 *
 * 2. **Two records were closed sets in their own files, gated by hand-written
 *    key lists elsewhere, with nothing linking them.** `compare.ts` had four
 *    such arrays naming eight of `BenchmarkMetrics`'s fourteen fields;
 *    `animatic.ts` had one naming six of its seven. Nothing checked either for
 *    coverage, so a field added to either record shipped **silently ungated** —
 *    and every remaining §8 metric is a field added to one of them.
 *
 * Three rules govern this file, each a correction to an earlier draft:
 *
 * - **Thresholds are literals here**, never read from the table.
 * - **The records come from the real runs and the committed baselines**, not
 *   from the local fixture. An earlier draft compared the fixture's keys to the
 *   real record's and called that evidence about the baseline; it was a fixture
 *   testing itself.
 * - **The derivation is checked at the source**, because equality cannot
 *   distinguish a derived array from a literal that happens to agree. An
 *   earlier draft claimed a perturbation proved the link; it only proved that a
 *   literal which *disagreed* failed.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ANIMATIC_FIELDS } from "../src/animatic";
import { BENCHMARK_FIELDS, benchmarkFieldsOf, runBenchmark, type BenchmarkMetrics } from "../src/run";
import { compareDeterministic, compareLatency, latencyLimitOverride, limitFromEnv, roundsFromEnv } from "../../../scripts/benchmark/compare";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const read = (relative: string) => readFileSync(join(REPO_ROOT, relative), "utf8");

const record = (over: Partial<BenchmarkMetrics> = {}): BenchmarkMetrics => ({
  fixtureVersion: "1.0.0", fixtureSha256: "a".repeat(64), provider: "mock", model: "mock-deterministic-v1",
  shots: 24, perShotLatencyMsAvg: 264, perShotLatencyMsMedian: 264, perShotLatencyMsP99: 276,
  perShotLatencyMsMin: 257, totalPipelineMs: 6359, visualQualityProxy: 1, continuityAvg: 0.52,
  costPerShotUsd: 0, recordedAt: "2026-09-01T19:18:08.349Z", ...over,
});

test("every recorded field of both benchmarks is classified, and nothing is classified that is not recorded", async () => {
  // From the real run, not from the fixture above: a field added to the
  // interface and written by `runBenchmark` cannot escape by the fixture simply
  // not mentioning it.
  const recorded = await runBenchmark(`/tmp/hv-bench-classification-${Date.now()}`);
  const fields = Object.keys(recorded).sort();
  expect(Object.keys(BENCHMARK_FIELDS).sort()).toEqual(fields);
  // And from the committed baseline, read from disk, because that is the other
  // record the gate reads. An earlier draft compared the local fixture here.
  expect(Object.keys(JSON.parse(read("packages/benchmarks/baseline.json")) as object).sort()).toEqual(fields);
  // The fixture in this file has to match too, or tests 2-4 are testing a shape
  // the gate never sees.
  expect(Object.keys(record()).sort()).toEqual(fields);

  // The whole table, pinned with literals: `kind`, every limit and every floor.
  // An earlier draft pinned only `kind` plus two rules, so a limit could be
  // widened from 0.05 to 0.5 with every assertion still passing.
  expect(BENCHMARK_FIELDS).toEqual({
    fixtureVersion: { kind: "exact" },
    fixtureSha256: { kind: "exact" },
    shots: { kind: "exact" },
    provider: { kind: "exact" },
    model: { kind: "exact" },
    recordedAt: { kind: "note" },
    costPerShotUsd: { kind: "lower", limit: 0.05, floor: 0.05 },
    visualQualityProxy: { kind: "higher", limit: 0.05, floor: 0.05 },
    continuityAvg: { kind: "higher", limit: 0.05, floor: 0.05 },
    perShotLatencyMsMin: { kind: "latency-ab", limit: 0.05 },
    totalPipelineMs: { kind: "latency-ab", limit: 0.05 },
    perShotLatencyMsAvg: { kind: "latency-note" },
    perShotLatencyMsMedian: { kind: "latency-note" },
    perShotLatencyMsP99: { kind: "latency-note" },
  });

  // `note` cannot be used to hide a metric. Every ungated field is a string in
  // the real record, so a new *number* has to be classified as something the
  // gate acts on. Without this the escape hatch is one word wide.
  for (const field of benchmarkFieldsOf("note")) {
    expect({ field, type: typeof recorded[field as keyof BenchmarkMetrics] }).toEqual({ field, type: "string" });
  }

  // The animatic benchmark's record is the same shape of closed set, and its
  // gate compares the `exact` fields of its own table. Its baseline carries
  // exactly those and not the wall-clock one.
  // Read from the interface in the source rather than from a list written here:
  // a list in this file is a third copy, and a field added to the record and to
  // the interface would pass a comparison against it. Running the animatic
  // benchmark for real needs ffprobe and 24 renders, which the CI job
  // `benchmark:animatic` already does; the interface is the closed set that
  // record is typed against.
  const declaredFields = (source: string, name: string): string[] => {
    const block = new RegExp(`export interface ${name}\\s*\\{([^}]*)\\}`).exec(source);
    if (!block) throw new Error(`interface ${name} not found`);
    return [...block[1]!.matchAll(/^\s*([A-Za-z][A-Za-z0-9]*)\??\s*:/gm)].map(match => match[1]!).sort();
  };
  expect(Object.keys(ANIMATIC_FIELDS).sort()).toEqual(declaredFields(read("packages/benchmarks/src/animatic.ts"), "AnimaticMetrics"));
  // And the same check on this benchmark's interface, which the real run above
  // also covers -- two independent readings of one closed set.
  expect(Object.keys(BENCHMARK_FIELDS).sort()).toEqual(declaredFields(read("packages/benchmarks/src/run.ts"), "BenchmarkMetrics"));
  expect(declaredFields(read("packages/benchmarks/src/animatic.ts"), "AnimaticMetrics").length).toBe(7);
  expect(Object.keys(JSON.parse(read("packages/benchmarks/animatic-baseline.json")) as object).sort())
    .toEqual(benchmarkFieldsOf("exact", ANIMATIC_FIELDS).sort());
  expect(ANIMATIC_FIELDS.latencyMs).toEqual({ kind: "latency-note" });
}, 180_000);

test("the gate derives its field lists from the table, at the source", () => {
  // Equality between a derived array and the table cannot tell derivation from
  // a literal that agrees today, so this reads the file. After the change no
  // metric field name appears as a string literal in the comparator at all:
  // every list comes from `benchmarkFieldsOf`, and every message interpolates
  // the key it is iterating.
  const comparator = read("scripts/benchmark/compare.ts");
  const named = Object.keys(BENCHMARK_FIELDS).filter(field => new RegExp(`["'\`]${field}["'\`]`).test(comparator));
  expect(named).toEqual([]);
  expect(/benchmarkFieldsOf\(/.test(comparator)).toBe(true);
  // The animatic gate too: its key list is derived, not written out.
  const animatic = read("packages/benchmarks/src/animatic.ts");
  const animaticList = /for \(const key of \[/.test(animatic);
  expect({ animaticHandWrittenList: animaticList }).toEqual({ animaticHandWrittenList: false });
  expect(/benchmarkFieldsOf\("exact", ANIMATIC_FIELDS\)/.test(animatic)).toBe(true);
  // And the fixture path is resolved rather than percent-encoded, which is why
  // a checkout under a path containing a space used to fail.
  const runner = read("packages/benchmarks/src/run.ts");
  expect(/new URL\([^)]*\)\.pathname/.test(runner)).toBe(false);
  expect(/fileURLToPath\(/.test(runner)).toBe(true);
  // The package's declared entry point exists.
  const manifest = JSON.parse(read("packages/benchmarks/package.json")) as { main: string };
  expect(() => read(join("packages/benchmarks", manifest.main))).not.toThrow();
});

test("the cost gate fires from a zero baseline, which is the only baseline there is", () => {
  const baseline = record({ costPerShotUsd: 0 });
  expect(compareDeterministic(baseline, record({ costPerShotUsd: 0.051 })).regressions)
    .toEqual(["costPerShotUsd: 0.0000 -> 0.0510, over the allowed 0.0500 (max of 5% and 0.05)"]);
  expect(compareDeterministic(baseline, record({ costPerShotUsd: 12 })).pass).toBe(false);
  // At or below the floor is allowed, which is what "≤ $0.05" means.
  expect(compareDeterministic(baseline, record({ costPerShotUsd: 0.05 })).pass).toBe(true);
  expect(compareDeterministic(baseline, record({ costPerShotUsd: 0 })).pass).toBe(true);
  // Above the floor the proportional limit takes over, so a real paid baseline
  // is not held to five cents for ever.
  const paid = record({ costPerShotUsd: 4 });
  expect(compareDeterministic(paid, record({ costPerShotUsd: 4.19 })).pass).toBe(true);
  expect(compareDeterministic(paid, record({ costPerShotUsd: 4.21 })).pass).toBe(false);
  expect(compareDeterministic(paid, record({ costPerShotUsd: 0 })).pass).toBe(true);

  // The same allowance, in the other direction, with the same absolute floor:
  // the `before > 0` guard that made the cost gate inert is gone from both
  // sides rather than one.
  const quality = record({ visualQualityProxy: 1 });
  expect(compareDeterministic(quality, record({ visualQualityProxy: 0.96 })).pass).toBe(true);
  expect(compareDeterministic(quality, record({ visualQualityProxy: 0.94 })).pass).toBe(false);
  expect(compareDeterministic(record({ visualQualityProxy: 0 }), record({ visualQualityProxy: 0 })).pass).toBe(true);
});

test("an exact field that changes is a regression, and a missing number is not silence", () => {
  const baseline = record();
  for (const field of benchmarkFieldsOf("exact")) {
    const changed = compareDeterministic(baseline, record({ [field]: field === "shots" ? 25 : "different" } as Partial<BenchmarkMetrics>));
    expect({ field, pass: changed.pass }).toEqual({ field, pass: false });
    expect(changed.regressions.join(" ")).toContain(`${String(field)} changed`);
  }
  // `provider` and `model` are in that set now, which they were not: a
  // candidate that swapped the mock provider used to pass in silence.
  expect(benchmarkFieldsOf("exact")).toContain("provider");
  expect(benchmarkFieldsOf("exact")).toContain("model");

  for (const field of [...benchmarkFieldsOf("lower"), ...benchmarkFieldsOf("higher")]) {
    const broken = compareDeterministic(baseline, record({ [field]: undefined } as Partial<BenchmarkMetrics>));
    expect({ field, pass: broken.pass }).toEqual({ field, pass: false });
    expect(broken.regressions.join(" ")).toContain(`${String(field)} is missing or not a number`);
  }
});

test("each gated latency field is held to its own table limit, and an override replaces every one", () => {
  const base = [record({ perShotLatencyMsMin: 100, totalPipelineMs: 1000 })];
  // No override: the table's 5% applies per field. An explicit `undefined` is
  // passed so an operator's ambient HV_BENCHMARK_LATENCY_LIMIT cannot make this
  // assertion about the default into an assertion about their shell.
  expect(compareLatency(base, [record({ perShotLatencyMsMin: 104, totalPipelineMs: 1000 })], undefined).pass).toBe(true);
  expect(compareLatency(base, [record({ perShotLatencyMsMin: 106, totalPipelineMs: 1000 })], undefined).pass).toBe(false);
  expect(compareLatency(base, [record({ perShotLatencyMsMin: 100, totalPipelineMs: 1060 })], undefined).pass).toBe(false);
  // An override replaces the table's limit for every gated field, and the
  // message says which limit was applied, so a loosened gate is legible.
  const loosened = compareLatency(base, [record({ perShotLatencyMsMin: 130, totalPipelineMs: 1000 })], 0.35);
  expect(loosened.pass).toBe(true);
  expect(loosened.advisories.join(" ")).toContain("limit 35%");
  expect(compareLatency(base, [record({ perShotLatencyMsMin: 140, totalPipelineMs: 1000 })], 0.35).pass).toBe(false);
  // The table's limit is what the default resolves to, which is the claim the
  // single-override signature rests on.
  expect(benchmarkFieldsOf("latency-ab").map(field => (BENCHMARK_FIELDS[field] as { limit: number }).limit)).toEqual([0.05, 0.05]);
});

test("a malformed limit or round count refuses the gate instead of disabling it", () => {
  // `Number("loose")` is NaN and `delta > NaN` is false, so a typo in this
  // override used to turn a merge gate off with no message at all.
  for (const bad of ["loose", "NaN", "-0.1", "2", "5%", "Infinity"]) {
    expect(() => limitFromEnv("HV_BENCHMARK_LATENCY_LIMIT", 0.05, { HV_BENCHMARK_LATENCY_LIMIT: bad }))
      .toThrow(/HV_BENCHMARK_LATENCY_LIMIT must be a fraction between 0 and 1/);
    // And through the accessor the gate actually calls, not only the parser.
    expect(() => latencyLimitOverride({ HV_BENCHMARK_LATENCY_LIMIT: bad }))
      .toThrow(/HV_BENCHMARK_LATENCY_LIMIT must be a fraction between 0 and 1/);
  }
  for (const bad of ["loose", "0", "-1", "2.5", "NaN"]) {
    expect(() => roundsFromEnv(3, { HV_BENCHMARK_ROUNDS: bad })).toThrow(/HV_BENCHMARK_ROUNDS must be a positive integer/);
  }
  // Absent, blank and valid values still work, so refusing a malformed value
  // has not made either variable mandatory -- and an absent override is
  // `undefined`, which is what lets each field keep its own limit.
  expect(latencyLimitOverride({})).toBeUndefined();
  expect(latencyLimitOverride({ HV_BENCHMARK_LATENCY_LIMIT: "  " })).toBeUndefined();
  expect(latencyLimitOverride({ HV_BENCHMARK_LATENCY_LIMIT: "0.35" })).toBe(0.35);
  expect(roundsFromEnv(3, {})).toBe(3);
  expect(roundsFromEnv(3, { HV_BENCHMARK_ROUNDS: "7" })).toBe(7);
});
