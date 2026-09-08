import {contentHash} from "../../generator/src/capabilities";
import {compileEditScriptSource} from "./edit-script-source";
import type {EditScriptEntry} from "./edit-script-types";
import {validateEditSourceReceipt,type EditSourceReceipt} from "./edit-sources";
import {editFail,type EditCaption} from "./edit-timeline";
import {validateLivingScriptPatch,type LivingScriptPatch} from "./living-script-patch";
import {compileLivingScriptGenerationImpact,type LivingScriptGenerationImpact,type LivingScriptRenderInputs,type LivingScriptShotChange} from "./living-script-generation";
import {renderInputHash,renderShots,sourceRenderRecord,validateReusePlan,type ShotRenderRecord} from "./shot-reuse";

export const LIVING_SCRIPT_SOURCE_MAP_LIMITS={inputBytes:64*1024**2,responseBytes:8*1024**2,shots:60,entries:16384,windows:100000} as const;
export interface LivingScriptSourceRange {startFrame:number;endFrame:number;startSample:number;endSample:number}
export interface LivingScriptSourceOverlap extends LivingScriptSourceRange {shotIds:string[]}
export interface LivingScriptSourceIdentity {
  sourceId:string;sourceRevision:string;receiptRevision:string;indexRevision:string;scriptRevision:string;
  scriptVersion:number;frames:number;width:number;height:number;
  /** Exact worker/assembler recipe: 30 fps, 48 kHz addresses; speech disables film crossfades. */
  assembly:{mode:"concat"|"crossfade";overlapFrames:number;fps:30;sampleRate:48000};
  shotOrder:string[];overlaps:LivingScriptSourceOverlap[];captions:EditCaption[];
}
export interface LivingScriptShotSourceSpan extends LivingScriptSourceRange {
  ordinal:number;frames:number;recordRevision:string;inputHash:string;
  /** Complete retained shot evidence, including role-specific file hashes, bytes and reuse ancestry. */
  record:ShotRenderRecord;
  /** Source intervals with only this shot contributing. Empty when overlapping fades cover the whole shot. */
  exclusiveRanges:LivingScriptSourceRange[];
}
export interface LivingScriptShotCorrespondence {
  shotId:string;sceneIndex:number;treatment:LivingScriptShotChange["treatment"];
  before:LivingScriptShotSourceSpan|null;after:LivingScriptShotSourceSpan|null;durationDeltaFrames:number|null;
  /** Shot-local correspondence only. Source-film overlaps still require explicit composition review. */
  mapping:"exact-shot-local"|"unbound-rendered";
}
export interface LivingScriptEntryCorrespondence {
  before:EditScriptEntry;after:EditScriptEntry;patched:boolean;
  performedTextChanged:boolean;measuredSpeechChanged:boolean;captionWindowsChanged:boolean;
}
export interface LivingScriptSourceMap {
  schema:"hv-living-script-source-map/1";projectId:string;patchRevision:string;generationRevision:string;
  before:LivingScriptSourceIdentity;after:LivingScriptSourceIdentity;durationDeltaFrames:number;
  shots:LivingScriptShotCorrespondence[];entries:LivingScriptEntryCorrespondence[];
  captionIdentitiesChanged:boolean;warnings:string[];revision:string;
}

