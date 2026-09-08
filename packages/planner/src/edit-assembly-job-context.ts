import type {Job,JobInput} from "../../queue/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {editFail} from "./edit-timeline";
import {validateEditAssemblyRenderPlan} from "./edit-assembly-jobs";
import type {EditAssemblyRenderPlan} from "./edit-assembly-jobs";

export function editAssemblyCaptionLanguage(plan:EditAssemblyRenderPlan):string {
  const ids=new Set(plan.assembly.plan.parent.timeline.clips.filter(clip=>clip.lane==="captions").map(clip=>clip.sourceId)),languages=[...new Set(plan.bindings.filter(binding=>ids.has(binding.source.facts.id)).map(binding=>binding.source.language))];return languages.length===1?languages[0]!:"mul";
}

export function assertEditAssemblyIdempotency(existing:Job|undefined,input:JobInput):void {
  if(existing&&(existing.assemblyEdit||input.assemblyEdit||existing.stage==="assembly-edit"||input.stage==="assembly-edit")&&(existing.stage!==input.stage||existing.assemblyEdit?.revision!==input.assemblyEdit?.revision))editFail("This key belongs to a different assembly render. Use a new key for another export.");
}

/** Assembly jobs never enter provider generation or borrow another stage's checkpoint. */
export function validateEditAssemblyJob(job:Job|JobInput,now?:number):void {
  if((job.stage==="assembly-edit")!==Boolean(job.assemblyEdit))editFail("An assembly render requires its own accepted range plan.");
  if(!job.assemblyEdit){if(job.assemblyCheckpoint||job.output?.assembly)editFail("A different job cannot carry assembly media.");return;}
  const plan=job.assemblyEdit,assembly=validateEditAssemblyRenderPlan(plan,now),origin=plan.bindings[0]!.source.job;
  if(job.projectId!==origin.projectId||plan.bindings.some(binding=>binding.owner.projectId!==job.projectId||binding.owner.jobId===job.id||binding.source.job.id===job.id)||job.scriptText!==origin.scriptText||job.scriptVersion!==origin.scriptVersion||job.totalFrames!==assembly.frames||!job.rightsAttestedAt||!Number.isFinite(Date.parse(job.rightsAttestedAt))||job.costCapUsd!==0||job.budgetReservedUsd!==0||job.providerPlan||job.providerSpec||job.casting||job.direction||job.shotReuse||job.shotTakes||job.characterSheet||job.dialogueReplacement||job.dialogueCheckpoint||job.audioTake||job.audioCheckpoint||job.audioOutput||job.lipSync||job.lipSyncPrepared||job.lipSyncCheckpoint||job.lipSyncReviews||job.soundMix||job.soundCheckpoint||job.pictureEdit||job.editCheckpoint||job.graphicRender||job.graphicCheckpoint||job.graphicOutput||job.graphicProgress||job.animaticJobId||job.animaticApprovedAt||job.routeDecisions?.length||job.cost||("costUsd" in job&&job.costUsd!==0))editFail("Invalid isolated assembly job context.");
  if(job.assemblyCheckpoint?.assembly&&contentHash(job.assemblyCheckpoint.assembly.plan)!==contentHash(plan)||job.output?.assembly&&contentHash(job.output.assembly.plan)!==contentHash(plan))editFail("The assembly checkpoint differs from its admitted render plan.");
}
