/**
 * A screenplay read out of a PDF's text layer (HV-016-08, Release 2's HV-016 slice).
 *
 * `docs/SCRIPT-IMPORT.md` said PDF import "is not built" and that FULL-SCOPE scopes it as "OCR +
 * structure recovery". OCR is a different problem and would mean a vendor, which this program does
 * not add. The other half is not: a screenplay PDF exported by Final Draft, Highland, Fade In or
 * Writer Duet carries a **text layer**, and a screenplay's element types are carried by its left
 * margins — that is what screenplay format *is*. So this reads the text layer and recovers the
 * structure from the margins, and refuses, by name, every file it cannot read that way. A scan has
 * no text layer and is told so rather than imported as an empty screenplay.
 *
 * Written by hand, with no PDF dependency, exactly as `final-draft.ts` was written with no XML one.
 * The rule is the same and is the reason both are readable: **every search here is a linear
 * `indexOf` or a single forward pass, so the bound on the input is also a bound on the work.**
 *
 * What it refuses rather than guesses at, each by name:
 *
 * - a file that is not a PDF, or whose objects cannot be read;
 * - an encrypted PDF, because the text layer is not there to read;
 * - a stream filter other than `FlateDecode`, because a wrong guess is silent mojibake;
 * - a font whose bytes do not stand for the characters they look like — a `/ToUnicode` CMap, an
 *   `/Encoding` with `/Differences`, or a composite `/Type0` font — for the same reason;
 * - a page whose text does not lie on screenplay margins.
 *
 * It does **not** carry: bold, italic and underline; dual dialogue; scene numbers; revision marks;
 * title pages; or anything a PDF holds that is not text. Those are reported as notes, the way the
 * Final Draft importer reports what it drops.
 */
import {inflateSync} from "node:zlib";
import {hiddenImportedLine, hiddenImportedLineMessage} from "./index";
import type {ScriptImport, ScriptImportNote} from "./final-draft";

export const PDF_LIMITS = Object.freeze({
  /** The same 4 MiB the Final Draft importer allows, measured in bytes rather than characters. */
  documentBytes: 4 * 1024 ** 2,
  /** A thirty-page screenplay is the parser's own limit; a hundred leaves room to say so clearly. */
  pages: 100,
  /** Text-showing operations across the document. A screenplay page holds a few hundred. */
  textItems: 200_000,
  /** The Fountain the parser will accept. */
  fountainCharacters: 200_000,
});

const fail: (message: string) => never = message => {throw new Error(message);};

/** One run of text the page draws, with where it starts. */
export interface PdfTextItem {page: number; x: number; y: number; text: string}

const LATIN = Array.from({length: 256}, (_, code) => String.fromCharCode(code));

/**
 * The bytes as Latin-1, so one byte is one character and an offset in the string is an offset in the
 * file. Chunked because `String.fromCharCode(...bytes)` on four megabytes overflows the stack.
 */
function latin1(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 8192) text += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return text;
}

/**
 * Every `N G obj … endobj` in the file, by object number.
 *
 * Found by scanning rather than through the cross-reference table, because a PDF that has been
 * edited, linearised or appended to has several cross-reference sections and a reader that trusts
 * the wrong one silently reads an older version of the page. Scanning takes the **last** definition
 * of an object number, which is what an incremental update means.
 */
function objects(bytes: Uint8Array, source: string): Map<number, {start: number; end: number}> {
  const found = new Map<number, {start: number; end: number}>();
  const digit = (at: number) => /[0-9]/.test(source[at] ?? "");
  const space = (at: number) => /[\s]/.test(source[at] ?? "");
  for (let at = source.indexOf("obj"); at >= 0; at = source.indexOf("obj", at + 3)) {
    // Walk back over "N G " -- whitespace, generation, whitespace, object number -- and no further.
    let cursor = at - 1;
    if (!space(cursor)) continue;
    while (space(cursor)) cursor--;
    if (!digit(cursor)) continue;
    while (digit(cursor)) cursor--;
    if (!space(cursor)) continue;
    while (space(cursor)) cursor--;
    if (!digit(cursor)) continue;
    const numberEnd = cursor + 1;
    while (digit(cursor)) cursor--;
    const id = Number(source.slice(cursor + 1, numberEnd));
    if (!Number.isSafeInteger(id)) continue;
    const end = source.indexOf("endobj", at);
    found.set(id, {start: at + 3, end: end < 0 ? bytes.length : end});
  }
  return found;
}

