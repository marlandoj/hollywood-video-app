/**
 * HV-025-13 (Release 3 step 12, part two; part HV-025.vfx-composite, surface desk-api): the Editor
 * composites one element over a shot of the mock film through the Director's desk's own routes, the
 * render runs on the studio's machine at $0, and the export's pixels, its job view and its
 * provenance all say what was composited over what.
 */
import {expect, test} from "bun:test";
import {readFileSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, sep} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspected as inspectedSource} from "../../../test/fixtures/editorial-inspection";
import {EDIT_COMPOSITE_LIMITS} from "../../planner/src/edit-composite-types";
import {VFX_COMPOSITE_SCHEMA, VFX_MATTE_ID, vfxCompositeLabel, vfxCompositeOperation, vfxComposites} from "../../planner/src/crew/vfx-composite";

const WIDTH = 640, HEIGHT = 360, AT = 20, FRAMES = 30, FROM = 120, OPACITY = 0.75;
/** The element's top-left text block (its slate's shot id, heading and action line), moved down half a frame. */
const MATTE = {xQ16: 0, yQ16: 0, widthQ16: 39322, heightQ16: 19661}, DROP = HEIGHT / 2;
const cleanup = (path: string) => { const root = realpathSync(path); if (!root.startsWith(realpathSync(tmpdir()) + sep + "hv-dub-studio-")) throw new Error("Unsafe VFX fixture cleanup."); rmSync(root, {recursive: true, force: true}); };
function frame(path: string, n: number): Uint8Array {
  const out = Bun.spawnSync(["ffmpeg", "-v", "error", "-nostdin", "-threads", "1", "-i", path, "-vf", `select=eq(n\\,${n})`, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]);
  if (out.exitCode !== 0 || out.stdout.length !== WIDTH * HEIGHT * 3) throw new Error("Could not sample frame " + n + ": " + out.stderr.toString());
  return new Uint8Array(out.stdout);
}
/** Mean absolute difference over a region, `expected` computed per pixel from the plate and element frames. */
function region(actual: Uint8Array, expected: (x: number, y: number, c: number) => number, x0: number, y0: number, x1: number, y1: number): number {
  let sum = 0, count = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) for (let c = 0; c < 3; c++) { sum += Math.abs(actual[(y * WIDTH + x) * 3 + c]! - expected(x, y, c)); count++; }
  return sum / count;
}
const at = (pixels: Uint8Array) => (x: number, y: number, c: number) => pixels[(y * WIDTH + x) * 3 + c]!;

