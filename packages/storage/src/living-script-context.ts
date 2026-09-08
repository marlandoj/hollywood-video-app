import type {SQL} from "bun";
import type {Job,JobInput} from "../../queue/src/index";
import type {PersistedProject} from "../../api/src/index";
import {assertLivingScriptGenerationCurrent} from "../../planner/src/living-script-jobs";
import {validateLivingScriptJob,assertLivingScriptPreviewApproval} from "../../planner/src/living-script-job-context";

/** Caller holds the project and, during processing, its admitted job/lease fence.
 * Keep carrier and artifact locks until the surrounding admission/dispatch/publication commits. */
export async function assertLivingScriptTransaction(tx:SQL,job:Job|JobInput,project:PersistedProject|undefined,now=Date.now()):Promise<void> {
  validateLivingScriptJob(job);if(!job.livingScript)return;
  const binding=job.livingScript.binding;
  const carrier=(await tx`select body from hv_jobs where id=${binding.owner.jobId} and project_id=${job.projectId} for share`)[0]?.body as Job|undefined;
  assertLivingScriptGenerationCurrent(job.livingScript,project,carrier,now);
  const files=await tx`select key,sha256,bytes from hv_artifacts where project_id=${job.projectId} and job_id=${binding.owner.jobId} for share`;
  for(const file of binding.files)if(!files.some((value:{key:string;sha256:string;bytes:number})=>value.key===file.path&&value.sha256===file.sha256&&Number(value.bytes)===file.bytes))throw new Error("A pending screenplay source artifact changed or disappeared.");
  if(job.stage==="final"){
    const preview=job.animaticJobId?(await tx`select body from hv_jobs where project_id=${job.projectId} and id=${job.animaticJobId} for share`)[0]?.body as Job|undefined:undefined;
    assertLivingScriptPreviewApproval(job,preview,project?.animaticApprovals.find(value=>value.animaticJobId===job.animaticJobId),now);
  }
}
