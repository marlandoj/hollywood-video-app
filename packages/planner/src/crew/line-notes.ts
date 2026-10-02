import { createHash } from "node:crypto";
import { askCrewModel, CrewAnswerUnusable, crewUnusableReason, type CrewModel, type CrewUnusableReason, type CrewVendor } from "../../../generator/src/crew-model";
import type { CrewAlert, CrewLedger } from "../../../operator/src/crew-ledger";
import type { CrewLedgerReader } from "../../../storage/src/crew-ledger";
import { parseFountain, scanProtectedSpans } from "../../../parser/src/index";
import { checkPrompt } from "../../../safety/src/index";
import { PERSONAS, PERSONA_IDS, type PersonaId } from "./personas";

/**
 * The crew's line notes (HV-016-32): the crew suggests script revisions, and the writer takes them one
 * line at a time.
 *
 * A note replaces the text of exactly one physical line of the saved screenplay. It is bound to the
 * version (and its SHA-256) it was written against, and it names the line's current text, so a note
 * can never land on a line that has moved or changed. Applying keeps every other byte: the line's own
 * indentation, trailing spaces and line ending, and every other line, CRLF included.
 *
 * A note may reword a line, never restructure the script: the parser must read the result as the same
 * scenes, beats, speakers and line counts. Dialogue stays dialogue and action stays action.
 *
 * Every `after` and `reason` passes the prompt gate. A note the gate refuses is dropped from the
 * proposal and never shown; the proposal says only how many were dropped. With no crew model, the
 * stand-in writes no notes and says so: it never invents an edit.
 *
 * HV-016-35: the crew is shown which lines it may change (unlocked spoken lines and action lines),
 * each with its number, and answers with a line number and the replacement. The studio takes `before`
 * from the script itself, so it is always the line's exact text. Every note it can't use is counted
 * under a fixed reason code, and an answer it can't read says why instead of passing as "no notes".
 */
export const LINE_NOTE_LIMITS = Object.freeze({notes: 12, text: 1000, reason: 300, request: 300});
export interface ScriptRef { version: number; sha256: string }
export interface LineNote {
  id: string; persona: PersonaId;
  /** One-based physical line, as the parser's beats count them. */
  line: number;
  /** The line's current text, without its surrounding whitespace or line ending (both are kept). */
  before: string;
  after: string; reason: string;
}
export interface LineNotesInput { request: string }
export interface LineNotesResult {
  schema: "hv-crew-line-notes/1";
  script: ScriptRef;
  notes: LineNote[];
  message: string;
  /** The vendor that answered (HV-030-24), or the stand-in. */
  source: CrewVendor | "stand-in";
  fallbackReason?: "model_unusable" | "model_unavailable" | "content_policy";
  /** How many of the model's notes were dropped (unsafe, stale, restructuring or malformed). Never their text. */
  dropped: number;
  /** HV-016-35: `dropped`, counted by reason. Only reasons with a count appear; `{}` when nothing was dropped. */
  droppedReasons: Partial<Record<LineNoteDropReason, number>>;
  /**
   * HV-030-25: with `model_unusable`, what was wrong with the paid answer: a fixed code, never its text.
   * From the vendor (`cut_off`, `empty`, `refused_by_model`, `bad_shape`), or from reading the text:
   * `no_json` (no JSON in it) or `bad_shape` (JSON, but no list of notes; HV-016-35).
   */
  unusableReason?: CrewUnusableReason;
  crewSpend: {usd: number; alerts: CrewAlert[]};
}

/**
 * Why a note from the crew wasn't used (HV-016-35). Each dropped note is counted under exactly one:
 * the first check it fails, in the order `validateLineNotes` runs them.
 * - `unknown_line`: no such line, a blank line, or the note quotes a different line than it numbers.
 * - `locked_line`: a heading, character cue, parenthetical, transition or title-page line, or one
 *   holding a `[[note]]` or boneyard. The crew changes only spoken lines and action.
 * - `unchanged`: the replacement is the line as it is.
 * - `too_long`: the replacement or the reason is over its limit.
 * - `element_change`: it adds a line, or the parser would read the line as another kind.
 * - `gate_refused`: the prompt gate refused the replacement, its reason, or the script with it.
 * - `duplicate`: a second note on a line already noted.
 * - `malformed`: not a note: an unknown crew member, a missing or empty field, control characters
 *   or Fountain note syntax.
 * - `too_many`: past the first 12.
 */
