import type {Project,PersistedProject} from "../../api/src/index";
import type {Job} from "../../queue/src/index";
import {validateCurrentFilmMixedJobPlan,type CurrentFilmJobV3} from "./current-film-mixed-jobs";
import {assertCurrentFilmGenerationCurrent} from "./current-film-authority";
import {assertCurrentFilmSourcePermission} from "./current-film-source-permission";
import {assertEditBindingAvailable} from "./edit-jobs";
import {editValidationKey} from "./edit-validation-key";

/** Call with a freshly authorized project and authoritative carrier snapshots
 * under the service's held admission/dispatch/publication fence. A caller-supplied
 * snapshot cannot establish that fence, and this check never reads media bytes. */
export function assertCurrentFilmMixedCurrent(plan:CurrentFilmJobV3,project:Project|PersistedProject|null|undefined,carriers:Job[],now=Date.now()):void {
  const checked=validateCurrentFilmMixedJobPlan(plan);
  // Target authority descriptor-checks its complete projection before source
  // permission reads the same trusted project, including its actual VersionStore.
  assertCurrentFilmGenerationCurrent(checked,project,now);
  if(!editValidationKey(carriers,256*1024**2)||!Array.isArray(carriers)||carriers.length>checked.origins.length)throw new Error("Retain bounded portable current mixed-film carrier snapshots.");
  const held=structuredClone(carriers),owners=new Set(checked.origins.map(origin=>origin.binding.owner.jobId));
  if(new Set(held.map(job=>job.id)).size!==held.length||held.some(job=>job.projectId!==checked.projectId||!owners.has(job.id)))throw new Error("Resolve each mixed-film carrier once from its exact owning project.");
  for(const origin of checked.origins){
    assertEditBindingAvailable(origin.binding,held.find(job=>job.id===origin.binding.owner.jobId),now);
    assertCurrentFilmSourcePermission(origin.binding.source.job,project,now);
  }
}
