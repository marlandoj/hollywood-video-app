import type {SQL} from "bun";
import type {Job} from "../../queue/src/index";
import {contentHash as hash} from "../../generator/src/capabilities";
import {validateCurrentFilmMixedJobPlan,type CurrentFilmJobV3} from "../../planner/src/current-film-mixed-jobs";
import {compileCurrentFilmProofClosure,CURRENT_FILM_PROOF_LIMITS,type CurrentFilmProofContext,type CurrentFilmProofClosure} from "../../planner/src/current-film-proof-closure";
import {freezeCurrentFilmProofContext,validateCurrentFilmProofPreviewFiles,type CurrentFilmProofSelection,type CurrentFilmProofCarrierSelection} from "../../planner/src/current-film-proof-copies";
import {editValidationKey} from "../../planner/src/edit-validation-key";
import {validateCurrentFilmProofTarget,type CurrentFilmProofTarget} from "../../planner/src/current-film-proof-target";
import type {RenderFile} from "../../planner/src/shot-reuse";

export const CURRENT_FILM_PROOF_INDEX_LIMITS={files:100000,bytes:64*1024**2,fileBytes:128*1024**3,resultBytes:256*1024**2} as const;
export type CurrentFilmProofSelectedCarrier=CurrentFilmProofCarrierSelection;
/** Detached historical metadata and locked index evidence, never object custody. */
export interface CurrentFilmProofResolution extends CurrentFilmProofSelection {
  closure:CurrentFilmProofClosure;
  metadataOnly:true;bytesVerified:false;hlsContentsVerified:false;currentAuthority:false;revision:string;
}
function fail(message:string):never {throw new Error(message);}
function portable<T>(value:T,max=CURRENT_FILM_PROOF_LIMITS.inputBytes):T {
  if(!editValidationKey(value,max))fail("Retain bounded portable proof context and index metadata without accessors or cycles.");
  return structuredClone(value);
}
/** Bun adds transport properties to SQL result arrays. Inspect dense row descriptors
 * before detaching; Array.from would execute a hostile indexed accessor first. */
function rows(value:unknown,max:number,maxBytes:number):Record<string,unknown>[] {
  if(!Array.isArray(value)||Object.getPrototypeOf(value)!==Array.prototype)fail("Retain a bounded complete proof query result.");
  const count=Object.getOwnPropertyDescriptor(value,"length")?.value;
  if(!Number.isSafeInteger(count)||count<0||count>max)fail("The complete proof query exceeds its capacity; do not truncate it.");
  const result:unknown[]=[];
  for(let index=0;index<count;index++){
    const field=Object.getOwnPropertyDescriptor(value,String(index));
    if(!field||!field.enumerable||!Object.hasOwn(field,"value"))fail("Retain proof query rows without accessors or holes.");result.push(field.value);
  }
  const checked=portable(result,maxBytes);
  if(checked.some(row=>!row||typeof row!=="object"||Array.isArray(row)))fail("Retain actual proof query row objects.");
  return checked as Record<string,unknown>[];
}
function path(value:unknown,projectId:string,jobId:string):asserts value is string {
  if(typeof value!=="string"||value.length>1024||!value.startsWith(`${projectId}/${jobId}/`)||!/^[A-Za-z0-9._/-]+$/.test(value)
    ||value.split("/").some(part=>!part||part==="."||part===".."))fail("Retain exact owned proof artifact paths.");
}
function bytes(value:unknown):number {
  const number=typeof value==="string"&&/^(0|[1-9][0-9]{0,11})$/.test(value)?Number(value):value;
  if(typeof number!=="number"||!Number.isSafeInteger(number)||Object.is(number,-0)||number<0||number>CURRENT_FILM_PROOF_INDEX_LIMITS.fileBytes)
    fail("Retain exact bounded proof artifact byte counts.");return number;
}
function indexRows(value:unknown,projectId:string,jobId:string):RenderFile[] {
  const checked=rows(value,CURRENT_FILM_PROOF_INDEX_LIMITS.files,CURRENT_FILM_PROOF_INDEX_LIMITS.bytes),seen=new Set<string>();
  return checked.map(row=>{
    if(Object.keys(row).sort().join(",")!=="bytes,key,sha256")fail("Retain the exact proof artifact index projection.");
    path(row.key,projectId,jobId);
    if(seen.has(row.key)||typeof row.sha256!=="string"||!/^[a-f0-9]{64}$/.test(row.sha256))fail("Retain distinct proof artifact keys and exact digests.");
    seen.add(row.key);return {path:row.key,sha256:row.sha256,bytes:bytes(row.bytes)};
  }).sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}
function jobRows(value:unknown,projectId:string,max:number):Job[] {
  return rows(value,max,CURRENT_FILM_PROOF_LIMITS.inputBytes).map(row=>{
    if(Object.keys(row).sort().join(",")!=="body,id"||typeof row.id!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(row.id)
      ||!row.body||typeof row.body!=="object"||Array.isArray(row.body))fail("Retain exact saved proof job rows.");
    const job=row.body as Job;if(job.id!==row.id||job.projectId!==projectId)fail("A saved proof job row changed its exact owner.");return job;
  });
}
function matches(files:RenderFile[],required:RenderFile[]):boolean {
  const indexed=new Map(files.map(file=>[file.path,file]));return required.every(file=>{const found=indexed.get(file.path);return found?.sha256===file.sha256&&found.bytes===file.bytes;});
}
/** The caller holds the authoritative saved project through commit and establishes
 * its own budget/target lock order first. Discovery is bounded and read-only. All
 * chosen carrier/preview jobs are then locked by ID, followed by their complete
 * artifact indexes by job ID/key. Their full discovered bodies/indexes must still
 * match; concurrent changes require a transaction retry, never another candidate.
 * No link lifetime, current rights, lease, reference bytes or S3/local bytes are
 * authorized here. A historical expired original can be used if its exact index
 * survives, or replaced by an intact complete retained carrier. */
