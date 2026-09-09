import {contentHash as hash} from "../../generator/src/capabilities";
import type {Job} from "../../queue/src/index";
import {editValidationKey} from "./edit-validation-key";
import {editOriginalJob} from "./edit-sources";
import {EDIT_STORAGE_LIMITS} from "./edit-resources";
import {compileCurrentFilmProofClosure,type CurrentFilmProofContext,type CurrentFilmProofCarrier,type CurrentFilmProofClosure} from "./current-film-proof-closure";
import {resolveCurrentFilmProofPreviewCarrier,resolveCurrentFilmProofReferenceCarrier} from "./current-film-proof-retained";
import {CURRENT_FILM_PROOF_LIMITS} from "./current-film-proof-limits";
import {currentFilmRuntimeRecordedFiles,currentFilmV3Job,validateCurrentFilmRuntimeOutput} from "./current-film-runtime-context";
import type {CurrentFilmJobV3} from "./current-film-mixed-jobs";
import type {RenderFile} from "./shot-reuse";
import {validateCurrentFilmProofTarget,type CurrentFilmProofTarget} from "./current-film-proof-target";

export interface CurrentFilmProofCarrierSelection {
  receiptRevision:string;kind:CurrentFilmProofCarrier["kind"];jobId:string;jobRevision:string;evidenceRevision:string;
}
export interface CurrentFilmProofSelection {
  target?:CurrentFilmProofTarget;
  frozenContext:CurrentFilmProofContext;
  carriers:CurrentFilmProofCarrierSelection[];
  previews:{jobId:string;files:RenderFile[]}[];
}
export interface CurrentFilmProofCopy {original:RenderFile;carrier:RenderFile;owned:RenderFile}
/** A deterministic private copy specification. Only a held, byte-verifying
 * checkpoint transaction can establish that these copies actually exist. */
export interface CurrentFilmProofCopies {
  schema:"hv-current-film-proof-copies/1";projectId:string;jobId:string;jobPlanRevision:string;
  target?:CurrentFilmProofTarget;
  frozenContext:CurrentFilmProofContext;closureRevision:string;
  carriers:(CurrentFilmProofCarrierSelection&{copies:CurrentFilmProofCopy[]})[];
  previews:{jobId:string;jobRevision:string;copies:CurrentFilmProofCopy[]}[];
  references:{assetId:string;copy:CurrentFilmProofCopy}[];
  files:number;bytes:number;mediaVerified:false;currentAuthority:false;revision:string;
}
export interface CurrentFilmProofResolution {proof:CurrentFilmProofCopies;closure:CurrentFilmProofClosure}
const LIMITS={metadataBytes:256*1024**2,files:CURRENT_FILM_PROOF_LIMITS.files,bytes:EDIT_STORAGE_LIMITS.workspaceBytes,path:1024};
function fail(message:string):never {throw new Error(message);}
function portable<T>(value:T):T {
  if(!editValidationKey(value,LIMITS.metadataBytes))fail("Retain bounded portable current-film proof copy inputs without accessors, hidden values or cycles.");
  return structuredClone(value);
}
// Successful historical results only. Retain encoded closure bytes, never the
// caller's proof/plan, mutable objects, permission results or verified media.
// Large valid results still compile normally; cache limits do not limit admission.
const CACHE={entries:8,entryBytes:8*1024**2,totalBytes:32*1024**2};
const checkedClosures=new Map<string,Buffer>();let checkedClosureBytes=0;
function resolutionKey(value:CurrentFilmProofCopies,plan:CurrentFilmJobV3,jobId:string):string {
  // Keep the existing independent bounds: combining the duplicate proof/plan
  // ancestry into one portable object could newly reject a valid large input.
  const proofKey=editValidationKey(value,LIMITS.metadataBytes),planKey=editValidationKey(plan,LIMITS.metadataBytes);
  if(!proofKey||!planKey)fail("Retain bounded portable current-film proof resolution inputs without accessors, hidden values or cycles.");
  owner(jobId);return hash({proofKey,planKey,jobId});
}
function rememberClosure(key:string,closure:CurrentFilmProofClosure):void {
  const serialized=JSON.stringify(closure),bytes=Buffer.byteLength(serialized);
  if(bytes>CACHE.entryBytes)return;
  // Optional own-undefined fields must not disappear in a cached JSON result.
  // Such valid historical shapes simply use normal uncached reconstruction.
  if(hash(JSON.parse(serialized))!==hash(closure))return;
  const previous=checkedClosures.get(key);if(previous){checkedClosureBytes-=previous.byteLength;checkedClosures.delete(key);}
  while(checkedClosures.size>=CACHE.entries||checkedClosureBytes+bytes>CACHE.totalBytes){
    const oldest=checkedClosures.keys().next().value!;checkedClosureBytes-=checkedClosures.get(oldest)!.byteLength;checkedClosures.delete(oldest);
  }
  const encoded=Buffer.from(serialized);checkedClosures.set(key,encoded);checkedClosureBytes+=encoded.byteLength;
}
function exact(value:unknown,keys:string[]):void {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))fail("Retain exact current-film proof copy fields.");
}
function owner(value:unknown):asserts value is string {
  if(typeof value!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(value))fail("Retain an exact current-film proof copy owner.");
}
function file(value:RenderFile,projectId:string,jobId:string,maximum=8*1024**3):void {
  exact(value,["path","sha256","bytes"]);
  if(typeof value.path!=="string"||value.path.length>LIMITS.path||!value.path.startsWith(`${projectId}/${jobId}/`)
    ||!/^[A-Za-z0-9._/-]+$/.test(value.path)||value.path.split("/").some(part=>!part||part==="."||part==="..")
    ||typeof value.sha256!=="string"||!/^[a-f0-9]{64}$/.test(value.sha256)||!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>maximum)
    fail("Retain exact bounded owned proof file paths, byte counts and hashes.");
}

