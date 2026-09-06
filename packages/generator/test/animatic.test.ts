import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RichAnimaticProvider, DeterministicMockImageProvider, sunkCostsOf } from "../src/index";
import { captionCues } from "../../planner/src/captions";
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
  test("explicit opposing pans move the same still in opposite directions for exactly 121 frames", async () => {
    const provider=new RichAnimaticProvider(new DeterministicMockImageProvider());
    const params={seed:7,durationSec:121/30,exactDuration:true,fps:30,widthxheight:"320x180"};
    const left=await provider.generate("A garden gate beside a tall tree",7,{...params,cameraMove:"pan-left"},join(root,"left.mp4"));
    const right=await provider.generate("A garden gate beside a tall tree",7,{...params,cameraMove:"pan-right"},join(root,"right.mp4"));
    const endpoints=(path:string)=>{const decoded=Bun.spawnSync(["ffmpeg","-v","error","-i",path,"-vf","select='eq(n,0)+eq(n,120)',scale=96:54","-fps_mode","passthrough","-pix_fmt","rgb24","-f","rawvideo","-"]);
      if(decoded.exitCode)throw new Error(decoded.stderr.toString());expect(decoded.stdout.length).toBe(96*54*3*2);return [decoded.stdout.subarray(0,96*54*3),decoded.stdout.subarray(96*54*3)] as const;};
    const [a,b]=endpoints(left.path),[c,d]=endpoints(right.path);
    const mse=(x:Uint8Array,y:Uint8Array)=>x.reduce((sum,value,index)=>sum+(value-y[index]!)**2,0)/x.length;
    const motion=mse(a,b);expect(motion).toBeGreaterThan(5);expect(mse(a,d)).toBeLessThan(motion/10);expect(mse(b,c)).toBeLessThan(motion/10);
    for(const clip of [left,right]){expect(clip.durationSec).toBe(121/30);expect(Number(probe(clip.path).streams.find((s:{codec_type:string})=>s.codec_type==="video").nb_frames)).toBe(121);}
    expect(readFileSync(left.posterPath!)).toEqual(readFileSync(right.posterPath!));
  },20000);

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
    const dialogue = [{ character: "SPUD", lines: ["Welcome to the zoo. We have plenty of time to see every animal before we go home today."] }];
    const a = await p.generate("A garden at dusk", 7, { seed: 7, durationSec: 3, widthxheight: "640x360", dialogue }, join(root, "voice.mp4"));
    const b = await p.generate("A quiet hall", 8, { seed: 8, durationSec: 2, widthxheight: "640x360" }, join(root, "silent.mp4"));
    const shots = [a, b].map((c, index) => ({ id: `shot-1-${index + 1}`, sceneIndex: 0, seed: index, prompt: "A quiet garden", durationSec: c.durationSec, dialogue: index === 0 ? dialogue : [] }));
    const output = assemble([a, b], shots, join(root, "export"), { crossfadeSec: 0, size: "640x360", fps: 30, burnInCaptions: true });
    expect(output.audioMode).toBe("provided");
    const audio = pcm(output.mp4Path);
    expect(audio.some(byte => byte !== 0)).toBe(true);
    expect(a.durationSec).toBeGreaterThan(3);
    expect(Math.abs(output.ffprobe.durationSec - a.durationSec - b.durationSec)).toBeLessThan(0.08);
    expect(readFileSync(output.vttPath, "utf8")).toContain("home today.");
    const cues = captionCues(dialogue, a.durationSec);
    expect(cues.length).toBeGreaterThan(1);
    for (const [index, cue] of cues.entries()) {
      expect(cue.text.split("\n").length).toBeLessThanOrEqual(2);
      expect(cue.text.split("\n").every(line => line.length <= 42)).toBe(true);
      expect(cue.endSec).toBeGreaterThan(cue.startSec);
      if (index > 0) expect(cue.startSec).toBe(cues[index - 1]!.endSec);
    }
    expect(cues.at(-1)!.endSec).toBe(a.durationSec);
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
