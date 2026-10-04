import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gateOrThrow } from "../../safety/src/index";
import {synthesizeLines,speechRuntimeRevision} from "./speech";
import {speechCaptions,type SpeechReport} from "../../planner/src/performances";
import { captionCues } from "../../planner/src/captions";
import { frameFingerprint } from "./fal";
import { parseFrameSize, type ImageProvider } from "./image";
import { sunkCostsOf, type GenParams, type ProviderAdapter, type VideoClip } from "./index";
import { capability, type CapabilitySnapshot } from "./capabilities";
import {assertCameraPathContext,cameraPathFilter,sampleCameraPath} from "../../planner/src/camera-path";
import {framingSettings,isCropped} from "../../planner/src/framing";
import {frameImage,FramingError} from "./framing";

export type CameraMove = "static" | "push-in" | "pull-out" | "pan-left" | "pan-right";
const MOVES: CameraMove[] = ["push-in", "pull-out", "pan-left", "pan-right"];
/** A local preflight refusal: no image request has been issued. */
export class ShotDurationError extends Error {override name="ShotDurationError";}

export async function animaticCommand(args: string[], cwd: string, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  const child = Bun.spawn(args, { cwd, stdout: "ignore", stderr: "pipe" });
  const abort = () => child.kill("SIGKILL");
  const timeout = setTimeout(abort, 60_000);
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) abort();
    const [code, error] = await Promise.all([child.exited, new Response(child.stderr).text()]);
    signal?.throwIfAborted();
    if (code !== 0) throw new Error(`animatic ${args[0]} failed: ${error.slice(-200)}`);
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", abort);
  }
}

export function animaticCaptionFilters(width:number,dialogue:NonNullable<GenParams["dialogue"]>,durationSec:number,scratch:string,speech?:SpeechReport):string[] {
  return (speech?speechCaptions(speech):captionCues(dialogue,durationSec)).map((cue,index)=>{
    writeFileSync(join(scratch,`caption-${index}.txt`),cue.text);
    return `drawtext=font=DejaVu Sans:textfile=caption-${index}.txt:expansion=none:fontcolor=white:fontsize=${Math.max(12,Math.round(width/32))}:box=1:boxcolor=black@0.7:boxborderw=8:x=(w-text_w)/2:y=h-text_h-16:enable='gte(t,${cue.startSec})*lt(t,${cue.endSec})'`;
  });
}

export class RichAnimaticProvider implements ProviderAdapter {
  readonly name = "rich-animatic";
  readonly model: string;
  readonly capabilities?: CapabilitySnapshot;
  constructor(readonly images: ImageProvider, private options: { narration?: boolean; captions?: boolean } = {}) {
    this.model = `animatic-v1/${images.model}`;
    this.capabilities = images.capabilities ? richAnimaticCapability(images.capabilities, options) : undefined;
  }

  estimateShotUsd(params: GenParams): number {
    return this.images.name === "mock" ? 0 : this.images.estimateFrameUsd?.(params) ?? Infinity;
  }

