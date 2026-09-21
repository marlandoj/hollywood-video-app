import { expect, test } from "bun:test";
import { validateAudioPolicy } from "../../planner/src/audio-jobs";
import { elevenLabsEvidenceManifest, elevenLabsPolicyCatalogue, elevenLabsTakeHoldUsd } from "../src/elevenlabs-policy-catalogue";
import { ELEVENLABS_MAX_LINE_CHARACTERS } from "../src/elevenlabs-capability";

// HV-022-07: the catalogue is built only from evidence captured on the host. Synthetic pages here.
const bytes = (text: string) => new TextEncoder().encode(text);
const ROGER = "CwhRBWXzGAHq8TQ4Fs17", SARAH = "EXAVITQu4vr4xnSDxMaL", GEORGE = "JBFqnCBsd6RMkjVDRZzb";
const voiceList = (ids: string[]) => bytes(JSON.stringify({voices: ids.map(voice_id => ({voice_id, name: "Voice - Warm, Clear", category: "premade", labels: {gender: "male"}}))}));
const snapshot = (text: string) => ({url: "https://example.test/page", fetchedAt: "2026-09-21T03:00:00.000Z", bytes: bytes(text)});
const evidence = (overrides: object = {}) => ({
  subscription: snapshot(JSON.stringify({tier: "starter", character_limit: 90_000, character_count: 3_100, character_refresh_period: "monthly_period", status: "active"})),
  voices: {url: "https://api.elevenlabs.io/v1/voices", fetchedAt: "2026-09-21T03:00:00.000Z", bytes: voiceList([ROGER, SARAH, GEORGE])},
  licence: [snapshot("terms of use")], price: snapshot("pricing"), planUsdPerPeriod: 6, authorize: [ROGER, SARAH], ...overrides});
const now = new Date("2026-09-21T03:00:00.500Z");

test("the authorized voices carry the account's own rate, and the application's validator accepts each", () => {
  const catalogue = elevenLabsPolicyCatalogue(evidence(), now);
  expect(catalogue.policies.map(policy => [policy.voiceId, policy.label])).toEqual([[ROGER, "Voice (ElevenLabs)"], [SARAH, "Voice (ElevenLabs)"]]);
  // $6 a month over 90,000 characters, for a line of at most 10,000: six dollars' worth of allowance.
  const held = elevenLabsTakeHoldUsd(6, 90_000);
  expect(held).toBeCloseTo(0.666667, 6);
  for (const policy of catalogue.policies) {
    expect(validateAudioPolicy(policy, now.getTime())).toEqual(policy);
    expect(policy).toMatchObject({schema: "hv-audio-policy/4", provider: "elevenlabs", model: "eleven_multilingual_v2",
      heldUsd: held, maxCharacters: ELEVENLABS_MAX_LINE_CHARACTERS, validFrom: "2026-09-21T03:00:00.000Z", expiresAt: "2027-09-21T03:00:00.000Z"});
  }
  expect(elevenLabsEvidenceManifest(evidence()).account).toMatchObject({provider: "elevenlabs", tier: "starter", characterLimit: 90_000, planUsdPerPeriod: 6});
});

test("a plan without the commercial licence, or a voice the account no longer has, is refused", () => {
  // A free plan may not use the output commercially, and a shared film uses it.
  expect(() => elevenLabsPolicyCatalogue(evidence({subscription: snapshot(JSON.stringify({tier: "free", character_limit: 10_000}))}), now)).toThrow("commercial licence");
  expect(() => elevenLabsPolicyCatalogue(evidence({voices: {url: "u", fetchedAt: "t", bytes: voiceList([SARAH])}}), now)).toThrow("no longer lists");
  expect(() => elevenLabsPolicyCatalogue(evidence({authorize: ["not-a-voice-id"]}), now)).toThrow("service's own voice ids");
  expect(() => elevenLabsPolicyCatalogue(evidence({authorize: []}), now)).toThrow("one and sixteen");
  expect(() => elevenLabsPolicyCatalogue(evidence({licence: []}), now)).toThrow("licence and price");
  expect(() => elevenLabsPolicyCatalogue(evidence({subscription: snapshot("not json")}), now)).toThrow("not readable");
  expect(() => elevenLabsPolicyCatalogue(evidence({voices: {url: "u", fetchedAt: "t", bytes: bytes("not json")}}), now)).toThrow("not readable");
  for (const price of [0, -1, 20_000]) expect(() => elevenLabsTakeHoldUsd(price, 90_000)).toThrow("allowance period");
  for (const limit of [0, 1.5]) expect(() => elevenLabsTakeHoldUsd(6, limit)).toThrow("character allowance");
});

test("what the evidence says is what the revisions bind", () => {
  const base = elevenLabsPolicyCatalogue(evidence(), now).policies[0]!;
  // Another voice appearing in the account does not move an authorized voice's permission.
  const more = elevenLabsPolicyCatalogue(evidence({voices: {url: "u", fetchedAt: "t", bytes: voiceList([ROGER, SARAH, GEORGE, "bIHbv24MWmeRgasZH58o"])}}), now).policies[0]!;
  expect(more.permissionRevision).toBe(base.permissionRevision);
  // New terms move the permission; a new price moves the price, not the permission.
  const terms = elevenLabsPolicyCatalogue(evidence({licence: [snapshot("new terms")]}), now).policies[0]!;
  expect(terms.permissionRevision).not.toBe(base.permissionRevision);
  const priced = elevenLabsPolicyCatalogue(evidence({price: snapshot("new pricing")}), now).policies[0]!;
  expect(priced.permissionRevision).toBe(base.permissionRevision);
  expect(priced.priceRevision).not.toBe(base.priceRevision);
  // A different plan price is a different hold, and so a different price revision.
  const dearer = elevenLabsPolicyCatalogue(evidence({planUsdPerPeriod: 22}), now).policies[0]!;
  expect(dearer.heldUsd).toBeGreaterThan(base.heldUsd);
  expect(dearer.priceRevision).not.toBe(base.priceRevision);
});
