import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BudgetError } from "../src/index";
import { MusicLedger, type MusicLineAlert } from "../src/music-ledger";
import { EVENTS } from "../../observability/src/logs";

/**
 * HV-024-11: the music line's ledger (the file store). A cue's hold is reserved against the $10 line
 * under the ledger's lock, refused past it in the house wording, settled at no more than its hold,
 * and the $3 and $7 alerts are raised exactly once each a month, after the hold is written.
 */
const SEPT = Date.parse("2026-09-30T12:00:00.000Z"), OCT = Date.parse("2026-10-01T00:00:01.000Z");
const cue = (id: string, heldUsd: number, now = SEPT, capUsd = 10) => ({id, projectId: "p1", provider: "elevenlabs", model: "music_v1", heldUsd, capUsd, now});
function scratch() { const dir = mkdtempSync(join(tmpdir(), "hv-music-ledger-")); return {dir, path: join(dir, "music-ledger.json"), done: () => rmSync(dir, {recursive: true, force: true})}; }

/** Spent plus held plus the cue may not pass the line; the refusal names the vendor and writes nothing. */
test("a cue is admitted up to the line and refused past it, in the house wording, with nothing written", () => {
  const files = scratch();
  try {
    const ledger = new MusicLedger(files.path);
    for (let i = 0; i < 9; i++) ledger.reserve(cue("c" + i, 1));
    ledger.settle("c0", 0.5, "asset-0");
    // $0.50 spent, $8 held: a $1.50 cue fits exactly; a cent more does not.
    expect(() => ledger.reserve(cue("over", 1.51))).toThrow("The elevenlabs music line has reached its limit of $10.00 ($8.50 spent or held). Ask the studio operator to raise it.");
    expect(() => ledger.reserve(cue("over", 1.51))).toThrow(BudgetError);
    expect(ledger.cue("over")).toBeUndefined();
    ledger.reserve(cue("fits", 1.5));
    expect(ledger.summary(SEPT)).toMatchObject({month: "2026-09", spentUsd: 0.5, heldUsd: 9.5, committedUsd: 10});
    // A settled cue counts its cost, an unreconciled one its hold, a released one nothing.
    ledger.markUnreconciled("c1"); ledger.release("c2");
    expect(ledger.summary(SEPT)).toMatchObject({spentUsd: 0.5, heldUsd: 8.5, committedUsd: 9});
    expect(() => ledger.release("c1")).toThrow("Only a cue that was never sent can release its hold.");
    expect(() => ledger.settle("c3", 1.01, null)).toThrow("A music cue settles at no more than its hold.");
    expect(ledger.settle("c3", 0.25, "asset-3")).toMatchObject({status: "settled", actualUsd: 0.25, assetId: "asset-3"});
    expect(ledger.settle("c3", 0.25, "asset-3").status).toBe("settled");
    expect(() => ledger.settle("c3", 0.3, "asset-3")).toThrow("already settled");
    // Read back from the file by a second ledger: the same figures.
    expect(new MusicLedger(files.path).summary(SEPT)).toEqual(ledger.summary(SEPT));
  } finally { files.done(); }
});

