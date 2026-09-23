/**
 * HV-030-11 — a crew ledger that had been spending on one host, carried into the database.
 *
 * HV-030-09 moved the crew's budget line into PostgreSQL and left this behind, in its own words:
 *
 *     Nothing migrates an existing file ledger into the database. A deployment that has been
 *     spending through the JSON ledger and then gains a database starts the crew's line at zero, and
 *     its raised alerts come back.
 *
 * A crew line that restarts at zero is a $1,000 ceiling that has to be crossed twice, and four
 * alerts the operator is told about a second time. Staging's crew line is at $0 today, which is why
 * this could wait a night; it is not a gap that stays harmless.
 *
 * Two things make this more than an insert loop, and they are what these tests are about:
 *
 * - **The file's `spentUsd` can exceed the sum of its own events.** It is cumulative and the file
 *   drops events past five thousand, which is exactly why the file version carries the total
 *   separately. The database has one number, `sum(usd)`, so the difference is carried across as a
 *   single `carried-forward` event rather than quietly lost.
 * - **Importing twice would double a budget line.** The check for an empty ledger and the insert are
 *   one transaction, and the check is for *any* event and *any* budget row.
 */
import {afterAll, beforeAll, expect, test} from "bun:test";
import {CREW_ALERT_THRESHOLDS_USD, CrewLedger, validateCrewLedger, type CrewLedgerState} from "../../operator/src/crew-ledger";
import {PostgresCrewLedger} from "../src/crew-ledger";
import {StudioDatabase} from "../src/database";

const event = (usd: number, at = "2026-09-23T04:00:00.000Z") =>
  ({at, projectId: "p1", persona: "producer", model: "claude-test", inputTokens: 10, outputTokens: 20, usd});

/** A file ledger's state, built the way the file ledger builds one. */
const ledgerOf = (amounts: number[], extra: Partial<CrewLedgerState> = {}): CrewLedgerState => {
  const file = new CrewLedger();
  for (const usd of amounts) file.record(event(usd));
  const summary = file.summary();
  return {schema: "hv-crew-ledger/1", spentUsd: summary.spentUsd, approvedCeilingUsd: summary.approvedCeilingUsd,
    alerts: summary.alerts, events: amounts.map(usd => event(usd)), ...extra};
};

test("the file ledger's own validator is what decides whether a ledger can be carried", () => {
  // Not a claim about the import: a claim about which reader it trusts. A ledger the file ledger
  // would refuse to open is not one the database should be given either.
  const good = ledgerOf([1, 2]);
  expect(good.spentUsd).toBe(3);
  expect(validateCrewLedger(good)).toEqual(good);
  for (const broken of [{...good, schema: "hv-crew-ledger/2"}, {...good, spentUsd: -1}, {...good, approvedCeilingUsd: 10},
    {...good, alerts: [{thresholdUsd: 7, at: good.events[0]!.at, spentUsd: 7}]},
    {...good, alerts: [{thresholdUsd: 25, at: good.events[0]!.at, spentUsd: 1}]}]) {
    expect(() => validateCrewLedger(broken)).toThrow("unreadable");
  }
});

const enabled = Boolean(process.env.HV_PG_ADMIN_URL);
const pgtest = enabled ? test : test.skip;
let admin: StudioDatabase;
beforeAll(async () => {if (enabled) {admin = new StudioDatabase(process.env.HV_PG_ADMIN_URL!, 2); await admin.migrate();}});
afterAll(async () => {if (enabled) await admin.sql.end();});
const clear = async () => {await admin.sql`delete from hv_crew_events`; await admin.sql`delete from hv_crew_budget`;};

