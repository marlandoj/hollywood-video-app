import {lstatSync,mkdirSync,mkdtempSync,realpathSync,rmSync} from "node:fs";
import {join,resolve,sep} from "node:path";
import {compileCurrentFilmAdoption,validateCurrentFilmAdoption,type CurrentFilmAdoption} from "../../planner/src/current-film-adoption";
import {resolveCurrentFilmMixedReuse,type CurrentFilmJobV3} from "../../planner/src/current-film-mixed-jobs";
import type {RenderFile} from "../../planner/src/shot-reuse";
import {verifyCurrentFilmClip} from "../../queue/src/current-film-media";
import {audioAbortable} from "./audio-stream";
import {copyDialogueFiles,type DialogueArtifactReader} from "./dialogue-replacement";
import {assertEditFreeSpace,editWorkspaceGuard} from "./edit-workspace";
import {withEditSourceAccess} from "./edit-source-media";
import {soundDigest} from "./sound-media";
import {currentFilmV2Job} from "../../planner/src/current-film-job-context";
import {prepareCurrentFilmCopyFiles} from "./current-film-copy-publication";

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
function evidence(plan:CurrentFilmJobV3,adoption:CurrentFilmAdoption){
  const resolved=resolveCurrentFilmMixedReuse(plan,adoption.target.ordinal),job=currentFilmV2Job(resolved.retained.binding.source.job);
  const record=job.currentFilmCheckpoint!.rows[adoption.sourceSelector.ordinal]!.record,slot=job.currentFilm!.materialization.slots[adoption.sourceSelector.ordinal]!;
  return {job,record,slot};
}
async function verifyOriginalNamespace(context:ReturnType<typeof evidence>,root:string,signal:AbortSignal):Promise<void> {
  const {job,record,slot}=context,files=record.files;
  await verifyCurrentFilmClip({projectId:job.projectId,id:job.id},slot,{...record.clip,path:resolve(root,files.video.path),
    ...(files.audio?{audioPath:resolve(root,files.audio.path)}:{}),...(files.poster?{posterPath:resolve(root,files.poster.path)}:{}),...(files.sourcePoster?{sourcePosterPath:resolve(root,files.sourcePoster.path)}:{}),
    renderRecord:record},root,signal);
}

/** Prepare exact reviewed roles idempotently without overwriting published bytes.
 * Complete native evidence is checked from owned files even on a recovered copy;
 * the caller's later held checkpoint remains the only custody boundary. */
export async function copyCurrentFilmAdoption(plan:CurrentFilmJobV3,jobId:string,ordinal:number,artifactRoot:string,access:Access,signal?:AbortSignal,reader?:DialogueArtifactReader):Promise<CurrentFilmAdoption> {
  signal?.throwIfAborted();const adoption=compileCurrentFilmAdoption(plan,jobId,ordinal),root=rootPath(artifactRoot);
  return withEditSourceAccess(access,signal,async active=>{
    const source=mappedReader(adoption,root,access,active,false,reader),originalJob=adoption.copies[0]!.original.path.split("/")[1]!;
    await prepareCurrentFilmCopyFiles(root,{projectId:adoption.projectId,jobId,jobPlanRevision:adoption.jobPlanRevision,kind:"adoption",ordinal,specificationRevision:adoption.revision},
      adoption.copies.map(copy=>copy.owned),async(file,inner)=>{const copy=adoption.copies.find(value=>value.owned.path===file.path)!;
        const response=await source.response(adoption.projectId,originalJob,copy.original.path,new Request("http://127.0.0.1/internal-current-film-adoption",{signal:inner}));
        if(!response)fail("The selected adoption carrier disappeared.");return response;},access,active);
    await verifyCurrentFilmAdoptionMedia(adoption,plan,jobId,root,access,active);
    await audioAbortable(access(),active);active.throwIfAborted();return adoption;
  });
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
    const guard=editWorkspaceGuard(root,()=>[scratch!],{bytes:total,files:adoption.copies.length}),jobGuard=editWorkspaceGuard(root,()=>[components(root,`${adoption.projectId}/${jobId}`)]);
    const current=async()=>{inner.throwIfAborted();guard();jobGuard();await audioAbortable(check(),inner);inner.throwIfAborted();};
    await verifyOwned(adoption,root,current,inner);
    await copyDialogueFiles(context.job,adoption.copies.map(copy=>copy.original),root,scratch,inner,mappedReader(adoption,root,current,inner,true));
    await current();await verifyOriginalNamespace(context,scratch,inner);await current();
  });}finally{if(scratch&&identity)removeOwned(root,scratch,identity);}
}
