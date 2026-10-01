import { BudgetError } from "./index";
import { capUnderMonthly, monthlyBudgetCap } from "./dollar-setting";

/**
 * A voice vendor's own budget line (G14-202609210000).
 *
 * The operator approved ElevenLabs with a ceiling of $25 and alerts at $5 and $15. That is a line
 * of its own, like the crew's: it never raises the monthly generation cap, the per-film cap or the
 * per-shot cap, and it is checked before a take is admitted rather than after the money is gone.
 *
 * What it counts is what the studio has committed to this vendor: takes it has paid for, plus the
 * holds its queued takes carry. The vendor sells a prepaid allowance, so a hold is the honest
 * measure of commitment until the operator allocates the subscription invoice.
 */
export const VOICE_VENDOR_CAP_ENV = "HV_VOICE_VENDOR_CAP_USD";
export const DEFAULT_VOICE_VENDOR_CAP_USD = 25;
export const VOICE_VENDOR_ALERTS_USD: readonly number[] = Object.freeze([5, 15]);

export function voiceVendorCap(env: Record<string, string | undefined> = process.env, monthlyCapUsd = monthlyBudgetCap(env)): number {
  return capUnderMonthly(env, VOICE_VENDOR_CAP_ENV, DEFAULT_VOICE_VENDOR_CAP_USD, monthlyCapUsd);
}

export interface VoiceVendorSpend { provider: string; spentUsd: number; heldUsd: number; capUsd: number }

export function assertVoiceVendorBudget(spend: VoiceVendorSpend, requestUsd: number): void {
  if (requestUsd <= 0) return;
  if (spend.spentUsd + spend.heldUsd + requestUsd > spend.capUsd + 1e-9)
    throw new BudgetError("The " + spend.provider + " voice line has reached its limit of $" + spend.capUsd.toFixed(2)
      + " ($" + (spend.spentUsd + spend.heldUsd).toFixed(2) + " spent or held). Ask the studio operator to raise it.");
}

/** The alerts this take crosses, given what was already committed. The caller raises them. */
export function voiceVendorAlerts(committedUsd: number, requestUsd: number): number[] {
  if (!(requestUsd > 0)) return [];
  const after = committedUsd + requestUsd;
  return VOICE_VENDOR_ALERTS_USD.filter(threshold => committedUsd < threshold && after >= threshold);
}
