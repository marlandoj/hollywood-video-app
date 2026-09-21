import {ELEVENLABS_API_VERSION, ELEVENLABS_HOST, ELEVENLABS_MAX_LINE_CHARACTERS, ELEVENLABS_MODEL, ELEVENLABS_OUTPUT_FORMAT, ELEVENLABS_VOICE_ID} from "./elevenlabs-capability";
import {AudioPerformanceError, type AudioLinePlan} from "../../planner/src/audio-performances";

/**
 * HV-022-05: one ElevenLabs request, built from an admitted line plan and nothing else.
 *
 * The timestamped endpoint is the only one used: it returns the audio and the alignment together,
 * so a delivery never has to be matched to a second call. The request carries no account, endpoint,
 * webhook or model the operator did not authorize through the capability.
 */
export interface ElevenLabsRequest {
  provider: "elevenlabs";
  model: string;
  apiVersion: string;
  url: string;
  outputFormat: string;
  body: {
    text: string;
    model_id: string;
    apply_text_normalization: "auto";
    voice_settings: {stability: number; similarity_boost: number; style: number; use_speaker_boost: false; speed: number};
  };
}

export function elevenLabsLineRequest(plan: AudioLinePlan): ElevenLabsRequest {
  const id = plan.profile.voice.id, controls = plan.profile.controls;
  if (plan.profile.provider !== "elevenlabs" || !ELEVENLABS_VOICE_ID.test(id)) throw new AudioPerformanceError("This line belongs to another voice adapter.");
  const text = plan.spokenText;
  if (!text.trim() || text.length > ELEVENLABS_MAX_LINE_CHARACTERS) throw new AudioPerformanceError(`Use a spoken line of at most ${ELEVENLABS_MAX_LINE_CHARACTERS} characters for this voice.`);
  for (const [label, value] of [["stability", controls.stability], ["similarity", controls.similarity], ["exaggeration", controls.exaggeration]] as const)
    if (typeof value !== "number") throw new AudioPerformanceError(`This line has no ${label} for an ElevenLabs read.`);
  return {
    provider: "elevenlabs", model: ELEVENLABS_MODEL, apiVersion: ELEVENLABS_API_VERSION,
    // `stream` is not used: the delivery is validated whole before anything is attached.
    url: `${ELEVENLABS_HOST}/v1/text-to-speech/${id}/with-timestamps?output_format=${ELEVENLABS_OUTPUT_FORMAT}`,
    outputFormat: ELEVENLABS_OUTPUT_FORMAT,
    body: {text, model_id: ELEVENLABS_MODEL, apply_text_normalization: "auto",
      voice_settings: {stability: controls.stability!, similarity_boost: controls.similarity!, style: controls.exaggeration!, use_speaker_boost: false, speed: controls.speed}},
  };
}

/**
 * The service aligns characters, not words. A word is the span from the first character of a run of
 * non-space characters to the last, in the order the service returns them; a character whose timing
 * is missing, out of order or outside the audio makes the delivery unusable rather than approximate.
 */
export interface ElevenLabsAlignment {characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[]}
export function elevenLabsWordTimings(alignment: ElevenLabsAlignment, seconds: number): {text: string; startSec: number; endSec: number}[] {
  const {characters, character_start_times_seconds: starts, character_end_times_seconds: ends} = alignment;
  if (!Array.isArray(characters) || characters.length > 200_000 || starts?.length !== characters.length || ends?.length !== characters.length)
    throw new AudioPerformanceError("The read's character alignment is unusable.");
  const words: {text: string; startSec: number; endSec: number}[] = [];
  let text = "", start = 0, end = 0, previous = -Infinity;
  const flush = () => { if (text.trim()) words.push({text, startSec: start, endSec: end}); text = ""; };
  for (const [index, character] of characters.entries()) {
    const from = starts[index]!, to = ends[index]!;
    if (typeof character !== "string" || character.length > 8 || !Number.isFinite(from) || !Number.isFinite(to) || from < 0 || to < from || to > seconds + 0.05 || from < previous - 1e-6)
      throw new AudioPerformanceError("The read's character alignment is unusable.");
    previous = from;
    if (/^\s+$/.test(character)) { flush(); continue; }
    if (!text) start = from;
    text += character; end = to;
  }
  flush();
  if (!words.length) throw new AudioPerformanceError("The read returned no aligned words.");
  return words;
}