export const LINE_NOTE_DROP_REASONS = Object.freeze(["unknown_line", "locked_line", "unchanged", "too_long", "element_change", "gate_refused", "duplicate", "malformed", "too_many"] as const);
export type LineNoteDropReason = typeof LINE_NOTE_DROP_REASONS[number];
/** A note refused for a reason the writer can act on, with its code. */
class NoteRefused extends Error {
  override name = "NoteRefused";
  constructor(readonly code: LineNoteDropReason, message: string) { super(message); }
}

/** A note bound to a version that is no longer the current script. The route answers 409. */
export class LineNoteConflict extends Error { override name = "LineNoteConflict"; }

export const scriptSha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export const scriptRef = (script: {version: number; text: string}): ScriptRef => ({version: script.version, sha256: scriptSha256(script.text)});

const fail = (message: string): never => { throw new Error(message); };
const refuse = (code: LineNoteDropReason, message: string): never => { throw new NoteRefused(code, message); };
const controlled = (text: string) => Array.from(text).some(character => {const code = character.charCodeAt(0); return code === 127 || (code < 32 && code !== 9) || (code >= 128 && code <= 159) || code === 8232 || code === 8233;});
const PROTECTED = /\[\[|\]\]|\/\*|\*\//;

interface PhysicalLine { raw: string; start: number; end: number; locked: boolean }
/** Physical lines split on LF or CRLF, as `parseFountain` splits them, with each line's offsets. */
function physical(text: string): PhysicalLine[] {
  const pieces = text.split(/(\r\n|\n)/), lines: PhysicalLine[] = [];
  let offset = 0, block = false;
  for (let i = 0; i < pieces.length; i += 2) {
    const raw = pieces[i]!, ending = pieces[i + 1] ?? "";
    // What the parser shows of this line, computed as `parseFountain` computes it: a boneyard that
    // closes on this line can reopen later on it, so the rest of the line is scanned again rather
    // than taken as visible. A line whose shown text isn't what the writer wrote holds a note or
    // boneyard, and a note never touches it; nor a line with a lone CR.
    // A line that starts inside a boneyard is locked whole, and may close it and open another.
    if (block) {
      const closer = raw.indexOf("*/");
      if (closer >= 0) block = scanProtectedSpans(raw.slice(closer + 2)).opensBlock;
      lines.push({raw, start: offset, end: offset + raw.length, locked: true});
    } else {
      const scan = scanProtectedSpans(raw);
      block = scan.opensBlock;
      lines.push({raw, start: offset, end: offset + raw.length, locked: scan.text !== raw || raw.includes("\r")});
    }
    offset += raw.length + ending.length;
  }
  return lines;
}

/** What a note must not change: the scenes, each beat's kind, lines and speaker, and what the parser could not read. */
function structure(text: string): string {
  const parsed = parseFountain(text);
  return JSON.stringify({rejected: parsed.rejected, unparseable: parsed.unparseable.map(entry => entry.line),
    scenes: parsed.scenes.map(scene => (scene.beats ?? []).map(beat => [beat.kind, beat.startLine, beat.endLine, beat.kind === "dialogue" ? beat.character + "/" + beat.lines.length : ""]))});
}

function replaceLines(text: string, lines: PhysicalLine[], notes: LineNote[]): string {
  let out = "", at = 0;
  for (const note of [...notes].sort((a, b) => a.line - b.line)) {
    const line = lines[note.line - 1]!;
    const lead = line.raw.slice(0, line.raw.length - line.raw.trimStart().length), trail = line.raw.slice(line.raw.trimEnd().length);
    out += text.slice(at, line.start) + lead + note.after + trail;
    at = line.end;
  }
  return out + text.slice(at);
}

