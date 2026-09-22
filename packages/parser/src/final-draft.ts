/**
 * HV-016: a Final Draft script, read into the Fountain this studio already understands.
 *
 * Written by hand and bounded at every step, like the retained caption reader: a general XML parser
 * would bring entity expansion and external-entity resolution to a file a stranger supplies, and this
 * needs none of it. Anything the studio's own screenplay model cannot hold is **refused or reported**,
 * never quietly dropped — an importer that silently loses a line is worse than one that will not run,
 * because the writer cannot see what went missing.
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
      if(!Number.isFinite(code)||code<9||code>0x10ffff||code>=0xd800&&code<=0xdfff||code>=0x7f&&code<=0x9f)
        fail("This Final Draft script uses a character that cannot be imported.");
      result+=String.fromCodePoint(code);
    }
    index=end+1;
  }
  return result+value.slice(index);
}
const collapse=(value:string)=>value.replace(/[\t\f\v ]+/g," ").replace(/\s*\r?\n\s*/g," ").replace(/ {2,}/g," ").trim();
/** One Fountain block per paragraph, with the blank lines the parser uses to tell blocks apart. */
class Draft {
  private readonly lines:string[]=[];
  private dialogue=false;
  block(text:string){if(this.lines.length)this.lines.push("");this.lines.push(text);this.dialogue=false;}
  cue(text:string){this.block(text);this.dialogue=true;}
  speech(text:string){if(!this.dialogue)return false;this.lines.push(text);return true;}
  get text(){return this.lines.join("\n")+"\n";}
}
export function importFinalDraft(document:unknown):ScriptImport{
  if(typeof document!=="string"||!document.trim())fail("Choose a Final Draft script to import.");
  const source=document as string;
  if(source.length>FINAL_DRAFT_LIMITS.documentCharacters)fail("A Final Draft script must be at most 4 MiB.");
  // A document type or entity declaration is the one construct that can make a parser fetch or expand
  // something the writer never wrote, so it is refused before anything is read.
  if(/<!DOCTYPE|<!ENTITY/i.test(source))fail("Final Draft scripts with a document type or entity declaration are not imported.");
  if(!/<FinalDraft\b[^>]*\bDocumentType\s*=\s*"Script"/.test(source))fail("Choose a Final Draft script document. Other Final Draft document types are not imported.");
  const content=/<Content\b[^>]*>([\s\S]*?)<\/Content>/.exec(source);
  if(!content)fail("This Final Draft file has no script content.");
  const notes:ScriptImportNote[]=[],note=(code:string,message:string)=>{if(!notes.some(value=>value.code===code))notes.push({code,message});};
  if(/<TitlePage\b/.test(source))note("title-page","The title page was not imported. Add a Fountain title page if you want one.");
  if(/<DualDialogue\b/.test(source)||/\bDualDialogue\s*=\s*"(?:1|Yes|true)"/i.test(source))
    note("dual-dialogue","Dual dialogue was imported as two speeches, one after the other, because the studio's screenplay has no side-by-side form.");
  if(/<Text\b[^>]*\bStyle\s*=\s*"[^"]+"/.test(source))note("styling","Bold, italic and underline styling was not imported; the screenplay keeps the words.");
  const draft=new Draft();
  const paragraphs=[...content[1]!.matchAll(/<Paragraph\b([^>]*?)(?:\/>|>([\s\S]*?)<\/Paragraph>)/g)];
  if(paragraphs.length>FINAL_DRAFT_LIMITS.paragraphs)fail("A Final Draft script must have at most "+FINAL_DRAFT_LIMITS.paragraphs+" paragraphs.");
  let headings=0,parentheticals=0;
  for(const paragraph of paragraphs){
    const attributes=paragraph[1]??"",body=paragraph[2]??"";
    if(body.length>FINAL_DRAFT_LIMITS.paragraphCharacters)fail("A Final Draft paragraph must be at most "+FINAL_DRAFT_LIMITS.paragraphCharacters+" characters.");
    const type=(/\bType\s*=\s*"([^"]*)"/.exec(attributes)?.[1]??"General").trim();
    const text=collapse(decodeFinalDraftText([...body.matchAll(/<Text\b[^>]*>([\s\S]*?)<\/Text>/g)].map(run=>run[1]!).join("")));
    if(!text){if(type==="Scene Heading")fail("This Final Draft script has an empty scene heading.");continue;}
    switch(type){
      case "Scene Heading":headings++;draft.block(SCENE_HEADING.test(text)?text:"."+text);break;
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
