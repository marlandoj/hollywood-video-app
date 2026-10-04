/**
 * HV-021-11 — the Director's desk shows a feature's sequence boundaries.
 *
 * The panel is mounted over the planner's own report and repair for a six-scene feature split into
 * three sequences of two scenes (the fake server computes `continuityReport` with the sequence plan,
 * `continuityRepair`, its summary and `continuityRepairRemakes`, and refuses an accept whose edits
 * differ, as the real routes do). A finding across a boundary is labelled with it, every boundary is
 * listed with what was compared across it, the repair's boundary edit says where it holds, and the
 * sequences made before the repair are named before and after it is applied.
 */
import {afterEach, expect, test} from "bun:test";
import {parseFountain} from "../../parser/src/index";
import {castingSnapshot, characterRecord} from "../../planner/src/casting";
import {directionEntry, directionSnapshot} from "../../planner/src/direction";
import {continuityReport} from "../../planner/src/continuity";
import {continuityRepair, continuityRepairRemakes, continuityRepairSummary} from "../../planner/src/continuity-repair";
import {featureShots, greedySequences, sceneShotCounts, sequencePlan} from "../../planner/src/sequences";
import {boundaryLine, initContinuity} from "../src/continuity.js";
import {Element, mountDom, tree} from "./audio-studio-dom.js";

const now = Date.UTC(2026, 9, 4);
const HEADINGS = ["INT. LIGHTHOUSE - NIGHT", "INT. LANTERN ROOM - NIGHT", "INT. STAIRWELL - CONTINUOUS", "INT. STAIRWELL - NIGHT", "INT. STAIRWELL - CONTINUOUS", "EXT. CLIFF - DAY"];
const parsed = parseFountain(HEADINGS.map((heading, i) => heading + "\n\n" + Array.from({length: 9}, (_, b) => `Marguerite moves through scene ${i + 1}, step ${b + 1}.`).join("\n\n")).join("\n\n"));
const shots = featureShots(parsed), plan = sequencePlan(1, greedySequences(sceneShotCounts(parsed)));
const permission = {status: "permitted", scope: "project", sceneNumbers: [], expiresAt: null, attestedAt: new Date(now).toISOString()};
const cast = castingSnapshot("project-1", 1, [characterRecord({name: "MARGUERITE", aliases: [], kind: "original-fictional", appearance: "A keeper of the light.", ageRange: "adult", ethnicity: "", body: "",
  hairMakeup: "", expressions: "", movement: "", relationships: "", arcNotes: "", prohibitedChanges: "", sceneBindings: [], permission,
  wardrobe: [{sceneNumber: null, description: "An oilskin coat"}, {sceneNumber: 3, description: "No coat, a wet jumper"}]}, "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", now, true)], now);
const shot = id => shots.find(value => value.id === id);
const settle = async (turns = 4) => {for (let i = 0; i < turns; i++) await new Promise(resolve => setTimeout(resolve, 0));};
let restore = () => {};
afterEach(() => restore());

function server() {
  let version = 4, entries = [directionEntry(shot("shot-4-1"), {keyLight: "Low lamp light"}), directionEntry(shot("shot-5-1"), {keyLight: "Bright daylight"})];
  const calls = [], snapshot = () => directionSnapshot("project-1", version, entries, now);
  const report = () => continuityReport(shots, cast, snapshot(), parsed, plan);
  // Sequence 1 has a rough cut under the current direction, and sequence 3 one being made.
  const jobs = () => [{id: "rough-1", stage: "animatic", status: "done", sequence: {number: 1, planRevision: plan.revision}, direction: snapshot()},
    {id: "rough-3", stage: "animatic", status: "queued", sequence: {number: 3, planRevision: plan.revision}, direction: snapshot()}];
  const s = {
    calls,
    state: () => ({direction: snapshot(), maxShots: 24, scriptVersion: 2, continuity: report()}),
    async request(path, init) {
      calls.push(path);
      if (path === "") return s.state();
      const proposal = continuityRepair(report());
      if (path === "/continuity/repair") return {report: report(), proposal, unavailable: null, summary: continuityRepairSummary(proposal), scriptVersion: 2, remake: continuityRepairRemakes(plan, proposal.edits, jobs(), snapshot())};
      if (path === "/continuity/repair/accept") {
        if (JSON.stringify(init.body.edits) !== JSON.stringify(proposal.edits) || init.body.expectedVersion !== version) {const error = new Error("The film changed."); error.status = 409; throw error;}
        const replaced = snapshot(), made = jobs();
        for (const edit of proposal.edits) entries = entries.map(entry => entry.source.id === edit.shotId ? {...entry, settings: {...entry.settings, [edit.field]: edit.to}} : entry);
        version++;
        return {direction: snapshot(), remake: continuityRepairRemakes(plan, proposal.edits, made, replaced)};
      }
      throw new Error("unexpected " + path);
    },
  };
  return s;
}
function mount(s = server(), state = null) {
  restore = mountDom();
  const parent = new Element("div");document.body.append(parent);
  let desk = state ?? s.state();
  const view = initContinuity({parent, request: (path, init) => s.request(path, init), state: () => desk, canEdit: () => true,
    accepted: async () => {desk = await s.request(""); view.render();}, reload: async () => {desk = await s.request(""); view.render();}});
  view.render();
  const all = () => tree(parent), texts = tag => all().filter(e => e.tag === tag && !e.closest("[hidden]")).map(e => e.textContent);
  const status = all().find(e => e.getAttribute("role") === "status");
  const press = async text => {await all().find(e => e.tag === "button" && e.textContent === text).onclick(); await settle();};
  return {s, texts, status, press};
}

