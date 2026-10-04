import { mkdirSync, rmSync } from "node:fs";
import { trustedQueueUrl } from "./receipts";
import { gateOrThrow } from "../../safety/src/index";
import type { CostRecord, GenParams, ProviderAdapter, VideoClip } from "./index";
import { baseCapability, cameraControlPlan, capability, type CapabilitySnapshot } from "./capabilities";
import { cameraPathSettings, type NativeCameraMove } from "../../planner/src/camera-path";
import { privatePngReferences } from "./image";
import {FrameAnchorError,normalizeAnchoredClip} from "./frame-anchor-media";

export interface FalModelSpec {
  endpoint: string;
  billedDurationsSec: readonly number[];
  aspectRatios: readonly string[];
  usdPerBilledSecond: number;
  supportsSeed: boolean;
  durationInput: (sec: number) => string;
  extraInput: Record<string, unknown>;
  frameAnchors?:true;
  /**
   * HV-020-01. The vendor's own camera-control input: which moves it takes and the request fields
   * that ask for them. Set only from a vendor schema the repository cites. None of the models below
   * has one -- REFERENCE-PROVIDERS.md and CAMERA-PATHS.md document no camera-control input for
   * Kling 2.5 Turbo Pro or Kling O3 -- so each is `camera: none` and a camera path stays a local crop.
   */
  cameraControl?:{moves:readonly NativeCameraMove[];input:(moves:readonly NativeCameraMove[])=>Record<string,unknown>};
}

