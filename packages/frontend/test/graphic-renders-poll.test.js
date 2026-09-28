/**
 * HV-039-07 — the graphics desk rebuilt "Rendered versions" every 1.5 seconds while a render ran.
 *
 * `watch` polls each running render's job every 1.5 seconds and then calls `drawRenders`, which
 * began `renders.replaceChildren()` and built the box again from nothing: the Version list, a new
 * `role=status` line and a new **Inspect retained frames** button. A title render runs for tens of
 * seconds. For all of that time:
 *
 * - a keyboard user who had tabbed to **Inspect retained frames** or the Version list lost focus to
 *   the page body every 1.5 seconds;
 * - an open Version list closed under the pointer mid-choice;
 * - the status line was a new live region each time, and its words were written again even when
 *   nothing had changed, so a screen reader read the progress out on every poll.
 *
 * The box is now built once for a set of renders and updated in place after that. A status line
 * is only written when its words change.
 */
import {afterEach, expect, test} from "bun:test";
import {GRAPHIC_KINDS, defaultMotionGraphic} from "../../planner/src/motion-graphics";
import {initGraphicStudio} from "../src/graphic-studio.js";
import {Element, fire, mountDom, tree} from "./audio-studio-dom.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
let restore = () => {};
afterEach(() => {restore(); globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout;});

const running = (id, captured) => ({id, spec: {id: "g1", label: "Opening title"}, status: "running", progress: {phase: "Capturing", capturedFrames: captured}, totalFrames: 90, retainedFrames: captured});
const done = id => ({id, spec: {id: "g1", label: "Opening title"}, status: "done", completedAt: "2026-09-28T20:00:00.000Z", totalFrames: 90, retainedFrames: 90});

/** The graphics desk, open on one saved graphic, with its 1.5-second poll under the test's hand. */
async function desk(jobs) {
  restore = mountDom();
  const polls = [];
  globalThis.setTimeout = (callback, delay) => {
    if (delay !== 1500) return realSetTimeout(callback, delay);
    const timer = {callback, cleared: false}; polls.push(timer); return timer;
  };
  globalThis.clearTimeout = timer => {if (timer && typeof timer === "object" && "cleared" in timer) timer.cleared = true; else realClearTimeout(timer);};
  const job = new Map(jobs.map(value => [value.id, value]));
  const index = () => ({library: {version: 1}, graphics: [{spec: {id: "g1", label: "Opening title", revision: 1, plan: defaultMotionGraphic("title")}, available: true}],
    jobs: [...job.values()], defaults: GRAPHIC_KINDS.map(kind => defaultMotionGraphic(kind))});
  const request = async path => path === "" ? index() : job.get(decodeURIComponent(path.split("/").at(-1)));
  const parent = new Element("div");
  const studio = initGraphicStudio({parent, request, projectId: () => "p1", assetUrl: url => url, canEdit: () => true});
  await studio.open(); await settle();
  const box = () => tree(parent).find(element => element.tag === "details" && element.children[0]?.textContent === "Rendered versions");
  const inside = () => tree(box());
  const view = () => ({
    box: box(),
    pick: inside().find(element => element.tag === "select"),
    state: inside().find(element => element.getAttribute("role") === "status"),
    inspect: inside().find(element => element.tag === "button" && element.textContent === "Inspect retained frames"),
  });
  /** The next status poll, as the browser would run it 1.5 seconds on. */
  const poll = async () => {
    const next = polls.filter(timer => !timer.cleared).at(-1);
    if (!next) return false;
    next.cleared = true; await next.callback(); await settle(); return true;
  };
  return {job, view, poll, onPage: element => tree(parent).includes(element), pending: () => polls.some(timer => !timer.cleared)};
}

test("the controls a keyboard user is on stay on the page while the render's progress updates", async () => {
  const d = await desk([running("j1", 10)]);
  const before = d.view();
  expect(before.state.textContent).toBe("Capturing · 10 / 90 captured frames; 10 retained");

  d.job.set("j1", running("j1", 40));
  expect(await d.poll()).toBe(true);
  const after = d.view();
  // The same controls, still on the page, not new ones: a control that stays on the page keeps its
  // focus, and one that is replaced loses it to the page body.
  for (const key of ["box", "pick", "state", "inspect"]) expect({key, same: after[key] === before[key], onPage: d.onPage(before[key])}).toEqual({key, same: true, onPage: true});
  expect(after.state.textContent).toBe("Capturing · 40 / 90 captured frames; 40 retained");
});

test("a poll that changes nothing writes nothing, so a screen reader is not read the same progress again", async () => {
  const d = await desk([running("j1", 10)]);
  const {state} = d.view(), writes = [];
  Object.defineProperty(state, "textContent", {get() {return this.written ?? "";}, set(value) {writes.push(value); this.written = value;}, configurable: true});
  await d.poll();
  expect(writes).toEqual([]);
  d.job.set("j1", running("j1", 60));
  await d.poll();
  expect(writes).toEqual(["Capturing · 60 / 90 captured frames; 60 retained"]);
});

test("an older version chosen mid-render stays chosen, in the same list, and the render's finish is still shown", async () => {
  const d = await desk([done("j0"), running("j1", 10)]);
  const {pick, state} = d.view();
  fire(pick, "change", "j0");
  expect(state.textContent).toBe("Ready. Inspect the animation or download the retained master.");
  d.job.set("j1", done("j1"));
  await d.poll();
  expect(d.view().pick).toBe(pick);
  expect(pick.value).toBe("j0");
  expect(pick.children.map(option => option.textContent.split(" · ")[1])).toEqual(["done", "done"]);
  // Both finished: nothing left to poll.
  expect(d.pending()).toBe(false);
});
