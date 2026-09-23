/**
 * HV-030-09 — the crew's budget line followed the generation ledger into PostgreSQL.
 *
 * `docs/CREW.md` named this under "Not yet":
 *
 *     The crew ledger lives on one host, in a JSON file. Moving it into PostgreSQL with the rest of
 *     the accounting needs a migration and is Release 2 work.
 *
 * The file version guards itself with `withFileLock`, which is a lock on **one filesystem**. Two API
 * processes on two hosts could each read a spend below a threshold, each record, and each miss the
 * alert the operator is supposed to get — or both raise it and send it twice. The generation cost
 * ledger had the same shape and moved for the same reason; the crew's did not.
 *
 * `PostgresCrewLedger.record` takes the budget row `FOR UPDATE` before it reads the spend, so the
 * crossing is decided once, by whichever transaction holds the row. The two tests below that need a
 * cluster prove exactly that, one of them with real separate processes, because a single-threaded
 * runtime cannot exhibit the race this is about.
 *
 * The spend is `sum(usd)` over the events rather than a running total beside them. The file version
 * has to carry that total because it drops events past five thousand; nothing is dropped here, so
 * there is one number and no way for the two to disagree.
 */
import {afterAll, beforeAll, expect, test} from "bun:test";
import {readFileSync, readdirSync} from "node:fs";
import {CREW_ALERT_THRESHOLDS_USD, CREW_DEFAULT_CEILING_USD, CrewBudgetStop, CrewLedger} from "../../operator/src/crew-ledger";
import {PostgresCrewLedger} from "../src/crew-ledger";
import {StudioDatabase} from "../src/database";

const root = new URL("../../../", import.meta.url).pathname;
const spend = (usd: number, at = "2026-09-23T04:00:00.000Z") =>
  ({at, projectId: "p1", persona: "producer", model: "claude-test", inputTokens: 10, outputTokens: 20, usd});

test("the tables the crew ledger needs are declared and created, and the API role is granted what it uses", () => {
  // The same agreement HV-040-08 asserts for indexes, for the two tables and the grants this adds.
  // A table created by a migration that the schema does not declare, or a policy with no grant
  // behind it, is a crew that stops on a permission error the first time it is asked to think.
  const schema = readFileSync(root + "packages/storage/src/schema.ts", "utf8");
  const migrations = readdirSync(root + "infra/drizzle").filter(name => name.endsWith(".sql")).sort()
    .map(name => readFileSync(root + "infra/drizzle/" + name, "utf8")).join("\n");
  for (const table of ["hv_crew_events", "hv_crew_budget"]) {
    expect({table, declared: schema.includes(`pgTable("${table}"`)}).toEqual({table, declared: true});
    expect({table, created: migrations.includes(`CREATE TABLE "${table}"`)}).toEqual({table, created: true});
    expect({table, rls: migrations.includes(`ALTER TABLE "${table}" FORCE ROW LEVEL SECURITY`)}).toEqual({table, rls: true});
  }
  // Every policy the migration creates for these tables names a role that has been granted the verb
  // it polices. `hv_crew_events` is append-only: no UPDATE and no DELETE, for either role.
  expect(migrations).toContain(`GRANT SELECT, INSERT ON "hv_crew_events" TO hv_api, hv_worker;`);
  expect(migrations).toContain(`GRANT SELECT, INSERT, UPDATE ON "hv_crew_budget" TO hv_api, hv_worker;`);
  expect(migrations).not.toMatch(/GRANT[^;]*DELETE[^;]*hv_crew_/);
  expect(migrations).not.toMatch(/GRANT[^;]*UPDATE[^;]*"hv_crew_events"/);
});

const enabled = Boolean(process.env.HV_PG_ADMIN_URL && process.env.HV_API_DATABASE_URL);
const pgtest = enabled ? test : test.skip;
let admin: StudioDatabase, apiRole: StudioDatabase;
beforeAll(async () => {
  if (!enabled) return;
  admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!, 4);
  apiRole = new StudioDatabase(process.env.HV_API_DATABASE_URL!, 4);
  await admin.migrate();
});
afterAll(async () => {if (enabled) {await admin.sql.end(); await apiRole.sql.end();}});
const clear = async () => {await admin.sql`delete from hv_crew_events`; await admin.sql`delete from hv_crew_budget`;};

pgtest("the PostgreSQL ledger answers what the file ledger answers, over the same sequence", async () => {
  // The equivalence, not a re-statement of the rules: the same events go into both and every answer
  // is compared. `crew-ledger.test.ts` is what says the rules are right; this is what says the move
  // did not change them.
  await clear();
  const file = new CrewLedger(), database = new PostgresCrewLedger(admin);
  const both = async (usd: number) => {
    const fromFile = file.record(spend(usd)), fromDatabase = await database.record(spend(usd));
    expect({usd, fromDatabase}).toEqual({usd, fromDatabase: fromFile});
    const summary = await database.summary();
    expect({usd, summary: {...summary, alerts: summary.alerts.map(alert => alert.thresholdUsd)}})
      .toEqual({usd, summary: {...file.summary(), alerts: file.summary().alerts.map(alert => alert.thresholdUsd)}});
  };
  for (const usd of [24.99, 0.01, 1, 200, 0.000001, 773.999999]) await both(usd);
  expect((await database.summary()).spentUsd).toBe(1000);
  // Both refuse at the ceiling, and both raise it only upward.
  await expect(database.assertCanSpend()).rejects.toThrow(CrewBudgetStop);
  expect(() => file.assertCanSpend()).toThrow(CrewBudgetStop);
  await expect(database.approveCeiling(900)).rejects.toThrow("above");
  await database.approveCeiling(1500);
  await expect(database.assertCanSpend()).resolves.toBeUndefined();
  expect((await database.summary()).approvedCeilingUsd).toBe(1500);
  // Every threshold the table declares was crossed exactly once.
  expect((await database.summary()).alerts.map(alert => alert.thresholdUsd)).toEqual([...CREW_ALERT_THRESHOLDS_USD]);
});

