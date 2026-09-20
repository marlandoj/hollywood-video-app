import { createHash } from "node:crypto";
import { audioPolicy, type AudioPolicy } from "../../planner/src/audio-jobs";
import { AZURE_VOICES } from "./azure-capability";
import { contentHash } from "./capabilities";

/**
 * HV-022-03: the operator's Azure voice catalogue (HV_AUDIO_POLICY_FILE), built only from evidence
 * captured on the staging host -- never typed in:
 *
 * - account: the Speech resource's ID, tier and region (not secret), as the operator reads them in the portal;
 * - catalogue: Azure's own voice list for the region, fetched with the operator's key (not billed),
 *   which must list every voice authorized here;
 * - licence and price: snapshots of the pages reviewed, saved beside the catalogue.
 *
 * Each hash identifies a saved record; the records stay on the host (voice-evidence/).
 */
export const AZURE_REGION = "eastus";
/** Hold per take: 1,500 characters at up to $20 per million, above today's standard neural list price. */
export const AZURE_TAKE_HOLD_USD = 0.03;
export const AZURE_TAKE_MAX_CHARACTERS = 1500;
export const AZURE_VOICE_LABELS: Readonly<Record<(typeof AZURE_VOICES)[number], string>> = Object.freeze({
  "en-US-GuyNeural": "Guy (Azure)", "en-US-DavisNeural": "Davis (Azure)", "en-US-JaneNeural": "Jane (Azure)",
});

export interface EvidenceSnapshot { url: string; fetchedAt: string; bytes: Uint8Array }
export interface CatalogueEvidence {
  resourceId: string; sku: "F0" | "S0"; region: string;
  voices: EvidenceSnapshot; licence: EvidenceSnapshot[]; price: EvidenceSnapshot;
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const RESOURCE = /^\/subscriptions\/[0-9a-f-]{36}\/resourceGroups\/[A-Za-z0-9._()-]{1,90}\/providers\/Microsoft\.CognitiveServices\/accounts\/[A-Za-z0-9-]{2,64}$/;

export function evidenceManifest(evidence: CatalogueEvidence) {
  const entry = (snapshot: EvidenceSnapshot) => ({url: snapshot.url, fetchedAt: snapshot.fetchedAt, sha256: sha256(snapshot.bytes), bytes: snapshot.bytes.byteLength});
  return {schema: "hv-azure-voice-evidence/1", account: {provider: "azure", service: "speech", region: evidence.region, resourceId: evidence.resourceId, sku: evidence.sku},
    voices: entry(evidence.voices), licence: evidence.licence.map(entry), price: entry(evidence.price)};
}

export function azurePolicyCatalogue(evidence: CatalogueEvidence, now: Date, validDays = 365): {schema: "hv-audio-policies/1"; policies: AudioPolicy[]} {
  if (!RESOURCE.test(evidence.resourceId)) throw new Error("Use the Speech resource's full Azure resource ID.");
  if (!["F0", "S0"].includes(evidence.sku) || evidence.region !== AZURE_REGION) throw new Error("The adapter is pinned to the standard neural service in East US.");
  if (!evidence.licence.length || evidence.licence.some(snapshot => !snapshot.bytes.byteLength) || !evidence.price.bytes.byteLength) throw new Error("Save the licence and price pages that were reviewed.");
  let listed: {ShortName?: unknown; Locale?: unknown}[];
  try { listed = JSON.parse(new TextDecoder().decode(evidence.voices.bytes)); } catch { throw new Error("Azure's voice list is not readable."); }
  if (!Array.isArray(listed)) throw new Error("Azure's voice list is not readable.");
  const missing = AZURE_VOICES.filter(voiceId => !listed.some(voice => voice.ShortName === voiceId && voice.Locale === "en-US"));
  if (missing.length) throw new Error("Azure no longer lists " + missing.join(", ") + " in " + evidence.region + ".");
  const manifest = evidenceManifest(evidence);
  const validFrom = new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString();
  const expiresAt = new Date(Date.parse(validFrom) + validDays * 86_400_000).toISOString();
  const policies = AZURE_VOICES.map(voiceId => audioPolicy({provider: "azure", voiceId, label: AZURE_VOICE_LABELS[voiceId],
    // The authorized voices' own entries, so a new voice elsewhere in Azure's list changes nothing here.
    accountRevision: contentHash(manifest.account), catalogueRevision: contentHash(AZURE_VOICES.map(id => listed.find(voice => voice.ShortName === id && voice.Locale === "en-US"))),
    licenceEvidenceSha256: contentHash(manifest.licence.map(entry => entry.sha256)), priceEvidenceSha256: manifest.price.sha256,
    heldUsd: AZURE_TAKE_HOLD_USD, maxCharacters: AZURE_TAKE_MAX_CHARACTERS, validFrom, expiresAt}));
  return {schema: "hv-audio-policies/1", policies};
}
