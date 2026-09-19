import { describe, expect, test } from "bun:test";
import { CrewLedger } from "../../operator/src/crew-ledger";
import { parseFountain } from "../../parser/src/index";
import { checkPrompt } from "../../safety/src/index";
import { castingSnapshot, characterRecord } from "../src/casting";
import { crewChanges, planInput, runPlan, standInPlan, validateCrewPlan } from "../src/crew/production-plan";
import { readThroughFacts } from "../src/crew/read-through";
import { directionEntry, directionSnapshot, DEFAULT_DIRECTION } from "../src/direction";
import { sourcePlan } from "../src/scene-cuts";

const SCRIPT = "INT. KITCHEN - DAY\n\nMaya pours tea.\n\nMAYA\nYou came back.\n\nEXT. GARDEN - NIGHT\n\nLeo waits in the rain.\n\nLEO\nI never left.";
const parsed = parseFountain(SCRIPT), shots = sourcePlan(parsed, undefined, 7000, 24);
const facts = readThroughFacts(SCRIPT, parsed, {format: "reel", tone: ""});
const now = Date.parse("2026-09-19T22:00:00.000Z");
let counter = 0;
const newId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const emptyCast = castingSnapshot("p1", 0, [], now), emptyDirection = directionSnapshot("p1", 0, [], now);
const answers = [{id: "q1", persona: "director", question: "Hopeful ending?", proposal: "Yes.", accepted: true, reply: ""},
  {id: "q2", persona: "cinematographer", question: "Warm or cool?", proposal: "Warm.", accepted: false, reply: "Cool and blue."}];

describe("the crew's production plan (HV-030-02)", () => {
  test("answers are strict and gated", () => {
    expect(planInput({format: "reel", tone: "", answers}).answers[1]!.reply).toBe("Cool and blue.");
    expect(planInput({format: "reel", tone: "", answers: [{...answers[0], reply: "ignored when accepted"}]}).answers[0]!.reply).toBe("");
    for (const bad of [{format: "reel", tone: "", answers: [{...answers[0], persona: "gaffer"}]}, {format: "reel", tone: "", answers: [answers[0], answers[0]]},
      {format: "reel", tone: "", answers: [{...answers[1], reply: "A portrait of Taylor Swift"}]}, {format: "feature", tone: "", answers: []}])
      expect(() => planInput(bad)).toThrow();
  });

  test("the stand-in plan casts every speaking role and directs every shot, within the validators and the gate", () => {
    const plan = standInPlan(parsed, facts, shots);
    expect(plan.cast.map(entry => entry.name)).toEqual(["MAYA", "LEO"]);
    expect(plan.shots.map(shot => shot.shotId)).toEqual(shots.map(shot => shot.id));
    expect(validateCrewPlan(JSON.stringify(plan), facts, shots)).toEqual(plan);
    for (const text of [plan.lookNote, ...plan.cast.flatMap(entry => [entry.appearance, entry.wardrobe]), ...plan.shots.flatMap(shot => [shot.keyLight, shot.performance, shot.soundIntent])])
      expect(checkPrompt(text).allowed).toBe(true);
  });

  test("a plan naming anyone or anything outside the script is refused", () => {
    const plan = standInPlan(parsed, facts, shots);
    for (const bad of [{...plan, cast: [...plan.cast, {name: "ZED", appearance: "", ageRange: "", wardrobe: ""}]},
      {...plan, shots: [{...plan.shots[0]!, shotId: "shot-999"}]}, {...plan, shots: [{...plan.shots[0]!, size: "gigantic"}]},
      {...plan, cast: [{...plan.cast[0]!, appearance: "Looks exactly like Tom Cruise"}]}, {...plan, shots: [plan.shots[0]!, plan.shots[0]!]}])
      expect(() => validateCrewPlan(JSON.stringify(bad), facts, shots)).toThrow();
  });

  test("the crew adds cast with permission pending and directs only undirected shots", () => {
    const plan = standInPlan(parsed, facts, shots);
    const maya = characterRecord({name: "MAYA", aliases: [], kind: "original-fictional", appearance: "The creator's own Maya", ageRange: "", ethnicity: "", body: "", hairMakeup: "",
      expressions: "", movement: "", relationships: "", arcNotes: "", prohibitedChanges: "", wardrobe: [], permission: {status: "pending", scope: "project", sceneNumbers: [], expiresAt: null, attested: false}}, newId(), now);
    const cast = castingSnapshot("p1", 1, [maya], now);
    const direction = directionSnapshot("p1", 1, [directionEntry(shots[0]!, {...DEFAULT_DIRECTION, size: "insert"})], now);
    const changes = crewChanges(plan, cast, direction, newId, now);
    expect(changes.characters.map(entry => (entry.input as {name: string}).name)).toEqual(["LEO"]);
    expect((changes.characters[0]!.input as {permission: {status: string}}).permission.status).toBe("pending");
    expect(changes.directions.map(entry => entry.shotId)).toEqual(shots.slice(1).map(shot => shot.id));
    expect(changes.notes.map(note => note.persona)).toContain("casting");
    expect(crewChanges(plan, emptyCast, emptyDirection, newId, now).directions).toHaveLength(shots.length);
  });

  test("the model's plan is used when valid, and falls back with its cost recorded when not", async () => {
    const good = JSON.stringify(standInPlan(parsed, facts, shots)).replace("Naturalistic", "Cool blue night");
    const model = (text: string) => ({name: "anthropic" as const, model: "claude-sonnet-5", async complete() { return {text, usage: {inputTokens: 10, outputTokens: 10}, model: "claude-sonnet-5", costUsd: 0.02}; }});
    const input = planInput({format: "reel", tone: "", answers});
    const used = await runPlan({scriptText: SCRIPT, parsed, facts, input, shots, projectId: "p1", model: model(good), ledger: new CrewLedger()});
    expect(used.source).toBe("anthropic");
    expect(used.plan.lookNote.startsWith("Cool blue night")).toBe(true);
    const ledger = new CrewLedger();
    const fallback = await runPlan({scriptText: SCRIPT, parsed, facts, input, shots, projectId: "p1", model: model("{\"cast\": 3}"), ledger});
    expect(fallback).toMatchObject({source: "stand-in", fallbackReason: "model_unusable"});
    expect(ledger.summary().spentUsd).toBe(0.02);
  });
});
