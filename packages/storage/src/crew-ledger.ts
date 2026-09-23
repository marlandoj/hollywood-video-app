/**
 * The crew's own budget line, in PostgreSQL (HV-030-09).
 *
 * `docs/CREW.md` named this under "Not yet": *"The crew ledger lives on one host, in a JSON file.
 * Moving it into PostgreSQL with the rest of the accounting needs a migration and is Release 2
 * work."*
 *
 * The file version guards itself with `withFileLock`, which is a lock on **one filesystem**. The
 * generation cost ledger had the same shape and moved for the same reason; the crew's did not. Two
 * API processes on two hosts could each read a spend below a threshold, each record, and each miss
 * the alert the operator is supposed to get — or both raise it and send it twice. `record` here
 * takes the budget row `FOR UPDATE`, so the crossing is decided once, by whichever transaction gets
 * the row.
 *
 * And the spend is `sum(usd)` over the events rather than a running total carried beside them. The
 * file version had to keep that total, because it drops events past five thousand and the dollars
 * must survive the drop; nothing is dropped here, so there is one number and no way for the two to
 * disagree.
 *
 * The interface is the file ledger's, returning promises. That is the same arrangement the
 * generation ledger already uses — `CostLedger` answers directly and `PostgresCostLedger` answers a
 * promise, and every caller awaits — so the crew paths take one `await` and nothing else changes.
 */
import {CREW_ALERT_THRESHOLDS_USD, CREW_DEFAULT_CEILING_USD, CrewBudgetStop, validateCrewLedger, type CrewAlert, type CrewLedgerState, type CrewSpendEvent} from "../../operator/src/crew-ledger";
import type {StudioDatabase} from "./database";

const money = (value: number) => Number(value.toFixed(6));

/**
 * The alerts column, refused rather than guessed at when it is not what it should be.
 *
 * A jsonb column written with `${JSON.stringify(value)}::jsonb` comes back a **string**, because the
 * driver JSON-encodes a string parameter before the cast sees it -- so the stored jsonb is a JSON
 * string holding a JSON array, and the array is one `JSON.parse` further away than the code thinks.
 * Measured against the staging cluster while building this: `typeof alerts === "string"`. The write
 * below passes the array itself, which is the form the rest of this package uses; this is the read
 * that says so out loud, because a ledger that quietly read its alerts as a string would re-raise
 * every threshold it had already raised.
 */
function alertsOf(value: unknown): CrewAlert[] {
  if (!Array.isArray(value)) throw new Error("The crew ledger is unreadable; the crew stays stopped until it is repaired.");
  return value as CrewAlert[];
}

/** What a crew ledger answers, whichever store is behind it. */
export interface CrewLedgerReader {
  summary(): Promise<CrewLedgerSummary> | CrewLedgerSummary;
  assertCanSpend(): Promise<void> | void;
  record(event: CrewSpendEvent): Promise<CrewAlert[]> | CrewAlert[];
  approveCeiling(usd: number): Promise<void> | void;
}
export interface CrewLedgerSummary {spentUsd: number; approvedCeilingUsd: number; alerts: CrewAlert[]; nextAlertUsd: number | null}

export class PostgresCrewLedger implements CrewLedgerReader {
  constructor(private readonly database: StudioDatabase) {}

  /**
   * The one budget row, created on first use with the default ceiling.
   *
   * `on conflict do nothing` rather than a check-then-insert, so two processes starting at once
   * cannot both create it and neither can fail on the primary key.
   */
  private async budget(tx: StudioDatabase["sql"] = this.database.sql, lock = false): Promise<{ceiling: number; alerts: CrewAlert[]}> {
    if (!lock) {
      const rows = await tx`select approved_ceiling_usd, alerts from hv_crew_budget where id = 'crew'`;
      if (rows.length) return {ceiling: Number(rows[0].approved_ceiling_usd), alerts: alertsOf(rows[0].alerts)};
      return {ceiling: CREW_DEFAULT_CEILING_USD, alerts: []};
    }
    await tx`insert into hv_crew_budget (id, approved_ceiling_usd, alerts)
      values ('crew', ${CREW_DEFAULT_CEILING_USD}, '[]'::jsonb) on conflict (id) do nothing`;
    const rows = await tx`select approved_ceiling_usd, alerts from hv_crew_budget where id = 'crew' for update`;
    return {ceiling: Number(rows[0].approved_ceiling_usd), alerts: alertsOf(rows[0].alerts)};
  }

