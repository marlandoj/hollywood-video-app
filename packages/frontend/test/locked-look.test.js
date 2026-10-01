/**
 * HV-017-15 — a locked look the creator can see and undo.
 *
 * Importing a shared actor now brings its creator's locked look with it. A lock refuses replacing or
 * removing the images it names ("Unlock the look…"), and before this the cast desk never read
 * `referenceLock` at all: an imported lock was invisible, and the one thing its refusal told the
 * creator to do could not be done from the page. The desk now says a character's look is locked,
 * names it, and offers "Unlock look", which calls the existing reference-lock route with `lock: null`.
 * The share preview says the look is locked before anyone imports it, and an import that could not
 * carry the lock says why in the desk's status line.
 */
import {afterEach, expect, test} from "bun:test";
import {cpSync, copyFileSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Element, mountDom, tree} from "./audio-studio-dom.js";

/** Served side by side under the names `casting.js` imports, as in desk-focus.test.js. */
const served = mkdtempSync(join(tmpdir(), "hv-cast-lock-"));
cpSync(join(import.meta.dir, "../src"), served, {recursive: true});
copyFileSync(join(served, "character-sheets.js"), join(served, "sheets.js"));
copyFileSync(join(served, "actor-library.js"), join(served, "library.js"));
const {initCasting} = await import(join(served, "casting.js"));
process.on("exit", () => rmSync(served, {recursive: true, force: true}));

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const asset = n => ({id: "a" + n, sha256: String(n).repeat(64)});
const lock = {schema: "hv-reference-lock/1", assets: [asset(2), asset(1)], label: "Act two, after the storm", note: "", lockedAt: "2026-09-30T00:00:00.000Z", revision: "f".repeat(64)};
const character = (id, name, referenceLock) => ({id, name, kind: "original-fictional", aliases: [], appearance: "", wardrobe: [], sceneBindings: [],
  permission: {status: "pending", scope: "project", sceneNumbers: [], expiresAt: null}, references: [asset(1), asset(2)], ...(referenceLock ? {referenceLock} : {})});

let restore = () => {};
afterEach(() => restore());

/** The desk over a cast that `request` edits, recording every write it is sent. */
async function desk(characters, {share, lookNote} = {}) {
  restore = mountDom();
  const body = document.body, panel = new Element("section"); body.append(panel); panel.hidden = true;
  let casting = {projectId: "p1", version: 3, createdAt: "2026-09-28T00:00:00.000Z", characters};
  const writes = [];
  const request = async (path, init) => {
    if (path === "") return {casting, history: [], sceneHeadings: [], scriptVersion: 1};
    if (path.endsWith("/sheets") || path.endsWith("/shares")) return {jobs: [], shares: []};
    writes.push({path, ...init});
    if (path === "/import") {
      casting = {...casting, version: casting.version + 1, characters: [...casting.characters, {...share.character, id: "c9", name: init.body.name}]};
      return {casting, ...(lookNote ? {lookNote} : {})};
    }
    const [, id] = path.split("/");
    casting = {...casting, version: casting.version + 1, characters: casting.characters.map(value => {
      if (value.id !== id) return value; const {referenceLock: _dropped, ...rest} = value; return rest;})};
    return {casting};
  };
  const view = initCasting({panel, request, ensureProject: async () => {}, changed() {}, image: async () => new Blob(), prepareGeneration: async () => {},
    assetUrl: url => url, sharedRequest: async () => ({share}), sharedImage: async () => new Blob()});
  await view.open(); await settle();
  const all = () => tree(panel);
  const find = (tag, text) => all().find(element => element.tag === tag && element.textContent === text);
  const press = async text => {const control = find("button", text); control.focus(); await control.onclick?.({currentTarget: control}); await settle();};
  const status = () => all().find(element => element.getAttribute("aria-live") === "polite");
  const texts = () => all().map(element => element.textContent).filter(Boolean);
  return {panel, find, press, status, texts, writes};
}

