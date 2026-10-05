import {AnchorStoryboardProvider} from "./anchor-storyboard";
import type { FrameParams } from "./image";
import {framingSettings,isCropped,type ShotFraming} from "../../planner/src/framing";
import {assertCameraPathContext,type CameraCropReason,type NativeCameraMove,type ShotCameraPath} from "../../planner/src/camera-path";
import {frameClip,FramingError} from "./framing";
import {PerformanceError} from "../../planner/src/performances";
import {FrameAnchorError} from "./frame-anchor-media";
export interface FrameAnchorInput {frames:{at:number;image:string}[];mode:"native"|"storyboard"|"prefer-native"}
import { baseCapability, cameraControlPlan, capability, matchCapability,videoRequirements,MAX_CONDITIONING_INPUTS,REFERENCES_RECORDED_NOT_RENDERED,type CapabilitySnapshot, type ShotRequirements } from "./capabilities";
import { recordReferences } from "./image";
import { RichAnimaticProvider } from "./animatic";
import { resolveImageProvider } from "./fal-image";
import type { CameraMove } from "./animatic";
export { RichAnimaticProvider } from "./animatic";
export type { CameraMove } from "./animatic";
export { FalImageProvider, FAL_IMAGE_MODELS, DEFAULT_FAL_IMAGE_MODEL, resolveImageProvider } from "./fal-image";
export type { FalImageOptions } from "./fal-image";
export { DeterministicMockImageProvider } from "./image";
export type { FrameParams, IdentityConditioning, ImageProvider, ReferenceRecord, StillFrame } from "./image";
import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { gateOrThrow } from "../../safety/src/index";
import { DEFAULT_FAL_MODEL, FAL_MODELS, FalVideoProvider, falCataloguePromptLimit } from "./fal";
import { PromptLengthError } from "./prompt-limits";
export { PromptLengthError } from "./prompt-limits";
import { specNamesPaidFamily } from "./registry";

export { DEFAULT_FAL_MAX_WAIT_MS, DEFAULT_FAL_MODEL, FAL_MODELS, FalProviderError, FalVideoProvider, frameFingerprint, normalizeClip, pickAspectRatio, pickBilledDuration } from "./fal";
export type { FalModelSpec, FalProviderOptions } from "./fal";

export interface ProviderAttemptHooks {onProviderRequest?: FrameParams["onProviderRequest"]}
export interface GenParams extends FrameParams { beforeAttempt?: (provider: ProviderAdapter) => void | ProviderAttemptHooks | Promise<void | ProviderAttemptHooks>; onAttemptCost?: (cost: CostRecord) => void | Promise<void>; afterAttempt?: (outcome: { costs: CostRecord[]; error?: unknown; accountingError?: unknown; dispatched: boolean }) => void | Promise<void>; dialogue?: { character: string; lines: string[] }[]; cameraMove?: CameraMove; widthxheight?: string; fps?: number; durationSec?: number; seed: number; signal?: AbortSignal;
  routingRequirements?: Partial<Pick<ShotRequirements, "audio" | "deterministic" | "nativeResolution" | "allowSynthetic" | "region">>;
  performances?:import("../../planner/src/performances").PerformanceLine[];
  exactDuration?: boolean;
  framing?:ShotFraming;
  cameraPath?:ShotCameraPath;
  frameAnchors?:FrameAnchorInput;
}
export interface VideoClip {
  /** HV-019-16: the reference images the adapter recorded without rendering from them (the mock); absent from a vendor's clip. */
  referenceRecord?:import("./image").ReferenceRecord;
  picturePerformance?:import("../../planner/src/picture-performance").PicturePerformance;
  audioPath?:string;
  speech?:import("../../planner/src/performances").SpeechReport;
  renderRecord?:import("../../planner/src/shot-reuse").ShotRenderRecord;
  frameAnchorControl?:{mode:"native"|"storyboard";positions:number[];timing?:{sourceFrames:number;outputFrames:number}};
  sourcePosterPath?:string;framing?:ShotFraming;
  /** `applied` (HV-020-01): the provider's own camera control (`moves`) or a local crop (`reason`). Absent on reports written before it, which were all local crops. */
  cameraPathControl?:{mode:"screen-space";keyframes:ShotCameraPath["keyframes"];outputFrames:number;applied?:"native"|"local-crop";moves?:NativeCameraMove[];reason?:CameraCropReason};
  posterPath?: string;
  audioMode?: "provided" | "silent-captioned";
  path: string;
  provider: string;
  model: string;
  seed: number;
  durationSec: number;
  fingerprint: string;
  cost: CostRecord;
  routing?: import("./router").RenderRoute;
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
  readonly capabilities?: CapabilitySnapshot;
  generate(prompt: string, seed: number, params: GenParams, outPath: string): Promise<VideoClip>;
}

export class DeterministicMockProvider implements ProviderAdapter {
  readonly name = "mock";
  readonly model = "mock-deterministic-v1";
  constructor(private opts: { failEvery?: number; costPerShotUsd?: number } = {}) {}
  private calls = 0;
  get capabilities(): CapabilitySnapshot {return mockVideoCapability(this.opts.costPerShotUsd ?? 0);}

