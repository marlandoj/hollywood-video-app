/**
 * HV-031-03 — a restore may not invent when or why a takedown happened.
 *
 * `takenDown` says a project is tombstoned; `takedownLog` says when and why.
 * `validateSnapshot` checked each list's own shape and never checked that they
 * agreed, so a snapshot could carry a tombstone with no record — and
 * `importState` completed it:
 *
 *     const at = event?.at ?? new Date().toISOString();
 *     … values (…, ${at}, ${event?.reason ?? "takedown"})
 *
 * The database then asserted that a takedown performed months ago happened at
 * the moment of the restore, for a generic reason, with no error, no counter
 * and no log line — and `delete_after` was derived from the fabricated date,
 * silently extending the tombstone's retention thirty days past the restore.
 * Any later `exportState` re-emitted the invented values as the record, so the
 * original date and reason were unrecoverable.
 *
 * The path was reachable without hand-editing anything: `ProjectService.reload`
 * reads `state.takedownLog ?? []`, so a state file written before that field
 * existed loads tombstones with no records at all.
 *
 * The PostgreSQL case is the one that proves the restore no longer fabricates;
 * the validation cases are pure and run everywhere.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { validateSnapshot, exportStateSnapshot, importStateSnapshot, type StateSnapshot } from "../src/snapshots";
import { StudioDatabase } from "../src/database";

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_API_DATABASE_URL && process.env.HV_WORKER_DATABASE_URL);
const pgtest = enabled ? test : test.skip;
// A state import refuses a non-empty destination, so this suite owns a
// database of its own for the run rather than sharing one -- the same pattern
// packages/storage/test/snapshots.test.ts uses, and the reason CLAUDE.md asks
// for a per-run database instead of the staging one.
const name = "hv_takedown_record_test_" + crypto.randomUUID().replaceAll("-", "");
let rootDatabase: StudioDatabase, admin: StudioDatabase;

beforeAll(async () => {
  if (!enabled) return;
  process.env.HV_TOKEN_SECRET = "takedown-record-fixture-secret-of-at-least-thirty-two";
  rootDatabase = new StudioDatabase(process.env.HV_PG_ADMIN_URL!);
  await rootDatabase.sql.unsafe('CREATE DATABASE "' + name + '"');
  const url = new URL(process.env.HV_PG_ADMIN_URL!); url.pathname = "/" + name;
  admin = new StudioDatabase(url.href);
  await admin.migrate();
});
afterAll(async () => {
  if (!enabled) return;
  await admin?.close();
  if (!/^hv_takedown_record_test_[a-f0-9]{32}$/.test(name)) throw new Error("refusing to drop an unexpected fixture database");
  await rootDatabase.sql.unsafe('DROP DATABASE "' + name + '"');
  await rootDatabase.close();
});

const TOMBSTONE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TAKEN_AT = "2026-03-04T05:06:07.000Z";

/** The smallest snapshot validateSnapshot accepts, with a takedown in it. */
const snapshot = (over: Partial<StateSnapshot["projects"]> = {}): StateSnapshot => ({
  schema: "hv-state/1",
  projects: {
    version: 1, projects: [], reviewLinks: [],
    takenDown: [TOMBSTONE],
    takedownLog: [{ projectId: TOMBSTONE, at: TAKEN_AT, reason: "verified legal request" }],
    ...over,
  },
  jobs: [], ledger: { events: [], reservations: [] }, reviews: [],
} as unknown as StateSnapshot);

