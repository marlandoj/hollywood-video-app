/**
 * HV-016-33 — the writer sees the crew's line notes and takes them one at a time in the studio.
 *
 * HV-016-32 built the routes: the crew suggests one-line changes bound to a script version, and the
 * writer's accepted ones become the next version. Nothing on screen used them. The Director's desk,
 * where the screenplay is edited, now has a "Line notes from the crew" panel (`line-notes.js`).
 *
 * The panel is tested directly over a small fake DOM, with `request`, `prepare` and `onApplied`
 * injected. The page's wiring -- saving the box first, binding to the saved version, reloading the
 * box after applying, and setting the notes aside when the box is typed in -- runs `index.html`'s
 * own module script through `desk-page.js`, with the real module.
 */
import {afterEach, beforeEach, expect, test} from "bun:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {initLineNotes, LINE_NOTES_REQUEST_MAX, readLineNotes} from "../src/line-notes.js";
import {PERSONA_TITLES} from "../src/studio.js";
import {openDesk, ok, pathOf} from "./desk-page.js";

class El {
  constructor(tag) {this.tag = tag; this.children = []; this.attributes = {}; this.listeners = {}; this.dataset = {}; this.hidden = false; this.disabled = false; this.value = ""; this._t = "";}
  set textContent(value) {this._t = String(value); this.children = [];} get textContent() {return this._t + this.children.map(child => child.textContent).join("");}
  append(...nodes) {this.children.push(...nodes);} replaceChildren(...nodes) {this.children = [...nodes];}
  setAttribute(name, value) {this.attributes[name] = String(value);} getAttribute(name) {return this.attributes[name] ?? null;} removeAttribute(name) {delete this.attributes[name];}
  addEventListener(type, listener) {(this.listeners[type] ??= []).push(listener);}
  /** A click focuses the control first, as a browser does, so a test can see where focus ends up. */
  focus() {globalThis.document.activeElement = this;}
  click() {this.focus(); for (const listener of this.listeners.click ?? []) listener();}
}
const all = root => root.children.flatMap(child => [child, ...all(child)]);
const button = (root, text) => all(root).find(e => e.tag === "button" && e.textContent === text);
const notesOf = root => all(root).filter(e => e.tag === "li");
const settle = async () => {for (let i = 0; i < 20; i++) await new Promise(resolve => setTimeout(resolve, 0));};

let previous;
beforeEach(() => {previous = globalThis.document; globalThis.document = {createElement: tag => new El(tag), activeElement: null};});
afterEach(() => {globalThis.document = previous;});

const SHA = "a".repeat(64);
const NOTES = [
  {id: "n1", persona: "director", line: 6, before: "You came back.", after: "You actually came back.", reason: "Lets it land."},
  {id: "n2", persona: "editor", line: 9, before: "I never left.", after: "I stayed.", reason: "Plainer."},
];
const answer = (extra = {}) => ({schema: "hv-crew-line-notes/1", source: "anthropic", script: {version: 1, sha256: SHA}, notes: NOTES, dropped: 0,
  message: "The crew has 2 line notes. Take the ones you want; nothing changes until you apply them.", crewSpend: {usd: 0, alerts: []}, ...extra});

/** The panel over a box holding version 1. `respond(suffix, body, n)` answers the n-th request. */
function mount(respond = async suffix => suffix ? {version: 2, applied: ["n1"], replayed: false} : answer(), {reloaded} = {}) {
  const parent = new El("div"), calls = [], order = [], applied = [], applying = [];
  const box = {text: "INT. KITCHEN - DAY", version: 1, saved: "INT. KITCHEN - DAY"};
  const panel = initLineNotes({parent, personaTitles: PERSONA_TITLES, current: () => ({...box}),
    prepare: async () => {order.push("prepare");},
    request: async (suffix, body) => {order.push("request" + suffix); calls.push({suffix, body: structuredClone(body)}); return respond(suffix, body, calls.length);},
    onApplying: on => applying.push(on),
    // As the desk does: a box that differs from the text the notes were applied to is kept as a draft.
    onApplied: async (version, {text}) => {applied.push({version, text}); const draft = box.text !== text; box.saved = "INT. KITCHEN - DAY (revised)"; if (!draft) box.text = box.saved; box.version = reloaded ?? version; return {version: box.version, draft};}});
  const status = all(parent).find(e => e.getAttribute("role") === "status");
  return {parent, panel, box, calls, order, applied, applying, status, heading: all(parent).find(e => e.tag === "h2"), ask: () => button(parent, "Ask the crew for line notes").click(),
    apply: () => button(parent, "Apply accepted notes").click(), input: all(parent).find(e => e.tag === "input")};
}

