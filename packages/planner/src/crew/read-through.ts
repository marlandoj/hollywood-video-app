import { describeProvider, type ProviderPoolEntry } from "../../../generator/src/catalog";
import { askCrewModel, CrewAnswerUnusable, crewUnusableReason, type CrewModel, type CrewUnusableReason, type CrewVendor } from "../../../generator/src/crew-model";
import type { CrewAlert, CrewLedger } from "../../../operator/src/crew-ledger";
import type { CrewLedgerReader } from "../../../storage/src/crew-ledger";
import type { ParseResult } from "../../../parser/src/index";
import { checkPrompt, namesPublicFigure } from "../../../safety/src/index";
import { planShots, type Shot } from "../index";
import { FORMAT_LIMIT_SEC, isFilmFormat, type FilmFormat } from "./formats";
import { billedShotTiming, pacedSeconds } from "./production-plan";
import { PERSONAS, PERSONA_IDS, QUESTIONS_PER_PERSONA, type PersonaId } from "./personas";
import { rememberedAnswer, styleCardInput, styleCardPrompt, styleCardText, type StyleCard } from "./style-card";

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
export { FILM_FORMATS, FORMAT_LIMIT_SEC, isFilmFormat, type FilmFormat } from "./formats";
/**
 * HV-030-28: how many shots the read-through plans when it reads a script for each format. A reel and a
 * short are read as one render's plan (24 shots, the free tier's limit), as before. A feature is read
 * whole, up to 240 shots (G19-202610030430: about 200-240 shots, ten 24-shot sequences), so its quote
 * covers the feature rather than its first render. The plan step and a render still make at most one
 * render's shots: splitting a feature into sequences is the Showrunner's (Release 3 step 2).
 */
export const READ_THROUGH_SHOT_LIMIT: Readonly<Record<FilmFormat, number>> = Object.freeze({reel: 24, short: 24, feature: 240});
/**
 * The video lane a creator is quoted for when the active final profile has no lane priced by the billed
 * second -- the mock profile (ADR-0021's first paid provider). With a live profile, the read-through
 * quotes that profile's own lead lane (HV-030-28).
 */
export const ESTIMATE_VIDEO_SPEC = "fal:kling-v2.5-turbo-pro";
const TEXT_LIMIT = {logline: 200, summary: 1200, question: 300, proposal: 400, tone: 200};
/**
 * HV-030-25: the read-through's output budget, the plan step's. At 2000 the answer the prompt allows
 * -- a 200-character logline, a 1200-character summary and eighteen questions (six crew members, three
 * each) of up to 300 characters with 400-character proposals, about 14,000-15,000 characters of JSON
 * -- could not fit, and a vendor that counts reasoning tokens against `max_tokens` (OpenRouter can)
 * leaves less still. It caps a call's output at 6000 tokens (about $0.30 at the dearest priced model);
 * the crew line's admission is unchanged.
 */
export const READ_THROUGH_MAX_TOKENS = 6000;

/** HV-030-19: `styleCard` is present only when the creator attached one to this pitch (`./style-card.ts`). */
export interface ReadThroughInput { format: FilmFormat; tone: string; styleCard?: StyleCard }
export interface CrewConcern { kind: "public_figure" | "content_policy" | "over_format" | "empty_script"; detail: string }
export interface CrewQuestion { id: string; persona: PersonaId; question: string; proposal: string }
export interface ReadThroughFacts {
  format: FilmFormat; formatLimitSec: number; scenes: number; shots: number; estimatedRuntimeSec: number;
  /** HV-030-28: `basis` is "profile" when the quote is the active final profile's lead lane, "reference" when it has none (mock). */
  characters: string[]; estimate: {videoSpec: string; basis: "profile" | "reference"; finalVideoUsd: number | null};
  concerns: CrewConcern[];
}
export interface ReadThrough {
  schema: "hv-crew-read-through/1";
  facts: ReadThroughFacts;
  logline: string; summary: string; questions: CrewQuestion[];
  /** The vendor that answered (HV-030-24), or the stand-in. */
  source: CrewVendor | "stand-in";
  /** Why the stand-in wrote the voice, when a live model was configured. */
  fallbackReason?: "model_unusable" | "model_unavailable";
  /** HV-030-25: with `model_unusable`, what was wrong with the paid answer: a fixed code, never its text. */
  unusableReason?: CrewUnusableReason;
  /** HV-030-25: on a model's answer, how many of its questions were left out (too long, an unknown crew member, past three each). Never their text. */
  dropped?: number;
  crewSpend: {usd: number; alerts: CrewAlert[]};
  /** HV-030-19: the crew read the style card the creator attached. Absent when none was. */
  readStyleCard?: true;
}

