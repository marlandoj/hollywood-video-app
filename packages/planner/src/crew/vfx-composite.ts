/**
 * HV-025-13 (Release 3 step 12, part two): a VFX composite, as the crew needs it.
 *
 * The engine already composites. Picture editorial has four picture layers, opacity, crops, authored
 * masks (rectangle, ellipse, polygon; feathered, inverted, keyed), track mattes and a placement
 * transform, rendered by the editorial conform on the studio's own machine (`docs/EDITORIAL-MASKS.md`).
 * What it did not have is a way for the crew to ask for one composite without authoring the timeline by
 * hand, or a reading of a rendered picture edit that says which composite it holds.
 *
 * So this is two small things and no new engine:
 *
 * - **The Editor's tool** (`vfxCompositeOperation`): one element (a still, a graphic or a second clip
 *   already in the sequence) over one shot, with one mask, an opacity and a placement. It is turned into
 *   the single `insert` operation a creator's own edit would be, and applied with `applyEditOperation`,
 *   the validator `PATCH /editorial/sequences/:id` runs. The desk validates it again when it is saved,
 *   so the crew can propose nothing a creator could not save.
 * - **The record** (`vfxComposites`): read from the picture edit's plan, which is what the render's
 *   `provenance.json` already carries. It names the plate and the element by their retained jobs and
 *   revisions, the matte (each mask, and a track matte's own inputs), the opacity and placement, and the
 *   history event that made the composite.
 */
import {applyEditOperation, editFail, editId, editNumber, type EditClip, type EditOperation, type EditTimeline} from "../edit-timeline";
import type {EditComposite, EditMaskBox, EditPlacement, EditTrackMatte} from "../edit-composite-types";
import {editHistoryState, type EditHistory} from "../edit-history";
import type {EditSourceBinding} from "../edit-jobs";

export const VFX_COMPOSITE_SCHEMA = "hv-vfx-composite/1";
export const VFX_MATTE_ID = "vfx-matte";
/** Picture layers are 0 to 3; an element goes on the layer directly above its plate. */
const TOP_LAYER = 3;
const overlaps = (clip: EditClip, at: number, frames: number) => clip.at < at + frames && at < clip.at + clip.frames;

export interface VfxCompositeRequest {
  /** The new clip's identity in the sequence. */
  clipId: string;
  /** The shot's picture clip: the plate the element is composited over. */
  plateClipId: string;
  /** A source already in the sequence: a generated still or graphic, or a second clip. */
  elementSourceId: string;
  /** Timeline frames, inside the plate clip. */
  at: number;
  frames: number;
  /** The element's first source frame. */
  from: number;
  /** In the element's own source coordinates (Q16 fractions of its width and height), as a creator's mask is. */
  mask: {kind: "rectangle" | "ellipse"; box: EditMaskBox; featherQ8?: number; invert?: boolean};
  /** Greater than 0, at most 1. */
  opacity: number;
  /** A simple transform: translation as a fraction of the frame, scale, clockwise rotation. */
  placement?: EditPlacement;
}

/** The one clip the Editor's composite inserts. Its mask is keyed to the element's revision and first frame. */
export function vfxCompositeClip(timeline: EditTimeline, request: VfxCompositeRequest): EditClip {
  editId(request.clipId);
  if (timeline.clips.some(clip => clip.id === request.clipId)) editFail("Choose a new clip identity for the composite.");
  const plate = timeline.clips.find(clip => clip.id === request.plateClipId);
  if (!plate || plate.lane !== "picture") editFail("Choose the shot's picture clip as the plate.");
  if (timeline.matteOnlyLayers?.includes(plate.layer)) editFail("A matte-only layer is not a plate.");
  editNumber(request.frames, 1, plate.frames, "Composite length");
  editNumber(request.at, plate.at, plate.at + plate.frames - request.frames, "Composite start inside the shot");
  if (plate.layer >= TOP_LAYER) editFail("The plate is on the top picture layer; there is no layer above it for the element.");
  // The timeline lets clips share a layer; the Editor composites onto a free one so its element is the only thing it adds there.
  const layer = plate.layer + 1;
  if (timeline.matteOnlyLayers?.includes(layer) || timeline.clips.some(clip => clip.lane === "picture" && clip.layer === layer && overlaps(clip, request.at, request.frames)))
    editFail("The layer above the shot is already in use over this window. Choose another window or clear that layer.");
  const element = timeline.sources.find(source => source.id === request.elementSourceId);
  if (!element) editFail("Add the element to the sequence before compositing it.");
  editNumber(request.from, 0, element.frames - request.frames, "Element start");
  editNumber(request.opacity, 0, 1, "Composite opacity", false);
  if (request.opacity <= 0) editFail("A composite needs an opacity above zero.");
  const {kind, box, featherQ8 = 0, invert = false} = request.mask ?? ({} as VfxCompositeRequest["mask"]);
  if (kind !== "rectangle" && kind !== "ellipse") editFail("Use a rectangle or ellipse matte.");
  const composite: EditComposite = {schema: "hv-edit-composite/1",
    masks: [{id: VFX_MATTE_ID, label: "VFX matte", sourceRevision: element.revision, kind, combine: "replace", invert, featherQ8,
      keyframes: [{sourceFrame: request.from, interpolation: "hold", geometry: structuredClone(box)}]}],
    ...(request.placement ? {placement: structuredClone(request.placement)} : {})};
  return {id: request.clipId, sourceId: element.id, lane: "picture", layer, link: null, at: request.at, from: request.from,
    frames: request.frames, gainDb: 0, opacity: request.opacity, crop: null, envelope: {from: request.from, frames: request.frames, fadeIn: 0, fadeOut: 0}, composite};
}

