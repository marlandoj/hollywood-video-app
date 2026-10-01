import { readJsonFile, withFileLock, writeJsonFile } from "../../queue/src/persist";
import { BudgetError } from "./index";
import { MUSIC_VENDOR_ALERTS_USD, assertMusicVendorBudget, musicVendorAlerts } from "./music-vendor-budget";

/**
 * HV-024-11: the music line's ledger -- where a cue's hold is reserved against the $10 line (G15),
 * settled at its actual cost, and where the $3 and $7 alerts are decided.
 *
 * The line is a **calendar month (UTC)**: what counts against it is every cue admitted in the month,
 * at its hold while it is held or unreconciled and at its cost once settled; a released cue (never
 * dispatched) counts nothing. Each alert is raised at most once a month: the crossing is computed
 * from the figure the ceiling was checked against (`musicVendorAlerts`, as the voice line does) and a
 * threshold already raised this month is not raised again, even if a release took the month back
 * below it.
 *
 * Two stores answer the same interface: this JSON file beside the other runtime state, guarded by
 * the interprocess file lock the crew ledger uses, and `PostgresMusicLedger` in packages/storage,
 * which decides under a transaction-scoped lock. Like the voice ledger, an alert is handed to
 * `onAlert` **after** the reservation is committed, so a refused or rolled-back cue raises nothing.
 *
 * A cue's id is derived from its project and its request key by the caller, so a retried request
 * finds its own cue rather than reserving a second one.
 */
export type MusicCueStatus = "held" | "unreconciled" | "settled" | "released";
export interface MusicCueRecord {
  id: string; projectId: string; at: string; month: string; provider: string; model: string;
  status: MusicCueStatus; heldUsd: number; actualUsd: number | null; alerts: number[]; assetId: string | null;
}
export interface MusicLineAlert { provider: string; thresholdUsd: number; committedUsd: number; month: string }
export interface MusicReservation { cue: MusicCueRecord; alerts: MusicLineAlert[]; replay: boolean }
export interface MusicReserveInput { id: string; projectId: string; provider: string; model: string; heldUsd: number; capUsd: number; now?: number }
export interface MusicLineSummary { month: string; spentUsd: number; heldUsd: number; committedUsd: number; alerts: number[] }

/** Whatever store is behind it. The file store answers directly, PostgreSQL with promises. */
export interface MusicLineLedger {
  onAlert?: (alert: MusicLineAlert) => void;
  reserve(input: MusicReserveInput): MusicReservation | Promise<MusicReservation>;
  settle(id: string, actualUsd: number, assetId: string | null): MusicCueRecord | Promise<MusicCueRecord>;
  markUnreconciled(id: string): MusicCueRecord | Promise<MusicCueRecord>;
  release(id: string): MusicCueRecord | Promise<MusicCueRecord>;
  cue(id: string): MusicCueRecord | undefined | Promise<MusicCueRecord | undefined>;
  summary(now?: number): MusicLineSummary | Promise<MusicLineSummary>;
}

const money = (value: number) => Number(value.toFixed(6));
export const musicMonth = (now: number) => new Date(now).toISOString().slice(0, 7);
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;

export function validateMusicCueRecord(value: unknown): MusicCueRecord {
  const cue = value as MusicCueRecord;
  if (!cue || typeof cue !== "object" || ![cue.id, cue.projectId].every(v => typeof v === "string" && ID.test(v))
    || typeof cue.at !== "string" || !Number.isFinite(Date.parse(cue.at)) || cue.month !== musicMonth(Date.parse(cue.at))
    || typeof cue.provider !== "string" || !cue.provider || typeof cue.model !== "string"
    || !["held", "unreconciled", "settled", "released"].includes(cue.status)
    || !Number.isFinite(cue.heldUsd) || cue.heldUsd < 0
    || (cue.status === "settled" ? !Number.isFinite(cue.actualUsd) || cue.actualUsd! < 0 || cue.actualUsd! > cue.heldUsd + 1e-9 : cue.actualUsd !== null)
    || !Array.isArray(cue.alerts) || cue.alerts.some(t => !MUSIC_VENDOR_ALERTS_USD.includes(t))
    || !(cue.assetId === null || typeof cue.assetId === "string" && ID.test(cue.assetId)))
    throw new BudgetError("The music ledger is unreadable; no cue is admitted until it is repaired.");
  return cue;
}

/** What a cue commits to the line: its hold until it is settled, its cost after, nothing once released. */
export function musicCueCommittedUsd(cue: MusicCueRecord): number {
  return cue.status === "settled" ? cue.actualUsd! : cue.status === "released" ? 0 : cue.heldUsd;
}

/**
 * The decision, for both stores: given the month's cues, check the line and name the alerts this
 * cue raises. The store calls it with the lock held and writes what it returns.
 */
export function planMusicReservation(month: MusicCueRecord[], input: MusicReserveInput, now: number): {cue: MusicCueRecord; alerts: MusicLineAlert[]} {
  if (![input.id, input.projectId].every(v => typeof v === "string" && ID.test(v)) || !input.provider || !Number.isFinite(input.heldUsd) || input.heldUsd <= 0)
    throw new BudgetError("Invalid music cue reservation.");
  const key = musicMonth(now);
  if (month.some(cue => cue.month !== key)) throw new BudgetError("Music cues from another month were offered to this month's line.");
  const spentUsd = money(month.filter(c => c.status === "settled").reduce((sum, c) => sum + c.actualUsd!, 0));
  const heldUsd = money(month.filter(c => c.status === "held" || c.status === "unreconciled").reduce((sum, c) => sum + c.heldUsd, 0));
  const before = money(spentUsd + heldUsd);
  assertMusicVendorBudget({provider: input.provider, spentUsd, heldUsd, capUsd: input.capUsd}, input.heldUsd);
  const raised = new Set(month.flatMap(c => c.alerts));
  const thresholds = musicVendorAlerts(before, input.heldUsd).filter(t => !raised.has(t));
  const cue: MusicCueRecord = {id: input.id, projectId: input.projectId, at: new Date(now).toISOString(), month: key, provider: input.provider, model: input.model,
    status: "held", heldUsd: money(input.heldUsd), actualUsd: null, alerts: thresholds, assetId: null};
  return {cue, alerts: thresholds.map(thresholdUsd => ({provider: input.provider, thresholdUsd, committedUsd: money(before + input.heldUsd), month: key}))};
}

