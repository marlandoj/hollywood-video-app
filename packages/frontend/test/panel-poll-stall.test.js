/**
 * HV-024-07 — the sound session and dialogue replacement waited on a stuck version for ever.
 *
 * Both panels wait for a rendered version with a loop that has no way out but a terminal status:
 *
 *     async function poll(id){for(;;){const job=await jobRequest(id);if(job.status==="done")return job;
 *       if(["failed","cancelled"].includes(job.status))throw …;tell(…);await new Promise(resolve=>setTimeout(resolve,1500));}}
 *
 * A version that never leaves "queued" -- no sound worker running, a lease the queue has given up
 * on -- was read every 1.5 seconds for as long as the tab stayed open. The wait runs inside the
 * panel's `run()`, so for all of that time every control was disabled, "Close sound session"
 * included, and `unsaved` stayed true, which kept the page's other editors shut too. Rendering a
 * reviewed session, opening a retained sound version and "Wait for this version" all ended there.
 *
 * HV-030-08 fixed this shape in studio.js: `pollJob` counts the polls on which nothing moved and
 * gives up after `STALL_LIMIT_MS` of them, saying the render is still on the server. Both panels
 * now keep the same clock, on the same 1.5-second interval: a poll that sees the same status and
 * output revision as the one before counts, any change starts the count again, and after thirty
 * unchanged minutes the panel stops waiting. It says the version is still retained on the server
 * and where to open it later. A reviewed draft keeps its request key, so rendering it again returns
 * the same version rather than starting another.
 */
import {afterEach, expect, test} from "bun:test";
import {POLL_INTERVAL_MS as STUDIO_INTERVAL, STALL_LIMIT_MS as STUDIO_LIMIT} from "../src/studio.js";
import {POLL_INTERVAL_MS as SOUND_INTERVAL, STALL_LIMIT_MS as SOUND_LIMIT, initSoundStudio} from "../src/sound-studio.js";
import {POLL_INTERVAL_MS as DIALOGUE_INTERVAL, STALL_LIMIT_MS as DIALOGUE_LIMIT, initDialogueReplacement} from "../src/dialogue-replacement.js";
import {Element, fire, mountDom, tree} from "./audio-studio-dom.js";

/** Thirty minutes of 1.5-second polls. The first read starts the count; this many more give up. */
const STALL_POLLS = Math.ceil(STUDIO_LIMIT / STUDIO_INTERVAL);
const HARNESS_LIMIT = 5000; // Over two hours of simulated polling: past this, the loop has no ceiling.
const realTimeout = globalThis.setTimeout;
const settle = () => new Promise(resolve => realTimeout(resolve, 0));
let restore = () => {};
afterEach(() => {restore(); globalThis.setTimeout = realTimeout;});

/** The page, with the panels' 1.5-second wait answered at once, so hours of polling run in milliseconds. */
function page() {
  const unmount = mountDom();
  globalThis.setTimeout = (fn, ms, ...args) => ms === 1500 ? (queueMicrotask(() => fn(...args)), 0) : realTimeout(fn, ms, ...args);
  Element.prototype.pause = Element.prototype.load = function () {};
  Object.defineProperty(Element.prototype, "classList", {get() {return {add() {}, remove() {}};}, configurable: true});
  restore = () => {unmount(); delete Element.prototype.pause; delete Element.prototype.load; delete Element.prototype.classList;};
  const parent = document.createElement("div"); document.body.append(parent);
  const find = text => tree(parent).find(element => element.tag === "button" && element.textContent === text);
  const status = () => tree(parent).find(element => element.getAttribute("role") === "status");
  return {parent, find, status};
}

/** A job read that answers `answer(n)` on the n-th read of `id`, and stops the test if the loop never does. */
function jobs(id, answer, others = {}) {
  let reads = 0;
  const jobRequest = async requested => {
    if (requested !== id) return others[requested];
    reads++;
    if (reads >= HARNESS_LIMIT) throw new Error("harness stopped the loop");
    return {id, ...answer(reads)};
  };
  return {jobRequest, reads: () => reads};
}

