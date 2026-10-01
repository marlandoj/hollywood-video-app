/**
 * HV-030-25 — a paid crew answer is not thrown away for one long question, and the studio says why an
 * answer was unusable.
 *
 * The Release 2 exit run on staging (2026-10-01) paid OpenRouter $0.022 for a read-through and then
 * showed the stand-in's voice with `fallbackReason: "model_unusable"` and nothing to say why. These
 * tests hold the read-through to dropping a defective question rather than the answer, keep the
 * safety gate's refusal whole, and check that every crew path returns a fixed reason code.
 */
import { describe, expect, test } from "bun:test";
import { AnthropicCrewModel, CREW_UNUSABLE_REASONS, CrewAnswerUnusable, OPENROUTER, OpenAiCompatibleCrewModel, type CrewModel, type CrewRequest, type CrewUnusableReason } from "../../generator/src/crew-model";
import { CrewLedger } from "../../operator/src/crew-ledger";
import { parseFountain } from "../../parser/src/index";
import { lineNotesInput, runLineNotes } from "../src/crew/line-notes";
import { CREW_PLAN_MAX_TOKENS, planInput, runPlan } from "../src/crew/production-plan";
import { READ_THROUGH_MAX_TOKENS, readThroughFacts, runReadThrough, validateCrewVoice } from "../src/crew/read-through";
import { sourcePlan } from "../src/scene-cuts";

