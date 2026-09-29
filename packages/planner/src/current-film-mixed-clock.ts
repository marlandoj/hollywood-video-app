import {contentHash as hash} from "../../generator/src/capabilities";
import {validateCurrentFilmMixedCheckpoint,currentFilmMixedRowFrames,type CurrentFilmMixedCheckpoint,type CurrentFilmMixedCheckpointContext} from "./current-film-mixed-context";
import {resolveCurrentFilmMixedReuse} from "./current-film-mixed-jobs";
import {currentFilmOverlap,validateCurrentFilmAssemblyMedia,type CurrentFilmMediaDigest,type CurrentFilmOverlapReason,type CurrentFilmProbe} from "./current-film-clock";
import type {CurrentFilmSlot} from "./current-film-jobs";
import type {CurrentFilmReuseCorrespondence,CurrentFilmSourceSelector} from "./current-film-reuse";
import type {ShotRenderRecord} from "./shot-reuse";
import {editValidationKey} from "./edit-validation-key";
import {currentFilmV2Job} from "./current-film-job-context";

export const CURRENT_FILM_MIXED_CLOCK_LIMITS={contextBytes:256*1024**2,resultBytes:16*1024**2,shots:60,sourceFrames:18000} as const;
export type CurrentFilmMixedExecution={
  kind:"generated";jobId:string;shotId:string;inputRevision:string;recordRevision:string;captureRevision:string;recipeRevision:string;
}|{
  kind:"reused";originId:string;jobId:string;selector:CurrentFilmSourceSelector;sourceOutputRevision:string;sourceCheckpointRevision:string;
  captureRevision:string;recipeRevision:string;bindingRevision:string;reviewRevision:string;adoptionRevision:string;correspondenceRevision:string;
};
export interface CurrentFilmMixedAssemblySlot {
  target:Pick<CurrentFilmSlot,"ordinal"|"logicalShotId"|"renderId"|"inputRevision"|"shot"|"physical">&{pictureIntent:CurrentFilmSlot["recipe"]["picturePerformance"]};
  checkpointRowRevision:string;frames:number;
  /** The original owning record is never renamed or retimed to the target. */
  originalRecord:ShotRenderRecord;ownedFiles:ShotRenderRecord["files"];
  execution:CurrentFilmMixedExecution;correspondence:CurrentFilmReuseCorrespondence|null;
}
/** Detached assembly inputs, not a Job, public clip, or grant of media custody. */
export interface CurrentFilmMixedAssembly {
  schema:"hv-current-film-assembly-inputs/3";projectId:string;jobId:string;jobPlanRevision:string;materializationRevision:string;checkpointRevision:string;
  documentRevision:string;targetRevision:string;outputSize:{width:number;height:number};fps:30;
  requestedOverlapFrames:0|15;effectiveOverlapFrames:0|15;reason:CurrentFilmOverlapReason;
  slots:CurrentFilmMixedAssemblySlot[];authority:"historical-only";mediaVerified:false;revision:string;
}
export interface CurrentFilmMixedAssemblyEvidence {
  sourceFrames:number[];effectiveOverlapFrames:0|15;reason:CurrentFilmOverlapReason;
  probe:CurrentFilmProbe;video:CurrentFilmMediaDigest;captions:{srt:CurrentFilmMediaDigest;vtt:CurrentFilmMediaDigest};
}
export interface CurrentFilmMixedAssemblyClock {
  schema:"hv-current-film-clock/3";projectId:string;jobId:string;jobPlanRevision:string;materializationRevision:string;checkpointRevision:string;
  documentRevision:string;targetRevision:string;outputSize:{width:number;height:number};fps:30;
  requestedOverlapFrames:0|15;effectiveOverlapFrames:0|15;reason:CurrentFilmOverlapReason;
  spans:{ordinal:number;logicalShotId:string;renderId:string;inputRevision:string;checkpointRowRevision:string;ownedFilesRevision:string;
    execution:CurrentFilmMixedExecution;frames:number;startFrame:number;endFrame:number;measuredSpeech:boolean}[];
  rawFrames:number;frames:number;probe:CurrentFilmProbe;video:CurrentFilmMediaDigest;
  captions:{policy:"hv-captions-measured-or-fallback-ms/1";srt:CurrentFilmMediaDigest;vtt:CurrentFilmMediaDigest};revision:string;
}
function fail(message:string):never {throw new Error(message);}
function exact(value:unknown,keys:string[]):void {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))fail("Retain exact version-three assembly fields.");
}
function portable<T>(value:T,maxBytes:number):T {
  if(!editValidationKey(value,maxBytes))fail("Retain bounded portable mixed assembly evidence without accessors or hidden data.");
  return structuredClone(value);
}
function seal<T extends object>(body:T):T&{revision:string} {
  return portable({...body,revision:hash(body)},CURRENT_FILM_MIXED_CLOCK_LIMITS.resultBytes);
}

