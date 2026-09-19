import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CREW_ALERT_THRESHOLDS_USD, CREW_DEFAULT_CEILING_USD, CrewBudgetStop, CrewLedger } from "../src/crew-ledger";

const spend = (usd: number, at = "2026-09-19T22:00:00.000Z") => ({at, projectId: "p1", persona: "producer", model: "claude-sonnet-5", inputTokens: 10, outputTokens: 5, usd});

describe("the crew budget line (G13)", () => {
  test("the operator's thresholds and stop point", () => {
    expect(CREW_ALERT_THRESHOLDS_USD).toEqual([25, 100, 200, 1000]);
    expect(CREW_DEFAULT_CEILING_USD).toBe(1000);
  });

  test("each threshold alerts once, when it is first crossed", () => {
    const ledger = new CrewLedger();
    expect(ledger.record(spend(24.99))).toEqual([]);
    expect(ledger.record(spend(0.01)).map(alert => alert.thresholdUsd)).toEqual([25]);
    expect(ledger.record(spend(1))).toEqual([]);
    expect(ledger.record(spend(200)).map(alert => alert.thresholdUsd)).toEqual([100, 200]);
    expect(ledger.summary()).toMatchObject({spentUsd: 226, nextAlertUsd: 1000, approvedCeilingUsd: 1000});
  });

  test("the crew stops at $1,000 until the operator approves more", () => {
    const ledger = new CrewLedger();
    ledger.record(spend(999.99));
    expect(() => ledger.assertCanSpend()).not.toThrow();
    expect(ledger.record(spend(0.02)).map(alert => alert.thresholdUsd)).toEqual([1000]);
    expect(() => ledger.assertCanSpend()).toThrow(CrewBudgetStop);
    expect(() => ledger.approveCeiling(900)).toThrow("above");
    ledger.approveCeiling(1500);
    expect(() => ledger.assertCanSpend()).not.toThrow();
  });

  test("it persists, keeps its total when old events are trimmed, and refuses a damaged file", () => {
    const path = join(mkdtempSync(join(tmpdir(), "hv-crew-")), "crew-ledger.json");
    writeFileSync(path, JSON.stringify({schema: "hv-crew-ledger/1", spentUsd: 4.998, approvedCeilingUsd: 1000, alerts: [],
      events: Array.from({length: 4998}, () => spend(0.001))}));
    const ledger = new CrewLedger(path);
    for (let index = 0; index < 7; index++) ledger.record(spend(0.001));
    const saved = JSON.parse(readFileSync(path, "utf8"));
    expect(saved.events).toHaveLength(5000);
    expect(new CrewLedger(path).summary().spentUsd).toBeCloseTo(5.005, 6);
    expect(readFileSync(path, "utf8")).not.toContain("prompt");
    writeFileSync(path, JSON.stringify({...saved, approvedCeilingUsd: 10}));
    expect(() => new CrewLedger(path).assertCanSpend()).toThrow("unreadable");
  });

  test("invalid spend is refused", () => {
    expect(() => new CrewLedger().record(spend(-1))).toThrow("Invalid");
    expect(() => new CrewLedger().record(spend(Number.NaN))).toThrow("Invalid");
  });
});
