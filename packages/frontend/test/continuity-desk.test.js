/**
 * HV-021-07 — the continuity report and its one repair reach the Director's desk.
 *
 * `GET /direction` has carried the Continuity Supervisor's report since HV-021-01, and the review
 * and accept routes for its one repair have existed since HV-021-02. No page showed either, so
 * Release 2's "drift detection and one-click repair" was an API a creator could not reach.
 *
 * These tests mount the panel over the planner's own report and repair: the fake server below
 * computes `continuityReport`, `continuityRepair` and `continuityRepairSummary` from a real
 * screenplay and real saved directions, and refuses an accept whose edits or versions differ from
 * its own, as `acceptContinuityRepair` does. So what the panel draws and sends is checked against
 * what the server would actually answer.
 */
import {afterEach, expect, test} from "bun:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {parseFountain} from "../../parser/src/index";
import {planShots} from "../../planner/src/index";
import {castingSnapshot} from "../../planner/src/casting";
import {directionEntry, directionSnapshot} from "../../planner/src/direction";
import {continuityReport} from "../../planner/src/continuity";
import {continuityRepair, continuityRepairSummary} from "../../planner/src/continuity-repair";
import {COVERAGE_CHOICES, DEFAULT_COVERAGE} from "../../planner/src/coverage";
import {DEFAULT_DIRECTION, DIRECTION_CHOICES} from "../../planner/src/direction";
import {initContinuity} from "../src/continuity.js";
import {initDirection} from "../src/direction.js";
import {Element, mountDom, tree} from "./audio-studio-dom.js";

const now = Date.UTC(2026, 8, 30);
const SCRIPT = "INT. KITCHEN - DAY\n\nMarguerite pours the tea.\n\nTomas opens the window.\n\nEXT. GARDEN - NIGHT\n\nTomas walks the path.\n\nThe gulls wheel.";
const parsed = parseFountain(SCRIPT), shots = planShots(parsed, 7000, 24), cast = castingSnapshot("project-1", 1, [], now);
const inScene = index => shots.filter(shot => shot.sceneIndex === index);
const settle = async (turns = 4) => {for (let i = 0; i < turns; i++) await new Promise(resolve => setTimeout(resolve, 0));};

let restore = () => {};
afterEach(() => restore());

/** Scene 1 declares two key lights; scene 2 is directed "day" under a NIGHT heading. */
function drifted() {
  const [a, b] = inScene(0), [c] = inScene(1);
  return [directionEntry(a, {keyLight: "warm tungsten"}), directionEntry(b, {keyLight: "cold moonlight"}), directionEntry(c, {timeOfDay: "day"})];
}

/**
 * A server holding one project's direction. `refuse` makes the next accept answer as the real route
 * does when the direction moved underneath it: 409, nothing applied. `hold` keeps the next request
 * out until the test releases it.
 */
function server(entries = drifted(), {unavailable: forced = null} = {}) {
  let version = 4, hold = null;
  const calls = [];
  const snapshot = () => directionSnapshot("project-1", version, entries, now);
  const report = () => continuityReport(shots, cast, snapshot(), parsed);
  const conflict = message => {const error = new Error(message); error.status = 409; return error;};
  const s = {
    calls, refuse: false,
    holdNext() {let release; hold = new Promise(resolve => {release = resolve;}); return () => release();},
    moveDirection() {version++;},
    state: () => ({direction: snapshot(), plan: [], scenes: parsed.scenes.map(scene => ({index: scene.index, heading: scene.heading})), maxShots: 24, scriptVersion: 3,
      defaults: DEFAULT_DIRECTION, choices: DIRECTION_CHOICES, coverageDefaults: DEFAULT_COVERAGE, coverageChoices: COVERAGE_CHOICES, coverage: null,
      continuity: report(), history: [], staleShotIds: [], staleSceneIndices: [], durationLimitSec: 30, motionPlans: []}),
    async request(path, init) {
      calls.push({path, body: init?.body === undefined ? undefined : structuredClone(init.body)});
      if (hold) {const waiting = hold; hold = null; await waiting;}
      if (path === "") return s.state();
      const value = report();
      let proposal = null, unavailable = null;
      try {proposal = forced ? null : continuityRepair(value);} catch (error) {unavailable = error.message;}
      if (forced) unavailable = forced;
      if (path === "/continuity/repair") return {report: value, proposal, unavailable, summary: proposal ? continuityRepairSummary(proposal) : null, scriptVersion: 3};
      if (path === "/continuity/repair/accept") {
        if (s.refuse) {s.refuse = false; throw conflict("The shot directions changed. Reload before saving.");}
        const {edits, expectedVersion, expectedScriptVersion} = init.body;
        if (expectedVersion !== version) throw conflict("The shot directions changed. Reload before saving.");
        if (expectedScriptVersion !== 3) throw conflict("The screenplay changed. Review a new continuity repair before accepting.");
        if (JSON.stringify(edits) !== JSON.stringify(proposal.edits)) throw conflict("The film changed since this continuity repair was read. Review a new one before accepting.");
        for (const edit of proposal.edits) entries = entries.map(entry => entry.source.id === edit.shotId ? {...entry, settings: {...entry.settings, [edit.field]: edit.to}} : entry);
        version++;
        return {direction: snapshot()};
      }
      throw new Error("unexpected " + path);
    },
  };
  return s;
}

