import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { gateOrThrow } from "../../safety/src/index";

export interface GenParams { widthxheight?: string; fps?: number; durationSec?: number; seed: number }
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
      const clip = await withTimeout(this.primary.generate(prompt, seed, params, outPath), this.timeoutMs);
      return { ...clip, failedOver: false };
    } catch (err) {
      if ((err as Error).name === "SafetyRefusal") throw err;
      const clip = await withTimeout(this.secondary.generate(prompt, seed, params, outPath), this.timeoutMs);
      return { ...clip, failedOver: true };
    }
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error("provider timeout")), ms))]);
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
