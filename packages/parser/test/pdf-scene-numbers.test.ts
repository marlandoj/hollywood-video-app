/**
 * HV-016-13 — a numbered shooting script was refused as "not laid out as a screenplay".
 *
 * A production or shooting draft prints each scene's number in the margin beside its heading, in the
 * left margin, the right margin or both, as runs of their own on the heading's baseline. Every
 * screenwriting program offers it and a script that has been through a production office has it.
 * The PDF importer promised, in its header and in docs/SCRIPT-IMPORT.md, that scene numbers are "not
 * carried" and reported as a note. What it did:
 *
 * - **A left-hand number** became the page's leftmost text. Margins are measured from that, so every
 *   action line sat half an inch right of "action" and the script was refused: "This PDF's text is
 *   not laid out as a screenplay — 3 of 10 lines sit outside the margins a screenplay uses." It was
 *   laid out as one. The writer was told to export from a program that had just exported it.
 * - **A right-hand number** was glued onto the heading. `INT. LIGHTHOUSE - NIGHT 12A` imported
 *   without a word, and "NIGHT 12A" is not a time of day.
 *
 * Scene numbers beside a heading are now taken off the line and reported as a note.
 */
import {expect, test} from "bun:test";
import {parseFountain} from "../src/index";
import {importPdfScreenplay} from "../src/pdf";
import {MARGIN, SCENE, pdfFixture, type PdfLineSpec} from "./pdf-fixture";

/** SCENE with each heading's number printed in the margins a screenwriting program uses. */
const numbered = (left: boolean, right: boolean): PdfLineSpec[] => {
  let scene = 0;
  return SCENE.map(([inches, text]) => {
    if (!/^(INT|EXT)\./.test(text)) return [inches, text];
    const label = String(++scene) + (scene === 2 ? "A" : "");
    return [inches, text, [...(left ? [[0.9, label] as [number, string]] : []), ...(right ? [[7.3, label] as [number, string]] : [])]];
  });
};
const plain = importPdfScreenplay(pdfFixture({pages: [{lines: SCENE}]}));

test("scene numbers in either margin, or both, import as the same screenplay the unnumbered draft does", () => {
  for (const [left, right] of [[true, true], [true, false], [false, true]] as const) {
    const imported = importPdfScreenplay(pdfFixture({pages: [{lines: numbered(left, right)}]}));
    expect({left, right, text: imported.text}).toEqual({left, right, text: plain.text});
    expect(parseFountain(imported.text).scenes.map(scene => scene.heading)).toEqual(["INT. LIGHTHOUSE - NIGHT", "EXT. THE CLIFF PATH - LATER"]);
  }
});

test("and the writer is told they were not carried, which the importer always said it did", () => {
  const imported = importPdfScreenplay(pdfFixture({pages: [{lines: numbered(true, true)}]}));
  expect(imported.notes.find(note => note.code === "scene-numbers")?.message)
    .toBe("Scene numbers were not imported; the studio numbers scenes in the order they appear.");
  expect(plain.notes.some(note => note.code === "scene-numbers")).toBe(false);
});

test("a number is a scene number only beside a heading, only on its own, and only across a clear gap", () => {
  const lines: PdfLineSpec[] = [
    // A heading that ends in a number, drawn as its own run a single space after the words.
    [MARGIN.action, "EXT. HIGHWAY", [[MARGIN.action + 1.3, "101"]]],
    // An action line that starts with a number, in its own run.
    [MARGIN.action, "12", [[MARGIN.action + 0.3, "monkeys sit on the dashboard."]]],
    // A right-hand run beside action is not a scene number.
    [MARGIN.action, "The mile marker reads", [[7.3, "40"]]],
    [MARGIN.action, "INT. CAR - NIGHT", [[7.3, "(12)"]]],
  ];
  const text = importPdfScreenplay(pdfFixture({pages: [{lines}]})).text;
  expect(text.split("\n").filter(Boolean)).toEqual([
    "EXT. HIGHWAY 101", "12 monkeys sit on the dashboard.", "The mile marker reads 40", "INT. CAR - NIGHT (12)"]);
});
