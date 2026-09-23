/**
 * HV-019-10 — the budget decision that read the ledger twice.
 *
 * `assertCanSpend` reloaded the ledger, and then called the **public** `shotCapacity`, which
 * reloads it again. So the shot's budget was checked against one reading of the file and the job's
 * against another. The two checks are one answer to one question — may this attempt be made — and an
 * answer assembled from two readings of the same file taken at two different instants is not one
 * answer.
 *
 * The cost is the corroboration rather than the point: the parse *is* the call. On a ledger of 4,000
 * events, `assertCanSpend` with a shot took 4.27 ms against `shotCapacity`'s 1.90 ms alone — about
 * twice, for the same decision. The worker asks this once per provider attempt per shot.
 *
 * These tests do not time anything. They count the reads, which is what the milliseconds were made
 * of, and they show the two halves answered from the same reading.
 */
import {afterAll, expect, spyOn, test} from "bun:test";
import * as fs from "node:fs";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {BudgetError, CostLedger} from "../src/index";

const root = mkdtempSync(join(tmpdir(), "hv-single-read-"));
afterAll(() => rmSync(root, {recursive: true, force: true}));

const event = (jobId: string, shotId: string, usd: number) => ({jobId, shotId, at: new Date().toISOString(), projectId: "p",
  stage: "animatic" as const, provider: "test", model: "m", prompt_tokens: 1, output_frames: 1, gpu_seconds: 0, total_cost_usd: usd});

/** A ledger with one job reserved at $10 and nothing spent, and the path it lives at. */
function reserved(name: string): {path: string; ledger: CostLedger} {
  const path = join(root, name + ".json");
  const ledger = new CostLedger(path);
  ledger.reserve("j", "animatic", 10, 1000);
  return {path, ledger};
}

/**
 * Count the reads of one path, and optionally do something the first time it is read.
 *
 * `readFileSync` is where the parse happens, so counting it counts the readings of the ledger —
 * which is both the cost of the call and, here, the thing the decision is made out of.
 */
function watch(path: string, onFirstRead?: () => void) {
  const real = fs.readFileSync;
  let reads = 0, fired = false, inside = false;
  const spy = spyOn(fs, "readFileSync").mockImplementation(((target: fs.PathOrFileDescriptor, options?: unknown) => {
    // The other worker's own reads are not this decision's reads, so they are not counted.
    const mine = String(target) === path && !inside;
    if (mine) reads += 1;
    const result = (real as (a: fs.PathOrFileDescriptor, b?: unknown) => unknown)(target, options);
    if (mine && !fired && onFirstRead) {fired = true; inside = true; try { onFirstRead(); } finally { inside = false; }}
    return result;
  }) as typeof fs.readFileSync);
  return {reads: () => reads, stop: () => spy.mockRestore()};
}

test("one decision is one reading of the ledger, not two", () => {
  const {path, ledger} = reserved("count");
  ledger.record(event("j", "s", 1));
  const watcher = watch(path);
  try {
    ledger.assertCanSpend("j", 1, {id: "s", capUsd: 5});
    expect(watcher.reads()).toBe(1);
  } finally { watcher.stop(); }
  // And it is the same reading `shotCapacity` takes on its own -- the shot half of the decision was
  // the whole of the second read, so a decision with a shot now costs what one without it costs.
  for (const [what, call] of [["with a shot", () => ledger.assertCanSpend("j", 1, {id: "s", capUsd: 5})],
    ["without one", () => ledger.assertCanSpend("j", 1)],
    ["the shot's capacity alone", () => ledger.shotCapacity("j", "s", 5)]] as const) {
    const each = watch(path);
    try { call(); expect({what, reads: each.reads()}).toEqual({what, reads: 1}); } finally { each.stop(); }
  }
});

test("and the two halves of it are answered from that one reading", () => {
  // The defect made visible. Another worker records a spend against the same shot between the first
  // read and the second: the old shape checked the job against the file before that spend and the
  // shot against the file after it, so the refusal it gave was not a refusal any single state of the
  // ledger justified.
  const {path, ledger} = reserved("between");
  const other = new CostLedger(path);
  const watcher = watch(path, () => other.record(event("j", "s", 4.99)));
  try {
    // As of the reading this decision took, the shot has its whole $5 and the job its whole $10.
    ledger.assertCanSpend("j", 1, {id: "s", capUsd: 5});
    expect(watcher.reads()).toBe(1);
  } finally { watcher.stop(); }
  // Nothing is lost by that: the spend is in the file, and the next decision is made on it.
  expect(JSON.parse(readFileSync(path, "utf8")).events).toHaveLength(1);
  expect(() => ledger.assertCanSpend("j", 1, {id: "s", capUsd: 5})).toThrow("this shot reached its generation budget");
});

test("and every refusal it made before, it still makes", () => {
  // The fix moved a check into a private method. The evidence that it moved rather than changed is
  // that each refusal still arrives, by its own words, for its own reason.
  const {ledger} = reserved("refusals");
  ledger.record(event("j", "s", 4.5));
  for (const [reason, call] of [
    ["invalid generation estimate", () => ledger.assertCanSpend("j", Number.NaN)],
    ["invalid generation estimate", () => ledger.assertCanSpend("j", -1)],
    ["invalid shot budget", () => ledger.assertCanSpend("j", 1, {id: "s", capUsd: Number.NaN})],
    ["invalid shot budget", () => ledger.assertCanSpend("j", 1, {id: "s", capUsd: -1})],
    ["this shot reached its generation budget", () => ledger.assertCanSpend("j", 1, {id: "s", capUsd: 5})],
    ["this job reached its generation budget", () => ledger.assertCanSpend("j", 100)],
    ["this job reached its generation budget", () => ledger.assertCanSpend("unreserved", 1)],
  ] as const) {
    expect(call).toThrow(BudgetError);
    expect(call).toThrow(reason);
  }
  // And each allowance it made, it still makes: inside both budgets, and the free attempt that is
  // checked against the shot but never against the job.
  expect(() => ledger.assertCanSpend("j", 0.4, {id: "s", capUsd: 5})).not.toThrow();
  expect(() => ledger.assertCanSpend("unreserved", 0)).not.toThrow();
  // A shot that has spent nothing is bounded by what the job still holds, not by its own cap.
  expect(ledger.shotCapacity("j", "fresh", 100)).toBe(5.5);
});

test("and nothing in the ledger reaches the public shotCapacity from inside a decision", () => {
  // The guard on the defect itself. `shotCapacity` reloads, by design -- it is what the API calls to
  // show a shot's remaining budget. A method that has already loaded the state must not go through
  // it, and this is the whole file's worth of that rule rather than one method's.
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");
  expect(source).not.toContain("this.shotCapacity(");
  const between = (from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to));
  // One reading, named once, at the top of the decision.
  const decision = between("  assertCanSpend(", "\n  release(");
  expect(decision.split("this.reload()").length - 1).toBe(1);
  // And the half it reuses does not take a reading of its own -- that is the whole of the fix.
  expect(between("  private shotCapacityOf(", "\n  /**\n   * HV-019-10")).not.toContain("this.reload()");
});
