/**
 * HV-037-01. Two defects in the merge gate, both of them about a rule that
 * lives in more than one place, or in no place at all.
 *
 * 1. **The cost gate could never fire.** `compareDeterministic` guarded the
 *    lower-is-better comparison with `before > 0`, and `runBenchmark`
 *    constructs `new DeterministicMockProvider({ costPerShotUsd: 0.0 })`. So
 *    the only cost check in the program was inert on the only record it ever
 *    reads. FULL-SCOPE §8 asks for "cost variance (≤ 5 % or $0.05)" — the
 *    absolute half is exactly what makes a gate work from a zero baseline, and
 *    it was not implemented.
 *
 * 2. **`BenchmarkMetrics` was a closed set in one file gated by three
 *    hand-written arrays in another, with nothing linking them.** Every
 *    remaining §8 metric — identity similarity, palette match, composition,
 *    caption alignment, loudness compliance, QC pass rate, provider success
 *    rate — is a field added to that interface, and each one would have
 *    shipped silently ungated. This suite is the link.
 *
 * The thresholds below are literals here, not read from the table, so the test
 * cannot pass by agreeing with whatever the table currently says.
 */
import { expect, test } from "bun:test";
import { BENCHMARK_FIELDS, benchmarkFieldsOf, runBenchmark, type BenchmarkMetrics } from "../src/run";
import { DETERMINISTIC_LIMIT, compareDeterministic, compareLatency, limitFromEnv, roundsFromEnv } from "../../../scripts/benchmark/compare";

const record = (over: Partial<BenchmarkMetrics> = {}): BenchmarkMetrics => ({
  fixtureVersion: "1.0.0", fixtureSha256: "a".repeat(64), provider: "mock", model: "mock-deterministic-v1",
  shots: 24, perShotLatencyMsAvg: 264, perShotLatencyMsMedian: 264, perShotLatencyMsP99: 276,
  perShotLatencyMsMin: 257, totalPipelineMs: 6359, visualQualityProxy: 1, continuityAvg: 0.52,
  costPerShotUsd: 0, recordedAt: "2026-09-01T19:18:08.349Z", ...over,
});

test("every recorded benchmark field is classified, and every classification is a recorded field", async () => {
  // The recorded record is produced by the real run, not by the fixture above,
  // so a field added to the interface and written by `runBenchmark` cannot
  // escape by the fixture simply not mentioning it.
  const recorded = await runBenchmark(`/tmp/hv-bench-classification-${Date.now()}`);
  const fields = Object.keys(recorded).sort();
  expect(Object.keys(BENCHMARK_FIELDS).sort()).toEqual(fields);
  // And the committed baseline is the same shape, since that is the other
  // record the gate reads.
  expect(Object.keys(record()).sort()).toEqual(fields);

  // The classification of every field, pinned. Adding a metric means adding a
  // line here as well as to the table, which is the point: an unclassified
  // field is a field nothing gates.
  expect(Object.fromEntries(Object.entries(BENCHMARK_FIELDS).map(([field, rule]) => [field, rule.kind])))
    .toEqual({
      fixtureVersion: "exact", fixtureSha256: "exact", shots: "exact",
      provider: "note", model: "note", recordedAt: "note",
      costPerShotUsd: "lower",
      visualQualityProxy: "higher", continuityAvg: "higher",
      perShotLatencyMsMin: "latency-ab", totalPipelineMs: "latency-ab",
      perShotLatencyMsAvg: "latency-note", perShotLatencyMsMedian: "latency-note", perShotLatencyMsP99: "latency-note",
    });

  // Literal thresholds, and the §8 absolute floor named rather than implied.
  expect(BENCHMARK_FIELDS.costPerShotUsd).toEqual({ kind: "lower", limit: 0.05, floor: 0.05 });
  expect(BENCHMARK_FIELDS.visualQualityProxy).toEqual({ kind: "higher", limit: 0.05 });
  // `compareLatency` takes one limit for every gated latency field, so those
  // fields must currently agree with it for that signature to be honest.
  for (const field of benchmarkFieldsOf("latency-ab")) {
    expect({ field, rule: BENCHMARK_FIELDS[field] }).toEqual({ field, rule: { kind: "latency-ab", limit: DETERMINISTIC_LIMIT } });
  }
}, 120_000);

