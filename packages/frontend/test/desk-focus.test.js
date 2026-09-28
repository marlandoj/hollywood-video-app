/**
 * HV-039-05 — the cast desk dropped keyboard focus to the page body after every save.
 *
 * HV-039-04 put focus on each studio step's heading as the creator arrives at it. The Director's desk
 * had the same hole one level down. Every change to the cast goes through `mutate`, which ends
 *
 *     editor.hidden = true; dirty = false; changed(snapshot.version, true); renderList();
 *
 * and `renderList` begins with `list.replaceChildren()`. So:
 *
 * - **Save character** is inside the editor that was just hidden;
 * - **Remove Mara**, **Revoke permission for Mara**, **Remove reference 1** are inside the list that
 *   was just rebuilt, and no longer exist;
 * - **Cancel edit** hides the editor it sits in;
 * - **Close cast editor** hides the whole desk.
 *
 * In every case a browser moves focus to the page body. The status line does say "Saved cast
 * version 4" -- it is `role=status` -- but the next Tab starts from the top of the page, several
 * screens above the desk, and a screen-reader user has to find their way back to the character
 * they were working on. Nothing tested this: `casting.js` had never been mounted by a test at all.
 *
 * The desk now puts focus back where the creator was: the control that opened what was just closed,
 * if it is still there; otherwise the character's own card; otherwise the desk's heading.
 */
import {afterEach, expect, test} from "bun:test";
import {cpSync, copyFileSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Element, fire, mountDom, tree} from "./audio-studio-dom.js";

/**
 * The cast desk exactly as a browser receives it. The API serves `character-sheets.js` as
 * `/api/cast/sheets.js` and `actor-library.js` as `/api/cast/library.js` (server.ts), and
 * `casting.js` imports them by those names, so they only resolve side by side under the served names.
 */
const served = mkdtempSync(join(tmpdir(), "hv-cast-"));
cpSync(join(import.meta.dir, "../src"), served, {recursive: true});
copyFileSync(join(served, "character-sheets.js"), join(served, "sheets.js"));
copyFileSync(join(served, "actor-library.js"), join(served, "library.js"));
const {initCasting} = await import(join(served, "casting.js"));
process.on("exit", () => rmSync(served, {recursive: true, force: true}));

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const character = (id, name, status = "pending") => ({id, name, kind: "original-fictional", aliases: [], appearance: "", wardrobe: [],
  permission: {status, scope: "project", sceneNumbers: [], expiresAt: null}, references: []});

let restore = () => {};
afterEach(() => restore());

/** The desk, mounted in a page with the button that opens it, over a cast that `request` edits. */
async function desk(characters) {
  restore = mountDom(); let refuse = false;
  const body = document.body, opener = new Element("button"), panel = new Element("section");
  opener.textContent = "Save screenplay and edit cast"; body.append(opener, panel); panel.hidden = true;
  let casting = {projectId: "p1", version: 3, createdAt: "2026-09-28T00:00:00.000Z", characters};
  const request = async (path, init) => {
    if (path === "") return {casting, history: [], sceneHeadings: [], scriptVersion: 1};
    if (path.endsWith("/sheets") || path.endsWith("/shares")) return {jobs: [], shares: []};
    if (refuse) {refuse = false; throw new Error("The cast changed. Reload it to review the changes.");}
    const [, id, action] = path.split("/");
    const next = action === "remove" ? casting.characters.filter(value => value.id !== id)
      : action === "revoke" ? casting.characters.map(value => value.id === id ? {...value, permission: {...value.permission, status: "revoked"}} : value)
      : casting.characters.map(value => value.id === id ? {...value, ...init.body.character, id} : value);
    casting = {...casting, version: casting.version + 1, characters: next};
    return {casting};
  };
  const view = initCasting({panel, request, ensureProject: async () => {}, changed() {}, image: async () => new Blob(), prepareGeneration: async () => {},
    assetUrl: url => url, sharedRequest: async () => ({}), sharedImage: async () => new Blob()});
  opener.focus();
  await view.open(); await settle();
  const find = (tag, text) => tree(panel).find(element => element.tag === tag && element.textContent === text);
  /** Press a desk button as a keyboard user does: it has focus, then it is activated. */
  const press = async text => {const control = find("button", text); control.focus(); await control.onclick?.({currentTarget: control}); await settle();};
  const form = tree(panel).find(element => element.tag === "form");
  const focus = () => {const active = document.activeElement; return {on: active.textContent, onThePage: active.isConnected && !active.closest("[hidden]")};};
  return {panel, opener, press, form, focus, find, refuseNext: () => {refuse = true;}};
}

test("closing the desk returns focus to the button that opened it", async () => {
  const d = await desk([character("c1", "Mara")]);
  expect(d.focus()).toEqual({on: "Cast direction", onThePage: true});
  await d.press("Close cast editor");
  expect(d.panel.hidden).toBe(true);
  expect(d.focus()).toEqual({on: "Save screenplay and edit cast", onThePage: true});
});

test("removing a character leaves focus on the desk, not on a button that no longer exists", async () => {
  const d = await desk([character("c1", "Mara"), character("c2", "Leo")]);
  await d.press("Remove Mara");
  expect(d.find("h3", "Mara")).toBeUndefined();
  // The character's card went with it, so the desk itself.
  expect(d.focus()).toEqual({on: "Cast direction", onThePage: true});
});

test("saving an edit, or revoking permission, leaves focus on that character's card", async () => {
  const d = await desk([character("c1", "Mara", "permitted"), character("c2", "Leo")]);
  await d.press("Edit Leo");
  expect(d.form.hidden).toBe(false);
  fire(d.form, "submit"); await settle(); await settle();
  expect(d.form.hidden).toBe(true);
  expect(d.focus()).toEqual({on: "Leo", onThePage: true});

  await d.press("Revoke permission for Mara");
  expect(d.find("button", "Revoke permission for Mara")).toBeUndefined();
  expect(d.focus()).toEqual({on: "Mara", onThePage: true});
});

test("cancelling an edit returns focus to the button that started it", async () => {
  const d = await desk([character("c1", "Mara")]);
  await d.press("Edit Mara");
  expect(d.focus().on).not.toBe("Edit Mara"); // the editor took it, to the name field
  await d.press("Cancel edit");
  expect(d.form.hidden).toBe(true);
  expect(d.focus()).toEqual({on: "Edit Mara", onThePage: true});

  await d.press("Add character");
  await d.press("Cancel edit");
  expect(d.focus()).toEqual({on: "Add character", onThePage: true});
});

test("a refused save leaves focus where it was: nothing was rebuilt", async () => {
  const d = await desk([character("c1", "Mara")]);
  d.refuseNext();
  await d.press("Remove Mara");
  expect(d.find("p", "The cast changed. Reload it to review the changes.")).toBeDefined();
  expect(d.focus()).toEqual({on: "Remove Mara", onThePage: true});
});
