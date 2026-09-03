import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { gateOrThrow } from "../../safety/src/index";
import { DEFAULT_FAL_MODEL, FAL_MODELS, FalVideoProvider } from "./fal";

export { DEFAULT_FAL_MODEL, FAL_MODELS, FalProviderError, FalVideoProvider, frameFingerprint, normalizeClip, pickAspectRatio, pickBilledDuration } from "./fal";
export type { FalModelSpec, FalProviderOptions } from "./fal";

export interface GenParams { widthxheight?: string; fps?: number; durationSec?: number; seed: number; signal?: AbortSignal }
export interface VideoClip {
  path: string;
  provider: string;
  model: string;
  seed: number;
  durationSec: number;
  fingerprint: string;
  cost: CostRecord;
}
export interface CostRecord {
  provider: string;
  model: string;
  prompt_tokens: number;
  output_frames: number;
  gpu_seconds: number;
  total_cost_usd: number;
}

export interface ProviderAdapter {
  readonly name: string;
  readonly model: string;
  generate(prompt: string, seed: number, params: GenParams, outPath: string): Promise<VideoClip>;
}

export class DeterministicMockProvider implements ProviderAdapter {
  readonly name = "mock";
  readonly model = "mock-deterministic-v1";
  constructor(private opts: { failEvery?: number; costPerShotUsd?: number } = {}) {}
  private calls = 0;

