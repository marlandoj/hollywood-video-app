import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {speechCaptions,type SpeechReport} from "../../planner/src/performances";
import { captionCues } from "../../planner/src/captions";
import type { VideoClip } from "../../generator/src/index";
import type { Shot } from "../../planner/src/index";
import {PROVENANCE_SPEC,provenanceAssembledAt,provenanceCredentials,type ProvenanceManifest} from "../../planner/src/provenance";
import {coverageReport} from "../../planner/src/coverage";
import {createCurrentFilmAssemblyClock,currentFilmOverlap,parseCurrentFilmProbe,type CurrentFilmAssemblyClock,type CurrentFilmClockRow,type CurrentFilmMediaDigest} from "../../planner/src/current-film-clock";

export interface AssembleOptions {
  /**
   * The instant this export is being assembled, as a UTC ISO 8601 string.
   *
   * Required, with no default, on purpose. It used to be a literal epoch
   * inside the manifest constructor, so every export this program ever
   * produced claimed it was assembled in 1970 -- and a caller that forgot to
   * supply a clock would have reproduced exactly that. A required field makes
   * forgetting it a type error at the two production call sites rather than a
   * constant in a rights record.
   */
  assembledAt: string;
  crossfadeSec?: number;
  fps?: number;
  size?: string;
  burnInCaptions?: boolean;
  srtPath?: string;
  projectId?: string;
  signal?: AbortSignal;
  casting?: import("../../planner/src/casting").CastingSnapshot;
  direction?: import("../../planner/src/direction").DirectionSnapshot;
  /** Opt-in canonical execution evidence; never placed in public clip metadata. */
  currentFilm?:{jobId:string;jobPlanRevision:string;materializationRevision:string;rows:CurrentFilmClockRow[]};
}

export interface ExportProbe {
  codec: string;
  width: number;
  height: number;
  fps: number;
  durationSec: number;
  bitrateBps: number;
  audioCodec: string;
  audioSampleRate: number;
}

export interface ExportResult {
  mp4Path: string;
  hlsPlaylistPath: string;
  srtPath: string;
  vttPath: string;
  manifestPath: string;
  sha256: string;
  ffprobe: ExportProbe;
  degradedShots: string[];
  audioMode: "provided" | "silent-captioned";
  currentFilmClock?:CurrentFilmAssemblyClock;
}

interface ProbeStream {
  codec_type: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  sample_rate?: string;
  channels?:number;nb_read_frames?:string;time_base?:string;duration_ts?:number;
}

interface ProbeOutput {
  streams?: ProbeStream[];
  format?: { duration?: string; bit_rate?: string };
}

export interface ExportExpectation { width: number; height: number; fps: number; durationSec: number }

/**
 * FR-044: every export passes ffprobe checks on codec, resolution, frame
 * rate, duration, bitrate, and audio before a download link is issued. Pure
 * so the rejection paths are testable without rendering.
 */
export function validateExport(info: ProbeOutput, expected: ExportExpectation): ExportProbe {
  const video = info.streams?.find((stream) => stream.codec_type === "video");
  const audio = info.streams?.find((stream) => stream.codec_type === "audio");
  if (!video) throw new Error("export has no video stream");
  if (!audio) throw new Error("export has no audio stream");
  if (video.codec_name !== "h264") throw new Error(`expected h264 video, got ${video.codec_name ?? "none"}`);
  if (audio.codec_name !== "aac") throw new Error(`expected aac audio, got ${audio.codec_name ?? "none"}`);
  if (video.width !== expected.width || video.height !== expected.height) {
    throw new Error(`expected ${expected.width}x${expected.height}, got ${video.width ?? "?"}x${video.height ?? "?"}`);
  }
  const fps = parseFrameRate(video.r_frame_rate ?? "");
  if (Math.abs(fps - expected.fps) > 0.01) throw new Error(`expected ${expected.fps} fps, got ${fps}`);
  const durationSec = Number.parseFloat(info.format?.duration ?? "");
  if (!Number.isFinite(durationSec) || durationSec <= 0) throw new Error("export has no measurable duration");
  const tolerance = Math.max(0.25, 2 / expected.fps);
  if (Math.abs(durationSec - expected.durationSec) > tolerance) {
    throw new Error(`expected ${expected.durationSec.toFixed(3)}s, got ${durationSec.toFixed(3)}s`);
  }
  const bitrateBps = Number.parseInt(info.format?.bit_rate ?? "", 10);
  if (!Number.isFinite(bitrateBps) || bitrateBps <= 0) throw new Error("export has no measurable bitrate");
  const audioSampleRate = Number.parseInt(audio.sample_rate ?? "", 10);
  if (!Number.isFinite(audioSampleRate) || audioSampleRate <= 0) throw new Error("export audio has no sample rate");
  return { codec: video.codec_name, width: video.width, height: video.height, fps, durationSec, bitrateBps, audioCodec: audio.codec_name, audioSampleRate };
}

