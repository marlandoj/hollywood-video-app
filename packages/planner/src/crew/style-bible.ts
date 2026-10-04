import { askCrewModel, CrewAnswerUnusable, crewUnusableReason, type CrewModel, type CrewUnusableReason, type CrewVendor } from "../../../generator/src/crew-model";
import type { CrewAlert, CrewLedger } from "../../../operator/src/crew-ledger";
import type { CrewLedgerReader } from "../../../storage/src/crew-ledger";
import type { ParseResult } from "../../../parser/src/index";
import { checkPrompt } from "../../../safety/src/index";
import { assertBibleWhole, bibleText, STYLE_BIBLE_LIMIT, STYLE_FIELDS, styleBibleText, type BibleDrop, type BibleLocation, type BibleStyle, type StyleBible, type StyleField } from "../style-bible";
import type { CrewNote, PlanInput } from "./production-plan";
import type { PersonaId } from "./personas";
import { rememberedAnswer, styleCardPrompt, type StyleCard } from "./style-card";

/**
 * The Showrunner writes a feature's style bible (HV-034-02, Release 3 step 3, G20-202610031349) once,
 * at the plan step, after splitting the feature and before the crew directs it. See
 * `../style-bible.ts` for the record and how every sequence's render reads it.
 *
 * Its tool is one typed proposal: the six style lines and a description for each of the script's
 * locations, by the name the studio gives it. The studio names the locations (from the headings) and
 * the characters (from the cast); the model can't add either. Unlike the plan, a bible is used field
 * by field: a line that is missing, not text, too long, refused by the gate or naming a public figure
 * is replaced by the stand-in's line, and `dropped` says which and why. An answer with no usable line,
 * or whose lines together fail the gate, is unusable and the stand-in's whole bible is used.
 *
 * With no model, nothing is asked or spent: the stand-in writes it from the creator's answers, the
 * attached style card and the screenplay, deterministically.
 */
export const STYLE_BIBLE_MAX_TOKENS = 1500;

/** The stand-in's lines when the creator said nothing for them: the stand-in plan's own conventions. */
export const STAND_IN_STYLE: Readonly<Record<StyleField, string>> = Object.freeze({
  look: "Naturalistic: soft motivated light, steady camera, close-ups for dialogue.",
  palette: "Natural colour true to each location's light, graded the same way in every sequence.",
  lighting: "Soft natural daylight outside, soft window light inside, low motivated practical light at night.",
  lens: "Wide to open each location, medium for action, close-ups for dialogue; eye-level and steady.",
  tone: "As the script reads.",
  sound: "The room tone of each location, with the music kept under the dialogue.",
});

export interface StyleBibleDraft {
  style: BibleStyle;
  source: CrewVendor | "stand-in";
  fallbackReason?: "model_unusable" | "model_unavailable" | "content_policy";
  unusableReason?: CrewUnusableReason;
  /** The parts of the model's answer left out, and why; the stand-in's line stands in each place. */
  dropped: BibleDrop[];
  crewSpend: {usd: number; alerts: CrewAlert[]};
}

/** What the creator settled on for this persona in this film's answers: the proposal accepted, or what they said instead. */
function answered(input: PlanInput, persona: PersonaId): string | null {
  for (const answer of input.answers.filter(entry => entry.persona === persona)) {
    if (answer.accepted && answer.proposal) return answer.proposal;
    if (!answer.accepted && answer.reply) return answer.reply;
  }
  return null;
}

/** The first candidate the bible can hold, else the stand-in's own line. */
function firstUsable(field: StyleField, candidates: (string | null | undefined)[]): string {
  for (const candidate of candidates) {
    if (!candidate) continue;
    const checked = bibleText(candidate, STYLE_BIBLE_LIMIT[field]);
    if ("text" in checked) return checked.text;
  }
  return STAND_IN_STYLE[field];
}

/**
 * The stand-in Showrunner's bible: this film's answers first, then the creator's style card, then the
 * stand-in's conventions. Deterministic: the same answers, card and script give the same bible.
 */