/** The panel on its own, with the desk's reload behaviour: fetch `GET /direction` again and redraw. */
function mount(s = server(), {canEdit = () => true} = {}) {
  restore = mountDom();
  const parent = new Element("div");document.body.append(parent);
  let desk = s.state();
  const view = initContinuity({parent, request: (path, init) => s.request(path, init), state: () => desk, canEdit,
    accepted: async () => {desk = await s.request(""); view.render();}, reload: async () => {desk = await s.request(""); view.render();}});
  view.render();
  const all = () => tree(parent);
  const find = (tag, text) => all().find(e => e.tag === tag && e.textContent === text);
  const texts = tag => all().filter(e => e.tag === tag && !hiddenIn(e)).map(e => e.textContent);
  const status = all().find(e => e.getAttribute("role") === "status");
  const press = async text => {const b = find("button", text); await b.onclick(); await settle();};
  return {parent, view, s, find, texts, status, press, all};
}
const hiddenIn = element => Boolean(element.closest("[hidden]"));

test("the report is grouped by scene, each finding in words with its severity, under a count of what was found", () => {
  const d = mount();
  // The summary count, from the report's own totals.
  const totals = d.s.state().continuity.totals;
  expect(totals.warnings).toBe(2);
  expect(d.texts("p")).toContain("2 warnings · " + totals.unknowns + " unknowns · " + totals.notes + " note" + (totals.notes === 1 ? "" : "s") + ", in 2 of 2 scenes.");
  // One group per scene with findings, headed by the scene's own heading.
  const summaries = d.texts("summary");
  expect(summaries[0]).toStartWith("Scene 1 · INT. KITCHEN - DAY · ");
  expect(summaries[1]).toStartWith("Scene 2 · EXT. GARDEN - NIGHT · ");
  // Each finding: severity and kind in words, the server's own sentence, and the shots it names.
  const strong = d.texts("strong");
  expect(strong).toContain("Warning: The look changes within the scene");
  expect(strong).toContain("Warning: A shot's time of day contradicts the scene heading");
  expect(strong.some(text => text.startsWith("Note: "))).toBe(true);
  const [a, b] = inScene(0);
  expect(d.texts("p")).toContain("Shots " + a.id + ", " + b.id);
  expect(d.texts("p").some(text => text.startsWith("This scene declares more than one key light: “warm tungsten” and “cold moonlight”."))).toBe(true);
  // Nothing is written as markup: the panel's source never assigns innerHTML or inserts HTML.
  const source = readFileSync(join(import.meta.dir, "../src/continuity.js"), "utf8");
  expect(source).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
});

test("a server string that looks like markup is drawn as text", () => {
  const d = mount();
  const report = structuredClone(d.s.state().continuity);
  report.scenes[0].findings[0].message = "<img src=x onerror=alert(1)>";
  const parent = new Element("div");
  const view = initContinuity({parent, request: async () => ({}), state: () => ({continuity: report, direction: {version: 1, revision: "r"}, maxShots: 24}), canEdit: () => true, accepted: async () => {}, reload: async () => {}});
  view.render();
  expect(tree(parent).some(e => e.tag === "p" && e.textContent === "<img src=x onerror=alert(1)>")).toBe(true);
  expect(tree(parent).some(e => e.tag === "img")).toBe(false);
});

