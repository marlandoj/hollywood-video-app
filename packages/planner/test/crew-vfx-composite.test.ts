/**
 * HV-025-13: the Editor's VFX composite is one insert a creator could have saved, validated by the
 * desk's own `applyEditOperation`, and a picture edit holding one says which inputs, matte and edit
 * made it. An edit without one reads exactly as before.
 */
import {expect, test} from "bun:test";
import {contentHash} from "../../generator/src/capabilities";
import {EditConflict, applyEditOperation, editTimeline, initialEditTimeline, type EditSource, type EditTimeline} from "../src/edit-timeline";
import {EDIT_COMPOSITE_LIMITS} from "../src/edit-composite-types";
import {appendEdit, createEditHistory, editHistoryState, moveEditCursor} from "../src/edit-history";
import type {EditSourceBinding} from "../src/edit-jobs";
import {VFX_COMPOSITE_SCHEMA, VFX_MATTE_ID, vfxCompositeLabel, vfxCompositeOperation, vfxComposites, type VfxCompositeRequest} from "../src/crew/vfx-composite";
// @ts-expect-error -- the Editor's title helpers are a plain browser module with no type declarations.
import {titleOperation} from "../../frontend/src/titles.js";

const source = (id: string, frames: number, media?: "graphic-rgba"): EditSource =>
  ({id, revision: contentHash(id), label: id, frames, width: 64, height: 36, audio: [], captions: [], voices: [], unmeasuredAudio: false, ...(media ? {media} : {})});
const PLATE = source("plate-job", 90), STILL = source("still-job", 30, "graphic-rgba");
const box = {xQ16: 0, yQ16: 0, widthQ16: 32768, heightQ16: 32768};
const request = (over: Partial<VfxCompositeRequest> = {}): VfxCompositeRequest => ({clipId: "vfx-1", plateClipId: "initial-0", elementSourceId: STILL.id,
  at: 30, frames: 20, from: 4, mask: {kind: "ellipse", box, featherQ8: 512}, opacity: 0.75, placement: {xQ16: 16384, yQ16: 0, scaleQ16: 65536, rotationMilliDegrees: 5000}, ...over});
const timeline = (): EditTimeline => initialEditTimeline([PLATE, STILL], PLATE.id, 64, 36);
const binding = (facts: EditSource, stage: string) => ({source: {facts, job: {id: facts.id, stage}, revision: contentHash({receipt: facts.id})},
  owner: {jobId: facts.id, outputRevision: contentHash({output: facts.id})}}) as unknown as EditSourceBinding;
const BINDINGS = [binding(PLATE, "final"), binding(STILL, "motion-graphic")];
const failure = (run: () => unknown) => { try { run(); } catch (error) { expect(error).toBeInstanceOf(EditConflict); return (error as Error).message; } throw new Error("expected a refusal"); };

test("the Editor's composite is one insert on the layer above the shot, keyed to the element, and the desk's validator accepts it", () => {
  const before = timeline(), {operation, timeline: after} = vfxCompositeOperation(before, request());
  expect(operation.kind).toBe("insert");
  expect(operation.clips).toHaveLength(1);
  const [clip] = operation.clips;
  expect(clip).toMatchObject({id: "vfx-1", sourceId: STILL.id, lane: "picture", layer: 1, at: 30, from: 4, frames: 20, opacity: 0.75, crop: null, link: null});
  expect(clip!.composite!.masks).toEqual([{id: VFX_MATTE_ID, label: "VFX matte", sourceRevision: STILL.revision, kind: "ellipse", combine: "replace", invert: false, featherQ8: 512,
    keyframes: [{sourceFrame: 4, interpolation: "hold", geometry: box}]}]);
  expect(clip!.composite!.placement).toEqual({xQ16: 16384, yQ16: 0, scaleQ16: 65536, rotationMilliDegrees: 5000});
  // Exactly what the desk would make of the same operation from a creator.
  expect(after.revision).toBe(applyEditOperation(before, operation).revision);
  expect(after.schema).toBe("hv-edit-timeline/2");
  expect(before.clips.find(c => c.id === "initial-0")).toEqual(after.clips.find(c => c.id === "initial-0")!);
  // A second clip works as an element as well as a still.
  expect(vfxCompositeOperation(before, request({elementSourceId: PLATE.id, from: 60, placement: undefined})).operation.clips[0]!.composite).toEqual({schema: "hv-edit-composite/1",
    masks: [expect.objectContaining({sourceRevision: PLATE.revision, keyframes: [{sourceFrame: 60, interpolation: "hold", geometry: box}]})]});
  expect(vfxCompositeLabel("Lens flare\u0007", "shot 1-2")).toBe("Editor (AI crew): VFX composite of Lens flare over shot 1-2");
});

