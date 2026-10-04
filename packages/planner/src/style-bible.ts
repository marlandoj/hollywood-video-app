import { contentHash } from "../../generator/src/capabilities";
import { CREW_VENDORS, type CrewVendor } from "../../generator/src/crew-model";
import type { ParseResult } from "../../parser/src/index";
import { checkPrompt, gateOrThrow } from "../../safety/src/index";
import { namesPublicFigure } from "../../safety/src/public-figures";
import { charactersForScene, type CastCharacter, type CastingSnapshot } from "./casting";
import { continuityHeadingTime } from "./continuity";
import type { Shot } from "./index";

/**
 * A feature's style bible (HV-034, Release 3 step 3, G20-202610031349).
 *
 * A feature is made as a series of sequences (HV-030-29), each its own rough cut and final. Without
 * one written statement of the look, each sequence's renders read only their own shots, and nothing
 * says sequence 7 should look like sequence 1. The Showrunner writes the bible once, at the plan step,
 * from the creator's answers, an attached style card and the screenplay; every sequence's render reads
 * it (`bibleShots`) and records which revision it read (`SequenceRef.bibleRevision`).
 *
 * - **Bounded.** Six style lines (look, palette, lighting, lens and framing, tone, sound), each
 *   principal character, and each recurring location, all with limits, at most 24 characters and 40
 *   locations.
 * - **The cast speaks for the characters.** A character's entry is the cast record's own appearance
 *   (and default wardrobe), never the model's words, so the bible can't describe a person the creator
 *   didn't consent to. A consented real person is never re-described. The render prompt still takes a
 *   character's look from the cast (`directCast`); the bible adds the feature's look.
 * - **Gated when written.** Every string passes the prompt gate and the public-figure check alone, and
 *   the whole bible passes the gate together (its paired rules read a request as a whole). A stored
 *   bible is checked for shape, limits and revision on load, and every render gates its prompt again,
 *   so a refusal added later refuses the render rather than making the project unreadable.
 */
export const STYLE_BIBLE_SCHEMA = "hv-style-bible/1";
export const STYLE_FIELDS = ["look", "palette", "lighting", "lens", "tone", "sound"] as const;
export type StyleField = typeof STYLE_FIELDS[number];
export const STYLE_BIBLE_LIMIT = {look: 400, palette: 240, lighting: 240, lens: 240, tone: 200, sound: 400,
  characters: 24, characterName: 80, characterDescription: 1000, locations: 40, locationName: 120, locationDescription: 300, version: 1_000_000} as const;
export const STYLE_FIELD_LABELS: Readonly<Record<StyleField, string>> = Object.freeze({look: "Look", palette: "Palette", lighting: "Lighting",
  lens: "Lens and framing", tone: "Tone", sound: "Sound"});

export interface BibleCharacter { name: string; description: string }
export interface BibleLocation { name: string; description: string }
export type BibleStyle = Record<StyleField, string> & { locations: BibleLocation[] };
export type BibleSource = CrewVendor | "stand-in" | "creator";
export interface StyleBible extends BibleStyle {
  schema: typeof STYLE_BIBLE_SCHEMA;
  /** 1 when the Showrunner writes it; one more each time it changes (a creator's edit, or a replan that changes it). */
  version: number;
  scriptVersion: number;
  source: BibleSource;
  characters: BibleCharacter[];
  revision: string;
}
/** Why one part of an answer was left out: the rest of the bible is still used. */
export type BibleDropReason = "missing" | "bad_shape" | "too_long" | "gate_refused" | "public_figure" | "unknown_location";
export interface BibleDrop { field: string; reason: BibleDropReason }
export class StyleBibleConflict extends Error { override name = "StyleBibleConflict"; }

const SOURCES: readonly string[] = [...CREW_VENDORS, "stand-in", "creator"];
const BIBLE_KEYS = ["schema", "version", "scriptVersion", "source", ...STYLE_FIELDS, "characters", "locations", "revision"];
const INVALID = "A project's style bible is not one the studio wrote.";

