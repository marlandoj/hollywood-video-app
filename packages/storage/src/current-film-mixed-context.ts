import type {SQL} from "bun";
import type {PersistedProject} from "../../api/src/index";
import type {Job} from "../../queue/src/index";
import {assertCurrentFilmGenerationCurrent} from "../../planner/src/current-film-authority";
import {assertCurrentFilmSourcePermission} from "../../planner/src/current-film-source-permission";
import {assertEditBindingAvailable} from "../../planner/src/edit-jobs";
import {editValidationKey} from "../../planner/src/edit-validation-key";
import {contentHash as hash} from "../../generator/src/capabilities";
import {assertCurrentFilmMixedAdmission,assertCurrentFilmMixedHeldInputs,assertCurrentFilmMixedPreviewRelationship,validateCurrentFilmMixedJob,type CurrentFilmMixedJob,type CurrentFilmMixedJobInput} from "../../planner/src/current-film-mixed-job-context";
import {currentFilmV3HeldJob} from "../../planner/src/current-film-runtime-context";
import type {CurrentFilmJobV3} from "../../planner/src/current-film-mixed-jobs";

const INDEX_LIMIT=100000; // The existing complete-job import inventory ceiling.
function runtime(job:CurrentFilmMixedJob|CurrentFilmMixedJobInput):job is CurrentFilmMixedJob {return Object.hasOwn(job,"status");}
function bytes(value:unknown):number {
  const amount=typeof value==="string"&&/^(0|[1-9][0-9]{0,11})$/.test(value)?Number(value):value;
  // The complete index can also contain a measured final MP4. Original copy
  // roles keep their separate <=8 GiB limit and exact expected bytes below.
  if(typeof amount!=="number"||!Number.isSafeInteger(amount)||amount<0||amount>128*1024**3)throw new Error("Retain exact bounded indexed current-film byte counts.");
  return amount;
}
/** Bun results may contain command/count metadata. Read only dense own row
 * descriptors, without invoking indexed accessors before portable validation. */
function indexRows(value:unknown):Record<string,unknown>[] {
  const fail=():never=>{throw new Error("Retain the bounded complete mixed current-film artifact index.");};
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)fail();
  const count=Object.getOwnPropertyDescriptor(value,"length")?.value;
  if(!Number.isSafeInteger(count)||count<0||count>INDEX_LIMIT)fail();
  const rows:unknown[]=[];
  for(let index=0;index<count;index++){
    const field=Object.getOwnPropertyDescriptor(value,String(index));
    if(!field||!field.enumerable||!Object.hasOwn(field,"value"))fail();
    rows.push(field!.value);
  }
  if(!editValidationKey(rows,64*1024**2))fail();
  const checked=structuredClone(rows);
  if(checked.some(row=>!row||typeof row!=="object"||Array.isArray(row)))fail();
  return checked as Record<string,unknown>[];
}

/** Caller already holds the current project and, for execution, the target job/lease.
 * Lock order here is target FOR SHARE, its artifact rows by key when prepared, then
 * distinct carrier/preview jobs by ID. Keep all locks through the caller's commit.
 * Preparation comes only from that saved target plus its complete exact artifact
 * index. This proves indexed custody, not S3/local byte existence or media validity;
 * the held artifact adapter must separately verify actual media before use/publication.
 * Complete bootstrap/proof custody remains the separate project closure gate. */
export async function assertCurrentFilmMixedTransaction(tx:SQL,raw:CurrentFilmMixedJob|CurrentFilmMixedJobInput,project:PersistedProject|undefined,now=Date.now()):Promise<void> {
  const plan=validateCurrentFilmMixedJob(raw,now),job=structuredClone(raw);
  assertCurrentFilmGenerationCurrent(plan,project,now);
  const rows=await tx`select body from hv_jobs where project_id=${job.projectId} and id=${job.id} for share`;
  const saved=rows[0]?.body as CurrentFilmMixedJob|undefined;
  if(saved){
    validateCurrentFilmMixedJob(saved);
    if(saved.id!==job.id||saved.projectId!==job.projectId)throw new Error("The held mixed current-film owner changed.");
    if(runtime(job))assertCurrentFilmMixedHeldInputs(saved,job);
    else assertCurrentFilmMixedAdmission(job,saved,now);
  }else {
    if(runtime(job))throw new Error("The admitted mixed current-film job is unavailable.");
    assertCurrentFilmMixedAdmission(job,undefined,now);
  }
  await checkedCurrentFilmCustody(tx,job,plan,saved?structuredClone(saved):undefined,project,now);
}

/** Internal held-row path. The artifact adapter must have read this actual saved
 * row FOR UPDATE and its project FOR SHARE in this same transaction, and checked
 * running state, worker, database lease version and current lease expiry. No
 * caller-supplied progress or 'already validated' flag establishes saved custody.
 * Its stronger existing target lock replaces the general path's duplicate read;
 * every current project/source/preview/index check below still executes afresh. */
