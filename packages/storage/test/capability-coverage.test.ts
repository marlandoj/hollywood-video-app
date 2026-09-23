import { afterAll, beforeAll, expect, test } from "bun:test";
import type { SQL } from "bun";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "../src/schema";
import { StudioDatabase } from "../src/database";
import { PostgresCostLedger } from "../src/ledger";
import { PostgresProjectService } from "../src/projects";
import { currentDirection } from "../../planner/src/direction";

// Guard for HV-040-03: every hv_* table forces row security, every command hv_api or hv_worker can run is policed,
// and schema.ts declares exactly the policies the hand-written migrations (0001, 0002, 0015) created.
const COMMANDS = ["SELECT", "INSERT", "UPDATE", "DELETE"] as const;
type Command = typeof COMMANDS[number];
const SCOPED = ["hv_archives", "hv_artifacts", "hv_jobs", "hv_outbox", "hv_projects", "hv_provider_attempts", "hv_reviews"];
/** The exact hv_api privilege map. Widening it is a deliberate edit here, in schema.ts and in a new migration together. */
const API_PRIVILEGES: Record<string, Command[]> = {
  ...Object.fromEntries(SCOPED.map(table => [table, [...COMMANDS]])),
  hv_budget_accounts: ["SELECT", "INSERT", "UPDATE"], hv_reservations: ["SELECT", "INSERT"],
  hv_cost_events: ["SELECT"], hv_workers: ["SELECT"], hv_operator_reviews: [],
  // HV-030-09: the crew's own budget line. Events are append-only for hv_api -- it records what the
  // crew spent and reads the total, and cannot unspend -- and the one budget row is read, created
  // on first use and updated when an alert is raised or the ceiling is approved.
  hv_crew_events: ["SELECT", "INSERT"], hv_crew_budget: ["SELECT", "INSERT", "UPDATE"],
};
type PolicyFor = "all" | "select" | "insert" | "update" | "delete";
const API_POLICIES: Record<string, Record<string, PolicyFor>> = {
  ...Object.fromEntries(SCOPED.map(table => [table, {[table + "_capability"]: "all"}])),
  hv_budget_accounts: {hv_budget_accounts_api_read: "select", hv_budget_accounts_api_insert: "insert", hv_budget_accounts_api_update: "update"},
  hv_reservations: {hv_reservations_api_read: "select", hv_reservations_api_admit: "insert"},
  hv_cost_events: {hv_cost_events_api_read: "select"}, hv_workers: {hv_workers_api_read: "select"}, hv_operator_reviews: {},
  hv_crew_events: {hv_crew_events_api_read: "select", hv_crew_events_api_insert: "insert"},
  hv_crew_budget: {hv_crew_budget_api_read: "select", hv_crew_budget_api_insert: "insert", hv_crew_budget_api_update: "update"},
};
const TABLES = Object.keys(API_PRIVILEGES).sort();
const roles = (to: unknown): string[] => (Array.isArray(to) ? to : [to]).map(value => typeof value === "string" ? value : (value as {name: string}).name);
const declared = () => Object.values(schema).filter(value => is(value, PgTable)).map(table => {
  const config = getTableConfig(table);
  return {name: config.name, enableRLS: config.enableRLS, policies: config.policies.map(policy => ({name: policy.name, for: policy.for ?? "all", to: roles(policy.to)}))};
});

