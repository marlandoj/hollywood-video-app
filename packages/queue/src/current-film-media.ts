import {createHash} from "node:crypto";
import {lstatSync,realpathSync} from "node:fs";
import {resolve,sep} from "node:path";
import {contentHash} from "../../generator/src/capabilities";
import {speechWavHeader} from "../../generator/src/speech";
import type {VideoClip} from "../../generator/src/index";
import {assertSpeechInput,renderRecord,validateRenderRecord,type RenderFile,type ShotRenderRecord} from "../../planner/src/shot-reuse";
import {currentFilmRecordedFiles} from "../../planner/src/current-film-job-context";
import {parseCurrentFilmProbe} from "../../planner/src/current-film-clock";
import type {Job} from "./index";
import type {CurrentFilmSlot} from "../../planner/src/current-film-jobs";

type Owner={projectId:string;id:string};
function owned(root:string,job:Owner,path:string):string{
  const scope=resolve(root,job.projectId,job.id)+sep,actual=realpathSync(path);
  if(!actual.startsWith(scope)||lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile())throw new Error("Current-film media escaped its owning job.");return actual;
}
async function digest(path:string,signal:AbortSignal):Promise<{sha256:string;bytes:number}>{const hash=createHash("sha256");let bytes=0;for await(const chunk of Bun.file(path).stream()){signal.throwIfAborted();hash.update(chunk);bytes+=chunk.byteLength;}signal.throwIfAborted();return {sha256:hash.digest("hex"),bytes};}
/** A fresh V2 owning record, never a rehashed or renamed legacy source record. */
export async function sealCurrentFilmClip(job:Owner,slot:CurrentFilmSlot,clip:VideoClip,root:string,signal:AbortSignal):Promise<VideoClip>{
  signal.throwIfAborted();if(clip.renderRecord!==undefined)throw new Error("Fresh current-film media cannot adopt an existing render record.");if(slot.renderId!==slot.shot.id)throw new Error("Current-film slot lost its exact render identity.");
  const file=async(path:string):Promise<RenderFile>=>{const actual=owned(resolve(root),job,path);return {path:actual.slice(resolve(root).length+1).split(sep).join("/"),...await digest(actual,signal)};};
  const {path,audioPath,posterPath,sourcePosterPath,cost:_cost,renderRecord:_previous,...metadata}=clip;
  const record=renderRecord({projectId:job.projectId,jobId:job.id,shotId:slot.renderId,inputHash:slot.inputRevision,clip:metadata,files:{video:await file(path),...(audioPath?{audio:await file(audioPath)}:{}),...(posterPath?{poster:await file(posterPath)}:{}),...(sourcePosterPath?{sourcePoster:await file(sourcePosterPath)}:{})},origin:{jobId:job.id,shotId:slot.renderId}});
  validateRenderRecord(record,job);assertSpeechInput(record,slot.shot);if(record.files.audio)await verifySpeech(record,owned(resolve(root),job,audioPath!),signal);await verifyFrames(owned(resolve(root),job,path),clip.durationSec,signal);return {...clip,renderRecord:record};
}
export async function verifyCurrentFilmClip(job:Owner,slot:CurrentFilmSlot,clip:VideoClip,root:string,signal:AbortSignal):Promise<void>{
  const saved=clip.renderRecord;if(!saved)throw new Error("The current-film checkpoint lost its fresh owning record.");validateRenderRecord(saved,job);
  if(saved.reusedFrom||saved.origin.jobId!==job.id||saved.origin.shotId!==slot.renderId)throw new Error("An all-fresh current film cannot restore reused media.");
  const {renderRecord:_checked,...fresh}=clip;const actual=(await sealCurrentFilmClip(job,slot,fresh,root,signal)).renderRecord!;if(contentHash(saved)!==contentHash(actual))throw new Error("The current-film checkpoint differs from its actual media, inputs or record.");
}
async function verifyFrames(path:string,durationSec:number,signal:AbortSignal):Promise<void>{
  const out=await probe(path,["-select_streams","v:0","-count_frames","-show_entries","stream=nb_read_frames,r_frame_rate"],signal);
  const stream=(JSON.parse(out) as {streams?:{nb_read_frames?:string;r_frame_rate?:string}[]}).streams?.[0],frames=Number(stream?.nb_read_frames),rate=stream?.r_frame_rate?.split("/").map(Number);
  if(!Number.isSafeInteger(frames)||frames<1||Math.abs(frames-durationSec*30)>1e-7||!rate||rate.length!==2||!Number.isSafeInteger(rate[0])||!Number.isSafeInteger(rate[1])||rate[1]!<1||rate[0]!==30*rate[1]!)throw new Error("The current-film clip differs from its actual decoded 30 fps frame count.");
}

