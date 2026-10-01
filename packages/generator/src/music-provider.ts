import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {MUSIC_PRICE_USD_PER_MINUTE, musicCueHoldUsd} from "../../operator/src/music-vendor-budget";

/**
 * HV-024-11: the music provider contract -- what the Composer may ask a music vendor for, and what
 * it accepts back.
 *
 * One cue is one request: a prompt, a length in whole seconds and a seed. What comes back is never
 * trusted as it arrives. Its bytes are probed with ffprobe, as a voice take's are, and decoded once
 * into the studio's 48 kHz stereo WAV by a fixed recipe. **Its cost is ours, not the vendor's**: it
 * is the probed length at the declared per-minute rate (`MUSIC_PRICE_USD_PER_MINUTE`), and never
 * more than the hold the cue was admitted with, whatever a response says it cost.
 *
 * Nothing here reaches the network. The ElevenLabs adapter (`elevenlabs-music.ts`) and the mock
 * below both answer through `deliverMusicCue`, so a test of the mock exercises the same checks the
 * live delivery must pass.
 */
export const MUSIC_CUE_SCHEMA = "hv-music-cue-request/1";
/** The shortest and longest cue the contract asks for. ElevenLabs Music's own bounds are unverified until the live proof. */
export const MUSIC_CUE_MIN_SEC = 10, MUSIC_CUE_MAX_SEC = 300;
export const MUSIC_PROMPT_MAX_CHARACTERS = 2000;
/** The delivered cue may be this much shorter or longer than asked (seconds) before it is refused. */
export const MUSIC_DURATION_TOLERANCE_SEC = 2;
const MAX_MUSIC_BYTES = 64 * 1024 * 1024;
/** The studio's own copy of a cue: 48 kHz, stereo, 16-bit PCM, with no metadata chunk. */
export const MUSIC_DECODE_RECIPE = Object.freeze({schema: "hv-music-decode/1", sampleRate: 48000, channels: 2, encoding: "pcm_s16le",
  resampler: "aresample=48000:resampler=swr:filter_size=64:phase_shift=10:exact_rational=1:dither_method=none"});

export class MusicCueError extends Error { override name = "MusicCueError"; }
/**
 * A failed cue, and whether the vendor may have been asked. `dispatched: false` means no request
 * left the studio, so its hold can be released; `true` means it may have been billed, so its hold
 * stays counted until the operator reconciles it.
 */
export class MusicProviderError extends Error {
  override name = "MusicProviderError";
  constructor(message: string, readonly dispatched: boolean, readonly providerRequestId: string | null = null) { super(message); }
}

export interface MusicCueRequest {schema: typeof MUSIC_CUE_SCHEMA; prompt: string; durationSec: number; seed: number; instrumental: true}

/** A request from anything: whole seconds within the bounds, a non-empty prompt, a 31-bit seed. */
export function validateMusicCueRequest(input: unknown): MusicCueRequest {
  const value = input as Record<string, unknown> | null;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new MusicCueError("Describe the cue with a prompt, a length and a seed.");
  const extra = Object.keys(value).filter(key => !["schema", "prompt", "durationSec", "seed", "instrumental"].includes(key));
  if (extra.length) throw new MusicCueError("A music cue has no " + extra[0] + ".");
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  if (!prompt || prompt.length > MUSIC_PROMPT_MAX_CHARACTERS || /[^\P{Cc}\n\t]/u.test(prompt))
    throw new MusicCueError(`Describe the music in one to ${MUSIC_PROMPT_MAX_CHARACTERS} characters, without control characters.`);
  const durationSec = value.durationSec;
  if (typeof durationSec !== "number" || !Number.isInteger(durationSec) || durationSec < MUSIC_CUE_MIN_SEC || durationSec > MUSIC_CUE_MAX_SEC)
    throw new MusicCueError(`Ask for a cue of ${MUSIC_CUE_MIN_SEC} to ${MUSIC_CUE_MAX_SEC} whole seconds.`);
  const seed = value.seed ?? 0;
  if (typeof seed !== "number" || !Number.isInteger(seed) || seed < 0 || seed > 0x7fffffff) throw new MusicCueError("Use a whole-number seed from 0 to 2147483647.");
  if (value.schema !== undefined && value.schema !== MUSIC_CUE_SCHEMA) throw new MusicCueError("Unknown music cue request schema.");
  if (value.instrumental !== undefined && value.instrumental !== true) throw new MusicCueError("A music cue is instrumental: the studio never asks a vendor to sing creator text.");
  return Object.freeze({schema: MUSIC_CUE_SCHEMA, prompt, durationSec, seed, instrumental: true});
}

/** What a provider hands back once its bytes have passed the contract. */
export interface MusicCueDelivery {
  provider: string; model: string; providerRequestId: string | null;
  /** What the vendor sent, as ffprobe named it. */
  sourceFormat: string;
  /** The probed length of what was delivered, in seconds. */
  durationSec: number;
  /** The studio's copy: 48 kHz stereo 16-bit PCM WAV. */
  wav: Buffer;
  sha256: string;
}

