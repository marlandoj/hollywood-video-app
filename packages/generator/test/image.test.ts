import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeterministicMockImageProvider, type ImageProvider } from "../src/index";

const root = mkdtempSync(join(tmpdir(), "hv-image-test-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const provider: ImageProvider = new DeterministicMockImageProvider();
const params = { shotId: "shot-01", sceneHeading: "EXT. ZOO - DAY", action: "Spud waves to a giraffe." };

describe("storyboard image contract", () => {
  test("same inputs produce identical PNG bytes, seed changes output, and cost is zero", async () => {
    const a = await provider.generateFrame("A quiet zoo", 42, params, join(root, "a.png"));
    const b = await provider.generateFrame("A quiet zoo", 42, params, join(root, "b.png"));
    const c = await provider.generateFrame("A quiet zoo", 43, params, join(root, "c.png"));
    expect(readFileSync(a.path).equals(readFileSync(b.path))).toBe(true);
    expect(readFileSync(a.path).equals(readFileSync(c.path))).toBe(false);
    expect(a.fingerprint).toBe(createHash("sha256").update(readFileSync(a.path)).digest("hex"));
    expect(a.cost).toEqual({ provider: "mock", model: provider.model, prompt_tokens: 3, output_frames: 1, gpu_seconds: 0, total_cost_usd: 0 });
    const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-show_streams", "-of", "json", a.path]);
    expect(probe.exitCode).toBe(0);
    const stream = JSON.parse(probe.stdout.toString()).streams[0];
    expect([stream.codec_name, stream.width, stream.height]).toEqual(["png", 640, 360]);
  }, 20000);

  test("identity hooks are a deterministic no-op and never read reference paths", async () => {
    const a = await provider.generateFrame("A quiet zoo", 42, params, join(root, "identity-a.png"));
    const b = await provider.generateFrame("A quiet zoo", 42, {
      ...params, referenceFrames: ["/does/not/exist.png"], identityLocks: ["spud"],
    }, join(root, "identity-b.png"));
    expect(readFileSync(a.path).equals(readFileSync(b.path))).toBe(true);
  });

  test("labels affect rendered pixels and filter syntax stays literal", async () => {
    const a = await provider.generateFrame("A quiet zoo", 42, params, join(root, "label-a.png"));
    const b = await provider.generateFrame("A quiet zoo", 42, {
      ...params, action: "100% %{eif:1+1:d} ' : , [ ] \\ Spud smiles.\nNext line",
    }, join(root, "label-b.png"));
    expect(a.fingerprint).not.toBe(b.fingerprint);
    const changed = await provider.generateFrame("A quiet zoo", 42, {
      ...params, shotId: "shot-02", sceneHeading: "INT. HALL - NIGHT",
    }, join(root, "label-c.png"));
    expect(a.fingerprint).not.toBe(changed.fingerprint);
  });

  test("all prompt-bearing metadata is gated before output directories are created", async () => {
    const forbidden = "deepfake of a real celebrity, intimate scene";
    for (const field of ["prompt", "action", "sceneHeading", "shotId"]) {
      const target = join(root, `blocked-${field}`, "frame.png");
      await expect(provider.generateFrame(field === "prompt" ? forbidden : "A quiet zoo", 42,
        { ...params, ...(field === "prompt" ? {} : { [field]: forbidden }) }, target)).rejects.toThrow("content policy");
      expect(existsSync(join(root, `blocked-${field}`))).toBe(false);
    }
  });

  test("invalid dimensions, invalid seed, and pre-aborted requests produce no output", async () => {
    const target = join(root, "invalid", "frame.png");
    for (const widthxheight of ["nope", "321x180", "320x181", "640x9999", "100x100"]) {
      await expect(provider.generateFrame("A quiet zoo", 42, { widthxheight }, target)).rejects.toThrow("frame");
    }
    await expect(provider.generateFrame("A quiet zoo", NaN, {}, target)).rejects.toThrow("seed");
    await expect(provider.generateFrame("A quiet zoo", 42, { signal: AbortSignal.abort() }, target)).rejects.toThrow();
    expect(existsSync(join(root, "invalid"))).toBe(false);
  });

  test("cancelling an active render preserves the previous destination", async () => {
    const target = join(root, "cancelled.png");
    writeFileSync(target, "previous artifact");
    const controller = new AbortController();
    const pending = provider.generateFrame("A quiet zoo", 42, { ...params, signal: controller.signal }, target);
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(readFileSync(target, "utf8")).toBe("previous artifact");
  });

  test("minimum supported frame renders and text beyond the 80-character action limit does not change it", async () => {
    const action = "a".repeat(80);
    const a = await provider.generateFrame("A quiet zoo", 42, { ...params, widthxheight: "320x180", action }, join(root, "small-a.png"));
    const b = await provider.generateFrame("A quiet zoo", 42, { ...params, widthxheight: "320x180", action: action + "ignored" }, join(root, "small-b.png"));
    expect(a.fingerprint).toBe(b.fingerprint);
  });
});