test("schema.ts declares forced row security and a policy per role and command on every hv_* table", () => {
  const tables = declared();
  expect(tables.map(table => table.name).sort()).toEqual(TABLES);
  for (const table of tables) {
    expect(table.enableRLS).toBe(true);
    expect(table.policies.some(policy => policy.to.includes("hv_worker") && policy.for === "all")).toBe(true);
    const api = Object.fromEntries(table.policies.filter(policy => policy.to.includes("hv_api")).map(policy => [policy.name, policy.for]));
    expect(api).toEqual(API_POLICIES[table.name]!);
  }
  expect(getTableConfig(schema.reservations).columns.find(column => column.name === "project_id")?.notNull).toBe(false);
  expect(schema.reservations.projectId.name).toBe("project_id");
});

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_API_DATABASE_URL && process.env.HV_WORKER_DATABASE_URL);
const pgtest = enabled ? test : test.skip;
const projectA = crypto.randomUUID(), projectB = crypto.randomUUID(), workerId = "capability-fixture-" + crypto.randomUUID();
const jobIds: string[] = [], projectIds: string[] = [projectA, projectB];
const job = () => { const value = crypto.randomUUID(); jobIds.push(value); return value; };
let admin: StudioDatabase, api: StudioDatabase, worker: StudioDatabase, priorCap: string | null = null;
interface Refusal { statement: string; role: "hv_api" | "hv_worker"; scoped: boolean; afterScopedTransaction?: true; sqlstate: string }
const refusals: Refusal[] = [];
const sqlstate = (error: unknown): string => {
  const value = error as {errno?: unknown; code?: unknown; message?: string};
  for (const candidate of [value.errno, value.code]) if (typeof candidate === "string" && /^[0-9A-Z]{5}$/.test(candidate)) return candidate;
  return /row-level security|permission denied/i.test(value.message ?? "") ? "42501" : String(value.code ?? value.message);
};
/** Runs a statement expected to fail with SQLSTATE 42501 (insufficient_privilege) and records the observation. */
const refused = async (statement: string, role: Refusal["role"], scoped: boolean, run: () => Promise<unknown>, afterScopedTransaction = false): Promise<void> => {
  let observed = "no error";
  try { await run(); } catch (error) { observed = sqlstate(error); }
  refusals.push({statement, role, scoped, ...(afterScopedTransaction ? {afterScopedTransaction: true as const} : {}), sqlstate: observed});
  expect({statement, sqlstate: observed}).toEqual({statement, sqlstate: "42501"});
};
const hold = (tx: SQL, jobId: string, projectId: string | null, remaining = 0) =>
  tx`insert into hv_reservations (job_id, stage, amount_usd, remaining_usd, body, created_at, project_id)
    values (${jobId}, 'animatic', ${remaining}, ${remaining}, ${{jobId, stage: "animatic", amountUsd: remaining, remainingUsd: remaining}}::jsonb, now(), ${projectId})`;

beforeAll(async () => {
  if (!enabled) return;
  admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!);
  api = new StudioDatabase(process.env.HV_API_DATABASE_URL!, 1); // one pooled connection: a scoped transaction is always followed by an unscoped statement on the same session
  worker = new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!);
  await admin.migrate();
  priorCap = (await admin.sql`select monthly_cap_usd from hv_budget_accounts where id = 'operator'`)[0]?.monthly_cap_usd ?? null;
  // The refusal cases need the singleton to exist (an UPDATE that matches no row raises nothing); seed it only when absent, with the ledger's own default, and remove it in afterAll.
  if (priorCap === null) await admin.sql`insert into hv_budget_accounts (id, monthly_cap_usd) values ('operator', ${Number(process.env.HV_MONTHLY_BUDGET_USD ?? 5000)}) on conflict (id) do nothing`;
});
afterAll(async () => {
  if (!enabled) return;
  for (const value of jobIds) await admin.sql`delete from hv_reservations where job_id = ${value}`;
  for (const id of projectIds) {
    for (const table of ["hv_cost_events", "hv_operator_reviews", "hv_outbox", "hv_jobs", "hv_reviews"]) await admin.sql.unsafe("delete from " + table + " where project_id = $1", [id]);
    await admin.sql`delete from hv_projects where id = ${id}`;
  }
  await admin.sql`delete from hv_workers where id = ${workerId}`;
  if (priorCap !== null) await admin.sql`update hv_budget_accounts set monthly_cap_usd = ${priorCap} where id = 'operator'`;
  else await admin.sql`delete from hv_budget_accounts where id = 'operator'`;
  await Promise.all([admin.close(), api.close(), worker.close()]);
});

