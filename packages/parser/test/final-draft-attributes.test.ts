/**
 * HV-016-07 — a legal XML attribute ended the tag early.
 *
 * XML requires `<` and `&` to be escaped inside an attribute value. It leaves `>` alone: `a > b` is
 * a legal attribute value and every conformant writer may emit one. This importer found the end of
 * a start tag with `indexOf(">")`, three times over, so the tag ended inside the quotes. What that
 * cost depended on where the character fell — measured on this repo's own importer, before:
 *
 *     <Text AdornmentStyle="a > b">She waits.</Text>
 *       action: `b">She waits.`
 *
 *     <Paragraph Number="a > b" Type="Character"><Text>MAYA</Text></Paragraph>
 *       REFUSED: "This Final Draft script has a speech with no character before it."
 *
 *     <FinalDraft Title="A > B" DocumentType="Script" Version="5">
 *       REFUSED: "Choose a Final Draft script document. Other Final Draft document types are not
 *                 imported."
 *
 * The first is this package's own rule broken: the writer's line goes into the screenplay carrying
 * stray markup, silently, and from there to the prompt, the voice vendor and the burnt-in captions.
 * The other two refuse a legal file and name a cause that is not true of it — which is what
 * HV-016-05 was about one file over, and what HV-016-03 refused three constructs for.
 *
 * `tagEnd` skips quoted attribute values with a forward-only cursor, which is this file's own stated
 * rule: every search here is linear, so the bound on the input is also a bound on the work.
 */
import {expect, test} from "bun:test";
import {importFinalDraft} from "../src/final-draft";

const wrap = (content: string, attributes = 'DocumentType="Script"') =>
  `<?xml version="1.0"?>\n<FinalDraft ${attributes} Version="5">\n<Content>\n${content}\n</Content>\n</FinalDraft>\n`;
const head = '<Paragraph Type="Scene Heading"><Text>INT. HALL - DAY</Text></Paragraph>\n';
const imported = (content: string, attributes?: string) => importFinalDraft(wrap(content, attributes));

test("a > in a Text run's attribute does not put markup into the writer's line", () => {
  // The silent one. `b">She waits.` was the action line, and action is the prompt.
  const result = imported(head + '<Paragraph Type="Action"><Text Style="Bold" AdornmentStyle="a > b">She waits.</Text></Paragraph>');
  expect(result.text).toBe("INT. HALL - DAY\n\nShe waits.\n");
  expect(result.text).not.toContain('">');
  // Two of them in one run, and one in a paragraph attribute, are the same span skipped twice.
  expect(imported(head + '<Paragraph Number="x > y" Type="Action"><Text A="1 > 2" B="3 > 4">She waits.</Text></Paragraph>').text)
    .toBe("INT. HALL - DAY\n\nShe waits.\n");
});

test("and a > before the Type attribute does not lose the paragraph's element name", () => {
  // Attribute order is the writer's file's business, not the importer's. Before, a cue whose Type
  // came after the > was read as an untyped paragraph, so the speech below it had no character and
  // the whole script was refused for a reason that was not true of it.
  expect(imported(head
    + '<Paragraph Number="a > b" Type="Character"><Text>MAYA</Text></Paragraph>\n'
    + '<Paragraph Type="Dialogue"><Text>Get out.</Text></Paragraph>').text)
    .toBe("INT. HALL - DAY\n\nMAYA\nGet out.\n");
  // And the same paragraph with its attributes the other way round reads identically, which is the
  // property that was broken rather than any one ordering.
  expect(imported(head + '<Paragraph Number="a > b" Type="Scene Heading"><Text>EXT. CLIFF - DAY</Text></Paragraph>').text)
    .toBe(imported(head + '<Paragraph Type="Scene Heading" Number="a > b"><Text>EXT. CLIFF - DAY</Text></Paragraph>').text);
});

test("and a > in the root element's attributes does not make a script a different document type", () => {
  expect(imported(head, 'Title="A > B" DocumentType="Script"').text).toBe("INT. HALL - DAY\n");
  // A single-quoted attribute value is legal XML too, and holds a double quote unescaped.
  expect(imported(head, `Title='A > "B"' DocumentType="Script"`).text).toBe("INT. HALL - DAY\n");
});

test("and a document that really is not a script is still refused, by the same message", () => {
  // The refusals this importer makes are the point of it; skipping quotes must not skip a check.
  expect(() => imported(head, 'DocumentType="Report"')).toThrow("Other Final Draft document types are not imported");
  expect(() => imported(head, 'Title="DocumentType=&quot;Script&quot;"')).toThrow("Other Final Draft document types are not imported");
  // A DOCTYPE is still refused before anything is read, and so is a nested note.
  expect(() => importFinalDraft('<!DOCTYPE x>' + wrap(head))).toThrow("document type or entity declaration");
});

test("and an attribute value that never closes its quote is refused, and named for what it is", () => {
  // `tagEnd` runs to the end of the file. That is its own malformation and it is said out loud,
  // rather than reported as a missing `>`: the file is not valid XML and the importer's rule is to
  // refuse it rather than guess where the tag ended.
  //
  // This is the one existing message this increment changes. `final-draft.test.ts` asserted that
  // the same file was refused with "element name this importer cannot read", which was true only
  // because the tag was being read as ending inside the quotes and the `Type` pattern then failed.
  // Still refused, by a message that describes the defect instead of its consequence.
  expect(() => imported(head + '<Paragraph Type="Action><Text>She waits.</Text></Paragraph>'))
    .toThrow("unterminated attribute value");
  // And on the root element, where there is no paragraph to name: not a script, by the check that
  // never sees a document type because the tag has no end.
  expect(() => importFinalDraft(wrap(head).replace('DocumentType="Script"', 'DocumentType="Script'))).toThrow();
});

test("and the whole document is still one pass", () => {
  // HV-016-03 made this reader linear and said so in its header; `tagEnd` is a per-tag scan and a
  // per-tag scan that could restart would be quadratic on a file of tags. Same assertion shape as
  // the parser's: eight times the document, at most twenty-four times the work.
  const ms = (work: () => unknown) => {const started = Bun.nanoseconds(); work(); return (Bun.nanoseconds() - started) / 1e6;};
  for (const paragraph of [
    '<Paragraph Type="Action"><Text>She waits.</Text></Paragraph>\n',
    '<Paragraph N="a > b" Type="Action"><Text A="1 > 2">She waits.</Text></Paragraph>\n',
    '<Paragraph Type="Action"><Text>She waits. >>>>>>>>>></Text></Paragraph>\n',
  ]) {
    const small = wrap(head + paragraph.repeat(500)), large = wrap(head + paragraph.repeat(4_000));
    importFinalDraft(small); importFinalDraft(large);
    const at500 = Math.min(...[0, 1, 2].map(() => ms(() => importFinalDraft(small))));
    const at4000 = Math.min(...[0, 1, 2].map(() => ms(() => importFinalDraft(large))));
    const round = (value: number) => Number(value.toFixed(2));
    expect({linear: at4000 <= Math.max(at500, 1) * 24, at500: round(at500), at4000: round(at4000)})
      .toEqual({linear: true, at500: round(at500), at4000: round(at4000)});
  }
});