const exact = (value: unknown, keys: readonly string[]): value is Record<string, unknown> => Boolean(value) && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value as object).sort().join(",") === [...keys].sort().join(",");
/** C0 controls other than tab, line feed and carriage return, and DEL: what the crew's other validators refuse. */
const unusableCharacter = (text: string) => Array.from(text).some(character => {const code = character.charCodeAt(0); return code === 127 || (code < 32 && ![9, 10, 13].includes(code));});

/**
 * One string of the bible, or why it can't be used. Never cut short: a string past its limit is
 * refused whole. Empty is refused too, because every line of the bible says something.
 */
export function bibleText(value: unknown, limit: number): {text: string} | {reason: Exclude<BibleDropReason, "missing" | "unknown_location">} {
  if (typeof value !== "string" || unusableCharacter(value)) return {reason: "bad_shape"};
  if (value.length > limit) return {reason: "too_long"};
  const text = value.trim();
  if (!text) return {reason: "bad_shape"};
  // The public-figure check first, so its reason is the specific one; the gate refuses most of them too.
  if (namesPublicFigure(text)) return {reason: "public_figure"};
  if (!checkPrompt(text).allowed) return {reason: "gate_refused"};
  return {text};
}

/** Every word of the bible as one text, for the gate to read the way a render prompt will. */
export function styleBibleText(bible: BibleStyle & {characters?: BibleCharacter[]}): string {
  return [...STYLE_FIELDS.map(field => bible[field]), ...(bible.characters ?? []).flatMap(entry => [entry.name, entry.description]),
    ...bible.locations.flatMap(entry => [entry.name, entry.description])].join("\n");
}