function portable<T>(input:T,limit:number):T {
  const active=new Set<object>();const visit=(value:unknown,depth:number):void=>{
    if(value===null||typeof value==="string"||typeof value==="boolean")return;
    if(typeof value==="number"){if(!Number.isFinite(value)||Object.is(value,-0))editFail("Use finite source correspondence values.");return;}
    if(typeof value!=="object"||depth>128||active.has(value))editFail("Use portable source correspondence metadata.");
    const array=Array.isArray(value),prototype=Object.getPrototypeOf(value),keys=Reflect.ownKeys(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)editFail("Use plain source correspondence records.");
    if(array&&keys.length!==value.length+1)editFail("Use dense source correspondence arrays.");active.add(value);
    for(const key of keys){if(array&&key==="length")continue;const property=Object.getOwnPropertyDescriptor(value,key)!;if(typeof key!=="string"||!property.enumerable||!Object.hasOwn(property,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))editFail("Use plain enumerable source correspondence fields.");visit(property.value,depth+1);}active.delete(value);
  };visit(input,0);if(Buffer.byteLength(JSON.stringify(input),"utf8")>limit)editFail("The complete source correspondence exceeds its metadata capacity.");return structuredClone(input);
}
function direct(receipt:EditSourceReceipt):void {
  const job=receipt.job;if(!["animatic","final"].includes(job.stage)||job.dialogueReplacement||job.soundMix||job.lipSync||job.graphicOutput)editFail("Direct film correspondence requires a separate verified mapping for retained dialogue, lip-sync, sound or graphic layers.");
}
const at=(receipt:EditSourceReceipt)=>{const value=Date.parse(receipt.job.startedAt??receipt.job.completedAt??"");if(!Number.isFinite(value))editFail("Retain the actual film render time before mapping source frames.");return value;};
const range=(startFrame:number,endFrame:number):LivingScriptSourceRange=>({startFrame,endFrame,startSample:startFrame*1600,endSample:endFrame*1600});
function renderInputs(job:EditSourceReceipt["job"]):LivingScriptRenderInputs {return {projectId:job.projectId,stage:job.stage,tier:job.tier,scriptVersion:job.scriptVersion,scriptText:job.scriptText,...(job.casting?{casting:job.casting}:{}),...(job.direction?{direction:job.direction}:{}),...(job.providerPlan?{providerPlan:job.providerPlan}:{})};}

function clock(receipt:EditSourceReceipt){
  const job=receipt.job,declared=renderShots(job,at(receipt)),records=job.output!.shotRenders!;
  if(!records.length||records.length>LIVING_SCRIPT_SOURCE_MAP_LIMITS.shots||records.length!==declared.length||new Set(records.map(record=>record.shotId)).size!==records.length||records.some((record,index)=>record.shotId!==declared[index]!.id))editFail("Retain the complete ordered rendered shot inventory before mapping a film source.");
  if(job.shotReuse)validateReusePlan(job.shotReuse,job,at(receipt));
  const overlap=job.stage==="final"&&records.length>1&&!records.some(record=>record.clip.speech)?15:0;
  let cursor=0;const spans=records.map((record,ordinal):LivingScriptShotSourceSpan=>{
    sourceRenderRecord(job,record,at(receipt));if(record.inputHash!==renderInputHash(job,declared[ordinal]!))editFail("A rendered shot differs from the reviewed per-shot inputs.");
    const frames=Math.round(record.clip.durationSec*30);if(!Number.isSafeInteger(frames)||frames<=overlap||Math.abs(frames/30-record.clip.durationSec)>1e-6)editFail("Actual shot duration must establish an exact frame clock longer than its assembly overlap.");
    const start=cursor,end=start+frames;cursor=end-(ordinal<records.length-1?overlap:0);return {...range(start,end),ordinal,frames,recordRevision:record.revision,inputHash:record.inputHash,record:structuredClone(record),exclusiveRanges:[]};
  });
  if(cursor!==receipt.facts.frames)editFail("The actual ordered shot durations and assembly overlap do not match the measured retained film frames.");
  // Sweep all boundaries, including short overlapping shots where more than two layers contribute.
  const boundaries=[...new Set(spans.flatMap(span=>[span.startFrame,span.endFrame]))].sort((a,b)=>a-b),overlaps:LivingScriptSourceOverlap[]=[];
  for(let i=1;i<boundaries.length;i++){const start=boundaries[i-1]!,end=boundaries[i]!,active=spans.filter(span=>span.startFrame<=start&&span.endFrame>=end);if(active.length>1)overlaps.push({...range(start,end),shotIds:active.map(span=>span.record.shotId)});else if(active.length===1)active[0]!.exclusiveRanges.push(range(start,end));else editFail("The retained assembly clock has an unexplained source gap.");}
  const index=compileEditScriptSource(receipt);if(index.scriptRevision===null)editFail("A direct film source requires its exact screenplay index.");
  const identity:LivingScriptSourceIdentity={sourceId:receipt.facts.id,sourceRevision:receipt.facts.revision,receiptRevision:receipt.revision,indexRevision:index.revision,scriptRevision:index.scriptRevision,scriptVersion:job.scriptVersion,frames:receipt.facts.frames,width:receipt.facts.width,height:receipt.facts.height,assembly:{mode:overlap?"crossfade":"concat",overlapFrames:overlap,fps:30,sampleRate:48000},shotOrder:records.map(record=>record.shotId),overlaps,captions:structuredClone(receipt.facts.captions)};
  return {identity,index,spans:new Map(spans.map(span=>[span.record.shotId,span]))};
}
const media=(record:ShotRenderRecord)=>({clip:record.clip,origin:record.origin,files:Object.fromEntries(Object.entries(record.files).map(([role,file])=>[role,{bytes:file.bytes,sha256:file.sha256}]))});
const entryAddress=(entry:EditScriptEntry)=>contentHash({kind:entry.kind,sceneIndex:entry.sceneIndex,startLine:entry.startLine,endLine:entry.endLine});

