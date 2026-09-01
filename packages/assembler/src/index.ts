import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { VideoClip } from "../../generator/src/index";
import type { ProvenanceManifest, Shot } from "../../planner/src/index";

export interface AssembleOptions {
  crossfadeSec?: number;
  fps?: number;
  size?: string;
  burnInCaptions?: boolean;
  srtPath?: string;
  projectId?: string;
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
}

interface ProbeStream {
  codec_type: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  sample_rate?: string;
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

function run(args: string[]): void {
  const p = Bun.spawnSync(args, { env: { ...process.env } });
  if (p.exitCode !== 0) throw new Error(`${args[0]} failed: ${p.stderr.toString().slice(-500)}`);
}

export function buildCaptions(shots: Shot[], srtPath: string, vttPath: string): void {
  let t = 0;
  const srt: string[] = [];
  const vtt: string[] = ["WEBVTT", ""];
  let idx = 1;
  for (const shot of shots) {
    for (const d of shot.dialogue) {
      const start = fmt(t), end = fmt(t + shot.durationSec);
      srt.push(`${idx}`, `${start.replace(".", ",")} --> ${end.replace(".", ",")}`, `${d.character}: ${d.lines.join(" ")}`, "");
      vtt.push(`${start} --> ${end}`, `${d.character}: ${d.lines.join(" ")}`, "");
      idx += 1;
    }
    t += shot.durationSec;
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
  const h = String(Math.floor(sec / 3600)).padStart(2, "0");
  const m = String(Math.floor((sec % 3600) / 60)).padStart(2, "0");
  const s = String(Math.floor(sec % 60)).padStart(2, "0");
  const ms = String(Math.round((sec % 1) * 1000)).padStart(3, "0");
  return `${h}:${m}:${s}.${ms}`;
}

export function assemble(
  clips: VideoClip[],
  shots: Shot[],
  outDir: string,
  opts: AssembleOptions = {},
  degradedShots: string[] = [],
): ExportResult {
  if (clips.length === 0) throw new Error("no clips to assemble");
  const fps = opts.fps ?? 30;
  const size = opts.size ?? "1920x1080";
  if (!/^\d{2,5}x\d{2,5}$/.test(size)) throw new Error(`invalid export size: ${size}`);
  const [width, height] = size.split("x").map(Number);
  const xf = opts.crossfadeSec ?? 0.5;
  mkdirSync(outDir, { recursive: true });
  const mp4Path = `${outDir}/export.mp4`;
  const srtPath = `${outDir}/captions.srt`;
  const vttPath = `${outDir}/captions.vtt`;
  buildCaptions(shots, srtPath, vttPath);

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
  if (clips.length === 1) filter = "";
  const total = clips.reduce((s, c) => s + c.durationSec, 0) - xf * (clips.length - 1);
  const sourceLabel = clips.length === 1 ? "[0:v]" : "[vout]";
  filter += `${sourceLabel}scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2[vscaled];`;
  filter += `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${total.toFixed(3)}[aout]`;
  const maps = ["-map", "[vscaled]", "-map", "[aout]"];
  const capArgs = opts.burnInCaptions ? ["-vf", `subtitles=${srtPath}`] : [];
  run([
    "ffmpeg", "-y", ...inputs,
    "-filter_complex", filter, ...maps, ...capArgs,
    "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-r", String(fps),
    "-c:a", "aac", "-b:a", "128k",
    "-metadata", `comment=degraded_shots=${degradedShots.join(",") || "none"}`,
    "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact",
    mp4Path,
  ]);

  const probe = Bun.spawnSync(["ffprobe", "-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", mp4Path], { env: { ...process.env } });
  if (probe.exitCode !== 0) throw new Error("ffprobe validation failed");
  const validated = validateExport(JSON.parse(probe.stdout.toString()) as ProbeOutput, { width, height, fps, durationSec: total });

  const bytes = new Uint8Array(require("node:fs").readFileSync(mp4Path));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest: ProvenanceManifest = {
    spec: "hv-provenance/1.0",
    projectId: opts.projectId ?? "unknown",
    scriptSha256: createHash("sha256").update(shots.map((s) => s.prompt).join("\n")).digest("hex"),
    shots: clips.map((c, i) => ({ id: shots[i]?.id ?? `clip-${i}`, provider: c.provider, model: c.model, seed: c.seed, fingerprint: c.fingerprint })),
    assembledAt: "1970-01-01T00:00:00.000Z",
    credentials: { type: "c2pa-style", issuer: "hollywood-video-app", claim: `AI-generated video; content credentials sha256:${sha256}` },
  };
  const manifestPath = `${outDir}/provenance.json`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  const hlsDirectory = `${outDir}/hls`;
  const hlsPlaylistPath = `${hlsDirectory}/index.m3u8`;
  mkdirSync(hlsDirectory, { recursive: true });
  run([
    "ffmpeg", "-y", "-i", mp4Path,
    "-map", "0:v:0", "-map", "0:a:0", "-c", "copy",
    "-hls_time", "2", "-hls_list_size", "0", "-hls_playlist_type", "vod",
    "-hls_segment_filename", `${hlsDirectory}/segment-%03d.ts`, hlsPlaylistPath,
  ]);
  return {
    mp4Path, hlsPlaylistPath, srtPath, vttPath, manifestPath, sha256,
    ffprobe: validated,
    degradedShots,
    audioMode: "silent-captioned",
  };
}

function parseFrameRate(value: string): number {
  const [numerator, denominator = 1] = value.split("/").map(Number);
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    throw new Error(`invalid ffprobe frame rate: ${value}`);
  }
  return numerator / denominator;
}
