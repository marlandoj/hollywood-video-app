import { mkdirSync, rmSync } from "node:fs";
import { gateOrThrow } from "../../safety/src/index";
import type { CostRecord, GenParams, ProviderAdapter, VideoClip } from "./index";

export interface FalModelSpec {
  endpoint: string;
  billedDurationsSec: readonly number[];
  aspectRatios: readonly string[];
  usdPerBilledSecond: number;
  supportsSeed: boolean;
  durationInput: (sec: number) => string;
  extraInput: Record<string, unknown>;
}

// Prices are fal.ai list prices on 2026-09-03 (Kling: $0.35 per 5 s plus $0.07
// per additional second; Veo 3 fast: $0.10 per second with audio off). Override
// with HV_FAL_USD_PER_BILLED_SECOND if the list price changes.
export const FAL_MODELS: Record<string, FalModelSpec> = {
  "kling-v2.5-turbo-pro": {
    endpoint: "fal-ai/kling-video/v2.5-turbo/pro/text-to-video",
    billedDurationsSec: [5, 10],
    aspectRatios: ["16:9", "9:16", "1:1"],
    usdPerBilledSecond: 0.07,
    supportsSeed: false,
    durationInput: (sec) => String(sec),
    extraInput: { negative_prompt: "blur, distort, low quality, text, watermark" },
  },
  "veo3-fast": {
    endpoint: "fal-ai/veo3/fast",
    billedDurationsSec: [4, 6, 8],
    aspectRatios: ["16:9", "9:16"],
    usdPerBilledSecond: 0.1,
    supportsSeed: true,
    durationInput: (sec) => `${sec}s`,
    extraInput: { generate_audio: false, resolution: "720p" },
  },
};
export const DEFAULT_FAL_MODEL = "kling-v2.5-turbo-pro";

export interface FalProviderOptions {
  apiKey?: string;
  model?: string;
  apiBase?: string;
  fetchImpl?: typeof fetch;
  pollMs?: number;
  maxWaitMs?: number;
  usdPerBilledSecond?: number;
}

export class FalProviderError extends Error {
  constructor(message: string, readonly requestId?: string) {
    super(message);
    this.name = "FalProviderError";
  }
}

export function pickBilledDuration(supported: readonly number[], requestedSec: number): number {
  const sorted = [...supported].sort((a, b) => a - b);
  return sorted.find((sec) => sec >= requestedSec) ?? sorted[sorted.length - 1]!;
}

export function pickAspectRatio(supported: readonly string[], width: number, height: number): string {
  const target = Math.log(width / height);
  let best = supported[0]!;
  let bestDelta = Number.POSITIVE_INFINITY;
  for (const ratio of supported) {
    const [w, h] = ratio.split(":").map(Number);
    const delta = Math.abs(Math.log(w! / h!) - target);
    if (delta < bestDelta) {
      best = ratio;
      bestDelta = delta;
    }
  }
  return best;
}

function parseSize(size: string): [number, number] {
  const match = /^(\d{2,5})x(\d{2,5})$/.exec(size);
  if (!match) throw new Error(`invalid clip size: ${size}`);
  return [Number(match[1]), Number(match[2])];
}

export function frameFingerprint(path: string, atSec: number): string {
  const probe = Bun.spawnSync([
    "ffmpeg", "-v", "error", "-ss", atSec.toFixed(3), "-i", path,
    "-frames:v", "1", "-vf", "scale=17:16:flags=area,format=gray", "-f", "rawvideo", "-",
  ], { env: { ...process.env } });
  if (probe.exitCode !== 0 || probe.stdout.length < 17 * 16) {
    throw new Error(`fingerprint failed: ${probe.stderr.toString().slice(-300)}`);
  }
  const px = probe.stdout;
  const bits = Buffer.alloc(32);
  for (let row = 0; row < 16; row += 1) {
    for (let col = 0; col < 16; col += 1) {
      const left = px[row * 17 + col]!;
      const right = px[row * 17 + col + 1]!;
      if (left > right) {
        const bit = row * 16 + col;
        bits[bit >> 3] = bits[bit >> 3]! | (0x80 >> (bit & 7));
      }
    }
  }
  return bits.toString("hex");
}

export class FalVideoProvider implements ProviderAdapter {
  readonly name = "fal";
  readonly model: string;
  readonly modelKey: string;
  private readonly spec: FalModelSpec;
  private readonly apiKey: string;
  private readonly apiBase: string;
  private readonly fetchImpl: typeof fetch;
  private readonly pollMs: number;
  private readonly maxWaitMs: number;
  private readonly usdPerBilledSecond: number;

  constructor(opts: FalProviderOptions = {}) {
    this.modelKey = opts.model ?? DEFAULT_FAL_MODEL;
    const spec = FAL_MODELS[this.modelKey];
    if (!spec) throw new Error(`unknown fal model "${this.modelKey}"; known: ${Object.keys(FAL_MODELS).join(", ")}`);
    this.spec = spec;
    this.model = spec.endpoint;
    const apiKey = opts.apiKey ?? process.env.FAL_KEY;
    if (!apiKey) throw new Error("FAL_KEY is not set; the fal provider cannot start");
    this.apiKey = apiKey;
    this.apiBase = (opts.apiBase ?? "https://queue.fal.run").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pollMs = opts.pollMs ?? 2000;
    this.maxWaitMs = opts.maxWaitMs ?? 240_000;
    this.usdPerBilledSecond = opts.usdPerBilledSecond ?? spec.usdPerBilledSecond;
  }

