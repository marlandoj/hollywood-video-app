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

test("the horizon is declared once, and neither ledger writes a duration of its own", () => {
  const files = ["packages/operator/src/index.ts", "packages/storage/src/ledger.ts", "packages/queue/src/index.ts"];
  const source = new Map(files.map(file => [file, readFileSync(join(REPO_ROOT, file), "utf8")]));

  // Exactly one file declares it.
  const declarers = files.filter(file => /export const FAIR_SHARE_WINDOW_MS/.test(source.get(file)!));
  expect(declarers).toEqual(["packages/queue/src/index.ts"]);

  // Both ledgers reach it rather than restating it. The JSON ledger goes
  // through `withinFairShareWindow`; the PostgreSQL one has to compute a
  // timestamp for SQL, so it names the constant directly.
  expect(source.get("packages/operator/src/index.ts")).toMatch(/withinFairShareWindow\(/);
  expect(source.get("packages/storage/src/ledger.ts")).toMatch(/FAIR_SHARE_WINDOW_MS/);

  // Neither `fairShareWeights` body contains a duration literal -- the shape
  // that would let the two horizons drift apart. `24 * 60 * 60 * 1000`,
  // `864e5` and a bare `86400000` are all refused.
  const durations = /\b(?:\d+\s*\*\s*\d+|\d{6,}|\d(?:\.\d+)?e\d+)\b/;
  for (const file of ["packages/operator/src/index.ts", "packages/storage/src/ledger.ts"]) {
    const text = source.get(file)!;
    const start = text.indexOf("fairShareWeights(");
    expect({ file, found: start >= 0 }).toEqual({ file, found: true });
    const body = text.slice(start, text.indexOf("\n  }", start));
    expect({ file, duration: durations.test(body) }).toEqual({ file, duration: false });
  }
});
