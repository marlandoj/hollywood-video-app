/**
 * HV-038-06 — the state files that forgot everything rather than say they could not be read.
 *
 * `readJsonFile` answered `null` for "there is no file" and for "there is a file and it is not
 * JSON" alike. Its five callers are the studio's durable state, and four of them read that `null`
 * as "nothing yet":
 *
 * - the **crew ledger** forgot every dollar the crew had spent, re-armed every alert and lifted the
 *   approved ceiling's stop — the one guard that is supposed to stop the spending;
 * - the **operator review queue** emptied itself, and the next flag wrote that emptiness back;
 * - the **studio's project state** started with no projects, and the next save wrote that over
 *   every anonymous project in the studio;
 * - a film's **retained clip manifest** read as "no shot was rendered", so a checkpoint naming
 *   finished shots would be rebuilt by paying for all of them again.
 *
 * The fifth, `CostLedger`, refused — and is the reason this is a defect rather than a design: the
 * one caller that guards money knew the difference and the one that guards the crew's money did
 * not. Every writer here is `writeJsonFile`, which writes a temporary file and renames it, so an
 * unparseable file is never a half-finished write: it is corruption, truncation, a half-restored
 * backup or a hand edit, and none of those is repaired by writing over it.
 */
import {afterAll, expect, test} from "bun:test";
import {mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {readJsonFile, UnreadableStateFile, writeJsonFile} from "../src/persist";
import {CostLedger, OperatorReviewQueue} from "../../operator/src/index";
import {CrewLedger} from "../../operator/src/crew-ledger";
import {ProjectService} from "../../api/src/index";

process.env.HV_TOKEN_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, {recursive: true, force: true}); });
const scratch = () => { const root = mkdtempSync(join(tmpdir(), "hv-unreadable-")); roots.push(root); return root; };
/** The shapes a state file is actually found in: truncated, emptied, or written over by hand. */
const CORRUPTIONS: [string, string][] = [["empty", ""], ["whitespace", "  \n"], ["truncated object", '{"schema":"hv-crew-ledg'],
  ["truncated array", '[{"shotId":"shot-1-1",'], ["trailing garbage", '{"a":1} oops'], ["not json at all", "<html>502 Bad Gateway</html>"]];

test("a file that exists and does not parse is refused, and a file that does not exist is still absent", () => {
  const root = scratch();
  expect(readJsonFile(join(root, "never-written.json"))).toBeNull();
  writeJsonFile(join(root, "written.json"), {a: 1});
  expect(readJsonFile<{a: number}>(join(root, "written.json"))).toEqual({a: 1});
  for (const [name, bytes] of CORRUPTIONS) {
    const path = join(root, "corrupt.json");
    writeFileSync(path, bytes);
    let caught: unknown;
    try { readJsonFile(path); } catch (error) { caught = error; }
    expect({name, refused: caught instanceof UnreadableStateFile}).toEqual({name, refused: true});
    expect({name, names: (caught as Error).message.includes(path)}).toEqual({name, names: true});
  }
});

test("the crew ledger's approved ceiling is not lifted by a truncated ledger", () => {
  const path = join(scratch(), "crew.json");
  const ledger = new CrewLedger(path);
  ledger.record({at: new Date().toISOString(), model: "m", inputTokens: 1, outputTokens: 1, usd: 1000.01, projectId: "p1", persona: "director"});
  expect(ledger.summary().spentUsd).toBe(1000.01);
  expect(ledger.summary().alerts.map(alert => alert.thresholdUsd)).toEqual([25, 100, 200, 1000]);
  expect(() => ledger.assertCanSpend()).toThrow("reached its approved budget");
  // Before this increment: $0 spent, no alerts, and the crew free to spend the whole ceiling again.
  const bytes = readFileSync(path);
  writeFileSync(path, bytes.subarray(0, Math.floor(bytes.length / 2)));
  const reopened = new CrewLedger(path);
  expect(() => reopened.summary()).toThrow("crew ledger is unreadable");
  expect(() => reopened.assertCanSpend()).toThrow("crew ledger is unreadable");
  expect(() => reopened.record({at: new Date().toISOString(), model: "m", inputTokens: 1, outputTokens: 1, usd: 1, projectId: "p1", persona: "director"}))
    .toThrow("crew ledger is unreadable");
  // And the bytes are still there, which is the point of refusing rather than starting over.
  expect(readFileSync(path).byteLength).toBe(Math.floor(bytes.length / 2));
});