/** One note's own shape, against the script it names. Throws with the reason a writer can act on. */
function checkNote(value: unknown, text: string, lines: PhysicalLine[], baseline: string): LineNote {
  const note = value as Record<string, unknown>;
  if (!note || typeof note !== "object" || Array.isArray(note) || Object.keys(note).some(key => !["id", "persona", "line", "before", "after", "reason"].includes(key)))
    refuse("malformed", "A line note has fields the studio doesn't use.");
  if (typeof note.id !== "string" || !/^n[1-9][0-9]?$/.test(note.id) || !PERSONA_IDS.includes(note.persona as PersonaId)) refuse("malformed", "A line note has no crew member or id.");
  if (!Number.isSafeInteger(note.line) || (note.line as number) < 1 || (note.line as number) > lines.length) refuse("unknown_line", "Line note " + note.id + " names a line the script doesn't have.");
  for (const key of ["before", "after", "reason"] as const) {
    const field = note[key];
    if (typeof field !== "string") refuse("malformed", "Line note " + note.id + " is too long or not text.");
    if ((field as string).length > (key === "reason" ? LINE_NOTE_LIMITS.reason : LINE_NOTE_LIMITS.text)) refuse("too_long", "Line note " + note.id + " is too long or not text.");
  }
  const before = note.before as string, after = note.after as string, reason = note.reason as string;
  if (/[\r\n\u2028\u2029]/.test(after)) refuse("element_change", "Line note " + note.id + " would add a line. A note changes one line only.");
  if (!after.trim() || after !== after.trim() || !reason.trim() || controlled(after) || controlled(reason) || PROTECTED.test(after)) refuse("malformed", "Line note " + note.id + " is not one plain line of script.");
  if (after === before) refuse("unchanged", "Line note " + note.id + " changes nothing.");
  // The gate reads what the note would put in the script, with the reason beside it, as one request.
  if (!checkPrompt(after).allowed || !checkPrompt(after + "\n" + reason).allowed) refuse("gate_refused", "Line note " + note.id + " falls outside the content policy.");
  const line = lines[(note.line as number) - 1]!;
  if (line.locked) refuse("locked_line", "Line note " + note.id + " is on a line that holds a note or boneyard; the crew doesn't change those.");
  if (!before || line.raw.trim() !== before) refuse("unknown_line", "Line note " + note.id + " no longer matches line " + note.line + ". Ask the crew again.");
  const typed = {id: note.id as string, persona: note.persona as PersonaId, line: note.line as number, before, after, reason: reason.trim()};
  if (structure(replaceLines(text, lines, [typed])) !== baseline) refuse("element_change", "Line note " + note.id + " would change what kind of line " + note.line + " is. A note may reword a line, not restructure the script.");
  return typed;
}

/**
 * Applies only the accepted notes to the script they were written against. Refuses, and changes
 * nothing, when the script is not that version, a note's `before` no longer matches, two accepted notes
 * share a line, a note would add a line or change the line's element type, or a note fails the gate.
 */
export function applyLineNotes(script: {version: number; text: string}, bound: {script: ScriptRef; notes: unknown}, acceptedIds: unknown): {text: string; applied: LineNote[]} {
  if (!bound || typeof bound !== "object" || !bound.script || !Number.isSafeInteger(bound.script.version) || typeof bound.script.sha256 !== "string")
    fail("Send the script version the crew's notes were written against.");
  if (script.version !== bound.script.version || scriptSha256(script.text) !== bound.script.sha256)
    throw new LineNoteConflict("The script changed since the crew wrote these notes. Ask the crew again; nothing was changed.");
  if (!Array.isArray(bound.notes) || bound.notes.length > LINE_NOTE_LIMITS.notes) fail("Send the crew's notes as they were given, at most " + LINE_NOTE_LIMITS.notes + ".");
  if (!Array.isArray(acceptedIds) || !acceptedIds.length || acceptedIds.some(id => typeof id !== "string") || new Set(acceptedIds).size !== acceptedIds.length)
    fail("Accept at least one note, each once.");
  const ids = (bound.notes as {id?: unknown}[]).map(note => note?.id);
  if (new Set(ids).size !== ids.length) fail("Two of the crew's notes share an id.");
  if ((acceptedIds as string[]).some(id => !ids.includes(id))) fail("An accepted note isn't one of the crew's notes.");
  const lines = physical(script.text), baseline = structure(script.text);
  const accepted = (bound.notes as unknown[]).filter((_, index) => (acceptedIds as string[]).includes(ids[index] as string)).map(note => checkNote(note, script.text, lines, baseline));
  const taken = new Set<number>();
  for (const note of accepted) { if (taken.has(note.line)) fail("Two accepted notes change line " + note.line + ". Take one of them."); taken.add(note.line); }
  const text = replaceLines(script.text, lines, accepted);
  if (structure(text) !== baseline) fail("Together, these notes would restructure the script. Take them one at a time.");
  if (!text.trim() || text.length > 200_000) fail("The script must stay within 1-200000 characters.");
  return {text, applied: accepted};
}

