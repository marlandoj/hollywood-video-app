/**
 * HV-039-10 — reviewing a character sheet while another generated closed it every five seconds.
 *
 * The cast desk's "Generate character sheets" lists every sheet for a character. While any of them
 * is queued or running, `load` runs again every five seconds, and it began
 *
 *     history.replaceChildren();
 *     … details.open=index===0&&job.status==="done"; …
 *
 * rebuilding every sheet's row from nothing. A creator reviewing an earlier, finished sheet had
 * opened it, was ticking "I reviewed this view" on the views to use, and was heading for "Use
 * selected views as references". Every five seconds, for as long as the new sheet took, that sheet
 * closed, keyboard focus dropped to the page body and its images were requested again. The ticks
 * survived because they are stored beside the list, but the creator could no longer see them.
 *
 * Rows are now kept across status checks and rebuilt only when what they show changes. A sheet's
 * progress is written into its own row.
 */
import {afterEach, expect, test} from "bun:test";
import {characterSheets} from "../src/character-sheets.js";
import {fire, mountDom, tree} from "./audio-studio-dom.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
let restore = () => {};
afterEach(() => {restore(); globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout;});

const VIEWS = ["front", "left", "back", "right"];
const sheet = (id, status, checkpointShots = 4) => ({id, status, checkpointShots, castingVersion: 3, castingRevision: "r3",
  characterSheet: {kind: "turnaround", seed: 7000, views: VIEWS},
  ...(status === "done" ? {output: {sheetUrl: "/sheets/" + id + ".png", manifestUrl: "/sheets/" + id + ".json"},
    storyboard: VIEWS.map(view => ({shotId: id + "-" + view, caption: view + " view", url: "/sheets/" + id + "/" + view + ".png"}))} : {})});

async function sheets(jobs) {
  restore = mountDom();
  const checks = [];
  globalThis.setTimeout = (callback, delay) => {
    if (delay !== 5000) return realSetTimeout(callback, delay);
    const timer = {callback, cleared: false}; checks.push(timer); return timer;
  };
  globalThis.clearTimeout = timer => {if (timer && typeof timer === "object" && "cleared" in timer) timer.cleared = true; else realClearTimeout(timer);};
  let current = jobs;
  const view = characterSheets({character: {id: "c1", name: "MAYA", permission: {scope: "project"}, references: []}, snapshot: {version: 3, revision: "r3"}, scenes: [],
    request: async () => ({jobs: current}), prepareGeneration: async () => {}, mutate: async () => {}, dirty: () => false, alive: () => true, assetUrl: url => url});
  view.panel.open = true; fire(view.panel, "toggle"); await settle();
  const history = view.panel.children.at(-1);
  /** A sheet's row: the list shows the sheets in the order the API sends them. */
  const row = id => history.children[current.findIndex(job => job.id === id)];
  const refresh = async () => {await tree(view.panel).find(element => element.tag === "button" && element.textContent === "Refresh sheets").onclick(); await settle();};
  return {
    history, row, refresh,
    set: jobs => {current = jobs;},
    /** The next five-second status check, as the browser would run it. */
    check: async () => {const next = checks.filter(timer => !timer.cleared).at(-1); next.cleared = true; await next.callback(); await settle();},
    pending: () => checks.some(timer => !timer.cleared),
  };
}

test("an earlier sheet being reviewed stays open, with the same controls, while a new one generates", async () => {
  const s = await sheets([sheet("new", "running", 1), sheet("old", "done")]);
  const old = s.row("old");
  expect(old.open).toBe(false);
  old.open = true;
  const tick = tree(old).find(element => element.tag === "input" && element.type === "checkbox");
  tick.checked = true; fire(tick, "change");
  const adopt = tree(old).find(element => element.tag === "button");
  s.set([sheet("new", "running", 2), sheet("old", "done")]);
  await s.check();
  expect(s.row("old")).toBe(old);
  expect(old.open).toBe(true);
  expect(tree(old).includes(tick) && tree(old).includes(adopt)).toBe(true);
  expect(tick.checked).toBe(true);
  // The new sheet's progress is written into its own row.
  expect(s.history.children[0].children.at(-1).textContent).toBe("2 of 4 views complete.");
});

test("a status check that changes nothing leaves every row where it is", async () => {
  const s = await sheets([sheet("new", "running", 1), sheet("old", "done")]);
  const before = [...s.history.children];
  await s.check();
  expect(s.history.children).toEqual(before);
  expect(s.history.children.every((element, i) => element === before[i])).toBe(true);
});

test("when the new sheet finishes, it is drawn with its views and the sheet under review is left alone", async () => {
  const s = await sheets([sheet("new", "running", 3), sheet("old", "done")]);
  const old = s.row("old"); old.open = true;
  s.set([sheet("new", "done"), sheet("old", "done")]);
  await s.check();
  expect(s.row("old")).toBe(old);
  expect(old.open).toBe(true);
  expect(tree(s.history.children[0]).filter(element => element.tag === "img").length).toBe(4);
  expect(s.pending()).toBe(false);
});

test("Refresh sheets still draws every row again, which is how an expired image link is replaced, and keeps what was open", async () => {
  const s = await sheets([sheet("new", "running", 1), sheet("old", "done")]);
  const old = s.row("old"); old.open = true;
  await s.refresh();
  expect(s.row("old")).not.toBe(old);
  expect(s.row("old").open).toBe(true);
});
