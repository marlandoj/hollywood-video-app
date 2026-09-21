/**
 * HV-022-03: writes the operator's Azure voice catalogue on the staging host.
 * HV-022-07: and, with --vendor elevenlabs, the ElevenLabs one beside it in the same file.
 *
 *   set -a; . $RC_RUNTIME/secrets.env; set +a
 *   bun scripts/audio-policy.ts --out $RC_RUNTIME/audio-policies.json --evidence $RC_RUNTIME/voice-evidence \
 *     --resource-id /subscriptions/.../accounts/NAME --sku S0 \
 *     --licence-url URL [--licence-url URL ...] --price-url URL
 *   bun scripts/audio-policy.ts --vendor elevenlabs --out $RC_RUNTIME/audio-policies.json \
 *     --evidence $RC_RUNTIME/voice-evidence-elevenlabs --plan-usd 6 \
 *     --authorize VOICEID [--authorize VOICEID ...] --licence-url URL [--licence-url URL ...] --price-url URL
 *   bun scripts/audio-policy.ts --check $RC_RUNTIME/audio-policies.json
 *
 * It fetches Azure's voice list for East US with HV_AZURE_SPEECH_KEY (sent only in its header, never
 * printed), saves it and the licence and price pages as evidence, and writes the catalogue mode 600.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { azurePolicyCatalogue, AZURE_REGION, evidenceManifest, type EvidenceSnapshot } from "../packages/generator/src/azure-policy-catalogue";
import { elevenLabsEvidenceManifest, elevenLabsPolicyCatalogue } from "../packages/generator/src/elevenlabs-policy-catalogue";
import { configuredAudioPolicies } from "../packages/generator/src/audio-config";

const values = (name: string) => process.argv.flatMap((arg, index) => arg === name && process.argv[index + 1] ? [process.argv[index + 1]!] : []);
const one = (name: string) => { const found = values(name); if (found.length !== 1) throw new Error("Give " + name + " once."); return found[0]!; };

if (values("--check").length) {
  process.env.HV_AUDIO_POLICY_FILE = one("--check");
  const policies = configuredAudioPolicies();
  const now = Date.now(), valid = policies.filter(policy => now >= Date.parse(policy.validFrom) && now < Date.parse(policy.expiresAt));
  console.log(JSON.stringify({policies: policies.length, currentlyValid: valid.length, voices: policies.map(policy => policy.voiceId), expiresAt: policies[0]?.expiresAt ?? null}));
  if (!valid.length) process.exit(1);
} else if (values("--vendor").includes("elevenlabs")) {
  // The ElevenLabs catalogue. The key is sent in its own header and never printed; the account's
  // own subscription and voice list are saved as evidence beside the licence and price pages.
  const key = process.env.HV_ELEVENLABS_API_KEY;
  if (!key) throw new Error("HV_ELEVENLABS_API_KEY is not in this shell; source the runtime secrets first.");
  const snapshot = async (url: string, headers: Record<string, string> = {}): Promise<EvidenceSnapshot> => {
    const response = await fetch(url, {headers, redirect: "follow"});
    if (!response.ok) throw new Error("Could not fetch " + url.replace(/\?.*$/, "") + ": " + response.status);
    return {url, fetchedAt: new Date().toISOString(), bytes: new Uint8Array(await response.arrayBuffer())};
  };
  const subscription = await snapshot("https://api.elevenlabs.io/v1/user/subscription", {"xi-api-key": key});
  const voices = await snapshot("https://api.elevenlabs.io/v1/voices", {"xi-api-key": key});
  const licence = await Promise.all(values("--licence-url").map(url => snapshot(url)));
  const price = await snapshot(one("--price-url"));
  const evidence = {subscription, voices, licence, price, planUsdPerPeriod: Number(one("--plan-usd")), authorize: values("--authorize")};
  const catalogue = elevenLabsPolicyCatalogue(evidence, new Date());
  const directory = one("--evidence"); mkdirSync(directory, {recursive: true, mode: 0o700});
  const save = (name: string, bytes: Uint8Array | string) => { writeFileSync(join(directory, name), bytes, {mode: 0o600}); };
  save("subscription.json", subscription.bytes);
  save("voices.json", voices.bytes);
  licence.forEach((page, index) => save(`licence-${index + 1}.html`, page.bytes));
  save("price.html", price.bytes);
  save("manifest.json", JSON.stringify(elevenLabsEvidenceManifest(evidence), null, 2) + "\n");
  // Other vendors' authorized voices stay authorized: this adds to the catalogue, it does not replace it.
  const out = one("--out");
  const existing = existsSync(out) ? (JSON.parse(readFileSync(out, "utf8")).policies as {provider: string}[]).filter(policy => policy.provider !== "elevenlabs") : [];
  const merged = {schema: "hv-audio-policies/1" as const, policies: [...existing, ...catalogue.policies]};
  const temporary = out + ".pending";
  writeFileSync(temporary, JSON.stringify(merged, null, 2) + "\n", {mode: 0o600}); chmodSync(temporary, 0o600); renameSync(temporary, out);
  process.env.HV_AUDIO_POLICY_FILE = out; configuredAudioPolicies();
  console.log(JSON.stringify({written: out, added: catalogue.policies.map(policy => [policy.voiceId, policy.label, policy.heldUsd]),
    kept: existing.length, expiresAt: catalogue.policies[0]!.expiresAt, evidence: JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8")).account}));
} else {
  const key = process.env.HV_AZURE_SPEECH_KEY;
  if (!key) throw new Error("HV_AZURE_SPEECH_KEY is not in this shell; source the runtime secrets first.");
  const snapshot = async (url: string, headers: Record<string, string> = {}): Promise<EvidenceSnapshot> => {
    const response = await fetch(url, {headers, redirect: "follow"});
    if (!response.ok) throw new Error("Could not fetch " + url.replace(/\?.*$/, "") + ": " + response.status);
    return {url, fetchedAt: new Date().toISOString(), bytes: new Uint8Array(await response.arrayBuffer())};
  };
  const voices = await snapshot(`https://${AZURE_REGION}.tts.speech.microsoft.com/cognitiveservices/voices/list`, {"Ocp-Apim-Subscription-Key": key});
  const licence = await Promise.all(values("--licence-url").map(url => snapshot(url)));
  const price = await snapshot(one("--price-url"));
  const evidence = {resourceId: one("--resource-id"), sku: one("--sku") as "F0" | "S0", region: AZURE_REGION, voices, licence, price};
  const catalogue = azurePolicyCatalogue(evidence, new Date());
  const directory = one("--evidence"); mkdirSync(directory, {recursive: true, mode: 0o700});
  const save = (name: string, bytes: Uint8Array | string) => { writeFileSync(join(directory, name), bytes, {mode: 0o600}); };
  save("voices-list.json", voices.bytes);
  licence.forEach((page, index) => save(`licence-${index + 1}.html`, page.bytes));
  save("price.html", price.bytes);
  save("manifest.json", JSON.stringify(evidenceManifest(evidence), null, 2) + "\n");
  const out = one("--out"), temporary = out + ".pending";
  writeFileSync(temporary, JSON.stringify(catalogue, null, 2) + "\n", {mode: 0o600}); chmodSync(temporary, 0o600); renameSync(temporary, out);
  process.env.HV_AUDIO_POLICY_FILE = out; configuredAudioPolicies();
  console.log(JSON.stringify({written: out, voices: catalogue.policies.map(policy => policy.voiceId), expiresAt: catalogue.policies[0]!.expiresAt,
    evidence: JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"))}));
}
