import type {Job,JobInput} from "../../queue/src/index";
import type {AnimaticApproval} from "../../api/src/index";
import {createCurrentFilmPreviewReview,type CurrentFilmPreviewReview} from "./current-film-job-context";
import {contentHash as hash} from "../../generator/src/capabilities";
import {validateCurrentFilmMixedJobPlan,type CurrentFilmJobV3} from "./current-film-mixed-jobs";
import {compileCurrentFilmOrigins,validateCurrentFilmOrigins,type CurrentFilmOrigins} from "./current-film-origins";
import {advanceCurrentFilmMixedCheckpoint,type CurrentFilmMixedCheckpoint} from "./current-film-mixed-context";
import {validateCurrentFilmMixedAssemblyClock,type CurrentFilmMixedAssemblyClock} from "./current-film-mixed-clock";
import {editValidationKey} from "./edit-validation-key";
import type {RenderFile} from "./shot-reuse";
import {validateCurrentFilmPreparedProof,currentFilmPreparedProofFiles} from "./current-film-prepared-proof";

export interface CurrentFilmMixedOutput {
  schema:"hv-current-film-output/3";projectId:string;jobId:string;jobPlanRevision:string;materializationRevision:string;
  documentRevision:string;targetRevision:string;originsRevision:string;checkpointRevision:string;
  assembly:CurrentFilmMixedAssemblyClock;degradedShots:string[];proofRevision?:string;revision:string;
}
export type CurrentFilmMixedJobOutput=Omit<NonNullable<Job["output"]>,"currentFilm">&{currentFilm:CurrentFilmMixedOutput};
/** Complete V3 envelope before queue activation. Progress and completed output
 * are separate from immutable admitted inputs and cannot be client supplied. */
export type CurrentFilmMixedJob=Omit<Job,"currentFilm"|"currentFilmCheckpoint"|"output">&{
  currentFilm:CurrentFilmJobV3;currentFilmOrigins?:CurrentFilmOrigins;currentFilmCheckpoint?:CurrentFilmMixedCheckpoint;output?:CurrentFilmMixedJobOutput;
};
export type CurrentFilmMixedJobInput=Omit<JobInput,"currentFilm"|"output"|"routeDecisions">&{
  currentFilm:CurrentFilmJobV3;currentFilmProof?:never;currentFilmOrigins?:never;currentFilmCheckpoint?:never;output?:never;routeDecisions?:never;
};
const same=(a:unknown,b:unknown)=>hash(a)===hash(b);
const conflicts=["direction","shotReuse","livingScript","executionCheckpoints","shotTakes","characterSheet","dialogueReplacement","dialogueCheckpoint","audioTake","audioCheckpoint","audioOutput","lipSync","lipSyncPrepared","lipSyncCheckpoint","lipSyncReviews","soundMix","soundCheckpoint","pictureEdit","editCheckpoint","assemblyEdit","assemblyCheckpoint","graphicRender","graphicCheckpoint","graphicOutput","graphicProgress"] as const;
function fail(message:string):never {throw new Error(message);}
function portable(value:unknown):string {const key=editValidationKey(value,256*1024**2);if(!key)fail("Retain bounded portable mixed current-film job evidence.");return key;}
function id(value:unknown):void {if(typeof value!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(value))fail("Retain exact mixed current-film owner identities.");}
function exact(value:unknown,keys:string[]):void {if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))fail("Retain exact mixed current-film context fields.");}
function time(value:unknown):number {if(typeof value!=="string"||!Number.isSafeInteger(Date.parse(value))||Date.parse(value)<0||new Date(value).toISOString()!==value)fail("Retain canonical mixed current-film times.");return Date.parse(value);}

/** Validate the complete historical request, not current source availability,
 * live project permission, media existence or a held worker lease. */
