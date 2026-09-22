/**
 * HV-016: a Final Draft script, read into the Fountain this studio already understands.
 *
 * Written by hand and bounded at every step, like the retained caption reader: a general XML parser
 * would bring entity expansion and external-entity resolution to a file a stranger supplies, and this
 * needs none of it. Anything the studio's own screenplay model cannot hold is **refused or reported**,
 * never quietly dropped — an importer that silently loses a line is worse than one that will not run,
 * because the writer cannot see what went missing.
 *
 * HV-016-02: the tags are found by scanning, not by matching. A pattern of the shape `<Tag[^>]*>` is
 * quadratic on a file full of unterminated tags, and this reader is reachable from a route, so a
 * 4 MiB document could hold the studio's single thread for minutes. Every search here is a linear
 * `indexOf`, and the bound on the input is therefore also a bound on the work.
 */
export const FINAL_DRAFT_LIMITS=Object.freeze({documentCharacters:4*1024**2,paragraphs:20000,paragraphCharacters:20000,fountainCharacters:200000});
export interface ScriptImportNote {code:string;message:string}
export interface ScriptImport {text:string;notes:ScriptImportNote[]}
const SCENE_HEADING=/^(INT|EXT|EST|INT\.\/EXT|I\/E)[.\s]/i;
const TRANSITION=/(TO:|FADE OUT\.?|FADE IN:?|CUT TO BLACK\.?)$/;
const CHARACTER=/^[A-Z][A-Z0-9 '().-]*$/;
/** The five XML names, and code points that are real characters. Nothing else resolves. */
const NAMED:Record<string,string>={amp:"&",lt:"<",gt:">",quot:"\"",apos:"'"};
const fail:(message:string)=>never=message=>{throw new Error(message);};
/** Tab, newline and carriage return are text. Every other control code is not, in any encoding of it. */
const control=(code:number)=>code<32&&![9,10,13].includes(code)||code>=0x7f&&code<=0x9f;
/** Scanned rather than replaced, so a decoded "&" is never mistaken for an unescaped one. */
export function decodeFinalDraftText(value:string):string{
  let result="",index=0;
  for(let at=value.indexOf("&",index);at>=0;at=value.indexOf("&",index)){
    result+=value.slice(index,at);
    const end=value.indexOf(";",at+1),entity=end>at+1&&end-at<=9?value.slice(at+1,end):"";
    if(!entity||/[^A-Za-z0-9#]/.test(entity))fail("This Final Draft script has an unescaped “&”. Re-export it from Final Draft before importing.");
    if(Object.hasOwn(NAMED,entity))result+=NAMED[entity]!;
    else{
      const numeric=/^#(x)?([0-9a-fA-F]{1,6})$/.exec(entity);
      if(!numeric)fail("This Final Draft script uses the character entity “&"+entity+";”, which is not imported.");
      const code=Number.parseInt(numeric![2]!,numeric![1]?16:10);
      if(!Number.isFinite(code)||code>0x10ffff||code>=0xd800&&code<=0xdfff||control(code))
        fail("This Final Draft script uses a character that cannot be imported.");
      result+=String.fromCodePoint(code);
    }
    index=end+1;
  }
  result+=value.slice(index);
  if([...result].some(character=>control(character.charCodeAt(0))))fail("This Final Draft script contains a control character that cannot be imported.");
  return result;
}
/**
 * HV-016-03: a scan, not three replacements.
 *
 * Replacing a `\s*` `\r?\n` `\s*` pattern is quadratic on a run of whitespace that is not a
 * newline: at every position the leading `\s*` eats the whole run, fails on the newline, and
 * backtracks one character at a time. The first pass collapsed spaces, tabs and non-breaking spaces but not carriage returns, so a
 * paragraph of 19,980 `\r` characters -- inside every bound this file states -- took 257 ms, and two
 * hundred of them, inside the route's own 8 MiB body limit, took **54 seconds of blocked CPU**. That
 * is exactly what the header above claims was eliminated in HV-016-02: the tag scanning was fixed and
 * the whitespace normalizer that runs on every paragraph was not, so the 4 MiB bound on the input was
 * not a bound on the work.
 *
 * The same six characters the old first pass collapsed are collapsed here, and no others. An
 * ideographic or thin space is a character the writer typed, and the old passes converted one only
 * when a newline happened to be beside it.
 */
const SPACE=(code:number)=>code===32||code===0xa0||code>=9&&code<=13;
export function collapseFinalDraftText(value:string):string{
  const parts:string[]=[];let index=0;
  while(index<value.length){
    while(index<value.length&&SPACE(value.charCodeAt(index)))index++;
    const start=index;
    while(index<value.length&&!SPACE(value.charCodeAt(index)))index++;
    if(index>start)parts.push(value.slice(start,index));
  }
  return parts.join(" ");
}
/** True when what follows the tag name ends it, so `<Contents>` is not read as `<Content>`. */
const boundary=(value:string|undefined)=>value===undefined||value===">"||value==="/"||/\s/.test(value);
/** True when an element with this name opens at or after `from`, terminated or not. */
function opens(source:string,name:string,from=0):boolean{
  for(let at=source.indexOf("<"+name,from);at>=0;at=source.indexOf("<"+name,at+1))if(boundary(source[at+name.length+1]))return true;
  return false;
}
/**
 * One element's contents, found by scanning. Returns null when the element is not there at all --
 * **and** when one opens and never closes, which every caller has to tell apart for itself with
 * `opens`. HV-016-03: the `<Text>` loop did not, and read a null as "no more runs", so an
 * unterminated run silently dropped the rest of the writer's paragraph with no note and no refusal.
 */
function element(source:string,name:string,from=0):{body:string;end:number}|null{
  for(let open=source.indexOf("<"+name,from);open>=0;open=source.indexOf("<"+name,open+1)){
    if(!boundary(source[open+name.length+1]))continue;
    const gt=source.indexOf(">",open);if(gt<0)return null;
    if(source[gt-1]==="/")return {body:"",end:gt+1};
    const close=source.indexOf("</"+name+">",gt+1);if(close<0)return null;
    return {body:source.slice(gt+1,close),end:close+name.length+3};
  }
  return null;
}
/** Every `<Paragraph>` in order, with its attributes and its own contents. Linear in the input. */
function* paragraphs(content:string):Generator<{attributes:string;body:string}>{
  let index=0;
  for(;;){
    const open=content.indexOf("<Paragraph",index);if(open<0)return;
    if(!boundary(content[open+10])){index=open+10;continue;}
    const gt=content.indexOf(">",open);if(gt<0)fail("This Final Draft script has an unclosed paragraph.");
    const attributes=content.slice(open+10,content[gt-1]==="/"?gt-1:gt);
    if(content[gt-1]==="/"){yield {attributes,body:""};index=gt+1;continue;}
    const close=content.indexOf("</Paragraph>",gt+1);if(close<0)fail("This Final Draft script has an unclosed paragraph.");
    yield {attributes,body:content.slice(gt+1,close)};
    index=close+12;
  }
}
/** Remove a whole element wherever it appears, counting what was taken out. */
function without(source:string,name:string):{text:string;removed:number}{
  let text="",index=0,removed=0;
  for(;;){
    const open=text.length>=0?source.indexOf("<"+name,index):-1;
    if(open<0)return {text:text+source.slice(index),removed};
    if(!boundary(source[open+name.length+1])){text+=source.slice(index,open+name.length+1);index=open+name.length+1;continue;}
    const found=element(source,name,open);
    if(!found)fail("This Final Draft script has an unclosed "+name+".");
    // HV-016-03: `element` takes the FIRST close tag after the open one. With a nested note that
    // close belongs to the inner note, so removal stopped there and everything between the inner
    // close and the outer close survived into the screenplay -- private note text reaching the shot
    // prompt, to be spoken and captioned, while the note below reported it removed. Both halves of
    // the rule broke at once, so a nested note is refused rather than guessed at.
    if(opens(found.body,name))fail("This Final Draft script nests a "+name+" inside another, which is not imported. Flatten the notes, or export the script as Fountain.");
    text+=source.slice(index,open);index=found.end;removed++;
  }
}
export function importFinalDraft(document:unknown):ScriptImport{
  if(typeof document!=="string"||!document.trim())fail("Choose a Final Draft script to import.");
  const source=document as string;
  if(source.length>FINAL_DRAFT_LIMITS.documentCharacters)fail("A Final Draft script must be at most 4 MiB.");
  // A document type or entity declaration is the one construct that can make a parser fetch or expand
  // something the writer never wrote, so it is refused before anything is read.
  if(/<!DOCTYPE|<!ENTITY/i.test(source))fail("Final Draft scripts with a document type or entity declaration are not imported.");
  // Found by scanning, not matched: a pattern anchored on a tag name is linear per occurrence and a
  // hostile file can hold three hundred thousand of them.
  const root=source.indexOf("<FinalDraft"),rootEnd=root<0?-1:source.indexOf(">",root);
  if(root<0||rootEnd<0||!boundary(source[root+11])||!/\bDocumentType\s*=\s*"Script"/.test(source.slice(root,rootEnd)))
    fail("Choose a Final Draft script document. Other Final Draft document types are not imported.");
  const found=element(source,"Content");
  if(!found)fail("This Final Draft file has no script content.");
  const notes:ScriptImportNote[]=[],note=(code:string,message:string)=>{if(!notes.some(value=>value.code===code))notes.push({code,message});};
  if(element(source,"TitlePage"))note("title-page","The title page was not imported. Add a Fountain title page if you want one.");
  if(source.includes("<DualDialogue")||/\bDualDialogue\s*=\s*"(?:1|Yes|true)"/i.test(source))
    note("dual-dialogue","Dual dialogue was imported as two speeches, one after the other, because the studio's screenplay has no side-by-side form.");
  if(/\bStyle\s*=\s*"[A-Za-z+ ]{1,64}"/.test(source))note("styling","Bold, italic and underline styling was not imported; the screenplay keeps the words.");
  // A script note holds its own paragraphs. Left in place its words would be read as action, reach the
  // shot prompt, and be spoken and captioned -- a private note becoming part of the film.
  const stripped=without(found.body,"ScriptNote");
  if(stripped.removed)note("script-notes",stripped.removed+(stripped.removed===1?" script note was":" script notes were")+" not imported. They are notes to yourself, and importing them would put their words in the film.");
  const draft=new Draft();
  let headings=0,parentheticals=0,count=0;
  for(const paragraph of paragraphs(stripped.text)){
    if(++count>FINAL_DRAFT_LIMITS.paragraphs)fail("A Final Draft script must have at most "+FINAL_DRAFT_LIMITS.paragraphs+" paragraphs.");
    const {attributes,body}=paragraph;
    if(body.length>FINAL_DRAFT_LIMITS.paragraphCharacters)fail("A Final Draft paragraph must be at most "+FINAL_DRAFT_LIMITS.paragraphCharacters+" characters.");
    if(body.includes("<Paragraph"))fail("This Final Draft script nests a paragraph inside another, which is not imported.");
    // HV-016-03: the {0,200} cap is on the *match*, so a 201-character Type value made the pattern
    // fail and the `??"General"` fallback quietly imported the paragraph as action -- stepping around
    // the refusal below that names the element. An unterminated quote did the same.
    const typed=/\bType\s*=\s*"([^"]{0,200})"/.exec(attributes);
    if(!typed&&/\bType\s*=/.test(attributes))fail("This Final Draft script has a paragraph whose element name this importer cannot read. Export the script as Fountain.");
    const type=(typed?.[1]??"General").trim();
    let text="",index=0;
    for(;;){
      const run=element(body,"Text",index);
      if(!run){if(opens(body,"Text",index))fail("This Final Draft script has a text run that is never closed, so part of a paragraph could not be read.");break;}
      text+=run.body;index=run.end;
    }
    text=collapseFinalDraftText(decodeFinalDraftText(text));
    if(!text){if(type==="Scene Heading")fail("This Final Draft script has an empty scene heading.");continue;}
    switch(type){
      // A heading the writer already forced keeps one dot, not two: "..X" is an escape in Fountain and
      // would take the scene out of the film without saying so.
      case "Scene Heading":{headings++;const heading=text.replace(/^\.+/,"").trim();
        if(!heading)fail("This Final Draft script has an empty scene heading.");
        draft.block(SCENE_HEADING.test(heading)?heading:"."+heading);break;}
      case "Character":{
        const cue=text.toLocaleUpperCase("en-US");
        if(cue.length>40||!CHARACTER.test(cue))fail("The character name “"+text+"” cannot be imported: the studio's screenplay uses upper-case cues of at most forty letters, digits, spaces and ' ( ) . -");
        if(!headings)fail("This Final Draft script has dialogue before its first scene heading.");
        draft.cue(cue);break;
      }
      case "Dialogue":if(!draft.speech(text))fail("This Final Draft script has a speech with no character before it.");break;
      // The studio's screenplay has no parenthetical element, and a parenthetical left in a speech
      // would be spoken and captioned. They are counted and reported rather than smuggled through.
      case "Parenthetical":parentheticals++;break;
      case "Transition":
        if(TRANSITION.test(text)&&text===text.toLocaleUpperCase("en-US"))draft.block(text);
        else{draft.block(text);note("transition","A transition the studio's screenplay does not recognize was imported as action.");}
        break;
      case "Action":case "General":case "Shot":draft.block(text);break;
      default:fail("This Final Draft script uses the “"+type+"” element, which is not imported. Remove it, or export the script as Fountain.");
    }
  }
  if(!headings)fail("This Final Draft script has no scene headings, so it has no scenes to shoot.");
  if(parentheticals)note("parentheticals",parentheticals+(parentheticals===1?" parenthetical was":" parentheticals were")+" not imported; the studio's screenplay has no parenthetical element, and one left in a speech would be spoken aloud.");
  const text=draft.text;
  if(text.length>FINAL_DRAFT_LIMITS.fountainCharacters)fail("This Final Draft script becomes more than "+FINAL_DRAFT_LIMITS.fountainCharacters+" characters of screenplay. Import it in parts.");
  return {text,notes};
}
/** One Fountain block per paragraph, with the blank lines the parser uses to tell blocks apart. */
class Draft {
  private readonly lines:string[]=[];
  private dialogue=false;
  block(text:string){if(this.lines.length)this.lines.push("");this.lines.push(text);this.dialogue=false;}
  cue(text:string){this.block(text);this.dialogue=true;}
  speech(text:string){if(!this.dialogue)return false;this.lines.push(text);return true;}
  get text(){return this.lines.join("\n")+"\n";}
}
