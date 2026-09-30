/**
 * HV-039-23 — Every credit row in the graphics desk had the same name, and removing one dropped focus.
 *
 * A credits graphic is edited as rows, each a `fieldset` holding a "Role" field, a "Name" field and a
 * "Remove credit" button:
 *
 *     const row=node('fieldset'),role=field(row,'Role',...),name=field(row,'Name',...);
 *     row.append(button('Remove credit',()=>{credits.splice(credits.indexOf(record),1);row.remove();changed();}));
 *
 * The fieldset had no legend. With twelve credits a screen reader met twelve "Role" fields, twelve
 * "Name" fields and twelve "Remove credit" buttons, with nothing saying which row any of them was in
 * (WCAG 1.3.1, 2.4.6). And "Remove credit" removed the row it sat in, itself included, so focus fell
 * to the page body (2.4.3). A keyboard user removing three credits started from the top of the page
 * three times.
 *
 * Each row is now a group named "Credit N", with "Remove credit N" as its button, renumbered as rows
 * go. Removing a row focuses the Role field of the row that took its place, or of the row before it,
 * or Add credit when none is left. Adding a row focuses its Role field.
 */
import {afterEach, expect, test} from "bun:test";
import {defaultMotionGraphic, GRAPHIC_KINDS} from "../../planner/src/motion-graphics";
import {initGraphicStudio} from "../src/graphic-studio.js";
import {Element, fire, mountDom, tree} from "./audio-studio-dom.js";

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
let restore = () => {};
afterEach(() => restore());

const CREDITS = [{role: "Directed by", name: "Ada"}, {role: "Written by", name: "Ben"}, {role: "Music", name: "Cleo"}];

/** The graphics desk, open on one saved credits graphic. */
async function desk(credits = CREDITS) {
  restore = mountDom();
  const plan = {...defaultMotionGraphic("credits"), credits};
  const index = {library: {version: 1}, graphics: [{spec: {id: "g1", label: "End credits", revision: 1, plan}, available: true}],
    jobs: [], defaults: GRAPHIC_KINDS.map(kind => defaultMotionGraphic(kind))};
  const parent = new Element("div");
  const sent = [];
  const request = async (path, options) => {if (options?.body) sent.push(structuredClone(options.body)); return index;};
  const studio = initGraphicStudio({parent, request, projectId: () => "p1", assetUrl: url => url, canEdit: () => true});
  await studio.open(); await settle();
  // A browser's input value is always a string; the stub keeps what was assigned, so make it one.
  for (const input of tree(parent).filter(e => e.tag === "input" || e.tag === "textarea")) input.value = String(input.value);
  const box = () => tree(parent).find(e => e.tag === "details" && e.children[0]?.textContent === "Credit rows");
  const rows = () => tree(box()).filter(e => e.tag === "fieldset");
  /** A row as a screen reader meets it: its group name, its field labels and values, and its button. */
  const read = row => ({
    group: row.children[0]?.tag === "legend" ? row.children[0].textContent : null,
    fields: tree(row).filter(e => e.tag === "label").map(label => label.textContent + ": " + tree(label).find(e => e.tag === "input").value),
    button: tree(row).find(e => e.tag === "button")?.textContent,
  });
  const role = row => tree(row).find(e => e.tag === "input");
  const addCredit = () => tree(box()).find(e => e.tag === "button" && e.textContent === "Add credit");
  /** Press a button from the keyboard: it has focus, then it is activated. */
  const press = async button => {button.focus(); fire(button, "click"); await settle(); await settle();};
  const save = () => tree(parent).find(e => e.tag === "button" && e.textContent === "Save graphic");
  const status = () => tree(parent).find(e => e.getAttribute?.("role") === "status")?.textContent;
  return {status, rows, read, role, addCredit, press, save, sent, focused: () => globalThis.document.activeElement, onPage: e => e.isConnected || tree(parent).includes(e)};
}

test("each credit row is a group named by its number, and its Remove button says which row it removes", async () => {
  const d = await desk();
  expect(d.rows().map(d.read)).toEqual([
    {group: "Credit 1", fields: ["Role: Directed by", "Name: Ada"], button: "Remove credit 1"},
    {group: "Credit 2", fields: ["Role: Written by", "Name: Ben"], button: "Remove credit 2"},
    {group: "Credit 3", fields: ["Role: Music", "Name: Cleo"], button: "Remove credit 3"},
  ]);
});

test("removing a credit puts focus on the row that took its place, and the rows are renumbered", async () => {
  const d = await desk();
  const [, second, third] = d.rows();
  await d.press(second.children.find(e => e.tag === "button"));
  // Focus is on the former third row, now the second, and never on the removed button.
  expect(d.focused()).toBe(d.role(third));
  expect(d.rows().map(d.read)).toEqual([
    {group: "Credit 1", fields: ["Role: Directed by", "Name: Ada"], button: "Remove credit 1"},
    {group: "Credit 2", fields: ["Role: Music", "Name: Cleo"], button: "Remove credit 2"},
  ]);
});

test("removing the last row focuses the row before it, and removing the only row focuses Add credit", async () => {
  const d = await desk();
  const rows = d.rows();
  await d.press(rows[2].children.find(e => e.tag === "button"));
  expect(d.focused()).toBe(d.role(rows[1]));
  await d.press(rows[1].children.find(e => e.tag === "button"));
  await d.press(rows[0].children.find(e => e.tag === "button"));
  expect(d.rows()).toEqual([]);
  expect(d.focused()).toBe(d.addCredit());
});

test("adding a credit focuses the new row's Role field, in a group with the next number", async () => {
  const d = await desk();
  await d.press(d.addCredit());
  const rows = d.rows();
  expect(rows.length).toBe(4);
  expect(d.read(rows[3])).toEqual({group: "Credit 4", fields: ["Role: ", "Name: "], button: "Remove credit 4"});
  expect(d.focused()).toBe(d.role(rows[3]));
});

test("the numbers are only names: a save sends the remaining rows' roles and names, in order", async () => {
  const d = await desk();
  await d.press(d.rows()[0].children.find(e => e.tag === "button"));
  fire(d.role(d.rows()[0]), "input", "Screenplay by");
  await d.press(d.save());
  expect(d.sent.at(-1).change.plan.credits).toEqual([{role: "Screenplay by", name: "Ben"}, {role: "Music", name: "Cleo"}]);
});