test("the crew can propose nothing a creator could not save", () => {
  const t = timeline();
  expect(failure(() => vfxCompositeOperation(t, request({at: 80})))).toContain("inside the shot");
  expect(failure(() => vfxCompositeOperation(t, request({frames: 91})))).toContain("Composite length");
  expect(failure(() => vfxCompositeOperation(t, request({plateClipId: "initial-1"})))).toContain("picture clip");
  expect(failure(() => vfxCompositeOperation(t, request({plateClipId: "missing"})))).toContain("picture clip");
  expect(failure(() => vfxCompositeOperation(t, request({elementSourceId: "elsewhere"})))).toContain("Add the element");
  expect(failure(() => vfxCompositeOperation(t, request({from: 11})))).toContain("Element start");
  expect(failure(() => vfxCompositeOperation(t, request({opacity: 0})))).toContain("opacity above zero");
  expect(failure(() => vfxCompositeOperation(t, request({opacity: 1.5})))).toContain("opacity");
  expect(failure(() => vfxCompositeOperation(t, request({clipId: "initial-0"})))).toContain("new clip identity");
  expect(failure(() => vfxCompositeOperation(t, request({clipId: "not an id"})))).toContain("timeline identity");
  expect(failure(() => vfxCompositeOperation(t, request({mask: {kind: "polygon" as "ellipse", box}})))).toContain("rectangle or ellipse");
  // The desk's own limits refuse what the tool passes through, with the desk's own words.
  const feather = request({mask: {kind: "rectangle", box, featherQ8: EDIT_COMPOSITE_LIMITS.featherMaxQ8 + 1}});
  const message = failure(() => vfxCompositeOperation(t, feather));
  const {composite, ...plain} = vfxCompositeOperation(t, request()).operation.clips[0]!;
  expect(failure(() => applyEditOperation(t, {kind: "insert", clips: [{...plain, composite: {...composite!, masks: [{...composite!.masks![0]!, featherQ8: EDIT_COMPOSITE_LIMITS.featherMaxQ8 + 1}]}}]}))).toBe(message);
  expect(failure(() => vfxCompositeOperation(t, request({placement: {xQ16: 0, yQ16: 0, scaleQ16: 1, rotationMilliDegrees: 0}})))).toBeTruthy();
  // A layer already holding a clip over the window, and a plate with no layer above it.
  const once = vfxCompositeOperation(t, request()).timeline;
  expect(failure(() => vfxCompositeOperation(once, request({clipId: "vfx-2", at: 40})))).toContain("already in use");
  expect(vfxCompositeOperation(once, request({clipId: "vfx-2", at: 50})).operation.clips[0]!.layer).toBe(1);
  const {revision: _revision, ...data} = t, top = editTimeline({...data, clips: t.clips.map(c => c.id === "initial-0" ? {...c, layer: 3} : c)});
  expect(failure(() => vfxCompositeOperation(top, request()))).toContain("top picture layer");
});

