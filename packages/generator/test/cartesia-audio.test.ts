import {afterEach, expect, test} from "bun:test";
import {CartesiaAudioProvider, AudioProviderError, type AudioAttemptJournal, type AudioAttemptOutcome, type AudioDispatchIntent} from "../src/cartesia-audio";
import {CARTESIA_API_VERSION, CARTESIA_AUDIO_CAPABILITY, CARTESIA_MODEL} from "../src/audio-capabilities";
import {validateAudioDelivery, audioPcmHash} from "../src/audio-delivery";
import {contentHash} from "../src/capabilities";
import {compileAudioLine, validateAudioLinePlan, type AudioVoiceProfile} from "../../planner/src/audio-performances";
import {lineSources, voiceProfile} from "../../planner/src/performances";
import {resolveProvider} from "../src/index";
import {readAudioSse} from "../src/audio-stream";
import {createScenePerformance} from "../../planner/src/performance-memory";
import {parseFountain} from "../../parser/src/index";

// Closed HTTP fixtures. This PCM is a transport probe, not synthesized speech or
// evidence that an emotion/voice sounds correct. No real credential is read.
const pcm = Buffer.alloc(48000 * 2);
for (let i = 0; i < 48000; i++) pcm.writeInt16LE(Math.round(Math.sin(i * .04) * 2000), i * 2);
const source = lineSources([{character: "MARLA", lines: ["(quietly)", "Zo 12."]}])[0]!;
const profile: AudioVoiceProfile = {schema: "hv-audio-voice/1", provider: "cartesia", language: "en",
  voice: {id: "db6b0ed5-d5d3-463d-ae85-518a07d3c2b4", catalogueRevision: "1".repeat(64), permissionRevision: "2".repeat(64)},
  controls: {speed: 1, volume: 1, emotion: "neutral"}, pronunciations: [{word: "Zo", say: "Zoe"}]};
