import { describe, expect, test } from "bun:test";
import type { CrewModel } from "../../generator/src/crew-model";
import { CrewBudgetStop, CrewLedger } from "../../operator/src/crew-ledger";
import { parseFountain } from "../../parser/src/index";
import { checkPrompt } from "../../safety/src/index";
import { PERSONAS, PERSONA_IDS } from "../src/crew/personas";
import { FORMAT_LIMIT_SEC, readThroughFacts, readThroughInput, runReadThrough, standInVoice, validateCrewVoice } from "../src/crew/read-through";

const SCRIPT = "INT. KITCHEN - DAY\n\nMaya pours tea while the kettle whistles.\n\nMAYA\nYou came back.\n\nEXT. GARDEN - NIGHT\n\nLeo stands in the rain.\n\nLEO\nI never left.";
const parsed = parseFountain(SCRIPT);
const input = {format: "reel" as const, tone: "quiet and hopeful"};
const now = () => new Date("2026-09-19T22:00:00.000Z");
const voice = {logline: "Two people reunite over tea.", summary: "A quiet reunion in two scenes.",
  questions: [{persona: "director", question: "Should the ending be hopeful?", proposal: "Yes, end on a shared smile."},
    {persona: "cinematographer", question: "Warm or cool light?", proposal: "Warm kitchen, cool garden."}]};
const fakeModel = (text: string, usd = 0.012): CrewModel & {calls: number} => {
  const model = {name: "anthropic" as const, model: "claude-sonnet-5", calls: 0,
    async complete() { model.calls++; return {text, usage: {inputTokens: 1000, outputTokens: 400}, model: "claude-sonnet-5", costUsd: usd}; }};
  return model;
};