  async generate(prompt: string, seed: number, params: GenParams, outPath: string): Promise<VideoClip> {
    gateOrThrow(prompt);
    const requestedSec = params.durationSec ?? 1;
    const fps = params.fps ?? 30;
    const [width, height] = parseSize(params.widthxheight ?? "1920x1080");
    const billedSec = pickBilledDuration(this.spec.billedDurationsSec, requestedSec);
    const input: Record<string, unknown> = {
      prompt,
      duration: this.spec.durationInput(billedSec),
      aspect_ratio: pickAspectRatio(this.spec.aspectRatios, width, height),
      ...this.spec.extraInput,
    };
    if (this.spec.supportsSeed) input.seed = seed;

    const submitted = await this.call(`${this.apiBase}/${this.spec.endpoint}`, params.signal, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }) as { request_id?: string; status_url?: string; response_url?: string };
    const requestId = submitted.request_id;
    if (!requestId) throw new FalProviderError("fal submit returned no request_id");
    const requestBase = `${this.apiBase}/${this.spec.endpoint}/requests/${requestId}`;
    const statusUrl = submitted.status_url ?? `${requestBase}/status`;
    const responseUrl = submitted.response_url ?? requestBase;

    const started = Date.now();
    for (;;) {
      if (params.signal?.aborted) {
        await this.cancel(requestBase);
        throw new FalProviderError("fal request aborted", requestId);
      }
      const status = await this.call(statusUrl, params.signal) as { status?: string; error?: unknown };
      if (status.status === "COMPLETED") break;
      if (status.status === "FAILED") {
        throw new FalProviderError(`fal generation failed: ${JSON.stringify(status.error ?? status).slice(0, 400)}`, requestId);
      }
      if (Date.now() - started > this.maxWaitMs) {
        await this.cancel(requestBase);
        throw new FalProviderError(`fal request exceeded ${Math.round(this.maxWaitMs / 1000)}s`, requestId);
      }
      await Bun.sleep(this.pollMs);
    }

    const result = await this.call(responseUrl, params.signal) as { video?: { url?: string }; video_url?: string };
    const videoUrl = result.video?.url ?? result.video_url;
    if (!videoUrl) throw new FalProviderError("fal result carried no video url", requestId);

    mkdirSync(outPath.slice(0, outPath.lastIndexOf("/")), { recursive: true });
    const rawPath = `${outPath}.raw.mp4`;
    const download = await this.fetchImpl(videoUrl, { signal: params.signal });
    if (!download.ok) throw new FalProviderError(`fal clip download failed (${download.status})`, requestId);
    await Bun.write(rawPath, download);
    try {
      normalizeClip(rawPath, outPath, { width, height, fps, durationSec: requestedSec });
    } finally {
      rmSync(rawPath, { force: true });
    }

    const cost: CostRecord = {
      provider: this.name,
      model: this.model,
      prompt_tokens: Math.ceil(prompt.length / 4),
      output_frames: Math.round(fps * requestedSec),
      gpu_seconds: billedSec,
      total_cost_usd: Number((billedSec * this.usdPerBilledSecond).toFixed(4)),
    };
    return {
      path: outPath,
      provider: this.name,
      model: this.model,
      seed,
      durationSec: requestedSec,
      fingerprint: frameFingerprint(outPath, requestedSec / 2),
      cost,
    };
  }

  private async call(url: string, signal: AbortSignal | undefined, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchImpl(url, {
      ...init,
      signal,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Key ${this.apiKey}` },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new FalProviderError(`fal ${init.method ?? "GET"} ${url.replace(this.apiBase, "")} failed (${response.status}): ${body.slice(0, 300)}`);
    }
    return response.json();
  }

  private async cancel(requestBase: string): Promise<void> {
    try {
      await this.fetchImpl(`${requestBase}/cancel`, { method: "PUT", headers: { authorization: `Key ${this.apiKey}` } });
    } catch {
      // Best effort: a request that already left the queue cannot be cancelled.
    }
  }
}

export function normalizeClip(
  rawPath: string,
  outPath: string,
  target: { width: number; height: number; fps: number; durationSec: number },
): void {
  const filter = [
    `scale=${target.width}:${target.height}:force_original_aspect_ratio=decrease`,
    `pad=${target.width}:${target.height}:(ow-iw)/2:(oh-ih)/2`,
    `fps=${target.fps}`,
    `tpad=stop_mode=clone:stop_duration=${target.durationSec}`,
  ].join(",");
  const proc = Bun.spawnSync([
    "ffmpeg", "-y", "-v", "error", "-i", rawPath,
    "-t", target.durationSec.toFixed(3), "-an", "-vf", filter,
    "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
    "-fflags", "+bitexact", "-flags:v", "+bitexact", "-map_metadata", "-1",
    outPath,
  ], { env: { ...process.env } });
  if (proc.exitCode !== 0) throw new Error(`ffmpeg normalize failed: ${proc.stderr.toString().slice(-400)}`);
}
