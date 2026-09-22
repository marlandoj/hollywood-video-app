import { describe, expect, test } from "bun:test";
import { BudgetError } from "../src/index";
import { DEFAULT_VOICE_VENDOR_CAP_USD, VOICE_VENDOR_ALERTS_USD, assertVoiceVendorBudget, voiceVendorAlerts, voiceVendorCap } from "../src/voice-vendor-budget";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { EVENTS } from "../../observability/src/logs";

// HV-022-08: the operator approved ElevenLabs with a $25 ceiling and alerts at $5 and $15
// (G14-202609210000). It is its own line: it never raises the monthly, per-film or per-shot cap.
describe("a voice vendor's own budget line", () => {
  test("$25 unless the operator sets another, and never above the monthly cap", () => {
    expect(DEFAULT_VOICE_VENDOR_CAP_USD).toBe(25);
    expect(VOICE_VENDOR_ALERTS_USD).toEqual([5, 15]);
    expect(voiceVendorCap({}, 500)).toBe(25);
    expect(voiceVendorCap({HV_VOICE_VENDOR_CAP_USD: "10"}, 500)).toBe(10);
    expect(voiceVendorCap({HV_VOICE_VENDOR_CAP_USD: "  "}, 500)).toBe(25);
    for (const value of ["0", "-1", "abc", "501"]) expect(() => voiceVendorCap({HV_VOICE_VENDOR_CAP_USD: value}, 500)).toThrow(BudgetError);
  });

  test("what the studio has paid and what its queued takes hold both count against the line", () => {
    expect(() => assertVoiceVendorBudget({provider: "elevenlabs", spentUsd: 20, heldUsd: 4, capUsd: 25}, 1)).not.toThrow();
    expect(() => assertVoiceVendorBudget({provider: "elevenlabs", spentUsd: 20, heldUsd: 4, capUsd: 25}, 1.01))
      .toThrow("elevenlabs voice line has reached its limit of $25.00 ($24.00 spent or held)");
    // A take that costs nothing is never refused by a budget.
    expect(() => assertVoiceVendorBudget({provider: "elevenlabs", spentUsd: 100, heldUsd: 0, capUsd: 25}, 0)).not.toThrow();
  });

  test("each alert is crossed once, by the take that crosses it", () => {
    expect(voiceVendorAlerts(0, 1)).toEqual([]);
    expect(voiceVendorAlerts(4.5, 1)).toEqual([5]);
    expect(voiceVendorAlerts(5, 1)).toEqual([]);
    expect(voiceVendorAlerts(4.5, 11)).toEqual([5, 15]);
    expect(voiceVendorAlerts(15, 5)).toEqual([]);
    expect(voiceVendorAlerts(0, 0)).toEqual([]);
  });
});

/**
 * HV-022-13 — and something reads them.
 *
 * Everything above this line passed on the day the alerts were written and every day since, while
 * `voiceVendorAlerts` was called by nothing outside this file's own imports: the operator's two
 * approved warnings could not fire, and the only signal this line gave was the hard refusal at its
 * ceiling. A rule that is computed and not read is not a rule, and it fails exactly this quietly.
 */
test("the alerts this line computes are read by the studio, and named where an operator sees them", () => {
  const root = new URL("../../", import.meta.url).pathname;
  const reads = (file: string) => readFileSync(join(root, file), "utf8");
  // Computed where the ceiling is checked, from the same figures, inside the same transaction.
  const ledger = reads("storage/src/audio-ledger.ts");
  expect(ledger).toContain("voiceVendorAlerts(");
  expect(ledger).toContain("onVendorAlert");
  // Raised where the crew's alerts are raised, under a name the log's own closed set admits.
  expect(reads("api/src/server.ts")).toContain('logger.warn("voice.budget_alert"');
  expect(EVENTS.has("voice.budget_alert")).toBe(true);
  // And the thresholds an operator is told about are the ones the operator approved.
  expect([...VOICE_VENDOR_ALERTS_USD]).toEqual([5, 15]);
});
