import type {Job,JobInput} from "../../queue/src/index";
import type {AnimaticApproval} from "../../api/src/index";
import type {VideoClip} from "../../generator/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {castingSnapshot} from "./casting";
import {directionSnapshot} from "./direction";
import {editFail,editId,editNumber} from "./edit-timeline";
import {assertLivingScriptJobInputs,validateLivingScriptJobPlan} from "./living-script-jobs";
import {assertRenderedOrigin,assertSpeechInput,renderInputHash,renderShots,validateRenderRecord,type ShotRenderRecord} from "./shot-reuse";
import {validateShotExecutionOutput} from "./shot-execution-inventory";

export interface LivingScriptPreviewReview {
  schema:"hv-living-script-preview-review/1";jobId:string;proposalRevision:string;planRevision:string;outputRevision:string;revision:string;
}
const same=(a:unknown,b:unknown)=>contentHash(a)===contentHash(b);
const conflicting=["shotTakes","characterSheet","dialogueReplacement","dialogueCheckpoint","audioTake","audioCheckpoint","audioOutput","lipSync","lipSyncPrepared","lipSyncCheckpoint","lipSyncReviews","soundMix","soundCheckpoint","pictureEdit","editCheckpoint","assemblyEdit","assemblyCheckpoint","graphicRender","graphicCheckpoint","graphicOutput","graphicProgress"] as const;
const outputFields=["mp4Path","hlsPlaylistPath","captionsPath","manifestPath","shotRenders","shotExecutions","picturePerformances","cameraPathRenders","frameAnchorRenders","storyboard"];
function present(value:object,key:string):boolean {
  const field=Object.getOwnPropertyDescriptor(value,key);if(field&&!Object.hasOwn(field,"value"))editFail("Retain pending context fields without accessors.");return field?.value!==undefined;
}
function portable(value:unknown):void {
  const active=new Set<object>();const visit=(item:unknown,depth:number):void=>{
    if(item===null||typeof item==="string"||typeof item==="boolean")return;
    if(typeof item==="number"&&Number.isFinite(item)&&!Object.is(item,-0))return;
    if(typeof item!=="object"||depth>180||active.has(item))editFail("Retain portable pending job metadata.");
    const array=Array.isArray(item),prototype=Object.getPrototypeOf(item),keys=Reflect.ownKeys(item);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)editFail("Retain plain pending job metadata.");
    if(array&&keys.length!==item.length+1)editFail("Retain dense pending job arrays.");active.add(item);
    for(const key of keys){if(array&&key==="length")continue;const d=Object.getOwnPropertyDescriptor(item,key)!;
      if(typeof key!=="string"||!d.enumerable||!Object.hasOwn(d,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=item.length))editFail("Retain pending job fields without accessors or hidden values.");
      // Normal server-built JobInput objects can have explicit undefined optional properties;
      // their JSON representation and restored equivalent deliberately mean the same thing.
      if(!array&&d.value===undefined)continue;visit(d.value,depth+1);
    }active.delete(item);
  };visit(value,0);if(Buffer.byteLength(JSON.stringify(value),"utf8")>256*1024**2)editFail("The pending job context exceeds 256 MiB.");
}
function time(value:unknown,label:string):number {
  if(typeof value!=="string")editFail("Retain an exact "+label+" time.");const at=Date.parse(value);
  if(!Number.isSafeInteger(at)||at<0||new Date(at).toISOString()!==value)editFail("Retain an exact "+label+" time.");return at;
}
function historical(job:Job|JobInput):number {return "startedAt" in job&&job.startedAt!==null?time(job.startedAt,"render start"):time(job.livingScript!.createdAt,"pending plan");}
function outputShape(job:Job|JobInput,output:NonNullable<Job["output"]>):void {
  if(!output||typeof output!=="object"||Array.isArray(output)||Object.keys(output).some(key=>!outputFields.includes(key)))editFail("Pending screenplay output must contain only its own normal film artifacts.");
  const required=[output.mp4Path,output.hlsPlaylistPath,output.captionsPath,output.manifestPath];
  if(new Set(required).size!==required.length||required.some(path=>typeof path!=="string"||!path.startsWith(job.projectId+"/"+job.id+"/")||path.length>1024||!/^[A-Za-z0-9._/-]+$/.test(path)||path.split("/").some(part=>!part||part==="."||part==="..")))editFail("Pending film artifacts escaped their owning job.");
}
/** Pure job context validation; current project, provider and carrier authority are fenced by
 * the caller. Omit now for historical restore; admission supplies the current clock. */
