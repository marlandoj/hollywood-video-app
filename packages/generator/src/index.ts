import type { FrameParams } from "./image";
import { RichAnimaticProvider } from "./animatic";
import { resolveImageProvider } from "./fal-image";
import type { CameraMove } from "./animatic";
export { RichAnimaticProvider } from "./animatic";
export type { CameraMove } from "./animatic";
export { FalImageProvider, FAL_IMAGE_MODELS, DEFAULT_FAL_IMAGE_MODEL, resolveImageProvider } from "./fal-image";
export type { FalImageOptions } from "./fal-image";
export { DeterministicMockImageProvider } from "./image";
export type { FrameParams, IdentityConditioning, ImageProvider, StillFrame } from "./image";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { gateOrThrow } from "../../safety/src/index";
import { DEFAULT_FAL_MODEL, FAL_MODELS, FalVideoProvider } from "./fal";

export { DEFAULT_FAL_MAX_WAIT_MS, DEFAULT_FAL_MODEL, FAL_MODELS, FalProviderError, FalVideoProvider, frameFingerprint, normalizeClip, pickAspectRatio, pickBilledDuration } from "./fal";
export type { FalModelSpec, FalProviderOptions } from "./fal";

export interface GenParams extends FrameParams { beforeAttempt?: (provider: ProviderAdapter) => void; onAttemptCost?: (cost: CostRecord) => void; dialogue?: { character: string; lines: string[] }[]; cameraMove?: CameraMove; widthxheight?: string; fps?: number; durationSec?: number; seed: number; signal?: AbortSignal }
export interface VideoClip {
  posterPath?: string;
  audioMode?: "provided" | "silent-captioned";
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

// Costs a provider incurred without delivering a usable clip: a paid request
// that was abandoned after it started rendering, or a repair attempt whose
// clip was discarded. They are carried on results and on thrown errors so the
// worker can charge them to the job like any other shot cost.
export function sunkCostsOf(value: unknown): CostRecord[] {
  if (!value || typeof value !== "object") return [];
  const { sunkCost, sunkCosts } = value as { sunkCost?: CostRecord; sunkCosts?: CostRecord[] };
  return [...(Array.isArray(sunkCosts) ? sunkCosts : []), ...(sunkCost ? [sunkCost] : [])];
}

function withSunkCosts(err: unknown, sunkCosts: CostRecord[]): Error {
  const error = err instanceof Error ? err : new Error(String(err));
  return Object.assign(error, { sunkCosts: [...sunkCosts, ...sunkCostsOf(err)] });
}

export class FailoverGenerator {
  constructor(private primary: ProviderAdapter, private secondary: ProviderAdapter, private timeoutMs = 30_000) {}
  async generate(prompt: string, seed: number, params: GenParams, outPath: string): Promise<VideoClip & { failedOver: boolean; sunkCosts: CostRecord[] }> {
    gateOrThrow(prompt);
    try {
      const clip = await this.attempt(this.primary, prompt, seed, params, outPath);
      return { ...clip, failedOver: false, sunkCosts: [] };
    } catch (err) {
      if (["SafetyRefusal", "BudgetError", "LeaseError"].includes((err as Error).name)) throw err;
      const sunkCosts = sunkCostsOf(err);
      try {
        const clip = await this.attempt(this.secondary, prompt, seed, params, outPath);
        return { ...clip, failedOver: true, sunkCosts };
      } catch (second) {
        throw withSunkCosts(second, sunkCosts);
      }
    }
  }

  // Each attempt gets its own abort signal so a provider that is still polling
  // or downloading stops (and cancels its remote request) when it times out
  // instead of finishing, and billing, in the background after failover.
  private async attempt(provider: ProviderAdapter, prompt: string, seed: number, params: GenParams, outPath: string): Promise<VideoClip> {
    params.beforeAttempt?.(provider);
    const controller = new AbortController();
    let clip: VideoClip;
    try {
      clip = await withTimeout(provider.generate(prompt, seed, { ...params, signal: controller.signal }, outPath), this.timeoutMs, controller);
    } catch (error) {
      for (const cost of sunkCostsOf(error)) params.onAttemptCost?.(cost);
      throw error;
    }
    for (const cost of [...sunkCostsOf(clip), clip.cost]) params.onAttemptCost?.(cost);
    return clip;
  }
}

// After the abort the provider gets a short grace period to cancel remotely
// and report whether the abandoned request still bills, so the timeout error
// carries that sunk cost instead of losing it.
const CANCEL_GRACE_MS = 15_000;

function withTimeout<T>(p: Promise<T>, ms: number, controller: AbortController): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      const settled = Promise.race([p.then(() => undefined, (err: unknown) => err), Bun.sleep(CANCEL_GRACE_MS)]);
      void settled.then((outcome) => reject(withSunkCosts(new Error("provider timeout"), sunkCostsOf(outcome))));
    }, ms);
    p.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (err: unknown) => { clearTimeout(timer); reject(err); },
    );
  });
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
  const value = spec.trim();
  return value === "fal" || value.startsWith("fal:") || value === "image:fal" || value.startsWith("image:fal:");
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
): Promise<{ clip: VideoClip; outcome: RepairOutcome; sunkCosts: CostRecord[] }> {
  // Every attempt is paid for on a real provider, including the ones whose
  // clips are discarded by a repair, so their costs travel with the result.
  const sunkCosts: CostRecord[] = [];
  const attemptOnce = async (attempt: number): Promise<VideoClip> => {
    try {
      const clip = await gen(attempt);
      sunkCosts.push(...sunkCostsOf(clip));
      return clip;
    } catch (err) {
      throw withSunkCosts(err, sunkCosts);
    }
  };
  let clip = await attemptOnce(0);
  let check = checkContinuity(shotId, prev, clip, threshold);
  let attempts = 0;
  while (!check.passed && attempts < 2) {
    attempts += 1;
    sunkCosts.push(clip.cost);
    clip = await attemptOnce(attempts);
    check = checkContinuity(shotId, prev, clip, threshold);
  }
  if (!check.passed) {
    reviewQueue.push({ shotId, score: check.score });
    return {
      clip,
      outcome: { shotId, attempts, status: "degraded", note: `continuity ${check.score.toFixed(3)} below threshold after ${attempts} repairs`, flaggedForReview: true },
      sunkCosts,
    };
  }
  if (attempts > 0) reviewQueue.push({ shotId, score: check.score });
  return { clip, outcome: { shotId, attempts, status: "ok", flaggedForReview: attempts > 0 }, sunkCosts };
}

export function resolveAnimaticProvider(spec: string, env: Record<string, string | undefined> = process.env): ProviderAdapter {
  if (spec === "legacy-mock") return new DeterministicMockProvider();
  return new RichAnimaticProvider(resolveImageProvider(spec, env), {
    narration: env.HV_NARRATION === "1", captions: env.HV_ANIMATIC_CAPTIONS === "1",
  });
}