interface CatalogRow { table: string; rls: boolean; forced: boolean; policies: {name: string; cmd: string; roles: string[]}[]; privileges: Record<string, Record<Command, boolean>> }
const catalog = async (): Promise<CatalogRow[]> => admin.sql`select c.relname as "table", c.relrowsecurity as rls, c.relforcerowsecurity as forced,
    (select coalesce(json_agg(json_build_object('name', p.policyname, 'cmd', p.cmd, 'roles', p.roles) order by p.policyname), '[]'::json)
      from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies,
    (select json_object_agg(grantee, json_build_object(
      'SELECT', has_table_privilege(grantee, c.oid, 'SELECT'), 'INSERT', has_table_privilege(grantee, c.oid, 'INSERT'),
      'UPDATE', has_table_privilege(grantee, c.oid, 'UPDATE'), 'DELETE', has_table_privilege(grantee, c.oid, 'DELETE')))
      from unnest(array['hv_api', 'hv_worker', 'public']) as grantee) as privileges
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'hv\\_%' order by c.relname` as unknown as Promise<CatalogRow[]>;

pgtest("every hv_* table forces row security and every granted command is covered by a policy for that role", async () => {
  const rows = await catalog();
  expect(rows.map(row => row.table)).toEqual(TABLES);
  const bySchema = Object.fromEntries(declared().map(table => [table.name, table]));
  for (const row of rows) {
    expect({table: row.table, rls: row.rls, forced: row.forced}).toEqual({table: row.table, rls: true, forced: true});
    for (const role of ["hv_api", "hv_worker"] as const) for (const command of COMMANDS) if (row.privileges[role]![command])
      expect({table: row.table, role, command, covered: row.policies.some(policy => policy.roles.includes(role) && (policy.cmd === command || policy.cmd === "ALL"))})
        .toEqual({table: row.table, role, command, covered: true});
    expect({table: row.table, publicPrivileges: COMMANDS.filter(command => row.privileges.public![command])}).toEqual({table: row.table, publicPrivileges: []});
    expect({table: row.table, api: COMMANDS.filter(command => row.privileges.hv_api![command])}).toEqual({table: row.table, api: API_PRIVILEGES[row.table]!});
    expect({table: row.table, policies: row.policies.map(policy => policy.name)}).toEqual({table: row.table, policies: bySchema[row.table]!.policies.map(policy => policy.name).sort()});
  }
  const dbRoles = await admin.sql`select rolname, rolsuper, rolbypassrls from pg_roles where rolname in ('hv_api', 'hv_worker') order by rolname`;
  expect(dbRoles).toEqual([{rolname: "hv_api", rolsuper: false, rolbypassrls: false}, {rolname: "hv_worker", rolsuper: false, rolbypassrls: false}]);
});

pgtest("hv_api cannot write the accounting tables outside a validated scope, including after a scoped transaction on the same session", async () => {
  const upsert = "insert into hv_budget_accounts (id, monthly_cap_usd) values ('operator', 5000) on conflict (id) do nothing";
  const check = async (afterScopedTransaction: boolean) => {
    await refused(upsert, "hv_api", false, () => api.sql`insert into hv_budget_accounts (id, monthly_cap_usd) values ('operator', 5000) on conflict (id) do nothing`, afterScopedTransaction);
    await refused("update hv_budget_accounts set updated_at = updated_at where id = 'operator'", "hv_api", false, () => api.sql`update hv_budget_accounts set updated_at = updated_at where id = 'operator'`, afterScopedTransaction);
    await refused("insert into hv_reservations (…, project_id) values (…, A)", "hv_api", false, () => hold(api.sql, job(), projectA), afterScopedTransaction);
    // '' must never match: after a scoped transaction the pooled session reads the setting as '' rather than NULL.
    await refused("insert into hv_reservations (…, project_id) values (…, '')", "hv_api", false, () => hold(api.sql, job(), ""), afterScopedTransaction);
  };
  expect((await api.sql`select current_setting('hv.project_id', true) as scope`)[0].scope).toBeNull();
  await check(false);
  await api.forProject(projectA, async tx => { await tx`select 1`; });
  expect((await api.sql`select current_setting('hv.project_id', true) as scope`)[0].scope).toBe(""); // the setting outlives the transaction as '' on a pooled session
  await check(true);
});

