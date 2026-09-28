/**
 * HV-016-12 — an imported line containing "/*" deleted the rest of the film, silently.
 *
 * Final Draft and PDF text is the writer's literal words. Both importers hand it to `parseFountain`
 * as Fountain, and Fountain reads `[[…]]` as a note and `/*` as the start of a boneyard that runs to
 * the next closer -- or to the end of the document. So a Final Draft action line reading
 *
 *     Mara types rm -rf /* and hits enter.
 *
 * imported with `notes: []`, kept every scene in the text the editor shows, and gave the film **one
 * scene and "Mara types rm -rf"**: the dialogue after it and the whole second scene were boneyard,
 * with no warning and nothing in `unparseable`. `It says [[classified]] on the cover.` lost its middle
 * the same way. The importers' own rule, in `final-draft.ts`'s header, is that one "that silently
 * loses a line is worse than one that will not run".
 *
 * Fountain has no escape for either marker, so an importer cannot carry them. It refuses by line.
 */
import {expect,test} from "bun:test";
import {hiddenImportedLine,parseFountain} from "../src/index";
import {importFinalDraft} from "../src/final-draft";
import {importPdfScreenplay} from "../src/pdf";
import {MARGIN,SCENE,pdfFixture} from "./pdf-fixture";

const fdx=(action:string,dialogue="You came back.")=>`<?xml version="1.0" encoding="UTF-8"?><FinalDraft DocumentType="Script" Version="1"><Content>
<Paragraph Type="Scene Heading"><Text>INT. OFFICE - NIGHT</Text></Paragraph>
<Paragraph Type="Action"><Text>${action}</Text></Paragraph>
<Paragraph Type="Character"><Text>MARA</Text></Paragraph>
<Paragraph Type="Dialogue"><Text>${dialogue}</Text></Paragraph>
<Paragraph Type="Scene Heading"><Text>EXT. STREET - DAY</Text></Paragraph>
<Paragraph Type="Action"><Text>She runs.</Text></Paragraph>
</Content></FinalDraft>`;

test("what the defect did, measured: the Fountain reader keeps one scene of two",()=>{
  // The importer's text is the writer's; it is the reading of it that loses the film.
  const text="INT. OFFICE - NIGHT\n\nMara types rm -rf /* and hits enter.\n\nMARA\nYou came back.\n\nEXT. STREET - DAY\n\nShe runs.\n";
  const parsed=parseFountain(text);
  expect({scenes:parsed.scenes.length,action:parsed.scenes[0]!.action,dialogue:parsed.scenes[0]!.dialogue.length})
    .toEqual({scenes:1,action:["Mara types rm -rf"],dialogue:0});
  expect(hiddenImportedLine(text)).toEqual({line:3,marker:"/*"});
});

test("a Final Draft line the reader would hide is refused by line, for either marker",()=>{
  expect(()=>importFinalDraft(fdx("Mara types rm -rf /* and hits enter."))).toThrow("Line 3 of this Final Draft script contains “/*”");
  expect(()=>importFinalDraft(fdx("Mara types rm -rf /* and hits enter."))).toThrow("everything after it would silently leave the film");
  expect(()=>importFinalDraft(fdx("Mara reads.","It says [[classified]] on the cover."))).toThrow("Line 6 of this Final Draft script contains “[[ ]]”");
});

test("and a PDF line the same",()=>{
  const lines:[number,string][]=[...SCENE];lines[1]=[MARGIN.action,"Marguerite types rm -rf /* and waits."];
  expect(()=>importPdfScreenplay(pdfFixture({pages:[{lines}]}))).toThrow("of this PDF screenplay contains “/*”");
});

test("and everything the importers already read is read exactly as before",()=>{
  // Only the two markers are refused. A lone closer, a single bracket and a slash are literal to the
  // Fountain reader, and so they are imported.
  for (const literal of ["A */ is not a note.","Seat [3] and [4].","Either/or, and 3 * 4.","A path like /usr/local."]) {
    const imported=importFinalDraft(fdx(literal));
    expect(parseFountain(imported.text).scenes.map(scene=>scene.action[0])).toEqual([literal,"She runs."]);
  }
  expect(parseFountain(importPdfScreenplay(pdfFixture({pages:[{lines:SCENE}]})).text).scenes).toHaveLength(2);
});
