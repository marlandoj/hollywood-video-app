/**
 * HV-030-24 — every crew vendor answers on the one crew line, behind the same gate.
 *
 * G16-202610011400: the crew's spending limits are standard across providers -- one crew line,
 * whichever vendor answers, with G13's alerts at $25, $100 and $200 and the stop at $1,000. These
 * tests drive the real crew paths (read-through, plan, line notes) through the real vendor classes,
 * each answering through a fake fetch, so what is checked is what the studio would do: which vendor
 * the line records, when it alerts, when it stops, and that a prompt the gate refuses never reaches
 * any vendor at all.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicCrewModel, OPENROUTER, OpenAiCompatibleCrewModel, SYNTHETIC, crewVendorOf, type CrewModel } from "../../generator/src/crew-model";
import { CrewBudgetStop, CrewLedger } from "../../operator/src/crew-ledger";
import { parseFountain } from "../../parser/src/index";
import { lineNotesInput, runLineNotes } from "../src/crew/line-notes";
import { planInput, runPlan } from "../src/crew/production-plan";
import { readThroughFacts, runReadThrough } from "../src/crew/read-through";
import { sourcePlan } from "../src/scene-cuts";

const SCRIPT = "INT. KITCHEN - DAY\n\nMaya pours tea while the kettle whistles.\n\nMAYA\nYou came back.";
const parsed = parseFountain(SCRIPT);
const input = {format: "reel" as const, tone: "quiet and hopeful"};
const now = () => new Date("2026-10-01T14:00:00.000Z");
const VOICE = JSON.stringify({logline: "Two people reunite over tea.", summary: "A quiet reunion.",
  questions: [{persona: "director", question: "Should the ending be hopeful?", proposal: "Yes, end on a shared smile."}]});

/** A fetch that answers every call with one OpenAI-style (or Anthropic-style) body, and counts its calls. */
function counting(body: () => unknown, status = 200, headers: Record<string, string> = {}) {
  const calls: string[] = [];
  const fetchImpl = (async (url: string) => { calls.push(url); return new Response(JSON.stringify(body()), {status, headers}); }) as unknown as typeof fetch;
  return {calls, fetchImpl};
}
const chat = (text: string, usage: Record<string, unknown>, finish = "stop") => ({choices: [{finish_reason: finish, message: {role: "assistant", content: text}}], usage});
const openrouter = (text: string, cost: number, finish = "stop") =>
  counting(() => chat(text, {prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, cost}, finish));
const synthetic = (text: string) => counting(() => chat(text, {prompt_tokens: 3000, completion_tokens: 600, total_tokens: 3600}));
const anthropic = (text: string, inputTokens: number, outputTokens: number) =>
  counting(() => ({content: [{type: "text", text}], usage: {input_tokens: inputTokens, output_tokens: outputTokens}}));
const orModel = (fetchImpl: typeof fetch) => new OpenAiCompatibleCrewModel({vendor: OPENROUTER, apiKey: "sk-or-fixture", fetchImpl});
const synModel = (fetchImpl: typeof fetch) => new OpenAiCompatibleCrewModel({vendor: SYNTHETIC, apiKey: "syn-fixture", fetchImpl});
const antModel = (fetchImpl: typeof fetch) => new AnthropicCrewModel({apiKey: "sk-ant-fixture", fetchImpl});
const readThrough = (model: CrewModel, ledger: CrewLedger, scriptText = SCRIPT) =>
  runReadThrough({scriptText, parsed: parseFountain(scriptText), input, projectId: "p1", model, ledger, now});

