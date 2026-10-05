import { createHash } from "node:crypto";
import type { ParseResult } from "../../parser/src/index";
import { gateOrThrow } from "../../safety/src/index";
import { MAX_CONDITIONING_INPUTS } from "../../generator/src/capabilities";
import { promptCharLimit, type ProviderPoolEntry } from "../../generator/src/catalog";
import { promptSize } from "../../generator/src/prompt-limits";
import type { Shot } from "./index";
import { CAST_DIRECTION_HEADER, REFERENCE_MAP_HEADER, castDirection, castProminence, characterDirectionFields, type CastCharacter, type CastingSnapshot } from "./casting";
import { DIRECTION_PROMPT_HEADER, directionPromptLines } from "./direction";
import { picturePerformancePrompt } from "./picture-performance";
import { STYLE_FIELD_LABELS, STYLE_PROMPT_HEADER, sceneBibleLocation, stylePromptLines, type StyleBible } from "./style-bible";

/**
 * HV-019-19: a shot's prompt fitted to its provider's prompt limit, before anything is paid for.
 *
 * Release 3's live run (G23) stopped when fal's Kling refused a final's prompt at result time: `422
 * string_too_long ... at most 2500 characters`. A shot's prompt is its scene heading and action, then
 * the cast direction, the reference map, the picture performance, the shot direction and, in a feature,
 * the style bible. Nothing bounded the whole, and the mock took any length.
 *
 * **The limit.** Each pool entry declares one in the catalogue or none (`promptCharLimit`). A shot's
 * limit is the smallest declared by the pool's providers that take its number of reference images, as
 * the router would choose among them (`poolPromptLimits`): on `live-film-referenced`, Kling O3 reference
 * for a shot with images (2,500 less its own numbered image note) and Kling 2.5 for one without (2,500).
 * The stills (FLUX) declare none, so a rough cut's prompts are never cut.
 *
 * **What is cut, in order.** Only as much as the limit needs, one part at a time:
 * 1. the style bible's location line (the heading names the place, the action describes it);
 * 2. the style bible's sound line (the picture is silent);
 * 3. the shot direction's sound and transition intent (neither is picture);
 * 4. the style bible's tone, lens and framing, palette, lighting and look lines, in that order;
 * 5. the shot direction's other lines, last first;
 * 6. the picture performance direction;
 * 7. each character's scene performance intent, last character first;
 * 8. unlocked characters' cast direction, least prominent first, down to the character's name;
 * 9. locked characters' relationships and character arc, least prominent first (neither says how they look);
 * 10. the action, down to its first {@link ACTION_MIN_CHARS} characters.
 * A part is dropped whole, or shortened at a word boundary and marked with "..." ({@link CUT_MARK}); never
 * mid-word. A block
 * whose lines are all dropped loses its header too.
 *
 * **Never cut.** The scene heading; the cast direction's header; every other sentence of a locked
 * character's cast direction (its name, appearance, age, ethnicity, body, hair and makeup, wardrobe,
 * expressions, movement and what to preserve: the identity the lock holds); the reference map; anything the planner can't
 * match exactly to the part it built. If the prompt still doesn't fit, the shot is refused
 * (`PromptFitError`) at admission, where nothing has been paid.
 *
 * **Measured with `promptSize`** (HV-019-21; generator/src/prompt-limits.ts): the limit, every size and every
 * cut. It counts a prompt as JSON writes it with every non-ASCII character escaped, plus an allowance for each
 * `@ImageN` token, because fal refused a fitted prompt that was 2,499 UTF-8 bytes (G23's second resume). The
 * cut mark is ASCII.
 *
 * **Recorded.** A fitted shot carries `promptFit`: the limit, the original and fitted sizes and
 * sha256s, and each part cut with its size before and after. It goes into the shot's provenance. A
 * shot within its limit is returned unchanged, byte for byte, with no record, so its input hash and any
 * render already made of it are unchanged. Both the whole and the fitted prompt pass the safety gate.
 */
