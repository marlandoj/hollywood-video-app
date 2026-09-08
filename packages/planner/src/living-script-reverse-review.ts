import {contentHash} from "../../generator/src/capabilities";
import {editFail,editId,EDIT_LANES,type EditLane,type EditClip} from "./edit-timeline";
import {validateEditLibrary,type EditLibrary} from "./edit-library";
import {editHistoryReplay,type EditEvent} from "./edit-history";
import {compileEditScriptSource} from "./edit-script-source";
import {projectEditScriptNavigation,editScriptOccurrenceId} from "./edit-script-projection";
import type {EditScriptEntry,EditScriptOccurrence,EditScriptWindow} from "./edit-script-types";
import {createLivingScriptStructureBase,livingScriptStructureLines,type LivingScriptStructureBase} from "./living-script-structure";

export const LIVING_SCRIPT_REVERSE_LIMITS={metadataBytes:64*1024**2,metadataNodes:1000000,entries:32768,occurrences:100000,windowMatches:1000000} as const;
export interface LivingScriptReverseSnapshot {library:EditLibrary;historyRevision:string;navigationRevision:string}
/** Complete authoritative saved snapshots; never owner-supplied frame lists or navigation bodies. */
export interface LivingScriptReverseInput {projectId:string;script:LivingScriptStructureBase;sequenceId:string;before:LivingScriptReverseSnapshot;after:LivingScriptReverseSnapshot}
export interface LivingScriptReverseCoverage {
  coverage:"none"|"held-only"|"partial"|"whole";
  sourceSpans:{startSample:number;endSample:number}[];heldPositions:number[];
  occurrenceIds:string[];clipIds:string[];outputSamples:number;mutedOutputSamples:number;
}
export interface LivingScriptReverseLane {
  lane:EditLane;timing:"measured-speech"|"shot-coverage"|"unknown";
  before:EditScriptOccurrence[];after:EditScriptOccurrence[];
  beforeClipIds:string[];afterClipIds:string[];laneSettingsChanged:boolean;
  occurrenceChanged:boolean;repeatedBefore:boolean;repeatedAfter:boolean;
  windows:{windowIndex:number;window:EditScriptWindow;before:LivingScriptReverseCoverage;after:LivingScriptReverseCoverage}[];
  reasons:string[];
}
export interface LivingScriptReverseEntry {
  sourceId:string;sourceRevision:string;receiptRevision:string;indexRevision:string;scriptRevision:string|null;
  entry:EditScriptEntry;currentScriptMatch:boolean;currentLineIds:string[];lanes:LivingScriptReverseLane[];
}
export interface LivingScriptReverseReview {
  schema:"hv-living-script-reverse-review/1";context:LivingScriptReverseInput;
  beforeHead:number;afterHead:number;appendedEvents:EditEvent[];activeEdits:Extract<EditEvent,{kind:"edit"}>[];
  sourceBindings:{sourceId:string;receiptRevision:string;before:boolean;after:boolean}[];
  entries:LivingScriptReverseEntry[];
  sceneOrder:{lane:EditLane;before:EditScriptOccurrence[];after:EditScriptOccurrence[]}[];
  warnings:string[];revision:string;
}
function exact(value:unknown,keys:string[]):void {if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))editFail("Use the complete supported reverse screenplay review fields.");}
function hash(value:unknown):void {if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))editFail("Retain exact saved history and navigation revisions.");}
/** Fail closed before invoking getters or hashing receipt metadata. No authorization cache. */
function portable<T>(input:T):T {
  let nodes=0,bytes=0;const active=new Set<object>();const visit=(value:unknown,depth:number):void=>{
    if(++nodes>LIVING_SCRIPT_REVERSE_LIMITS.metadataNodes||depth>128)editFail("The reverse screenplay review exceeds its metadata capacity.");
    if(typeof value==="string"){bytes+=Buffer.byteLength(value,"utf8");if(bytes>LIVING_SCRIPT_REVERSE_LIMITS.metadataBytes)editFail("The reverse screenplay review exceeds its metadata capacity.");return;}
    if(value===null||typeof value==="boolean")return;if(typeof value==="number"){if(!Number.isFinite(value)||Object.is(value,-0))editFail("Use finite reverse screenplay metadata.");return;}
    if(typeof value!=="object"||active.has(value))editFail("Use portable, non-cyclic reverse screenplay metadata.");
    const array=Array.isArray(value),keys=Reflect.ownKeys(value),prototype=Object.getPrototypeOf(value);if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)editFail("Use plain reverse screenplay records.");
    if(array&&keys.length!==value.length+1)editFail("Use dense reverse screenplay arrays.");active.add(value);
    for(const key of keys){if(array&&key==="length")continue;const descriptor=Object.getOwnPropertyDescriptor(value,key)!;if(typeof key!=="string"||!descriptor.enumerable||!Object.hasOwn(descriptor,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))editFail("Use plain enumerable reverse screenplay metadata.");bytes+=Buffer.byteLength(key,"utf8");visit(descriptor.value,depth+1);}active.delete(value);
  };visit(input,0);if(Buffer.byteLength(JSON.stringify(input),"utf8")>LIVING_SCRIPT_REVERSE_LIMITS.metadataBytes)editFail("The reverse screenplay review exceeds its metadata capacity.");return structuredClone(input);
}
/** Charge each nested array item before retaining it. The extra comma for a first item is a
 * conservative byte allowance; no complete oversized review is built or hashed before rejection. */
