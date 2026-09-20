import type { CapabilitySnapshot } from "../../../generator/src/capabilities";
import type { CrewModel } from "../../../generator/src/crew-model";
import type { CrewAlert, CrewLedger } from "../../../operator/src/crew-ledger";
import type { ParseResult } from "../../../parser/src/index";
import { checkPrompt } from "../../../safety/src/index";
import { namesPublicFigure } from "../../../safety/src/public-figures";
import { characterRecord, type CastingSnapshot } from "../casting";
import { DEFAULT_DIRECTION, DIRECTION_CHOICES, directionSettings, type DirectionSnapshot } from "../direction";
import type { Shot } from "../index";
import { introductionAppearance, scriptIntroductions, UNSTATED_AGE } from "./introductions";
import { PERSONA_IDS, type PersonaId } from "./personas";
import type { FilmFormat, ReadThroughFacts } from "./read-through";

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
export interface CrewNote { persona: PersonaId; change: string }
export interface CrewChanges {
  characters: {id: string; input: unknown}[];
  directions: {shotId: string; input: unknown}[];
  notes: CrewNote[];
}

const LIMIT = {answer: 400, question: 300, lookNote: 400, name: 80, appearance: 600, ageRange: 80, wardrobe: 400, intent: 300, timeOfDay: 80};
const PLAN_KEYS = ["size", "angle", "movement"] as const;

function gated(value: unknown, limit: number, name: string, allowEmpty = true): string {
  if (typeof value !== "string" || value.length > limit) throw new Error("The crew's " + name + " is not usable.");
  const text = value.trim();
  if ((!allowEmpty && !text) || (text && !checkPrompt(text).allowed)) throw new Error("The crew's " + name + " is not usable.");
  return text;
}

export function planInput(value: unknown): PlanInput {
  const input = value as Record<string, unknown>;
  if (!input || typeof input !== "object" || !["reel", "short"].includes(String(input.format)) || typeof input.tone !== "string"
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
  return {format: input.format as FilmFormat, tone: gated(input.tone, 200, "tone"), answers};
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
    keyLight: gated(shot.keyLight ?? "", LIMIT.intent, "light"), timeOfDay: gated(shot.timeOfDay ?? "", LIMIT.timeOfDay, "time of day"),
    performance: gated(shot.performance ?? "", LIMIT.intent, "performance"), soundIntent: gated(shot.soundIntent ?? "", LIMIT.intent, "sound intent"),
    transitionIntent: gated(shot.transitionIntent ?? "", LIMIT.intent, "transition")};
}

/** Parses and gates the model's plan; the shots and names must be the studio's own. */
export function validateCrewPlan(text: string, facts: ReadThroughFacts, shots: Shot[]): CrewPlan {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON");
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
    const night = /\bNIGHT\b/i.test(heading), exterior = /^\s*EXT/i.test(heading);
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
/** A generous estimate of how long a shot's lines take to say (about 120 words a minute, with pauses). */
export function dialogueSeconds(dialogue: Shot["dialogue"]): number {
  const lines = dialogue.flatMap(block => block.lines);
  if (!lines.length) return 0;
  const count = lines.join(" ").split(/\s+/).filter(Boolean).length;
  return count / 2 + lines.length * 0.2 + 0.8;
}
function pacedFrames(timing: ShotTiming, shot: Shot): number {
  const needed = Math.max(timing.floorSec, dialogueSeconds(shot.dialogue));
  const step = timing.stepsSec.find(value => value >= needed) ?? timing.stepsSec.at(-1)!;
  return Math.min(900, Math.max(30, Math.round(step * 30)));
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
  const directions = plan.shots.filter(shot => !directed.has(shot.shotId)).map(shot => {
    const input = {...DEFAULT_DIRECTION, size: shot.size, angle: shot.angle, movement: shot.movement, keyLight: shot.keyLight, timeOfDay: shot.timeOfDay,
      performance: shot.performance, soundIntent: shot.soundIntent, transitionIntent: shot.transitionIntent,
      ...(pacing?.timing && byId.get(shot.shotId) && byId.get(shot.shotId)!.cutDurationFrames == null ? {durationFrames: pacedFrames(pacing.timing, byId.get(shot.shotId)!)} : {})};
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
  }
  return {characters, directions, notes};
}

export async function runPlan(options: {
  scriptText: string; parsed: ParseResult; facts: ReadThroughFacts; input: PlanInput; shots: Shot[]; projectId: string;
  model: CrewModel | null; ledger: CrewLedger; now?: () => Date;
}): Promise<{plan: CrewPlan; source: "anthropic" | "stand-in"; fallbackReason?: "model_unusable" | "model_unavailable"; crewSpend: {usd: number; alerts: CrewAlert[]}}> {
  const {scriptText, parsed, facts, input, shots, projectId, model, ledger} = options;
  const now = options.now ?? (() => new Date());
  const standIn = () => standInPlan(parsed, facts, shots);
  const refused = facts.concerns.some(concern => concern.kind === "public_figure" || concern.kind === "content_policy");
  if (!model || refused || !shots.length) return {plan: standIn(), source: "stand-in", crewSpend: {usd: 0, alerts: []}};
  ledger.assertCanSpend();
  const prompt = planPrompt(scriptText, facts, input, shots);
  let completion;
  try { completion = await model.complete({system: prompt.system, messages: [{role: "user", content: prompt.user}], maxTokens: 6000}); }
  catch { return {plan: standIn(), source: "stand-in", fallbackReason: "model_unavailable", crewSpend: {usd: 0, alerts: []}}; }
  const alerts = ledger.record({at: now().toISOString(), projectId, persona: "crew-plan", model: completion.model,
    inputTokens: completion.usage.inputTokens, outputTokens: completion.usage.outputTokens, usd: completion.costUsd});
  try { return {plan: validateCrewPlan(completion.text, facts, shots), source: "anthropic", crewSpend: {usd: completion.costUsd, alerts}}; }
  catch { return {plan: standIn(), source: "stand-in", fallbackReason: "model_unusable", crewSpend: {usd: completion.costUsd, alerts}}; }
}
