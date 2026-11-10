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
  /**
   * HV-030-43: beside `dialogue`, one flag per speech: whether the speaker is heard and not seen. A cue
   * marked V.O., O.S. or O.C. (`cueVoice` "off-camera") always is; a voice through a device or a door
   * ("through") is only when the scene's action never names the speaker; a bare (CONT'D) ("continued") is
   * as the same speaker's previous speech in the scene was. Present only on a scene with at least one such
   * speech, so every other scene is exactly as it was. Kept apart from the dialogue blocks and the beats,
   * whose exact shapes saved records hash.
   */
  offCameraDialogue?: boolean[];
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

const SCENE_HEADING = /^(INT\.?\/EXT|INT|EXT|EST|I\/E)[.\s]/i;
const FORCED_HEADING = /^\./;
const TRANSITION = /(TO:|FADE OUT\.?|FADE IN:?|CUT TO BLACK\.?)$/;
/**
 * HV-016-19: the name part of a character cue, in capitals in any script, with the extension -- `(V.O.)`,
 * `(CONT'D)`, `(on the radio)` -- taken off first and tested on its own. This was one pattern over the
 * whole line, `/^[A-Z][A-Z0-9 '().-]*$/`, so a lowercase extension (the Fountain spec's own
 * `HANS (on the radio)`), a typographic apostrophe (`MAYA (CONT’D)`, `O’BRIEN`) or an accented
 * capital (`JOSÉ`) made the cue action, and the speech under it action too. Every line that pattern
 * accepts, this accepts, and names the same speaker.
 */
