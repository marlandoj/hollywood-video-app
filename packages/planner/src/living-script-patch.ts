import {createHash} from "node:crypto";
import {parseFountain,type ParseResult,type SceneBeat} from "../../parser/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {compileEditScriptSource} from "./edit-script-source";
import type {EditSourceReceipt} from "./edit-sources";
import {soundBaseFilm} from "./sound-jobs";
import {editFail,editId,editNumber} from "./edit-timeline";

export const LIVING_SCRIPT_PATCH_LIMITS={scriptCharacters:200000,replacementCharacters:20000,requestBytes:4*1024**2,sourceBytes:64*1024**2,responseBytes:8*1024**2} as const;
export interface LivingScriptPatchRequest {
  entryId:string;indexRevision:string;currentScript:{version:number;text:string};replacement:string;
  /** Additional current screenplay locks supplied by the owning project, never inferred from text. */
  protectedLines?:number[];
}
export interface LivingScriptPatchText {version:number;text:string;sha256:string;scriptRevision:string}
export interface LivingScriptPatch {
  schema:"hv-living-script-patch/1";projectId:string;sourceId:string;sourceRevision:string;receiptRevision:string;indexRevision:string;
  sourceFilm:{jobId:string;scriptVersion:number;scriptRevision:string};
  before:LivingScriptPatchText;
  /** Proposed next version only; this pure compiler neither commits a screenplay nor creates a rendered source. */
  after:LivingScriptPatchText;
  replacement:string;protectedLines:number[];
  line:{physicalLine:number;beforeRaw:string;afterRaw:string;leadingWhitespace:string;trailingWhitespace:string;lineEnding:""|"\n"|"\r\n";offsetUnit:"utf16";beforeStart:number;beforeEnd:number;afterStart:number;afterEnd:number};
  mapping:{oldEntryId:string;sceneEntryId:string;sceneIndex:number;beatId:string;beatLineIndex:number;sceneDialogueIndex:number;sceneDialogueLineIndex:number;beforeLineId:string;afterLineId:string;newRetainedEntryId:null};
  affectedSceneIndexes:number[];affectedShotIds:string[];shotCoverageComplete:boolean;warnings:string[];revision:string;
}
const sha=(text:string)=>createHash("sha256").update(text,"utf8").digest("hex");
const hash=(value:unknown)=>{if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))editFail("Retain the exact screenplay source identity.");};
function exact(value:unknown,keys:string[]):void {if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))editFail("Use only the supported screenplay patch fields.");}
/** Reject serialization tricks before invoking receipt validators, accessors or hashes. */
function copy<T>(value:T,limit:number):T {
  const active=new Set<object>();const visit=(item:unknown,depth:number):void=>{
    if(item===null||typeof item==="string"||typeof item==="boolean")return;
    if(typeof item==="number"){if(!Number.isFinite(item)||Object.is(item,-0))editFail("Use finite screenplay patch values.");return;}
    if(typeof item!=="object"||depth>128||active.has(item))editFail("Use portable, non-cyclic screenplay patch data.");
    const array=Array.isArray(item),prototype=Object.getPrototypeOf(item),keys=Reflect.ownKeys(item);if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)editFail("Use plain screenplay patch records.");
    if(array&&keys.length!==item.length+1)editFail("Use dense screenplay patch arrays.");active.add(item);
    for(const key of keys){if(array&&key==="length")continue;const descriptor=Object.getOwnPropertyDescriptor(item,key)!;if(typeof key!=="string"||!descriptor.enumerable||!Object.hasOwn(descriptor,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=item.length))editFail("Use plain enumerable screenplay patch fields.");visit(descriptor.value,depth+1);}active.delete(item);
  };visit(value,0);if(Buffer.byteLength(JSON.stringify(value),"utf8")>limit)editFail("The screenplay patch exceeds its metadata capacity.");return structuredClone(value);
}
interface PhysicalLine {raw:string;ending:""|"\n"|"\r\n";start:number;end:number}
function physical(script:string):{lines:PhysicalLine[];protectedLines:Set<number>}{
  const pieces=script.split(/(\r\n|\n)/),lines:PhysicalLine[]=[],protectedLines=new Set<number>();let offset=0,block=false;
  for(let i=0;i<pieces.length;i+=2){const raw=pieces[i]!,ending=(pieces[i+1]??"") as PhysicalLine["ending"],number=lines.length+1;lines.push({raw,ending,start:offset,end:offset+raw.length});offset+=raw.length+ending.length;
    if(block){protectedLines.add(number);if(raw.includes("*/"))block=false;}
    else if(raw.includes("/*")&&!raw.includes("*/")){protectedLines.add(number);block=true;}
    else if(/\[\[[^\]]*\]\]|\/\*[\s\S]*?\*\//.test(raw))protectedLines.add(number);
  }
  return {lines,protectedLines};
}
type DialogueBeat=Extract<SceneBeat,{kind:"dialogue"}>;
function address(parsed:ParseResult,source:ReturnType<typeof physical>,sceneIndex:number,physicalLine:number){
  const scene=parsed.scenes[sceneIndex];if(!scene)editFail("The selected line lost its retained scene.");let dialogueIndex=-1,originalLine=0;
  for(const beat of scene.beats??[]){if(beat.kind!=="dialogue")continue;const physicalBeat:number[]=[];
    for(let line=beat.startLine;line<=beat.endLine;line++)if(!source.protectedLines.has(line)&&source.lines[line-1]!.raw.trim())physicalBeat.push(line);
    const cue=physicalBeat.length===beat.lines.length+1,lines=cue?physicalBeat.slice(1):physicalBeat;if(cue){dialogueIndex++;originalLine=0;}
    if(lines.length!==beat.lines.length||dialogueIndex<0)editFail("The dialogue beat lost its physical line mapping.");
    const beatLineIndex=lines.indexOf(physicalLine);if(beatLineIndex>=0)return {scene,beat,beatLineIndex,sceneDialogueIndex:dialogueIndex,sceneDialogueLineIndex:originalLine+beatLineIndex};originalLine+=beat.lines.length;
  }
  return editFail("The selected screenplay entry is not an original spoken line.");
}
function scriptText(version:number,text:string):LivingScriptPatchText {return {version,text,sha256:sha(text),scriptRevision:contentHash({scriptVersion:version,scriptText:text})};}

