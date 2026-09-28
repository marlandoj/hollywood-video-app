/**
 * HV-039-06 — shot direction dropped keyboard focus to the page body after every save.
 *
 * HV-039-05 fixed the cast desk; the shot-direction desk has the same shape. Every change goes
 * through `mutate`, which ends
 *
 *     state = await request(""); render(); dirty = false; editing = null; form.hidden = true;
 *
 * and `render` starts with `list.replaceChildren()`. So **Save shot direction** sits in the form that
 * was just hidden, **Remove direction for s3** in the list that was just rebuilt, **Cancel shot
 * edit** hides its own form and **Close shot editor** hides the desk. A browser moves focus to the
 * page body each time, and a keyboard or screen-reader user starts again from the top of the page,
 * above a desk that lists up to 24 shots in collapsed groups of six.
 *
 * The desk now returns focus to where the creator was: the control that opened what was closed, if
 * it is still there; otherwise the shot's own row, opened if its scene or group was collapsed;
 * otherwise the desk heading.
 */
import {afterEach, expect, test} from "bun:test";
import {initDirection} from "../src/direction.js";
import {COVERAGE_CHOICES, DEFAULT_COVERAGE} from "../../planner/src/coverage";
import {DEFAULT_DIRECTION, DIRECTION_CHOICES} from "../../planner/src/direction";
import {CAMERA_PRESETS, DEFAULT_FRAMING, DEFAULT_OPTICS} from "../../planner/src/framing";
import {Element, fire, mountDom, tree} from "./audio-studio-dom.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
/** Scene 1 has eight shots, so s7 and s8 sit in a second, collapsed group; scene 2 starts collapsed. */
const IDS = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"];

let restore = () => {};
afterEach(() => restore());

async function desk() {
  restore = mountDom();
  let version = 0, entries = [], refuse = false;
  const plan = IDS.map((id, index) => ({source: {id, sceneIndex: index < 8 ? 0 : 1, prompt: "Shot " + id, dialogue: []}, sourceHash: "hash-" + id, settings: null, performanceLines: []}));
  // The fields the direction route sends (server.ts), with the planner's own defaults and choices.
  const state = () => ({direction: {version, entries}, plan, scenes: [{index: 0, heading: "INT. KITCHEN - DAY"}, {index: 1, heading: "EXT. GARDEN - NIGHT"}],
    defaults: DEFAULT_DIRECTION, choices: DIRECTION_CHOICES, coverageDefaults: DEFAULT_COVERAGE, coverageChoices: COVERAGE_CHOICES, coverage: null,
    framingDefaults: DEFAULT_FRAMING, opticsDefaults: DEFAULT_OPTICS, cameraPresets: CAMERA_PRESETS, viewfinderSources: [], anchorAssets: [],
    history: [], staleShotIds: [], staleSceneIndices: [], durationLimitSec: 30, maxShots: 24, scriptVersion: 1, motionPlans: []});
  const request = async (path, init) => {
    if (path === "") return state();
    if (refuse) {refuse = false; throw new Error("The shot plan changed. Reload it to review the changes.");}
    const [, id, action] = path.split("/");
    if (action === "remove") entries = entries.filter(entry => entry.source.id !== id);
    else if (id !== "restore") entries = [...entries.filter(entry => entry.source.id !== id), {source: plan.find(value => value.source.id === id).source, settings: {...init.body.settings, durationFrames: null}}];
    version++;
    return {direction: {version}};
  };
  const body = document.body, opener = new Element("button"), panel = new Element("section");
  opener.textContent = "Save screenplay and direct shots"; body.append(opener, panel); panel.hidden = true;
  const view = initDirection({panel, request, prepare: async () => {}, changed() {}, assetUrl: url => url, image: async () => new Blob(),
    takeRequest: async () => ({jobs: []}), prepareGeneration: async () => {}, motionDownload: async () => new Blob()});
  opener.focus();
  await view.open(); await settle();
  const find = (tag, text) => tree(panel).find(element => element.tag === tag && element.textContent === text);
  /** Press a desk button as a keyboard user does: open what it is folded inside, focus it, activate it. */
  const press = async text => {
    const control = find("button", text);
    for (let node = control.parentElement; node; node = node.parentElement) if (node.tag === "details") node.open = true;
    control.focus(); await control.onclick?.({currentTarget: control}); await settle();};
  const form = tree(panel).find(element => element.tag === "form");
  const focus = () => {
    const active = document.activeElement;
    const collapsed = [];
    for (let node = active.parentElement; node; node = node.parentElement) if (node.tag === "details" && !node.open) collapsed.push(node);
    return {on: active.textContent, onThePage: active.isConnected && !active.closest("[hidden]") && collapsed.length === 0};
  };
  return {panel, opener, press, form, focus, find, refuseNext: () => {refuse = true;}};
}

test("closing the desk returns focus to the button that opened it", async () => {
  const d = await desk();
  expect(d.focus()).toEqual({on: "Shot direction", onThePage: true});
  await d.press("Close shot editor");
  expect(d.panel.hidden).toBe(true);
  expect(d.focus()).toEqual({on: "Save screenplay and direct shots", onThePage: true});
});

test("saving a shot leaves focus on that shot's row, opened even when its group was collapsed", async () => {
  const d = await desk();
  await d.press("Edit s7");
  expect(d.form.hidden).toBe(false);
  fire(d.form, "submit"); await settle(); await settle();
  expect(d.form.hidden).toBe(true);
  expect(d.focus()).toEqual({on: "s7", onThePage: true});
});

test("removing a saved direction leaves focus on the shot's row, not on a button that no longer exists", async () => {
  const d = await desk();
  await d.press("Edit s9");
  fire(d.form, "submit"); await settle(); await settle();
  await d.press("Remove direction for s9");
  expect(d.find("button", "Remove direction for s9")).toBeUndefined();
  expect(d.focus()).toEqual({on: "s9", onThePage: true});
});

test("cancelling a shot edit returns focus to the Edit button that started it", async () => {
  const d = await desk();
  await d.press("Edit s2");
  await d.press("Cancel shot edit");
  expect(d.form.hidden).toBe(true);
  expect(d.focus()).toEqual({on: "Edit s2", onThePage: true});
});

test("a refused save leaves focus where it was: nothing was rebuilt", async () => {
  const d = await desk();
  await d.press("Edit s1");
  fire(d.form, "submit"); await settle(); await settle();
  d.refuseNext();
  await d.press("Remove direction for s1");
  expect(d.find("p", "The shot plan changed. Reload it to review the changes.")).toBeDefined();
  expect(d.focus()).toEqual({on: "Remove direction for s1", onThePage: true});
});