const plan = () => compileAudioLine(source, profile, {sourceHash: source.hash, beforeMs: 250, afterMs: 500, emotion: "calm", notes: "Hold the last beat."});
test("phrase tags reach one closed HTTP request and reports preserve actual provider timing instead of inventing requested pause durations",async()=>{
  const f=fixture(),line=compileAudioLine(source,profile,{sourceHash:source.hash,phrases:[{start:0,end:2,text:"Zo",speed:.8,volume:.7,pauseAfterMs:750}],beforeMs:250}),output=await f.provider.synthesize(line,f.journal);
  expect(f.calls).toHaveLength(1);expect(f.calls[0]!.body.transcript).toBe('<speed ratio="0.8"/><volume ratio="0.7"/>Zoe<speed ratio="1"/><volume ratio="1"/><break time="750ms"/> 12.');
  expect(output.report.plan.phrases).toEqual(line.phrases);expect(output.report.speechStartSample).toBe(12000);expect(output.report.alignment.words).toEqual([{text:"Zoe",startSec:0,endSec:.35},{text:"twelve.",startSec:.4,endSec:.9}]);expect(output.pcm.subarray(12000*2,60000*2)).toEqual(pcm);expect(output.outcome.billing.actualUsd).toBeNull();
  expect(validateAudioDelivery(output.report,output.pcm)).toEqual(output.report);
});
test("saved scene controls reach the closed HTTP voice request while free-form intent remains in the immutable report",async()=>{
  const scene=parseFountain("INT. ROOM - DAY\n\nMARLA\n(quietly)\nZo 12.").scenes[0]!,memory=createScenePerformance(crypto.randomUUID(),scene,{notes:"Hide the disappointment.",controls:{emotion:"sad",speed:.8,volume:.7}}),line=compileAudioLine(source,profile,{sourceHash:source.hash,emotion:"neutral"},undefined,memory),f=fixture();
  const output=await f.provider.synthesize(line,f.journal);expect(f.calls).toHaveLength(1);expect(f.calls[0]!.body.generation_config).toEqual({emotion:"neutral",speed:.8,volume:.7});expect(f.calls[0]!.body.transcript).toBe("Zoe 12.");expect(JSON.stringify(f.calls[0]!.body)).not.toContain(memory.notes);expect(output.report.plan.memory).toEqual(memory);expect(validateAudioDelivery(output.report,output.pcm)).toEqual(output.report);
});
type Wire = Record<string, unknown>;
function events(context: string): Wire[] {
  return [
    {type: "chunk", context_id: context, status_code: 206, done: false, step_time: 3, data: pcm.subarray(0, 1001).toString("base64")},
    {type: "timestamps", context_id: context, status_code: 206, done: false, word_timestamps: {words: ["Zoe", "twelve."], start: [0, .4], end: [.35, .9]}},
    {type: "phoneme_timestamps", context_id: context, status_code: 206, done: false, phoneme_timestamps: {phonemes: ["z", "oʊ", "i", "twɛlv"], start: [0, .1, .2, .4], end: [.1, .2, .35, .9]}},
    {type: "chunk", context_id: context, status_code: 206, done: false, step_time: 3, data: pcm.subarray(1001).toString("base64")},
    {type: "done", context_id: context, status_code: 200, done: true},
  ];
}
function sse(rows: Wire[], newline = "\r\n"): Response {
  const text = ": fixture heartbeat" + newline + newline + rows.map(row => "event: " + row.type + newline + "data: " + JSON.stringify(row) + newline + newline).join("");
  return new Response(text, {headers: {"Content-Type": "text/event-stream; charset=utf-8"}});
}
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });
function fixture(reply: (body: Wire, request: Request) => Response | Promise<Response> = body => sse(events(String(body.context_id))), timeoutMs?: number) {
  const calls: {url: string; body: Wire; auth: string | null; version: string | null}[] = [], order: string[] = [];
  const server = Bun.serve({hostname: "127.0.0.1", port: 0, async fetch(request) {
    const body = await request.json() as Wire;
    calls.push({url: request.url, body, auth: request.headers.get("authorization"), version: request.headers.get("Cartesia-Version")});
    order.push("fetch"); return reply(body, request);
  }}); servers.push(server);
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    expect(String(url)).toBe("https://api.cartesia.ai/tts/sse");
    expect(init?.redirect).toBe("manual");
    return fetch(new URL("/tts/sse", server.url), init);
  }) as typeof fetch;
  const outcomes: AudioAttemptOutcome[] = [], intents: AudioDispatchIntent[] = [];
  const journal: AudioAttemptJournal = {
    async authorize(intent, compiled) {
      order.push("authorize"); expect(Object.isFrozen(compiled.profile.controls)).toBe(true);
      expect(intent.planRevision).toBe(compiled.revision); intents.push(intent);
      return {id: "audio-reservation-fixture", priceRevision: "3".repeat(64), heldUsd: .25};
    },
    async assertCurrent() { order.push("permission"); },
    async recordOutcome(outcome) { order.push("outcome"); outcomes.push(structuredClone(outcome)); },
  };
  return {provider: new CartesiaAudioProvider({apiKey: "fixture-not-a-real-key", fetchImpl, timeoutMs}), journal, calls, order, outcomes, intents};
}
async function failed(action: Promise<unknown>): Promise<AudioProviderError> {
  try { await action; throw new Error("Expected audio failure."); }
  catch (error) { expect(error).toBeInstanceOf(AudioProviderError); return error as AudioProviderError; }
}