// Prices are fal.ai list prices on 2026-09-03 (Kling: $0.35 per 5 s plus $0.07
// per additional second; Veo 3 fast: $0.10 per second with audio off). Override
// with HV_FAL_USD_PER_BILLED_SECOND if the list price changes.
export const FAL_MODELS: Record<string, FalModelSpec> = {
  // Opt-in adapter variant keeps previously admitted reference-only capability hashes unchanged.
  "kling-o3-standard-keyframes": {
    endpoint:"fal-ai/kling-video/o3/standard/reference-to-video",
    billedDurationsSec:[3,4,5,6,7,8,9,10,11,12,13,14,15],aspectRatios:["16:9","9:16","1:1"],
    usdPerBilledSecond:0.084,supportsSeed:false,durationInput:sec=>String(sec),extraInput:{generate_audio:false},frameAnchors:true,
  },
  // Vendor schema and audio-off list rate checked on 2026-09-06.
  "kling-o3-standard-reference": {
    endpoint:"fal-ai/kling-video/o3/standard/reference-to-video",
    billedDurationsSec:[3,4,5,6,7,8,9,10,11,12,13,14,15],aspectRatios:["16:9","9:16","1:1"],
    usdPerBilledSecond:0.084,supportsSeed:false,durationInput:sec=>String(sec),extraInput:{generate_audio:false},
  },
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
export function falVideoCapability(modelKey = DEFAULT_FAL_MODEL, usdPerBilledSecond?: number): CapabilitySnapshot {
  const spec = Object.hasOwn(FAL_MODELS, modelKey) ? FAL_MODELS[modelKey] : undefined;
  if (!spec) throw new Error("Unknown video provider configuration.");
  const definition = baseCapability("fal", spec.endpoint, "video");
  // The vendor API documentation marked this endpoint unsupported when checked on 2026-09-06.
  // Keep its adapter for historical receipts and contract fixtures; the router must never dispatch it.
  if (modelKey === "veo3-fast") definition.lifecycle = "retired";
  definition.output.durationSec = [.1, Math.max(...spec.billedDurationsSec)];
  definition.output.aspectRatios = [...spec.aspectRatios];
  definition.output.nativeResolution = spec.extraInput.resolution === "720p" ? "720p" : "unknown";
  definition.determinism = spec.supportsSeed ? "seed-best-effort" : "none";
  definition.postProcessing = ["scale-pad", "frame-rate-conversion", "trim"];
  definition.price = {...definition.price, unit: "billed-second", usd: usdPerBilledSecond ?? spec.usdPerBilledSecond, billedDurationsSec: [...spec.billedDurationsSec].sort((a,b)=>a-b)};
  if (modelKey === "kling-o3-standard-reference") {
    definition.input.referenceFrames = 4;definition.input.minimumReferenceFrames = 1;
  }
  if(spec.cameraControl)definition.nativeCamera={moves:[...spec.cameraControl.moves]};
  if(spec.frameAnchors){definition.input.referenceFrames=4;definition.input.minimumFirstFrame=true;definition.frameControls={first:true,last:true,intermediate:false};definition.frameControlMode="native";
    definition.postProcessing=["scale-pad","frame-rate-conversion","retime-preserving-generated-endpoints"];}
  return capability(definition);
}
// Kling v2.5 turbo pro rendered a 5 s clip in 360 s of inference on 2026-09-03,
// so the wait budget is well above one observed render plus queue time.
export const DEFAULT_FAL_MAX_WAIT_MS = 900_000;

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
  // sunkCost is set when the abandoned request had already left fal's queue:
  // fal only honours a cancel while a request is queued, so anything that
  // reached IN_PROGRESS is billed whether or not the clip is used.
  constructor(message: string, readonly requestId?: string, readonly sunkCost?: CostRecord) {
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

/**
 * HV-019-09. `normalizeClip` and `frameFingerprint` run `Bun.spawnSync` on bytes the *vendor*
 * supplied, and carried no timeout and no abort wiring -- while three other synchronous ffmpeg
 * calls in this package (`sound-audio`, `audio-timeline`, `graphic-render`) all pass `timeout`, and
 * every asynchronous spawn carries a timer and an abort listener. Being synchronous they also stop
 * the timers that *do* exist around them from running: measured on a benign six-second 720p clip,
 * zero heartbeat ticks in 2.1 s and a cancel scheduled 100 ms in was never delivered.
 *
 * The encode gets longer than the probe because it is an encode. Neither is a lease bound -- the
 * lease is five minutes and beats every hundred seconds -- they are bounds on how long a worker
 * can be unresponsive to a vendor's file at all.
 */
const FFMPEG_TIMEOUT_MS = 60_000;
const FFMPEG_ENCODE_TIMEOUT_MS = 120_000;
/** Far above any clip this studio asks for, and far below filling an artifact volume. */
const MAX_CLIP_BYTES = 256 * 1024 ** 2;
/** The same rule the image adapter has always applied to a fal media URL. */
function falMediaUrl(value: string, requestId: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new FalProviderError("fal result carried an unreadable video url", requestId); }
  if (url.protocol !== "https:" || url.port || url.username || url.password || url.hash
    || !(url.hostname === "fal.media" || url.hostname.endsWith(".fal.media"))) {
    throw new FalProviderError("fal result carried an untrusted video url", requestId);
  }
  return url.href;
}
/** Streams the clip to disk, refusing past `maxBytes` rather than buffering it to find out. */
async function writeLimitedClip(response: Response, path: string, maxBytes: number, requestId: string): Promise<void> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    throw new FalProviderError("fal clip exceeds its size limit", requestId);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new FalProviderError("fal clip download carried no body", requestId);
  const sink = Bun.file(path).writer();
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new FalProviderError("fal clip exceeds its size limit", requestId);
      sink.write(next.value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    await sink.end();
  }
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
  ], { env: { ...process.env }, timeout: FFMPEG_TIMEOUT_MS });
  if (probe.signalCode) throw new Error(`fingerprint exceeded ${FFMPEG_TIMEOUT_MS / 1000}s`);
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
  readonly capabilities: CapabilitySnapshot;

  constructor(opts: FalProviderOptions = {}) {
    this.modelKey = opts.model ?? DEFAULT_FAL_MODEL;
    const spec = FAL_MODELS[this.modelKey];
    if (!spec) throw new Error(`unknown fal model "${this.modelKey}"; known: ${Object.keys(FAL_MODELS).join(", ")}`);
    this.spec = spec;
    this.model = spec.endpoint;
    const apiKey = opts.apiKey ?? process.env.FAL_KEY;
    if (!apiKey) throw new Error("FAL_KEY is not set; the fal provider cannot start");
    this.apiKey = apiKey;
    const base = new URL(opts.apiBase ?? "https://queue.fal.run");
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error("fal API base must be an HTTPS origin");
    this.apiBase = base.origin;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.pollMs = opts.pollMs ?? 2000;
    this.maxWaitMs = opts.maxWaitMs ?? DEFAULT_FAL_MAX_WAIT_MS;
    this.usdPerBilledSecond = opts.usdPerBilledSecond ?? spec.usdPerBilledSecond;
    this.capabilities = falVideoCapability(this.modelKey, this.usdPerBilledSecond);
  }

  async generate(prompt: string, seed: number, params: GenParams, outPath: string): Promise<VideoClip> {
    gateOrThrow(prompt);
    const references = params.referenceFrames ?? [], anchored=Boolean(this.spec.frameAnchors),conditioned = this.modelKey === "kling-o3-standard-reference"||anchored;
    if (params.identityLocks?.length) throw new Error("Video embedding identity conditioning is not implemented by this adapter.");
    if(anchored){const frames=params.frameAnchors?.frames;
      if(!frames||frames.length<1||frames.length>2||frames[0]?.at!==0||(frames.length===2&&frames[1]?.at!==10000)||!["native","prefer-native"].includes(params.frameAnchors?.mode??""))throw new FrameAnchorError("This adapter requires a first frame and supports an optional last frame, with no intermediate anchors.");
      try{privatePngReferences(frames.map(f=>f.image),1,2);}catch(error){throw new FrameAnchorError((error as Error).message);}
    }else if(params.frameAnchors)throw new FrameAnchorError("This video adapter does not support frame anchors.");
    if (conditioned){try{privatePngReferences(references,anchored?0:1);}catch(error){if(anchored)throw new FrameAnchorError((error as Error).message);throw error;}}
    else if (references.length) throw new Error("Video reference conditioning is not implemented by this adapter.");
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
    if(anchored){input.start_image_url=params.frameAnchors!.frames[0]!.image;if(params.frameAnchors!.frames[1])input.end_image_url=params.frameAnchors!.frames[1]!.image;}
    if (conditioned&&references.length) {
      input.image_urls = references;
      input.prompt = prompt + "\n" + references.map((_,index) => "@Image" + (index+1) + " is reference image " + (index+1) + ".").join(" ");
    }
    // HV-020-01: a path this model can move natively goes in the request and is not cropped later.
    const camera = params.cameraPath === undefined ? undefined : cameraControlPlan(this.capabilities, cameraPathSettings(params.cameraPath));
    if (camera?.applied === "native") {
      const fields = this.spec.cameraControl!.input(camera.moves);
      if (Object.keys(fields).some(key => Object.hasOwn(input, key))) throw new Error("A camera control field would replace a field this adapter already sends.");
      Object.assign(input, fields);
    }

    const submitted = await this.call(`${this.apiBase}/${this.spec.endpoint}`, params.signal, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    }) as { request_id?: string; status_url?: string; response_url?: string };
    const requestId = submitted.request_id;
    if (!requestId || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) throw new FalProviderError("fal submit returned no valid request_id");
    const requestBase = `${this.apiBase}/${this.spec.endpoint}/requests/${requestId}`;
    const statusUrl = trustedQueueUrl(submitted.status_url ?? `${requestBase}/status`,this.apiBase);
    const responseUrl = trustedQueueUrl(submitted.response_url ?? requestBase,this.apiBase);

    const started = Date.now();
    const abandon = async (message: string): Promise<FalProviderError> => {
      const stillBilled = await this.cancel(requestBase, statusUrl);
      return new FalProviderError(message, requestId, stillBilled ? this.costRecord(prompt, fps, requestedSec, billedSec) : undefined);
    };
    try {
      await params.onProviderRequest?.({schema:"fal-request/1",requestId,model:this.model,statusUrl,responseUrl,
        cancelUrl:requestBase+"/cancel",quotedCost:this.costRecord(prompt,fps,requestedSec,billedSec)});
    } catch (error) {
      const failure = await abandon("provider request receipt could not be saved");
      failure.name = ["BudgetError","LeaseError"].includes((error as Error).name) ? (error as Error).name : "BudgetError";
      throw failure;
    }
    for (;;) {
      if (params.signal?.aborted) throw await abandon("fal request aborted");
      let status: { status?: string; error?: unknown };
      try {
        status = await this.call(statusUrl, params.signal) as { status?: string; error?: unknown };
      } catch (err) {
        if (params.signal?.aborted) throw await abandon("fal request aborted");
        throw err;
      }
      if (status.status === "COMPLETED") break;
      if (status.status === "FAILED") {
        throw new FalProviderError(`fal generation failed: ${JSON.stringify(status.error ?? status).slice(0, 400)}`, requestId);
      }
      if (Date.now() - started > this.maxWaitMs) {
        throw await abandon(`fal request exceeded ${Math.round(this.maxWaitMs / 1000)}s`);
      }
      await Bun.sleep(this.pollMs);
    }

    try {
    const result = await this.call(responseUrl, params.signal) as { video?: { url?: string }; video_url?: string };
    const videoUrl = result.video?.url ?? result.video_url;
    if (!videoUrl) throw new FalProviderError("fal result carried no video url", requestId);

    mkdirSync(outPath.slice(0, outPath.lastIndexOf("/")), { recursive: true });
    const rawPath = `${outPath}.raw.mp4`;
    // HV-019-09: the URL came out of the response body and was fetched verbatim, to any host, over
    // any scheme, with no cap on what came back. The image adapter beside this one has required
    // `https`, no port and a `fal.media` host since it was written, and caps its body; the queue
    // URLs here are checked by `trustedQueueUrl` and the media URL was not. It needs a misbehaving
    // vendor rather than a creator, which is why it is a missing defence rather than a live hole --
    // and it is a defence its sibling already has.
    const download = await this.fetchImpl(falMediaUrl(videoUrl, requestId), { signal: params.signal });
    if (!download.ok) throw new FalProviderError(`fal clip download failed (${download.status})`, requestId);
    await writeLimitedClip(download, rawPath, MAX_CLIP_BYTES, requestId);
    let anchorTiming:{sourceFrames:number;outputFrames:number}|undefined;
    try {
      if(anchored)anchorTiming=await normalizeAnchoredClip(rawPath,outPath,{width,height,fps,durationSec:requestedSec},params.signal);
      else normalizeClip(rawPath, outPath, { width, height, fps, durationSec: requestedSec });
    } finally {
      if(anchored){try{rmSync(rawPath,{force:true});}catch {}}else rmSync(rawPath, { force: true });
    }

    return {
      path: outPath,
      provider: this.name,
      model: this.model,
      seed,
      durationSec: requestedSec,
      fingerprint: frameFingerprint(outPath, requestedSec / 2),
      ...(camera?.applied==="native"?{cameraPathControl:{mode:"screen-space" as const,keyframes:cameraPathSettings(params.cameraPath!).keyframes,outputFrames:Math.round(requestedSec*fps),applied:"native" as const,moves:camera.moves}}:{}),
      ...(anchorTiming?{frameAnchorControl:{mode:"native" as const,positions:params.frameAnchors!.frames.map(f=>f.at),timing:anchorTiming}}:{}),
      cost: this.costRecord(prompt, fps, requestedSec, billedSec),
    };
    }catch(error){
      /**
       * HV-019-09: everything inside this `try` runs **after** the queue reported `COMPLETED` --
       * fal has rendered the clip and billed for it. Whatever fails here, the money is spent.
       *
       * The cost was attached only when `anchored`, which is one model of four
       * (`kling-o3-standard-keyframes`); the three others -- including `DEFAULT_FAL_MODEL` --
       * rethrew bare. `sunkCostsOf` then found nothing, `FailoverGenerator.attempt` had nothing to
       * hand `onAttemptCost`, and `chargeCost` never ran: the film's `costUsd`, the cost events and
       * the month's spend were all short by the full price of that render. On PostgreSQL the
       * attempt settled `unknown` with `actual_usd = 0` while the adapter had the exact figure in
       * hand; on the JSON ledger there was no record at all.
       *
       * And a plain `Error` is not in `stopped()`, so the router tries the next candidate and the
       * worker requeues up to `maxRetries: 2` -- three billed renders of one shot, none of them in
       * the ledger. The budget hold is sized for exactly that (`const attempts = 3` at admission),
       * so the money was reserved; what was lost was the record of having spent it.
       *
       * The sibling image adapter has always done this right (`fal-image.ts`, `submitted &&
       * mayBeBilled ? cost : undefined`). This one now does too, on every model.
       */
      const sunkCost=this.costRecord(prompt,fps,requestedSec,billedSec);
      if(!anchored)throw Object.assign(error instanceof Error?error:new Error(String(error)),{sunkCost});
      const failure=error instanceof FrameAnchorError?error:new FrameAnchorError("The completed anchored render could not be recovered locally. The paid request will not be repeated automatically.",{cause:error});
      throw Object.assign(failure,{sunkCost});
    }
  }

  private costRecord(prompt: string, fps: number, requestedSec: number, billedSec: number): CostRecord {
    return {
      provider: this.name,
      model: this.model,
      prompt_tokens: Math.ceil(prompt.length / 4),
      output_frames: Math.round(fps * requestedSec),
      gpu_seconds: billedSec,
      total_cost_usd: Number((billedSec * this.usdPerBilledSecond).toFixed(4)),
    };
  }

  private async call(url: string, signal: AbortSignal | undefined, init: RequestInit = {}): Promise<unknown> {
    const response = await this.fetchImpl(trustedQueueUrl(url,this.apiBase), {
      ...init,
      redirect: "error",
      signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000),
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Key ${this.apiKey}` },
    });
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new FalProviderError(`fal ${init.method ?? "GET"} ${url.replace(this.apiBase, "")} failed (${response.status}): ${body.slice(0, 300)}`);
    }
    return response.json();
  }

  // Returns true when the abandoned request must be treated as billed. fal
  // accepts a cancel only while the request is queued; once it is IN_PROGRESS
  // (or already COMPLETED) the render runs to the end and is charged, so the
  // status is re-read after the cancel rather than trusting the cancel alone.
  // An unreadable status after a rejected cancel is assumed billed.
  private async cancel(requestBase: string, statusUrl: string): Promise<boolean> {
    const headers = { authorization: `Key ${this.apiKey}` };
    const signal = AbortSignal.timeout(5000);
    let accepted = false;
    try {
      accepted = (await this.fetchImpl(`${requestBase}/cancel`, { method: "PUT", headers, signal, redirect:"error" })).ok;
    } catch {
      accepted = false;
    }
    try {
      const response = await this.fetchImpl(trustedQueueUrl(statusUrl,this.apiBase), { headers, signal, redirect:"error" });
      if (response.ok) {
        const status = (await response.json() as { status?: string }).status;
        return status === "IN_PROGRESS" || status === "COMPLETED";
      }
    } catch {
      // fall through to the cancel verdict
    }
    return !accepted;
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
  ], { env: { ...process.env }, timeout: FFMPEG_ENCODE_TIMEOUT_MS });
  if (proc.signalCode) throw new Error(`ffmpeg normalize exceeded ${FFMPEG_ENCODE_TIMEOUT_MS / 1000}s`);
  if (proc.exitCode !== 0) throw new Error(`ffmpeg normalize failed: ${proc.stderr.toString().slice(-400)}`);
}
