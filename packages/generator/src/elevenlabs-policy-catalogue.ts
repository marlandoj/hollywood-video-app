import { createHash } from "node:crypto";
import { audioPolicy, type AudioPolicy } from "../../planner/src/audio-jobs";
import { ELEVENLABS_MAX_LINE_CHARACTERS, ELEVENLABS_VOICE_ID } from "./elevenlabs-capability";
import { contentHash } from "./capabilities";

/**
 * HV-022-07: the operator's authorized ElevenLabs voices, built only from evidence captured on the
 * staging host — never typed in:
 *
 * - account: the subscription the key answers as (tier, character allowance, refresh period). A
 *   free account may not use the output commercially, so a catalogue is refused for one.
 * - catalogue: the account's own voice list, which must contain every voice authorized here, with
 *   the service's own ids.
 * - licence and price: snapshots of the pages reviewed, saved beside the catalogue.
 *
 * The cost of a take is not a per-call price: the plan buys a monthly character allowance, so a
 * take's hold is the plan's rate for the characters it may spend — the monthly price over the
 * monthly allowance, times the line's ceiling. The rate the operator reviewed is passed in with the
 * page it came from; nothing here invents one.
 */
export interface ElevenLabsSubscription {tier: string; character_limit: number; character_count?: number; character_refresh_period?: string; status?: string; currency?: string}
export interface ElevenLabsVoiceRecord {voice_id: string; name: string; category?: string; labels?: Record<string, string>}
export interface EvidenceSnapshot { url: string; fetchedAt: string; bytes: Uint8Array }
export interface ElevenLabsCatalogueEvidence {
  subscription: EvidenceSnapshot;
  voices: EvidenceSnapshot;
  licence: EvidenceSnapshot[];
  price: EvidenceSnapshot;
  /** The plan's price for one allowance period, as the operator read it on the price page. */
  planUsdPerPeriod: number;
  /** The voices to authorize, by the service's own id. */
  authorize: string[];
}
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** The vendor's own label, and nothing inferred from a name. */
export function voiceSex(voice: ElevenLabsVoiceRecord): "female" | "male" | "neutral" | undefined {
  const stated = voice.labels?.gender?.trim().toLowerCase();
  return stated === "female" || stated === "male" || stated === "neutral" ? stated : undefined;
}
const text = (snapshot: EvidenceSnapshot) => new TextDecoder().decode(snapshot.bytes);

export function elevenLabsEvidenceManifest(evidence: ElevenLabsCatalogueEvidence) {
  const subscription = readSubscription(evidence);
  const entry = (snapshot: EvidenceSnapshot) => ({url: snapshot.url, fetchedAt: snapshot.fetchedAt, sha256: sha256(snapshot.bytes), bytes: snapshot.bytes.byteLength});
  return {schema: "hv-elevenlabs-voice-evidence/1",
    account: {provider: "elevenlabs", service: "text-to-speech", tier: subscription.tier, characterLimit: subscription.character_limit,
      refreshPeriod: subscription.character_refresh_period ?? "unknown", planUsdPerPeriod: evidence.planUsdPerPeriod},
    subscription: entry(evidence.subscription), voices: entry(evidence.voices), licence: evidence.licence.map(entry), price: entry(evidence.price)};
}

function readSubscription(evidence: ElevenLabsCatalogueEvidence): ElevenLabsSubscription {
  let value: ElevenLabsSubscription;
  try { value = JSON.parse(text(evidence.subscription)); } catch { throw new Error("The account's subscription record is not readable."); }
  if (!value || typeof value.tier !== "string" || !Number.isInteger(value.character_limit) || value.character_limit <= 0)
    throw new Error("The account's subscription record is not readable.");
  // A free account may not use the output commercially, and a film made here is used.
  if (/free/i.test(value.tier)) throw new Error("This account's plan does not carry the commercial licence a shared film needs.");
  return value;
}

/** The dollars a take may spend: the plan's rate per character, times the line's character ceiling. */
export function elevenLabsTakeHoldUsd(planUsdPerPeriod: number, characterLimit: number, maxCharacters = ELEVENLABS_MAX_LINE_CHARACTERS): number {
  if (!Number.isFinite(planUsdPerPeriod) || planUsdPerPeriod <= 0 || planUsdPerPeriod > 10_000) throw new Error("Give the plan's price for one allowance period.");
  if (!Number.isInteger(characterLimit) || characterLimit <= 0) throw new Error("Give the account's own character allowance.");
  const held = Number((planUsdPerPeriod / characterLimit * maxCharacters).toFixed(6));
  return Math.max(0.000001, held);
}

export function elevenLabsPolicyCatalogue(evidence: ElevenLabsCatalogueEvidence, now: Date, validDays = 365): {schema: "hv-audio-policies/1"; policies: AudioPolicy[]} {
  const subscription = readSubscription(evidence);
  if (!evidence.licence.length || evidence.licence.some(snapshot => !snapshot.bytes.byteLength) || !evidence.price.bytes.byteLength)
    throw new Error("Save the licence and price pages that were reviewed.");
  let listed: ElevenLabsVoiceRecord[];
  try { const value = JSON.parse(text(evidence.voices)); listed = Array.isArray(value?.voices) ? value.voices : value; } catch { throw new Error("The account's voice list is not readable."); }
  if (!Array.isArray(listed) || !listed.length) throw new Error("The account's voice list is not readable.");
  const authorize = [...new Set(evidence.authorize)];
  if (!authorize.length || authorize.length > 16) throw new Error("Authorize between one and sixteen voices.");
  if (authorize.some(id => !ELEVENLABS_VOICE_ID.test(id))) throw new Error("Use the service's own voice ids.");
  const chosen = authorize.map(id => {
    const voice = listed.find(record => record?.voice_id === id);
    if (!voice || typeof voice.name !== "string" || !voice.name.trim()) throw new Error("This account no longer lists " + id + ".");
    return voice;
  });
  const manifest = elevenLabsEvidenceManifest(evidence);
  const validFrom = new Date(Math.floor(now.getTime() / 1000) * 1000).toISOString();
  const expiresAt = new Date(Date.parse(validFrom) + validDays * 86_400_000).toISOString();
  const heldUsd = elevenLabsTakeHoldUsd(evidence.planUsdPerPeriod, subscription.character_limit);
  const policies = chosen.map(voice => audioPolicy({provider: "elevenlabs", voiceId: voice.voice_id,
    label: (voice.name.split(" - ")[0] ?? voice.name).trim().slice(0, 60) + " (ElevenLabs)",
    accountRevision: contentHash(manifest.account),
    // The authorized voices' own entries, so another voice appearing in the account changes nothing here.
    catalogueRevision: contentHash(chosen.map(record => ({id: record.voice_id, name: record.name, category: record.category ?? null, labels: record.labels ?? null}))),
    licenceEvidenceSha256: contentHash(manifest.licence.map(entry => entry.sha256)), priceEvidenceSha256: manifest.price.sha256,
    // HV-022-09: the account's own label for the voice, so the crew can cast by the script's stated
    // sex without anyone typing a judgement about a voice into this repository.
    ...(voiceSex(voice) ? {sex: voiceSex(voice)!} : {}),
    heldUsd, maxCharacters: ELEVENLABS_MAX_LINE_CHARACTERS, validFrom, expiresAt}));
  return {schema: "hv-audio-policies/1", policies};
}
