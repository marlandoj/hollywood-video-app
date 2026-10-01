/**
 * HV-017-16 — a creator can lock a character's look from the cast desk.
 *
 * HV-017-15 let the desk show a locked look and unlock it, but locking stayed API-only: a creator
 * who unlocked an imported look could never lock one again from the page. A character with images
 * and no lock now offers "Choose a locked look": one to four of its own images, ticked in the order
 * renders number them, a required name and an optional note, sent to the existing reference-lock
 * route exactly as it takes them. The server's refusals reach the live status line, a stale cast is
 * reloaded rather than retried, and a locked image's card says to unlock the look first instead of
 * offering a remove button whose only outcome is a refusal.
 */
import {afterEach, expect, test} from "bun:test";
import {cpSync, copyFileSync, mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Element, fire, mountDom, tree} from "./audio-studio-dom.js";

/** Served side by side under the names `casting.js` imports, as in locked-look.test.js. */
const served = mkdtempSync(join(tmpdir(), "hv-cast-lock-look-"));
cpSync(join(import.meta.dir, "../src"), served, {recursive: true});
copyFileSync(join(served, "character-sheets.js"), join(served, "sheets.js"));
copyFileSync(join(served, "actor-library.js"), join(served, "library.js"));
const {initCasting} = await import(join(served, "casting.js"));
const {characterSheets} = await import(join(served, "character-sheets.js"));
process.on("exit", () => rmSync(served, {recursive: true, force: true}));

const settle = () => new Promise(resolve => setTimeout(resolve, 0));
const asset = n => ({id: "a" + n, sha256: String(n).repeat(64)});
const character = (id, name, {references = [asset(1), asset(2), asset(3)], referenceLock} = {}) => ({id, name, kind: "original-fictional", aliases: [], appearance: "",
  wardrobe: [], sceneBindings: [], permission: {status: "pending", scope: "project", sceneNumbers: [], expiresAt: null}, references, ...(referenceLock ? {referenceLock} : {})});
const lockOf = (ids, label) => ({schema: "hv-reference-lock/1", assets: ids.map(id => asset(Number(id.slice(1)))), label, note: "", lockedAt: "2026-10-01T00:00:00.000Z", revision: "f".repeat(64)});
const refused = (message, status) => Object.assign(new Error(message), {status});

let restore = () => {};
afterEach(() => restore());

/**
 * The desk over a cast that `request` edits. `answers` decides each reference-lock write in turn: a
 * function returning the next cast, or an error to throw. Every write is recorded.
 */
async function desk(characters, answers = []) {
  restore = mountDom();
  const body = document.body, panel = new Element("section"); body.append(panel); panel.hidden = true;
  const state = {casting: {projectId: "p1", version: 3, createdAt: "2026-10-01T00:00:00.000Z", characters}};
  const writes = [];
  const request = async (path, init) => {
    if (path === "") return {casting: state.casting, history: [], sceneHeadings: [], scriptVersion: 1};
    if (path.endsWith("/sheets") || path.endsWith("/shares")) return {jobs: [], shares: []};
    writes.push({path, ...init});
    const answer = answers.shift();
    if (answer instanceof Error) {await state.gate; throw answer;}
    await state.gate;
    const [, id] = path.split("/");
    state.casting = {...state.casting, version: state.casting.version + 1, characters: state.casting.characters.map(value => value.id !== id ? value
      : {...value, referenceLock: lockOf(init.body.lock.assetIds, init.body.lock.label)})};
    return {casting: state.casting};
  };
  const view = initCasting({panel, request, ensureProject: async () => {}, changed() {}, image: async () => new Blob(), prepareGeneration: async () => {},
    assetUrl: url => url, sharedRequest: async () => ({}), sharedImage: async () => new Blob()});
  await view.open(); await settle();
  const all = () => tree(panel);
  const find = (tag, text) => all().find(element => element.tag === tag && element.textContent === text);
  const click = control => {control.focus(); return control.onclick?.({currentTarget: control});};
  const press = async text => {await click(find("button", text)); await settle();};
  const status = () => all().find(element => element.getAttribute("role") === "status" && element.parentElement === panel);
  const texts = () => all().map(element => element.textContent).filter(Boolean);
  /** The checkbox whose label begins "Reference <n>", inside the locked-look chooser. */
  const choice = n => all().find(element => element.tag === "label" && element.className === "attestation"
    && element.children[2]?.textContent.startsWith("Reference " + n))?.children[0];
  const tick = (n, checked = true) => {const box = choice(n); box.checked = checked; fire(box, "change");};
  const label = n => choice(n).parentElement.children[2].textContent;
  const input = id => all().find(element => element.id === id);
  return {panel, state, find, click, press, status, texts, writes, choice, tick, label, input};
}