test("a finding across a sequence boundary is labelled with it, and the scene that opens the sequence says so", () => {
  const d = mount();
  const strong = d.texts("strong");
  expect(strong).toContain("Warning: A character's wardrobe changes across a CONTINUOUS heading (where sequence 1 meets sequence 2)");
  expect(strong).toContain("Warning: The light changes across a sequence boundary in the same place (where sequence 2 meets sequence 3)");
  // A finding inside a scene is not labelled.
  expect(strong).toContain("Unknown: A character has no reference image");
  expect(strong.filter(text => !text.startsWith("Warning: ")).every(text => !text.includes("where sequence"))).toBe(true);
  const summaries = d.texts("summary");
  expect(summaries.some(text => text.startsWith("Scene 3 · INT. STAIRWELL - CONTINUOUS · opens sequence 2 · "))).toBe(true);
  expect(summaries.some(text => text.startsWith("Scene 5 · INT. STAIRWELL - CONTINUOUS · opens sequence 3 · "))).toBe(true);
  expect(summaries.some(text => text.startsWith("Scene 4 ") && text.includes("opens sequence"))).toBe(false);
});

test("every sequence boundary is listed with what was compared across it", () => {
  const d = mount();
  expect(d.texts("summary")).toContain("Sequence boundaries (2) · 2 findings");
  expect(d.texts("li")).toContain("Sequence 1 to 2, scene 2 to scene 3: CONTINUOUS; 1 comparison, 1 finding.");
  expect(d.texts("li")).toContain("Sequence 2 to 3, scene 4 to scene 5: CONTINUOUS, in the same place; 2 comparisons, 1 finding.");
  // The other two shapes of a boundary, in words.
  expect(boundaryLine({from: 3, to: 4, lastScene: 6, firstScene: 7, continuous: false, sameLocation: false, comparisons: 0, findings: 0}))
    .toBe("Sequence 3 to 4, scene 6 to scene 7: not compared. Scene 7 is not CONTINUOUS, so story time may pass between the two.");
  expect(boundaryLine({from: 3, to: 4, lastScene: 6, firstScene: 7, continuous: true, sameLocation: false, comparisons: 0, findings: 0}))
    .toBe("Sequence 3 to 4, scene 6 to scene 7: CONTINUOUS, but nothing is declared on both sides to compare.");
  expect(boundaryLine({from: 3, to: 4, lastScene: 6, firstScene: 7, continuous: true, sameLocation: true, comparisons: 3, findings: 0}))
    .toBe("Sequence 3 to 4, scene 6 to scene 7: CONTINUOUS, in the same place; 3 comparisons, nothing contradicts.");
});

test("the boundary repair is reviewed with where it holds and what it sends back, then applied exactly as reviewed", async () => {
  const d = mount();
  await d.press("Review continuity repair");
  expect(d.texts("li")).toContain("Shot shot-5-1, key light: from “Bright daylight” to “Low lamp light” (where sequence 2 meets sequence 3)");
  expect(d.texts("p")).toContain("Sequence 1 and sequence 3 (changed by this repair) are made under the current shot directions, so each will need a new rough cut before its final.");
  expect(d.texts("p").some(text => text.includes("Sequence 3 opens in the place and moment the sequence before it closes"))).toBe(true);
  await d.press("Apply continuity repair");
  expect(d.s.calls).toEqual(["/continuity/repair", "/continuity/repair/accept", ""]);
  expect(d.status.textContent).toBe("Continuity repair applied as direction version 5. The report above is the new one. "
    + "Sequence 1 and sequence 3 (changed by this repair) were made under the earlier shot directions, so each needs a new rough cut before its final.");
  expect(d.texts("strong").some(text => text.startsWith("Warning: The light changes across a sequence boundary"))).toBe(false);
  expect(d.texts("strong")).toContain("Warning: A character's wardrobe changes across a CONTINUOUS heading (where sequence 1 meets sequence 2)");
});

test("a report without sequences -- a reel or a short -- draws no boundaries and labels nothing", () => {
  const s = server(), short = continuityReport(shots, cast, s.state().direction, parsed);
  const d = mount(s, {...s.state(), continuity: short});
  expect(d.texts("summary").some(text => text.startsWith("Sequence boundaries") || text.includes("opens sequence"))).toBe(false);
  expect(d.texts("strong").some(text => text.includes("where sequence"))).toBe(false);
});