  async generate(prompt: string, seed: number, params: GenParams, outPath: string): Promise<VideoClip> {
    gateOrThrow(prompt);
    // HV-019-16: references are recorded, never rendered from; an identity embedding is still refused.
    if (params.identityLocks?.length) throw new Error("Mock video identity conditioning is not implemented.");
    // HV-019-19: the mock stands in for the live fal video models, so it takes no longer a prompt than they do.
    const limit = mockVideoPromptLimit(params.referenceFrames?.length ?? 0);
    if (limit !== null && prompt.length > limit) throw new PromptLengthError("This shot's prompt is " + prompt.length + " characters; the mock, standing in for the live video models, takes at most " + limit + ". Nothing was rendered.");
    const referenceRecord = params.referenceFrames?.length ? recordReferences(params.referenceFrames) : undefined;
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
    ], { env: { ...process.env }, timeout: 60_000 });
    // HV-019-09: the third unbounded synchronous ffmpeg call. Its input is generated rather than a
    // vendor's, so this is consistency rather than exposure -- and a mock that can hang forever is
    // still a worker that can hang forever.
    if (proc.signalCode) throw new Error("ffmpeg exceeded 60s");
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
    return { ...(referenceRecord ? {referenceRecord} : {}), path: outPath, provider: this.name, model: this.model, seed, durationSec: dur, fingerprint: h.toString("hex"), cost };
  }
}

/**
 * HV-019-19. The most characters the mock video adapter takes for a shot with `references` images: the
 * strictest live fal video model's limit, less the reference note a reference model appends
 * (`falCataloguePromptLimit`). A $0 rehearsal on the mock then fits and refuses prompts as the live pool would.
 */
export function mockVideoPromptLimit(references: number): number | null {
  return falCataloguePromptLimit(references);
}

export function mockVideoCapability(costPerShotUsd = 0): CapabilitySnapshot {
  const definition = baseCapability("mock", "mock-deterministic-v1", "video");
  definition.synthetic = true; definition.region = "local"; definition.cancellation = "none"; definition.determinism = "local-bitexact";
  definition.output.nativeResolution = "requested";
  // HV-019-16: accepts any reference set a shot can carry and records it; the picture is not rendered from it.
  definition.input.referenceFrames = MAX_CONDITIONING_INPUTS; definition.referenceUse = REFERENCES_RECORDED_NOT_RENDERED;
  if (costPerShotUsd !== 0) definition.price = {...definition.price, unit: "request", usd: costPerShotUsd};
  return capability(definition);
}

