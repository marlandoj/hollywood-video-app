import {createHash} from "node:crypto";
import {lstatSync,opendirSync,realpathSync} from "node:fs";
import {open} from "node:fs/promises";
import {dirname,join} from "node:path";
import type {Project} from "../../api/src/index";
import {compileCurrentFilmProofClosure,type CurrentFilmProofContext} from "../../planner/src/current-film-proof-closure";
import {snapshotCurrentFilmVersions,assertCurrentFilmGenerationCurrent} from "../../planner/src/current-film-authority";
import {assertCurrentFilmSourcePermission} from "../../planner/src/current-film-source-permission";
import {editValidationKey} from "../../planner/src/edit-validation-key";
import {resolveCurrentFilmProofPreviewCarrier} from "../../planner/src/current-film-proof-retained";
import {compileCurrentFilmProofTarget} from "../../planner/src/current-film-proof-target";
import {compileCurrentFilmProofCopies,freezeCurrentFilmProofContext,validateCurrentFilmProofPreviewFiles,type CurrentFilmProofCopy} from "../../planner/src/current-film-proof-copies";
import {createCurrentFilmPreparedProof,assertCurrentFilmProofProjectPrefix,assertCurrentFilmProofRetainedCapacity,validateCurrentFilmPreparedProof,type CurrentFilmPreparedProof} from "../../planner/src/current-film-prepared-proof";
import {currentFilmRuntimeRecordedFiles,currentFilmV3Job} from "../../planner/src/current-film-runtime-context";
import {assertCurrentFilmMixedPreviewApproval,type CurrentFilmMixedJob} from "../../planner/src/current-film-mixed-job-context";
import type {RenderFile} from "../../planner/src/shot-reuse";
import {contentHash as hash} from "../../generator/src/capabilities";
import {prepareCurrentFilmProofCopies} from "../../generator/src/current-film-proof-copy";
import {verifyCurrentFilmProofMedia} from "../../generator/src/current-film-proof-media";
import {withEditSourceAccess} from "../../generator/src/edit-source-media";
import {audioAbortable} from "../../generator/src/audio-stream";
import type {DialogueArtifactReader} from "../../generator/src/dialogue-replacement";
import {ReferenceBlobStore} from "../../storage/src/references";
import {DurableJobStore} from "./index";

function fail(message:string):never {throw new Error(message);}
/** Persist only fields consumed by proof closure. A live Project includes a
 * VersionStore and unrelated service data; neither is JSON authority by itself. */
function proofProject(raw:Project):CurrentFilmProofContext["project"] {
  const field=(key:keyof Project):unknown=>{
    const value=Object.getOwnPropertyDescriptor(raw,key);
    if(value&&(!value.enumerable||!Object.hasOwn(value,"value")))fail("Retain current proof project fields without accessors or hidden values.");
    return value?.value;
  };
  const optional:Record<string,unknown>={};
  for(const key of ["currentScreenplay","referenceAssets","livingScriptProposals"] as const){const value=field(key);if(value!==undefined)optional[key]=value;}
  const selected={id:field("id"),versions:snapshotCurrentFilmVersions(field("versions")),animaticApprovals:field("animaticApprovals"),...optional};
  if(!editValidationKey(selected,256*1024**2))fail("Retain bounded portable current proof project history.");
  return structuredClone(selected) as CurrentFilmProofContext["project"];
}
/** Single-process local commit guard. Invoke after the final awaited access
 * check, with no await between these saved-job reads and the domain checkpoint.
 * Database workers use the held artifact transaction instead. */
