import { BudgetError } from "./index";
import { capUnderMonthly, monthlyBudgetCap } from "./dollar-setting";

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

export function filmSpendCap(env: Record<string, string | undefined> = process.env, monthlyCapUsd = monthlyBudgetCap(env)): number {
  return capUnderMonthly(env, FILM_SPEND_CAP_ENV, DEFAULT_FILM_SPEND_CAP_USD, monthlyCapUsd);
}

export interface FilmSpend { spentUsd: number; heldUsd: number; capUsd: number }

/**
 * What a paid render holds (HV-019-06): the dearest eligible provider's estimate for every shot it
 * generates, for each of the three attempts the retry policy allows, rounded up to the cent -- at
 * least a cent, never more than the render's cap. The render cannot spend past its hold.
 *
 * HV-022-18: one function for every route that holds, where the render route had its own copy and
 * the screenplay-revision route held the cap. The product is rounded to six places before the ceiling,
 * because `0.4 * 3 * 100` is `120.00000000000001` and a bare ceiling held $1.21 for $1.20.
 */
export const RENDER_ATTEMPTS = 3;
export function renderHold(maximumEstimateUsd: number, costCapUsd: number): number {
  return Math.min(costCapUsd, Math.max(0.01, Math.ceil(Number((maximumEstimateUsd * RENDER_ATTEMPTS * 100).toFixed(6))) / 100));
}

export function assertFilmBudget(spend: FilmSpend, requestUsd: number): void {
  if (requestUsd <= 0) return;
  if (spend.spentUsd + spend.heldUsd + requestUsd > spend.capUsd + 1e-9)
    throw new BudgetError("This film has reached its spending limit of $" + spend.capUsd.toFixed(2) + " ($" + (spend.spentUsd + spend.heldUsd).toFixed(2)
      + " spent or held). Shorten the film, or ask the studio operator to raise the limit.");
}
