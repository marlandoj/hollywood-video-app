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
import { TAKEDOWN_CLOCK_SKEW_MS, validateSnapshot, exportStateSnapshot, importStateSnapshot, type StateSnapshot } from "../src/snapshots";
import { StudioDatabase } from "../src/database";
import { PostgresRetention } from "../src/retention";

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_API_DATABASE_URL && process.env.HV_WORKER_DATABASE_URL);
const pgtest = enabled ? test : test.skip;
// A state import refuses a non-empty destination, so every PostgreSQL case
// here owns a database of its own for the run rather than sharing one -- the
// same pattern packages/storage/test/snapshots.test.ts uses, and the reason
// CLAUDE.md asks for a per-run database instead of the staging one.
const NAME = /^hv_takedown_record_test_[a-f0-9]{32}$/;
let rootDatabase: StudioDatabase;
const opened: { name: string; database: StudioDatabase }[] = [];

async function freshDatabase(): Promise<StudioDatabase> {
  const name = "hv_takedown_record_test_" + crypto.randomUUID().replaceAll("-", "");
  await rootDatabase.sql.unsafe('CREATE DATABASE "' + name + '"');
  const url = new URL(process.env.HV_PG_ADMIN_URL!); url.pathname = "/" + name;
  const database = new StudioDatabase(url.href);
  await database.migrate();
  opened.push({ name, database });
  return database;
}

