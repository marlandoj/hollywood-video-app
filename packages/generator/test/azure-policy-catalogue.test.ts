import { expect, test } from "bun:test";
import { validateAudioPolicy } from "../../planner/src/audio-jobs";
import { AZURE_TAKE_HOLD_USD, azurePolicyCatalogue, evidenceManifest } from "../src/azure-policy-catalogue";

// HV-022-03: the operator's catalogue is built only from saved evidence. Synthetic pages here.
const bytes = (text: string) => new TextEncoder().encode(text);
const listed = (names: string[], extra: object[] = []) => bytes(JSON.stringify([...names.map(ShortName => ({ShortName, Locale: "en-US", Gender: "x"})), ...extra]));
const evidence = (overrides: object = {}) => ({resourceId: "/subscriptions/17aec464-8564-4b4f-88f8-59118a42c13b/resourceGroups/RG_Rough_Cut/providers/Microsoft.CognitiveServices/accounts/Rough",
  sku: "S0" as const, region: "eastus", voices: {url: "https://eastus.tts.speech.microsoft.com/cognitiveservices/voices/list", fetchedAt: "2026-09-20T03:00:00.000Z",
    bytes: listed(["en-US-GuyNeural", "en-US-DavisNeural", "en-US-JaneNeural"])},
  licence: [{url: "https://example.test/terms", fetchedAt: "2026-09-20T03:00:00.000Z", bytes: bytes("terms")}],
  price: {url: "https://example.test/pricing", fetchedAt: "2026-09-20T03:00:00.000Z", bytes: bytes("pricing")}, ...overrides});
const now = new Date("2026-09-20T03:00:00.500Z");

test("three Azure voices, valid for a year, each checkable by the application's own validator", () => {
  const catalogue = azurePolicyCatalogue(evidence(), now);
  expect(catalogue.policies.map(policy => [policy.voiceId, policy.label])).toEqual([["en-US-GuyNeural", "Guy (Azure)"], ["en-US-DavisNeural", "Davis (Azure)"], ["en-US-JaneNeural", "Jane (Azure)"]]);
  for (const policy of catalogue.policies) {
    expect(validateAudioPolicy(policy, now.getTime())).toEqual(policy);
    expect(policy).toMatchObject({schema: "hv-audio-policy/2", provider: "azure", heldUsd: AZURE_TAKE_HOLD_USD, maxCharacters: 1500, validFrom: "2026-09-20T03:00:00.000Z", expiresAt: "2027-09-20T03:00:00.000Z"});
  }
  expect(evidenceManifest(evidence()).account).toEqual({provider: "azure", service: "speech", region: "eastus", resourceId: evidence().resourceId, sku: "S0"});
});

test("a new voice elsewhere in Azure's list changes nothing; new licence or price pages do", () => {
  const base = azurePolicyCatalogue(evidence(), now).policies[0]!;
  const more = azurePolicyCatalogue(evidence({voices: {...evidence().voices, bytes: listed(["en-US-GuyNeural", "en-US-DavisNeural", "en-US-JaneNeural"], [{ShortName: "en-US-NewNeural", Locale: "en-US"}])}}), now).policies[0]!;
  expect(more.permissionRevision).toBe(base.permissionRevision);
  const terms = azurePolicyCatalogue(evidence({licence: [{url: "u", fetchedAt: "t", bytes: bytes("new terms")}]}), now).policies[0]!;
  expect(terms.permissionRevision).not.toBe(base.permissionRevision);
  const price = azurePolicyCatalogue(evidence({price: {url: "u", fetchedAt: "t", bytes: bytes("new price")}}), now).policies[0]!;
  expect([price.permissionRevision, price.priceRevision === base.priceRevision]).toEqual([base.permissionRevision, false]);
});

test("nothing is authorized from missing or wrong evidence", () => {
  expect(() => azurePolicyCatalogue(evidence({resourceId: "Rough"}), now)).toThrow("resource ID");
  expect(() => azurePolicyCatalogue(evidence({region: "westeurope"}), now)).toThrow("East US");
  expect(() => azurePolicyCatalogue(evidence({licence: []}), now)).toThrow("licence and price");
  expect(() => azurePolicyCatalogue(evidence({voices: {...evidence().voices, bytes: listed(["en-US-GuyNeural"])}}), now)).toThrow("no longer lists en-US-DavisNeural, en-US-JaneNeural");
  expect(() => azurePolicyCatalogue(evidence({voices: {...evidence().voices, bytes: bytes("<html>")}}), now)).toThrow("not readable");
});