const stuck = () => ({status: "queued"});

test("Both panels poll on the studio's interval and stop at the studio's stall limit.", () => {
  expect([SOUND_INTERVAL, DIALOGUE_INTERVAL]).toEqual([STUDIO_INTERVAL, STUDIO_INTERVAL]);
  expect([SOUND_LIMIT, DIALOGUE_LIMIT]).toEqual([STUDIO_LIMIT, STUDIO_LIMIT]);
  expect(STALL_POLLS).toBe(1200);
});

/** The sound session, open, with one retained version in its history. */
async function soundSession(job, request = async () => ({library: {version: 0, assets: [], events: []}, jobs: [{id: "stuck-job-0001", status: "queued"}], sources: []})) {
  const view = page();
  const studio = initSoundStudio({parent: view.parent, request, libraryRequest: async () => ({}), recording: async () => new Blob(), jobRequest: job.jobRequest,
    projectState: async () => ({dialogueSelections: {version: 0, entries: []}}), assetUrl: url => url, canEdit: () => true, adopt: async () => ({})});
  await studio.open(); await settle();
  return {...view, studio};
}

test("Opening a sound version that never leaves queued stops after thirty unchanged minutes and says the version is retained.", async () => {
  let during = null;
  const job = jobs("stuck-job-0001", n => {if (n === 10) during = {closeDisabled: view.find("Close sound session").disabled, unsaved: view.studio.unsaved}; return stuck();});
  const view = await soundSession(job);
  await view.find("Open sound version stuck-jo").onclick(); await settle();
  // While it waited the panel was held, as before: that is why the wait needs an end.
  expect(during).toEqual({closeDisabled: true, unsaved: true});
  expect(job.reads()).toBe(STALL_POLLS + 1);
  expect(view.status().dataset.state).toBe("error");
  expect(view.status().textContent).toBe("This sound version has not moved for 30 minutes. It is still queued on the server as version stuck-jo, so nothing has been lost: "
    + "open it later from Retained sound versions. Rendering the same reviewed session again returns this version rather than starting another.");
  expect(view.find("Close sound session").disabled).toBe(false);
  expect(view.studio.unsaved).toBe(false);
});

test("A sound version whose status or output revision keeps changing is waited on past the stall limit until it is done.", async () => {
  // Each change comes before 1,200 unchanged polls, so the count starts again every time.
  const job = jobs("stuck-job-0001", n => n < 1000 ? {status: "queued"} : n < 2000 ? {status: "running", outputRevision: "a"} : n < 3000 ? {status: "running", outputRevision: "b"} : {status: "done", mediaUnavailable: "Expired."});
  const view = await soundSession(job);
  await view.find("Open sound version stuck-jo").onclick(); await settle();
  expect(job.reads()).toBe(3001); // 3,000 polls, then the read `show` makes of the finished version
  expect(view.status().dataset.state).not.toBe("error");
});

test("Rendering a reviewed sound session that stalls keeps the draft, and rendering it again sends the same request key.", async () => {
  const posts = [];
  const request = async (path, options = {}) => {
    if (options.method === "POST") {posts.push(options.body); return {jobId: "mix-00000001"};}
    if (path === "/cut-00000001") return {sourceJobId: "cut-00000001", durationSec: 2, language: "en", sourceRevision: "r", engineVersion: "e", library: {version: 0, assets: [], events: []}};
    return {library: {version: 0, assets: [], events: []}, jobs: [], sources: [{id: "cut-00000001", stage: "final"}]};
  };
  const job = jobs("mix-00000001", stuck);
  const view = await soundSession(job, request);
  await view.find("Load sound session").onclick(); await settle();
  tree(view.parent).find(element => element.tag === "form" && element.onsubmit && tree(element).some(child => child.textContent === "Review sound session")).onsubmit({preventDefault() {}});
  await settle();
  await view.find("Render reviewed sound session").onclick(); await settle();
  expect(job.reads()).toBe(STALL_POLLS + 1);
  expect(view.status().textContent).toStartWith("This sound version has not moved for 30 minutes. It is still queued on the server as version mix-0000");
  // The reviewed draft is still here, with its key.
  expect(view.studio.unsaved).toBe(true);
  await view.find("Render reviewed sound session").onclick(); await settle();
  expect(posts.length).toBe(2);
  expect(posts[1].idempotencyKey).toBe(posts[0].idempotencyKey);
});