function run(args: string[]): string {
  const p = Bun.spawnSync(args, { env: { ...process.env } });
  if (p.exitCode !== 0) throw new Error(`${args[0]} failed: ${p.stderr.toString().slice(-500)}`);
  return p.stdout.toString();
}

export function buildCaptions(shots: Shot[], srtPath: string, vttPath: string, crossfadeSec = 0, speech:(SpeechReport|undefined)[]=[]): void {
  let t = 0;
  const srt: string[] = [];
  const vtt: string[] = ["WEBVTT", ""];
  let idx = 1;
  for (const [shotIndex,shot] of shots.entries()) {
    const measured=speech[shotIndex];
    for (const cue of measured?speechCaptions(measured):captionCues(shot.dialogue, shot.durationSec)) {
      const start = fmt(t + cue.startSec), end = fmt(t + cue.endSec);
      srt.push(`${idx}`, `${start.replace(".", ",")} --> ${end.replace(".", ",")}`, cue.text, "");
      vtt.push(`${start} --> ${end}`, cue.text, "");
      idx += 1;
    }
    t += shot.durationSec - crossfadeSec;
  }
  if (idx === 1) {
    srt.push("1", "00:00:00,000 --> 00:00:01,000", "[no dialogue]", "");
    vtt.push("00:00:00.000 --> 00:00:01.000", "[no dialogue]", "");
  }
  mkdirSync(dirname(srtPath), { recursive: true });
  writeFileSync(srtPath, srt.join("\n"));
  writeFileSync(vttPath, vtt.join("\n"));
}

function fmt(sec: number): string {
  const millis = Math.max(0, Math.round(sec * 1000));
  const h = String(Math.floor(millis / 3600000)).padStart(2, "0");
  const m = String(Math.floor((millis % 3600000) / 60000)).padStart(2, "0");
  const seconds = String(Math.floor((millis % 60000) / 1000)).padStart(2, "0");
  const ms = String(millis % 1000).padStart(3, "0");
  return `${h}:${m}:${seconds}.${ms}`;

}