test("a rendered composite's plan names the plate, the element, the matte and the edit that made it", () => {
  const root = timeline();
  let history = createEditHistory("crew-vfx", root);
  const {operation} = vfxCompositeOperation(root, request());
  history = appendEdit(history, operation, vfxCompositeLabel("still-job", "shot 1"), history.revision, Date.parse("2026-10-04T10:00:00Z"));
  const record = vfxComposites({sequence: {id: "crew-vfx", history}, bindings: BINDINGS})!;
  expect(record.schema).toBe(VFX_COMPOSITE_SCHEMA);
  expect(record).toMatchObject({sequenceId: "crew-vfx", historyRevision: history.revision, timelineRevision: editHistoryState(history).timeline.revision});
  expect(record.composites).toHaveLength(1);
  const [composite] = record.composites;
  expect(composite!.window).toEqual({at: 30, frames: 20});
  expect(composite!.element).toEqual({clipId: "vfx-1", sourceId: STILL.id, layer: 1, at: 30, from: 4, frames: 20, jobId: STILL.id, heldBy: STILL.id, stage: "motion-graphic",
    sourceRevision: BINDINGS[1]!.source.revision, outputRevision: BINDINGS[1]!.owner.outputRevision, media: "graphic-rgba"});
  expect(composite!.plates).toEqual([{clipId: "initial-0", sourceId: PLATE.id, layer: 0, at: 0, from: 0, frames: 90, jobId: PLATE.id, heldBy: PLATE.id, stage: "final",
    sourceRevision: BINDINGS[0]!.source.revision, outputRevision: BINDINGS[0]!.owner.outputRevision, media: "film"}]);
  expect(composite!.matte).toEqual({masks: [{id: VFX_MATTE_ID, kind: "ellipse", combine: "replace", invert: false, featherQ8: 512, keys: 1}], track: null});
  expect(composite!.opacity).toBe(0.75);
  expect(composite!.placement).toEqual({xQ16: 16384, yQ16: 0, scaleQ16: 65536, rotationMilliDegrees: 5000});
  expect(composite!.operation).toEqual({event: 1, kind: "insert", label: "Editor (AI crew): VFX composite of still-job over shot 1", at: "2026-10-04T10:00:00.000Z"});
  // A later creator edit to the matte is the edit the record names.
  const masks = [{...operation.clips[0]!.composite!.masks![0]!, invert: true}];
  history = appendEdit(history, {kind: "composite", clipId: "vfx-1", composite: {schema: "hv-edit-composite/1", masks}}, "Invert the matte", history.revision, Date.parse("2026-10-04T10:01:00Z"));
  const edited = vfxComposites({sequence: {id: "crew-vfx", history}, bindings: BINDINGS})!.composites[0]!;
  expect(edited.operation).toMatchObject({event: 2, kind: "composite", label: "Invert the matte"});
  expect(edited.matte.masks[0]!.invert).toBe(true);
  expect(edited.placement).toBeNull();
  // Undo back to before the composite: the selected branch holds none.
  history = moveEditCursor(history, 0, "branch", "Back to the plain cut", history.revision, Date.parse("2026-10-04T10:02:00Z"));
  expect(vfxComposites({sequence: {id: "crew-vfx", history}, bindings: BINDINGS})).toBeNull();
  // A source the edit did not retain is refused, never invented.
  expect(failure(() => vfxComposites({sequence: {id: "crew-vfx", history: appendEdit(createEditHistory("x", root), operation, "VFX", createEditHistory("x", root).revision)}, bindings: BINDINGS.slice(0, 1)}))).toContain("did not retain");
});

test("a track matte's own inputs are named, and an edit without a composite reads exactly as before", () => {
  const MATTE = source("matte-job", 90, "graphic-rgba"), root = initialEditTimeline([PLATE, STILL, MATTE], PLATE.id, 64, 36);
  let history = createEditHistory("matted", root);
  const {operation} = vfxCompositeOperation(root, request());
  history = appendEdit(history, {kind: "insert", clips: [{...operation.clips[0]!, id: "matte-clip", sourceId: MATTE.id, layer: 2, from: 0, composite: undefined, opacity: 1,
    envelope: {from: 0, frames: 20, fadeIn: 0, fadeOut: 0}}].map(({composite: _composite, ...clip}) => clip)}, "Matte", history.revision);
  history = appendEdit(history, {kind: "matte-only", layers: [2]}, "Matte only", history.revision);
  history = appendEdit(history, {kind: "insert", clips: [{...operation.clips[0]!, composite: {...operation.clips[0]!.composite!, matte: {layer: 2, channel: "luma", invert: false}}}]}, "VFX", history.revision);
  const record = vfxComposites({sequence: {id: "matted", history}, bindings: [...BINDINGS, binding(MATTE, "motion-graphic")]})!;
  expect(record.composites.map(c => c.clipId)).toEqual(["vfx-1"]);
  expect(record.composites[0]!.plates.map(p => p.clipId)).toEqual(["initial-0"]);
  expect(record.composites[0]!.matte.track).toMatchObject({layer: 2, channel: "luma", invert: false, inputs: [{clipId: "matte-clip", jobId: MATTE.id, layer: 2}]});
  expect(record.composites[0]!.operation).toMatchObject({event: 3, label: "VFX"});
  // The Editor's titles (a reel's or a short's) and an untouched cut hold no composite.
  const plain = createEditHistory("plain", root);
  expect(vfxComposites({sequence: {id: "plain", history: plain}, bindings: BINDINGS})).toBeNull();
  const titled = appendEdit(plain, titleOperation({film: PLATE, title: {...STILL, frames: 30}, credits: {...STILL, id: STILL.id, frames: 30}}), "Editor: title and credits", plain.revision);
  expect(editHistoryState(titled).timeline.clips.some(c => c.composite)).toBe(false);
  expect(vfxComposites({sequence: {id: "titled", history: titled}, bindings: BINDINGS})).toBeNull();
});