test("character defaults and line overrides bind source, voice grants, pronunciation and effective direction without changing legacy voice admission", () => {
  const compiled = plan(); expect(validateAudioLinePlan(compiled)).toEqual(compiled);
  expect(compiled.spokenText).toBe("Zoe 12."); expect(compiled.profile.controls.emotion).toBe("calm");
  expect(profile.controls.emotion).toBe("neutral"); expect(compiled.source.cues).toEqual(["(quietly)"]);
  expect(CARTESIA_AUDIO_CAPABILITY.billing.actualUsd).toBeNull(); expect(CARTESIA_AUDIO_CAPABILITY.controls.wordEmphasis).toBe(false);
  expect(CARTESIA_AUDIO_CAPABILITY.qualification).toBe("transport-fixtures-only");
  expect(() => voiceProfile(profile)).toThrow(); expect(() => resolveProvider("audio:cartesia")).toThrow();
  for (const patch of [{emphasis: ["Zo"]}, {pitch: 50}, {speed: .59}, {volume: 2.01}, {emotion: "whisper"}, {beforeMs: .5}, {sourceHash: "0".repeat(64)}])
    expect(() => compileAudioLine(source, profile, {sourceHash: source.hash, ...patch} as never)).toThrow();
  for (const text of ["<emotion value='angry'>Hello</emotion>", "\ud800"])
    expect(() => compileAudioLine(lineSources([{character: "MARLA", lines: [text]}])[0]!, profile)).toThrow();
  const stale = structuredClone(compiled); stale.profile.voice.permissionRevision = "f".repeat(64);
  expect(() => validateAudioLinePlan(stale)).toThrow("changed");
});

test("closed HTTP synthesis preserves actual PCM, provider tokens, exact pauses and a separate unresolved credit receipt", async () => {
  const f = fixture(), output = await f.provider.synthesize(plan(), f.journal), request = f.calls[0]!;
  expect(f.order).toEqual(["authorize", "permission", "fetch", "permission", "outcome"]);
  expect(request.auth).toBe("Bearer fixture-not-a-real-key"); expect(request.version).toBe(CARTESIA_API_VERSION);
  expect(request.body).toEqual({model_id: CARTESIA_MODEL, transcript: "Zoe 12.", voice: profile.voice.id, language: "en",
    output_format: {container: "raw", encoding: "pcm_s16le", sample_rate: 48000}, generation_config: {speed: 1, volume: 1, emotion: "calm"},
    normalization: "auto", add_timestamps: true, add_phoneme_timestamps: true, use_normalized_timestamps: true, context_id: f.intents[0]!.contextId});
  expect(f.intents[0]!.requestSha256).toBe(contentHash(request.body));
  expect(output.wav.subarray(0, 4).toString()).toBe("RIFF"); expect(output.wav.readUInt32LE(24)).toBe(48000);
  expect(output.wav.readUInt32LE(28)).toBe(96000); expect(output.wav.readUInt32LE(40)).toBe(output.pcm.length);
  expect(output.wav.subarray(44)).toEqual(output.pcm);
  expect(output.report.speechStartSample).toBe(12000); expect(output.report.speechEndSample).toBe(60000);
  expect(output.report.totalSamples).toBe(84000);
  expect(output.pcm.subarray(12000 * 2, 60000 * 2)).toEqual(pcm);
  expect(output.report.speechPcmSha256).toBe(audioPcmHash(pcm));
  expect(output.report.alignment.words.map(w => w.text)).toEqual(["Zoe", "twelve."]);
  expect(output.report.alignment.phonemes[1]!.text).toBe("oʊ");
  expect(output.report.alignment.origin).toBe("speech-start");
  expect(output.outcome.providerRequestId).toBeNull(); expect(output.outcome.providerState).toBe("completed");
  expect(output.outcome.billing).toEqual({state: "unreconciled", actualUsd: null});
  expect(output.outcome.reservation!.heldUsd).toBe(.25); expect(f.outcomes).toEqual([output.outcome]);
  expect(JSON.stringify(output.outcome)).not.toContain("fixture-not-a-real-key");
  expect(validateAudioDelivery(output.report, output.pcm)).toEqual(output.report);
  const badBytes = Buffer.from(output.pcm); badBytes[0] = 1; expect(() => validateAudioDelivery(output.report, badBytes)).toThrow("bytes");
  const badReport = structuredClone(output.report); badReport.alignment.words[0]!.text = "Invented";
  expect(() => validateAudioDelivery(badReport)).toThrow("changed");
});