const validatedHistoricalJobs=new Set<string>();
function checkedCurrentFilmMixedJob(job:CurrentFilmMixedJob|CurrentFilmMixedJobInput,now?:number):{revision:string;plan?:CurrentFilmJobV3} {
  const key=portable(job),created=time(job.currentFilm.createdAt);
  // Recheck descriptors and the complete content on every call. Only successful
  // historical validation is cached; live time, permission, custody and media
  // checks remain outside this cache. A hit returns only the checked revision;
  // the public validator separately detaches its result, while held comparison
  // consumes this primitive synchronously without cloning either complete plan.
  if(now!==undefined&&(!Number.isSafeInteger(now)||now<created||now>8640000000000000))fail("Mixed current-film admission cannot precede its target.");
  if(validatedHistoricalJobs.has(key)){validatedHistoricalJobs.delete(key);validatedHistoricalJobs.add(key);return {revision:job.currentFilm.revision};}
  const plan=validateCurrentFilmMixedJobPlan(job.currentFilm);id(job.id);id(job.projectId);
  if(conflicts.some(key=>Object.getOwnPropertyDescriptor(job,key)?.value!==undefined)||job.projectId!==plan.projectId||job.stage!==plan.render.stage||job.tier!==plan.render.tier
    ||job.scriptVersion!==plan.materialization.script.version||job.scriptText!==plan.materialization.script.text||job.totalFrames!==plan.materialization.requestedFrames
    ||!same(job.providerPlan,plan.render.providerPlan)||!same(job.casting,plan.target.state.casting.candidate))fail("The mixed current-film job differs from its complete admitted inputs or contains another job mode.");
  // Also checks every direct-origin owner, complete inventory expansion and limits.
  const origins=compileCurrentFilmOrigins(plan,job.id);
  if("startedAt" in job&&job.startedAt!==null&&time(job.startedAt)<created)fail("Mixed current-film execution cannot precede its admitted target.");
  time(job.rightsAttestedAt);
  if(typeof job.idempotencyKey!=="string"||!job.idempotencyKey||job.idempotencyKey.length>257||!Number.isFinite(job.costCapUsd)||job.costCapUsd<=0
    ||job.budgetReservedUsd!==undefined&&(!Number.isFinite(job.budgetReservedUsd)||job.budgetReservedUsd<0||job.budgetReservedUsd>job.costCapUsd))fail("Retain exact mixed current-film admission and budget.");
  exact(job.retryPolicy,["maxRetries","backoffMs"]);
  if(!Number.isSafeInteger(job.retryPolicy.maxRetries)||job.retryPolicy.maxRetries<0||!Number.isSafeInteger(job.retryPolicy.backoffMs)||job.retryPolicy.backoffMs<0
    ||!Number.isSafeInteger(job.timeoutMs)||job.timeoutMs<1)fail("Retain mixed current-film retry and timeout settings.");
  if(job.providerSpec!==undefined&&(job.stage!=="animatic"||job.providerSpec!==plan.render.providerPlan.pool[0]!.spec))fail("The mixed current-film provider override differs from its pinned plan.");
  if(job.stage==="animatic"){if(job.animaticJobId!==null||job.animaticApprovedAt!==null)fail("A mixed current-film preview cannot contain final approval.");}
  else {id(job.animaticJobId);if(job.animaticJobId===job.id)fail("Review an independent mixed current-film preview.");time(job.animaticApprovedAt);}
  if(job.currentFilmOrigins!==undefined){
    if(!("startedAt" in job))fail("Retain the execution time with prepared current-film originals.");time(job.startedAt);
    if(!same(validateCurrentFilmOrigins(job.currentFilmOrigins,plan,job.id),origins))fail("The prepared originals differ from the admitted mixed film.");
  }
  if((job.currentFilmCheckpoint!==undefined||job.output!==undefined)&&job.currentFilmOrigins===undefined)fail("Mixed current-film progress requires its complete prepared-original inventory.");
  if(Object.hasOwn(job,"currentFilmProof")){
    if(!job.currentFilmProof||!("startedAt" in job))fail("Retain the exact prepared-proof marker with its original execution time.");
    validateCurrentFilmPreparedProof(job.currentFilmProof,job);
  }
  validatedHistoricalJobs.add(key);if(validatedHistoricalJobs.size>64)validatedHistoricalJobs.delete(validatedHistoricalJobs.values().next().value!);
  return {revision:plan.revision,plan};
}
export function validateCurrentFilmMixedJob(job:CurrentFilmMixedJob|CurrentFilmMixedJobInput,now?:number):CurrentFilmJobV3 {
  const checked=checkedCurrentFilmMixedJob(job,now);
  return checked.plan??structuredClone(job.currentFilm);
}
/** Only use the revision returned by this envelope's complete validator. Its seal
 * covers every exact plan field, so the comparison need not serialize that full
 * source/proof ancestry again. All other submitted fields remain exact mirrors. */