/** Historical independent media verification. Portable record paths resolve in this restored root;
 * no old absolute manifest paths, present permissions or owner approval are inferred here. */
export async function verifyCurrentFilmMedia(job:Job,root:string,signal:AbortSignal=new AbortController().signal):Promise<void>{
  signal.throwIfAborted();const files=currentFilmRecordedFiles(job),scope=resolve(root);
  for(const file of files){const path=owned(scope,job,resolve(scope,file.path)),actual=await digest(path,signal);if(actual.sha256!==file.sha256||actual.bytes!==file.bytes)throw new Error("The restored current-film media differs from its exact recorded bytes.");}
  for(const row of job.currentFilmCheckpoint!.rows){if(row.record.files.audio)await verifySpeech(row.record,owned(scope,job,resolve(scope,row.record.files.audio.path)),signal);await verifyFrames(owned(scope,job,resolve(scope,row.record.files.video.path)),row.record.clip.durationSec,signal);}
  if(job.output){const path=owned(scope,job,resolve(scope,job.output.mp4Path)),text=await probe(path,["-count_frames","-show_streams","-show_format"],signal),actual=parseCurrentFilmProbe(JSON.parse(text));
    if(contentHash(actual)!==contentHash(job.output.currentFilm!.assembly.probe))throw new Error("The restored current-film assembly clock differs from its actual decoded media.");
  }signal.throwIfAborted();
}
async function probe(path:string,args:string[],signal:AbortSignal):Promise<string>{
  signal.throwIfAborted();const child=Bun.spawn(["ffprobe","-v","error",...args,"-of","json",path],{stdout:"pipe",stderr:"pipe",stdin:"ignore"}),abort=()=>child.kill();signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
  try{const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);signal.throwIfAborted();if(code!==0)throw new Error("Current-film source probe failed: "+err.slice(-300));return out;
  }finally{signal.removeEventListener("abort",abort);}
}

/** The report's half-open source ranges address the actual native mono signed-16 PCM. */
async function verifySpeech(record:ShotRenderRecord,path:string,signal:AbortSignal):Promise<void>{
  const report=record.clip.speech;if(!report)return;signal.throwIfAborted();const size=44+report.totalSamples*2;
  if(!Number.isSafeInteger(size)||size<46||size>44+600*22050*2||record.files.audio?.bytes!==size)throw new Error("Current-film speech exceeds its bounded native PCM size.");
  // One extra byte detects a longer body without allocating an unbounded changed file.
  const bytes=Buffer.from(await Bun.file(path).slice(0,size+1).arrayBuffer());signal.throwIfAborted();if(bytes.byteLength!==size||!bytes.subarray(0,44).equals(speechWavHeader(report.totalSamples)))throw new Error("Current-film speech lost its exact 22,050 Hz mono 16-bit WAV header.");
  let cursor=0;const silence=(end:number)=>{if(bytes.subarray(44+cursor*2,44+end*2).some(value=>value!==0))throw new Error("Current-film recorded speech pauses contain non-silent PCM.");};
  for(const line of report.lines){signal.throwIfAborted();silence(line.startSample);const sha256=createHash("sha256").update(bytes.subarray(44+line.startSample*2,44+line.endSample*2)).digest("hex");if(sha256!==line.pcmSha256)throw new Error("Current-film speech differs from its exact recorded line PCM.");cursor=line.endSample;}
  silence(report.totalSamples);signal.throwIfAborted();
}