test("an empty report says there is nothing to fix, and does not call an undeclared film a pass", () => {
  const [a, b] = inScene(0), [c, e] = inScene(1);
  const agreeing = [directionEntry(a, {keyLight: "warm tungsten"}), directionEntry(b, {keyLight: "warm tungsten"}), directionEntry(c, {timeOfDay: "night"}), directionEntry(e, {timeOfDay: "night"})];
  const report = continuityReport(shots, cast, directionSnapshot("project-1", 1, agreeing, now), parsed);
  // These shots have no frame anchors, so the report still carries handoff notes; with those taken
  // out it is a report of a film whose declarations agree.
  const clean = {...report, scenes: report.scenes.map(scene => ({...scene, findings: []})), totals: {...report.totals, warnings: 0, unknowns: 0, notes: 0}};
  const draw = value => {const parent = new Element("div"); initContinuity({parent, request: async () => ({}), state: () => ({continuity: value, direction: {version: 1, revision: "r"}, maxShots: 24}), canEdit: () => true, accepted: async () => {}, reload: async () => {}}).render(); return tree(parent);};
  restore = mountDom();
  const agreed = draw(clean);
  expect(agreed.find(e => e.tag === "p" && e.textContent.startsWith("Nothing to fix."))?.textContent).toMatch(/^Nothing to fix\. The saved declarations agree with each other across \d+ comparisons?\.$/);
  expect(agreed.some(e => e.tag === "summary")).toBe(false);
  const nothing = draw({...clean, totals: {...clean.totals, lookComparisons: 0, wardrobeComparisons: 0, handoffComparisons: 0}});
  expect(nothing.some(e => e.tag === "p" && e.textContent === "Nothing to fix. Nothing is declared yet that could be compared, so this is not a pass.")).toBe(true);
});

test("reviewing shows the summary, the notes and every edit from what to what, and applies nothing", async () => {
  const d = mount();
  const before = d.s.state().direction.revision;
  await d.press("Review continuity repair");
  // One review request, with the plan's shot tier, and nothing else sent.
  expect(d.s.calls.map(call => call.path)).toEqual(["/continuity/repair"]);
  expect(d.s.calls[0].body).toEqual({maxShots: 24});
  expect(d.s.state().direction.revision).toBe(before);
  const proposal = continuityRepair(d.s.state().continuity);
  expect(proposal.edits).toHaveLength(1);
  const [, b] = inScene(0);
  expect(d.texts("h4")).toContain("Proposed continuity repair");
  expect(d.texts("p")).toContain(continuityRepairSummary(proposal));
  expect(d.texts("li")).toContain("Shot " + b.id + ", key light: from “cold moonlight” to “warm tungsten”");
  for (const note of proposal.notes) expect(d.texts("li")).toContain(note);
  expect(d.status.textContent).toBe("Review the 1 change below. Nothing has been applied.");
  expect(d.find("button", "Apply continuity repair").hidden).toBe(false);
  // Discarding the review changes nothing either.
  await d.press("Discard repair review");
  expect(d.s.calls.map(call => call.path)).toEqual(["/continuity/repair"]);
  expect(d.find("button", "Apply continuity repair").hidden).toBe(true);
});

test("when the server says no repair can be made, the panel shows its reason and offers nothing to apply", async () => {
  // The limit refusal as HV-021-04 made the route answer it: the report, no proposal, and the reason.
  const reason = "This film's declared look drifts in 295 places, more than the 240 one repair carries.";
  const d = mount(server(drifted(), {unavailable: reason}));
  await d.press("Review continuity repair");
  expect(d.texts("p")).toContain("No repair can be made: " + reason);
  expect(d.status.textContent).toBe("No repair can be made: " + reason);
  expect(d.find("button", "Apply continuity repair").hidden).toBe(true);
  // The report is still there beside the refusal.
  expect(d.texts("strong")).toContain("Warning: The look changes within the scene");
  expect(d.s.calls.map(call => call.path)).toEqual(["/continuity/repair"]);
});

test("applying sends exactly the reviewed edits and versions, then reloads the report", async () => {
  const d = mount();
  await d.press("Review continuity repair");
  const reviewed = continuityRepair(d.s.state().continuity);
  await d.press("Apply continuity repair");
  const accept = d.s.calls.filter(call => call.path === "/continuity/repair/accept");
  expect(accept).toHaveLength(1);
  expect(accept[0].body).toEqual({edits: reviewed.edits, expectedVersion: 4, expectedScriptVersion: 3, maxShots: 24});
  // Verbatim: the same objects in the same order, as the server's hash compares them.
  expect(JSON.stringify(accept[0].body.edits)).toBe(JSON.stringify(reviewed.edits));
  // The report was fetched again after the apply and is drawn from the new direction.
  expect(d.s.calls.map(call => call.path)).toEqual(["/continuity/repair", "/continuity/repair/accept", ""]);
  expect(d.texts("strong")).not.toContain("Warning: The look changes within the scene");
  expect(d.texts("strong")).toContain("Warning: A shot's time of day contradicts the scene heading");
  expect(d.status.textContent).toBe("Continuity repair applied as direction version 5. The report above is the new one. Create a new preview to see it.");
  expect(d.find("button", "Apply continuity repair").hidden).toBe(true);
});

