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
}

export interface ExportResult {
  mp4Path: string;
  srtPath: string;
  vttPath: string;
  manifestPath: string;
  sha256: string;
  ffprobe: { codec: string; fps: number; durationSec: number; audioCodec: string };
  linkExpiresAt: string;
  degradedShots: string[];
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
  const fps = opts.fps ?? 24;
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
  const videoLabel = clips.length === 1 ? "0:v" : "vout";
  if (clips.length === 1) filter = "";
  const total = clips.reduce((s, c) => s + c.durationSec, 0) - xf * (clips.length - 1);
  filter += `anullsrc=channel_layout=stereo:sample_rate=44100:duration=${total.toFixed(3)}[aout]`;
  const maps = ["-map", clips.length === 1 ? "0:v" : "[vout]", "-map", "[aout]"];
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
  const info = JSON.parse(probe.stdout.toString());
  const v = info.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  const a = info.streams.find((s: { codec_type: string }) => s.codec_type === "audio");
  if (v.codec_name !== "h264") throw new Error(`expected h264, got ${v.codec_name}`);

  const bytes = new Uint8Array(require("node:fs").readFileSync(mp4Path));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest: ProvenanceManifest = {
    spec: "hv-provenance/1.0",
    projectId: shots[0]?.id.split("-")[0] ?? "unknown",
    scriptSha256: createHash("sha256").update(shots.map((s) => s.prompt).join("\n")).digest("hex"),
    shots: clips.map((c, i) => ({ id: shots[i]?.id ?? `clip-${i}`, provider: c.provider, model: c.model, seed: c.seed, fingerprint: c.fingerprint })),
    assembledAt: "1970-01-01T00:00:00.000Z",
    credentials: { type: "c2pa-style", issuer: "hollywood-video-app", claim: `AI-generated video; content credentials sha256:${sha256}` },
  };
  const manifestPath = `${outDir}/provenance.json`;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  return {
    mp4Path, srtPath, vttPath, manifestPath, sha256,
    ffprobe: { codec: v.codec_name, fps: eval(v.r_frame_rate), durationSec: parseFloat(info.format.duration), audioCodec: a.codec_name },
    linkExpiresAt: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
    degradedShots,
  };
}