export function assertLocalCurrentFilmProofCurrent(proof:CurrentFilmPreparedProof,store:DurableJobStore,project:Project|null,now=Date.now()):void {
  if(!project)fail("The current proof project disappeared.");
  const saved=store.get(proof.jobId);if(!saved)fail("The held local proof target disappeared.");
  const job=currentFilmV3Job(saved);validateCurrentFilmPreparedProof(proof,job);
  assertCurrentFilmGenerationCurrent(job.currentFilm,project,now);
  for(const origin of job.currentFilm.origins)assertCurrentFilmSourcePermission(origin.binding.source.job,project,now);
  if(job.stage==="final")assertCurrentFilmMixedPreviewApproval(job,store.get(job.animaticJobId!),project.animaticApprovals.filter(value=>value.animaticJobId===job.animaticJobId).at(-1),now);
  assertCurrentFilmProofProjectPrefix(proof.specification,proofProject(project));
  for(const source of proof.specification.frozenContext.jobs){const actual=store.get(source.id);
    if(!actual||!editValidationKey(actual,256*1024**2)||hash(JSON.parse(JSON.stringify(actual)))!==hash(source))fail("A selected local proof job changed before its checkpoint.");}
}
function filePath(root:string,key:string):string {
  if(key.length>1024||!/^[A-Za-z0-9._/-]+$/.test(key)||key.split("/").some(part=>!part||part==="."||part===".."))fail("Proof media escaped its exact local path.");
  let path=root;for(const part of key.split("/")){path=join(path,part);if(lstatSync(path).isSymbolicLink()||realpathSync(path)!==path)fail("Local proof media cannot follow linked paths.");}
  if(!lstatSync(path).isFile())fail("Retain regular local proof media.");return path;
}
/** Internal local byte measurement, not a permission or custody receipt. One
 * opened inode is read in bounded proof blocks, with fresh access for each read. */
export async function measureLocalCurrentFilmProofFile(root:string,key:string,access:()=>Promise<void>,signal:AbortSignal,expected?:RenderFile,picture?:RenderFile):Promise<RenderFile> {
  signal.throwIfAborted();await audioAbortable(access(),signal);signal.throwIfAborted();const path=filePath(root,key),before=lstatSync(path),sha=createHash("sha256");let bytes=0;
  // Only the preview caller's exact recorded current-film output picture has
  // the larger ceiling. Unmeasured manifests, segments and legacy media retain
  // the ordinary bound before any open/read, not after hashing their contents.
  if(picture&&(!editValidationKey({expected,picture},4096)||!expected||!key.endsWith(".mp4")||picture.path!==key||hash(picture)!==hash(expected)
    ||Object.keys(picture).sort().join(",")!=="bytes,path,sha256"||typeof picture.sha256!=="string"||!/^[a-f0-9]{64}$/.test(picture.sha256)
    ||!Number.isSafeInteger(picture.bytes)||picture.bytes<1||picture.bytes>128*1024**3))fail("Retain the exact measured current-film proof picture.");
  if(before.size<1||before.size>(picture?picture.bytes:8*1024**3))fail("Local proof media exceeds its exact bounded size.");
  if(expected&&(expected.path!==key||before.size!==expected.bytes))fail("Local proof media changed its exact recorded size or path.");
  const handle=await audioAbortable(open(path,"r"),signal,late=>{void late.close().catch(()=>{});});
  try{
    const held=await handle.stat();signal.throwIfAborted();
    if(!held.isFile()||held.dev!==before.dev||held.ino!==before.ino||held.size!==before.size)fail("Local proof media changed while opening its recorded inode.");
    const block=Buffer.alloc(Math.min(1024*1024,before.size));
    while(bytes<before.size){
      signal.throwIfAborted();await audioAbortable(access(),signal);signal.throwIfAborted();
      const {bytesRead}=await audioAbortable(handle.read(block,0,Math.min(block.length,before.size-bytes),null),signal);signal.throwIfAborted();
      if(bytesRead<1)fail("Local proof bytes ended before their recorded size.");bytes+=bytesRead;sha.update(block.subarray(0,bytesRead));
    }
    const openedAfter=await handle.stat();signal.throwIfAborted();const after=lstatSync(filePath(root,key));
    if(bytes!==before.size||openedAfter.dev!==held.dev||openedAfter.ino!==held.ino||openedAfter.size!==before.size
      ||after.dev!==held.dev||after.ino!==held.ino||after.size!==before.size)fail("Local proof media changed its recorded identity.");
    // Candidate selection and preview validation compare this measured digest
    // with their exact metadata; an incomplete candidate may have a valid peer.
    return {path:key,sha256:sha.digest("hex"),bytes};
  }finally{await handle.close();}
}
/** Local preparation uses actual saved jobs and measured files. The durable
 * store's held checkpoint is still separate; callers recheck fresh access and
 * immutable selected metadata immediately before that synchronous commit. */