/** A heading's place, as the bible names it: "INT. KITCHEN - NIGHT" is KITCHEN. */
export function headingLocation(heading: string): string {
  let text = heading.trim().replace(/^\.(?=[^.])/, "").replace(/#[^#]*#\s*$/, "").trim();
  text = text.replace(/^(?:INT\.?\s*\/\s*EXT|EXT\.?\s*\/\s*INT|I\s*\/\s*E|INT|EXT|EST)\.?\s+/i, "");
  const dash = text.search(/\s+[-–—]{1,2}\s+/);
  if (dash > 0) text = text.slice(0, dash);
  return text.replace(/\s+/g, " ").trim().toLocaleUpperCase("en-US");
}

/**
 * The script's locations in order of first appearance, with what the stand-in says about each: inside
 * or out, by day or by night. A place the bible can't name (past its limits, or refused) is left out
 * with its reason, and so is every place past the 40th (`too_long`): never silently.
 */
export function scriptLocations(parsed: ParseResult): {locations: BibleLocation[]; dropped: BibleDrop[]} {
  const seen = new Map<string, {interior: boolean; exterior: boolean; times: Set<string>}>(), dropped: BibleDrop[] = [];
  for (const scene of parsed.scenes) {
    const name = headingLocation(scene.heading);
    if (!name) continue;
    const entry = seen.get(name) ?? {interior: false, exterior: false, times: new Set<string>()};
    if (/^\s*\.?\s*(?:INT|I\s*\/\s*E)/i.test(scene.heading) || /^\s*\.?\s*EXT\.?\s*\/\s*INT/i.test(scene.heading)) entry.interior = true;
    if (/^\s*\.?\s*(?:EXT|I\s*\/\s*E)/i.test(scene.heading) || /^\s*\.?\s*INT\.?\s*\/\s*EXT/i.test(scene.heading)) entry.exterior = true;
    const time = continuityHeadingTime(scene.heading);
    if (time) entry.times.add(time);
    seen.set(name, entry);
  }
  const locations: BibleLocation[] = [];
  for (const [name, entry] of seen) {
    const checked = bibleText(name, STYLE_BIBLE_LIMIT.locationName);
    if (!("text" in checked)) { dropped.push({field: "location", reason: checked.reason}); continue; }
    if (locations.length >= STYLE_BIBLE_LIMIT.locations) { dropped.push({field: "location", reason: "too_long"}); continue; }
    const place = entry.interior && entry.exterior ? "Inside and out" : entry.interior ? "An interior" : entry.exterior ? "An exterior" : "A place";
    const when = entry.times.size === 2 ? ", seen by day and by night" : entry.times.has("night") ? ", seen by night" : entry.times.has("day") ? ", seen by day" : "";
    locations.push({name: checked.text, description: place + when + ". It keeps the same set dressing and light in every sequence it appears in."});
  }
  return {locations, dropped};
}

/**
 * The bible's characters: each cast character the script mentions, in cast order, described by the
 * cast record itself. An original character is its appearance, with its default wardrobe when that
 * fits; a consented real person is never re-described. A character the bible can't hold is left out
 * with its reason.
 */
export function bibleCharacters(characters: readonly CastCharacter[], parsed: ParseResult): {characters: BibleCharacter[]; dropped: BibleDrop[]} {
  const snapshot = {characters} as unknown as CastingSnapshot;
  const present = new Set(parsed.scenes.flatMap(scene => charactersForScene(snapshot, scene.index, parsed).map(character => character.id)));
  const result: BibleCharacter[] = [], dropped: BibleDrop[] = [];
  for (const character of characters.filter(value => present.has(value.id))) {
    const name = bibleText(character.name, STYLE_BIBLE_LIMIT.characterName);
    if (!("text" in name)) { dropped.push({field: "character", reason: name.reason}); continue; }
    if (result.length >= STYLE_BIBLE_LIMIT.characters) { dropped.push({field: "character", reason: "too_long"}); continue; }
    if (character.kind !== "original-fictional") {
      result.push({name: name.text, description: "A consented real person: their look is the cast record's, within what their consent allows."});
      continue;
    }
    const wardrobe = character.wardrobe.find(entry => entry.sceneNumber === null)?.description;
    const candidates = [wardrobe ? character.appearance.trim() + " Wardrobe: " + wardrobe.trim() : "", character.appearance].filter(Boolean);
    let reason: BibleDropReason = "bad_shape", description: string | null = null;
    for (const candidate of candidates) {
      const checked = bibleText(candidate, STYLE_BIBLE_LIMIT.characterDescription);
      if ("text" in checked) { description = checked.text; break; }
      reason = checked.reason;
    }
    if (description === null) { dropped.push({field: "character", reason}); continue; }
    result.push({name: name.text, description});
  }
  return {characters: result, dropped};
}

export function styleBible(fields: Omit<StyleBible, "schema" | "revision">): StyleBible {
  const body = {schema: STYLE_BIBLE_SCHEMA, version: fields.version, scriptVersion: fields.scriptVersion, source: fields.source,
    ...Object.fromEntries(STYLE_FIELDS.map(field => [field, fields[field]])) as Record<StyleField, string>,
    characters: fields.characters.map(({name, description}) => ({name, description})),
    locations: fields.locations.map(({name, description}) => ({name, description}))};
  return {...body, revision: contentHash(body)} as StyleBible;
}

const positive = (value: unknown, max: number): value is number => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= max;
const bounded = (value: unknown, limit: number) => typeof value === "string" && value.length <= limit && value.trim() === value && value.length > 0 && !unusableCharacter(value);
function entries(value: unknown, max: number, nameLimit: number, descriptionLimit: number): value is {name: string; description: string}[] {
  return Array.isArray(value) && value.length <= max && value.every(entry => exact(entry, ["name", "description"]) && bounded(entry.name, nameLimit) && bounded(entry.description, descriptionLimit))
    && new Set(value.map(entry => (entry as {name: string}).name.toLocaleUpperCase("en-US"))).size === value.length;
}

/**
 * A stored bible's own shape: what a project load, a state snapshot and a render job accept. The
 * revision is recomputed, so a bible changed after it was written is refused.
 */
export function validateStyleBible(value: unknown): StyleBible {
  if (!exact(value, BIBLE_KEYS) || value.schema !== STYLE_BIBLE_SCHEMA || !positive(value.version, STYLE_BIBLE_LIMIT.version)
    || !positive(value.scriptVersion, Number.MAX_SAFE_INTEGER) || !SOURCES.includes(value.source as string)
    || STYLE_FIELDS.some(field => !bounded(value[field], STYLE_BIBLE_LIMIT[field]))
    || !entries(value.characters, STYLE_BIBLE_LIMIT.characters, STYLE_BIBLE_LIMIT.characterName, STYLE_BIBLE_LIMIT.characterDescription)
    || !entries(value.locations, STYLE_BIBLE_LIMIT.locations, STYLE_BIBLE_LIMIT.locationName, STYLE_BIBLE_LIMIT.locationDescription)
    || typeof value.revision !== "string") throw new Error(INVALID);
  const bible = styleBible(value as unknown as StyleBible);
  if (bible.revision !== value.revision) throw new Error("A project's style bible changed after it was written.");
  return bible;
}

/**
 * The bible a plan step leaves: its words checked once more as a whole. If the whole fails the gate
 * (each line passing alone is not the bible passing), it is refused, and the caller falls back.
 */
export function assertBibleWhole(bible: BibleStyle & {characters?: BibleCharacter[]}): void {
  if (!checkPrompt(styleBibleText(bible)).allowed) throw new Error("The style bible, taken as a whole, falls outside the content policy.");
}

/**
 * The creator's edit (`PUT /style-bible`): the six style lines, and optionally new descriptions for
 * locations the bible already names. Every field meets the rules the Showrunner's words met, and any
 * failure refuses the edit whole (400) -- a creator is told, never silently dropped. The characters
 * are the cast's: edit the cast to change them. An edit that changes nothing is not a new version.
 */
export function styleBibleEdit(current: StyleBible, value: unknown): StyleBible {
  const input = value as Record<string, unknown>;
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["expectedRevision", ...STYLE_FIELDS, "locations"].includes(key)))
    throw new Error("Send the style bible's revision you edited, its six lines (look, palette, lighting, lens, tone and sound) and, if you like, new location descriptions.");
  if (input.expectedRevision !== current.revision) throw new StyleBibleConflict("The style bible changed since you opened it. Reload it before editing.");
  const fields = {} as Record<StyleField, string>;
  for (const field of STYLE_FIELDS) {
    const checked = bibleText(input[field], STYLE_BIBLE_LIMIT[field]);
    if (!("text" in checked)) throw new Error("The style bible's " + STYLE_FIELD_LABELS[field].toLocaleLowerCase("en-US") + " can't be used ("
      + checked.reason.replaceAll("_", " ") + "): it must be text of up to " + STYLE_BIBLE_LIMIT[field] + " characters that passes the content policy and names no public figure.");
    fields[field] = checked.text;
  }
  const locations = current.locations.map(entry => ({...entry}));
  if (input.locations !== undefined) {
    if (!Array.isArray(input.locations) || input.locations.length > STYLE_BIBLE_LIMIT.locations) throw new Error("Send each location as its name and new description.");
    const named = new Set<string>();
    for (const entry of input.locations) {
      if (!exact(entry, ["name", "description"]) || typeof entry.name !== "string") throw new Error("Send each location as its name and new description.");
      const key = entry.name.trim().toLocaleUpperCase("en-US"), target = locations.find(location => location.name === key);
      if (!target) throw new Error("The style bible names no location " + JSON.stringify(entry.name.slice(0, 120)) + "; its locations come from the screenplay's headings.");
      if (named.has(key)) throw new Error("Describe each location once.");
      named.add(key);
      const checked = bibleText(entry.description, STYLE_BIBLE_LIMIT.locationDescription);
      if (!("text" in checked)) throw new Error("The description of " + key + " can't be used (" + checked.reason.replaceAll("_", " ") + "): it must be text of up to "
        + STYLE_BIBLE_LIMIT.locationDescription + " characters that passes the content policy and names no public figure.");
      target.description = checked.text;
    }
  }
  const candidate = {...fields, locations, characters: current.characters};
  if (!checkPrompt(styleBibleText(candidate)).allowed) throw new Error("The style bible, taken as a whole, falls outside the content policy. Reword it; nothing was saved.");
  const unchanged = STYLE_FIELDS.every(field => fields[field] === current[field]) && locations.every((entry, index) => entry.description === current.locations[index]!.description);
  if (unchanged) return current;
  return styleBible({version: current.version + 1, scriptVersion: current.scriptVersion, source: "creator", ...fields, characters: current.characters, locations});
}

