import type {Job,JobInput} from "../../queue/src/index";
import {editPortableCacheKey} from "./edit-portable-cache-key";
import {assertCurrentFilmMode,assertCurrentFilmIdempotency,assertCurrentFilmHeldInputs,validateCurrentFilmJob,validateCurrentFilmOutput,currentFilmRecordedFiles,createCurrentFilmPreviewReview,validateCurrentFilmPreviewReview,type CurrentFilmPreviewReview} from "./current-film-job-context";
import {assertCurrentFilmMixedAdmission,assertCurrentFilmMixedHeldInputs,validateCurrentFilmMixedJob,validateCurrentFilmMixedOutput,currentFilmMixedRecordedFiles,
  createCurrentFilmMixedPreviewReview,validateCurrentFilmMixedPreviewReview,type CurrentFilmMixedPreviewReview,type CurrentFilmMixedJob,type CurrentFilmMixedJobInput,type CurrentFilmMixedJobOutput} from "./current-film-mixed-job-context";

function read(value:object,key:string):unknown {
  const field=Object.getOwnPropertyDescriptor(value,key);
  if(field&&(!field.enumerable||!Object.hasOwn(field,"value")))throw new Error("Retain explicit current-film runtime markers without accessors or hidden fields.");return field?.value;
}
/** Only the runtime dispatcher accepts both versions. Historical V2 source
 * consumers keep their strict original discriminator and sibling checks. */
function runtimeDiscriminator(job:Job|JobInput):"ordinary"|"v2"|"v3" {
  const plan=read(job,"currentFilm");
  if(plan&&typeof plan==="object"&&read(plan,"schema")==="hv-current-film-job/3"){
    if(Object.hasOwn(job,"currentFilmProof")){
      const proof=read(job,"currentFilmProof");
      if(!proof||typeof proof!=="object"||read(proof,"schema")!=="hv-current-film-prepared-proof/1")throw new Error("Mixed current-film proof must retain its exact owning context.");
    }
    const checkpoint=read(job,"currentFilmCheckpoint"),output=read(job,"output"),completed=output&&typeof output==="object"?read(output,"currentFilm"):undefined;
    if(checkpoint!==undefined&&(!checkpoint||typeof checkpoint!=="object"||read(checkpoint,"schema")!=="hv-current-film-checkpoint/3")
      ||completed!==undefined&&(!completed||typeof completed!=="object"||read(completed,"schema")!=="hv-current-film-output/3"))throw new Error("Mixed current-film progress must retain its exact version-three owning context.");
    return "v3";
  }
  assertCurrentFilmMode(job);return plan===undefined?"ordinary":"v2";
}
export function currentFilmRuntimeMode(job:Job|JobInput):"ordinary"|"v2"|"v3" {
  const mode=runtimeDiscriminator(job);
  if(mode==="v3"&&!editPortableCacheKey(job,256*1024**2))throw new Error("Retain bounded portable mixed current-film runtime inputs.");
  return mode;
}
// Private dispatch is only used immediately before a complete validator. It
// checks marker descriptors and sibling versions without hashing the entire
// envelope twice. The public discriminator retains its portable-input check.
/** Checked correlated view; the explicit discriminator is never a relabelling. */
export function currentFilmV3Job(job:Job):CurrentFilmMixedJob {
  if(runtimeDiscriminator(job)!=="v3")throw new Error("Use an explicit mixed current-film job.");
  const view=job as CurrentFilmMixedJob;validateCurrentFilmMixedJob(view);return view;
}
export function currentFilmV3Input(input:JobInput):CurrentFilmMixedJobInput {
  if(runtimeDiscriminator(input)!=="v3")throw new Error("Use an explicit mixed current-film request.");
  const view=input as CurrentFilmMixedJobInput;validateCurrentFilmMixedJob(view);return view;
}
/** Correlated held view after one complete comparison. The caller still owns
 * the running-state, worker identity, lease and fresh authority checks. */