test("and an unreadable review queue does not report an empty one, nor write that emptiness back", () => {
  const path = join(scratch(), "review.json");
  const queue = new OperatorReviewQueue(path);
  for (let index = 1; index <= 5; index++) queue.flag("shot-1-" + index, "p1", 0.4);
  expect(queue.pending()).toHaveLength(5);
  const bytes = readFileSync(path, "utf8");
  writeFileSync(path, bytes.slice(0, 40));
  // Before this increment: `pending()` answered 0 with no error, and the next flag rewrote the file
  // with one item -- the operator's five flags gone, permanently, with nothing said.
  // It refuses at the door -- the queue is read when it is opened -- so nothing downstream ever
  // sees an empty one, and the flags on disk are exactly as they were.
  expect(() => new OperatorReviewQueue(path)).toThrow("unreadable");
  expect(readFileSync(path, "utf8")).toBe(bytes.slice(0, 40));
  // Repaired, it is the five flags again: refusing is what kept them.
  writeFileSync(path, bytes);
  expect(new OperatorReviewQueue(path).pending()).toHaveLength(5);
});

test("and an unreadable studio state does not serve a studio with no projects in it", () => {
  const path = join(scratch(), "projects.json");
  const service = new ProjectService(path);
  const first = service.createAnonymousProject();
  service.editScript(first.token, "INT. ROOM - DAY\n\nMaya waits.");
  const second = service.createAnonymousProject();
  service.editScript(second.token, "EXT. GARDEN - NIGHT\n\nLeo waits.");
  const bytes = readFileSync(path);
  expect(bytes.byteLength).toBeGreaterThan(400);
  writeFileSync(path, bytes.subarray(0, Math.floor(bytes.length / 2)));
  // Before this increment: the service started empty and the next `createAnonymousProject` wrote a
  // state file holding one project over the state file holding two. Nothing was said, and there was
  // nothing left to restore from.
  expect(() => new ProjectService(path)).toThrow("unreadable");
  expect(readFileSync(path).byteLength).toBe(Math.floor(bytes.byteLength / 2));
  // A path that was never written is still a new studio, which is how every first run starts.
  expect(() => new ProjectService(join(scratch(), "fresh.json"))).not.toThrow();
});

test("and the cost ledger keeps the message it always had", () => {
  // It is the one caller that refused before this increment, and its refusal is asserted by name
  // elsewhere; this increment must not have changed what an operator reads.
  const path = join(scratch(), "cost.json");
  writeJsonFile(path, {events: [], reservations: []});
  expect(() => new CostLedger(path)).not.toThrow();
  writeFileSync(path, '{"events":[');
  expect(() => new CostLedger(path)).toThrow("cost ledger is unreadable; generation is paused");
});

/**
 * Every file that reads a state file, and what it does with a file it cannot read. A new caller has
 * to join this table, which is the point: the default used to be "start over", and the whole defect
 * was four callers taking it without deciding to.
 */
const READERS: Record<string, string> = {
  "api/src/index.ts": "refuses; the studio's projects are not served from an empty state",
  "api/src/persist.ts": "re-export only",
  "operator/src/crew-ledger.ts": "refuses; the crew stays stopped until the ledger is repaired",
  "operator/src/index.ts": "refuses; the cost ledger pauses generation and the review queue keeps its flags",
  "queue/src/persist.ts": "the reader itself",
  "queue/src/take-exports.ts": "propagates; the export it just wrote must be readable",
  "queue/src/worker.ts": "propagates; an unreadable clip manifest is not an unrendered film",
};
test("and every reader of a state file is one that decided what an unreadable file means", () => {
  const root = new URL("../../", import.meta.url).pathname;
  const found = new Set<string>();
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, {withFileTypes: true})) {
      if (entry.name === "node_modules" || entry.name === "test" || entry.name.startsWith(".")) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { walk(path); continue; }
      if (!entry.name.endsWith(".ts")) continue;
      if (/\breadJsonFile\b/.test(readFileSync(path, "utf8"))) found.add(path.slice(root.length));
    }
  };
  walk(root);
  expect([...found].sort()).toEqual(Object.keys(READERS).sort());
});
