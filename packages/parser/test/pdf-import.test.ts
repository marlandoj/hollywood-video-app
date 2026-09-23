/**
 * HV-016-08 — a screenplay read out of a PDF's text layer.
 *
 * Release 2's HV-016 slice is "FDX and PDF import". FDX is built (HV-016-01…07). `SCRIPT-IMPORT.md`
 * said of the other half: *"PDF import is not built. FULL-SCOPE scopes it as 'OCR + structure
 * recovery', which is a different problem from reading a structured file and needs its own work."*
 *
 * Half of that is still true: OCR is a different problem and would mean a vendor, which this program
 * does not add. The other half is not. A screenplay PDF exported by Final Draft, Highland, Fade In
 * or Writer Duet carries a **text layer**, and a screenplay's element types are carried by its left
 * margins — action at 1.5in, dialogue at 2.5in, a parenthetical at 3.0in, a cue at 3.5in, a
 * transition at 6.0in. That is what screenplay format *is*. So the text layer is read and the
 * structure is recovered from the margins, and a file that cannot be read that way is refused by
 * name rather than imported as an empty or a garbled screenplay.
 *
 * The fixtures are written by hand, byte for byte (`pdf-fixture.ts`), so a test states the layout it
 * is asserting about rather than proving that this importer reads one word processor.
 */
import {expect, test} from "bun:test";
import {parseFountain} from "../src/index";
import {PDF_LIMITS, importPdfScreenplay, pdfLines, readPdfText} from "../src/pdf";
import {MARGIN, SCENE, pdfFixture} from "./pdf-fixture";

const scene = (overrides: Partial<Parameters<typeof pdfFixture>[0]> = {}) => pdfFixture({pages: [{lines: SCENE}], ...overrides});

test("a screenplay PDF becomes the screenplay the studio reads, scene for scene and line for line", () => {
  const imported = importPdfScreenplay(scene({deflate: true}));
  const parsed = parseFountain(imported.text);
  expect(parsed.rejected).toBe(false);
  expect(parsed.scenes.map(value => ({heading: value.heading, action: value.action, dialogue: value.dialogue, transitions: value.transitions}))).toEqual([
    {
      heading: "INT. LIGHTHOUSE - NIGHT",
      action: ["Marguerite winds the lamp. Rain hammers the glass."],
      dialogue: [{character: "MARGUERITE", lines: ["The light has to hold."]}, {character: "TOMAS", lines: ["Then we hold it together."]}],
      transitions: ["CUT TO:"],
    },
    {heading: "EXT. THE CLIFF PATH - LATER", action: ["Tomas walks the path with a lantern."], dialogue: [], transitions: []},
  ]);
  expect(parsed.unparseable).toEqual([]);
  // Uncompressed and FlateDecode are the same screenplay; every real producer uses the second.
  expect(importPdfScreenplay(scene({deflate: false})).text).toBe(imported.text);
});

test("and the margins are read from the page's own leftmost text, not from an absolute point", () => {
  // A wider binding margin, a different paper size, a producer that shifts everything right: the
  // element is the *offset* between the margins, which is what a screenplay actually specifies.
  for (const shift of [0, 0.4, 1.1]) {
    const shifted = pdfFixture({pages: [{lines: SCENE.map(([inches, text]) => [inches + shift, text] as [number, string])}]});
    expect({shift, text: importPdfScreenplay(shifted).text}).toEqual({shift, text: importPdfScreenplay(scene()).text});
  }
});

test("and what could not be carried across is reported, never quietly dropped", () => {
  const notes = importPdfScreenplay(scene()).notes;
  // A parenthetical left inside a speech would be spoken by the voice vendor and burned into the
  // caption, which is why the Final Draft importer drops and counts it. The same reason, the same
  // answer.
  // Only what the file actually contains is reported, which is the Final Draft importer's own rule:
  // this scene has a parenthetical and no page furniture, so it says so and says nothing else.
  expect(notes.map(note => note.code).sort()).toEqual(["parentheticals", "styling"]);
  expect(importPdfScreenplay(scene()).text).not.toContain("quietly");
  for (const note of notes) expect(note.message.length).toBeGreaterThan(20);
  // A page number on its own line is furniture wherever it sits, and is not in the screenplay.
  const numbered = importPdfScreenplay(pdfFixture({pages: [{lines: [[7.2, "2."], ...SCENE]}]}));
  expect(numbered.text).not.toContain("2.");
  expect(numbered.notes.map(note => note.code)).toContain("page-furniture");
});

test("and every page is read, in page order", () => {
  const two = importPdfScreenplay(pdfFixture({deflate: true, pages: [{lines: SCENE}, {lines: [[MARGIN.action, "INT. BOAT - DAWN"], [MARGIN.action, "Fog."]]}]}));
  expect(parseFountain(two.text).scenes.map(value => value.heading)).toEqual(["INT. LIGHTHOUSE - NIGHT", "EXT. THE CLIFF PATH - LATER", "INT. BOAT - DAWN"]);
  // The runs come back with their page, which is what puts them in order.
  const items = readPdfText(pdfFixture({pages: [{lines: [[MARGIN.action, "A"]]}, {lines: [[MARGIN.action, "B"]]}]}));
  expect(items.map(item => [item.page, item.text])).toEqual([[1, "A"], [2, "B"]]);
});