function* assemblySteps(
  clips: VideoClip[],
  shots: Shot[],
  outDir: string,
  opts: AssembleOptions,
  degradedShots: string[] = [],
): Generator<string[] | {hashFile: string;withBytes?:boolean}, ExportResult, string> {
  if (clips.length === 0) throw new Error("no clips to assemble");
  const fps = opts.fps ?? 30;
  const size = opts.size ?? "1920x1080";
  if (!/^\d{2,5}x\d{2,5}$/.test(size)) throw new Error(`invalid export size: ${size}`);
  const [width, height] = size.split("x").map(Number);
  let xf = clips.some(c=>c.speech)?0:opts.crossfadeSec ?? 0.5;
  let sourceFrames:number[]|undefined;
  const requestedOverlapFrames=(opts.crossfadeSec??0.5)*30;
  const clockChoice=opts.currentFilm?currentFilmOverlap(opts.currentFilm.rows,requestedOverlapFrames as 0|15):undefined;
  if(opts.currentFilm){
    if(fps!==30||!opts.projectId||opts.currentFilm.rows.length!==clips.length||shots.length!==clips.length||opts.currentFilm.rows.some((row,i)=>row.renderId!==shots[i]!.id||!clips[i]!.renderRecord||row.record.revision!==clips[i]!.renderRecord!.revision))throw new Error("Canonical assembly requires its complete ordered owning clips.");
    xf=clockChoice!.effectiveOverlapFrames/30;sourceFrames=[];
    for(const clip of clips){
      const info=JSON.parse(yield ["ffprobe","-v","error","-select_streams","v:0","-count_frames","-show_entries","stream=nb_read_frames,r_frame_rate","-of","json",clip.path]) as {streams?:ProbeStream[]},stream=info.streams?.[0],frames=Number(stream?.nb_read_frames);
      if(!Number.isSafeInteger(frames)||frames<1||parseFrameRate(stream?.r_frame_rate??"")!==30||Math.abs(clip.durationSec*30-frames)>1e-7)throw new Error("Canonical source duration differs from its actual decoded frames.");sourceFrames.push(frames);
    }
  }
  mkdirSync(outDir, { recursive: true });
  const mp4Path = `${outDir}/export.mp4`;
  const srtPath = `${outDir}/captions.srt`;
  const vttPath = `${outDir}/captions.vtt`;
  buildCaptions(shots.map((shot, index) => ({ ...shot, durationSec: clips[index]?.durationSec ?? shot.durationSec })), srtPath, vttPath, xf,clips.map(c=>c.speech));

  const inputs = clips.flatMap((c) => ["-i", c.path]);
  let filter = "";
  let last = "[0:v]";
  let offset = 0;
  for (let i = 1; i < clips.length; i++) {
    offset += clips[i - 1].durationSec - xf;
    const out = i === clips.length - 1 ? "[vout]" : `[x${i}]`;
    filter += `${last}[${i}:v]xfade=transition=fade:duration=${xf}:offset=${offset.toFixed(3)}${out};`;
    last = out;
  }
  if (xf === 0 && clips.length > 1) filter = clips.map((_, i) => `[${i}:v]`).join("") + `concat=n=${clips.length}:v=1:a=0[vout];`;
  if (clips.length === 1) filter = "";
  const total = clips.reduce((s, c) => s + c.durationSec, 0) - xf * (clips.length - 1);
  const sourceLabel = clips.length === 1 ? "[0:v]" : "[vout]";
  filter += `${sourceLabel}scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2[vscaled];`;
  const hasVoice = clips.some(c => c.audioMode === "provided");
  if (hasVoice) {
    clips.forEach((clip, i) => {
      filter += clip.audioMode ? `[${i}:a]aresample=44100,aformat=channel_layouts=stereo,apad,atrim=duration=${clip.durationSec},asetpts=PTS-STARTPTS[voice${i}];`
        : `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${clip.durationSec}[voice${i}];`;
    });
    if (clips.length === 1) filter += "[voice0]anull[aout]";
    else if (xf === 0) filter += clips.map((_, i) => `[voice${i}]`).join("") + `concat=n=${clips.length}:v=0:a=1[aout]`;
    else {
      let lastAudio = "[voice0]";
      for (let i = 1; i < clips.length; i++) {
        const next = i === clips.length - 1 ? "[aout]" : `[mixed${i}]`;
        filter += `${lastAudio}[voice${i}]acrossfade=d=${xf}${next}${i === clips.length - 1 ? "" : ";"}`;
        lastAudio = next;
      }
    }
  } else filter += `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${total.toFixed(3)}[aout]`;
  let videoOutput = "[vscaled]";
  if (opts.burnInCaptions) {
    const escaped = srtPath.replace(/\\/g, "\\\\").replace(/'/g, "'\\''").replace(/:/g, "\\:");
    filter += `;[vscaled]subtitles=filename='${escaped}'[captioned]`;
    videoOutput = "[captioned]";
  }
  const maps = ["-map", videoOutput, "-map", "[aout]"];
  yield [
    "ffmpeg", "-y", ...inputs,
    "-filter_complex", filter, ...maps,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-r", String(fps),
    "-c:a", "aac", "-b:a", "128k",
    "-metadata", `comment=degraded_shots=${degradedShots.join(",") || "none"}`,
    "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
    mp4Path,
  ];

  const probe = yield ["ffprobe", "-v", "quiet", ...(opts.currentFilm?["-count_frames"]:[]), "-print_format", "json", "-show_streams", "-show_format", mp4Path];
  const info=JSON.parse(probe) as ProbeOutput,validated = validateExport(info, { width, height, fps, durationSec: total });
  const measuredVideo=opts.currentFilm?JSON.parse(yield {hashFile:mp4Path,withBytes:true}) as CurrentFilmMediaDigest:undefined;
  const sha256 = measuredVideo?.sha256??(yield {hashFile: mp4Path});
  let currentFilmClock:CurrentFilmAssemblyClock|undefined;
  if(opts.currentFilm){
    const exactProbe=parseCurrentFilmProbe(info);
    const srt=JSON.parse(yield {hashFile:srtPath,withBytes:true}) as CurrentFilmMediaDigest,vtt=JSON.parse(yield {hashFile:vttPath,withBytes:true}) as CurrentFilmMediaDigest;
    currentFilmClock=createCurrentFilmAssemblyClock({projectId:opts.projectId!,jobId:opts.currentFilm.jobId,jobPlanRevision:opts.currentFilm.jobPlanRevision,materializationRevision:opts.currentFilm.materializationRevision,requestedOverlapFrames:requestedOverlapFrames as 0|15,...clockChoice!,rows:opts.currentFilm.rows,sourceFrames:sourceFrames!,probe:exactProbe,video:measuredVideo!,captions:{srt,vtt}});
  }
  const manifest: ProvenanceManifest = {
    spec: PROVENANCE_SPEC,
    projectId: opts.projectId ?? "unknown",
    scriptSha256: createHash("sha256").update(shots.map((s) => s.sourcePrompt ?? s.prompt).join("\n")).digest("hex"),
    ...(opts.casting ? {casting: opts.casting} : {}),
    ...(opts.direction?{direction:opts.direction,coverage:coverageReport(shots,opts.direction)}:{}),
    shots: clips.map((c, i) => ({ id: shots[i]?.id ?? `clip-${i}`, provider: c.provider, model: c.model, seed: c.seed, fingerprint: c.fingerprint,
      ...(c.picturePerformance?{picturePerformance:c.picturePerformance}:{}),...(c.speech?{speech:c.speech}:{}),...(c.renderRecord?{renderRecord:c.renderRecord}:{}),
      ...(c.routing ? {routing: c.routing} : {}),...(c.framing?{appliedFraming:c.framing}:{}),...(c.cameraPathControl?{cameraPathControl:c.cameraPathControl}:{}),...(c.frameAnchorControl?{frameAnchorControl:c.frameAnchorControl}:{}),...(opts.direction?{durationSec:c.durationSec,requestedDurationSec:shots[i]?.durationSec,direction:shots[i]?.direction??null}: {}) })),
    assembledAt: provenanceAssembledAt(opts.assembledAt),
    credentials: provenanceCredentials(sha256),
  };
  const manifestPath = `${outDir}/provenance.json`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const hlsDirectory = `${outDir}/hls`;
  const hlsPlaylistPath = `${hlsDirectory}/index.m3u8`;
  mkdirSync(hlsDirectory, { recursive: true });
  yield [
    "ffmpeg", "-y", "-i", mp4Path,
    "-map", "0:v:0", "-map", "0:a:0", "-c", "copy",
    "-hls_time", "2", "-hls_list_size", "0", "-hls_playlist_type", "vod",
    "-hls_segment_filename", `${hlsDirectory}/segment-%03d.ts`, hlsPlaylistPath,
  ];
  return {
    mp4Path, hlsPlaylistPath, srtPath, vttPath, manifestPath, sha256,
    ffprobe: validated,
    degradedShots,
    audioMode: hasVoice ? "provided" : "silent-captioned",
    ...(currentFilmClock?{currentFilmClock}:{}),
  };
}

/** Synchronous entry point retained for deterministic benchmarks and local tooling. */
export function assemble(...args: Parameters<typeof assemblySteps>): ExportResult {
  const steps = assemblySteps(...args);
  let next = steps.next();
  while (!next.done) {
    let value:string;
    if(Array.isArray(next.value))value=run(next.value);else {const data=require("node:fs").readFileSync(next.value.hashFile) as Buffer,sha256=createHash("sha256").update(data).digest("hex");value=next.value.withBytes?JSON.stringify({sha256,bytes:data.byteLength}):sha256;}
    next = steps.next(value);
  }
  return next.value;
}

/** Worker exports keep the event loop free for lease heartbeats and cancellation. */
export async function assembleAsync(...args: Parameters<typeof assemblySteps>): Promise<ExportResult> {
  const steps = assemblySteps(...args);
  const signal = args[3]?.signal;
  let next = steps.next();
  while (!next.done) {
    signal?.throwIfAborted();
    let value: string;
    if (Array.isArray(next.value)) value = await runAsync(next.value, signal);
    else {
      const hash = createHash("sha256");let bytes=0;
      for await (const chunk of Bun.file(next.value.hashFile).stream()) {
        signal?.throwIfAborted();
        hash.update(chunk);
        bytes+=chunk.byteLength;
      }
      const sha256=hash.digest("hex");value=next.value.withBytes?JSON.stringify({sha256,bytes}):sha256;
    }
    next = steps.next(value);
  }
  signal?.throwIfAborted();
  return next.value;
}

async function runAsync(args: string[], signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const child = Bun.spawn(args, {env: {...process.env}, stdin: "ignore", stdout: "pipe", stderr: "pipe"});
  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const abort = () => {
    child.kill("SIGTERM");
    killTimer = setTimeout(() => child.kill("SIGKILL"), 5000);
  };
  signal?.addEventListener("abort", abort, {once: true});
  if (signal?.aborted) abort();
  try {
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    signal?.throwIfAborted();
    if (code !== 0) throw new Error(`${args[0]} failed: ${stderr.slice(-500)}`);
    return stdout;
  } finally {
    signal?.removeEventListener("abort", abort);
    if (killTimer) clearTimeout(killTimer);
  }
}

function parseFrameRate(value: string): number {
  const [numerator, denominator = 1] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    throw new Error(`invalid ffprobe frame rate: ${value}`);
  }
  return numerator / denominator;
}
