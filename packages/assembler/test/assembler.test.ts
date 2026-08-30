import { describe, expect, test } from "bun:test";
import { DeterministicMockProvider } from "../../generator/src/index";
import type { Shot } from "../../planner/src/index";
import { assemble, buildCaptions } from "../src/index";

const TMP = `/tmp/hv-asm-${Date.now()}`;

const shots: Shot[] = [
  { id: "shot-1-1", sceneIndex: 0, prompt: "INT. KITCHEN - DAY. Kettle.", dialogue: [{ character: "MARLA", lines: ["Tea time."] }], durationSec: 1, seed: 1 },
  { id: "shot-2-1", sceneIndex: 1, prompt: "EXT. GARDEN - DUSK. Hedge.", dialogue: [], durationSec: 1, seed: 2 },
];

describe("assembly + export (AC-013, AC-014)", () => {
  test("assembles with crossfade, passes ffprobe (h264+aac), captions present, re-export byte-identical", async () => {
    const p = new DeterministicMockProvider();
    const clips = [];
    for (const s of shots) {
      clips.push(await p.generate(s.prompt, s.seed, { seed: s.seed, durationSec: s.durationSec }, `${TMP}/clips/${s.id}.mp4`));
    }
    const r1 = assemble(clips, shots, `${TMP}/out1`, { crossfadeSec: 0.5 }, ["shot-2-1"]);
    expect(r1.ffprobe.codec).toBe("h264");
    expect(r1.ffprobe.audioCodec).toBe("aac");
    expect(await Bun.file(r1.srtPath).text()).toContain("MARLA: Tea time.");
    expect(await Bun.file(r1.vttPath).text()).toContain("WEBVTT");
    const manifest = JSON.parse(await Bun.file(r1.manifestPath).text());
    expect(manifest.credentials.type).toBe("c2pa-style");
    expect(manifest.shots.length).toBe(2);
    expect(r1.degradedShots).toContain("shot-2-1");
    const r2 = assemble(clips, shots, `${TMP}/out2`, { crossfadeSec: 0.5 }, ["shot-2-1"]);
    expect(r2.sha256).toBe(r1.sha256);
    expect(new Date(r1.linkExpiresAt).getTime()).toBeGreaterThan(Date.now() + 29 * 24 * 3600 * 1000);
  }, 60000);
});

describe("captions fallback", () => {
  test("no dialogue still yields captions (silent degradation path per ADR-0020)", () => {
    buildCaptions([{ id: "s", sceneIndex: 0, prompt: "x", dialogue: [], durationSec: 1, seed: 1 }], `${TMP}/f.srt`, `${TMP}/f.vtt`);
    expect(require("node:fs").readFileSync(`${TMP}/f.srt`, "utf8")).toContain("[no dialogue]");
  });
});
