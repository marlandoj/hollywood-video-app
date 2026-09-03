import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import {
  DEFAULT_FAL_MAX_WAIT_MS,
  DeterministicMockProvider,
  FAL_MODELS,
  FailoverGenerator,
  FalProviderError,
  FalVideoProvider,
  frameFingerprint,
  pickAspectRatio,
  pickBilledDuration,
  repairLoop,
  resolveProvider,
  type CostRecord,
  type VideoClip,
} from "../src/index";

const TMP = `/tmp/hv-fal-test-${process.pid}`;
mkdirSync(TMP, { recursive: true });
const API = "https://fal.test";
const ENDPOINT = FAL_MODELS["kling-v2.5-turbo-pro"]!.endpoint;

function sampleClip(path: string, seconds = 5): string {
  const proc = Bun.spawnSync([
    "ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", `testsrc=size=1280x720:rate=24:duration=${seconds}`,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path,
  ]);
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return path;
}

function probe(path: string): { width: number; height: number; fps: number; durationSec: number; audio: boolean } {
  const proc = Bun.spawnSync(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path]);
  const info = JSON.parse(proc.stdout.toString()) as { streams: Array<Record<string, string>>; format: { duration: string } };
  const video = info.streams.find((s) => s.codec_type === "video")!;
  const [n, d] = video.r_frame_rate!.split("/").map(Number);
  return {
    width: Number(video.width), height: Number(video.height), fps: n! / d!,
    durationSec: Number(info.format.duration), audio: info.streams.some((s) => s.codec_type === "audio"),
  };
}

interface FakeFal {
  fetchImpl: typeof fetch;
  submits: Array<{ url: string; body: Record<string, unknown>; auth: string | null }>;
  polls: number;
  cancels: number;
}

// hang keeps the request IN_QUEUE forever (cancellable); inProgress keeps it
// IN_PROGRESS forever, where fal rejects the cancel and bills the render.
function fakeFal(opts: { clipPath: string; pollsUntilDone?: number; fail?: boolean; hang?: boolean; inProgress?: boolean } ): FakeFal {
  const state: FakeFal = { submits: [], polls: 0, cancels: 0, fetchImpl: undefined as unknown as typeof fetch };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  state.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization");
    if (init?.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (method === "POST" && url === `${API}/${ENDPOINT}`) {
      state.submits.push({ url, body: JSON.parse(String(init?.body)), auth });
      return json({ request_id: "req-1", status_url: `${API}/${ENDPOINT}/requests/req-1/status`, response_url: `${API}/${ENDPOINT}/requests/req-1` });
    }
    if (url.endsWith("/requests/req-1/status")) {
      state.polls += 1;
      if (opts.fail) return json({ status: "FAILED", error: { message: "content policy" } });
      if (opts.inProgress) return json({ status: "IN_PROGRESS" });
      if (opts.hang) return json({ status: "IN_QUEUE" });
      return json({ status: state.polls >= (opts.pollsUntilDone ?? 2) ? "COMPLETED" : "IN_QUEUE" });
    }
    if (url.endsWith("/requests/req-1/cancel")) {
      state.cancels += 1;
      if (opts.inProgress) return json({ detail: "request is already in progress" }, 400);
      return json({ ok: true });
    }
    if (url.endsWith("/requests/req-1")) return json({ video: { url: `${API}/files/clip.mp4` } });
    if (url === `${API}/files/clip.mp4`) return new Response(Bun.file(opts.clipPath));
    return json({ error: `unexpected ${method} ${url}` }, 404);
  }) as typeof fetch;
  return state;
}

