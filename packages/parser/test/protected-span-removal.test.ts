/**
 * HV-016-05 — the parser deleted the line instead of the span.
 *
 * A Fountain note is `[[…]]` and a boneyard is `/*…*\/`. Fountain removes the **span**. This parser
 * asked a predicate about the whole line and, when the answer was yes, `return`ed before parsing it:
 *
 *     if (protectedRanges.has(i)) return;
 *
 * So `She slides the envelope across the bar. [[needs a rewrite]]` lost the sentence. Silently —
 * no warning, nothing in `unparseable`, which is the one thing this package's own rule says must not
 * happen: *refuse rather than silently drop*. On a scene heading it lost the **scene**, and then
 * filed that scene's own action as an unparseable construct, naming the wrong line and a cause that
 * was not true of it.
 *
 * And the latch that opened a block comment was `l.includes("/*") && !l.includes("*\/")`. A line
 * holding both — `Visible action. /* old *\/ kept /* cut from here` — fails that test, so the latch
 * never set: the line itself was dropped and **every following line of the boneyard was parsed as
 * film**. Material the writer explicitly cut became a character cue and a spoken line, which is the
 * exact inverse of what the check exists for.
 *
 * Measured before, on this repo's own parser:
 *
 *     without a note          action = ["She slides the envelope across the bar."]
 *     with a trailing note    action = []                    warnings 0, unparseable 0
 *     note on a scene heading scenes = [the *second* scene]   "Unparseable construct at line 3"
 *     boneyard reopened       dialogue = [{character: "SECRET ACTION THE WRITER DELETED", …}]
 */
import {expect, test} from "bun:test";
import {holdsProtectedSpan, parseFountain, scanProtectedSpans} from "../src/index";

const scene = (result: ReturnType<typeof parseFountain>) =>
  result.scenes.map(value => ({heading: value.heading, action: value.action, dialogue: value.dialogue}));

test("a note beside the writer's text costs the note, not the text", () => {
  const plain = parseFountain("INT. BAR - DAY\n\nShe slides the envelope across the bar.");
  const noted = parseFountain("INT. BAR - DAY\n\nShe slides the envelope across the bar. [[needs a rewrite]]");
  expect(noted.scenes[0]!.action).toEqual(["She slides the envelope across the bar."]);
  expect(scene(noted)).toEqual(scene(plain));
  expect({warnings: noted.warnings.length, unparseable: noted.unparseable.length}).toEqual({warnings: 0, unparseable: 0});
  // The same for a closed boneyard, and for a note in the middle of a sentence.
  expect(parseFountain("INT. BAR - DAY\n\nShe waits. /* cut this */").scenes[0]!.action).toEqual(["She waits."]);
  expect(parseFountain("INT. BAR - DAY\n\nShe [[who?]] waits.").scenes[0]!.action).toEqual(["She  waits."]);
});

test("and a note on a scene heading costs the note, not the scene", () => {
  // Before: the heading was dropped, so `current` stayed null, so the scene's own action was filed
  // as unparseable -- at line 3, with a message naming a construct that parses perfectly.
  const result = parseFountain("INT. BAR - DAY [[needs a rewrite]]\n\nShe enters.\n\nEXT. STREET - NIGHT\n\nHe follows.");
  expect(scene(result)).toEqual([
    {heading: "INT. BAR - DAY", action: ["She enters."], dialogue: []},
    {heading: "EXT. STREET - NIGHT", action: ["He follows."], dialogue: []},
  ]);
  expect({warnings: result.warnings, unparseable: result.unparseable}).toEqual({warnings: [], unparseable: []});
});

