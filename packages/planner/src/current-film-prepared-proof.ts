import type {Job} from "../../queue/src/index";
import {contentHash as hash} from "../../generator/src/capabilities";
import {editValidationKey} from "./edit-validation-key";
import {compileCurrentFilmProofTarget,assertCurrentFilmProofTargetApproval} from "./current-film-proof-target";
import {resolveCurrentFilmProofCopies,type CurrentFilmProofCopies} from "./current-film-proof-copies";
import type {CurrentFilmMixedJob} from "./current-film-mixed-job-context";
import type {RenderFile} from "./shot-reuse";
import type {CurrentFilmProofContext} from "./current-film-proof-closure";
import {validateProjectCurrentScreenplay} from "./current-screenplay-library";
import {validateProjectLivingScriptProposals} from "./living-script-proposals";
import {compileCurrentFilmOrigins} from "./current-film-origins";
import {compileCurrentFilmAdoption} from "./current-film-adoption";
import {EDIT_STORAGE_LIMITS} from "./edit-resources";

export interface CurrentFilmPreparedProof {
  schema:"hv-current-film-prepared-proof/1";projectId:string;jobId:string;jobPlanRevision:string;
  targetRevision:string;startedAt:string;preparedAt:string;specification:CurrentFilmProofCopies;revision:string;
}
function fail(message:string):never {throw new Error(message);}
function portable<T>(value:T):T {
  if(!editValidationKey(value,256*1024**2))fail("Retain bounded portable prepared-proof evidence without accessors or cycles.");return structuredClone(value);
}
function time(value:unknown):number {
  if(typeof value!=="string"||!Number.isSafeInteger(Date.parse(value))||Date.parse(value)<0||new Date(value).toISOString()!==value)fail("Retain canonical prepared-proof execution times.");return Date.parse(value);
}
/** Discard only this job's marker before validating its actual immutable inputs.
 * Historical nested source jobs keep their evidence. This avoids self-recursion
 * while never treating a supplied marker as its own authority. */
function withoutProof(raw:CurrentFilmMixedJob):CurrentFilmMixedJob {
  const value=portable(raw) as CurrentFilmMixedJob&{currentFilmProof?:unknown};delete value.currentFilmProof;return value;
}
/** Constructs historical metadata only. The held artifact transaction must
 * verify complete actual bytes, current authority and the saved artifact index
 * before storing this marker. A browser cannot submit it through admission. */
export function createCurrentFilmPreparedProof(raw:CurrentFilmMixedJob,rawSpecification:CurrentFilmProofCopies,at=Date.now()):CurrentFilmPreparedProof {
  const job=withoutProof(raw),{proof:specification,closure}=resolveCurrentFilmProofCopies(rawSpecification,job.currentFilm,job.id),target=compileCurrentFilmProofTarget(job);
  if(!specification.target||hash(specification.target)!==hash(target))fail("Prepared proof requires this actual target's complete preview dependency.");
  assertCurrentFilmProofRetainedCapacity(job,specification);
  const started=time(job.startedAt);
  if(!Number.isSafeInteger(at)||at<started||at>8640000000000000)fail("Prepared proof cannot precede original execution.");
  if(target.stage==="final"){
    const binding=closure.targetApproval;if(!binding)fail("Retain the exact prepared target preview approval.");
    const preview=specification.frozenContext.jobs.find(value=>value.id===binding.previewJobId);
    // Both execution and preparation occurred while this exact review was valid.
    assertCurrentFilmProofTargetApproval(target,job.currentFilm,preview,binding.approval,started);
    assertCurrentFilmProofTargetApproval(target,job.currentFilm,preview,binding.approval,at);
  }
  const body={schema:"hv-current-film-prepared-proof/1" as const,projectId:job.projectId,jobId:job.id,jobPlanRevision:job.currentFilm.revision,
    targetRevision:target.revision,startedAt:job.startedAt!,preparedAt:new Date(at).toISOString(),specification};
  const checked=portable(body);return portable({...checked,revision:hash(checked)});
}
const checkedProofs=new Set<string>();
export function validateCurrentFilmPreparedProof(value:CurrentFilmPreparedProof,job:CurrentFilmMixedJob):CurrentFilmPreparedProof {
  const key=editValidationKey({value,job},256*1024**2);if(!key)fail("Retain bounded portable prepared-proof job evidence.");
  if(checkedProofs.has(key))return structuredClone(value);
  const input=portable(value);
  if(!input||Object.keys(input).sort().join(",")!==["schema","projectId","jobId","jobPlanRevision","targetRevision","startedAt","preparedAt","specification","revision"].sort().join(","))fail("Retain exact prepared-proof marker fields.");
  const expected=createCurrentFilmPreparedProof(job,input.specification,time(input.preparedAt));
  if(hash(input)!==hash(expected))fail("Prepared proof changed its exact target, execution, requirements or owned inventory.");
  checkedProofs.add(key);if(checkedProofs.size>16)checkedProofs.delete(checkedProofs.values().next().value!);return expected;
}
export function advanceCurrentFilmPreparedProof(job:CurrentFilmMixedJob,value:CurrentFilmPreparedProof):CurrentFilmPreparedProof {
  const next=validateCurrentFilmPreparedProof(value,job),previous=(job as Job&{currentFilmProof?:CurrentFilmPreparedProof}).currentFilmProof;
  if(previous&&hash(validateCurrentFilmPreparedProof(previous,job))!==hash(next))fail("The held prepared-proof checkpoint is immutable.");
  if(job.output&&!previous)fail("Do not attach new proof to an already completed output.");return next;
}
export function currentFilmPreparedProofFiles(value:CurrentFilmPreparedProof,job:CurrentFilmMixedJob):RenderFile[] {
  const proof=validateCurrentFilmPreparedProof(value,job).specification;
  return [...proof.carriers.flatMap(group=>group.copies),...proof.previews.flatMap(group=>group.copies),...proof.references.map(group=>group.copy)].map(copy=>copy.owned);
}

