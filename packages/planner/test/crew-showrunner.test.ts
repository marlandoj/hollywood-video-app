/**
 * HV-030-29 — the Showrunner splits a feature into sequences (Release 3 step 2, G20-202610031349).
 *
 * A feature is longer than one render (24 shots on the free tier), so the Showrunner splits it into
 * runs of consecutive scenes of at most 24 shots each. The model may propose the boundaries; the studio
 * counts the shots and validates the split, and falls back to the stand-in's greedy split when the
 * answer can't be used. The feature's shots are the same whichever valid split is chosen.
 */
import { describe, expect, test } from "bun:test";
import { CrewLedger } from "../../operator/src/crew-ledger";
import { parseFountain } from "../../parser/src/index";
import { TIERS } from "../../queue/src/index";
import { CREW, SHOWRUNNER, PERSONA_IDS } from "../src/crew/personas";
import { runShowrunner, showrunnerNote, showrunnerPrompt, validateShowrunnerSplit } from "../src/crew/showrunner";
import { countedSequences, featureShots, filmPlan, greedySequences, inSequence, SEQUENCE_SHOT_LIMIT, sceneShotCounts, sequencePlan, sequenceRef,
  splitProblem, stalePlanReason, validateSequencePlan, validateSequenceRef } from "../src/sequences";
import { sourcePlan } from "../src/scene-cuts";
import { featureScript } from "../../../test/fixtures/feature-script";

const parsed = parseFountain(featureScript()), counts = sceneShotCounts(parsed);
const model = (text: string, costUsd = 0.01) => {
  const asked: string[] = [];
  return {asked, name: "anthropic" as const, model: "claude-sonnet-5", async complete(request: {messages: {content: string}[]}) {
    asked.push(request.messages[0]!.content); return {text, usage: {inputTokens: 100, outputTokens: 40}, model: "claude-sonnet-5", costUsd};
  }};
};

describe("the Showrunner on the roster", () => {
  test("it is crew, asks no questions, and proposes sequences only", () => {
    expect(CREW.map(member => member.id)).toEqual([...PERSONA_IDS, "continuity", "showrunner"]);
    expect(SHOWRUNNER).toMatchObject({id: "showrunner", title: "Showrunner", speaks: "sequence-plan"});
    expect(PERSONA_IDS).not.toContain("showrunner" as never);
  });
});

describe("a feature's split", () => {
  test("the per-render limit is the free tier's 24 shots", () => {
    expect(SEQUENCE_SHOT_LIMIT).toBe(TIERS.free.maxShots);
    expect(SEQUENCE_SHOT_LIMIT).toBe(24);
  });

  test("a 34-scene feature splits into sequences of at most 24 shots covering every scene once, in order", () => {
    expect(parsed.scenes).toHaveLength(34);
    const sequences = greedySequences(counts), shots = featureShots(parsed);
    expect(sequences.length).toBeGreaterThan(1);
    expect(sequences[0]!.firstScene).toBe(1);
    expect(sequences.at(-1)!.lastScene).toBe(34);
    for (const [index, sequence] of sequences.entries()) {
      expect(sequence.shots).toBeGreaterThanOrEqual(1);
      expect(sequence.shots).toBeLessThanOrEqual(24);
      expect(sequence.lastScene).toBeGreaterThanOrEqual(sequence.firstScene);
      if (index) expect(sequence.firstScene).toBe(sequences[index - 1]!.lastScene + 1);
    }
    expect(splitProblem(sequences, counts)).toBeNull();
    // Every scene in exactly one sequence; every shot in exactly one sequence's render.
    const scenes = sequences.flatMap(sequence => Array.from({length: sequence.lastScene - sequence.firstScene + 1}, (_, i) => sequence.firstScene + i));
    expect(scenes).toEqual(Array.from({length: 34}, (_, i) => i + 1));
    const plan = sequencePlan(1, sequences);
    const rendered = plan.sequences.map((_, index) => inSequence(shots, sequenceRef(plan, index + 1)));
    expect(rendered.map(list => list.length)).toEqual(sequences.map(sequence => sequence.shots));
    expect(rendered.flat().map(shot => shot.id)).toEqual(shots.map(shot => shot.id));
    expect(new Set(shots.map(shot => shot.id)).size).toBe(shots.length);
    // The 30-beat scene is grouped into 24 shots, alone, as a short of that one scene would be.
    expect(counts[20]).toBe(24);
    expect(sequences.find(sequence => sequence.firstScene === 21)).toEqual({firstScene: 21, lastScene: 21, shots: 24});
  });

  test("each sequence's shots are exactly what a 24-shot render of its scenes plans", () => {
    const plan = sequencePlan(1, greedySequences(counts)), shots = featureShots(parsed);
    for (const [index, sequence] of plan.sequences.entries()) {
      const alone = sourcePlan({...parsed, scenes: parsed.scenes.slice(sequence.firstScene - 1, sequence.lastScene)}, undefined, 7000, 24);
      const ours = inSequence(shots, sequenceRef(plan, index + 1));
      expect(ours.map(shot => [shot.id, shot.prompt, shot.dialogue])).toEqual(alone.map(shot => [shot.id, shot.prompt, shot.dialogue]));
    }
  });

  test("the feature's shots don't depend on the split", () => {
    const other = countedSequences(counts.map((_, index) => ({firstScene: index + 1, lastScene: index + 1})), counts);
    expect(other).toHaveLength(34);
    const a = sequencePlan(1, greedySequences(counts)), b = sequencePlan(1, other);
    expect(a.revision).not.toBe(b.revision);
    const shots = featureShots(parsed);
    expect(b.sequences.flatMap((_, index) => inSequence(shots, sequenceRef(b, index + 1)))).toEqual(a.sequences.flatMap((_, index) => inSequence(shots, sequenceRef(a, index + 1))));
    // A sequence render plans the feature's shots; any other render plans its own 24 as before.
    expect(filmPlan(parsed, undefined, 24, sequenceRef(a, 1))).toEqual(shots);
    expect(filmPlan(parsed, undefined, 24)).toEqual(sourcePlan(parsed, undefined, 7000, 24));
  });

  test("the stand-in split is deterministic", async () => {
    const ledger = new CrewLedger();
    const first = await runShowrunner({parsed, counts, scriptVersion: 3, projectId: "p1", model: null, ledger});
    const again = await runShowrunner({parsed: parseFountain(featureScript()), counts: sceneShotCounts(parseFountain(featureScript())), scriptVersion: 3, projectId: "p1", model: null, ledger});
    expect(first.source).toBe("stand-in");
    expect(first.plan).toEqual(again.plan);
    expect(first.plan).toEqual(sequencePlan(3, greedySequences(counts)));
    expect(first.crewSpend).toEqual({usd: 0, alerts: []});
    expect(validateSequencePlan(structuredClone(first.plan))).toEqual(first.plan);
  });

  test("a scene whose accepted coverage is past 24 shots can't be split", () => {
    expect(() => greedySequences([3, 25, 2])).toThrow("Scene 2's accepted coverage needs 25 shots");
  });
});

