/**
 * HV-016-14 — a reopened project whose rough cut awaited approval left the studio on an empty pitch.
 *
 * HV-016-09 made the studio rebuild its step from a reopened project link, and `index.html` started
 * it like this:
 *
 *     resumeProject(current.token).then(() => studio.resume())
 *
 * `resumeProject` is the Director's desk's own resume. It does not return when the project is read:
 * for a rough cut that has not been approved it awaits `reviewAnimatic`, which resolves when the
 * creator presses Approve or Send back in the desk's animatic panel, and for a render still running
 * it awaits `pollJob` until the render ends. The desk is hidden behind the Advanced switch, so the
 * creator the studio was built for never pressed either, and `studio.resume()` never ran. They saw
 * the pitch with an empty box -- and the one thing it offered was to pitch again, which renders and
 * charges again, for a rough cut they had already paid for.
 *
 * The studio needs nothing from the desk's resume: `resumeProject` sets `project` before its first
 * await, and the studio reads the project for itself. It now starts at once.
 *
 * The test runs `index.html`'s own module script with the real studio and stubs for the other
 * panels, so it exercises the page's wiring, which the studio's own tests cannot see.
 */
import {expect, test} from "bun:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {initStudio} from "../src/studio.js";
import {livingScriptResumeMedia} from "../src/living-script-state.js";

class El {
  constructor(tag = "div") {this.tag = tag; this.children = []; this.dataset = {}; this.style = {}; this.attributes = {}; this.hidden = false; this.disabled = false; this.value = ""; this.checked = false; this.classList = {add() {}, remove() {}, toggle() {}};}
  set textContent(v) {this._t = v;} get textContent() {return this._t ?? "";}
  append(...n) {this.children.push(...n);} prepend(...n) {this.children.unshift(...n);} replaceChildren(...n) {this.children = [...n];}
  after() {} before() {} remove() {} focus() {} load() {} pause() {} removeAttribute() {} addEventListener() {}
  setAttribute(k, v) {this.attributes[k] = String(v);} getAttribute(k) {return this.attributes[k] ?? null;}
  querySelectorAll(sel) {const tags = sel.split(","), out = []; const walk = e => {for (const c of e.children ?? []) if (c instanceof El) {if (tags.includes(c.tag)) out.push(c); walk(c);}}; walk(this); return out;}
  querySelector() {return null;} closest() {return new El("label");} reportValidity() {return true;} canPlayType() {return "";}
  get lastChild() {return this.children.at(-1) ?? null;}
}
const all = e => (e.children ?? []).flatMap(c => c instanceof El ? [c, ...all(c)] : []);
const SCRIPT = "INT. LIGHTHOUSE - NIGHT\n\nShe winds the lamp.";