pgtest("inside forProject(A) hv_api upserts the singleton budget row and admits only holds bound to A; update and delete stay revoked", async () => {
  const jobA = job();
  await api.forProject(projectA, async tx => {
    await tx`insert into hv_budget_accounts (id, monthly_cap_usd) values ('operator', 5000) on conflict (id) do nothing`;
    expect(await tx`select monthly_cap_usd from hv_budget_accounts where id = 'operator' for update`).toHaveLength(1);
    const touched = await tx`update hv_budget_accounts set updated_at = updated_at where id = 'operator'`;
    expect(touched.count).toBe(1);
    expect((await hold(tx, jobA, projectA)).count).toBe(1);
  });
  expect((await admin.sql`select project_id from hv_reservations where job_id = ${jobA}`)[0].project_id).toBe(projectA);
  await refused("insert into hv_reservations (…, project_id) values (…, B)", "hv_api", true, () => api.forProject(projectA, tx => hold(tx, job(), projectB)));
  await refused("insert into hv_reservations (…, project_id) values (…, NULL)", "hv_api", true, () => api.forProject(projectA, tx => hold(tx, job(), null)));
  await refused("insert into hv_reservations (…, project_id) values (…, '')", "hv_api", true, () => api.forProject(projectA, tx => hold(tx, job(), "")));
  await refused("update hv_reservations set remaining_usd = 0 where job_id = …", "hv_api", true, () => api.forProject(projectA, tx => tx`update hv_reservations set remaining_usd = 0 where job_id = ${jobA}`));
  await refused("delete from hv_reservations where job_id = …", "hv_api", true, () => api.forProject(projectA, tx => tx`delete from hv_reservations where job_id = ${jobA}`));
  await refused("delete from hv_budget_accounts where id = 'operator'", "hv_api", true, () => api.forProject(projectA, tx => tx`delete from hv_budget_accounts where id = 'operator'`));
  expect(await admin.sql`select job_id from hv_reservations where job_id = ${jobA}`).toHaveLength(1); // the refused update and delete left the hold intact
});

pgtest("hv_api reads the budget row and every hold unscoped, and holds no privilege it lacks a policy for", async () => {
  const seededA = job(), seededB = job();
  await hold(admin.sql, seededA, projectA, 0.02); await hold(admin.sql, seededB, projectB, 0.01);
  expect(await api.sql`select monthly_cap_usd from hv_budget_accounts where id = 'operator'`).toHaveLength(1);
  expect(Number((await api.sql`select coalesce(sum(remaining_usd), 0) as held from hv_reservations where job_id in ${api.sql([seededA, seededB])}`)[0].held)).toBeCloseTo(0.03, 6);
  await api.sql`select id from hv_cost_events limit 1`;
  await api.sql`select id from hv_workers limit 1`;
  await refused("select id from hv_operator_reviews", "hv_api", false, () => api.sql`select id from hv_operator_reviews limit 1`);
  await refused("insert into hv_cost_events (…)", "hv_api", false, () => api.sql`insert into hv_cost_events (id, event_key, project_id, provider, total_usd, body, created_at)
    values (${crypto.randomUUID()}, ${crypto.randomUUID()}, ${projectA}, 'fixture', 0, '{}'::jsonb, now())`);
  await refused("insert into hv_workers (…)", "hv_api", false, () => api.sql`insert into hv_workers (id, classes, body) values (${workerId}, '[]'::jsonb, '{}'::jsonb)`);
});