function submitted(job:CurrentFilmMixedJob|CurrentFilmMixedJobInput,revision:string):unknown {
  return {projectId:job.projectId,idempotencyKey:job.idempotencyKey,currentFilmRevision:revision,stage:job.stage,tier:job.tier,scriptVersion:job.scriptVersion,scriptText:job.scriptText,
    providerPlan:job.providerPlan,providerSpec:job.providerSpec??null,casting:job.casting,totalFrames:job.totalFrames,retryPolicy:job.retryPolicy,timeoutMs:job.timeoutMs,
    costCapUsd:job.costCapUsd,budgetReservedUsd:job.budgetReservedUsd??null,rightsAttestedAt:job.rightsAttestedAt,animaticJobId:job.animaticJobId,animaticApprovedAt:job.animaticApprovedAt};
}
export function assertCurrentFilmMixedAdmission(input:CurrentFilmMixedJobInput,existing?:CurrentFilmMixedJob,now=Date.now()):void {
  portable({input,existing});
  if(["currentFilmProof","currentFilmOrigins","currentFilmCheckpoint","output","routeDecisions"].some(key=>Object.hasOwn(input,key)))fail("Mixed current-film admission cannot supply private worker progress, journal or output.");
  const plan=validateCurrentFilmMixedJob(input,now);
  if(existing){const previous=validateCurrentFilmMixedJob(existing);if(!same(submitted(existing,previous.revision),submitted(input,plan.revision)))fail("This mixed current-film request key belongs to different admitted inputs.");}
}
export function assertCurrentFilmMixedHeldInputs(current:CurrentFilmMixedJob,claimed:CurrentFilmMixedJob):void {
  const saved=checkedCurrentFilmMixedJob(current),received=checkedCurrentFilmMixedJob(claimed);
  if(current.id!==claimed.id||!same(submitted(current,saved.revision),submitted(claimed,received.revision)))fail("The held mixed current-film inputs differ from this worker's admitted job.");
}

/** Full original preparation is immutable once retained by the held job. Media
 * verification and artifact-index publication belong to the caller's fence. */
export function advanceCurrentFilmOrigins(job:CurrentFilmMixedJob,value:CurrentFilmOrigins):CurrentFilmOrigins {
  portable({job,value});const plan=validateCurrentFilmMixedJob(job);time(job.startedAt);
  const next=validateCurrentFilmOrigins(value,plan,job.id);
  if(job.currentFilmOrigins&&!same(job.currentFilmOrigins,next))fail("The durable mixed current-film original inventory is immutable.");return next;
}
export function createCurrentFilmMixedOutput(job:CurrentFilmMixedJob,clock:CurrentFilmMixedAssemblyClock,degradedShots:string[]=[]):CurrentFilmMixedOutput {
  portable({job,clock,degradedShots});const plan=validateCurrentFilmMixedJob(job);
  if(!Array.isArray(degradedShots)||degradedShots.length>plan.selection.length||new Set(degradedShots).size!==degradedShots.length
    ||degradedShots.some(id=>!plan.selection.some(slot=>slot.renderId===id)))fail("Retain bounded unique target identities with mixed current-film continuity outcomes.");
  if(!job.currentFilmOrigins||!job.currentFilmCheckpoint)fail("Complete mixed current-film custody before publishing output.");
  const checkpoint=advanceCurrentFilmMixedCheckpoint(job,job.currentFilmCheckpoint,job.checkpointShots,job.checkpointFrame);
  if(checkpoint.rows.length!==plan.selection.length)fail("Complete every selected mixed current-film slot before publishing output.");
  const assembly=validateCurrentFilmMixedAssemblyClock(job,checkpoint,clock);
  const body={schema:"hv-current-film-output/3" as const,projectId:job.projectId,jobId:job.id,jobPlanRevision:plan.revision,materializationRevision:plan.materialization.revision,
    documentRevision:plan.materialization.documentRevision,targetRevision:plan.target.revision,originsRevision:job.currentFilmOrigins.revision,checkpointRevision:checkpoint.revision,assembly,degradedShots:structuredClone(degradedShots),
    ...(job.currentFilmProof?{proofRevision:job.currentFilmProof.revision}:{})};
  return {...body,revision:hash(body)};
}
export function validateCurrentFilmMixedOutput(job:CurrentFilmMixedJob,output:CurrentFilmMixedJobOutput):void {
  portable({job,output});validateCurrentFilmMixedJob(job);
  const allowed=["mp4Path","hlsPlaylistPath","captionsPath","manifestPath","currentFilm"];
  if(!output||Object.keys(output).some(key=>!allowed.includes(key))||!output.currentFilm)fail("Retain only owned mixed current-film artifacts and private output evidence.");
  const paths=[output.mp4Path,output.hlsPlaylistPath,output.captionsPath,output.manifestPath];
  if(new Set(paths).size!==paths.length||paths.some(path=>typeof path!=="string"||!path.startsWith(job.projectId+"/"+job.id+"/")||path.length>1024
    ||!/^[A-Za-z0-9._/-]+$/.test(path)||path.split("/").some(part=>!part||part==="."||part==="..")))fail("Mixed current-film artifacts escaped their owner.");
  const expected=createCurrentFilmMixedOutput(job,output.currentFilm.assembly,output.currentFilm.degradedShots);
  if(!same(output.currentFilm,expected))fail("Mixed current-film output differs from its original inventory, durable checkpoint or measured assembly.");
}
/** Exact direct-original, selected-role and assembled-file inventory. Required
 * bootstrap/proof closure is separately retained by the enclosing project. */