/** The writer's optional "what to work on", gated like any creator text the crew is given. */
export function lineNotesInput(value: unknown): LineNotesInput {
  const input = (value ?? {}) as Record<string, unknown>;
  if (typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => key !== "request")) fail("Ask the crew for line notes with an optional request, nothing else.");
  const raw = input.request ?? "";
  if (typeof raw !== "string" || raw.length > LINE_NOTE_LIMITS.request) fail("Say what the crew should work on in " + LINE_NOTE_LIMITS.request + " characters or fewer.");
  const request = (raw as string).trim();
  const unusable = Array.from(raw as string).some(character => {const code = character.charCodeAt(0); return code === 127 || (code < 32 && ![9, 10, 13].includes(code));});
  if (unusable || (request && !checkPrompt(request).allowed))
    fail("The crew can't work on this request: it names a real person or falls outside the content policy. Say it in your own words -- nothing was sent to the crew.");
  return {request};
}

/**
 * The lines a crew note may change (HV-016-35): spoken lines and action lines, as the parser reads
 * them, shown whole. Never a heading, a character cue, a parenthetical, a transition, a title-page
 * line or a blank line, nor a line holding a note or boneyard. Also where each scene's heading is, so
 * the crew can find "the last scene".
 */
function changeable(text: string, lines: PhysicalLine[]): {candidates: Set<number>; headings: number[]} {
  const parsed = parseFountain(text), candidates = new Set<number>();
  const open = (number: number) => { const line = lines[number - 1]; return !!line && !line.locked && !!line.raw.trim(); };
  for (const scene of parsed.scenes) for (const beat of scene.beats ?? []) {
    if (beat.kind === "action") { if (open(beat.startLine) && lines[beat.startLine - 1]!.raw.trim() === beat.text) candidates.add(beat.startLine); }
    else if (beat.kind === "dialogue") {
      // A speech that began at its cue starts on the cue's line, and the cue is never changed. (One that
      // carries on after a transition inside it starts on a spoken line.)
      const cued = !beat.lines.length || lines[beat.startLine - 1]?.raw.trim() !== beat.lines[0];
      for (let number = beat.startLine + (cued ? 1 : 0); number <= beat.endLine; number++)
        if (open(number) && !/^\(.*\)$/.test(lines[number - 1]!.raw.trim())) candidates.add(number);
    }
  }
  const headings: number[] = [];
  let from = 0;
  for (const scene of parsed.scenes) {
    const at = lines.findIndex((line, index) => index >= from && !line.locked && [scene.heading, "." + scene.heading].includes(line.raw.trim()));
    if (at >= 0) { headings.push(at + 1); from = at + 1; }
  }
  return {candidates, headings};
}

