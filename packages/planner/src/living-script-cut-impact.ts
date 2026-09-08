import {contentHash} from "../../generator/src/capabilities";
import {validateEditLibrary,type EditLibrary} from "./edit-library";
import {deriveEditAssemblyParent} from "./edit-assembly-parent";
import type {EditAssemblyParent} from "./edit-assembly-types";
import {editFail,type EditClip} from "./edit-timeline";
import {editRenderClips} from "./edit-transition-render";
import {compileEditScriptSource} from "./edit-script-source";
import {projectEditScriptNavigation,editScriptOccurrenceId} from "./edit-script-projection";
import type {EditScriptOccurrence} from "./edit-script-types";
import {soundBaseFilm} from "./sound-jobs";
import {validateLivingScriptPatch,type LivingScriptPatch} from "./living-script-patch";
import {compileLivingScriptGenerationImpact,type LivingScriptRenderInputs,type LivingScriptGenerationImpact} from "./living-script-generation";

export interface LivingScriptClipImpact {
  clip:EditClip;sourceTreatment:"selected-source"|"related-source"|"matte-dependent";
  renderStartFrame:number;renderEndFrame:number;selectedLineOccurrenceIds:string[];changedShotOccurrenceIds:string[];
  affectedOutputRanges:{startFrame:number;endFrame:number}[];reviewReasons:string[];
}
export interface LivingScriptCutImpact {
  schema:"hv-living-script-cut-impact/1";projectId:string;editorialLibraryRevision:string;navigationRevision:string;
  patchRevision:string;parent:EditAssemblyParent;generation:LivingScriptGenerationImpact;
  selectedLineOccurrences:EditScriptOccurrence[];changedShotOccurrences:EditScriptOccurrence[];
  relatedSourceIds:string[];clips:LivingScriptClipImpact[];warnings:string[];revision:string;
}

/** Preserve the full saved parent and all original clocks while compiling a pre-generation review.
 * No clip is replaced and no word-level timing is inferred from the proposed text. */