  private async spent(tx: StudioDatabase["sql"] = this.database.sql): Promise<number> {
    return money(Number((await tx`select coalesce(sum(usd), 0) as total from hv_crew_events`)[0].total));
  }

  async summary(): Promise<CrewLedgerSummary> {
    const [{ceiling, alerts}, spentUsd] = await Promise.all([this.budget(), this.spent()]);
    return {spentUsd, approvedCeilingUsd: ceiling, alerts: structuredClone(alerts),
      nextAlertUsd: CREW_ALERT_THRESHOLDS_USD.find(threshold => threshold > spentUsd) ?? null};
  }

  async assertCanSpend(): Promise<void> {
    const [{ceiling}, spentUsd] = await Promise.all([this.budget(), this.spent()]);
    if (spentUsd >= ceiling) throw new CrewBudgetStop(spentUsd, ceiling);
  }

  async record(event: CrewSpendEvent): Promise<CrewAlert[]> {
    if (!Number.isFinite(event.usd) || event.usd < 0 || !Number.isSafeInteger(event.inputTokens) || !Number.isSafeInteger(event.outputTokens))
      throw new Error("Invalid crew spend.");
    return this.database.sql.begin(async (tx: StudioDatabase["sql"]) => {
      // The row lock comes first, so the sum below is taken with no other `record` in flight.
      const {alerts} = await this.budget(tx, true);
      await tx`insert into hv_crew_events (id, at, project_id, persona, model, input_tokens, output_tokens, usd)
        values (${crypto.randomUUID()}, ${event.at}, ${event.projectId}, ${event.persona}, ${event.model},
          ${event.inputTokens}, ${event.outputTokens}, ${money(event.usd)})`;
      const spentUsd = await this.spent(tx);
      const crossed = CREW_ALERT_THRESHOLDS_USD
        .filter(threshold => spentUsd >= threshold && !alerts.some(alert => alert.thresholdUsd === threshold))
        .map(thresholdUsd => ({thresholdUsd, at: event.at, spentUsd}));
      // The array itself, not `JSON.stringify` of it: see `alertsOf`. This is the form the rest of
      // this package writes jsonb with.
      if (crossed.length) await tx`update hv_crew_budget set alerts = ${[...alerts, ...crossed]}::jsonb where id = 'crew'`;
      return crossed;
    }) as Promise<CrewAlert[]>;
  }

  /**
   * The operator's approval to continue past the ceiling. It can only be raised, and the `where`
   * says so rather than a read followed by a write: two operators raising at once both succeed and
   * the higher one stands.
   */
  async approveCeiling(usd: number): Promise<void> {
    if (!Number.isFinite(usd)) throw new Error("A new crew ceiling must be above the current one.");
    await this.database.sql.begin(async (tx: StudioDatabase["sql"]) => {
      await this.budget(tx, true);
      const raised = await tx`update hv_crew_budget set approved_ceiling_usd = ${money(usd)}
        where id = 'crew' and approved_ceiling_usd < ${money(usd)} returning approved_ceiling_usd`;
      if (!raised.length) throw new Error("A new crew ceiling must be above the current one.");
    });
  }

