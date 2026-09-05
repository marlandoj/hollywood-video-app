import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RichAnimaticProvider, DeterministicMockImageProvider, sunkCostsOf } from "../src/index";
import { assemble } from "../../assembler/src/index";

const root = mkdtempSync(join(tmpdir(), "hv-animatic-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
function probe(path: string) {
  const p = Bun.spawnSync(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", path]);
  if (p.exitCode) throw new Error(p.stderr.toString());
  return JSON.parse(p.stdout.toString());
}
function pcm(path: string) {
  const p = Bun.spawnSync(["ffmpeg", "-v", "error", "-i", path, "-map", "0:a:0", "-f", "s16le", "-"]);
  if (p.exitCode) throw new Error(p.stderr.toString());
  return p.stdout;
}
describe("rich animatic", () => {
  test("frame count, H264 format, poster and zero-cost deterministic motion", async () => {
    const p = new RichAnimaticProvider(new DeterministicMockImageProvider());
    const params = { seed: 7, durationSec: 1.25, fps: 24, widthxheight: "320x180", shotId: "shot-1-1", cameraMove: "push-in" as const };
    const a = await p.generate("A garden at dusk", 7, params, join(root, "a.mp4"));
    const b = await p.generate("A garden at dusk", 7, params, join(root, "b.mp4"));
    expect(readFileSync(a.path).equals(readFileSync(b.path))).toBe(true);
    const v = probe(a.path).streams.find((s: { codec_type: string }) => s.codec_type === "video");
    expect([v.codec_name, v.pix_fmt, Number(v.nb_frames)]).toEqual(["h264", "yuv420p", 30]);
    expect(a.durationSec).toBe(1.25);
    expect(a.cost.total_cost_usd).toBe(0);
    expect(a.posterPath).toBeTruthy();
  }, 20000);

  test("temporary speech and captions render, and assembled export preserves audible audio", async () => {
    const p = new RichAnimaticProvider(new DeterministicMockImageProvider(), { narration: true, captions: true });
    const dialogue = [{ character: "SPUD", lines: ["Welcome to the zoo."] }];
    const a = await p.generate("A garden at dusk", 7, { seed: 7, durationSec: 3, widthxheight: "640x360", dialogue }, join(root, "voice.mp4"));
    const b = await p.generate("A quiet hall", 8, { seed: 8, durationSec: 2, widthxheight: "640x360" }, join(root, "silent.mp4"));
    const shots = [a, b].map((c, index) => ({ id: `shot-1-${index + 1}`, sceneIndex: 0, seed: index, prompt: "A quiet garden", durationSec: c.durationSec, dialogue: index === 0 ? dialogue : [] }));
    const output = assemble([a, b], shots, join(root, "export"), { crossfadeSec: 0, size: "640x360", fps: 30 });
    expect(output.audioMode).toBe("provided");
    const audio = pcm(output.mp4Path);
    expect(audio.some(byte => byte !== 0)).toBe(true);
    expect(Math.abs(output.ffprobe.durationSec - 5)).toBeLessThan(0.08);
    expect(readFileSync(output.vttPath, "utf8")).toContain("00:00:03.000");
  }, 30000);

  test("dialogue is gated before image inference and render failure carries frame cost", async () => {
    let called = 0;
    const mock = new DeterministicMockImageProvider();
    const image = { name: "test", model: "fixture", generateFrame: async (...args: Parameters<typeof mock.generateFrame>) => {
      called++;
      const frame = await mock.generateFrame(...args);
      return { ...frame, cost: { ...frame.cost, total_cost_usd: 0.02 } };
    } };
    const p = new RichAnimaticProvider(image);
    await expect(p.generate("A garden", 7, { seed: 7, dialogue: [{ character: "SPUD", lines: ["deepfake of a real celebrity"] }] }, join(root, "unsafe.mp4"))).rejects.toThrow("content policy");
    expect(called).toBe(0);
    const controller = new AbortController();
    const images = { ...image, generateFrame: async (...args: Parameters<typeof mock.generateFrame>) => {
      const frame = await image.generateFrame(...args); controller.abort(); return frame;
    } };
    let error: unknown;
    try { await new RichAnimaticProvider(images).generate("A garden", 7, { seed: 7, signal: controller.signal }, join(root, "cancel.mp4")); } catch (err) { error = err; }
    expect(sunkCostsOf(error).map(c => c.total_cost_usd)).toEqual([0.02]);
  });
});