describe("fal.ai provider adapter (FR-6.1)", () => {
  const clip = sampleClip(`${TMP}/source.mp4`);

  test("submits with the API key, polls to completion, and normalizes the clip to the requested shot", async () => {
    const fal = fakeFal({ clipPath: clip });
    const provider = new FalVideoProvider({ apiKey: "test-key", apiBase: API, fetchImpl: fal.fetchImpl, pollMs: 1 });
    const out = `${TMP}/shot.mp4`;
    const result = await provider.generate("INT. ZOO - DAY. A potato watches the flamingos.", 11, { seed: 11, durationSec: 2, fps: 30, widthxheight: "1280x720" }, out);

    expect(fal.submits.length).toBe(1);
    expect(fal.submits[0]!.auth).toBe("Key test-key");
    expect(fal.submits[0]!.body).toMatchObject({ duration: "5", aspect_ratio: "16:9", prompt: "INT. ZOO - DAY. A potato watches the flamingos." });
    expect(fal.polls).toBe(2);
    expect(existsSync(out)).toBe(true);
    expect(existsSync(`${out}.raw.mp4`)).toBe(false);

    const info = probe(out);
    expect(info.width).toBe(1280);
    expect(info.height).toBe(720);
    expect(info.fps).toBe(30);
    expect(Math.abs(info.durationSec - 2)).toBeLessThan(0.1);
    expect(info.audio).toBe(false);

    expect(result.provider).toBe("fal");
    expect(result.model).toBe(ENDPOINT);
    expect(result.durationSec).toBe(2);
    expect(result.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.cost).toEqual({ provider: "fal", model: ENDPOINT, prompt_tokens: 12, output_frames: 60, gpu_seconds: 5, total_cost_usd: 0.35 });
  }, 30000);

  test("pads a clip shorter than the shot and uses the price override", async () => {
    const short = sampleClip(`${TMP}/short.mp4`, 1);
    const fal = fakeFal({ clipPath: short });
    const provider = new FalVideoProvider({ apiKey: "k", apiBase: API, fetchImpl: fal.fetchImpl, pollMs: 1, usdPerBilledSecond: 0.5 });
    const result = await provider.generate("EXT. GARDEN - DUSK. Wind moves the leaves.", 1, { seed: 1, durationSec: 3, fps: 30, widthxheight: "640x360" }, `${TMP}/padded.mp4`);
    const info = probe(result.path);
    expect(Math.abs(info.durationSec - 3)).toBeLessThan(0.1);
    expect(info.width).toBe(640);
    expect(result.cost.total_cost_usd).toBe(2.5);
  }, 30000);

  test("a prohibited prompt is refused before any request leaves the process", async () => {
    const fal = fakeFal({ clipPath: clip });
    const provider = new FalVideoProvider({ apiKey: "k", apiBase: API, fetchImpl: fal.fetchImpl, pollMs: 1 });
    await expect(provider.generate("deepfake of a real celebrity, intimate scene", 1, { seed: 1 }, `${TMP}/refused.mp4`)).rejects.toThrow("content policy");
    expect(fal.submits.length).toBe(0);
  });

  test("a FAILED status surfaces as a provider error so failover can run", async () => {
    const fal = fakeFal({ clipPath: clip, fail: true });
    const provider = new FalVideoProvider({ apiKey: "k", apiBase: API, fetchImpl: fal.fetchImpl, pollMs: 1 });
    await expect(provider.generate("INT. ROOM - DAY. A lamp glows.", 1, { seed: 1, durationSec: 1 }, `${TMP}/failed.mp4`)).rejects.toThrow("fal generation failed");
  });

  test("timeout aborts the primary, cancels its remote request, and fails over", async () => {
    const fal = fakeFal({ clipPath: clip, hang: true });
    const hanging = new FalVideoProvider({ apiKey: "k", apiBase: API, fetchImpl: fal.fetchImpl, pollMs: 5 });
    const generator = new FailoverGenerator(hanging, new DeterministicMockProvider(), 60);
    const result = await generator.generate("INT. ROOM - DAY. A lamp glows.", 1, { seed: 1, durationSec: 1 }, `${TMP}/failover.mp4`);
    expect(result.failedOver).toBe(true);
    expect(result.provider).toBe("mock");
    await Bun.sleep(30);
    const pollsAfterAbort = fal.polls;
    await Bun.sleep(30);
    expect(fal.polls).toBe(pollsAfterAbort);
    expect(fal.cancels).toBe(1);
    expect(result.sunkCosts).toEqual([]);
  }, 20000);

  test("a timed-out request that already left the queue is charged as sunk cost and fails over", async () => {
    const fal = fakeFal({ clipPath: clip, inProgress: true });
    const rendering = new FalVideoProvider({ apiKey: "k", apiBase: API, fetchImpl: fal.fetchImpl, pollMs: 5 });
    const generator = new FailoverGenerator(rendering, new DeterministicMockProvider(), 60);
    const result = await generator.generate("INT. ROOM - DAY. A lamp glows.", 1, { seed: 1, durationSec: 2 }, `${TMP}/sunk-failover.mp4`);
    expect(result.failedOver).toBe(true);
    expect(result.provider).toBe("mock");
    expect(fal.cancels).toBe(1);
    expect(result.sunkCosts).toEqual([
      { provider: "fal", model: ENDPOINT, prompt_tokens: 8, output_frames: 60, gpu_seconds: 5, total_cost_usd: 0.35 },
    ]);
  }, 20000);

  test("a timed-out request whose fallback also fails still surfaces the sunk cost on the error", async () => {
    const fal = fakeFal({ clipPath: clip, inProgress: true });
    const rendering = new FalVideoProvider({ apiKey: "k", apiBase: API, fetchImpl: fal.fetchImpl, pollMs: 5 });
    const broken = { name: "broken", model: "broken-v1", generate: () => Promise.reject(new Error("secondary down")) };
    const generator = new FailoverGenerator(rendering, broken, 60);
    let caught: unknown;
    try {
      await generator.generate("INT. ROOM - DAY. A lamp glows.", 1, { seed: 1, durationSec: 2 }, `${TMP}/sunk-both.mp4`);
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).message).toBe("secondary down");
    expect((caught as { sunkCosts: CostRecord[] }).sunkCosts.map((c) => c.total_cost_usd)).toEqual([0.35]);
  }, 20000);

  test("exceeding the fal wait budget cancels a queued request at no cost", async () => {
    const fal = fakeFal({ clipPath: clip, hang: true });
    const provider = new FalVideoProvider({ apiKey: "k", apiBase: API, fetchImpl: fal.fetchImpl, pollMs: 2, maxWaitMs: 20 });
    let caught: unknown;
    try {
      await provider.generate("INT. ROOM - DAY. A lamp glows.", 1, { seed: 1, durationSec: 1 }, `${TMP}/budget.mp4`);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FalProviderError);
    expect((caught as Error).message).toContain("exceeded");
    expect((caught as FalProviderError).sunkCost).toBeUndefined();
    expect(fal.cancels).toBe(1);
  });

  test("exceeding the fal wait budget on a rendering request reports the billed cost", async () => {
    const fal = fakeFal({ clipPath: clip, inProgress: true });
    const provider = new FalVideoProvider({ apiKey: "k", apiBase: API, fetchImpl: fal.fetchImpl, pollMs: 2, maxWaitMs: 20 });
    let caught: unknown;
    try {
      await provider.generate("INT. ROOM - DAY. A lamp glows.", 1, { seed: 1, durationSec: 1 }, `${TMP}/budget-billed.mp4`);
    } catch (err) {
      caught = err;
    }
    expect((caught as FalProviderError).sunkCost?.total_cost_usd).toBe(0.35);
    expect(fal.cancels).toBe(1);
  });

  test("the default wait budget covers an observed Kling render with margin", () => {
    expect(DEFAULT_FAL_MAX_WAIT_MS).toBe(900_000);
    expect(DEFAULT_FAL_MAX_WAIT_MS).toBeGreaterThanOrEqual(2 * 360_000);
  });

  test("veo3-fast maps duration, seed, and audio-off input", async () => {
    const fal = fakeFal({ clipPath: clip });
    const veo = FAL_MODELS["veo3-fast"]!;
    const fetchImpl = ((input: RequestInfo | URL, init?: RequestInit) =>
      fal.fetchImpl(String(input).replace(veo.endpoint, ENDPOINT), init)) as typeof fetch;
    const provider = new FalVideoProvider({ apiKey: "k", apiBase: API, fetchImpl, pollMs: 1, model: "veo3-fast" });
    const result = await provider.generate("EXT. STREET - NIGHT. Rain on neon.", 99, { seed: 99, durationSec: 5, fps: 30, widthxheight: "1920x1080" }, `${TMP}/veo.mp4`);
    expect(fal.submits[0]!.body).toMatchObject({ duration: "6s", seed: 99, generate_audio: false, resolution: "720p", aspect_ratio: "16:9" });
    expect(result.cost.gpu_seconds).toBe(6);
    expect(result.cost.total_cost_usd).toBe(0.6);
  }, 30000);

  test("construction fails closed without an API key or with an unknown model", () => {
    expect(() => new FalVideoProvider({ apiKey: "", model: "kling-v2.5-turbo-pro" })).toThrow("FAL_KEY");
    expect(() => new FalVideoProvider({ apiKey: "k", model: "nope" })).toThrow("unknown fal model");
  });
});