export async function prepareLocalCurrentFilmProof(job:CurrentFilmMixedJob,store:DurableJobStore,artifactRoot:string,
  project:()=>Promise<Project|null>,access:()=>Promise<void>,references?:Pick<ReferenceBlobStore,"read">,signal?:AbortSignal):Promise<CurrentFilmPreparedProof> {
  const root=realpathSync(artifactRoot);if(lstatSync(artifactRoot).isSymbolicLink())fail("Use a real local proof workspace.");
  return withEditSourceAccess(access,signal,async active=>{
    const saved=await project();if(!saved)fail("The current proof project is unavailable.");
    const target=compileCurrentFilmProofTarget(job),frozenContext=freezeCurrentFilmProofContext({project:proofProject(saved),jobs:store.all().filter(value=>value.projectId===job.projectId)}),
      closure=compileCurrentFilmProofClosure(job.currentFilm,frozenContext,target),carriers=[];
    for(const {receipt,candidates} of closure.receipts){
      let selected:typeof candidates[number]|undefined;
      for(const candidate of candidates){let complete=true;
        for(const file of candidate.files){try{if(lstatSync(filePath(root,file.path)).size!==file.bytes||hash(await measureLocalCurrentFilmProofFile(root,file.path,access,active,file))!==hash(file)){complete=false;break;}}
          catch(error){active.throwIfAborted();if((error as NodeJS.ErrnoException).code!=="ENOENT")throw error;complete=false;break;}}
        if(complete){selected=candidate;break;}
      }
      if(!selected)fail("A required local proof source has no complete measured carrier.");
      const {files:_files,...candidate}=selected;carriers.push({receiptRevision:receipt.revision,...candidate});
    }
    const previews=[];
    for(const {job:preview} of closure.previews){
      const retained=resolveCurrentFilmProofPreviewCarrier(closure,carriers,preview.id);
      if(retained){
        // The selected complete /4 candidate was actually measured above; its
        // nested preview files are copied/hashed again through those same owned
        // paths. Do not reopen an absent original preview directory.
        previews.push({jobId:preview.id,files:validateCurrentFilmProofPreviewFiles(preview,retained.files.map(file=>file.original))});continue;
      }
      const output=preview.output!,known=preview.currentFilm?currentFilmRuntimeRecordedFiles(preview):preview.output!.shotRenders!.flatMap(row=>Object.values(row.files)),keys=new Set(known.map(file=>file.path));
      for(const key of [output.mp4Path,output.hlsPlaylistPath,output.captionsPath,output.captionsPath.slice(0,-4)+".srt",output.manifestPath])keys.add(key);
      if(preview.currentFilm?.schema!=="hv-current-film-job/3")keys.add(`${preview.projectId}/${preview.id}/clips/manifest.json`);
      const prefix=output.hlsPlaylistPath.slice(0,-"index.m3u8".length),directory=opendirSync(dirname(filePath(root,output.hlsPlaylistPath)));let count=0;
      try{for(let entry=directory.readSync();entry;entry=directory.readSync()){if(++count>10001)fail("The local preview index exceeds its complete inventory bound.");keys.add(prefix+entry.name);}}finally{directory.closeSync();}
      const knownFiles=new Map(known.map(file=>[file.path,file]));
      const files=[];for(const key of keys){const expected=knownFiles.get(key),picture=preview.currentFilm&&key===output.mp4Path?expected:undefined;
        files.push(await measureLocalCurrentFilmProofFile(root,key,access,active,expected,picture));}
      previews.push({jobId:preview.id,files:validateCurrentFilmProofPreviewFiles(preview,files)});
    }
    const specification=compileCurrentFilmProofCopies(job.currentFilm,job.id,{frozenContext,carriers,previews,target});assertCurrentFilmProofRetainedCapacity(job,specification);
    const read=async(copy:CurrentFilmProofCopy,inner:AbortSignal):Promise<Response>=>{
      const reference=specification.references.find(group=>group.copy.owned.path===copy.owned.path);
      if(reference&&hash(copy.carrier)===hash(copy.original)){const asset=closure.references.find(group=>group.asset.id===reference.assetId)!.asset,data=await audioAbortable((references??new ReferenceBlobStore(root)).read(asset),inner);
        return new Response(new Uint8Array(data),{headers:{etag:'"'+copy.owned.sha256+'"',"content-length":String(copy.owned.bytes)}});}
      return new Response(Bun.file(filePath(root,copy.carrier.path)).stream(),{headers:{etag:'"'+copy.carrier.sha256+'"',"content-length":String(copy.carrier.bytes)}});
    };
    await prepareCurrentFilmProofCopies(specification,job.currentFilm,job.id,root,read,access,active);
    await verifyCurrentFilmProofMedia(specification,job.currentFilm,job.id,root,access,active);
    const current=await project();if(!current)fail("The current proof project disappeared.");assertCurrentFilmProofProjectPrefix(specification,proofProject(current));
    for(const source of specification.frozenContext.jobs){const actual=store.get(source.id);if(!actual||hash(JSON.parse(JSON.stringify(actual)))!==hash(source))fail("A selected local proof job changed during preparation.");}
    await access();active.throwIfAborted();return createCurrentFilmPreparedProof(job,specification,Date.now());
  });
}