test("SSE framing survives fragmented UTF-8, CRLF, comments and multiline data; bare CR completion also works", async () => {
  const f = fixture(async body => {
    const raw = await sse(events(String(body.context_id))).text();
    const bytes = new TextEncoder().encode(raw.replace('data: {"type":"timestamps",', 'data: {"type":"timestamps",\r\ndata: '));
    let at = 0;
    return new Response(new ReadableStream({pull(controller) {
      if (at === bytes.length) { controller.close(); return; }
      const end = Math.min(at + (at % 17) + 1, bytes.length); controller.enqueue(bytes.subarray(at, end)); at = end;
    }}), {headers: {"Content-Type": "text/event-stream"}});
  });
  const result = await f.provider.synthesize(plan(), f.journal); expect(result.report.alignment.phonemes[1]!.text).toBe("oʊ");
  const cr = fixture(body => sse(events(String(body.context_id)), "\r"));
  expect((await cr.provider.synthesize(plan(), cr.journal)).report.speechPcmSha256).toBe(audioPcmHash(pcm));
});

test("words-only requests require word timing and never manufacture phonemes", async () => {
  const f = fixture(body => sse(events(String(body.context_id)).filter(e => e.type !== "phoneme_timestamps")));
  const output = await f.provider.synthesize(compileAudioLine(source, profile, undefined, "words"), f.journal);
  expect(f.calls[0]!.body.add_phoneme_timestamps).toBe(false); expect(output.report.alignment.phonemes).toEqual([]);
});

test("parser reconstructs every individual UTF-8 byte and CRLF delimiter without relying on HTTP packet boundaries", async () => {
  const wire = new TextEncoder().encode(': heartbeat\r\n\r\ndata: {"type":"timestamps",\r\ndata: "token":"oʊ"}\r\n\r\ndata: {"type":"done"}\r\n\r\n');
  let at = 0; const seen: unknown[] = [];
  const response = new Response(new ReadableStream({pull(stream) {
    if (at === wire.length) stream.close(); else stream.enqueue(wire.subarray(at, ++at));
  }}), {headers: {"Content-Type": "text/event-stream"}});
  await readAudioSse(response, new AbortController().signal, value => { seen.push(value); return (value as Wire).type === "done"; });
  expect(seen).toEqual([{type: "timestamps", token: "oʊ"}, {type: "done"}]);
  const incomplete = new Response('data: {"type":"done"}\n', {headers: {"Content-Type": "text/event-stream"}});
  await expect(readAudioSse(incomplete, new AbortController().signal, () => true)).rejects.toThrow("completion");
});

test("unsupported or stale inputs and failed authorizations cannot reach the provider", async () => {
  const f = fixture(), stale = structuredClone(plan()); stale.spokenText = "Another line.";
  await expect(f.provider.synthesize(stale, f.journal)).rejects.toThrow("changed");
  expect(f.intents).toHaveLength(0);
  f.journal.authorize = async () => { throw new Error("revoked catalogue permission"); };
  const error = await failed(f.provider.synthesize(plan(), f.journal));
  expect(error.failure).toBe("authorization"); expect(error.outcome.billing).toEqual({state: "not-incurred", actualUsd: 0});
  expect(f.calls).toHaveLength(0); expect(f.outcomes).toHaveLength(1);
});

test("an invalid budget hold or permission loss immediately before dispatch cannot consume provider credits", async () => {
  for (const heldUsd of [0, -1, NaN, Infinity]) {
    const f = fixture(); f.journal.authorize = async () => ({id: "held-fixture", priceRevision: "3".repeat(64), heldUsd});
    const error = await failed(f.provider.synthesize(plan(), f.journal));
    expect(error.outcome.dispatched).toBe(false); expect(f.calls).toHaveLength(0);
  }
  const f = fixture(); f.journal.assertCurrent = async () => { throw new Error("permission revoked"); };
  const error = await failed(f.provider.synthesize(plan(), f.journal));
  expect(error.failure).toBe("permission-changed"); expect(error.outcome.reservation!.id).toBe("audio-reservation-fixture");
  expect(error.outcome.billing.actualUsd).toBe(0); expect(f.calls).toHaveLength(0);
});

