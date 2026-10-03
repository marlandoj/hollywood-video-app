import type { CapabilitySnapshot } from "../../../generator/src/capabilities";
import { askCrewModel, CrewAnswerUnusable, crewUnusableReason, type CrewModel, type CrewUnusableReason, type CrewVendor } from "../../../generator/src/crew-model";
import type { CrewAlert, CrewLedger } from "../../../operator/src/crew-ledger";
import type { CrewLedgerReader } from "../../../storage/src/crew-ledger";
import type { ParseResult } from "../../../parser/src/index";
import { checkPrompt } from "../../../safety/src/index";
import { namesPublicFigure } from "../../../safety/src/public-figures";
import { characterRecord, type CastingSnapshot } from "../casting";
import { continuityHeadingTime } from "../continuity";
import { DEFAULT_DIRECTION, DIRECTION_CHOICES, DIRECTION_TEXT_LIMITS, directionSettings, type DirectionSnapshot } from "../direction";
import { DEFAULT_VOICE } from "../performances";
import type { Shot } from "../index";
import { introductionAppearance, scriptIntroductions, UNSTATED_AGE } from "./introductions";
import { PERSONA_IDS, type CrewMemberId, type PersonaId } from "./personas";
import { isFilmFormat, type FilmFormat } from "./formats";
import type { ReadThroughFacts } from "./read-through";

/**
 * The crew's production plan (HV-030-02): the creator's answers turned into the
 * studio's own settings, through the same validators a creator's edit meets.
 *
 * - Casting proposes an original character for each speaking role that has no cast
 *   record yet, with its permission left pending: the creator attests at the look
 *   approval, never the crew.
 * - The Director, Cinematographer, Composer/Sound and Editor propose each shot's
 *   direction (size, angle, movement, light, performance, sound and transition
 *   intent) for shots the creator has not directed.
 * - Nothing the creator set is overwritten. Nothing is rendered or spent on
 *   generation; that happens only at an approval.
 */
export interface CrewAnswer { id: string; persona: PersonaId; question: string; proposal: string; accepted: boolean; reply: string }
export interface PlanInput { format: FilmFormat; tone: string; answers: CrewAnswer[] }
export interface CastProposal { name: string; appearance: string; ageRange: string; wardrobe: string }
export interface ShotProposal {
  shotId: string; size: string; angle: string; movement: string;
  keyLight: string; timeOfDay: string; performance: string; soundIntent: string; transitionIntent: string;
}
export interface CrewPlan { schema: "hv-crew-plan/1"; lookNote: string; cast: CastProposal[]; shots: ShotProposal[] }
/**
 * HV-021-09: `source: "continuity-report"` marks the Continuity Supervisor's notes, which are written
 * from the studio's continuity report and never by a model. Every other note is absent `source`.
 */
export interface CrewNote { persona: CrewMemberId; change: string; source?: "continuity-report" }
export interface CrewChanges {
  characters: {id: string; input: unknown}[];
  directions: {shotId: string; input: unknown}[];
  notes: CrewNote[];
}

/**
 * HV-030-12: the shot fields are the direction's own limits, not a second guess at them.
 *
 * This table used to give every shot field `intent: 300`. `directionSettings`, which `crewChanges`
 * runs on the same values after the model has been paid, allows `keyLight` and `transitionIntent`
 * 240. A plan with a 241–300-character light or transition passed this gate as the model's own,
 * was recorded against the crew's budget, and then threw from `crewChanges` -- a 400 at "Plan the
 * film" about a field the creator never saw, paid for again on every retry. docs/CREW.md says a
 * plan this file cannot use falls back to the stand-in plan; now it does, because the refusal
 * happens here.
 */
const LIMIT = {answer: 400, question: 300, lookNote: 400, name: 80, appearance: 600, ageRange: 80, wardrobe: 400};
const PLAN_KEYS = ["size", "angle", "movement"] as const;
/** The plan step's output budget; the read-through's is the same (HV-030-25, `READ_THROUGH_MAX_TOKENS`). */
export const CREW_PLAN_MAX_TOKENS = 6000;

/**
 * HV-030-13: the characters the direction and cast validators refuse, refused here too. A plan whose
 * light read "Soft\fwindow light" or whose wardrobe read "Blue\fapron" passed this gate, was paid for,
 * and then threw from `crewChanges` ("keyLight must be text of at most 240 characters") -- the same
 * paid-then-refused failure HV-030-12 closed for length, with a reason about length that was false.
 * C0 controls other than tab, line feed and carriage return, and DEL, as `characterRecord` refuses.
 */
