/**
 * HV-024-08 — "Load sound session" with no available cut read the catalogue as a quote.
 *
 * Opening the sound session lists every retained cut in "Picture or sound version", and disables
 * the ones that are no longer retained. When none is available the select's value is "":
 *
 *     choose.value=data.sources.filter(s=>!s.unavailable).at(-1)?.id??"";
 *     …controls.append(button("Load sound session",()=>inspect(choose.value)),…
 *
 * The button stayed enabled anyway, and `inspect("")` asked for `request("/"+id)`, which is
 * `/sound-mixes/`. The API drops empty path parts, so that is the catalogue listing, and the panel
 * took it for a quote: it hid any sound version the owner had open, cleared the editor, and said
 * "undefined is not an object (evaluating 'quote.durationSec.toFixed')", or whatever the browser
 * calls that TypeError.
 *
 * The button is now disabled while no available version is chosen, and `inspect` refuses an empty
 * id with a sentence that says what to do, before it touches the playback or the network.
 */
import {afterEach, expect, test} from "bun:test";
import {initSoundStudio} from "../src/sound-studio.js";
import {Element, mountDom, tree} from "./audio-studio-dom.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
let restore = () => {};
afterEach(() => restore());

const LIBRARY = {version: 0, assets: [], events: []};
const QUOTE = {sourceJobId: "cut-00000002", durationSec: 2, language: "en", sourceRevision: "r", engineVersion: "e", library: LIBRARY};

/** The sound session opened on `sources`, with every request it makes written down. */
async function session(sources, jobs = []) {
  restore = mountDom();
  const unmount = restore; Element.prototype.pause = Element.prototype.load = function () {};
  Object.defineProperty(Element.prototype, "classList", {get() {return {add() {}, remove() {}};}, configurable: true});
  restore = () => {unmount(); delete Element.prototype.pause; delete Element.prototype.load; delete Element.prototype.classList;};
  const paths = [];
  // As the server answers: an empty id is dropped from the path, so "/" is the catalogue.
  const request = async path => {paths.push(path); return path === "" || path === "/" ? {library: LIBRARY, jobs, sources} : QUOTE;};
  const parent = document.createElement("div"); document.body.append(parent);
  const studio = initSoundStudio({parent, request, libraryRequest: async () => ({}), recording: async () => new Blob(), jobRequest: async id => ({id, status: "done", mediaUnavailable: "This version's media has expired."}),
    projectState: async () => ({dialogueSelections: {version: 0, entries: []}}), assetUrl: url => url, canEdit: () => true, adopt: async () => ({})});
  await studio.open(); await settle();
  const find = text => tree(parent).find(element => element.tag === "button" && element.textContent === text);
  const status = () => tree(parent).find(element => element.getAttribute("role") === "status");
  return {parent, paths, find, status};
}

const unavailable = {id: "cut-00000001", stage: "final", unavailable: "This cut is no longer retained."};

test("Load sound session is disabled when every retained cut is unavailable.", async () => {
  const view = await session([unavailable]);
  expect(tree(view.parent).find(element => element.tag === "select").value).toBe("");
  expect(view.find("Load sound session").disabled).toBe(true);
  expect(view.status().textContent).toBe("Create a retained film with isolated voices before starting a sound session.");
});

test("Load sound session is disabled when there is no retained cut at all.", async () => {
  const view = await session([]);
  expect(view.find("Load sound session").disabled).toBe(true);
});

test("Load sound session stays enabled for an available cut and loads that cut's quote.", async () => {
  const view = await session([unavailable, {id: "cut-00000002", stage: "final"}]);
  const load = view.find("Load sound session");
  expect(load.disabled).toBe(false);
  expect(view.paths).toEqual(["", "/cut-00000002"]);
  await load.onclick(); await settle();
  expect(view.paths.at(-1)).toBe("/cut-00000002");
  expect(view.status().textContent).toBe("Step 1 of 3 · Place cues around the retained voices.");
});

test("Loading with no chosen version asks for one and never requests the catalogue as a quote.", async () => {
  const view = await session([unavailable]);
  // A click that reaches the handler anyway (a stale page, a script) is refused by `inspect` itself.
  await view.find("Load sound session").onclick(); await settle();
  expect(view.paths).not.toContain("/");
  expect(view.status().dataset.state).toBe("error");
  expect(view.status().textContent).toBe("Choose an available picture or sound version before loading a sound session.");
});

test("Loading with no chosen version leaves an open sound version on screen.", async () => {
  const view = await session([unavailable], [{id: "mix-00000001", status: "done"}]);
  await view.find("Open sound version mix-0000").onclick(); await settle();
  const playback = tree(view.parent).find(element => element.tag === "h3" && element.textContent === "Sound version · mix-0000").parentElement;
  expect(playback.hidden).toBe(false);
  await view.find("Load sound session").onclick(); await settle();
  expect(playback.hidden).toBe(false);
  expect(tree(playback).some(element => element.textContent === "This version's media has expired.")).toBe(true);
});