export function currentFilmMixedRecordedFiles(job:CurrentFilmMixedJob):RenderFile[] {
  validateCurrentFilmMixedJob(job);if(!job.currentFilmOrigins&&!job.currentFilmProof)fail("Retain the complete mixed current-film original inventory.");
  const files=[...(job.currentFilmProof?currentFilmPreparedProofFiles(job.currentFilmProof,job):[]),...(job.currentFilmOrigins?.origins.flatMap(origin=>origin.copies.map(copy=>copy.owned))??[])];
  if(job.currentFilmCheckpoint){
    const checkpoint=advanceCurrentFilmMixedCheckpoint(job,job.currentFilmCheckpoint,job.checkpointShots,job.checkpointFrame);
    files.push(...checkpoint.rows.flatMap(row=>row.kind==="generated"?Object.values(row.record.files):row.adoption.copies.map(copy=>copy.owned)));
  }else if(job.checkpointShots!==0||job.checkpointFrame!==0)fail("The mixed current-film job lost its durable prefix.");
  if(job.output){
    validateCurrentFilmMixedOutput(job,job.output);if(!job.output.captionsPath.endsWith(".vtt"))fail("Retain both actual mixed current-film caption formats.");
    const clock=job.output.currentFilm.assembly;
    files.push({path:job.output.mp4Path,...clock.video},{path:job.output.captionsPath,...clock.captions.vtt},{path:job.output.captionsPath.slice(0,-4)+".srt",...clock.captions.srt});
  }
  if(new Set(files.map(file=>file.path)).size!==files.length)fail("Mixed current-film media roles require distinct owned paths.");return structuredClone(files);
}

export interface CurrentFilmMixedPreviewReview {
  schema:"hv-current-film-preview-review/3";jobId:string;headRevision:string;targetRevision:string;documentRevision:string;
  planRevision:string;materializationRevision:string;outputRevision:string;revision:string;
}
export type CurrentFilmMixedApproval=Omit<AnimaticApproval,"currentFilmReview">&{currentFilmReview?:CurrentFilmPreviewReview|CurrentFilmMixedPreviewReview};
export function createCurrentFilmMixedPreviewReview(preview:CurrentFilmMixedJob):CurrentFilmMixedPreviewReview {
  const plan=validateCurrentFilmMixedJob(preview);
  if(preview.stage!=="animatic"||preview.status!=="done"||!preview.output)fail("Review a completed mixed current-film preview.");
  const completed=time(preview.completedAt);
  if(completed<time(preview.startedAt)||time(preview.linkExpiresAt)<=completed)fail("Retain the mixed current-film preview lifetime.");
  validateCurrentFilmMixedOutput(preview,preview.output);
  const body={schema:"hv-current-film-preview-review/3" as const,jobId:preview.id,headRevision:plan.baseline.headRevision,targetRevision:plan.target.revision,
    documentRevision:plan.materialization.documentRevision,planRevision:plan.revision,materializationRevision:plan.materialization.revision,outputRevision:hash(preview.output)};
  return {...body,revision:hash(body)};
}
export function validateCurrentFilmMixedPreviewReview(preview:CurrentFilmMixedJob,review:CurrentFilmMixedPreviewReview):CurrentFilmMixedPreviewReview {
  portable({preview,review});const expected=createCurrentFilmMixedPreviewReview(preview);
  if(!same(expected,review))fail("The mixed current-film preview changed after its review was opened.");return expected;
}
/** A final may use an explicit V2 or V3 preview of the same canonical target.
 * Stage-specific execution choices differ, but the exact reviewed output and
 * decision remain bound. The caller supplies current permission and a held job. */
