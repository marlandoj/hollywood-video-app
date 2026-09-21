import {randomUUID} from "node:crypto";
import {mkdtempSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ELEVENLABS_API_VERSION, ELEVENLABS_AUDIO_CAPABILITY, ELEVENLABS_MODEL, ELEVENLABS_SAMPLE_RATE} from "./elevenlabs-capability";
import {elevenLabsLineRequest, elevenLabsWordTimings, type ElevenLabsAlignment} from "./elevenlabs-request";
import {AUDIO_SAMPLE_RATE} from "./audio-capabilities";
import {contentHash} from "./capabilities";
import {audioAbortable, AudioStreamError} from "./audio-stream";
import {createAudioDelivery, type AudioTiming} from "./audio-delivery";
import {audioNumber, validateAudioLinePlan, type AudioLinePlan} from "../../planner/src/audio-performances";
import {AudioProviderError, validateAudioOutcome, type AudioAttemptJournal, type AudioAttemptOutcome, type AudioDispatchIntent} from "./cartesia-audio";

/**
 * HV-022-06: the ElevenLabs adapter, on the same protocol as the others — authorize, assert the
 * permission again, dispatch exactly once, record the outcome whatever happened.
 *
 * Two things are this adapter's own:
 *
 * - The service returns 44.1 kHz and every delivery here is 48 kHz, so the read is resampled once,
 *   with the fixed recipe the capability names. The conversion is deterministic and its command is
 *   not owner-supplied.
 * - The service aligns characters. The words come from `normalized_alignment` when the service
 *   sends one, because that is the text it actually spoke, and from `alignment` otherwise.
 *
 * No retry, alternate voice or second dispatch exists: one reservation, one request.
 */
const MAX_AUDIO_BYTES = ELEVENLABS_SAMPLE_RATE * 2 * 600;
export interface ElevenLabsConversion {(pcm: Buffer, signal: AbortSignal): Promise<Buffer>}

/** 44.1 kHz to 48 kHz, by the one recipe the capability declares. */
export async function resampleElevenLabsPcm(pcm: Buffer, signal: AbortSignal): Promise<Buffer> {
  const directory = mkdtempSync(join(tmpdir(), "hv-elevenlabs-"));
  try {
    const input = join(directory, "read.pcm"), output = join(directory, "read-48k.pcm");
    writeFileSync(input, pcm, {flag: "wx"});
    const child = Bun.spawn(["ffmpeg", "-v", "error", "-nostdin", "-threads", "1", "-f", "s16le", "-ar", String(ELEVENLABS_SAMPLE_RATE), "-ac", "1", "-i", input,
      "-af", `aresample=${AUDIO_SAMPLE_RATE}:resampler=swr:filter_size=64:phase_shift=10:exact_rational=1:dither_method=none`,
      "-f", "s16le", "-ac", "1", output], {cwd: directory, stdin: "ignore", stdout: "ignore", stderr: "pipe"});
    const abort = () => child.kill("SIGKILL");
    signal.addEventListener("abort", abort, {once: true});
    if (signal.aborted) abort();
    try {
      const code = await child.exited;
      signal.throwIfAborted();
      if (code !== 0) throw new AudioStreamError("The read could not be converted to the studio's sample rate.");
      const converted = Buffer.from(await Bun.file(output).arrayBuffer());
      if (!converted.length || converted.length % 2) throw new AudioStreamError("The converted read is not whole samples.");
      return converted;
    } finally { signal.removeEventListener("abort", abort); }
  } finally { rmSync(directory, {recursive: true, force: true}); }
}

function alignmentOf(value: unknown): ElevenLabsAlignment {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AudioStreamError("The read has no usable alignment.");
  const v = value as Record<string, unknown>;
  if (!Array.isArray(v.characters) || !Array.isArray(v.character_start_times_seconds) || !Array.isArray(v.character_end_times_seconds))
    throw new AudioStreamError("The read has no usable alignment.");
  return v as unknown as ElevenLabsAlignment;
}

export class ElevenLabsAudioProvider {
  readonly capabilities = ELEVENLABS_AUDIO_CAPABILITY;
  private readonly fetchImpl: typeof fetch;
  private readonly convert: ElevenLabsConversion;
  private readonly timeoutMs: number;
  constructor(private readonly options: {apiKey: string; fetchImpl?: typeof fetch; convert?: ElevenLabsConversion; timeoutMs?: number}) {
    if (typeof options.apiKey !== "string" || !options.apiKey.trim() || options.apiKey.length > 4096 || /\s/.test(options.apiKey))
      throw new Error("Configure the ElevenLabs credential on the worker.");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.convert = options.convert ?? resampleElevenLabsPcm;
    this.timeoutMs = audioNumber(options.timeoutMs ?? 120000, 1, 180000, "Audio request timeout", true);
  }

