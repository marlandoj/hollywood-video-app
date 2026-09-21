import { AZURE_VOICES } from "../../../generator/src/azure-capability";
import { validateAudioPolicy, type AudioPolicy } from "../audio-jobs";
import { audioVoiceProfile, type AudioVoiceProfile } from "../audio-performances";
import { ELEVENLABS_DEFAULTS } from "../elevenlabs-performance";
import type { CrewNote } from "./production-plan";
import type { ScriptIntroduction } from "./introductions";

/**
 * HV-022-02: the Composer/Sound persona casts a production voice for each speaking character,
 * deterministically, from the operator's authorized catalogue (HV_AUDIO_POLICY_FILE). Since
 * HV-022-09 that catalogue may hold more than one vendor, and the crew casts from the vendor the
 * operator put first (ElevenLabs), falling back to the next (Azure) for a part it cannot fill.
 * No model is asked and nothing is spent: the voice is only an assignment until a take is made.
 *
 * - A character that already has a voice keeps it; that voice counts as used. A real person
 *   (a consented cast member) is never given a synthetic voice by the crew.
 * - The voice's sex follows the script's own introduction (HV-017-05) when the script states it;
 *   otherwise any authorized voice may be chosen.
 * - Voices are shared out evenly, least-used first, in the catalogue's fixed order.
 * - With no authorized voice of the stated sex, the character keeps the temporary voice and the
 *   crew says so. Every Azure voice is an adult voice; a child is voiced by one and the crew says so.
 */
export const AZURE_VOICE_SEX: Readonly<Record<(typeof AZURE_VOICES)[number], "female" | "male">> = Object.freeze({
  "en-US-GuyNeural": "male", "en-US-DavisNeural": "male", "en-US-JaneNeural": "female",
});
/** A little brisker than Azure's default, so reads fit the rough cut's timing (the replacement keeps each line's start). */
export const CREW_VOICE_SPEED = 1.1;

export interface VoiceCastingCharacter { id: string; name: string; kind?: string; audioVoice?: AudioVoiceProfile }
export interface VoiceAssignment { characterId: string; name: string; voiceId: string; policyRevision: string; profile: AudioVoiceProfile }

export function crewVoiceProfile(policy: AudioPolicy): AudioVoiceProfile {
  const voice = {id: policy.voiceId, catalogueRevision: policy.catalogueRevision, permissionRevision: policy.permissionRevision};
  // Each vendor's profile is its own contract; the crew's brisker pace is the one thing they share.
  if (policy.provider === "elevenlabs") return audioVoiceProfile({schema: "hv-audio-voice/4", provider: "elevenlabs", language: "en", voice,
    controls: {speed: CREW_VOICE_SPEED, volume: 1, emotion: "neutral", ...ELEVENLABS_DEFAULTS}, pronunciations: []});
  return audioVoiceProfile({schema: "hv-audio-voice/2", provider: "azure", language: "en", voice,
    controls: {speed: CREW_VOICE_SPEED, volume: 1, emotion: "neutral", style: "neutral", intensity: 1}, pronunciations: []});
}

/** The sex a policy's own catalogue states for its voice: the vendor's label, or Azure's fixed map. */
export function policyVoiceSex(policy: AudioPolicy): "female" | "male" | "neutral" | undefined {
  if (policy.provider === "azure") return AZURE_VOICE_SEX[policy.voiceId as keyof typeof AZURE_VOICE_SEX];
  return policy.sex;
}
/**
 * HV-022-09: the operator's vendor order (G14). The crew casts from the vendor the operator put
 * first and falls back to the next when it has no authorized voice that fits the part.
 */
export const VOICE_VENDOR_ORDER: readonly AudioPolicy["provider"][] = Object.freeze(["elevenlabs", "azure"]);

export function castVoices(characters: VoiceCastingCharacter[], intros: ScriptIntroduction[], policies: AudioPolicy[], now = Date.now()): {assignments: VoiceAssignment[]; notes: CrewNote[]} {
  const valid = policies.flatMap(policy => { try { return [validateAudioPolicy(policy, now)]; } catch { return []; } });
  const usable = VOICE_VENDOR_ORDER.flatMap(provider => provider === "azure"
    // Azure's authorized voices keep their catalogue order, as they always had.
    ? AZURE_VOICES.flatMap(voiceId => valid.filter(policy => policy.provider === "azure" && policy.voiceId === voiceId))
    : valid.filter(policy => policy.provider === provider));
  const notes: CrewNote[] = [];
  if (!usable.length) return {assignments: [], notes};
  const uses = new Map<string, number>(usable.map(policy => [policy.voiceId, 0]));
  for (const character of characters) if (character.audioVoice && uses.has(character.audioVoice.voice.id)) uses.set(character.audioVoice.voice.id, uses.get(character.audioVoice.voice.id)! + 1);
  const assignments: VoiceAssignment[] = [];
  for (const character of characters) {
    // A real person's own voice is theirs to choose; the crew never gives them a synthetic one.
    if (character.audioVoice || (character.kind && character.kind !== "original-fictional")) continue;
    const intro = intros.find(value => value.name.toLocaleUpperCase("en-US") === character.name.toLocaleUpperCase("en-US"));
    const fitting = intro?.sex ? usable.filter(policy => policyVoiceSex(policy) === intro.sex) : usable;
    if (!fitting.length) { notes.push({persona: "sound", change: `No authorized ${intro!.sex} voice is available, so ${character.name} keeps the temporary voice.`}); continue; }
    // The operator's first vendor, if it has a voice for this part; otherwise the next that does.
    const preferred = VOICE_VENDOR_ORDER.map(provider => fitting.filter(policy => policy.provider === provider)).find(pool => pool.length)!;
    const policy = preferred.reduce((best, value) => uses.get(value.voiceId)! < uses.get(best.voiceId)! ? value : best);
    uses.set(policy.voiceId, uses.get(policy.voiceId)! + 1);
    assignments.push({characterId: character.id, name: character.name, voiceId: policy.voiceId, policyRevision: policy.revision, profile: crewVoiceProfile(policy)});
    if (intro?.age === "child") notes.push({persona: "sound", change: `${character.name} is a child, and every authorized voice is an adult's; ${policy.label} reads the part.`});
  }
  if (assignments.length) notes.unshift({persona: "sound", change: "Cast voices: " + assignments.map(value => `${value.name} (${usable.find(policy => policy.voiceId === value.voiceId)!.label})`).join(", ") + "."});
  return {assignments, notes};
}