test("cancellation before dispatch creates no charge; cancellation during a stream retains the original hold", async () => {
  const early = fixture(), cancelled = new AbortController(); cancelled.abort();
  const a = await failed(early.provider.synthesize(plan(), early.journal, cancelled.signal));
  expect(a.failure).toBe("cancelled"); expect(a.outcome.dispatched).toBe(false); expect(early.calls).toHaveLength(0);
  const controller = new AbortController();
  const f = fixture(body => new Response(new ReadableStream({start(stream) {
    stream.enqueue(new TextEncoder().encode("data: " + JSON.stringify(events(String(body.context_id))[0]) + "\n\n"));
    setTimeout(() => controller.abort(), 20);
  }}), {headers: {"Content-Type": "text/event-stream"}}));
  const b = await failed(f.provider.synthesize(plan(), f.journal, controller.signal));
  expect(b.failure).toBe("cancelled"); expect(b.outcome.billing.actualUsd).toBeNull();
  expect(b.outcome.providerState).toBe("unconfirmed"); expect(f.calls).toHaveLength(1);
  expect(f.outcomes[0]!.intent.attemptId).toBe(f.intents[0]!.attemptId);
});

test("timeout bounds a stalled body and never submits another attempt", async () => {
  const f = fixture(() => new Response(new ReadableStream({start(stream) { stream.enqueue(new TextEncoder().encode(": waiting\n\n")); }}),
    {headers: {"Content-Type": "text/event-stream"}}), 60);
  const error = await failed(f.provider.synthesize(plan(), f.journal));
  expect(error.failure).toBe("timeout"); expect(error.outcome.billing.state).toBe("unreconciled"); expect(f.calls).toHaveLength(1);
});

test("HTTP errors and redirects stay separate from invoice evidence and never echo remote secrets", async () => {
  for (const status of [401, 429, 500, 307]) {
    const f = fixture(() => new Response("fixture-not-a-real-key secret remote echo", {status, headers: status === 307 ? {Location: "https://untrusted.invalid/steal"} : {}}));
    const error = await failed(f.provider.synthesize(plan(), f.journal));
    expect(error.outcome.httpStatus).toBe(status); expect(error.outcome.billing.actualUsd).toBeNull();
    expect(error.outcome.providerState).toBe(status < 500 && status !== 307 ? "rejected" : "unconfirmed");
    expect(error.message).not.toContain("secret"); expect(error.message).not.toContain("fixture-not-a-real-key"); expect(f.calls).toHaveLength(1);
  }
});

test("a documented provider error records its real request ID without exposing the echoed message", async () => {
  const f = fixture(() => sse([{type: "error", status_code: 500, done: true, request_id: "vendor-error-request-1", title: "Remote", message: "fixture-not-a-real-key"}]));
  const error = await failed(f.provider.synthesize(plan(), f.journal));
  expect(error.failure).toBe("provider-rejected"); expect(error.outcome.providerRequestId).toBe("vendor-error-request-1");
  expect(error.outcome.providerState).toBe("rejected"); expect(JSON.stringify(error)).not.toContain("fixture-not-a-real-key");
});

test("truncation, wrong contexts, invalid base64 and malformed timestamps withhold audio and preserve billing uncertainty", async () => {
  const variants: ((rows: Wire[]) => Wire[])[] = [
    rows => rows.slice(0, -1),
    rows => [{...rows[0], context_id: "another-attempt"}, ...rows.slice(1)],
    rows => [{...rows[0], data: "!!!!"}, ...rows.slice(1)],
    rows => [{...rows[0], done: true}, ...rows.slice(1)],
    rows => rows.map(e => e.type === "timestamps" ? {...e, word_timestamps: {words: ["Zoe"], start: [0], end: []}} : e),
    rows => rows.map(e => e.type === "timestamps" ? {...e, word_timestamps: {words: ["Zoe", "twelve"], start: [.6, .4], end: [.7, .9]}} : e),
    rows => [{type: "surprise", status_code: 200, done: false}, ...rows],
  ];
  for (const variant of variants) {
    const f = fixture(body => sse(variant(events(String(body.context_id))))), error = await failed(f.provider.synthesize(plan(), f.journal));
    expect(error.failure).toBe("protocol"); expect(error.outcome.deliveryState).toBe("withheld");
    expect(error.outcome.billing.actualUsd).toBeNull(); expect(f.calls).toHaveLength(1);
  }
});

