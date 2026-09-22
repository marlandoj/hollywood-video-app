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

test("a hostile document is bounded in time as well as in size",()=>{
  // HV-016-02: `<Tag[^>]*>` is quadratic on a file full of unterminated tags, and this reader is
  // reachable from a route on a single-threaded server. Before the scan replaced the match, the first
  // of these took 46 seconds at 200,000 tags and grew fourfold per doubling.
  const hostile:[string,string][]=[
    ["content",'<FinalDraft DocumentType="Script">'+"<Content".repeat(400000)],
    ["paragraph",'<FinalDraft DocumentType="Script"><Content>'+"<Paragraph".repeat(400000)+"</Content>"],
    ["text",'<FinalDraft DocumentType="Script"><Content><Paragraph Type="Action">'+"<Text".repeat(300000)+"</Paragraph></Content>"],
    ["root","<FinalDraft".repeat(300000)],
  ];
  for(const [name,document] of hostile){
    const started=performance.now();
    expect(()=>importFinalDraft(document)).toThrow();
    expect({name,seconds:performance.now()-started<2000}).toEqual({name,seconds:true});
  }
  // And a real script of nineteen thousand paragraphs is read in the same breath.
  const long='<FinalDraft DocumentType="Script"><Content>'+scene()+'<Paragraph Type="Action"><Text>A beat.</Text></Paragraph>'.repeat(19000)+"</Content></FinalDraft>";
  const started=performance.now(),imported=importFinalDraft(long);
  expect(performance.now()-started).toBeLessThan(2000);
  expect(imported.text.length).toBeGreaterThan(100000);
});

test("a script note is not imported, and does not become part of the film",()=>{
  const document=wrap(scene()+'<Paragraph Type="Action"><Text>He waits by the door.</Text>'
    +'<ScriptNote><Paragraph><Text>TODO: rewrite this beat, maybe cut the scene</Text></Paragraph></ScriptNote></Paragraph>');
  const imported=importFinalDraft(document);
  // Left in place its words would be read as action, reach the shot prompt, and be spoken and captioned.
  expect(imported.text).toContain("He waits by the door.");
  expect(imported.text).not.toContain("TODO");
  expect(imported.notes.map(note=>note.code)).toContain("script-notes");
  expect(imported.notes.find(note=>note.code==="script-notes")!.message).toContain("1 script note was");
  expect(parseFountain(imported.text).scenes[0]!.action).toEqual(["He waits by the door."]);
  // A paragraph nested any other way is refused rather than guessed at.
  expect(()=>importFinalDraft(wrap(scene()+'<Paragraph Type="Action"><Text>A</Text><Paragraph Type="Action"><Text>B</Text></Paragraph></Paragraph>'))).toThrow("nests a paragraph inside another");
  expect(()=>importFinalDraft(wrap(scene()+'<Paragraph Type="Action"><Text>A</Text>'))).toThrow("unclosed paragraph");
});

test("a heading the writer already forced keeps one dot, and its scene survives",()=>{
  const document=wrap(scene()+'<Paragraph Type="Action"><Text>A.</Text></Paragraph>'
    +'<Paragraph Type="Scene Heading"><Text>.THE VOID</Text></Paragraph><Paragraph Type="Action"><Text>B.</Text></Paragraph>'
    +'<Paragraph Type="Scene Heading"><Text>EXT. STREET - NIGHT</Text></Paragraph><Paragraph Type="Action"><Text>C.</Text></Paragraph>');
  const imported=importFinalDraft(document);
  // "..X" is an escape in Fountain, so the doubled dot took the scene out of the film in silence.
  expect(imported.text).not.toContain("..THE VOID");
  const parsed=parseFountain(imported.text);
  expect(parsed.scenes.map(value=>value.heading)).toEqual(["INT. HALL - DAY","THE VOID","EXT. STREET - NIGHT"]);
  expect(()=>importFinalDraft(wrap('<Paragraph Type="Scene Heading"><Text>...</Text></Paragraph>'))).toThrow("empty scene heading");
});

test("every control character is refused, however it is written",()=>{
  for(const encoded of ["&#11;","&#14;","&#27;","&#31;","&#x1b;","&#0;","&#x7f;","&#x9f;"])
    expect(()=>decodeFinalDraftText("He waits."+encoded)).toThrow("cannot be imported");
  // And literal control bytes, which never pass through the entity decoder at all.
  for(const literal of ["\u001b","\u000e","\u001f","\u000b"])
    expect(()=>decodeFinalDraftText("He waits."+literal)).toThrow("control character");
  expect(()=>importFinalDraft(wrap(scene()+'<Paragraph Type="Action"><Text>Red\u001b[31m text</Text></Paragraph>'))).toThrow("control character");
  // Tab, newline and carriage return are text, and survive as the spacing they are.
  expect(decodeFinalDraftText("a\tb\nc\r")).toBe("a\tb\nc\r");
});