/**
 * A locked character's card names its look and how many images it holds, and offers a real button
 * to unlock it. Pressing it sends the existing reference-lock route `lock: null` on the current cast
 * version, the desk says the cast was saved in its live status line, and the lock is gone.
 */
test("a locked look is shown on its character's card and can be unlocked from it", async () => {
  const d = await desk([character("c1", "Mara", lock), character("c2", "Leo")]);
  expect(d.texts()).toContain("Locked look: Act two, after the storm · 2 images. Renders use these images in this order. Unlock the look to replace or remove them.");
  const unlock = d.find("button", "Unlock look for Mara");
  expect(unlock.type).toBe("button");
  // Only the locked character has one.
  expect(d.find("button", "Unlock look for Leo")).toBeUndefined();
  await d.press("Unlock look for Mara");
  expect(d.writes).toEqual([{path: "/c1/reference-lock", method: "PUT", body: {expectedVersion: 3, lock: null}}]);
  expect(d.status().getAttribute("role")).toBe("status");
  expect(d.status().textContent).toBe("Saved cast version 4. Create a new preview to review these directions.");
  expect(d.find("button", "Unlock look for Mara")).toBeUndefined();
  expect(d.texts().some(text => text.startsWith("Locked look:"))).toBe(false);
  // Focus stays with the character, not on the button that was just rebuilt away.
  expect(document.activeElement.textContent).toBe("Mara");
});

/** A character with no lock shows neither the line nor the button: nothing changes for it. */
test("an unlocked character shows no locked look and no unlock control", async () => {
  const d = await desk([character("c1", "Mara")]);
  expect(d.texts().some(text => text.startsWith("Locked look:"))).toBe(false);
  expect(d.find("button", "Unlock look for Mara")).toBeUndefined();
});

/** Review, attest and import a share through the desk's import panel, as a creator does. */
async function importShare(d) {
  const input = d.panel.children.flatMap(child => tree(child)).find(element => element.tag === "textarea" && element.maxLength === 4096);
  input.value = "eyJzaGFyZSI6MX0." + "a".repeat(43);
  await d.press("Review shared actor"); await settle();
  return async () => {
    const approved = tree(d.panel).find(element => element.tag === "label" && element.className === "attestation"
      && element.children[1]?.textContent.startsWith("I reviewed this actor"));
    approved.children[0].checked = true;
    await d.press("Import actor into this project"); await settle();
  };
}

/**
 * The share preview says the actor's look is locked, which look, and how many of its images, before
 * anyone imports it -- and the imported actor's card then shows the lock with its unlock control.
 */
test("the share preview says the actor's look is locked before it is imported", async () => {
  const share = {projectId: "p2", expiresAt: "2026-10-07T00:00:00.000Z", character: character("s1", "Mara", lock)};
  const d = await desk([], {share});
  const finish = await importShare(d);
  expect(d.texts()).toContain("Locked look: Act two, after the storm · 2 of 2 reference images, in the order renders use them. The lock comes with an import and can be unlocked there.");
  await finish();
  expect(d.writes.map(write => write.path)).toEqual(["/import"]);
  expect(d.find("button", "Unlock look for Mara")).toBeDefined();
});

/** An import that could not carry the lock says so, in the creator's words from the server, in the live status line. */
test("an import whose locked look could not be carried says why in the status line", async () => {
  const share = {projectId: "p2", expiresAt: "2026-10-07T00:00:00.000Z", character: character("s1", "Mara")};
  const lookNote = "The locked look “Act two, after the storm” was not carried over: locked image 2 was not copied into this project. The actor was imported unlocked; lock its look again from its images here.";
  const d = await desk([], {share, lookNote});
  await (await importShare(d))();
  expect(d.status().textContent).toBe("Saved cast version 4. " + lookNote + " Create a new preview to review these directions.");
  expect(d.find("button", "Unlock look for Mara")).toBeUndefined();
});
