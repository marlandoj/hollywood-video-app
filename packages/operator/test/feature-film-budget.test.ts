/**
 * HV-030-28 — a feature's own film limit (G20-202610031349).
 *
 * Kevin decided at G20 that a feature gets its own per-film limit of $150, that reels and shorts stay
 * at $40, and that the $500 program cap and the $450 alert don't change. These tests hold the limit
 * to that: the feature's figure, the reel's and short's unchanged figure, which films get which, and
 * that neither the monthly cap nor the documented alert moves.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { DEFAULT_MONTHLY_BUDGET_USD, monthlyBudgetCap } from "../src/dollar-setting";
import { DEFAULT_FEATURE_FILM_SPEND_CAP_USD, DEFAULT_FILM_SPEND_CAP_USD, assertFilmBudget, featureFilmSpendCap, filmCapFor, filmLimits, filmSpendCap, renderHold } from "../src/film-budget";
import { BudgetError, CostLedger } from "../src/index";

const STAGING = {HV_MONTHLY_BUDGET_USD: "500"};
const repo = (path: string) => readFileSync(new URL("../../../" + path, import.meta.url), "utf8");

describe("the feature's own film limit", () => {
  test("is $150; a reel's and a short's stays $40", () => {
    expect(DEFAULT_FEATURE_FILM_SPEND_CAP_USD).toBe(150);
    expect(DEFAULT_FILM_SPEND_CAP_USD).toBe(40);
    expect(filmLimits(STAGING)).toEqual({filmCapUsd: 40, featureCapUsd: 150});
    expect(filmLimits({})).toEqual({filmCapUsd: 40, featureCapUsd: 150});
  });

  test("a feature is held to $150; a reel, a short and a film never planned to $40", () => {
    const limits = filmLimits(STAGING);
    expect(filmCapFor({format: "feature"}, limits)).toBe(150);
    for (const project of [{format: "reel"}, {format: "short"}, {}, {format: undefined}, null, undefined]) expect(filmCapFor(project, limits)).toBe(40);
    // Anything else is the film's limit too: an unknown format never reads as the larger one.
    for (const format of ["Feature", "film", "feature ", ""]) expect(filmCapFor({format}, limits)).toBe(40);
    // Without a feature limit to hand, a feature is held to the film's.
    expect(filmCapFor({format: "feature"}, {filmCapUsd: 40})).toBe(40);
  });

  test("the operator may set it, in plain dollars, never above the monthly cap", () => {
    expect(featureFilmSpendCap({HV_FEATURE_FILM_SPEND_CAP_USD: "120"}, 500)).toBe(120);
    for (const value of ["0", "-1", "abc", "501", "1e3"]) expect(() => featureFilmSpendCap({HV_FEATURE_FILM_SPEND_CAP_USD: value}, 500)).toThrow(BudgetError);
    // Unset under a month smaller than $150, it is held to the month rather than stopping the studio.
    expect(featureFilmSpendCap({}, 100)).toBe(100);
    expect(() => featureFilmSpendCap({HV_FEATURE_FILM_SPEND_CAP_USD: "150"}, 100)).toThrow("between 0 and the monthly cap");
    // The two limits are read apart: setting one leaves the other.
    expect(filmLimits({...STAGING, HV_FILM_SPEND_CAP_USD: "25"})).toEqual({filmCapUsd: 25, featureCapUsd: 150});
    expect(filmLimits({...STAGING, HV_FEATURE_FILM_SPEND_CAP_USD: "90"})).toEqual({filmCapUsd: 40, featureCapUsd: 90});
    expect(filmSpendCap({...STAGING, HV_FEATURE_FILM_SPEND_CAP_USD: "150"})).toBe(40);
  });

  test("HV-030-27's arithmetic: a feature's last 24-shot anchored sequence fits under $150, and not under $40", () => {
    const limits = filmLimits(STAGING);
    // HV-019-06: a render holds three attempts at the dearest estimate; 24 shots at $0.42 hold $30.24.
    const hold = renderHold(24 * 0.42, 24 * 5);
    expect(hold).toBe(30.24);
    // 240 shots at $0.42 is $100.80 of video. With the last sequence's 24 still to render, 216 are spent.
    const spent = Number((216 * 0.42).toFixed(2));
    expect(() => assertFilmBudget({spentUsd: spent, heldUsd: 0, capUsd: filmCapFor({format: "feature"}, limits)}, hold)).not.toThrow();
    expect(() => assertFilmBudget({spentUsd: spent, heldUsd: 0, capUsd: filmCapFor({format: "short"}, limits)}, hold)).toThrow("spending limit of $40.00");
    // A short at its $40 is refused one cent past it, as before.
    expect(() => assertFilmBudget({spentUsd: 9.75, heldUsd: 0, capUsd: filmCapFor({format: "short"}, limits)}, 30.24)).not.toThrow();
    expect(() => assertFilmBudget({spentUsd: 9.77, heldUsd: 0, capUsd: filmCapFor({format: "short"}, limits)}, 30.24)).toThrow("spending limit of $40.00");
    // And a feature at its $150 the same way.
    expect(() => assertFilmBudget({spentUsd: 119.76, heldUsd: 0, capUsd: filmCapFor({format: "feature"}, limits)}, 30.24)).not.toThrow();
    expect(() => assertFilmBudget({spentUsd: 119.77, heldUsd: 0, capUsd: filmCapFor({format: "feature"}, limits)}, 30.24)).toThrow("spending limit of $150.00");
  });
});

describe("the program cap and its alert are untouched", () => {
  test("the monthly cap reads as before, whatever the feature's limit is", () => {
    expect(DEFAULT_MONTHLY_BUDGET_USD).toBe(5000);
    expect(monthlyBudgetCap({})).toBe(5000);
    expect(monthlyBudgetCap({HV_FEATURE_FILM_SPEND_CAP_USD: "150"})).toBe(5000);
    expect(monthlyBudgetCap({...STAGING, HV_FEATURE_FILM_SPEND_CAP_USD: "150"})).toBe(500);
  });

  test("a feature within its own limit is still refused by the month", () => {
    const ledger = new CostLedger();
    ledger.record({projectId: "other-film", shotId: "s1", jobId: "j0", provider: "fal", gpu_seconds: 1, total_cost_usd: 480, at: new Date().toISOString()} as never);
    // $30.24 fits the feature's $150 but not the month's remaining $20.
    expect(() => assertFilmBudget({...ledger.filmSpend("feature", new Set()), capUsd: filmCapFor({format: "feature"}, filmLimits(STAGING))}, 30.24)).not.toThrow();
    expect(() => ledger.reserve("j1", "final", 30.24, monthlyBudgetCap(STAGING))).toThrow(BudgetError);
  });

  test("the staging host still writes a $500 month, and Release 3's generation line is still $450", () => {
    for (const script of ["scripts/provision-staging-host.py", "scripts/deploy-private-staging.py"]) expect(repo(script)).toContain("export HV_MONTHLY_BUDGET_USD=500\n");
    const release3 = repo("docs/ROADMAP.md").split("\n## Release 3 ")[1]!.split("\n## Release 4 ")[0]!;
    expect(release3).toMatch(/^\| generation \| 450 \| /m);
    // No deploy script sets either film limit: both are the code's defaults on staging.
    for (const script of ["scripts/provision-staging-host.py", "scripts/deploy-private-staging.py", "scripts/deploy-storage-staging.py", "scripts/staging-providers.py"])
      expect(repo(script)).not.toMatch(/HV_(FEATURE_)?FILM_SPEND_CAP_USD/);
  });
});