export function standInStyleBible(input: PlanInput, card: StyleCard | null, locations: BibleLocation[]): BibleStyle {
  const remembered = (persona: PersonaId) => card ? rememberedAnswer(card, persona) : null;
  const style = {
    look: firstUsable("look", [answered(input, "cinematographer"), remembered("cinematographer"), card?.look]),
    palette: STAND_IN_STYLE.palette,
    lighting: STAND_IN_STYLE.lighting,
    lens: STAND_IN_STYLE.lens,
    tone: firstUsable("tone", [input.tone, card?.tone, answered(input, "director"), remembered("director")]),
    sound: firstUsable("sound", [answered(input, "sound"), remembered("sound")]),
    locations: locations.map(entry => ({...entry})),
  };
  // Each line passed alone; the gate's paired rules read the whole. If the creator's words together
  // fail it, the bible says only the stand-in's conventions.
  return checkPrompt(styleBibleText(style)).allowed ? style : {...STAND_IN_STYLE, locations: style.locations};
}

export function styleBiblePrompt(input: PlanInput, card: StyleCard | null, parsed: ParseResult, locations: BibleLocation[], characters: string[]): {system: string; user: string} {
  const system = "You are the Showrunner of an AI film studio, writing the style bible of a feature: one short document that every sequence's renders read, "
    + "so the whole feature keeps one look from its first sequence to its last. Describe light, colour, framing, mood, sound and places only. "
    + "Never describe the characters (the cast does that) and never name a real or famous person. Reply with JSON only, exactly: "
    + "{\"look\": string, \"palette\": string, \"lighting\": string, \"lens\": string, \"tone\": string, \"sound\": string, \"locations\": [{\"name\": string, \"description\": string}]}, "
    + "with each location's name exactly as given. At most " + STYLE_FIELDS.map(field => field + " " + STYLE_BIBLE_LIMIT[field]).join(", ")
    + " and each location's description " + STYLE_BIBLE_LIMIT.locationDescription + " characters.";
  const answers = input.answers.map(answer => "- " + answer.persona + " asked: " + answer.question + " Creator: "
    + (answer.accepted ? "accepted the proposal: " + answer.proposal : answer.reply ? answer.reply : "declined the proposal: " + answer.proposal)).join("\n");
  const user = "Format: feature. Tone: " + (input.tone || "not stated") + ".\nCreator's answers:\n" + (answers || "(none)")
    + (card ? "\n" + styleCardPrompt(card) : "") + "\nCharacters (the cast describes them): " + JSON.stringify(characters)
    + "\nLocations: " + JSON.stringify(locations.map(entry => entry.name)) + "\nScenes: " + parsed.scenes.length + ".";
  return {system, user};
}

/**
 * The model's bible, read field by field (see above). Throws `CrewAnswerUnusable` only when nothing in
 * it can be used, or its lines together fail the gate.
 */
