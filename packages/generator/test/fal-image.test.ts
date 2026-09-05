import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeterministicMockImageProvider, FalImageProvider, providerUsesPaidInference, resolveImageProvider, sunkCostsOf } from "../src/index";

const root = mkdtempSync(join(tmpdir(), "hv-fal-image-test-"));
const API = "https://queue.test";
const BASE = API + "/fal-ai/flux/schnell/requests/req-1";
const MEDIA = "https://v3.fal.media/files/frame.png";
let png: Buffer;
beforeAll(async () => {
  const frame = await new DeterministicMockImageProvider().generateFrame("A quiet garden", 1, {}, join(root, "source.png"));
  png = readFileSync(frame.path);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

type Options = {
  status?: string; cancelStatus?: string; cancelHttp?: number; afterCancel?: string | number;
  submitHttp?: number; submitThrows?: boolean; receipt?: Record<string, unknown>;
  result?: Record<string, unknown>; mediaBytes?: Buffer; mediaHttp?: number;
  declaredSize?: string; hangStatus?: boolean; pollHttp?: number; resultHttp?: number; streamedOversize?: boolean;
};
function fixture(opts: Options = {}) {
  const calls: { url: string; method: string; headers: Headers; body?: Record<string, unknown>; redirect?: RequestRedirect }[] = [];
  let cancelled = false;
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    init.signal?.throwIfAborted();
    const url = String(input), method = init.method ?? "GET";
    calls.push({ url, method, headers: new Headers(init.headers), body: init.body ? JSON.parse(String(init.body)) : undefined, redirect: init.redirect });
    if (method === "POST") {
      if (opts.submitThrows) throw new Error("network unavailable");
      return json({ request_id: "req-1", status_url: BASE + "/status", response_url: BASE, cancel_url: BASE + "/cancel", ...opts.receipt }, opts.submitHttp ?? 200);
    }
    if (url === BASE + "/cancel") {
      cancelled = true;
      return json({ status: opts.cancelStatus ?? "CANCELLATION_REQUESTED" }, opts.cancelHttp ?? 202);
    }
    if (url === BASE + "/status") {
      if (opts.hangStatus && !cancelled) return await new Promise<Response>((_resolve, reject) => {
        init.signal!.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
      });
      if (cancelled && typeof opts.afterCancel === "number") return json({}, opts.afterCancel);
      return json({ status: cancelled ? opts.afterCancel ?? opts.status ?? "COMPLETED" : opts.status ?? "COMPLETED" }, opts.pollHttp ?? 200);
    }
    if (url === BASE) return json({
      images: [{ url: MEDIA, width: 640, height: 360 }], has_nsfw_concepts: [false], ...opts.result,
    }, opts.resultHttp ?? 200);
    if (url === MEDIA && opts.streamedOversize) {
      let chunks = 0;
      return new Response(new ReadableStream({ pull(controller) {
        if (chunks++ < 3) controller.enqueue(new Uint8Array(16 * 1024 * 1024));
        else controller.close();
      } }));
    }
    if (url === MEDIA) return new Response(new Uint8Array(opts.mediaBytes ?? png), {
      status: opts.mediaHttp ?? 200,
      headers: opts.declaredSize ? { "content-length": opts.declaredSize } : {},
    });
    throw new Error("unexpected fixture URL");
  }) as typeof fetch;
  return {
    calls,
    provider: new FalImageProvider({ apiKey: "fixture-key", apiBase: API, fetchImpl, pollMs: 2,
      maxWaitMs: 60, requestTimeoutMs: 40, cleanupTimeoutMs: 40 }),
    fetchImpl,
  };
}
async function failure(provider: FalImageProvider, params = {}): Promise<unknown> {
  try {
    await provider.generateFrame("A quiet garden", 1, params, join(root, "failed", "frame.png"));
  } catch (error) { return error; }
  throw new Error("expected generation failure");
}