export function compileLivingScriptCutImpact(projectId:string,library:EditLibrary,sequenceId:string,historyRevision:string,patch:LivingScriptPatch,candidate:LivingScriptRenderInputs,expectedNavigationRevision:string,now=Date.now()):LivingScriptCutImpact {
  const checked=validateEditLibrary(library,projectId),parent=deriveEditAssemblyParent(projectId,checked,sequenceId,historyRevision);
  const source=checked.sources.find(source=>source.revision===patch.receiptRevision);
  if(!source||!parent.sourceReceipts.some(binding=>binding.sourceId===patch.sourceId&&binding.receiptRevision===source.revision))editFail("The chosen saved cut does not retain this exact screenplay source.");
  const retainedPatch=validateLivingScriptPatch(source,patch),generation=compileLivingScriptGenerationImpact(source,retainedPatch,candidate,now);
  const sources=parent.sourceReceipts.map(binding=>checked.sources.find(source=>source.revision===binding.receiptRevision)!);
  const indexes=sources.map(compileEditScriptSource),navigation=projectEditScriptNavigation(parent.sequenceId,parent.historyRevision,parent.timeline,indexes);
  if(navigation.revision!==expectedNavigationRevision)editFail("The screenplay-to-cut navigation changed. Review the current saved cut before proposing a linked revision.");
  const relatedSourceIds=sources.filter(source=>{
    const film=soundBaseFilm(source.job.soundMix?.source.base??source.job);
    return film.id===retainedPatch.sourceFilm.jobId&&film.scriptText===retainedPatch.before.text&&film.scriptVersion===retainedPatch.before.version;
  }).map(source=>source.facts.id);
  const related=new Set(relatedSourceIds),changedShots=new Set([...generation.generateShotIds,...generation.removedShotIds]);
  const entries=new Map(indexes.filter(index=>related.has(index.sourceId)).flatMap(index=>index.entries.map(entry=>[index.sourceId+":"+entry.id,entry] as const)));
  const selectedLineOccurrences=navigation.occurrences.filter(occurrence=>occurrence.sourceId===source.facts.id&&occurrence.entryId===retainedPatch.mapping.oldEntryId);
  const changedShotOccurrences=navigation.occurrences.filter(occurrence=>entries.get(occurrence.sourceId+":"+occurrence.entryId)?.windows.some((window,index)=>window.shotId&&changedShots.has(window.shotId)&&editScriptOccurrenceId(occurrence.sourceId,occurrence.entryId,occurrence.clipId,index,occurrence.startSample,occurrence.endSample)===occurrence.id));
  type Range={startFrame:number;endFrame:number};
  const merge=(values:Range[])=>{const result:Range[]=[];for(const value of values.slice().sort((a,b)=>a.startFrame-b.startFrame||a.endFrame-b.endFrame)){const previous=result.at(-1);if(previous&&value.startFrame<=previous.endFrame)previous.endFrame=Math.max(previous.endFrame,value.endFrame);else result.push({...value});}return result;};
  const render=editRenderClips(parent.timeline),affected=new Map<string,Range[]>(render.filter(clip=>related.has(clip.sourceId)).map(clip=>[clip.id,[{startFrame:clip.at,endFrame:clip.at+clip.frames}]]));
  // A changed matte may affect clips on unrelated originals and may feed another matte layer.
  let added=true;while(added){added=false;for(const clip of render){if(clip.lane!=="picture"||!clip.composite?.matte)continue;
    const incoming=render.filter(matte=>matte.lane==="picture"&&matte.layer===clip.composite!.matte!.layer).flatMap(matte=>(affected.get(matte.id)??[]).map(range=>({startFrame:Math.max(range.startFrame,clip.at),endFrame:Math.min(range.endFrame,clip.at+clip.frames)})).filter(range=>range.startFrame<range.endFrame));
    if(!incoming.length)continue;const previous=affected.get(clip.id)??[],next=merge([...previous,...incoming]);if(contentHash(previous)!==contentHash(next)){affected.set(clip.id,next);added=true;}
  }}
  const clips:LivingScriptClipImpact[]=parent.timeline.clips.filter(clip=>affected.has(clip.id)).map(clip=>{
    const expanded=render.find(item=>item.id===clip.id)!,relatedSource=related.has(clip.sourceId),reviewReasons:string[]=[];
    if(relatedSource)reviewReasons.push("Map this complete retained source range against the actual generated source; unchanged later shots may have shifted source positions.");
    else reviewReasons.push("This picture depends on a changed matte. Recheck its complete composition with the replacement media.");
    if(clip.sourceId!==source.facts.id&&relatedSource)reviewReasons.push("This source shares the original film. Review its performance and sound bindings before replacement.");
    if(clip.timing)reviewReasons.push("Preserve or explicitly revise the complete retiming curve and fractional source phase.");
    if(clip.composite?.masks?.length)reviewReasons.push("Review source-bound mask removal or rebinding against the new source identity.");
    if(clip.composite?.matte)reviewReasons.push("Review the matte input and dependent picture layers together.");
    if(expanded.at!==clip.at||expanded.frames!==clip.frames||expanded.crossfades?.length)reviewReasons.push("Preserve and review borrowed dissolve handles and the original transition phase.");
    if(clip.lane!=="picture"&&clip.lane!=="captions")reviewReasons.push("Compare actual measured speech and sound; picture duration does not establish word timing.");
    if(clip.lane==="captions")reviewReasons.push("Rebuild captions from the actual replacement source and its reviewed cut mapping.");
    return {clip:structuredClone(clip),sourceTreatment:relatedSource?(clip.sourceId===source.facts.id?"selected-source":"related-source"):"matte-dependent",renderStartFrame:expanded.at,renderEndFrame:expanded.at+expanded.frames,selectedLineOccurrenceIds:selectedLineOccurrences.filter(value=>value.clipId===clip.id).map(value=>value.id),changedShotOccurrenceIds:changedShotOccurrences.filter(value=>value.clipId===clip.id).map(value=>value.id),affectedOutputRanges:structuredClone(affected.get(clip.id)!),reviewReasons};
  });
  const warnings=[...navigation.warnings,...generation.warnings];
  if(!selectedLineOccurrences.length)warnings.push("The selected line has no verified occurrence in this saved cut. Other retained source ranges still require source-clock mapping after regeneration.");
  warnings.push("This review preserves the parent only. Actual generated source mapping, resulting cut timing, independent conform and atomic screenplay/cut acceptance remain required.");
  const data={schema:"hv-living-script-cut-impact/1" as const,projectId,editorialLibraryRevision:checked.revision,navigationRevision:navigation.revision,patchRevision:retainedPatch.revision,parent,generation,selectedLineOccurrences,changedShotOccurrences,relatedSourceIds,clips,warnings:[...new Set(warnings)]};
  const result={...data,revision:contentHash(data)};if(Buffer.byteLength(JSON.stringify(result),"utf8")>16*1024**2)editFail("The linked screenplay cut review exceeds its metadata capacity.");return result;
}
