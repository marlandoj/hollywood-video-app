/**
 * HV-030-30 — the assembler joins a feature's sequence films into one film (Release 3 step 7).
 *
 * Real ffmpeg on small synthetic films: three "sequence films" with sound and captions, an RGBA title
 * graphic and an opaque credits card like the graphics path renders. The joined film is the films'
 * length less a 0.4 s dissolve at each join plus the credits, its sound runs the whole length, its
 * captions sit where each film does, the title shows over the start only, the credits close it, and it
 * is signed beside its record when a (throwaway) key is configured, unsigned when none is.
 */
import {afterAll, expect, test} from "bun:test";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {assembleFeatureFilm, featureCaptions, featureFilmFilter, vttCues} from "../src/feature-film";
import {verifyC2paSidecar} from "../src/c2pa";
import {makeC2paTestIdentity} from "./c2pa-fixture";

const TMP = mkdtempSync(join(tmpdir(), "hv-feature-film-"));
afterAll(() => rmSync(TMP, {recursive: true, force: true}));
const run = (args: string[]) => {const result = Bun.spawnSync(args); if (result.exitCode) throw new Error(result.stderr.toString()); return result.stdout;};
const W = 320, H = 180;

/** A film of `seconds` at 30 fps: a flat colour, a tone, and one caption. */
function film(name: string, seconds: number, color: string, caption: string, sound = true) {
  const path = join(TMP, name + ".mp4"), captions = join(TMP, name + ".vtt");
  run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=${W}x${H}:r=30:d=${seconds}`, ...(sound ? ["-f", "lavfi", "-i", `sine=frequency=440:sample_rate=44100:duration=${seconds}`] : []),
    "-c:v", "libx264", "-pix_fmt", "yuv420p", ...(sound ? ["-c:a", "aac"] : []), "-shortest", path]);
  const at = (value: number) => "00:00:" + value.toFixed(3).padStart(6, "0");
  writeFileSync(captions, `WEBVTT\n\n${at(0.2)} --> ${at(0.9)}\n${caption}\n\n${at(seconds - 0.1)} --> ${at(seconds + 1)}\nlast words\n`);
  return {path, captionsPath: captions};
}
/** A graphic master like the graphics path's: FFV1 with alpha. */
function graphic(name: string, frames: number, background: string) {
  const path = join(TMP, name + ".mkv");
  run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", `color=c=red:s=80x40:r=30,format=rgba,pad=${W}:${H}:0:0:color=${background}`,
    "-frames:v", String(frames), "-c:v", "ffv1", "-pix_fmt", "bgra", path]);
  return {path, frames};
}
/** The picture at `at` seconds, as one RGB pixel at (x, y). */
function pixel(path: string, at: number, x: number, y: number): number[] {
  const raw = run(["ffmpeg", "-v", "error", "-ss", String(at), "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  const offset = (y * W + x) * 3;
  return [raw[offset]!, raw[offset + 1]!, raw[offset + 2]!];
}
const durations = (path: string) => {
  const info = JSON.parse(run(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,duration:format=duration", "-of", "json", path]).toString());
  return {format: Number(info.format.duration), audio: Number(info.streams.find((stream: {codec_type: string}) => stream.codec_type === "audio").duration)};
};

test("three films join into one film: the dissolves, the title over the start, the credits after, the sound and captions throughout, signed", async () => {
  const identity = makeC2paTestIdentity(join(TMP, "identity"));
  const films = [film("one", 2, "blue", "first"), film("two", 3, "green", "second", false), film("three", 2.5, "yellow", "third")];
  const outDir = join(TMP, "signed");
  const result = await assembleFeatureFilm({films, title: graphic("title", 30, "black@0"), credits: graphic("credits", 45, "0x111318"), width: W, height: H, crossfadeFrames: 12, outDir,
    projectId: "p1", assembledAt: "2026-10-04T00:00:00.000Z", record: {join: {schema: "hv-feature-join/1", sequences: [1, 2, 3]}}, c2pa: {keyPath: identity.keyPath, certPath: identity.chainPath}});
  // The films (7.5 s) less two 0.4 s dissolves, plus 1.5 s of credits.
  expect(result.crossfadeSec).toBe(0.4);
  expect(result.durationSec).toBeCloseTo(7.5 - 0.8 + 1.5, 6);
  const measured = durations(result.mp4Path);
  expect(Math.abs(measured.format - 8.2)).toBeLessThan(0.1);
  expect(Math.abs(measured.audio - measured.format)).toBeLessThan(0.1);
  expect(result.ffprobe).toMatchObject({codec: "h264", width: W, height: H, fps: 30, audioCodec: "aac"});
  expect(result.films.map(value => [Number(value.durationSec.toFixed(1)), value.audio])).toEqual([[2, true], [3, false], [2.5, true]]);

  // The title is over the start only; each film shows in its place; the credits close the film.
  expect(pixel(result.mp4Path, 0.5, 20, 20)[0]).toBeGreaterThan(180);            // title box, red
  expect(pixel(result.mp4Path, 0.5, 200, 120)[2]).toBeGreaterThan(150);          // sequence 1 under it, blue
  expect(pixel(result.mp4Path, 1.4, 20, 20)[2]).toBeGreaterThan(150);            // title gone after 1 s
  expect(pixel(result.mp4Path, 3, 200, 120)[1]).toBeGreaterThan(80);             // sequence 2, green
  expect(pixel(result.mp4Path, 6, 200, 120).slice(0, 2).every(value => value > 150)).toBe(true); // sequence 3, yellow
  expect(pixel(result.mp4Path, 7.8, 200, 120).every(value => value < 40)).toBe(true);            // the credits card

  // Captions where each film starts in the feature (0, 1.6, 4.2), cut to the part each film keeps.
  expect(vttCues(readFileSync(result.vttPath, "utf8"))).toEqual([
    {start: 0.2, end: 0.9, text: "first"}, {start: 1.8, end: 2.5, text: "second"}, {start: 1.9, end: 2, text: "last words"},
    {start: 4.4, end: 5.1, text: "third"}, {start: 4.5, end: 4.6, text: "last words"}, {start: 6.6, end: 6.7, text: "last words"}]);

  // Signed beside its record, bound to this MP4.
  const record = JSON.parse(readFileSync(result.manifestPath, "utf8"));
  expect(record).toMatchObject({spec: "hv-feature-film-result/1", projectId: "p1", assembledAt: "2026-10-04T00:00:00.000Z", join: {schema: "hv-feature-join/1"}, crossfadeSec: 0.4, creditsSec: 1.5});
  expect(record.credentials.type).toBe("c2pa-sidecar");
  expect(result.c2paPath).toBe(join(outDir, "provenance.c2pa"));
  const verified = await verifyC2paSidecar(result.mp4Path, readFileSync(result.c2paPath!), identity.anchorPem);
  expect({state: verified.state, codes: verified.codes}).toEqual({state: "Trusted", codes: []});
  expect(verified.provenance).toMatchObject({spec: "hv-feature-film-result/1", projectId: "p1", mp4Sha256: result.sha256});
  expect(readFileSync(result.hlsPlaylistPath, "utf8")).toContain("#EXT-X-ENDLIST");
}, 120000);

test("without a key the film is unsigned and says so; a film too short to dissolve joins with a cut; no title or credits is a plain join", async () => {
  const films = [film("short-a", 0.5, "red", "a"), film("short-b", 1, "blue", "b")];
  const result = await assembleFeatureFilm({films, title: null, credits: null, width: W, height: H, crossfadeFrames: 12, outDir: join(TMP, "unsigned"), projectId: "p1",
    assembledAt: "2026-10-04T00:00:00.000Z", record: {}, c2pa: null});
  expect(result.crossfadeSec).toBe(0);
  expect(Math.abs(durations(result.mp4Path).format - 1.5)).toBeLessThan(0.1);
  expect(result.c2paPath).toBeUndefined();
  expect(JSON.parse(readFileSync(result.manifestPath, "utf8")).credentials.type).toBe("c2pa-style");
});

test("the filter graph and the captions are the join's, piece by piece", () => {
  const filter = featureFilmFilter([{durationSec: 10, audio: true}, {durationSec: 8, audio: false}], 0.4, {width: 1280, height: 720}, 2, {input: 3, seconds: 6});
  expect(filter).toContain("[v0][v1]xfade=transition=fade:duration=0.4:offset=9.600[vj]");
  expect(filter).toContain("[a0][a1]acrossfade=d=0.4[aj]");
  expect(filter).toContain("anullsrc=channel_layout=stereo:sample_rate=48000,atrim=duration=8[a1]");
  expect(filter).toContain("[vj][title]overlay=0:0:eof_action=pass:format=auto,format=yuv420p[vt]");
  expect(filter).toContain("[vt][aj][vc][ac]concat=n=2:v=1:a=1[vout][aout]");
  expect(featureFilmFilter([{durationSec: 1, audio: true}, {durationSec: 1, audio: true}], 0, {width: 64, height: 64}, null, null)).toContain("[v0][a0][v1][a1]concat=n=2:v=1:a=1[vj][aj]");
  expect(vttCues("WEBVTT\n\n00:00:00.000 --> 00:00:01.000\n[no dialogue]\n")).toEqual([]);
  expect(featureCaptions([{cues: [{start: 0, end: 3, text: "x"}], start: 5, durationSec: 2}])).toEqual([{start: 5, end: 7, text: "x"}]);
});