test("a conflict on apply says the direction changed, reloads the report, and does not retry", async () => {
  const d = mount();
  await d.press("Review continuity repair");
  d.s.refuse = true;
  await d.press("Apply continuity repair");
  expect(d.s.calls.map(call => call.path)).toEqual(["/continuity/repair", "/continuity/repair/accept", ""]);
  expect(d.status.textContent).toBe("The direction changed since this repair was reviewed, so nothing was applied. The report has been reloaded; review the repair again.");
  expect(d.status.dataset.state).toBe("error");
  // The stale review is gone, so the refused edits cannot be sent again without a new review.
  expect(d.find("button", "Apply continuity repair").hidden).toBe(true);
  expect(d.texts("h4")).not.toContain("Proposed continuity repair");
  await settle(10);
  expect(d.s.calls.filter(call => call.path === "/continuity/repair/accept")).toHaveLength(1);
});

test("a desk behind the server's direction reloads rather than offering a repair bound to another version", async () => {
  const d = mount();
  d.s.moveDirection();
  await d.press("Review continuity repair");
  expect(d.s.calls.map(call => call.path)).toEqual(["/continuity/repair", ""]);
  expect(d.find("button", "Apply continuity repair").hidden).toBe(true);
  expect(d.status.textContent).toBe("The direction changed since the desk loaded, so the report has been reloaded. Review the repair again.");
});

test("the panel is a headed region with real buttons and a live status that stays outside the busy state", async () => {
  const d = mount();
  const section = d.all().find(e => e.tag === "section"), heading = d.all().find(e => e.tag === "h3");
  expect(heading.textContent).toBe("Continuity");
  expect(section.getAttribute("aria-labelledby")).toBe(heading.id);
  for (const label of ["Review continuity repair", "Apply continuity repair", "Discard repair review"]) expect(d.find("button", label).type).toBe("button");
  expect(d.status.getAttribute("role")).toBe("status");
  expect(d.status.parentElement).toBe(section);
  const release = d.s.holdNext();
  const pending = d.find("button", "Review continuity repair").onclick();
  await settle();
  // While the request is out: the panel's other parts are busy, the status is not, and the button is off.
  const busy = d.all().filter(e => e.getAttribute("aria-busy") === "true");
  expect(busy.length).toBeGreaterThan(0);
  expect(busy).not.toContain(d.status);
  expect(busy).not.toContain(section);
  expect(d.find("button", "Review continuity repair").disabled).toBe(true);
  expect(d.status.textContent).toBe("Reviewing the continuity repair…");
  release(); await pending; await settle();
  expect(d.all().filter(e => e.getAttribute("aria-busy") === "true")).toEqual([]);
  expect(d.find("button", "Review continuity repair").disabled).toBe(false);
});

test("pressing twice sends one review and one apply", async () => {
  const d = mount();
  const review = d.find("button", "Review continuity repair");
  await Promise.all([review.onclick(), review.onclick()]); await settle();
  expect(d.s.calls.filter(call => call.path === "/continuity/repair")).toHaveLength(1);
  const apply = d.find("button", "Apply continuity repair");
  await Promise.all([apply.onclick(), apply.onclick()]); await settle();
  expect(d.s.calls.filter(call => call.path === "/continuity/repair/accept")).toHaveLength(1);
});

test("an open shot edit holds the repair back", async () => {
  let open = true;
  const d = mount(server(), {canEdit: () => !open});
  await d.press("Review continuity repair");
  expect(d.s.calls).toEqual([]);
  expect(d.status.textContent).toBe("Save or cancel the open shot edit before reviewing a continuity repair.");
  open = false;
  await d.press("Review continuity repair");
  open = true;
  await d.press("Apply continuity repair");
  expect(d.s.calls.map(call => call.path)).toEqual(["/continuity/repair"]);
});

test("the Director's desk draws the continuity panel from its own direction load", async () => {
  restore = mountDom();
  const s = server(), panel = new Element("section");document.body.append(panel);panel.hidden = true;
  const view = initDirection({panel, request: (path, init) => s.request(path, init), prepare: async () => {}, changed() {}, assetUrl: url => url, image: async () => new Blob(),
    takeRequest: async () => ({groups: []}), prepareGeneration: async () => {}, motionDownload: async () => new Blob()});
  await view.open(); await settle();
  const all = tree(panel);
  expect(all.some(e => e.tag === "h3" && e.textContent === "Continuity")).toBe(true);
  expect(all.some(e => e.tag === "strong" && e.textContent === "Warning: The look changes within the scene")).toBe(true);
  // And its repair goes through the desk's own request, under the desk's direction path.
  await all.find(e => e.tag === "button" && e.textContent === "Review continuity repair").onclick(); await settle();
  expect(s.calls.map(call => call.path)).toContain("/continuity/repair");
});