/** HV-019-21: /3 counts `promptSize` (escaped characters and reference tokens); /2 counted UTF-8 bytes; /1 UTF-16 units. */
export const PROMPT_FIT_SCHEMA = "hv-prompt-fit/3" as const;
/** What a shortened part ends with: ASCII, so it costs what it shows. */
export const CUT_MARK = "...";
/** The action is never cut below this many characters (or its whole length, if shorter). */
export const ACTION_MIN_CHARS = 240;
export type PromptFitPart = "style" | "direction" | "picture-performance" | "performance-intent" | "cast-unlocked" | "cast-locked" | "action";
export interface PromptTrim { part: PromptFitPart; label: string; fromSize: number; toSize: number }
export interface ShotPromptFit {
  schema: typeof PROMPT_FIT_SCHEMA;
  /** The largest `promptSize` this shot's provider takes from the planner (a reference model's image note already counted). */
  limit: number;
  originalSize: number; fittedSize: number; originalSha256: string; fittedSha256: string;
  /** In the order they were cut. `toSize` 0 is a part dropped whole. */
  trimmed: PromptTrim[];
}
export class PromptFitError extends Error { override name = "PromptFitError"; }
/** A pool's prompt limit for each number of reference images a shot may carry (index), or null when it declares none. */
export type PromptLimits = (number | null)[] | null;

/**
 * The smallest prompt limit among the pool's providers that take a shot with each number of images; when
 * none takes that many, the smallest in the pool. Null when no provider in the pool declares a limit.
 */
export function poolPromptLimits(stage: string, pool: readonly ProviderPoolEntry[] | null | undefined): PromptLimits {
  if (!pool?.length) return null;
  const table = Array.from({length: MAX_CONDITIONING_INPUTS + 1}, (_, count) => {
    const takes = pool.filter(entry => entry.snapshot.lifecycle !== "retired" && count <= entry.snapshot.input.referenceFrames
      && count >= (entry.snapshot.input.minimumReferenceFrames ?? 0));
    const limits = (takes.length ? takes : pool).flatMap(entry => { const limit = promptCharLimit(stage, entry.spec, count); return limit === null ? [] : [limit]; });
    return limits.length ? Math.min(...limits) : null;
  });
  return table.some(limit => limit !== null) ? table : null;
}

interface Segment { text: string; part?: PromptFitPart; label?: string; rank?: number; keep?: number; droppable?: boolean; group?: "style" | "direction"; header?: "style" | "direction" }
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const STYLE_RANK: Record<string, number> = {location: 10, sound: 20, tone: 40, lens: 41, palette: 42, lighting: 43, look: 44};