/**
 * Ticking images numbers them in the order they were ticked, which is the order renders use, and
 * unticking one closes the gap. "Lock look" sends the route its exact body -- the cast version, the
 * ids in that order, the trimmed name and note -- and the card then shows the HV-017-15 locked look
 * line and its unlock button, with focus on the character's heading.
 */
test("a creator locks a character's look from its card, in the order they chose the images", async () => {
  const d = await desk([character("c1", "Mara")]);
  expect(d.find("summary", "Choose a locked look")).toBeDefined();
  expect(d.texts()).toContain("No images chosen yet.");
  d.tick(1); d.tick(3); d.tick(2);
  expect([d.label(1), d.label(2), d.label(3)]).toEqual(["Reference 1 · 1st in the look", "Reference 2 · 3rd in the look", "Reference 3 · 2nd in the look"]);
  d.tick(1, false);
  expect([d.label(1), d.label(2), d.label(3)]).toEqual(["Reference 1", "Reference 2 · 2nd in the look", "Reference 3 · 1st in the look"]);
  expect(d.texts()).toContain("Render order: Reference 3, then Reference 2.");
  d.input("lock-name-c1").value = "  Act two, after the storm "; d.input("lock-note-c1").value = "The scarf stays. ";
  await d.press("Lock look for Mara");
  expect(d.writes).toEqual([{path: "/c1/reference-lock", method: "PUT",
    body: {expectedVersion: 3, lock: {assetIds: ["a3", "a2"], label: "Act two, after the storm", note: "The scarf stays."}}}]);
  expect(d.status().textContent).toBe("Saved cast version 4. Create a new preview to review these directions.");
  expect(d.texts()).toContain("Locked look: Act two, after the storm · 2 images. Renders use these images in this order. Unlock the look to replace or remove them.");
  expect(d.find("button", "Unlock look for Mara")).toBeDefined();
  expect(d.find("button", "Lock look for Mara")).toBeUndefined();
  expect(document.activeElement.textContent).toBe("Mara");
});

/**
 * The form checks what the server checks before anything is sent: one to four images, a name, and
 * the server's own text rule. Each refusal is said in the live status line and focus goes to the
 * control that needs changing. Every image checkbox sits inside its own label, which names it.
 */
test("the lock form asks for images and a name before anything is sent", async () => {
  const d = await desk([character("c1", "Mara"), character("c2", "Leo", {references: []})]);
  // A character with no images has nothing to lock.
  expect(d.find("button", "Lock look for Leo")).toBeUndefined();
  for (const n of [1, 2, 3]) {
    expect(d.choice(n).type).toBe("checkbox");
    expect(d.choice(n).parentElement.tag).toBe("label");
  }
  expect(d.input("lock-name-c1").maxLength).toBe(120);
  expect(d.input("lock-name-c1").required).toBe(true);
  expect(d.input("lock-note-c1").maxLength).toBe(400);
  await d.press("Lock look for Mara");
  expect(d.status().textContent).toBe("Choose one to four of Mara's images for the locked look.");
  expect(d.status().dataset.state).toBe("error");
  expect(document.activeElement).toBe(d.choice(1));
  d.tick(2); d.input("lock-name-c1").value = "   ";
  await d.press("Lock look for Mara");
  expect(d.status().textContent).toBe("Name the look before locking it.");
  expect(document.activeElement).toBe(d.input("lock-name-c1"));
  d.input("lock-name-c1").value = "Act\u0007two";
  await d.press("Lock look for Mara");
  expect(d.status().textContent).toBe("The look name must be text of at most 120 characters.");
  d.input("lock-name-c1").value = "Act two"; d.input("lock-note-c1").value = "x".repeat(401);
  await d.press("Lock look for Mara");
  expect(d.status().textContent).toBe("The look note must be text of at most 400 characters.");
  expect(document.activeElement).toBe(d.input("lock-note-c1"));
  expect(d.writes).toEqual([]);
});

/**
 * A refusal from the server -- the content policy reading the name, here -- is said in the live
 * status line, the form keeps the creator's choices and focus returns to "Lock look". A stale cast
 * version is reloaded, said, and not sent again: the next write is the creator's own.
 */