  async generate(prompt: string, seed: number, params: GenParams, outPath: string): Promise<VideoClip> {
    const dialogue = (params.dialogue ?? []).map(d => `${d.character}: ${d.lines.join(" ")}`).join("\n");
    gateOrThrow([prompt, params.shotId ?? "", params.sceneHeading ?? "", params.action ?? "", dialogue].join("\n"));
    params.signal?.throwIfAborted();
    if(params.cameraPath!==undefined){try{assertCameraPathContext(params);}catch(error){throw new FramingError((error as Error).message);}}
    if(params.framing){try{framingSettings(params.framing);if(isCropped(params.framing)&&params.routingRequirements?.nativeResolution)throw new Error("A digital crop is incompatible with a native-resolution requirement.");}catch(error){throw new FramingError((error as Error).message);}}
    const [width, height] = parseFrameSize(params.widthxheight ?? "640x360");
    const fps = params.fps ?? 30, requestedDuration = params.durationSec ?? 2;
    if (!Number.isInteger(fps) || fps < 1 || fps > 60 || !Number.isFinite(requestedDuration) || requestedDuration < 0.1 || requestedDuration > 30) {
      throw new Error("animatic requires 1-60 fps and a duration from 0.1 to 30 seconds");
    }
    let frames = Math.max(1, Math.round(fps * requestedDuration)), durationSec = frames / fps;
    const digest = createHash("sha256").update(`${prompt}|${seed}`).digest();
    const move = params.cameraPath?"static":params.cameraMove ?? MOVES[digest[0]! % MOVES.length]!;
    if (!["static", ...MOVES].includes(move)) throw new Error("unknown animatic camera move");
    const target = resolve(outPath);
    mkdirSync(dirname(target), { recursive: true });
    const scratch = mkdtempSync(join(dirname(target), ".hv-animatic-"));
    let frame: Awaited<ReturnType<ImageProvider["generateFrame"]>> | undefined;
    try {
      const audio = await synthesizeLines(scratch,params.dialogue??[],params.performances,fps,frames,params.exactDuration,this.options.narration,params.signal,this.capabilities?.postProcessing.find(p=>p.startsWith("espeak-")));
      frames=audio.frames;durationSec=audio.durationSec;const voice=audio.voice;
      frame = await this.images.generateFrame(prompt, seed, { ...params, widthxheight: `${width}x${height}` }, join(scratch, "frame.png"));
      const firstFraming=params.cameraPath?sampleCameraPath(params.cameraPath,0,frames):params.framing,cropped=Boolean(params.cameraPath)||isCropped(firstFraming);if(cropped)await frameImage(join(scratch,"frame.png"),join(scratch,"framed.png"),firstFraming!,`${width}x${height}`,params.signal);
      const progress = `on/${Math.max(1, frames - 1)}`;
      const z = move === "push-in" ? `1+0.08*${progress}` : move === "pull-out" ? `1.08-0.08*${progress}` : move === "static" ? "1" : "1.08";
      const x = move === "pan-left" ? `(iw-iw/zoom)*(1-${progress})` : move === "pan-right" ? `(iw-iw/zoom)*${progress}` : "iw/2-iw/zoom/2";
      const filters = params.cameraPath?[cameraPathFilter(params.cameraPath,width,height,fps,frames,true)]:[`scale=${width * 2}:${height * 2}`,
        `zoompan=z='${z}':x='${x}':y='ih/2-ih/zoom/2':d=${frames}:s=${width}x${height}:fps=${fps}`];
      if(this.options.captions)filters.push(...animaticCaptionFilters(width,params.dialogue??[],durationSec,scratch,audio.speech));
      await animaticCommand([
        "ffmpeg", "-y", "-v", "error", "-i", cropped&&!params.cameraPath?"framed.png":"frame.png",
        ...(voice ? ["-i", "voice.wav"] : ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"]),
        "-vf", filters.join(","), "-af", "apad", "-t", String(durationSec), "-frames:v", String(frames),
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
        "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1", "clip.mp4",
      ], scratch, params.signal);
      params.signal?.throwIfAborted();
      const fingerprint = frameFingerprint(join(scratch, "clip.mp4"), durationSec / 2);
      if(cropped)renameSync(join(scratch,"frame.png"),`${target}.source.png`);
      renameSync(join(scratch, cropped?"framed.png":"frame.png"), `${target}.png`);
      renameSync(join(scratch, "clip.mp4"), target);
      if(audio.speech)renameSync(join(scratch,"voice.wav"),`${target}.wav`);
      return { path: outPath, provider: this.name, model: this.model, seed, durationSec, fingerprint,
        ...(audio.speech?{speech:audio.speech,audioPath:`${target}.wav`}:{}),posterPath: `${target}.png`, ...(cropped?{sourcePosterPath:`${target}.source.png`,...(!params.cameraPath?{framing:params.framing}:{})}:{}),...(params.cameraPath?{cameraPathControl:{mode:"screen-space" as const,keyframes:structuredClone(params.cameraPath.keyframes),outputFrames:frames,applied:"local-crop" as const,reason:"provider-has-no-native-camera" as const}}:{}),audioMode: voice ? "provided" : "silent-captioned",
        cost: { ...frame.cost, output_frames: frames } };
    } catch (error) {
      const err = error instanceof Error ? error : new Error("animatic rendering failed");
      if (frame) Object.assign(err, { sunkCosts: [...sunkCostsOf(err), frame.cost] });
      throw err;
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}

export function richAnimaticCapability(image: CapabilitySnapshot, options: {narration?: boolean; captions?: boolean} = {}): CapabilitySnapshot {
  const {schema: _schema, revision: _revision, priceVersion: _priceVersion, ...definition} = structuredClone(image);
  definition.adapter = "rich-animatic"; definition.model = "animatic-v1/" + image.model; definition.modality = "video";
  definition.output.fps = [1,60]; definition.output.durationSec = [.1,30];
  definition.audio = options.narration ? "temporary-dialogue" : "silent";
  definition.cameraMoves = ["static", "push-in", "pull-out", "pan-left", "pan-right"];
  if(options.narration)definition.determinism="none";
  definition.postProcessing.push("pan-zoom", ...(options.narration ? ["temporary-narration","line-performances-v1",speechRuntimeRevision()] : []), ...(options.captions ? ["burn-in-captions"] : []));
  return capability(definition);
}