export function readThroughInput(value: unknown): ReadThroughInput {
  const input = value as Record<string, unknown>;
  if (!input || typeof input !== "object" || !isFilmFormat(input.format) || typeof input.tone !== "string"
    || input.tone.length > TEXT_LIMIT.tone || Object.keys(input).some(key => key !== "format" && key !== "tone" && key !== "styleCard"))
    throw new Error("Choose a reel, a short or a feature, and describe the tone in a sentence.");
  // HV-030-17: the tone goes into the crew model's prompt, so it passes the gate the plan route's
  // `planInput` puts it through, before anything is sent or spent.
  const tone = input.tone.trim();
  if (Array.from(input.tone).some(character => {const code = character.charCodeAt(0); return code === 127 || (code < 32 && ![9, 10, 13].includes(code));}) || (tone && !checkPrompt(tone).allowed))
    throw new Error("The crew can't read with this tone: it names a real person or falls outside the content policy. Describe the tone in your own words -- nothing was sent to the crew.");
  // HV-030-19: a style card is creator text too; `styleCardInput` refuses it whole, before anything is sent.
  if (input.styleCard === undefined || input.styleCard === null) return {format: input.format as FilmFormat, tone};
  const styleCard = styleCardInput(input.styleCard);
  // The tone and the card go to the model together, so they are gated together.
  if (tone && !checkPrompt(tone + "\n" + styleCardText(styleCard)).allowed)
    throw new Error("The crew can't read this tone with this style card: together they fall outside the content policy. Change the tone or leave the card off -- nothing was sent to the crew.");
  return {format: input.format as FilmFormat, tone, styleCard};
}

/**
 * HV-030-28: the final lane the read-through quotes. Until HV-030-28 every quote priced Kling 2.5
 * (`ESTIMATE_VIDEO_SPEC`, $0.35 a 5 s clip) whatever the operator's profile was, so on the
 * look-matched profile (`live-film-anchored`, Kling O3 keyframes at $0.084 a billed second, $0.42 a
 * 5 s clip) it understated a film by a fifth. It now quotes the active final profile's lead lane: the
 * first entry of the configured final pool that is priced by the billed second and not retired -- the
 * lane the `configured` routing strategy tries first. A profile with no such lane (mock) is quoted at
 * the reference lane, as before, and `basis` says which.
 */
export function quotedLane(finalPool?: readonly ProviderPoolEntry[] | null): {lane: ProviderPoolEntry; basis: "profile" | "reference"} {
  const lead = (finalPool ?? []).find(entry => entry.snapshot.price.unit === "billed-second" && entry.snapshot.price.billedDurationsSec.length > 0
    && entry.snapshot.lifecycle !== "retired");
  return lead ? {lane: lead, basis: "profile"} : {lane: describeProvider(ESTIMATE_VIDEO_SPEC, "final", {}), basis: "reference"};
}

function perShotUsd(lane: ProviderPoolEntry, durationSec: number): number | null {
  const price = lane.snapshot.price;
  if (price.unit !== "billed-second") return null;
  const durations = [...price.billedDurationsSec].sort((a, b) => a - b);
  const billed = durations.find(value => value >= durationSec) ?? durations.at(-1)! * Math.ceil(durationSec / durations.at(-1)!);
  return price.usd * billed;
}