/** Index-level completeness only. Actual playlist references, native PCM and
 * container/provenance semantics still require the subsequent byte verifier. */
export function validateCurrentFilmProofPreviewFiles(raw:Job,rawFiles:RenderFile[]):RenderFile[] {
  const {job,files}=portable({job:raw,files:rawFiles});owner(job.id);owner(job.projectId);
  const mixed=job.currentFilm?.schema==="hv-current-film-job/3";
  if(mixed){currentFilmV3Job(job);if(job.output)validateCurrentFilmRuntimeOutput(job,job.output);}else editOriginalJob(job);
  if(job.status!=="done"||job.stage!=="animatic"||!job.output)fail("Retain an actual completed historical preview for proof copies.");
  if(!Array.isArray(files)||!files.length||files.length>LIMITS.files)fail("Retain the bounded complete historical preview index.");
  const output=job.output,known=job.currentFilm?currentFilmRuntimeRecordedFiles(job):job.output.shotRenders!.flatMap(row=>Object.values(row.files));
  const delivery=[output.mp4Path,output.hlsPlaylistPath,output.captionsPath,output.manifestPath];
  if(new Set(delivery).size!==4||!output.hlsPlaylistPath.endsWith("/index.m3u8")||!output.captionsPath.endsWith(".vtt"))fail("Retain distinct preview delivery roles and its exact playlist/captions.");
  const expected=new Map<string,RenderFile>();
  for(const value of known){const prior=expected.get(value.path);if(prior&&hash(prior)!==hash(value))fail("Conflicting historical preview role identities.");expected.set(value.path,value);}
  const required=new Set([...expected.keys(),...delivery,output.captionsPath.slice(0,-4)+".srt"]);
  if(!mixed)required.add(`${job.projectId}/${job.id}/clips/manifest.json`);
  const prefix=output.hlsPlaylistPath.slice(0,-"index.m3u8".length),indexed=new Map<string,RenderFile>();let segments=0;
  for(const value of files){
    file(value,job.projectId,job.id,job.currentFilm&&value.path===output.mp4Path?LIMITS.bytes:8*1024**3);
    if(indexed.has(value.path))fail("Duplicate historical preview index paths.");indexed.set(value.path,value);
    if(!required.has(value.path)){
      if(!value.path.startsWith(prefix)||!/^segment-\d{3,5}\.ts$/.test(value.path.slice(prefix.length))||++segments>10000)fail("The historical preview index contains an unowned delivery or media role.");
    }
    const sealed=expected.get(value.path);if(sealed&&hash(sealed)!==hash(value))fail("The historical preview index differs from its measured media evidence.");
  }
  if(!segments||[...required].some(path=>!indexed.has(path)))fail("The historical preview index is missing a required role or segment inventory.");
  return files.sort((a,b)=>a.path.localeCompare(b.path));
}

/** Snapshot only the historical fields used by the closure, with persisted JSON
 * semantics. Call this before compiling/selecting candidates for a local store. */
export function freezeCurrentFilmProofContext(raw:CurrentFilmProofContext):CurrentFilmProofContext {
  const input=portable(raw);exact(input,["project","jobs"]);
  const project=input.project;
  if(!project||typeof project!=="object"||Array.isArray(project))fail("Retain the exact saved proof project.");
  if(!Array.isArray(input.jobs)||input.jobs.length>CURRENT_FILM_PROOF_LIMITS.jobs)fail("Retain the complete bounded proof job context.");
  for(const job of input.jobs)owner(job?.id);
  const selected={id:project.id,currentScreenplay:project.currentScreenplay,versions:project.versions,animaticApprovals:project.animaticApprovals,
    ...(project.referenceAssets!==undefined?{referenceAssets:project.referenceAssets}:{}),...(project.livingScriptProposals!==undefined?{livingScriptProposals:project.livingScriptProposals}:{})};
  return JSON.parse(JSON.stringify({project:selected,jobs:input.jobs.sort((a,b)=>a.id.localeCompare(b.id))})) as CurrentFilmProofContext;
}

