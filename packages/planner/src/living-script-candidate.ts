import {contentHash} from "../../generator/src/capabilities";
import {validateProviderPlan,type ProviderPlan} from "../../generator/src/catalog";
import {parseFountain} from "../../parser/src/index";
import {TIERS,type Tier} from "../../queue/src/index";
import {directionEntry,directionSnapshot,directionSource,staleDirections,type DirectionEntry} from "./direction";
import {cutSource,sceneCut,sourcePlan} from "./scene-cuts";
import {lineSources} from "./performances";
import {castingSnapshot} from "./casting";
import {createScenePerformance,scenePerformanceSource} from "./performance-memory";
import type {Shot} from "./index";
import type {EditSourceReceipt} from "./edit-sources";
import {validateLivingScriptPatch,type LivingScriptPatch} from "./living-script-patch";
import {validateLivingScriptSettings,type LivingScriptSettingsBaseline} from "./living-script-settings";
import {compileLivingScriptGenerationImpact,type LivingScriptRenderInputs} from "./living-script-generation";
import {renderShots} from "./shot-reuse";
import {editFail,editId,editNumber} from "./edit-timeline";

export const LIVING_SCRIPT_CANDIDATE_LIMITS={metadataBytes:128*1024**2} as const;
export interface LivingScriptCandidateContext {
  projectId:string;currentScript:{version:number;text:string};baseline:LivingScriptSettingsBaseline;
  stage:"animatic"|"final";tier:Tier;providerPlan:ProviderPlan;
}
export interface LivingScriptCandidate {
  schema:"hv-living-script-candidate/1";projectId:string;sourceReceiptRevision:string;patchRevision:string;
  baseline:LivingScriptSettingsBaseline;candidateInputs:LivingScriptRenderInputs;
  changes:{directions:{shotId:string;beforeSourceHash:string;afterSourceHash:string;
    lines:{index:number;beforeSourceHash:string;afterSourceHash:string;beforeText:string;afterText:string}[]}[];
    sceneCuts:{sceneIndex:number;beforeRevision:string;afterRevision:string}[];
    scenePerformances:{characterId:string;sceneNumber:number;beforeSourceHash:string;afterSourceHash:string;beforeRevision:string;afterRevision:string}[]};
  warnings:string[];createdAt:string;revision:string;
}
const same=(a:unknown,b:unknown)=>contentHash(a)===contentHash(b);
function exact(value:unknown,keys:string[]):void {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))editFail("Retain the exact pending screenplay candidate fields.");
}
function portable<T>(value:T):T {
  const active=new Set<object>();const visit=(item:unknown,depth:number):void=>{
    if(item===null||typeof item==="string"||typeof item==="boolean")return;
    if(typeof item==="number"&&Number.isFinite(item)&&!Object.is(item,-0))return;
    if(typeof item!=="object"||depth>160||active.has(item))editFail("Retain portable pending screenplay candidate data.");
    const array=Array.isArray(item),prototype=Object.getPrototypeOf(item),keys=Reflect.ownKeys(item);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)editFail("Retain plain pending screenplay candidate records.");
    if(array&&keys.length!==item.length+1)editFail("Retain dense pending screenplay candidate arrays.");active.add(item);
    for(const key of keys){if(array&&key==="length")continue;const property=Object.getOwnPropertyDescriptor(item,key)!;
      if(typeof key!=="string"||!property.enumerable||!Object.hasOwn(property,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=item.length))editFail("Retain candidate data without accessors or hidden fields.");visit(property.value,depth+1);
    }active.delete(item);
  };visit(value,0);
  if(Buffer.byteLength(JSON.stringify(value),"utf8")>LIVING_SCRIPT_CANDIDATE_LIMITS.metadataBytes)editFail("The complete pending screenplay candidate exceeds its metadata capacity.");
  return structuredClone(value);
}
/** Source-plan dialogue addresses differ between the normal first shot and authored beat coverage.
 * The patch supplies verified scene/block and beat/line identities for these two exact cases. */
