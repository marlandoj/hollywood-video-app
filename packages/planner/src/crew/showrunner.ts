import { askCrewModel, CrewAnswerUnusable, crewUnusableReason, type CrewModel, type CrewUnusableReason, type CrewVendor } from "../../../generator/src/crew-model";
import type { CrewAlert, CrewLedger } from "../../../operator/src/crew-ledger";
import type { CrewLedgerReader } from "../../../storage/src/crew-ledger";
import type { ParseResult } from "../../../parser/src/index";
import { checkPrompt } from "../../../safety/src/index";
import { countedSequences, greedySequences, SEQUENCE_LIMIT, SEQUENCE_SHOT_LIMIT, sequencePlan, splitProblem, type FilmSequence, type SequencePlan } from "../sequences";
import type { CrewNote } from "./production-plan";

/**
 * The Showrunner (HV-030-29, Release 3 step 2, G20-202610031349): splits a feature into sequences of
 * at most 24 shots, the per-render limit, so each sequence is made like a short: its own rough cut,
 * its own final, under the feature's one film limit. The look is approved once for the whole feature.
 *
 * Its tool set is one typed proposal: the sequence boundaries, as scene numbers. It may not change the
 * script, the cast or a shot. The studio counts each sequence's shots itself and validates the split
 * exactly as it validates a stored plan (`../sequences.ts`): contiguous, complete, in order, at least
 * one scene and at most 24 shots each. Anything else is unusable and the stand-in's deterministic
 * greedy split is used instead, with `unusableReason` as for every other crew answer (HV-030-25).
 *
 * When the whole feature fits one render there is nothing to decide, so the model isn't asked and
 * nothing is spent.
 */
export const SHOWRUNNER_MAX_TOKENS = 2000;

export interface ShowrunnerResult {
  plan: SequencePlan;
  source: CrewVendor | "stand-in";
  fallbackReason?: "model_unusable" | "model_unavailable" | "content_policy";
  unusableReason?: CrewUnusableReason;
  crewSpend: {usd: number; alerts: CrewAlert[]};
}

export function showrunnerPrompt(parsed: ParseResult, counts: number[]): {system: string; user: string} {
  const system = "You are the Showrunner of an AI film studio. A feature is too long for one render, so it is made as a series of sequences: "
    + "runs of consecutive scenes, each made and approved like a short film. Split the feature into sequences. Every scene belongs to exactly one sequence, "
    + "in script order, and each sequence's shots add up to at most " + SEQUENCE_SHOT_LIMIT + ". Prefer to end a sequence where the story turns "
    + "or the location changes, and use no more sequences than the story needs. Reply with JSON only, exactly: "
    + "{\"sequences\": [{\"firstScene\": number, \"lastScene\": number}]}, with scene numbers as given.";
  const user = "Scenes (number, shots, heading):\n" + parsed.scenes.map((scene, index) => (index + 1) + ". " + counts[index] + " shot" + (counts[index] === 1 ? "" : "s") + ": " + scene.heading).join("\n");
  return {system, user};
}

/** The model's boundaries, read and validated; the shots are the studio's count. */
export function validateShowrunnerSplit(text: string, counts: number[]): FilmSequence[] {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new CrewAnswerUnusable("no JSON", "no_json");
  const value = JSON.parse(text.slice(start, end + 1)) as {sequences?: unknown};
  if (!value || typeof value !== "object" || !Array.isArray(value.sequences) || value.sequences.length > SEQUENCE_LIMIT)
    throw new CrewAnswerUnusable("The Showrunner's answer is not a list of sequences.", "bad_shape");
  const boundaries = value.sequences.map(item => {
    const entry = item as Record<string, unknown>;
    if (!entry || typeof entry !== "object" || Object.keys(entry).some(key => key !== "firstScene" && key !== "lastScene")
      || !Number.isSafeInteger(entry.firstScene) || !Number.isSafeInteger(entry.lastScene))
      throw new CrewAnswerUnusable("The Showrunner named a sequence without its first and last scene.", "bad_shape");
    return {firstScene: entry.firstScene as number, lastScene: entry.lastScene as number};
  });
  const problem = splitProblem(boundaries, counts);
  if (problem) throw new CrewAnswerUnusable("The Showrunner's split is not usable: " + problem + ".", "bad_shape");
  return countedSequences(boundaries, counts);
}

/** The Showrunner's note for the plan step, in the studio's words: never the model's. */
export function showrunnerNote(plan: SequencePlan): CrewNote {
  const listed = plan.sequences.slice(0, 6).map((sequence, index) => (index + 1) + ": scene" + (sequence.firstScene === sequence.lastScene ? " " + sequence.firstScene
    : "s " + sequence.firstScene + "–" + sequence.lastScene) + " (" + sequence.shots + " shot" + (sequence.shots === 1 ? "" : "s") + ")");
  const rest = plan.sequences.length - listed.length;
  const count = plan.sequences.length;
  return {persona: "showrunner", change: "Split the feature into " + count + " sequence" + (count === 1 ? "" : "s") + " of at most " + SEQUENCE_SHOT_LIMIT
    + " shots, each made like a short: " + listed.join("; ") + (rest > 0 ? "; and " + rest + " more" : "")
    + ". You approve the look once; then each sequence gets its own rough cut and final, one after another."};
}

export async function runShowrunner(options: {
  parsed: ParseResult; counts: number[]; scriptVersion: number; projectId: string;
  model: CrewModel | null; ledger: CrewLedger | CrewLedgerReader; now?: () => Date;
}): Promise<ShowrunnerResult> {
  const {parsed, counts, scriptVersion, projectId, model, ledger} = options;
  const now = options.now ?? (() => new Date());
  // Throws SequenceSplitError when a scene can't fit any sequence: nothing is asked or spent then.
  const standIn = () => sequencePlan(scriptVersion, greedySequences(counts));
  const fallback = standIn();
  const whole = counts.reduce((sum, count) => sum + count, 0) <= SEQUENCE_SHOT_LIMIT;
  if (!model || whole) return {plan: fallback, source: "stand-in", crewSpend: {usd: 0, alerts: []}};
  const prompt = showrunnerPrompt(parsed, counts);
  if (!checkPrompt(prompt.user).allowed) return {plan: fallback, source: "stand-in", fallbackReason: "content_policy", crewSpend: {usd: 0, alerts: []}};
  await ledger.assertCanSpend();
  const asked = await askCrewModel(model, {system: prompt.system, messages: [{role: "user", content: prompt.user}], maxTokens: SHOWRUNNER_MAX_TOKENS});
  if (!asked) return {plan: fallback, source: "stand-in", fallbackReason: "model_unavailable", crewSpend: {usd: 0, alerts: []}};
  const {completion} = asked;
  const alerts = await ledger.record({at: now().toISOString(), projectId, persona: "crew-showrunner", model: completion.model,
    inputTokens: completion.usage.inputTokens, outputTokens: completion.usage.outputTokens, usd: completion.costUsd});
  const unusable = (unusableReason: CrewUnusableReason) => ({plan: fallback, source: "stand-in" as const, fallbackReason: "model_unusable" as const, unusableReason,
    crewSpend: {usd: completion.costUsd, alerts}});
  if (!asked.usable) return unusable(asked.reason);
  try {
    return {plan: sequencePlan(scriptVersion, validateShowrunnerSplit(completion.text, counts)), source: model.name as CrewVendor, crewSpend: {usd: completion.costUsd, alerts}};
  } catch (error) { return unusable(crewUnusableReason(error)); }
}
