import type {Job,JobInput} from "../../queue/src/index";
import type {AnimaticApproval} from "../../api/src/index";
import type {VideoClip} from "../../generator/src/index";
import {contentHash as hash} from "../../generator/src/capabilities";
import {validateCurrentFilmJobPlan,type CurrentFilmJobV2} from "./current-film-jobs";
import {validateRenderRecord,assertSpeechInput} from "./shot-reuse";
import {validateShotExecutionCapture,type ShotExecutionCapture} from "./shot-execution-capture";
import {validateCurrentFilmAssemblyClock,type CurrentFilmAssemblyClock,type CurrentFilmClockRow} from "./current-film-clock";

export interface CurrentFilmCheckpointRow extends CurrentFilmClockRow {capture:ShotExecutionCapture}
export interface CurrentFilmCheckpoint {
  schema:"hv-current-film-checkpoint/2";projectId:string;jobId:string;jobPlanRevision:string;materializationRevision:string;rows:CurrentFilmCheckpointRow[];revision:string;
}
export interface CurrentFilmOutput {
  schema:"hv-current-film-output/2";projectId:string;jobId:string;jobPlanRevision:string;materializationRevision:string;documentRevision:string;targetRevision:string;
  checkpointRevision:string;records:CurrentFilmClockRow[];assembly:CurrentFilmAssemblyClock;revision:string;
}
export interface CurrentFilmPreviewReview {
  schema:"hv-current-film-preview-review/2";jobId:string;headRevision:string;targetRevision:string;documentRevision:string;planRevision:string;materializationRevision:string;outputRevision:string;revision:string;
}
export interface CurrentFilmV2Envelope {
  currentFilm?:CurrentFilmJobV2;currentFilmCheckpoint?:CurrentFilmCheckpoint;currentFilmOrigins?:never;currentFilmProof?:never;
  output?:Omit<NonNullable<Job["output"]>,"currentFilm">&{currentFilm?:CurrentFilmOutput};
}
export type CurrentFilmV2Job=Omit<Job,keyof CurrentFilmV2Envelope>&CurrentFilmV2Envelope;
const same=(a:unknown,b:unknown)=>hash(a)===hash(b);
const seal=<T extends object>(body:T):T&{revision:string}=>({...body,revision:hash(body)});
const conflicts=["direction","shotReuse","livingScript","executionCheckpoints","shotTakes","characterSheet","dialogueReplacement","dialogueCheckpoint","audioTake","audioCheckpoint","audioOutput","lipSync","lipSyncPrepared","lipSyncCheckpoint","lipSyncReviews","soundMix","soundCheckpoint","pictureEdit","editCheckpoint","assemblyEdit","assemblyCheckpoint","graphicRender","graphicCheckpoint","graphicOutput","graphicProgress"] as const;
function fail(message:string):never {throw new Error(message);}
function id(value:unknown):void {if(typeof value!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(value))fail("Retain exact current-film owner identities.");}
function exact(value:unknown,keys:string[]):void {if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))fail("Retain exact current-film context fields.");}
function time(value:unknown):number {if(typeof value!=="string"||!Number.isSafeInteger(Date.parse(value))||Date.parse(value)<0||new Date(value).toISOString()!==value)fail("Retain canonical current-film times.");return Date.parse(value);}
/** Inspect descriptors before fields/hashes. Server-built optional undefined properties
 * normalize as absent on durable JSON transport; arrays and V2 plans remain strict. */