export function assertCurrentFilmMixedPreviewApproval(final:CurrentFilmMixedJob|CurrentFilmMixedJobInput,preview:Job|CurrentFilmMixedJob|undefined,approval:CurrentFilmMixedApproval|null|undefined,now=Date.now()):void {
  portable({final,preview,approval,now});const plan=validateCurrentFilmMixedJob(final);
  assertCurrentFilmMixedPreviewRelationship({projectId:final.projectId,jobId:final.id,stage:plan.render.stage,animaticJobId:final.animaticJobId,animaticApprovedAt:final.animaticApprovedAt},plan,preview,approval,now);
  if("startedAt" in final&&final.startedAt!==null&&time(approval!.at)>time(final.startedAt))fail("The mixed current-film preview decision is late, expired or differs from admission.");
}
/** The relationship requires only these admitted fields plus the exact plan.
 * A caller must separately bind a projection to the authoritative saved job;
 * this does not invent a Job, budget, capture, current grant or worker lease. */
export interface CurrentFilmMixedPreviewTarget {
  projectId:string;jobId:string;stage:"animatic"|"final";animaticJobId:string|null;animaticApprovedAt:string|null;
}
const validatedPreviewRelationships=new Set<string>();
export function assertCurrentFilmMixedPreviewRelationship(target:CurrentFilmMixedPreviewTarget,rawPlan:CurrentFilmJobV3,preview:Job|CurrentFilmMixedJob|undefined,approval:CurrentFilmMixedApproval|null|undefined,now:number):void {
  // Reinspect every descriptor and hash the complete current inputs. Only the
  // static relationship is reusable; the caller must supply the latest decision
  // and live preview on every call, and their time bounds are always rechecked.
  const key=portable({target,rawPlan,preview,approval});
  if(!validatedPreviewRelationships.has(key)){
  exact(target,["projectId","jobId","stage","animaticJobId","animaticApprovedAt"]);
  const plan=validateCurrentFilmMixedJobPlan(rawPlan);id(target.projectId);id(target.jobId);
  if(target.projectId!==plan.projectId||target.stage!==plan.render.stage||target.stage!=="final"||!preview||!approval)fail("Select the saved mixed current-film preview approval.");
  id(target.animaticJobId);time(target.animaticApprovedAt);
  let review:CurrentFilmPreviewReview|CurrentFilmMixedPreviewReview;
  if(preview.currentFilm?.schema==="hv-current-film-job/3")review=createCurrentFilmMixedPreviewReview(preview as CurrentFilmMixedJob);
  else if(preview.currentFilm?.schema==="hv-current-film-job/2")review=createCurrentFilmPreviewReview(preview as Job);
  else fail("Select an explicit completed canonical current-film preview.");
  const candidate=preview.currentFilm!;
  if(preview.id!==target.animaticJobId||preview.projectId!==target.projectId||preview.id===target.jobId||!same(candidate.selector,plan.selector)||!same(candidate.target,plan.target)
    ||candidate.baseline.headRevision!==plan.baseline.headRevision||!same(preview.casting,plan.target.state.casting.candidate)||preview.scriptText!==plan.materialization.script.text||preview.scriptVersion!==plan.materialization.script.version)fail("The approved mixed current-film preview differs from the final target.");
  if(!same(approval.currentFilmReview,review)||approval.livingScriptReview!==undefined||approval.takeRevision!==undefined||approval.animaticJobId!==preview.id||approval.scriptVersion!==plan.materialization.script.version||approval.decision!=="approved")fail("Retain the exact mixed current-film preview decision.");
  const cast=plan.target.state.casting.candidate!,direction=plan.library.origin!.request.baseline.direction;
  if(approval.castingVersion!==cast.version||approval.castingRevision!==cast.revision||approval.directionVersion!==direction.version||approval.directionRevision!==direction.revision)fail("The mixed current-film approval lost its exact cast or original direction baseline.");
  }
  const at=time(approval!.at),completed=time(preview!.completedAt),expires=time(preview!.linkExpiresAt);
  if(!Number.isSafeInteger(now)||at!==time(target.animaticApprovedAt)||at<completed||at>=expires||at>now||expires<=now)fail("The mixed current-film preview decision is late, expired or differs from admission.");
  validatedPreviewRelationships.delete(key);validatedPreviewRelationships.add(key);
  if(validatedPreviewRelationships.size>64)validatedPreviewRelationships.delete(validatedPreviewRelationships.values().next().value!);
}