export function validateLivingScriptJob(job:Job|JobInput,now?:number):void {
  if(!present(job,"livingScript"))return;portable(job);
  const plan=validateLivingScriptJobPlan(job.livingScript!);assertLivingScriptJobInputs(plan,job);editId(job.id);editId(job.projectId);
  if(!["animatic","final"].includes(job.stage)||conflicting.some(key=>job[key]!==undefined)||job.id===plan.binding.owner.jobId||job.id===plan.binding.source.job.id)editFail("Pending screenplay generation requires an isolated normal film job and an independent carrier.");
  const created=time(plan.createdAt,"pending plan"),at=historical(job);if(at<created)editFail("Pending generation cannot start before its reviewed plan.");
  if(now!==undefined){editNumber(now,0,8640000000000000,"Pending job validation time");if(now<created)editFail("Pending generation cannot be admitted before its reviewed plan.");}
  if(job.totalFrames!==renderShots(job,at).reduce((total,shot)=>total+Math.round(shot.durationSec*30),0))editFail("Pending generation lost its exact planned frame budget.");
  if(typeof job.idempotencyKey!=="string"||!job.idempotencyKey||job.idempotencyKey.length>257)editFail("Retain a bounded pending generation request key.");
  time(job.rightsAttestedAt,"rights attestation");
  if(!Number.isFinite(job.costCapUsd)||job.costCapUsd<=0||job.budgetReservedUsd!==undefined&&(!Number.isFinite(job.budgetReservedUsd)||job.budgetReservedUsd<0||job.budgetReservedUsd>job.costCapUsd))editFail("Retain the admitted pending generation budget and reservation.");
  if(!job.retryPolicy||Object.keys(job.retryPolicy).sort().join(",")!=="backoffMs,maxRetries"||!Number.isSafeInteger(job.retryPolicy.maxRetries)||job.retryPolicy.maxRetries<0||!Number.isSafeInteger(job.retryPolicy.backoffMs)||job.retryPolicy.backoffMs<0||!Number.isSafeInteger(job.timeoutMs)||job.timeoutMs<1)editFail("Retain the admitted pending generation retry and timeout settings.");
  if(job.providerSpec!==undefined&&(job.stage!=="animatic"||job.providerSpec!==job.providerPlan!.pool[0]!.spec))editFail("The pending provider override differs from its pinned preview provider.");
  if(job.stage==="animatic"){if(job.animaticJobId!==null||job.animaticApprovedAt!==null)editFail("A pending preview cannot carry another preview's final approval.");}
  else{if(plan.request.role!=="render"||!job.animaticJobId||job.animaticJobId===job.id)editFail("A pending final requires its own reviewed pending preview.");editId(job.animaticJobId);time(job.animaticApprovedAt,"animatic approval");}
  if(job.output)outputShape(job,job.output);
}
function submitted(job:Job|JobInput):unknown {
  return {projectId:job.projectId,idempotencyKey:job.idempotencyKey,stage:job.stage,tier:job.tier,scriptVersion:job.scriptVersion,scriptText:job.scriptText,
    livingScript:job.livingScript??null,casting:job.casting??null,direction:job.direction??null,providerPlan:job.providerPlan??null,providerSpec:job.providerSpec??null,shotReuse:job.shotReuse??null,
    totalFrames:job.totalFrames,costCapUsd:job.costCapUsd,budgetReservedUsd:job.budgetReservedUsd??null,retryPolicy:job.retryPolicy,timeoutMs:job.timeoutMs,
    rightsAttestedAt:job.rightsAttestedAt,animaticJobId:job.animaticJobId,animaticApprovedAt:job.animaticApprovedAt};
}
export function assertLivingScriptIdempotency(existing:Job|undefined,input:JobInput):void {
  if(!existing||!present(existing,"livingScript")&&!present(input,"livingScript"))return;
  portable(existing);portable(input);
  if(existing.livingScript===undefined||input.livingScript===undefined)editFail("This request key belongs to a different pending screenplay context.");
  validateLivingScriptJob(existing);validateLivingScriptJob(input);
  if(!same(submitted(existing),submitted(input)))editFail("This pending generation key already belongs to a different reviewed plan or submitted render settings.");
}
function records(job:Job|JobInput,items:ShotRenderRecord[],complete:boolean):void {
  const shots=renderShots(job,historical(job));
  if(!Array.isArray(items)||items.length>shots.length||complete&&items.length!==shots.length)editFail("Retain the exact complete shot order or checkpoint prefix for pending generation.");
  for(const [index,record]of items.entries()){
    const shot=shots[index]!;validateRenderRecord(record,job);
    if(record.shotId!==shot.id||record.inputHash!==renderInputHash(job,shot))editFail("A pending rendered shot changed its admitted order or inputs.");
    assertSpeechInput(record,shot);assertRenderedOrigin(record,job);
  }
}
/** Validates complete metadata before completion/publication; actual media byte checks remain
 * with the caller's normal local/S3 verification and lease fence. */
