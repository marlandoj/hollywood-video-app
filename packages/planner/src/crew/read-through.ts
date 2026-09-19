import { describeProvider } from "../../../generator/src/catalog";
import type { CrewModel } from "../../../generator/src/crew-model";
import type { CrewAlert, CrewLedger } from "../../../operator/src/crew-ledger";
import type { ParseResult } from "../../../parser/src/index";
import { checkPrompt, namesPublicFigure } from "../../../safety/src/index";
import { planShots } from "../index";
import { PERSONAS, PERSONA_IDS, QUESTIONS_PER_PERSONA, type PersonaId } from "./personas";

/**
 * The Producer's read-through (HV-030-01): the crew's first answer to a script.
 *
 * Two kinds of content, kept apart on purpose:
 *  - **facts** the studio computes itself, deterministically: scenes, speaking
 *    characters, planned shots, runtime against the format, a generation estimate,
 *    and the concerns the safety gate raises. The model never states these, so it
 *    cannot misstate them.
 *  - **the crew's voice**, written by the model: a logline, a summary, and up to
 *    three questions per persona, each with a proposed answer the creator can
 *    accept in one click. Every string passes the same prompt gate as any prompt.
 *
 * With no key entered, or when the model's answer is unusable, the stand-in crew
 * writes the voice from the facts, deterministically, and says so.
 */
export type FilmFormat = "reel" | "short";
export const FORMAT_LIMIT_SEC: Readonly<Record<FilmFormat, number>> = Object.freeze({reel: 90, short: 600});
/** The video lane a creator would be quoted for (ADR-0021's first paid provider). */
export const ESTIMATE_VIDEO_SPEC = "fal:kling-v2.5-turbo-pro";
const TEXT_LIMIT = {logline: 200, summary: 1200, question: 300, proposal: 400, tone: 200};

export interface ReadThroughInput { format: FilmFormat; tone: string }
export interface CrewConcern { kind: "public_figure" | "content_policy" | "over_format" | "empty_script"; detail: string }
export interface CrewQuestion { id: string; persona: PersonaId; question: string; proposal: string }
export interface ReadThroughFacts {
  format: FilmFormat; formatLimitSec: number; scenes: number; shots: number; estimatedRuntimeSec: number;
  characters: string[]; estimate: {videoSpec: string; finalVideoUsd: number | null};
  concerns: CrewConcern[];
}
export interface ReadThrough {
  schema: "hv-crew-read-through/1";
  facts: ReadThroughFacts;
  logline: string; summary: string; questions: CrewQuestion[];
  source: "anthropic" | "stand-in";
  /** Why the stand-in wrote the voice, when a live model was configured. */
  fallbackReason?: "model_unusable" | "model_unavailable";
  crewSpend: {usd: number; alerts: CrewAlert[]};
}

export function readThroughInput(value: unknown): ReadThroughInput {
  const input = value as Record<string, unknown>;
  if (!input || typeof input !== "object" || !["reel", "short"].includes(String(input.format)) || typeof input.tone !== "string"
    || input.tone.length > TEXT_LIMIT.tone || Object.keys(input).some(key => key !== "format" && key !== "tone"))
    throw new Error("Choose a reel or a short, and describe the tone in a sentence.");
  return {format: input.format as FilmFormat, tone: input.tone.trim()};
}

function perShotUsd(durationSec: number): number | null {
  const price = describeProvider(ESTIMATE_VIDEO_SPEC, "final", {}).snapshot.price;
  if (price.unit !== "billed-second") return null;
  const durations = price.billedDurationsSec;
  const billed = durations.find(value => value >= durationSec) ?? durations.at(-1)! * Math.ceil(durationSec / durations.at(-1)!);
  return price.usd * billed;
}