/** The next state of a cue, for both stores. Settling twice with the same figures is a replay. */
export function nextMusicCue(cue: MusicCueRecord, action: {settle: number; assetId: string | null} | "unreconciled" | "release"): MusicCueRecord {
  if (action === "release") {
    if (cue.status === "released") return cue;
    if (cue.status !== "held") throw new BudgetError("Only a cue that was never sent can release its hold.");
    return {...cue, status: "released"};
  }
  if (action === "unreconciled") {
    if (cue.status === "unreconciled") return cue;
    if (cue.status !== "held") throw new BudgetError("This music cue was already settled.");
    return {...cue, status: "unreconciled"};
  }
  const actual = money(action.settle);
  if (!Number.isFinite(actual) || actual < 0 || actual > cue.heldUsd + 1e-9) throw new BudgetError("A music cue settles at no more than its hold.");
  if (action.assetId !== null && !ID.test(action.assetId)) throw new BudgetError("Invalid music cue asset.");
  if (cue.status === "settled") {
    if (cue.actualUsd === actual && cue.assetId === action.assetId) return cue;
    throw new BudgetError("This music cue was already settled.");
  }
  if (cue.status !== "held") throw new BudgetError("This music cue cannot be settled from " + cue.status + ".");
  return {...cue, status: "settled", actualUsd: actual, assetId: action.assetId};
}

export function summarizeMusicMonth(month: MusicCueRecord[], key: string): MusicLineSummary {
  const spentUsd = money(month.filter(c => c.status === "settled").reduce((sum, c) => sum + c.actualUsd!, 0));
  const heldUsd = money(month.filter(c => c.status === "held" || c.status === "unreconciled").reduce((sum, c) => sum + c.heldUsd, 0));
  return {month: key, spentUsd, heldUsd, committedUsd: money(spentUsd + heldUsd), alerts: [...new Set(month.flatMap(c => c.alerts))].sort((a, b) => a - b)};
}

interface MusicLedgerState { schema: "hv-music-ledger/1"; cues: MusicCueRecord[] }
const empty = (): MusicLedgerState => ({schema: "hv-music-ledger/1", cues: []});

export class MusicLedger implements MusicLineLedger {
  onAlert?: (alert: MusicLineAlert) => void;
  constructor(private readonly path?: string, private memory: MusicLedgerState = empty()) {}

  private read(): MusicLedgerState {
    if (!this.path) return structuredClone(this.memory);
    // As the crew ledger learned (HV-038-06): a file that will not parse is not an empty ledger.
    let raw: unknown;
    try { raw = readJsonFile<unknown>(this.path); }
    catch { throw new BudgetError("The music ledger is unreadable; no cue is admitted until it is repaired."); }
    if (raw === null) return empty();
    const state = raw as MusicLedgerState;
    if (state?.schema !== "hv-music-ledger/1" || !Array.isArray(state.cues)) throw new BudgetError("The music ledger is unreadable; no cue is admitted until it is repaired.");
    state.cues.forEach(validateMusicCueRecord);
    return state;
  }
  private write(state: MusicLedgerState): void { if (this.path) writeJsonFile(this.path, state); else this.memory = structuredClone(state); }
  private locked<T>(fn: () => T): T { return this.path ? withFileLock(this.path, fn) : fn(); }

  reserve(input: MusicReserveInput): MusicReservation {
    const now = input.now ?? Date.now();
    const result = this.locked(() => {
      const state = this.read(), existing = state.cues.find(cue => cue.id === input.id);
      if (existing) {
        if (existing.projectId !== input.projectId) throw new BudgetError("This music cue belongs to another film.");
        return {cue: existing, alerts: [], replay: true};
      }
      const planned = planMusicReservation(state.cues.filter(cue => cue.month === musicMonth(now)), input, now);
      this.write({...state, cues: [...state.cues, planned.cue]});
      return {...planned, replay: false};
    });
    // After the write, never inside it: a refused cue raises nothing.
    for (const alert of result.alerts) this.onAlert?.(alert);
    return result;
  }
  private transition(id: string, action: Parameters<typeof nextMusicCue>[1]): MusicCueRecord {
    return this.locked(() => {
      const state = this.read(), index = state.cues.findIndex(cue => cue.id === id);
      if (index < 0) throw new BudgetError("Unknown music cue.");
      const next = nextMusicCue(state.cues[index]!, action);
      state.cues[index] = next; this.write(state);
      return next;
    });
  }
  settle(id: string, actualUsd: number, assetId: string | null): MusicCueRecord { return this.transition(id, {settle: actualUsd, assetId}); }
  markUnreconciled(id: string): MusicCueRecord { return this.transition(id, "unreconciled"); }
  release(id: string): MusicCueRecord { return this.transition(id, "release"); }
  cue(id: string): MusicCueRecord | undefined { return this.read().cues.find(cue => cue.id === id); }
  summary(now = Date.now()): MusicLineSummary {
    const key = musicMonth(now);
    return summarizeMusicMonth(this.read().cues.filter(cue => cue.month === key), key);
  }
}