/** The alerts are raised to `onAlert`, once each a month, by the cue that crosses them, after it is written. */
test("the $3 and $7 alerts are raised once each a month, by the cue that crosses them, and read by the caller", () => {
  const ledger = new MusicLedger(), raised: MusicLineAlert[] = [];
  // Raised after the hold is written: the ledger already holds the figure the alert names.
  ledger.onAlert = alert => { raised.push(alert); expect(ledger.summary(Date.parse(alert.month + "-15T00:00:00.000Z")).committedUsd).toBe(alert.committedUsd); };
  // Cues of $0.25 until the month passes $7.
  for (let total = 25; total <= 800; total += 25) {
    const result = ledger.reserve(cue("s" + total, 0.25));
    expect(result.alerts).toEqual(raised.filter(alert => alert.committedUsd === total / 100));
  }
  expect(raised.map(alert => alert.thresholdUsd)).toEqual([3, 7]);
  expect(raised.map(alert => alert.committedUsd)).toEqual([3, 7]);
  expect(raised.every(alert => alert.provider === "elevenlabs" && alert.month === "2026-09")).toBe(true);
  // A replay is not a second commitment; a refused cue crosses nothing.
  expect(ledger.reserve(cue("s300", 0.25)).replay).toBe(true);
  expect(() => ledger.reserve(cue("big", 5))).toThrow("music line has reached its limit");
  // Releasing below $3 and crossing it again does not raise it a second time this month.
  for (let total = 25; total <= 800; total += 25) ledger.release("s" + total);
  expect(ledger.summary(SEPT).committedUsd).toBe(0);
  ledger.reserve(cue("again", 3.5));
  expect(raised).toHaveLength(2);
  expect(ledger.summary(SEPT).alerts).toEqual([3, 7]);
  // A new month starts the line and its alerts again.
  ledger.reserve(cue("october", 3, OCT));
  expect(raised.map(alert => [alert.month, alert.thresholdUsd])).toEqual([["2026-09", 3], ["2026-09", 7], ["2026-10", 3]]);
  expect(ledger.summary(OCT)).toMatchObject({month: "2026-10", committedUsd: 3, alerts: [3]});
});

/** Separate processes reserving at once against one file: the lock lets exactly as many through as the line holds. */
test("concurrent reservations from separate processes cannot pass the line, and each alert is raised once", async () => {
  const files = scratch();
  try {
    const module = new URL("../src/music-ledger.ts", import.meta.url).pathname;
    const script = (i: number) => `import {MusicLedger} from ${JSON.stringify(module)};
      const ledger = new MusicLedger(${JSON.stringify(files.path)}), alerts = [];
      ledger.onAlert = alert => alerts.push(alert.thresholdUsd);
      try { ledger.reserve({id: "p${i}", projectId: "p${i}", provider: "elevenlabs", model: "music_v1", heldUsd: 1.5, capUsd: 10, now: ${SEPT}}); console.log(JSON.stringify({ok: true, alerts})); }
      catch (error) { console.log(JSON.stringify({ok: false, message: error.message})); }`;
    const children = Array.from({length: 10}, (_, i) => Bun.spawn(["bun", "-e", script(i)], {stdout: "pipe", stderr: "pipe"}));
    const results = await Promise.all(children.map(async child => JSON.parse((await new Response(child.stdout).text()).trim()) as {ok: boolean; alerts?: number[]; message?: string}));
    // $1.50 cues on a $10 line: six fit ($9), the seventh would be $10.50.
    expect(results.filter(r => r.ok)).toHaveLength(6);
    expect(results.filter(r => !r.ok).every(r => r.message!.includes("music line has reached its limit"))).toBe(true);
    expect(results.flatMap(r => r.alerts ?? []).sort()).toEqual([3, 7]);
    expect(new MusicLedger(files.path).summary(SEPT)).toMatchObject({committedUsd: 9, alerts: [3, 7]});
  } finally { files.done(); }
}, 60000);

/** A ledger file that will not parse is not an empty ledger: nothing is admitted until it is repaired. */
test("an unreadable music ledger admits nothing", () => {
  const files = scratch();
  try {
    writeFileSync(files.path, "{\"schema\":\"hv-music-ledger/1\",\"cues\":[");
    expect(() => new MusicLedger(files.path).reserve(cue("c", 0.15))).toThrow("The music ledger is unreadable");
    writeFileSync(files.path, JSON.stringify({schema: "hv-music-ledger/1", cues: [{id: "x", projectId: "p", at: "2026-09-30T00:00:00.000Z", month: "2026-08", provider: "elevenlabs", model: "m",
      status: "held", heldUsd: 1, actualUsd: null, alerts: [], assetId: null}]}));
    expect(() => new MusicLedger(files.path).summary(SEPT)).toThrow("The music ledger is unreadable");
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
