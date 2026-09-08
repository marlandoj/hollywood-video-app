import {contentHash} from "../../generator/src/capabilities";
import {EditAssemblyClock,validateEditAssemblyPlan} from "./edit-assembly-clock";
import type {EditAssemblyPlan} from "./edit-assembly-types";
import {projectEditScriptNavigation} from "./edit-script-projection";
import {EDIT_SCRIPT_LIMITS,type EditScriptOccurrence,type EditScriptSourceIndex} from "./edit-script-types";
import {editFail,editId} from "./edit-timeline";
import {EditTime} from "./edit-time";
import {editRenderClips} from "./edit-transition-render";

export interface EditAssemblyScriptOccurrence extends EditScriptOccurrence {
  rangeId:string;parentOccurrenceId:string;parentStartSample:number;parentEndSample:number;
}
export interface EditAssemblyScriptNavigation {
  schema:"hv-edit-assembly-script/1";assemblyId:string;assemblyRevision:string;planRevision:string;
  parentNavigationRevision:string;sources:EditScriptSourceIndex[];occurrences:EditAssemblyScriptOccurrence[];
  warnings:string[];revision:string;
}
const S=1600,bytes=(value:unknown)=>new TextEncoder().encode(JSON.stringify(value)).length;
function bounded(size:number):void {if(size>EDIT_SCRIPT_LIMITS.responseBytes)editFail("Assembly script navigation exceeds its 8 MiB response capacity. Select fewer retained occurrences.");}

/** Resolve retained script evidence through the full parent before mapping child output positions. */
export function projectEditAssemblyScript(assemblyId:string,assemblyRevision:string,input:EditAssemblyPlan,sources:EditScriptSourceIndex[]):EditAssemblyScriptNavigation {
  editId(assemblyId);if(typeof assemblyRevision!=="string"||!/^[a-f0-9]{64}$/.test(assemblyRevision))editFail("Use a current assembly revision for script navigation.");
  const plan=validateEditAssemblyPlan(input),timeline=plan.parent.timeline,parent=projectEditScriptNavigation(plan.parent.sequenceId,plan.parent.historyRevision,timeline,sources);
  for(const [i,source]of parent.sources.entries())if(source.receiptRevision!==plan.parent.sourceReceipts[i]!.receiptRevision)editFail("Assembly script navigation lost its retained parent receipt binding.");
  // Count before allocating expanded records: repeated selections can multiply a small parent index.
  let count=0;for(const occurrence of parent.occurrences)for(const range of plan.ranges)if(occurrence.startSample<range.toFrame*S&&occurrence.endSample>range.fromFrame*S&&++count>EDIT_SCRIPT_LIMITS.occurrences)editFail("Assembly script navigation exceeds its 100,000-occurrence capacity. Select fewer retained occurrences.");
  const clock=new EditAssemblyClock(plan),originals=new Map(timeline.clips.map(clip=>[clip.id,clip])),clocks=new Map(editRenderClips(timeline).map(clip=>[clip.id,{clip,time:new EditTime(clip)}])),occurrences:EditAssemblyScriptOccurrence[]=[];
  const data={schema:"hv-edit-assembly-script/1" as const,assemblyId,assemblyRevision,planRevision:plan.revision,parentNavigationRevision:parent.revision,sources:parent.sources,occurrences,warnings:[...parent.warnings,"Assembly positions use the child output clock; clip identities and source evidence belong to the independently retained parent."]};
  let size=bytes({...data,revision:"0".repeat(64)});bounded(size);
  for(const occurrence of parent.occurrences){
    const {clip,time}=clocks.get(occurrence.clipId)!,original=originals.get(occurrence.clipId)!;
    for(const span of clock.occurrences(occurrence.startSample,occurrence.endSample)){
      const parentStartSample=span.parentStartSample,parentEndSample=parentStartSample+span.samples,startSample=span.outputStartSample,endSample=startSample+span.samples;
      const held=occurrence.held||time.speed(parentStartSample)===0&&time.speed(parentEndSample-1)===0&&time.source(parentStartSample)===time.source(parentEndSample-1),transition=parentStartSample<original.at*S||parentEndSample>(original.at+original.frames)*S||Boolean(clip.crossfades?.some(fade=>parentStartSample<(fade.at+fade.frames)*S&&parentEndSample>fade.at*S));
      const mapped:EditAssemblyScriptOccurrence={...occurrence,id:contentHash({assemblyId,assemblyRevision,planRevision:plan.revision,rangeId:span.rangeId,parentOccurrenceId:occurrence.id,parentStartSample,parentEndSample,startSample,endSample}),rangeId:span.rangeId,parentOccurrenceId:occurrence.id,parentStartSample,parentEndSample,startSample,endSample,startFrame:Math.floor(startSample/S),endFrame:Math.ceil(endSample/S),sourceStartSample:Math.max(occurrence.sourceStartSample,time.source(parentStartSample)),sourceEndSample:Math.min(occurrence.sourceEndSample,time.source(held?parentStartSample:parentEndSample)),held,transition,muted:held&&clip.lane!=="picture"&&clip.lane!=="captions"};
      size+=bytes(mapped)+(occurrences.length?1:0);bounded(size);occurrences.push(mapped);
    }
  }
  occurrences.sort((a,b)=>a.startSample-b.startSample||a.endSample-b.endSample||a.sourceId.localeCompare(b.sourceId)||a.entryId.localeCompare(b.entryId)||a.clipId.localeCompare(b.clipId)||a.rangeId.localeCompare(b.rangeId)||a.id.localeCompare(b.id));
  const result={...data,revision:contentHash(data)};bounded(bytes(result));return result;
}