describe("fal image contract", () => {
  test("authenticates only queue calls, fixes single-image safe PNG inputs, normalizes and fingerprints the result", async () => {
    const f = fixture();
    const p = new FalImageProvider({ apiKey: "fixture-key", apiBase: API, fetchImpl: f.fetchImpl });
    let receipts = 0;
    const out = await p.generateFrame("A quiet garden", 17, { widthxheight: "320x180",onProviderRequest:async receipt=>{
      receipts++;expect(f.calls).toHaveLength(1);expect(receipt.requestId).toBe("req-1");expect(receipt.model).toBe("fal-ai/flux/schnell");
    } }, join(root, "success.png"));
    expect(receipts).toBe(1);
    expect(f.calls[0]!.body).toEqual({ prompt: "A quiet garden", seed: 17, image_size: { width: 320, height: 180 },
      num_images: 1, num_inference_steps: 4, output_format: "png", enable_safety_checker: true });
    expect(f.calls.slice(0, 3).every(c => c.headers.get("authorization") === "Key fixture-key")).toBe(true);
    expect(f.calls[3]!.headers.has("authorization")).toBe(false);
    expect(f.calls.every(c => c.redirect === "error")).toBe(true);
    expect(out.cost.total_cost_usd).toBe(0.003);
    expect(out.cost.output_frames).toBe(1);
    expect(out.cost.gpu_seconds).toBe(0);
    const bytes = readFileSync(out.path);
    expect([bytes.readUInt32BE(16), bytes.readUInt32BE(20)]).toEqual([320, 180]);
    expect(out.fingerprint).toBe(new Bun.CryptoHasher("sha256").update(bytes).digest("hex"));
  });

  test("receipt persistence failure cancels the image request and preserves the pause signal",async()=>{
    const f=fixture();
    const error=await failure(f.provider,{onProviderRequest:async()=>{throw Object.assign(new Error("receipt store unavailable"),{name:"BudgetError"});}});
    expect((error as Error).name).toBe("BudgetError");
    expect(f.calls.filter(call=>call.method==="POST")).toHaveLength(1);
    expect(f.calls.some(call=>call.url===BASE+"/cancel")).toBe(true);
  });
  test("prices rounded-up megapixels and validates explicit per-image price overrides", () => {
    const p = new FalImageProvider({ apiKey: "k" });
    expect(p.estimateFrameUsd({ widthxheight: "640x360" })).toBe(0.003);
    expect(p.estimateFrameUsd({ widthxheight: "1920x1080" })).toBe(0.009);
    expect(new FalImageProvider({ apiKey: "k", usdPerImage: 0.02 }).estimateFrameUsd({ widthxheight: "1920x1080" })).toBe(0.02);
    for (const usdPerImage of [0, -1, NaN, Infinity]) expect(() => new FalImageProvider({ apiKey: "k", usdPerImage })).toThrow();
  });

  test("safety and unsupported identity conditioning stop all network calls", async () => {
    const f = fixture();
    for (const params of [{ action: "deepfake of a real celebrity" }, { sceneHeading: "deepfake of a real celebrity" },
      { shotId: "deepfake of a real celebrity" }, { referenceFrames: [MEDIA] }, { identityLocks: ["spud"] },
      { signal: AbortSignal.abort() }, { widthxheight: "1x1" }]) {
      await expect(f.provider.generateFrame("A quiet garden", 1, params, join(root, "blocked.png"))).rejects.toThrow();
    }
    await expect(f.provider.generateFrame("deepfake of a real celebrity", 1, {}, join(root, "blocked.png"))).rejects.toThrow();
    expect(f.calls).toHaveLength(0);
    expect(existsSync(join(root, "blocked.png"))).toBe(false);
  });

  test("known queued cancellation can release cost, including a removed request", async () => {
    for (const afterCancel of ["IN_QUEUE", 404]) {
      const f = fixture({ status: "IN_QUEUE", afterCancel });
      const err = await failure(f.provider);
      expect(sunkCostsOf(err)).toEqual([]);
      expect(f.calls.filter(c => c.method === "PUT")).toHaveLength(1);
    }
  });

  test("in-progress, cancellation races, rejected cancellation and unknown cleanup remain charged", async () => {
    for (const opts of [
      { status: "IN_PROGRESS", afterCancel: "IN_PROGRESS" },
      { status: "IN_QUEUE", afterCancel: "COMPLETED" },
      { status: "IN_QUEUE", cancelHttp: 400, afterCancel: 404 },
      { status: "IN_QUEUE", afterCancel: "UNRECOGNIZED" },
    ]) {
      const f = fixture(opts);
      expect(sunkCostsOf(await failure(f.provider))[0]!.total_cost_usd).toBe(0.003);
    }
  });

  test("hanging status requests time out and attempt bounded cleanup", async () => {
    const f = fixture({ hangStatus: true, afterCancel: "IN_PROGRESS" });
    const started = Date.now();
    expect(sunkCostsOf(await failure(f.provider))[0]!.total_cost_usd).toBe(0.003);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(f.calls.some(c => c.method === "PUT")).toBe(true);
  });

  test("submit rejection has no cost, but a lost submission receipt carries a conservative estimate", async () => {
    expect(sunkCostsOf(await failure(fixture({ submitHttp: 401 }).provider))).toEqual([]);
    expect(sunkCostsOf(await failure(fixture({ submitThrows: true }).provider))[0]!.total_cost_usd).toBe(0.003);
    expect(sunkCostsOf(await failure(fixture({ receipt: { request_id: null } }).provider))[0]!.total_cost_usd).toBe(0.003);
  });

  test("post-submission HTTP errors and unknown queue statuses carry cost", async () => {
    for (const opts of [{ pollHttp: 500 }, { status: "FAILED" }, { status: "UNKNOWN" }, { resultHttp: 500 }]) {
      expect(sunkCostsOf(await failure(fixture(opts).provider))[0]!.total_cost_usd).toBe(0.003);
    }
  });

  test("unsafe or missing output verdict is terminal and billed with no download", async () => {
    for (const flags of [[true], [], undefined]) {
      const f = fixture({ result: { has_nsfw_concepts: flags } });
      const err = await failure(f.provider);
      expect((err as Error).name).toBe("SafetyRefusal");
      expect(sunkCostsOf(err)[0]!.total_cost_usd).toBe(0.003);
      expect(f.calls.some(c => c.url === MEDIA)).toBe(false);
    }
  });

  test("completed results that are invalid, too large, or fail to download retain cost and preserve output", async () => {
    for (const opts of [
      { result: { images: [] } }, { mediaHttp: 503 }, { mediaBytes: Buffer.from("not a PNG") },
      { declaredSize: String(33 * 1024 * 1024) }, { streamedOversize: true }, { mediaHttp: 302 }, { result: { images: [{ url: MEDIA, width: 99999, height: 360 }] } },
    ]) {
      const f = fixture(opts);
      const target = join(root, "previous.png");
      writeFileSync(target, "previous artifact");
      let error: unknown;
      try { await f.provider.generateFrame("A quiet garden", 1, {}, target); } catch (err) { error = err; }
      expect(sunkCostsOf(error)[0]!.total_cost_usd).toBe(0.003);
      expect(readFileSync(target, "utf8")).toBe("previous artifact");
    }
  });

  test("queue URLs cannot exfiltrate keys and media URLs cannot target internal hosts", async () => {
    const f = fixture({ receipt: { response_url: "https://evil.example/results" } });
    await failure(f.provider);
    expect(f.calls.every(c => c.url.startsWith(API))).toBe(true);
    for (const url of ["http://127.0.0.1/x", "https://fal.media.evil.example/x", "file:///etc/passwd", "https://u:p@v3.fal.media/x"]) {
      const media = fixture({ result: { images: [{ url, width: 640, height: 360 }] } });
      expect(sunkCostsOf(await failure(media.provider))[0]!.total_cost_usd).toBe(0.003);
      expect(media.calls.every(c => c.url.startsWith(API))).toBe(true);
    }
  });

  test("external abort cancels an active request and leaves no background polling", async () => {
    const f = fixture({ status: "IN_PROGRESS", afterCancel: "IN_PROGRESS" });
    const controller = new AbortController();
    const p = new FalImageProvider({ apiKey: "k", apiBase: API, fetchImpl: f.fetchImpl, pollMs: 1000 });
    const pending = failure(p, { signal: controller.signal });
    await Bun.sleep(10);
    controller.abort();
    expect(sunkCostsOf(await pending)[0]!.total_cost_usd).toBe(0.003);
    const count = f.calls.length;
    await Bun.sleep(20);
    expect(f.calls).toHaveLength(count);
  });

  test("failed PNG decoding retains the estimate and preserves previous content", async () => {
    const corrupt = Buffer.from(png.subarray(0, 40));
    const f = fixture({ mediaBytes: corrupt });
    const target = join(root, "decoder-failure.png");
    writeFileSync(target, "previous artifact");
    const p = new FalImageProvider({ apiKey: "k", apiBase: API, fetchImpl: f.fetchImpl });
    let error: unknown;
    try { await p.generateFrame("A quiet garden", 1, {}, target); } catch (err) { error = err; }
    expect(sunkCostsOf(error)[0]!.total_cost_usd).toBe(0.003);
    expect(readFileSync(target, "utf8")).toBe("previous artifact");
  });

  test("provider resolution is explicit, validates environment values, and identifies paid image specs", () => {
    expect(resolveImageProvider("mock").name).toBe("mock");
    expect(resolveImageProvider("image:mock").name).toBe("mock");
    expect(resolveImageProvider("image:fal", { FAL_KEY: "k" }).name).toBe("fal-image");
    expect(resolveImageProvider("image:fal:flux-schnell", { FAL_KEY: "k" }).model).toBe("fal-ai/flux/schnell");
    for (const spec of ["image:fal", "image:fal:nope", "image:unknown", "image:fal:constructor", "image:fal:toString"]) expect(() => resolveImageProvider(spec, {})).toThrow();
    expect(() => resolveImageProvider("image:fal", { FAL_KEY: "k", HV_FAL_IMAGE_USD_PER_IMAGE: "NaN" })).toThrow();
    expect(() => resolveImageProvider("image:fal:constructor", { FAL_KEY: "k" })).toThrow("unknown");
    for (const spec of ["fal", "fal:model", "image:fal", "image:fal:flux-schnell"]) expect(providerUsesPaidInference(spec)).toBe(true);
    for (const spec of ["mock", "image:mock", "false", "image:falcon"]) expect(providerUsesPaidInference(spec)).toBe(false);
  });
});