test("a server refusal reaches the status line, and a stale cast is reloaded without sending the lock again", async () => {
  const policy = "This look's name names a real person or a public figure, who can't be cast. Change the name, then lock the look again. Nothing was saved.";
  const stale = "The cast changed in another session. Reload the cast before saving.";
  const d = await desk([character("c1", "Mara")], [refused(policy, 400), refused(stale, 409)]);
  d.tick(1); d.input("lock-name-c1").value = "A famous face";
  await d.press("Lock look for Mara");
  expect(d.status().textContent).toBe(policy);
  expect(d.status().dataset.state).toBe("error");
  expect(document.activeElement).toBe(d.find("button", "Lock look for Mara"));
  expect(d.choice(1).checked).toBe(true);
  expect(d.input("lock-name-c1").value).toBe("A famous face");

  // Meanwhile another session saved the cast.
  d.state.casting = {...d.state.casting, version: 5};
  d.input("lock-name-c1").value = "Act two";
  await d.press("Lock look for Mara"); await settle();
  expect(d.writes.map(write => write.body.expectedVersion)).toEqual([3, 3]);
  expect(d.status().textContent).toBe("The cast changed in another session, so it was reloaded and nothing was saved. Review it and try again.");
  expect(d.texts()).toContain("Cast version 5 · 1 of 24 characters");
  expect(document.activeElement.textContent).toBe("Mara");
  // The next lock is sent on the reloaded version.
  d.tick(2); d.input("lock-name-c1").value = "Act two";
  await d.press("Lock look for Mara");
  expect(d.writes.at(-1).body).toEqual({expectedVersion: 5, lock: {assetIds: ["a2"], label: "Act two", note: ""}});
});

/**
 * While the lock is being saved the desk is busy: every control is disabled, a second press sends
 * nothing, and `aria-busy` marks the desk around -- never over -- its live status line.
 */
test("a lock being saved cannot be sent twice, and the desk is busy around its status line", async () => {
  const d = await desk([character("c1", "Mara")]);
  let open; d.state.gate = new Promise(resolve => {open = resolve;});
  d.tick(1); d.input("lock-name-c1").value = "Act two";
  const lock = d.find("button", "Lock look for Mara");
  const first = d.click(lock);
  await settle();
  expect(lock.disabled).toBe(true);
  expect(d.status().textContent).toBe("Saving cast…");
  expect(d.status().getAttribute("aria-busy")).toBeNull();
  expect(tree(d.panel).some(element => element.getAttribute("aria-busy") === "true")).toBe(true);
  await d.click(lock);
  expect(d.writes).toHaveLength(1);
  open(); await first; await settle();
  expect(tree(d.panel).some(element => element.getAttribute("aria-busy") === "true")).toBe(false);
  expect(d.writes).toHaveLength(1);
});

/**
 * The server refuses removing an image a locked look names. The card no longer offers a remove
 * button for it; it says the image is in the locked look and to unlock the look first. An image
 * outside the look keeps its button, and a locked character offers no second lock.
 */
test("a locked image says to unlock the look first instead of offering a remove button", async () => {
  const d = await desk([character("c1", "Mara", {references: [asset(1), asset(2)], referenceLock: lockOf(["a2"], "The hat")})]);
  expect(d.find("button", "Remove reference 1")).toBeDefined();
  expect(d.find("button", "Remove reference 2")).toBeUndefined();
  expect(d.texts()).toContain("In the locked look. Unlock the look first to remove it.");
  expect(d.find("summary", "Choose a locked look")).toBeUndefined();
});

const VIEWS = ["front", "left"];
const sheet = {id: "j1", status: "done", checkpointShots: 2, castingVersion: 3, castingRevision: "r3", characterSheet: {kind: "turnaround", seed: 7000, views: VIEWS},
  output: {sheetUrl: "/s.png", manifestUrl: "/s.json"}, storyboard: VIEWS.map(view => ({shotId: "j1-" + view, caption: view + " view", url: "/" + view + ".png"}))};
/** One finished sheet's adopt controls, for a character with or without a locked look. */
async function adoptControls(referenceLock) {
  restore = mountDom();
  const adopted = [];
  const view = characterSheets({character: character("c1", "Mara", {references: [asset(1), asset(2)], referenceLock}), snapshot: {version: 3, revision: "r3"}, scenes: [],
    request: async () => ({jobs: [sheet]}), prepareGeneration: async () => {}, mutate: async action => adopted.push(action), dirty: () => false, alive: () => true, assetUrl: url => url});
  view.panel.open = true; fire(view.panel, "toggle"); await settle();
  return {all: () => tree(view.panel), adopted};
}

/**
 * Adopting a sheet's views with "Replace the current reference set" is refused by the server while
 * the look is locked. The replace choice is not offered then, and the sheet says why and what to do.
 */
test("a sheet's replace choice is not offered over a locked look, and the sheet says to unlock first", async () => {
  const unlocked = await adoptControls();
  expect(unlocked.all().some(element => element.textContent.startsWith("Replace the current reference set"))).toBe(true);
  const locked = await adoptControls(lockOf(["a1"], "The hat"));
  expect(locked.all().some(element => element.textContent.startsWith("Replace the current reference set"))).toBe(false);
  expect(locked.all().map(element => element.textContent)).toContain("Mara's look is locked, so these views are added beside its images. Unlock the look first to replace the reference set.");
});
