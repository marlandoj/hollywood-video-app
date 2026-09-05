import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gateOrThrow } from "../../safety/src/index";
import { FalProviderError } from "./fal";
import { DeterministicMockImageProvider, parseFrameSize, type FrameParams, type ImageProvider, type StillFrame } from "./image";
import type { CostRecord } from "./index";

export const DEFAULT_FAL_IMAGE_MODEL = "flux-schnell";
export const FAL_IMAGE_MODELS: Readonly<Record<string, { endpoint: string; usdPerMegapixel: number; supportsCustomSize: boolean }>> = {
  "flux-schnell": { endpoint: "fal-ai/flux/schnell", usdPerMegapixel: 0.003, supportsCustomSize: true },
};

export interface FalImageOptions {
  apiKey?: string;
  model?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  pollMs?: number;
  maxWaitMs?: number;
  requestTimeoutMs?: number;
  cleanupTimeoutMs?: number;
  usdPerImage?: number;
}

class ImageHttpError extends Error {
  constructor(readonly status: number) {
    super(`fal image request failed (HTTP ${status})`);
  }
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be positive and finite`);
  return value;
}

async function limitedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > maxBytes) {
    await response.body?.cancel();
    throw new Error("fal response exceeds size limit");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("fal response has no body");
  const parts: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) throw new Error("fal response exceeds size limit");
      parts.push(value);
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  return Buffer.concat(parts);
}

function queueUrl(value: string, base: string): string {
  const url = new URL(value);
  if (url.origin !== base || url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error("untrusted fal queue URL");
  }
  return url.href;
}

function mediaUrl(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash ||
      !(url.hostname === "fal.media" || url.hostname.endsWith(".fal.media"))) {
    throw new Error("untrusted fal image URL");
  }
  return url.href;
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolvePause, reject) => {
    signal.throwIfAborted();
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolvePause();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });
}

async function normalizeFrame(bytes: Buffer, width: number, height: number, outPath: string, signal: AbortSignal): Promise<string> {
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.toString("ascii", 12, 16) !== "IHDR") throw new Error("fal image is not a PNG");
  const sourceWidth = bytes.readUInt32BE(16), sourceHeight = bytes.readUInt32BE(20);
  if (!sourceWidth || !sourceHeight || sourceWidth > 4096 || sourceHeight > 4096) throw new Error("fal image dimensions exceed limits");
  const scratch = mkdtempSync(join(tmpdir(), "hv-fal-image-"));
  try {
    writeFileSync(join(scratch, "source.png"), bytes);
    signal.throwIfAborted();
    const child = Bun.spawn([
      "ffmpeg", "-y", "-v", "error", "-protocol_whitelist", "file,pipe", "-i", "source.png",
      "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      "-frames:v", "1", "-threads", "1", "-c:v", "png", "-fflags", "+bitexact",
      "-flags:v", "+bitexact", "-map_metadata", "-1", "frame.png",
    ], { cwd: scratch, stdout: "ignore", stderr: "pipe" });
    const abort = () => child.kill();
    signal.addEventListener("abort", abort, { once: true });
    try {
      if (signal.aborted) abort();
      const [exitCode] = await Promise.all([child.exited, new Response(child.stderr).text()]);
      signal.throwIfAborted();
      if (exitCode !== 0) throw new Error("fal PNG normalization failed");
    } finally {
      signal.removeEventListener("abort", abort);
    }
    const result = readFileSync(join(scratch, "frame.png"));
    signal.throwIfAborted();
    const target = resolve(outPath);
    mkdirSync(dirname(target), { recursive: true });
    const staging = mkdtempSync(join(dirname(target), ".hv-image-"));
    try {
      writeFileSync(join(staging, "frame.png"), result);
      renameSync(join(staging, "frame.png"), target);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
    return createHash("sha256").update(result).digest("hex");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export class FalImageProvider implements ImageProvider {
  readonly name = "fal-image";
  readonly model: string;
  readonly modelKey: string;
  private readonly key: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollMs: number;
  private readonly maxWaitMs: number;
  private readonly requestTimeoutMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly usdPerImage?: number;

  constructor(opts: FalImageOptions = {}) {
    this.modelKey = opts.model ?? DEFAULT_FAL_IMAGE_MODEL;
    const spec = Object.hasOwn(FAL_IMAGE_MODELS, this.modelKey) ? FAL_IMAGE_MODELS[this.modelKey] : undefined;
    if (!spec) throw new Error("unknown fal image model");
    this.model = spec.endpoint;
    this.key = opts.apiKey ?? process.env.FAL_KEY ?? "";
    if (!this.key.trim()) throw new Error("FAL_KEY is required for image inference");
    const base = new URL(opts.apiBase ?? "https://queue.fal.run");
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") {
      throw new Error("fal image API base must be an HTTPS origin");
    }
    this.base = base.origin;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pollMs = positive(opts.pollMs ?? 1000, "poll interval");
    this.maxWaitMs = positive(opts.maxWaitMs ?? 120_000, "image wait budget");
    this.requestTimeoutMs = positive(opts.requestTimeoutMs ?? 15_000, "request timeout");
    this.cleanupTimeoutMs = positive(opts.cleanupTimeoutMs ?? 5000, "cleanup timeout");
    this.usdPerImage = opts.usdPerImage === undefined ? undefined : positive(opts.usdPerImage, "image price");
  }

  estimateFrameUsd(params: FrameParams = {}): number {
    const [width, height] = parseFrameSize(params.widthxheight ?? "640x360");
    return this.price(width, height);
  }

  private price(width: number, height: number): number {
    return this.usdPerImage ?? Number((Math.ceil(width * height / 1_000_000) * FAL_IMAGE_MODELS[this.modelKey]!.usdPerMegapixel).toFixed(6));
  }

  private async call(url: string, signal: AbortSignal, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const response = await this.fetchImpl(queueUrl(url, this.base), {
      ...init, redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]),
      headers: { ...init.headers, authorization: `Key ${this.key}` },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ImageHttpError(response.status);
    }
    const data: unknown = JSON.parse((await limitedBody(response, 256_000)).toString("utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid fal response");
    return data as Record<string, unknown>;
  }

  private async cancel(cancelUrl: string, statusUrl: string, observed: string): Promise<boolean> {
    const signal = AbortSignal.timeout(this.cleanupTimeoutMs);
    let accepted = false;
    try {
      const result = await this.call(cancelUrl, signal, { method: "PUT" });
      accepted = result.status === "CANCELLATION_REQUESTED";
    } catch {}
    try {
      const status = await this.call(statusUrl, signal);
      if (status.status === "IN_PROGRESS" || status.status === "COMPLETED") return true;
      if (accepted && observed === "IN_QUEUE" && status.status === "IN_QUEUE") return false;
    } catch (error) {
      if (accepted && observed === "IN_QUEUE" && error instanceof ImageHttpError && error.status === 404) return false;
    }
    return true;
  }

  async generateFrame(prompt: string, seed: number, params: FrameParams, outPath: string): Promise<StillFrame> {
    gateOrThrow([prompt, params.shotId ?? "", params.sceneHeading ?? "", params.action ?? ""].join("\n"));
    params.signal?.throwIfAborted();
    if (!Number.isSafeInteger(seed) || seed < 0 || seed > 2147483647) throw new Error("fal image seed must be an integer from 0 to 2147483647");
    if (params.referenceFrames?.length || params.identityLocks?.length) throw new Error("fal image identity conditioning is not implemented");
    const [width, height] = parseFrameSize(params.widthxheight ?? "640x360");
    const cost: CostRecord = {
      provider: this.name, model: this.model, prompt_tokens: Math.ceil(prompt.length / 4),
      output_frames: 1, gpu_seconds: 0, total_cost_usd: this.price(width, height),
    };
    const controller = new AbortController();
    const signal = params.signal ? AbortSignal.any([params.signal, controller.signal]) : controller.signal;
    const timer = setTimeout(() => controller.abort(new Error("fal image wait budget exceeded")), this.maxWaitMs);
    let requestId: string | undefined;
    let statusUrl = "", cancelUrl = "", observed = "";
    let submitted = false;
    let started = false;
    let mayBeBilled = true;
    try {
      signal.throwIfAborted();
      submitted = true;
      const receipt = await this.call(`${this.base}/${this.model}`, signal, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt, seed, image_size: { width, height }, num_images: 1,
          num_inference_steps: 4, output_format: "png", enable_safety_checker: true }),
      });
      if (typeof receipt.request_id !== "string" || !/^[a-zA-Z0-9_-]+$/.test(receipt.request_id)) throw new Error("fal image submit returned no valid request ID");
      requestId = receipt.request_id;
      const requestBase = `${this.base}/${this.model}/requests/${requestId}`;
      statusUrl = `${requestBase}/status`;
      cancelUrl = `${requestBase}/cancel`;
      if (receipt.status_url !== undefined) statusUrl = queueUrl(String(receipt.status_url), this.base);
      if (receipt.cancel_url !== undefined) cancelUrl = queueUrl(String(receipt.cancel_url), this.base);
      const responseUrl = queueUrl(String(receipt.response_url ?? requestBase), this.base);
      for (;;) {
        const result = await this.call(statusUrl, signal);
        observed = String(result.status);
        started ||= observed === "IN_PROGRESS" || observed === "COMPLETED";
        if (observed === "COMPLETED") break;
        if (observed !== "IN_QUEUE" && observed !== "IN_PROGRESS") throw new Error("fal image returned a failed or unknown status");
        await pause(this.pollMs, signal);
      }
      const result = await this.call(responseUrl, signal);
      const images = result.images as Array<{ url?: unknown; width?: unknown; height?: unknown }> | undefined;
      const flags = result.has_nsfw_concepts;
      if (!Array.isArray(flags) || flags.length !== 1 || flags[0] !== false) {
        throw Object.assign(new Error("fal image was refused or lacked a safety verdict"), { name: "SafetyRefusal" });
      }
      if (!Array.isArray(images) || images.length !== 1 || typeof images[0]?.url !== "string") throw new Error("fal result must contain exactly one image");
      const returnedWidth = Number(images[0].width), returnedHeight = Number(images[0].height);
      if (!Number.isInteger(returnedWidth) || !Number.isInteger(returnedHeight) || returnedWidth <= 0 || returnedHeight <= 0 ||
          returnedWidth > 4096 || returnedHeight > 4096) throw new Error("invalid fal result dimensions");
      cost.total_cost_usd = Math.max(cost.total_cost_usd, this.price(returnedWidth, returnedHeight));
      const download = await this.fetchImpl(mediaUrl(images[0].url), {
        signal: AbortSignal.any([signal, AbortSignal.timeout(this.requestTimeoutMs)]), redirect: "error",
      });
      if (!download.ok) {
        await download.body?.cancel();
        throw new Error("fal image download failed");
      }
      const bytes = await limitedBody(download, 32 * 1024 * 1024);
      if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        const decodedWidth = bytes.readUInt32BE(16), decodedHeight = bytes.readUInt32BE(20);
        if (decodedWidth > 0 && decodedHeight > 0 && decodedWidth <= 4096 && decodedHeight <= 4096) {
          cost.total_cost_usd = Math.max(cost.total_cost_usd, this.price(decodedWidth, decodedHeight));
        }
      }
      const fingerprint = await normalizeFrame(bytes, width, height, outPath, signal);
      return { path: outPath, provider: this.name, model: this.model, seed, fingerprint, cost };
    } catch (error) {
      if (requestId && observed !== "COMPLETED") mayBeBilled = await this.cancel(cancelUrl, statusUrl, started ? "IN_PROGRESS" : observed);
      if (!requestId && error instanceof ImageHttpError && error.status >= 400 && error.status < 500) mayBeBilled = false;
      const failed = new FalProviderError(
        signal.aborted ? "fal image request aborted or exceeded its wait budget" :
          error instanceof Error ? error.message : "fal image generation failed",
        requestId, submitted && mayBeBilled ? cost : undefined,
      );
      if (error instanceof Error && error.name === "SafetyRefusal") failed.name = "SafetyRefusal";
      throw failed;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function resolveImageProvider(spec: string, env: Record<string, string | undefined> = process.env): ImageProvider {
  const value = spec.trim();
  if (value === "mock" || value === "image:mock") return new DeterministicMockImageProvider();
  if (value !== "image:fal" && !value.startsWith("image:fal:")) throw new Error("unknown image provider");
  return new FalImageProvider({
    apiKey: env.FAL_KEY ?? "", model: value === "image:fal" ? DEFAULT_FAL_IMAGE_MODEL : value.slice("image:fal:".length),
    usdPerImage: !env.HV_FAL_IMAGE_USD_PER_IMAGE?.trim() ? undefined : Number(env.HV_FAL_IMAGE_USD_PER_IMAGE),
    maxWaitMs: env.HV_FAL_IMAGE_MAX_WAIT_MS === undefined ? undefined : Number(env.HV_FAL_IMAGE_MAX_WAIT_MS),
  });
}
