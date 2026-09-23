export type SceneBeat = {id:string;startLine:number;endLine:number} & (
  {kind:"action"|"transition";text:string} | {kind:"dialogue";character:string;lines:string[]}
);
export interface Scene {
  index: number;
  heading: string;
  action: string[];
  dialogue: { character: string; lines: string[] }[];
  transitions: string[];
  /** Ordered visible screenplay content, with one-based original source lines. */
  beats?: SceneBeat[];
}

export interface ParseWarning { code: string; message: string; line?: number }

export interface ParseResult {
  scenes: Scene[];
  pageEstimate: number;
  warnings: ParseWarning[];
  rejected: boolean;
  rejectionReason?: string;
  unparseable: { line: number; text: string }[];
}

const LINES_PER_PAGE = 55;
const MAX_PAGES = 30;
const SCENE_WARNING_THRESHOLD = 20;

const SCENE_HEADING = /^(INT|EXT|EST|INT\.\/EXT|I\/E)[.\s]/i;
const FORCED_HEADING = /^\./;
const TRANSITION = /(TO:|FADE OUT\.?|FADE IN:?|CUT TO BLACK\.?)$/;
const CHARACTER = /^[A-Z][A-Z0-9 '().-]*$/;

/**
 * Whether a line holds something Fountain protects from the film: a `[[note]]`, or a block comment
 * that opens and closes on the same line.
 *
 * HV-016-04: this was `/\[\[[^\]]*\]\]|\/\*[\s\S]*?\*\//`, run once per line, and the first
 * alternative is quadratic in the length of the line. `\[\[` matches at every offset of a run of
 * `[`, `[^\]]*` then runs to the end of the line, `\]\]` fails, and the engine gives back one
 * character at a time. `parseFountain` bounds the document (thirty pages of *parsed* lines) but
 * never bounds a line, so the whole payload is one line and the page estimate is 1:
 *
 * | characters | before |
 * |---|---|
 * | 12,500 | 27 ms |
 * | 25,000 | 111 ms |
 * | 50,000 | 416 ms |
 * | 100,000 | 1,640 ms |
 * | 200,000 | 6,048 ms |
 *
 * Fourfold per doubling. 200,000 is the script route's own limit, the parse returns
 * `rejected: false` so the screenplay **saves**, and every later read parses it again --
 * `GET /direction` four times, `GET /audio-takes` twice -- on a single-threaded server, from routes
 * an anonymous project reaches for free. `final-draft.ts` already carries the rule this breaks:
 * *"Every search here is a linear `indexOf`, and the bound on the input is therefore also a bound
 * on the work."*
 *
 * Both alternatives are decidable in one left-to-right pass, and the cursors below only ever move
 * forward, so no character of the line is examined twice.
 */
/**
 * What is left of a line once its notes and boneyards are taken out, and whether it opens one.
 *
 * HV-016-05: this used to be a predicate, and a line that answered `true` was **discarded whole**.
 * Fountain removes the span, not the line: `She slides the envelope across the bar. [[rewrite]]`
 * lost the sentence, silently -- no warning, nothing in `unparseable`. On a scene heading it lost
 * the scene, and then filed the scene's own action as an unparseable construct at the wrong line.
 *
 * And the latch that opened a block comment was `l.includes("/*") && !l.includes("*\/")`, so a line
 * holding both -- `/* old *\/ kept /* cut from here` -- never set it: the line itself was dropped
 * and every following line of the boneyard was parsed as film. Material the writer explicitly cut
 * became a character cue and a spoken line. `opensBlock` answers on the **last** unmatched opener
 * rather than on "contains a closer anywhere".
 *
 * Still one left-to-right pass with forward-only cursors, which is what HV-016-04 was about: the
 * 200,000 characters the script route allows are a bound on the work as well as on the input.
 */
export interface ProtectedScan {
  /** The line with its notes and closed boneyards taken out, and any unterminated boneyard's tail. */
  text: string;
  /** A note or a closed boneyard was removed -- what the predicate below has always been about. */
  closedSpans: boolean;
  /** The line ends inside a boneyard, so the lines after it are inside one too. */
  opensBlock: boolean;
}
export function scanProtectedSpans(line: string): ProtectedScan {
  // `[[` … `]]` with no `]` between: for a given `[[`, the span can only reach the first `]` after
  // it, so the match is "that `]` is doubled". `close` is that first `]`, recomputed only when the
  // opener has passed it, which makes the scans disjoint.
  let kept = "", cursor = 0, close = -1, from = 0, closedSpans = false;
  for (;;) {
    const open = line.indexOf("[[", from);
    if (open < 0) break;
    if (close < open + 2) close = line.indexOf("]", open + 2);
    if (close < 0) break;
    if (line.charCodeAt(close + 1) === 93) {
      if (open >= cursor) {kept += line.slice(cursor, open); cursor = close + 2; closedSpans = true;}
      from = close + 2; close = -1; continue;
    }
    from = open + 1;
  }
  const withoutNotes = kept + line.slice(cursor);
  // `/*` … `*/`, each closed pair removed, and a final unterminated opener taking the rest of the
  // line with it and saying so.
  let text = "", at = 0, opensBlock = false;
  for (;;) {
    const opener = withoutNotes.indexOf("/*", at);
    if (opener < 0) {text += withoutNotes.slice(at); break;}
    const closer = withoutNotes.indexOf("*/", opener + 2);
    text += withoutNotes.slice(at, opener);
    if (closer < 0) {opensBlock = true; break;}
    at = closer + 2; closedSpans = true;
  }
  return {text, closedSpans, opensBlock};
}
/**
 * Whether a line holds a note or a closed boneyard at all. HV-016-04 proved this equal to the
 * pattern it replaced over every arrangement of `[ ] / *` up to length eight and 200,000 seeded
 * strings; it is defined in terms of the scan above so the two cannot answer differently.
 */
export function holdsProtectedSpan(line: string): boolean {
  return scanProtectedSpans(line).closedSpans;
}

/** A scene heading, forced or not. The parse loop and the cue rule below must agree on this. */
function isHeading(text: string): boolean {
  return SCENE_HEADING.test(text) || (FORCED_HEADING.test(text) && !text.startsWith(".."));
}

export function parseFountain(text: string): ParseResult {
  const rawLines = text.split(/\r?\n/);
  const warnings: ParseWarning[] = [];
  const unparseable: { line: number; text: string }[] = [];
  const scenes: Scene[] = [];
  let current: Scene | null = null;
  let pendingCharacter: string | null = null;

  // What the writer wrote, minus what they marked as not part of the film. A line reduced to nothing
  // is skipped; a line with text left keeps it, which it did not before (HV-016-05).
  const visible: string[] = [];
  let inBlockComment = false;
  rawLines.forEach((l, i) => {
    if (inBlockComment) {
      const closer = l.indexOf("*/");
      if (closer < 0) {visible[i] = ""; return;}
      inBlockComment = false;
      const rest = scanProtectedSpans(l.slice(closer + 2));
      visible[i] = rest.text; inBlockComment = rest.opensBlock;
      return;
    }
    const scan = scanProtectedSpans(l);
    visible[i] = scan.text; inBlockComment = scan.opensBlock;
  });

  /**
   * A character cue is a line in capitals that someone then says something after.
   *
   * HV-016-06: the test was `CHARACTER.test(t)` and nothing else, so an all-caps *action* line --
   * `SHE SLAMS THE DOOR.` -- became a character with nothing to say. The action left the film (it is
   * in neither `action` nor the beats) and a phantom speaker entered it, silently: no warning,
   * nothing in `unparseable`. `coverageReport` then asks for single or over-shoulder coverage of
   * "THE DOOR SLAMS BEHIND HIM." by name (coverage.ts:49-55), and that name is what casting, the
   * character sheets and the voice paths take a character to be.
   *
   * Fountain's rule is the whole sentence: a Character is a line in uppercase with an empty line
   * *before* it and no empty line *after* it. The second half is what a lone all-caps action line
   * fails; the first is what one in a run of action lines fails. Both are enforced here, with a
   * scene heading counting as the boundary a blank line is -- the loop below already treats a
   * heading that way, clearing `pendingCharacter` on it, and this repo's own fixtures write a cue
   * directly under a heading.
   *
   * `speechAfter` and `blankBefore` are two passes over the lines rather than a search per candidate
   * -- HV-016-04 made this parser linear in the document and proved it, and a scan per capitalised
   * line would be quadratic on a document of them.
   */
  const deciding = (index: number): boolean => {
    // The lines the loop below acts on. A line that was nothing but a note is skipped by it, so it
    // neither ends a speech nor stands between a cue and its dialogue (HV-016-05).
    const text = (visible[index] ?? rawLines[index]!).trim();
    return !(text === "" && rawLines[index]!.trim() !== "");
  };
  const speechAfter: boolean[] = Array.from({length: rawLines.length}, () => false);
  const openBefore: boolean[] = Array.from({length: rawLines.length}, () => true);
  let next = -1, previous = -1;
  for (let j = rawLines.length - 1; j >= 0; j--) {
    speechAfter[j] = next >= 0 && (visible[next] ?? rawLines[next]!).trim() !== "";
    if (deciding(j)) next = j;
  }
  for (let j = 0; j < rawLines.length; j++) {
    const before = previous < 0 ? "" : (visible[previous] ?? rawLines[previous]!).trim();
    openBefore[j] = previous < 0 || before === "" || isHeading(before);
    if (deciding(j)) previous = j;
  }

  rawLines.forEach((raw, i) => {
    const line = (visible[i] ?? raw).trimEnd();
    const t = line.trim();
    // A line that was nothing but a note is not a blank line: it does not end a speech, exactly as
    // it did not before, because the whole line used to be skipped.
    if (t === "" && raw.trim() !== "") return;
    if (t === "") { pendingCharacter = null; return; }
    if (isHeading(t)) {
      current = { index: scenes.length, heading: t.replace(/^\./, ""), action: [], dialogue: [], transitions: [], beats: [] };
      scenes.push(current);
      pendingCharacter = null;
      return;
    }
    if (TRANSITION.test(t) && t === t.toUpperCase()) {
      if (current) {current.transitions.push(t);current.beats!.push({id:`beat-${current.index+1}-${current.beats!.length+1}`,kind:"transition",text:t,startLine:i+1,endLine:i+1});}
      return;
    }
    if (!current) {
      if (/^(Title|Credit|Author|Source|Draft date|Contact):/i.test(t)) return;
      unparseable.push({ line: i + 1, text: t });
      return;
    }
    if (pendingCharacter) {
      const d = current.dialogue[current.dialogue.length - 1];
      d.lines.push(t);
      const beat=current.beats!.at(-1)!;if(beat.kind==="dialogue"){beat.lines.push(t);beat.endLine=i+1;}
      else current.beats!.push({id:`beat-${current.index+1}-${current.beats!.length+1}`,kind:"dialogue",character:d.character,lines:[t],startLine:i+1,endLine:i+1});
      return;
    }
    if (CHARACTER.test(t) && t.length <= 40 && !SCENE_HEADING.test(t) && speechAfter[i] && openBefore[i]) {
      pendingCharacter = t;
      current.dialogue.push({ character: t.replace(/\s*\(.*\)$/, ""), lines: [] });
      current.beats!.push({id:`beat-${current.index+1}-${current.beats!.length+1}`,kind:"dialogue",character:t.replace(/\s*\(.*\)$/, ""),lines:[],startLine:i+1,endLine:i+1});
      return;
    }
    if (/^[<>~_*]{3,}/.test(t)) {
      unparseable.push({ line: i + 1, text: t });
      warnings.push({ code: "UNPARSEABLE", message: `Unparseable construct at line ${i + 1}`, line: i + 1 });
      return;
    }
    current.action.push(t);
    current.beats!.push({id:`beat-${current.index+1}-${current.beats!.length+1}`,kind:"action",text:t,startLine:i+1,endLine:i+1});
  });

  const nonEmpty = rawLines.filter((l) => l.trim() !== "").length;
  const pageEstimate = Math.ceil(nonEmpty / LINES_PER_PAGE) || 0;
  let rejected = false;
  let rejectionReason: string | undefined;
  if (pageEstimate > MAX_PAGES) {
    rejected = true;
    rejectionReason = `Script is approximately ${pageEstimate} pages; the limit is ${MAX_PAGES} pages.`;
  }
  if (scenes.length > SCENE_WARNING_THRESHOLD) {
    warnings.push({ code: "SCENE_COUNT", message: `Script has ${scenes.length} scenes; more than ${SCENE_WARNING_THRESHOLD} may exceed capacity tiers.` });
  }
  for (const u of unparseable) {
    if (!warnings.some((w) => w.line === u.line)) warnings.push({ code: "UNPARSEABLE", message: `Unparseable construct at line ${u.line}`, line: u.line });
  }
  return { scenes, pageEstimate, warnings, rejected, rejectionReason, unparseable };
}

export interface ScriptVersion { version: number; text: string; createdAt: string; parentVersion: number | null }

export class VersionStore {
  private versions: ScriptVersion[] = [];
  static hydrate(versions: ScriptVersion[]): VersionStore {
    const store = new VersionStore();
    store.versions = [...versions];
    return store;
  }
  commit(text: string): ScriptVersion {
    // Recovery permits increasing, noncontiguous versions. Array length is not a version identity.
    const parent=this.latest()?.version??null,next=(parent??0)+1;
    if(parent!==null&&(!Number.isSafeInteger(parent)||parent<1)||!Number.isSafeInteger(next))throw new Error("The screenplay version cannot advance beyond its retained identity.");
    const v: ScriptVersion = {
      version: next,
      text,
      createdAt: new Date().toISOString(),
      parentVersion: parent,
    };
    this.versions.push(v);
    return v;
  }
  get(version: number): ScriptVersion | undefined { return this.versions.find((v) => v.version === version); }
  latest(): ScriptVersion | undefined { return this.versions[this.versions.length - 1]; }
  history(): ScriptVersion[] { return [...this.versions]; }
}