function portable(value:unknown):void {
  let nodes=0,bytes=0;const active=new Set<object>();
  const visit=(item:unknown,depth:number):void=>{
    if(++nodes>2500000||depth>200)fail("Current-film context exceeds metadata capacity.");
    if(typeof item==="string"){bytes+=Buffer.byteLength(item);if(bytes>256*1024**2)fail("Current-film context exceeds metadata capacity.");return;}
    if(item===null||typeof item==="boolean"||typeof item==="number"&&Number.isFinite(item)&&!Object.is(item,-0))return;
    if(typeof item!=="object"||active.has(item))fail("Retain portable current-film context.");
    const array=Array.isArray(item),keys=Reflect.ownKeys(item),prototype=Object.getPrototypeOf(item);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)fail("Retain plain current-film context.");
    if(array&&keys.length!==item.length+1)fail("Retain dense current-film context arrays.");active.add(item);
    for(const key of keys){if(array&&key==="length")continue;const d=Object.getOwnPropertyDescriptor(item,key)!;
      if(typeof key!=="string"||!d.enumerable||!Object.hasOwn(d,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=item.length))fail("Current-film context cannot contain accessors or hidden fields.");
      bytes+=Buffer.byteLength(key);if(bytes>256*1024**2)fail("Current-film context exceeds metadata capacity.");
      if(!array&&d.value===undefined){if(++nodes>2500000)fail("Current-film context exceeds metadata capacity.");continue;}visit(d.value,depth+1);
    }active.delete(item);
  };visit(value,0);if(Buffer.byteLength(JSON.stringify(value))>256*1024**2)fail("Current-film context exceeds metadata capacity.");
}
/** A malformed or orphaned V2 marker must never fall through to ordinary generation. */
export function assertCurrentFilmMode<T extends Job|JobInput>(job:T):asserts job is T&CurrentFilmV2Envelope {
  const read=(value:object,key:string):unknown=>{const d=Object.getOwnPropertyDescriptor(value,key);if(d&&(!d.enumerable||!Object.hasOwn(d,"value")))fail("Retain current-film mode without hidden fields or accessors.");return d?.value;};
  const plan=read(job,"currentFilm"),checkpoint=read(job,"currentFilmCheckpoint"),output=read(job,"output"),completed=output&&typeof output==="object"?read(output,"currentFilm"):undefined;
  if(Object.hasOwn(job,"currentFilmOrigins"))fail("Version-two current-film context cannot contain mixed original custody.");
  if(Object.hasOwn(job,"currentFilmProof"))fail("Version-two or ordinary current-film context cannot contain mixed prepared proof.");
  if(plan!==undefined){if(!plan||typeof plan!=="object"||read(plan,"schema")!=="hv-current-film-job/2"
    ||checkpoint!==undefined&&(!checkpoint||typeof checkpoint!=="object"||read(checkpoint,"schema")!=="hv-current-film-checkpoint/2")
    ||completed!==undefined&&(!completed||typeof completed!=="object"||read(completed,"schema")!=="hv-current-film-output/2"))fail("Use the explicit valid current-film discriminator.");}
  else if(checkpoint!==undefined||completed!==undefined)fail("Current-film evidence requires its owning job context.");
}
/** Strict historical V2 validation; the service/held transaction supplies live authority. */
export function validateCurrentFilmJob(job:Job|JobInput,now?:number):CurrentFilmJobV2 {
  portable(job);assertCurrentFilmMode(job);if(!job.currentFilm)fail("Use an explicit version-two current-film job.");
  const plan=validateCurrentFilmJobPlan(job.currentFilm);id(job.id);id(job.projectId);
  if(conflicts.some(key=>Object.getOwnPropertyDescriptor(job,key)?.value!==undefined)||job.projectId!==plan.projectId||job.stage!==plan.render.stage||job.tier!==plan.render.tier
    ||job.scriptVersion!==plan.materialization.script.version||job.scriptText!==plan.materialization.script.text||job.totalFrames!==plan.materialization.requestedFrames
    ||!same(job.providerPlan,plan.render.providerPlan)||!same(job.casting,plan.target.state.casting.candidate))fail("The current-film job differs from its complete admitted inputs or contains another job mode.");
  if(plan.library.origin?.request.source.job.id===job.id)fail("Generate the current film in a new owning job.");
  const created=time(plan.createdAt);if("startedAt" in job&&job.startedAt!==null&&time(job.startedAt)<created)fail("Current-film execution cannot precede its admitted target.");
  if(now!==undefined&&(!Number.isSafeInteger(now)||now<created||now>8640000000000000))fail("Current-film admission cannot precede its target.");
  time(job.rightsAttestedAt);
  if(typeof job.idempotencyKey!=="string"||!job.idempotencyKey||job.idempotencyKey.length>257||!Number.isFinite(job.costCapUsd)||job.costCapUsd<=0
    ||job.budgetReservedUsd!==undefined&&(!Number.isFinite(job.budgetReservedUsd)||job.budgetReservedUsd<0||job.budgetReservedUsd>job.costCapUsd))fail("Retain the exact current-film request and admitted budget.");
  exact(job.retryPolicy,["maxRetries","backoffMs"]);
  if(!Number.isSafeInteger(job.retryPolicy.maxRetries)||job.retryPolicy.maxRetries<0||!Number.isSafeInteger(job.retryPolicy.backoffMs)||job.retryPolicy.backoffMs<0||!Number.isSafeInteger(job.timeoutMs)||job.timeoutMs<1)fail("Retain current-film retry and timeout settings.");
  if(job.providerSpec!==undefined&&(job.stage!=="animatic"||job.providerSpec!==plan.render.providerPlan.pool[0]!.spec))fail("The current-film provider override differs from its pinned plan.");
  if(job.stage==="animatic"){if(job.animaticJobId!==null||job.animaticApprovedAt!==null)fail("A current-film preview cannot contain final approval.");}
  else {id(job.animaticJobId);if(job.animaticJobId===job.id)fail("Review an independent current-film preview.");time(job.animaticApprovedAt);}
  return plan;
}
/** Explicit checked V2 view for consumers whose source/clock format predates
 * mixed adoption. This never relabels a V3 plan, checkpoint or output. */
