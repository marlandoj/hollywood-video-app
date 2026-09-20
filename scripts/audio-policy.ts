/**
 * HV-022-03: writes the operator's Azure voice catalogue on the staging host.
 *
 *   set -a; . $RC_RUNTIME/secrets.env; set +a
 *   bun scripts/audio-policy.ts --out $RC_RUNTIME/audio-policies.json --evidence $RC_RUNTIME/voice-evidence \
 *     --resource-id /subscriptions/.../accounts/NAME --sku S0 \
 *     --licence-url URL [--licence-url URL ...] --price-url URL
 *   bun scripts/audio-policy.ts --check $RC_RUNTIME/audio-policies.json
 *
 * It fetches Azure's voice list for East US with HV_AZURE_SPEECH_KEY (sent only in its header, never
 * printed), saves it and the licence and price pages as evidence, and writes the catalogue mode 600.
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { azurePolicyCatalogue, AZURE_REGION, evidenceManifest, type EvidenceSnapshot } from "../packages/generator/src/azure-policy-catalogue";
import { configuredAudioPolicies } from "../packages/generator/src/audio-config";

const values = (name: string) => process.argv.flatMap((arg, index) => arg === name && process.argv[index + 1] ? [process.argv[index + 1]!] : []);
const one = (name: string) => { const found = values(name); if (found.length !== 1) throw new Error("Give " + name + " once."); return found[0]!; };

if (values("--check").length) {
  process.env.HV_AUDIO_POLICY_FILE = one("--check");
  const policies = configuredAudioPolicies();
  const now = Date.now(), valid = policies.filter(policy => now >= Date.parse(policy.validFrom) && now < Date.parse(policy.expiresAt));
  console.log(JSON.stringify({policies: policies.length, currentlyValid: valid.length, voices: policies.map(policy => policy.voiceId), expiresAt: policies[0]?.expiresAt ?? null}));
  if (!valid.length) process.exit(1);
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