describe("the model proposes, the studio validates", () => {
  const boundaries = [{firstScene: 1, lastScene: 6}, {firstScene: 7, lastScene: 12}, {firstScene: 13, lastScene: 18}, {firstScene: 19, lastScene: 20},
    {firstScene: 21, lastScene: 21}, {firstScene: 22, lastScene: 27}, {firstScene: 28, lastScene: 33}, {firstScene: 34, lastScene: 34}];

  test("a usable split is the model's, with the studio's own shot counts", async () => {
    expect(splitProblem(boundaries, counts)).toBeNull();
    const ledger = new CrewLedger(), live = model(JSON.stringify({sequences: boundaries}));
    const result = await runShowrunner({parsed, counts, scriptVersion: 2, projectId: "p1", model: live, ledger});
    expect(result.source).toBe("anthropic");
    expect(result.fallbackReason).toBeUndefined();
    expect(result.plan).toEqual(sequencePlan(2, countedSequences(boundaries, counts)));
    expect(result.plan).not.toEqual(sequencePlan(2, greedySequences(counts)));
    expect(result.crewSpend.usd).toBe(0.01);
    expect(ledger.summary().spentUsd).toBe(0.01);
    // It was shown each scene's heading and shot count, and nothing else of the script.
    expect(live.asked[0]).toContain("21. 24 shots: INT. PLACE 21 - DAY");
    expect(live.asked[0]).not.toContain("Mara crosses");
    expect(showrunnerPrompt(parsed, counts).system).toContain("at most 24");
  });

  test("a gap, an overlap, an oversized or out-of-order sequence is refused and the greedy split is used", async () => {
    const bad = {
      gap: [{firstScene: 1, lastScene: 6}, {firstScene: 8, lastScene: 34}],
      overlap: [...boundaries.slice(0, 2), {firstScene: 12, lastScene: 18}, ...boundaries.slice(3)],
      oversized: [{firstScene: 1, lastScene: 12}, ...boundaries.slice(2)],
      outOfOrder: [boundaries[1]!, boundaries[0]!, ...boundaries.slice(2)],
      empty: [{firstScene: 7, lastScene: 6}, ...boundaries],
      short: boundaries.slice(0, -1),
      unknownScene: [...boundaries.slice(0, -1), {firstScene: 34, lastScene: 35}],
    };
    expect(splitProblem(bad.gap, counts)).toBe("scene 7 is in no sequence");
    expect(splitProblem(bad.overlap, counts)).toBe("sequence 3 overlaps or goes back");
    expect(splitProblem(bad.oversized, counts)).toContain("past 24");
    expect(splitProblem(bad.outOfOrder, counts)).toBe("scene 1 is in no sequence");
    expect(splitProblem(bad.empty, counts)).toBe("sequence 1 holds no scene");
    expect(splitProblem(bad.short, counts)).toBe("scene 34 is in no sequence");
    expect(splitProblem(bad.unknownScene, counts)).toContain("a scene the script doesn't have");
    const greedy = sequencePlan(5, greedySequences(counts));
    for (const sequences of Object.values(bad)) {
      const ledger = new CrewLedger();
      const result = await runShowrunner({parsed, counts, scriptVersion: 5, projectId: "p1", model: model(JSON.stringify({sequences})), ledger});
      expect(result).toMatchObject({source: "stand-in", fallbackReason: "model_unusable", unusableReason: "bad_shape", plan: greedy});
      // The answer was paid for, so it stays on the crew line.
      expect(result.crewSpend.usd).toBe(0.01);
      expect(ledger.summary().spentUsd).toBe(0.01);
    }
  });

  test("an answer that isn't a list of boundaries is unusable, with its reason", async () => {
    for (const [text, reason] of [["Sequences: one to six.", "no_json"], ["{\"sequences\": [{\"firstScene\": 1}]}", "bad_shape"], ["{\"acts\": []}", "bad_shape"],
      ["{\"sequences\": [{\"firstScene\": 1, \"lastScene\": 34, \"note\": \"all\"}]}", "bad_shape"], ["{\"sequences\": [{\"firstScene\": \"1\", \"lastScene\": 6}]}", "bad_shape"]] as const) {
      const result = await runShowrunner({parsed, counts, scriptVersion: 1, projectId: "p1", model: model(text), ledger: new CrewLedger()});
      expect(result).toMatchObject({source: "stand-in", fallbackReason: "model_unusable", unusableReason: reason});
    }
    expect(() => validateShowrunnerSplit("```json\n" + JSON.stringify({sequences: boundaries}) + "\n```", counts)).not.toThrow();
  });

  test("a feature that fits one render asks no model and spends nothing", async () => {
    const small = parseFountain(featureScript(4)), smallCounts = sceneShotCounts(small), live = model("{}");
    expect(smallCounts.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(24);
    const result = await runShowrunner({parsed: small, counts: smallCounts, scriptVersion: 1, projectId: "p1", model: live, ledger: new CrewLedger()});
    expect(result).toMatchObject({source: "stand-in", crewSpend: {usd: 0, alerts: []}});
    expect(result.plan.sequences).toEqual([{firstScene: 1, lastScene: 4, shots: smallCounts.reduce((a, b) => a + b, 0)}]);
    expect(live.asked).toHaveLength(0);
  });

  test("the note is the studio's words, and counts what it doesn't list", () => {
    const note = showrunnerNote(sequencePlan(1, countedSequences(counts.map((_, index) => ({firstScene: index + 1, lastScene: index + 1})), counts)));
    expect(note.persona).toBe("showrunner");
    expect(note.change).toStartWith("Split the feature into 34 sequences of at most 24 shots");
    expect(note.change).toContain("and 28 more");
    expect(note.change).toContain("You approve the look once");
  });
});

describe("a stored plan", () => {
  const plan = sequencePlan(4, greedySequences(counts));

  test("only the Showrunner's shape is read back", () => {
    expect(validateSequencePlan(JSON.parse(JSON.stringify(plan)))).toEqual(plan);
    const tampered = structuredClone(plan); tampered.sequences[0]!.shots = 3;
    expect(() => validateSequencePlan(tampered)).toThrow("changed after the Showrunner made it");
    for (const bad of [{...plan, schema: "hv-sequence-plan/2"}, {...plan, sequences: []}, {...plan, extra: 1}, {...plan, scriptVersion: 0},
      {...plan, sequences: [plan.sequences[1], plan.sequences[0], ...plan.sequences.slice(2)]}, {...plan, sequences: [{...plan.sequences[0]!, shots: 25}, ...plan.sequences.slice(1)]}])
      expect(() => validateSequencePlan(bad)).toThrow();
  });

  test("a plan is stale once the screenplay moves on", () => {
    expect(stalePlanReason(plan, 4, parsed)).toBeNull();
    expect(stalePlanReason(plan, 5, parsed)).toContain("The screenplay changed");
    expect(stalePlanReason(plan, 4, parseFountain(featureScript(30)))).toContain("no longer fit");
  });

  test("a render's sequence names one sequence of one plan", () => {
    const ref = sequenceRef(plan, 2);
    expect(ref).toEqual({number: 2, of: plan.sequences.length, firstScene: plan.sequences[1]!.firstScene, lastScene: plan.sequences[1]!.lastScene, planRevision: plan.revision});
    expect(validateSequenceRef(structuredClone(ref))).toEqual(ref);
    expect(() => sequenceRef(plan, 0)).toThrow();
    expect(() => sequenceRef(plan, plan.sequences.length + 1)).toThrow();
    for (const bad of [{...ref, number: ref.of + 1}, {...ref, lastScene: ref.firstScene - 1}, {...ref, planRevision: "x"}, {...ref, extra: true}])
      expect(() => validateSequenceRef(bad)).toThrow();
  });
});
