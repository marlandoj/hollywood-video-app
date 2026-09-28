/**
 * HV-022-20 — a lip-sync pass the server refused stayed saved for ever, and locked the studio.
 *
 * "Render reviewed lip-sync" saves the request in localStorage before it is sent, so a lost reply
 * can be checked later with the same idempotency key. Only success ever cleared it:
 *
 *     const admitted=await request("/"+pending.sourceId,{method:"POST",body:pending.body});
 *     remember(null);dirty=false;…
 *
 * A request the server refuses outright -- a 400 because the provider policy moved on, a 403, a
 * 409, a 422 -- threw before `remember(null)`. The saved request stayed, and everything around it
 * refused because of it:
 *
 * - "Check or resume saved request" sent the same doomed body again, and was refused again;
 * - "Discard speaker draft" said "Resolve the saved request before discarding its draft.";
 * - "Load applied lines" was disabled, and "Open result" said "Resolve the saved request before
 *   opening another result.";
 * - `unsaved` stayed true, so the page's `canEdit` kept the sound session, picture editorial and
 *   the graphics desk shut -- across reloads, because the request lives in localStorage.
 *
 * The only way out was clearing site data by hand. Now a definite refusal (400-499, except 408 and
 * 429, which say "try again") clears the saved request and its confirmation, reads the catalogue
 * again, and says the pass was not saved and that a new pass must be reviewed. A network error, a
 * 408, a 429 or a 5xx still keeps the request, because the server may yet have admitted it, and
 * checking it again sends the same key.
 */
import {afterEach, expect, test} from "bun:test";
import {initLipSync} from "../src/lipsync.js";
import {fire, mountDom, tree} from "./audio-studio-dom.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
let restore = () => {};
afterEach(() => {restore(); delete globalThis.localStorage;});

const KEY = "hv-lipsync-pending:p1";
const saved = (key = "k1") => ({sourceId: "src1", body: {idempotencyKey: key, generationApproved: true, sourceRevision: "r", policyRevision: "old-policy", capabilityRevision: "c", shotId: "s1", lineIndex: 0,
  selection: {frame: 0, width: 10, height: 10, rgbSha256: "x", x: 1, y: 1}}});
const refusal = (status, message = "Review the current provider and reserved cost before submitting.") => Object.assign(new Error(message), {status});
const LINE = {character: "Mara", text: "We should go.", voiceLabel: "Warm", shotId: "s1", lineIndex: 0, window: {startFrame: 0, frames: 30}};

/**
 * The lip-sync panel for project p1, with `post` answering every submission. `stored` is what
 * localStorage held when the page opened. The catalogue's policy revision is `revisions[n]` on the
 * n-th read, so a test can see a refusal read it again.
 */
async function panel({stored = saved(), post, revisions = ["new-policy"]} = {}) {
  restore = mountDom();
  const store = new Map(stored ? [[KEY, JSON.stringify(stored)]] : []);
  globalThis.localStorage = {getItem: key => store.get(key) ?? null, setItem: (key, value) => store.set(key, String(value)), removeItem: key => store.delete(key)};
  const posts = [], reads = {catalogue: 0};
  const request = async (path, options = {}) => {
    if (path === "") {const revision = revisions[Math.min(reads.catalogue++, revisions.length - 1)];
      return {enabled: true, policy: {label: "Provider", heldUsd: 1, revision}, capabilityRevision: "c", sources: [{id: "src1", stage: "dialogue-replacement", lines: 1}], jobs: []};}
    if (path === "/src1" && options.method === "POST") {posts.push(options.body); return post(options.body, posts.length);}
    if (path === "/src1") return {sourceJobId: "src1", sourceRevision: "r", lines: [LINE]};
    if (path === "/src1/preview") return {frame: 0, width: 10, height: 10, rgbSha256: "x", image: "data:image/png;base64,"};
    throw new Error("unexpected " + path);
  };
  const parent = document.createElement("div"); document.body.append(parent);
  const lip = initLipSync({parent, request, jobRequest: async id => ({id, status: "queued", lipSync: {character: "Mara"}}), projectState: async () => ({}), assetUrl: url => url, adopt: async () => ({}), projectId: () => "p1", canEdit: () => true});
  await lip.open(); await settle();
  const find = text => tree(parent).find(element => element.tag === "button" && element.textContent === text);
  const press = async text => {await find(text).onclick(); await settle();};
  const status = () => tree(parent).find(element => element.getAttribute("role") === "status");
  return {lip, store, posts, reads, find, press, status, parent};
}