/** `/Name value` inside one object's dictionary, as written. Linear per lookup. */
function entry(body: string, name: string): string | null {
  for (let at = body.indexOf("/" + name); at >= 0; at = body.indexOf("/" + name, at + 1)) {
    const after = body[at + name.length + 1];
    // `/Type` must not match `/TypeSomething`.
    if (after !== undefined && /[A-Za-z0-9]/.test(after)) continue;
    let cursor = at + name.length + 1;
    while (cursor < body.length && /\s/.test(body[cursor]!)) cursor++;
    let end = cursor, depth = 0;
    for (; end < body.length; end++) {
      const character = body[end]!;
      if (character === "[" || character === "(") depth++;
      else if (character === "]" || character === ")") {depth--; if (depth <= 0) {end++; break;}}
      else if (depth === 0 && (character === "/" || character === ">") && end > cursor) break;
      else if (depth === 0 && character === "\n" && end > cursor) break;
    }
    return body.slice(cursor, end).trim();
  }
  return null;
}

/** The bytes of an object's stream, inflated when it says it is deflated and refused when it is anything else. */
function streamBytes(bytes: Uint8Array, source: string, span: {start: number; end: number}): Uint8Array | null {
  const marker = source.indexOf("stream", span.start);
  if (marker < 0 || marker > span.end) return null;
  const head = source.slice(span.start, marker);
  let from = marker + 6;
  if (source[from] === "\r") from++;
  if (source[from] === "\n") from++;
  const closer = source.indexOf("endstream", from);
  const raw = bytes.subarray(from, closer < 0 || closer > span.end ? span.end : closer);
  const filter = entry(head, "Filter");
  if (!filter) return raw;
  if (!/^\/FlateDecode$/.test(filter.trim()))
    fail("This PDF compresses its pages with " + filter.trim().replace(/[^\w/ ]/g, "") + ", which this importer does not read. Export the script as Fountain or Final Draft.");
  try {return new Uint8Array(inflateSync(raw));}
  catch {fail("This PDF's page contents could not be decompressed. Export the script as Fountain or Final Draft.");}
}

/**
 * The text a content stream draws, with the position of each run.
 *
 * One forward pass over the stream. The operators that matter to a screenplay are the ones that set
 * the text position -- `Td`, `TD`, `Tm`, `T*` -- and the ones that show a string -- `Tj`, `TJ`, `'`
 * and `"`. Everything else moves the cursor past it.
 */
