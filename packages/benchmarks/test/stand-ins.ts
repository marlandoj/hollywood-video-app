/**
 * HV-037-02 test doubles. Local, synthetic video providers that render real files with ffmpeg, so
 * the measured score is computed from real pixels without any vendor call:
 *
 * - `ReferenceLoopProvider` with `conditioned: true` renders a shot that has a reference as that
 *   reference, held for the clip -- the best a reference-conditioned model could do. Without a
 *   reference it renders SMPTE bars, a structured picture unrelated to any character.
 * - With `conditioned: false` it takes no references at all, like a text-only model.
 * - `usdPerShot` prices it, so the ledger and declaration paths can be exercised at $0 real spend;
 *   `billedUsd` lets a test make it bill more than its own estimate.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { CostRecord, GenParams, ProviderAdapter, VideoClip } from "../../generator/src/index";
import { baseCapability, capability, type CapabilitySnapshot } from "../../generator/src/capabilities";

const run = (args: string[]) => {
  const result = Bun.spawnSync(["ffmpeg", "-v", "error", "-y", ...args], { timeout: 60_000 });
  if (result.exitCode !== 0) throw new Error("ffmpeg failed: " + result.stderr.toString().slice(-300));
};

export function writeReferences(dir: string): { KEEPER: string; SAILOR: string } {
  mkdirSync(dir, { recursive: true });
  const keeper = join(dir, "keeper.png"), sailor = join(dir, "sailor.png");
  run(["-f", "lavfi", "-i", "testsrc2=s=512x512:d=1", "-frames:v", "1", keeper]);
  run(["-f", "lavfi", "-i", "mandelbrot=s=512x512", "-frames:v", "1", sailor]);
  return { KEEPER: keeper, SAILOR: sailor };
}

export class ReferenceLoopProvider implements ProviderAdapter {
  readonly name: string;
  readonly model: string;
  readonly capabilities: CapabilitySnapshot;
  readonly calls: { prompt: string; references: number }[] = [];
  constructor(private readonly opts: { conditioned: boolean; usdPerShot?: number; billedUsd?: number; name?: string }) {
    this.name = opts.name ?? "stand-in";
    this.model = opts.conditioned ? "reference-loop-v1" : "text-only-bars-v1";
    const definition = baseCapability(this.name, this.model, "video");
    definition.synthetic = true;
    definition.region = "local";
    definition.output.nativeResolution = "requested";
    if (opts.conditioned) definition.input.referenceFrames = 4;
    if (opts.usdPerShot) definition.price = { ...definition.price, unit: "request", usd: opts.usdPerShot };
    this.capabilities = capability(definition);
  }
  async generate(prompt: string, seed: number, params: GenParams, outPath: string): Promise<VideoClip> {
    const references = params.referenceFrames ?? [];
    if (references.length && !this.opts.conditioned) throw new Error("This stand-in takes no references.");
    this.calls.push({ prompt, references: references.length });
    const size = params.widthxheight ?? "1280x720", durationSec = params.durationSec ?? 1;
    mkdirSync(dirname(outPath), { recursive: true });
    if (references.length) {
      const scratch = mkdtempSync(join(tmpdir(), "hv-standin-"));
      try {
        writeFileSync(join(scratch, "ref.png"), Buffer.from(references[0]!.slice("data:image/png;base64,".length), "base64"));
        run(["-loop", "1", "-i", join(scratch, "ref.png"), "-t", String(durationSec), "-r", "2", "-vf", `scale=${size.replace("x", ":")},format=yuv420p`,
          "-c:v", "libx264", "-preset", "ultrafast", outPath]);
      } finally { rmSync(scratch, { recursive: true, force: true }); }
    } else {
      run(["-f", "lavfi", "-i", `smptebars=s=${size}:r=2:d=${durationSec}`, "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", outPath]);
    }
    const cost: CostRecord = { provider: this.name, model: this.model, prompt_tokens: 0, output_frames: Math.round(2 * durationSec), gpu_seconds: 0,
      total_cost_usd: this.opts.billedUsd ?? this.opts.usdPerShot ?? 0 };
    return { path: outPath, provider: this.name, model: this.model, seed, durationSec, fingerprint: "0".repeat(64), cost };
  }
}
