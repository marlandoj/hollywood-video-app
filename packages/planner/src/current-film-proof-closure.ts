import type {AnimaticApproval,PersistedProject} from "../../api/src/index";
import type {Job} from "../../queue/src/index";
import {contentHash as hash} from "../../generator/src/capabilities";
import {validateCurrentFilmMixedJobPlan,type CurrentFilmJobV3} from "./current-film-mixed-jobs";
import {validateProjectCurrentScreenplay,type CurrentScreenplayLibrary} from "./current-screenplay-library";
import {assertCurrentFilmPreviewApproval} from "./current-film-job-context";
import {assertCurrentFilmMixedPreviewApproval} from "./current-film-mixed-job-context";
import {currentFilmV3Job,validateCurrentFilmRuntimeOutput} from "./current-film-runtime-context";
import {validateCurrentFilmOrigins} from "./current-film-origins";
import {advanceCurrentFilmMixedCheckpoint} from "./current-film-mixed-context";
import {assertLivingScriptPreviewApproval} from "./living-script-job-context";
import {validateProjectLivingScriptProposals,type LivingScriptProposals} from "./living-script-proposals";
import {editOriginalJob,validateEditSourceReceipt,type EditSourceReceipt} from "./edit-sources";
import {validateEditOutput} from "./edit-jobs";
import {validateEditAssemblyOutput} from "./edit-assembly-jobs";
import {editValidationKey} from "./edit-validation-key";
import {validateReference,referenceLocalKey,type ReferenceAsset} from "./references";
import {castingMatches,currentCasting} from "./casting";
import {directionMatches,currentDirection} from "./direction";
import type {RenderFile} from "./shot-reuse";
import {validateCurrentFilmProofTarget,assertCurrentFilmProofTargetApproval,type CurrentFilmProofTarget,type CurrentFilmProofTargetApproval} from "./current-film-proof-target";

import {CURRENT_FILM_PROOF_LIMITS} from "./current-film-proof-limits";
export {CURRENT_FILM_PROOF_LIMITS} from "./current-film-proof-limits";
export interface CurrentFilmProofContext {
  project:Pick<PersistedProject,"id"|"currentScreenplay"|"versions"|"animaticApprovals"|"referenceAssets"|"livingScriptProposals">;
  jobs:Job[];
}
export interface CurrentFilmProofReason {kind:"target-bootstrap"|"direct-source"|"source-bootstrap"|"preview-bootstrap"|"retained-origin"|"pending-original"|"pending-proposal-source"|"saved-proposal-source";ownerId:string}
/** A validated mapping candidate, never proof that a file or artifact index exists. */
export interface CurrentFilmProofCarrier {
  kind:"original"|"editorial"|"assembly"|"mixed-originals";jobId:string;jobRevision:string;evidenceRevision:string;files:RenderFile[];
}
/** Internal detached metadata only. Deliberately not a new persisted job/schema marker. */
export interface CurrentFilmProofClosure {
  projectId:string;planRevision:string;savedLibraryRevision:string;savedProposalsRevision:string|null;
  targetApproval?:CurrentFilmProofTargetApproval|null;
  proposalHistory:{proposalId:string;proposalRevision:string;index:number;prefixRevision:string}[];
  receipts:{receipt:EditSourceReceipt;requiredBy:CurrentFilmProofReason[];candidates:CurrentFilmProofCarrier[]}[];
  previews:{job:Job;revision:string}[];
  approvals:{finalJobId:string;finalOutputRevision:string;previewJobId:string;previewRevision:string;approval:AnimaticApproval;revision:string}[];
  references:{asset:ReferenceAsset;file:RenderFile}[];
  historicalOnly:true;mediaVerified:false;currentAuthority:false;revision:string;
}
const same=(a:unknown,b:unknown)=>hash(a)===hash(b);
function fail(message:string):never {throw new Error(message);}
function portable<T>(value:T,max=CURRENT_FILM_PROOF_LIMITS.inputBytes):T {
  if(!editValidationKey(value,max))fail("Retain bounded portable current-film proof metadata without accessors, hidden fields or cycles.");
  return structuredClone(value);
}
function id(value:unknown):asserts value is string {if(typeof value!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(value))fail("Retain an exact current-film proof owner.");}
function time(value:unknown):number {
  if(typeof value!=="string"||!Number.isSafeInteger(Date.parse(value))||Date.parse(value)<0||new Date(value).toISOString()!==value)fail("Retain canonical historical proof times.");return Date.parse(value);
}
function exact(value:object,keys:string[]):void {if(Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))fail("Retain exact current-film proof fields.");}
function prefix(saved:CurrentScreenplayLibrary,prior:CurrentScreenplayLibrary):void {
  if(saved.projectId!==prior.projectId||saved.version<prior.version||!same(saved.origin,prior.origin)
    ||!same(saved.proposals.slice(0,prior.proposals.length),prior.proposals)||!same(saved.acceptances.slice(0,prior.acceptances.length),prior.acceptances))
    fail("The saved screenplay lost the exact historical proof prefix.");
}
/** Source inspection persists JSON. Recovery may change delivery/lease bookkeeping;
 * all admitted inputs, measured progress, journal, output and lifetime stay bound. */