/** Replays complete metadata only. The worker still checks its held journal,
 * current authority and every actual owned byte before assembly/publication. */
export function resolveCurrentFilmMixedAssembly(context:CurrentFilmMixedCheckpointContext,checkpoint:CurrentFilmMixedCheckpoint):CurrentFilmMixedAssembly {
  const input=portable({context,checkpoint},CURRENT_FILM_MIXED_CLOCK_LIMITS.contextBytes),plan=input.context.currentFilm;
  const checked=validateCurrentFilmMixedCheckpoint(input.context,input.checkpoint);
  if(!checked.rows.length||checked.rows.length!==plan.materialization.slots.length||checked.rows.length>CURRENT_FILM_MIXED_CLOCK_LIMITS.shots)fail("Mixed assembly requires every selected slot, never an incomplete checkpoint prefix.");
  const slots:CurrentFilmMixedAssemblySlot[]=checked.rows.map((row,index)=>{
    const slot=plan.materialization.slots[index]!,target={ordinal:slot.ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,shot:slot.shot,physical:slot.physical,pictureIntent:slot.recipe.picturePerformance};
    const common={target,checkpointRowRevision:hash(row),frames:currentFilmMixedRowFrames(row)};
    if(row.kind==="generated")return {...common,originalRecord:row.record,ownedFiles:row.record.files,correspondence:null,
      execution:{kind:"generated",jobId:row.record.jobId,shotId:row.record.shotId,inputRevision:row.record.inputHash,recordRevision:row.record.revision,captureRevision:row.capture.revision,recipeRevision:row.capture.observation.recipe.revision}};
    const {retained,review}=resolveCurrentFilmMixedReuse(plan,index),source=currentFilmV2Job(retained.binding.source.job);
    const originalRecord=source.currentFilmCheckpoint!.rows[retained.source.ordinal]!.record;
    const ownedFiles=Object.fromEntries(row.adoption.copies.map(copy=>[copy.role,copy.owned])) as ShotRenderRecord["files"];
    return {...common,originalRecord,ownedFiles,correspondence:review.correspondence,
      execution:{kind:"reused",originId:row.adoption.originId,jobId:source.id,selector:retained.source,sourceOutputRevision:retained.sourceOutputRevision,sourceCheckpointRevision:retained.checkpointRevision,
        captureRevision:retained.captureRevision,recipeRevision:review.source.recipeRevision,bindingRevision:retained.binding.revision,reviewRevision:review.revision,adoptionRevision:row.adoption.revision,correspondenceRevision:row.adoption.correspondenceRevision}};
  });
  const requestedOverlapFrames=plan.render.assembly.requestedCrossfadeFrames,overlap=currentFilmOverlap(slots.map(slot=>({record:slot.originalRecord})),requestedOverlapFrames);
  return seal({schema:"hv-current-film-assembly-inputs/3" as const,projectId:checked.projectId,jobId:checked.jobId,jobPlanRevision:plan.revision,materializationRevision:plan.materialization.revision,checkpointRevision:checked.revision,
    documentRevision:plan.materialization.documentRevision,targetRevision:plan.target.revision,outputSize:plan.render.outputSize,fps:30 as const,requestedOverlapFrames,...overlap,slots,authority:"historical-only" as const,mediaVerified:false as const});
}

/** Seal actual counts/digests against the selected generated/adopted records.
 * The caller obtains these facts from decoded owned files; this pure function
 * cannot establish that a supplied digest or ffprobe observation came from disk. */