test("completion with missing alignment, out-of-range timing or partial samples is recorded but never published as usable audio", async () => {
  const variants: ((rows: Wire[]) => Wire[])[] = [
    rows => rows.filter(e => e.type !== "timestamps"),
    rows => rows.filter(e => e.type !== "phoneme_timestamps"),
    rows => rows.map(e => e.type === "timestamps" ? {...e, word_timestamps: {words: ["Zoe"], start: [0], end: [1.1]}} : e),
    rows => rows.map(e => e.type === "chunk" ? {...e, data: ""} : e),
    rows => rows.filter((_, i) => i !== 3),
  ];
  for (const variant of variants) {
    const f = fixture(body => sse(variant(events(String(body.context_id))))), error = await failed(f.provider.synthesize(plan(), f.journal));
    expect(error.outcome.providerState).toBe("completed"); expect(error.outcome.deliveryState).toBe("withheld");
    expect(error.outcome.billing.actualUsd).toBeNull(); expect(error.outcome.deliveryRevision).toBeNull();
  }
});

test("non-SSE responses, invalid UTF-8 and oversized events are rejected without raw response leakage", async () => {
  for (const reply of [() => new Response("secret", {headers: {"Content-Type": "application/json"}}),
    () => new Response(new Uint8Array([100, 97, 116, 97, 58, 255, 10, 10]), {headers: {"Content-Type": "text/event-stream"}}),
    () => new Response("data: " + "x".repeat(2 * 1024 * 1024 + 1), {headers: {"Content-Type": "text/event-stream"}})]) {
    const f = fixture(reply), error = await failed(f.provider.synthesize(plan(), f.journal));
    expect(error.failure).toBe("protocol"); expect(error.message).not.toContain("secret"); expect(f.calls).toHaveLength(1);
  }
});

test("permission or lease loss after successful generation withholds media but retains the paid-attempt evidence", async () => {
  const f = fixture(); let checks = 0;
  f.journal.assertCurrent = async () => { if (++checks === 2) throw new Error("lease lost"); };
  const error = await failed(f.provider.synthesize(plan(), f.journal));
  expect(error.failure).toBe("permission-changed"); expect(error.outcome.providerState).toBe("completed");
  expect(error.outcome.deliveryState).toBe("withheld"); expect(error.outcome.billing.actualUsd).toBeNull(); expect(f.outcomes).toHaveLength(1);
});

test("outcome journal failure prevents publishing and carries the original attempt for reconciliation", async () => {
  const f = fixture(); f.journal.recordOutcome = async () => { throw new Error("database disconnected"); };
  const error = await failed(f.provider.synthesize(plan(), f.journal));
  expect(error.failure).toBe("accounting"); expect(error.outcome.intent.attemptId).toBe(f.intents[0]!.attemptId);
  expect(error.outcome.providerState).toBe("completed"); expect(error.outcome.billing.actualUsd).toBeNull(); expect(f.calls).toHaveLength(1);
});

test("cancellation during outcome persistence still records the attempt and returns no media", async () => {
  const f = fixture(), abort = new AbortController();
  f.journal.recordOutcome = async outcome => { f.outcomes.push(outcome); abort.abort(); };
  const error = await failed(f.provider.synthesize(plan(), f.journal, abort.signal));
  expect(error.failure).toBe("cancelled"); expect(f.outcomes).toHaveLength(1);
  expect(error.outcome).toEqual(f.outcomes[0]); expect(error.outcome.billing.actualUsd).toBeNull();
});
