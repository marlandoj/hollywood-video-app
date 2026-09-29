/**
 * HV-039-20 — scrubbing the camera path preview, then nudging or dragging the crop, overwrote the
 * selected keyframe with the in-between framing.
 *
 * The path editor's preview scrubber shows the interpolated crop by writing it into the viewfinder's
 * own editable crop:
 *
 *     scrub.oninput = event => {...; showCrop(sample(at), true); ...};     // camera-path.js
 *
 * and every edit the viewfinder makes to its crop -- a position or size control, an arrow key, a
 * drag on the source -- reports the whole crop to the path editor, which copies it into the
 * *selected* keyframe:
 *
 *     function setCrop(key, value) {...; crop = {...crop, [key]: value}; ...; pathEditor.cropChanged(crop); ...}   // viewfinder.js
 *     cropChanged(crop) {...; Object.assign(keyframes[selected], crop); ...}                                    // camera-path.js
 *
 * So a creator who scrubbed to the end of the path to look at it, and then nudged the horizontal
 * position of the first keyframe, saved a first keyframe with the last keyframe's size and vertical
 * position. Nothing on screen said so, because the viewfinder was already showing that crop. The
 * first frame of the next render was framed wrong.
 *
 * The path editor now knows when the viewfinder is showing a preview rather than the selected
 * keyframe. An edit made then puts the selected keyframe back on screen, leaves every keyframe
 * unchanged, and says why. The next edit works on the keyframe as it really is. Scrubbing still
 * previews exactly as before.
 */
import {expect, test} from "bun:test";
import {mountDom, tree, fire} from "./audio-studio-dom.js";
import {initViewfinder} from "../src/viewfinder.js";

const FIRST = {x: 1000, y: 1000, size: 8000, at: 0, easing: "linear"}, LAST = {x: 5000, y: 5000, size: 5000, at: 10000, easing: "linear"};
const STATE = {framingDefaults: {x: 0, y: 0, size: 10000}, opticsDefaults: {sensorWidthMm: 36, sensorHeightMm: 24, squeeze: 1, look: ""}, cameraPresets: [], viewfinderSources: []};

/** A viewfinder with a two-keyframe path, the first keyframe selected, scrubbed to the end of the path. */
function scrubbedToEnd() {
  const restore = mountDom();
  const parent = document.createElement("div"); document.body.append(parent);
  const view = initViewfinder({parent, assetUrl: p => p, direction: () => ({lensMm: 35, durationFrames: 300}), applyDirection() {}, changed() {}, canEdit: () => true});
  view.fill({cameraPath: {mode: "screen-space", keyframes: [structuredClone(FIRST), structuredClone(LAST)]}}, STATE, "shot-1");
  const all = () => tree(parent), byId = id => all().find(e => e.id === id);
  const shown = () => ({x: Number(byId("viewfinder-x").value), y: Number(byId("viewfinder-y").value), size: Number(byId("viewfinder-size").value)});
  fire(byId("camera-path-preview"), "input", "10000");
  const saved = () => view.read().cameraPath.keyframes.map(({x, y, size}) => ({x, y, size}));
  const pathStatus = () => all().find(e => e.tag === "p" && e.getAttribute("role") === "status" && e.parentElement?.tag === "details")?.textContent ?? "";
  return {restore, all, byId, shown, saved, pathStatus};
}

test("nudging the crop after scrubbing the preview leaves the selected keyframe's framing as it was and shows it again", () => {
  const page = scrubbedToEnd();
  try {
    // The preview itself still works: the viewfinder shows the end of the path.
    expect(page.shown()).toEqual({x: 5000, y: 5000, size: 5000});
    fire(page.byId("viewfinder-x"), "input", "5100");
    expect(page.saved()).toEqual([{x: 1000, y: 1000, size: 8000}, {x: 5000, y: 5000, size: 5000}]);
    // The viewfinder is back on the keyframe being edited, and says why the nudge did not land.
    expect(page.shown()).toEqual({x: 1000, y: 1000, size: 8000});
    expect(page.byId("camera-path-preview").value).toBe(0);
    expect(page.pathStatus()).toContain("back on the selected keyframe");
  } finally {page.restore();}
});

test("the next edit after that changes only what the creator changed on the selected keyframe", () => {
  const page = scrubbedToEnd();
  try {
    fire(page.byId("viewfinder-x"), "input", "5100");
    fire(page.byId("viewfinder-y"), "input", "1500");
    fire(page.byId("viewfinder-x"), "input", "1200");
    expect(page.saved()).toEqual([{x: 1200, y: 1500, size: 8000}, {x: 5000, y: 5000, size: 5000}]);
  } finally {page.restore();}
});

test("dragging the crop after scrubbing the preview keeps the selected keyframe's size", () => {
  const page = scrubbedToEnd();
  try {
    const stage = page.all().find(e => e.className === "viewfinder-source-stage"), image = stage.children.find(e => e.tag === "img");
    Object.assign(image, {complete: true, naturalWidth: 1600});
    Object.assign(stage, {getBoundingClientRect: () => ({left: 0, top: 0, width: 100, height: 100}), setPointerCapture() {}});
    // Press inside the previewed rectangle (the end of the path) and drag it a little up and left.
    stage.onpointerdown({button: 0, pointerId: 1, clientX: 70, clientY: 70});
    stage.onpointermove({pointerId: 1, clientX: 65, clientY: 65});
    stage.onpointerup();
    const [first, last] = page.saved();
    expect(first.size).toBe(8000);
    expect(last).toEqual({x: 5000, y: 5000, size: 5000});
    expect(page.shown().size).toBe(8000);
  } finally {page.restore();}
});
