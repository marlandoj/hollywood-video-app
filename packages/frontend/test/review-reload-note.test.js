/**
 * HV-029-16 — the review page talks about reloads only on a link that counts viewers by id.
 *
 * HV-029-13 left one sentence in the review page's static intro:
 *
 *     <p class="intro">... In most browsers, reloading this page does not use another view.</p>
 *
 * It is true only on a link minted with an owner-chosen limit (`maxViews` in the review view): those
 * links count each viewer id once. A link minted without one (through the API directly, or before
 * HV-029-05) counts every serve in every browser, so on that page every reload does use a view and
 * the sentence was wrong. The studio's share button always sets a limit, so only such links showed it.
 *
 * The sentence now arrives with the review view, and only when the view has `maxViews`. These run
 * `index.html`'s own module script through `desk-page.js` and read both the intro's reload sentence
 * and HV-029-13's "this browser" note, for a limited link in a browser that remembers the reviewer,
 * a limited link in one whose `sessionStorage` throws, and a link without a limit.
 */
import {expect, test} from "bun:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {openDesk, ok, pathOf} from "./desk-page.js";

const LIMITED = {stage: "final", viewsRemaining: 2, maxViews: 3, output: {hlsUrl: "/h", mp4Url: "/m", captionsUrl: "/c"}};
const {maxViews: _limit, ...UNLIMITED} = LIMITED;
const RELOAD = " In most browsers, reloading this page does not use another view.";
const NOTE = "This browser does not let this page remember you, so each reload will use another view of this link. Keep this page open until you have decided.";

const workingStorage = () => {const values = new Map(); return {getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value))};};
const throwingStorage = () => {const refuse = () => {throw new DOMException("The operation is insecure.", "SecurityError");}; return {getItem: refuse, setItem: refuse};};

/** Open `#/review/tok` answering `response` for the review view; returns what the page says about reloads. */
async function load(storage, response) {
  const fetch = async url => pathOf(url) === "/api/reviews/tok" ? response : ok({});
  const desk = await openDesk({hash: "#/review/tok", fetch, sessionStorage: storage});
  try {
    await desk.settle();
    return {reload: desk.q("#review-reload-note").textContent, note: desk.q("#review-viewer-note").textContent, status: desk.q("#review-status").textContent};
  } finally {desk.restore();}
}

/** A limited link in a browser that keeps the viewer id: the intro says reloads are free, and nothing more. */
test("a limited link in a browser that remembers the reviewer says reloading does not use another view", async () => {
  const shown = await load(workingStorage(), ok(LIMITED));
  expect(shown.reload).toBe(RELOAD);
  expect(shown.note).toBe("");
  expect(shown.status).toContain("Reviewing the final cut");
});

/** A limited link where `sessionStorage` throws: "most browsers" in the intro, and "this browser" in the note. */
test("a limited link where sessionStorage throws says reloads are free in most browsers and will count in this one", async () => {
  const shown = await load(throwingStorage(), ok(LIMITED));
  expect(shown.reload).toBe(RELOAD);
  expect(shown.note).toBe(NOTE);
});

/** A link without `maxViews` counts every serve, so the page makes no claim about reloads in any browser. */
test("a link without a limit says nothing about reloads, whether or not the browser remembers the reviewer", async () => {
  for (const storage of [workingStorage(), throwingStorage()]) {
    const shown = await load(storage, ok(UNLIMITED));
    expect(shown.reload).toBe("");
    expect(shown.note).toBe("");
    expect(shown.status).toContain("Reviewing the final cut");
  }
});

/** Before the view arrives, or when it never does, the page cannot know the link's kind and says nothing. */
test("a link that cannot show the cut says nothing about reloads", async () => {
  const shown = await load(workingStorage(), {ok: false, status: 403, json: async () => ({error: "review link is invalid, expired, revoked, or fully used"})});
  expect(shown.status).toContain("fully used");
  expect(shown.reload).toBe("");
});

/** The static intro no longer carries the claim; it is an empty slot the script fills. */
test("the review page's intro holds an empty slot for the reload sentence instead of the sentence itself", () => {
  const html = readFileSync(join(import.meta.dir, "../src/index.html"), "utf8");
  const intro = /<p class="intro">Choose one decision\.[^\n]*<\/p>/.exec(html)?.[0] ?? "";
  expect(intro.includes('<span id="review-reload-note"></span>')).toBe(true);
  expect(intro.includes("reloading")).toBe(false);
});