test("and a boneyard that closes and reopens on one line does not leak what the writer cut", () => {
  // The latch tested `includes("/*") && !includes("*\/")`, which a line holding both fails. The line
  // was dropped and everything after it was film: a cue and a spoken line, out of deleted material.
  const result = parseFountain(
    "INT. LAB - DAY\n\nVisible action. /* old */ kept /* cut from here\n\nSECRET ACTION THE WRITER DELETED\nmore deleted material */");
  expect(result.scenes[0]!.dialogue).toEqual([]);
  expect(result.scenes[0]!.action.join(" ")).toContain("kept");
  expect(JSON.stringify(result)).not.toContain("SECRET ACTION");
  expect(JSON.stringify(result)).not.toContain("more deleted material");
  // And text after the closer on the closing line is film again, which is what makes it a span.
  const resumed = parseFountain("INT. LAB - DAY\n\n/* cut\nstill cut */ She returns.");
  expect(resumed.scenes[0]!.action).toEqual(["She returns."]);
});

test("and a line that was nothing but a note still does not end a speech", () => {
  // The one behaviour that must not change: a whole-line note used to be skipped, and a skipped line
  // is not a blank line. A blank line ends a speech; this must not start doing that.
  const result = parseFountain("INT. BAR - DAY\n\nMAYA\n[[check this]]\nI never said that.");
  expect(result.scenes[0]!.dialogue).toEqual([{character: "MAYA", lines: ["I never said that."]}]);
  // And a genuinely blank line still ends it.
  const ended = parseFountain("INT. BAR - DAY\n\nMAYA\nI never said that.\n\nShe leaves.");
  expect(ended.scenes[0]!.dialogue).toEqual([{character: "MAYA", lines: ["I never said that."]}]);
  expect(ended.scenes[0]!.action).toEqual(["She leaves."]);
});

test("and the predicate HV-016-04 proved equal to its pattern still answers what it answered", () => {
  // `holdsProtectedSpan` is now defined in terms of the scan, so the two cannot disagree -- and it
  // still means "a note or a *closed* boneyard", not "an unterminated opener", which is the block
  // latch's business. `protected-span.test.ts` re-proves the equality over 87,380 strings; this is
  // the one distinction that would have been easy to lose while making it a scan.
  expect(holdsProtectedSpan("a [[note]] b")).toBe(true);
  expect(holdsProtectedSpan("a /* boneyard */ b")).toBe(true);
  expect(holdsProtectedSpan("a /* opens and never closes")).toBe(false);
  expect(scanProtectedSpans("a /* opens and never closes")).toEqual({text: "a ", closedSpans: false, opensBlock: true});
  expect(scanProtectedSpans("a [[note]] b")).toEqual({text: "a  b", closedSpans: true, opensBlock: false});
  expect(scanProtectedSpans("/* old */ kept /* cut")).toEqual({text: " kept ", closedSpans: true, opensBlock: true});
  expect(scanProtectedSpans("nothing here")).toEqual({text: "nothing here", closedSpans: false, opensBlock: false});
});

test("and the whole 200,000 characters the route allows is still one pass", () => {
  // HV-016-04 made this linear and proved it; turning a predicate into a scan is exactly the change
  // that could quietly undo it. Same shape of assertion: eight times the line, at most twenty-four
  // times the work.
  const ms = (work: () => unknown) => {const started = Bun.nanoseconds(); work(); return (Bun.nanoseconds() - started) / 1e6;};
  for (const shape of ["[", "[[", "/*", "/*]", "[[x]]"]) {
    const small = shape.repeat(Math.ceil(25_000 / shape.length)).slice(0, 25_000);
    const large = shape.repeat(Math.ceil(200_000 / shape.length)).slice(0, 200_000);
    scanProtectedSpans(small); scanProtectedSpans(large);
    const at25 = Math.min(...[0, 1, 2].map(() => ms(() => scanProtectedSpans(small))));
    const at200 = Math.min(...[0, 1, 2].map(() => ms(() => scanProtectedSpans(large))));
    const round = (value: number) => Number(value.toFixed(2));
    expect({shape, linear: at200 <= Math.max(at25, 0.05) * 24, at25: round(at25), at200: round(at200)})
      .toEqual({shape, linear: true, at25: round(at25), at200: round(at200)});
  }
  // And the parser as a whole, on the route's own limit as one line.
  const line = "INT. ROOM - DAY\n\n" + "[".repeat(200_000);
  expect(ms(() => parseFountain(line))).toBeLessThan(500);
});
