import {expect, test} from "bun:test";
import {mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ELEVENLABS_MUSIC_MODEL, ELEVENLABS_MUSIC_URL, ElevenLabsMusicProvider, elevenLabsMusicRequest, musicProviderFromEnvironment} from "../src/elevenlabs-music";
import {MockMusicProvider, MusicCueError, MusicProviderError, mockMusicWav, musicCueCostUsd, probeMusicAudio, validateMusicCueRequest} from "../src/music-provider";
import {musicCueHoldUsd} from "../../operator/src/music-vendor-budget";

/**
 * HV-024-11: the ElevenLabs Music contract and adapter. Nothing here reaches the network: the
 * transport is a fake `fetch`, as the voice adapter's fixtures are. What is proved is the request's
 * shape, that what comes back is probed and decoded before it is trusted, that no failure echoes the
 * remote body, that every failure says whether the vendor may have been asked, that the cost is
 * ours and never above the hold, and that the live adapter is unreachable unless the operator
 * names it.
 */
const KEY = "fixture-key-not-a-secret";
const REQUEST = validateMusicCueRequest({prompt: "Slow instrumental underscore in a minor key", durationSec: 12, seed: 7});

/** Real MP3 bytes, made by ffmpeg here, so the adapter's probe and decode meet what the vendor sends. */
function mp3(seconds: number): Buffer {
  const directory = mkdtempSync(join(tmpdir(), "hv-music-fixture-"));
  try {
    const result = Bun.spawnSync(["ffmpeg", "-v", "error", "-nostdin", "-f", "lavfi", "-i", `sine=frequency=220:sample_rate=44100:duration=${seconds}`,
      "-ac", "2", "-c:a", "libmp3lame", "-b:a", "128k", "-fflags", "+bitexact", join(directory, "cue.mp3")], {stdout: "ignore", stderr: "pipe"});
    if (result.exitCode !== 0) throw new Error("fixture: " + result.stderr.toString());
    return readFileSync(join(directory, "cue.mp3"));
  } finally { rmSync(directory, {recursive: true, force: true}); }
}

function fakeFetch(answer: () => Response) {
  const calls: {url: string; init: RequestInit}[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => { calls.push({url: String(url), init: init!}); return answer(); }) as unknown as typeof fetch;
  return {impl, calls};
}

async function failure(promise: Promise<unknown>): Promise<MusicProviderError> {
  try { await promise; } catch (error) { if (error instanceof MusicProviderError) return error; throw error; }
  throw new Error("expected a MusicProviderError");
}

/** One request: the endpoint, the key in its own header, exactly the documented body, and no seed. */
test("the adapter sends one request of the contract's shape and delivers a probed 48 kHz stereo WAV", async () => {
  const fake = fakeFetch(() => new Response(new Uint8Array(mp3(12)), {status: 200, headers: {"content-type": "audio/mpeg", "request-id": "req_123", "x-cost-usd": "0.00"}}));
  const delivery = await new ElevenLabsMusicProvider({apiKey: KEY, fetchImpl: fake.impl}).compose(REQUEST);
  expect(fake.calls).toHaveLength(1);
  const [{url, init}] = fake.calls as [{url: string; init: RequestInit}];
  expect(url).toBe(ELEVENLABS_MUSIC_URL);
  expect(url).toBe("https://api.elevenlabs.io/v1/music?output_format=mp3_44100_128");
  expect(init.method).toBe("POST");
  expect(init.redirect).toBe("manual");
  expect((init.headers as Record<string, string>)["xi-api-key"]).toBe(KEY);
  expect(JSON.parse(String(init.body))).toEqual({prompt: REQUEST.prompt, music_length_ms: 12000, model_id: ELEVENLABS_MUSIC_MODEL, force_instrumental: true});
  expect(elevenLabsMusicRequest(REQUEST).body).not.toHaveProperty("seed");
  expect(delivery).toMatchObject({provider: "elevenlabs", model: "music_v1", providerRequestId: "req_123", sourceFormat: "mp3"});
  expect(Math.abs(delivery.durationSec - 12)).toBeLessThan(0.2);
  const probe = await probeMusicAudio(delivery.wav);
  expect(probe).toMatchObject({format: "wav", codec: "pcm_s16le", channels: 2, sampleRate: 48000});
}, 30000);

/** A refusal, a wrong type, an unusable body and a cue far from the asked length: each fails as sent, and none quotes the body. */
test("every failure after the request says it may have been charged, and none repeats what the vendor sent", async () => {
  const secret = "SECRET-BODY-" + KEY;
  const cases: [string, () => Response][] = [
    ["refused", () => new Response(secret, {status: 402, headers: {"content-type": "application/json"}})],
    ["rate-limited", () => new Response(secret, {status: 429})],
    ["not mp3", () => new Response(secret, {status: 200, headers: {"content-type": "application/json"}})],
    ["not audio", () => new Response(secret, {status: 200, headers: {"content-type": "audio/mpeg"}})],
    ["too long", () => new Response(new Uint8Array(mp3(20)), {status: 200, headers: {"content-type": "audio/mpeg"}})],
    ["too short", () => new Response(new Uint8Array(mp3(4)), {status: 200, headers: {"content-type": "audio/mpeg", "request-id": "req_short"}})],
  ];
  for (const [name, answer] of cases) {
    const fake = fakeFetch(answer), error = await failure(new ElevenLabsMusicProvider({apiKey: KEY, fetchImpl: fake.impl}).compose(REQUEST));
    expect({name, dispatched: error.dispatched, calls: fake.calls.length}).toEqual({name, dispatched: true, calls: 1});
    expect({name, leaked: error.message.includes("SECRET") || error.message.includes(KEY)}).toEqual({name, leaked: false});
  }
  const short = fakeFetch(cases[5]![1]);
  expect((await failure(new ElevenLabsMusicProvider({apiKey: KEY, fetchImpl: short.impl}).compose(REQUEST))).providerRequestId).toBe("req_short");
}, 60000);