const SCRIPT = "INT. KITCHEN - DAY\n\nMaya pours tea while the kettle whistles.\n\nMAYA\nYou came back.";
const parsed = parseFountain(SCRIPT);
const input = {format: "reel" as const, tone: "quiet and hopeful"};
const now = () => new Date("2026-10-01T22:36:00.000Z");
const ask = (persona: string, question = "Should the ending be hopeful?", proposal = "Yes, end on a shared smile.") => ({persona, question, proposal});
const voice = (questions: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({logline: "Two people reunite over tea.", summary: "A quiet reunion in one kitchen.", questions, ...extra});
const reasonOf = (run: () => unknown) => { try { run(); } catch (error) { return error instanceof CrewAnswerUnusable ? error.reason : "not CrewAnswerUnusable"; } return "usable"; };

/** A model that answers every request with one text, and keeps the requests it was sent. */
function fakeModel(text: string, usd = 0.022): CrewModel & {requests: CrewRequest[]} {
  const model = {name: "openrouter" as const, model: "openrouter:anthropic/claude-sonnet-5.5", requests: [] as CrewRequest[],
    async complete(request: CrewRequest) { model.requests.push(request); return {text, usage: {inputTokens: 1000, outputTokens: 2000}, model: model.model, costUsd: usd}; }};
  return model;
}
/** The real OpenRouter class over a fake fetch answering with one chat completion. */
function openrouter(text: string, finish = "stop") {
  const fetchImpl = (async () => new Response(JSON.stringify({choices: [{finish_reason: finish, message: {role: "assistant", content: text}}],
    usage: {prompt_tokens: 1000, completion_tokens: 2000, cost: 0.022}}))) as unknown as typeof fetch;
  return new OpenAiCompatibleCrewModel({vendor: OPENROUTER, apiKey: "sk-or-fixture", fetchImpl});
}
const readThrough = (model: CrewModel, ledger = new CrewLedger()) => runReadThrough({scriptText: SCRIPT, parsed, input, projectId: "p1", model, ledger, now});

describe("validateCrewVoice drops a defective question, not the answer", () => {
  /** One question over its 300-character limit is left out whole; the others stay, renumbered, and the answer says one was dropped. */
  test("one over-limit question: the answer is kept, that question is dropped, and dropped is 1", () => {
    const read = validateCrewVoice(voice([ask("director"), ask("cinematographer", "Q".repeat(301)), ask("sound", "Music under the dialogue?", "A light score.")]));
    expect(read.questions.map(question => [question.id, question.persona])).toEqual([["q1", "director"], ["q2", "sound"]]);
    expect(read.dropped).toBe(1);
    // Nothing is cut short into the creator's view: every question shown is the model's own, whole.
    expect(read.questions.every(question => question.question.length <= 300 && question.proposal.length <= 400)).toBe(true);
    const longProposal = validateCrewVoice(voice([ask("director", "Hopeful?", "P".repeat(401)), ask("editor")]));
    expect([longProposal.questions.map(question => question.persona), longProposal.dropped]).toEqual([["editor"], 1]);
  });

  /** A crew member the studio doesn't have is dropped; the persona id is read without regard to case or spaces. */
  test("an unknown persona's question is dropped, and \" Director \" is the director", () => {
    const read = validateCrewVoice(voice([ask("gaffer"), ask(" Director "), ask("continuity")]));
    expect([read.questions.map(question => question.persona), read.dropped]).toEqual([["director"], 2]);
  });

  /** Past three questions from one crew member, the first three are kept and the rest dropped. */
  test("a fourth question from one crew member is dropped and the first three are kept", () => {
    const read = validateCrewVoice(voice([1, 2, 3, 4].map(n => ask("director", "Question " + n + "?"))));
    expect([read.questions.map(question => question.question), read.dropped]).toEqual([["Question 1?", "Question 2?", "Question 3?"], 1]);
  });

  /** Safety does not shrink: a refused string anywhere -- even in a question that would be dropped for length -- discards the whole answer. */
  test("text the safety gate refuses makes the whole answer unusable, even in a question that would be dropped", () => {
    expect(reasonOf(() => validateCrewVoice(voice([ask("director")], {logline: "A portrait of Taylor Swift"})))).toBe("gate_refused");
    expect(reasonOf(() => validateCrewVoice(voice([ask("director"), ask("casting", "Should Taylor Swift play Maya?", "Yes.")])))).toBe("gate_refused");
    expect(reasonOf(() => validateCrewVoice(voice([ask("director"), ask("gaffer", "Should Taylor Swift play Maya?" + " ".repeat(10) + "x".repeat(300), "Yes.")])))).toBe("gate_refused");
  });

  /** A refused string anywhere in the parsed answer -- a persona, a bare-string item, a nested array, an extra key or its name -- discards the whole answer. */
  test("the gate reads every string in the answer: a persona, a bare item, a nested array and an extra key", () => {
    const refusedText = "Should Taylor Swift play Maya?";
    expect(reasonOf(() => validateCrewVoice(voice([ask("director"), ask(refusedText)])))).toBe("gate_refused");
    expect(reasonOf(() => validateCrewVoice(voice([ask("director"), refusedText])))).toBe("gate_refused");
    expect(reasonOf(() => validateCrewVoice(voice([ask("director"), {persona: "casting", question: [refusedText], proposal: "Yes."}])))).toBe("gate_refused");
    expect(reasonOf(() => validateCrewVoice(voice([ask("director")], {notes: {aside: [refusedText]}})))).toBe("gate_refused");
    expect(reasonOf(() => validateCrewVoice(voice([{...ask("director"), [refusedText]: true}])))).toBe("gate_refused");
    // The same answers with harmless text in those places keep the director's question and drop the rest.
    expect(validateCrewVoice(voice([ask("director"), "A bare line.", {persona: "casting", question: ["Who?"], proposal: "Yes."}], {notes: {aside: ["fine"]}})))
      .toMatchObject({questions: [{persona: "director"}], dropped: 2});
  });

  /** Questions were asked and none survived: the answer is unusable, for the first question's defect. */
  test("no surviving questions makes the answer unusable, with the defect as the reason", () => {
    expect(reasonOf(() => validateCrewVoice(voice([ask("gaffer"), ask("director", "Q".repeat(301))])))).toBe("unknown_persona");
    expect(reasonOf(() => validateCrewVoice(voice([ask("director", "Q".repeat(301)), ask("gaffer")])))).toBe("too_long");
    expect(reasonOf(() => validateCrewVoice(voice([{persona: "director", question: 7, proposal: "Yes."}])))).toBe("bad_shape");
    // A model that asks nothing is still a usable answer, as the prompt allows.
    expect(validateCrewVoice(voice([]))).toMatchObject({questions: [], dropped: 0});
  });

  /** The logline and summary must be usable, and an answer that isn't JSON of the asked shape says which. */
  test("the logline, summary and shape give their own reasons", () => {
    expect(reasonOf(() => validateCrewVoice(voice([ask("director")], {summary: "S".repeat(1201)})))).toBe("too_long");
    expect(reasonOf(() => validateCrewVoice(voice([ask("director")], {logline: ""})))).toBe("bad_shape");
    expect(reasonOf(() => validateCrewVoice("I'd rather not."))).toBe("no_json");
    expect(reasonOf(() => validateCrewVoice('{"logline": "Two people", "summary": "cut off'))).toBe("no_json");
    expect(reasonOf(() => validateCrewVoice('{"logline": "A", "summary": "B", "questions": [{"persona": "director", "question": "Q?", "proposal": "P."}, {"persona": "edi'))).toBe("no_json");
    expect(reasonOf(() => validateCrewVoice(JSON.stringify({logline: "A", summary: "B", questions: "none"})))).toBe("bad_shape");
  });

  /** A fenced JSON block with prose around it is read: the JSON runs from the first "{" to the last "}". */
  test("markdown fences and prose around the JSON are read", () => {
    const read = validateCrewVoice("Here is the crew's read:\n```json\n" + voice([ask("director")]) + "\n```\nLet me know!");
    expect(read).toMatchObject({logline: "Two people reunite over tea.", dropped: 0, questions: [{id: "q1", persona: "director"}]});
  });
});

describe("every crew path says why a paid answer was unusable", () => {
  /** A read-through with one long question answers live, says how many it dropped, and spends once. */
  test("the read-through keeps a paid answer with one long question, and says one was dropped", async () => {
    const ledger = new CrewLedger();
    const result = await readThrough(fakeModel(voice([ask("director"), ask("casting", "Q".repeat(301))])), ledger);
    expect(result).toMatchObject({source: "openrouter", dropped: 1, questions: [{id: "q1", persona: "director"}], crewSpend: {usd: 0.022}});
    expect(result.fallbackReason).toBeUndefined();
    expect(result.unusableReason).toBeUndefined();
    expect(ledger.summary().spentUsd).toBe(0.022);
  });

  /** An answer cut off at its token limit comes back as `cut_off`, with its cost on the line; the stand-in answers. */
  test("a cut-off answer is reason cut_off, on OpenRouter and on Anthropic", async () => {
    const ledger = new CrewLedger();
    const result = await readThrough(openrouter(voice([ask("director")]).slice(0, 80), "length"), ledger);
    expect(result).toMatchObject({source: "stand-in", fallbackReason: "model_unusable", unusableReason: "cut_off"});
    expect(result.crewSpend.usd).toBeGreaterThan(0);
    expect(ledger.summary().spentUsd).toBe(result.crewSpend.usd);
    const anthropic = new AnthropicCrewModel({apiKey: "sk-ant-fixture", fetchImpl: (async () => new Response(JSON.stringify({
      content: [{type: "text", text: '{"logline": "Two'}], stop_reason: "max_tokens", usage: {input_tokens: 1000, output_tokens: 6000}}))) as unknown as typeof fetch});
    const cut = await readThrough(anthropic);
    expect(cut).toMatchObject({source: "stand-in", unusableReason: "cut_off", crewSpend: {usd: 0.062}});
  });

  /** The other reasons reach the read-through's result as fixed codes, never the model's text. */
  test("the read-through returns the reason from the vendor or from the studio's reading", async () => {
    const cases: [CrewModel, CrewUnusableReason][] = [
      [openrouter("", "stop"), "empty"],
      [openrouter(voice([ask("director")]), "content_filter"), "refused_by_model"],
      [fakeModel("Sorry, no JSON today."), "no_json"],
      [fakeModel(voice([ask("director")], {logline: "A portrait of Taylor Swift"})), "gate_refused"],
      [fakeModel(voice([ask("gaffer")])), "unknown_persona"],
      [fakeModel(voice([ask("director")], {summary: "S".repeat(1201)})), "too_long"],
    ];
    for (const [model, reason] of cases) {
      const result = await readThrough(model);
      expect([result.source, result.fallbackReason, result.unusableReason]).toEqual(["stand-in", "model_unusable", reason]);
      expect(JSON.stringify(result)).not.toContain("Taylor Swift");
    }
    expect([...CREW_UNUSABLE_REASONS]).toEqual(["cut_off", "empty", "refused_by_model", "no_json", "bad_shape", "gate_refused", "too_long", "unknown_persona"]);
  });

  /** The read-through asks for as many output tokens as the plan step, 6000, so the answer its prompt allows fits. */
  test("the read-through's max tokens is the plan step's, 6000", async () => {
    const model = fakeModel(voice([ask("director")]));
    await readThrough(model);
    expect(model.requests.map(request => request.maxTokens)).toEqual([6000]);
    expect(READ_THROUGH_MAX_TOKENS).toBe(CREW_PLAN_MAX_TOKENS);
  });

  /** The plan stays all or nothing, and now says why: a direction over its limit is `too_long`, an unknown shot `bad_shape`. */
  test("the plan step returns its reason and stays all or nothing", async () => {
    const shots = sourcePlan(parsed, undefined, 7000, 24);
    const facts = readThroughFacts(SCRIPT, parsed, input, shots);
    const plan = (text: string) => runPlan({scriptText: SCRIPT, parsed, facts, input: planInput({format: "reel", tone: "quiet", answers: []}), shots, projectId: "p1", model: fakeModel(text), ledger: new CrewLedger(), now});
    const shot = {shotId: shots[0]!.id, size: "wide", angle: "eye-level", movement: "static", keyLight: "Soft window light", timeOfDay: "day", performance: "", soundIntent: "", transitionIntent: ""};
    const good = {lookNote: "Soft.", cast: [{name: "MAYA", appearance: "A woman in her thirties.", ageRange: "30s", wardrobe: "Apron."}], shots: [shot]};
    expect((await plan(JSON.stringify(good))).source).toBe("openrouter");
    expect(await plan(JSON.stringify({...good, shots: [{...shot, keyLight: "L".repeat(241)}]}))).toMatchObject({source: "stand-in", unusableReason: "too_long"});
    expect(await plan(JSON.stringify({...good, shots: [{...shot, shotId: "nope"}]}))).toMatchObject({source: "stand-in", unusableReason: "bad_shape"});
    expect(await plan(JSON.stringify({...good, lookNote: "Lit like a Taylor Swift video."}))).toMatchObject({source: "stand-in", unusableReason: "gate_refused"});
    expect(await plan("{\"lookNote\": \"Soft")).toMatchObject({source: "stand-in", unusableReason: "no_json"});
  });

  /** Line notes keep dropping bad notes one at a time, and an unusable answer says why. */
  test("line notes return their reason", async () => {
    const notes = (model: CrewModel) => runLineNotes({script: {version: 1, text: SCRIPT}, input: lineNotesInput({}), projectId: "p1", model, ledger: new CrewLedger(), now});
    expect(await notes(openrouter("{\"notes\": [", "length"))).toMatchObject({source: "stand-in", fallbackReason: "model_unusable", unusableReason: "cut_off"});
    expect(await notes(fakeModel("No notes."))).toMatchObject({unusableReason: "no_json"});
    expect(await notes(fakeModel("{\"notes\": {}}"))).toMatchObject({unusableReason: "bad_shape"});
    const kept = await notes(fakeModel(JSON.stringify({notes: [{persona: "director", line: 6, before: "You came back.", after: "You came home.", reason: "Warmer."}, {persona: "gaffer", line: 3, before: "x", after: "y", reason: "z"}]})));
    expect(kept).toMatchObject({source: "openrouter", dropped: 1, notes: [{line: 6, after: "You came home."}]});
    expect(kept.unusableReason).toBeUndefined();
  });
});