export function createCurrentFilmMixedAssemblyClock(context:CurrentFilmMixedCheckpointContext,checkpoint:CurrentFilmMixedCheckpoint,evidence:CurrentFilmMixedAssemblyEvidence):CurrentFilmMixedAssemblyClock {
  const measured=portable(evidence,CURRENT_FILM_MIXED_CLOCK_LIMITS.resultBytes);
  exact(measured,["sourceFrames","effectiveOverlapFrames","reason","probe","video","captions"]);
  const assembly=resolveCurrentFilmMixedAssembly(context,checkpoint);
  if(!Array.isArray(measured.sourceFrames)||measured.sourceFrames.length!==assembly.slots.length)fail("Retain every ordered actual mixed-film source frame count.");
  if(measured.effectiveOverlapFrames!==assembly.effectiveOverlapFrames||measured.reason!==assembly.reason)fail("The actual mixed assembler overlap differs from its admitted speech policy.");
  let rawFrames=0,at=0;
  const spans=assembly.slots.map((slot,index)=>{
    const frames=measured.sourceFrames[index]!;
    if(!Number.isSafeInteger(frames)||frames<1||frames>CURRENT_FILM_MIXED_CLOCK_LIMITS.sourceFrames||frames!==slot.frames
      ||Math.abs(slot.originalRecord.clip.durationSec*30-frames)>1e-7||assembly.slots.length>1&&frames<=assembly.effectiveOverlapFrames)fail("Actual mixed source frames differ from the original duration or lack dissolve handles.");
    const startFrame=at,endFrame=at+frames;rawFrames+=frames;at=endFrame-assembly.effectiveOverlapFrames;
    const {ordinal,logicalShotId,renderId,inputRevision}=slot.target;
    return {ordinal,logicalShotId,renderId,inputRevision,checkpointRowRevision:slot.checkpointRowRevision,ownedFilesRevision:hash(slot.ownedFiles),execution:slot.execution,frames,startFrame,endFrame,measuredSpeech:Boolean(slot.originalRecord.clip.speech)};
  });
  const frames=spans.at(-1)!.endFrame,media=validateCurrentFilmAssemblyMedia({frames,probe:measured.probe,video:measured.video,captions:measured.captions});
  if(media.probe.video.width!==assembly.outputSize.width||media.probe.video.height!==assembly.outputSize.height)fail("The measured mixed-film output differs from its admitted dimensions.");
  return seal({schema:"hv-current-film-clock/3" as const,projectId:assembly.projectId,jobId:assembly.jobId,jobPlanRevision:assembly.jobPlanRevision,materializationRevision:assembly.materializationRevision,checkpointRevision:assembly.checkpointRevision,
    documentRevision:assembly.documentRevision,targetRevision:assembly.targetRevision,outputSize:assembly.outputSize,fps:30 as const,requestedOverlapFrames:assembly.requestedOverlapFrames,effectiveOverlapFrames:assembly.effectiveOverlapFrames,reason:assembly.reason,
    spans,rawFrames,frames,probe:media.probe,video:media.video,captions:{policy:"hv-captions-measured-or-fallback-ms/1" as const,...media.captions}});
}

export function validateCurrentFilmMixedAssemblyClock(context:CurrentFilmMixedCheckpointContext,checkpoint:CurrentFilmMixedCheckpoint,clock:CurrentFilmMixedAssemblyClock):CurrentFilmMixedAssemblyClock {
  const value=portable(clock,CURRENT_FILM_MIXED_CLOCK_LIMITS.resultBytes);
  exact(value,["schema","projectId","jobId","jobPlanRevision","materializationRevision","checkpointRevision","documentRevision","targetRevision","outputSize","fps","requestedOverlapFrames","effectiveOverlapFrames","reason","spans","rawFrames","frames","probe","video","captions","revision"]);
  if(!Array.isArray(value.spans)||value.spans.length>CURRENT_FILM_MIXED_CLOCK_LIMITS.shots)fail("Retain bounded ordered mixed-film assembly spans.");
  exact(value.captions,["policy","srt","vtt"]);
  const expected=createCurrentFilmMixedAssemblyClock(context,checkpoint,{sourceFrames:value.spans.map(span=>span.frames),effectiveOverlapFrames:value.effectiveOverlapFrames,reason:value.reason,probe:value.probe,video:value.video,captions:{srt:value.captions.srt,vtt:value.captions.vtt}});
  if(hash(value)!==hash(expected))fail("The mixed-film clock changed its exact checkpoint, provenance or measured facts.");
  return expected;
}