test("the cost gate fires from a zero baseline, which is the only baseline there is", () => {
  const baseline = record({ costPerShotUsd: 0 });
  // The committed baseline records $0.00 per shot, because the benchmark runs
  // on the mock provider. Under the old proportional-only rule every one of
  // these passed.
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
  // Cheaper is never a regression.
  expect(compareDeterministic(paid, record({ costPerShotUsd: 0 })).pass).toBe(true);
});

test("an exact field that changes is a regression, and a missing number is not silence", () => {
  const baseline = record();
  for (const field of benchmarkFieldsOf("exact")) {
    const changed = compareDeterministic(baseline, record({ [field]: field === "shots" ? 25 : "different" } as Partial<BenchmarkMetrics>));
    expect({ field, pass: changed.pass }).toEqual({ field, pass: false });
    expect(changed.regressions.join(" ")).toContain(`${field} changed`);
  }
  // A record that lost a gated number is refused rather than skipped. The old
  // code's `before > 0` guard and the latency loop's `typeof` guard both
  // treated a missing value as nothing to check.
  for (const field of [...benchmarkFieldsOf("lower"), ...benchmarkFieldsOf("higher")]) {
    const broken = compareDeterministic(baseline, record({ [field]: undefined } as Partial<BenchmarkMetrics>));
    expect({ field, pass: broken.pass }).toEqual({ field, pass: false });
    expect(broken.regressions.join(" ")).toContain(`${field} is missing or not a number`);
  }
});

test("a malformed limit or round count refuses the gate instead of disabling it", () => {
  // `Number("loose")` is NaN and `delta > NaN` is false, so a typo in this
  // override used to turn a merge gate off with no message at all: a fail-open
  // environment variable on a merge gate.
  for (const bad of ["loose", "NaN", "-0.1", "2", "5%", "Infinity"]) {
    expect(() => limitFromEnv("HV_BENCHMARK_LATENCY_LIMIT", 0.05, { HV_BENCHMARK_LATENCY_LIMIT: bad }))
      .toThrow(/HV_BENCHMARK_LATENCY_LIMIT must be a fraction between 0 and 1/);
  }
  for (const bad of ["loose", "0", "-1", "2.5", "NaN"]) {
    expect(() => roundsFromEnv(3, { HV_BENCHMARK_ROUNDS: bad }))
      .toThrow(/HV_BENCHMARK_ROUNDS must be a positive integer/);
  }
  // Absent, empty and valid values all still work, so refusing a malformed
  // value has not made either variable mandatory.
  expect(limitFromEnv("HV_BENCHMARK_LATENCY_LIMIT", 0.05, {})).toBe(0.05);
  expect(limitFromEnv("HV_BENCHMARK_LATENCY_LIMIT", 0.05, { HV_BENCHMARK_LATENCY_LIMIT: "  " })).toBe(0.05);
  expect(limitFromEnv("HV_BENCHMARK_LATENCY_LIMIT", 0.05, { HV_BENCHMARK_LATENCY_LIMIT: "0.35" })).toBe(0.35);
  expect(roundsFromEnv(3, {})).toBe(3);
  expect(roundsFromEnv(3, { HV_BENCHMARK_ROUNDS: "7" })).toBe(7);
  expect(DETERMINISTIC_LIMIT).toBe(0.05);

  // And the gate itself still fires at the documented limit.
  const runs = [record({ perShotLatencyMsMin: 100, totalPipelineMs: 2400 })];
  expect(compareLatency(runs, [record({ perShotLatencyMsMin: 104, totalPipelineMs: 2400 })]).pass).toBe(true);
  expect(compareLatency(runs, [record({ perShotLatencyMsMin: 106, totalPipelineMs: 2400 })]).pass).toBe(false);
});
