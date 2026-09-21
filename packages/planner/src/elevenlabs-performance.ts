import {ELEVENLABS_SPEED} from "../../generator/src/elevenlabs-capability";
import {AudioPerformanceError, audioNumber, audioRecord, type AudioControls} from "./audio-performances";

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