  async generate(prompt: string, seed: number, params: GenParams, outPath: string): Promise<VideoClip> {
    gateOrThrow(prompt);
    this.calls += 1;
    if (this.opts.failEvery && this.calls % this.opts.failEvery === 0) {
      throw new Error("mock provider transient failure");
    }
    const size = params.widthxheight ?? "1920x1080";
    const fps = params.fps ?? 30;
    const dur = params.durationSec ?? 1;
    const h = createHash("sha256").update(`${prompt}|${seed}|${this.model}`).digest();
    const color = `0x${h.subarray(0, 3).toString("hex")}`;
    mkdirSync(outPath.slice(0, outPath.lastIndexOf("/")), { recursive: true });
    const proc = Bun.spawnSync([
      "ffmpeg", "-y", "-f", "lavfi",
      "-i", `color=c=${color}:s=${size}:r=${fps}:d=${dur}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
      "-fflags", "+bitexact", "-flags:v", "+bitexact", "-map_metadata", "-1",
      outPath,
    ], { env: { ...process.env } });
    if (proc.exitCode !== 0) throw new Error(`ffmpeg failed: ${proc.stderr.toString().slice(-400)}`);
    const frames = fps * dur;
    const cost: CostRecord = {
      provider: this.name,
      model: this.model,
      prompt_tokens: Math.ceil(prompt.length / 4),
      output_frames: frames,
      gpu_seconds: dur * 0.5,
      total_cost_usd: this.opts.costPerShotUsd ?? 0,
    };
    return { path: outPath, provider: this.name, model: this.model, seed, durationSec: dur, fingerprint: h.toString("hex"), cost };
  }
}

export class FailoverGenerator {
  constructor(private primary: ProviderAdapter, private secondary: ProviderAdapter, private timeoutMs = 30_000) {}
  async generate(prompt: string, seed: number, params: GenParams, outPath: string): Promise<VideoClip & { failedOver: boolean }> {
    gateOrThrow(prompt);
    try {
      const clip = await this.attempt(this.primary, prompt, seed, params, outPath);
      return { ...clip, failedOver: false };
    } catch (err) {
      if ((err as Error).name === "SafetyRefusal") throw err;
      const clip = await this.attempt(this.secondary, prompt, seed, params, outPath);
      return { ...clip, failedOver: true };
    }
  }

  // Each attempt gets its own abort signal so a provider that is still polling
  // or downloading stops (and cancels its remote request) when it times out
  // instead of finishing, and billing, in the background after failover.
  private attempt(provider: ProviderAdapter, prompt: string, seed: number, params: GenParams, outPath: string): Promise<VideoClip> {
    const controller = new AbortController();
    return withTimeout(provider.generate(prompt, seed, { ...params, signal: controller.signal }, outPath), this.timeoutMs, controller);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((_, rej) => {
    timer = setTimeout(() => {
      controller.abort();
      rej(new Error("provider timeout"));
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export type ProviderSpec = string;

// Resolves the HV_PROVIDER_* strings: "mock", "fal" (default fal model), or
// "fal:<model key>" for any entry in FAL_MODELS.
export function resolveProvider(spec: ProviderSpec, env: Record<string, string | undefined> = process.env): ProviderAdapter {
  const trimmed = spec.trim();
  if (trimmed === "" || trimmed === "mock") return new DeterministicMockProvider();
  if (trimmed === "fal" || trimmed.startsWith("fal:")) {
    const model = trimmed === "fal" ? DEFAULT_FAL_MODEL : trimmed.slice(4);
    if (!FAL_MODELS[model]) throw new Error(`unknown fal model "${model}"; known: ${Object.keys(FAL_MODELS).join(", ")}`);
    const override = env.HV_FAL_USD_PER_BILLED_SECOND;
    return new FalVideoProvider({
      model,
      apiKey: env.FAL_KEY ?? "",
      maxWaitMs: env.HV_FAL_MAX_WAIT_MS ? Number(env.HV_FAL_MAX_WAIT_MS) : undefined,
      usdPerBilledSecond: override ? Number(override) : undefined,
    });
  }
  throw new Error(`unknown provider "${spec}"; use mock, fal, or fal:<model>`);
}

export function providerUsesPaidInference(spec: ProviderSpec): boolean {
  return spec.trim().startsWith("fal");
}

export interface ContinuityResult { shotId: string; score: number; passed: boolean }
const CONTINUITY_THRESHOLD = 0.35;

export function continuityScore(prev: VideoClip | null, cur: VideoClip): number {
  if (!prev) return 1;
  const a = Buffer.from(prev.fingerprint, "hex");
  const b = Buffer.from(cur.fingerprint, "hex");
  let same = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    same += 8 - popcount(a[i] ^ b[i]);
  }
  return same / (Math.min(a.length, b.length) * 8);
}

function popcount(x: number): number { let c = 0; while (x) { c += x & 1; x >>= 1; } return c; }

export function checkContinuity(shotId: string, prev: VideoClip | null, cur: VideoClip, threshold = CONTINUITY_THRESHOLD): ContinuityResult {
  const score = continuityScore(prev, cur);
  return { shotId, score, passed: score >= threshold };
}

export interface RepairOutcome { shotId: string; attempts: number; status: "ok" | "degraded"; note?: string; flaggedForReview: boolean }

export async function repairLoop(
  shotId: string,
  prev: VideoClip | null,
  gen: (attempt: number) => Promise<VideoClip>,
  reviewQueue: { shotId: string; score: number }[],
  threshold = CONTINUITY_THRESHOLD,
): Promise<{ clip: VideoClip; outcome: RepairOutcome }> {
  let clip = await gen(0);
  let check = checkContinuity(shotId, prev, clip, threshold);
  let attempts = 0;
  while (!check.passed && attempts < 2) {
    attempts += 1;
    clip = await gen(attempts);
    check = checkContinuity(shotId, prev, clip, threshold);
  }
  if (!check.passed) {
    reviewQueue.push({ shotId, score: check.score });
    return {
      clip,
      outcome: { shotId, attempts, status: "degraded", note: `continuity ${check.score.toFixed(3)} below threshold after ${attempts} repairs`, flaggedForReview: true },
    };
  }
  if (attempts > 0) reviewQueue.push({ shotId, score: check.score });
  return { clip, outcome: { shotId, attempts, status: "ok", flaggedForReview: attempts > 0 } };
}