describe("sunk-cost accounting", () => {
  const cost = (usd: number): CostRecord => ({ provider: "paid", model: "m", prompt_tokens: 1, output_frames: 30, gpu_seconds: 5, total_cost_usd: usd });
  const fakeClip = (fingerprint: string, usd: number): VideoClip => ({ path: "/dev/null", provider: "paid", model: "m", seed: 1, durationSec: 1, fingerprint, cost: cost(usd) });

  test("repair attempts whose clips are discarded still carry their cost", async () => {
    const reviews: { shotId: string; score: number }[] = [];
    const prev = fakeClip("0".repeat(64), 0);
    const result = await repairLoop("shot-1", prev, async (attempt) => fakeClip("f".repeat(64), 0.35 + attempt), reviews);
    expect(result.outcome.status).toBe("degraded");
    expect(result.outcome.attempts).toBe(2);
    expect(result.clip.cost.total_cost_usd).toBe(2.35);
    expect(result.sunkCosts.map((c) => c.total_cost_usd)).toEqual([0.35, 1.35]);
  });

  test("a repair attempt that throws carries the discarded costs on the error", async () => {
    const prev = fakeClip("0".repeat(64), 0);
    let caught: unknown;
    try {
      await repairLoop("shot-1", prev, async (attempt) => {
        if (attempt === 1) throw Object.assign(new Error("provider timeout"), { sunkCost: cost(0.5) });
        return fakeClip("f".repeat(64), 0.35);
      }, []);
    } catch (err) {
      caught = err;
    }
    expect((caught as { sunkCosts: CostRecord[] }).sunkCosts.map((c) => c.total_cost_usd)).toEqual([0.35, 0.5]);
  });

  test("a clean run carries no sunk cost", async () => {
    const result = await repairLoop("shot-1", null, async () => fakeClip("a".repeat(64), 0.35), []);
    expect(result.sunkCosts).toEqual([]);
  });
});