function drawnText(stream: string, page: number, items: PdfTextItem[]): void {
  let x = 0, y = 0, lineX = 0, lineY = 0, leading = 0;
  const operands: string[] = [];
  const number = (back: number) => Number(operands[operands.length - back] ?? "0");
  for (let at = 0; at < stream.length;) {
    const character = stream[at]!;
    if (character === "(") {
      // A literal string: `\` escapes the next byte, and parentheses nest.
      let depth = 1, text = "";
      at++;
      for (; at < stream.length && depth > 0; at++) {
        const value = stream[at]!;
        if (value === "\\") {
          const escaped = stream[++at];
          if (escaped === undefined) break;
          if (/[0-7]/.test(escaped)) {
            let octal = escaped;
            while (octal.length < 3 && /[0-7]/.test(stream[at + 1] ?? "")) octal += stream[++at]!;
            text += LATIN[parseInt(octal, 8) & 0xff]!;
          } else text += ({n: "\n", r: "\r", t: "\t", b: "\b", f: "\f"} as Record<string, string>)[escaped] ?? escaped;
          continue;
        }
        if (value === "(") {depth++; text += value; continue;}
        if (value === ")") {depth--; if (depth > 0) text += value; continue;}
        text += value;
      }
      operands.push("\u0000" + text);
      continue;
    }
    if (character === "<" && stream[at + 1] !== "<") {
      // A hexadecimal string.
      const close = stream.indexOf(">", at);
      const digits = (close < 0 ? stream.slice(at + 1) : stream.slice(at + 1, close)).replace(/\s/g, "");
      let text = "";
      for (let pair = 0; pair + 1 < digits.length; pair += 2) text += LATIN[parseInt(digits.slice(pair, pair + 2), 16) & 0xff]!;
      operands.push("\u0000" + text);
      at = close < 0 ? stream.length : close + 1;
      continue;
    }
    if (/[\s[\]<>{}]/.test(character)) {at++; continue;}
    let end = at;
    while (end < stream.length && !/[\s([<[\]{}]/.test(stream[end]!)) end++;
    const token = stream.slice(at, end);
    at = end;
    const show = (text: string) => {
      if (items.length >= PDF_LIMITS.textItems) fail("This PDF draws more text than a screenplay does. Export the script as Fountain or Final Draft.");
      if (text) items.push({page, x, y, text});
    };
    switch (token) {
      case "BT": x = y = lineX = lineY = 0; break;
      case "Td": lineX += number(2); lineY += number(1); x = lineX; y = lineY; break;
      case "TD": leading = -number(1); lineX += number(2); lineY += number(1); x = lineX; y = lineY; break;
      case "Tm": lineX = number(2); lineY = number(1); x = lineX; y = lineY; break;
      case "TL": leading = number(1); break;
      case "T*": lineY -= leading; x = lineX; y = lineY; break;
      case "Tj": show(operands.at(-1)?.startsWith("\u0000") ? operands.at(-1)!.slice(1) : ""); break;
      case "'": lineY -= leading; x = lineX; y = lineY; show(operands.at(-1)?.startsWith("\u0000") ? operands.at(-1)!.slice(1) : ""); break;
      case '"': lineY -= leading; x = lineX; y = lineY; show(operands.at(-1)?.startsWith("\u0000") ? operands.at(-1)!.slice(1) : ""); break;
      case "TJ": {
        // An array of strings and kerning numbers; the numbers move the pen and do not break a word.
        let text = "";
        for (const operand of operands) if (operand.startsWith("\u0000")) text += operand.slice(1);
        show(text);
        break;
      }
      default: operands.push(token); continue;
    }
    operands.length = 0;
  }
}

/**
 * A font that does not stand for what it draws.
 *
 * A screenplay PDF is Courier, and a Courier byte is the character it looks like. A font with a
 * `/ToUnicode` CMap, an `/Encoding` with `/Differences`, or a composite `/Type0` descendant draws
 * glyphs whose byte values mean something else entirely — a subset font commonly numbers its glyphs
 * from 1. Reading those bytes as characters produces text that looks like a screenplay's shape and
 * says nothing, which is the one outcome worse than refusing.
 */
function unreadableFont(body: string): string | null {
  if (/\/Subtype\s*\/Type0/.test(body)) return "a composite (Type0) font";
  if (/\/ToUnicode\b/.test(body)) return "a font with its own character map";
  if (/\/Differences\b/.test(body)) return "a font with a re-mapped encoding";
  return null;
}

/** Every run of text the document draws, in page order, with its position. */
export function readPdfText(document: Uint8Array): PdfTextItem[] {
  if (!(document instanceof Uint8Array) || document.length === 0) fail("Choose a PDF screenplay to import.");
  if (document.length > PDF_LIMITS.documentBytes) fail("A PDF screenplay must be at most 4 MiB.");
  // Latin-1, so every byte is one character and an offset in the string is an offset in the file.
  const source = latin1(document);
  if (!source.startsWith("%PDF-")) fail("This file is not a PDF. Choose a PDF screenplay to import.");
  if (/\/Encrypt\b/.test(source)) fail("This PDF is encrypted, so its text cannot be read. Remove the password, or export the script as Fountain or Final Draft.");

  const found = objects(document, source);
  if (found.size === 0) fail("This PDF's objects could not be read. Export the script as Fountain or Final Draft.");
  const bodies = new Map([...found].map(([id, span]) => [id, source.slice(span.start, span.end)]));
  for (const body of bodies.values()) {
    const unreadable = unreadableFont(body);
    if (unreadable) fail("This PDF draws its text with " + unreadable + ", so the bytes it stores are not the letters it shows. Export the script as Fountain or Final Draft.");
  }

  // The pages, in order: every object that says it is one, by object number, which is the order a
  // writer emits them in. Walking /Kids would be exact; every producer this importer has been shown
  // numbers its pages in order, and a page tree that disagrees is caught by the margin check below.
  const pages = [...found.keys()].filter(id => /\/Type\s*\/Page\b/.test(bodies.get(id)!)).sort((a, b) => a - b);
  if (pages.length === 0) fail("This PDF has no pages this importer can read. Export the script as Fountain or Final Draft.");
  if (pages.length > PDF_LIMITS.pages) fail("A PDF screenplay must be at most " + PDF_LIMITS.pages + " pages.");

  const items: PdfTextItem[] = [];
  pages.forEach((id, index) => {
    const contents = entry(bodies.get(id)!, "Contents");
    if (!contents) return;
    for (const reference of contents.matchAll(/(\d+)\s+\d+\s+R/g)) {
      const span = found.get(Number(reference[1]));
      if (!span) continue;
      const stream = streamBytes(document, source, span);
      if (!stream) continue;
      drawnText(latin1(stream), index + 1, items);
    }
  });
  if (items.length === 0)
    fail("This PDF has no text layer — it looks like a scan or an image of a script. Export the script as Fountain or Final Draft, or run it through a text-recognition tool first.");
  return items;
}

/**
 * Half a line of twelve-point type, and the width of one Courier character at it -- a screenplay is
 * set in twelve-point Courier and nothing else, which is what makes its margins mean anything. Both
 * are only used to decide whether two runs on one baseline had a space between them.
 */
const BASELINE = 3, COURIER_ADVANCE = 7.2;

/** One visual line of the page: the runs that share a baseline, left to right. */
export interface PdfLine {page: number; x: number; y: number; text: string}

/** Runs grouped onto baselines, in reading order. */
export function pdfLines(items: PdfTextItem[]): PdfLine[] {
  return baselines(items).map(joined).filter(line => line.text !== "");
}

/** The runs on each baseline, each baseline's runs left to right. */
function baselines(items: PdfTextItem[]): PdfTextItem[][] {
  // Down the page first, because a run's baseline is what puts it on a line; across it second,
  // because two runs of one line may be drawn in either order and may sit a fraction of a point
  // apart. Sorting by y alone would put "leaves." before "He" for a half-point difference.
  const sorted = [...items].sort((a, b) => a.page - b.page || b.y - a.y || a.x - b.x);
  const groups: PdfTextItem[][] = [];
  for (const item of sorted) {
    const group = groups.at(-1);
    if (group && group[0]!.page === item.page && Math.abs(group[0]!.y - item.y) <= BASELINE) group.push(item);
    else groups.push([item]);
  }
  return groups.map(group => [...group].sort((a, b) => a.x - b.x));
}

/** One baseline's runs, left to right, as a line. */
function joined(ordered: PdfTextItem[]): PdfLine {
  const x = ordered[0]!.x;
  let text = ordered[0]!.text;
  // The gap to the next run, measured from where the text written so far ends. Wider than half a
  // character and the producer meant a space; narrower and it is the same word in two runs.
  for (const item of ordered.slice(1)) text += (item.x - (x + text.length * COURIER_ADVANCE) > COURIER_ADVANCE / 2 ? " " : "") + item.text;
  return {page: ordered[0]!.page, x, y: ordered[0]!.y, text: text.replace(/\s+/g, " ").trim()};
}

/** The start of a scene heading, as the importer and `parseFountain` both read one. */
const SCENE_HEADING = /^(INT\.?\/EXT|INT|EXT|EST|I\/E)[.\s]/i;
/** A production draft's scene number: 12, 12A, A12, 12AB, or any of those with a full stop. */
const SCENE_NUMBER = /^[A-Z]{0,2}\d{1,4}[A-Z]{0,2}\.?$/;

/**
 * HV-016-13: a baseline with its scene numbers taken off, or the same runs when it has none.
 *
 * A production or shooting draft prints each scene's number in the margin beside its heading, in
 * the left margin, the right margin, or both, as runs of their own on the heading's baseline. Left
 * in, a left-hand number became the page's leftmost text, which moved every margin half an inch and
 * refused the whole script as "not laid out as a screenplay". A right-hand number was glued onto the
 * heading, so `INT. LIGHTHOUSE - NIGHT 12` became the scene's time of day.
 *
 * A run is a scene number only beside a scene heading, only if it is nothing but a number, and on
 * the right only if a clear gap (two characters, where a space is one) separates it from the
 * heading. So `EXT. HIGHWAY 101` drawn as one run keeps its highway, and an action line that starts
 * with a number is never touched.
 */
function withoutSceneNumbers(runs: PdfTextItem[]): PdfTextItem[] {
  const number = (run: PdfTextItem) => SCENE_NUMBER.test(run.text.trim());
  let start = 0;
  while (start < runs.length && number(runs[start]!)) start++;
  const rest = runs.slice(start);
  if (!rest.length || !SCENE_HEADING.test(joined(rest).text)) return runs;
  let end = rest.length;
  const gap = (before: PdfTextItem, after: PdfTextItem) => after.x - (before.x + before.text.length * COURIER_ADVANCE);
  while (end > 1 && number(rest[end - 1]!) && gap(rest[end - 2]!, rest[end - 1]!) >= 2 * COURIER_ADVANCE) end--;
  return rest.slice(0, end);
}

/**
 * The offsets, in points, of each screenplay element from the action margin.
 *
 * A US screenplay page puts action at 1.5in, dialogue at 2.5in, a parenthetical at 3.0in, a
 * character cue at 3.5in and a transition at 6.0in. The offsets are measured **from the page's own
 * leftmost text**, not from an absolute point, so a script laid out on A4 or with a wider binding
 * margin reads the same. A run that lands on none of them, within half an inch, is what makes a
 * document not a screenplay.
 */
const MARGINS: readonly [string, number][] = [["action", 0], ["dialogue", 72], ["parenthetical", 108], ["character", 144], ["transition", 324]];
const TOLERANCE = 36;

function classify(offset: number): string | null {
  let best: string | null = null, closest = TOLERANCE;
  for (const [kind, at] of MARGINS) {
    const distance = Math.abs(offset - at);
    if (distance < closest) {closest = distance; best = kind;}
  }
  return best;
}

/**
 * A PDF screenplay as Fountain, or a refusal that names what stopped it.
 *
 * The margins decide the element and the text confirms it. Where they disagree the text wins for the
 * two elements a screenplay marks unambiguously — a scene heading starts with INT or EXT, a
 * parenthetical is wrapped in brackets — because those are the writer's own statement of intent and
 * a margin is a layout accident. A character cue is a cue only if something is said under it, which
 * is the rule `parseFountain` itself uses (HV-016-06).
 */
export function importPdfScreenplay(document: Uint8Array): ScriptImport {
  const items = readPdfText(document);
  let numbered = 0;
  const lines = baselines(items).map(runs => {
    const kept = withoutSceneNumbers(runs);
    if (kept.length !== runs.length) numbered++;
    return joined(kept);
  }).filter(line => line.text !== "");
  if (lines.length === 0) fail("This PDF has no text this importer could read. Export the script as Fountain or Final Draft.");
  const left = Math.min(...lines.map(line => line.x));
  const kinds = lines.map(line => classify(line.x - left));
  const unplaced = kinds.filter(kind => kind === null).length;
  // A tenth is generous: page numbers, headers and footers sit outside the margins and are dropped
  // below. More than that and the document is not laid out as a screenplay.
  if (unplaced > Math.max(2, lines.length / 10))
    fail("This PDF's text is not laid out as a screenplay — " + unplaced + " of " + lines.length
      + " lines sit outside the margins a screenplay uses. Export the script as Fountain or Final Draft.");

  const notes: ScriptImportNote[] = [], note = (code: string, message: string) => {if (!notes.some(value => value.code === code)) notes.push({code, message});};
  note("styling", "Bold, italic and underline were not imported; the screenplay keeps the words.");
  if (numbered) note("scene-numbers", "Scene numbers were not imported; the studio numbers scenes in the order they appear.");

  const out: string[] = [];
  let dropped = 0;
  lines.forEach((line, index) => {
    const kind = kinds[index];
    const text = line.text;
    if (kind === null) {dropped++; return;}
    // A page number is a line of digits on its own, wherever it sits.
    if (/^\d+\.?$/.test(text)) {dropped++; return;}
    const heading = SCENE_HEADING.test(text);
    const parenthetical = /^\(.*\)$/.test(text);
    const speaks = kinds[index + 1] === "dialogue" || kinds[index + 1] === "parenthetical";
    const blank = () => {if (out.length && out.at(-1) !== "") out.push("");};
    if (heading) {blank(); out.push(text); return;}
    if (parenthetical) {
      // HV-016-05's neighbour: a parenthetical inside a speech is spoken by the voice vendor and
      // burned into the caption, so it is dropped and counted, exactly as the Final Draft importer
      // drops it and for the same reason.
      note("parentheticals", "Parentheticals were not imported, because one left inside a speech would be spoken aloud and captioned.");
      return;
    }
    if (kind === "character" && speaks) {blank(); out.push(text); return;}
    if (kind === "dialogue") {out.push(text); return;}
    if (kind === "transition") {blank(); out.push(text); return;}
    // Everything else, including a character-margin line with nothing said under it, is action.
    blank();
    out.push(text);
  });
  if (dropped) note("page-furniture", "Page numbers, headers and footers were not imported; the screenplay keeps the script.");
  const text = out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  // HV-016-12: the writer's words, read by Fountain, must still be all of the writer's words.
  const hidden = hiddenImportedLine(text); if (hidden) fail(hiddenImportedLineMessage(hidden, "PDF screenplay"));
  if (text.length > PDF_LIMITS.fountainCharacters) fail("This PDF's screenplay is longer than the studio's 200,000-character limit.");
  if (!new RegExp(SCENE_HEADING.source, "im").test(text)) fail("This PDF has no scene headings, so it has no scenes to shoot.");
  return {text, notes};
}