/**
 * HV-030-15: `shots` is the plan the studio will make -- the routes pass `sourcePlan(parsed, direction,
 * seed, maxShots)`, the same call the plan step and a render use. Computed here from `planShots(parsed)`
 * it had no shot limit and ignored accepted scene cuts: a four-scene script of forty action paragraphs
 * was read as 40 shots, 80 s and a $14 quote, and "over_format", while the plan and the render made 24
 * shots and 48 s -- and the plan prompt told the model "shots: 40 (computed, do not restate
 * differently)" beside a list of 24 shot ids. Without `shots` it reads the script as before.
 */
export function readThroughFacts(scriptText: string, parsed: ParseResult, input: ReadThroughInput, planned?: Shot[], finalPool?: readonly ProviderPoolEntry[] | null): ReadThroughFacts {
  const shots = planned ?? (parsed.scenes.length ? planShots(parsed) : []);
  const runtime = Math.round(shots.reduce((total, shot) => total + shot.durationSec, 0));
  const characters = [...new Set(parsed.scenes.flatMap(scene => scene.dialogue.map(line => line.character.trim())).filter(Boolean))].slice(0, 24);
  const concerns: CrewConcern[] = [];
  if (!parsed.scenes.length) concerns.push({kind: "empty_script", detail: "The script has no scenes yet. Start each scene with a heading such as INT. KITCHEN - DAY."});
  const verdict = checkPrompt(scriptText);
  if (namesPublicFigure(scriptText)) concerns.push({kind: "public_figure", detail: "The script names a public figure. The studio can't depict public figures; rename the character or cast someone who has given consent."});
  else if (!verdict.allowed) concerns.push({kind: "content_policy", detail: "Part of the script falls outside the studio's content policy (" + verdict.category + "). Those scenes will be refused until they are revised."});
  const limit = FORMAT_LIMIT_SEC[input.format];
  if (runtime > limit) concerns.push({kind: "over_format", detail: "At about " + runtime + " s the script runs past a " + input.format + " (" + limit + " s). The Editor will propose what to trim."});
  let finalVideoUsd: number | null = null, videoSpec = ESTIMATE_VIDEO_SPEC, basis: "profile" | "reference" = "reference";
  try {
    const quoted = quotedLane(finalPool);
    videoSpec = quoted.lane.spec; basis = quoted.basis;
    // HV-030-28: each shot is priced at the clip the Editor will pace it to on this profile (HV-017-05,
    // `crewChanges`): at least the pool's billed floor, longer for its lines. On the anchored profile
    // that is 5 s, so $0.42 a shot. With no profile lane (mock) shots are priced as planned, as before.
    const timing = basis === "profile" ? billedShotTiming(finalPool!) : null;
    const costs = shots.map(shot => perShotUsd(quoted.lane, timing && shot.cutDurationFrames == null ? pacedSeconds(timing, shot) ?? shot.durationSec : shot.durationSec));
    finalVideoUsd = costs.every(cost => cost !== null) ? Number(costs.reduce((a, b) => a! + b!, 0)!.toFixed(2)) : null;
  } catch { finalVideoUsd = null; }
  return {format: input.format, formatLimitSec: limit, scenes: parsed.scenes.length, shots: shots.length, estimatedRuntimeSec: runtime,
    characters, estimate: {videoSpec, basis, finalVideoUsd}, concerns};
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
    + (input.styleCard ? "\n" + styleCardPrompt(input.styleCard) : "")
    + "\n\nScript:\n" + scriptText;
  return {system, user};
}

/** The voice the studio read from a model's answer, and how many of its questions it left out. */
export type CrewVoice = Pick<ReadThrough, "logline" | "summary" | "questions"> & {dropped: number};

const unusable = (reason: CrewUnusableReason) => new CrewAnswerUnusable(reason.replace(/_/g, " "), reason);
/** A string the gate refuses. Anything else -- not text, or empty -- is the shape check's to judge. */
const refused = (value: unknown) => typeof value === "string" && value.trim() !== "" && !checkPrompt(value.trim()).allowed;
/**
 * Whether the gate refuses any string anywhere in the parsed answer: every value and every key, at any
 * depth, in the fields the studio reads and in any it ignores. Walked without recursion, so a deeply
 * nested answer can't overflow the stack.
 */