export async function assertCurrentFilmMixedLockedTransaction(tx:SQL,saved:Job,claimed:Job,project:PersistedProject|undefined,now=Date.now()):Promise<CurrentFilmMixedJob> {
  const current=structuredClone(currentFilmV3HeldJob(saved,claimed)),plan=current.currentFilm;
  assertCurrentFilmGenerationCurrent(plan,project,now);
  await checkedCurrentFilmCustody(tx,current,plan,current,project,now);
  return current;
}

/** Inputs are detached complete validated envelopes from one of the entry points
 * above. Their origins/proof have already passed the full canonical validators. */
async function checkedCurrentFilmCustody(tx:SQL,job:CurrentFilmMixedJob|CurrentFilmMixedJobInput,plan:CurrentFilmJobV3,saved:CurrentFilmMixedJob|undefined,project:PersistedProject|undefined,now:number):Promise<void> {
  // A new claimed marker does not select this branch; only the locked stored row can.
  const proof=saved?.currentFilmProof;
  if(saved&&(saved.currentFilmOrigins!==undefined||proof)){
    const origins=saved.currentFilmOrigins;
    const result=await tx`select key,sha256,bytes from hv_artifacts where project_id=${saved.projectId} and job_id=${saved.id} order by key limit 100001 for share`;
    const indexed=indexRows(result);
    const files=new Map<string,{sha256:string;bytes:number}>();
    for(const row of indexed){
      if(typeof row.key!=="string"||row.key.length>1024||!row.key.startsWith(`${saved.projectId}/${saved.id}/`)||files.has(row.key)
        ||typeof row.sha256!=="string"||!/^[a-f0-9]{64}$/.test(row.sha256))throw new Error("Retain distinct owned mixed current-film artifact identities.");
      files.set(row.key,{sha256:row.sha256,bytes:bytes(row.bytes)});
    }
    const required=new Set<string>();
    const specification=proof?.specification,proofFiles=specification?[...specification.carriers.flatMap(group=>group.copies),...specification.previews.flatMap(group=>group.copies),...specification.references.map(group=>group.copy)].map(copy=>copy.owned):[];
    for(const file of [...(origins?.origins.flatMap(origin=>origin.copies.map(copy=>copy.owned))??[]),...proofFiles]){
      required.add(file.path);const actual=files.get(file.path);
      if(!actual||actual.sha256!==file.sha256||actual.bytes!==file.bytes)throw new Error("The held mixed current-film originals or proof are missing or differ from their complete artifact index.");
    }
    for(const path of files.keys())if((path.startsWith(`${saved.projectId}/${saved.id}/originals/`)||path.startsWith(`${saved.projectId}/${saved.id}/proof/`))&&!required.has(path))throw new Error("The indexed mixed current-film originals or proof contain an unreviewed file.");
  }

  // Target authority above descriptor-checks the fresh permission projection first.
  for(const origin of plan.origins)assertCurrentFilmSourcePermission(origin.binding.source.job,project,now);
  const needsCarriers=saved?.currentFilmOrigins===undefined&&!proof;
  const carrierIds=needsCarriers?[...new Set(plan.origins.map(origin=>origin.binding.owner.jobId))]:[];
  const lockIds=[...new Set([...carrierIds,...(job.stage==="final"?[job.animaticJobId!]:[])])].sort();
  const locked=new Map<string,Job|CurrentFilmMixedJob>();
  for(const id of lockIds){
    const row=(await tx`select body from hv_jobs where project_id=${job.projectId} and id=${id} for share`)[0];
    if(row)locked.set(id,row.body as Job|CurrentFilmMixedJob);
  }
  if(needsCarriers)for(const origin of plan.origins){
    const carrier=locked.get(origin.binding.owner.jobId);
    // V3 is not an editorial source format in this increment. Original binding
    // validation rejects unsupported carriers; no V3-to-V2 relabelling is allowed.
    if(carrier?.currentFilm?.schema==="hv-current-film-job/3")throw new Error("Use a supported original current-film carrier.");
    assertEditBindingAvailable(origin.binding,carrier as Job|undefined,now);
  }
  if(job.stage==="final"){
    const approval=project?.animaticApprovals.filter(value=>value.animaticJobId===job.animaticJobId).at(-1);
    const current=locked.get(job.animaticJobId!),retained=proof?.specification.frozenContext.jobs.find(value=>value.id===job.animaticJobId);
    if(proof&&(!retained||current&&(!editValidationKey(current,256*1024**2)||hash(JSON.parse(JSON.stringify(current)))!==hash(retained))))throw new Error("The current preview differs from its exact retained proof identity.");
    assertCurrentFilmMixedPreviewRelationship({projectId:job.projectId,jobId:job.id,stage:plan.render.stage,animaticJobId:job.animaticJobId,animaticApprovedAt:job.animaticApprovedAt},plan,current??retained,approval,now);
    // The relationship checks approval/preview identity and current lifetime;
    // the complete-job wrapper additionally forbids approval after execution.
    if(runtime(job)&&job.startedAt!==null&&Date.parse(approval!.at)>Date.parse(job.startedAt))throw new Error("The mixed current-film preview decision is late, expired or differs from admission.");
  }
}
