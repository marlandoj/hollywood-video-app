/**
 * HV-039-13 — choosing a frame anchor's image destroyed the list being used.
 *
 * In Shot direction → Frame anchors, each anchor has a "Private image" list:
 *
 *     select.onchange=()=>{frame.asset=…;changed();render();};
 *
 * and `render` begins `list.replaceChildren()`, rebuilding every anchor row. The list the creator had
 * just used was replaced by a new one, so keyboard focus fell to the page body. On Windows, where
 * the arrow keys on a closed list change its value and fire `change` on each press, a keyboard user
 * lost the list at the first arrow and could not reach the second image without the mouse.
 * **Remove anchor N** rebuilt the rows too, and its own button went with them.
 *
 * Choosing an image now redraws only that anchor's thumbnail. Removing an anchor puts focus on the
 * anchor that took its place, or the one before it, or on **Add frame anchor** when none are left.
 */
import {afterEach, expect, test} from "bun:test";
import {initFrameAnchors} from "../src/frame-anchors.js";
import {Element, fire, mountDom, tree} from "./audio-studio-dom.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const asset = (id, label) => ({id, source: {kind: "shot-anchor", shotId: "s1", label}});
const GATE = asset("a1", "Opening at the gate"), DOOR = asset("a2", "Hand on the door"), ROOM = asset("a3", "The empty room");

let restore = () => {};
const focus = Element.prototype.focus;
afterEach(() => {restore(); Element.prototype.focus = focus;});

function anchors(frames) {
  restore = mountDom();
  // The anchor editor writes two captions as text nodes.
  document.createTextNode = text => {const node = new Element("#text"); node.textContent = text; return node;};
  const focused = [];
  Element.prototype.focus = function () {focused.push(this);};
  const parent = new Element("div");
  const editor = initFrameAnchors({parent, request: async () => ({}), image: async () => new Blob(["png"]), context: () => ({shot: {source: {id: "s1"}, sourceHash: "h"}, state: {}}),
    changed() {}, locked: async action => action(), tell() {}});
  editor.fill({frameAnchors: {frames, fallback: "stop"}}, {anchorAssets: [GATE, DOOR, ROOM]});
  const all = () => tree(parent);
  const rows = () => all().filter(element => element.tag === "fieldset" && element.className === "anchor-row");
  const list = row => tree(row).find(element => element.tag === "select");
  const button = text => all().find(element => element.tag === "button" && element.textContent === text);
  return {editor, rows, list, button, focused, alt: row => tree(row).find(element => element.tag === "img")?.alt};
}

test("choosing an anchor's image keeps the list, the row and the other anchors where they are", async () => {
  const a = anchors([{at: 0, asset: GATE}, {at: 10000, asset: DOOR}]);
  const [first, last] = a.rows(), list = a.list(last);
  fire(list, "change", ROOM.id); await settle();
  expect(a.rows()).toEqual([first, last]);
  expect(a.rows().every((row, i) => row === [first, last][i])).toBe(true);
  expect(a.list(last)).toBe(list);
  // The thumbnail follows the choice, and the draft does.
  expect(a.alt(last)).toBe("The empty room");
  expect(a.editor.read().frameAnchors.frames.map(frame => frame.asset.id)).toEqual(["a1", "a3"]);
});

test("removing an anchor puts focus on the anchor that took its place", async () => {
  const a = anchors([{at: 0, asset: GATE}, {at: 5000, asset: DOOR}, {at: 10000, asset: ROOM}]);
  a.button("Remove anchor 2").onclick(); await settle();
  expect(a.rows()).toHaveLength(2);
  expect(a.focused.at(-1)).toBe(a.list(a.rows()[1]));
});

test("removing the last anchor puts focus on the one before it, and the only one on Add frame anchor", async () => {
  const a = anchors([{at: 0, asset: GATE}, {at: 10000, asset: DOOR}]);
  a.button("Remove anchor 2").onclick(); await settle();
  expect(a.focused.at(-1)).toBe(a.list(a.rows()[0]));
  a.button("Remove anchor 1").onclick(); await settle();
  expect(a.rows()).toHaveLength(0);
  expect(a.focused.at(-1)).toBe(a.button("Add frame anchor"));
});