describe("provider selection helpers", () => {
  test("billed duration is the smallest supported length that covers the shot", () => {
    expect(pickBilledDuration([5, 10], 2)).toBe(5);
    expect(pickBilledDuration([5, 10], 5)).toBe(5);
    expect(pickBilledDuration([5, 10], 7)).toBe(10);
    expect(pickBilledDuration([4, 6, 8], 30)).toBe(8);
  });

  test("aspect ratio picks the closest supported frame", () => {
    expect(pickAspectRatio(["16:9", "9:16", "1:1"], 1920, 1080)).toBe("16:9");
    expect(pickAspectRatio(["16:9", "9:16", "1:1"], 640, 360)).toBe("16:9");
    expect(pickAspectRatio(["16:9", "9:16", "1:1"], 1080, 1920)).toBe("9:16");
    expect(pickAspectRatio(["16:9", "9:16"], 1000, 1000)).toBe("16:9");
  });

  test("frame fingerprints are stable for identical clips and 256 bits wide", () => {
    const a = sampleClip(`${TMP}/fp-a.mp4`, 1);
    const b = sampleClip(`${TMP}/fp-b.mp4`, 1);
    expect(frameFingerprint(a, 0.5)).toBe(frameFingerprint(b, 0.5));
    expect(frameFingerprint(a, 0.5)).toMatch(/^[0-9a-f]{64}$/);
  });

  test("HV_PROVIDER_* strings resolve to adapters and reject unknown values", () => {
    expect(resolveProvider("mock").name).toBe("mock");
    expect(resolveProvider("").name).toBe("mock");
    const fal = resolveProvider("fal", { FAL_KEY: "k" }) as FalVideoProvider;
    expect(fal.name).toBe("fal");
    expect(fal.modelKey).toBe("kling-v2.5-turbo-pro");
    expect((resolveProvider("fal:veo3-fast", { FAL_KEY: "k" }) as FalVideoProvider).modelKey).toBe("veo3-fast");
    expect(() => resolveProvider("fal", {})).toThrow("FAL_KEY");
    expect(() => resolveProvider("fal:nope", { FAL_KEY: "k" })).toThrow("unknown fal model");
    expect(() => resolveProvider("runway", { FAL_KEY: "k" })).toThrow("unknown provider");
  });
});
