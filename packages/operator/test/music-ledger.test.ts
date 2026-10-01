import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetError, CostLedger, type CostEvent } from "../src/index";
import { MusicLedger, type MusicLineAlert } from "../src/music-ledger";
import { EVENTS } from "../../observability/src/logs";

/**
 * HV-024-11: the music line's ledger (the file store). A cue's hold is reserved against the $10
 * lifetime line, the film's limit and the month's generation cap in one critical section, refused
 * past any of them in its house wording, and ends as an ordinary cost event in the generation ledger.
 * The $3 and $7 alerts are raised once each, ever, after the hold is written.
 */
const SEPT = Date.parse("2026-09-30T12:00:00.000Z"), OCT = Date.parse("2026-10-01T00:00:01.000Z"), NEXT_YEAR = Date.parse("2027-10-01T00:00:00.000Z");
const cue = (id: string, heldUsd: number, now = SEPT, extra: Record<string, unknown> = {}) =>
  ({id, projectId: "p1", provider: "elevenlabs", model: "music_v1", heldUsd, capUsd: 10, monthlyCapUsd: 500, now, ...extra});
function scratch() {
  const dir = mkdtempSync(join(tmpdir(), "hv-music-ledger-"));
  return {dir, path: join(dir, "music-ledger.json"), costs: join(dir, "ledger.json"), done: () => rmSync(dir, {recursive: true, force: true})};
}
const spent = (projectId: string, usd: number, at = new Date(SEPT).toISOString()): CostEvent =>
  ({eventId: crypto.randomUUID(), at, projectId, shotId: "s1", jobId: crypto.randomUUID(), stage: "final", provider: "fal", model: "m", prompt_tokens: 0, output_frames: 0, gpu_seconds: 0, total_cost_usd: usd});

/** Spent plus held plus the cue may not pass the line; the refusal names the vendor and writes nothing in either ledger. */
test("a cue is admitted up to the line and refused past it, and each cue ends as a cost in the generation ledger", () => {
  const files = scratch();
  try {
    const costs = new CostLedger(files.costs), ledger = new MusicLedger(files.path, costs);
    for (let i = 0; i < 9; i++) ledger.reserve(cue("c" + i, 1));
    expect(costs.reservedUsd()).toBe(9);
    ledger.settle("c0", 0.5, "asset-0");
    // $0.50 spent, $8 held: a $1.50 cue fits exactly; a cent more does not.
    expect(() => ledger.reserve(cue("over", 1.51))).toThrow("The elevenlabs music line has reached its limit of $10.00 ($8.50 spent or held). Ask the studio operator to raise it.");
    expect(() => ledger.reserve(cue("over", 1.51))).toThrow(BudgetError);
    expect(ledger.cue("over")).toBeUndefined();
    expect(new CostLedger(files.costs).reservedUsd()).toBe(8);
    ledger.reserve(cue("fits", 1.5));
    expect(ledger.summary()).toEqual({spentUsd: 0.5, heldUsd: 9.5, committedUsd: 10, alerts: [3, 7]});
    // An unreconciled cue is recorded at its hold; a released one counts nothing.
    ledger.markUnreconciled("c1"); ledger.release("c2");
    expect(ledger.summary()).toMatchObject({spentUsd: 1.5, heldUsd: 7.5, committedUsd: 9});
    expect(() => ledger.release("c1")).toThrow("Only a cue that was never sent can release its hold.");
    expect(() => ledger.settle("c3", 1.01, null)).toThrow("A music cue settles at no more than its hold.");
    expect(ledger.settle("c3", 1, "asset-3")).toMatchObject({status: "settled", actualUsd: 1, assetId: "asset-3"});
    expect(ledger.settle("c3", 1, "asset-3").status).toBe("settled");
    expect(() => ledger.settle("c3", 0.9, "asset-3")).toThrow("already settled");
    // The generation ledger: one cost event per ended, possibly-charged cue, at its recorded cost; its hold gone.
    const events = new CostLedger(files.costs).all();
    expect(events.map(e => [e.jobId, e.stage, e.provider, e.total_cost_usd])).toEqual([["c0", "music-cue", "elevenlabs", 0.5], ["c1", "music-cue", "elevenlabs", 1], ["c3", "music-cue", "elevenlabs", 1]]);
    expect(new CostLedger(files.costs).reservedUsd()).toBe(6.5);
    expect(new CostLedger(files.costs).rollup("month", new Date(SEPT)).byProvider).toEqual({elevenlabs: 2.5});
    // Read back from the files by a second ledger: the same figures.
    expect(new MusicLedger(files.path, new CostLedger(files.costs)).summary()).toEqual(ledger.summary());
  } finally { files.done(); }
});

