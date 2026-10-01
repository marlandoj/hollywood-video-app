import { describe, expect, test } from "bun:test";
import { BudgetError } from "../src/index";
import { DEFAULT_MONTHLY_BUDGET_USD, PLAIN_DOLLARS, capUnderMonthly, monthlyBudgetCap, plainDollars } from "../src/dollar-setting";
import { DEFAULT_FILM_SPEND_CAP_USD, FILM_SPEND_CAP_ENV, filmSpendCap } from "../src/film-budget";
import { DEFAULT_VOICE_VENDOR_CAP_USD, VOICE_VENDOR_CAP_ENV, voiceVendorCap } from "../src/voice-vendor-budget";
import { DEFAULT_MUSIC_VENDOR_CAP_USD, MUSIC_VENDOR_CAP_ENV, musicVendorCap } from "../src/music-vendor-budget";

// HV-024-13: every budget line reads its dollars as plain decimals, and refuses a cap it can't compare.
// `Number()` read "0x10" as 16, "1e3" as 1000 and " 5 " as 5, and read "abc" as NaN, which no
// comparison refuses: a $1,000,000 music line was accepted under a monthly cap of "abc".

const LINES = [
  {name: "the film's limit", env: FILM_SPEND_CAP_ENV, fallback: DEFAULT_FILM_SPEND_CAP_USD, read: filmSpendCap},
  {name: "the voice line", env: VOICE_VENDOR_CAP_ENV, fallback: DEFAULT_VOICE_VENDOR_CAP_USD, read: voiceVendorCap},
  {name: "the music line", env: MUSIC_VENDOR_CAP_ENV, fallback: DEFAULT_MUSIC_VENDOR_CAP_USD, read: musicVendorCap},
] as const;

/** Forms `Number()` accepts that no operator means as a dollar amount, plus plain nonsense. */
const NOT_DOLLARS = ["abc", "0x10", "0X10", "0b11", "0o7", "1e3", "1E3", "5e-1", " 5", "5 ", " 5 ", "\t5", "5\n", "+5", "-1", "-0",
  "Infinity", "-Infinity", "NaN", "5.", ".5", "5.001", "1,000", "1_000", "$5", "5USD", "５", "1".repeat(400)];

describe("a dollar setting is plain decimal dollars", () => {
  test("digits, optionally a point and one or two more, are read as written", () => {
    const read: Record<string, number> = {"0": 0, "5": 5, "10": 10, "25": 25, "40": 40, "500": 500, "5000": 5000, "0.03": 0.03, "0.5": 0.5,
      "12.5": 12.5, "12.50": 12.5, "1250.50": 1250.5, "007": 7};
    for (const [raw, value] of Object.entries(read)) {
      expect(PLAIN_DOLLARS.test(raw)).toBe(true);
      expect(plainDollars(raw)).toBe(value);
    }
  });

  test("hex, binary, octal, exponents, signs, whitespace, Infinity, separators and over-long numbers are not dollars", () => {
    for (const raw of [...NOT_DOLLARS, "", "  "]) expect(plainDollars(raw)).toBeUndefined();
  });
});

describe("the monthly cap", () => {
  test("is $5,000 when unset, as before, and reads the documented values as before", () => {
    expect(DEFAULT_MONTHLY_BUDGET_USD).toBe(5000);
    expect(monthlyBudgetCap({})).toBe(5000);
    for (const raw of ["5000", "500", "150"]) expect(monthlyBudgetCap({HV_MONTHLY_BUDGET_USD: raw})).toBe(Number(raw));
    expect(monthlyBudgetCap({HV_MONTHLY_BUDGET_USD: "1250.50"})).toBe(1250.5);
  });

  test("refuses anything that is not plain dollars above zero, naming the setting", () => {
    for (const raw of [...NOT_DOLLARS, "", "  ", "0", "0.00"]) {
      expect(() => monthlyBudgetCap({HV_MONTHLY_BUDGET_USD: raw})).toThrow(BudgetError);
      expect(() => monthlyBudgetCap({HV_MONTHLY_BUDGET_USD: raw})).toThrow("Set HV_MONTHLY_BUDGET_USD to a plain dollar amount above zero");
    }
  });
});

describe("every line under the monthly cap", () => {
  for (const line of LINES) {
    test(line.name + " keeps its default and reads plain dollars as before", () => {
      expect(line.read({}, 500)).toBe(line.fallback);
      expect(line.read({})).toBe(line.fallback);
      expect(line.read({[line.env]: "  "}, 500)).toBe(line.fallback);
      expect(line.read({[line.env]: "4"}, 500)).toBe(4);
      expect(line.read({[line.env]: "0.03"}, 500)).toBe(0.03);
      expect(line.read({[line.env]: "12.50"}, 500)).toBe(12.5);
      expect(line.read({[line.env]: "500"}, 500)).toBe(500);
    });

    test(line.name + " refuses a value that is not plain dollars, naming its setting", () => {
      for (const raw of NOT_DOLLARS.filter(value => value.trim() !== "")) expect(() => line.read({[line.env]: raw}, 500)).toThrow("Set " + line.env + " to a plain dollar amount");
      for (const raw of ["0", "0.00", "500.01", "501"]) expect(() => line.read({[line.env]: raw}, 500)).toThrow("Set " + line.env + " between 0 and the monthly cap.");
    });

    test(line.name + " refuses to compare against a monthly cap that is not a finite amount above zero", () => {
      for (const monthly of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, -500])
        expect(() => line.read({[line.env]: "1000000"}, monthly)).toThrow("The monthly cap is not a dollar amount, so " + line.env + " cannot be checked against it.");
      // The default reads the monthly cap through the same parser, so "abc" stops it there.
      expect(() => line.read({HV_MONTHLY_BUDGET_USD: "abc", [line.env]: "1000000"})).toThrow("Set HV_MONTHLY_BUDGET_USD to a plain dollar amount above zero");
      expect(() => line.read({HV_MONTHLY_BUDGET_USD: "0x10", [line.env]: "16"})).toThrow("Set HV_MONTHLY_BUDGET_USD");
    });
  }

  test("the review's case: a $1,000,000 music line under a monthly cap of NaN is refused", () => {
    expect(() => musicVendorCap({HV_MUSIC_VENDOR_CAP_USD: "1000000"}, Number.NaN)).toThrow(BudgetError);
    expect(() => capUnderMonthly({X: "1"}, "X", 1, Number.NaN)).toThrow(BudgetError);
  });
});
