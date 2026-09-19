import { describe, expect, test } from "bun:test";
import { DEFAULT_FILM_SPEND_CAP_USD, assertFilmBudget, filmSpendCap } from "../src/film-budget";
import { BudgetError, CostLedger } from "../src/index";

describe("the per-film spending limit (HV-019-04)", () => {
  test("$40 unless the operator sets another, and never above the monthly cap", () => {
    expect(DEFAULT_FILM_SPEND_CAP_USD).toBe(40);
    expect(filmSpendCap({}, 500)).toBe(40);
    expect(filmSpendCap({HV_FILM_SPEND_CAP_USD: "25"}, 500)).toBe(25);
    for (const value of ["0", "-1", "abc", "501"]) expect(() => filmSpendCap({HV_FILM_SPEND_CAP_USD: value}, 500)).toThrow(BudgetError);
  });

  test("spent plus held plus the new render may not pass the limit; free renders always pass", () => {
    expect(() => assertFilmBudget({spentUsd: 30, heldUsd: 5, capUsd: 40}, 5)).not.toThrow();
    expect(() => assertFilmBudget({spentUsd: 30, heldUsd: 5, capUsd: 40}, 5.01)).toThrow("spending limit of $40.00");
    expect(() => assertFilmBudget({spentUsd: 400, heldUsd: 0, capUsd: 40}, 0)).not.toThrow();
  });

  test("the JSON ledger reports one film's spend and the holds of its own jobs only", () => {
    const ledger = new CostLedger();
    ledger.record({projectId: "film-a", shotId: "s1", jobId: "j1", provider: "fal", gpu_seconds: 1, total_cost_usd: 1.25, at: new Date().toISOString()} as never);
    ledger.record({projectId: "film-b", shotId: "s1", jobId: "j9", provider: "fal", gpu_seconds: 1, total_cost_usd: 9, at: new Date().toISOString()} as never);
    ledger.reserve("j2", "final", 5, 500);
    ledger.reserve("j8", "final", 7, 500);
    expect(ledger.filmSpend("film-a", new Set(["j1", "j2"]))).toEqual({spentUsd: 1.25, heldUsd: 5});
  });
});