test("a tombstone with no takedown record is refused, naming the project", () => {
  expect(validateSnapshot(snapshot())).toBeDefined();

  // The exact shape ProjectService.reload produces from a state file written
  // before takedownLog existed: the tombstone survives, the record does not.
  let thrown: unknown;
  try { validateSnapshot(snapshot({ takedownLog: [] })); } catch (error) { thrown = error; }
  expect(String((thrown as Error | undefined)?.message)).toContain("takedown records are missing for 1");
  expect(String((thrown as Error | undefined)?.message)).toContain(TOMBSTONE);

  // Two tombstones, one record: the count and both names are reported, so an
  // operator fixing the file knows which projects to look up.
  try {
    validateSnapshot(snapshot({ takenDown: [TOMBSTONE, OTHER], takedownLog: [] }));
  } catch (error) { thrown = error; }
  expect(String((thrown as Error | undefined)?.message)).toContain("missing for 2");
  expect(String((thrown as Error | undefined)?.message)).toContain(OTHER);
});

test("a takedown record for a project that is not tombstoned is refused too", () => {
  // The other direction. A record with no tombstone means the project is
  // either still live -- in which case the record is a false accusation of a
  // takedown that did not happen -- or missing from both lists.
  let thrown: unknown;
  try {
    validateSnapshot(snapshot({ takenDown: [], takedownLog: [{ projectId: OTHER, at: TAKEN_AT, reason: "verified legal request" }] }));
  } catch (error) { thrown = error; }
  expect(String((thrown as Error | undefined)?.message)).toContain("not tombstoned");
  expect(String((thrown as Error | undefined)?.message)).toContain(OTHER);

  // And a second record for the same tombstone is refused: `takedown()`
  // appends exactly one, guarded by its own `takenDown.has` early return, so
  // two records mean two different answers to "when".
  try {
    validateSnapshot(snapshot({ takedownLog: [
      { projectId: TOMBSTONE, at: TAKEN_AT, reason: "verified legal request" },
      { projectId: TOMBSTONE, at: "2026-07-08T09:10:11.000Z", reason: "something else" },
    ] }));
  } catch (error) { thrown = error; }
  expect(String((thrown as Error | undefined)?.message)).toContain("duplicate takedown record");
});

test("a snapshot with no takedowns at all is still valid", () => {
  // The tightening must not refuse the ordinary case; the checked-in golden
  // archive fixture has both lists empty.
  expect(validateSnapshot(snapshot({ takenDown: [], takedownLog: [] }))).toBeDefined();
});

pgtest("a restore writes the takedown's own date and reason, and derives retention from them", async () => {
  const tombstone = crypto.randomUUID();
  const source: StateSnapshot = snapshot({
    takenDown: [tombstone],
    takedownLog: [{ projectId: tombstone, at: TAKEN_AT, reason: "verified legal request" }],
  });

  const before = Date.now();
  await importStateSnapshot(admin, validateSnapshot(source), 500);

  const rows = await admin.sql`select taken_down_at, takedown_reason, delete_after from hv_projects where id = ${tombstone}`;
  const row = (rows as { taken_down_at: Date; takedown_reason: string; delete_after: Date }[])[0]!;
  // The date the takedown actually happened, not the moment of the restore.
  expect(new Date(row.taken_down_at).toISOString()).toBe(TAKEN_AT);
  expect(row.takedown_reason).toBe("verified legal request");
  // And the retention window is measured from that date. The fabricated
  // version put it thirty days past the restore instead, silently extending
  // the tombstone.
  expect(new Date(row.delete_after).toISOString()).toBe(new Date(Date.parse(TAKEN_AT) + 30 * 864e5).toISOString());
  expect(new Date(row.delete_after).getTime()).toBeLessThan(before);

  // An export round-trips the record rather than the restore's own clock: the
  // fabricated values used to become the record on the next export out.
  const exported = await exportStateSnapshot(admin);
  const record = exported.projects.takedownLog.find((event: {projectId: string}) => event.projectId === tombstone);
  expect(record).toEqual({ projectId: tombstone, at: TAKEN_AT, reason: "verified legal request" });
  expect(exported.projects.takenDown).toContain(tombstone);
  // And the round trip is accepted by the validation that refused the corrupt
  // input, so export and import agree about the invariant.
  expect(validateSnapshot(exported)).toBeDefined();
});