function anyRefused(root: unknown): boolean {
  const pending: unknown[] = [root];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string") { if (refused(value)) return true; }
    else if (Array.isArray(value)) pending.push(...value);
    else if (value && typeof value === "object") for (const [key, entry] of Object.entries(value)) { if (refused(key)) return true; pending.push(entry); }
  }
  return false;
}
/** One field of the voice: its text, or what is wrong with it. */
function voiceText(value: unknown, limit: number): {text: string} | {defect: CrewUnusableReason} {
  if (typeof value !== "string" || !value.trim()) return {defect: "bad_shape"};
  return value.trim().length > limit ? {defect: "too_long"} : {text: value.trim()};
}

/**
 * Parses and gates the model's answer (HV-030-25: per question, not all or nothing).
 *
 * - **Safety does not shrink.** Every string in the parsed answer passes the gate first: every value
 *   and key at any depth, persona ids, extra keys and the questions that will be left out included.
 *   If the gate refuses any of it, the whole answer is unusable (`gate_refused`) and the stand-in
 *   answers, as before.
 * - **The logline and summary must be usable**: text, not empty, within their limits.
 * - **A defective question is left out, not the answer.** A question or proposal that isn't text or
 *   is over its limit, an unknown crew member, or a question past a crew member's third is dropped,
 *   whole: nothing is cut short into the creator's view. The rest keep their order and are numbered
 *   q1, q2, ... `dropped` says how many were left out.
 * - **If questions were asked and none survives**, the answer is unusable, for the first one's defect.
 *   A model that asks no questions at all is still a usable answer, as the prompt allows.
 *
 * Crew member ids are read without regard to case or surrounding spaces ("Director" is the director).
 * The JSON is read from the first "{" to the last "}", so a fenced block or prose around it is fine.
 */
export function validateCrewVoice(text: string): CrewVoice {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw unusable("no_json");
  let value: {logline?: unknown; summary?: unknown; questions?: unknown};
  try { value = JSON.parse(text.slice(start, end + 1)); } catch { throw unusable("no_json"); }
  // The gate reads every string the model wrote, wherever it is, before anything is dropped or its shape judged.
  if (anyRefused(value)) throw unusable("gate_refused");
  if (!value || typeof value !== "object" || !Array.isArray(value.questions)) throw unusable("bad_shape");
  const items = (value.questions as unknown[]).map(item => (item && typeof item === "object" ? item : {}) as {persona?: unknown; question?: unknown; proposal?: unknown});
  const logline = voiceText(value.logline, TEXT_LIMIT.logline), summary = voiceText(value.summary, TEXT_LIMIT.summary);
  if ("defect" in logline) throw unusable(logline.defect);
  if ("defect" in summary) throw unusable(summary.defect);
  const counts = new Map<PersonaId, number>(), questions: CrewQuestion[] = [], defects: CrewUnusableReason[] = [];
  for (const item of items) {
    const persona = (typeof item.persona === "string" ? item.persona.trim().toLowerCase() : "") as PersonaId;
    const question = voiceText(item.question, TEXT_LIMIT.question), proposal = voiceText(item.proposal, TEXT_LIMIT.proposal);
    if (!PERSONA_IDS.includes(persona)) { defects.push("unknown_persona"); continue; }
    if ("defect" in question) { defects.push(question.defect); continue; }
    if ("defect" in proposal) { defects.push(proposal.defect); continue; }
    // A question past the crew member's third is dropped as `bad_shape`; it is never the reason an
    // answer is unusable, because the three before it were kept.
    if ((counts.get(persona) ?? 0) >= QUESTIONS_PER_PERSONA) { defects.push("bad_shape"); continue; }
    counts.set(persona, (counts.get(persona) ?? 0) + 1);
    questions.push({id: "q" + (questions.length + 1), persona, question: question.text, proposal: proposal.text});
  }
  if (items.length && !questions.length) throw unusable(defects[0]!);
  return {logline: logline.text, summary: summary.text, questions, dropped: defects.length};
}

