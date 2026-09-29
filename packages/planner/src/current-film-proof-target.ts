import type {Job,JobInput} from "../../queue/src/index";
import {contentHash as hash} from "../../generator/src/capabilities";
import {editValidationKey} from "./edit-validation-key";
import {currentFilmRuntimeMode} from "./current-film-runtime-context";
import {validateCurrentFilmMixedJobPlan,type CurrentFilmJobV3} from "./current-film-mixed-jobs";
import {compileCurrentFilmOrigins} from "./current-film-origins";
import {validateCurrentFilmMixedJob,assertCurrentFilmMixedPreviewRelationship,type CurrentFilmMixedJob,type CurrentFilmMixedJobInput,type CurrentFilmMixedApproval} from "./current-film-mixed-job-context";

export interface CurrentFilmProofTarget {
  schema:"hv-current-film-proof-target/1";projectId:string;jobId:string;jobPlanRevision:string;stage:"animatic"|"final";
  animaticJobId:string|null;animaticApprovedAt:string|null;revision:string;
}
export interface CurrentFilmProofTargetApproval {
  targetRevision:string;previewJobId:string;previewRevision:string;approval:CurrentFilmMixedApproval;revision:string;
}
const LIMITS={targetBytes:16384,contextBytes:256*1024**2,approvalBytes:16384};
function fail(message:string):never {throw new Error(message);}
function portable<T>(value:T,bytes:number):T {
  if(!editValidationKey(value,bytes))fail("Retain bounded portable current-film proof target evidence.");return structuredClone(value);
}
function id(value:unknown):void {if(typeof value!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(value))fail("Retain exact current-film proof target owners.");}
function time(value:unknown):void {
  if(typeof value!=="string"||!Number.isSafeInteger(Date.parse(value))||Date.parse(value)<0||new Date(value).toISOString()!==value)fail("Retain the exact canonical proof target approval time.");
}
function body(value:CurrentFilmProofTarget):Omit<CurrentFilmProofTarget,"revision"> {
  return {schema:"hv-current-film-proof-target/1",projectId:value.projectId,jobId:value.jobId,jobPlanRevision:value.jobPlanRevision,stage:value.stage,
    animaticJobId:value.animaticJobId,animaticApprovedAt:value.animaticApprovedAt};
}

/** Stable admitted identity, derived only after the actual full V3 envelope
 * validates. Progress, output and mutable lease bookkeeping are not projected. */
export function compileCurrentFilmProofTarget(raw:Job|JobInput):CurrentFilmProofTarget {
  const job=portable(raw,LIMITS.contextBytes);
  if(currentFilmRuntimeMode(job)!=="v3")fail("Use an explicit mixed current-film proof target.");
  const plan=validateCurrentFilmMixedJob(job as CurrentFilmMixedJob|CurrentFilmMixedJobInput);
  const value={schema:"hv-current-film-proof-target/1" as const,projectId:job.projectId,jobId:job.id,jobPlanRevision:plan.revision,stage:plan.render.stage,
    animaticJobId:job.animaticJobId,animaticApprovedAt:job.animaticApprovedAt};
  return portable({...value,revision:hash(value)},LIMITS.targetBytes);
}

/** Historical shape and plan consistency, not proof that this target was saved.
 * The service must compare the exact projection of its authoritative job. */
export function validateCurrentFilmProofTarget(raw:CurrentFilmProofTarget,rawPlan:CurrentFilmJobV3,jobId:string):CurrentFilmProofTarget {
  const value=portable(raw,LIMITS.targetBytes),plan=validateCurrentFilmMixedJobPlan(rawPlan);id(jobId);id(value.projectId);id(value.jobId);
  if(Object.keys(value).sort().join(",")!==["schema","projectId","jobId","jobPlanRevision","stage","animaticJobId","animaticApprovedAt","revision"].sort().join(",")
    ||value.schema!=="hv-current-film-proof-target/1"||value.projectId!==plan.projectId||value.jobId!==jobId||value.jobPlanRevision!==plan.revision||value.stage!==plan.render.stage)
    fail("The proof target differs from its exact plan or owner.");
  // Preserve the real plan's independent bootstrap/direct-origin owner rule.
  compileCurrentFilmOrigins(plan,jobId);
  if(value.stage==="animatic"){
    if(value.animaticJobId!==null||value.animaticApprovedAt!==null)fail("A proof preview cannot contain a final approval dependency.");
  }else {id(value.animaticJobId);time(value.animaticApprovedAt);if(value.animaticJobId===jobId)fail("Retain an independent proof target preview.");}
  if(hash(body(value))!==value.revision)fail("The current-film proof target seal changed.");return value;
}

/** Replay at the explicit historical boundary supplied by the held caller.
 * A seal alone does not grant current authority, preview custody or media proof. */
export function assertCurrentFilmProofTargetApproval(raw:CurrentFilmProofTarget,rawPlan:CurrentFilmJobV3,rawPreview:Job|undefined,rawApproval:CurrentFilmMixedApproval|null|undefined,at:number):CurrentFilmProofTargetApproval|null {
  const candidate=portable(raw,LIMITS.targetBytes),target=validateCurrentFilmProofTarget(candidate,rawPlan,candidate.jobId);
  if(!Number.isSafeInteger(at)||at<0||at>8640000000000000)fail("Retain an explicit canonical proof approval replay time.");
  const {plan,preview,approval}=portable({plan:rawPlan,preview:rawPreview,approval:rawApproval},LIMITS.contextBytes);
  if(target.stage==="animatic"){
    if(preview!==undefined||approval!==undefined&&approval!==null)fail("A proof preview has no target approval dependency.");return null;
  }
  assertCurrentFilmMixedPreviewRelationship({projectId:target.projectId,jobId:target.jobId,stage:target.stage,animaticJobId:target.animaticJobId,animaticApprovedAt:target.animaticApprovedAt},plan,preview,approval,at);
  const value={targetRevision:target.revision,previewJobId:preview!.id,previewRevision:hash(preview),approval:approval!};
  return portable({...value,revision:hash(value)},LIMITS.approvalBytes);
}