/** All known retained proof, direct originals and selected reuse are counted
 * together before copying. Future generated/encoded bytes still have runtime
 * limits; this is not a codec-size prediction or complete archive estimate. */
export function assertCurrentFilmProofRetainedCapacity(job:CurrentFilmMixedJob,specification:CurrentFilmProofCopies):void {
  const plan=job.currentFilm,origins=compileCurrentFilmOrigins(plan,job.id),adoptions=plan.selection.filter(slot=>slot.kind==="reuse").map(slot=>compileCurrentFilmAdoption(plan,job.id,slot.ordinal));
  const files=[...specification.carriers.flatMap(group=>group.copies),...specification.previews.flatMap(group=>group.copies),...specification.references.map(group=>group.copy),
    ...origins.origins.flatMap(group=>group.copies),...adoptions.flatMap(group=>group.copies)].map(copy=>copy.owned);
  if(files.length>100000||new Set(files.map(file=>file.path)).size!==files.length||files.reduce((sum,file)=>sum+file.bytes,0)>EDIT_STORAGE_LIMITS.workspaceBytes)
    fail("Complete proof, originals and selected reuse exceed the shared retained-media capacity.");
}

/** Check frozen historical requirements against fresh saved project history.
 * Unrelated append-only work is allowed; removal/rewrite of required history is
 * not. Current grants and latest target approval remain the caller's live gate. */
export function assertCurrentFilmProofProjectPrefix(specification:CurrentFilmProofCopies,rawProject:CurrentFilmProofContext["project"]):void {
  const {specification:proof,project}=portable({specification,project:rawProject}),saved=proof.frozenContext.project;
  if(project.id!==proof.projectId)fail("The proof project changed owner.");
  const previous=validateProjectCurrentScreenplay(saved.currentScreenplay,{projectId:project.id,versions:saved.versions}),
    current=validateProjectCurrentScreenplay(project.currentScreenplay,{projectId:project.id,versions:project.versions});
  if(current.version<previous.version||hash(current.origin)!==hash(previous.origin)||hash(current.proposals.slice(0,previous.proposals.length))!==hash(previous.proposals)
    ||hash(current.acceptances.slice(0,previous.acceptances.length))!==hash(previous.acceptances)||hash(project.versions.slice(0,saved.versions.length))!==hash(saved.versions))
    fail("The current project rewrote the frozen proof history.");
  const prior=saved.livingScriptProposals,currentPending=project.livingScriptProposals;
  if(currentPending)validateProjectLivingScriptProposals(currentPending,project.id,project.versions);
  if(prior&&(!currentPending||hash(currentPending.proposals.slice(0,prior.proposals.length))!==hash(prior.proposals)))fail("The current project lost the frozen pending proof history.");
  for(const approval of saved.animaticApprovals)if(!project.animaticApprovals.some(value=>hash(value)===hash(approval)))fail("The current project lost a required historical proof approval.");
  for(const {assetId} of proof.references){const expected=saved.referenceAssets?.find(asset=>asset.id===assetId),actual=project.referenceAssets?.filter(asset=>asset.id===assetId);
    if(!expected||actual?.length!==1||hash(actual[0])!==hash(expected))fail("The current project changed a required proof reference.");}
}
