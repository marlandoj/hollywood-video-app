import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {parseFountain} from "../src/index";
import {FINAL_DRAFT_LIMITS,decodeFinalDraftText,importFinalDraft} from "../src/final-draft";

const LIGHTHOUSE=readFileSync(new URL("./fixtures/lighthouse.fdx",import.meta.url),"utf8");
const wrap=(content:string,attributes='DocumentType="Script"')=>
  `<?xml version="1.0"?>\n<FinalDraft ${attributes} Version="5">\n<Content>\n${content}\n</Content>\n</FinalDraft>\n`;
const scene=(heading="INT. HALL - DAY")=>`<Paragraph Type="Scene Heading"><Text>${heading}</Text></Paragraph>`;

test("a Final Draft script becomes the screenplay the studio reads, scene for scene and line for line",()=>{
  const imported=importFinalDraft(LIGHTHOUSE),parsed=parseFountain(imported.text);
  expect(parsed.rejected).toBe(false);
  expect(parsed.scenes).toHaveLength(2);
  const [first,second]=parsed.scenes;
  expect(first!.heading).toBe("INT. LIGHTHOUSE - NIGHT");
  expect(first!.action).toEqual(["Marguerite winds the lamp. Rain & wind hammer the glass."]);
  // A lower-case cue becomes a cue the parser can see, and its speeches stay with it.
  expect(first!.dialogue).toEqual([
    {character:"MARGUERITE",lines:["The light has to hold.","It always has."]},
    {character:"TOMAS",lines:["Then we hold it together."]},
  ]);
  expect(first!.transitions).toEqual(["CUT TO:"]);
  // A heading Final Draft calls a heading but Fountain would not is forced, not lost.
  expect(second!.heading).toBe("THE CLIFF PATH - LATER");
  expect(imported.text).toContain(".THE CLIFF PATH - LATER");
  // A wrapped action paragraph is one line of action, not two.
  expect(second!.action).toEqual(["Tomas walks the path with a lantern. It swings in the dark."]);
  expect(parsed.unparseable).toEqual([]);
});

test("what could not be carried across is reported, never quietly dropped",()=>{
  const notes=importFinalDraft(LIGHTHOUSE).notes,codes=notes.map(value=>value.code);
  // A parenthetical left inside a speech would be spoken aloud and captioned, so it is not imported.
  expect(codes).toContain("parentheticals");
  expect(notes.find(value=>value.code==="parentheticals")!.message).toContain("1 parenthetical was");
  expect(importFinalDraft(LIGHTHOUSE).text).not.toContain("quietly");
  expect(codes).toContain("styling");
  for(const note of notes)expect(note.message.length).toBeGreaterThan(20);
  // Only what the file actually contains is reported.
  expect(codes).not.toContain("title-page");
  expect(codes).not.toContain("dual-dialogue");
  const dual=importFinalDraft(wrap(scene()+'<Paragraph Type="Character" DualDialogue="1"><Text>SPUD</Text></Paragraph><Paragraph Type="Dialogue"><Text>Both at once.</Text></Paragraph>'));
  expect(dual.notes.map(value=>value.code)).toContain("dual-dialogue");
  const titled=importFinalDraft(wrap(scene()).replace("<Content>","<TitlePage><Paragraph><Text>A Film</Text></Paragraph></TitlePage><Content>"));
  expect(titled.notes.map(value=>value.code)).toContain("title-page");
});

test("an importer that cannot represent something refuses it, and says which thing",()=>{
  expect(()=>importFinalDraft("")).toThrow("Choose a Final Draft script");
  expect(()=>importFinalDraft(wrap(scene()).replace("<?xml version=\"1.0\"?>","<?xml version=\"1.0\"?>\n<!DOCTYPE FinalDraft SYSTEM \"http://example.invalid/evil.dtd\">"))).toThrow("document type or entity declaration");
  expect(()=>importFinalDraft(wrap(scene()).replace("<Content>","<!ENTITY x \"y\">\n<Content>"))).toThrow("document type or entity declaration");
  expect(()=>importFinalDraft(wrap(scene(),'DocumentType="Alt Document"'))).toThrow("Choose a Final Draft script document");
  expect(()=>importFinalDraft('<FinalDraft DocumentType="Script"></FinalDraft>')).toThrow("no script content");
  expect(()=>importFinalDraft(wrap('<Paragraph Type="Action"><Text>A room.</Text></Paragraph>'))).toThrow("no scene headings");
  expect(()=>importFinalDraft(wrap(scene()+'<Paragraph Type="Cast List"><Text>Everyone</Text></Paragraph>'))).toThrow("“Cast List” element, which is not imported");
  expect(()=>importFinalDraft(wrap(scene()+'<Paragraph Type="Character"><Text>Mr. Ex-Machina, the 2nd!</Text></Paragraph>'))).toThrow("cannot be imported");
  expect(()=>importFinalDraft(wrap(scene()+'<Paragraph Type="Dialogue"><Text>Who said that?</Text></Paragraph>'))).toThrow("speech with no character before it");
  expect(()=>importFinalDraft(wrap('<Paragraph Type="Character"><Text>SPUD</Text></Paragraph>'+scene()))).toThrow("dialogue before its first scene heading");
  expect(()=>importFinalDraft(wrap('<Paragraph Type="Scene Heading"><Text> </Text></Paragraph>'))).toThrow("empty scene heading");
  expect(()=>importFinalDraft("x".repeat(FINAL_DRAFT_LIMITS.documentCharacters+1))).toThrow("at most 4 MiB");
  const many=wrap(scene()+'<Paragraph Type="Action"><Text>A beat.</Text></Paragraph>'.repeat(FINAL_DRAFT_LIMITS.paragraphs));
  expect(()=>importFinalDraft(many)).toThrow("at most "+FINAL_DRAFT_LIMITS.paragraphs+" paragraphs");
  expect(()=>importFinalDraft(wrap(scene()+'<Paragraph Type="Action"><Text>'+"a".repeat(FINAL_DRAFT_LIMITS.paragraphCharacters+1)+"</Text></Paragraph>"))).toThrow("at most 20000 characters");
});

test("only the five XML names and real code points resolve, and nothing else is guessed at",()=>{
  expect(decodeFinalDraftText("Rain &amp; wind &lt;in&gt; a &quot;storm&quot; &apos;here&apos;")).toBe("Rain & wind <in> a \"storm\" 'here'");
  expect(decodeFinalDraftText("caf&#233; &#x2014; done")).toBe("café — done");
  expect(()=>decodeFinalDraftText("Marks &copy; someone")).toThrow("“&copy;”, which is not imported");
  expect(()=>decodeFinalDraftText("Bare & ampersand")).toThrow("unescaped “&”");
  expect(()=>decodeFinalDraftText("&#xD800;")).toThrow("cannot be imported");
  expect(()=>decodeFinalDraftText("&#x0;")).toThrow("cannot be imported");
});