export function readThroughFacts(scriptText: string, parsed: ParseResult, input: ReadThroughInput): ReadThroughFacts {
  const shots = parsed.scenes.length ? planShots(parsed) : [];
  const runtime = Math.round(shots.reduce((total, shot) => total + shot.durationSec, 0));
  const characters = [...new Set(parsed.scenes.flatMap(scene => scene.dialogue.map(line => line.character.trim())).filter(Boolean))].slice(0, 24);
  const concerns: CrewConcern[] = [];
  if (!parsed.scenes.length) concerns.push({kind: "empty_script", detail: "The script has no scenes yet. Start each scene with a heading such as INT. KITCHEN - DAY."});
  const verdict = checkPrompt(scriptText);
  if (namesPublicFigure(scriptText)) concerns.push({kind: "public_figure", detail: "The script names a public figure. The studio can't depict public figures; rename the character or cast someone who has given consent."});
  else if (!verdict.allowed) concerns.push({kind: "content_policy", detail: "Part of the script falls outside the studio's content policy (" + verdict.category + "). Those scenes will be refused until they are revised."});
  const limit = FORMAT_LIMIT_SEC[input.format];
  if (runtime > limit) concerns.push({kind: "over_format", detail: "At about " + runtime + " s the script runs past a " + input.format + " (" + limit + " s). The Editor will propose what to trim."});
  let finalVideoUsd: number | null = null;
  try {
    const costs = shots.map(shot => perShotUsd(shot.durationSec));
    finalVideoUsd = costs.every(cost => cost !== null) ? Number(costs.reduce((a, b) => a! + b!, 0)!.toFixed(2)) : null;
  } catch { finalVideoUsd = null; }
  return {format: input.format, formatLimitSec: limit, scenes: parsed.scenes.length, shots: shots.length, estimatedRuntimeSec: runtime,
    characters, estimate: {videoSpec: ESTIMATE_VIDEO_SPEC, finalVideoUsd}, concerns};
}

export function readThroughPrompt(scriptText: string, facts: ReadThroughFacts, input: ReadThroughInput): {system: string; user: string} {
  const crew = PERSONAS.map(persona => "- " + persona.id + " (" + persona.title + "): owns " + persona.department + ". " + persona.brief).join("\n");
  const system = "You are the crew of an AI film studio reading a creator's script for the first time. The creator should not have to fill in settings: "
    + "each crew member asks only what matters and proposes an answer the creator can accept in one click.\n\nCrew:\n" + crew
    + "\n\nRules: never name or depict real public figures; describe people by appearance, not as real persons; keep every question under "
    + TEXT_LIMIT.question + " characters and every proposal under " + TEXT_LIMIT.proposal + ". Ask at most " + QUESTIONS_PER_PERSONA
    + " questions per crew member, and none if the script already answers it. Reply with JSON only, no prose, in exactly this shape: "
    + '{"logline": string, "summary": string, "questions": [{"persona": one of ' + JSON.stringify(PERSONA_IDS) + ', "question": string, "proposal": string}]}';
  const user = "Format: " + input.format + " (up to " + facts.formatLimitSec + " seconds). Tone the creator asked for: " + (input.tone || "not stated")
    + ".\nStudio facts (computed, do not restate differently): " + JSON.stringify({scenes: facts.scenes, shots: facts.shots, estimatedRuntimeSec: facts.estimatedRuntimeSec, characters: facts.characters})
    + "\n\nScript:\n" + scriptText;
  return {system, user};
}

function gateText(value: unknown, limit: number): string {
  if (typeof value !== "string") throw new Error("not text");
  const text = value.trim();
  if (!text || text.length > limit || !checkPrompt(text).allowed) throw new Error("unusable text");
  return text;
}

/** Parses and gates the model's answer; any defect makes the whole answer unusable. */
export function validateCrewVoice(text: string): Pick<ReadThrough, "logline" | "summary" | "questions"> {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON");
  const value = JSON.parse(text.slice(start, end + 1)) as {logline?: unknown; summary?: unknown; questions?: unknown};
  if (!Array.isArray(value.questions) || value.questions.length > PERSONA_IDS.length * QUESTIONS_PER_PERSONA) throw new Error("bad questions");
  const counts = new Map<string, number>();
  const questions = value.questions.map((item, index) => {
    const entry = item as {persona?: unknown; question?: unknown; proposal?: unknown};
    if (!PERSONA_IDS.includes(entry.persona as PersonaId)) throw new Error("unknown persona");
    counts.set(entry.persona as string, (counts.get(entry.persona as string) ?? 0) + 1);
    if (counts.get(entry.persona as string)! > QUESTIONS_PER_PERSONA) throw new Error("too many questions");
    return {id: "q" + (index + 1), persona: entry.persona as PersonaId, question: gateText(entry.question, TEXT_LIMIT.question), proposal: gateText(entry.proposal, TEXT_LIMIT.proposal)};
  });
  return {logline: gateText(value.logline, TEXT_LIMIT.logline), summary: gateText(value.summary, TEXT_LIMIT.summary), questions};
}