export function lineNotesPrompt(scriptText: string, input: LineNotesInput): {system: string; user: string} {
  const crew = PERSONAS.map(persona => "- " + persona.id + " (" + persona.title + "): owns " + persona.department + ".").join("\n");
  const system = "You are the writers' room of an AI film studio, giving a writer line notes on their screenplay. Crew:\n" + crew
    + "\n\nEach note replaces the text of exactly one line you may change: the lines that start with their number. Lines that start with \"-| \" "
    + "(headings, character cues, parentheticals, transitions, the title page, notes and blank lines) are there to read, never to change. "
    + "Keep what the line is: dialogue stays dialogue and action stays action. Never add, split, join or remove lines, and never put a line break in a note. "
    + "Give the line's number in \"line\" and its whole new text in \"after\", without the number or \"| \". "
    + "Never name or depict real public figures. When the writer asks for something, answer it with notes on the lines it is about; give none only if none of those lines can be improved. "
    + "Give at most " + LINE_NOTE_LIMITS.notes + " notes, each \"after\" under " + LINE_NOTE_LIMITS.text + " characters and each \"reason\" one short sentence. "
    + "Reply with JSON only, no prose, in exactly this shape: "
    + '{"notes": [{"persona": one of ' + JSON.stringify(PERSONA_IDS) + ', "line": number, "after": string, "reason": string}]}';
  const lines = physical(scriptText), {candidates, headings} = changeable(scriptText, lines), rows: string[] = [];
  lines.forEach((line, index) => {
    const at = headings.indexOf(index + 1);
    if (at >= 0) rows.push("== Scene " + (at + 1) + " of " + headings.length + (at + 1 === headings.length ? ", the last scene" : "") + " ==");
    rows.push((candidates.has(index + 1) ? String(index + 1) : "-") + "| " + line.raw);
  });
  const user = "What the writer asked the crew to work on: " + (input.request || "not stated; use your judgement")
    + ".\n\nScript. A line you may change starts with its number and \"| \"; any other line starts with \"-| \". Neither is part of the line. "
    + "A line \"== Scene … ==\" marks where a scene starts and isn't part of the script.\n" + rows.join("\n");
  return {system, user};
}

/**
 * Reads the list of notes out of the model's answer (HV-016-35): `{"notes": [...]}` or a bare array,
 * alone, in a code fence, or with prose around it. An answer with no JSON throws `CrewAnswerUnusable`
 * with `no_json`; JSON that isn't a list of notes, with `bad_shape` (HV-030-25's codes). Never "no notes".
 */
export function readLineNotesAnswer(text: string): unknown[] {
  const trimmed = text.trim(), tries = [trimmed];
  for (const fence of trimmed.matchAll(/```[A-Za-z0-9_-]*[ \t]*\r?\n?([\s\S]*?)```/g)) tries.push(fence[1]!.trim());
  // The outermost brackets or braces, whichever opens first, then the other.
  const spans = ([["{", "}"], ["[", "]"]] as const).map(([open, close]) => ({start: trimmed.indexOf(open), end: trimmed.lastIndexOf(close)}))
    .filter(span => span.start >= 0 && span.end > span.start).sort((a, b) => a.start - b.start);
  for (const span of spans) tries.push(trimmed.slice(span.start, span.end + 1));
  for (const attempt of tries) {
    let value: unknown;
    try { value = JSON.parse(attempt); } catch { continue; }
    if (Array.isArray(value)) return value;
    if (value && typeof value === "object" && Array.isArray((value as {notes?: unknown}).notes)) return (value as {notes: unknown[]}).notes;
    throw new CrewAnswerUnusable("no notes", "bad_shape");
  }
  throw new CrewAnswerUnusable("no JSON", "no_json");
}

/** Letters and digits only, case-folded: enough to tell a quoted line from another, whatever its quotes, spacing or cue. */
const loose = (text: string) => text.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
/** A `before` the model sent anyway must be the line it numbers, give or take quotes, punctuation, spacing or the cue. */
const quotes = (quoted: string, line: string) => { const a = loose(quoted), b = loose(line); return !a || a.includes(b) || b.includes(a); };

/**
 * Reads the model's answer. The answer names each note's line by number; the note's `before` is that
 * line's exact text, taken from the script. Each note that fails any check is dropped (never
 * repaired) and counted under its reason, the rest keep their order, and a second note on a line
 * already noted is dropped too. An answer with no list of notes throws `CrewAnswerUnusable`.
 */