beforeAll(async () => {
  if (!enabled) return;
  process.env.HV_TOKEN_SECRET = "takedown-record-fixture-secret-of-at-least-thirty-two";
  rootDatabase = new StudioDatabase(process.env.HV_PG_ADMIN_URL!);
});
afterAll(async () => {
  if (!enabled) return;
  for (const { name, database } of opened) {
    await database.close();
    if (!NAME.test(name)) throw new Error("refusing to drop an unexpected fixture database");
    await rootDatabase.sql.unsafe('DROP DATABASE "' + name + '"');
  }
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

/** The refusal message for one input, or "" when it was accepted. */
const refusal = (over: Partial<StateSnapshot["projects"]>): string => {
  try { validateSnapshot(snapshot(over)); return ""; } catch (error) { return (error as Error).message; }
};

test("a tombstone with no takedown record is refused, naming the project", () => {
  expect(validateSnapshot(snapshot())).toBeDefined();

  // The exact shape ProjectService.reload produces from a state file written
  // before takedownLog existed: the tombstone survives, the record does not.
  const none = refusal({ takedownLog: [] });
  expect(none).toContain("takedown records are missing for 1");
  expect(none).toContain(TOMBSTONE);

  // Two tombstones, no records: the count and both names are reported, so an
  // operator fixing the file knows which projects to look up.
  const both = refusal({ takenDown: [TOMBSTONE, OTHER], takedownLog: [] });
  expect(both).toContain("missing for 2");
  expect(both).toContain(TOMBSTONE);
  expect(both).toContain(OTHER);

  // Two tombstones, ONE record -- the shape an earlier draft of this suite
  // claimed to cover and did not. Both cross-checks were only ever exercised
  // with the other list empty, so `missing = recorded.size ? [] : takenDown`
  // passed the whole suite while accepting a snapshot whose second tombstone
  // the restore then dropped entirely: the insert loop walks the records, so
  // an unrecorded tombstone is not written to hv_projects in any form. That is
  // worse than the defect this increment removes, and it was one line away.
  const partial = refusal({ takenDown: [TOMBSTONE, OTHER], takedownLog: [{ projectId: TOMBSTONE, at: TAKEN_AT, reason: "verified legal request" }] });
  expect(partial).toContain("missing for 1");
  expect(partial).toContain(OTHER);
  expect(partial).not.toContain(TOMBSTONE);
});

test("a takedown record for a project that is not tombstoned is refused", () => {
  // A record with no tombstone means the project is either still live -- in
  // which case the record is a false claim of a takedown that did not happen
  // -- or missing from both lists.
  const orphan = refusal({ takenDown: [], takedownLog: [{ projectId: OTHER, at: TAKEN_AT, reason: "verified legal request" }] });
  expect(orphan).toContain("not tombstoned");
  expect(orphan).toContain(OTHER);

  // With a tombstone present as well, so the check is exercised against a
  // non-empty `takenDown` rather than only against an empty one.
  const mixed = refusal({ takedownLog: [
    { projectId: TOMBSTONE, at: TAKEN_AT, reason: "verified legal request" },
    { projectId: OTHER, at: TAKEN_AT, reason: "verified legal request" },
  ] });
  expect(mixed).toContain("name 1 project(s) that are not tombstoned");
  expect(mixed).toContain(OTHER);
  expect(mixed).not.toContain("missing for");
});

test("two records for the same tombstone are refused", () => {
  // `takedown()` appends exactly one, guarded by its own `takenDown.has` early
  // return, so two records mean two different answers to "when".
  expect(refusal({ takedownLog: [
    { projectId: TOMBSTONE, at: TAKEN_AT, reason: "verified legal request" },
    { projectId: TOMBSTONE, at: "2026-07-08T09:10:11.000Z", reason: "something else" },
  ] })).toContain("duplicate takedown record");
});

test("a record has to be plausible, not merely present", () => {
  // The cross-check moved the fabrication out of the code and into whatever an
  // operator types into the file, so the record itself is checked. Before
  // this, `reason: ""` and a date in 2099 were both accepted -- and since
  // `delete_after` derives from `at`, 2099 bought a seventy-three-year
  // extension of the tombstone.
  for (const [label, reason] of [["empty", ""], ["whitespace", "   "], ["a tab", "\t"]] as const) {
    expect({ label, refused: refusal({ takedownLog: [{ projectId: TOMBSTONE, at: TAKEN_AT, reason }] }) })
      .toEqual({ label, refused: "takedown record for " + TOMBSTONE + " has no reason" });
  }
  const future = new Date(Date.now() + 48 * 3600_000).toISOString();
  expect(refusal({ takedownLog: [{ projectId: TOMBSTONE, at: future, reason: "verified legal request" }] }))
    .toContain("dated in the future");

  // Clock skew between the recording host and the validating one is tolerated,
  // and the boundary is the declared constant rather than a feeling.
  expect(TAKEDOWN_CLOCK_SKEW_MS).toBe(3600_000);
  const skewed = new Date(Date.now() + TAKEDOWN_CLOCK_SKEW_MS - 60_000).toISOString();
  expect(refusal({ takedownLog: [{ projectId: TOMBSTONE, at: skewed, reason: "verified legal request" }] })).toBe("");
  const beyond = new Date(Date.now() + TAKEDOWN_CLOCK_SKEW_MS + 60_000).toISOString();
  expect(refusal({ takedownLog: [{ projectId: TOMBSTONE, at: beyond, reason: "verified legal request" }] })).toContain("dated in the future");
  // `now` is a parameter, so the boundary is asserted against a chosen instant
  // and not against whenever the suite happens to run.
  const at = "2026-03-04T05:06:07.000Z";
  expect(() => validateSnapshot(snapshot({ takedownLog: [{ projectId: TOMBSTONE, at, reason: "r" }] }), Date.parse(at) - TAKEDOWN_CLOCK_SKEW_MS - 1)).toThrow("dated in the future");
  expect(validateSnapshot(snapshot({ takedownLog: [{ projectId: TOMBSTONE, at, reason: "r" }] }), Date.parse(at) - TAKEDOWN_CLOCK_SKEW_MS)).toBeDefined();
});

test("a snapshot with no takedowns at all is still valid", () => {
  // The tightening must not refuse the ordinary case; the checked-in golden
  // archive fixture has both lists empty.
  expect(validateSnapshot(snapshot({ takenDown: [], takedownLog: [] }))).toBeDefined();
});

pgtest("a restore writes each takedown's own date and reason, and derives retention from them", async () => {
  const admin = await freshDatabase();
  const first = crypto.randomUUID(), second = crypto.randomUUID();
  const LATER = "2026-05-06T07:08:09.000Z";
  const source: StateSnapshot = snapshot({
    // Two tombstones and two records, so the loop is exercised with more than
    // one row and each row has to carry its own values rather than the last
    // one seen. A single-row case cannot tell those apart.
    takenDown: [first, second],
    takedownLog: [
      { projectId: first, at: TAKEN_AT, reason: "verified legal request" },
      { projectId: second, at: LATER, reason: "second complaint, unrelated" },
    ],
  });

  await importStateSnapshot(admin, validateSnapshot(source), 500);

  // The row count, which nothing asserted before: a tombstone silently
  // dropped by the record-driven loop is the failure mode the weakened
  // cross-check would have produced.
  const count = await admin.sql`select count(*)::int as n from hv_projects`;
  expect((count as { n: number }[])[0]!.n).toBe(2);

  const rows = await admin.sql`select id, taken_down_at, takedown_reason, delete_after from hv_projects order by taken_down_at`;
  expect((rows as { id: string }[]).map(row => row.id)).toEqual([first, second]);
  for (const [id, at, reason] of [[first, TAKEN_AT, "verified legal request"], [second, LATER, "second complaint, unrelated"]] as const) {
    const row = (rows as { id: string; taken_down_at: Date; takedown_reason: string; delete_after: Date }[]).find(candidate => candidate.id === id)!;
    // The date the takedown actually happened, not the moment of the restore.
    expect({ id, at: new Date(row.taken_down_at).toISOString() }).toEqual({ id, at });
    expect({ id, reason: row.takedown_reason }).toEqual({ id, reason });
    // And the retention window is measured from that date. The fabricated
    // version put it thirty days past the restore instead, silently extending
    // the tombstone.
    expect({ id, deleteAfter: new Date(row.delete_after).toISOString() })
      .toEqual({ id, deleteAfter: new Date(Date.parse(at) + 30 * 864e5).toISOString() });
  }

  // An export round-trips both records rather than the restore's own clock:
  // the fabricated values used to become the record on the next export out.
  const exported = await exportStateSnapshot(admin);
  expect(exported.projects.takenDown.slice().sort()).toEqual([first, second].sort());
  expect(exported.projects.takedownLog.slice().sort((a: {projectId: string}, b: {projectId: string}) => a.projectId.localeCompare(b.projectId)))
    .toEqual([
      { projectId: first, at: TAKEN_AT, reason: "verified legal request" },
      { projectId: second, at: LATER, reason: "second complaint, unrelated" },
    ].sort((a, b) => a.projectId.localeCompare(b.projectId)));
});

pgtest("a retention sweep purges the restored tombstone and keeps the reason it was given", async () => {
  const admin = await freshDatabase();
  // This is the consequence of deriving `delete_after` from the takedown's own
  // date: a takedown from months ago is immediately sweep-eligible, so the
  // first sweep tick after a restore reaches it. The sweep must purge the data
  // -- that retention is overdue is the correct reading -- while leaving the
  // recorded reason alone. It did not: `takedown_reason = 'content removed'`
  // was unconditional, so the sweep erased the reason the restore had just
  // preserved and the next export emitted the generic string as the record.
  // Preserving the date and losing the reason would have been a worse record
  // than the one this increment replaced.
  const tombstone = crypto.randomUUID();
  await importStateSnapshot(admin, validateSnapshot(snapshot({
    takenDown: [tombstone],
    takedownLog: [{ projectId: tombstone, at: TAKEN_AT, reason: "verified legal request" }],
  })), 500);
  const before = await admin.sql`select delete_after from hv_projects where id = ${tombstone}`;
  expect(new Date((before as { delete_after: Date }[])[0]!.delete_after).getTime()).toBeLessThan(Date.now());

  const swept = await new PostgresRetention(admin).sweep();
  expect(swept).toContain(tombstone);

  const after = await admin.sql`select taken_down_at, takedown_reason, purged_at from hv_projects where id = ${tombstone}`;
  const row = (after as { taken_down_at: Date; takedown_reason: string; purged_at: Date | null }[])[0]!;
  expect(row.purged_at).not.toBeNull();
  expect(new Date(row.taken_down_at).toISOString()).toBe(TAKEN_AT);
  expect(row.takedown_reason).toBe("verified legal request");

  // And the export after the sweep still carries the operator's reason.
  const exported = await exportStateSnapshot(admin);
  expect(exported.projects.takedownLog.find((event: { projectId: string }) => event.projectId === tombstone))
    .toEqual({ projectId: tombstone, at: TAKEN_AT, reason: "verified legal request" });
});

pgtest("a project purged for ordinary expiry still gets the generic reason", async () => {
  const admin = await freshDatabase();
  // The coalesce must not stop the sweeper labelling a project it purged for
  // reaching its retention date rather than for a takedown: that row has no
  // recorded reason, so the generic string is the right value there. This is
  // the half of the sweeper's behaviour the fix must leave alone.
  const expired = crypto.randomUUID();
  await admin.sql`insert into hv_projects (id, body, delete_after)
    values (${expired}, ${{ id: expired, createdAt: TAKEN_AT, deleteAfter: TAKEN_AT, versions: [] }}::jsonb, ${TAKEN_AT})`;
  expect(await new PostgresRetention(admin).sweep()).toContain(expired);
  const rows = await admin.sql`select takedown_reason, taken_down_at from hv_projects where id = ${expired}`;
  const row = (rows as { takedown_reason: string; taken_down_at: Date }[])[0]!;
  expect(row.takedown_reason).toBe("content removed");
  // And this is the residual this increment declares rather than fixes: the
  // sweeper writes `taken_down_at` for a project that was never taken down,
  // so the export below reports an ordinary expiry as a takedown. Pinned so
  // the follow-up increment has a failing expectation to change rather than a
  // sentence in a document to rediscover.
  expect(row.taken_down_at).not.toBeNull();
  const exported = await exportStateSnapshot(admin);
  expect(exported.projects.takenDown).toContain(expired);
  expect(exported.projects.takedownLog.find((event: { projectId: string }) => event.projectId === expired)?.reason)
    .toBe("content removed");
});

pgtest("a row tombstoned with no reason is named by the export, not emitted as a record", async () => {
  // `takedown_reason` is a nullable column and every code path now sets it, so
  // a NULL is only producible by a direct database write -- but the export
  // used to read the column with no fallback and emit `reason: null`, which
  // the validator it returns through then refuses with the generic "invalid
  // takedown history". An operator mid-rollback got a message that named
  // neither the project nor the problem. It now names both.
  const admin = await freshDatabase();
  const nameless = crypto.randomUUID();
  await admin.sql`insert into hv_projects (id, body, delete_after, taken_down_at)
    values (${nameless}, '{}'::jsonb, ${TAKEN_AT}, ${TAKEN_AT})`;

  let thrown: unknown;
  try { await exportStateSnapshot(admin); } catch (error) { thrown = error; }
  const message = String((thrown as Error | undefined)?.message);
  expect(message).toContain("tombstoned with no recorded reason");
  expect(message).toContain(nameless);
  expect(message).not.toContain("invalid takedown history");

  // And once the reason is recorded, the same export succeeds -- so the
  // refusal is about the missing value and not about the row existing.
  await admin.sql`update hv_projects set takedown_reason = 'verified legal request' where id = ${nameless}`;
  const exported = await exportStateSnapshot(admin);
  expect(exported.projects.takedownLog).toEqual([{ projectId: nameless, at: TAKEN_AT, reason: "verified legal request" }]);
});
