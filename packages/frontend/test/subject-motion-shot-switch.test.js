/**
 * HV-039-19 — opening subject motion for a second shot showed, saved and exported the first shot's plan.
 *
 * Each shot's "Plan subject motion for …" button calls `open(plan)`, which points the panel at the
 * new shot and reads its context:
 *
 *     shotId=plan.source.id;maxShots=limit;panel.hidden=false;if(!dirty)await reload(false);
 *
 * `reload` runs inside `run()`, and `run()` drops any step that arrives while another is in flight:
 *
 *     async function run(action){if(busy)return;busy=true;…
 *
 * So pressing shot B's button while shot A's context was still loading set `shotId` to B, the read
 * for B was dropped, and A's reply arrived after that and became `context`. From then on the panel
 * said "Current source · A" and showed A's subjects, while every request went to `/B/…`:
 * **Save movement plan** sent A's source hash, image and points to B, and **Download native inputs**
 * asked for B under A's saved revision. Nothing on screen said B had never loaded.
 *
 * Now each read names the shot it was made for, and a reply for a shot the panel no longer shows is
 * dropped. A read that `open` asks for while the panel is busy is remembered, and it runs once the
 * panel is free, so B's own context is always what B shows.
 */
import {afterEach, expect, test} from "bun:test";
import {initSubjectMotion} from "../src/subject-motion.js";
import {Element, mountDom, tree} from "./audio-studio-dom.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
let restore = () => {};
afterEach(() => restore());

/** A shot's saved plan: one subject with one track, on that shot's own image and source hash. */
const ctx = id => ({study: {revision: "study-" + id, scriptVersion: 1, castingRevision: "c", directionRevision: undefined, sourceHash: "hash-" + id, asset: {id: "img-" + id}, links: [],
  plan: {subjects: [{id: "subject-1", label: "Subject " + id, tracks: [{id: "point-1", keyframes: [0, 80].map(frame => ({frame, x: 4000, y: 5000, easing: "linear", visible: true}))}]}], prompt: "Move " + id, seed: 7}},
source: {source: {id, prompt: "Shot " + id}, sourceHash: "hash-" + id}, characters: [], castingRevision: "c", directionVersion: 1, scriptVersion: 1, version: 1, assets: [{id: "img-" + id, label: "Image " + id}]});

/**
 * Subject motion on a stand-in page. Reads for a shot in `hold` wait until the test releases them
 * with `release(id)`; every other read answers at once. `download` can be held the same way.
 */
function panel({hold = [], holdDownload = false} = {}) {
  restore = mountDom();
  // Subject motion draws its stage in SVG, reads a list's options and validates its point fields.
  document.createElementNS ??= (_namespace, tag) => new Element(tag);
  const added = [];
  for (const [name, value] of [["options", {get() {return this.children;}, configurable: true}], ["checkValidity", {value() {return true;}, configurable: true}], ["click", {value() {}, configurable: true}]])
    if (!(name in Element.prototype)) {Object.defineProperty(Element.prototype, name, value); added.push(name);}
  const unmount = restore; restore = () => {unmount(); for (const name of added) delete Element.prototype[name];};
  globalThis.URL.createObjectURL ??= () => "blob:x"; globalThis.URL.revokeObjectURL ??= () => {};
  const reads = [], writes = [], downloads = [], gates = {};
  let downloadGate = null;
  const request = (path, options = {}) => {
    if (options.method) {writes.push({path, ...options}); return Promise.resolve({});}
    reads.push(path);
    const id = path.split("/")[1];
    if (!hold.includes(id)) return Promise.resolve(ctx(id));
    hold = hold.filter(value => value !== id);
    return new Promise(resolve => {gates[id] = () => resolve(ctx(id));});
  };
  const download = (...args) => {downloads.push(args); return holdDownload ? new Promise(resolve => {downloadGate = () => resolve(new Blob());}) : Promise.resolve(new Blob());};
  const parent = new Element("div"); document.body.append(parent);
  const motion = initSubjectMotion({parent, request, image: async () => new Blob(), download, prepare: async () => {}, canEdit: () => true, changed: async () => {}});
  const source = () => tree(parent).find(element => element.tag === "p" && /Current source/.test(element.textContent))?.textContent ?? "";
  const status = () => tree(parent).find(element => element.getAttribute("role") === "status").textContent;
  const find = text => tree(parent).find(element => element.tag === "button" && element.textContent === text);
  const release = async id => {gates[id](); await settle(); await settle();};
  return {motion, reads, writes, downloads, source, status, find, release, releaseDownload: async () => {downloadGate(); await settle(); await settle();}, parent};
}

