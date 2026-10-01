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
  /** HV-030-25: with `model_unusable`, what was wrong with the paid answer: a fixed code, never its text. */
  unusableReason?: CrewUnusableReason;
  /** How many of the model's notes were dropped (unsafe, stale, restructuring or malformed). Never their text. */
  dropped: number;
  crewSpend: {usd: number; alerts: CrewAlert[]};
}

/** A note bound to a version that is no longer the current script. The route answers 409. */
export class LineNoteConflict extends Error { override name = "LineNoteConflict"; }

export const scriptSha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export const scriptRef = (script: {version: number; text: string}): ScriptRef => ({version: script.version, sha256: scriptSha256(script.text)});

const fail = (message: string): never => { throw new Error(message); };
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
    fail("A line note has fields the studio doesn't use.");
  if (typeof note.id !== "string" || !/^n[1-9][0-9]?$/.test(note.id) || !PERSONA_IDS.includes(note.persona as PersonaId)) fail("A line note has no crew member or id.");
  if (!Number.isSafeInteger(note.line) || (note.line as number) < 1 || (note.line as number) > lines.length) fail("Line note " + note.id + " names a line the script doesn't have.");
  for (const key of ["before", "after", "reason"] as const) {
    const field = note[key];
    if (typeof field !== "string" || field.length > (key === "reason" ? LINE_NOTE_LIMITS.reason : LINE_NOTE_LIMITS.text)) fail("Line note " + note.id + " is too long or not text.");
  }
  const before = note.before as string, after = note.after as string, reason = note.reason as string;
  if (/[\r\n\u2028\u2029]/.test(after)) fail("Line note " + note.id + " would add a line. A note changes one line only.");
  if (!after.trim() || after !== after.trim() || !reason.trim() || controlled(after) || controlled(reason) || PROTECTED.test(after)) fail("Line note " + note.id + " is not one plain line of script.");
  if (after === before) fail("Line note " + note.id + " changes nothing.");
  // The gate reads what the note would put in the script, with the reason beside it, as one request.
  if (!checkPrompt(after).allowed || !checkPrompt(after + "\n" + reason).allowed) fail("Line note " + note.id + " falls outside the content policy.");
  const line = lines[(note.line as number) - 1]!;
  if (line.locked) fail("Line note " + note.id + " is on a line that holds a note or boneyard; the crew doesn't change those.");
  if (!before || line.raw.trim() !== before) fail("Line note " + note.id + " no longer matches line " + note.line + ". Ask the crew again.");
  const typed = {id: note.id as string, persona: note.persona as PersonaId, line: note.line as number, before, after, reason: reason.trim()};
  if (structure(replaceLines(text, lines, [typed])) !== baseline) fail("Line note " + note.id + " would change what kind of line " + note.line + " is. A note may reword a line, not restructure the script.");
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

export function lineNotesPrompt(scriptText: string, input: LineNotesInput): {system: string; user: string} {
  const crew = PERSONAS.map(persona => "- " + persona.id + " (" + persona.title + "): owns " + persona.department + ".").join("\n");
  const system = "You are the writers' room of an AI film studio, giving a writer line notes on their screenplay. Crew:\n" + crew
    + "\n\nEach note replaces the text of exactly one numbered line. Keep what the line is: dialogue stays dialogue, action stays action, a heading stays a heading. "
    + "Never change a character cue, never add, split, join or remove lines, and never put a line break in a note. Quote the line's current text exactly in \"before\", without its number. "
    + "Never name or depict real public figures. Give at most " + LINE_NOTE_LIMITS.notes + " notes, only where a line clearly improves, and none if the script is fine; "
    + "each \"after\" under " + LINE_NOTE_LIMITS.text + " characters and each \"reason\" one short sentence. Reply with JSON only, no prose, in exactly this shape: "
    + '{"notes": [{"persona": one of ' + JSON.stringify(PERSONA_IDS) + ', "line": number, "before": string, "after": string, "reason": string}]}';
  const numbered = scriptText.split(/\r?\n/).map((line, index) => (index + 1) + "| " + line).join("\n");
  const user = "What the writer asked the crew to work on: " + (input.request || "not stated; use your judgement")
    + ".\n\nScript (each line starts with its number and \"| \", which are not part of the line):\n" + numbered;
  return {system, user};
}

/**
 * Reads the model's answer. An answer that isn't JSON with a `notes` array is unusable; inside it, each
 * note that fails any check is dropped (never repaired), the rest keep their order, and a second note
 * on a line already noted is dropped too.
 */
export function validateLineNotes(text: string, scriptText: string): {notes: LineNote[]; dropped: number} {
  const start = text.indexOf("{"), end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new CrewAnswerUnusable("no JSON", "no_json");
  const value = JSON.parse(text.slice(start, end + 1)) as {notes?: unknown};
  if (!value || !Array.isArray(value.notes)) throw new CrewAnswerUnusable("no notes", "bad_shape");
  const raw = value.notes as unknown[];
  const lines = physical(scriptText), baseline = structure(scriptText), notes: LineNote[] = [], taken = new Set<number>();
  let dropped = Math.max(0, raw.length - LINE_NOTE_LIMITS.notes);
  for (const item of raw.slice(0, LINE_NOTE_LIMITS.notes)) {
    const entry = item as Record<string, unknown>;
    try {
      if (!entry || typeof entry !== "object") fail("not a note");
      const note = checkNote({id: "n" + (notes.length + 1), persona: entry.persona, line: entry.line, before: typeof entry.before === "string" ? entry.before.trim() : entry.before,
        after: typeof entry.after === "string" ? entry.after.trim() : entry.after, reason: entry.reason}, scriptText, lines, baseline);
      // HV-030-19's lesson: the gate's paired rules read a whole request, so the note is also read in
      // the script it would change. A note that makes the script fail is never shown.
      if (taken.has(note.line) || !checkPrompt(replaceLines(scriptText, lines, [note])).allowed) fail("dropped");
      taken.add(note.line); notes.push(note);
    } catch { dropped++; }
  }
  return {notes, dropped};
}

const UNCHANGED = " Your script is unchanged.";
export async function runLineNotes(options: {
  script: {version: number; text: string}; input: LineNotesInput; projectId: string;
  model: CrewModel | null; ledger: CrewLedger | CrewLedgerReader; now?: () => Date;
}): Promise<LineNotesResult> {
  const {script, input, projectId, model, ledger} = options;
  const now = options.now ?? (() => new Date());
  const base = {schema: "hv-crew-line-notes/1" as const, script: scriptRef(script), notes: [] as LineNote[], dropped: 0};
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
  const unusable = (reason: CrewUnusableReason) => standIn("The crew's answer couldn't be used, so there are no line notes.", "model_unusable", completion.costUsd, alerts, reason);
  if (!asked.usable) return unusable(asked.reason);
  let read;
  try { read = validateLineNotes(completion.text, script.text); }
  catch (error) { return unusable(crewUnusableReason(error)); }
  const count = read.notes.length;
  const message = count ? "The crew has " + count + " line note" + (count === 1 ? "" : "s") + ". Take the ones you want; nothing changes until you apply them."
    : "The crew read the script and has no line changes to suggest.";
  return {...base, notes: read.notes, dropped: read.dropped, message, source: model.name, crewSpend: {usd: completion.costUsd, alerts}};
}