/** Dialogue replacement, open on one retained cut with one spoken line, and one queued version of it. */
async function dialogueDesk(job, posts = []) {
  const view = page();
  const later = new Date(Date.now() + 864e5).toISOString();
  const cut = {id: "cut-00000001", stage: "final", status: "done", scriptVersion: 1, linkExpiresAt: later, shotRenders: [{speech: {}}], output: {mp4Url: "/m.mp4", captionsUrl: "/c.vtt"}};
  const version = {id: "adr-00000001", stage: "dialogue-replacement", status: "queued", dialogueReplacement: {sourceJobId: cut.id}};
  const line = {shotId: "s1", index: 0, character: "Mara", text: "We should go.", startSec: 0, availableSec: 2, sourceHash: "h", voice: {voice: "en-us", rateWpm: 160, pitch: 50, level: 100, pronunciations: []}, auditions: []};
  const request = async (path, options = {}) => {
    if (options.method === "POST") {posts.push(options.body); return {jobId: "adr-00000002"};}
    return {sourceJobId: cut.id, originalJobId: cut.id, sourceRevision: "r", engineVersion: "e", durationSec: 2, lines: [line], narration: null};
  };
  const jobRequest = async id => id === cut.id ? cut : job.jobRequest(id);
  const desk = initDialogueReplacement({parent: view.parent, request, projectState: async () => ({jobs: [cut, version], dialogueSelections: {version: 0, entries: []}}), jobRequest, assetUrl: url => url, canEdit: () => true, adopt: async () => ({})});
  await desk.open(); await settle();
  return {...view, desk};
}

test("Waiting for a retained dialogue version that never leaves queued stops after thirty unchanged minutes and says the version is retained.", async () => {
  const job = jobs("adr-00000001", stuck);
  const view = await dialogueDesk(job);
  await view.find("Open retained dialogue version").onclick(); await settle();
  const before = job.reads();
  await view.find("Wait for this version").onclick(); await settle();
  expect(job.reads() - before).toBe(STALL_POLLS + 1);
  expect(view.status().dataset.state).toBe("error");
  expect(view.status().textContent).toBe("This dialogue version has not moved for 30 minutes. It is still queued on the server as version adr-0000, so nothing has been lost: "
    + "open it later from Browse all dialogue versions. Rendering the same reviewed lines again returns this version rather than starting another.");
  expect(view.find("Wait for this version").disabled).toBe(false);
  expect(view.desk.unsaved).toBe(false);
});

test("Rendering reviewed dialogue lines that stall keeps the draft, and rendering them again sends the same request key.", async () => {
  const posts = [], job = jobs("adr-00000002", stuck);
  const view = await dialogueDesk(job, posts);
  const replace = tree(view.parent).find(element => element.tag === "input" && element.type === "checkbox" && element.id && tree(view.parent).some(label => label.tag === "label" && label.htmlFor === element.id && label.textContent === "Replace 1 · Mara"));
  replace.checked = true; fire(replace, "change");
  tree(view.parent).find(element => element.tag === "form" && element.onsubmit).onsubmit({preventDefault() {}});
  await settle();
  await view.find("Render reviewed lines").onclick(); await settle();
  expect(job.reads()).toBe(STALL_POLLS + 1);
  expect(view.status().textContent).toStartWith("This dialogue version has not moved for 30 minutes. It is still queued on the server as version adr-0000");
  expect(view.desk.unsaved).toBe(true);
  await view.find("Render reviewed lines").onclick(); await settle();
  expect(posts.length).toBe(2);
  expect(posts[1].idempotencyKey).toBe(posts[0].idempotencyKey);
});