  /**
   * Carry a JSON crew ledger into the database, once (HV-030-11).
   *
   * HV-030-09 moved the crew's budget line into PostgreSQL and left this behind, in its own words:
   * *"Nothing migrates an existing file ledger into the database. A deployment that has been
   * spending through the JSON ledger and then gains a database starts the crew's line at zero, and
   * its raised alerts come back."* A crew line that restarts at zero is a $1,000 ceiling that has to
   * be crossed twice and four alerts the operator is told about twice.
   *
   * Two things make this more than an insert loop:
   *
   * - **The file's `spentUsd` can exceed the sum of its own events.** It is cumulative and the file
   *   drops events past five thousand, which is exactly why the file version carries the total
   *   separately. The database has one number, `sum(usd)`, so the difference is carried across as a
   *   single event of its own — `persona: "carried-forward"` — rather than quietly lost. A ledger
   *   whose events do add up gets no such event.
   * - **It refuses a database that already holds anything.** Importing twice would double a budget
   *   line, which is the one mistake this must not make, so the check and the insert are one
   *   transaction and the check is for *any* event and *any* budget row, not for a matching one.
   */
  async importFrom(state: CrewLedgerState): Promise<{events: number; carriedForwardUsd: number; spentUsd: number}> {
    validateCrewLedger(state);
    return this.database.sql.begin(async (tx: StudioDatabase["sql"]) => {
      const held = Number((await tx`select count(*)::int as rows from hv_crew_events`)[0].rows)
        + Number((await tx`select count(*)::int as rows from hv_crew_budget`)[0].rows);
      if (held > 0) throw new Error("The crew ledger in this database is not empty, so a file ledger cannot be carried into it. Importing twice would double the crew's budget line.");
      // `state()` reads the events back ordered by `at` and then by id, and a file ledger records
      // several events in one millisecond -- so `at` alone does not keep the order they happened in.
      // The file's order is real information about the crew's spending, so the imported ids ascend
      // and carry it. Six digits is beyond the five thousand events a file ledger holds.
      const carriedId = (index: number) => "carried-" + String(index).padStart(6, "0") + "-" + crypto.randomUUID();
      for (const [index, event] of state.events.entries()) {
        await tx`insert into hv_crew_events (id, at, project_id, persona, model, input_tokens, output_tokens, usd)
          values (${carriedId(index)}, ${event.at}, ${event.projectId}, ${event.persona}, ${event.model},
            ${event.inputTokens}, ${event.outputTokens}, ${money(event.usd)})`;
      }
      const counted = money(state.events.reduce((sum, event) => sum + event.usd, 0));
      const carriedForwardUsd = money(state.spentUsd - counted);
      if (carriedForwardUsd < 0) throw new Error("This crew ledger's events add up to more than the spend it records, so it cannot be carried across without changing one of them.");
      if (carriedForwardUsd > 0) {
        // The dollars the file kept but the events could not account for, said out loud rather than
        // dropped: the file trims its events at five thousand and its total does not trim with them.
        await tx`insert into hv_crew_events (id, at, project_id, persona, model, input_tokens, output_tokens, usd)
          values (${carriedId(state.events.length)}, ${state.events.at(-1)?.at ?? new Date(0).toISOString()}, ${"carried-forward"}, ${"carried-forward"},
            ${"carried-forward"}, ${0}, ${0}, ${carriedForwardUsd})`;
      }
      await tx`insert into hv_crew_budget (id, approved_ceiling_usd, alerts)
        values ('crew', ${money(state.approvedCeilingUsd)}, ${state.alerts}::jsonb)`;
      return {events: state.events.length, carriedForwardUsd, spentUsd: money(state.spentUsd)};
    }) as Promise<{events: number; carriedForwardUsd: number; spentUsd: number}>;
  }

  /** The whole ledger, in the file ledger's own shape, for an operator readout or an export. */
  async state(): Promise<CrewLedgerState> {
    const [{ceiling, alerts}, spentUsd] = await Promise.all([this.budget(), this.spent()]);
    const rows = await this.database.sql`select at, project_id, persona, model, input_tokens, output_tokens, usd
      from hv_crew_events order by at, id`;
    return {schema: "hv-crew-ledger/1", spentUsd, approvedCeilingUsd: ceiling, alerts: structuredClone(alerts),
      // HV-030-11: `at` as the file ledger writes it. The driver hands back PostgreSQL's own rendering
      // of a timestamptz, which is not the ISO string this shape promises, so a ledger carried into
      // the database and read back did not match the one that went in.
      events: rows.map((row: Record<string, unknown>) => ({at: new Date(String(row.at)).toISOString(), projectId: String(row.project_id), persona: String(row.persona),
        model: String(row.model), inputTokens: Number(row.input_tokens), outputTokens: Number(row.output_tokens), usd: Number(row.usd)}))};
  }
}