export function validateLivingScriptOutput(job:Job|JobInput,output:NonNullable<Job["output"]>):void {
  if(!present(job,"livingScript")){if(output&&(Object.hasOwn(output,"livingScript")||Object.hasOwn(output,"livingScriptReview")))editFail("An ordinary output cannot supply a pending screenplay plan.");return;}
  portable(output);validateLivingScriptJob(job);outputShape(job,output);records(job,output.shotRenders!,true);
  if(output.shotExecutions!==undefined||"executionCheckpoints" in job)validateShotExecutionOutput(job as Job,output);
}
export function validateLivingScriptClips(job:Job|JobInput,clips:VideoClip[]):void {
  if(!present(job,"livingScript"))return;portable(clips);validateLivingScriptJob(job);
  if(!Array.isArray(clips))editFail("Retain an ordered pending clip checkpoint.");
  records(job,clips.map(clip=>clip.renderRecord!),false);
  for(const clip of clips){const {path:_path,audioPath:_audioPath,posterPath:_posterPath,sourcePosterPath:_sourcePosterPath,cost:_cost,renderRecord:record,...metadata}=clip;
    if(!record||!same(metadata,record.clip))editFail("The pending clip metadata differs from its exact rendered receipt.");
  }
}
/** This sealed receipt identifies actual completed preview media; it is not an approval. */
export function createLivingScriptPreviewReview(previewJob:Job):LivingScriptPreviewReview {
  validateLivingScriptJob(previewJob);
  const plan=previewJob.livingScript;if(!plan||plan.request.role!=="preview"||previewJob.stage!=="animatic"||previewJob.status!=="done"||!previewJob.output)editFail("Review a completed pending preview for the exact final screenplay proposal.");
  const completed=time(previewJob.completedAt,"preview completion"),expires=time(previewJob.linkExpiresAt,"preview expiry");
  if(completed<historical(previewJob)||expires<=completed)editFail("The pending preview lost its completed media lifetime.");
  validateLivingScriptOutput(previewJob,previewJob.output);
  const data={schema:"hv-living-script-preview-review/1" as const,jobId:previewJob.id,proposalRevision:plan.proposal.revision,planRevision:plan.revision,outputRevision:contentHash(previewJob.output)};
  return {...data,revision:contentHash(data)};
}
/** The caller must fetch this approval from the current saved project under its mutation fence.
 * A caller-supplied review alone never grants final generation or changes the screenplay. */
export function assertLivingScriptPreviewApproval(finalJob:Job|JobInput,previewJob:Job|undefined,approval:AnimaticApproval|null|undefined,now=Date.now()):void {
  if(!present(finalJob,"livingScript")){if(previewJob&&present(previewJob,"livingScript")||approval&&present(approval,"livingScriptReview"))editFail("An ordinary final cannot consume a pending screenplay preview or approval.");return;}
  validateLivingScriptJob(finalJob);editNumber(now,0,8640000000000000,"Pending final approval time");
  if(finalJob.stage!=="final"||!previewJob||!approval)editFail("Select the current saved approval for this pending final preview.");
  portable(approval);const review=createLivingScriptPreviewReview(previewJob),plan=finalJob.livingScript!,preview=previewJob.livingScript!;
  if(previewJob.projectId!==finalJob.projectId||previewJob.id!==finalJob.animaticJobId||previewJob.id===finalJob.id||preview.proposal.revision!==plan.proposal.revision||!same(preview.proposal,plan.proposal)
    ||previewJob.scriptVersion!==finalJob.scriptVersion||previewJob.scriptText!==finalJob.scriptText||!same(previewJob.casting??null,finalJob.casting??null)||!same(previewJob.direction??null,finalJob.direction??null))editFail("The approved preview differs from this exact pending final proposal and candidate settings.");
  if(!same(approval.livingScriptReview??null,review)||approval.animaticJobId!==previewJob.id||approval.scriptVersion!==finalJob.scriptVersion||approval.decision!=="approved"||approval.takeRevision!==undefined)editFail("Retain the exact saved pending preview approval and completed output review.");
  const at=time(approval.at,"saved preview approval"),completed=time(previewJob.completedAt,"preview completion"),expires=time(previewJob.linkExpiresAt,"preview expiry");
  if(at!==time(finalJob.animaticApprovedAt,"admitted preview approval")||at<completed||at>=expires||at>now||completed>now||expires<=now||"startedAt" in finalJob&&finalJob.startedAt!==null&&at>time(finalJob.startedAt,"final start"))editFail("The pending preview approval is late, expired or differs from the admitted approval time.");
  const cast=finalJob.casting??castingSnapshot(finalJob.projectId,0,[],0),direction=finalJob.direction??directionSnapshot(finalJob.projectId,0,[],0);
  if(approval.castingVersion!==cast.version||approval.castingRevision!==cast.revision||approval.directionVersion!==direction.version||approval.directionRevision!==direction.revision)editFail("The saved pending approval lost its exact candidate cast or direction.");
}