const unusableCharacter = (text: string) => Array.from(text).some(character => {const code = character.charCodeAt(0); return code === 127 || (code < 32 && ![9, 10, 13].includes(code));});

/** HV-030-25: each refusal carries its reason (`too_long`, `gate_refused` or `bad_shape`); the message is unchanged. */
export function gated(value: unknown, limit: number, name: string, allowEmpty = true): string {
  const refuse = (reason: CrewUnusableReason) => new CrewAnswerUnusable("The crew's " + name + " is not usable.", reason);
  if (typeof value !== "string" || unusableCharacter(value)) throw refuse("bad_shape");
  if (value.length > limit) throw refuse("too_long");
  const text = value.trim();
  if (!allowEmpty && !text) throw refuse("bad_shape");
  if (text && !checkPrompt(text).allowed) throw refuse("gate_refused");
  return text;
}

export function planInput(value: unknown): PlanInput {
  const input = value as Record<string, unknown>;
  if (!input || typeof input !== "object" || !isFilmFormat(input.format) || typeof input.tone !== "string"
    || !Array.isArray(input.answers) || input.answers.length > PERSONA_IDS.length * 3)
    throw new Error("Send the format, the tone and your answers to the crew's questions.");
  const answers = input.answers.map(item => {
    const answer = item as Record<string, unknown>;
    if (!answer || typeof answer.id !== "string" || !/^q[0-9]{1,2}$/.test(answer.id) || !PERSONA_IDS.includes(answer.persona as PersonaId) || typeof answer.accepted !== "boolean")
      throw new Error("Each answer names its question, its crew member and whether the proposal was accepted.");
    return {id: answer.id, persona: answer.persona as PersonaId, accepted: answer.accepted,
      question: gated(answer.question, LIMIT.question, "question", false), proposal: gated(answer.proposal, LIMIT.answer, "proposal"),
      reply: answer.accepted ? "" : gated(answer.reply ?? "", LIMIT.answer, "reply")};
  });
  if (new Set(answers.map(answer => answer.id)).size !== answers.length) throw new Error("Answer each question once.");
  const tone = gated(input.tone, 200, "tone");
  // HV-030-21: each string passes the gate alone, but the gate's paired rules are about the request
  // as a whole -- a tone and a reply can each pass and together describe what neither may.
  if (!checkPrompt([tone, ...answers.flatMap(answer => [answer.question, answer.proposal, answer.reply])].filter(Boolean).join("\n")).allowed)
    throw new Error("The crew can't plan with these answers together: taken as a whole they fall outside the content policy. Reword your answers -- nothing was sent to the crew.");
  return {format: input.format as FilmFormat, tone, answers};
}

export function planPrompt(scriptText: string, facts: ReadThroughFacts, input: PlanInput, shots: Shot[]): {system: string; user: string} {
  const system = "You are the crew of an AI film studio turning a creator's answers into a production plan. "
    + "Casting proposes an original fictional look for each speaking character (never a real or famous person). "
    + "Director, Cinematographer, Composer/Sound and Editor propose each shot's direction. Describe people by appearance only. "
    + "Reply with JSON only, exactly: {\"lookNote\": string, \"cast\": [{\"name\": string, \"appearance\": string, \"ageRange\": string, \"wardrobe\": string}], "
    + "\"shots\": [{\"shotId\": string, \"size\": one of " + JSON.stringify(DIRECTION_CHOICES.size) + ", \"angle\": one of " + JSON.stringify(DIRECTION_CHOICES.angle)
    + ", \"movement\": one of " + JSON.stringify(DIRECTION_CHOICES.movement) + ", \"keyLight\": string, \"timeOfDay\": string, \"performance\": string, \"soundIntent\": string, \"transitionIntent\": string}]}. "
    + "Use exactly the character names and shot ids given.";
  const answers = input.answers.map(answer => "- " + answer.persona + " asked: " + answer.question + " Creator: "
    + (answer.accepted ? "accepted the proposal: " + answer.proposal : answer.reply ? answer.reply : "declined the proposal: " + answer.proposal)).join("\n");
  const user = "Format: " + input.format + ". Tone: " + (input.tone || "not stated") + ".\nCharacters: " + JSON.stringify(facts.characters)
    + "\nCreator's answers:\n" + (answers || "(none)") + "\nShots: " + JSON.stringify(shots.map(shot => ({shotId: shot.id, scene: shot.sceneIndex + 1, action: shot.prompt})))
    + "\n\nScript:\n" + scriptText;
  return {system, user};
}