/** Criterion 1: asking saves the box, sends the writer's request, and shows every note skipped. */
test("asking saves the script, sends the writer's request, and shows each note's line, proposal, persona and reason, all skipped", async () => {
  const view = mount();
  view.input.value = "  tighten the dialogue  ";
  view.ask(); await settle();
  expect(view.order).toEqual(["prepare", "request"]);
  expect(view.calls).toEqual([{suffix: "", body: {request: "tighten the dialogue"}}]);
  const items = notesOf(view.parent);
  expect(items.length).toBe(2);
  const first = all(items[0]).map(e => e.textContent);
  expect(first).toContain("Line 6, from the Director");
  expect(first).toContain("Why: Lets it land.");
  expect(first).toContain("Now: You came back.");
  expect(first).toContain("Proposed: You actually came back.");
  expect(all(items[1]).map(e => e.textContent)).toContain("Line 9, from the Editor");
  // Nothing is accepted until the writer says so, and nothing can be applied yet.
  expect(button(view.parent, "Accept line 6").getAttribute("aria-pressed")).toBe("false");
  expect(button(view.parent, "Skip line 6").getAttribute("aria-pressed")).toBe("true");
  expect(button(view.parent, "Apply accepted notes").disabled).toBe(true);
  expect(view.status.textContent).toBe(answer().message);
});

/** Criterion 1: Accept and Skip are a toggle; pressing them sends nothing, and Apply follows what is accepted. */
test("Accept and Skip toggle a note without sending anything, and Apply is off while none is accepted", async () => {
  const view = mount();
  view.ask(); await settle();
  button(view.parent, "Accept line 6").click();
  expect(button(view.parent, "Accept line 6").getAttribute("aria-pressed")).toBe("true");
  expect(button(view.parent, "Skip line 6").getAttribute("aria-pressed")).toBe("false");
  expect(notesOf(view.parent)[0].dataset.accepted).toBe("true");
  expect(button(view.parent, "Apply accepted notes").disabled).toBe(false);
  expect(view.status.textContent).toBe("1 note accepted. Apply them to change the script.");
  button(view.parent, "Skip line 6").click();
  expect(button(view.parent, "Apply accepted notes").disabled).toBe(true);
  // A click on a disabled Apply (a stale event, a script) still sends nothing.
  view.apply(); await settle();
  expect(view.calls.length).toBe(1);
});

/** Criterion 1: with no crew model, the stand-in's own words are shown, and there is nothing to take. */
test("the stand-in's honest no-notes message is shown, with no notes and no Apply", async () => {
  const message = "No crew model is connected on this studio, so the crew wrote no line notes. Your script is unchanged.";
  const view = mount(async () => answer({source: "stand-in", notes: [], message}));
  view.ask(); await settle();
  expect(view.status.textContent).toBe(message);
  expect(notesOf(view.parent)).toEqual([]);
  expect(button(view.parent, "Apply accepted notes").hidden).toBe(true);
  // Dropped notes are counted, never shown.
  const dropped = mount(async () => answer({notes: [NOTES[1]], dropped: 2, message: "The crew has 1 line note."}));
  dropped.ask(); await settle();
  expect(dropped.status.textContent).toBe("The crew has 1 line note. 2 of the crew's notes couldn't be used and were left out.");
  // A refused request keeps the server's reason.
  const refused = mount(async () => {throw Object.assign(new Error("The crew can't work on this request -- nothing was sent to the crew."), {status: 400});});
  refused.ask(); await settle();
  expect(refused.status.textContent).toContain("nothing was sent to the crew");
  expect(refused.status.dataset.state).toBe("error");
});

/**
 * HV-016-35: when every note the crew offered was dropped, the server's message says how many and the
 * commonest reason, so the panel shows it alone, with nothing to take, and doesn't count them twice.
 */