export function validateStyleBibleAnswer(text: string, fallback: BibleStyle): {style: BibleStyle; dropped: BibleDrop[]} {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new CrewAnswerUnusable("no JSON", "no_json");
  const value = JSON.parse(text.slice(start, end + 1)) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CrewAnswerUnusable("The Showrunner's bible is not an object.", "bad_shape");
  const answer = value as Record<string, unknown>, dropped: BibleDrop[] = [];
  for (const key of Object.keys(answer)) if (![...STYLE_FIELDS, "locations"].includes(key)) dropped.push({field: key.slice(0, 40), reason: "bad_shape"});
  const style = {...fallback, locations: fallback.locations.map(entry => ({...entry}))};
  let used = 0;
  for (const field of STYLE_FIELDS) {
    if (answer[field] === undefined) { dropped.push({field, reason: "missing"}); continue; }
    const checked = bibleText(answer[field], STYLE_BIBLE_LIMIT[field]);
    if ("text" in checked) { style[field] = checked.text; used++; } else dropped.push({field, reason: checked.reason});
  }
  if (answer.locations === undefined) dropped.push({field: "locations", reason: "missing"});
  else if (!Array.isArray(answer.locations) || answer.locations.length > STYLE_BIBLE_LIMIT.locations * 2) dropped.push({field: "locations", reason: "bad_shape"});
  else {
    const described = new Set<string>();
    for (const item of answer.locations) {
      const entry = item as Record<string, unknown>;
      if (!entry || typeof entry !== "object" || Array.isArray(entry) || Object.keys(entry).sort().join(",") !== "description,name" || typeof entry.name !== "string") {
        dropped.push({field: "location", reason: "bad_shape"}); continue;
      }
      const key = entry.name.trim().toLocaleUpperCase("en-US"), target = style.locations.find(location => location.name === key);
      if (!target) { dropped.push({field: "location", reason: "unknown_location"}); continue; }
      if (described.has(key)) { dropped.push({field: "location", reason: "bad_shape"}); continue; }
      described.add(key);
      const checked = bibleText(entry.description, STYLE_BIBLE_LIMIT.locationDescription);
      if ("text" in checked) { target.description = checked.text; used++; } else dropped.push({field: "location", reason: checked.reason});
    }
  }
  if (!used) throw new CrewAnswerUnusable("Nothing in the Showrunner's bible could be used.", "bad_shape");
  if (!checkPrompt(styleBibleText(style)).allowed) throw new CrewAnswerUnusable("The Showrunner's bible, taken as a whole, falls outside the content policy.", "gate_refused");
  return {style, dropped};
}

export async function runStyleBible(options: {
  input: PlanInput; card: StyleCard | null; parsed: ParseResult; locations: BibleLocation[]; characters: string[]; projectId: string;
  model: CrewModel | null; ledger: CrewLedger | CrewLedgerReader; refused?: boolean; now?: () => Date;
}): Promise<StyleBibleDraft> {
  const {input, card, parsed, locations, characters, projectId, model, ledger} = options;
  const now = options.now ?? (() => new Date());
  const fallback = standInStyleBible(input, card, locations);
  assertBibleWhole(fallback);
  const standIn = (extra: Partial<StyleBibleDraft> = {}): StyleBibleDraft => ({style: fallback, source: "stand-in", dropped: [], crewSpend: {usd: 0, alerts: []}, ...extra});
  // A script the read-through flagged (a public figure, the content policy) is never sent: the stand-in writes it, as the plan's does.
  if (!model || options.refused) return standIn();
  const prompt = styleBiblePrompt(input, card, parsed, locations, characters);
  if (!checkPrompt(prompt.user).allowed) return standIn({fallbackReason: "content_policy"});
  await ledger.assertCanSpend();
  const asked = await askCrewModel(model, {system: prompt.system, messages: [{role: "user", content: prompt.user}], maxTokens: STYLE_BIBLE_MAX_TOKENS});
  if (!asked) return standIn({fallbackReason: "model_unavailable"});
  const {completion} = asked;
  const alerts = await ledger.record({at: now().toISOString(), projectId, persona: "crew-style-bible", model: completion.model,
    inputTokens: completion.usage.inputTokens, outputTokens: completion.usage.outputTokens, usd: completion.costUsd});
  const crewSpend = {usd: completion.costUsd, alerts};
  if (!asked.usable) return standIn({fallbackReason: "model_unusable", unusableReason: asked.reason, crewSpend});
  try {
    const {style, dropped} = validateStyleBibleAnswer(completion.text, fallback);
    return {style, source: model.name as CrewVendor, dropped, crewSpend};
  } catch (error) { return standIn({fallbackReason: "model_unusable", unusableReason: crewUnusableReason(error), crewSpend}); }
}

/** The Showrunner's note on the bible, in the studio's words: never the model's. */
export function styleBibleNote(bible: StyleBible, carried: boolean): CrewNote {
  const counts = bible.characters.length + " character" + (bible.characters.length === 1 ? "" : "s") + " and " + bible.locations.length + " location" + (bible.locations.length === 1 ? "" : "s");
  return {persona: "showrunner", change: (carried ? "Kept the feature's style bible (version " + bible.version + "), with " : "Wrote the feature's style bible, with ")
    + counts + ". Every sequence's renders read it, so the look stays the same from the first sequence to the last."};
}
