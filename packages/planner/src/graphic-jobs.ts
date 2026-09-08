import type {Job,JobInput} from "../../queue/src/index";
import type {PersistedProject} from "../../api/src/index";
import type {RenderFile} from "./shot-reuse";
import {contentHash} from "../../generator/src/capabilities";
import {validateGraphicReceipt,graphicRevision,type GraphicRenderReceipt} from "../../generator/src/graphic-receipt";
import {GRAPHIC_RECIPE} from "./motion-graphics";
import {emptyGraphicLibrary,graphicDate,graphicSpecAvailable,validateGraphicSpec,type GraphicSpec} from "./graphic-library";
import {editId,editRecord} from "./edit-timeline";
import {editFail,editNumber} from "./edit-errors";

export interface GraphicJobPlan {schema:"hv-graphic-job/1";spec:GraphicSpec;recipe:typeof GRAPHIC_RECIPE;storage:"local"|"s3";admittedAt:string;requestHash:string;revision:string}
export interface GraphicOutput {schema:"hv-graphic-output/1";planRevision:string;report:GraphicRenderReceipt;masterPath:string;manifestPath:string;files:RenderFile[];revision:string}
export interface GraphicProgress {phase:"capture"|"encode"|"verify"|"retain";capturedFrames:number;at:string}
export function graphicJobPlan(spec:GraphicSpec,storage:GraphicJobPlan["storage"],requestHash:string,now=Date.now()):GraphicJobPlan {
  validateGraphicSpec(spec,spec.projectId);graphicRevision(requestHash);if(!["local","s3"].includes(storage))editFail("Choose the configured graphic storage backend.");
  const data={schema:"hv-graphic-job/1" as const,spec:structuredClone(spec),recipe:GRAPHIC_RECIPE,storage,requestHash,admittedAt:new Date(now).toISOString()};return {...data,revision:contentHash(data)};
}
export function validateGraphicPlan(plan:GraphicJobPlan):void {
  editRecord(plan,["schema","spec","recipe","storage","admittedAt","requestHash","revision"]);graphicDate(plan.admittedAt);
  if(contentHash(plan)!==contentHash(graphicJobPlan(plan.spec,plan.storage,plan.requestHash,Date.parse(plan.admittedAt))))editFail("The admitted graphic plan changed.");
}
export function assertGraphicPermission(plan:GraphicJobPlan,project:Pick<PersistedProject,"id"|"rightsAttestedAt"|"deleteAfter"|"graphicLibrary">|null|undefined,now=Date.now()):void {
  validateGraphicPlan(plan);
  if(!project||project.id!==plan.spec.projectId||!project.rightsAttestedAt||Date.parse(project.rightsAttestedAt)>now||Date.parse(project.deleteAfter)<=now||!graphicSpecAvailable(project.graphicLibrary??emptyGraphicLibrary(),project.id,plan.spec))editFail("This graphic or its project permission is no longer available.");
}
export function validateGraphicJob(job:JobInput|Job):void {
  if((job.stage==="motion-graphic")!==Boolean(job.graphicRender))editFail("Graphics require their own admitted rendering plan.");
  if(!job.graphicRender){if(job.graphicOutput||job.graphicCheckpoint||job.graphicProgress)editFail("Only graphic jobs can carry graphic media or progress.");return;}
  const plan=job.graphicRender;validateGraphicPlan(plan);editId(job.id);editId(job.projectId);
  if(plan.spec.projectId!==job.projectId||!job.rightsAttestedAt||graphicDate(job.rightsAttestedAt)>Date.parse(plan.admittedAt)||job.scriptText!==""||job.scriptVersion!==0||job.animaticJobId!==null||job.animaticApprovedAt!==null||job.totalFrames!==plan.spec.plan.frames||job.costCapUsd!==0||job.budgetReservedUsd!==0||job.retryPolicy.maxRetries!==2||job.retryPolicy.backoffMs!==1000
    ||job.casting||job.direction||job.shotReuse||job.shotTakes||job.characterSheet||job.dialogueReplacement||job.dialogueCheckpoint||job.audioTake||job.audioCheckpoint||job.audioOutput||job.lipSync||job.lipSyncPrepared||job.lipSyncCheckpoint||job.lipSyncReviews||job.soundMix||job.soundCheckpoint||job.pictureEdit||job.editCheckpoint||job.providerSpec||job.providerPlan||job.routeDecisions?.length||job.output||job.cost||("costUsd" in job&&job.costUsd!==0))editFail("A graphic must retain isolated media with zero provider cost.");
  if(job.graphicProgress)validateGraphicProgress(job.graphicProgress,job.totalFrames);
}
export function validateGraphicProgress(progress:GraphicProgress,frames:number):void {
  editRecord(progress,["phase","capturedFrames","at"]);graphicDate(progress.at);editNumber(progress.capturedFrames,0,frames,"Captured graphic frames");
  if(!["capture","encode","verify","retain"].includes(progress.phase)||progress.phase!=="capture"&&progress.capturedFrames!==frames)editFail("Graphic progress lost its captured frame count.");
}
export function assertGraphicIdempotency(existing:Job|undefined,input:JobInput):void {
  if(existing&&(existing.graphicRender||input.graphicRender||existing.stage==="motion-graphic"||input.stage==="motion-graphic")&&(existing.stage!==input.stage||existing.graphicRender?.requestHash!==input.graphicRender?.requestHash||existing.graphicRender?.spec.revision!==input.graphicRender?.spec.revision||existing.graphicRender?.storage!==input.graphicRender?.storage))editFail("This request key belongs to another graphic render.");
}
export function graphicInventory(report:GraphicRenderReceipt):{file:string;sha256?:string;bytes?:number}[]{
  // JSONB may reorder fields. The original manifest bytes are bound by output.files;
  // verifyGraphicMedia separately parses those exact bytes and compares the report.
  return [report.composition,...report.fonts,report.license,report.frameIndex,...report.frames,report.master,{file:"graphic.json"}];
}
export function validateGraphicOutput(job:JobInput|Job,output:GraphicOutput):void {
  validateGraphicJob(job);if(!job.graphicRender)editFail("Choose an admitted graphic job.");editRecord(output,["schema","planRevision","report","masterPath","manifestPath","files","revision"]);
  const {revision,...data}=output;if(output.schema!=="hv-graphic-output/1"||revision!==contentHash(data)||output.planRevision!==job.graphicRender.revision)editFail("The graphic output lost its admitted plan.");validateGraphicReceipt(output.report,job.graphicRender.spec.plan);
  const prefix=`${job.projectId}/${job.id}/`,root=output.manifestPath.slice(0,-"graphic.json".length);
  if(!output.manifestPath.startsWith(prefix)||!/^graphic-[A-Za-z0-9_-]+\/graphic\.json$/.test(output.manifestPath.slice(prefix.length))||output.masterPath!==root+output.report.master.file)editFail("The graphic paths escaped their owner.");
  const inventory=new Map(graphicInventory(output.report).map(f=>[root+f.file,f]));if(!Array.isArray(output.files)||output.files.length!==inventory.size||new Set(output.files.map(f=>f.path)).size!==inventory.size)editFail("The graphic file inventory is incomplete or duplicated.");let bytes=0;
  for(const entry of output.files){editRecord(entry,["path","sha256","bytes"]);const expected=inventory.get(entry.path);graphicRevision(entry.sha256);editNumber(entry.bytes,1,entry.path===output.manifestPath?16*1024**2:4*1024**3,"Graphic file bytes");if(!expected||expected.sha256!==undefined&&entry.sha256!==expected.sha256||expected.bytes!==undefined&&entry.bytes!==expected.bytes)editFail("A graphic file changed from its retained receipt.");bytes+=entry.bytes;}
  if(bytes>8*1024**3)editFail("The graphic exceeds its retained storage limit.");
}
