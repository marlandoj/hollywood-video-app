import { describe, expect, test } from "bun:test";
import { BudgetError } from "../src/index";
import { DEFAULT_MUSIC_VENDOR_CAP_USD, MUSIC_PRICE_USD_PER_MINUTE, MUSIC_VENDOR_ALERTS_USD, assertMusicVendorBudget, musicCueHoldUsd, musicVendorAlerts, musicVendorCap } from "../src/music-vendor-budget";
import { DEFAULT_VOICE_VENDOR_CAP_USD, VOICE_VENDOR_CAP_ENV, voiceVendorCap } from "../src/voice-vendor-budget";

// HV-024-10: the operator approved ElevenLabs Music with a $10 line and alerts at $3 and $7 (G15,
// 2026-09-30). It is its own line: it never raises the monthly, per-film or per-shot cap, and it is
// not the voice line.
describe("the generated-music line", () => {
  test("$10 unless the operator sets another, and never above the monthly cap", () => {
    expect(DEFAULT_MUSIC_VENDOR_CAP_USD).toBe(10);
    expect(MUSIC_VENDOR_ALERTS_USD).toEqual([3, 7]);
    expect(musicVendorCap({}, 500)).toBe(10);
    expect(musicVendorCap({HV_MUSIC_VENDOR_CAP_USD: "4"}, 500)).toBe(4);
    expect(musicVendorCap({HV_MUSIC_VENDOR_CAP_USD: "  "}, 500)).toBe(10);
    for (const value of ["0", "-1", "abc", "501", "Infinity"]) expect(() => musicVendorCap({HV_MUSIC_VENDOR_CAP_USD: value}, 500)).toThrow(BudgetError);
  });

  test("it is not the voice line: neither setting moves the other", () => {
    expect(musicVendorCap({[VOICE_VENDOR_CAP_ENV]: "20"}, 500)).toBe(10);
    expect(voiceVendorCap({HV_MUSIC_VENDOR_CAP_USD: "2"}, 500)).toBe(DEFAULT_VOICE_VENDOR_CAP_USD);
  });

  test("a cue holds its length at the published rate, rounded up", () => {
    expect(MUSIC_PRICE_USD_PER_MINUTE).toBe(0.15);
    expect(musicCueHoldUsd(60)).toBe(0.15);
    expect(musicCueHoldUsd(180)).toBe(0.45);
    expect(musicCueHoldUsd(0.4)).toBe(0.01);
    expect(musicCueHoldUsd(61)).toBe(0.16);
    for (const seconds of [0, -1, 601, Number.NaN]) expect(() => musicCueHoldUsd(seconds)).toThrow(BudgetError);
  });

  test("what the studio has paid and what its queued cues hold both count against the line", () => {
    expect(() => assertMusicVendorBudget({provider: "elevenlabs", spentUsd: 8, heldUsd: 1.5, capUsd: 10}, 0.5)).not.toThrow();
    expect(() => assertMusicVendorBudget({provider: "elevenlabs", spentUsd: 8, heldUsd: 1.5, capUsd: 10}, 0.51))
      .toThrow("elevenlabs music line has reached its limit of $10.00 ($9.50 spent or held)");
    expect(() => assertMusicVendorBudget({provider: "elevenlabs", spentUsd: 100, heldUsd: 0, capUsd: 10}, 0)).not.toThrow();
  });

  test("each alert is crossed once, by the cue that crosses it", () => {
    expect(musicVendorAlerts(0, 1)).toEqual([]);
    expect(musicVendorAlerts(2.9, 0.15)).toEqual([3]);
    expect(musicVendorAlerts(3, 0.15)).toEqual([]);
    expect(musicVendorAlerts(2.9, 5)).toEqual([3, 7]);
    expect(musicVendorAlerts(7, 1)).toEqual([]);
    expect(musicVendorAlerts(0, 0)).toEqual([]);
  });
});
