/**
 * HV-039-22 — the mask viewport told keyboard users to select a handle, and gave them no key to do it.
 *
 * The viewport's accessible name was "Mask shape editor. Select a handle, then move it with the arrow
 * keys." Only a pointer could select one: `selectedHandle` was assigned in the `pointerdown` handler
 * and nowhere else, and it starts as `move`, the whole shape. So for a rectangle or an ellipse the
 * arrow keys moved the whole shape, or whichever corner a mouse had last pressed. A keyboard user
 * could resize only through the coordinate fields (WCAG 2.1.1 is met there), and the instruction
 * that was meant for them was wrong (3.3.2). For a polygon the editor's vertex select worked, but the
 * viewport the arrows act on had no key of its own.
 *
 * Space now selects the next handle in the order the viewport lists them (corners, then the whole
 * shape; or each vertex round the ring), Shift+Space the previous one. A vertex chosen this way is
 * reported to the editor, as a pointer's choice is, so the vertex select and fields follow.
 */
import {expect, test} from "bun:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import * as viewportModule from "../src/mask-viewport.js";

// Read through the namespace, so that this file still loads, and fails case by case, against a
// mask-viewport.js that does not export the sentence yet.
const {mountMaskViewport, MASK_HANDLE_SENTENCE, MASK_STEP_PIXELS, MASK_STEP_SENTENCE, MASK_VIEWPORT_LABEL} = viewportModule;

const CONTEXT = new Proxy({}, {get: (target, key) => target[key] ?? (() => {})});

class Node {
  constructor(tag) {this.tag = tag; this.attributes = {}; this.writes = []; this.children = []; this.style = {}; this.events = new Map();}
  setAttribute(name, value) {this.attributes[name] = String(value);}
  getAttribute(name) {return Object.hasOwn(this.attributes, name) ? this.attributes[name] : null;}
  append(...nodes) {this.children.push(...nodes);}
  addEventListener(type, fn) {this.events.set(type, fn);}
  getBoundingClientRect() {return {left: 0, top: 0, width: 640, height: 360};}
  getContext() {return CONTEXT;}
  focus() {}
  setPointerCapture() {}
  set textContent(value) {this.written = value; this.writes.push(value);}
  get textContent() {return this.written ?? "";}
}

/** A 320x180 source with a shape from a quarter to three quarters of it, as the HV-039-03 tests use. */
function harness(kind = "rectangle", {locked = false} = {}) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "document"), changes = [], vertices = [];
  globalThis.document = {createElement: tag => new Node(tag)};
  const source = {width: 320, height: 180}, parent = new Node("div");
  const viewport = mountMaskViewport({parent, source, onGeometry: value => changes.push(structuredClone(value)), onVertex: id => vertices.push(id), onError() {}, canChange: () => !locked});
  const geometry = kind === "polygon"
    ? {points: [{id: "a", xQ16: 16384, yQ16: 16384}, {id: "b", xQ16: 49152, yQ16: 16384}, {id: "c", xQ16: 49152, yQ16: 49152}]}
    : {xQ16: 16384, yQ16: 16384, widthQ16: 32768, heightQ16: 32768};
  viewport.set({geometry, kind, selectedVertex: kind === "polygon" ? "a" : null, mode: "source", frame: 0});
  const key = (key, options = {}) => {const event = {key, prevented: false, preventDefault() {this.prevented = true;}, ...options}; viewport.canvas.events.get("keydown")(event); return event;};
  return {viewport, source, changes, vertices, geometry, key, said: () => viewport.announcement.textContent,
    restore() {viewport.dispose(); if (previous) Object.defineProperty(globalThis, "document", previous); else delete globalThis.document;}};
}
const q16 = (pixels, size) => Math.round(pixels / size * 65536);