test("A saved request the server refuses with a 400 is cleared, and the panel says the pass was not saved.", async () => {
  const view = await panel({post: () => {throw refusal(400);}});
  expect(view.lip.unsaved).toBe(true);
  await view.press("Check or resume saved request");
  expect(view.posts.length).toBe(1);
  expect(view.store.has(KEY)).toBe(false);
  expect(view.lip.unsaved).toBe(false);
  expect(view.find("Check or resume saved request")).toBeUndefined();
  expect(view.status().dataset.state).toBe("error");
  expect(view.status().textContent).toBe("This lip-sync pass was not saved. Review the current provider and reserved cost before submitting. Review a new pass before rendering.");
});

test("After a refusal the owner can discard the speaker draft and load applied lines again.", async () => {
  const view = await panel({post: () => {throw refusal(400);}});
  expect(view.find("Load applied lines").disabled).toBe(true);
  await view.press("Check or resume saved request");
  // The catalogue was read again, so the controls it draws no longer wait on the saved request.
  expect(view.reads.catalogue).toBe(2);
  expect(view.find("Load applied lines").disabled).toBe(false);
  await view.press("Discard speaker draft");
  expect(view.status().textContent).toBe("Speaker draft discarded. Retained results remain available.");
  await view.press("Load applied lines");
  expect(view.status().dataset.state).not.toBe("error");
  expect(view.find("Choose speaker frame")).toBeDefined();
});

test("Every definite refusal clears the saved request, while a 408 or a 429 keeps it.", async () => {
  for (const code of [400, 403, 404, 409, 410, 422, 499]) {
    const view = await panel({post: () => {throw refusal(code, "Refused.");}});
    await view.press("Check or resume saved request");
    expect({code, stored: view.store.has(KEY), unsaved: view.lip.unsaved}).toEqual({code, stored: false, unsaved: false});
    restore();
  }
  for (const code of [408, 429]) {
    const view = await panel({post: () => {throw refusal(code, "Try again shortly.");}});
    await view.press("Check or resume saved request");
    expect({code, stored: view.store.has(KEY), unsaved: view.lip.unsaved, resume: Boolean(view.find("Check or resume saved request"))}).toEqual({code, stored: true, unsaved: true, resume: true});
    expect(view.status().textContent).toBe("Try again shortly.");
    restore();
  }
});

test("A network error or a 5xx keeps the saved request, and checking it again resends the same key.", async () => {
  const outcomes = [() => {throw new TypeError("Failed to fetch");}, () => {throw refusal(503, "The studio is busy.");}, () => ({jobId: "lip-00000001"})];
  const view = await panel({post: (_body, n) => outcomes[n - 1]()});
  await view.press("Check or resume saved request");
  expect(view.store.has(KEY)).toBe(true);
  expect(view.lip.unsaved).toBe(true);
  expect(view.status().textContent).toBe("Failed to fetch");
  await view.press("Check or resume saved request");
  expect(view.store.has(KEY)).toBe(true);
  expect(view.status().textContent).toBe("The studio is busy.");
  await view.press("Check or resume saved request");
  expect(view.posts.map(body => body.idempotencyKey)).toEqual(["k1", "k1", "k1"]);
  expect(view.store.has(KEY)).toBe(false);
  expect(view.lip.unsaved).toBe(false);
});

test("A pass refused as it is rendered keeps the speaker draft, and the next review carries the policy read again.", async () => {
  const view = await panel({stored: null, revisions: ["old-policy", "new-policy"], post: (_body, n) => {if (n === 1) throw refusal(400); return {jobId: "lip-00000001"};}});
  await view.press("Load applied lines");
  await view.press("Choose speaker frame");
  const [x, y] = tree(view.parent).filter(element => element.tag === "input" && element.type === "number" && element.max === 9);
  fire(x, "input", "4"); fire(y, "input", "5");
  await view.press("Review lip-sync pass");
  await view.press("Render reviewed lip-sync");
  expect(view.posts[0].policyRevision).toBe("old-policy");
  expect(view.store.has(KEY)).toBe(false);
  expect(view.find("Render reviewed lip-sync")).toBeUndefined();
  expect(view.status().textContent).toContain("This lip-sync pass was not saved.");
  // The draft is still here to review again: the owner marked a face and should not have to twice.
  await view.press("Review lip-sync pass");
  await view.press("Render reviewed lip-sync");
  expect(view.posts[1].policyRevision).toBe("new-policy");
  expect(view.posts[1].idempotencyKey).not.toBe(view.posts[0].idempotencyKey);
  expect(view.store.has(KEY)).toBe(false);
});