pgtest("a file ledger is carried across whole: every event, the ceiling and every alert", async () => {
  await clear();
  const file = ledgerOf([24.99, 0.01, 1, 200], {approvedCeilingUsd: 1500});
  const database = new PostgresCrewLedger(admin);
  expect(await database.importFrom(file)).toEqual({events: 4, carriedForwardUsd: 0, spentUsd: 226});
  const summary = await database.summary();
  expect({spentUsd: summary.spentUsd, ceiling: summary.approvedCeilingUsd, alerts: summary.alerts.map(alert => alert.thresholdUsd)})
    .toEqual({spentUsd: 226, ceiling: 1500, alerts: [25, 100, 200]});
  // The events are the file's events, not a summary of them -- and in the file's own order, which
  // `at` alone does not keep, because a file ledger records several events in one millisecond.
  const state = await database.state();
  expect(state.events.map(value => value.usd)).toEqual([24.99, 0.01, 1, 200]);
  // And `at` comes back as the file ledger writes it, not as PostgreSQL renders a timestamptz --
  // "the file ledger's own shape" is a claim about the strings too (HV-030-11).
  expect(state.events.every(value => value.at === "2026-09-23T04:00:00.000Z")).toBe(true);
  expect(state.events.every(value => value.persona === "producer")).toBe(true);
  // And the alerts already raised are not raised again: the next record crosses nothing.
  expect(await database.record(event(1))).toEqual([]);
});

pgtest("and dollars the file kept but its events could not account for are carried as their own event", async () => {
  // The file drops events past five thousand and its total does not drop with them. A ledger whose
  // events add to less than its spend is the ordinary state of a long-lived file, not a corrupt one.
  await clear();
  const trimmed: CrewLedgerState = {...ledgerOf([1, 2]), spentUsd: 900};
  const database = new PostgresCrewLedger(admin);
  expect(await database.importFrom(trimmed)).toEqual({events: 2, carriedForwardUsd: 897, spentUsd: 900});
  expect((await database.summary()).spentUsd).toBe(900);
  const state = await database.state();
  expect(state.events.length).toBe(3);
  const carried = state.events.find(value => value.persona === "carried-forward")!;
  expect({usd: carried.usd, tokens: [carried.inputTokens, carried.outputTokens]}).toEqual({usd: 897, tokens: [0, 0]});
  // It is one event, named for what it is, rather than a number hidden in a column nothing reads.
  expect(state.events.filter(value => value.persona === "carried-forward").length).toBe(1);
});

pgtest("and a ledger whose events add to more than its spend is refused rather than reconciled", async () => {
  await clear();
  const impossible: CrewLedgerState = {...ledgerOf([10, 10]), spentUsd: 5};
  await expect(new PostgresCrewLedger(admin).importFrom(impossible)).rejects.toThrow("add up to more than the spend it records");
  // Nothing was written: the check and the inserts are one transaction.
  expect((await admin.sql`select count(*)::int as rows from hv_crew_events`)[0].rows).toBe(0);
});

pgtest("and a database that already holds a crew ledger refuses a second import", async () => {
  // The one mistake this must not make. Both halves are checked, because either alone is enough to
  // mean the line has already started somewhere.
  await clear();
  const database = new PostgresCrewLedger(admin);
  await database.importFrom(ledgerOf([5]));
  await expect(database.importFrom(ledgerOf([5]))).rejects.toThrow("not empty");
  expect((await database.summary()).spentUsd).toBe(5);
  // A budget row with no events is still a ledger that has started.
  await admin.sql`delete from hv_crew_events`;
  await expect(database.importFrom(ledgerOf([5]))).rejects.toThrow("not empty");
  // And an event with no budget row is too.
  await clear();
  await admin.sql`insert into hv_crew_events (id, at, project_id, persona, model, input_tokens, output_tokens, usd)
    values (${crypto.randomUUID()}, now(), 'p1', 'producer', 'm', 1, 1, 1)`;
  await expect(database.importFrom(ledgerOf([5]))).rejects.toThrow("not empty");
});

pgtest("and an empty file ledger carries across as an empty one, ceiling and all", async () => {
  await clear();
  const database = new PostgresCrewLedger(admin);
  expect(await database.importFrom(ledgerOf([], {approvedCeilingUsd: 2500}))).toEqual({events: 0, carriedForwardUsd: 0, spentUsd: 0});
  const summary = await database.summary();
  expect({spent: summary.spentUsd, ceiling: summary.approvedCeilingUsd, next: summary.nextAlertUsd, alerts: summary.alerts})
    .toEqual({spent: 0, ceiling: 2500, next: CREW_ALERT_THRESHOLDS_USD[0]!, alerts: []});
});