export function currentFilmV2Job(job:Job):CurrentFilmV2Job {assertCurrentFilmMode(job);validateCurrentFilmJob(job);return job;}
function submitted(job:Job|JobInput):unknown {
  return {projectId:job.projectId,idempotencyKey:job.idempotencyKey,currentFilm:job.currentFilm,stage:job.stage,tier:job.tier,scriptVersion:job.scriptVersion,scriptText:job.scriptText,
    providerPlan:job.providerPlan,providerSpec:job.providerSpec??null,casting:job.casting,totalFrames:job.totalFrames,retryPolicy:job.retryPolicy,timeoutMs:job.timeoutMs,
    costCapUsd:job.costCapUsd,budgetReservedUsd:job.budgetReservedUsd??null,rightsAttestedAt:job.rightsAttestedAt,animaticJobId:job.animaticJobId,animaticApprovedAt:job.animaticApprovedAt};
}
export function assertCurrentFilmIdempotency(existing:Job|undefined,input:JobInput):void {
  assertCurrentFilmMode(input);if(existing)assertCurrentFilmMode(existing);
  if(!input.currentFilm&&!existing?.currentFilm)return;
  portable({existing,input});if(Object.hasOwn(input,"currentFilmCheckpoint")||Object.hasOwn(input.output??{},"currentFilm")||input.currentFilm&&input.output!==undefined)fail("Admission cannot supply generated current-film evidence.");
  if(!existing)return;if(!existing.currentFilm&&!input.currentFilm)return;
  validateCurrentFilmJob(existing);validateCurrentFilmJob(input);if(!same(submitted(existing),submitted(input)))fail("This current-film request key belongs to different inputs or generation settings.");
}
/** Compare immutable admitted inputs on two worker snapshots. Private progress in the
 * caller never establishes custody; the held job independently validates its own prefix. */