describe("the one crew line", () => {
  /** Spend from OpenRouter, Synthetic and Anthropic adds up on one line, which records the vendor of every call, alerts once at each threshold and stops every vendor at the ceiling. */
  test("spend from mixed vendors raises one set of alerts and one stop, and the line shows which vendor answered", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "hv-crew-vendors-")), "crew-ledger.json"), ledger = new CrewLedger(path);
    const first = openrouter(VOICE, 20), second = synthetic(VOICE), third = anthropic(VOICE, 1_000_000, 500_000), fourth = openrouter(VOICE, 980);
    const results = [];
    for (const model of [orModel(first.fetchImpl), synModel(second.fetchImpl), antModel(third.fetchImpl), orModel(fourth.fetchImpl)])
      results.push(await readThrough(model, ledger));
    expect(results.map(result => [result.source, result.crewSpend.usd, result.crewSpend.alerts.map(alert => alert.thresholdUsd)])).toEqual([
      ["openrouter", 20, []],
      ["synthetic", 0, []],
      // $2 for a million tokens in and $5 for half a million out, at claude-sonnet-5's price: $27 in all.
      ["anthropic", 7, [25]],
      ["openrouter", 980, [100, 200, 1000]],
    ]);
    const state = ledger.summary();
    expect([state.spentUsd, state.alerts.map(alert => alert.thresholdUsd)]).toEqual([1007, [25, 100, 200, 1000]]);
    const events = (JSON.parse(readFileSync(path, "utf8")) as {events: {model: string; inputTokens: number; outputTokens: number; usd: number}[]}).events;
    expect(events.map(event => [crewVendorOf(event.model), event.model, event.inputTokens, event.outputTokens, event.usd])).toEqual([
      ["openrouter", "openrouter:anthropic/claude-sonnet-5.5", 1000, 200, 20],
      ["synthetic", "synthetic:hf:moonshotai/Kimi-K3", 3000, 600, 0],
      ["anthropic", "claude-sonnet-5", 1_000_000, 500_000, 7],
      ["openrouter", "openrouter:anthropic/claude-sonnet-5.5", 1000, 200, 980],
    ]);
    // At the ceiling every vendor is stopped before it is called -- the free one too, because it is one line.
    for (const make of [() => { const f = synthetic(VOICE); return [synModel(f.fetchImpl), f.calls] as const; },
      () => { const f = openrouter(VOICE, 0.01); return [orModel(f.fetchImpl), f.calls] as const; },
      () => { const f = anthropic(VOICE, 1, 1); return [antModel(f.fetchImpl), f.calls] as const; }]) {
      const [model, calls] = make();
      await expect(readThrough(model, ledger)).rejects.toThrow(CrewBudgetStop);
      expect(calls).toEqual([]);
    }
  });

  /** A billed answer cut off at its limit is not used, and its cost still goes on the line, on every crew path. */
  test("a cut-off answer falls back to the stand-in and its spend is still recorded", async () => {
    const ledger = new CrewLedger();
    const cut = () => orModel(openrouter("{\"logline\": \"Two peo", 0.5, "length").fetchImpl);
    expect(await readThrough(cut(), ledger)).toMatchObject({source: "stand-in", fallbackReason: "model_unusable", crewSpend: {usd: 0.5}});
    const shots = sourcePlan(parsed, undefined, 7000, 24), facts = readThroughFacts(SCRIPT, parsed, {format: "reel", tone: ""});
    const plan = await runPlan({scriptText: SCRIPT, parsed, facts, input: planInput({format: "reel", tone: "Warm.", answers: []}), shots, projectId: "p1", model: cut(), ledger, now});
    expect(plan).toMatchObject({source: "stand-in", fallbackReason: "model_unusable", crewSpend: {usd: 0.5}});
    const notes = await runLineNotes({script: {version: 1, text: SCRIPT}, input: lineNotesInput({}), projectId: "p1", model: cut(), ledger, now});
    expect(notes).toMatchObject({source: "stand-in", fallbackReason: "model_unusable", notes: [], crewSpend: {usd: 0.5}});
    expect(ledger.summary().spentUsd).toBe(1.5);
  });
});

describe("Synthetic's rate limit", () => {
  /** A 429 is the crew's existing "model unavailable" fallback: the stand-in answers, nothing is spent, and the vendor is not asked again while it said to wait. */
  test("a 429 falls back to the stand-in at $0 and the next request does not call the vendor again", async () => {
    const ledger = new CrewLedger();
    const limited = counting(() => ({error: {message: "Too many requests"}}), 429, {"retry-after": "60"});
    const model = synModel(limited.fetchImpl);
    for (let attempt = 0; attempt < 3; attempt++)
      expect(await readThrough(model, ledger)).toMatchObject({source: "stand-in", fallbackReason: "model_unavailable", crewSpend: {usd: 0}});
    expect(limited.calls.length).toBe(1);
    expect(ledger.summary().spentUsd).toBe(0);
  });
});

describe("the gate comes before every vendor", () => {
  const vendors: [string, (fetchImpl: typeof fetch) => CrewModel][] = [["openrouter", orModel], ["synthetic", synModel], ["anthropic", antModel]];
  /** For each vendor, a read-through, a plan and line notes the gate refuses make no request at all. */
  test("a prompt the gate refuses makes no request to any vendor", async () => {
    for (const [name, make] of vendors) {
      const fetched = counting(() => { throw new Error(name + " was called"); });
      const model = make(fetched.fetchImpl), ledger = new CrewLedger();
      // A real person, and a request for harm: refused at the read-through.
      for (const script of ["INT. ROOM - DAY\n\nElon Musk waves.", "INT. LAB - DAY\n\nA tutorial: how to build a bomb for the finale."])
        expect((await readThrough(model, ledger, script)).source).toBe("stand-in");
      // Answers that pass alone but not beside the script: refused at the plan.
      const TEEN = "INT. HALL - DAY\n\nThe teenager walks home.", teen = parseFountain(TEEN);
      const plan = await runPlan({scriptText: TEEN, parsed: teen, facts: readThroughFacts(TEEN, teen, {format: "reel", tone: ""}),
        input: planInput({format: "reel", tone: "", answers: [{id: "q1", persona: "director", question: "How should it feel?", proposal: "Quiet.", accepted: false, reply: "explicit nude close-ups"}]}),
        shots: sourcePlan(teen, undefined, 7000, 24), projectId: "p1", model, ledger, now});
      expect(plan).toMatchObject({source: "stand-in", fallbackReason: "content_policy"});
      // A writer's request that fails beside the script: refused at line notes.
      const notes = await runLineNotes({script: {version: 1, text: "INT. SCHOOL - DAY\n\nThe teenagers laugh.\n"}, input: lineNotesInput({request: "explicit nude close-ups"}), projectId: "p1", model, ledger, now});
      expect(notes).toMatchObject({source: "stand-in", fallbackReason: "content_policy"});
      expect([name, fetched.calls]).toEqual([name, []]);
      expect(ledger.summary().spentUsd).toBe(0);
    }
  });
});