test("the Editor composites a masked element over a shot on the desk, rendered at $0, with its inputs, matte and edit on the record", async () => {
  const f = await dubStudio();
  try {
    const base = f.base + "/editorial", call = (path: string, method = "GET", body?: unknown, token: string | undefined = f.owner.token) => f.call(base + path, method, body, token);
    const source = (await inspectedSource(async suffix => await (await call(suffix)).json() as any, "/sources/" + f.film.id)).sources[0];
    const created = await call("/sequences", "POST", {id: "crew-vfx-" + f.film.id.slice(0, 8), label: "Editor: VFX composite", sources: [{jobId: f.film.id, sourceRevision: source.sourceRevision}],
      firstSourceId: f.film.id, width: WIDTH, height: HEIGHT, expectedVersion: 0});
    expect(created.status).toBe(201);
    let state = await created.json() as any;
    const path = "/sequences/" + state.sequence.id;
    expect(state.timeline.frames).toBeGreaterThan(FROM + FRAMES);

    // The Editor's tool: the second shot's text block keyed over the first shot, moved down, at 75%.
    const {operation, timeline} = vfxCompositeOperation(state.timeline, {clipId: "crew-vfx", plateClipId: "initial-0", elementSourceId: f.film.id, at: AT, frames: FRAMES, from: FROM,
      mask: {kind: "rectangle", box: MATTE}, opacity: OPACITY, placement: {xQ16: 0, yQ16: 32768, scaleQ16: 65536, rotationMilliDegrees: 0}});
    const label = vfxCompositeLabel("shot-1-2", "shot-1-1"), patch = (op: unknown, token?: string) => call(path, "PATCH",
      {expectedVersion: state.libraryVersion, expectedHistoryRevision: state.sequence.history.revision, change: {kind: "edit", label, operation: op}}, token);

    // Refused: no caller, and another project's owner. Nothing is saved.
    expect((await patch(operation, "")).status).toBe(401);
    const stranger = await (await f.call("/api/projects", "POST")).json() as {projectId: string; token: string};
    const foreign = await patch(operation, stranger.token);
    expect([401, 403, 404]).toContain(foreign.status);
    // Validated like a creator's edit: what the desk refuses from a creator it refuses from the crew.
    const tooSoft = structuredClone(operation);
    tooSoft.clips[0]!.composite!.masks![0]!.featherQ8 = EDIT_COMPOSITE_LIMITS.featherMaxQ8 + 1;
    expect((await patch(tooSoft)).status).toBe(400);
    expect((await (await call(path)).json() as any).sequence.history.revision).toBe(state.sequence.history.revision);

    const saved = await patch(operation);
    expect(await saved.clone().text()).not.toContain('"error"');
    expect(saved.status).toBe(200);
    state = await saved.json();
    expect(state.timeline.revision).toBe(timeline.revision);

    // Rendered on the studio's own machine, through the desk's own review and admission.
    const quote = await (await call(path + "/renders")).json() as any;
    expect(quote.compositing.clips[0].maskCount).toBe(1);
    const queued = await call(path + "/renders", "POST", {idempotencyKey: "crew-vfx-" + f.film.id, generationApproved: true, historyRevision: state.sequence.history.revision,
      sourceBindingsRevision: quote.sourceBindingsRevision, engineVersion: quote.engineVersion, review: {...quote.review, accepted: true}});
    expect(queued.status).toBe(202);
    const done = (await f.worker())!;
    expect(done.failureReason ?? done.cancelReason).toBeUndefined();
    expect(done.status).toBe("done");
    expect(done.stage).toBe("picture-edit");
    expect(done.costUsd ?? 0).toBe(0);
    expect(f.ledger.monthSpend()).toBe(0);

    // The pixels: the plate outside the matte and outside the window, the element blended inside it.
    const exported = join(f.paths.artifactRoot, done.output!.mp4Path), film = join(f.paths.artifactRoot, f.film.output!.mp4Path);
    const n = AT + 15, out = frame(exported, n), plate = frame(film, n), element = frame(film, FROM + 15), weight = Math.floor(255 * OPACITY) / 255;
    const top = Math.round(MATTE.yQ16 / 65536 * HEIGHT) + DROP, bottom = Math.round((MATTE.yQ16 + MATTE.heightQ16) / 65536 * HEIGHT) + DROP, right = Math.round(MATTE.widthQ16 / 65536 * WIDTH);
    const blended = (x: number, y: number, c: number) => at(plate)(x, y, c) * (1 - weight) + at(element)(x, y - DROP, c) * weight;
    const inside = region(out, blended, 4, top + 4, right - 4, bottom - 4);
    expect(inside).toBeLessThan(6);
    // ...and the matte held something the plate does not (the element's text): this is not a plate passed through.
    const text: [number, number][] = [];
    for (let y = top + 4; y < bottom - 4; y++) for (let x = 4; x < right - 4; x++) if (Math.abs(blended(x, y, 1) - at(plate)(x, y, 1)) > 60) text.push([x, y]);
    expect(text.length).toBeGreaterThan(1000);
    const mean = (expected: (x: number, y: number, c: number) => number) => text.reduce((sum, [x, y]) => sum + Math.abs(at(out)(x, y, 1) - expected(x, y, 1)), 0) / text.length;
    expect(mean(blended)).toBeLessThan(20);
    expect(mean(at(plate))).toBeGreaterThan(60);
    // Outside the matte: above it (where the element's own text would be without the matte's move), right of it, below it.
    expect(region(out, at(plate), 0, 0, WIDTH, top - 4)).toBeLessThan(4);
    expect(region(out, at(plate), right + 4, top, WIDTH, bottom)).toBeLessThan(4);
    expect(region(out, at(plate), 0, bottom + 4, WIDTH, HEIGHT)).toBeLessThan(4);
    // Outside the window the shot is untouched.
    for (const m of [AT - 10, AT + FRAMES + 10]) expect(region(frame(exported, m), at(frame(film, m)), 0, 0, WIDTH, HEIGHT)).toBeLessThan(4);

    // The record, in the job view and in the provenance the render wrote, names each input, the matte and the edit.
    const view = await (await f.call("/api/jobs/" + done.id, "GET", undefined, f.owner.token)).json() as any;
    const vfx = view.pictureEdit.vfx;
    expect((await f.call("/api/jobs/" + done.id, "GET", undefined, stranger.token)).status).toBe(404);
    expect((await f.call("/api/jobs/" + done.id)).status).toBe(404);
    expect(vfx.schema).toBe(VFX_COMPOSITE_SCHEMA);
    expect(vfx).toMatchObject({sequenceId: state.sequence.id, historyRevision: state.sequence.history.revision, timelineRevision: timeline.revision});
    expect(vfx.composites).toHaveLength(1);
    const [composite] = vfx.composites;
    expect(composite.window).toEqual({at: AT, frames: FRAMES});
    expect(composite.plates).toEqual([expect.objectContaining({clipId: "initial-0", jobId: f.film.id, stage: f.film.stage, sourceRevision: source.sourceRevision, media: "film", layer: 0})]);
    expect(composite.element).toMatchObject({clipId: "crew-vfx", jobId: f.film.id, sourceRevision: source.sourceRevision, layer: 1, at: AT, from: FROM, frames: FRAMES});
    expect(composite.matte).toEqual({masks: [{id: VFX_MATTE_ID, kind: "rectangle", combine: "replace", invert: false, featherQ8: 0, keys: 1}], track: null});
    expect(composite.opacity).toBe(OPACITY);
    expect(composite.placement).toEqual({xQ16: 0, yQ16: 32768, scaleQ16: 65536, rotationMilliDegrees: 0});
    expect(composite.operation).toMatchObject({event: 1, kind: "insert", label});
    const provenance = JSON.parse(readFileSync(join(f.paths.artifactRoot, done.output!.manifestPath), "utf8"));
    expect(vfxComposites(provenance.plan)).toEqual(vfx);
    // The result is a cut like any other: its export, its captions and its stream.
    expect(view.output.mp4Url).toBeTruthy();
    expect(done.output!.hlsPlaylistPath).toMatch(/hls\/index\.m3u8$/);
  } finally {
    await f.close(false);
    cleanup(f.root);
  }
}, 240000);
