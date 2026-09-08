import {contentHash} from "../../generator/src/capabilities";
import {validateEditLibrary,type EditLibrary} from "./edit-library";
import {createEditHistory,appendEdit,editHistoryReplay,type EditHistory} from "./edit-history";
import {editFail,editId,editRecord,type EditOperation,type EditTimeline} from "./edit-timeline";
import {validateEditSourceReceipt,type EditSourceReceipt} from "./edit-sources";
import {compileEditScriptSource} from "./edit-script-source";
import {projectEditScriptNavigation} from "./edit-script-projection";
import type {EditScriptOccurrence} from "./edit-script-types";
import type {EditAssemblyParent} from "./edit-assembly-types";
import type {LivingScriptPatch} from "./living-script-patch";
import type {LivingScriptRenderInputs} from "./living-script-generation";
import {compileLivingScriptCutImpact} from "./living-script-cut-impact";
import {validateLivingScriptSourceMap,type LivingScriptSourceMap} from "./living-script-source-map";

export const LIVING_SCRIPT_RECUT_LIMITS={operations:999,inputBytes:64*1024**2,responseBytes:64*1024**2} as const;
export interface LivingScriptRecutInput {
  projectId:string;library:EditLibrary;sequenceId:string;historyRevision:string;
  patch:LivingScriptPatch;candidate:LivingScriptRenderInputs;navigationRevision:string;
  generated:EditSourceReceipt;sourceMap:LivingScriptSourceMap;
  operations:EditOperation[];newSequenceId:string;
}
export interface LivingScriptRecutSource {
  sourceId:string;sourceRevision:string;receiptRevision:string;indexRevision:string;
}
export interface LivingScriptRecut {
  schema:"hv-living-script-recut/1";projectId:string;createdAt:string;sequenceId:string;
  editorialLibraryRevision:string;patchRevision:string;cutImpactRevision:string;
  generationRevision:string;sourceMapRevision:string;parent:EditAssemblyParent;
  beforeSource:LivingScriptRecutSource;afterSource:LivingScriptRecutSource;
  history:EditHistory;sourceReceipts:{sourceId:string;receiptRevision:string}[];
  afterTimeline:EditTimeline;operations:EditOperation[];
  newLineEntryId:string;mappedNewLineOccurrences:EditScriptOccurrence[];navigationRevision:string;
  warnings:string[];revision:string;
}

/** Inspect descriptors before cloning, hashing or executing reviewed operations. */
function portable<T>(input:T,limit:number):T {
  const active=new Set<object>();const visit=(value:unknown,depth:number):void=>{
    if(value===null||typeof value==="string"||typeof value==="boolean")return;
    if(typeof value==="number"){if(!Number.isFinite(value)||Object.is(value,-0))editFail("Use finite recut review values.");return;}
    if(typeof value!=="object"||depth>128||active.has(value))editFail("Use portable recut review metadata.");
    const array=Array.isArray(value),prototype=Object.getPrototypeOf(value),keys=Reflect.ownKeys(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)editFail("Use plain recut review records.");
    if(array&&keys.length!==value.length+1)editFail("Use dense recut operation and receipt arrays.");active.add(value);
    for(const key of keys){if(array&&key==="length")continue;const property=Object.getOwnPropertyDescriptor(value,key)!;
      if(typeof key!=="string"||!property.enumerable||!Object.hasOwn(property,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))editFail("Use plain enumerable recut review fields.");visit(property.value,depth+1);
    }active.delete(value);
  };visit(input,0);if(Buffer.byteLength(JSON.stringify(input),"utf8")>limit)editFail("The complete linked recut exceeds its metadata capacity.");return structuredClone(input);
}
const identity=(value:LivingScriptRecutSource):LivingScriptRecutSource=>({sourceId:value.sourceId,sourceRevision:value.sourceRevision,receiptRevision:value.receiptRevision,indexRevision:value.indexRevision});

/** Execute only explicitly reviewed edit operations against an independent frozen-parent history.
 * This neither mutates the project nor grants permission to render, adopt a screenplay or publish.
 * Retain `now` with the review so recompilation reproduces the exact history event identities. */