test("when none of the crew's notes could be used, the server's reason is shown once, with nothing to take", async () => {
  const message = "The crew suggested 3 line notes, but none could be used. The most common reason, for 2 of them: it left the line as it is. Your script is unchanged.";
  const view = mount(async () => answer({notes: [], dropped: 3, droppedReasons: {unchanged: 2, locked_line: 1}, message}));
  view.ask(); await settle();
  expect(view.status.textContent).toBe(message);
  expect(notesOf(view.parent)).toEqual([]);
  expect(button(view.parent, "Apply accepted notes").hidden).toBe(true);
});

/** Criterion 2: Apply sends the bound version, the notes as given and the accepted ids, then reloads the script. */
test("Apply posts the version, the notes and the accepted ids, and the studio's script reloads to the new version", async () => {
  const view = mount();
  view.ask(); await settle();
  button(view.parent, "Accept line 6").click();
  view.apply(); await settle();
  expect(view.calls[1]).toEqual({suffix: "/accept", body: {version: 1, sha256: SHA, notes: NOTES, acceptedIds: ["n1"]}});
  expect(view.applied).toEqual([{version: 2, text: "INT. KITCHEN - DAY"}]);
  expect(view.status.textContent).toBe("Applied 1 note as version 2.");
  expect(notesOf(view.parent)).toEqual([]);
});

/** Criterion 2: a double click sends one accept, and the panel is busy (its live region excepted) while it is out. */
test("a double click sends one accept, and the panel is busy while it is in flight", async () => {
  let release;
  const view = mount(async suffix => suffix ? new Promise(resolve => {release = () => resolve({version: 2, applied: ["n1"], replayed: false});}) : answer());
  view.ask(); await settle();
  button(view.parent, "Accept line 6").click();
  view.apply(); view.apply(); await settle();
  expect(view.calls.filter(call => call.suffix === "/accept").length).toBe(1);
  expect(button(view.parent, "Apply accepted notes").disabled).toBe(true);
  expect(button(view.parent, "Ask the crew for line notes").disabled).toBe(true);
  expect(button(view.parent, "Accept line 9").disabled).toBe(true);
  expect(view.status.textContent).toBe("Applying 1 accepted note…");
  // aria-busy marks the panel's parts, never the live region that announces the outcome.
  expect(all(view.parent).some(e => e.getAttribute("aria-busy") === "true")).toBe(true);
  expect(view.status.getAttribute("aria-busy")).toBe(null);
  expect(view.status.getAttribute("aria-live")).toBe("polite");
  release(); await settle();
  expect(all(view.parent).some(e => e.getAttribute("aria-busy") === "true")).toBe(false);
  expect(view.calls.filter(call => call.suffix === "/accept").length).toBe(1);
});

/** Criterion 2: a 409 says so in the server's words, sets the notes aside, and is not retried. */
test("a 409 shows the server's message, discards the notes and does not retry", async () => {
  const server = "The script changed since the crew wrote these notes. Ask the crew again; nothing was changed.";
  const view = mount(async suffix => {if (suffix) throw Object.assign(new Error(server), {status: 409}); return answer();});
  view.ask(); await settle();
  button(view.parent, "Accept line 9").click();
  view.apply(); await settle();
  expect(view.status.textContent).toContain(server);
  expect(view.status.dataset.state).toBe("error");
  expect(notesOf(view.parent)).toEqual([]);
  expect(button(view.parent, "Apply accepted notes").hidden).toBe(true);
  expect(view.applied).toEqual([]);
  await settle();
  expect(view.calls.filter(call => call.suffix === "/accept").length).toBe(1);
  // Any other refusal keeps the notes, so the writer can skip the one the server refused.
  const refused = mount(async suffix => {if (suffix) throw Object.assign(new Error("Line note n1 no longer matches line 6."), {status: 400}); return answer();});
  refused.ask(); await settle();
  button(refused.parent, "Accept line 6").click();
  refused.apply(); await settle();
  expect(refused.status.textContent).toBe("Line note n1 no longer matches line 6.");
  expect(notesOf(refused.parent).length).toBe(2);
  expect(button(refused.parent, "Apply accepted notes").disabled).toBe(false);
});

