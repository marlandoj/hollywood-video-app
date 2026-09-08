import {lstatSync,mkdirSync,mkdtempSync,realpathSync,rmSync} from "node:fs";
import {open,type FileHandle} from "node:fs/promises";
import {createHash} from "node:crypto";
import {dirname,join,resolve,sep} from "node:path";
import {compileCurrentFilmAdoption,validateCurrentFilmAdoption,type CurrentFilmAdoption} from "../../planner/src/current-film-adoption";
import {resolveCurrentFilmMixedReuse,type CurrentFilmJobV3} from "../../planner/src/current-film-mixed-jobs";
import type {RenderFile} from "../../planner/src/shot-reuse";
import {verifyCurrentFilmClip} from "../../queue/src/current-film-media";
import {audioAbortable} from "./audio-stream";
import {copyDialogueFiles,type DialogueArtifactReader} from "./dialogue-replacement";
import {assertEditFreeSpace,editWorkspaceGuard} from "./edit-workspace";
import {withEditSourceAccess} from "./edit-source-media";
import {soundDigest} from "./sound-media";

type Access=()=>Promise<void>;
function fail(message:string):never {throw new Error(message);}
function rootPath(path:string):string {
  if(lstatSync(path).isSymbolicLink()||!lstatSync(path).isDirectory())fail("Use a real current-film adoption workspace.");return realpathSync(path);
}
/** Check every component, including links that resolve inside the same owner. */
function components(root:string,key:string,create=false):string {
  if(!/^[A-Za-z0-9._/-]+$/.test(key)||key.split("/").some(part=>!part||part==="."||part===".."))fail("Current-film adoption escaped its owner.");
  let path=root;
  for(const part of key.split("/")){path=join(path,part);if(create)try{mkdirSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
    const stat=lstatSync(path);if(stat.isSymbolicLink()||realpathSync(path)!==path||create&&!stat.isDirectory())fail("Current-film adoption refuses linked or unavailable paths.");}
  return path;
}
function ownedFile(root:string,file:RenderFile):string {
  const path=components(root,file.path),stat=lstatSync(path);if(!stat.isFile()||stat.size!==file.bytes)fail("Current-film adoption media is missing or changed.");return path;
}
function removeOwned(root:string,path:string,identity:{dev:number;ino:number}):void {
  const stat=lstatSync(path);if(!path.startsWith(root+sep)||realpathSync(path)!==path||stat.isSymbolicLink()||!stat.isDirectory()||stat.dev!==identity.dev||stat.ino!==identity.ino)fail("Current-film adoption cleanup lost its created directory.");
  rmSync(path,{recursive:true,force:true});
}
function boundedBody(body:ReadableStream<Uint8Array>,access:Access,signal:AbortSignal):ReadableStream<Uint8Array> {
  const reader=body.getReader();let stopped=false;
  const stop=()=>{if(stopped)return;stopped=true;void reader.cancel().catch(()=>{});};
  return new ReadableStream<Uint8Array>({async pull(controller){try{
    signal.throwIfAborted();await audioAbortable(access(),signal);const next=await audioAbortable(reader.read(),signal);
    signal.throwIfAborted();if(next.done){stop();controller.close();}else controller.enqueue(next.value);
  }catch(error){stop();controller.error(error);}},cancel(){stop();}});
}
function mappedReader(adoption:CurrentFilmAdoption,root:string,access:Access,signal:AbortSignal,fromOwned:boolean,reader?:DialogueArtifactReader):DialogueArtifactReader {
  const originalJob=adoption.copies[0]!.original.path.split("/")[1]!;
  return {async response(projectId,jobId,key){
    signal.throwIfAborted();await audioAbortable(access(),signal);
    const copy=adoption.copies.find(value=>value.original.path===key);
    if(projectId!==adoption.projectId||jobId!==originalJob||!copy)fail("The adoption reader requested an unselected original role.");
    const file=fromOwned?copy.owned:copy.carrier;let response:Response|null;
    if(reader&&!fromOwned){response=await audioAbortable(reader.response(projectId,file.path.split("/")[1]!,file.path,new Request("http://127.0.0.1/internal-current-film-adoption",{signal})),signal,late=>{void late?.body?.cancel().catch(()=>{});});}
    else response=new Response(Bun.file(ownedFile(root,file)).stream(),{headers:{etag:'"'+file.sha256+'"',"content-length":String(file.bytes)}});
    if(!response?.ok||!response.body||response.headers.get("etag")!=='"'+file.sha256+'"'||Number(response.headers.get("content-length"))!==file.bytes){void response?.body?.cancel().catch(()=>{});fail("The authenticated adoption carrier changed or disappeared.");}
    return new Response(boundedBody(response.body,access,signal),{headers:response.headers});
  }};
}
async function verifyOwned(adoption:CurrentFilmAdoption,root:string,access:Access,signal:AbortSignal):Promise<void> {
  for(const copy of adoption.copies){signal.throwIfAborted();await audioAbortable(access(),signal);const actual=await soundDigest(ownedFile(root,copy.owned),signal);
    if(actual.bytes!==copy.owned.bytes||actual.sha256!==copy.owned.sha256)fail("The owned adoption role failed independent checksum verification.");}
  signal.throwIfAborted();
}
async function publishRole(source:string,destination:string,file:RenderFile,access:Access,signal:AbortSignal):Promise<void> {
  const incoming=await open(source,"r");let output:FileHandle|undefined;
  try{signal.throwIfAborted();output=await open(destination,"wx");const buffer=Buffer.alloc(64*1024),checksum=createHash("sha256");let bytes=0;
    while(true){signal.throwIfAborted();await audioAbortable(access(),signal);signal.throwIfAborted();const {bytesRead:length}=await incoming.read(buffer,0,buffer.length,null);if(!length)break;
      bytes+=length;if(bytes>file.bytes)fail("The adoption publication exceeds its recorded size.");checksum.update(buffer.subarray(0,length));
      for(let offset=0;offset<length;){signal.throwIfAborted();const {bytesWritten:written}=await output.write(buffer,offset,length-offset);if(written<1)fail("The adoption publication could not write its complete role.");offset+=written;}
    }
    if(bytes!==file.bytes||checksum.digest("hex")!==file.sha256)fail("The adoption publication changed its recorded bytes.");signal.throwIfAborted();
  }finally{try{await incoming.close();}finally{await output?.close();}}
}
function evidence(plan:CurrentFilmJobV3,adoption:CurrentFilmAdoption){
  const resolved=resolveCurrentFilmMixedReuse(plan,adoption.target.ordinal),job=resolved.retained.binding.source.job;
  const record=job.currentFilmCheckpoint!.rows[adoption.sourceSelector.ordinal]!.record,slot=job.currentFilm!.materialization.slots[adoption.sourceSelector.ordinal]!;
  return {job,record,slot};
}
async function verifyOriginalNamespace(context:ReturnType<typeof evidence>,root:string,signal:AbortSignal):Promise<void> {
  const {job,record,slot}=context,files=record.files;
  await verifyCurrentFilmClip({projectId:job.projectId,id:job.id},slot,{...record.clip,path:resolve(root,files.video.path),
    ...(files.audio?{audioPath:resolve(root,files.audio.path)}:{}),...(files.poster?{posterPath:resolve(root,files.poster.path)}:{}),...(files.sourcePoster?{sourcePosterPath:resolve(root,files.sourcePoster.path)}:{}),
    cost:{provider:record.clip.provider,model:record.clip.model,prompt_tokens:0,output_frames:0,gpu_seconds:0,total_cost_usd:0},renderRecord:record},root,signal);
}

/** Copy only the reviewed roles. The caller supplies current source/target authority;
 * an authenticated reader supplies carrier bytes, never a substitute source record.
 * The reserved slot is returned only when complete and removed on any failure. */
export async function copyCurrentFilmAdoption(plan:CurrentFilmJobV3,jobId:string,ordinal:number,artifactRoot:string,access:Access,signal?:AbortSignal,reader?:DialogueArtifactReader):Promise<CurrentFilmAdoption> {
  signal?.throwIfAborted();const adoption=compileCurrentFilmAdoption(plan,jobId,ordinal),context=evidence(plan,adoption),root=rootPath(artifactRoot),active=signal??new AbortController().signal;
  const total=adoption.copies.reduce((sum,copy)=>sum+copy.owned.bytes,0);assertEditFreeSpace(root,total*2);
  const check=()=>audioAbortable(Promise.resolve().then(access),active);let destination:string|undefined,scratch:string|undefined,destinationIdentity:{dev:number;ino:number}|undefined,scratchIdentity:{dev:number;ino:number}|undefined;
  try{return await withEditSourceAccess(check,active,async inner=>{
    const parent=components(root,`${adoption.projectId}/${jobId}/reused`,true),slot=dirname(adoption.copies[0]!.owned.path);
    destination=resolve(root,slot);mkdirSync(destination);destinationIdentity=lstatSync(destination);
    scratch=mkdtempSync(join(parent,".adoption-"));scratchIdentity=lstatSync(scratch);
    const guard=editWorkspaceGuard(root,()=>[destination!,scratch!],{bytes:total*2,files:adoption.copies.length*2});
    const current=async()=>{inner.throwIfAborted();guard();await audioAbortable(check(),inner);inner.throwIfAborted();components(root,slot);};
    await copyDialogueFiles(context.job,adoption.copies.map(copy=>copy.original),root,scratch,inner,mappedReader(adoption,root,current,inner,false,reader));
    await current();await verifyOriginalNamespace(context,scratch,inner);
    for(const copy of adoption.copies){await current();await publishRole(ownedFile(scratch,copy.original),resolve(root,copy.owned.path),copy.owned,current,inner);}
    await verifyOwned(adoption,root,current,inner);await current();return adoption;
  });}catch(error){if(destination&&destinationIdentity)removeOwned(root,destination,destinationIdentity);throw error;
  }finally{if(scratch&&scratchIdentity)removeOwned(root,scratch,scratchIdentity);}
}

/** Independent restored verification uses target-owned bytes only. No original or
 * carrier directory is required, and no original record/capture is rewritten. */
export async function verifyCurrentFilmAdoptionMedia(value:CurrentFilmAdoption,plan:CurrentFilmJobV3,jobId:string,artifactRoot:string,access:Access,signal?:AbortSignal):Promise<void> {
  signal?.throwIfAborted();const adoption=validateCurrentFilmAdoption(value,plan,jobId),context=evidence(plan,adoption),root=rootPath(artifactRoot),active=signal??new AbortController().signal;
  const total=adoption.copies.reduce((sum,copy)=>sum+copy.owned.bytes,0);assertEditFreeSpace(root,total);
  const check=()=>audioAbortable(Promise.resolve().then(access),active);let scratch:string|undefined,identity:{dev:number;ino:number}|undefined;
  try{await withEditSourceAccess(check,active,async inner=>{
    for(const copy of adoption.copies)ownedFile(root,copy.owned);
    const parent=components(root,`${adoption.projectId}/${jobId}/reused`);scratch=mkdtempSync(join(parent,".adoption-verify-"));identity=lstatSync(scratch);
    const guard=editWorkspaceGuard(root,()=>[scratch!],{bytes:total,files:adoption.copies.length});
    const current=async()=>{inner.throwIfAborted();guard();await audioAbortable(check(),inner);inner.throwIfAborted();};
    await verifyOwned(adoption,root,current,inner);
    await copyDialogueFiles(context.job,adoption.copies.map(copy=>copy.original),root,scratch,inner,mappedReader(adoption,root,current,inner,true));
    await current();await verifyOriginalNamespace(context,scratch,inner);await current();
  });}finally{if(scratch&&identity)removeOwned(root,scratch,identity);}
}