/** The prompt split into the parts the planner built it from, or one unsplit part when they can't be matched exactly. */
function segmentsOf(shot: Shot, parsed: ParseResult, casting: CastingSnapshot | undefined, bible: StyleBible | undefined): Segment[] {
  let rest = shot.prompt;
  const tail: Segment[] = [];
  const take = (block: string) => { if (!block || !rest.endsWith(block)) return false; rest = rest.slice(0, rest.length - block.length); return true; };
  if (bible) {
    const lines = stylePromptLines(bible, sceneBibleLocation(bible, parsed, shot.sceneIndex));
    if (take("\n" + STYLE_PROMPT_HEADER + "\n" + lines.map(line => line.text).join("\n")))
      tail.unshift({text: "\n" + STYLE_PROMPT_HEADER, header: "style"}, ...lines.map(line => {
        const label = line.field === "location" ? "location" : STYLE_FIELD_LABELS[line.field];
        return {text: "\n" + line.text, part: "style" as const, label, rank: STYLE_RANK[line.field]!, droppable: true, group: "style" as const,
          keep: line.field === "location" ? line.text.length + 1 : ("\n" + STYLE_FIELD_LABELS[line.field] + ": ").length};
      }));
  }
  if (shot.direction) {
    const lines = directionPromptLines(shot.direction);
    if (lines.length && take("\n" + DIRECTION_PROMPT_HEADER + "\n" + lines.map(line => line.text).join("\n")))
      tail.unshift({text: "\n" + DIRECTION_PROMPT_HEADER, header: "direction"}, ...lines.map((line, index) => {
        const offPicture = line.key === "soundIntent" || line.key === "transitionIntent";
        return {text: "\n" + line.text, part: "direction" as const, label: line.key, rank: offPicture ? 30 + index / 100 : 50 + (lines.length - index) / 100,
          droppable: true, group: "direction" as const, keep: line.text.includes(": ") ? line.text.indexOf(": ") + 3 : line.text.length + 1};
      }));
  }
  if (shot.picturePerformance) {
    const block = "\n" + picturePerformancePrompt(shot.picturePerformance);
    if (take(block)) tail.unshift({text: block, part: "picture-performance", label: "picture performance", rank: 60, droppable: true, keep: block.length});
  }
  if (shot.referenceAssets?.length) {
    const at = rest.lastIndexOf("\n" + REFERENCE_MAP_HEADER + "\n");
    if (at >= 0) { tail.unshift({text: rest.slice(at)}); rest = rest.slice(0, at); }
  }
  const characters = (shot.characterIds ?? []).map(id => casting?.characters.find(character => character.id === id));
  if (characters.length && characters.every(Boolean)) {
    const directions = characters.map(character => ({character: character!, ...castDirection(character!, shot.sceneIndex, parsed)}));
    if (take("\n" + CAST_DIRECTION_HEADER + "\n" + directions.map(entry => entry.description + (entry.intent === null ? "" : "\n" + entry.intent)).join("\n"))) {
      const prominence = castProminence(directions.map(entry => entry.character), {prompt: shot.sourcePrompt ?? rest, dialogue: shot.dialogue});
      const cast: Segment[] = [{text: "\n" + CAST_DIRECTION_HEADER}];
      directions.forEach((entry, index) => {
        // Lower ranks are cut first: the least prominent character's direction, the last character's intent.
        const prominent = (prominence.length - prominence.indexOf(entry.character)) / 100, last = (directions.length - index) / 100;
        if (entry.character.referenceLock) cast.push(...lockedDirection(entry.character, entry.description, shot.sceneIndex + 1, prominent));
        else cast.push({text: "\n" + entry.description, part: "cast-unlocked", label: entry.character.name, rank: 80 + prominent, keep: ("\n" + entry.character.name + ".").length});
        if (entry.intent !== null) cast.push({text: "\n" + entry.intent, part: "performance-intent", label: entry.character.name, rank: 70 + last, droppable: true, keep: entry.intent.length + 1});
      });
      tail.unshift(...cast);
    }
  }
  // What is left must be exactly the base the planner started from: the heading, then the action.
  const heading = parsed.scenes.find(scene => scene.index === shot.sceneIndex)?.heading;
  const headers = [CAST_DIRECTION_HEADER, REFERENCE_MAP_HEADER, DIRECTION_PROMPT_HEADER, STYLE_PROMPT_HEADER].some(header => rest.includes("\n" + header));
  const base = shot.sourcePrompt === undefined ? !headers : rest === shot.sourcePrompt;
  const prefix = heading === undefined ? undefined : [heading + ". ", heading + "\n"].find(value => rest.startsWith(value));
  if (!base || prefix === undefined || rest.length === prefix.length) return [{text: rest}, ...tail];
  const action = rest.slice(prefix.length);
  return [{text: prefix}, {text: action, part: "action", label: "action", rank: 90, keep: Math.min(action.length, ACTION_MIN_CHARS)}, ...tail];
}

/** The cast direction sentences of a locked character that say nothing about how it looks: cut only after every unlocked character's. */
const LOCKED_CUTTABLE = ["Relationships", "Character arc"];
/**
 * A locked character's cast direction: its name and every sentence that carries its look stay whole; its
 * relationships and arc, which don't, may be dropped (least prominent character first). One unsplit part
 * when the sentences don't rebuild the description exactly.
 */
function lockedDirection(character: CastCharacter, description: string, sceneNumber: number, prominent: number): Segment[] {
  const fields = characterDirectionFields(character, sceneNumber);
  if (!fields.length || character.name + ". " + fields.map(field => field.text).join(" ") !== description) return [{text: "\n" + description}];
  const segments: Segment[] = [{text: "\n" + character.name + ". " + fields[0]!.text}];
  for (const field of fields.slice(1)) {
    const text = " " + field.text;
    segments.push(LOCKED_CUTTABLE.includes(field.label)
      ? {text, part: "cast-locked", label: character.name + ": " + field.label, rank: 85 + prominent + LOCKED_CUTTABLE.indexOf(field.label) / 1000, droppable: true, keep: text.length}
      : {text});
  }
  return segments;
}

/**
 * `text` cut to a `promptSize` of at most `max`, at a word boundary, marked {@link CUT_MARK}, and never below its first
 * `keep` characters; "" when dropped.
 */
