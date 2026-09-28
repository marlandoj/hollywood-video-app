/**
 * HV-039-08 — the take desk locked every control for each 2.5-second status check.
 *
 * While a take group renders (minutes, for three alternatives), `poll` checked it every 2.5 seconds
 * through `run`:
 *
 *     const poll=()=>{…timer=setTimeout(()=>busy?poll():run(()=>load(false)),2500);};
 *
 * `run` sets `busy` and disables every button, input and select in the panel until the request
 * returns. The take draft is on the same panel, and so, every 2.5 seconds:
 *
 * - the field the creator was typing a label or seed into was disabled, so keystrokes were dropped
 *   and a browser that moves focus off a disabled control moved it to the page body;
 * - a click on **Estimate preview takes**, **Render**, or **Adopt selected take direction** that
 *   landed during a check went into `run`, met `if(busy)return`, and was dropped with nothing said;
 * - `groupChoice.replaceChildren()` rebuilt the Saved take group list, closing it if it was open.
 *
 * The check no longer goes through `run`: it changes only what it reports, waits while the
 * creator's own action runs, and keeps the group list's options when the groups are the same.
 */
import {afterEach, expect, test} from "bun:test";
import {DEFAULT_DIRECTION} from "../../planner/src/direction";
import {initTakes} from "../src/takes.js";
import {Element, fire, mountDom, tree} from "./audio-studio-dom.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
let restore = () => {};
afterEach(() => {restore(); globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout;});

const group = (status, checkpointShots) => ({id: "0b7f3a52-9c1e-4d6a-8f2b-5e3c1a9d7f60", stage: "take-preview", status, directionVersion: 1, checkpointShots,
  shotTakes: {source: {id: "s1"}, sourceHash: "hash-s1", takes: [{}, {}, {}]}, takeClips: []});

async function takeDesk() {
  restore = mountDom();
  const checks = [];
  globalThis.setTimeout = (callback, delay) => {
    if (delay !== 2500) return realSetTimeout(callback, delay);
    const timer = {callback, cleared: false}; checks.push(timer); return timer;
  };
  globalThis.clearTimeout = timer => {if (timer && typeof timer === "object" && "cleared" in timer) timer.cleared = true; else realClearTimeout(timer);};
  let status = group("running", 1), held = null;
  const quotes = [];
  const request = async (path, init) => {
    if (path.startsWith("?shotId=")) {
      const answer = {scriptVersion: 1, castingVersion: 1, directionVersion: 1, groups: [status]};
      // A status check the test is holding open, to act while it is in flight.
      if (held) return new Promise(resolve => {held.release = () => resolve(answer);});
      return answer;
    }
    if (path === "/quote") {quotes.push(init.body.stage); return {minimumEstimateUsd: 0.1, maximumEstimateUsd: 0.3, costCapUsd: 1, perTakeCapUsd: 0.4, providerPlanRevision: "r1"};}
    throw new Error("unexpected " + path);
  };
  const plan = {source: {id: "s1", prompt: "Maya pours tea."}, sourceHash: "hash-s1", durationSec: 4, performanceLines: []};
  const parent = new Element("div");
  const takes = initTakes({parent, request, prepareGeneration: async () => {}, prepare: async () => {}, state: () => ({plan: [plan], direction: {entries: []}, defaults: DEFAULT_DIRECTION}),
    canEdit: () => true, adopted: async () => {}, assetUrl: url => url});
  await takes.open(plan); await settle();
  const all = () => tree(parent);
  const labelled = text => all().find(element => element.tag === "label" && element.textContent === text)?.children.find(child => child.tag === "input" || child.tag === "select");
  return {
    all, labelled, quotes,
    form: all().find(element => element.tag === "form"),
    groupChoice: all().find(element => element.getAttribute("aria-label") === "Saved take group"),
    finish: () => {status = group("done", 3);},
    /** Fire the next status check and hold its request open until `release`. */
    async startCheck() {
      held = {};
      const next = checks.filter(timer => !timer.cleared).at(-1);
      next.cleared = true; const running = next.callback(); await settle();
      const release = async () => {held.release(); held = null; await running; await settle();};
      return release;
    },
  };
}

test("typing into the take draft is not locked out while a status check is in flight", async () => {
  const d = await takeDesk();
  const label = d.labelled("Take A label"), seed = d.labelled("Take B seed");
  const release = await d.startCheck();
  expect({label: label.disabled, seed: seed.disabled}).toEqual({label: false, seed: false});
  await release();
  expect({label: label.disabled, seed: seed.disabled}).toEqual({label: false, seed: false});
});

test("Estimate pressed during a status check is carried out, not silently dropped", async () => {
  const d = await takeDesk();
  const release = await d.startCheck();
  fire(d.form, "submit"); await settle(); await settle();
  expect(d.quotes).toEqual(["take-preview"]);
  expect(d.all().some(element => element.tag === "button" && element.textContent === "Render preview takes")).toBe(true);
  await release();
});

test("a status check keeps the group list's options, so an open list is not closed under the pointer", async () => {
  const d = await takeDesk();
  const [option] = d.groupChoice.children;
  expect(option.textContent).toBe("Preview · running · 0b7f3a52");
  d.finish();
  const release = await d.startCheck(); await release();
  expect(d.groupChoice.children[0]).toBe(option);
  expect(option.textContent).toBe("Preview · done · 0b7f3a52");
});