pgtest("and a ledger with no row yet reads as an empty one, from either role, without creating anything", async () => {
  await clear();
  const database = new PostgresCrewLedger(admin);
  expect(await database.summary()).toEqual({spentUsd: 0, approvedCeilingUsd: CREW_DEFAULT_CEILING_USD, alerts: [], nextAlertUsd: 25});
  await expect(database.assertCanSpend()).resolves.toBeUndefined();
  expect(Number((await admin.sql`select count(*)::int as budget_rows from hv_crew_budget`)[0].budget_rows)).toBe(0);
  // And the API role -- the one the crew routes actually run as -- can do each thing it needs to,
  // through its own policies and grants rather than as the owner.
  const asApi = new PostgresCrewLedger(apiRole);
  expect(await asApi.record(spend(26))).toEqual([{thresholdUsd: 25, at: "2026-09-23T04:00:00.000Z", spentUsd: 26}]);
  expect((await asApi.summary()).spentUsd).toBe(26);
  // Append-only: the grant does not include DELETE, so the API cannot unspend. Written as a catch
  // rather than `rejects`, because a query here is a lazy thenable and `rejects` does not start it.
  let denied = "";
  try { await apiRole.sql`delete from hv_crew_events`; } catch (error) { denied = (error as Error).message; }
  expect({denied: denied.includes("permission denied")}).toEqual({denied: true});
});

pgtest("and two processes recording at once cross a threshold once, not twice and not never", async () => {
  // The whole reason for the move. A file lock guards one filesystem; this is two separate
  // processes, which is what two API hosts are, and a single-threaded runtime cannot show it.
  await clear();
  const script = `
    const {PostgresCrewLedger} = await import(${JSON.stringify(root + "packages/storage/src/crew-ledger.ts")});
    const {StudioDatabase} = await import(${JSON.stringify(root + "packages/storage/src/database.ts")});
    const database = new StudioDatabase(process.env.HV_API_DATABASE_URL, 1);
    const ledger = new PostgresCrewLedger(database);
    const crossed = [];
    for (let index = 0; index < 8; index++) {
      const alerts = await ledger.record({at: new Date().toISOString(), projectId: "p1", persona: "producer",
        model: "claude-test", inputTokens: 1, outputTokens: 1, usd: 2});
      for (const alert of alerts) crossed.push(alert.thresholdUsd);
    }
    console.log(JSON.stringify(crossed));
    await database.sql.end();
  `;
  const processes = [0, 1, 2].map(() => Bun.spawn([process.execPath, "-e", script], {env: {...process.env}, stdout: "pipe", stderr: "pipe"}));
  const outputs = await Promise.all(processes.map(async child => {
    const [out, error] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({code: await child.exited, error}).toEqual({code: 0, error: ""});
    return JSON.parse(out.trim()) as number[];
  }));
  // Twenty-four records of two dollars is forty-eight: the twenty-five threshold, and only it.
  expect((await new PostgresCrewLedger(admin).summary()).spentUsd).toBe(48);
  expect(outputs.flat()).toEqual([25]);
  expect((await new PostgresCrewLedger(admin).summary()).alerts.map(alert => alert.thresholdUsd)).toEqual([25]);
});

pgtest("and the whole ledger reads back in the file ledger's own shape", async () => {
  await clear();
  const database = new PostgresCrewLedger(admin);
  await database.record(spend(1, "2026-09-23T04:00:00.000Z"));
  await database.record({...spend(2, "2026-09-23T05:00:00.000Z"), persona: "crew-plan", projectId: "p2"});
  const state = await database.state();
  expect({schema: state.schema, spentUsd: state.spentUsd, ceiling: state.approvedCeilingUsd, count: state.events.length})
    .toEqual({schema: "hv-crew-ledger/1", spentUsd: 3, ceiling: CREW_DEFAULT_CEILING_USD, count: 2});
  expect(state.events.map(event => [event.projectId, event.persona, event.usd, event.inputTokens, event.outputTokens]))
    .toEqual([["p1", "producer", 1, 10, 20], ["p2", "crew-plan", 2, 10, 20]]);
  // It holds token counts and dollars, never prompts or answers -- which is what the file ledger's
  // own header promises and what the columns here are.
  const columns = (await admin.sql`select column_name from information_schema.columns where table_name = 'hv_crew_events' order by column_name`)
    .map((row: {column_name: string}) => row.column_name);
  expect(columns).toEqual(["at", "id", "input_tokens", "model", "output_tokens", "persona", "project_id", "usd"]);
});