function originalIdentity(job:Job):unknown {
  const {notifications:_notifications,leaseVersion:_leaseVersion,leaseExpiresAt:_leaseExpiresAt,claimedBy:_claimedBy,...body}=job;
  return JSON.parse(JSON.stringify(body));
}
function approvalShape(value:AnimaticApproval):void {
  const required=["animaticJobId","scriptVersion","decision","note","at"],optional=["castingVersion","castingRevision","directionVersion","directionRevision","currentFilmReview","livingScriptReview","takeRevision"];
  if(required.some(key=>!Object.hasOwn(value,key))||Object.keys(value).some(key=>!required.includes(key)&&!optional.includes(key))
    ||!Number.isSafeInteger(value.scriptVersion)||value.scriptVersion<1||value.decision!=="approved"||typeof value.note!=="string"||value.note.length>2000)
    fail("Retain the exact historical preview decision.");
  id(value.animaticJobId);time(value.at);
}
function ordinaryApproval(final:Job,preview:Job,approval:AnimaticApproval,at:number):void {
  editOriginalJob(preview);
  const cast=currentCasting(final.projectId,final.casting?[final.casting]:[]),direction=currentDirection(final.projectId,final.direction?[final.direction]:[]);
  if(preview.currentFilm||preview.livingScript||preview.stage!=="animatic"||preview.projectId!==final.projectId||preview.id===final.id
    ||preview.id!==final.animaticJobId||preview.scriptVersion!==final.scriptVersion||preview.scriptText!==final.scriptText
    ||approval.currentFilmReview!==undefined||approval.livingScriptReview!==undefined||approval.takeRevision!==undefined
    ||approval.scriptVersion!==final.scriptVersion||approval.animaticJobId!==preview.id||approval.at!==final.animaticApprovedAt
    ||!castingMatches(preview.casting,cast)||!directionMatches(preview.direction,direction)
    ||(approval.castingVersion??0)!==cast.version||cast.version>0&&approval.castingRevision!==cast.revision
    ||(approval.directionVersion??0)!==direction.version||direction.version>0&&approval.directionRevision!==direction.revision
    ||time(approval.at)<time(preview.completedAt)||time(approval.at)>=time(preview.linkExpiresAt)||time(approval.at)>at||time(preview.linkExpiresAt)<=at)
    fail("The retained ordinary final lost its actual matching preview and historical approval.");
}

/** Caller supplies authoritative saved metadata. Every returned carrier still needs
 * held index/byte verification; expired links and present permissions are not tested. */