function shotProposal(value: unknown, shotIds: Set<string>): ShotProposal {
  const shot = value as Record<string, unknown>;
  if (!shot || typeof shot.shotId !== "string" || !shotIds.has(shot.shotId)) throw new Error("The crew named a shot that is not in the plan.");
  for (const key of PLAN_KEYS) if (!(DIRECTION_CHOICES[key] as readonly string[]).includes(String(shot[key]))) throw new Error("The crew chose an unknown " + key + ".");
  return {shotId: shot.shotId, size: String(shot.size), angle: String(shot.angle), movement: String(shot.movement),
    keyLight: gated(shot.keyLight ?? "", DIRECTION_TEXT_LIMITS.keyLight, "light"), timeOfDay: gated(shot.timeOfDay ?? "", DIRECTION_TEXT_LIMITS.timeOfDay, "time of day"),
    performance: gated(shot.performance ?? "", DIRECTION_TEXT_LIMITS.performance, "performance"), soundIntent: gated(shot.soundIntent ?? "", DIRECTION_TEXT_LIMITS.soundIntent, "sound intent"),
    transitionIntent: gated(shot.transitionIntent ?? "", DIRECTION_TEXT_LIMITS.transitionIntent, "transition")};
}

/**
 * Parses and gates the model's plan; the shots and names must be the studio's own.
 *
 * HV-030-25: still all or nothing, unlike the read-through's questions. A plan is applied as the
 * film's cast and direction: a dropped cast entry would leave a speaking character with no look, and
 * a dropped shot would be undirected, under a plan credited to the model. The stand-in's plan is
 * whole. Each refusal now says why (`crewUnusableReason`): a JSON parse error is `no_json`, an
 * unknown shot, choice or character `bad_shape`.
 */
export function validateCrewPlan(text: string, facts: ReadThroughFacts, shots: Shot[]): CrewPlan {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new CrewAnswerUnusable("no JSON", "no_json");
  const value = JSON.parse(text.slice(start, end + 1)) as {lookNote?: unknown; cast?: unknown; shots?: unknown};
  if (!Array.isArray(value.cast) || !Array.isArray(value.shots) || value.cast.length > 24 || value.shots.length > shots.length) throw new Error("bad plan");
  const names = new Set(facts.characters.map(name => name.toLocaleUpperCase("en-US")));
  const cast = value.cast.map(item => {
    const entry = item as Record<string, unknown>;
    const name = gated(entry?.name, LIMIT.name, "character name", false);
    if (!names.has(name.toLocaleUpperCase("en-US"))) throw new Error("The crew cast a character who is not in the script.");
    return {name, appearance: gated(entry.appearance, LIMIT.appearance, "appearance"), ageRange: gated(entry.ageRange ?? "", LIMIT.ageRange, "age range"),
      wardrobe: gated(entry.wardrobe ?? "", LIMIT.wardrobe, "wardrobe")};
  });
  if (new Set(cast.map(entry => entry.name.toLocaleUpperCase("en-US"))).size !== cast.length) throw new Error("A character was cast twice.");
  const shotIds = new Set(shots.map(shot => shot.id));
  const planned = value.shots.map(item => shotProposal(item, shotIds));
  if (new Set(planned.map(shot => shot.shotId)).size !== planned.length) throw new Error("A shot was planned twice.");
  // HV-030-14: the model's words are gated beside the action they will be rendered with, as the
  // stand-in's already are (`standInCast`: "the cast can never be what turns a scene into a
  // refusal"). Gated alone, "A councillor who can incite a room with a look." passed here and in
  // `crewChanges`, and then every shot of a scene that is "close to violence" was refused at render
  // as incitement -- a plan paid for that could not be made. Such a plan falls back to the stand-in.
  const passes = (text: string) => checkPrompt(text).allowed;
  const action = shots.map(shot => shot.prompt).join(" ");
  if (passes(action)) for (const entry of cast)
    if (!passes(action + " " + entry.appearance + " Age range: " + entry.ageRange + ". Wardrobe: " + entry.wardrobe + "."))
      throw new CrewAnswerUnusable("The crew's cast for " + entry.name + " is not usable beside the script.", "gate_refused");
  for (const shot of planned) {
    const prompt = shots.find(value => value.id === shot.shotId)!.prompt;
    if (passes(prompt) && !passes([prompt, shot.keyLight, shot.timeOfDay, shot.performance, shot.soundIntent, shot.transitionIntent].join(" ")))
      throw new CrewAnswerUnusable("The crew's direction for " + shot.shotId + " is not usable beside the script.", "gate_refused");
  }
  return {schema: "hv-crew-plan/1", lookNote: gated(value.lookNote ?? "", LIMIT.lookNote, "look"), cast, shots: planned};
}