/**
 * The bible a later plan step keeps (written once): the same six lines; each location the script still
 * has keeps its description and a new one gets the stand-in's; the characters are the cast's as it now
 * is. It is a new version only if something changed, so sequences already made say which they read.
 */
export function carriedStyleBible(previous: StyleBible, fresh: {scriptVersion: number; characters: BibleCharacter[]; locations: BibleLocation[]}): StyleBible {
  const locations = fresh.locations.map(entry => previous.locations.find(old => old.name === entry.name) ?? entry);
  const next = styleBible({version: previous.version, scriptVersion: fresh.scriptVersion, source: previous.source,
    ...Object.fromEntries(STYLE_FIELDS.map(field => [field, previous[field]])) as Record<StyleField, string>, characters: fresh.characters, locations});
  if (next.revision === previous.revision) return previous;
  return styleBible({...next, version: previous.version + 1});
}

/** The block every sequence render's shot prompt carries: the feature's look, and this shot's location. */
export function stylePrompt(bible: StyleBible, location?: BibleLocation): string {
  return "Style bible (one look for the whole feature, the same in every sequence; preserve the screenplay action and the cast direction):\n"
    + STYLE_FIELDS.map(field => STYLE_FIELD_LABELS[field] + ": " + bible[field]).join("\n") + (location ? "\nLocation, " + location.name + ": " + location.description : "");
}

