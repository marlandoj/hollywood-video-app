import {AZURE_AUDIO_CAPABILITY} from "./azure-capability";
import {contentHash} from "./capabilities";

export const CARTESIA_MODEL = "sonic-3.6-2026-08-27";
export const CARTESIA_API_VERSION = "2026-08-14";
export const AUDIO_SAMPLE_RATE = 48000;
export const AUDIO_EMOTIONS = ["neutral", "calm", "angry", "content", "sad", "scared"] as const;
export type AudioEmotion = typeof AUDIO_EMOTIONS[number];

function freeze<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
}

// This is an audio contract, not a video routing capability. In particular it has no
// zero-dollar price and cannot be admitted through the temporary-speech render lane.
const definition = {
  schema: "hv-audio-capability/1" as const,
  provider: "cartesia" as const,
  model: CARTESIA_MODEL,
  apiVersion: CARTESIA_API_VERSION,
  qualification: "transport-fixtures-only" as const,
  languages: ["en"],
  controls: {
    speed: {min: 0.6, max: 1.5, interpretation: "guidance"},
    volume: {min: 0.5, max: 2, interpretation: "guidance"},
    emotion: {values: [...AUDIO_EMOTIONS], interpretation: "experimental-guidance", languages: ["en"]},
    wordEmphasis: false,
    pitch: false,
    notes: "retained-direction-only",
    pauses: "local-exact-silence",
  },
  alignment: {words: true, phonemes: true, basis: "provider-normalized-transcript"},
  output: {encoding: "pcm_s16le", channels: 1, sampleRate: AUDIO_SAMPLE_RATE, maxSpeechSeconds: 600},
  maxLineCharacters: 20000,
  voiceIdentity: "current-catalogue-and-permission-revisions-required",
  voiceCloning: false,
  determinism: "none",
  cancellation: "disconnect-billing-unconfirmed",
  billing: {unit: "credits", approximateCreditsPerCharacter: 1, actualUsd: null,
    usageGranularity: "aggregate", reconciliation: "required-before-settlement"},
  documentation: [
    "https://docs.cartesia.ai/build-with-cartesia/tts-models/latest",
    "https://docs.cartesia.ai/build-with-cartesia/capability-guides/volume-speed-emotion",
    "https://docs.cartesia.ai/build-with-cartesia/capability-guides/ssml-tags",
    "https://docs.cartesia.ai/api-reference/tts/sse",
    "https://docs.cartesia.ai/api-reference/usage/credits",
    "https://docs.cartesia.ai/pricing",
  ],
};

export const CARTESIA_AUDIO_CAPABILITY = freeze({...definition, revision: contentHash(definition)});

// Additive contract: old line plans and dispatch receipts retain their original revision.
const phraseDefinition={...definition,schema:"hv-audio-capability/2" as const,controls:{...definition.controls,
  phraseDirection:{maxRanges:16,boundaries:"source-whitespace-tokens",speed:"inline-guidance",volume:"inline-guidance",pauses:"provider-requested-0-to-3000ms",emotion:false,wordEmphasis:false}},
  transcript:"compiler-generated-speed-volume-break-tags",maxTranscriptCharacters:40000};
export const CARTESIA_PHRASE_CAPABILITY=freeze({...phraseDefinition,revision:contentHash(phraseDefinition)});
export const AUDIO_CAPABILITIES=freeze([CARTESIA_AUDIO_CAPABILITY,CARTESIA_PHRASE_CAPABILITY,AZURE_AUDIO_CAPABILITY]);
export function audioCapability(revision:string){return AUDIO_CAPABILITIES.find(c=>c.revision===revision);}