export function assertCurrentFilmHeldInputs(current:Job,claimed:Job):void {
  assertCurrentFilmMode(current);assertCurrentFilmMode(claimed);if(!current.currentFilm&&!claimed.currentFilm)return;
  validateCurrentFilmJob(current);validateCurrentFilmJob(claimed);
  if(current.id!==claimed.id||!same(submitted(current),submitted(claimed)))fail("The held current-film inputs differ from this worker's admitted job.");
}
function checkedRows(job:Job|JobInput,plan:CurrentFilmJobV2,rows:CurrentFilmCheckpointRow[]):void {
  if(!Array.isArray(rows)||rows.length>plan.materialization.slots.length)fail("Retain the exact ordered current-film checkpoint prefix.");
  if(rows.length){if(!("startedAt" in job))fail("Retain the original current-film execution time.");time(job.startedAt);}
  const paths=new Set<string>();
  for(const [index,row]of rows.entries()){
    exact(row,["ordinal","logicalShotId","renderId","inputRevision","record","capture"]);const slot=plan.materialization.slots[index]!;
    if(row.ordinal!==index||row.logicalShotId!==slot.logicalShotId||row.renderId!==slot.renderId||row.inputRevision!==slot.inputRevision)fail("The current-film checkpoint changed its slot order or inputs.");
    validateRenderRecord(row.record,job);if(row.record.shotId!==slot.renderId||row.record.inputHash!==slot.inputRevision||row.record.reusedFrom)fail("Retain a fresh current-film record under its exact owning slot.");
    for(const file of Object.values(row.record.files)){if(paths.has(file.path))fail("Fresh current-film slots and media roles require distinct owned paths.");paths.add(file.path);}
    assertSpeechInput(row.record,slot.shot);validateShotExecutionCapture(row.capture,row.record);
    if(!same(row.capture.observation.recipe,slot.recipe))fail("The actual current-film capture differs from its admitted recipe.");
    const frames=row.record.clip.durationSec*30;if(!Number.isSafeInteger(Math.round(frames))||Math.abs(frames-Math.round(frames))>1e-7)fail("Current-film clips require exact 30 fps frame durations.");
  }
}
export function createCurrentFilmCheckpoint(job:Job|JobInput,rows:CurrentFilmCheckpointRow[]):CurrentFilmCheckpoint {
  portable({job,rows});const plan=validateCurrentFilmJob(job);checkedRows(job,plan,rows);
  return structuredClone(seal({schema:"hv-current-film-checkpoint/2" as const,projectId:job.projectId,jobId:job.id,jobPlanRevision:plan.revision,materializationRevision:plan.materialization.revision,rows}));
}
export function validateCurrentFilmCheckpoint(job:Job|JobInput,input:CurrentFilmCheckpoint):CurrentFilmCheckpoint {
  portable({job,input});exact(input,["schema","projectId","jobId","jobPlanRevision","materializationRevision","rows","revision"]);
  const expected=createCurrentFilmCheckpoint(job,input.rows);if(!same(input,expected))fail("The current-film checkpoint lost its exact context or seal.");return expected;
}
/** The caller holds this authoritative job. Never establish journal custody from a worker copy. */
export function advanceCurrentFilmCheckpoint(job:Job,input:CurrentFilmCheckpoint,shots:number,frames:number):CurrentFilmCheckpoint {
  assertCurrentFilmMode(job);
  const next=validateCurrentFilmCheckpoint(job,input),previous=job.currentFilmCheckpoint;
  if(next.rows.length!==shots||frames!==next.rows.reduce((sum,row)=>sum+Math.round(row.record.clip.durationSec*30),0))fail("Current-film progress differs from the actual recorded prefix.");
  if(!Number.isSafeInteger(job.checkpointShots)||job.checkpointShots<0||job.checkpointShots>shots)fail("A current-film checkpoint cannot truncate its durable prefix.");
  if(previous){validateCurrentFilmCheckpoint(job,previous);
    if(previous.rows.length!==job.checkpointShots||previous.rows.reduce((sum,row)=>sum+Math.round(row.record.clip.durationSec*30),0)!==job.checkpointFrame||!same(previous.rows,next.rows.slice(0,job.checkpointShots)))fail("The durable current-film prefix is immutable.");
  }else if(job.checkpointShots!==0||job.checkpointFrame!==0)fail("A current-film checkpoint cannot invent missing historical custody.");
  const journal=job.routeDecisions??[];if(new Set(journal.map(row=>row.id)).size!==journal.length)fail("The current-film durable journal contains duplicate decisions.");
  for(const row of next.rows)for(const route of row.capture.routes){const saved=journal.find(value=>value.id===route.id);if(!saved||!same(saved,route))fail("The captured current-film route is absent from its held durable journal.");}
  return next;
}
export function validateCurrentFilmClips(job:Job|JobInput,clips:VideoClip[],checkpoint?:CurrentFilmCheckpoint):CurrentFilmCheckpoint {
  assertCurrentFilmMode(job);
  portable({job,clips,checkpoint});const input=checkpoint??("currentFilmCheckpoint" in job?job.currentFilmCheckpoint:undefined);
  if(!input)fail("Retain the actual current-film checkpoint with its clips.");const checked=validateCurrentFilmCheckpoint(job,input);
  if(!Array.isArray(clips)||clips.length!==checked.rows.length)fail("Current-film clips differ from their checkpoint prefix.");
  for(const [i,clip]of clips.entries()){
    const {path:_path,audioPath:_audio,posterPath:_poster,sourcePosterPath:_source,cost:_cost,renderRecord,...metadata}=clip,record=checked.rows[i]!.record;
    if(!same(renderRecord,record)||!same(metadata,record.clip))fail("Current-film clip metadata differs from its fresh record.");
    for(const [field,role]of [["path","video"],["audioPath","audio"],["posterPath","poster"],["sourcePosterPath","sourcePoster"]] as const)if(Boolean(clip[field])!==Boolean(record.files[role]))fail("Current-film checkpoint lost a recorded media role.");
  }return checked;
}
export function createCurrentFilmOutput(job:Job|JobInput,input:CurrentFilmCheckpoint,assembly:CurrentFilmAssemblyClock):CurrentFilmOutput {
  portable({job,input,assembly});const plan=validateCurrentFilmJob(job),checkpoint=validateCurrentFilmCheckpoint(job,input);
  if(checkpoint.rows.length!==plan.materialization.slots.length)fail("Complete every current-film slot before publishing output.");
  const records=checkpoint.rows.map(({capture:_capture,...row})=>row),clock=validateCurrentFilmAssemblyClock(assembly,records,plan.render.assembly.requestedCrossfadeFrames);
  if(clock.projectId!==job.projectId||clock.jobId!==job.id||clock.jobPlanRevision!==plan.revision||clock.materializationRevision!==plan.materialization.revision
    ||clock.probe.video.width!==plan.render.outputSize.width||clock.probe.video.height!==plan.render.outputSize.height)fail("The measured current-film assembly belongs to different inputs or dimensions.");
  return seal({schema:"hv-current-film-output/2" as const,projectId:job.projectId,jobId:job.id,jobPlanRevision:plan.revision,materializationRevision:plan.materialization.revision,documentRevision:plan.materialization.documentRevision,targetRevision:plan.target.revision,checkpointRevision:checkpoint.revision,records,assembly:clock});
}
export function validateCurrentFilmOutput(job:Job|JobInput,output:NonNullable<Job["output"]>):void {
  assertCurrentFilmMode(job);const marker=Object.getOwnPropertyDescriptor(output,"currentFilm");if(marker&&(!marker.enumerable||!Object.hasOwn(marker,"value")))fail("Retain current-film output without hidden fields or accessors.");
  if(!job.currentFilm){if(marker?.value!==undefined)fail("An ordinary job cannot own current-film evidence.");return;}
  portable({job,output});
  const allowed=["mp4Path","hlsPlaylistPath","captionsPath","manifestPath","currentFilm","picturePerformances","cameraPathRenders","frameAnchorRenders","storyboard"];
  if(Object.keys(output).some(key=>!allowed.includes(key))||!output.currentFilm||!("currentFilmCheckpoint" in job)||!job.currentFilmCheckpoint)fail("Retain only owned current-film artifacts and the complete private checkpoint.");
  const paths=[output.mp4Path,output.hlsPlaylistPath,output.captionsPath,output.manifestPath];
  if(new Set(paths).size!==paths.length||paths.some(path=>typeof path!=="string"||!path.startsWith(job.projectId+"/"+job.id+"/")||path.length>1024||!/^[A-Za-z0-9._/-]+$/.test(path)||path.split("/").some(part=>!part||part==="."||part==="..")))fail("Current-film artifacts escaped their owner.");
  const held=job as CurrentFilmV2Job,checkpoint=advanceCurrentFilmCheckpoint(held,held.currentFilmCheckpoint!,held.checkpointShots,held.checkpointFrame);
  if(output.currentFilm.schema!=="hv-current-film-output/2")fail("Retain the exact version-two current-film output.");
  const expected=createCurrentFilmOutput(job,checkpoint,output.currentFilm.assembly);if(!same(expected,output.currentFilm))fail("Current-film output differs from its immutable checkpoint and assembly.");
}
/** Exact indexed bytes required at held completion and independent restoration. */
export function currentFilmRecordedFiles(job:Job):{path:string;sha256:string;bytes:number}[] {
  assertCurrentFilmMode(job);
  validateCurrentFilmJob(job);if(!job.currentFilmCheckpoint)fail("Retain the complete current-film custody before reading its media inventory.");
  const checked=advanceCurrentFilmCheckpoint(job,job.currentFilmCheckpoint,job.checkpointShots,job.checkpointFrame),files=checked.rows.flatMap(row=>Object.values(row.record.files));
  if(job.output){validateCurrentFilmOutput(job,job.output);if(!job.output.captionsPath.endsWith(".vtt"))fail("Retain the actual current-film caption formats.");const clock=job.output.currentFilm!.assembly;
    files.push({path:job.output.mp4Path,...clock.video},{path:job.output.captionsPath,...clock.captions.vtt},{path:job.output.captionsPath.slice(0,-4)+".srt",...clock.captions.srt});
  }
  if(new Set(files.map(file=>file.path)).size!==files.length)fail("Current-film media roles must have distinct owned paths.");return files;
}
export function createCurrentFilmPreviewReview(preview:Job):CurrentFilmPreviewReview {
  portable(preview);if(preview.stage!=="animatic"||preview.status!=="done"||!preview.output)fail("Review a completed current-film preview.");
  // Reuse only full-body historical validation. Fresh approval, expiry, target
  // and permission checks remain in the caller's live relationship gate.
  const plan=validateCompletedCurrentFilmSource(preview);
  return seal({schema:"hv-current-film-preview-review/2" as const,jobId:preview.id,headRevision:plan.baseline.headRevision,targetRevision:plan.target.revision,documentRevision:plan.materialization.documentRevision,planRevision:plan.revision,materializationRevision:plan.materialization.revision,outputRevision:hash(preview.output)});
}
const validatedCompletedSources=new Set<string>();
/** Pure immutable-source verification. Every access still checks the full caller
 * bytes/descriptors. Current project grants and carrier availability are separate. */
