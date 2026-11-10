import {ELEVENLABS_MAX_CONTEXT_CHARACTERS, ELEVENLABS_SPEED} from "../../generator/src/elevenlabs-capability";
import {gateOrThrow} from "../../safety/src/index";
import {AudioPerformanceError, audioNumber, audioRecord, audioText, type AudioControls} from "./audio-performances";
import type {LineSource} from "./performances";

/**
 * HV-022-05: the ElevenLabs line controls.
 *
 * The service takes four numbers per request and no loudness at all: `speed` paces the read,
 * `stability` holds it to one delivery, `similarity_boost` holds it to the catalogue voice, and
 * `style` exaggerates that voice's own manner. A line that asks for a volume change or another
 * provider's emotion is refused here, before any reservation or dispatch, rather than delivered at
 * a level the service never applied.
 */
export const ELEVENLABS_DEFAULTS = Object.freeze({stability: 0.5, similarity: 0.75, exaggeration: 0});
const hundredths = (value: number, label: string) => {
  if (Math.abs(value * 100 - Math.round(value * 100)) > 1e-8) throw new AudioPerformanceError(`Use ${label} in steps of 0.01.`);
  return value;
};

export function elevenLabsControls(input: unknown): AudioControls {
  const v = audioRecord(input, ["speed", "volume", "emotion", "stability", "similarity", "exaggeration"]);
  if (v.emotion !== "neutral") throw new AudioPerformanceError("This voice contract has no emotion control; direct the read with stability, similarity and exaggeration.");
  if (v.volume !== 1) throw new AudioPerformanceError("This voice contract has no loudness control. Keep volume at 1 and set the level in the mix.");
  return {
    speed: hundredths(audioNumber(v.speed, ELEVENLABS_SPEED.min, ELEVENLABS_SPEED.max, "Speed"), "speed"),
    volume: 1,
    emotion: "neutral",
    stability: hundredths(audioNumber(v.stability ?? ELEVENLABS_DEFAULTS.stability, 0, 1, "Stability"), "stability"),
    similarity: hundredths(audioNumber(v.similarity ?? ELEVENLABS_DEFAULTS.similarity, 0, 1, "Similarity"), "similarity"),
    exaggeration: hundredths(audioNumber(v.exaggeration ?? ELEVENLABS_DEFAULTS.exaggeration, 0, 1, "Exaggeration"), "exaggeration"),
  };
}

/**
 * HV-022-22: the dialogue either side of an ElevenLabs line, sent as `previous_text` and `next_text`
 * so the line is read in conversation. Context is never spoken: it is plain screenplay text, at most
 * `ELEVENLABS_MAX_CONTEXT_CHARACTERS` a side, with no speech tags, and it passes the safety gate.
 */
export interface ElevenLabsLineContext {previousText?: string; nextText?: string}
export function elevenLabsContext(input: unknown): ElevenLabsLineContext {
  const v = audioRecord(input, ["previousText", "nextText"]), context: ElevenLabsLineContext = {};
  for (const key of ["previousText", "nextText"] as const) {
    if (v[key] === undefined) continue;
    const text = audioText(v[key], ELEVENLABS_MAX_CONTEXT_CHARACTERS, "conversation context");
    if (!text.trim() || text !== text.trim() || /[<>]/.test(text)) throw new AudioPerformanceError("Use plain neighbouring dialogue as the line's conversation context.");
    gateOrThrow(text);
    context[key] = text;
  }
  return context;
}
/** The characters a take sends, and so holds: its spoken text and any conversation context. */
export function elevenLabsBilledCharacters(line: {spokenText: string; context?: ElevenLabsLineContext}): number {
  return line.spokenText.length + (line.context?.previousText?.length ?? 0) + (line.context?.nextText?.length ?? 0);
}
/**
 * The context the take route sends for one scene line: the line before it and the line after it,
 * whoever speaks them. A neighbour is left out, never shortened or refused, when it is longer than
 * the context limit, has speech tags or does not pass the safety gate, or when it would take the
 * take's characters past the policy's ceiling (`maxCharacters`). So a line admitted before this
 * contract is never refused for its context, and its hold never passes the policy's price.
 */
export function elevenLabsLineContext(sources: readonly LineSource[], index: number, spokenCharacters: number, maxCharacters: number): ElevenLabsLineContext {
  const usable = (source: LineSource | undefined) => {
    if (!source) return undefined;
    try { return elevenLabsContext({previousText: source.text.trim()}).previousText; } catch { return undefined; }
  };
  const context: ElevenLabsLineContext = {};
  let room = maxCharacters - spokenCharacters;
  const previous = usable(sources[index - 1]);
  if (previous && previous.length <= room) { context.previousText = previous; room -= previous.length; }
  const next = usable(sources[index + 1]);
  if (next && next.length <= room) context.nextText = next;
  return context;
}