/**
 * HV-017-05: the stand-in casts from the script's own introductions. The text must pass the
 * content gate by itself and beside the script's action (so the cast can never be what turns a
 * scene into a refusal), and must not name a public figure; otherwise it falls back to the plain
 * lead ("An older woman."), then to the old placeholder with no age.
 */
export function standInCast(parsed: ParseResult, names: string[]): CastProposal[] {
  const action = parsed.scenes.flatMap(scene => scene.action).join(" ");
  const usable = (text: string) => text.length <= LIMIT.appearance && checkPrompt(text).allowed && !namesPublicFigure(text)
    && (!checkPrompt(action).allowed || checkPrompt(action + " " + text).allowed);
  return scriptIntroductions(parsed, names).map(intro => {
    const {lead, full, ageRange} = introductionAppearance(intro);
    // Checked together, as describeCharacter puts them in one prompt.
    const appearance = [full, lead].find(text => text && usable(text + " Age range: " + ageRange + "."));
    return {name: intro.name, appearance: appearance ?? "As the script describes " + intro.name + ".", ageRange: appearance ? ageRange : UNSTATED_AGE,
      wardrobe: "Everyday clothes that suit the scene."};
  });
}

/** The stand-in crew's plan: deterministic, conservative, and every field inside the validators. */
export function standInPlan(parsed: ParseResult, facts: ReadThroughFacts, shots: Shot[]): CrewPlan {
  const cast = standInCast(parsed, facts.characters);
  const planned = shots.map((shot, index) => {
    const heading = parsed.scenes[shot.sceneIndex]?.heading ?? "";
    // HV-030-16: the heading's time as the continuity report reads it (MIDNIGHT is night; the NIGHT in
    // "NIGHT MARKET" is a place), so the crew never writes a time its own report flags.
    const night = continuityHeadingTime(heading) === "night", exterior = /^\s*EXT/i.test(heading);
    const first = index === 0 || shots[index - 1]!.sceneIndex !== shot.sceneIndex;
    return {shotId: shot.id, size: first ? "wide" : shot.dialogue.length ? "close-up" : "medium", angle: "eye-level", movement: shot.dialogue.length ? "static" : "dolly",
      keyLight: night ? "Low, motivated practical light" : exterior ? "Soft natural daylight" : "Soft window light",
      timeOfDay: night ? "night" : "day", performance: shot.dialogue.length ? "Natural and understated" : "",
      soundIntent: exterior ? "Room tone of the location, light wind" : "Quiet room tone", transitionIntent: first && index > 0 ? "Cut on the new location" : ""};
  });
  return {schema: "hv-crew-plan/1", lookNote: "Naturalistic: soft motivated light, steady camera, close-ups for dialogue.", cast, shots: planned};
}

/**
 * HV-017-05: what the configured final provider bills, so the Editor holds each shot long enough
 * to use every billed second (Kling bills 5 s a clip; a 2 s shot wasted 3 of them). Null for free
 * pools, where shot length costs nothing.
 */
export interface ShotTiming { floorSec: number; stepsSec: number[] }
export function billedShotTiming(pool: readonly {snapshot: CapabilitySnapshot}[]): ShotTiming | null {
  const billed = pool.map(entry => entry.snapshot.price).filter(price => price.unit === "billed-second" && price.billedDurationsSec?.length);
  if (!billed.length) return null;
  const floorSec = Math.max(...billed.map(price => Math.min(...price.billedDurationsSec!)));
  return {floorSec, stepsSec: [...billed[0]!.billedDurationsSec!].sort((a, b) => a - b)};
}
/**
 * What the temporary speech engine costs in time, as measured from it rather than assumed
 * (HV-030-05). The old estimate was a flat "about 120 words a minute", which held only because the
 * engine's own default is 175 and the gap was slack. Two things spend that slack and it then
 * undershot: a line directed slower than the assumption, and punctuation, whose pauses are close to
 * a fixed length and so dominate a short line — the engine takes 19% longer than its nominal pace on
 * "Stop, wait, listen: did you hear that?" while running 25% faster than nominal on a long plain
 * sentence. Both terms below are calibrated against the engine itself, and
 * `packages/generator/test/speech-pacing.test.ts` holds them to it.
 */
