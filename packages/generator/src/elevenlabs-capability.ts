import {contentHash} from "./capabilities";

/**
 * HV-022-05: the ElevenLabs contract, as a capability record.
 *
 * The operator approved a second voice vendor (G14). This file states exactly what the adapter
 * will ask for and what it will accept back; nothing here reaches the network, and no voice is
 * authorized by it — a voice is authorized only by the operator's catalogue evidence.
 *
 * Two facts shape the contract:
 *
 * - The service returns raw PCM, and every delivery in this application is 48 kHz mono
 *   (`AUDIO_SAMPLE_RATE`). The adapter therefore resamples with the one fixed ffmpeg recipe
 *   already used for retained editorial audio, and the capability says so rather than pretending
 *   the service returns 48 kHz.
 * - **The rate asked for is 24 kHz, not the service's highest.** `pcm_44100` is sold with the Pro
 *   plan and refused below it (HV-022-12: the first live take was refused with "Output format
 *   'pcm_44100' is only available on the Pro tier and above"), while `pcm_24000` is returned on
 *   every plan including the free one. A contract that only works on one plan is not a contract
 *   this studio can hold, and a lossless 24 kHz read carries speech — whose energy sits below
 *   8 kHz — with no codec artefacts, which an MP3 alternative at any bitrate would add before the
 *   mix. So the rate is fixed here for every account rather than derived from the operator's plan,
 *   which also keeps one capability revision across accounts.
 * - Timing comes from the `with-timestamps` endpoint, which aligns *characters*, not words. Word
 *   timings are derived from those characters by the adapter, and the basis is recorded as such.
 */
export const ELEVENLABS_MODEL = "eleven_multilingual_v2";
export const ELEVENLABS_API_VERSION = "v1-2026-09-21";
export const ELEVENLABS_HOST = "https://api.elevenlabs.io";
export const ELEVENLABS_OUTPUT_FORMAT = "pcm_24000";
export const ELEVENLABS_SAMPLE_RATE = 24000;
/** The service's own per-request ceiling for this model (models.json, `max_characters_request_subscribed_user`). */
export const ELEVENLABS_MAX_LINE_CHARACTERS = 10000;
/** A voice ID as the service issues them: twenty URL-safe characters, not a UUID. */
export const ELEVENLABS_VOICE_ID = /^[A-Za-z0-9]{20}$/;
/** `voice_settings.speed` is the only pacing control this model accepts, and only in this band. */
export const ELEVENLABS_SPEED = {min: 0.7, max: 1.2} as const;

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

const definition = {
  schema: "hv-audio-capability/4" as const,
  provider: "elevenlabs" as const,
  model: ELEVENLABS_MODEL,
  apiVersion: ELEVENLABS_API_VERSION,
  qualification: "transport-fixtures-only" as const,
  languages: ["en"],
  voices: "operator-authorized-catalogue-only",
  modelVersion: "service-managed-not-pinnable",
  controls: {
    speed: {min: ELEVENLABS_SPEED.min, max: ELEVENLABS_SPEED.max, interpretation: "voice-settings-speed"},
    // The service has no loudness control. A line that asks for one is refused before dispatch
    // rather than quietly delivered at the wrong level.
    volume: false,
    emotion: false,
    style: {min: 0, max: 1, step: 0.01, interpretation: "voice-settings-style-exaggeration"},
    stability: {min: 0, max: 1, step: 0.01, interpretation: "voice-settings-stability"},
    similarity: {min: 0, max: 1, step: 0.01, interpretation: "voice-settings-similarity-boost"},
    wordEmphasis: false,
    phraseVolume: false,
    notes: "retained-direction-only",
    pauses: "local-exact-silence",
  },
  alignment: {words: true, phonemes: false, visemes: false, basis: "derived-from-provider-character-alignment"},
  output: {encoding: "pcm_s16le", channels: 1, sampleRate: 48000, maxSpeechSeconds: 600,
    provider: {encoding: "pcm_s16le", channels: 1, sampleRate: ELEVENLABS_SAMPLE_RATE},
    conversion: "ffmpeg aresample=48000:resampler=swr:filter_size=64:phase_shift=10:exact_rational=1:dither_method=none"},
  maxLineCharacters: ELEVENLABS_MAX_LINE_CHARACTERS,
  maxTranscriptCharacters: ELEVENLABS_MAX_LINE_CHARACTERS,
  voiceIdentity: "current-catalogue-and-permission-revisions-required",
  voiceCloning: false,
  determinism: "none",
  cancellation: "disconnect-billing-unconfirmed",
  // The plan is prepaid in characters, so a take's dollar cost is the plan's own rate for the
  // characters it spends. The operator's catalogue carries that rate and its evidence.
  billing: {unit: "characters", actualUsd: null, quota: "monthly-character-allowance",
    reconciliation: "operator-subscription-allocation"},
  documentation: [
    "https://elevenlabs.io/docs/api-reference/text-to-speech/convert-with-timestamps",
    "https://elevenlabs.io/docs/api-reference/models/list",
    "https://elevenlabs.io/docs/api-reference/voices/get-all",
    "https://elevenlabs.io/terms-of-use",
    "https://elevenlabs.io/pricing",
  ],
};

export const ELEVENLABS_AUDIO_CAPABILITY = freeze({...definition, revision: contentHash(definition)});