/** The line is the voice line's shape: lifetime. A new month neither forgets an unreconciled cue nor re-arms an alert. */
test("the line is lifetime: an unreconciled cue still counts next month, and each alert is raised once, ever", () => {
  const ledger = new MusicLedger(), raised: MusicLineAlert[] = [];
  // Raised after the hold is written: the ledger already holds the figure the alert names.
  ledger.onAlert = alert => { raised.push(alert); expect(ledger.summary().committedUsd).toBe(alert.committedUsd); };
  // The adversarial review's case: $9.50 unreconciled in September is still $9.50 on October 1.
  ledger.reserve(cue("u1", 9.5)); ledger.markUnreconciled("u1");
  expect(() => ledger.reserve(cue("o1", 0.51, OCT))).toThrow("music line has reached its limit of $10.00 ($9.50 spent or held)");
  expect(() => ledger.reserve(cue("o1", 9.9, NEXT_YEAR))).toThrow("music line has reached its limit");
  ledger.reserve(cue("o2", 0.5, OCT));
  expect(raised.map(alert => [alert.thresholdUsd, alert.committedUsd])).toEqual([[3, 9.5], [7, 9.5]]);
  expect(raised.every(alert => alert.provider === "elevenlabs")).toBe(true);

  const fresh = new MusicLedger(), crossed: MusicLineAlert[] = [];
  fresh.onAlert = alert => crossed.push(alert);
  for (let total = 25; total <= 800; total += 25) expect(fresh.reserve(cue("s" + total, 0.25)).alerts.map(a => a.thresholdUsd)).toEqual(total === 300 ? [3] : total === 700 ? [7] : []);
  expect(crossed.map(alert => alert.committedUsd)).toEqual([3, 7]);
  // A replay is not a second commitment; a refused cue crosses nothing.
  expect(fresh.reserve(cue("s300", 0.25)).replay).toBe(true);
  expect(() => fresh.reserve(cue("big", 5))).toThrow("music line has reached its limit");
  // Releasing below $3 and crossing again, even a year later, raises nothing.
  for (let total = 25; total <= 800; total += 25) fresh.release("s" + total);
  expect(fresh.summary().committedUsd).toBe(0);
  fresh.reserve(cue("again", 7.5, NEXT_YEAR));
  expect(crossed).toHaveLength(2);
  expect(fresh.summary().alerts).toEqual([3, 7]);
});

/** A cue is generation spend: refused by the film's limit and by the month's cap, as an audio take's hold would be. */
test("a cue's hold counts against the film's limit and the month's cap, and the film's spend shows it", () => {
  const files = scratch();
  try {
    const costs = new CostLedger(files.costs), ledger = new MusicLedger(files.path, costs);
    costs.record(spent("p1", 39.9));
    const film = {filmCapUsd: 40, filmJobIds: new Set<string>()};
    expect(() => ledger.reserve(cue("film", 0.15, SEPT, film))).toThrow("This film has reached its spending limit of $40.00 ($39.90 spent or held).");
    expect(ledger.cue("film")).toBeUndefined();
    ledger.reserve(cue("fits", 0.1, SEPT, film));
    expect(costs.filmSpend("p1", new Set())).toEqual({spentUsd: 39.9, heldUsd: 0.1});
    // Another film's cue is not this film's, but the month counts every film.
    costs.record(spent("p2", 459.9));
    expect(() => ledger.reserve({...cue("month", 0.15, SEPT), projectId: "p3"})).toThrow("generation capacity is reserved; try again when current jobs finish");
    expect(ledger.cue("month")).toBeUndefined();
    expect(ledger.summary().committedUsd).toBe(0.1);
    ledger.settle("fits", 0.1, "asset");
    expect(costs.filmSpend("p1", new Set())).toEqual({spentUsd: 40, heldUsd: 0});
    expect(costs.monthSpend(new Date(SEPT))).toBeCloseTo(499.9, 6);
    // The worker's reconcile releases job holds whose job is gone, never a cue's.
    ledger.reserve({...cue("flight", 0.05, SEPT), projectId: "p4"});
    costs.reconcile(new Set(), 0, SEPT + 3600e3);
    expect(costs.reservedUsd()).toBe(0.05);
  } finally { files.done(); }
});