test("Space selects a corner, so the arrow keys resize a rectangle with no pointer at all", () => {
  const h = harness();
  try {
    // The handle starts as the whole shape. Space moves on to the first corner, then the next.
    const event = h.key(" ");
    expect(event.prevented).toBe(true);                       // the page does not scroll
    expect(h.said()).toBe("Top-left corner at source pixel 80, 45.");
    h.key(" ");
    expect(h.said()).toBe("Top-right corner at source pixel 240, 45.");
    // The arrow now moves that corner: the right edge goes out one pixel, the left edge stays.
    h.key("ArrowRight");
    const moved = h.changes.at(-1);
    expect(moved.xQ16).toBe(h.geometry.xQ16);
    expect(moved.widthQ16 - h.geometry.widthQ16).toBe(q16(MASK_STEP_PIXELS.normal, h.source.width));
    expect(moved.heightQ16).toBe(h.geometry.heightQ16);
    expect(h.said()).toBe("Top-right corner at source pixel 241, 45.");
  } finally {h.restore();}
});

test("Shift+Space goes back, and the choice runs round every handle, the whole shape included", () => {
  const h = harness("ellipse");
  try {
    h.key(" ", {shiftKey: true});
    expect(h.said()).toBe("Bottom-right corner at source pixel 240, 135.");
    const seen = [];
    for (let i = 0; i < 5; i++) {h.key(" "); seen.push(h.said().split(" at ")[0]);}
    expect(seen).toEqual(["Whole shape", "Top-left corner", "Top-right corner", "Bottom-left corner", "Bottom-right corner"]);
    // With the whole shape selected, an arrow moves it and keeps its size.
    h.key(" "); h.key("ArrowDown", {shiftKey: true});
    const moved = h.changes.at(-1);
    expect(moved.yQ16 - h.geometry.yQ16).toBe(q16(MASK_STEP_PIXELS.shift, h.source.height));
    expect([moved.widthQ16, moved.heightQ16]).toEqual([h.geometry.widthQ16, h.geometry.heightQ16]);
  } finally {h.restore();}
});

test("a polygon vertex chosen with Space is the one the editor shows and the one the arrows move", () => {
  const h = harness("polygon");
  try {
    h.key(" ");
    expect(h.vertices).toEqual(["b"]);                        // the editor's vertex select and fields follow
    expect(h.said()).toBe("Vertex 2 of 3 at source pixel 240, 45.");
    h.key("ArrowDown");
    const [a, b, c] = h.changes.at(-1).points;
    expect(b.yQ16 - h.geometry.points[1].yQ16).toBe(q16(MASK_STEP_PIXELS.normal, h.source.height));
    expect([a, c]).toEqual([h.geometry.points[0], h.geometry.points[2]]);
    h.key(" ", {shiftKey: true}); h.key(" ", {shiftKey: true});
    expect(h.vertices).toEqual(["b", "a", "c"]);              // back past the first vertex to the last
  } finally {h.restore();}
});

test("Space leaves the selection alone while a shape is being drawn or while mask changes are locked", () => {
  const drawing = harness("polygon");
  try {
    drawing.viewport.draw();
    const before = drawing.said(), event = drawing.key(" ");
    expect([drawing.vertices, drawing.said(), event.prevented]).toEqual([[], before, false]);
  } finally {drawing.restore();}
  const locked = harness("rectangle", {locked: true});
  try {
    const before = locked.said(), event = locked.key(" ");
    expect([locked.said(), event.prevented]).toEqual([before, false]);
  } finally {locked.restore();}
});

test("the viewport's name and the editor's instructions say which key selects a handle", () => {
  expect(MASK_HANDLE_SENTENCE).toBe("Space selects the next handle; Shift+Space selects the previous one.");
  expect(MASK_VIEWPORT_LABEL).toBe("Mask shape editor. " + MASK_HANDLE_SENTENCE + " " + MASK_STEP_SENTENCE);
  expect(MASK_VIEWPORT_LABEL).not.toContain("Select a handle, then");
  // The editor's paragraph is built from the same export, after the step sentence HV-039-03 pinned.
  const editor = readFileSync(join(import.meta.dir, "..", "src", "mask-editor.js"), "utf8");
  expect(editor).toMatch(/'[^']*use these fields\. '\+MASK_STEP_SENTENCE\+' '\+MASK_HANDLE_SENTENCE/);
});
