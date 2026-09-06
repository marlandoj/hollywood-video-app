import {randomUUID} from "node:crypto";
import {CARTESIA_API_VERSION, CARTESIA_AUDIO_CAPABILITY, CARTESIA_MODEL, AUDIO_SAMPLE_RATE} from "./audio-capabilities";
import {contentHash} from "./capabilities";
import {audioAbortable, readAudioSse, AudioStreamError} from "./audio-stream";
import {createAudioDelivery, validateAudioTimings, type AudioTiming, type AudioLineDelivery} from "./audio-delivery";
import {audioHash, audioNumber, audioRecord, validateAudioLinePlan, type AudioLinePlan} from "../../planner/src/audio-performances";

const ENDPOINT = "https://api.cartesia.ai/tts/sse";
export interface AudioDispatchIntent {
  schema: "hv-audio-dispatch/1";
  attemptId: string;
  /** Client correlation only. This is not a provider-generated request ID. */
  contextId: string;
  planRevision: string;
  capabilityRevision: string;
  requestSha256: string;
  provider: "cartesia";
  model: string;
  apiVersion: string;
}
export interface AudioReservation {id: string; priceRevision: string; heldUsd: number}
export interface AudioAttemptOutcome {
  schema: "hv-audio-attempt-outcome/1";
  intent: AudioDispatchIntent;
  reservation: AudioReservation | null;
  dispatched: boolean;
  providerState: "not-dispatched" | "unconfirmed" | "completed" | "rejected";
  /** "ready" records successful validation before outcome persistence. It does
   * not assert publication or grant permission to attach media after lease loss. */
  deliveryState: "ready" | "withheld";
  httpStatus: number | null;
  providerRequestId: string | null;
  billing: {state: "not-incurred"; actualUsd: 0} | {state: "unreconciled"; actualUsd: null};
  deliveryRevision: string | null;
}
export interface AudioAttemptJournal {
  /** Atomically verify project/cast/catalogue permission and the worker lease,
   * reserve funds, and persist this unique intent BEFORE allowing any network IO.
   * A crash after this succeeds must leave an unknown-attempt hold, not redispatch. */
  authorize(intent: AudioDispatchIntent, plan: AudioLinePlan): Promise<AudioReservation>;
  assertCurrent(intent: AudioDispatchIntent, plan: AudioLinePlan): Promise<void>;
  /** Persist by original attempt ID even after cancellation/lease loss. All
   * dispatched outcomes retain their hold until independent billing reconciliation.
   * A completion event, disconnect or aggregate credit bucket is not an invoice. */
  recordOutcome(outcome: AudioAttemptOutcome): Promise<void>;
}
type Failure = "authorization" | "permission-changed" | "transport" | "protocol" | "provider-rejected" | "cancelled" | "timeout" | "accounting";
export class AudioProviderError extends Error {
  override name = "AudioProviderError";
  constructor(message: string, readonly failure: Failure, readonly outcome: AudioAttemptOutcome) { super(message); }
}
function immutable<T>(value: T): T {
  if (value && typeof value === "object") { Object.values(value).forEach(immutable); Object.freeze(value); }
  return value;
}
function reservation(input: AudioReservation): AudioReservation {
  const v = audioRecord(input, ["id", "priceRevision", "heldUsd"]);
  if (typeof v.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(v.id)) throw new Error("Invalid audio reservation.");
  return {id: v.id, priceRevision: audioHash(v.priceRevision), heldUsd: audioNumber(v.heldUsd, .000001, 1000000, "Reserved audio cost")};
}
function timingEvent(value: unknown, tokenKey: "words" | "phonemes", destination: AudioTiming[], max: number): void {
  const v = audioRecord(value, [tokenKey, "start", "end"]), tokens = v[tokenKey];
  if (!Array.isArray(tokens) || !Array.isArray(v.start) || !Array.isArray(v.end) || tokens.length !== v.start.length || tokens.length !== v.end.length
    || destination.length + tokens.length > max) throw new AudioStreamError("Invalid provider timing arrays.");
  const start = v.start, end = v.end;
  const incoming = validateAudioTimings(tokens.map((text, i) => ({text, startSec: start[i], endSec: end[i]})), max, 600);
  const prior = destination.at(-1), first = incoming[0];
  if (prior && first && (first.startSec < prior.startSec || first.endSec < prior.endSec)) throw new AudioStreamError("Provider timing events arrived out of order.");
  destination.push(...incoming);
}

