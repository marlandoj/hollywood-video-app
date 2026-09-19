import { BudgetError } from "./index";

/**
 * The per-film spending limit (HV-019-04, Release 1 "Studio" step 4).
 *
 * The program has a monthly generation cap ($500, `HV_MONTHLY_BUDGET_USD`) and a
 * per-shot cap; nothing stopped one film from using the whole month. A film's paid
 * generation -- what it has spent plus what its queued jobs hold -- may not pass
 * `HV_FILM_SPEND_CAP_USD` ($40 unless the operator sets another). It is a new
 * restriction: it never raises the monthly or per-shot cap, and a value above the
 * monthly cap is refused.
 */
export const FILM_SPEND_CAP_ENV = "HV_FILM_SPEND_CAP_USD";
export const DEFAULT_FILM_SPEND_CAP_USD = 40;

export function filmSpendCap(env: Record<string, string | undefined> = process.env, monthlyCapUsd = Number(env.HV_MONTHLY_BUDGET_USD ?? 5000)): number {
  const raw = env[FILM_SPEND_CAP_ENV];
  const value = raw === undefined || raw.trim() === "" ? DEFAULT_FILM_SPEND_CAP_USD : Number(raw);
  if (!Number.isFinite(value) || value <= 0 || value > monthlyCapUsd) throw new BudgetError("Set " + FILM_SPEND_CAP_ENV + " between 0 and the monthly cap.");
  return value;
}

export interface FilmSpend { spentUsd: number; heldUsd: number; capUsd: number }

export function assertFilmBudget(spend: FilmSpend, requestUsd: number): void {
  if (requestUsd <= 0) return;
  if (spend.spentUsd + spend.heldUsd + requestUsd > spend.capUsd + 1e-9)
    throw new BudgetError("This film has reached its spending limit of $" + spend.capUsd.toFixed(2) + " ($" + (spend.spentUsd + spend.heldUsd).toFixed(2)
      + " spent or held). Shorten the film, or ask the studio operator to raise the limit.");
}