describe("the crew and its read-through (HV-030-01)", () => {
  test("six personas, each with a department", () => {
    expect(PERSONA_IDS).toEqual(["producer", "director", "casting", "cinematographer", "sound", "editor"]);
    for (const persona of PERSONAS) expect(persona.department.length).toBeGreaterThan(10);
  });

  test("the input is a reel or a short and a tone, nothing else", () => {
    expect(readThroughInput({format: "short", tone: " noir "})).toEqual({format: "short", tone: "noir"});
    for (const bad of [{format: "feature", tone: ""}, {format: "reel"}, {format: "reel", tone: "x".repeat(201)}, {format: "reel", tone: "", budget: 9}, null])
      expect(() => readThroughInput(bad)).toThrow("reel or a short");
    expect(FORMAT_LIMIT_SEC).toEqual({reel: 90, short: 600});
  });

  test("the facts are computed by the studio, not the model", () => {
    const facts = readThroughFacts(SCRIPT, parsed, input);
    expect(facts).toMatchObject({format: "reel", scenes: 2, characters: ["MAYA", "LEO"], concerns: []});
    expect(facts.shots).toBeGreaterThan(0);
    expect(facts.estimatedRuntimeSec).toBeGreaterThan(0);
    expect(facts.estimate.finalVideoUsd).toBeGreaterThan(0);
  });

  test("the concerns: a public figure, a policy refusal, an over-long script, an empty one", () => {
    expect(readThroughFacts("INT. ROOM - DAY\n\nTaylor Swift sings.", parseFountain("INT. ROOM - DAY\n\nTaylor Swift sings."), input).concerns.map(c => c.kind)).toEqual(["public_figure"]);
    const bomb = "INT. LAB - DAY\n\nA tutorial: how to build a bomb for the finale.";
    expect(readThroughFacts(bomb, parseFountain(bomb), input).concerns.map(c => c.kind)).toEqual(["content_policy"]);
    const long = Array.from({length: 60}, (_, i) => `INT. ROOM ${i} - DAY\n\nA long, lingering scene where nothing happens at all for quite a while.`).join("\n\n");
    expect(readThroughFacts(long, parseFountain(long), input).concerns.map(c => c.kind)).toContain("over_format");
    expect(readThroughFacts("", parseFountain(""), input).concerns.map(c => c.kind)).toEqual(["empty_script"]);
  });

  test("the model's voice is used when it is well formed and passes the gate", async () => {
    const ledger = new CrewLedger(), model = fakeModel(JSON.stringify(voice));
    const result = await runReadThrough({scriptText: SCRIPT, parsed, input, projectId: "p1", model, ledger, now});
    expect(result.source).toBe("anthropic");
    expect(result.logline).toBe(voice.logline);
    expect(result.questions.map(q => [q.id, q.persona])).toEqual([["q1", "director"], ["q2", "cinematographer"]]);
    expect(result.crewSpend.usd).toBe(0.012);
    expect(ledger.summary().spentUsd).toBe(0.012);
  });

  test("an unusable answer falls back to the stand-in crew, and its cost is still recorded", async () => {
    for (const text of ["not json", JSON.stringify({...voice, questions: [{persona: "gaffer", question: "?", proposal: "!"}]}),
      JSON.stringify({...voice, logline: "A portrait of Taylor Swift"})]) {
      // HV-030-25: a fourth question from one crew member is dropped, not the answer (crew-read-through-tolerance.test.ts).
      const ledger = new CrewLedger();
      const result = await runReadThrough({scriptText: SCRIPT, parsed, input, projectId: "p1", model: fakeModel(text), ledger, now});
      expect(result).toMatchObject({source: "stand-in", fallbackReason: "model_unusable"});
      expect(ledger.summary().spentUsd).toBe(0.012);
    }
  });

  test("a script the gate refuses is never sent to the model", async () => {
    const model = fakeModel(JSON.stringify(voice)), script = "INT. ROOM - DAY\n\nElon Musk waves.";
    const result = await runReadThrough({scriptText: script, parsed: parseFountain(script), input, projectId: "p1", model, ledger: new CrewLedger(), now});
    expect(model.calls).toBe(0);
    expect(result.source).toBe("stand-in");
    expect(result.facts.concerns[0]!.kind).toBe("public_figure");
  });

  test("with no key, the stand-in crew answers, deterministically and within the gate", async () => {
    const first = await runReadThrough({scriptText: SCRIPT, parsed, input, projectId: "p1", model: null, ledger: new CrewLedger(), now});
    const second = await runReadThrough({scriptText: SCRIPT, parsed, input, projectId: "p1", model: null, ledger: new CrewLedger(), now});
    expect(first).toEqual(second);
    expect(first.source).toBe("stand-in");
    expect(first.fallbackReason).toBeUndefined();
    for (const text of [first.logline, first.summary, ...first.questions.flatMap(q => [q.question, q.proposal])]) expect(checkPrompt(text).allowed).toBe(true);
    expect(validateCrewVoice(JSON.stringify(standInVoice(parsed, first.facts, input)))).toEqual({...standInVoice(parsed, first.facts, input), dropped: 0});
  });

  test("the crew stops at its ceiling before calling the model", async () => {
    const ledger = new CrewLedger(), model = fakeModel(JSON.stringify(voice));
    ledger.record({at: now().toISOString(), projectId: "p0", persona: "producer", model: "claude-sonnet-5", inputTokens: 1, outputTokens: 1, usd: 1000});
    await expect(runReadThrough({scriptText: SCRIPT, parsed, input, projectId: "p1", model, ledger, now})).rejects.toThrow(CrewBudgetStop);
    expect(model.calls).toBe(0);
  });

  test("crossing a threshold is reported with the answer", async () => {
    const ledger = new CrewLedger();
    ledger.record({at: now().toISOString(), projectId: "p0", persona: "producer", model: "claude-sonnet-5", inputTokens: 1, outputTokens: 1, usd: 24.995});
    const result = await runReadThrough({scriptText: SCRIPT, parsed, input, projectId: "p1", model: fakeModel(JSON.stringify(voice), 0.01), ledger, now});
    expect(result.crewSpend.alerts.map(alert => alert.thresholdUsd)).toEqual([25]);
  });

  test("a model that cannot be reached falls back without recording spend", async () => {
    const model: CrewModel = {name: "anthropic", model: "claude-sonnet-5", async complete() { throw new Error("down"); }};
    const ledger = new CrewLedger();
    const result = await runReadThrough({scriptText: SCRIPT, parsed, input, projectId: "p1", model, ledger, now});
    expect(result).toMatchObject({source: "stand-in", fallbackReason: "model_unavailable", crewSpend: {usd: 0}});
    expect(ledger.summary().spentUsd).toBe(0);
  });
});