/** Explicit audio adapter for qualification. It is deliberately not registered in
 * video resolveProvider or zero-cost dialogue admission. A production caller must
 * implement the durable audio journal and billing reconciliation first. */
export class CartesiaAudioProvider {
  readonly capabilities = CARTESIA_AUDIO_CAPABILITY;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  constructor(private readonly options: {apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number}) {
    if (typeof options.apiKey !== "string" || !options.apiKey.trim() || options.apiKey.length > 4096 || /\s/.test(options.apiKey))
      throw new Error("Configure the audio provider credential on the worker.");
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = audioNumber(options.timeoutMs ?? 120000, 1, 180000, "Audio request timeout", true);
  }

  async synthesize(input: AudioLinePlan, journal: AudioAttemptJournal, signal?: AbortSignal): Promise<{wav: Buffer; pcm: Buffer; report: AudioLineDelivery; outcome: AudioAttemptOutcome}> {
    // Validation occurs before intent/reservation creation and before credential use.
    const plan = immutable(validateAudioLinePlan(input));
    if (!journal || [journal.authorize, journal.assertCurrent, journal.recordOutcome].some(fn => typeof fn !== "function"))
      throw new Error("Audio synthesis requires a durable reservation and permission journal.");
    const id = randomUUID(), body = {model_id: CARTESIA_MODEL, transcript: plan.spokenText, voice: plan.profile.voice.id,
      language: plan.profile.language, output_format: {container: "raw", encoding: "pcm_s16le", sample_rate: AUDIO_SAMPLE_RATE},
      generation_config: {...plan.profile.controls}, normalization: "auto", add_timestamps: true,
      add_phoneme_timestamps: plan.alignment === "words-and-phonemes", use_normalized_timestamps: true, context_id: id};
    const intent = immutable<AudioDispatchIntent>({schema: "hv-audio-dispatch/1", attemptId: id, contextId: id,
      planRevision: plan.revision, capabilityRevision: plan.capabilityRevision, requestSha256: contentHash(body),
      provider: "cartesia", model: CARTESIA_MODEL, apiVersion: CARTESIA_API_VERSION});
    let outcome: AudioAttemptOutcome = {schema: "hv-audio-attempt-outcome/1", intent, reservation: null, dispatched: false,
      providerState: "not-dispatched", deliveryState: "withheld", httpStatus: null, providerRequestId: null,
      billing: {state: "not-incurred", actualUsd: 0}, deliveryRevision: null};
    let result: ReturnType<typeof createAudioDelivery> | undefined, failure: Failure = "authorization", failed = false;
    const deadline = AbortSignal.timeout(this.timeoutMs), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try {
      combined.throwIfAborted();
      outcome.reservation = immutable(reservation(await journal.authorize(intent, plan)));
      combined.throwIfAborted();
      failure = "permission-changed";
      await journal.assertCurrent(intent, plan);
      combined.throwIfAborted();
      // An intent already exists if fetch fails ambiguously. No automatic retry,
      // alternate voice, or fallback provider may consume a second reservation.
      outcome.dispatched = true; outcome.providerState = "unconfirmed"; outcome.billing = {state: "unreconciled", actualUsd: null};
      failure = "transport";
      const response = await audioAbortable(this.fetchImpl(ENDPOINT, {method: "POST", redirect: "manual", signal: combined,
        headers: {Authorization: `Bearer ${this.options.apiKey}`, "Cartesia-Version": CARTESIA_API_VERSION, "Content-Type": "application/json", Accept: "text/event-stream"},
        body: JSON.stringify(body)}), combined, late => { void late.body?.cancel().catch(() => {}); });
      outcome.httpStatus = response.status;
      if (!response.ok) {
        // Never echo the remote body: error messages can include credentials or
        // screenplay text. Redirects are not followed with the worker credential.
        void response.body?.cancel().catch(() => {});
        if ([400, 401, 402, 403, 404, 413, 422, 429].includes(response.status)) outcome.providerState = "rejected";
        failure = "provider-rejected";
        throw new AudioStreamError("The audio provider rejected the request.");
      }
      failure = "protocol";
      const chunks: Buffer[] = [], words: AudioTiming[] = [], phonemes: AudioTiming[] = [];
      let pcmBytes = 0;
      await readAudioSse(response, combined, value => {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new AudioStreamError("Invalid audio event.");
        const v = value as Record<string, unknown>;
        if (v.context_id != null && v.context_id !== id) throw new AudioStreamError("Audio event belongs to another context.");
        if (!Number.isInteger(v.status_code)) throw new AudioStreamError("Invalid audio event status.");
        if (v.type === "error") {
          if ((v.status_code as number) < 400 || (v.status_code as number) > 599 || typeof v.done !== "boolean"
            || typeof v.request_id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(v.request_id)) throw new AudioStreamError("Invalid audio error event.");
          outcome.providerState = "rejected"; outcome.providerRequestId = v.request_id; failure = "provider-rejected";
          throw new AudioStreamError("The audio provider reported a generation error.");
        }
        if ((v.status_code as number) < 200 || (v.status_code as number) > 299 || v.done !== (v.type === "done")) throw new AudioStreamError("Invalid audio event completion state.");
        switch (v.type) {
          case "chunk": {
            if (typeof v.data !== "string" || v.data.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(v.data))
              throw new AudioStreamError("Invalid base64 audio data.");
            const pcm = Buffer.from(v.data, "base64");
            if (pcm.toString("base64") !== v.data) throw new AudioStreamError("Non-canonical audio data.");
            pcmBytes += pcm.length;
            if (pcmBytes > AUDIO_SAMPLE_RATE * 2 * 600) throw new AudioStreamError("The provider exceeded the line duration limit.");
            chunks.push(pcm); break;
          }
          case "timestamps": timingEvent(v.word_timestamps, "words", words, 20000); break;
          case "phoneme_timestamps":
            if (plan.alignment !== "words-and-phonemes") throw new AudioStreamError("Unexpected phoneme alignment.");
            timingEvent(v.phoneme_timestamps, "phonemes", phonemes, 100000); break;
          case "done": outcome.providerState = "completed"; return true;
          default: throw new AudioStreamError("Unsupported audio event type.");
        }
        return false;
      });
      combined.throwIfAborted();
      result = createAudioDelivery(plan, id, Buffer.concat(chunks), words, phonemes);
      failure = "permission-changed";
      await journal.assertCurrent(intent, plan);
      combined.throwIfAborted();
      outcome.deliveryState = "ready"; outcome.deliveryRevision = result.report.revision;
    } catch {
      failed = true;
      if (signal?.aborted) failure = "cancelled"; else if (deadline.aborted) failure = "timeout";
      outcome.deliveryState = "withheld";
    }
    outcome = immutable(outcome);
    // Completion is withheld if durable outcome recording fails. The exception
    // carries the original attempt for recovery, without raw provider text/secrets.
    try { await journal.recordOutcome(outcome); }
    catch { throw new AudioProviderError("Audio outcome recording failed. Reconcile the original attempt before retrying.", "accounting", outcome); }
    if (combined.aborted) throw new AudioProviderError("Audio delivery was interrupted. The recorded attempt is retained for reconciliation.",
      signal?.aborted ? "cancelled" : "timeout", outcome);
    if (failed || !result) throw new AudioProviderError(
      outcome.dispatched ? "Audio delivery failed. The original attempt remains pending billing reconciliation." : "Audio was not dispatched. Check the line, current permissions and reservation.", failure, outcome);
    return {...result, outcome};
  }
}