export async function resolveCurrentFilmProofContext(tx:SQL,rawPlan:CurrentFilmJobV3,rawProject:CurrentFilmProofContext["project"],rawTarget?:CurrentFilmProofTarget):Promise<CurrentFilmProofResolution> {
  const input=portable({plan:rawPlan,project:rawProject,...(rawTarget!==undefined?{target:rawTarget}:{})}),plan=validateCurrentFilmMixedJobPlan(input.plan),saved=input.project;
  const target=input.target===undefined?undefined:validateCurrentFilmProofTarget(input.target,plan,input.target.jobId);
  if(!saved||saved.id!==plan.projectId)fail("Resolve proof context for the exact saved project.");
  const project:CurrentFilmProofContext["project"]={id:saved.id,versions:saved.versions,animaticApprovals:saved.animaticApprovals,
    ...(saved.currentScreenplay!==undefined?{currentScreenplay:saved.currentScreenplay}:{}),
    ...(saved.livingScriptProposals!==undefined?{livingScriptProposals:saved.livingScriptProposals}:{}),
    ...(saved.referenceAssets!==undefined?{referenceAssets:saved.referenceAssets}:{})};
  const discovered=jobRows(await tx`select id,body from hv_jobs where project_id=${project.id} order by id limit 1025`,project.id,CURRENT_FILM_PROOF_LIMITS.jobs);
  const frozenContext=freezeCurrentFilmProofContext({project,jobs:discovered}),closure=compileCurrentFilmProofClosure(plan,frozenContext,target),jobs=new Map(frozenContext.jobs.map(job=>[job.id,job]));
  const candidateIds=[...new Set([...closure.receipts.flatMap(receipt=>receipt.candidates.map(candidate=>candidate.jobId)),...closure.previews.map(preview=>preview.job.id)])].sort();
  const indexes=new Map<string,RenderFile[]>();let totalFiles=0,totalBytes=0;
  for(const id of candidateIds){
    const files=indexRows(await tx`select key,sha256,bytes from hv_artifacts where project_id=${project.id} and job_id=${id} order by key limit 100001`,project.id,id);
    totalFiles+=files.length;totalBytes+=Buffer.byteLength(JSON.stringify(files));
    if(totalFiles>CURRENT_FILM_PROOF_INDEX_LIMITS.files||totalBytes>CURRENT_FILM_PROOF_INDEX_LIMITS.bytes)fail("The complete proof artifact inventories exceed their aggregate capacity.");indexes.set(id,files);
  }
  const carriers:CurrentFilmProofSelectedCarrier[]=closure.receipts.map(({receipt,candidates})=>{
    const selected=candidates.find(candidate=>matches(indexes.get(candidate.jobId)!,candidate.files));
    if(!selected)fail("A required proof receipt has no complete exact indexed carrier.");
    const {kind,jobId,jobRevision,evidenceRevision}=selected;return {receiptRevision:receipt.revision,kind,jobId,jobRevision,evidenceRevision};
  });
  const previews=closure.previews.map(({job})=>({jobId:job.id,files:validateCurrentFilmProofPreviewFiles(job,indexes.get(job.id)!)}));
  const selectedIds=[...new Set([...carriers.map(carrier=>carrier.jobId),...previews.map(preview=>preview.jobId)])].sort();
  for(const id of selectedIds){
    const locked=jobRows(await tx`select id,body from hv_jobs where project_id=${project.id} and id=${id} for share`,project.id,1);
    // Descriptor validation already ran; compare the same persisted JSON form as
    // frozenContext, including for in-process SQL adapters with own undefined.
    const canonical=JSON.parse(JSON.stringify(locked)) as Job[];
    if(canonical.length!==1||canonical[0]!.id!==id||hash(canonical[0])!==hash(jobs.get(id)))fail("A selected proof job changed during resolution; retry the transaction.");
  }
  for(const id of selectedIds){
    const locked=indexRows(await tx`select key,sha256,bytes from hv_artifacts where project_id=${project.id} and job_id=${id} order by key limit 100001 for share`,project.id,id);
    if(hash(locked)!==hash(indexes.get(id)))fail("A selected proof artifact inventory changed during resolution; retry the transaction.");
  }
  const body={frozenContext,closure,carriers,previews,...(target?{target}:{}),metadataOnly:true as const,bytesVerified:false as const,hlsContentsVerified:false as const,currentAuthority:false as const};
  const checked=portable(body,CURRENT_FILM_PROOF_INDEX_LIMITS.resultBytes);
  return portable({...checked,revision:hash(checked)},CURRENT_FILM_PROOF_INDEX_LIMITS.resultBytes);
}
