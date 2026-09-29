/**
 * HV-016-17 — an `INT/EXT.` scene heading was read as action, and its scene folded into the one before.
 *
 * Fountain lists the scene-heading prefixes as INT, EXT, EST, INT./EXT, INT/EXT and I/E. The parser's
 * pattern was
 *
 *     /^(INT|EXT|EST|INT\.\/EXT|I\/E)[.\s]/i
 *
 * which has `INT./EXT` but not `INT/EXT` -- the spelling most screenwriting programs print for a car
 * or a doorway. `INT/EXT. CAR - NIGHT` matched none of them, so it became an action line of the
 * previous scene with no warning: the car scene's action and dialogue were planned and shot under
 * the kitchen's heading, the scene count dropped by one, and a script that opened with one had no
 * first scene at all. The PDF importer and the edit-script and living-script heading finders carry
 * copies of the same pattern and lost the same scene; the creative bible's location list, which
 * strips the prefix with its own pattern, filed the car as "INT/EXT. CAR" (and "INT./EXT. CAR" as
 * "/EXT. CAR").
 *
 * Every copy now accepts every prefix Fountain lists, `INT/EXT` included.
 */
import {expect, test} from "bun:test";
import {readFileSync} from "node:fs";
import {parseFountain} from "../src/index";
import {importPdfScreenplay} from "../src/pdf";
import {generateBible} from "../../planner/src/index";
import {MARGIN, pdfFixture} from "./pdf-fixture";

const SCRIPT = "INT. KITCHEN - DAY\n\nMaya pours tea.\n\nINT/EXT. CAR - NIGHT\n\nLeo drives in silence.\n\nLEO\nWe're late.\n";

test("an INT/EXT. heading starts its own scene, with its own action and dialogue", () => {
  const parsed = parseFountain(SCRIPT);
  expect(parsed.scenes.map(scene => scene.heading)).toEqual(["INT. KITCHEN - DAY", "INT/EXT. CAR - NIGHT"]);
  expect(parsed.scenes[0]!.action).toEqual(["Maya pours tea."]);
  expect(parsed.scenes[1]!.action).toEqual(["Leo drives in silence."]);
  expect(parsed.scenes[1]!.dialogue.map(line => line.character)).toEqual(["LEO"]);
});

test("every prefix Fountain lists starts a scene, in either case, and a word that only begins like one does not", () => {
  for (const prefix of ["INT.", "EXT.", "EST.", "INT./EXT.", "INT/EXT.", "I/E.", "int/ext", "Int./Ext."]) {
    expect({prefix, scenes: parseFountain(prefix + " CAR - DAY\n\nLeo drives.\n").scenes.length}).toEqual({prefix, scenes: 1});
  }
  expect(parseFountain("INT. HALL - DAY\n\nINTERIOR designers argue.\n").scenes.length).toBe(1);
});

test("a PDF whose scene heading is INT/EXT. imports that scene", () => {
  const imported = importPdfScreenplay(pdfFixture({pages: [{lines: [
    [MARGIN.action, "INT. KITCHEN - DAY"], [MARGIN.action, "Maya pours tea."],
    [MARGIN.action, "INT/EXT. CAR - NIGHT"], [MARGIN.action, "Leo drives in silence."],
  ]}]}));
  expect(parseFountain(imported.text).scenes.map(scene => scene.heading)).toEqual(["INT. KITCHEN - DAY", "INT/EXT. CAR - NIGHT"]);
});

test("the creative bible files an INT/EXT scene under its location", () => {
  const bible = generateBible("p1", parseFountain(SCRIPT + "\nINT./EXT. BARN - DAY\n\nHay.\n"));
  expect(bible.locations).toEqual(["KITCHEN", "CAR", "BARN"]);
});

test("every copy of the heading pattern accepts every prefix the parser does", () => {
  const files = ["../src/index.ts", "../src/pdf.ts", "../src/final-draft.ts", "../../planner/src/edit-script-source.ts", "../../planner/src/living-script-document.ts"];
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), "utf8");
    const patterns = [...source.matchAll(/\/\^\((?:[^()]*I\\\/E)\)\[\.\\s\]\/i/g)].map(match => match[0]);
    expect({file, found: patterns.length > 0}).toEqual({file, found: true});
    for (const literal of patterns) {
      const pattern = new RegExp(literal.slice(1, -2), "i");
      for (const prefix of ["INT.", "EXT.", "EST.", "INT./EXT.", "INT/EXT.", "I/E."]) expect({file, prefix, heading: pattern.test(prefix + " CAR")}).toEqual({file, prefix, heading: true});
    }
  }
});