export const SPEECH_PACE = {wordFactor: .9, markSec: .45, markRateWpm: 175, headroomSec: .8} as const;
/** A conservative estimate of how long a shot's lines take to say, including its authored silences. */
export function dialogueSeconds(dialogue: Shot["dialogue"], performances?: Shot["performances"]): number {
  const texts = dialogue.flatMap(block => block.lines).map(line => line.trim()).filter(Boolean);
  if (!texts.length) return 0;
  // The slowest directed line sets the pace for all of them: an estimate may run long, never short.
  const rateWpm = Math.min(DEFAULT_VOICE.rateWpm, ...(performances ?? []).map(line => line.voice.rateWpm));
  const spoken = texts.reduce((total, text) => total + text.split(/\s+/).filter(Boolean).length * 60 / rateWpm * SPEECH_PACE.wordFactor
    + (text.match(/[.,;:!?…]/g) ?? []).length * SPEECH_PACE.markSec * SPEECH_PACE.markRateWpm / rateWpm, 0);
  // Silences the creator authored are rendered too; without them the engine's own default applies.
  const pauses = performances?.length ? performances.reduce((total, line) => total + (line.beforeMs + line.afterMs) / 1000, 0) : texts.length * .2;
  return spoken + pauses + SPEECH_PACE.headroomSec;
}
/**
 * The billed clip that holds this shot, or null when none does. Until HV-030-05 a shot whose
 * dialogue outran every billed clip was pinned to the longest one anyway, which set an exact
 * duration the temporary speech could not fit: the render then refused the shot before requesting a
 * single image, and the creator was told to increase a duration the studio had chosen for them. A
 * shot no billed clip holds is left on automatic duration instead, and the Editor says why.
 */
function pacedFrames(timing: ShotTiming, shot: Shot): number | null {
  const needed = Math.max(timing.floorSec, dialogueSeconds(shot.dialogue, shot.performances));
  const step = timing.stepsSec.find(value => value >= needed);
  if (step === undefined) return null;
  const frames = Math.max(30, Math.round(step * 30));
  return frames > 900 ? null : frames;
}

/** HV-030-28: the seconds the Editor paces this shot to on a billed profile, or null when no billed clip holds it. */
export function pacedSeconds(timing: ShotTiming, shot: Shot): number | null {
  const frames = pacedFrames(timing, shot);
  return frames === null ? null : frames / 30;
}

/**
 * What the crew may change: new cast for uncast speaking roles, and direction for
 * shots the creator has not directed. Anything already set by the creator is left.
 */
export function crewChanges(plan: CrewPlan, casting: CastingSnapshot, direction: DirectionSnapshot, newId: () => string, now = Date.now(),
  pacing?: {timing: ShotTiming | null; shots: Shot[]}): CrewChanges {
  const byId = new Map((pacing?.shots ?? []).map(shot => [shot.id, shot]));
  const taken = new Set(casting.characters.flatMap(character => [character.name, ...character.aliases]).map(name => name.toLocaleUpperCase("en-US")));
  const directed = new Set(direction.entries.map(entry => entry.source.id));
  const notes: CrewNote[] = [];
  const characters = plan.cast.filter(entry => !taken.has(entry.name.toLocaleUpperCase("en-US"))).map(entry => {
    const id = newId();
    const input = {name: entry.name, aliases: [], kind: "original-fictional", appearance: entry.appearance, ageRange: entry.ageRange, ethnicity: "", body: "",
      hairMakeup: "", expressions: "", movement: "", relationships: "", arcNotes: "", prohibitedChanges: "",
      wardrobe: entry.wardrobe ? [{sceneNumber: null, description: entry.wardrobe}] : [],
      permission: {status: "pending", scope: "project", sceneNumbers: [], expiresAt: null, attested: false}};
    characterRecord(input, id, now); // the same validator a creator's save meets; throws on anything invalid
    notes.push({persona: "casting", change: "Proposed a look for " + entry.name + "; it waits for your permission at the look approval."});
    return {id, input};
  });
  const overlong: string[] = [];
  const directions = plan.shots.filter(shot => !directed.has(shot.shotId)).map(shot => {
    const source = byId.get(shot.shotId);
    const paced = pacing?.timing && source && source.cutDurationFrames == null ? pacedFrames(pacing.timing, source) : undefined;
    if (paced === null) overlong.push(shot.shotId);
    const input = {...DEFAULT_DIRECTION, size: shot.size, angle: shot.angle, movement: shot.movement, keyLight: shot.keyLight, timeOfDay: shot.timeOfDay,
      performance: shot.performance, soundIntent: shot.soundIntent, transitionIntent: shot.transitionIntent,
      ...(typeof paced === "number" ? {durationFrames: paced} : {})};
    directionSettings(input);
    return {shotId: shot.shotId, input};
  });
  if (directions.length) {
    notes.push({persona: "cinematographer", change: "Set the look for " + directions.length + " shot" + (directions.length === 1 ? "" : "s") + ": " + (plan.lookNote || "framing, movement and light") + "."});
    if (directions.some(entry => (entry.input as {performance: string}).performance)) notes.push({persona: "director", change: "Gave performance notes for the dialogue shots."});
    if (directions.some(entry => (entry.input as {soundIntent: string}).soundIntent)) notes.push({persona: "sound", change: "Set the sound of each location."});
    if (directions.some(entry => (entry.input as {transitionIntent: string}).transitionIntent)) notes.push({persona: "editor", change: "Marked the cuts between locations."});
    const paced = [...new Set(directions.map(entry => (entry.input as {durationFrames: number | null}).durationFrames).filter((value): value is number => value !== null))];
    if (paced.length) notes.push({persona: "editor", change: "Held each shot to " + paced.map(frames => frames / 30).sort((a, b) => a - b).join(" or ") + " s, so the final uses every second the provider bills."});
    if (overlong.length) notes.push({persona: "editor", change: "Left " + overlong.length + " shot" + (overlong.length === 1 ? "" : "s")
      + " on automatic duration — " + overlong.slice(0, 6).join(", ") + (overlong.length > 6 ? ", and others" : "")
      + ". Their dialogue runs longer than the longest clip this provider bills, so no fixed length holds it. Split "
      + (overlong.length === 1 ? "it" : "them") + " into coverage to use every billed second."});
  }
  return {characters, directions, notes};
}