function patchedAddress(shot:Shot,patch:LivingScriptPatch,baseline:LivingScriptSettingsBaseline):{dialogueIndex:number;lineIndex:number}|null {
  if(shot.sceneIndex!==patch.mapping.sceneIndex)return null;
  const cut=baseline.direction.sceneCuts?.find(cut=>cut.source.sceneIndex===shot.sceneIndex);
  if(cut){const selected=cut.shots.find(value=>value.id===shot.id);if(!selected)editFail("Review the changed shot's authored coverage identity.");
    const beats=selected.beatIds.map(id=>cut.source.beats.find(beat=>beat.id===id)!).filter(beat=>beat.kind==="dialogue"),index=beats.findIndex(beat=>beat.id===patch.mapping.beatId);
    return index<0?null:{dialogueIndex:index,lineIndex:patch.mapping.beatLineIndex};
  }
  return shot.id===`shot-${shot.sceneIndex+1}-1`?{dialogueIndex:patch.mapping.sceneDialogueIndex,lineIndex:patch.mapping.sceneDialogueLineIndex}:null;
}
function verifyDialogue(before:Shot,after:Shot,patch:LivingScriptPatch,baseline:LivingScriptSettingsBaseline):void {
  const expected=structuredClone(before.dialogue),address=patchedAddress(before,patch,baseline);
  if(address){const block=expected[address.dialogueIndex];if(!block||block.lines[address.lineIndex]!==patch.line.beforeRaw.trim())editFail("Review the selected line's exact source-plan correspondence.");block.lines[address.lineIndex]=patch.replacement;}
  if(!same(expected,after.dialogue))editFail("Review changed dialogue membership before carrying its artistic settings.");
  const oldLines=lineSources(before.dialogue),newLines=lineSources(after.dialogue);
  if(oldLines.length!==newLines.length)editFail("Review changed spoken-line membership before carrying its performance.");
  for(const [index,old]of oldLines.entries()){
    const next=newLines[index]!,{hash:_oldHash,text:oldText,...oldIdentity}=old,{hash:_newHash,text:newText,...newIdentity}=next;
    if(!same(oldIdentity,newIdentity)||newText!==(address&&old.dialogueIndex===address.dialogueIndex&&old.lineIndex===address.lineIndex?patch.replacement:oldText))editFail("Review ambiguous spoken-line correspondence before carrying its performance.");
  }
}

/** Rebind only exact source identities for an immutable physical-line patch. Artistic settings
 * remain unchanged; the returned candidate is an explicit review, never a save or permission grant. */