/** Sealed metadata correspondence, not a file-system probe or permission/publication grant.
 * Regenerated shots and their speech/captions retain independent measured clocks; no endpoint interpolation is implied. */
export function compileLivingScriptSourceMap(beforeReceipt:EditSourceReceipt,patch:LivingScriptPatch,impact:LivingScriptGenerationImpact,afterReceipt:EditSourceReceipt):LivingScriptSourceMap {
  const inputs=portable({beforeReceipt,patch,impact,afterReceipt},LIVING_SCRIPT_SOURCE_MAP_LIMITS.inputBytes),before=validateEditSourceReceipt(inputs.beforeReceipt),after=validateEditSourceReceipt(inputs.afterReceipt);direct(before);direct(after);
  const checked=validateLivingScriptPatch(before,inputs.patch),generation=compileLivingScriptGenerationImpact(before,checked,inputs.impact.candidateInputs,at(after));
  if(contentHash(generation)!==contentHash(inputs.impact))editFail("The generation impact differs from the exact reviewed candidate inputs.");
  if(before.job.id===after.job.id||contentHash(renderInputs(after.job))!==contentHash(generation.candidateInputs))editFail("The newly rendered film must preserve the reviewed project, stage, screenplay version and all candidate bindings.");
  const old=clock(before),next=clock(after),shots:LivingScriptShotCorrespondence[]=[];
  if((after.job.shotReuse?.shots.length??0)!==generation.reusableRecords.length)editFail("Only the exact reviewed unchanged shots may supply reused media to this generated film.");
  for(const change of generation.shots){
    const previous=old.spans.get(change.shotId)??null,current=next.spans.get(change.shotId)??null;
    if((previous?.inputHash??null)!==change.beforeInputHash||(current?.inputHash??null)!==change.afterInputHash)editFail("The complete rendered shot inputs differ from their reviewed correspondence.");
    if(change.treatment==="unchanged"){
      const expected=generation.reusableRecords.find(record=>record.shotId===change.shotId),selected=after.job.shotReuse?.shots.find(record=>record.shotId===change.shotId),record=current?.record;
      if(!previous||!record||!expected||!selected||contentHash(expected)!==contentHash(previous.record)||contentHash(selected)!==contentHash(expected)||record.reusedFrom?.jobId!==expected.jobId||record.reusedFrom.shotId!==expected.shotId||record.reusedFrom.revision!==expected.revision||contentHash(media(record))!==contentHash(media(expected)))editFail("Every unchanged shot must retain the exact reviewed clip, media hashes and original reuse ancestry.");
    }
    else if(current&&(current.record.reusedFrom||current.record.origin.jobId!==after.job.id))editFail("Regenerated and new shots require the reviewed fresh render origin; review alternate-source reuse separately.");
    shots.push({shotId:change.shotId,sceneIndex:change.sceneIndex,treatment:change.treatment,before:previous,after:current,durationDeltaFrames:previous&&current?current.frames-previous.frames:null,mapping:change.treatment==="unchanged"?"exact-shot-local":"unbound-rendered"});
  }
  if(shots.filter(shot=>shot.before).length!==old.spans.size||shots.filter(shot=>shot.after).length!==next.spans.size)editFail("Map every actual old and new rendered shot without a partial inventory.");
  const newer=new Map(next.index.entries.map(entry=>[entryAddress(entry),entry]));
  if(old.index.entries.length>LIVING_SCRIPT_SOURCE_MAP_LIMITS.entries||newer.size!==next.index.entries.length||old.index.entries.length!==next.index.entries.length||new Set(old.index.entries.map(entryAddress)).size!==old.index.entries.length)editFail("The exact physical screenplay topology must be complete on both sides of the source map.");
  const speech=(entry:EditScriptEntry,side:ReturnType<typeof clock>)=>entry.windows.filter(window=>window.evidence==="measured-speech"&&!window.lanes.includes("captions")).map(window=>{
    // The authoritative compiler already established the line identity. Ordered positive speech
    // windows identify exactly one retained report line in that shot, without matching text.
    const span=window.shotId?side.spans.get(window.shotId):undefined,report=span?.record.clip.speech,lines=report?.lines.filter(line=>span!.startSample+Math.round(line.startSample*48000/22050)===window.startSample&&span!.startSample+Math.round(line.endSample*48000/22050)===window.endSample);
    if(!report||lines?.length!==1)editFail("A measured screenplay window lost its exact retained speech receipt.");return {window,engineVersion:report.engineVersion,sampleRate:report.sampleRate,line:lines[0]!};
  }),captions=(entry:EditScriptEntry)=>entry.windows.filter(window=>window.lanes.includes("captions"));
  const entries=old.index.entries.map((entry):LivingScriptEntryCorrespondence=>{const nextEntry=newer.get(entryAddress(entry)),patched=entry.id===checked.mapping.oldEntryId;if(!nextEntry||nextEntry.text!==(patched?checked.replacement:entry.text)||nextEntry.character!==entry.character)editFail("Map screenplay entries by their exact retained physical identity, never by repeated text.");return {before:entry,after:nextEntry,patched,performedTextChanged:entry.performedText!==nextEntry.performedText,measuredSpeechChanged:contentHash(speech(entry,old))!==contentHash(speech(nextEntry,next)),captionWindowsChanged:contentHash(captions(entry))!==contentHash(captions(nextEntry))};});
  if(entries.filter(entry=>entry.patched).length!==1||entries.reduce((sum,entry)=>sum+entry.before.windows.length+entry.after.windows.length,0)>LIVING_SCRIPT_SOURCE_MAP_LIMITS.windows)editFail("The complete screenplay correspondence exceeds its measured-window capacity or lost the patched entry.");
  const warnings=[...old.index.warnings,...next.index.warnings,"Regenerated shot interiors and measured speech are independent clocks; approve explicit cut replacements without interpolating their endpoints.","This receipt validates retained metadata. Current permissions, carrier availability and actual media bytes still require admission and publication checks."];
  if(old.identity.overlaps.length||next.identity.overlaps.length)warnings.push("Film crossfades contain overlapping shot contributions. Shot-local reuse does not establish a single-source mapping inside these overlap intervals.");
  if(before.facts.width!==after.facts.width||before.facts.height!==after.facts.height)warnings.push("The rendered film dimensions changed; review all picture placement before replacing a source.");
  if(shots.some(shot=>shot.durationDeltaFrames!==null&&shot.durationDeltaFrames!==0))warnings.push("Actual rendered shot durations changed. Review measured source coverage, all retained occurrences and cut joins.");
  const data:Omit<LivingScriptSourceMap,"revision">={schema:"hv-living-script-source-map/1",projectId:before.job.projectId,patchRevision:checked.revision,generationRevision:generation.revision,before:old.identity,after:next.identity,durationDeltaFrames:after.facts.frames-before.facts.frames,shots,entries,captionIdentitiesChanged:contentHash(before.facts.captions)!==contentHash(after.facts.captions),warnings:[...new Set(warnings)]};
  return portable({...data,revision:contentHash(data)},LIVING_SCRIPT_SOURCE_MAP_LIMITS.responseBytes);
}

export function validateLivingScriptSourceMap(before:EditSourceReceipt,patch:LivingScriptPatch,impact:LivingScriptGenerationImpact,after:EditSourceReceipt,map:LivingScriptSourceMap):LivingScriptSourceMap {
  const checked=portable(map,LIVING_SCRIPT_SOURCE_MAP_LIMITS.responseBytes),compiled=compileLivingScriptSourceMap(before,patch,impact,after);if(contentHash(checked)!==contentHash(compiled))editFail("The sealed rendered source correspondence changed. Review the complete original and generated receipts again.");return compiled;
}