export function compileCurrentFilmProofClosure(raw:CurrentFilmJobV3,rawContext:CurrentFilmProofContext,rawTarget?:CurrentFilmProofTarget):CurrentFilmProofClosure {
  const input=portable({plan:raw,context:rawContext,...(rawTarget!==undefined?{target:rawTarget}:{})}),{context}=input;
  if(!context||typeof context!=="object")fail("Retain the saved proof context.");exact(context,["project","jobs"]);
  const plan=validateCurrentFilmMixedJobPlan(input.plan),project=context.project;id(project?.id);
  const target=input.target===undefined?undefined:validateCurrentFilmProofTarget(input.target,plan,input.target.jobId);
  if(project.id!==plan.projectId||!Array.isArray(context.jobs)||context.jobs.length>CURRENT_FILM_PROOF_LIMITS.jobs
    ||!Array.isArray(project.animaticApprovals))fail("Retain bounded proof jobs and approvals from the same project.");
  const saved=validateProjectCurrentScreenplay(project.currentScreenplay,{projectId:project.id,versions:project.versions});prefix(saved,plan.library);
  // Pending films keep the actual saved immutable proposal and its original
  // screenplay version. Later proposals/accepted screenplay heads remain valid.
  const pending:LivingScriptProposals|undefined=project.livingScriptProposals===undefined?undefined:
    validateProjectLivingScriptProposals(project.livingScriptProposals,project.id,project.versions);
  const jobs=new Map<string,Job>(),jobKeys=new Map<string,string>();
  for(const job of context.jobs){id(job?.id);if(job.projectId!==project.id)fail("A current-film proof job belongs to another project.");
    const key=hash(job),previous=jobKeys.get(job.id);if(previous&&previous!==key)fail("Conflicting same-ID authoritative proof jobs.");
    jobs.set(job.id,job);jobKeys.set(job.id,key);
  }
  const receipts=new Map<string,CurrentFilmProofClosure["receipts"][number]>(),originals=new Map<string,string>(),previews=new Map<string,CurrentFilmProofClosure["previews"][number]>();
  const approvals:CurrentFilmProofClosure["approvals"]=[],catalog=new Map<string,ReferenceAsset>(),references=new Map<string,ReferenceAsset>();
  if(project.referenceAssets!==undefined&&(!Array.isArray(project.referenceAssets)||project.referenceAssets.length>CURRENT_FILM_PROOF_LIMITS.references))fail("Retain the bounded historical reference catalog.");
  for(const asset of project.referenceAssets??[]){const checked=validateReference(asset,project.id),old=catalog.get(checked.id);if(old&&!same(old,checked))fail("Conflicting same-ID proof reference assets.");catalog.set(checked.id,checked);}
  const scanReferences=(value:unknown):void=>{
    if(!value||typeof value!=="object")return;
    if(!Array.isArray(value)&&"schema" in value&&value.schema==="hv-reference/1"){
      const asset=validateReference(value as ReferenceAsset,project.id),current=catalog.get(asset.id);
      if(!current||!same(current,asset))fail("A historical proof reference is missing or changed in the saved catalog.");
      const previous=references.get(asset.id);if(previous&&!same(previous,asset))fail("Conflicting historical reference identities.");references.set(asset.id,asset);return;
    }
    for(const child of Object.values(value))scanReferences(child);
  };
  scanReferences(plan);
  const addedFilms=new Set<string>(),activeFilms=new Set<string>();
  const addFilm=(job:Job):void=>{
    const identity=hash(originalIdentity(job)),old=originals.get(job.id);
    if(old&&old!==identity)fail("Conflicting same-ID retained original proof bodies.");originals.set(job.id,identity);
    if(activeFilms.has(job.id))fail("Historical preview proof dependencies contain a cycle.");
    if(addedFilms.has(job.id))return;activeFilms.add(job.id);
    if(job.currentFilm){prefix(saved,job.currentFilm.library);addReceipt(job.currentFilm.library.origin!.request.source,{kind:job.stage==="animatic"?"preview-bootstrap":"source-bootstrap",ownerId:job.id});}
    if(job.currentFilm?.schema==="hv-current-film-job/3")for(const origin of job.currentFilm.origins)addReceipt(origin.binding.source,{kind:"retained-origin",ownerId:job.id});
    if(job.livingScript){
      const proposal=job.livingScript.proposal,retained=pending?.proposals.find(value=>value.request.id===proposal.request.id);
      if(!retained||retained.revision!==proposal.revision||!same(retained,proposal))fail("The pending source lost its exact authoritative saved screenplay proposal.");
      addReceipt(job.livingScript.binding.source,{kind:"pending-original",ownerId:job.id});
      for(const source of proposal.editorial.sources)addReceipt(source,{kind:"pending-proposal-source",ownerId:proposal.revision});
    }
    scanReferences(job);
    if(job.stage==="final"){
      const preview=jobs.get(job.animaticJobId??""),matches=project.animaticApprovals.filter(value=>value.animaticJobId===job.animaticJobId&&value.at===job.animaticApprovedAt);
      if(!preview||matches.length!==1)fail("The retained final requires its actual saved preview job and one exact historical approval.");
      const approval=matches[0]!;approvalShape(approval);const at=time(job.startedAt??job.animaticApprovedAt);
      if(job.currentFilm?.schema==="hv-current-film-job/3")assertCurrentFilmMixedPreviewApproval(currentFilmV3Job(job),preview,approval,at);
      else if(job.currentFilm)assertCurrentFilmPreviewApproval(job,preview,approval,at);
      else if(job.livingScript)assertLivingScriptPreviewApproval(job,preview,approval,at);
      else ordinaryApproval(job,preview,approval,at);
      if(previews.size>=CURRENT_FILM_PROOF_LIMITS.previews&&!previews.has(preview.id))fail("Historical preview proof exceeds its capacity.");
      const revision=hash(preview);previews.set(preview.id,{job:preview,revision});
      const body={finalJobId:job.id,finalOutputRevision:hash(job.output),previewJobId:preview.id,previewRevision:revision,approval};approvals.push({...body,revision:hash(body)});
      addFilm(preview);
    }
    activeFilms.delete(job.id);addedFilms.add(job.id);
  };
  function addReceipt(value:EditSourceReceipt,reason:CurrentFilmProofReason):void {
    const existing=receipts.get(value.revision);
    if(existing){if(!same(existing.receipt,value))fail("Conflicting same-revision proof receipts.");if(!existing.requiredBy.some(item=>same(item,reason)))existing.requiredBy.push(reason);return;}
    if(receipts.size>=CURRENT_FILM_PROOF_LIMITS.receipts)fail("Current-film proof receipts exceed their capacity.");
    const receipt=validateEditSourceReceipt(value);if(receipt.job.projectId!==project.id)fail("A historical original escaped its proof project.");
    receipts.set(receipt.revision,{receipt,requiredBy:[reason],candidates:[]});addFilm(receipt.job);
  }
  addReceipt(plan.library.origin!.request.source,{kind:"target-bootstrap",ownerId:plan.revision});
  for(const origin of plan.origins)addReceipt(origin.binding.source,{kind:"direct-source",ownerId:origin.id});
  // Recovery retains frozen proposal history, including originals absent from
  // its visible cut. Metadata for only the selected patch source is insufficient.
  for(const proposal of pending?.proposals??[]){
    scanReferences(proposal);
    for(const source of proposal.editorial.sources)addReceipt(source,{kind:"saved-proposal-source",ownerId:proposal.revision});
  }

  // The target final's own approval is an admitted-envelope dependency, not a
  // field of its render plan. Preserve it explicitly without inventing output
  // for the unfinished target or hashing a circular full target Job.
  let targetApproval:CurrentFilmProofTargetApproval|null|undefined;
  if(target){
    if(target.stage==="animatic")targetApproval=assertCurrentFilmProofTargetApproval(target,plan,undefined,undefined,Date.parse(plan.createdAt));
    else {
      const preview=jobs.get(target.animaticJobId!),matches=project.animaticApprovals.filter(value=>value.animaticJobId===target.animaticJobId&&value.at===target.animaticApprovedAt);
      if(!preview||matches.length!==1)fail("The target final requires its actual saved preview and exact approval.");
      const approval=matches[0]!;approvalShape(approval);
      targetApproval=assertCurrentFilmProofTargetApproval(target,plan,preview,approval,time(target.animaticApprovedAt));
      if(previews.size>=CURRENT_FILM_PROOF_LIMITS.previews&&!previews.has(preview.id))fail("Historical preview proof exceeds its capacity.");
      const revision=hash(preview),existing=previews.get(preview.id);
      if(existing&&existing.revision!==revision)fail("Conflicting historical and target preview identities.");
      previews.set(preview.id,{job:preview,revision});addFilm(preview);
    }
  }

  let candidateCount=0,fileCount=0;
  const addCandidate=(receipt:EditSourceReceipt,job:Job,kind:CurrentFilmProofCarrier["kind"],evidence:unknown,files:RenderFile[])=>{
    const target=receipts.get(receipt.revision);if(!target)return;
    if(!same(target.receipt,receipt))fail("A proof carrier changed the complete original receipt.");
    if(files.length!==receipt.files.length||new Set(files.map(file=>file.path)).size!==files.length)fail("A proof carrier lost its exact file inventory.");
    for(const [index,file]of files.entries()){
      exact(file,["path","sha256","bytes"]);const original=receipt.files[index]!;
      if(file.sha256!==original.sha256||file.bytes!==original.bytes||typeof file.path!=="string"||file.path.length>1024||!file.path.startsWith(`${project.id}/${job.id}/`)
        ||!/^[A-Za-z0-9._/-]+$/.test(file.path)||file.path.split("/").some(part=>!part||part==="."||part===".."))fail("A proof carrier changed original file bytes or ownership.");
    }
    const candidate={kind,jobId:job.id,jobRevision:jobKeys.get(job.id)!,evidenceRevision:hash(evidence),files};
    if(target.candidates.some(value=>same(value,candidate)))return;
    if(++candidateCount>CURRENT_FILM_PROOF_LIMITS.candidates||(fileCount+=files.length)>CURRENT_FILM_PROOF_LIMITS.files)fail("Current-film proof carrier mappings exceed their capacity.");
    target.candidates.push(candidate);
  };
  for(const {receipt}of receipts.values()){
    const current=jobs.get(receipt.job.id);if(!current)continue;
    editOriginalJob(current);if(!same(originalIdentity(current),originalIdentity(receipt.job)))fail("The saved original changed its historical proof identity.");
    addCandidate(receipt,current,"original",receipt,receipt.files);
  }
  for(const job of jobs.values()){
    for(const field of ["output","editCheckpoint","assemblyCheckpoint"] as const){
      const output=job[field];if(!output)continue;
      for(const kind of ["editorial","assembly"] as const){
        const result=output[kind];if(!result||!result.prepared.sources.some(source=>receipts.has(source.receipt.revision)))continue;
        if(kind==="editorial")validateEditOutput(job,output);else validateEditAssemblyOutput(job,output);
        for(const source of result.prepared.sources)addCandidate(source.receipt,job,kind,result,source.copies.map(copy=>copy.copy));
      }
    }
    if(job.currentFilm?.schema==="hv-current-film-job/3"&&job.currentFilmOrigins&&job.currentFilmOrigins.origins.some(origin=>receipts.has(origin.receiptRevision))){
      const current=currentFilmV3Job(job),prepared=validateCurrentFilmOrigins(current.currentFilmOrigins!,current.currentFilm,current.id);
      if(current.currentFilmCheckpoint)advanceCurrentFilmMixedCheckpoint(current,current.currentFilmCheckpoint,current.checkpointShots,current.checkpointFrame);
      else if(current.checkpointShots!==0||current.checkpointFrame!==0)fail("The mixed proof carrier lost its complete held prefix.");
      if(current.output)validateCurrentFilmRuntimeOutput(job,current.output);
      for(const origin of prepared.origins){const source=current.currentFilm.origins.find(value=>value.id===origin.originId)!.binding.source;
        addCandidate(source,job,"mixed-originals",prepared,origin.copies.map(copy=>copy.owned));}
    }
  }
  for(const value of receipts.values()){
    if(!value.candidates.length)fail("A required current-film proof receipt has no original or retained carrier metadata.");
    value.requiredBy.sort((a,b)=>a.kind.localeCompare(b.kind)||a.ownerId.localeCompare(b.ownerId));
    value.candidates.sort((a,b)=>a.jobId.localeCompare(b.jobId)||a.kind.localeCompare(b.kind)||a.evidenceRevision.localeCompare(b.evidenceRevision));
  }
  const body={projectId:project.id,planRevision:plan.revision,savedLibraryRevision:saved.revision,savedProposalsRevision:pending?.revision??null,
    ...(target?{targetApproval:targetApproval!}:{}),
    proposalHistory:(pending?.proposals??[]).map((proposal,index)=>({proposalId:proposal.request.id,proposalRevision:proposal.revision,index,prefixRevision:hash({projectId:project.id,proposals:pending!.proposals.slice(0,index+1)})})),
    receipts:[...receipts.values()].sort((a,b)=>a.receipt.revision.localeCompare(b.receipt.revision)),
    previews:[...previews.values()].sort((a,b)=>a.job.id.localeCompare(b.job.id)),approvals:approvals.sort((a,b)=>a.finalJobId.localeCompare(b.finalJobId)),
    references:[...references.values()].sort((a,b)=>a.id.localeCompare(b.id)).map(asset=>({asset,file:{path:referenceLocalKey(asset),sha256:asset.sha256,bytes:asset.bytes}})),
    historicalOnly:true as const,mediaVerified:false as const,currentAuthority:false as const};
  return portable({...body,revision:hash(body)},CURRENT_FILM_PROOF_LIMITS.resultBytes);
}
export function validateCurrentFilmProofClosure(value:CurrentFilmProofClosure,plan:CurrentFilmJobV3,context:CurrentFilmProofContext,target?:CurrentFilmProofTarget):CurrentFilmProofClosure {
  const checked=portable(value,CURRENT_FILM_PROOF_LIMITS.resultBytes),expected=compileCurrentFilmProofClosure(plan,context,target);
  if(!same(checked,expected))fail("The current-film proof closure differs from its exact saved dependencies and carrier mappings.");return expected;
}