/** Runs the page's module script for a reopened project link, answering the project read with `answer`. */
async function reopen(answer) {
  const html = readFileSync(join(import.meta.dir, "../src/index.html"), "utf8");
  const body = html.slice(html.indexOf('<script type="module">') + 22, html.lastIndexOf("</script>")).replace(/await import\(([^)]*)\)/g, (_, arg) => `await __import(${arg})`);
  const byId = new Map(), q = sel => {if (!byId.has(sel)) byId.set(sel, new El(sel)); return byId.get(sel);};
  const token = Buffer.from(JSON.stringify({projectId: "p1"})).toString("base64url") + ".sig";
  const calls = [];
  const fetch = async url => {
    const path = url.replace("https://studio.test", ""); calls.push(path);
    if (path === "/api/projects/p1") return answer();
    return {ok: true, status: 200, json: async () => path === "/api/projects/p1/spend" ? {spentUsd: 1, heldUsd: 0, capUsd: 40} : {}};
  };
  let studio = null;
  const stub = () => ({unsaved: false, open() {}, checkCoverage: async () => {}});
  const mods = {
    "studio/app.js": {initStudio: args => (studio = initStudio(args))},
    "living-script.js": {livingScriptResumeMedia},
    "direction/performances.js": {showSpeechReviews() {}},
    "cast/app.js": {initCasting: stub}, "cast/library.js": {showSharedActor() {}},
    "direction/app.js": {initDirection: stub}, "direction/dialogue-replacement.js": {initDialogueReplacement: stub},
    "audio-studio.js": {initAudioStudio: stub}, "lipsync.js": {initLipSync: stub}, "sound-studio.js": {initSoundStudio: stub},
    "editorial.js": {initEditorial: stub}, "graphic-studio.js": {initGraphicStudio: stub}, "color-grade.js": {initColorGrade: stub},
    "review-notes.js": {initReviewComments: () => ({enable() {}}), renderOwnerReviews() {}},
    "line-notes.js": {initLineNotes: () => ({sync() {}})},
  };
  const __import = spec => {const key = Object.keys(mods).find(k => spec.endsWith("/api/" + k)); if (!key) throw new Error("no stub for " + spec); return mods[key];};
  const document = {querySelector: q, getElementById: () => null, createElement: t => new El(t), createElementNS: (_, t) => new El(t), querySelectorAll: () => []};
  const prev = {document: globalThis.document, Option: globalThis.Option};
  globalThis.document = document; globalThis.Option = class extends El {constructor(l, v) {super("option"); this.textContent = l; this.value = v;}};
  const location = {hash: "#/p/" + token, origin: "https://studio.test", href: "https://studio.test/#/p/" + token, reload() {}};
  try {
    const run = new (Object.getPrototypeOf(async function () {}).constructor)("__import", "document", "location", "window", "localStorage", "history", "fetch", "atob", body);
    await run(__import, document, location, {addEventListener() {}, Hls: null}, {getItem: () => null, setItem() {}}, {replaceState() {}}, fetch, atob);
    for (let i = 0; i < 100; i++) await new Promise(r => setTimeout(r, 0));
  } finally {globalThis.document = prev.document; globalThis.Option = prev.Option;}
  const studioText = all(q("#studio")).map(e => e.textContent).join("\n");
  return {studio, calls, studioText, deskStatus: q("#status").textContent, animaticPanel: q("#animatic")};
}

test("a reopened rough cut awaiting approval resumes the studio to the rough cut, while the desk still waits on its own panel", async () => {
  const animatic = {id: "animatic-1", stage: "animatic", status: "done", scriptVersion: 1, castingVersion: 0, directionVersion: 0, completedAt: "2026-09-27T00:00:00Z",
    output: {hlsUrl: "/h", mp4Url: "/m", captionsUrl: "/c"}, storyboard: []};
  const project = {script: SCRIPT, scriptVersion: 1, castingVersion: 0, directionVersion: 0, rightsAttestedAt: "x",
    jobs: [animatic], animaticApprovals: [], dialogueSelections: {version: 0, entries: []}, expiresAt: "2026-10-01T00:00:00Z"};
  const page = await reopen(() => ({ok: true, status: 200, json: async () => project}));
  expect(page.studio.flow.state.step).toBe("rough-cut");
  expect(page.studio.flow.state.animatic.id).toBe("animatic-1");
  expect(page.studio.flow.state.script).toBe(SCRIPT);
  expect(page.studioText).toContain("does not render it again");
  // The desk resumed as it did, and is still waiting at its own approval, which is where it belongs.
  expect(page.animaticPanel.hidden).toBe(false);
  // And the studio read the project for itself: the desk and the studio each asked once.
  expect(page.calls.filter(path => path === "/api/projects/p1").length).toBe(2);
});

test("a link that cannot reopen is still reported by the desk, and the studio says so instead of waiting", async () => {
  const page = await reopen(() => ({ok: false, status: 404, json: async () => ({error: "This project has expired."})}));
  expect(page.deskStatus).toContain("Your project link is retained. Reload to retry.");
  expect(page.studio.flow.state.step).toBe("pitch");
  expect(page.studioText).not.toContain("Opening your film.");
  expect(page.studioText).toContain("This project has expired.");
});