/** Direct originals can be populated from held complete proof after all old
 * carrier directories disappear. Request keys retain their original binding;
 * only the transport maps that exact role to the verified owned proof file. */
export function createCurrentFilmProofOriginsReader(job:CurrentFilmMixedJob,artifactRoot:string,access:()=>Promise<void>,signal?:AbortSignal):DialogueArtifactReader {
  const proof=validateCurrentFilmPreparedProof(job.currentFilmProof!,job).specification,root=realpathSync(artifactRoot),mapping=new Map<string,RenderFile>();
  for(const origin of job.currentFilm.origins){const group=proof.carriers.find(value=>value.receiptRevision===origin.binding.source.revision);if(!group)fail("The held proof lost a required direct original.");
    for(const [index,carrier] of origin.binding.files.entries()){const original=origin.binding.source.files[index]!,copy=group.copies.find(value=>value.original.path===original.path);
      if(!copy||copy.original.bytes!==carrier.bytes||copy.original.sha256!==carrier.sha256)fail("The held proof changed its original carrier correspondence.");
      const previous=mapping.get(carrier.path);if(previous&&(previous.sha256!==copy.owned.sha256||previous.bytes!==copy.owned.bytes))fail("The held proof has conflicting carrier requests.");mapping.set(carrier.path,copy.owned);}
  }
  return {async response(projectId,jobId,key,request){const active=signal?AbortSignal.any([signal,request.signal]):request.signal;active.throwIfAborted();await audioAbortable(access(),active);
    const file=mapping.get(key);if(projectId!==job.projectId||key.split("/")[1]!==jobId||!file)fail("The proof original reader requested an unselected role.");
    return new Response(Bun.file(filePath(root,file.path)).stream(),{headers:{etag:'"'+file.sha256+'"',"content-length":String(file.bytes)}});
  }};
}