/** Open A, and while A's read is in flight, open B -- the owner pressing two shots' buttons in turn. */
async function openBWhileALoads(view) {
  const openA = view.motion.open({source: {id: "A"}}, 24);
  await settle();
  expect(view.reads).toEqual(["/A/subject-motion?maxShots=24"]);
  const openB = view.motion.open({source: {id: "B"}}, 24);
  await settle();
  return {openA, openB};
}

test("A late context reply for the shot opened first does not become the context of the shot opened after it.", async () => {
  const view = panel({hold: ["A"]});
  const {openA, openB} = await openBWhileALoads(view);
  await view.release("A"); await openA; await openB; await settle();
  expect(view.source()).toContain("Current source · B");
  expect(view.source()).not.toContain("Shot A");
});

test("The shot opened while another shot's context was loading has its own context read once that read finishes.", async () => {
  const view = panel({hold: ["A"]});
  const {openA, openB} = await openBWhileALoads(view);
  // B's read waits for the panel: two reads at once would race for the same `context`.
  expect(view.reads).toEqual(["/A/subject-motion?maxShots=24"]);
  await view.release("A"); await openA; await openB; await settle();
  expect(view.reads).toEqual(["/A/subject-motion?maxShots=24", "/B/subject-motion?maxShots=24"]);
  expect(view.status()).toBe("Movement plan loaded.");
  expect(view.motion.unsaved).toBe(false);
});

test("Downloading native inputs after switching shots exports the newly opened shot's saved plan.", async () => {
  const view = panel({hold: ["A"]});
  const {openA, openB} = await openBWhileALoads(view);
  await view.release("A"); await openA; await openB; await settle();
  await view.find("Download native inputs").onclick(); await settle();
  expect(view.downloads).toEqual([["B", "study-B"]]);
});

test("Saving after switching shots sends the newly opened shot's source hash and image to that shot.", async () => {
  const view = panel({hold: ["A"]});
  const {openA, openB} = await openBWhileALoads(view);
  await view.release("A"); await openA; await openB; await settle();
  const form = tree(view.parent).find(element => element.tag === "form");
  form.onsubmit({preventDefault() {}}); await settle(); await settle();
  expect(view.writes.map(write => write.path)).toEqual(["/B/subject-motion"]);
  expect(view.writes[0].body.input).toMatchObject({sourceHash: "hash-B", assetId: "img-B", prompt: "Move B"});
  expect(view.status()).toContain("Movement plan saved.");
});

test("Opening a second shot while the first shot's download is in flight still loads the second shot's context.", async () => {
  const view = panel({holdDownload: true});
  await view.motion.open({source: {id: "A"}}, 24); await settle();
  expect(view.source()).toContain("Current source · A");
  const pressed = view.find("Download native inputs").onclick(); await settle();
  await view.motion.open({source: {id: "B"}}, 24); await settle();
  expect(view.reads).toEqual(["/A/subject-motion?maxShots=24"]);
  await view.releaseDownload(); await pressed; await settle();
  expect(view.downloads).toEqual([["A", "study-A"]]);
  expect(view.reads).toEqual(["/A/subject-motion?maxShots=24", "/B/subject-motion?maxShots=24"]);
  expect(view.source()).toContain("Current source · B");
});