export function compileLivingScriptRecut(input:LivingScriptRecutInput,now=Date.now()):LivingScriptRecut {
  const args=portable(input,LIVING_SCRIPT_RECUT_LIMITS.inputBytes);
  editRecord(args,["projectId","library","sequenceId","historyRevision","patch","candidate","navigationRevision","generated","sourceMap","operations","newSequenceId"]);
  if(!Number.isSafeInteger(now)||now<0||now>8640000000000000)editFail("Retain a valid recut review time.");
  if(!Array.isArray(args.operations)||!args.operations.length||args.operations.length>LIVING_SCRIPT_RECUT_LIMITS.operations)editFail("Review one to 999 ordered recut operations, reserving one history event for the generated original.");
  for(const operation of args.operations)if(!operation||operation.kind==="source")editFail("The generated receipt is the only new original admitted by this recut. Review other source additions separately.");
  const library=validateEditLibrary(args.library,args.projectId);editId(args.newSequenceId);
  if(library.sequences.some(sequence=>sequence.id===args.newSequenceId))editFail("Choose a new independent recut sequence identity.");
  if(library.sequences.length>=32)editFail("This editorial library already contains 32 saved sequences.");
  const impact=compileLivingScriptCutImpact(args.projectId,library,args.sequenceId,args.historyRevision,args.patch,args.candidate,args.navigationRevision,now);
  const before=library.sources.find(source=>source.revision===args.patch.receiptRevision)!,generated=validateEditSourceReceipt(args.generated);
  const sourceMap=validateLivingScriptSourceMap(before,args.patch,impact.generation,generated,args.sourceMap);
  if(impact.parent.timeline.sources.some(source=>source.id===generated.facts.id))editFail("The generated original must be new to the frozen parent timeline.");
  if(!library.sources.some(source=>source.revision===generated.revision)&&library.sources.length>=64)editFail("This editorial library already retains 64 original receipts.");
  let history=createEditHistory(args.newSequenceId,impact.parent.timeline);
  history=appendEdit(history,{kind:"source",source:generated.facts,receiptRevision:generated.revision},"Admit generated screenplay source",history.revision,now);
  for(const [index,operation]of args.operations.entries())history=appendEdit(history,operation,"Reviewed linked recut operation "+(index+1),history.revision,now);
  const replay=editHistoryReplay(history),afterTimeline=replay.state.timeline;
  if(afterTimeline.clips.some(clip=>clip.sourceId===before.facts.id))editFail("Replace or remove every clip using the selected original before accepting this linked recut.");
  const related=new Set(impact.relatedSourceIds.filter(id=>id!==before.facts.id));
  if(afterTimeline.clips.some(clip=>related.has(clip.sourceId)))editFail("A related dialogue, lip-sync or sound source remains unresolved. Review explicit preservation or replacement mapping for every derived-source clip.");
  if(!afterTimeline.clips.some(clip=>clip.sourceId===generated.facts.id))editFail("The recut must retain at least one actual clip from the generated screenplay source.");
  const bindings=new Map(impact.parent.sourceReceipts.map(binding=>[binding.sourceId,binding.receiptRevision]));bindings.set(generated.facts.id,generated.revision);
  const sourceReceipts=replay.catalog.map(source=>({sourceId:source.id,receiptRevision:bindings.get(source.id)!}));
  if(sourceReceipts.some(binding=>!binding.receiptRevision||replay.receipts[binding.sourceId]&&replay.receipts[binding.sourceId]!==binding.receiptRevision))editFail("The recut history lost an exact original receipt binding.");
  const receipts=new Map([...library.sources,generated].map(receipt=>[receipt.revision,receipt]));
  const indexes=afterTimeline.sources.map(source=>compileEditScriptSource(receipts.get(bindings.get(source.id)!)!));
  const navigation=projectEditScriptNavigation(args.newSequenceId,history.revision,afterTimeline,indexes),patched=sourceMap.entries.find(entry=>entry.patched)!;
  const mappedNewLineOccurrences=navigation.occurrences.filter(occurrence=>occurrence.sourceId===generated.facts.id&&occurrence.entryId===patched.after.id);
  const warnings=[...sourceMap.warnings,...navigation.warnings];
  if(!mappedNewLineOccurrences.length)warnings.push("The revised line has no verified occurrence in this explicit recut. Retained generated media alone does not establish visible picture or audible speech for that line.");
  warnings.push("This receipt executes reviewed edit operations only. Current permissions, actual media conform, comparison playback and atomic screenplay/cut acceptance remain required.");
  const data:Omit<LivingScriptRecut,"revision">={schema:"hv-living-script-recut/1",projectId:args.projectId,createdAt:new Date(now).toISOString(),sequenceId:args.newSequenceId,editorialLibraryRevision:library.revision,patchRevision:args.patch.revision,cutImpactRevision:impact.revision,generationRevision:impact.generation.revision,sourceMapRevision:sourceMap.revision,parent:impact.parent,beforeSource:identity(sourceMap.before),afterSource:identity(sourceMap.after),history,sourceReceipts,afterTimeline,operations:args.operations,newLineEntryId:patched.after.id,mappedNewLineOccurrences,navigationRevision:navigation.revision,warnings:[...new Set(warnings)]};
  return portable({...data,revision:contentHash(data)},LIVING_SCRIPT_RECUT_LIMITS.responseBytes);
}
