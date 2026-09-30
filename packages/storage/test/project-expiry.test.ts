/**
 * HV-031-12 (G4, approved 2026-09-30 as G15) -- expiry is not a takedown.
 *
 * The PostgreSQL sweeper purged a project whose retention had ended by stamping `taken_down_at`
 * and the reason "content removed", because `taken_down_at` doubled as the "this project is gone"
 * marker. History then said the project was taken down. Expiry now has its own column
 * (`expired_at`, migration 0019), its own record in the file store and in whole-state snapshots
 * (`projects.expired`, state schema 17), and every read that asks whether a project is gone
 * honours both. Rows the old sweeper already stamped are reported, read-only, and never rewritten.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { ProjectService } from "../../api/src/index";
import { StudioDatabase } from "../src/database";
import { PostgresProjectService } from "../src/projects";
import { findSweeperStampedTakedowns, PostgresRetention } from "../src/retention";
import { exportStateSnapshot, importStateSnapshot, stateSnapshotSchema, validateSnapshot, type StateSnapshot } from "../src/snapshots";

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_API_DATABASE_URL && process.env.HV_WORKER_DATABASE_URL);
const pgtest = enabled ? test : test.skip;
const NAME = /^hv_project_expiry_test_[a-f0-9]{32}$/;
let rootDatabase: StudioDatabase;
const opened: { name: string; database: StudioDatabase }[] = [];

async function freshDatabase(): Promise<StudioDatabase> {
  const name = "hv_project_expiry_test_" + crypto.randomUUID().replaceAll("-", "");
  await rootDatabase.sql.unsafe('CREATE DATABASE "' + name + '"');
  const url = new URL(process.env.HV_PG_ADMIN_URL!); url.pathname = "/" + name;
  const database = new StudioDatabase(url.href);
  await database.migrate();
  opened.push({ name, database });
  return database;
}

beforeAll(async () => {
  process.env.HV_TOKEN_SECRET ??= "project-expiry-fixture-secret-of-at-least-thirty-two";
  if (enabled) rootDatabase = new StudioDatabase(process.env.HV_PG_ADMIN_URL!);
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

const EXPIRED = "33333333-3333-4333-8333-333333333333";
const TAKEN = "44444444-4444-4444-8444-444444444444";
const AT = "2026-03-04T05:06:07.000Z";

const snapshot = (over: Partial<StateSnapshot["projects"]> = {}, schema = "hv-state/17"): StateSnapshot => ({
  schema,
  projects: { version: 1, projects: [], reviewLinks: [], takenDown: [], takedownLog: [], expired: [{ projectId: EXPIRED, at: AT }], ...over },
  jobs: [], ledger: { events: [], reservations: [] }, reviews: [],
} as unknown as StateSnapshot);
const refusal = (value: StateSnapshot): string => { try { validateSnapshot(value); return ""; } catch (error) { return (error as Error).message; } };

test("an expiry record is accepted at state schema 17 and refused below it", () => {
  expect(refusal(snapshot())).toBe("");
  expect(refusal(snapshot({}, "hv-state/16"))).toContain("requires state schema 17");
  expect(refusal(snapshot({}, "hv-state/1"))).toContain("requires state schema 17");
});

test("an expiry record has to be well formed and plausible", () => {
  expect(refusal(snapshot({ expired: [] }))).toBe("invalid expiry history");
  expect(refusal(snapshot({ expired: [{ projectId: EXPIRED, at: AT, reason: "x" } as never] }))).toBe("invalid expiry history");
  expect(refusal(snapshot({ expired: [{ projectId: "not an id!", at: AT }] }))).toBe("invalid expiry history");
  expect(refusal(snapshot({ expired: [{ projectId: EXPIRED, at: "never" }] }))).toBe("invalid expiry history");
  expect(refusal(snapshot({ expired: [{ projectId: EXPIRED, at: AT }, { projectId: EXPIRED, at: AT }] }))).toContain("expiry record");
  expect(refusal(snapshot({ expired: [{ projectId: EXPIRED, at: new Date(Date.now() + 86_400_000).toISOString() }] }))).toContain("dated in the future");
});

test("a project cannot be both expired and taken down", () => {
  const both = snapshot({ takenDown: [EXPIRED], takedownLog: [{ projectId: EXPIRED, at: AT, reason: "verified legal request" }] });
  expect(refusal(both)).toContain("live or taken down");
  expect(refusal(snapshot({ takenDown: [TAKEN], takedownLog: [{ projectId: TAKEN, at: AT, reason: "verified legal request" }] }))).toBe("");
});

test("only a state that carries an expiry record is promoted to schema 17", () => {
  const plain = { version: 1 as const, projects: [], reviewLinks: [], takenDown: [], takedownLog: [] };
  expect(stateSnapshotSchema(plain, [])).toBe("hv-state/1");
  expect(stateSnapshotSchema({ ...plain, expired: [{ projectId: EXPIRED, at: AT }] }, [])).toBe("hv-state/17");
});

test("the file store records a swept project as expired, never as taken down", () => {
  const service = new ProjectService();
  const created = Date.parse("2026-01-01T00:00:00.000Z");
  const { projectId } = service.createAnonymousProject(created);
  expect("expired" in service.snapshot()).toBe(false);
  const sweptAt = created + 31 * 86_400_000;
  expect(service.sweepExpired(sweptAt)).toEqual([projectId]);
  const state = service.snapshot();
  expect(state.projects).toEqual([]);
  expect(state.takenDown).toEqual([]);
  expect(state.takedownLog).toEqual([]);
  expect(state.expired).toEqual([{ projectId, at: new Date(sweptAt).toISOString() }]);
  expect(ProjectService.fromState(state).snapshot().expired).toEqual(state.expired);
  expect(service.isTakenDown(projectId)).toBe(false);
});

pgtest("a restore brings an expired project back as it left: purged, with no takedown", async () => {
  const admin = await freshDatabase();
  await importStateSnapshot(admin, validateSnapshot(snapshot()), 500);
  const rows = await admin.sql`select body, taken_down_at, takedown_reason, expired_at, purged_at from hv_projects where id = ${EXPIRED}`;
  const row = (rows as { body: object; taken_down_at: Date | null; takedown_reason: string | null; expired_at: Date; purged_at: Date }[])[0]!;
  expect(row.body).toEqual({});
  expect(row.taken_down_at).toBeNull();
  expect(row.takedown_reason).toBeNull();
  expect(new Date(row.expired_at).toISOString()).toBe(AT);
  expect(new Date(row.purged_at).toISOString()).toBe(AT);
  // Already purged, so the sweeper leaves it alone -- and the next export says the same thing.
  expect(await new PostgresRetention(admin).sweep()).not.toContain(EXPIRED);
  const exported = await exportStateSnapshot(admin);
  expect(exported.schema).toBe("hv-state/17");
  expect(exported.projects.expired).toEqual([{ projectId: EXPIRED, at: AT }]);
  expect(exported.projects.takenDown).toEqual([]);
});

pgtest("an expired project reads as no project, and a write never deletes the row that records it", async () => {
  const admin = await freshDatabase();
  const projects = new PostgresProjectService(admin);
  const { projectId, token } = await projects.createAnonymousProject();
  expect(await projects.authorize(token)).not.toBeNull();
  await admin.sql`update hv_projects set delete_after = now() - interval '1 day' where id = ${projectId}`;
  expect(await new PostgresRetention(admin).sweep()).toContain(projectId);
  // The owner's token is still inside its own lifetime; the project is not.
  expect(await projects.authorize(token)).toBeNull();
  expect(await projects.editScript(token, "INT. KITCHEN - DAY\n\nA kettle.\n")).toBeNull();
  const rows = await admin.sql`select expired_at, taken_down_at, purged_at from hv_projects where id = ${projectId}`;
  expect(rows.length).toBe(1);
  const row = (rows as { expired_at: Date | null; taken_down_at: Date | null; purged_at: Date | null }[])[0]!;
  expect(row.expired_at).not.toBeNull();
  expect(row.taken_down_at).toBeNull();
});

pgtest("the report names only rows the old sweeper stamped, and changes nothing", async () => {
  const admin = await freshDatabase();
  const stamped = crypto.randomUUID(), taken = crypto.randomUUID(), expired = crypto.randomUUID();
  const later = "2026-04-04T05:06:07.000Z";
  // The pre-HV-031-12 sweeper's signature: one timestamp for both columns, the generic reason.
  await admin.sql`insert into hv_projects (id, body, delete_after, taken_down_at, takedown_reason, purged_at)
    values (${stamped}, '{}'::jsonb, ${AT}, ${AT}, 'content removed', ${AT})`;
  // A real takedown with the same generic words, recorded first and purged later.
  await admin.sql`insert into hv_projects (id, body, delete_after, taken_down_at, takedown_reason, purged_at)
    values (${taken}, '{}'::jsonb, ${AT}, ${AT}, 'content removed', ${later})`;
  await admin.sql`insert into hv_projects (id, body, delete_after, expired_at, purged_at)
    values (${expired}, '{}'::jsonb, ${AT}, ${AT}, ${AT})`;
  const before = await admin.sql`select id, taken_down_at, takedown_reason, expired_at, purged_at, version from hv_projects order by id`;
  expect(await findSweeperStampedTakedowns(admin)).toEqual([{ projectId: stamped, stampedAt: AT }]);
  expect(await admin.sql`select id, taken_down_at, takedown_reason, expired_at, purged_at, version from hv_projects order by id`).toEqual(before);
});
