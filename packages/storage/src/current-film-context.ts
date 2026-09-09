import type {SQL} from "bun";
import type {Job,JobInput} from "../../queue/src/index";
import type {PersistedProject} from "../../api/src/index";
import {assertCurrentFilmGenerationCurrent} from "../../planner/src/current-film-authority";
import {validateCurrentFilmJob,assertCurrentFilmPreviewApproval} from "../../planner/src/current-film-job-context";
import {currentFilmRuntimeMode,currentFilmV3Job,currentFilmV3Input} from "../../planner/src/current-film-runtime-context";
import {assertCurrentFilmMixedTransaction} from "./current-film-mixed-context";

/** Caller holds the current project and the admitted job/lease fence. Keep the preview row
 * locked until admission, dispatch or publication commits. The first V2 plan is all-fresh:
 * historical origin files are not dispatch inputs, and no carrier lookup grants authority. */
export async function assertCurrentFilmTransaction(tx:SQL,job:Job|JobInput,project:PersistedProject|undefined,now=Date.now()):Promise<void> {
  if(currentFilmRuntimeMode(job)==="v3")return assertCurrentFilmMixedTransaction(tx,"status" in job?currentFilmV3Job(job):currentFilmV3Input(job),project,now);
  const marker=Object.getOwnPropertyDescriptor(job,"currentFilm");
  if(marker&&!Object.hasOwn(marker,"value"))throw new Error("Retain the current-film discriminator without accessors.");
  if(marker?.value===undefined)return;
  const plan=validateCurrentFilmJob(job);
  assertCurrentFilmGenerationCurrent(plan,project,now);
  if(job.stage==="final"){
    const preview=job.animaticJobId?(await tx`select body from hv_jobs where project_id=${job.projectId} and id=${job.animaticJobId} for share`)[0]?.body as Job|undefined:undefined;
    const approval=project?.animaticApprovals.filter(value=>value.animaticJobId===job.animaticJobId).at(-1);
    assertCurrentFilmPreviewApproval(job,preview,approval,now);
  }
}
