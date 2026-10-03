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

/**
 * A feature's own film limit (HV-030-28, Release 3 step 1; decided at G20-202610031349): $150, set by
 * `HV_FEATURE_FILM_SPEND_CAP_USD` if the operator sets another. A 15-20 minute feature is one project of
 * about 200-240 shots, about $84-101 of video on the look-matched profile, and a render holds three
 * attempts at the dearest estimate (HV-019-06): about $30 for its last 24-shot sequence. Reels and
 * shorts keep `HV_FILM_SPEND_CAP_USD` ($40). Like the film's limit it is a restriction under the
 * monthly cap, never above it, and it changes neither the monthly cap nor the operator's alert.
 */
export const FEATURE_FILM_SPEND_CAP_ENV = "HV_FEATURE_FILM_SPEND_CAP_USD";
export const DEFAULT_FEATURE_FILM_SPEND_CAP_USD = 150;

export function featureFilmSpendCap(env: Record<string, string | undefined> = process.env, monthlyCapUsd = monthlyBudgetCap(env)): number {
  // Unset under a monthly cap below $150, the feature is held to the monthly cap rather than stopping
  // the studio at startup: the default is a ceiling, never a reason to refuse a smaller month.
  return capUnderMonthly(env, FEATURE_FILM_SPEND_CAP_ENV, Math.min(DEFAULT_FEATURE_FILM_SPEND_CAP_USD, monthlyCapUsd), monthlyCapUsd);
}

/** The two limits a studio holds films to, read once at startup. */
export interface FilmLimits { filmCapUsd: number; featureCapUsd: number }
export function filmLimits(env: Record<string, string | undefined> = process.env, monthlyCapUsd = monthlyBudgetCap(env)): FilmLimits {
  return {filmCapUsd: filmSpendCap(env, monthlyCapUsd), featureCapUsd: featureFilmSpendCap(env, monthlyCapUsd)};
}

/**
 * The limit one film is held to: the feature's for a project pitched as a `feature`, the film's
 * ($40) for anything else -- a reel, a short, or a project never pitched to the crew. Without a
 * feature limit to hand, a feature is held to the film's: an unknown limit never reads as a larger one.
 */
export function filmCapFor(project: {format?: string} | null | undefined, limits: {filmCapUsd: number; featureCapUsd?: number}): number {
  return project?.format === "feature" && limits.featureCapUsd !== undefined ? limits.featureCapUsd : limits.filmCapUsd;
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