/**
 * The shots of a sequence render with the bible read into each prompt. Without a bible (a reel, a
 * short, or a feature planned before the bible existed) the shots are returned unchanged.
 */
export function bibleShots<T extends Shot>(shots: T[], parsed: ParseResult, bible?: StyleBible): T[] {
  if (!bible) return shots;
  return shots.map(shot => {
    const heading = parsed.scenes.find(scene => scene.index === shot.sceneIndex)?.heading ?? "";
    const name = headingLocation(heading), location = bible.locations.find(entry => entry.name === name);
    const prompt = shot.prompt + "\n" + stylePrompt(bible, location);
    if (prompt.length > 30_000) throw new Error("This shot has too much direction with the style bible. Shorten its notes or the bible.");
    gateOrThrow(prompt);
    return {...shot, prompt};
  });
}

/**
 * A render job carries a bible only as a feature's sequence render that names its revision, and a
 * sequence that names a revision carries that bible.
 */
export function validateStyleBibleJob(job: {styleBible?: unknown; sequence?: {bibleRevision?: string}}): void {
  if (job.styleBible === undefined && job.sequence?.bibleRevision === undefined) return;
  if (job.styleBible === undefined || !job.sequence) throw new Error("Only a feature's sequence render reads a style bible.");
  const bible = validateStyleBible(job.styleBible);
  if (job.sequence.bibleRevision !== bible.revision) throw new Error("A render's style bible is not the one its sequence names.");
}

/**
 * The bible a plan step stores for a feature: the Showrunner's lines (or, written once, the bible the
 * feature already has, carried forward) with the characters of the cast this plan leaves. If the whole
 * fails the gate with the cast beside it, the characters are left out with that reason; the render
 * still takes each character's look from the cast.
 */
export function plannedStyleBible(options: {previous?: StyleBible; style: BibleStyle; source: BibleSource; scriptVersion: number;
  cast: readonly CastCharacter[]; parsed: ParseResult; locations: BibleLocation[]}): {bible: StyleBible; dropped: BibleDrop[]} {
  const {previous, style, source, scriptVersion, parsed} = options;
  const build = (characters: BibleCharacter[]) => previous ? carriedStyleBible(previous, {scriptVersion, characters, locations: options.locations})
    : styleBible({version: 1, scriptVersion, source, ...Object.fromEntries(STYLE_FIELDS.map(field => [field, style[field]])) as Record<StyleField, string>,
      characters, locations: style.locations});
  const {characters, dropped} = bibleCharacters(options.cast, parsed);
  const bible = build(characters);
  if (checkPrompt(styleBibleText(bible)).allowed) return {bible, dropped};
  return {bible: build([]), dropped: [...dropped, {field: "characters", reason: "gate_refused"}]};
}