/** Exact original-language physical line patch. No text search, media mutation or inferred future entry identity. */
export function compileLivingScriptPatch(input:EditSourceReceipt,request:LivingScriptPatchRequest):LivingScriptPatch {
  const source=copy(input,LIVING_SCRIPT_PATCH_LIMITS.sourceBytes),asked=copy(request,LIVING_SCRIPT_PATCH_LIMITS.requestBytes);exact(asked,["entryId","indexRevision","currentScript","replacement",...(Object.hasOwn(asked,"protectedLines")?["protectedLines"]:[])]);exact(asked.currentScript,["version","text"]);hash(asked.entryId);hash(asked.indexRevision);
  editNumber(asked.currentScript.version,1,Number.MAX_SAFE_INTEGER-1,"Current screenplay version");
  const current=asked.currentScript.text;if(typeof current!=="string"||!current.trim()||current.length>LIVING_SCRIPT_PATCH_LIMITS.scriptCharacters||Buffer.from(current,"utf8").toString("utf8")!==current||/\r(?!\n)/.test(current))editFail("Use a complete current screenplay with supported LF or CRLF physical lines.");
  const index=compileEditScriptSource(source);if(index.revision!==asked.indexRevision)editFail("The screenplay source index changed. Reload the selected original entry.");
  if(source.job.currentFilm)editFail("Use the canonical screenplay proposal workflow for this current-film source.");
  if(index.scriptText===null||index.scriptRevision===null)editFail("This source has no original screenplay dialogue to patch.");
  const film=soundBaseFilm(source.job.soundMix?.source.base??source.job);editId(film.id);editId(source.job.projectId);
  if(current!==index.scriptText||asked.currentScript.version!==film.scriptVersion)editFail("The current screenplay differs from the retained source. Resolve the stale version or branch before patching this line.");
  const before=scriptText(asked.currentScript.version,current);if(before.scriptRevision!==index.scriptRevision)editFail("The retained screenplay hash no longer matches its original version.");
  const entry=index.entries.find(entry=>entry.id===asked.entryId);if(!entry||entry.kind!=="dialogue"||entry.startLine===null||entry.endLine!==entry.startLine||entry.sceneIndex===null)editFail("Select one original spoken dialogue entry; narration, action and performed-text layers are separate.");
  const lines=physical(current),line=lines.lines[entry.startLine-1]!,locks=Object.hasOwn(asked,"protectedLines")?asked.protectedLines!:[];
  if(!Array.isArray(locks)||locks.length>lines.lines.length||locks.some(number=>!Number.isSafeInteger(number)||number<1||number>lines.lines.length)||new Set(locks).size!==locks.length)editFail("Protect distinct physical lines from the exact current screenplay.");
  if(lines.protectedLines.has(entry.startLine)||locks.includes(entry.startLine))editFail("The selected physical line is protected and cannot be replaced.");
  const replacement=asked.replacement;
  if(typeof replacement!=="string"||!replacement||replacement.length>LIVING_SCRIPT_PATCH_LIMITS.replacementCharacters||replacement.trim()!==replacement||Buffer.from(replacement,"utf8").toString("utf8")!==replacement||[...replacement].some(char=>{const code=char.charCodeAt(0);return code<32&&code!==9||code>=127&&code<=159||code===8232||code===8233;}))editFail("Use one nonblank spoken line without newlines, outer whitespace or control characters.");
  if(/\[\[|\]\]|\/\*|\*\//.test(replacement)||/^\([^\r\n]*\)$/.test(replacement)||/^(?:\.(?!\.)|[#=@>~!])/.test(replacement))editFail("A spoken-line patch cannot introduce protected, parenthetical or structural screenplay syntax.");
  const leadingWhitespace=line.raw.slice(0,line.raw.length-line.raw.trimStart().length),trailingWhitespace=line.raw.slice(line.raw.trimEnd().length),old=line.raw.trim();
  if(old!==entry.text)editFail("The selected spoken entry no longer matches its physical source line.");if(replacement===old)editFail("Change the selected spoken line before proposing a screenplay patch.");
  const parsed=parseFountain(current),located=address(parsed,lines,entry.sceneIndex,entry.startLine),afterRaw=leadingWhitespace+replacement+trailingWhitespace,next=current.slice(0,line.start)+afterRaw+current.slice(line.end),after=scriptText(before.version+1,next);
  if(next.length>LIVING_SCRIPT_PATCH_LIMITS.scriptCharacters)editFail("The proposed screenplay exceeds its character capacity.");
  const expected=structuredClone(parsed),expectedScene=expected.scenes[entry.sceneIndex]!,expectedBeat=expectedScene.beats!.find(beat=>beat.id===located.beat.id) as DialogueBeat;
  if(parsed.rejected||located.beat.lines[located.beatLineIndex]!==old||located.scene.dialogue[located.sceneDialogueIndex]?.lines[located.sceneDialogueLineIndex]!==old)editFail("The selected dialogue lost its exact retained beat identity.");
  expectedBeat.lines[located.beatLineIndex]=replacement;expectedScene.dialogue[located.sceneDialogueIndex]!.lines[located.sceneDialogueLineIndex]=replacement;
  if(contentHash(parseFountain(next))!==contentHash(expected))editFail("This replacement changes screenplay topology. Use a reviewed structural edit instead.");
  const sceneEntry=index.entries.find(value=>value.kind==="scene"&&value.sceneIndex===entry.sceneIndex);if(!sceneEntry)editFail("The selected dialogue lost its scene entry identity.");
  const identity={sceneIndex:entry.sceneIndex,beatId:located.beat.id,beatLineIndex:located.beatLineIndex,physicalLine:entry.startLine},lineId=(revision:string)=>contentHash({schema:"hv-living-script-line/1",scriptRevision:revision,...identity});
  const known=new Set(entry.windows.flatMap(window=>window.shotId?[window.shotId]:[])),affectedShotIds=(film.output?.shotRenders??[]).filter(shot=>known.has(shot.shotId)).map(shot=>shot.shotId);if(affectedShotIds.length!==known.size)editFail("The selected line's shot evidence differs from the retained film.");
  const shotCoverageComplete=entry.windows.some(window=>window.evidence==="shot-coverage"&&window.shotId!==undefined),warnings=[...index.warnings];
  if(!shotCoverageComplete)warnings.push("Complete retained shot coverage is unavailable for this line; regeneration requires additional verified shot mapping.");
  if(entry.performedText!==undefined&&entry.performedText!==entry.text)warnings.push("This proposal changes the original screenplay only; different retained performed or localized text remains historical.");
  const data:Omit<LivingScriptPatch,"revision">={schema:"hv-living-script-patch/1",projectId:source.job.projectId,sourceId:index.sourceId,sourceRevision:index.sourceRevision,receiptRevision:index.receiptRevision,indexRevision:index.revision,sourceFilm:{jobId:film.id,scriptVersion:film.scriptVersion,scriptRevision:index.scriptRevision},before,after,replacement,protectedLines:[...locks].sort((a,b)=>a-b),line:{physicalLine:entry.startLine,beforeRaw:line.raw,afterRaw,leadingWhitespace,trailingWhitespace,lineEnding:line.ending,offsetUnit:"utf16",beforeStart:line.start,beforeEnd:line.end,afterStart:line.start,afterEnd:line.start+afterRaw.length},mapping:{oldEntryId:entry.id,sceneEntryId:sceneEntry.id,sceneIndex:entry.sceneIndex,beatId:located.beat.id,beatLineIndex:located.beatLineIndex,sceneDialogueIndex:located.sceneDialogueIndex,sceneDialogueLineIndex:located.sceneDialogueLineIndex,beforeLineId:lineId(before.scriptRevision),afterLineId:lineId(after.scriptRevision),newRetainedEntryId:null},affectedSceneIndexes:[entry.sceneIndex],affectedShotIds,shotCoverageComplete,warnings:[...new Set(warnings)]};
  return copy({...data,revision:contentHash(data)},LIVING_SCRIPT_PATCH_LIMITS.responseBytes);
}

/** Recompile the entire exact proposal, including preserved bytes and affected identities, before trusting a receipt. */
export function validateLivingScriptPatch(source:EditSourceReceipt,input:LivingScriptPatch):LivingScriptPatch {
  const patch=copy(input,LIVING_SCRIPT_PATCH_LIMITS.responseBytes),compiled=compileLivingScriptPatch(source,{entryId:patch.mapping?.oldEntryId,indexRevision:patch.indexRevision,currentScript:{version:patch.before?.version,text:patch.before?.text},replacement:patch.replacement,protectedLines:patch.protectedLines});
  if(contentHash(compiled)!==contentHash(patch))editFail("The sealed screenplay patch differs from its original line, preserved bytes or impact mapping.");return compiled;
}
