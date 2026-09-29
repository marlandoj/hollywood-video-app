/**
 * HV-016-20 — page breaks, sections and synopses became action beats and extra shots, and a forced
 * transition or centred text kept its markers.
 *
 * The parser's only rule for Fountain's marked lines was
 *
 *     if (/^[<>~_*]{3,}/.test(t)) {  // unparseable construct
 *
 * and everything else outside a speech was action. So Fountain's non-printing elements -- a page
 * break `===`, a section `# ACT ONE`, a synopsis `= She is nervous.` -- were each an action beat, and
 * `planShots` turns every action beat into a shot: the film grew a shot whose prompt read
 * `INT. BAR - NIGHT. ===` or `INT. BAR - NIGHT. ## Sequence two`, and paid for it. A section before
 * the first scene heading was reported as an unparseable construct. A forced transition,
 * `> BURN TO WHITE.`, was also action -- a shot of the words "> BURN TO WHITE." -- and one that happened
 * to end in `TO:` was a transition that kept its `>`. Centred text, `>THE END<`, was shot with its
 * markers in the prompt.
 *
 * Outside a speech, a line starting `#` or `=` is now skipped, `> X` is a transition "X", and `>X<` is
 * action "X". A run of three marker characters is still unparseable, and inside a speech every line
 * is spoken as written, as before. Because these lines no longer read as their literal words, the PDF
 * and Final Draft importers refuse one by line, as HV-016-12 made them refuse a `/*`; and the living
 * script's evidence check reads a marked line through `printedText`, as the parser does.
 */
import {expect, test} from "bun:test";
import * as parser from "../src/index";
import {parseFountain} from "../src/index";
import {importFinalDraft} from "../src/final-draft";
import {importPdfScreenplay} from "../src/pdf";
import {planShots} from "../../planner/src/index";
import {compileLivingScriptDocument} from "../../planner/src/living-script-document";
import {createLivingScriptStructureBase} from "../../planner/src/living-script-structure";
import {MARGIN, SCENE, pdfFixture} from "./pdf-fixture";

test("a page break between two action lines is neither an action beat nor a shot", () => {
  const parsed = parseFountain("INT. BAR - NIGHT\n\nShe waits.\n\n===\n\nShe leaves.\n");
  expect(parsed.scenes[0]!.action).toEqual(["She waits.", "She leaves."]);
  expect(parsed.scenes[0]!.beats!.map(beat => beat.kind)).toEqual(["action", "action"]);
  expect(planShots(parsed).map(shot => shot.prompt)).toEqual(["INT. BAR - NIGHT. She waits.", "INT. BAR - NIGHT. She leaves."]);
});

test("sections and synopses are neither action nor shots, inside a scene or before the first one", () => {
  const parsed = parseFountain("# ACT ONE\n\n= The night it went wrong.\n\nINT. BAR - NIGHT\n\nShe waits.\n\n= She is nervous.\n\n## Sequence two\n");
  expect(parsed.scenes[0]!.action).toEqual(["She waits."]);
  expect(planShots(parsed)).toHaveLength(1);
  expect({warnings: parsed.warnings, unparseable: parsed.unparseable}).toEqual({warnings: [], unparseable: []});
});

test("a forced transition is a transition without its >, and one ending in TO: loses its > too", () => {
  const parsed = parseFountain("INT. BAR - NIGHT\n\nShe waits.\n\n> BURN TO WHITE.\n\nShe leaves.\n\n> CUT TO:\n");
  expect(parsed.scenes[0]!.transitions).toEqual(["BURN TO WHITE.", "CUT TO:"]);
  expect(parsed.scenes[0]!.action).toEqual(["She waits.", "She leaves."]);
  expect(parsed.scenes[0]!.beats!.map(beat => beat.kind)).toEqual(["action", "transition", "action", "transition"]);
});

test("centred text is action without its markers, and a run of markers is still unparseable", () => {
  const parsed = parseFountain("INT. BAR - NIGHT\n\n>THE END<\n\n> INTERMISSION <\n\n>>>~~~ broken markup ~~~<<<\n");
  expect(parsed.scenes[0]!.action).toEqual(["THE END", "INTERMISSION"]);
  expect(planShots(parsed).map(shot => shot.prompt).join(" ")).not.toMatch(/[<>]/);
  expect(parsed.unparseable).toEqual([{line: 7, text: ">>>~~~ broken markup ~~~<<<"}]);
  // Inside a speech every line is still spoken as written.
  expect(parseFountain("INT. BAR - NIGHT\n\nMAYA\n= Two.\n# Three.\n> Four.\n").scenes[0]!.dialogue).toEqual([{character: "MAYA", lines: ["= Two.", "# Three.", "> Four."]}]);
});

const fdx = (action: string) => `<?xml version="1.0" encoding="UTF-8"?><FinalDraft DocumentType="Script" Version="1"><Content>
<Paragraph Type="Scene Heading"><Text>INT. OFFICE - NIGHT</Text></Paragraph>
<Paragraph Type="Action"><Text>${action}</Text></Paragraph>
</Content></FinalDraft>`;

test("an importer refuses, by line, a line the screenplay would now read as a section, synopsis, page break or transition", () => {
  expect(() => importFinalDraft(fdx("# of guests: twelve."))).toThrow("Line 3 of this Final Draft script starts with “#”, which the studio's screenplay format reads as a section heading");
  expect(() => importFinalDraft(fdx("= is all she writes."))).toThrow("starts with “=”, which the studio's screenplay format reads as a synopsis or page break");
  expect(() => importFinalDraft(fdx("&gt; is the prompt."))).toThrow("starts with “>”, which the studio's screenplay format reads as a transition or centred text");
  const lines: [number, string][] = [...SCENE]; lines[1] = [MARGIN.action, "# of guests: twelve."];
  expect(() => importPdfScreenplay(pdfFixture({pages: [{lines}]}))).toThrow("of this PDF screenplay starts with “#”");
  // A marker anywhere but the start of a line is literal, and is imported.
  expect(parser.hiddenImportedLine("INT. OFFICE - NIGHT\n\nSeat #3 = row C > aisle.\n")).toBeNull();
});

test("the living script binds forced transitions and centred text, and puts page breaks, sections and synopses in no beat", () => {
  const text = "INT. BAR - NIGHT\n\nShe waits.\n\n===\n\n= She is nervous.\n\n# ACT TWO\n\n>THE END<\n\n> BURN TO WHITE.\n";
  const document = compileLivingScriptDocument({base: createLivingScriptStructureBase({projectId: "non-printing", version: 1, text, locks: []}), ancestry: []});
  expect(document.scenes[0]!.beats.map(beat => [beat.kind, beat.startLine])).toEqual([["action", 3], ["action", 11], ["transition", 13]]);
  expect(parser.printedText?.(">THE END<")).toBe("THE END");
});