pgtest("hv_worker keeps unconditional access to reservations, workers, operator reviews and cost events", async () => {
  const jobW = job(), reviewId = crypto.randomUUID();
  expect((await hold(worker.sql, jobW, null)).count).toBe(1);
  const updated = await worker.sql`update hv_reservations set body = body where job_id = ${jobW}`, deleted = await worker.sql`delete from hv_reservations where job_id = ${jobW}`;
  expect(updated.count).toBe(1); expect(deleted.count).toBe(1);
  await worker.sql`insert into hv_workers (id, classes, body) values (${workerId}, '["animatic"]'::jsonb, '{"name":"capability-fixture"}'::jsonb)
    on conflict (id) do update set heartbeat_at = now(), body = excluded.body`;
  await worker.sql`insert into hv_operator_reviews (id, project_id, shot_id, body) values (${reviewId}, ${projectA}, 'shot-1', '{}'::jsonb)
    on conflict (id) do update set body = excluded.body, resolved_at = null`;
  const resolved = await worker.sql`update hv_operator_reviews set resolved_at = now() where id = ${reviewId} and resolved_at is null`;
  const billed = await worker.sql`insert into hv_cost_events (id, event_key, project_id, provider, total_usd, body, created_at)
    values (${crypto.randomUUID()}, ${crypto.randomUUID()}, ${projectA}, 'fixture', 0, '{}'::jsonb, now())`;
  expect(resolved.count).toBe(1); expect(billed.count).toBe(1);
  expect(await worker.sql`select id from hv_workers where id = ${workerId}`).toHaveLength(1);
});

pgtest("real hv_api admission writes project_id on the reservation and the run is recorded as evidence", async () => {
  process.env.HV_TOKEN_SECRET = "capability-coverage-fixture-secret-at-least-thirty-two-characters";
  const projects = new PostgresProjectService(api), owner = await projects.createAnonymousProject();
  projectIds.push(owner.projectId);
  const script = "EXT. GARDEN - DAY\n\nSpud waves.";
  await projects.editScript(owner.token, script); await projects.attestRights(owner.token);
  const project = (await projects.authorize(owner.token))!, id = job();
  const admitted = await new PostgresCostLedger(api).admit(owner.projectId, {id, projectId: owner.projectId, idempotencyKey: id, tier: "free", stage: "animatic",
    scriptVersion: 1, scriptText: script, direction: currentDirection(owner.projectId, project.directionHistory), rightsAttestedAt: new Date().toISOString(),
    animaticJobId: null, animaticApprovedAt: null, totalFrames: 60, costCapUsd: 1, budgetReservedUsd: 0, retryPolicy: {maxRetries: 0, backoffMs: 0}, timeoutMs: 60_000}, 500);
  expect(admitted.id).toBe(id);
  const stored = await admin.sql`select project_id from hv_reservations where job_id = ${id}`;
  expect(stored).toEqual([{project_id: owner.projectId}]);
  if (process.env.HV_CAPABILITY_COVERAGE_EVIDENCE) {
    // Record for docs/evidence/hv040-storage/capability-coverage.json; only ever written from a real run.
    const path = resolve(process.env.HV_CAPABILITY_COVERAGE_EVIDENCE);
    const tables = Object.fromEntries((await catalog()).map(row => [row.table, {rls: row.rls, forced: row.forced,
      apiPrivileges: COMMANDS.filter(command => row.privileges.hv_api![command]),
      apiPolicies: row.policies.filter(policy => policy.roles.includes("hv_api")).map(policy => policy.name + ":" + policy.cmd),
      workerPolicies: row.policies.filter(policy => policy.roles.includes("hv_worker")).map(policy => policy.name + ":" + policy.cmd)}]));
    mkdirSync(dirname(path), {recursive: true});
    writeFileSync(path, JSON.stringify({schema: "hv-capability-coverage/1", status: "recorded", recordedAt: new Date().toISOString(),
      postgresVersion: (await admin.sql`select version()`)[0].version, tables, refusals,
      admissionWritesProjectId: stored[0].project_id === owner.projectId, newProviderSpendUsd: 0}, null, 2) + "\n");
  }
});