class ReviewBudget {
  #bytes=0;#nodes=0;#matches=0;
  constructor(skeleton:unknown){this.add(skeleton);}
  add(value:unknown){
    const visit=(item:unknown):void=>{if(++this.#nodes>LIVING_SCRIPT_REVERSE_LIMITS.metadataNodes)editFail("The reverse screenplay review exceeds its incremental output capacity.");if(item&&typeof item==="object")for(const child of Object.values(item))visit(child);};visit(value);
    this.#bytes+=Buffer.byteLength(JSON.stringify(value),"utf8")+1;if(this.#bytes>LIVING_SCRIPT_REVERSE_LIMITS.metadataBytes)editFail("The reverse screenplay review exceeds its incremental output capacity.");
  }
  match(){if(++this.#matches>LIVING_SCRIPT_REVERSE_LIMITS.windowMatches)editFail("The reverse screenplay review exceeds its window matching capacity. Review fewer retained ranges.");}
}
function snapshot(projectId:string,sequenceId:string,input:LivingScriptReverseSnapshot){
  exact(input,["library","historyRevision","navigationRevision"]);hash(input.historyRevision);hash(input.navigationRevision);
  const library=validateEditLibrary(input.library,projectId),sequence=library.sequences.find(value=>value.id===sequenceId);if(!sequence||sequence.history.revision!==input.historyRevision)editFail("The saved sequence history changed. Review the exact before and after cuts.");
  const replay=editHistoryReplay(sequence.history),bindings=new Map(replay.catalog.map((source,index)=>[source.id,sequence.sourceRevisions[index]!])),indexes=replay.state.timeline.sources.map(source=>{
    const receipt=library.sources.find(value=>value.revision===bindings.get(source.id));if(!receipt)editFail("The saved cut lost its retained screenplay source.");return compileEditScriptSource(receipt);
  }),navigation=projectEditScriptNavigation(sequenceId,input.historyRevision,replay.state.timeline,indexes);
  if(navigation.revision!==input.navigationRevision)editFail("The saved screenplay navigation changed. Recompile this review from its original receipts.");return {library,sequence,replay,bindings,indexes,navigation};
}
function coverage(window:EditScriptWindow,occurrences:EditScriptOccurrence[]):LivingScriptReverseCoverage {
  const intervals=occurrences.filter(value=>value.sourceStartSample<value.sourceEndSample).map(value=>({startSample:value.sourceStartSample,endSample:value.sourceEndSample})).sort((a,b)=>a.startSample-b.startSample||a.endSample-b.endSample),sourceSpans:LivingScriptReverseCoverage["sourceSpans"]=[];
  for(const interval of intervals){const last=sourceSpans.at(-1);if(last&&interval.startSample<=last.endSample)last.endSample=Math.max(last.endSample,interval.endSample);else sourceSpans.push({...interval});}
  const heldPositions=[...new Set(occurrences.filter(value=>value.held).map(value=>value.sourceStartSample))].sort((a,b)=>a-b),whole=sourceSpans.length===1&&sourceSpans[0]!.startSample<=window.startSample&&sourceSpans[0]!.endSample>=window.endSample;
  return {coverage:!occurrences.length?"none":!sourceSpans.length?"held-only":whole?"whole":"partial",sourceSpans,heldPositions,occurrenceIds:occurrences.map(value=>value.id),clipIds:[...new Set(occurrences.map(value=>value.clipId))],outputSamples:occurrences.reduce((n,value)=>n+value.endSample-value.startSample,0),mutedOutputSamples:occurrences.filter(value=>value.muted).reduce((n,value)=>n+value.endSample-value.startSample,0)};
}
const occurrenceKey=(sourceId:string,entryId:string,lane:EditLane)=>sourceId+":"+entryId+":"+lane;
function occurrenceGroups(values:EditScriptOccurrence[]){const result=new Map<string,EditScriptOccurrence[]>();for(const value of values){const key=occurrenceKey(value.sourceId,value.entryId,value.lane),group=result.get(key);if(group)group.push(value);else result.set(key,[value]);}return result;}
/** Different clips are not necessarily repeats: a split can retain disjoint pieces of one line. */
function repeated(values:EditScriptOccurrence[]):boolean {
  const sorted=values.slice().sort((a,b)=>a.sourceStartSample-b.sourceStartSample),longest:{clipId:string;end:number}[]=[],held=new Set<string>();let position=-1;
  for(const value of sorted){const start=value.sourceStartSample;if(start!==position){held.clear();position=start;}
    if(longest.some(previous=>previous.clipId!==value.clipId&&previous.end>start)||held.size>1||held.size===1&&!held.has(value.clipId))return true;
    if(value.sourceEndSample===start){held.add(value.clipId);continue;}
    const old=longest.find(previous=>previous.clipId===value.clipId);if(old)old.end=Math.max(old.end,value.sourceEndSample);else longest.push({clipId:value.clipId,end:value.sourceEndSample});longest.sort((a,b)=>b.end-a.end);longest.splice(2);
  }return false;
}
interface LaneClips {beforeClipIds:string[];afterClipIds:string[];laneSettingsChanged:boolean}
function laneClips(old:EditClip[],next:EditClip[]):Map<EditLane,LaneClips>{return new Map(EDIT_LANES.map(lane=>{const before=old.filter(clip=>clip.lane===lane),after=next.filter(clip=>clip.lane===lane);return [lane,{beforeClipIds:before.map(clip=>clip.id),afterClipIds:after.map(clip=>clip.id),laneSettingsChanged:contentHash(before)!==contentHash(after)}];}));}
function laneReview(sourceId:string,entry:EditScriptEntry,lane:EditLane,before:EditScriptOccurrence[],after:EditScriptOccurrence[],clips:LaneClips,budget:ReviewBudget):LivingScriptReverseLane {
  const selectedWindows=entry.windows.flatMap((window,windowIndex)=>window.lanes.includes(lane)?[{window,windowIndex}]:[]),timing=selectedWindows.some(value=>value.window.evidence==="measured-speech")?"measured-speech":selectedWindows.some(value=>value.window.evidence==="shot-coverage")?"shot-coverage":"unknown",{laneSettingsChanged}=clips,occurrenceChanged=contentHash(before)!==contentHash(after),reasons:string[]=[],windows:LivingScriptReverseLane["windows"]=[];
  const result:LivingScriptReverseLane={lane,timing,before,after,beforeClipIds:clips.beforeClipIds,afterClipIds:clips.afterClipIds,laneSettingsChanged,occurrenceChanged,repeatedBefore:false,repeatedAfter:false,windows,reasons};
  budget.add(result);result.before=structuredClone(before);result.after=structuredClone(after);result.beforeClipIds=clips.beforeClipIds.slice();result.afterClipIds=clips.afterClipIds.slice();
  for(const {window,windowIndex}of selectedWindows){
    const selected=(values:EditScriptOccurrence[])=>values.filter(value=>{budget.match();return value.evidence===window.evidence&&value.sourceStartSample>=window.startSample&&value.sourceEndSample<=window.endSample&&value.id===editScriptOccurrenceId(sourceId,entry.id,value.clipId,windowIndex,value.startSample,value.endSample);});
    const old=selected(before),next=selected(after);result.repeatedBefore||=repeated(old);result.repeatedAfter||=repeated(next);
    const evidence={windowIndex,window:structuredClone(window),before:coverage(window,old),after:coverage(window,next)};budget.add(evidence);windows.push(evidence);
  }
  if(timing==="unknown")reasons.push("This lane has no aligned timing for this original entry; clip changes cannot establish which words or actions were removed.");
  if(timing==="shot-coverage")reasons.push("Shot coverage is retained picture context, not observed action or measured spoken words.");
  if(result.repeatedBefore||result.repeatedAfter)reasons.push("This original entry repeats overlapping source material in multiple clips. Removing one occurrence does not remove its screenplay identity.");
  if(windows.some(value=>value.window.evidence==="measured-speech"&&value.after.coverage==="partial"))reasons.push("Only part of a measured source interval is retained. No word deletion or proportional transcript is inferred.");
  if(windows.some(value=>value.window.evidence==="measured-speech"&&value.before.coverage!=="none"&&value.after.coverage==="none"))reasons.push("A previously retained measured interval is absent on this lane. Review every other lane and repeated occurrence before authoring a script change.");
  if([...before,...after].some(value=>value.held))reasons.push("Held source positions remain distinct from whole speech intervals; zero-speed audio segments are muted.");
  if([...before,...after].some(value=>value.transition))reasons.push("Retained intervals include original borrowed transition handles and their source clocks.");
  if(laneSettingsChanged&&!occurrenceChanged)reasons.push("Saved clip settings changed while retained entry timing did not; visibility and audibility still require actual media review.");
  for(const reason of reasons)budget.add(reason);return result;
}

/** Evidence only: no text operation, acceptance, inferred words or current media permission. */
export function compileLivingScriptReverseReview(input:LivingScriptReverseInput):LivingScriptReverseReview {
  const context=portable(input);exact(context,["projectId","script","sequenceId","before","after"]);editId(context.projectId);editId(context.sequenceId);
  const script=context.script;exact(script,["schema","projectId","version","text","scriptRevision","locks","revision"]);
  const checkedScript=createLivingScriptStructureBase({projectId:script.projectId,version:script.version,text:script.text,locks:script.locks});if(script.projectId!==context.projectId||contentHash(checkedScript)!==contentHash(script))editFail("The current screenplay structural base or project changed.");
  const before=snapshot(context.projectId,context.sequenceId,context.before),after=snapshot(context.projectId,context.sequenceId,context.after),oldHistory=before.sequence.history,newHistory=after.sequence.history;
  if(after.library.version<=before.library.version||after.sequence.createdAt!==before.sequence.createdAt||contentHash(newHistory.root)!==contentHash(oldHistory.root)||newHistory.events.length<=oldHistory.events.length||oldHistory.events.some((event,index)=>contentHash(event)!==contentHash(newHistory.events[index])))editFail("Retain the exact earlier saved history prefix and a newer library, not a rewritten or unrelated cut.");
  for(const source of before.library.sources)if(!after.library.sources.some(value=>value.revision===source.revision&&contentHash(value)===contentHash(source)))editFail("The later library lost or changed an earlier retained source receipt.");
  for(const [id,revision]of before.bindings)if(after.bindings.get(id)!==revision)editFail("The saved history changed an earlier original receipt binding.");
  const activeEdits:Extract<EditEvent,{kind:"edit"}>[]=[],nodes=new Map(newHistory.events.filter((event):event is Extract<EditEvent,{kind:"edit"}>=>event.kind==="edit").map(event=>[event.sequence,event]));let head=after.replay.state.head;
  while(head!==before.replay.state.head){const event=nodes.get(head);if(!event)editFail("The selected after cut is not a descendant of the reviewed before cut. Resolve its branch.");activeEdits.push(structuredClone(event));head=event.parent;}
  activeEdits.reverse();if(!activeEdits.length)editFail("The selected after cut has no active descendant edit to review.");
  // A cursor can select an edit that already existed on an abandoned branch. It is evidence, but
  // must not masquerade as an operation authored after this reviewed before snapshot.
  if(activeEdits.some(event=>event.sequence<=oldHistory.events.length))editFail("The selected cut reactivates an older branch. Review that branch from its actual saved ancestor.");
  const allIndexes=new Map(before.indexes.map(index=>[index.sourceId,index]));for(const index of after.indexes){const old=allIndexes.get(index.sourceId);if(old&&old.revision!==index.revision)editFail("The original screenplay source index changed between saved cuts.");allIndexes.set(index.sourceId,index);}
  if(before.navigation.occurrences.length+after.navigation.occurrences.length>LIVING_SCRIPT_REVERSE_LIMITS.occurrences)editFail("The reverse screenplay review exceeds its occurrence capacity.");
  const oldGroups=occurrenceGroups(before.navigation.occurrences),newGroups=occurrenceGroups(after.navigation.occurrences),physical=livingScriptStructureLines(script),entries:LivingScriptReverseEntry[]=[],sourceBindings:LivingScriptReverseReview["sourceBindings"]=[];
  const sceneIds=new Set([...allIndexes.values()].flatMap(index=>index.entries.filter(entry=>entry.kind==="scene").map(entry=>index.sourceId+":"+entry.id))),sceneOrder=EDIT_LANES.map(lane=>({lane,before:before.navigation.occurrences.filter(value=>value.lane===lane&&sceneIds.has(value.sourceId+":"+value.entryId)),after:after.navigation.occurrences.filter(value=>value.lane===lane&&sceneIds.has(value.sourceId+":"+value.entryId))})).filter(value=>value.before.length||value.after.length);
  const warnings=[...new Set([...before.navigation.warnings,...after.navigation.warnings,...before.indexes.flatMap(index=>index.warnings),...after.indexes.flatMap(index=>index.warnings)])];
  warnings.push("Coverage compares retained source spans with each full original evidence window, not only its already-trimmed before occurrence. Occurrence lists preserve repeats, holds and independent lanes.");
  warnings.push("This review does not select words, delete screenplay text, approve visibility or audibility, or grant access to original media. Any script change requires a separate explicit structural proposal and current owner review.");
  if([...allIndexes.values()].some(index=>index.entries.length&&(index.scriptRevision!==script.scriptRevision||index.scriptText!==script.text)))warnings.push("Some originals belong to another screenplay revision. Equal text cannot establish current line identity; resolve authoritative ancestry before proposing text changes.");
  const data={schema:"hv-living-script-reverse-review/1" as const,context,beforeHead:before.replay.state.head,afterHead:after.replay.state.head,appendedEvents:structuredClone(newHistory.events.slice(oldHistory.events.length)),activeEdits,sourceBindings,entries,sceneOrder,warnings},budget=new ReviewBudget({...data,revision:"0".repeat(64)});
  for(const index of allIndexes.values()){
    const binding={sourceId:index.sourceId,receiptRevision:index.receiptRevision,before:before.indexes.some(value=>value.sourceId===index.sourceId),after:after.indexes.some(value=>value.sourceId===index.sourceId)};budget.add(binding);sourceBindings.push(binding);
    const currentScriptMatch=index.scriptRevision===script.scriptRevision&&index.scriptText===script.text,clips=laneClips(before.replay.state.timeline.clips.filter(clip=>clip.sourceId===index.sourceId),after.replay.state.timeline.clips.filter(clip=>clip.sourceId===index.sourceId));
    for(const entry of index.entries){if(entries.length>=LIVING_SCRIPT_REVERSE_LIMITS.entries)editFail("The reverse screenplay review exceeds its entry capacity.");
      const lanes=EDIT_LANES.filter(lane=>clips.get(lane)!.beforeClipIds.length||clips.get(lane)!.afterClipIds.length||entry.windows.some(window=>window.lanes.includes(lane))),currentLineIds=currentScriptMatch&&entry.startLine!==null&&entry.endLine!==null?physical.slice(entry.startLine-1,entry.endLine).map(line=>line.id):[];
      const row:LivingScriptReverseEntry={sourceId:index.sourceId,sourceRevision:index.sourceRevision,receiptRevision:index.receiptRevision,indexRevision:index.revision,scriptRevision:index.scriptRevision,entry,currentScriptMatch,currentLineIds,lanes:[]};budget.add(row);row.entry=structuredClone(entry);entries.push(row);
      for(const lane of lanes)row.lanes.push(laneReview(index.sourceId,entry,lane,oldGroups.get(occurrenceKey(index.sourceId,entry.id,lane))??[],newGroups.get(occurrenceKey(index.sourceId,entry.id,lane))??[],clips.get(lane)!,budget));
    }
  }
  return portable({...data,revision:contentHash(data)});
}
export function validateLivingScriptReverseReview(input:LivingScriptReverseReview):LivingScriptReverseReview {
  const review=portable(input);exact(review,["schema","context","beforeHead","afterHead","appendedEvents","activeEdits","sourceBindings","entries","sceneOrder","warnings","revision"]);
  const expected=compileLivingScriptReverseReview(review.context);if(contentHash(review)!==contentHash(expected))editFail("The reverse screenplay evidence, active ancestry or source identity changed.");return expected;
}