/** A request the contract refuses never reaches the transport, and says it was not sent. */
test("a request outside the contract is refused before anything is sent", async () => {
  const fake = fakeFetch(() => { throw new Error("must not be called"); });
  const provider = new ElevenLabsMusicProvider({apiKey: KEY, fetchImpl: fake.impl});
  for (const bad of [{prompt: "", durationSec: 30, seed: 0}, {prompt: "a cue", durationSec: 5, seed: 0}, {prompt: "a cue", durationSec: 301, seed: 0},
    {prompt: "a cue", durationSec: 30.5, seed: 0}, {prompt: "a cue", durationSec: 30, seed: -1}, {prompt: "a\u0007cue", durationSec: 30, seed: 0}]) {
    const error = await failure(provider.compose(bad as never));
    expect({bad, dispatched: error.dispatched}).toEqual({bad, dispatched: false});
  }
  expect(() => validateMusicCueRequest({prompt: "a cue", durationSec: 30, instrumental: false})).toThrow(MusicCueError);
  expect(() => validateMusicCueRequest({prompt: "a cue", durationSec: 30, lyrics: "la la"})).toThrow("A music cue has no lyrics.");
  expect(fake.calls).toHaveLength(0);
});

/** The cost is the probed length at the declared rate, never above the hold, whatever the vendor says. */
test("a cue costs its probed length at $0.15 a minute, rounded up to the cent, and never more than its hold", () => {
  const hold = musicCueHoldUsd(60);
  expect(hold).toBe(0.15);
  expect(musicCueCostUsd(60, hold)).toBe(0.15);
  expect(musicCueCostUsd(30.2, hold)).toBe(0.08);
  // Longer than asked: capped at the hold the line was checked against.
  expect(musicCueCostUsd(61.9, hold)).toBe(0.15);
  expect(musicCueCostUsd(0, hold)).toBe(0);
  expect(() => musicCueCostUsd(10, -1)).toThrow(MusicCueError);
});

/** The mock is deterministic, answers through the same door, and fails in both ways on request. */
test("the mock music adapter makes the same cue from the same request, through the contract's own checks", async () => {
  const mock = new MockMusicProvider();
  const first = await mock.compose(REQUEST), again = await mock.compose(REQUEST);
  expect(first.sha256).toBe(again.sha256);
  expect(first).toMatchObject({provider: "mock", sourceFormat: "wav", providerRequestId: null});
  expect(Math.abs(first.durationSec - 12)).toBeLessThan(0.01);
  expect(mockMusicWav({...REQUEST, seed: 8}).equals(mockMusicWav(REQUEST))).toBe(false);
  expect((await failure(new MockMusicProvider({fail: "before-dispatch"}).compose(REQUEST))).dispatched).toBe(false);
  expect((await failure(new MockMusicProvider({fail: "after-dispatch"}).compose(REQUEST))).dispatched).toBe(true);
  // A delivery past the tolerance is refused by the contract, not by the mock.
  expect((await failure(new MockMusicProvider({stretchSec: 3}).compose(REQUEST))).message).toContain("12 s was asked for");
}, 30000);

/** Live music only when the operator names the vendor and its key is present; the key alone, already on the host for voices, is not enough. */
test("the live adapter is reachable only when the operator names it, and a nonsense setting fails at startup", () => {
  expect(musicProviderFromEnvironment({})).toBeUndefined();
  expect(musicProviderFromEnvironment({HV_ELEVENLABS_API_KEY: KEY})).toBeUndefined();
  expect(musicProviderFromEnvironment({HV_MUSIC_PROVIDER: "none", HV_ELEVENLABS_API_KEY: KEY})).toBeUndefined();
  expect(() => musicProviderFromEnvironment({HV_MUSIC_PROVIDER: "elevenlabs"})).toThrow("needs the ElevenLabs credential");
  expect(() => musicProviderFromEnvironment({HV_MUSIC_PROVIDER: "suno", HV_ELEVENLABS_API_KEY: KEY})).toThrow("Set HV_MUSIC_PROVIDER");
  expect(() => musicProviderFromEnvironment({HV_MUSIC_PROVIDER: "mock"})).toThrow("Set HV_MUSIC_PROVIDER");
  expect(musicProviderFromEnvironment({HV_MUSIC_PROVIDER: "elevenlabs", HV_ELEVENLABS_API_KEY: KEY})).toBeInstanceOf(ElevenLabsMusicProvider);
  expect(() => new ElevenLabsMusicProvider({apiKey: " "})).toThrow("Configure the ElevenLabs credential");
});
