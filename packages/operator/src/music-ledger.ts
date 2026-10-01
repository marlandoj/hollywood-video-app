import { readJsonFile, withFileLock, writeJsonFile } from "../../queue/src/persist";
import { BudgetError, CostLedger, type CostEvent } from "./index";
import { MUSIC_VENDOR_ALERTS_USD, assertMusicVendorBudget, musicVendorAlerts } from "./music-vendor-budget";

/**
 * HV-024-11: the music line's ledger -- where a cue's hold is reserved against the $10 line (G15),
 * against the film's limit and against the month's generation cap, and settled after.
 *
 * **The line is lifetime, like the voice line** (`voiceVendorSpend` sums every cost and hold with no
 * date) and like the crew's: what counts is every cue the studio has ever admitted, at its hold while
 * it is held, at its recorded cost once settled or unreconciled, and at nothing once released (never
 * sent). So the $3 and $7 alerts are each raised **once, ever**: the crossing is computed from the
 * figure the ceiling was checked against (`musicVendorAlerts`, as the voice line does), and a
 * threshold already raised is not raised again, even if a release took the line back below it.
 *
 * **A cue's hold is also a generation hold.** The same hold is admitted to the cost ledger, against
 * the film's limit and the month's cap, in the same critical section as the line's check; its cost
 * becomes an ordinary cost event (stage `music-cue`), so the month-to-date spend, the film's spend and
 * the operator's diagnostics all count music.
 *
 * Two stores answer the same interface: this JSON file, whose lock is taken around the cost ledger's
 * own, and `PostgresMusicLedger` in packages/storage, which decides under the cost ledger's row lock
 * in one transaction. An alert is handed to `onAlert` **after** the reservation is committed, so a
 * refused or rolled-back cue raises nothing.
 *
 * A cue's id is derived from its film and its request key by the caller, so a retried request finds
 * its own cue rather than reserving a second one.
 */
export type MusicCueStatus = "held" | "unreconciled" | "settled" | "released";
export interface MusicCueRecord {
  id: string; projectId: string; at: string; provider: string; model: string;
  /** `unreconciled`: the request may have been charged and returned nothing usable. Its cost is recorded at its hold. */
  status: MusicCueStatus; heldUsd: number; actualUsd: number | null; alerts: number[]; assetId: string | null;
}
export interface MusicLineAlert { provider: string; thresholdUsd: number; committedUsd: number }
export interface MusicReservation { cue: MusicCueRecord; alerts: MusicLineAlert[]; replay: boolean }
export interface MusicReserveInput {
  id: string; projectId: string; provider: string; model: string; heldUsd: number;
  /** The music line ($10 unless the operator sets another). */
  capUsd: number;
  /** The month's generation cap and the film's limit, which the hold also counts against. */
  monthlyCapUsd: number; filmCapUsd?: number;
  /** The file store only: the film's jobs, whose holds count toward its limit. PostgreSQL reads them itself. */
  filmJobIds?: ReadonlySet<string>;
  now?: number;
}
export interface MusicLineSummary { spentUsd: number; heldUsd: number; committedUsd: number; alerts: number[] }

/** Whatever store is behind it. The file store answers directly, PostgreSQL with promises. */
export interface MusicLineLedger {
  onAlert?: (alert: MusicLineAlert) => void;
  reserve(input: MusicReserveInput): MusicReservation | Promise<MusicReservation>;
  settle(id: string, actualUsd: number, assetId: string | null): MusicCueRecord | Promise<MusicCueRecord>;
  markUnreconciled(id: string): MusicCueRecord | Promise<MusicCueRecord>;
  release(id: string): MusicCueRecord | Promise<MusicCueRecord>;
  cue(id: string): MusicCueRecord | undefined | Promise<MusicCueRecord | undefined>;
  summary(): MusicLineSummary | Promise<MusicLineSummary>;
}

const money = (value: number) => Number(value.toFixed(6));
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
export const MUSIC_COST_STAGE = "music-cue" as const;

export function validateMusicCueRecord(value: unknown): MusicCueRecord {
  const cue = value as MusicCueRecord;
  const recorded = cue?.status === "settled" || cue?.status === "unreconciled";
  if (!cue || typeof cue !== "object" || ![cue.id, cue.projectId].every(v => typeof v === "string" && ID.test(v))
    || typeof cue.at !== "string" || !Number.isFinite(Date.parse(cue.at))
    || typeof cue.provider !== "string" || !cue.provider || typeof cue.model !== "string"
    || !["held", "unreconciled", "settled", "released"].includes(cue.status)
    || !Number.isFinite(cue.heldUsd) || cue.heldUsd < 0
    || (recorded ? !Number.isFinite(cue.actualUsd) || cue.actualUsd! < 0 || cue.actualUsd! > cue.heldUsd + 1e-9 : cue.actualUsd !== null)
    || cue.status === "unreconciled" && cue.actualUsd !== cue.heldUsd
    || !Array.isArray(cue.alerts) || cue.alerts.some(t => !MUSIC_VENDOR_ALERTS_USD.includes(t))
    || !(cue.assetId === null || typeof cue.assetId === "string" && ID.test(cue.assetId)))
    throw new BudgetError("The music ledger is unreadable; no cue is admitted until it is repaired.");
  return cue;
}

/** What a cue commits to the line: its hold until it ends, its recorded cost after, nothing if it was never sent. */
export function musicCueCommittedUsd(cue: MusicCueRecord): number {
  return cue.status === "released" ? 0 : cue.status === "held" ? cue.heldUsd : cue.actualUsd!;
}