/** Separate processes reserving at once against the same files: the locks let exactly as many through as the line holds. */
test("concurrent reservations from separate processes cannot pass the line, and each alert is raised once", async () => {
  const files = scratch();
  try {
    const operator = new URL("../src/", import.meta.url).pathname;
    const script = (i: number) => `import {MusicLedger} from ${JSON.stringify(operator + "music-ledger.ts")}; import {CostLedger} from ${JSON.stringify(operator + "index.ts")};
      const ledger = new MusicLedger(${JSON.stringify(files.path)}, new CostLedger(${JSON.stringify(files.costs)})), alerts = [];
      ledger.onAlert = alert => alerts.push(alert.thresholdUsd);
      try { ledger.reserve({id: "p${i}", projectId: "p${i}", provider: "elevenlabs", model: "music_v1", heldUsd: 1.5, capUsd: 10, monthlyCapUsd: 500, now: ${SEPT}}); console.log(JSON.stringify({ok: true, alerts})); }
      catch (error) { console.log(JSON.stringify({ok: false, message: error.message})); }`;
    const children = Array.from({length: 10}, (_, i) => Bun.spawn(["bun", "-e", script(i)], {stdout: "pipe", stderr: "pipe"}));
    const results = await Promise.all(children.map(async child => JSON.parse((await new Response(child.stdout).text()).trim()) as {ok: boolean; alerts?: number[]; message?: string}));
    // $1.50 cues on a $10 line: six fit ($9), the seventh would be $10.50.
    expect(results.filter(r => r.ok)).toHaveLength(6);
    expect(results.filter(r => !r.ok).every(r => r.message!.includes("music line has reached its limit"))).toBe(true);
    expect(results.flatMap(r => r.alerts ?? []).sort()).toEqual([3, 7]);
    expect(new MusicLedger(files.path, new CostLedger(files.costs)).summary()).toMatchObject({committedUsd: 9, alerts: [3, 7]});
    expect(new CostLedger(files.costs).reservedUsd()).toBe(9);
  } finally { files.done(); }
}, 60000);

/** A ledger file that will not parse is not an empty ledger: nothing is admitted until it is repaired. */
test("an unreadable music ledger admits nothing", () => {
  const files = scratch();
  try {
    writeFileSync(files.path, "{\"schema\":\"hv-music-ledger/2\",\"cues\":[");
    expect(() => new MusicLedger(files.path).reserve(cue("c", 0.15))).toThrow("The music ledger is unreadable");
    writeFileSync(files.path, JSON.stringify({schema: "hv-music-ledger/2", cues: [{id: "x", projectId: "p", at: "2026-09-30T00:00:00.000Z", provider: "elevenlabs", model: "m",
      status: "unreconciled", heldUsd: 1, actualUsd: null, alerts: [], assetId: null}]}));
    expect(() => new MusicLedger(files.path).summary()).toThrow("The music ledger is unreadable");
  } finally { files.done(); }
});

/**
 * The HV-022-13 lesson, kept for this line: a computed alert that nothing reads is not an alert.
 * Both stores raise the alerts they decide; the studio sets the seam to a log warning under a name
 * the log's closed set admits. `packages/api/test/music-cues.test.ts` shows the line being written.
 */
test("the music line's alerts are read by the studio, and named where an operator sees them", () => {
  const root = new URL("../../", import.meta.url).pathname, reads = (file: string) => readFileSync(join(root, file), "utf8");
  for (const file of ["operator/src/music-ledger.ts", "storage/src/music-ledger.ts"]) {
    expect({file, plans: reads(file).includes("planMusicReservation(")}).toEqual({file, plans: true});
    expect({file, raises: reads(file).includes("this.onAlert?.(alert)")}).toEqual({file, raises: true});
  }
  expect(reads("operator/src/music-ledger.ts")).toContain("musicVendorAlerts(");
  expect(reads("api/src/server.ts")).toContain('logger.warn("music.budget_alert"');
  expect(EVENTS.has("music.budget_alert")).toBe(true);
});
