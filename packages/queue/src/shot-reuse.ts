import {createHash} from "node:crypto";
import {contentHash} from "../../generator/src/capabilities";
import {lstatSync,mkdirSync,realpathSync,renameSync,unlinkSync} from "node:fs";
import {resolve,sep} from "node:path";
import type {VideoClip} from "../../generator/src/index";
import {assertSpeechInput,renderInputHash,renderRecord,validateRenderRecord,ShotReuseError,type ShotRenderRecord,type RenderFile} from "../../planner/src/shot-reuse";
import {validateRetainedShotReuse,retainedShotReuseFiles,type RetainedShotReuse} from "../../planner/src/retained-shot-reuse";
import type {Shot} from "../../planner/src/index";
import type {PostgresArtifactStore} from "../../storage/src/artifacts";
import type {Job} from "./index";

function ownedPath(root:string,job:Pick<Job,"projectId"|"id">,path:string):string {
  try{const scope=resolve(root,job.projectId,job.id)+sep,actual=realpathSync(path);
    if(!actual.startsWith(scope)||lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile())throw new Error("outside source");return actual;
  }catch{throw new ShotReuseError("Reusable media is unavailable or outside its source job. Turn off reuse to render fresh shots.");}
}
async function digest(path:string,signal:AbortSignal):Promise<{sha256:string;bytes:number}> {
  const hash=createHash("sha256");let bytes=0;for await(const chunk of Bun.file(path).stream()){signal.throwIfAborted();hash.update(chunk);bytes+=chunk.byteLength;}return {sha256:hash.digest("hex"),bytes};
}
export async function sealShotClip(job:Job,shot:Shot,clip:VideoClip,root:string,signal:AbortSignal):Promise<VideoClip> {
  const file=async(path:string):Promise<RenderFile>=>{const actual=ownedPath(resolve(root),job,path);return {path:actual.slice(resolve(root).length+1).split(sep).join("/"),...await digest(actual,signal)};};
  const {path,audioPath,posterPath,sourcePosterPath,cost:_cost,renderRecord:_record,...metadata}=clip;
  const record=renderRecord({projectId:job.projectId,jobId:job.id,shotId:shot.id,inputHash:renderInputHash(job,shot),clip:metadata,files:{video:await file(path),...(audioPath?{audio:await file(audioPath)}:{}),...(posterPath?{poster:await file(posterPath)}:{}),...(sourcePosterPath?{sourcePoster:await file(sourcePosterPath)}:{})},origin:{jobId:job.id,shotId:shot.id}});
  validateRenderRecord(record,job);assertSpeechInput(record,shot);return {...clip,renderRecord:record};
}
export async function verifySealedClip(job:Job,shot:Shot,clip:VideoClip,root:string,signal:AbortSignal):Promise<void> {
  const saved=clip.renderRecord;if(!saved)throw new ShotReuseError("The resumed shot is missing verified render metadata.");validateRenderRecord(saved,job);
  const actual=(await sealShotClip(job,shot,clip,root,signal)).renderRecord!;
  if(saved.inputHash!==actual.inputHash||contentHash(saved.files)!==contentHash(actual.files)||contentHash(saved.clip)!==contentHash(actual.clip))throw new ShotReuseError("The resumed shot no longer matches its verified media and inputs.");
  const selected=job.shotReuse?.shots.find(r=>r.shotId===shot.id);
  if(selected?(saved.reusedFrom?.revision!==selected.revision||saved.reusedFrom.jobId!==selected.jobId||contentHash(saved.origin)!==contentHash(selected.origin)):Boolean(saved.reusedFrom))throw new ShotReuseError("The resumed shot differs from its admitted reuse plan.");
}
export async function copyReusableClip(record:ShotRenderRecord,job:Job,root:string,signal:AbortSignal,artifacts?:Pick<PostgresArtifactStore,"response">,context?:RetainedShotReuse):Promise<VideoClip> {
  signal.throwIfAborted();
  const retained=context===undefined?undefined:validateRetainedShotReuse(context);
  if(retained&&(retained.binding.owner.projectId!==job.projectId||contentHash(retained.record)!==contentHash(record)))throw new ShotReuseError("The retained shot context differs from the admitted original or destination project.");
  validateRenderRecord(record,{projectId:job.projectId,id:record.jobId});
  const sourceJobId=retained?.binding.owner.jobId??record.jobId,sourceFiles=retained?retainedShotReuseFiles(retained):record.files,directory=resolve(root,job.projectId,job.id,"clips");mkdirSync(directory,{recursive:true});
  if(!realpathSync(directory).startsWith(resolve(root,job.projectId,job.id)+sep))throw new ShotReuseError("Reuse destination escaped its job.");
  const files:ShotRenderRecord["files"]={} as ShotRenderRecord["files"];
  for(const [kind,file]of Object.entries(sourceFiles)){
    signal.throwIfAborted();const path=resolve(directory,record.shotId+"-reused-"+kind+(kind==="video"?".mp4":kind==="audio"?".wav":".png")),temporary=path+"."+crypto.randomUUID()+".copy";
    let stream:ReadableStream<Uint8Array>;
    if(artifacts){const response=await artifacts.response(job.projectId,sourceJobId,file.path,new Request("http://127.0.0.1/internal-reuse",{signal}));
      if(!response?.ok||response.headers.get("etag")!=='"'+file.sha256+'"'||Number(response.headers.get("content-length"))!==file.bytes||!response.body)throw new ShotReuseError("Stored reusable media changed or disappeared. Turn off reuse to render fresh shots.");stream=response.body;
    }else stream=Bun.file(ownedPath(resolve(root),{projectId:job.projectId,id:sourceJobId},resolve(root,file.path))).stream();
    const writer=Bun.file(temporary).writer(),hash=createHash("sha256");let bytes=0;
    try{for await(const chunk of stream){signal.throwIfAborted();bytes+=chunk.byteLength;if(bytes>file.bytes)throw new ShotReuseError("Reusable media exceeds its recorded size.");hash.update(chunk);writer.write(chunk);await writer.flush();}
      await writer.end();if(bytes!==file.bytes||hash.digest("hex")!==file.sha256)throw new ShotReuseError("Reusable media failed checksum verification. Turn off reuse to render fresh shots.");renameSync(temporary,path);
    }catch(error){await writer.end();try{unlinkSync(temporary);}catch{}throw error;}
    files[kind as keyof typeof files]={...file,path:path.slice(resolve(root).length+1).split(sep).join("/")};
  }
  const copied=renderRecord({projectId:job.projectId,jobId:job.id,shotId:record.shotId,inputHash:record.inputHash,clip:record.clip,files,origin:record.origin,reusedFrom:{jobId:record.jobId,shotId:record.shotId,revision:record.revision}});
  validateRenderRecord(copied,job);
  return {...record.clip,path:resolve(root,files.video.path),...(files.audio?{audioPath:resolve(root,files.audio.path)}:{}),...(files.poster?{posterPath:resolve(root,files.poster.path)}:{}),...(files.sourcePoster?{sourcePosterPath:resolve(root,files.sourcePoster.path)}:{}),
    cost:{provider:record.clip.provider,model:record.clip.model,prompt_tokens:0,output_frames:0,gpu_seconds:0,total_cost_usd:0},renderRecord:copied};
}