export function validateLineNotes(text: string, scriptText: string): {notes: LineNote[]; dropped: number; droppedReasons: Partial<Record<LineNoteDropReason, number>>} {
  const raw = readLineNotesAnswer(text);
  const lines = physical(scriptText), baseline = structure(scriptText), {candidates} = changeable(scriptText, lines);
  const notes: LineNote[] = [], taken = new Set<number>(), droppedReasons: Partial<Record<LineNoteDropReason, number>> = {};
  const drop = (code: LineNoteDropReason, count = 1) => { if (count > 0) droppedReasons[code] = (droppedReasons[code] ?? 0) + count; };
  drop("too_many", raw.length - LINE_NOTE_LIMITS.notes);
  for (const item of raw.slice(0, LINE_NOTE_LIMITS.notes)) {
    try {
      if (!item || typeof item !== "object" || Array.isArray(item)) refuse("malformed", "not a note");
      const entry = item as Record<string, unknown>;
      const number = typeof entry.line === "string" && /^\s*[0-9]{1,7}\s*$/.test(entry.line) ? Number(entry.line) : entry.line as number;
      if (!Number.isSafeInteger(number) || number < 1 || number > lines.length || !lines[number - 1]!.raw.trim()) refuse("unknown_line", "no such line");
      if (!candidates.has(number)) refuse("locked_line", "not a line the crew changes");
      const before = lines[number - 1]!.raw.trim();
      if (typeof entry.before === "string" && !quotes(entry.before, before)) refuse("unknown_line", "quotes another line");
      // An "after" sent with its line's number in front, as the script was shown, is the text after it.
      const after = typeof entry.after === "string" ? entry.after.trim().replace(new RegExp("^" + number + "\\|[ \\t]?"), "").trim() : entry.after;
      const note = checkNote({id: "n" + (notes.length + 1), persona: typeof entry.persona === "string" ? entry.persona.trim().toLowerCase() : entry.persona,
        line: number, before, after, reason: entry.reason}, scriptText, lines, baseline);
      if (taken.has(note.line)) refuse("duplicate", "line already noted");
      // HV-030-19's lesson: the gate's paired rules read a whole request, so the note is also read in
      // the script it would change. A note that makes the script fail is never shown.
      if (!checkPrompt(replaceLines(scriptText, lines, [note])).allowed) refuse("gate_refused", "the script with it");
      taken.add(note.line); notes.push(note);
    } catch (error) { drop(error instanceof NoteRefused ? error.code : "malformed"); }
  }
  return {notes, dropped: Object.values(droppedReasons).reduce((sum, count) => sum + count, 0), droppedReasons};
}

/** How a reason reads to the writer, for one note. Fixed text: never the model's own words. */
const DROP_REASON_TEXT: Readonly<Record<LineNoteDropReason, string>> = Object.freeze({
  unknown_line: "it named a line the script doesn't have, or quoted a different line than it numbered",
  locked_line: "it named a line the crew doesn't change (a heading, a character cue, a parenthetical, a transition, or a line holding a note or boneyard)",
  unchanged: "it left the line as it is",
  too_long: "it was too long",
  element_change: "it would have changed what kind of line it is",
  gate_refused: "it fell outside the studio's content policy",
  duplicate: "it repeated a line already noted",
  malformed: "it wasn't in the shape the studio asked for",
  too_many: "it was past the limit of " + LINE_NOTE_LIMITS.notes + " notes",
});
/** How each `unusableReason` reads to the writer. Fixed text: never the model's own words. */
const UNUSABLE_TEXT: Readonly<Record<CrewUnusableReason, string>> = Object.freeze({
  cut_off: "the crew model's reply was cut off at its length limit",
  empty: "the crew model's reply was empty",
  refused_by_model: "the crew model declined to answer, or its vendor withheld the reply",
  no_json: "it wasn't the list of notes the studio asked for",
  bad_shape: "it had no list of notes the studio could read",
  gate_refused: "it fell outside the studio's content policy",
  too_long: "it was too long",
  unknown_persona: "it named a crew member the studio doesn't have",
});

