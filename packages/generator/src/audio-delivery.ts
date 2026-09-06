import {createHash} from "node:crypto";
import {AUDIO_SAMPLE_RATE} from "./audio-capabilities";
import {contentHash} from "./capabilities";
import {audioHash, audioNumber, audioRecord, audioText, AudioPerformanceError, validateAudioLinePlan, type AudioLinePlan} from "../../planner/src/audio-performances";

export interface AudioTiming {text: string; startSec: number; endSec: number}
export interface AudioLineDelivery {
  schema: "hv-audio-line-delivery/1";
  plan: AudioLinePlan;
  attemptId: string;
  format: {encoding: "pcm_s16le"; channels: 1; sampleRate: 48000};
  totalSamples: number;
  speechStartSample: number;
  speechEndSample: number;
  pcmSha256: string;
  speechPcmSha256: string;
  alignment: {basis: "provider-normalized-transcript"; origin: "speech-start"; words: AudioTiming[]; phonemes: AudioTiming[]};
  directionEvidence: "submitted-guidance-not-quality-evaluated";
  revision: string;
}
export const audioPcmHash = (pcm: Uint8Array): string => createHash("sha256").update(pcm).digest("hex");

function audioWav(pcm: Buffer): Buffer {
  // Preserve the requested studio sample rate. Legacy temporary speech keeps its
  // original 22050 Hz header and receipts; no resampling is hidden in this layer.
  const header = Buffer.alloc(44);
  header.write("RIFF"); header.writeUInt32LE(36 + pcm.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(AUDIO_SAMPLE_RATE, 24); header.writeUInt32LE(AUDIO_SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** Preserve provider tokens, including normalized numbers and pronunciation
 * substitutions. Never infer a word/phoneme mapping from caption proportions. */
export function validateAudioTimings(input: unknown, maxItems: number, durationSec: number): AudioTiming[] {
  if (!Array.isArray(input) || input.length > maxItems) throw new AudioPerformanceError("The provider returned too many timing entries.");
  let previousStart = 0, previousEnd = 0;
  return input.map(item => {
    const v = audioRecord(item, ["text", "startSec", "endSec"]), text = audioText(v.text, 2000, "timing token");
    const startSec = audioNumber(v.startSec, 0, durationSec + 1 / AUDIO_SAMPLE_RATE, "Alignment start"),
      endSec = audioNumber(v.endSec, startSec, durationSec + 1 / AUDIO_SAMPLE_RATE, "Alignment end");
    // Coarticulation may overlap adjacent tokens. Require ordered starts and ends,
    // not fabricated non-overlapping segments or a forced match to the screenplay.
    if (!text.length || startSec < previousStart || endSec < previousEnd) throw new AudioPerformanceError("The provider returned unordered or empty timing entries.");
    previousStart = startSec; previousEnd = endSec;
    return {text, startSec, endSec};
  });
}
export function createAudioDelivery(planInput: AudioLinePlan, attemptId: string, speechPcm: Buffer,
  words: AudioTiming[], phonemes: AudioTiming[]): {pcm: Buffer; wav: Buffer; report: AudioLineDelivery} {
  const plan = validateAudioLinePlan(planInput);
  if (!speechPcm.length || speechPcm.length % 2 || speechPcm.length > AUDIO_SAMPLE_RATE * 2 * 600)
    throw new AudioPerformanceError("The provider returned invalid or oversized line audio.");
  const start = Math.round(plan.beforeMs * AUDIO_SAMPLE_RATE / 1000), end = start + speechPcm.length / 2;
  const pcm = Buffer.concat([Buffer.alloc(start * 2), speechPcm, Buffer.alloc(Math.round(plan.afterMs * AUDIO_SAMPLE_RATE / 1000) * 2)]);
  const data = {schema: "hv-audio-line-delivery/1" as const, plan, attemptId,
    format: {encoding: "pcm_s16le", channels: 1, sampleRate: AUDIO_SAMPLE_RATE} as const,
    totalSamples: pcm.length / 2, speechStartSample: start, speechEndSample: end,
    pcmSha256: audioPcmHash(pcm), speechPcmSha256: audioPcmHash(speechPcm),
    alignment: {basis: "provider-normalized-transcript" as const, origin: "speech-start" as const, words, phonemes},
    directionEvidence: "submitted-guidance-not-quality-evaluated" as const};
  const report = validateAudioDelivery({...data, revision: contentHash(data)}, pcm);
  return {pcm, wav: audioWav(pcm), report};
}
export function validateAudioDelivery(input: AudioLineDelivery, pcm?: Buffer): AudioLineDelivery {
  audioRecord(input, ["schema", "plan", "attemptId", "format", "totalSamples", "speechStartSample", "speechEndSample", "pcmSha256", "speechPcmSha256", "alignment", "directionEvidence", "revision"]);
  const plan = validateAudioLinePlan(input.plan);
  if (input.schema !== "hv-audio-line-delivery/1" || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(input.attemptId)
    || contentHash(input.format) !== contentHash({encoding: "pcm_s16le", channels: 1, sampleRate: AUDIO_SAMPLE_RATE})
    || input.directionEvidence !== "submitted-guidance-not-quality-evaluated") throw new AudioPerformanceError("Invalid recorded audio delivery.");
  const start = Math.round(plan.beforeMs * AUDIO_SAMPLE_RATE / 1000);
  audioNumber(input.speechEndSample, start + 1, start + AUDIO_SAMPLE_RATE * 600, "Speech end", true);
  if (input.speechStartSample !== start || input.totalSamples !== input.speechEndSample + Math.round(plan.afterMs * AUDIO_SAMPLE_RATE / 1000))
    throw new AudioPerformanceError("The recorded exact pauses or duration changed.");
  audioRecord(input.alignment, ["basis", "origin", "words", "phonemes"]);
  if (input.alignment.basis !== "provider-normalized-transcript" || input.alignment.origin !== "speech-start")
    throw new AudioPerformanceError("Invalid provider alignment basis.");
  const duration = (input.speechEndSample - start) / AUDIO_SAMPLE_RATE;
  validateAudioTimings(input.alignment.words, 20000, duration);
  validateAudioTimings(input.alignment.phonemes, 100000, duration);
  if (!input.alignment.words.length || (plan.alignment === "words-and-phonemes" ? !input.alignment.phonemes.length : input.alignment.phonemes.length !== 0))
    throw new AudioPerformanceError("The provider did not return the requested alignment.");
  audioHash(input.pcmSha256); audioHash(input.speechPcmSha256);
  const {revision, ...data} = input;
  if (contentHash(data) !== audioHash(revision)) throw new AudioPerformanceError("The recorded audio delivery changed.");
  if (pcm && (pcm.length !== input.totalSamples * 2 || audioPcmHash(pcm) !== input.pcmSha256
    || audioPcmHash(pcm.subarray(start * 2, input.speechEndSample * 2)) !== input.speechPcmSha256
    || !pcm.subarray(0, start * 2).every(b => b === 0) || !pcm.subarray(input.speechEndSample * 2).every(b => b === 0)))
    throw new AudioPerformanceError("The owned audio bytes or exact silence changed.");
  return structuredClone(input);
}
