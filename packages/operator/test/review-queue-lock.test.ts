/**
 * HV-038-08 — the queue two processes share, written by neither of them safely.
 *
 * `OperatorReviewQueue` keeps the shots the continuity supervisor wants an operator to look at. Its
 * file is fixed at `/data/state/operator-review-queue.json` (`worker.ts:720`) and every worker that
 * flags a shot writes it. `flag` reloaded, mutated and persisted **outside any lock**, while the
 * other two shared-state classes in the same file — `CostLedger.transact` and `CrewLedger.locked` —
 * both take `withFileLock`, whose own comment says it exists for "state shared between the API and
 * worker processes".
 *
 * Measured with three processes flagging 150 distinct shots each — this test, with the lock taken
 * out: **450 expected, 404 on disk, 46 lost** in this container; 311 on disk, 139 lost on a busier
 * one. The size of the loss is the machine's; that there is one is the code's. Every individual
 * call reported success.
 *
 * `docker-compose.yml` runs one worker today, so it needs the scaled fleet that
 * `HV_EXPECTED_WORKERS` and the worker registry exist for. It is exactly the shape of defect those
 * were built for.
 *
 * And one signature beside it: `resolve` took a shot id alone, while `flag` keys on the pair —
 * `PostgresReviewQueue.flag` hashes `projectId + "\0" + shotId` for its primary key. Shot ids are
 * per-project strings like `shot-1-1`, so the first caller of `resolve` would have cleared every
 * project's review of the same shot. There is no production caller today, which is why this was a
 * trap rather than a leak.
 */
import {afterAll, expect, test} from "bun:test";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {OperatorReviewQueue, type ReviewItem} from "../src/index";

const roots: string[] = [];
afterAll(() => { for (const root of roots) rmSync(root, {recursive: true, force: true}); });
const scratch = () => { const root = mkdtempSync(join(tmpdir(), "hv-review-lock-")); roots.push(root); return root; };
const stored = (path: string): ReviewItem[] => JSON.parse(readFileSync(path, "utf8")) as ReviewItem[];

test("three processes flagging at once lose none of it", async () => {
  const path = join(scratch(), "review.json");
  const WORKERS = 3, EACH = 150;
  // Real processes, not promises: the defect is between them, and a single-threaded runtime cannot
  // exhibit it at all. Each flags its own distinct shots, so nothing is meant to overwrite anything.
  const script = join(scratch(), "worker.ts");
  writeFileSync(script, `
    import {OperatorReviewQueue} from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).pathname)};
    const queue = new OperatorReviewQueue(process.argv[2]);
    const worker = process.argv[3];
    for (let index = 0; index < ${EACH}; index++) queue.flag("shot-" + worker + "-" + index, "p1", 0.2);
  `);
  writeFileSync(path, "[]");
  await Promise.all(Array.from({length: WORKERS}, (_, index) =>
    Bun.spawn(["bun", script, path, String(index)], {stdout: "ignore", stderr: "inherit"}).exited));
  const items = stored(path);
  expect({expected: WORKERS * EACH, onDisk: items.length}).toEqual({expected: WORKERS * EACH, onDisk: WORKERS * EACH});
  // And every one of them is distinct, which is what says they were merged rather than overwritten.
  expect(new Set(items.map(item => item.shotId)).size).toBe(WORKERS * EACH);
  expect(new OperatorReviewQueue(path).pending()).toHaveLength(WORKERS * EACH);
}, 120_000);

test("and one process's flags are what they always were", () => {
  // The lock changes when the write happens, not what it writes. This is HV-019-07's rule,
  // unchanged: one entry per shot of a project, replaced rather than repeated, reopened on a
  // second flag after a resolve.
  const path = join(scratch(), "review.json");
  const queue = new OperatorReviewQueue(path);
  queue.flag("shot-1-1", "p1", 0.2);
  queue.flag("shot-1-1", "p1", 0.1);
  expect(queue.pending()).toHaveLength(1);
  expect(queue.pending()[0]!.score).toBe(0.1);
  queue.flag("shot-1-1", "p2", 0.3);
  expect(queue.pending().map(item => item.projectId).sort()).toEqual(["p1", "p2"]);
  queue.resolve("shot-1-1", "p1");
  expect(queue.pending().map(item => item.projectId)).toEqual(["p2"]);
  queue.flag("shot-1-1", "p1", 0.05);
  expect(queue.pending().map(item => item.projectId).sort()).toEqual(["p1", "p2"]);
});

test("and resolving a shot clears that project's flag, not every project's", () => {
  // Shot ids are per-project strings. `flag` has always keyed on the pair; `resolve` took the shot
  // id alone, so the first caller of it would have cleared every project's review of `shot-1-1`.
  const path = join(scratch(), "review.json");
  const queue = new OperatorReviewQueue(path);
  for (const project of ["p1", "p2", "p3"]) queue.flag("shot-1-1", project, 0.2);
  queue.resolve("shot-1-1", "p2");
  expect(queue.pending().map(item => item.projectId).sort()).toEqual(["p1", "p3"]);
  // A project that has no flag for that shot resolves nothing, rather than resolving someone else's.
  queue.resolve("shot-1-1", "p9");
  expect(queue.pending().map(item => item.projectId).sort()).toEqual(["p1", "p3"]);
  // Resolving twice is not an error and does not reach further.
  queue.resolve("shot-1-1", "p2");
  expect(queue.pending().map(item => item.projectId).sort()).toEqual(["p1", "p3"]);
});

test("and both stores of this queue take a project before they resolve anything", () => {
  // The JSON store and the PostgreSQL store are two implementations of one queue, and HV-019-07 was
  // written because they disagreed about what a second flag means. Asserted over the source so they
  // cannot drift apart on this too.
  const operator = readFileSync(new URL("../src/index.ts", import.meta.url).pathname, "utf8");
  const postgres = readFileSync(new URL("../../storage/src/reviews.ts", import.meta.url).pathname, "utf8");
  expect(operator).toContain("resolve(shotId: string, projectId: string)");
  expect(postgres).toContain("resolve(shotId: string, projectId: string)");
  expect(postgres).toContain("body->>'projectId' = ${projectId}");
  // And the JSON store's writes go through the same lock its siblings in this file take. Two
  // classes in this file transact under it now -- the cost ledger and this queue -- where the line
  // appeared once before; `CrewLedger` takes it through `locked` in its own file.
  expect([...operator.matchAll(/withFileLock\(this\.path, apply\)/g)]).toHaveLength(2);
});
