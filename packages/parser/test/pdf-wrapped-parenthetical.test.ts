/**
 * HV-016-22 — a parenthetical that wrapped onto a second line in a PDF turned the whole speech into
 * action.
 *
 * The PDF importer recognised a parenthetical by its text alone, one line at a time:
 *
 *     const parenthetical = /^\(.*\)$/.test(text);
 *
 * A parenthetical too long for its column is printed over two lines -- `(quietly, looking at` /
 * `the door)` -- and neither half is bracketed at both ends. Both fell through to the last rule,
 * "everything else is action", which opens a new paragraph. The speech was cut in two: the cue was
 * left with nothing under it, so `parseFountain` read it as action too (HV-016-06), and the lines
 * said after the parenthetical were appended to the action paragraph. MAYA said nothing; the film
 * got three extra action shots reading her cue, her direction and her line as scene description.
 *
 * A run of lines at the parenthetical margin, from an opener to a line ending `)`, is now one
 * parenthetical, and is dropped and reported as every parenthetical is -- the studio's screenplay has
 * no parenthetical element, and one left in a speech would be spoken and captioned. An opener that
 * never closes at that margin is read as before.
 */
import {expect, test} from "bun:test";
import {parseFountain} from "../src/index";
import {importPdfScreenplay} from "../src/pdf";
import {MARGIN, pdfFixture} from "./pdf-fixture";

const imported = (lines: [number, string][]) => importPdfScreenplay(pdfFixture({deflate: true, pages: [{lines}]}));

test("a parenthetical wrapped onto a second line keeps MAYA's speech, and is reported like any other", () => {
  const result = imported([
    [MARGIN.action, "INT. BAR - NIGHT"],
    [MARGIN.action, "Maya pulls on her coat."],
    [MARGIN.character, "MAYA"],
    [MARGIN.parenthetical, "(quietly, looking at"],
    [MARGIN.parenthetical, "the door)"],
    [MARGIN.dialogue, "I'm leaving."],
    [MARGIN.transition, "CUT TO:"],
  ]);
  const scene = parseFountain(result.text).scenes[0]!;
  expect(scene.dialogue).toEqual([{character: "MAYA", lines: ["I'm leaving."]}]);
  expect(scene.action).toEqual(["Maya pulls on her coat."]);
  expect(scene.transitions).toEqual(["CUT TO:"]);
  expect(result.text).not.toContain("the door");
  expect(result.notes.map(note => note.code)).toContain("parentheticals");
});

test("a parenthetical wrapped over three lines in the middle of a speech leaves the speech whole", () => {
  const result = imported([
    [MARGIN.action, "INT. BAR - NIGHT"],
    [MARGIN.character, "MAYA"],
    [MARGIN.dialogue, "I'm leaving."],
    [MARGIN.parenthetical, "(she stops at the"],
    [MARGIN.parenthetical, "door, and does not"],
    [MARGIN.parenthetical, "turn round)"],
    [MARGIN.dialogue, "Tonight."],
  ]);
  const scene = parseFountain(result.text).scenes[0]!;
  expect(scene.dialogue).toEqual([{character: "MAYA", lines: ["I'm leaving.", "Tonight."]}]);
  expect(scene.action).toEqual([]);
});

test("an opener that never closes at the parenthetical margin keeps its words, as before", () => {
  const result = imported([
    [MARGIN.action, "INT. BAR - NIGHT"],
    [MARGIN.character, "MAYA"],
    [MARGIN.parenthetical, "(quietly, looking at"],
    [MARGIN.dialogue, "the door and leaving."],
  ]);
  expect(result.text).toContain("(quietly, looking at");
  expect(result.text).toContain("the door and leaving.");
  expect(result.notes.some(note => note.code === "parentheticals")).toBe(false);
});