/** Criterion 2 (review): what the writer typed while an accept was out is kept as a draft, and the reported version is the one saved. */
test("text typed while an apply is in flight is kept as the writer's draft, and the version reported is the one now saved", async () => {
  let release;
  const view = mount(async suffix => suffix ? new Promise(resolve => {release = () => resolve({version: 2, applied: ["n1"], replayed: false});}) : answer());
  view.ask(); await settle();
  button(view.parent, "Accept line 6").click();
  view.apply(); await settle();
  expect(view.applying).toEqual([true]);
  // The writer types (the page holds the box read-only, so this is the safety net); the page reports it.
  view.box.text += "\nUNSAVED WORK.";
  view.panel.sync();
  // Mid-flight, the request already out is not second-guessed: the status still says it is applying.
  expect(view.status.textContent).toBe("Applying 1 accepted note…");
  release(); await settle();
  expect(view.applying).toEqual([true, false]);
  expect(view.applied).toEqual([{version: 2, text: "INT. KITCHEN - DAY"}]);
  expect(view.box.text).toBe("INT. KITCHEN - DAY\nUNSAVED WORK.");
  expect(view.status.textContent).toBe("Applied 1 note as version 2. What you typed meanwhile is kept in the box as an unsaved draft; saving it replaces that version.");
  expect(view.status.dataset.state).toBe("error");

  // A page that reloads a later version than the accept made says which version is now saved.
  const later = mount(undefined, {reloaded: 3});
  later.ask(); await settle();
  button(later.parent, "Accept line 6").click();
  later.apply(); await settle();
  expect(later.status.textContent).toBe("Applied 1 note as version 2. The saved script is now version 3.");
});

/** Criterion 4 (review): a toggle keeps keyboard focus; when Apply goes away, focus goes to the panel's heading. */
test("the toggled button keeps focus, and focus moves to the heading when Apply is gone", async () => {
  const view = mount();
  view.ask(); await settle();
  expect(document.activeElement).toBe(button(view.parent, "Ask the crew for line notes"));
  const take = button(view.parent, "Accept line 6");
  take.click();
  // The same element, still on screen, still focused, now pressed.
  expect(document.activeElement).toBe(take);
  expect(button(view.parent, "Accept line 6")).toBe(take);
  expect(take.getAttribute("aria-pressed")).toBe("true");
  const skip = button(view.parent, "Skip line 6");
  skip.click();
  expect(document.activeElement).toBe(skip);
  expect(button(view.parent, "Skip line 6")).toBe(skip);
  button(view.parent, "Accept line 9").click();
  view.apply(); await settle();
  expect(button(view.parent, "Apply accepted notes").hidden).toBe(true);
  expect(document.activeElement).toBe(view.heading);
  expect(view.heading.tabIndex).toBe(-1);

  const conflict = mount(async suffix => {if (suffix) throw Object.assign(new Error("The script changed."), {status: 409}); return answer();});
  conflict.ask(); await settle();
  button(conflict.parent, "Accept line 6").click();
  conflict.apply(); await settle();
  expect(document.activeElement).toBe(conflict.heading);
});

/** Criterion 3 (review): a save that finished with older text than the box now holds doesn't bind notes to the wrong text. */
test("the crew isn't asked when the box no longer holds the text that was saved", async () => {
  const view = mount();
  // The save `prepare` joined was of older text: the box moved on before it finished.
  view.box.saved = "INT. KITCHEN - DAY (older)";
  view.ask(); await settle();
  expect(view.calls).toEqual([]);
  expect(notesOf(view.parent)).toEqual([]);
  expect(view.status.textContent).toBe("The script in the box changed while it was being saved, so the crew wasn't asked. Ask again.");
});

/** Criterion 3: notes are bound to the version and text they were fetched for; a change sets them aside. */
test("notes are discarded when the script changes after they were fetched, and a stale apply sends nothing", async () => {
  const typed = mount();
  typed.ask(); await settle();
  typed.box.text += "\nA kettle sings.";
  typed.panel.sync();
  expect(notesOf(typed.parent)).toEqual([]);
  expect(typed.status.textContent).toBe("The script changed after the crew wrote these notes, so they were set aside. Ask the crew again.");

  const saved = mount();
  saved.ask(); await settle();
  button(saved.parent, "Accept line 6").click();
  saved.box.version = 2; // saved as a new version elsewhere in the studio, with no sync yet
  saved.apply(); await settle();
  expect(saved.calls.filter(call => call.suffix === "/accept")).toEqual([]);
  expect(notesOf(saved.parent)).toEqual([]);

  // Unchanged, a sync keeps them.
  const same = mount();
  same.ask(); await settle();
  same.panel.sync();
  expect(notesOf(same.parent).length).toBe(2);

  // Notes written against a version the box isn't showing are never shown.
  const elsewhere = mount(async () => answer({script: {version: 4, sha256: SHA}}));
  elsewhere.ask(); await settle();
  expect(notesOf(elsewhere.parent)).toEqual([]);
  expect(elsewhere.status.textContent).toContain("set aside");
});