/**
 * The Editor's tool: one `insert`, validated by the same `applyEditOperation` the desk runs on a
 * creator's save. Returns the operation to send and the timeline it produces.
 */
export function vfxCompositeOperation(timeline: EditTimeline, request: VfxCompositeRequest): {operation: Extract<EditOperation, {kind: "insert"}>; timeline: EditTimeline} {
  const operation = {kind: "insert" as const, clips: [vfxCompositeClip(timeline, request)]};
  return {operation, timeline: applyEditOperation(timeline, operation)};
}

/** The history label the Editor saves the composite under. */
export function vfxCompositeLabel(element: string, plate: string): string {
  const short = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim().slice(0, 80) || "untitled";
  return `Editor (AI crew): VFX composite of ${short(element)} over ${short(plate)}`;
}

export interface VfxInput {
  clipId: string; sourceId: string; layer: number; at: number; from: number; frames: number;
  /** The retained job the picture came from, the job holding the copy rendered, and their revisions. */
  jobId: string; heldBy: string; stage: string; sourceRevision: string; outputRevision: string;
  media: "film" | "graphic-rgba";
}
export interface VfxComposite {
  clipId: string;
  window: {at: number; frames: number};
  element: VfxInput;
  /** Every visible picture clip under the element in its window, lowest layer first. */
  plates: VfxInput[];
  matte: {
    masks: {id: string; kind: string; combine: string; invert: boolean; featherQ8: number; keys: number}[];
    track: (EditTrackMatte & {inputs: VfxInput[]}) | null;
  };
  opacity: number;
  placement: EditPlacement | null;
  /** The saved edit that last set this clip's composite, or null when the sequence was created with it. */
  operation: {event: number; kind: EditOperation["kind"]; label: string; at: string} | null;
}
export interface VfxCompositeRecord {
  schema: typeof VFX_COMPOSITE_SCHEMA;
  sequenceId: string; historyRevision: string; timelineRevision: string;
  composites: VfxComposite[];
}

function touches(operation: EditOperation, clipId: string): boolean {
  switch (operation.kind) {
    case "insert": return operation.clips.some(clip => clip.id === clipId && Object.hasOwn(clip, "composite"));
    case "composite": return operation.clipId === clipId;
    case "replace": return operation.clipId === clipId && Object.hasOwn(operation, "maskAction");
    case "duplicate": return Object.values(operation.ids).includes(clipId);
    default: return false;
  }
}
/** The latest edit on the selected branch that set the clip's composite. */
function madeBy(history: EditHistory, head: number, clipId: string): VfxComposite["operation"] {
  for (let node = head; node > 0;) {
    const event = history.events.find(candidate => candidate.kind === "edit" && candidate.sequence === node);
    if (!event || event.kind !== "edit") return null;
    if (touches(event.operation, clipId)) return {event: event.sequence, kind: event.operation.kind, label: event.label, at: event.at};
    node = event.parent;
  }
  return null;
}

/**
 * The composites a picture edit holds, read from its plan (the job's `pictureEdit`, or the `plan` in
 * its `provenance.json`). Null when it holds none, so an edit without VFX reads exactly as before.
 */
export function vfxComposites(plan: {sequence: {id: string; history: EditHistory}; bindings: EditSourceBinding[]}): VfxCompositeRecord | null {
  const {head, timeline} = editHistoryState(plan.sequence.history);
  const hidden = new Set(timeline.matteOnlyLayers ?? []);
  const input = (clip: EditClip): VfxInput => {
    const binding = plan.bindings.find(candidate => candidate.source.facts.id === clip.sourceId);
    if (!binding) editFail("A composited clip names a source this edit did not retain.");
    return {clipId: clip.id, sourceId: clip.sourceId, layer: clip.layer, at: clip.at, from: clip.from, frames: clip.frames,
      jobId: binding.source.job.id, heldBy: binding.owner.jobId, stage: binding.source.job.stage, sourceRevision: binding.source.revision,
      outputRevision: binding.owner.outputRevision, media: binding.source.facts.media ?? "film"};
  };
  const pictures = timeline.clips.filter(clip => clip.lane === "picture");
  const composites = pictures.filter(clip => clip.composite).map((clip): VfxComposite => {
    const composite = clip.composite!, onLayer = (layer: number) =>
      pictures.filter(other => other.layer === layer && overlaps(other, clip.at, clip.frames)).sort((a, b) => a.at - b.at).map(input);
    const plates = pictures.filter(other => other.layer < clip.layer && !hidden.has(other.layer) && overlaps(other, clip.at, clip.frames))
      .sort((a, b) => a.layer - b.layer || a.at - b.at).map(input);
    return {clipId: clip.id, window: {at: clip.at, frames: clip.frames}, element: input(clip), plates,
      matte: {masks: (composite.masks ?? []).map(mask => ({id: mask.id, kind: mask.kind, combine: mask.combine, invert: mask.invert, featherQ8: mask.featherQ8, keys: mask.keyframes.length})),
        track: composite.matte ? {...composite.matte, inputs: onLayer(composite.matte.layer)} : null},
      opacity: clip.opacity, placement: composite.placement ? structuredClone(composite.placement) : null,
      operation: madeBy(plan.sequence.history, head, clip.id)};
  });
  if (!composites.length) return null;
  return {schema: VFX_COMPOSITE_SCHEMA, sequenceId: plan.sequence.id, historyRevision: plan.sequence.history.revision, timelineRevision: timeline.revision, composites};
}