/** The most common reason a note was dropped; ties go to the one listed first in `LINE_NOTE_DROP_REASONS`. */
export function topDropReason(reasons: Partial<Record<LineNoteDropReason, number>>): LineNoteDropReason | null {
  let top: LineNoteDropReason | null = null;
  for (const code of LINE_NOTE_DROP_REASONS) if ((reasons[code] ?? 0) > (top ? reasons[top]! : 0)) top = code;
  return top;
}

const UNCHANGED = " Your script is unchanged.";
export async function runLineNotes(options: {
  script: {version: number; text: string}; input: LineNotesInput; projectId: string;
  model: CrewModel | null; ledger: CrewLedger | CrewLedgerReader; now?: () => Date;
}): Promise<LineNotesResult> {
  const {script, input, projectId, model, ledger} = options;
  const now = options.now ?? (() => new Date());
  const base = {schema: "hv-crew-line-notes/1" as const, script: scriptRef(script), notes: [] as LineNote[], dropped: 0, droppedReasons: {}};
  const standIn = (message: string, fallbackReason?: LineNotesResult["fallbackReason"], usd = 0, alerts: CrewAlert[] = [], unusableReason?: CrewUnusableReason): LineNotesResult =>
    ({...base, message: message + UNCHANGED, source: "stand-in", ...(fallbackReason ? {fallbackReason} : {}), ...(unusableReason ? {unusableReason} : {}), crewSpend: {usd, alerts}});
  // The stand-in never invents an edit: without a model, there are no notes.
  if (!model) return standIn("No crew model is connected on this studio, so the crew wrote no line notes.");
  const prompt = lineNotesPrompt(script.text, input);
  // A script the gate refuses, alone or with the writer's request beside it, is never sent.
  if (!checkPrompt(script.text).allowed || !checkPrompt(prompt.user).allowed)
    return standIn("The crew can't read this script" + (input.request ? " with this request" : "") + ": it falls outside the studio's content policy, so nothing was sent.", "content_policy");
  await ledger.assertCanSpend();
  const asked = await askCrewModel(model, {system: prompt.system, messages: [{role: "user", content: prompt.user}], maxTokens: 4000});
  if (!asked) return standIn("The crew model couldn't be reached, so the crew wrote no line notes.", "model_unavailable");
  const {completion} = asked;
  const alerts = await ledger.record({at: now().toISOString(), projectId, persona: "crew-line-notes", model: completion.model,
    inputTokens: completion.usage.inputTokens, outputTokens: completion.usage.outputTokens, usd: completion.costUsd});
  // HV-030-25's one vocabulary: the vendor's reason, or the reader's; HV-016-35 says it in the message too.
  const unusable = (reason: CrewUnusableReason) => standIn("The crew's answer couldn't be used: " + UNUSABLE_TEXT[reason] + ", so there are no line notes.",
    "model_unusable", completion.costUsd, alerts, reason);
  if (!asked.usable) return unusable(asked.reason);
  let read;
  try { read = validateLineNotes(completion.text, script.text); }
  catch (error) { return unusable(crewUnusableReason(error)); }
  const count = read.notes.length, offered = count + read.dropped, top = topDropReason(read.droppedReasons);
  // HV-016-35: an answer whose every note was dropped says so, with the commonest reason, never as "no changes".
  const message = count ? "The crew has " + count + " line note" + (count === 1 ? "" : "s") + ". Take the ones you want; nothing changes until you apply them."
    : !offered || !top ? "The crew read the script and has no line changes to suggest." + UNCHANGED
    : offered === 1 ? "The crew suggested 1 line note, but it couldn't be used: " + DROP_REASON_TEXT[top] + "." + UNCHANGED
    : "The crew suggested " + offered + " line notes, but none could be used. The most common reason, for " + read.droppedReasons[top] + " of them: "
      + DROP_REASON_TEXT[top] + "." + UNCHANGED;
  return {...base, notes: read.notes, dropped: read.dropped, droppedReasons: read.droppedReasons, message, source: model.name, crewSpend: {usd: completion.costUsd, alerts}};
}