/** The stand-in crew: deterministic, from the facts alone. */
export function standInVoice(parsed: ParseResult, facts: ReadThroughFacts, input: ReadThroughInput): Pick<ReadThrough, "logline" | "summary" | "questions"> {
  const first = parsed.scenes[0]?.heading ?? "an untitled scene";
  const people = facts.characters.length ? facts.characters.slice(0, 3).join(", ") : "no speaking characters";
  const tone = input.tone || "the tone the script suggests";
  const logline = ("A " + input.format + " in " + facts.scenes + " scene" + (facts.scenes === 1 ? "" : "s") + ", opening on " + first + ".").slice(0, TEXT_LIMIT.logline);
  const summary = ("About " + facts.estimatedRuntimeSec + " seconds across " + facts.shots + " shots, with " + people + ". Played for " + tone + ".").slice(0, TEXT_LIMIT.summary);
  const raw: [PersonaId, string, string][] = [
    ["director", "What should the audience feel at the final moment?", "Land the ending quietly and hold on the last image for two seconds."],
    ["casting", facts.characters.length ? "Should any of the characters be played by you or by someone who has agreed to appear?" : "Should the film have an on-screen presenter?",
      facts.characters.length ? "Cast original characters for everyone; you can swap in yourself later." : "No presenter; let the images carry it."],
    ["cinematographer", "Which look fits best: naturalistic, stylized, or high-contrast noir?", "Naturalistic: soft daylight, handheld only in the busiest scene."],
    ["sound", "Should music lead or stay under the dialogue?", "A light score under the dialogue, rising only at the end."],
    ["editor", facts.estimatedRuntimeSec > facts.formatLimitSec ? "The script runs long for a " + input.format + ". Trim scenes, or tighten every shot?" : "Brisk cuts, or let scenes breathe?",
      facts.estimatedRuntimeSec > facts.formatLimitSec ? "Tighten every shot first, and cut a scene only if it still runs long." : "Brisk cuts, with one held moment per scene."],
  ];
  return {logline, summary, questions: raw.map(([persona, question, proposal], index) => ({id: "q" + (index + 1), persona, question, proposal}))};
}

export async function runReadThrough(options: {
  scriptText: string; parsed: ParseResult; input: ReadThroughInput; projectId: string;
  model: CrewModel | null; ledger: CrewLedger; now?: () => Date;
}): Promise<ReadThrough> {
  const {scriptText, parsed, input, projectId, model, ledger} = options;
  const now = options.now ?? (() => new Date());
  const facts = readThroughFacts(scriptText, parsed, input);
  const base = {schema: "hv-crew-read-through/1" as const, facts};
  // A script the gate refuses is never sent to the model.
  const sendable = model && parsed.scenes.length && !facts.concerns.some(concern => concern.kind === "public_figure" || concern.kind === "content_policy");
  if (!model || !sendable) return {...base, ...standInVoice(parsed, facts, input), source: "stand-in", crewSpend: {usd: 0, alerts: []}};
  ledger.assertCanSpend();
  const prompt = readThroughPrompt(scriptText, facts, input);
  let completion;
  try { completion = await model.complete({system: prompt.system, messages: [{role: "user", content: prompt.user}], maxTokens: 2000}); }
  catch { return {...base, ...standInVoice(parsed, facts, input), source: "stand-in", fallbackReason: "model_unavailable", crewSpend: {usd: 0, alerts: []}}; }
  const alerts = ledger.record({at: now().toISOString(), projectId, persona: "producer", model: completion.model,
    inputTokens: completion.usage.inputTokens, outputTokens: completion.usage.outputTokens, usd: completion.costUsd});
  try {
    return {...base, ...validateCrewVoice(completion.text), source: "anthropic", crewSpend: {usd: completion.costUsd, alerts}};
  } catch {
    return {...base, ...standInVoice(parsed, facts, input), source: "stand-in", fallbackReason: "model_unusable", crewSpend: {usd: completion.costUsd, alerts}};
  }
}