test("and a cue is written as a cue only when something is said under it", () => {
  // The importer lays out Fountain, so what it must get right is the blank line. A cue and its
  // speech are written with no blank between them; a capitalised line on the cue margin with
  // nothing said under it is written as its own block, which is action.
  const said = importPdfScreenplay(pdfFixture({pages: [{lines: [
    [MARGIN.action, "INT. LIGHTHOUSE - NIGHT"], [MARGIN.character, "MARGUERITE"], [MARGIN.dialogue, "The light has to hold."]]}]}));
  expect(said.text).toBe("INT. LIGHTHOUSE - NIGHT\n\nMARGUERITE\nThe light has to hold.\n");
  const unsaid = importPdfScreenplay(pdfFixture({pages: [{lines: [
    [MARGIN.action, "INT. LIGHTHOUSE - NIGHT"], [MARGIN.character, "A DOOR SLAMS"], [MARGIN.action, "She waits."]]}]}));
  expect(unsaid.text).toBe("INT. LIGHTHOUSE - NIGHT\n\nA DOOR SLAMS\n\nShe waits.\n");
  // Whether `parseFountain` then reads a lone capitalised block as action is its own rule and its
  // own increment (HV-016-06); what this importer owes it is the blank line.
});

test("and a file this importer cannot read is refused by name, never imported as an empty screenplay", () => {
  // Each of these is a way of reading the file wrong, and each one refuses instead. The scan is the
  // one that matters most: an image of a script has no text layer at all, and importing it as an
  // empty screenplay would be the silent drop this package forbids.
  expect(() => importPdfScreenplay(pdfFixture({pages: [{lines: []}]}))).toThrow("no text layer");
  expect(() => importPdfScreenplay(new TextEncoder().encode("not a pdf at all"))).toThrow("is not a PDF");
  expect(() => importPdfScreenplay(new Uint8Array(0))).toThrow("Choose a PDF screenplay to import");
  expect(() => importPdfScreenplay(scene({encrypted: true}))).toThrow("encrypted");
  expect(() => importPdfScreenplay(scene({filter: "LZWDecode"}))).toThrow("LZWDecode");
  // A font whose bytes are not the letters it shows: reading them anyway is silent mojibake, which
  // is worse than a refusal because it looks like a screenplay and says nothing.
  expect(() => importPdfScreenplay(scene({font: " /ToUnicode 9 0 R"}))).toThrow("its own character map");
  expect(() => importPdfScreenplay(scene({font: " /Encoding << /Differences [1 /A] >>"}))).toThrow("re-mapped encoding");
  expect(() => importPdfScreenplay(scene({font: " /X /Y >>\n<< /Subtype /Type0"}))).toThrow("composite (Type0) font");
  // Text that is not laid out as a screenplay is not a screenplay, and the refusal counts it.
  expect(() => importPdfScreenplay(pdfFixture({pages: [{lines: [[1.5, "INT. A - DAY"], [4.2, "x"], [4.3, "y"], [4.4, "z"], [4.5, "w"]]}]})))
    .toThrow("4 of 5 lines sit outside the margins");
  expect(() => importPdfScreenplay(pdfFixture({pages: [{lines: [[MARGIN.action, "She waits."], [MARGIN.action, "He leaves."]]}]})))
    .toThrow("no scene headings");
  expect(() => importPdfScreenplay(pdfFixture({pages: Array.from({length: PDF_LIMITS.pages + 1}, () => ({lines: SCENE}))})))
    .toThrow("at most " + PDF_LIMITS.pages + " pages");
});

test("and the runs on one baseline are one line, in reading order", () => {
  // A producer may draw a line in several runs -- one per word, or one per style change. They are
  // one line of the screenplay, and the gap between them decides whether there was a space.
  const items = [
    {page: 1, x: 108, y: 700, text: "She"}, {page: 1, x: 108 + 3 * 7.2 + 7.2, y: 700, text: "waits."},
    {page: 1, x: 108, y: 688, text: "He"}, {page: 1, x: 108 + 3 * 7.2, y: 688.5, text: "leaves."},
  ];
  expect(pdfLines(items).map(line => line.text)).toEqual(["She waits.", "He leaves."]);
  // Two runs with no gap are one word, which is how a producer splits a word across a style change.
  expect(pdfLines([{page: 1, x: 108, y: 700, text: "Mar"}, {page: 1, x: 108 + 3 * 7.2, y: 700, text: "guerite"}]).map(line => line.text))
    .toEqual(["Marguerite"]);
  // Out of order on the page is still in reading order afterwards: down the page, then across it.
  expect(pdfLines([...items].reverse()).map(line => line.text)).toEqual(["She waits.", "He leaves."]);
});

test("and the whole document is one pass", () => {
  // `final-draft.ts` states the rule this reader inherits: every search is linear, so the bound on
  // the input is also a bound on the work. Eight times the screenplay, at most twenty-four times the
  // work -- the same assertion shape as the Fountain parser's and the Final Draft reader's.
  const ms = (work: () => unknown) => {const started = Bun.nanoseconds(); work(); return (Bun.nanoseconds() - started) / 1e6;};
  const pages = (count: number) => pdfFixture({deflate: true, pages: Array.from({length: count}, () => ({lines: SCENE}))});
  const small = pages(4), large = pages(32);
  importPdfScreenplay(small); importPdfScreenplay(large);
  const at4 = Math.min(...[0, 1, 2].map(() => ms(() => importPdfScreenplay(small))));
  const at32 = Math.min(...[0, 1, 2].map(() => ms(() => importPdfScreenplay(large))));
  const round = (value: number) => Number(value.toFixed(2));
  expect({linear: at32 <= Math.max(at4, 1) * 24, at4: round(at4), at32: round(at32)}).toEqual({linear: true, at4: round(at4), at32: round(at32)});
});
