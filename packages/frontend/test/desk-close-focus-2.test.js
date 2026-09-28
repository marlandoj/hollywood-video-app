/**
 * HV-039-17 — the sound session and a discarded movement draft closed onto the page body.
 *
 * HV-039-16 gave focus back on close for the voice studio, the graphics desk and take comparison.
 * The same shape remained in:
 *
 * - "Close sound session": `release();stop(playback);panel.hidden=true;` -- the page's "Edit sound
 *   session" button was never focused again;
 * - "Discard movement draft", which hides subject motion (opened from a shot's "Plan subject motion
 *   for s3" in the direction list): `fill(context.study);dirty=false;panel.hidden=true;`;
 * - "Close picture editorial", tested beside the rest of picture editorial's focus in
 *   editorial-focus.test.js.
 *
 * Hiding an element that holds focus drops focus to the page body. Each panel now focuses the
 * control that opened it again when it closes.
 */
import {afterEach, expect, test} from "bun:test";
import {initSoundStudio} from "../src/sound-studio.js";
import {initSubjectMotion} from "../src/subject-motion.js";
import {Element, mountDom, tree} from "./audio-studio-dom.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
let restore = () => {};
afterEach(() => restore());

function page(label) {
  restore = mountDom();
  // Subject motion draws its stage in SVG.
  document.createElementNS ??= (_namespace, tag) => new Element(tag);
  // And reads a list's options and validates its point fields; the shared test DOM lacks both.
  const added = [];
  if (!("options" in Element.prototype)) {Object.defineProperty(Element.prototype, "options", {get() {return this.children;}, configurable: true}); added.push("options");}
  if (!("setCustomValidity" in Element.prototype)) {Element.prototype.setCustomValidity = function (message) {this.validationMessage = message;}; added.push("setCustomValidity");}
  const unmount = restore; restore = () => {unmount(); for (const name of added) delete Element.prototype[name];};
  const opener = new Element("button"), parent = new Element("div");
  opener.textContent = label; document.body.append(opener, parent); opener.focus();
  const press = async text => {const button = tree(parent).find(element => element.tag === "button" && element.textContent === text); button.focus(); await button.onclick?.(); await settle();};
  return {opener, parent, press, focused: () => document.activeElement};
}

test("closing the sound session returns focus to the button that opened it", async () => {
  const p = page("Edit sound session");
  const studio = initSoundStudio({parent: p.parent, request: async () => ({library: {assets: []}, jobs: [], sources: []}), libraryRequest: async () => ({}), recording: async () => new Blob(),
    jobRequest: async () => ({}), projectState: async () => ({dialogueSelections: {version: 0, entries: []}}), assetUrl: url => url, canEdit: () => true, adopt: async () => ({})});
  await studio.open(); await settle();
  await p.press("Close sound session");
  expect(p.focused()).toBe(p.opener);
});

test("discarding a movement draft returns focus to the shot's Plan subject motion button", async () => {
  const p = page("Plan subject motion for s1");
  const motion = initSubjectMotion({parent: p.parent, request: async () => ({study: null, source: {source: {id: "s1", prompt: "Maya pours tea."}, sourceHash: "h"}, characters: [], castingRevision: "c", directionVersion: 1, scriptVersion: 1, assets: []}),
    image: async () => new Blob(), download: async () => new Blob(), prepare: async () => {}, canEdit: () => true, changed: async () => {}});
  await motion.open({source: {id: "s1"}}, 24); await settle();
  await p.press("Discard movement draft");
  expect(p.focused()).toBe(p.opener);
});