/**
 * Costs a provider incurred without delivering a usable clip: a paid request abandoned after it
 * started rendering, a render the vendor billed whose local half then failed, or a repair attempt
 * whose clip was discarded.
 *
 * **One path charges them.** `attempt` below reads them off a thrown failure into `costs` and
 * drains that through `onAttemptCost`, which is `chargeCost` in the worker. The `sunkCosts` that
 * `attempt` then re-attaches to the error, and the `sunkCosts` field on
 * `FailoverGenerator.generate`'s result, are for a caller that wants to say what was spent -- and
 * nothing in `packages/queue`, `packages/api` or `packages/storage` reads either one.
 *
 * HV-019-09: that is worth saying out loud rather than leaving the older wording, which read as
 * though both were charged. They are the same records, already drained: anything that charged them
 * a second time would double-bill every discarded attempt and every repair
 * (`repairLoop` pushes `clip.cost` after `attempt` has charged it).
 */
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
  /** The router selects candidates; this retains the single accounting/cancellation implementation. */
  generateAttempt(provider: ProviderAdapter, prompt: string, seed: number, params: GenParams, outPath: string): Promise<VideoClip> {
    return this.attempt(provider, prompt, seed, params, outPath);
  }
  async generate(prompt: string, seed: number, params: GenParams, outPath: string): Promise<VideoClip & { failedOver: boolean; sunkCosts: CostRecord[] }> {
    gateOrThrow(prompt);
    try {
      const clip = await this.attempt(this.primary, prompt, seed, params, outPath);
      return { ...clip, failedOver: false, sunkCosts: [] };
    } catch (err) {
      if (params.signal?.aborted) throw withSunkCosts(params.signal.reason, sunkCostsOf(err));
      if (["SafetyRefusal", "BudgetError", "LeaseError", "ShotDurationError", "FramingError","FrameAnchorError","PerformanceError","PromptLengthError"].includes((err as Error).name)) throw err;
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
    params.signal?.throwIfAborted();
    if(params.performances?.length&&(!provider.capabilities||!matchCapability(provider.capabilities,videoRequirements(params),1e6).eligible))throw new PerformanceError("This provider cannot execute the saved voices and line performances. Choose a speech-enabled storyboard provider.");
    if(params.frameAnchors){try{if(!provider.capabilities||!matchCapability(provider.capabilities,videoRequirements(params),1e6).eligible)throw new Error("This provider cannot satisfy the frame anchor requirements.");}catch(error){throw new FrameAnchorError((error as Error).message);}}
    if(params.cameraPath!==undefined){try{assertCameraPathContext(params);}catch(error){throw new FramingError((error as Error).message);}}
    if(params.framing){try{framingSettings(params.framing);if(isCropped(params.framing)&&params.routingRequirements?.nativeResolution)throw new Error("A digital crop is incompatible with a native-resolution requirement.");}catch(error){throw new FramingError((error as Error).message);}}
    const hooks = await params.beforeAttempt?.(provider);
    const controller = new AbortController();
    const abort = () => controller.abort(params.signal?.reason);
    params.signal?.addEventListener("abort", abort, { once: true });
    let clip: VideoClip | undefined, error: unknown, accountingError: unknown;
    let dispatched = false;
    let costs: CostRecord[] = [];
    try {
      params.signal?.throwIfAborted();
      dispatched = true;
      clip = await withTimeout(provider.generate(prompt, seed, { ...params, onProviderRequest: hooks?.onProviderRequest ?? params.onProviderRequest, signal: controller.signal }, outPath), this.timeoutMs, controller);
      costs = [...sunkCostsOf(clip), clip.cost];
      if((params.framing||params.cameraPath)&&!(provider instanceof RichAnimaticProvider)&&!(provider instanceof AnchorStoryboardProvider)){
        // HV-020-01: a move the provider declares and reports as sent is not cropped again; anything else is framed here, with why.
        const camera=params.cameraPath===undefined?undefined:cameraControlPlan(provider.capabilities,params.cameraPath),reported=clip.cameraPathControl?.applied==="native";
        if(camera&&(camera.applied==="native")!==reported)throw new FramingError(reported?"The provider reported a native camera move its capability does not declare.":"The provider did not confirm the native camera move it declares. The paid request will not be repeated automatically.");
        if(camera?.applied!=="native")clip=await frameClip(clip,params.framing??{x:0,y:0,size:10000},params.widthxheight??"1920x1080",params.fps??30,params.signal,params.cameraPath,camera?.reason);
      }
    } catch (failure) {
      error = failure;
      costs = clip ? [...sunkCostsOf(clip),clip.cost] : sunkCostsOf(failure);
    } finally {
      params.signal?.removeEventListener("abort", abort);
    }
    // Drain every cost, including discarded attempts, before reporting an accounting error.
    for (const cost of costs) {
      try { await params.onAttemptCost?.(cost); } catch (failure) { accountingError ??= failure; }
    }
    try { await params.afterAttempt?.({costs, error, accountingError, dispatched}); }
    catch (failure) {
      if (["BudgetError", "LeaseError", "SafetyRefusal"].includes((failure as Error).name)) throw withSunkCosts(failure, costs);
      accountingError ??= failure;
    }
    if (accountingError) throw Object.assign(new Error("Cost accounting is temporarily unavailable; generation is paused.", {cause: accountingError}),
      {name: "BudgetError", sunkCosts: costs});
    if (params.signal?.aborted) throw withSunkCosts(params.signal.reason, costs);
    if (error) throw clip ? withSunkCosts(error,costs) : error;
    return clip!;
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
  if(spec.startsWith("image:"))return resolveAnimaticProvider(spec,env);
  if(spec==="anchor-storyboard")return new AnchorStoryboardProvider({narration:env.HV_NARRATION==="1",captions:env.HV_ANIMATIC_CAPTIONS==="1"});
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

/**
 * Whether a spec names a paid vendor family. Derived from the registry's paid
 * entries rather than being a fourth hand-written switch over the same grammar.
 * An unregistered model key inside a paid family still answers true.
 *
 * No production code calls this: admission reserves on the admitted snapshot's
 * price unit, not on the spec string. It is kept because it is exported and
 * covered by tests, and deleting it would put a test file in the diff for no
 * gain — see the note on specNamesPaidFamily.
 */
export function providerUsesPaidInference(spec: ProviderSpec): boolean {
  return specNamesPaidFamily(spec);
}

export interface ContinuityResult { shotId: string; score: number; passed: boolean }
const CONTINUITY_THRESHOLD = 0.35;

export type ContinuityClip = Pick<VideoClip,"fingerprint">;
export function continuityScore(prev: ContinuityClip | null, cur: ContinuityClip): number {
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

export function checkContinuity(shotId: string, prev: ContinuityClip | null, cur: ContinuityClip, threshold = CONTINUITY_THRESHOLD): ContinuityResult {
  const score = continuityScore(prev, cur);
  return { shotId, score, passed: score >= threshold };
}

export interface RepairOutcome { shotId: string; attempts: number; status: "ok" | "degraded"; note?: string; flaggedForReview: boolean }

export async function repairLoop(
  shotId: string,
  prev: ContinuityClip | null,
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
  if(spec==="anchor-storyboard")return new AnchorStoryboardProvider({narration:env.HV_NARRATION==="1",captions:env.HV_ANIMATIC_CAPTIONS==="1"});
  if (spec === "legacy-mock") return new DeterministicMockProvider();
  return new RichAnimaticProvider(resolveImageProvider(spec, env), {
    narration: env.HV_NARRATION === "1", captions: env.HV_ANIMATIC_CAPTIONS === "1",
  });
}