/** Criterion 4: a heading, labelled field, real buttons with pressed states, a live region, and text only. */
test("the panel is labelled, its toggles are real buttons with pressed states, and crew text is never markup", async () => {
  const hostile = {...NOTES[0], after: "<img src=x onerror=alert(1)>", reason: "<b>bold</b>"};
  const view = mount(async () => answer({notes: [hostile]}));
  const section = view.parent.children[0], heading = all(section).find(e => e.tag === "h2");
  expect(section.tag).toBe("section");
  expect(section.getAttribute("aria-labelledby")).toBe(heading.id);
  expect(heading.textContent).toBe("Line notes from the crew");
  const label = all(section).find(e => e.tag === "label");
  expect(label.htmlFor).toBe(view.input.id);
  expect(view.input.maxLength).toBe(LINE_NOTES_REQUEST_MAX);
  expect(view.status.getAttribute("role")).toBe("status");
  view.ask(); await settle();
  for (const control of all(section).filter(e => e.tag === "button")) expect(control.type).toBe("button");
  expect(all(section).map(e => e.textContent)).toContain("Proposed: <img src=x onerror=alert(1)>");
  expect(all(section).map(e => e.textContent)).toContain("Why: <b>bold</b>");
  const source = readFileSync(join(import.meta.dir, "../src/line-notes.js"), "utf8");
  expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  // An answer that isn't the crew's shape is refused rather than drawn.
  expect(readLineNotes({...answer(), notes: [{...NOTES[0], line: "6"}]})).toBe(null);
  expect(readLineNotes({...answer(), schema: "other"})).toBe(null);
});

/** Criterion 4: the stylesheet gives the pressed toggle a visible fill and sizes the request field. */
test("the pressed toggle is filled, and the panel's field and buttons are at least 44 pixels tall", () => {
  const html = readFileSync(join(import.meta.dir, "../src/index.html"), "utf8");
  expect(html).toContain(".line-notes button.secondary[aria-pressed=true] { background: var(--accent-strong); }");
  expect(html).toMatch(/\.line-notes input \{[^}]*min-height: 44px/);
  expect(html).toMatch(/\n {2}button \{[^}]*min-height: 2\.75rem/);
});

const SCRIPT = "INT. KITCHEN - DAY\n\nMAYA\nYou came back.";
const REVISED = "INT. KITCHEN - DAY\n\nMAYA\nYou actually came back.";

/** The desk with the real panel; `accept` answers the accept route. */
async function desk(accept = async () => ok({version: 4, applied: ["n1"], replayed: false})) {
  const requests = [];
  let made = null;
  const fetch = async (url, options = {}) => {
    const path = pathOf(url), body = options.body ? JSON.parse(options.body) : undefined;
    requests.push({path, method: options.method ?? "GET", body});
    if (path === "/api/projects" && options.method === "POST") return ok({projectId: "p1", token: "t"});
    if (path === "/api/projects/p1/script") return ok({version: 3});
    if (path === "/api/projects/p1/crew/line-notes") return ok(answer({script: {version: 3, sha256: SHA}, notes: [{...NOTES[0], line: 4}]}));
    if (path === "/api/projects/p1/crew/line-notes/accept") return accept();
    if (path === "/api/projects/p1") return ok({script: REVISED, scriptVersion: 4, castingVersion: 0, directionVersion: 0});
    return ok({});
  };
  const real = await import("../src/line-notes.js");
  const page = await openDesk({fetch, setup: q => {q("#script").value = SCRIPT;}, modules: {"line-notes.js": {initLineNotes: args => (made = Object.assign(real.initLineNotes(args), {args}))}}});
  const root = made.args.parent;
  const press = text => findButton(root, text).listeners.click[0]();
  return {page, requests, root, press, script: page.q("#script"), status: () => walk(root).find(e => e.getAttribute?.("role") === "status")};
}
const walk = root => (root.children ?? []).flatMap(child => [child, ...walk(child)]);
const findButton = (root, text) => walk(root).find(e => e.tag === "button" && e.textContent === text);