/** Freeze the historical requirements and exact source-to-carrier-to-copy map.
 * This does not promise combined workspace/archive capacity or current access. */
export function compileCurrentFilmProofCopies(raw:CurrentFilmJobV3,jobId:string,rawSelection:CurrentFilmProofSelection):CurrentFilmProofCopies {
  const resolved=compileResolvedProofCopies(raw,jobId,rawSelection);
  rememberClosure(resolutionKey(resolved.proof,raw,jobId),resolved.closure);
  return resolved.proof;
}
function compileResolvedProofCopies(raw:CurrentFilmJobV3,jobId:string,rawSelection:CurrentFilmProofSelection):CurrentFilmProofResolution {
  owner(jobId);const {plan,selection}=portable({plan:raw,selection:rawSelection});exact(selection,["frozenContext","carriers","previews",...(Object.hasOwn(selection,"target")?["target"]:[])]);
  const target=Object.hasOwn(selection,"target")?validateCurrentFilmProofTarget(selection.target!,plan,jobId):undefined;
  selection.frozenContext=freezeCurrentFilmProofContext(selection.frozenContext);
  let closure=compileCurrentFilmProofClosure(plan,selection.frozenContext,target);const projectId=closure.projectId;owner(projectId);
  if(!Array.isArray(selection.carriers)||selection.carriers.length!==closure.receipts.length||!Array.isArray(selection.previews)||selection.previews.length!==closure.previews.length)fail("Retain every exact proof receipt and historical preview once.");
  const selected=new Map<string,CurrentFilmProofCarrierSelection>();
  for(const value of selection.carriers){
    exact(value,["receiptRevision","kind","jobId","jobRevision","evidenceRevision"]);
    if(selected.has(value.receiptRevision))fail("Retain each proof receipt exactly once.");selected.set(value.receiptRevision,value);
  }
  const previews=new Map<string,CurrentFilmProofSelection["previews"][number]>();
  for(const value of selection.previews){exact(value,["jobId","files"]);if(previews.has(value.jobId))fail("Retain each historical preview exactly once.");previews.set(value.jobId,value);}
  // A newly admitted target legitimately appears in discovery. It must not own
  // any selected proof or original dependency; unrelated rows are pruned below.
  if(closure.receipts.some(value=>value.receipt.job.id===jobId)||selection.carriers.some(value=>value.jobId===jobId)||closure.previews.some(value=>value.job.id===jobId))
    fail("Retain proof under an independent target job.");
  // Discovery may include unrelated jobs or alternate copies. Retain only the
  // selected carriers and actual required previews, then prove the historical
  // requirements are unchanged before sealing this smaller frozen context.
  const retainedIds=new Set([...selection.carriers.map(value=>value.jobId),...closure.previews.map(value=>value.job.id)]);
  const requiredApprovals=new Set([...closure.approvals.map(value=>hash(value.approval)),...(closure.targetApproval?[hash(closure.targetApproval.approval)]:[])]);
  const frozenContext={project:{...selection.frozenContext.project,animaticApprovals:selection.frozenContext.project.animaticApprovals.filter(value=>requiredApprovals.has(hash(value)))},
    jobs:selection.frozenContext.jobs.filter(job=>retainedIds.has(job.id))};
  const retained=compileCurrentFilmProofClosure(plan,frozenContext,target);
  const requirements=(value:typeof closure)=>{const {revision:_revision,receipts,...body}=value;return {...body,receipts:receipts.map(({candidates:_candidates,...receipt})=>receipt)};};
  if(hash(requirements(closure))!==hash(requirements(retained)))fail("Selected proof carriers do not retain the complete historical requirements.");
  closure=retained;
  let count=0,bytes=0,metadata=Buffer.byteLength(JSON.stringify(frozenContext))+4096;
  const paths=new Set<string>();
  const copy=(original:RenderFile,carrier:RenderFile,prefix:string):CurrentFilmProofCopy=>{
    // Preserve the original relative hierarchy inside an isolated owned root.
    // Existing historical media/playlist verifiers then need no rewritten Job,
    // aliased original records, global source directories or duplicate scratch.
    const owned={...original,path:`${projectId}/${jobId}/proof/${prefix}/${original.path}`};
    file(owned,projectId,jobId,LIMITS.bytes);
    if(original.bytes!==carrier.bytes||original.sha256!==carrier.sha256)fail("A proof carrier changed the original bytes.");
    const result={original,carrier,owned};
    if(++count>LIMITS.files||(bytes+=owned.bytes)>LIMITS.bytes||paths.has(owned.path))fail("The complete proof copy set exceeds its distinct-file or byte capacity.");paths.add(owned.path);
    metadata+=Buffer.byteLength(JSON.stringify(result))+1;if(metadata>LIMITS.metadataBytes)fail("The complete proof copy set exceeds its metadata capacity.");
    return result;
  };
  const carriers=closure.receipts.map(({receipt,candidates})=>{
    const chosen=selected.get(receipt.revision),candidate=chosen&&candidates.find(value=>value.kind===chosen.kind&&value.jobId===chosen.jobId&&value.jobRevision===chosen.jobRevision&&value.evidenceRevision===chosen.evidenceRevision);
    if(!candidate||!chosen)fail("The selected proof carrier differs from the exact frozen historical evidence.");
    return {...chosen,copies:receipt.files.map((original,index)=>copy(original,candidate.files[index]!,`originals/${receipt.revision}`))};
  });
  const previewCopies=closure.previews.map(({job,revision})=>{
    const chosen=previews.get(job.id);if(!chosen)fail("Retain the actual required historical preview inventory.");
    const files=validateCurrentFilmProofPreviewFiles(job,chosen.files),retained=resolveCurrentFilmProofPreviewCarrier(closure,selection.carriers,job.id);
    if(retained&&hash(files)!==hash(retained.files.map(value=>value.original)))fail("Selected nested preview files differ from the exact retained proof.");
    return {jobId:job.id,jobRevision:revision,copies:files.map((original,index)=>copy(original,retained?.files[index]?.carrier??original,`previews/${job.id}`))};
  });
  const references=closure.references.map(({asset,file})=>{
    const retained=resolveCurrentFilmProofReferenceCarrier(closure,selection.carriers,asset.id);
    return {assetId:asset.id,copy:copy(file,retained?.files[0]?.carrier??file,`references/${asset.id}`)};
  });
  const body={schema:"hv-current-film-proof-copies/1" as const,projectId,jobId,jobPlanRevision:closure.planRevision,...(target?{target}:{}),frozenContext,closureRevision:closure.revision,
    carriers,previews:previewCopies,references,files:count,bytes,mediaVerified:false as const,currentAuthority:false as const};
  const checked=portable(body);
  return {proof:portable({...checked,revision:hash(checked)}),closure};
}
/** Reuse only successful exact historical reconstruction. Every call inspects
 * full input descriptors/content; returned proof and closure are detached.
 * Current project, lease, index custody and actual bytes remain separate gates. */