export interface MusicProvider {
  readonly name: string;
  readonly model: string;
  /** Who made it, for the sound library's rights record and the film's credits. */
  readonly rights: {basis: "original" | "licensed"; source: string; credit: string; terms: string};
  compose(request: MusicCueRequest, signal?: AbortSignal): Promise<MusicCueDelivery>;
}

/**
 * The cost of a delivered cue: its probed length at the declared rate, never above its hold.
 *
 * A vendor's own figure is not an input. A cue that came back a second longer than asked costs what
 * a cue of that length costs, up to the hold and no further; the line was checked against the hold.
 */
export function musicCueCostUsd(probedSec: number, heldUsd: number): number {
  if (!Number.isFinite(heldUsd) || heldUsd < 0) throw new MusicCueError("Invalid music hold.");
  if (!Number.isFinite(probedSec) || probedSec <= 0) return 0;
  return Math.min(heldUsd, musicCueHoldUsd(Math.min(probedSec, 600)));
}
export {MUSIC_PRICE_USD_PER_MINUTE};

export interface MusicProbe {format: string; codec: string; channels: number; sampleRate: number; durationSec: number}

async function run(args: string[], cwd: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const child = Bun.spawn(args, {cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore"});
  const abort = () => child.kill("SIGKILL"), timer = setTimeout(abort, 120000);
  signal?.addEventListener("abort", abort, {once: true});
  try {
    const code = await child.exited;
    signal?.throwIfAborted();
    // ffmpeg's own words are not repeated: they can quote the input's metadata back.
    if (code !== 0) throw new MusicCueError("The music cue could not be read as audio.");
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

/** One audio stream and nothing else, as ffprobe reads the bytes. */
export async function probeMusicAudio(bytes: Buffer, signal?: AbortSignal): Promise<MusicProbe> {
  if (!bytes.length || bytes.length > MAX_MUSIC_BYTES) throw new MusicCueError("The music cue is empty or larger than the studio accepts.");
  const directory = mkdtempSync(join(tmpdir(), "hv-music-probe-"));
  try {
    writeFileSync(join(directory, "cue.bin"), bytes, {flag: "wx"});
    await run(["ffprobe", "-v", "error", "-protocol_whitelist", "file", "-show_streams", "-show_format", "-of", "json", "-o", "probe.json", "cue.bin"], directory, signal);
    const probe = JSON.parse(readFileSync(join(directory, "probe.json"), "utf8")) as {streams?: Record<string, unknown>[]; format?: Record<string, unknown>};
    const streams = probe.streams ?? [];
    if (streams.length !== 1 || streams[0]!.codec_type !== "audio") throw new MusicCueError("The music cue must be one audio stream and nothing else.");
    const stream = streams[0]!, durationSec = Number(stream.duration ?? probe.format?.duration);
    const channels = Number(stream.channels), sampleRate = Number(stream.sample_rate);
    if (!Number.isFinite(durationSec) || durationSec <= 0 || ![1, 2].includes(channels) || !Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 192000)
      throw new MusicCueError("The music cue has no usable length, channels or sample rate.");
    return {format: String(probe.format?.format_name ?? ""), codec: String(stream.codec_name ?? ""), channels, sampleRate, durationSec};
  } finally { rmSync(directory, {recursive: true, force: true}); }
}

/** Decode once, by the fixed recipe, into the studio's WAV. The command is not owner-supplied. */
export async function decodeMusicCue(bytes: Buffer, signal?: AbortSignal): Promise<Buffer> {
  const directory = mkdtempSync(join(tmpdir(), "hv-music-decode-"));
  try {
    writeFileSync(join(directory, "cue.bin"), bytes, {flag: "wx"});
    await run(["ffmpeg", "-v", "error", "-nostdin", "-threads", "1", "-protocol_whitelist", "file", "-i", "cue.bin", "-vn", "-sn", "-dn", "-map_metadata", "-1",
      "-af", MUSIC_DECODE_RECIPE.resampler, "-ac", "2", "-c:a", "pcm_s16le", "-fflags", "+bitexact", "-flags:a", "+bitexact", "-f", "wav", "cue.wav"], directory, signal);
    const wav = readFileSync(join(directory, "cue.wav"));
    if (wav.length <= 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") throw new MusicCueError("The music cue did not decode to a WAV.");
    return wav;
  } finally { rmSync(directory, {recursive: true, force: true}); }
}

/**
 * The contract's one door: probe what came back, hold it to the request, decode it, probe the copy.
 * A provider calls this with the bytes it received and the formats it is allowed to send.
 */
export async function deliverMusicCue(bytes: Buffer, request: MusicCueRequest, accept: {formats: readonly string[]; provider: string; model: string; providerRequestId: string | null}, signal?: AbortSignal): Promise<MusicCueDelivery> {
  const probe = await probeMusicAudio(bytes, signal);
  if (!accept.formats.includes(probe.format)) throw new MusicCueError("The music cue is not in a format this provider may send.");
  if (probe.durationSec > request.durationSec + MUSIC_DURATION_TOLERANCE_SEC || probe.durationSec < request.durationSec - MUSIC_DURATION_TOLERANCE_SEC)
    throw new MusicCueError(`The music cue is ${probe.durationSec.toFixed(2)} s long; ${request.durationSec} s was asked for.`);
  const wav = await decodeMusicCue(bytes, signal), copy = await probeMusicAudio(wav, signal);
  if (copy.format !== "wav" || copy.codec !== "pcm_s16le" || copy.channels !== 2 || copy.sampleRate !== 48000 || Math.abs(copy.durationSec - probe.durationSec) > 0.1)
    throw new MusicCueError("The decoded music cue does not match what was delivered.");
  return {provider: accept.provider, model: accept.model, providerRequestId: accept.providerRequestId, sourceFormat: probe.format,
    durationSec: copy.durationSec, wav, sha256: createHash("sha256").update(wav).digest("hex")};
}

/**
 * The mock music adapter: deterministic audio, so the Composer's path can be tested end to end
 * without a vendor. The bytes depend only on the request -- the prompt and the seed pick a chord
 * and a tempo from fixed tables -- so the same request is always the same cue.
 *
 * It answers through `deliverMusicCue` like the live adapter, and it is priced like the vendor in
 * the ledger, so every test of the music line exercises its real figures. It is reachable only when
 * a test or a caller hands it to the studio; nothing in the environment selects it.
 */
export class MockMusicProvider implements MusicProvider {
  readonly name = "mock";
  readonly model = "mock-music/1";
  readonly rights = {basis: "original" as const, source: "Generated by this application's mock music adapter (mock-music/1)",
    credit: "Composer (AI crew), mock music adapter",
    terms: "Deterministic test audio rendered by the application's own code from fixed tables; no third-party recording, sample or model output."};
  readonly requests: MusicCueRequest[] = [];
  constructor(private readonly options: {fail?: "before-dispatch" | "after-dispatch"; stretchSec?: number} = {}) {}
  async compose(input: MusicCueRequest, signal?: AbortSignal): Promise<MusicCueDelivery> {
    const request = validateMusicCueRequest(input);
    this.requests.push(request);
    if (this.options.fail === "before-dispatch") throw new MusicProviderError("The mock music adapter was told to refuse.", false);
    if (this.options.fail === "after-dispatch") throw new MusicProviderError("The mock music adapter was told to fail after dispatch.", true, "mock-request");
    const wav = mockMusicWav(request, this.options.stretchSec ?? 0);
    try { return await deliverMusicCue(wav, request, {formats: ["wav"], provider: this.name, model: this.model, providerRequestId: null}, signal); }
    catch (error) { throw new MusicProviderError((error as Error).message, true, null); }
  }
}

/** A plain stereo chord, from the request alone. */
export function mockMusicWav(request: MusicCueRequest, stretchSec = 0): Buffer {
  const rate = 48000, frames = Math.round((request.durationSec + stretchSec) * rate);
  const digest = createHash("sha256").update(request.prompt + "\n" + request.seed).digest();
  const root = 110 * 2 ** ((digest[0]! % 12) / 12), minor = digest[1]! % 2 === 1, pulse = 0.5 + (digest[2]! % 4) * 0.25;
  const voices = [1, 2 ** ((minor ? 3 : 4) / 12), 2 ** (7 / 12), 2].map(ratio => root * ratio);
  const out = Buffer.alloc(44 + frames * 4);
  out.write("RIFF", 0, "ascii"); out.writeUInt32LE(36 + frames * 4, 4); out.write("WAVEfmt ", 8, "ascii"); out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20); out.writeUInt16LE(2, 22); out.writeUInt32LE(rate, 24); out.writeUInt32LE(rate * 4, 28); out.writeUInt16LE(4, 32); out.writeUInt16LE(16, 34);
  out.write("data", 36, "ascii"); out.writeUInt32LE(frames * 4, 40);
  for (let i = 0; i < frames; i++) {
    const t = i / rate, envelope = Math.min(1, i / 4800, (frames - 1 - i) / 4800) * (0.75 + 0.25 * Math.sin(2 * Math.PI * pulse * t));
    let left = 0, right = 0;
    for (const [index, f] of voices.entries()) { const v = Math.sin(2 * Math.PI * f * t) * 0.2; left += v * (1 - index * 0.15); right += v * (0.55 + index * 0.15); }
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, left * envelope * 0.5)) * 32767), 44 + i * 4);
    out.writeInt16LE(Math.round(Math.max(-1, Math.min(1, right * envelope * 0.5)) * 32767), 46 + i * 4);
  }
  return out;
}
