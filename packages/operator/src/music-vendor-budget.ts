import { BudgetError } from "./index";

/**
 * The generated-music line (G15, approved 2026-09-30).
 *
 * The operator approved ElevenLabs Music on the existing ElevenLabs account -- no new vendor,
 * account or key -- with a line of its own: **$10, alerts at $3 and $7**. Like the voice line
 * (`voice-vendor-budget.ts`) it never raises the monthly generation cap, the per-film cap or the
 * per-shot cap, and it is checked before a cue is admitted rather than after the money is gone.
 * It is separate from the voice line: a score never spends the voice budget, and the reverse.
 *
 * What it counts is what the studio has committed to music: cues it has paid for plus the holds
 * its queued cues carry. The vendor's public API price is about $0.15 per generated minute
 * (`MUSIC_PRICE_USD_PER_MINUTE`, from its pricing page on 2026-09-30); a cue's hold is priced from
 * that until the operator captures the price on the host, as the voice catalogue does.
 *
 * Nothing reads this yet: generated music has no admission path. HV-024-11 (the adapter and its
 * admission) calls `assertMusicVendorBudget` inside the reserving transaction and raises
 * `musicVendorAlerts` as a log warning, with a test that the alerts are read -- the lesson of
 * HV-022-13, where the voice line's alerts were computed and read by nothing.
 */
export const MUSIC_VENDOR_CAP_ENV = "HV_MUSIC_VENDOR_CAP_USD";
export const DEFAULT_MUSIC_VENDOR_CAP_USD = 10;
export const MUSIC_VENDOR_ALERTS_USD: readonly number[] = Object.freeze([3, 7]);
/** The vendor's published rate, 2026-09-30. A declared constant, not captured evidence. */
export const MUSIC_PRICE_USD_PER_MINUTE = 0.15;

export function musicVendorCap(env: Record<string, string | undefined> = process.env, monthlyCapUsd = Number(env.HV_MONTHLY_BUDGET_USD ?? 5000)): number {
  const raw = env[MUSIC_VENDOR_CAP_ENV];
  const value = raw === undefined || raw.trim() === "" ? DEFAULT_MUSIC_VENDOR_CAP_USD : Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > monthlyCapUsd) throw new BudgetError("Set " + MUSIC_VENDOR_CAP_ENV + " between 0 and the monthly cap.");
  return value;
}

/** The most a cue of this length may hold: whole seconds, rounded up to the cent. */
export function musicCueHoldUsd(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) throw new BudgetError("A music cue must be between 0 and 600 seconds.");
  return Math.ceil(Math.ceil(seconds) / 60 * MUSIC_PRICE_USD_PER_MINUTE * 100) / 100;
}

export interface MusicVendorSpend { provider: string; spentUsd: number; heldUsd: number; capUsd: number }

export function assertMusicVendorBudget(spend: MusicVendorSpend, requestUsd: number): void {
  if (requestUsd <= 0) return;
  if (spend.spentUsd + spend.heldUsd + requestUsd > spend.capUsd + 1e-9)
    throw new BudgetError("The " + spend.provider + " music line has reached its limit of $" + spend.capUsd.toFixed(2)
      + " ($" + (spend.spentUsd + spend.heldUsd).toFixed(2) + " spent or held). Ask the studio operator to raise it.");
}

/** The alerts this cue crosses, given what was already committed. The caller raises them. */
export function musicVendorAlerts(committedUsd: number, requestUsd: number): number[] {
  if (!(requestUsd > 0)) return [];
  const after = committedUsd + requestUsd;
  return MUSIC_VENDOR_ALERTS_USD.filter(threshold => committedUsd < threshold && after >= threshold);
}