export function validateCompletedCurrentFilmSource(job:Job):CurrentFilmJobV2 {
  portable(job);assertCurrentFilmMode(job);const key=hash(job);
  if(validatedCompletedSources.has(key)){validatedCompletedSources.delete(key);validatedCompletedSources.add(key);return structuredClone(job.currentFilm!);}
  const plan=validateCurrentFilmJob(job);
  if(job.status!=="done"||!job.output||time(job.completedAt)<time(job.startedAt)||time(job.linkExpiresAt)<=time(job.completedAt))fail("Retain a completed original current-film source and its historical lifetime.");
  validateCurrentFilmOutput(job,job.output);validatedCompletedSources.add(key);if(validatedCompletedSources.size>64)validatedCompletedSources.delete(validatedCompletedSources.values().next().value!);return plan;
}
export function validateCurrentFilmPreviewReview(preview:Job,review:CurrentFilmPreviewReview):CurrentFilmPreviewReview {
  portable({preview,review});const expected=createCurrentFilmPreviewReview(preview);if(!same(expected,review))fail("The current-film preview changed after its review was opened.");return expected;
}
export function assertCurrentFilmPreviewApproval(final:Job|JobInput,preview:Job|undefined,approval:AnimaticApproval|null|undefined,now=Date.now()):void {
  portable({final,preview,approval,now});if(!final.currentFilm){if(preview?.currentFilm||approval?.currentFilmReview)fail("An ordinary final cannot consume a current-film preview.");return;}
  const plan=validateCurrentFilmJob(final);if(final.stage!=="final"||!preview||!approval)fail("Select the saved current-film preview approval.");
  const review=createCurrentFilmPreviewReview(preview),candidate=preview.currentFilm!;
  if(preview.id!==final.animaticJobId||preview.projectId!==final.projectId||preview.id===final.id||!same(candidate.selector,plan.selector)||!same(candidate.target,plan.target)
    ||candidate.baseline.headRevision!==plan.baseline.headRevision||!same(preview.casting,final.casting)||preview.scriptText!==final.scriptText||preview.scriptVersion!==final.scriptVersion)fail("The approved current-film preview differs from the final target.");
  if(!same(approval.currentFilmReview,review)||approval.livingScriptReview!==undefined||approval.takeRevision!==undefined||approval.animaticJobId!==preview.id||approval.scriptVersion!==final.scriptVersion||approval.decision!=="approved")fail("Retain the exact current-film preview decision.");
  const at=time(approval.at),completed=time(preview.completedAt),expires=time(preview.linkExpiresAt);
  if(!Number.isSafeInteger(now)||at!==time(final.animaticApprovedAt)||at<completed||at>=expires||at>now||expires<=now||"startedAt" in final&&final.startedAt!==null&&at>time(final.startedAt))fail("The current-film preview decision is late, expired or differs from admission.");
  const cast=plan.target.state.casting.candidate!,direction=plan.library.origin!.request.baseline.direction;
  if(approval.castingVersion!==cast.version||approval.castingRevision!==cast.revision||approval.directionVersion!==direction.version||approval.directionRevision!==direction.revision)fail("The current-film approval lost its exact cast or original direction baseline.");
}