export async function runPlan(options: {
  scriptText: string; parsed: ParseResult; facts: ReadThroughFacts; input: PlanInput; shots: Shot[]; projectId: string;
  model: CrewModel | null; ledger: CrewLedger | CrewLedgerReader; now?: () => Date;
}): Promise<{plan: CrewPlan; source: CrewVendor | "stand-in"; fallbackReason?: "model_unusable" | "model_unavailable" | "content_policy"; unusableReason?: CrewUnusableReason; crewSpend: {usd: number; alerts: CrewAlert[]}}> {
  const {scriptText, parsed, facts, input, shots, projectId, model, ledger} = options;
  const now = options.now ?? (() => new Date());
  const standIn = () => standInPlan(parsed, facts, shots);
  const refused = facts.concerns.some(concern => concern.kind === "public_figure" || concern.kind === "content_policy");
  if (!model || refused || !shots.length) return {plan: standIn(), source: "stand-in", crewSpend: {usd: 0, alerts: []}};
  const prompt = planPrompt(scriptText, facts, input, shots);
  // HV-030-21: and the whole request the model would receive -- the script with the answers beside it --
  // passes the gate before anything is sent or spent. If it does not, the stand-in plans, and the
  // creator's answers never reach the model.
  if (!checkPrompt(prompt.user).allowed) return {plan: standIn(), source: "stand-in", fallbackReason: "content_policy", crewSpend: {usd: 0, alerts: []}};
  await ledger.assertCanSpend();
  const asked = await askCrewModel(model, {system: prompt.system, messages: [{role: "user", content: prompt.user}], maxTokens: CREW_PLAN_MAX_TOKENS});
  if (!asked) return {plan: standIn(), source: "stand-in", fallbackReason: "model_unavailable", crewSpend: {usd: 0, alerts: []}};
  const {completion} = asked;
  const alerts = await ledger.record({at: now().toISOString(), projectId, persona: "crew-plan", model: completion.model,
    inputTokens: completion.usage.inputTokens, outputTokens: completion.usage.outputTokens, usd: completion.costUsd});
  const fallback = (unusableReason: CrewUnusableReason) => ({plan: standIn(), source: "stand-in" as const, fallbackReason: "model_unusable" as const, unusableReason,
    crewSpend: {usd: completion.costUsd, alerts}});
  if (!asked.usable) return fallback(asked.reason);
  try {
    return {plan: validateCrewPlan(completion.text, facts, shots), source: model.name, crewSpend: {usd: completion.costUsd, alerts}};
  } catch (error) { return fallback(crewUnusableReason(error)); }
}
