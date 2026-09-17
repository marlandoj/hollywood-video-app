/**
 * HV-032-02 — the fair-share weight has a horizon.
 *
 * `CostLedger.gpuSecondsByProject()` summed every event the ledger had ever
 * recorded and handed the total to the claim order. A project that rendered on
 * its first day therefore sat behind every newer project for the remaining
 * twenty-nine days of its retention, however idle it had been since — one
 * project starving another, which is what FR-029 forbids. The weight is now
 * `fairShareWeights(now)` over `FAIR_SHARE_WINDOW_MS`.
 *
 * The last case is the one that matters: it drives `fairShareOrder` with the
 * weights the ledger actually produces, rather than with numbers written in the
 * test, so it fails if the ledger and the ordering disagree about the horizon.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CostLedger } from "../src/index";
import { FAIR_SHARE_WINDOW_MS, fairShareOrder, withinFairShareWindow } from "../../queue/src/index";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const root = mkdtempSync(join(tmpdir(), "hv-fair-share-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const NOW = Date.parse("2026-09-17T12:00:00.000Z");
const event = (projectId: string, seconds: number, at: number) => ({
  jobId: `${projectId}-${at}`, at: new Date(at).toISOString(), projectId, shotId: "s",
  stage: "animatic" as const, provider: "test", model: "m",
  prompt_tokens: 1, output_frames: 1, gpu_seconds: seconds, total_cost_usd: 0,
});
let ledgers = 0;
const seeded = (...events: ReturnType<typeof event>[]) => {
  const ledger = new CostLedger(join(root, `ledger-${ledgers++}.json`));
  for (const item of events) ledger.record(item);
  return ledger;
};

test("usage older than the window no longer weighs against a project", () => {
  const ledger = seeded(
    event("old", 500, NOW - FAIR_SHARE_WINDOW_MS - 1),
    event("recent", 20, NOW - 60_000),
  );
  expect(ledger.fairShareWeights(NOW)).toEqual({ recent: 20 });
  // The lifetime total is still in the ledger; it is simply not the weight.
  expect(ledger.all().reduce((sum, item) => sum + item.gpu_seconds, 0)).toBe(520);
});

test("the boundary is inclusive at exactly the window's age, and the next millisecond is out", () => {
  const ledger = seeded(
    event("edge", 7, NOW - FAIR_SHARE_WINDOW_MS),
    event("just-out", 9, NOW - FAIR_SHARE_WINDOW_MS - 1),
  );
  expect(ledger.fairShareWeights(NOW)).toEqual({ edge: 7 });
  // And the same events a millisecond later: the edge ages out too.
  expect(ledger.fairShareWeights(NOW + 1)).toEqual({});
  expect([
    withinFairShareWindow(new Date(NOW - FAIR_SHARE_WINDOW_MS).toISOString(), NOW),
    withinFairShareWindow(new Date(NOW - FAIR_SHARE_WINDOW_MS - 1).toISOString(), NOW),
    withinFairShareWindow(new Date(NOW).toISOString(), NOW),
    withinFairShareWindow("not a date", NOW),
  ]).toEqual([true, false, true, false]);
});

test("several events for one project inside the window add up, and a quiet project weighs nothing", () => {
  const ledger = seeded(
    event("busy", 30, NOW - 3_600_000),
    event("busy", 12.5, NOW - 1_800_000),
    event("busy", 400, NOW - FAIR_SHARE_WINDOW_MS - 3_600_000),
    event("quiet", 90, NOW - FAIR_SHARE_WINDOW_MS - 1),
  );
  expect(ledger.fairShareWeights(NOW)).toEqual({ busy: 42.5 });
  // `quiet` is absent rather than zero, and the claim order reads an absent
  // project as zero -- so the two spellings have to mean the same thing.
  expect(fairShareOrder([
    { jobId: "j-busy", projectId: "busy", gpuSecondsUsed: ledger.fairShareWeights(NOW).busy ?? 0 },
    { jobId: "j-quiet", projectId: "quiet", gpuSecondsUsed: ledger.fairShareWeights(NOW).quiet ?? 0 },
  ])).toEqual(["j-quiet", "j-busy"]);
});

test("the starvation FR-029 forbids: a long-idle project stops losing every race to a new one", () => {
  // `established` rendered heavily on its first day and nothing since.
  // `newcomer` has just arrived. Both have a job queued now.
  const ledger = seeded(
    event("established", 5_000, NOW - 29 * 24 * 3600 * 1000),
    event("newcomer", 60, NOW - 120_000),
  );
  const order = (weights: Record<string, number>) => fairShareOrder([
    { jobId: "job-established", projectId: "established", gpuSecondsUsed: weights.established ?? 0 },
    { jobId: "job-newcomer", projectId: "newcomer", gpuSecondsUsed: weights.newcomer ?? 0 },
  ]);

  // With the horizon, the newcomer's recent 60 seconds outweigh the
  // established project's aged-out 5000, so the established project is served
  // first -- it is no longer permanently behind.
  expect(order(ledger.fairShareWeights(NOW))).toEqual(["job-established", "job-newcomer"]);

  // Measured against the defect, on the same ledger: a lifetime sum puts the
  // established project last, and would do so for every newcomer, for the rest
  // of its retention. This is the comparison, not an assertion about the
  // shipped code -- it is computed here from the same events.
  const lifetime: Record<string, number> = {};
  for (const item of ledger.all()) lifetime[item.projectId] = (lifetime[item.projectId] ?? 0) + item.gpu_seconds;
  expect(lifetime).toEqual({ established: 5_000, newcomer: 60 });
  expect(order(lifetime)).toEqual(["job-newcomer", "job-established"]);

  // And once the newcomer's own usage ages out, the two are level and the tie
  // breaks on the job id, deterministically, rather than on ancient history.
  expect(order(ledger.fairShareWeights(NOW + FAIR_SHARE_WINDOW_MS))).toEqual(["job-established", "job-newcomer"]);
});

test("the horizon is one day, and it is the same day the ledgers already window by", () => {
  // The value, pinned. Every other assertion in both suites is written in
  // terms of FAIR_SHARE_WINDOW_MS, so they are value-agnostic by
  // construction: the critic pass set the constant to 28 days -- which,
  // inside a 30-day retention, *is* the lifetime sum this increment exists to
  // remove -- and measured the whole repository green. Nothing constrained the
  // number but two incidental literals in this file.
  expect(FAIR_SHARE_WINDOW_MS).toBe(24 * 60 * 60 * 1000);

  // And pinned to the thing the doc argues from rather than to a bare number:
  // it is the `day` rollup both ledgers already compute beside the weight, it
  // is far longer than the job timeout so a project's own in-flight render can
  // never age out under it, and it is a small fraction of the project
  // retention that made a lifetime sum indefensible.
  const dayRollupMs = 864e5;
  const jobTimeoutMs = 30 * 60 * 1000;
  const retentionMs = 30 * 24 * 3600 * 1000;
  expect(FAIR_SHARE_WINDOW_MS).toBe(dayRollupMs);
  expect(FAIR_SHARE_WINDOW_MS / jobTimeoutMs).toBeGreaterThanOrEqual(24);
  expect(FAIR_SHARE_WINDOW_MS / retentionMs).toBeLessThanOrEqual(1 / 15);
});

test("the horizon is declared once, and neither ledger writes a duration of its own", () => {
  const files = [...new Bun.Glob("packages/*/src/**/*.ts").scanSync(REPO_ROOT)]
    .map(file => file.split("\\").join("/")).sort();
  // The glob has to be finding the packages, or the declaration scan below is
  // vacuous rather than true.
  expect(files.length).toBeGreaterThan(100);
  expect(files).toContain("packages/queue/src/index.ts");
  const source = new Map(files.map(file => [file, readFileSync(join(REPO_ROOT, file), "utf8")]));

  // Exactly one file in the whole of packages/*/src declares it -- an earlier
  // draft looked only at the three files it already suspected, so a duplicate
  // anywhere else was invisible.
  expect(files.filter(file => /export const FAIR_SHARE_WINDOW_MS/.test(source.get(file)!)))
    .toEqual(["packages/queue/src/index.ts"]);

  // Both ledgers reach it rather than restating it, and *use* it: an earlier
  // draft asserted only that the name appeared somewhere in the PostgreSQL
  // ledger, which its import line and a doc comment satisfy on their own --
  // so replacing the constant with a literal in the query, leaving the import
  // unused, passed.
  const durations = /[\d_]{6,}|[\d_]+\s*\*|\d+(?:\.\d+)?e\d+/;
  for (const [file, use] of [
    ["packages/operator/src/index.ts", /if \(!withinFairShareWindow\(event\.at, now\)\) continue;/],
    ["packages/storage/src/ledger.ts", /new Date\(now - FAIR_SHARE_WINDOW_MS\)/],
  ] as const) {
    const text = source.get(file)!;
    const start = text.indexOf("fairShareWeights(");
    expect({ file, found: start >= 0 }).toEqual({ file, found: true });
    const body = text.slice(start, text.indexOf("\n  }", start));
    // The horizon is applied inside the method, not merely imported.
    expect({ file, uses: use.test(body) }).toEqual({ file, uses: true });
    // And no duration of the method's own: `24 * 60 * 60 * 1000`, `864e5`,
    // `86400000` and `86_400_000` are all refused. The separator form matters
    // -- it is this codebase's dominant style and an earlier draft's regex,
    // anchored on \b and a plain digit run, matched none of the underscored
    // spellings while its comment claimed it did.
    expect({ file, duration: durations.test(body) }).toEqual({ file, duration: false });
  }

  // The refusal is exercised rather than asserted: each of these spellings, in
  // a method body, is caught.
  for (const spelling of ["24 * 60 * 60 * 1000", "86400000", "86_400_000", "864e5", "7 * 86_400_000"]) {
    expect({ spelling, caught: durations.test(`  return now - ${spelling};`) }).toEqual({ spelling, caught: true });
  }
  // And a short literal that is not a duration is not caught, so the guard is
  // not simply refusing every number.
  for (const innocent of ["0", "1", "now", "seconds ?? 0"]) {
    expect({ innocent, caught: durations.test(`  return ${innocent};`) }).toEqual({ innocent, caught: false });
  }
});