const CUE_NAME = /^\p{Lu}[\p{Lu}\p{M}\p{N} '’().-]*$/u;
const CUE_EXTENSION = /\s*\(.*\)$/;

/**
 * The speaker a character cue names (HV-016-19): without Fountain's forcing `@`, without the `^` that
 * marks the second half of dual dialogue, and without the extension. `MAYA (CONT’D)` and
 * `MAYA (CONT'D)` both name MAYA, so casting finds the same character under either.
 */
export function cueCharacter(line: string): string {
  return line.trim().replace(/^@/, "").replace(/\s*\^$/, "").replace(CUE_EXTENSION, "").trim();
}
/** A cue extension's word or initials for a voice whose speaker is not on screen, dots, spaces and hyphens taken out. */
/** Extension marks, compared without case, dots, spaces, dashes, apostrophes or slashes, for a voice not on screen. */
const OFF_CAMERA_MARKS = new Set(["vo", "os", "oc", "oov", "oof", "voiceover", "offscreen", "offcamera", "offframe", "off", "outofframe", "outofshot", "outofvision"]);
/** Marks that only continue the previous speech: (CONT'D), (CONTINUING) and their spellings. */
const CONTINUED_MARKS = new Set(["contd", "cont", "continued", "continuing"]);
/**
 * A parenthetical that is wholly a voice heard through something: a device, `(on the radio)`, `(PHONE)`,
 * `(over the intercom)`, `(ON TV)`, `(FILTERED)`, or a door or wall, `(through the door)`. Matched only as
 * the whole parenthetical, so `(into phone)` and `(on the phone, pacing)` are not, nor any other wording.
 * Such a voice may still be someone we see making the call, so it is off camera only when the scene's
 * action never names the speaker (`parseFountain`).
 */
const THROUGH_VOICE = /^(?:(?:(?:on|over|through|thru|via|from)\s+)?(?:(?:the|a|an|his|her|their|its|my|your|our)\s+)?(?:radio|phone|telephone|cell ?phone|mobile|intercom|tv|television|speaker|speakerphone|loudspeaker|p\.? ?a\.?|walkie[- ]?talkie|walkie|comms?|headset|earpiece|voicemail|answering machine|recording|tape|filtered)(?:\s+(?:speaker|system))?|(?:through|thru|behind|from behind)\s+(?:the|a)\s+(?:door|wall|curtain|window))$/;
const compact = (value: string) => value.replace(/[.\s\-’'/]/g, "");
/** What a character cue's extension says of the voice. See `Scene.offCameraDialogue` for what each means. */
export type CueVoice = "off-camera" | "through" | "continued" | "on-camera";
/**
 * HV-030-43: what a character cue's extension says of the speaker's voice: "off-camera" for (V.O.), (O.S.),
 * (O.C.), (V/O), (OFF), (OOV), (out of frame) and the like, alone or beside (CONT'D) in the same or another
 * parenthetical; else "through" for a parenthetical wholly a voice through a device or a door
 * (`THROUGH_VOICE`); else "continued" for a bare (CONT'D); else "on-camera", as for a cue with no extension.
 */
export function cueVoice(line: string): CueVoice {
  const extension = line.trim().replace(/^@/, "").replace(/\s*\^$/, "").match(CUE_EXTENSION)?.[0] ?? "";
  const groups = [...extension.matchAll(/\(([^()]*)\)/g)].map(([, inner]) => inner!.trim().toLowerCase().replace(/\s+/g, " "));
  // Whole, so (V/O) and (O/S) read as VO and OS; and in parts, so (V.O., CONT'D) and (CONT'D/O.S.) are found.
  if (groups.some(whole => OFF_CAMERA_MARKS.has(compact(whole)) || whole.split(/[,;/]/).some(part => OFF_CAMERA_MARKS.has(compact(part))))) return "off-camera";
  if (groups.some(whole => THROUGH_VOICE.test(whole))) return "through";
  if (groups.length && groups.every(whole => whole.split(/[,;/]/).every(part => CONTINUED_MARKS.has(compact(part))))) return "continued";
  return "on-camera";
}
const TITLE = /^(?:dr|doctor|mr|mrs|ms|miss|captain|capt|sergeant|sgt|officer|detective|det|professor|prof|sir|lady|lord|aunt|uncle)\.?\s+(?=\S)/i;
/** HV-030-43: the names a scene's action may call a speaker by: the cue's name, and that name without a leading title. */
export function cueNames(character: string): string[] {
  const name = character.trim();
  return [...new Set([name, name.replace(TITLE, "").trim()].filter(Boolean))];
}
/** Whether `text` names `name` as a whole word, in any case (as casting compares names). */
function names(text: string, name: string): boolean {
  const source = text.toLocaleUpperCase("en-US"), needle = name.toLocaleUpperCase("en-US");
  for (let from = source.indexOf(needle); from >= 0; from = source.indexOf(needle, from + needle.length)) {
    const before = source.slice(Math.max(0, from - 1), from), after = source.slice(from + needle.length, from + needle.length + 1);
    if ((!before || !/[\p{L}\p{N}_]/u.test(before)) && (!after || !/[\p{L}\p{N}_]/u.test(after))) return true;
  }
  return false;
}
/** A scene's off-camera flags from its cues' voices (see `Scene.offCameraDialogue`), or undefined when none is off camera. */
function offCameraFlags(scene: Scene, voices: CueVoice[]): boolean[] | undefined {
  const action = scene.action.join("\n"), flags: boolean[] = [];
  voices.forEach((voice, index) => {
    const character = scene.dialogue[index]!.character, key = character.toLocaleUpperCase("en-US");
    if (voice === "off-camera") flags.push(true);
    else if (voice === "through") flags.push(!cueNames(character).some(name => names(action, name)));
    else if (voice === "continued") {
      let previous = index - 1;
      while (previous >= 0 && scene.dialogue[previous]!.character.toLocaleUpperCase("en-US") !== key) previous--;
      flags.push(previous >= 0 && flags[previous] === true);
    } else flags.push(false);
  });
  return flags.some(Boolean) ? flags : undefined;
}
/** Whether a line has the shape of a character cue; whether it is one also depends on its neighbours. */
function cueShaped(line: string): boolean {
  const name = cueCharacter(line);
  // HV-016-19: `@McCLANE` is Fountain's forced cue, for a name that is not all capitals.
  return name !== "" && (line.startsWith("@") || CUE_NAME.test(name));
}

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

/**
 * The first line of an imported screenplay that the Fountain reader would hide part of (HV-016-12).
 *
 * Final Draft and PDF text is the writer's literal words. The importers hand it to `parseFountain`
 * as Fountain, and Fountain reads `[[…]]` as a note and `/*` as the start of a boneyard that runs
 * to the next star-slash closer -- or to the end of the document. So an action line reading
 * `Mara types rm -rf /* and hits enter.` imported cleanly, kept every scene in the editor's text,
 * and left the film with one scene and half a sentence: everything after `/*` was boneyard, with no
 * note and no warning. `[[classified]]` inside a speech was cut from it the same way.
 *
 * Fountain has no escape for either, so an importer cannot carry them; it can only refuse by line,
 * which is the rule the importers were written to: one that silently loses a line is worse than one
 * that will not run. Returns null when every line is read exactly as written.
 */
export function hiddenImportedLine(text: string): {line: number; marker: "[[ ]]" | "/*" | "#" | "=" | ">"} | null {
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const scan = scanProtectedSpans(lines[index]!);
    if (scan.opensBlock) return {line: index + 1, marker: "/*"};
    if (scan.closedSpans) return {line: index + 1, marker: lines[index]!.includes("[[") ? "[[ ]]" : "/*"};
    // HV-016-20: a line starting `#` or `=` is now a section, synopsis or page break, and one starting
    // `>` a transition or centred text. Fountain has no escape for these either.
    const lead = lines[index]!.trim().charAt(0);
    if (lead === "#" || lead === "=" || lead === ">") return {line: index + 1, marker: lead};
  }
  return null;
}
/** The refusal both importers give, in one place so they cannot come to say it differently. */
export function hiddenImportedLineMessage(hidden: {line: number; marker: string}, source: string): string {
  // HV-016-20: a leading marker changes what the whole line is, rather than hiding a span of it.
  const reads = ({"#": "a section heading, so the line would silently leave the film. ", "=": "a synopsis or page break, so the line would silently leave the film. ",
    ">": "a transition or centred text, so the line would not be filmed as written. "} as Record<string, string | undefined>)[hidden.marker];
  if (reads) return "Line " + hidden.line + " of this " + source + " starts with “" + hidden.marker + "”, which the studio's screenplay format reads as " + reads
    + "Reword that line and import the script again.";
  return "Line " + hidden.line + " of this " + source + " contains “" + hidden.marker + "”, which the studio's screenplay format reads as a hidden note: "
    + (hidden.marker === "/*" ? "everything after it would silently leave the film. " : "the text inside it would silently leave the film. ")
    + "Reword that line and import the script again.";
}

/** A scene heading, forced or not. The parse loop and the cue rule below must agree on this. */
function isHeading(text: string): boolean {
  return SCENE_HEADING.test(text) || (FORCED_HEADING.test(text) && !text.startsWith(".."));
}

/**
 * HV-016-20: Fountain's non-printing elements -- a section (`# ACT ONE`), a synopsis
 * (`= She is nervous.`) and a page break (`===`). They are the writer's outline, not the film.
 */
const NON_PRINTING = /^[#=]/;

/**
 * HV-016-20: a line Fountain marks with `>`. `>THE END<` is centred text, which is action; `> BURN TO
 * WHITE.` is a forced transition. Either way the markers are not the writer's words. A run of three
 * or more marker characters stays what it was, an unparseable construct.
 */
function markedLine(t: string): {kind: "centred" | "transition"; text: string} | null {
  if (!t.startsWith(">") || /^[<>~_*]{3,}/.test(t)) return null;
  const centred = t.endsWith("<"), text = t.slice(1, centred ? -1 : undefined).trim();
  return text ? {kind: centred ? "centred" : "transition", text} : null;
}
/**
 * The text a line outside a speech gives its action or transition beat (HV-016-20): the line, or
 * what a `>` marks without the markers. The living script document checks a beat against its
 * physical line with this.
 */
export function printedText(line: string): string {
  const t = line.trim();
  return markedLine(t)?.text ?? t;
}

export function parseFountain(text: string): ParseResult {
  const rawLines = text.split(/\r?\n/);
  const warnings: ParseWarning[] = [];
  const unparseable: { line: number; text: string }[] = [];
  const scenes: Scene[] = [];
  let current: Scene | null = null;
  let pendingCharacter: string | null = null;
  const cueVoices = new Map<Scene, CueVoice[]>();

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
    // HV-016-20: a forced transition is a transition outside a speech, and loses its `>` either way.
    const marked = markedLine(t);
    if ((TRANSITION.test(t) && t === t.toUpperCase()) || (marked?.kind === "transition" && !pendingCharacter)) {
      const text = marked?.kind === "transition" ? marked.text : t;
      if (current) {current.transitions.push(text);current.beats!.push({id:`beat-${current.index+1}-${current.beats!.length+1}`,kind:"transition",text,startLine:i+1,endLine:i+1});}
      return;
    }
    // HV-016-20: a section, synopsis or page break outside a speech is not film.
    if (!pendingCharacter && NON_PRINTING.test(t)) return;
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
    if (cueShaped(t) && t.length <= 40 && !SCENE_HEADING.test(t) && speechAfter[i] && openBefore[i]) {
      pendingCharacter = t;
      current.dialogue.push({ character: cueCharacter(t), lines: [] });
      // HV-030-43: what the cue says of the voice, read with the scene's action once it is parsed (`offCameraFlags`).
      const voices = cueVoices.get(current) ?? [];voices.push(cueVoice(t));cueVoices.set(current, voices);
      current.beats!.push({id:`beat-${current.index+1}-${current.beats!.length+1}`,kind:"dialogue",character:cueCharacter(t),lines:[],startLine:i+1,endLine:i+1});
      return;
    }
    if (/^[<>~_*]{3,}/.test(t)) {
      unparseable.push({ line: i + 1, text: t });
      warnings.push({ code: "UNPARSEABLE", message: `Unparseable construct at line ${i + 1}`, line: i + 1 });
      return;
    }
    // HV-016-20: centred text is action, without its `>` `<`.
    const text = marked?.text ?? t;
    current.action.push(text);
    current.beats!.push({id:`beat-${current.index+1}-${current.beats!.length+1}`,kind:"action",text,startLine:i+1,endLine:i+1});
  });

  for (const [scene, voices] of cueVoices) { const flags = offCameraFlags(scene, voices); if (flags) scene.offCameraDialogue = flags; }
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
    // HV-016-10: a save that changes nothing is not a revision, and here it was one. Identical text
    // advanced the version, and the version is in the key the server derives for a render --
    // `${stage}:${scriptVersion}:cast-${castingVersion}:direction-${directionVersion}` -- so saving
    // the same screenplay again and asking for the same film again admitted a **second** job and
    // charged for it. HV-030-07 took the studio's random idempotency keys away so that the derived
    // one would stand; a no-op save moved the derived one.
    //
    // Measured on this repo's own API: three `PUT /script` of one string gave versions 1, 2 and 3,
    // and a re-pitch of an unchanged script rendered a second animatic.
    const current=this.latest();
    if(current&&current.text===text)return current;
    // Recovery permits increasing, noncontiguous versions. Array length is not a version identity.
    const parent=current?.version??null,next=(parent??0)+1;
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
