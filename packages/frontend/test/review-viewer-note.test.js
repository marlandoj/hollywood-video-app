/**
 * HV-029-13 (G15) — where `sessionStorage` throws, every reload of a review link was another viewer,
 * while the owner had been told that reloading does not count.
 *
 * HV-029-05 made a reload free by keeping one random viewer id per tab in `sessionStorage` and sending
 * it with the link's two API calls. `reviewViewerId` swallowed a storage failure and returned a fresh
 * id, so in Safari private browsing, a sandboxed iframe or some webviews each load was a new viewer and
 * spent a view of a link with a limit -- silently, on both sides:
 *
 *     output.textContent = link.reviewUrl + " — " + link.maxViews + " viewer(s) can open it; reloading does not count.";
 *     <p class="intro">... Reloading this page does not use another view.</p>
 *
 * Kevin's decision (G15, 2026-09-30): stay cookie-free (ADR-0018) and say so. The reviewer is told,
 * in a polite status, that this browser cannot be remembered and reloads will count; the owner's and
 * the review page's copy say reloads don't count "in most browsers".
 *
 * These run `index.html`'s own module script through `desk-page.js`, with the page's `sessionStorage`
 * replaced by one that works, one that throws, or one that accepts a write and keeps nothing.
 */
import {expect, test} from "bun:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {openDesk, ok, pathOf} from "./desk-page.js";

const VIEW = {stage: "final", viewsRemaining: 2, maxViews: 3, output: {hlsUrl: "/h", mp4Url: "/m", captionsUrl: "/c"}};
const NOTE = "This browser does not let this page remember you, so each reload will use another view of this link. Keep this page open until you have decided.";

const workingStorage = () => {const values = new Map(); return {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), values};};
const throwingStorage = () => {const refuse = () => {throw new DOMException("The operation is insecure.", "SecurityError");}; return {getItem: refuse, setItem: refuse};};
/** Accepts the write without an error and keeps nothing: an in-memory store that is dropped at once. */
const forgetfulStorage = () => ({getItem: () => null, setItem() {}});

/** Open `#/review/tok` with `storage` as the page's `sessionStorage`; returns the viewer id sent and the note. */
async function load(storage, view = VIEW) {
  const sent = [];
  const fetch = async (url, options = {}) => {
    if (pathOf(url) === "/api/reviews/tok") {sent.push(options.headers?.["x-hv-review-viewer"]); return ok(view);}
    return ok({});
  };
  const desk = await openDesk({hash: "#/review/tok", fetch, sessionStorage: storage});
  try {
    await desk.settle();
    const note = desk.q("#review-viewer-note");
    return {id: sent[0], note: note.textContent, status: desk.q("#review-status").textContent};
  } finally {desk.restore();}
}

test("where sessionStorage works, a reload sends the same viewer id and the reviewer is told nothing", async () => {
  const storage = workingStorage();
  const first = await load(storage), second = await load(storage);
  expect(first.id).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
  expect(second.id).toBe(first.id);
  expect(storage.values.get("hv-review-viewer:tok")).toBe(first.id);
  expect(first.note).toBe("");
  expect(second.note).toBe("");
  expect(second.status).toContain("Reviewing the final cut");
});

test("where sessionStorage throws, each load is a new viewer and the reviewer is told reloads will count", async () => {
  const first = await load(throwingStorage()), second = await load(throwingStorage());
  expect(first.id).toMatch(/^[A-Za-z0-9_-]{22,64}$/);
  expect(second.id).not.toBe(first.id);
  expect(first.note).toBe(NOTE);
  expect(first.status).toContain("Reviewing the final cut");
});

test("a sessionStorage that accepts the write but keeps nothing is caught too: the id is read back, not assumed", async () => {
  expect((await load(forgetfulStorage())).note).toBe(NOTE);
});

test("a link without an owner-chosen limit says nothing about this browser, even where it cannot be remembered", async () => {
  const {maxViews, ...unlimited} = VIEW;
  const shown = await load(throwingStorage(), unlimited);
  expect(maxViews).toBe(3);
  expect(shown.note).toBe("");
  expect(shown.status).toContain("Reviewing the final cut");
});

test("a link that cannot show the cut says nothing about reloads", async () => {
  const fetch = async url => pathOf(url) === "/api/reviews/tok" ? {ok: false, status: 403, json: async () => ({error: "review link is invalid, expired, revoked, or fully used"})} : ok({});
  const desk = await openDesk({hash: "#/review/tok", fetch, sessionStorage: throwingStorage()});
  try {
    await desk.settle();
    expect(desk.q("#review-status").textContent).toContain("fully used");
    expect(desk.q("#review-viewer-note").textContent).toBe("");
  } finally {desk.restore();}
});

test("the owner's link copy says reloads don't count in most browsers", async () => {
  const views = 4;
  const fetch = async (url, options = {}) => {
    const path = pathOf(url);
    if (path === "/api/projects/p1/reviews" && options.method === "POST") return ok({reviewUrl: "https://studio.test/#/review/r1", maxViews: JSON.parse(options.body).maxViews});
    return ok({});
  };
  const token = Buffer.from(JSON.stringify({projectId: "p1"})).toString("base64url") + ".sig";
  const desk = await openDesk({hash: "#/p/" + token, fetch, setup: q => {q("#share-views").value = String(views);}});
  try {
    await desk.settle();
    for (const listener of desk.q("#share").listeners.click) listener();
    await desk.settle();
    expect(desk.q("#share-output").textContent).toBe("https://studio.test/#/review/r1 — 4 viewer(s) can open it; in most browsers, reloading does not count.");
  } finally {desk.restore();}
});

test("the page no longer says, flatly, that reloading does not count; the reviewer's note is a polite status", () => {
  const html = readFileSync(join(import.meta.dir, "../src/index.html"), "utf8");
  // Booleans, so a failure names the claim rather than printing the whole page.
  expect(html.includes("In most browsers, reloading this page does not use another view.")).toBe(true);
  expect(/\. Reloading this page does not use another view/.test(html)).toBe(false);
  expect(/it; reloading does not count/.test(html)).toBe(false);
  expect(/<p id="review-viewer-note"[^>]*role="status"[^>]*aria-live="polite"[^>]*><\/p>/.test(html)).toBe(true);
});
