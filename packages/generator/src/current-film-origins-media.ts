import {lstatSync,mkdirSync,realpathSync} from "node:fs";
import {join} from "node:path";
import {compileCurrentFilmOrigins,validateCurrentFilmOrigins,type CurrentFilmOrigins} from "../../planner/src/current-film-origins";
import {validateCurrentFilmMixedJobPlan,type CurrentFilmJobV3} from "../../planner/src/current-film-mixed-jobs";
import type {RenderFile} from "../../planner/src/shot-reuse";
import {verifyCurrentFilmMedia} from "../../queue/src/current-film-media";
import {contentHash as hash} from "./capabilities";
import {audioAbortable} from "./audio-stream";
import type {DialogueArtifactReader} from "./dialogue-replacement";
import {editWorkspaceGuard} from "./edit-workspace";
import {withEditSourceAccess} from "./edit-source-media";
import {soundDigest} from "./sound-media";
import {currentFilmV2Job} from "../../planner/src/current-film-job-context";
import {prepareCurrentFilmCopyFiles} from "./current-film-copy-publication";
import {provenanceMatches,provenanceShotRecords} from "../../planner/src/provenance";

type Access=()=>Promise<void>;
function fail(message:string):never {throw new Error(message);}
function rootPath(path:string):string {
  const stat=lstatSync(path);if(stat.isSymbolicLink()||!stat.isDirectory())fail("Use a real current-film originals workspace.");return realpathSync(path);
}
/** No component may redirect even to a different location inside the same root. */
function components(root:string,key:string,create=false):string {
  if(!/^[A-Za-z0-9._/-]+$/.test(key)||key.split("/").some(part=>!part||part==="."||part===".."))fail("Current-film originals escaped their owner.");
  let path=root;
  for(const part of key.split("/")){path=join(path,part);if(create)try{mkdirSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
    const stat=lstatSync(path);if(stat.isSymbolicLink()||realpathSync(path)!==path||create&&!stat.isDirectory())fail("Current-film originals refuse linked or unavailable paths.");}
  return path;
}
function ownedFile(root:string,file:RenderFile):string {
  const path=components(root,file.path),stat=lstatSync(path);if(!stat.isFile()||stat.size!==file.bytes)fail("Current-film original media is missing or changed.");return path;
}
function cancel(body:ReadableStream<Uint8Array>|null|undefined):void {void body?.cancel().catch(()=>{});}
async function sourceResponse(plan:CurrentFilmJobV3,originIndex:number,copyIndex:number,root:string,access:Access,signal:AbortSignal,reader?:DialogueArtifactReader):Promise<Response> {
  signal.throwIfAborted();await audioAbortable(access(),signal);const origin=plan.origins[originIndex]!,file=origin.binding.files[copyIndex]!;
  const response=reader?await audioAbortable(reader.response(plan.projectId,origin.binding.owner.jobId,file.path,
    new Request("http://127.0.0.1/internal-current-film-originals",{signal})),signal,late=>cancel(late?.body))
    :new Response(Bun.file(ownedFile(root,file)).stream(),{headers:{etag:'"'+file.sha256+'"',"content-length":String(file.bytes)}});
  if(!response?.ok||!response.body||response.headers.get("etag")!=='"'+file.sha256+'"'||Number(response.headers.get("content-length"))!==file.bytes){cancel(response?.body);fail("The authenticated current-film original carrier changed or disappeared.");}
  return response;
}
async function verifyOrigin(plan:CurrentFilmJobV3,value:CurrentFilmOrigins,index:number,root:string,access:Access,signal:AbortSignal):Promise<void> {
  const origin=value.origins[index]!,binding=plan.origins[index]!.binding;
  for(const copy of origin.copies){signal.throwIfAborted();await audioAbortable(access(),signal);const actual=await soundDigest(ownedFile(root,copy.owned),signal);
    if(actual.bytes!==copy.owned.bytes||actual.sha256!==copy.owned.sha256)fail("The owned current-film original failed independent checksum verification.");}
  const namespace=components(root,`${value.projectId}/${value.jobId}/originals/${origin.originId}`),job=currentFilmV2Job(binding.source.job);
  await audioAbortable(access(),signal);await verifyCurrentFilmMedia(job,namespace,signal);await audioAbortable(access(),signal);
  const manifest=origin.copies.find(copy=>copy.original.path===job.output!.manifestPath)!,video=origin.copies.find(copy=>copy.original.path===job.output!.mp4Path)!;
  if(manifest.owned.bytes>32*1024**2)fail("The retained current-film original provenance exceeds its metadata capacity.");
  const provenance=JSON.parse(await Bun.file(ownedFile(root,manifest.owned)).text());signal.throwIfAborted();
  if(!provenanceMatches(provenance,{projectId:job.projectId,sha256:video.original.sha256})
    ||hash(provenanceShotRecords(provenance))!==hash(job.output!.currentFilm!.records.map(row=>row.record)))fail("The retained current-film original differs from its picture provenance.");
  await audioAbortable(access(),signal);signal.throwIfAborted();
}

/** Prepare every direct original idempotently. Exact existing bytes are retained,
 * missing files are atomically published without overwrite, and all actual media
 * is verified before return. Only a later held checkpoint establishes custody. */
export async function copyCurrentFilmOrigins(raw:CurrentFilmJobV3,jobId:string,artifactRoot:string,access:Access,signal?:AbortSignal,reader?:DialogueArtifactReader):Promise<CurrentFilmOrigins> {
  signal?.throwIfAborted();const plan=validateCurrentFilmMixedJobPlan(raw),value=compileCurrentFilmOrigins(plan,jobId),root=rootPath(artifactRoot);
  const copies=value.origins.flatMap((origin,originIndex)=>origin.copies.map((copy,copyIndex)=>({copy,originIndex,copyIndex}))),byPath=new Map(copies.map(row=>[row.copy.owned.path,row]));
  return withEditSourceAccess(access,signal,async active=>{
    await audioAbortable(access(),active);if(!copies.length)return value;
    await prepareCurrentFilmCopyFiles(root,{projectId:value.projectId,jobId,jobPlanRevision:plan.revision,kind:"origins",ordinal:null,specificationRevision:value.revision},
      copies.map(row=>row.copy.owned),async(file,inner)=>{const row=byPath.get(file.path)!;return sourceResponse(plan,row.originIndex,row.copyIndex,root,access,inner,reader);},access,active);
    for(let index=0;index<value.origins.length;index++)await verifyOrigin(plan,value,index,root,access,active);
    await audioAbortable(access(),active);active.throwIfAborted();return value;
  });
}
/** Restored verification reads target-owned original namespaces only. It never
 * needs the old original/carrier directory and never repairs or deletes files. */
export async function verifyCurrentFilmOriginsMedia(value:CurrentFilmOrigins,raw:CurrentFilmJobV3,jobId:string,artifactRoot:string,access:Access,signal?:AbortSignal):Promise<void> {
  signal?.throwIfAborted();const plan=validateCurrentFilmMixedJobPlan(raw),checked=validateCurrentFilmOrigins(value,plan,jobId),root=rootPath(artifactRoot),active=signal??new AbortController().signal;
  const total=checked.origins.reduce((sum,origin)=>sum+origin.copies.reduce((bytes,copy)=>bytes+copy.owned.bytes,0),0),count=checked.origins.reduce((sum,origin)=>sum+origin.copies.length,0);
  const check=()=>audioAbortable(Promise.resolve().then(access),active);
  await withEditSourceAccess(check,active,async inner=>{
    if(!checked.origins.length)return;
    const directory=components(root,`${checked.projectId}/${checked.jobId}/originals`),guard=editWorkspaceGuard(root,()=>[directory],{bytes:total,files:count});
    const current=async()=>{inner.throwIfAborted();guard();await audioAbortable(check(),inner);inner.throwIfAborted();};
    for(let index=0;index<checked.origins.length;index++)await verifyOrigin(plan,checked,index,root,current,inner);
    await current();
  });
}
