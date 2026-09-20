import {createHash} from "node:crypto";
import {lstatSync,mkdirSync,realpathSync,renameSync,rmSync} from "node:fs";
import {resolve,sep} from "node:path";
import type {VideoClip} from "../../generator/src/index";
import {assertSpeechInput,validateRenderRecord,type ShotRenderRecord} from "../../planner/src/shot-reuse";
import type {Shot} from "../../planner/src/index";
import type {PostgresArtifactStore} from "../../storage/src/artifacts";
import type {Job} from "./index";

/**
 * HV-022-01: a final shot keeps the approved rough cut's dialogue.
 *
 * The paid final providers render picture only (Kling is asked for no audio), so every studio
 * final was silent. The creator approved the rough cut *with* its spoken lines, and the crew
 * paces each final shot to the same length (HV-017-05). When a final shot has no sound of its
 * own and the approved rough cut's shot has a speech receipt for exactly this shot's lines and
 * exactly this length, that verified voice track is laid under the final picture. Any other silent
 * shot gets a silent track and is marked "silent-captioned", as the rough cut's silent shots are.
 */
export function roughCutDialogue(animatic:Job|undefined,shot:Shot,clip:VideoClip):ShotRenderRecord|undefined {
  if(!animatic?.output?.shotRenders||clip.audioPath||clip.speech||clip.audioMode)return undefined;
  const record=animatic.output.shotRenders.find(value=>value.shotId===shot.id);
  if(!record?.clip.speech||!record.files.audio||record.clip.audioMode!=="provided")return undefined;
  if(Math.round(record.clip.durationSec*30)!==Math.round(clip.durationSec*30))return undefined;
  try{validateRenderRecord(record,animatic);assertSpeechInput(record,shot);}catch{return undefined;}
  return record;
}

async function copyVerified(record:ShotRenderRecord,job:Job,root:string,target:string,signal:AbortSignal,artifacts?:Pick<PostgresArtifactStore,"response">):Promise<void> {
  const file=record.files.audio!;
  let stream:ReadableStream<Uint8Array>;
  if(artifacts){
    const response=await artifacts.response(job.projectId,record.jobId,file.path,new Request("http://127.0.0.1/internal-dialogue",{signal}));
    if(!response?.ok||!response.body)throw new Error("The approved rough cut's dialogue is unavailable.");
    stream=response.body;
  }else{
    const scope=resolve(root,job.projectId,record.jobId)+sep,path=resolve(root,file.path),actual=realpathSync(path);
    if(!actual.startsWith(scope)||lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile())throw new Error("The approved rough cut's dialogue is outside its job.");
    stream=Bun.file(actual).stream();
  }
  const temporary=target+"."+crypto.randomUUID()+".copy",writer=Bun.file(temporary).writer(),hash=createHash("sha256");let bytes=0;
  try{
    for await(const chunk of stream){signal.throwIfAborted();bytes+=chunk.byteLength;if(bytes>file.bytes)throw new Error("The rough cut's dialogue exceeds its recorded size.");hash.update(chunk);writer.write(chunk);await writer.flush();}
    await writer.end();
    if(bytes!==file.bytes||hash.digest("hex")!==file.sha256)throw new Error("The rough cut's dialogue failed checksum verification.");
    renameSync(temporary,target);
  }catch(error){await writer.end();rmSync(temporary,{force:true});throw error;}
}

/** Lays the verified rough-cut voice under a silent final shot; returns the clip unchanged when it does not qualify. */
export async function carryRoughCutDialogue(job:Job,animatic:Job|undefined,shot:Shot,clip:VideoClip,root:string,signal:AbortSignal,artifacts?:Pick<PostgresArtifactStore,"response">):Promise<VideoClip> {
  if(job.stage!=="final")return clip;
  const record=roughCutDialogue(animatic,shot,clip);
  const directory=resolve(root,job.projectId,job.id,"clips");
  if(!record){
    // A shot without lines gets a silent track and says so, as the rough cut's do, so a cut mixing
    // voiced and silent shots assembles and its dialogue can be replaced later.
    if(clip.audioPath||clip.speech||clip.audioMode)return clip;
    // Only a clip with no sound at all: a provider's own soundtrack is never replaced.
    const probe=Bun.spawn(["ffprobe","-v","error","-select_streams","a","-show_entries","stream=index","-of","csv=p=0",clip.path],{stdout:"pipe",stderr:"pipe",signal});
    const streams=(await new Response(probe.stdout).text()).trim();if(await probe.exited!==0)throw new Error("The final shot could not be inspected.");
    if(streams)return clip;
    mkdirSync(directory,{recursive:true});
    const silent=resolve(directory,shot.id+"-silent.mp4");
    const muxed=Bun.spawn(["ffmpeg","-y","-v","error","-i",clip.path,"-f","lavfi","-i","anullsrc=r=44100:cl=stereo","-map","0:v:0","-map","1:a:0","-c:v","copy",
      "-c:a","aac","-b:a","128k","-t",clip.durationSec.toFixed(3),"-map_metadata","-1",silent],{stderr:"pipe",signal});
    if(await muxed.exited!==0)throw new Error("The final shot's silent track could not be added.");
    rmSync(clip.path,{force:true});
    return {...clip,path:silent,audioMode:"silent-captioned"};
  }
  mkdirSync(directory,{recursive:true});
  const voice=resolve(directory,shot.id+"-dialogue.wav"),voiced=resolve(directory,shot.id+"-voiced.mp4");
  await copyVerified(record,job,resolve(root),voice,signal,artifacts);
  const muxed=Bun.spawn(["ffmpeg","-y","-v","error","-i",clip.path,"-i",voice,"-map","0:v:0","-map","1:a:0","-c:v","copy",
    "-af","apad","-c:a","aac","-b:a","128k","-ar","44100","-ac","2","-t",clip.durationSec.toFixed(3),"-map_metadata","-1",voiced],{stderr:"pipe",signal});
  if(await muxed.exited!==0)throw new Error("The rough cut's dialogue could not be laid under the final shot.");
  rmSync(clip.path,{force:true});
  return {...clip,path:voiced,audioPath:voice,speech:structuredClone(record.clip.speech),audioMode:"provided"};
}
