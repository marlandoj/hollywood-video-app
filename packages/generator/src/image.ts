import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gateOrThrow } from "../../safety/src/index";
import type { ProviderRequestReceipt } from "./receipts";
import type { CostRecord } from "./index";

export interface IdentityConditioning {
  referenceFrames?: readonly string[];
  identityLocks?: readonly string[];
}

export interface FrameParams extends IdentityConditioning {
  onProviderRequest?: (receipt: ProviderRequestReceipt) => void | Promise<void>;
  widthxheight?: string;
  shotId?: string;
  sceneHeading?: string;
  action?: string;
  signal?: AbortSignal;
}

export interface StillFrame {
  path: string;
  provider: string;
  model: string;
  seed: number;
  fingerprint: string;
  cost: CostRecord;
}

export interface ImageProvider {
  readonly name: string;
  readonly model: string;
  estimateFrameUsd?(params: FrameParams): number;
  generateFrame(prompt: string, seed: number, params: FrameParams, outPath: string): Promise<StillFrame>;
}

export function parseFrameSize(size: string): [number, number] {
  const match = /^(\d{3,4})x(\d{3,4})$/.exec(size);
  if (!match) throw new Error("frame size must be WIDTHxHEIGHT");
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (width < 320 || height < 180 || width > 4096 || height > 4096 || width % 2 || height % 2) {
    throw new Error("frame dimensions must be even, between 320x180 and 4096x4096");
  }
  return [width, height];
}

function plainLabel(text: string, limit: number): string {
  const clean = Array.from(text, (char) => {
    const code = char.codePointAt(0)!;
    return code < 32 || (code >= 127 && code <= 159) ? " " : char;
  }).join("");
  return Array.from(clean.replace(/\s+/g, " ").trim()).slice(0, limit).join("");
}

function wrapLabel(text: string, columns: number): string {
  const chars = Array.from(text);
  const lines: string[] = [];
  while (chars.length) lines.push(chars.splice(0, columns).join(""));
  return lines.join("\n");
}

export class DeterministicMockImageProvider implements ImageProvider {
  readonly name = "mock";
  readonly model = "mock-storyboard-v1";

  async generateFrame(prompt: string, seed: number, params: FrameParams, outPath: string): Promise<StillFrame> {
    gateOrThrow([prompt, params.shotId ?? "", params.sceneHeading ?? "", params.action ?? ""].join("\n"));
    params.signal?.throwIfAborted();
    if (!Number.isSafeInteger(seed)) throw new Error("frame seed must be a safe integer");
    const [width, height] = parseFrameSize(params.widthxheight ?? "640x360");
    const fontSize = Math.max(12, Math.floor(Math.min(height / 20, width / 38)));
    const padding = Math.max(12, Math.floor(Math.min(width, height) / 18));
    const columns = Math.max(16, Math.floor((width - 2 * padding) / fontSize));
    const label = [
      plainLabel(params.shotId ?? "STORYBOARD", columns),
      wrapLabel(plainLabel(params.sceneHeading ?? "", 60), columns),
      wrapLabel(plainLabel(params.action ?? prompt, 80), columns),
    ].filter(Boolean).join("\n");
    const hash = createHash("sha256").update(JSON.stringify([this.model, prompt, seed, width, height, label])).digest();
    const color = `0x${hash.subarray(0, 3).toString("hex")}`;
    const scratch = mkdtempSync(join(tmpdir(), "hv-storyboard-"));
    try {
      writeFileSync(join(scratch, "label.txt"), label);
      const filter = [
        "drawbox=x=0:y=0:w=iw:h=ih:color=black@0.60:t=fill",
        `drawtext=font=DejaVu Sans:textfile=label.txt:expansion=none:fontcolor=white:fontsize=${fontSize}:line_spacing=4:x=${padding}:y=${padding}`,
      ].join(",");
      const child = Bun.spawn([
        "ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=${width}x${height}:r=1`,
        "-vf", filter, "-frames:v", "1", "-threads", "1", "-c:v", "png",
        "-fflags", "+bitexact", "-flags:v", "+bitexact", "-map_metadata", "-1", "frame.png",
      ], { cwd: scratch, stdout: "ignore", stderr: "pipe" });
      const abort = () => child.kill();
      params.signal?.addEventListener("abort", abort, { once: true });
      const timeout = setTimeout(() => child.kill(), 30_000);
      try {
        if (params.signal?.aborted) abort();
        const [exitCode, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
        params.signal?.throwIfAborted();
        if (exitCode !== 0) throw new Error(`storyboard render failed: ${stderr.slice(-400)}`);
      } finally {
        clearTimeout(timeout);
        params.signal?.removeEventListener("abort", abort);
      }
      const bytes = readFileSync(join(scratch, "frame.png"));
      params.signal?.throwIfAborted();
      const target = resolve(outPath);
      mkdirSync(dirname(target), { recursive: true });
      const staging = mkdtempSync(join(dirname(target), ".hv-frame-"));
      try {
        writeFileSync(join(staging, "frame.png"), bytes);
        renameSync(join(staging, "frame.png"), target);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
      return {
        path: outPath, provider: this.name, model: this.model, seed,
        fingerprint: createHash("sha256").update(bytes).digest("hex"),
        cost: {
          provider: this.name, model: this.model, prompt_tokens: Math.ceil(prompt.length / 4),
          output_frames: 1, gpu_seconds: 0, total_cost_usd: 0,
        },
      };
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }
}