export function resolveCurrentFilmProofCopies(value:CurrentFilmProofCopies,plan:CurrentFilmJobV3,jobId:string):CurrentFilmProofResolution {
  const key=resolutionKey(value,plan,jobId),cached=checkedClosures.get(key);
  if(cached){checkedClosures.delete(key);checkedClosures.set(key,cached);return {proof:structuredClone(value),closure:JSON.parse(cached.toString("utf8")) as CurrentFilmProofClosure};}
  const input=structuredClone(value);exact(input,["schema","projectId","jobId","jobPlanRevision","frozenContext","closureRevision","carriers","previews","references","files","bytes","mediaVerified","currentAuthority","revision",...(Object.hasOwn(input,"target")?["target"]:[])]);
  if(!Array.isArray(input.carriers)||input.carriers.length>CURRENT_FILM_PROOF_LIMITS.receipts||!Array.isArray(input.previews)||input.previews.length>CURRENT_FILM_PROOF_LIMITS.previews)fail("Retain bounded proof copy groups.");
  const carriers=input.carriers.map(value=>{exact(value,["receiptRevision","kind","jobId","jobRevision","evidenceRevision","copies"]);const {copies:_copies,...selection}=value;return selection;});
  const previews=input.previews.map(value=>{exact(value,["jobId","jobRevision","copies"]);if(!Array.isArray(value.copies)||value.copies.length>LIMITS.files)fail("Retain bounded historical preview copies.");return {jobId:value.jobId,files:value.copies.map(copy=>copy.original)};});
  const resolved=compileResolvedProofCopies(plan,jobId,{frozenContext:input.frozenContext,carriers,previews,...(Object.hasOwn(input,"target")?{target:input.target!}:{})});
  if(hash(input)!==hash(resolved.proof))fail("Current-film proof copies differ from their exact frozen requirements, carriers or owned paths.");
  rememberClosure(key,resolved.closure);return resolved;
}
export function validateCurrentFilmProofCopies(value:CurrentFilmProofCopies,plan:CurrentFilmJobV3,jobId:string):CurrentFilmProofCopies {
  return resolveCurrentFilmProofCopies(value,plan,jobId).proof;
}
