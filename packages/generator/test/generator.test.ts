import { describe, expect, test } from "bun:test";
import { DeterministicMockProvider, FailoverGenerator, checkContinuity, repairLoop } from "../src/index";

const TMP = "/tmp/hv-gen-test";

describe("provider adapter + deterministic mock", () => {
  test("same prompt/seed/params produce byte-identical clips", async () => {
    const p = new DeterministicMockProvider();
    const a = await p.generate("kitchen wide shot", 42, { seed: 42, durationSec: 1 }, `${TMP}/a.mp4`);
    const b = await p.generate("kitchen wide shot", 42, { seed: 42, durationSec: 1 }, `${TMP}/b.mp4`);
    const [ha, hb] = await Promise.all([Bun.file(a.path).arrayBuffer(), Bun.file(b.path).arrayBuffer()]);
    expect(Buffer.from(ha).equals(Buffer.from(hb))).toBe(true);
    expect(a.fingerprint).toBe(b.fingerprint);
  }, 20000);

  test("cost record carries the five required fields", async () => {
    const p = new DeterministicMockProvider({ costPerShotUsd: 0.12 });
    const clip = await p.generate("garden dusk", 7, { seed: 7, durationSec: 1 }, `${TMP}/c.mp4`);
    expect(clip.cost.provider).toBe("mock");
    expect(clip.cost.model).toBeTruthy();
    expect(clip.cost.prompt_tokens).toBeGreaterThan(0);
    expect(clip.cost.output_frames).toBe(30);
    expect(clip.cost.gpu_seconds).toBeGreaterThan(0);
    expect(clip.cost.total_cost_usd).toBe(0.12);
  }, 20000);

  test("prohibited prompt never reaches the provider", async () => {
    const p = new DeterministicMockProvider();
    await expect(p.generate("deepfake of a real celebrity, intimate scene", 1, { seed: 1 }, `${TMP}/x.mp4`)).rejects.toThrow("content policy");
  });
});

describe("provider failover (AC-026)", () => {
  test("primary failure retries on secondary before failing the job", async () => {
    const primary = new DeterministicMockProvider({ failEvery: 1 });
    const secondary = new DeterministicMockProvider();
    const fo = new FailoverGenerator(primary, secondary, 15000);
    const clip = await fo.generate("hall interior", 3, { seed: 3, durationSec: 1 }, `${TMP}/fo.mp4`);
    expect(clip.failedOver).toBe(true);
    expect(clip.provider).toBe("mock");
  }, 20000);
});

describe("continuity + repair loop (AC-012)", () => {
  const fakeClip = (fp: string) => ({ path: "", provider: "mock", model: "m", seed: 0, durationSec: 1, fingerprint: fp, cost: { provider: "mock", model: "m", prompt_tokens: 1, output_frames: 1, gpu_seconds: 0, total_cost_usd: 0 } });

  test("identical fingerprints score 1, inverted score 0", () => {
    const a = fakeClip("ff".repeat(32));
    expect(checkContinuity("s1", a, fakeClip("ff".repeat(32))).score).toBe(1);
    expect(checkContinuity("s2", a, fakeClip("00".repeat(32))).score).toBe(0);
  });

  test("repair retries at most twice then marks degraded with note and review flag", async () => {
    const prev = fakeClip("ff".repeat(32));
    const bad = fakeClip("00".repeat(32));
    const queue: { shotId: string; score: number }[] = [];
    let calls = 0;
    const { outcome } = await repairLoop("shot-9", prev, async () => { calls += 1; return bad; }, queue);
    expect(calls).toBe(3);
    expect(outcome.status).toBe("degraded");
    expect(outcome.note).toContain("continuity");
    expect(queue.length).toBe(1);
  });
});
