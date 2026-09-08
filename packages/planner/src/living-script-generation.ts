import {contentHash} from "../../generator/src/capabilities";
import type {Job} from "../../queue/src/index";
import {soundBaseFilm} from "./sound-jobs";
import {validateEditSourceReceipt,type EditSourceReceipt} from "./edit-sources";
import {renderShots,renderInputHash,sourceRenderRecord,type ShotRenderRecord} from "./shot-reuse";
import {validateLivingScriptPatch,type LivingScriptPatch} from "./living-script-patch";
import {editFail} from "./edit-timeline";

export type LivingScriptRenderInputs=Pick<Job,"projectId"|"stage"|"tier"|"scriptVersion"|"scriptText"|"casting"|"direction"|"providerPlan">;
export interface LivingScriptShotChange {
  shotId:string;sceneIndex:number;treatment:"unchanged"|"regenerate"|"new"|"removed";
  beforeInputHash:string|null;afterInputHash:string|null;
  beforePlannedFrames:number|null;afterPlannedFrames:number|null;
  retainedRecordRevision:string|null;
}
export interface LivingScriptGenerationImpact {
  schema:"hv-living-script-generation-impact/1";projectId:string;patchRevision:string;
  sourceReceiptRevision:string;sourceFilmJobId:string;candidateInputs:LivingScriptRenderInputs;
  shots:LivingScriptShotChange[];reusableRecords:ShotRenderRecord[];
  generateShotIds:string[];removedShotIds:string[];topologyChanged:boolean;
  warnings:string[];revision:string;
}

/** Compare actual pinned per-shot inputs, not global script revisions or equal spoken strings.
 * This is generation impact only: publication still requires current permission, provider/cost
 * admission and an independently reviewed mapping of the actual generated media into the cut. */
export function compileLivingScriptGenerationImpact(receipt:EditSourceReceipt,patch:LivingScriptPatch,candidate:LivingScriptRenderInputs,now=Date.now()):LivingScriptGenerationImpact {
  const source=validateEditSourceReceipt(receipt),checked=validateLivingScriptPatch(source,patch);
  const film=soundBaseFilm(source.job.soundMix?.source.base??source.job);
  if(!Number.isFinite(now)||candidate.projectId!==film.projectId||candidate.stage!==film.stage||candidate.tier!==film.tier
    ||candidate.scriptVersion!==checked.after.version||candidate.scriptText!==checked.after.text)editFail("Review generation inputs for the exact proposed screenplay and original film stage.");
  if(candidate.casting&&candidate.casting.projectId!==candidate.projectId||candidate.direction&&candidate.direction.projectId!==candidate.projectId
    ||!candidate.providerPlan||candidate.providerPlan.stage!==candidate.stage)editFail("Use cast, direction and provider bindings for this project and render stage.");
  const at=Date.parse(film.startedAt??film.completedAt??"");if(!Number.isFinite(at))editFail("The retained film has no verified render time.");
  // Existing compilers reject stale coverage, direction and cast bindings. No approved binding is discarded here.
  const before=renderShots(film,at),after=renderShots(candidate,now),beforeById=new Map(before.map(shot=>[shot.id,shot])),afterById=new Map(after.map(shot=>[shot.id,shot]));
  const records=film.output?.shotRenders??[];
  if(records.length!==before.length||new Set(records.map(record=>record.shotId)).size!==records.length
    ||records.some((record,index)=>record.shotId!==before[index]!.id))editFail("The retained film must preserve the complete ordered shot receipts before selective generation can be reviewed.");
  const verified=new Map(records.map(record=>[record.shotId,sourceRenderRecord(film,record,at)]));
  const shots:LivingScriptShotChange[]=[],reusableRecords:ShotRenderRecord[]=[],warnings:string[]=[];
  for(const shot of after){
    const previous=beforeById.get(shot.id),record=verified.get(shot.id),oldHash=previous?renderInputHash(film,previous):null,newHash=renderInputHash(candidate,shot);
    const treatment=previous?(oldHash===newHash?"unchanged":"regenerate"):"new";
    if(treatment==="unchanged")reusableRecords.push(structuredClone(record!));
    shots.push({shotId:shot.id,sceneIndex:shot.sceneIndex,treatment,beforeInputHash:oldHash,afterInputHash:newHash,beforePlannedFrames:previous?Math.round(previous.durationSec*30):null,afterPlannedFrames:Math.round(shot.durationSec*30),retainedRecordRevision:record?.revision??null});
  }
  for(const shot of before)if(!afterById.has(shot.id))shots.push({shotId:shot.id,sceneIndex:shot.sceneIndex,treatment:"removed",beforeInputHash:renderInputHash(film,shot),afterInputHash:null,beforePlannedFrames:Math.round(shot.durationSec*30),afterPlannedFrames:null,retainedRecordRevision:verified.get(shot.id)!.revision});
  const topologyChanged=contentHash(before.map(shot=>shot.id))!==contentHash(after.map(shot=>shot.id));
  if(topologyChanged)warnings.push("Shot order or membership changed. Review an explicit source-to-cut replacement mapping before publishing the revised cut.");
  if(shots.some(shot=>shot.beforePlannedFrames!==null&&shot.afterPlannedFrames!==null&&shot.beforePlannedFrames!==shot.afterPlannedFrames))warnings.push("Planned shot duration changed. Review timing and all retained occurrences before generation and again against actual output.");
  if(source.job.id!==film.id)warnings.push("The selected source includes later dialogue, lip-sync or sound work. Its performed media needs an explicit preservation or replacement review.");
  warnings.push("Reusable receipts are candidates only. Current original permissions, carrier availability and exact media bytes must be checked at admission and publication.");
  warnings.push("Actual generated duration, measured speech, captions and cut joins require review before the linked screenplay and cut are accepted.");
  const candidateInputs:LivingScriptRenderInputs={projectId:candidate.projectId,stage:candidate.stage,tier:candidate.tier,scriptVersion:candidate.scriptVersion,scriptText:candidate.scriptText,...(candidate.casting?{casting:structuredClone(candidate.casting)}:{}),...(candidate.direction?{direction:structuredClone(candidate.direction)}:{}),...(candidate.providerPlan?{providerPlan:structuredClone(candidate.providerPlan)}:{})};
  const data={schema:"hv-living-script-generation-impact/1" as const,projectId:film.projectId,patchRevision:checked.revision,sourceReceiptRevision:source.revision,sourceFilmJobId:film.id,candidateInputs,shots,reusableRecords,generateShotIds:shots.filter(shot=>shot.treatment==="regenerate"||shot.treatment==="new").map(shot=>shot.shotId),removedShotIds:shots.filter(shot=>shot.treatment==="removed").map(shot=>shot.shotId),topologyChanged,warnings};
  return {...data,revision:contentHash(data)};
}