/** Criteria 1–3 at the page: the box is saved before asking, applying reloads the box, and typing sets the notes aside. */
test("the desk saves the box before asking, binds the notes to that version, and reloads the box after applying", async () => {
  const {page, requests, root, press, script, status} = await desk();
  try {
    press("Ask the crew for line notes"); await page.settle();
    const put = requests.findIndex(r => r.path === "/api/projects/p1/script"), asked = requests.findIndex(r => r.path === "/api/projects/p1/crew/line-notes");
    expect(put).toBeGreaterThanOrEqual(0);
    expect(requests[put].body).toEqual({text: SCRIPT});
    expect(asked).toBeGreaterThan(put);
    press("Accept line 4");
    press("Apply accepted notes"); await page.settle();
    expect(requests.find(r => r.path === "/api/projects/p1/crew/line-notes/accept").body).toEqual({version: 3, sha256: SHA, notes: [{...NOTES[0], line: 4}], acceptedIds: ["n1"]});
    expect(script.value).toBe(REVISED);
    expect(status().textContent).toBe("Applied 1 note as version 4.");
    // The box now shows version 4, so asking again sends no save: the text is the saved text.
    const puts = requests.filter(r => r.path === "/api/projects/p1/script").length;
    press("Ask the crew for line notes"); await page.settle();
    expect(requests.filter(r => r.path === "/api/projects/p1/script").length).toBe(puts);
    expect(walk(root).some(e => e.tag === "button" && e.textContent === "Accept line 4")).toBe(false); // version 3 notes don't match version 4
  } finally {page.restore();}
});

/** Criterion 2 at the page (review): while an accept is out the box is read-only and every save refuses; a draft is kept. */
test("while an apply is in flight the desk's box is read-only and saving refuses, and a changed box is kept as a draft", async () => {
  let release;
  const view = await desk(() => new Promise(resolve => {release = () => resolve(ok({version: 4, applied: ["n1"], replayed: false}));}));
  try {
    view.press("Ask the crew for line notes"); await view.page.settle();
    view.press("Accept line 4");
    view.press("Apply accepted notes"); await view.page.settle();
    expect(view.script.readOnly).toBe(true);
    const puts = view.requests.filter(r => r.path === "/api/projects/p1/script").length;
    view.script.value = SCRIPT + "\nShe smiles.";
    for (const listener of view.page.q("#screenplay-form").listeners.submit) await listener({preventDefault() {}});
    expect(view.page.q("#status").textContent).toBe("Wait for the crew's line notes to finish applying, then save.");
    expect(view.requests.filter(r => r.path === "/api/projects/p1/script").length).toBe(puts);
    release(); await view.page.settle();
    expect(view.script.readOnly).toBe(false);
    expect(view.script.value).toBe(SCRIPT + "\nShe smiles.");
    expect(view.status().textContent).toContain("kept in the box as an unsaved draft");
  } finally {view.page.restore();}
});

test("typing in the desk's script sets the notes aside, and a 409 there is shown in the server's words", async () => {
  const typed = await desk();
  try {
    typed.press("Ask the crew for line notes"); await typed.page.settle();
    expect(findButton(typed.root, "Accept line 4")).toBeDefined();
    typed.script.value = SCRIPT + "\nShe smiles.";
    for (const listener of typed.script.listeners.input) listener();
    expect(findButton(typed.root, "Accept line 4")).toBeUndefined();
    expect(typed.status().textContent).toContain("set aside");
  } finally {typed.page.restore();}

  const server = "The script changed since the crew wrote these notes. Ask the crew again; nothing was changed.";
  const conflict = await desk(async () => ({ok: false, status: 409, json: async () => ({error: server})}));
  try {
    conflict.press("Ask the crew for line notes"); await conflict.page.settle();
    conflict.press("Accept line 4");
    conflict.press("Apply accepted notes"); await conflict.page.settle();
    expect(conflict.status().textContent).toContain(server);
    expect(findButton(conflict.root, "Accept line 4")).toBeUndefined();
    expect(conflict.requests.filter(r => r.path === "/api/projects/p1/crew/line-notes/accept").length).toBe(1);
    expect(conflict.script.value).toBe(SCRIPT);
  } finally {conflict.page.restore();}
});
