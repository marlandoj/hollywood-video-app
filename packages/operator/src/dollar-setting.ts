import { BudgetError } from "./index";

/**
 * How the studio reads a dollar setting from its environment (HV-024-13).
 *
 * Every budget line used to read its setting with `Number()`. That accepts things no operator means
 * as a dollar amount: `"0x10"` is 16, `"1e3"` is 1000, `" 5 "` is 5 and `"Infinity"` is Infinity. It
 * also turns `"abc"` into `NaN`, and a comparison with `NaN` is never true. So with
 * `HV_MONTHLY_BUDGET_USD=abc`, "is the music line above the monthly cap?" was never yes, and a
 * $1,000,000 music line was accepted.
 *
 * A dollar setting is now plain decimal dollars: digits, and optionally a point with one or two more
 * (`500`, `40`, `12.5`, `12.50`). Anything else is refused with the setting's name.
 */
export const PLAIN_DOLLARS = /^\d+(\.\d{1,2})?$/;

export const MONTHLY_BUDGET_ENV = "HV_MONTHLY_BUDGET_USD";
/** Unchanged from every reader before this one; budget defaults never move upward. */
export const DEFAULT_MONTHLY_BUDGET_USD = 5000;

/** Plain decimal dollars, or undefined. A value too long to be a finite number is not one. */
export function plainDollars(raw: string): number | undefined {
  if (!PLAIN_DOLLARS.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

/**
 * The monthly generation cap: $5,000 when unset, otherwise plain dollars above zero. The API and the
 * worker read it before anything else at startup, so a value they cannot compare stops them there.
 * A blank value is refused rather than read as the default: the monthly cap is the one every other
 * line is held under, and a blank one used to read as $0.
 */
export function monthlyBudgetCap(env: Record<string, string | undefined> = process.env): number {
  const raw = env[MONTHLY_BUDGET_ENV];
  if (raw === undefined) return DEFAULT_MONTHLY_BUDGET_USD;
  const value = plainDollars(raw);
  if (value === undefined || value <= 0) throw new BudgetError("Set " + MONTHLY_BUDGET_ENV + " to a plain dollar amount above zero, such as 500 or 1250.50.");
  return value;
}

/**
 * A line held under the monthly cap (the film's limit, the voice line, the music line): its default
 * when unset or blank, otherwise plain dollars above zero and not above the monthly cap. It refuses to
 * compare against a monthly cap that is not a finite amount above zero, rather than letting every
 * comparison with it come out false.
 */
export function capUnderMonthly(env: Record<string, string | undefined>, name: string, defaultUsd: number, monthlyCapUsd: number): number {
  if (!Number.isFinite(monthlyCapUsd) || monthlyCapUsd <= 0)
    throw new BudgetError("The monthly cap is not a dollar amount, so " + name + " cannot be checked against it. Set " + MONTHLY_BUDGET_ENV + " to a plain dollar amount above zero, such as 500.");
  const raw = env[name];
  const value = raw === undefined || raw.trim() === "" ? defaultUsd : plainDollars(raw);
  if (value === undefined) throw new BudgetError("Set " + name + " to a plain dollar amount, such as 10 or 12.50.");
  if (value <= 0 || value > monthlyCapUsd) throw new BudgetError("Set " + name + " between 0 and the monthly cap.");
  return value;
}