export function currentFilmV3HeldJob(current:Job,claimed:Job):CurrentFilmMixedJob {
  if(runtimeDiscriminator(current)!=="v3"||runtimeDiscriminator(claimed)!=="v3")throw new Error("The held current-film runtime version changed.");
  const view=current as CurrentFilmMixedJob;
  assertCurrentFilmMixedHeldInputs(view,claimed as CurrentFilmMixedJob);return view;
}
export function validateCurrentFilmRuntimeJob(job:Job|JobInput,now?:number):void {
  const mode=runtimeDiscriminator(job);
  if(mode==="v3")validateCurrentFilmMixedJob(job as CurrentFilmMixedJob|CurrentFilmMixedJobInput,now);
  else if(mode==="v2")validateCurrentFilmJob(job,now);
}
export function assertCurrentFilmRuntimeIdempotency(existing:Job|undefined,input:JobInput):void {
  const mode=currentFilmRuntimeMode(input),previous=existing?currentFilmRuntimeMode(existing):undefined;
  if(mode==="v3"||previous==="v3"){
    if(mode!=="v3"||previous!==undefined&&previous!=="v3")throw new Error("This request key belongs to a different current-film runtime version.");
    assertCurrentFilmMixedAdmission(currentFilmV3Input(input),existing?currentFilmV3Job(existing):undefined);return;
  }
  assertCurrentFilmIdempotency(existing,input);
}
export function assertCurrentFilmRuntimeHeldInputs(current:Job,claimed:Job):void {
  const mode=runtimeDiscriminator(current),other=runtimeDiscriminator(claimed);
  if(mode==="v3"||other==="v3"){
    if(mode!==other)throw new Error("The held current-film runtime version changed.");
    // The exact mode checks above establish both discriminators; the mixed
    // comparator validates both complete envelopes itself.
    assertCurrentFilmMixedHeldInputs(current as CurrentFilmMixedJob,claimed as CurrentFilmMixedJob);return;
  }
  assertCurrentFilmHeldInputs(current,claimed);
}
export function validateCurrentFilmRuntimeOutput(job:Job,output:NonNullable<Job["output"]>):void {
  if(currentFilmRuntimeMode(job)==="v3")validateCurrentFilmMixedOutput(currentFilmV3Job(job),output as CurrentFilmMixedJobOutput);
  else validateCurrentFilmOutput(job,output);
}
export function currentFilmRuntimeRecordedFiles(job:Job):ReturnType<typeof currentFilmRecordedFiles> {
  return currentFilmRuntimeMode(job)==="v3"?currentFilmMixedRecordedFiles(currentFilmV3Job(job)):currentFilmRecordedFiles(job);
}
export type CurrentFilmRuntimePreviewReview=CurrentFilmPreviewReview|CurrentFilmMixedPreviewReview;
export function createCurrentFilmRuntimePreviewReview(job:Job):CurrentFilmRuntimePreviewReview {
  return currentFilmRuntimeMode(job)==="v3"?createCurrentFilmMixedPreviewReview(currentFilmV3Job(job)):createCurrentFilmPreviewReview(job);
}
export function validateCurrentFilmRuntimePreviewReview(job:Job,review:CurrentFilmRuntimePreviewReview):CurrentFilmRuntimePreviewReview {
  if(!editPortableCacheKey(review,16*1024**2))throw new Error("Retain the exact portable current-film review.");
  if(currentFilmRuntimeMode(job)==="v3"){
    if(review.schema!=="hv-current-film-preview-review/3")throw new Error("Review the exact mixed current-film output.");
    return validateCurrentFilmMixedPreviewReview(currentFilmV3Job(job),review);
  }
  if(review.schema!=="hv-current-film-preview-review/2")throw new Error("Review the exact version-two current-film output.");
  return validateCurrentFilmPreviewReview(job,review);
}