function shorten(text: string, max: number, keep: number, droppable: boolean): string {
  if (promptSize(text) <= max) return text;
  const floor = droppable ? "" : text.slice(0, keep);
  if (max <= promptSize(text.slice(0, keep))) return floor;
  // A prefix's size never falls as it grows, so no cut longer than `bound` characters can fit: find `bound` by
  // halving and look for a word break only below it. (Measuring every break from the end was quadratic: 0.2 s for
  // a 25,000-character action once `promptSize` became a loop, and studio tests timed out behind it.)
  let low = keep, high = text.length - 1;
  while (low < high) { const middle = Math.ceil((low + high) / 2); if (promptSize(text.slice(0, middle) + CUT_MARK) <= max) low = middle; else high = middle - 1; }
  for (let at = low; at >= keep; at -= 1) {
    if (!/\s/.test(text[at]!)) continue;
    const cut = text.slice(0, at).trimEnd();
    if (cut.length < keep) return floor;
    if (promptSize(cut + CUT_MARK) <= max) return cut + CUT_MARK;
  }
  return floor;
}

/** One shot's prompt fitted to `limit`, or the shot unchanged when it already fits. */
export function fitShotPrompt(shot: Shot, limit: number | null, context: {parsed: ParseResult; casting?: CastingSnapshot; styleBible?: StyleBible}): Shot {
  if (limit === null || promptSize(shot.prompt) <= limit) return shot;
  gateOrThrow(shot.prompt);
  const segments = segmentsOf(shot, context.parsed, context.casting, context.styleBible), trimmed: PromptTrim[] = [];
  let excess = promptSize(shot.prompt) - limit;
  const order = segments.filter(segment => segment.part).sort((a, b) => a.rank! - b.rank!);
  for (const segment of order) {
    if (excess <= 0) break;
    const next = shorten(segment.text, promptSize(segment.text) - excess, segment.keep ?? 0, segment.droppable ?? false);
    if (next === segment.text) continue;
    trimmed.push({part: segment.part!, label: segment.label!, fromSize: promptSize(segment.text), toSize: promptSize(next)});
    excess -= promptSize(segment.text) - promptSize(next);
    segment.text = next;
    // A block whose lines are all gone loses its header with them.
    const header = segment.group && segments.find(value => value.header === segment.group);
    if (header && header.text && segments.every(value => value.group !== segment.group || !value.text)) {
      trimmed.push({part: segment.group!, label: "header", fromSize: promptSize(header.text), toSize: 0});
      excess -= promptSize(header.text);
      header.text = "";
    }
  }
  const prompt = segments.map(segment => segment.text).join("");
  if (promptSize(prompt) > limit) {
    const locked = (shot.characterIds ?? []).flatMap(id => { const character = context.casting?.characters.find(value => value.id === id); return character?.referenceLock ? [character.name] : []; });
    throw new PromptFitError("Shot " + shot.id + "'s prompt is " + promptSize(prompt) + " in fal's count after every cut the planner may make, and its provider takes at most " + limit
      + ". What is left is the scene heading, the action's opening" + (locked.length ? ", the cast direction of the locked characters (" + locked.join(", ") + ")" : "")
      + (shot.referenceAssets?.length ? " and the reference map" : "") + ". Shorten " + (locked.length ? "the locked characters' notes or " : "") + "the shot's action, then render again. Nothing was sent.");
  }
  gateOrThrow(prompt);
  return {...shot, prompt, promptFit: {schema: PROMPT_FIT_SCHEMA, limit, originalSize: promptSize(shot.prompt), fittedSize: promptSize(prompt),
    originalSha256: sha256(shot.prompt), fittedSha256: sha256(prompt), trimmed}};
}

/** Every shot fitted to its pool's limit for the images it carries (`poolPromptLimits`). Null limits leave every shot as it is. */
export function fitShotPrompts<T extends Shot>(shots: T[], limits: PromptLimits, context: {parsed: ParseResult; casting?: CastingSnapshot; styleBible?: StyleBible}): T[] {
  if (!limits) return shots;
  return shots.map(shot => fitShotPrompt(shot, limits[Math.min(shot.referenceAssets?.length ?? 0, MAX_CONDITIONING_INPUTS)] ?? null, context) as T);
}
