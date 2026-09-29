/**
 * HV-017-14 — retrying a character sheet whose answer was lost admitted it, and paid for it, twice.
 *
 * "Generate character sheet" posts to `/cast/:id/sheets` with an idempotency key, and the server
 * admits one job per key: a second request with the key the first used gets the first job back
 * with `admitted: false`. The panel made a new key on every press:
 *
 *     idempotencyKey: crypto.randomUUID()
 *
 * so when the server admitted the sheet but its answer never arrived -- a 502 from the proxy, a
 * dropped connection -- the panel said the sheet could not start, and pressing the button again,
 * the one thing it invited, was a new key and a second paid sheet. The key only protected against
 * a double click, which `submitting` already did.
 *
 * The panel now keeps the key of a submission whose outcome it does not know, with what that
 * submission asked for, and sends it again when the creator asks for the same sheet. A different
 * sheet -- another seed, type or scene -- or one asked for after the last one was answered gets a
 * new key, as before.
 */
import {afterEach, expect, test} from "bun:test";
import {characterSheets} from "../src/character-sheets.js";
import {fire, mountDom, tree} from "./audio-studio-dom.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
let restore = () => {};
afterEach(() => restore());

/** The panel for one character, with each POST's answer lost or given as the test says. */
async function sheets(lose) {
  restore = mountDom();
  const posts = [];
  const request = async (path, init) => {
    if (init?.method === "POST") {
      posts.push(init.body);
      if (lose(posts.length)) throw Object.assign(new Error("Request failed (502)"), {status: 502});
      return {jobId: "sheet-" + posts.length};
    }
    return {jobs: []};
  };
  const view = characterSheets({character: {id: "c1", name: "MAYA", permission: {scope: "project"}, references: []}, snapshot: {version: 3}, scenes: [],
    request, prepareGeneration: async () => {}, mutate: async () => {}, dirty: () => false, alive: () => true, assetUrl: url => url});
  view.panel.open = true; fire(view.panel, "toggle"); await settle();
  const find = test => tree(view.panel).find(test);
  return {posts, press: () => find(element => element.tag === "button" && element.textContent === "Generate character sheet").onclick(),
    seed: find(element => element.tag === "input" && element.type === "number"),
    status: () => find(element => element.getAttribute?.("role") === "status").textContent};
}

test("pressing Generate again after the answer was lost sends the same key, so the server finds the sheet it admitted", async () => {
  const s = await sheets(count => count === 1);
  await s.press();
  expect(s.status()).toContain("502");
  await s.press();
  expect(s.posts).toHaveLength(2);
  expect(s.posts[1].idempotencyKey).toBe(s.posts[0].idempotencyKey);
  expect(s.posts[1]).toEqual(s.posts[0]);
  expect(s.status()).toContain("Sheet queued");
});

test("a different sheet after a lost answer gets its own key", async () => {
  const s = await sheets(count => count === 1);
  await s.press();
  s.seed.value = "7001";
  await s.press();
  expect(s.posts.map(body => body.settings.seed)).toEqual([7000, 7001]);
  expect(s.posts[1].idempotencyKey).not.toBe(s.posts[0].idempotencyKey);
});

test("and the same sheet asked for again after it was answered is a new sheet, as before", async () => {
  const s = await sheets(() => false);
  await s.press();
  await s.press();
  expect(s.posts[1].idempotencyKey).not.toBe(s.posts[0].idempotencyKey);
});
