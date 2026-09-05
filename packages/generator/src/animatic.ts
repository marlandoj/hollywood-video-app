import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { gateOrThrow } from "../../safety/src/index";
import { captionCues } from "../../planner/src/captions";
import { frameFingerprint } from "./fal";
import { parseFrameSize, type ImageProvider } from "./image";
import { sunkCostsOf, type GenParams, type ProviderAdapter, type VideoClip } from "./index";

export type CameraMove = "static" | "push-in" | "pull-out" | "pan-left" | "pan-right";
const MOVES: CameraMove[] = ["push-in", "pull-out", "pan-left", "pan-right"];

async function command(args: string[], cwd: string, signal?: AbortSignal): Promise<void> {
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

export class RichAnimaticProvider implements ProviderAdapter {
  readonly name = "rich-animatic";
  readonly model: string;
  constructor(readonly images: ImageProvider, private options: { narration?: boolean; captions?: boolean } = {}) {
    this.model = `animatic-v1/${images.model}`;
  }

  estimateShotUsd(params: GenParams): number {
    return this.images.name === "mock" ? 0 : this.images.estimateFrameUsd?.(params) ?? Infinity;
  }

  async generate(prompt: string, seed: number, params: GenParams, outPath: string): Promise<VideoClip> {
    const dialogue = (params.dialogue ?? []).map(d => `${d.character}: ${d.lines.join(" ")}`).join("\n");
    gateOrThrow([prompt, params.shotId ?? "", params.sceneHeading ?? "", params.action ?? "", dialogue].join("\n"));
    params.signal?.throwIfAborted();
    const [width, height] = parseFrameSize(params.widthxheight ?? "640x360");
    const fps = params.fps ?? 30, requestedDuration = params.durationSec ?? 2;
    if (!Number.isInteger(fps) || fps < 1 || fps > 60 || !Number.isFinite(requestedDuration) || requestedDuration < 0.1 || requestedDuration > 30) {
      throw new Error("animatic requires 1-60 fps and a duration from 0.1 to 30 seconds");
    }
    let frames = Math.max(1, Math.round(fps * requestedDuration)), durationSec = frames / fps;
    const digest = createHash("sha256").update(`${prompt}|${seed}`).digest();
    const move = params.cameraMove ?? MOVES[digest[0]! % MOVES.length]!;
    if (!["static", ...MOVES].includes(move)) throw new Error("unknown animatic camera move");
    const target = resolve(outPath);
    mkdirSync(dirname(target), { recursive: true });
    const scratch = mkdtempSync(join(dirname(target), ".hv-animatic-"));
    let frame: Awaited<ReturnType<ImageProvider["generateFrame"]>> | undefined;
    try {
      const voice = this.options.narration && dialogue.length > 0;
      if (voice) {
        writeFileSync(join(scratch, "dialogue.txt"), dialogue);
        await command(["espeak-ng", "-b", "1", "-v", "en", "-s", "175", "-f", "dialogue.txt", "-w", "voice.wav"], scratch, params.signal);
        const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", join(scratch, "voice.wav")]);
        const voiceDuration = Number(probe.stdout.toString().trim());
        if (probe.exitCode !== 0 || !Number.isFinite(voiceDuration) || voiceDuration <= 0 || voiceDuration > 600) throw new Error("temporary dialogue must fit within ten minutes per shot");
        frames = Math.max(frames, Math.ceil((voiceDuration + 0.3) * fps));
        durationSec = frames / fps;
      }
      frame = await this.images.generateFrame(prompt, seed, { ...params, widthxheight: `${width}x${height}` }, join(scratch, "frame.png"));
      const progress = `on/${Math.max(1, frames - 1)}`;
      const z = move === "push-in" ? `1+0.08*${progress}` : move === "pull-out" ? `1.08-0.08*${progress}` : move === "static" ? "1" : "1.08";
      const x = move === "pan-left" ? `(iw-iw/zoom)*(1-${progress})` : move === "pan-right" ? `(iw-iw/zoom)*${progress}` : "iw/2-iw/zoom/2";
      const filters = [`scale=${width * 2}:${height * 2}`,
        `zoompan=z='${z}':x='${x}':y='ih/2-ih/zoom/2':d=${frames}:s=${width}x${height}:fps=${fps}`];
      if (this.options.captions && dialogue) {
        for (const [index, cue] of captionCues(params.dialogue ?? [], durationSec).entries()) {
          writeFileSync(join(scratch, `caption-${index}.txt`), cue.text);
          filters.push(`drawtext=font=DejaVu Sans:textfile=caption-${index}.txt:expansion=none:fontcolor=white:fontsize=${Math.max(12, Math.round(width / 32))}:box=1:boxcolor=black@0.7:boxborderw=8:x=(w-text_w)/2:y=h-text_h-16:enable='gte(t,${cue.startSec})*lt(t,${cue.endSec})'`);
        }
      }
      await command([
        "ffmpeg", "-y", "-v", "error", "-i", "frame.png",
        ...(voice ? ["-i", "voice.wav"] : ["-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo"]),
        "-vf", filters.join(","), "-af", "apad", "-t", String(durationSec), "-frames:v", String(frames),
        "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "128k", "-ar", "44100", "-ac", "2",
        "-fflags", "+bitexact", "-flags:v", "+bitexact", "-flags:a", "+bitexact", "-map_metadata", "-1", "clip.mp4",
      ], scratch, params.signal);
      params.signal?.throwIfAborted();
      const fingerprint = frameFingerprint(join(scratch, "clip.mp4"), durationSec / 2);
      renameSync(join(scratch, "frame.png"), `${target}.png`);
      renameSync(join(scratch, "clip.mp4"), target);
      return { path: outPath, provider: this.name, model: this.model, seed, durationSec, fingerprint,
        posterPath: `${target}.png`, audioMode: voice ? "provided" : "silent-captioned",
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
