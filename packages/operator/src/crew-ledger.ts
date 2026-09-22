import { readJsonFile, withFileLock, writeJsonFile } from "../../queue/src/persist";

/**
 * The crew's own budget line (G13-202609192200). It is separate from the generation
 * cost ledger and its $500 cap. The operator is alerted as cumulative crew spend
 * crosses each threshold, and the crew stops at the approved ceiling ($1,000 unless
 * the operator approves more) until the operator raises it.
 *
 * It is a JSON file beside the other runtime state (HV_CREW_LEDGER_PATH), guarded by
 * the same interprocess file lock the cost ledger uses. It holds token counts and
 * dollars, never prompts or answers.
 */
export const CREW_ALERT_THRESHOLDS_USD: readonly number[] = Object.freeze([25, 100, 200, 1000]);
export const CREW_DEFAULT_CEILING_USD = 1000;
const MAX_EVENTS = 5000;

export interface CrewSpendEvent {
  at: string; projectId: string; persona: string; model: string; inputTokens: number; outputTokens: number; usd: number;
}
export interface CrewAlert { thresholdUsd: number; at: string; spentUsd: number }
export interface CrewLedgerState {
  schema: "hv-crew-ledger/1";
  /** Cumulative spend; kept even when old events are trimmed. */
  spentUsd: number;
  approvedCeilingUsd: number;
  alerts: CrewAlert[];
  events: CrewSpendEvent[];
}

export class CrewBudgetStop extends Error {
  override name = "CrewBudgetStop";
  constructor(readonly spentUsd: number, readonly ceilingUsd: number) {
    super("The crew has reached its approved budget of $" + ceilingUsd.toFixed(0) + ". The studio operator must approve more before the crew can continue.");
  }
}

const empty = (): CrewLedgerState => ({schema: "hv-crew-ledger/1", spentUsd: 0, approvedCeilingUsd: CREW_DEFAULT_CEILING_USD, alerts: [], events: []});

export function validateCrewLedger(value: unknown): CrewLedgerState {
  const state = value as CrewLedgerState;
  if (!state || state.schema !== "hv-crew-ledger/1" || !Number.isFinite(state.spentUsd) || state.spentUsd < 0
    || !Number.isFinite(state.approvedCeilingUsd) || state.approvedCeilingUsd < CREW_DEFAULT_CEILING_USD
    || !Array.isArray(state.alerts) || !Array.isArray(state.events) || state.events.length > MAX_EVENTS
    || state.alerts.some(alert => !CREW_ALERT_THRESHOLDS_USD.includes(alert.thresholdUsd) || alert.spentUsd < alert.thresholdUsd)
    || new Set(state.alerts.map(alert => alert.thresholdUsd)).size !== state.alerts.length)
    throw new Error("The crew ledger is unreadable; the crew stays stopped until it is repaired.");
  return state;
}

export class CrewLedger {
  constructor(private readonly path?: string, private memory: CrewLedgerState = empty()) {}

  private read(): CrewLedgerState {
    if (!this.path) return this.memory;
    // HV-038-06: `raw === null` meant "no ledger yet" *and* "a ledger that will not parse", so a
    // truncated file forgot every dollar the crew had spent, re-armed every alert and lifted the
    // approved ceiling's stop. `validateCrewLedger` has always had the right answer for a ledger it
    // cannot read; the parse failure never reached it.
    let raw: unknown;
    try { raw = readJsonFile<unknown>(this.path); }
    catch { throw new Error("The crew ledger is unreadable; the crew stays stopped until it is repaired."); }
    return raw === null ? empty() : validateCrewLedger(raw);
  }
  private write(state: CrewLedgerState): void {
    if (this.path) writeJsonFile(this.path, state); else this.memory = state;
  }
  private locked<T>(fn: () => T): T { return this.path ? withFileLock(this.path, fn) : fn(); }

  summary(): {spentUsd: number; approvedCeilingUsd: number; alerts: CrewAlert[]; nextAlertUsd: number | null} {
    const state = this.read();
    return {spentUsd: state.spentUsd, approvedCeilingUsd: state.approvedCeilingUsd, alerts: structuredClone(state.alerts),
      nextAlertUsd: CREW_ALERT_THRESHOLDS_USD.find(threshold => threshold > state.spentUsd) ?? null};
  }

  /** Refuses before a call is made once the approved ceiling is reached. */
  assertCanSpend(): void {
    const state = this.read();
    if (state.spentUsd >= state.approvedCeilingUsd) throw new CrewBudgetStop(state.spentUsd, state.approvedCeilingUsd);
  }

  /** Records a completed call and returns the alerts it crossed, so the caller can raise them. */
  record(event: CrewSpendEvent): CrewAlert[] {
    if (!Number.isFinite(event.usd) || event.usd < 0 || !Number.isSafeInteger(event.inputTokens) || !Number.isSafeInteger(event.outputTokens))
      throw new Error("Invalid crew spend.");
    return this.locked(() => {
      const state = this.read();
      const spentUsd = Number((state.spentUsd + event.usd).toFixed(6));
      const crossed = CREW_ALERT_THRESHOLDS_USD.filter(threshold => spentUsd >= threshold && !state.alerts.some(alert => alert.thresholdUsd === threshold))
        .map(thresholdUsd => ({thresholdUsd, at: event.at, spentUsd}));
      this.write({...state, spentUsd, alerts: [...state.alerts, ...crossed], events: [...state.events, event].slice(-MAX_EVENTS)});
      return crossed;
    });
  }

  /** The operator's approval to continue past the ceiling. It can only be raised. */
  approveCeiling(usd: number): void {
    this.locked(() => {
      const state = this.read();
      if (!Number.isFinite(usd) || usd <= state.approvedCeilingUsd) throw new Error("A new crew ceiling must be above the current one.");
      this.write({...state, approvedCeilingUsd: usd});
    });
  }
}