export function compileLivingScriptCandidate(source:EditSourceReceipt,patch:LivingScriptPatch,context:LivingScriptCandidateContext,now=Date.now()):LivingScriptCandidate {
  const args=portable({source,patch,context,now}),c=args.context;exact(c,["projectId","currentScript","baseline","stage","tier","providerPlan"]);exact(c.currentScript,["version","text"]);editId(c.projectId);editNumber(args.now,0,8640000000000000,"Candidate review time");
  const checked=validateLivingScriptPatch(args.source,args.patch),baseline=validateLivingScriptSettings(c.baseline,c.baseline,c.projectId);
  if(c.projectId!==checked.projectId||!same(c.currentScript,{version:checked.before.version,text:checked.before.text}))editFail("The current screenplay differs from the exact retained patch baseline.");
  if(!["animatic","final"].includes(c.stage)||!["free","elevated"].includes(c.tier)||c.stage!==args.source.job.stage||c.tier!==args.source.job.tier||checked.sourceFilm.jobId!==args.source.job.id)editFail("Choose the original direct film's stage and tier for this pending candidate; derived versions require explicit correspondence.");
  validateProviderPlan(c.providerPlan);if(c.providerPlan.stage!==c.stage)editFail("Review a provider plan for this pending film stage.");
  if(now<Math.max(Date.parse(baseline.direction.createdAt),Date.parse(baseline.casting.createdAt)))editFail("Review this candidate after its current settings baseline.");
  const before=parseFountain(checked.before.text),after=parseFountain(checked.after.text),oldShots=sourcePlan(before,baseline.direction,7000,TIERS[c.tier].maxShots);
  if(staleDirections(oldShots,baseline.direction).length)editFail("Review existing stale shot directions before proposing this screenplay line.");
  renderShots({projectId:c.projectId,stage:c.stage,tier:c.tier,providerPlan:c.providerPlan,scriptText:checked.before.text,casting:baseline.casting,direction:baseline.direction},now);
  const changes:LivingScriptCandidate["changes"]={directions:[],sceneCuts:[],scenePerformances:[]},cuts=baseline.direction.sceneCuts?.map(cut=>{
    const scene=after.scenes[cut.source.sceneIndex]!;if(same(cutSource(scene),cut.source))return structuredClone(cut);
    if(scene.index!==checked.mapping.sceneIndex)editFail("Review unrelated authored coverage before changing this line.");
    const expected=structuredClone(cut.source),beat=expected.beats.find(beat=>beat.id===checked.mapping.beatId);
    if(!beat||beat.kind!=="dialogue"||beat.lines[checked.mapping.beatLineIndex]!==checked.line.beforeRaw.trim())editFail("Review the selected line's exact authored beat correspondence.");
    beat.lines[checked.mapping.beatLineIndex]=checked.replacement;if(!same(expected,cutSource(scene)))editFail("Review changed coverage topology before carrying its artistic settings.");
    const next=sceneCut(expected,cut.shots,cut.notes);changes.sceneCuts.push({sceneIndex:scene.index,beforeRevision:cut.revision,afterRevision:next.revision});return next;
  });
  const characters=baseline.casting.characters.map(character=>{
    if(character.scenePerformances===undefined)return structuredClone(character);
    return {...structuredClone(character),scenePerformances:character.scenePerformances.map(memory=>{
      const scene=after.scenes[memory.sceneNumber-1]!;if(memory.sourceHash===scenePerformanceSource(scene))return structuredClone(memory);
      if(scene.index!==checked.mapping.sceneIndex)editFail("Review unrelated character performance before changing this line.");
      const next=createScenePerformance(character.id,scene,{notes:memory.notes,controls:memory.controls,...(memory.picture?{picture:memory.picture}:{}),...(memory.nativeVoice?{nativeVoice:memory.nativeVoice}:{})});
      const {sourceHash:_oldSource,revision:_oldRevision,...oldSettings}=memory,{sourceHash:_newSource,revision:_newRevision,...newSettings}=next;
      if(!same(oldSettings,newSettings))editFail("Review changed character performance settings before rebinding their screenplay source.");
      changes.scenePerformances.push({characterId:character.id,sceneNumber:memory.sceneNumber,beforeSourceHash:memory.sourceHash,afterSourceHash:next.sourceHash,beforeRevision:memory.revision,afterRevision:next.revision});return next;
    })};
  });
  const casting=changes.scenePerformances.length?castingSnapshot(c.projectId,baseline.casting.version+1,characters,now):structuredClone(baseline.casting);
  const newShots=sourcePlan(after,{...baseline.direction,...(cuts===undefined?{}:{sceneCuts:cuts})},7000,TIERS[c.tier].maxShots);
  if(!same(oldShots.map(shot=>({id:shot.id,sceneIndex:shot.sceneIndex})),newShots.map(shot=>({id:shot.id,sceneIndex:shot.sceneIndex}))))editFail("Review changed shot membership before carrying saved artistic settings.");
  for(const [index,shot]of oldShots.entries())verifyDialogue(shot,newShots[index]!,checked,baseline);
  const entries:DirectionEntry[]=baseline.direction.entries.map(entry=>{
    const old=oldShots.find(shot=>shot.id===entry.source.id)!,next=newShots.find(shot=>shot.id===entry.source.id)!;
    if(same(directionSource(next),entry.source))return structuredClone(entry);
    const oldLines=lineSources(old.dialogue),newLines=lineSources(next.dialogue),settings=structuredClone(entry.settings),lines:LivingScriptCandidate["changes"]["directions"][number]["lines"]=[];
    if(settings.lines)settings.lines=settings.lines.map(line=>{const before=oldLines[line.index]!,after=newLines[line.index]!;
      if(before.hash===after.hash)return line;
      lines.push({index:line.index,beforeSourceHash:before.hash,afterSourceHash:after.hash,beforeText:before.text,afterText:after.text});return {...line,sourceHash:after.hash};
    });
    const rebound=directionEntry(next,settings);changes.directions.push({shotId:next.id,beforeSourceHash:entry.sourceHash,afterSourceHash:rebound.sourceHash,lines});return rebound;
  });
  const direction=changes.directions.length||changes.sceneCuts.length?directionSnapshot(c.projectId,baseline.direction.version+1,entries,now,cuts):structuredClone(baseline.direction);
  const candidateInputs:LivingScriptRenderInputs={projectId:c.projectId,stage:c.stage,tier:c.tier,scriptVersion:checked.after.version,scriptText:checked.after.text,casting,direction,providerPlan:structuredClone(c.providerPlan)};
  validateLivingScriptSettings(baseline,candidateInputs,c.projectId);compileLivingScriptGenerationImpact(args.source,checked,candidateInputs,now);
  const data:Omit<LivingScriptCandidate,"revision">={schema:"hv-living-script-candidate/1",projectId:c.projectId,sourceReceiptRevision:args.source.revision,patchRevision:checked.revision,baseline,candidateInputs,changes,warnings:["Review the carried artistic settings against the revised spoken line before generation; actual performance and cut timing still require output review."],createdAt:new Date(now).toISOString()};
  return portable({...data,revision:contentHash(data)});
}
