/**
 * HV-039-18 — a take status check for one shot, answered after the creator switched shots, drew the
 * first shot's take groups under the second.
 *
 * While a take group renders, the take desk checks its status every 2.5 seconds with
 * `load(false)`, which asks for `?shotId=<the shot open now>` and, when the answer comes back, writes
 * it into the panel. The answer was written whatever shot was open by then. A creator who pressed
 * "Compare takes for s2" while s1's check was in flight saw s2's heading and prompt above s1's
 * saved take groups, with s1's takes in the player -- and "Adopt selected take direction" there
 * adopted s1's direction while the panel said s2.
 *
 * `load` now remembers which shot it asked about and drops an answer for a shot that is no longer
 * open.
 */
import {afterEach, expect, test} from "bun:test";
import {DEFAULT_DIRECTION} from "../../planner/src/direction";
import {initTakes} from "../src/takes.js";
import {Element, mountDom, tree} from "./audio-studio-dom.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
let restore = () => {};
afterEach(() => {restore(); globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout;});
const group = (id, shot, status) => ({id, stage: "take-preview", status, directionVersion: 1, checkpointShots: 1,
  shotTakes: {source: {id: shot}, sourceHash: "hash-" + shot, takes: [{}, {}, {}]}, takeClips: []});

/** The take desk with s1 rendering, its 2.5-second checks under the test's hand, and s1's answer holdable. */
async function desk() {
  restore = mountDom();
  const checks = [];
  globalThis.setTimeout = (callback, delay) => {if (delay !== 2500) return realSetTimeout(callback, delay); const timer = {callback, cleared: false}; checks.push(timer); return timer;};
  globalThis.clearTimeout = timer => {if (timer && typeof timer === "object" && "cleared" in timer) timer.cleared = true; else realClearTimeout(timer);};
  let hold = false, release = null;
  const request = async path => {
    const shot = decodeURIComponent(path.slice("?shotId=".length));
    const answer = {scriptVersion: 1, castingVersion: 1, directionVersion: 1,
      groups: shot === "s1" ? [group("aaaaaaaa-1111", "s1", "running")] : [group("bbbbbbbb-2222", "s2", "done")]};
    // The held check is the one that finds s1's group finished.
    if (hold && shot === "s1") {hold = false; return new Promise(resolve => {release = () => resolve({...answer, groups: [group("aaaaaaaa-1111", "s1", "done")]});});}
    return answer;
  };
  const plans = ["s1", "s2"].map(id => ({source: {id, prompt: id + " prompt"}, sourceHash: "hash-" + id, durationSec: 4, performanceLines: []}));
  const parent = new Element("div");
  const takes = initTakes({parent, request, prepareGeneration: async () => {}, prepare: async () => {},
    state: () => ({plan: plans, direction: {entries: []}, defaults: DEFAULT_DIRECTION}), canEdit: () => true, adopted: async () => {}, assetUrl: url => url});
  await takes.open(plans[0]); await settle();
  const all = () => tree(parent);
  return {takes, plans,
    /** Fires s1's next status check and holds its answer in flight. */
    holdCheck: async () => {hold = true; const next = checks.filter(timer => !timer.cleared).at(-1); next.cleared = true; const running = next.callback(); await settle(); return async () => {release(); await running; await settle();};},
    groups: () => all().find(element => element.getAttribute?.("aria-label") === "Saved take group").children.map(option => option.value),
    labels: () => all().find(element => element.getAttribute?.("aria-label") === "Saved take group").children.map(option => option.textContent),
    source: () => all().find(element => element.tag === "p" && element.textContent.endsWith("prompt"))?.textContent};
}

test("a status check for s1 answered after the creator opened s2 leaves s2's take groups on the panel", async () => {
  const d = await desk();
  expect(d.groups()).toEqual(["aaaaaaaa-1111"]);
  const answer = await d.holdCheck();
  await d.takes.open(d.plans[1]); await settle();
  expect({source: d.source(), groups: d.groups()}).toEqual({source: "s2: s2 prompt", groups: ["bbbbbbbb-2222"]});
  await answer();
  expect({source: d.source(), groups: d.groups()}).toEqual({source: "s2: s2 prompt", groups: ["bbbbbbbb-2222"]});
});

test("and a check answered for the shot still open is written as before", async () => {
  const d = await desk();
  const answer = await d.holdCheck();
  expect(d.labels()).toEqual(["Preview · running · aaaaaaaa"]);
  await answer();
  expect({source: d.source(), labels: d.labels()}).toEqual({source: "s1: s1 prompt", labels: ["Preview · done · aaaaaaaa"]});
});
