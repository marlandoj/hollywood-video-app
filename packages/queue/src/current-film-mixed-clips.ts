import {createHash} from "node:crypto";
import {lstatSync,realpathSync} from "node:fs";
import {join} from "node:path";
import type {VideoClip} from "../../generator/src/index";
import type {DialogueArtifactReader} from "../../generator/src/dialogue-replacement";
import {audioAbortable} from "../../generator/src/audio-stream";
import {contentHash} from "../../generator/src/capabilities";
import {compileCurrentFilmAdoption} from "../../planner/src/current-film-adoption";
import {currentFilmMixedRecordedFiles,validateCurrentFilmMixedJob,type CurrentFilmMixedJob} from "../../planner/src/current-film-mixed-job-context";
import {resolveCurrentFilmMixedReuse} from "../../planner/src/current-film-mixed-jobs";
import {currentFilmV2Job} from "../../planner/src/current-film-job-context";
import type {RenderFile,ShotRenderRecord} from "../../planner/src/shot-reuse";

export interface CurrentFilmMixedClip {
  kind:"generated"|"reused";
  target:{ordinal:number;logicalShotId:string;renderId:string;inputRevision:string};
  originalRecord:ShotRenderRecord;
  /** Worker-local media only. Neither a new render receipt nor a cost event. */
  clip:Omit<VideoClip,"cost"|"renderRecord">;
}
function fail(message:string):never {throw new Error(message);}
function rootPath(path:string):string {
  const stat=lstatSync(path);if(stat.isSymbolicLink()||!stat.isDirectory())fail("Use a real mixed current-film clip workspace.");return realpathSync(path);
}
function owned(root:string,file:RenderFile):string {
  if(!/^[A-Za-z0-9._/-]+$/.test(file.path)||file.path.split("/").some(part=>!part||part==="."||part===".."))fail("Mixed current-film clips escaped their owned namespace.");
  let path=root;
  for(const part of file.path.split("/")){path=join(path,part);if(lstatSync(path).isSymbolicLink()||realpathSync(path)!==path)fail("Mixed current-film clips refuse linked media components.");}
  const stat=lstatSync(path);if(!stat.isFile()||stat.size!==file.bytes)fail("The owned mixed current-film role is missing or changed.");return path;
}
function checked(raw:CurrentFilmMixedJob):CurrentFilmMixedJob {
  validateCurrentFilmMixedJob(raw);
  // Replays prepared originals and the complete held prefix, including its new
  // route journal. This is metadata validation, never a substitute for media checks.
  currentFilmMixedRecordedFiles(raw);return structuredClone(raw);
}
/** Call verifyCurrentFilmMixedMedia first under the same held job/access scope.
 * No local clips manifest is consulted, and no original receipt is relabeled. */
export function resolveCurrentFilmMixedClips(raw:CurrentFilmMixedJob,artifactRoot:string):CurrentFilmMixedClip[] {
  const job=checked(raw),root=rootPath(artifactRoot);
  return (job.currentFilmCheckpoint?.rows??[]).map(row=>{
    const {ordinal,logicalShotId,renderId,inputRevision}=row;
    const record=row.kind==="generated"?row.record:currentFilmV2Job(resolveCurrentFilmMixedReuse(job.currentFilm,ordinal).retained.binding.source.job).currentFilmCheckpoint!.rows[row.adoption.sourceSelector.ordinal]!.record;
    const files=row.kind==="generated"?row.record.files:Object.fromEntries(row.adoption.copies.map(copy=>[copy.role,copy.owned])) as ShotRenderRecord["files"];
    const clip={...record.clip,path:owned(root,files.video),...(files.audio?{audioPath:owned(root,files.audio)}:{}),
      ...(files.poster?{posterPath:owned(root,files.poster)}:{}),...(files.sourcePoster?{sourcePosterPath:owned(root,files.sourcePoster)}:{})};
    return {kind:row.kind,target:{ordinal,logicalShotId,renderId,inputRevision},originalRecord:record,clip};
  });
}

/** An exact selected-role reader over already prepared full originals. The held
 * job supplies custody; access remains current on each request and body pull.
 * This does not contact old carriers or make a new authority/approval claim. */
export function createCurrentFilmPreparedAdoptionReader(raw:CurrentFilmMixedJob,artifactRoot:string,access:()=>Promise<void>,signal?:AbortSignal):DialogueArtifactReader {
  signal?.throwIfAborted();if(typeof access!=="function")fail("Supply current mixed current-film access.");
  const job=checked(raw),root=rootPath(artifactRoot),selected=new Map<string,{carrier:RenderFile;owned:RenderFile}>();
  for(const selection of job.currentFilm.selection){
    if(selection.kind!=="reuse")continue;
    const adoption=compileCurrentFilmAdoption(job.currentFilm,job.id,selection.ordinal),origin=job.currentFilmOrigins!.origins.find(value=>value.originId===adoption.originId)!;
    for(const role of adoption.copies){
      const copy=origin.copies.find(value=>value.original.path===role.original.path);
      if(!copy||contentHash(copy.original)!==contentHash(role.original)||contentHash(copy.carrier)!==contentHash(role.carrier))fail("Prepared current-film originals lost their selected carrier mapping.");
      const previous=selected.get(copy.carrier.path);
      if(previous&&(previous.carrier.sha256!==copy.carrier.sha256||previous.carrier.bytes!==copy.carrier.bytes))fail("Selected current-film carrier roles have conflicting bytes.");
      if(!previous)selected.set(copy.carrier.path,{carrier:copy.carrier,owned:copy.owned});
    }
  }
  return {async response(projectId,jobId,key,request){
    const active=signal?AbortSignal.any([signal,request.signal]):request.signal;active.throwIfAborted();
    const copy=selected.get(key);
    if(request.method!=="GET"||projectId!==job.projectId||!copy||jobId!==copy.carrier.path.split("/")[1])fail("The prepared reader requested an unselected current-film carrier role.");
    await audioAbortable(Promise.resolve().then(access),active);active.throwIfAborted();
    const path=owned(root,copy.owned),input=Bun.file(path).stream().getReader(),sum=createHash("sha256");let bytes=0,closed=false;
    let abort:()=>void;
    const stop=()=>{if(closed)return;closed=true;active.removeEventListener("abort",abort);void input.cancel().then(()=>input.releaseLock()).catch(()=>{});};
    const body=new ReadableStream<Uint8Array>({
      start(controller){abort=()=>{stop();controller.error(active.reason);};active.addEventListener("abort",abort,{once:true});if(active.aborted)abort();},
      async pull(controller){try{
        active.throwIfAborted();await audioAbortable(Promise.resolve().then(access),active);active.throwIfAborted();
        const next=await audioAbortable(input.read(),active);active.throwIfAborted();
        if(next.done){
          if(bytes!==copy.owned.bytes||sum.digest("hex")!==copy.owned.sha256)fail("The prepared current-film original failed recorded checksum verification.");
          owned(root,copy.owned);stop();controller.close();
        }else{bytes+=next.value.byteLength;if(bytes>copy.owned.bytes)fail("The prepared current-film original exceeds its recorded size.");sum.update(next.value);controller.enqueue(next.value);}
      }catch(error){stop();if(!active.aborted)controller.error(error);}},
      cancel(){stop();},
    },{highWaterMark:0});
    return new Response(body,{headers:{etag:'"'+copy.carrier.sha256+'"',"content-length":String(copy.carrier.bytes)}});
  }};
}
