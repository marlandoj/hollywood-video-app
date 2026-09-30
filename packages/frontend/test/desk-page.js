/**
 * The Director's desk as the browser runs it: `index.html`'s own module script, over stub panels.
 *
 * The desk's defects live in the page's wiring -- the order of two awaits in the submit handler, the
 * body of a POST, which buttons are live while a request is out -- and none of that is in a module
 * a unit test can import. So this reads the script out of `index.html` and runs it, with the same
 * approach `studio-resume-desk.test.js` takes: every `await import(...)` panel is stubbed, `fetch`
 * is the test's, and each element is made on first `querySelector` so a test can reach any of them
 * by the selector the page uses.
 *
 * `setTimeout` is the page's own name for its poll wait, so the harness passes one that records the
 * delay it was asked for and runs on the next turn instead. A test can then drive half an hour of
 * polling in a second and still say exactly how long the page meant to wait.
 */
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {STALL_LIMIT_MS} from "../src/studio.js";
import * as reviewNotes from "../src/review-notes.js";

export class El {
  constructor(tag = "div") {this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.hidden = false; this.disabled = false; this.value = ""; this.checked = false; this.listeners = {}; this.classList = {add() {}, remove() {}, toggle() {}};}
  set textContent(v) {this._t = v;} get textContent() {return this._t ?? "";}
  append(...n) {this.children.push(...n);} prepend(...n) {this.children.unshift(...n);} replaceChildren(...n) {this.children = [...n];}
  after() {} before() {} remove() {} focus() {} load() {} pause() {} removeAttribute() {}
  addEventListener(type, listener) {(this.listeners[type] ??= []).push(listener);}
  setAttribute(k, v) {this.attributes[k] = String(v);} getAttribute(k) {return this.attributes[k] ?? null;}
  /** A test that needs a real answer here (the review panel's buttons) sets `select`. */
  querySelectorAll(selector) {return this.select?.(selector) ?? [];}
  querySelector() {return null;} closest() {return new El("label");} reportValidity() {return true;} canPlayType() {return "";}
}

export const SCRIPT = "INT. LIGHTHOUSE - NIGHT\n\nShe winds the lamp.";
export const ok = value => ({ok: true, status: 200, json: async () => value});
export const refused = (status, error) => ({ok: false, status, json: async () => ({error})});

/**
 * Run the page at `hash` with `fetch`. `setup(q, make)` runs before the script, with `q` the page's
 * own `document.querySelector` and `make` an element factory. Returns `q`, `settle(turns)`, the
 * delays the page asked `setTimeout` for, and `restore()`, which every test calls in `finally`.
 * `sessionStorage` replaces the page's (by default one that keeps nothing) for a test that needs a
 * working one, or one that throws.
 * `modules` replaces any of the stubbed panel modules by file name (HV-029-15).
 */
export async function openDesk({hash = "", fetch, setup = () => {}, sessionStorage, modules: overrides = {}}) {
  const html = readFileSync(join(import.meta.dir, "../src/index.html"), "utf8");
  const body = html.slice(html.indexOf('<script type="module">') + 22, html.lastIndexOf("</script>")).replace(/await import\(([^)]*)\)/g, (_, arg) => `await __import(${arg})`);
  const elements = new Map(), q = selector => {if (!elements.has(selector)) elements.set(selector, new El(selector)); return elements.get(selector);};
  q("#script").value = SCRIPT;
  setup(q, tag => new El(tag));
  const stub = () => ({unsaved: false, open() {}, checkCoverage: async () => {}});
  const modules = {
    // The studio panel is a stub; the desk also reads the studio's stall ceiling, which is real.
    "studio/app.js": {initStudio: () => ({resume: async () => {}}), STALL_LIMIT_MS},
    "living-script.js": {livingScriptResumeMedia: () => ({})},
    "direction/performances.js": {showSpeechReviews() {}},
    "cast/app.js": {initCasting: stub}, "cast/library.js": {showSharedActor() {}},
    "direction/app.js": {initDirection: stub}, "direction/dialogue-replacement.js": {initDialogueReplacement: stub},
    "audio-studio.js": {initAudioStudio: stub}, "lipsync.js": {initLipSync: stub}, "sound-studio.js": {initSoundStudio: stub},
    "editorial.js": {initEditorial: stub}, "graphic-studio.js": {initGraphicStudio: stub},
    // HV-029-15: the review comment box and the owner's review list are real, so a test sees what they draw.
    "review-notes.js": reviewNotes,
    ...overrides,
  };
  const __import = spec => {const key = Object.keys(modules).find(k => spec.endsWith("/api/" + k)); if (!key) throw new Error("no stub for " + spec); return modules[key];};
  const document = {querySelector: q, getElementById: () => null, createElement: t => new El(t), createElementNS: (_, t) => new El(t), querySelectorAll: () => []};
  const prev = {document: globalThis.document, Option: globalThis.Option};
  globalThis.document = document; globalThis.Option = class extends El {constructor(l, v) {super("option"); this.textContent = l; this.value = v;}};
  const location = {hash, origin: "https://studio.test", href: "https://studio.test/" + hash, reload() {}};
  const waits = [];
  const wait = (fn, ms) => {waits.push(ms); return setTimeout(fn, 0);};
  const storage = {getItem: () => null, setItem() {}};
  try {
    const run = new (Object.getPrototypeOf(async function () {}).constructor)("__import", "document", "location", "window", "localStorage", "history", "fetch", "atob", "setTimeout", "sessionStorage", body);
    await run(__import, document, location, {addEventListener() {}, Hls: null}, storage, {replaceState() {}}, fetch, atob, wait, sessionStorage ?? storage);
  } catch (error) {globalThis.document = prev.document; globalThis.Option = prev.Option; throw error;}
  const settle = async (turns = 50) => {for (let i = 0; i < turns; i++) await new Promise(r => setTimeout(r, 0));};
  return {q, settle, waits, restore() {globalThis.document = prev.document; globalThis.Option = prev.Option;}};
}

/** The desk's own path for a request to the test's `fetch`. */
export const pathOf = url => url.replace("https://studio.test", "");