/** The stand-in crew: deterministic, from the facts and the creator's own style card alone. */
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
  // HV-030-19: with a style card attached, each crew member proposes what the creator settled on last
  // time, in their own words, and the summary says how many did. Deterministic, like the rest.
  const card = input.styleCard;
  const mine = raw.map(([persona]) => card ? rememberedAnswer(card, persona) : null);
  const questions = raw.map(([persona, question, proposal], index) => ({id: "q" + (index + 1), persona, question, proposal: mine[index] ?? proposal}));
  const remembered = mine.filter(Boolean).length;
  const read = card ? " The crew read your style card: " + (remembered ? remembered + " of these proposals follow" + (remembered === 1 ? "s" : "") + " what you chose before." : "none of its choices fit these questions.") : "";
  return {logline, summary: (summary + read).slice(0, TEXT_LIMIT.summary), questions};
}

export async function runReadThrough(options: {
  scriptText: string; parsed: ParseResult; input: ReadThroughInput; projectId: string;
  model: CrewModel | null; ledger: CrewLedger | CrewLedgerReader; now?: () => Date; shots?: Shot[];
  /** HV-030-28: the configured final pool, whose lead lane the estimate quotes. */
  finalPool?: readonly ProviderPoolEntry[] | null;
}): Promise<ReadThrough> {
  const {scriptText, parsed, input, projectId, model, ledger} = options;
  const now = options.now ?? (() => new Date());
  const facts = readThroughFacts(scriptText, parsed, input, options.shots, options.finalPool);
  // HV-030-19: the gate reads the request the model would be sent -- the script with the tone and the
  // card beside it -- because its paired rules (FR-054) hold across the whole of it. A script that
  // passes alone, read with words the creator attached that also pass alone, can still be refused.
  // It is then a content-policy concern, which keeps the creator at the pitch, and nothing is sent.
  if (parsed.scenes.length && !facts.concerns.some(concern => concern.kind === "public_figure" || concern.kind === "content_policy")) {
    const verdict = checkPrompt(readThroughPrompt(scriptText, facts, input).user);
    if (!verdict.allowed) facts.concerns.push({kind: "content_policy", detail: "Read with the tone" + (input.styleCard ? " and the style card" : "")
      + " you gave, the script falls outside the studio's content policy (" + verdict.category + "). Change the tone" + (input.styleCard ? " or leave the card off" : "") + "."});
  }
  const base = {schema: "hv-crew-read-through/1" as const, facts, ...(input.styleCard ? {readStyleCard: true as const} : {})};
  // A script the gate refuses is never sent to the model.
  const sendable = model && parsed.scenes.length && !facts.concerns.some(concern => concern.kind === "public_figure" || concern.kind === "content_policy");
  if (!model || !sendable) return {...base, ...standInVoice(parsed, facts, input), source: "stand-in", crewSpend: {usd: 0, alerts: []}};
  await ledger.assertCanSpend();
  const prompt = readThroughPrompt(scriptText, facts, input);
  const asked = await askCrewModel(model, {system: prompt.system, messages: [{role: "user", content: prompt.user}], maxTokens: READ_THROUGH_MAX_TOKENS});
  if (!asked) return {...base, ...standInVoice(parsed, facts, input), source: "stand-in", fallbackReason: "model_unavailable", crewSpend: {usd: 0, alerts: []}};
  const {completion} = asked;
  const alerts = await ledger.record({at: now().toISOString(), projectId, persona: "producer", model: completion.model,
    inputTokens: completion.usage.inputTokens, outputTokens: completion.usage.outputTokens, usd: completion.costUsd});
  const fallback = (unusableReason: CrewUnusableReason): ReadThrough => ({...base, ...standInVoice(parsed, facts, input), source: "stand-in",
    fallbackReason: "model_unusable", unusableReason, crewSpend: {usd: completion.costUsd, alerts}});
  if (!asked.usable) return fallback(asked.reason);
  try {
    return {...base, ...validateCrewVoice(completion.text), source: model.name, crewSpend: {usd: completion.costUsd, alerts}};
  } catch (error) { return fallback(crewUnusableReason(error)); }
}