  async synthesize(input: AudioLinePlan, journal: AudioAttemptJournal, signal?: AbortSignal) {
    const plan = validateAudioLinePlan(input);
    if (plan.profile.provider !== "elevenlabs" || plan.capabilityRevision !== ELEVENLABS_AUDIO_CAPABILITY.revision)
      throw new Error("The selected voice requires its own audio adapter.");
    if (!journal || [journal.authorize, journal.assertCurrent, journal.recordOutcome].some(fn => typeof fn !== "function"))
      throw new Error("Audio synthesis requires a durable reservation and permission journal.");
    const id = randomUUID(), request = elevenLabsLineRequest(plan);
    const intent: AudioDispatchIntent = Object.freeze({schema: "hv-audio-dispatch/2", attemptId: id, contextId: id,
      planRevision: plan.revision, capabilityRevision: plan.capabilityRevision, requestSha256: contentHash(request),
      provider: "elevenlabs", model: ELEVENLABS_MODEL, apiVersion: ELEVENLABS_API_VERSION});
    let outcome: AudioAttemptOutcome = {schema: "hv-audio-attempt-outcome/1", intent, reservation: null, dispatched: false,
      providerState: "not-dispatched", deliveryState: "withheld", httpStatus: null, providerRequestId: null,
      billing: {state: "not-incurred", actualUsd: 0}, deliveryRevision: null};
    let result: ReturnType<typeof createAudioDelivery> | undefined, failed = false;
    let failure: AudioProviderError["failure"] = "authorization";
    const deadline = AbortSignal.timeout(this.timeoutMs), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      combined.throwIfAborted();
      const held = await journal.authorize(intent, plan);
      if (typeof held?.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(held.id)) throw new Error("Invalid audio reservation.");
      audioNumber(held.heldUsd, .000001, 1000000, "Audio reservation");
      outcome.reservation = Object.freeze({...held});
      failure = "permission-changed";
      await journal.assertCurrent(intent, plan);
      combined.throwIfAborted();
      // The reservation exists before any network call: an ambiguous failure leaves a held attempt
      // to reconcile, never a second dispatch.
      outcome.dispatched = true; outcome.providerState = "unconfirmed"; outcome.billing = {state: "unreconciled", actualUsd: null};
      failure = "transport";
      const response = await audioAbortable(this.fetchImpl(request.url, {method: "POST", redirect: "manual", signal: combined,
        headers: {"xi-api-key": this.options.apiKey, "content-type": "application/json", accept: "application/json"},
        body: JSON.stringify(request.body)}), combined, late => { void late.body?.cancel().catch(() => {}); });
      outcome.httpStatus = response.status;
      const requestId = response.headers.get("request-id");
      if (typeof requestId === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(requestId)) outcome.providerRequestId = requestId;
      if (!response.ok) {
        // The remote body is never echoed: it can carry the credential or the screenplay line back.
        void response.body?.cancel().catch(() => {});
        if ([400, 401, 402, 403, 404, 413, 422, 429].includes(response.status)) outcome.providerState = "rejected";
        failure = "provider-rejected";
        throw new AudioStreamError("The audio provider rejected the request.");
      }
      failure = "protocol";
      const payload = await audioAbortable(response.json() as Promise<unknown>, combined);
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new AudioStreamError("The read is not a usable response.");
      const body = payload as Record<string, unknown>;
      if (typeof body.audio_base64 !== "string" || body.audio_base64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(body.audio_base64))
        throw new AudioStreamError("Invalid base64 audio data.");
      const native = Buffer.from(body.audio_base64, "base64");
      if (native.toString("base64") !== body.audio_base64) throw new AudioStreamError("Non-canonical audio data.");
      if (!native.length || native.length % 2) throw new AudioStreamError("The read is not whole samples.");
      if (native.length > MAX_AUDIO_BYTES) throw new AudioStreamError("The provider exceeded the line duration limit.");
      const alignment = alignmentOf(body.normalized_alignment ?? body.alignment);
      const pcm = await this.convert(native, combined);
      combined.throwIfAborted();
      if (pcm.length > AUDIO_SAMPLE_RATE * 2 * 600) throw new AudioStreamError("The provider exceeded the line duration limit.");
      const words: AudioTiming[] = elevenLabsWordTimings(alignment, pcm.length / 2 / AUDIO_SAMPLE_RATE);
      outcome.providerState = "completed";
      result = createAudioDelivery(plan, id, pcm, words, []);
      failure = "permission-changed";
      await journal.assertCurrent(intent, plan);
      combined.throwIfAborted();
      outcome.deliveryState = "ready"; outcome.deliveryRevision = result.report.revision;
    } catch {
      failed = true;
      if (signal?.aborted) failure = "cancelled"; else if (deadline.aborted) failure = "timeout";
      outcome.deliveryState = "withheld"; outcome.deliveryRevision = null;
    }
    validateAudioOutcome(outcome);
    outcome = Object.freeze(outcome);
    try { await journal.recordOutcome(outcome); }
    catch { throw new AudioProviderError("Audio outcome recording failed. Reconcile the original attempt before retrying.", "accounting", outcome); }
    if (combined.aborted) throw new AudioProviderError("Audio delivery was interrupted. The recorded attempt is retained for reconciliation.",
      signal?.aborted ? "cancelled" : "timeout", outcome);
    if (failed || !result) throw new AudioProviderError(
      outcome.dispatched ? "Audio delivery failed. The original attempt remains pending billing reconciliation." : "Audio was not dispatched. Check the line, current permissions and reservation.", failure, outcome);
    return {...result, outcome};
  }
}
