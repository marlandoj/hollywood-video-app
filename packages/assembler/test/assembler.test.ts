import { describe, expect, test } from "bun:test";
import { DeterministicMockProvider } from "../../generator/src/index";
import type { Shot } from "../../planner/src/index";
import { assemble, buildCaptions, validateExport } from "../src/index";

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
    const r1 = assemble(clips, shots, `${TMP}/out1`, { crossfadeSec: 0.5, projectId: "project-abc" }, ["shot-2-1"]);
    expect(r1.ffprobe.codec).toBe("h264");
    expect(r1.ffprobe.audioCodec).toBe("aac");
    expect(r1.ffprobe.fps).toBe(30);
    expect(r1.ffprobe.width).toBe(1920);
    expect(r1.ffprobe.height).toBe(1080);
    expect(r1.ffprobe.bitrateBps).toBeGreaterThan(0);
    expect(r1.ffprobe.durationSec).toBeCloseTo(1.5, 0);
    expect(await Bun.file(r1.hlsPlaylistPath).text()).toContain("#EXTM3U");
    expect(await Bun.file(r1.srtPath).text()).toContain("MARLA: Tea time.");
    expect(await Bun.file(r1.vttPath).text()).toContain("WEBVTT");
    const manifest = JSON.parse(await Bun.file(r1.manifestPath).text());
    expect(manifest.credentials.type).toBe("c2pa-style");
    expect(manifest.projectId).toBe("project-abc");
    expect(manifest.shots.length).toBe(2);
    expect(r1.degradedShots).toContain("shot-2-1");
    expect(r1.audioMode).toBe("silent-captioned");
    const r2 = assemble(clips, shots, `${TMP}/out2`, { crossfadeSec: 0.5, projectId: "project-abc" }, ["shot-2-1"]);
    expect(r2.sha256).toBe(r1.sha256);
  }, 60000);
});

describe("ffprobe export gate checks every required property (FR-044)", () => {
  const good = {
    streams: [
      { codec_type: "video", codec_name: "h264", width: 1920, height: 1080, r_frame_rate: "30/1" },
      { codec_type: "audio", codec_name: "aac", sample_rate: "44100" },
    ],
    format: { duration: "1.500000", bit_rate: "512000" },
  };
  const expected = { width: 1920, height: 1080, fps: 30, durationSec: 1.5 };

  test("a conforming export reports codec, resolution, fps, duration, bitrate, and audio", () => {
    const probe = validateExport(good, expected);
    expect(probe).toEqual({ codec: "h264", width: 1920, height: 1080, fps: 30, durationSec: 1.5, bitrateBps: 512000, audioCodec: "aac", audioSampleRate: 44100 });
  });

  test("wrong resolution is rejected", () => {
    const wrong = { ...good, streams: [{ ...good.streams[0], width: 1280, height: 720 }, good.streams[1]] };
    expect(() => validateExport(wrong, expected)).toThrow("expected 1920x1080");
  });

  test("wrong frame rate is rejected", () => {
    const wrong = { ...good, streams: [{ ...good.streams[0], r_frame_rate: "24/1" }, good.streams[1]] };
    expect(() => validateExport(wrong, expected)).toThrow("expected 30 fps");
  });

  test("wrong duration is rejected", () => {
    expect(() => validateExport({ ...good, format: { ...good.format, duration: "4.0" } }, expected)).toThrow("expected 1.500s");
  });

  test("missing bitrate is rejected", () => {
    expect(() => validateExport({ ...good, format: { duration: "1.5" } }, expected)).toThrow("bitrate");
  });

  test("wrong audio codec or a missing audio stream is rejected", () => {
    expect(() => validateExport({ ...good, streams: [good.streams[0], { ...good.streams[1], codec_name: "mp3" }] }, expected)).toThrow("expected aac audio");
    expect(() => validateExport({ ...good, streams: [good.streams[0]] }, expected)).toThrow("no audio stream");
  });

  test("a non-h264 video stream is rejected", () => {
    expect(() => validateExport({ ...good, streams: [{ ...good.streams[0], codec_name: "hevc" }, good.streams[1]] }, expected)).toThrow("expected h264 video");
  });
});

describe("captions fallback", () => {
  test("no dialogue still yields captions (silent degradation path per ADR-0020)", () => {
    buildCaptions([{ id: "s", sceneIndex: 0, prompt: "x", dialogue: [], durationSec: 1, seed: 1 }], `${TMP}/f.srt`, `${TMP}/f.vtt`);
    expect(require("node:fs").readFileSync(`${TMP}/f.srt`, "utf8")).toContain("[no dialogue]");
  });
});