/** The cost event a settled or unreconciled cue becomes in the generation cost ledger. */
export function musicCostEvent(cue: MusicCueRecord, at = new Date().toISOString()): CostEvent {
  return {eventId: "music:" + cue.id, at, projectId: cue.projectId, shotId: MUSIC_COST_STAGE, jobId: cue.id, stage: MUSIC_COST_STAGE,
    provider: cue.provider, model: cue.model, prompt_tokens: 0, output_frames: 0, gpu_seconds: 0, total_cost_usd: cue.actualUsd ?? 0};
}

/**
 * The line's decision, for both stores: given every cue, check the line and name the alerts this cue
 * raises. The store calls it with its lock held, then admits the generation hold, then writes the cue.
 */
export function planMusicReservation(cues: MusicCueRecord[], input: MusicReserveInput, now: number): {cue: MusicCueRecord; alerts: MusicLineAlert[]} {
  if (![input.id, input.projectId].every(v => typeof v === "string" && ID.test(v)) || !input.provider || !Number.isFinite(input.heldUsd) || input.heldUsd <= 0)
    throw new BudgetError("Invalid music cue reservation.");
  const {spentUsd, heldUsd} = summarizeMusicCues(cues), before = money(spentUsd + heldUsd);
  assertMusicVendorBudget({provider: input.provider, spentUsd, heldUsd, capUsd: input.capUsd}, input.heldUsd);
  const raised = new Set(cues.flatMap(c => c.alerts));
  const thresholds = musicVendorAlerts(before, input.heldUsd).filter(t => !raised.has(t));
  const cue: MusicCueRecord = {id: input.id, projectId: input.projectId, at: new Date(now).toISOString(), provider: input.provider, model: input.model,
    status: "held", heldUsd: money(input.heldUsd), actualUsd: null, alerts: thresholds, assetId: null};
  return {cue, alerts: thresholds.map(thresholdUsd => ({provider: input.provider, thresholdUsd, committedUsd: money(before + input.heldUsd)}))};
}

/** The next state of a cue, for both stores. Repeating the same transition is a replay. */
export function nextMusicCue(cue: MusicCueRecord, action: {settle: number; assetId: string | null} | "unreconciled" | "release"): MusicCueRecord {
  if (action === "release") {
    if (cue.status === "released") return cue;
    if (cue.status !== "held") throw new BudgetError("Only a cue that was never sent can release its hold.");
    return {...cue, status: "released"};
  }
  if (action === "unreconciled") {
    if (cue.status === "unreconciled") return cue;
    if (cue.status !== "held") throw new BudgetError("This music cue was already settled.");
    return {...cue, status: "unreconciled", actualUsd: cue.heldUsd};
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

export function summarizeMusicCues(cues: MusicCueRecord[]): MusicLineSummary {
  const spentUsd = money(cues.filter(c => c.status === "settled" || c.status === "unreconciled").reduce((sum, c) => sum + c.actualUsd!, 0));
  const heldUsd = money(cues.filter(c => c.status === "held").reduce((sum, c) => sum + c.heldUsd, 0));
  return {spentUsd, heldUsd, committedUsd: money(spentUsd + heldUsd), alerts: [...new Set(cues.flatMap(c => c.alerts))].sort((a, b) => a - b)};
}

interface MusicLedgerState { schema: "hv-music-ledger/2"; cues: MusicCueRecord[] }
const empty = (): MusicLedgerState => ({schema: "hv-music-ledger/2", cues: []});

export class MusicLedger implements MusicLineLedger {
  onAlert?: (alert: MusicLineAlert) => void;
  /** `costs` is the studio's generation cost ledger; its lock is always taken inside this one's, never the other way. */
  constructor(private readonly path?: string, private readonly costs: CostLedger = new CostLedger(), private memory: MusicLedgerState = empty()) {}

  private read(): MusicLedgerState {
    if (!this.path) return structuredClone(this.memory);
    // As the crew ledger learned (HV-038-06): a file that will not parse is not an empty ledger.
    let raw: unknown;
    try { raw = readJsonFile<unknown>(this.path); }
    catch { throw new BudgetError("The music ledger is unreadable; no cue is admitted until it is repaired."); }
    if (raw === null) return empty();
    const state = raw as MusicLedgerState;
    if (state?.schema !== "hv-music-ledger/2" || !Array.isArray(state.cues)) throw new BudgetError("The music ledger is unreadable; no cue is admitted until it is repaired.");
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
      const planned = planMusicReservation(state.cues, input, now);
      // The generation hold, under the cost ledger's lock, inside this one: a refusal there writes nothing here.
      this.costs.admitHold({id: input.id, stage: MUSIC_COST_STAGE, amountUsd: planned.cue.heldUsd, projectId: input.projectId, provider: input.provider,
        monthlyCapUsd: input.monthlyCapUsd, filmCapUsd: input.filmCapUsd, filmJobIds: input.filmJobIds}, new Date(now));
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
      const current = state.cues[index]!, next = nextMusicCue(current, action);
      if (next === current) return current;
      // The hold ends in the cost ledger as the cue ends here: its cost recorded once, its hold gone.
      this.costs.settleHold(id, next.status === "released" ? undefined : musicCostEvent(next));
      state.cues[index] = next; this.write(state);
      return next;
    });
  }
  settle(id: string, actualUsd: number, assetId: string | null): MusicCueRecord { return this.transition(id, {settle: actualUsd, assetId}); }
  markUnreconciled(id: string): MusicCueRecord { return this.transition(id, "unreconciled"); }
  release(id: string): MusicCueRecord { return this.transition(id, "release"); }
  cue(id: string): MusicCueRecord | undefined { return this.read().cues.find(cue => cue.id === id); }
  summary(): MusicLineSummary { return summarizeMusicCues(this.read().cues); }
}
