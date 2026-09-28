/**
 * HV-039-16 — the voice studio, the graphics desk and take comparison closed onto the page body.
 *
 * HV-039-05 and HV-039-06 made the cast and shot-direction desks give focus back to the button
 * that opened them. Three more panels hid themselves with focus inside:
 *
 * - "Close voice studio" ran `close()`, which is `panel.hidden=true`, and the page's "Save screenplay
 *   and audition voices" button was never focused again;
 * - "Close graphics" in the titles and graphics desk: `cancelView();panel.hidden=true;`;
 * - "Close take comparison", opened from a shot's "Compare takes for s3" in the direction list:
 *   `player?.pause();panel.hidden=true;clearTimeout(timer);`.
 *
 * Hiding an element that holds focus drops focus to the page body, so a keyboard or screen-reader
 * user who closed any of them started again from the top of the page. Each panel now remembers the
 * control focus was on when it opened (if that was outside the panel) and focuses it again on close.
 */
import {afterEach, expect, test} from "bun:test";
import {DEFAULT_DIRECTION} from "../../planner/src/direction";
import {GRAPHIC_KINDS, defaultMotionGraphic} from "../../planner/src/motion-graphics";
import {initAudioStudio} from "../src/audio-studio.js";
import {initGraphicStudio} from "../src/graphic-studio.js";
import {initTakes} from "../src/takes.js";
import {Element, mountDom, tree} from "./audio-studio-dom.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
let restore = () => {};
afterEach(() => restore());

/** A page with the button that opens the panel, focused, as it is when the creator presses it. */
function page(label) {
  restore = mountDom();
  const opener = new Element("button"), parent = new Element("div");
  opener.textContent = label; document.body.append(opener, parent); opener.focus();
  const press = async (text) => {const button = tree(parent).find(element => element.tag === "button" && element.textContent === text); button.focus(); await button.onclick?.(); await settle();};
  return {opener, parent, press, focused: () => document.activeElement};
}

test("closing the voice studio returns focus to the button that opened it", async () => {
  const p = page("Save screenplay and audition voices");
  const studio = initAudioStudio({parent: p.parent, prepare: async () => {}, prepareGeneration: async () => {}, request: async () => ({characters: [], lines: [], scenes: [], jobs: [], voices: [], enabled: true}),
    saveVoice: async () => ({casting: {version: 1}}), savePerformance: async () => ({}), projectId: () => "p1", assetUrl: url => String(url), canEdit: () => true, changed: () => {}});
  await studio.open(); await settle();
  await p.press("Close voice studio");
  expect(p.focused()).toBe(p.opener);
});

test("closing the graphics desk returns focus to the button that opened it", async () => {
  const p = page("Titles and graphics");
  const request = async () => ({library: {version: 1}, graphics: [], jobs: [], defaults: GRAPHIC_KINDS.map(kind => defaultMotionGraphic(kind))});
  const studio = initGraphicStudio({parent: p.parent, request, projectId: () => "p1", assetUrl: url => url, canEdit: () => true});
  await studio.open(); await settle();
  await p.press("Close graphics"); await settle();
  expect(p.focused()).toBe(p.opener);
});

test("closing take comparison returns focus to the shot's Compare takes button", async () => {
  const p = page("Compare takes for s1");
  const plan = {source: {id: "s1", prompt: "Maya pours tea."}, sourceHash: "hash-s1", durationSec: 4, performanceLines: []};
  const takes = initTakes({parent: p.parent, request: async () => ({scriptVersion: 1, castingVersion: 1, directionVersion: 1, groups: []}), prepareGeneration: async () => {}, prepare: async () => {},
    state: () => ({plan: [plan], direction: {entries: []}, defaults: DEFAULT_DIRECTION}), canEdit: () => true, adopted: async () => {}, assetUrl: url => url});
  await takes.open(plan); await settle();
  await p.press("Close take comparison");
  expect(p.focused()).toBe(p.opener);
});

test("an opener that is gone by the time the panel closes is not focused", async () => {
  const p = page("Save screenplay and audition voices");
  const studio = initAudioStudio({parent: p.parent, prepare: async () => {}, prepareGeneration: async () => {}, request: async () => ({characters: [], lines: [], scenes: [], jobs: [], voices: [], enabled: true}),
    saveVoice: async () => ({casting: {version: 1}}), savePerformance: async () => ({}), projectId: () => "p1", assetUrl: url => String(url), canEdit: () => true, changed: () => {}});
  await studio.open(); await settle();
  document.body.children = document.body.children.filter(element => element !== p.opener); p.opener.parentElement = null;
  await p.press("Close voice studio");
  expect(p.focused()).not.toBe(p.opener);
});
