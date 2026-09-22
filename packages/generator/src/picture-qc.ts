import {createHash} from "node:crypto";
import {readFileSync,rmSync,statSync} from "node:fs";
import {join} from "node:path";
import {soundProcessingCommand} from "./sound-finishing";
import {soundRuntimeRevision} from "./sound-audio";
import {PICTURE_QC_RECIPE,pictureQcReport,type PictureQcMeasurement,type PictureQcReport,type PictureQcSpan} from "../../planner/src/picture-qc";

type Access=()=>Promise<void>;
export class PictureQcError extends Error {override name="PictureQcError";}
const fail=(message:string):never=>{throw new PictureQcError(message);};
async function run(args:string[],directory:string,access:Access,signal?:AbortSignal):Promise<string>{
  try{return await soundProcessingCommand(args,directory,access,signal);}
  catch(error){if(error instanceof Error&&/timed out|exceeded their limit|finishing failed/.test(error.message))fail("The quality check could not run: "+error.message);throw error;}
}
const boundedText=(path:string)=>{if(statSync(path).size>32*1024**2)fail("A quality-check measurement exceeds its limit.");return readFileSync(path,"utf8");};
const decibels=(value:string|undefined):number|null=>{
  if(value===undefined)return null;if(/^-inf$/i.test(value))return null;
  if(!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))fail("The level meter returned an invalid value: "+value.slice(0,30));
  return Number(value);
};
/** Spans are reported closed: a freeze that runs to the end of the programme ends at its duration. */
function spans(log:string,start:RegExp,end:RegExp,durationSec:number):PictureQcSpan[]{
  const starts=[...log.matchAll(start)].map(match=>Number(match[1])),ends=[...log.matchAll(end)].map(match=>Number(match[1]));
  return starts.map((from,index)=>({fromSec:from,toSec:ends[index]??durationSec})).filter(span=>Number.isFinite(span.fromSec)&&Number.isFinite(span.toSec)&&span.toSec>span.fromSec);
}
function statistic(directory:string,file:string,key:string):number[]{
  const text=boundedText(join(directory,file)),values:number[]=[];
  for(const line of text.split(/\r?\n/)){
    if(!line.startsWith("lavfi.signalstats."+key+"="))continue;
    const value=Number(line.slice(("lavfi.signalstats."+key+"=").length));
    if(!Number.isFinite(value))fail("A luma statistic was not a number.");
    values.push(value);
  }
  return values;
}
const hash=async(path:string,signal?:AbortSignal)=>{const digest=createHash("sha256");for await(const chunk of Bun.file(path).stream()){signal?.throwIfAborted();digest.update(chunk);}return digest.digest("hex");};
/**
 * One probe and one decode. Nothing is written beside the film and no pixel is changed, so this can
 * be run on a delivered master as often as it is wanted without touching what was delivered.
 */
export async function measurePictureQc(path:string,directory:string,access:Access,signal?:AbortSignal):Promise<PictureQcReport>{
  const runtimeRevision=soundRuntimeRevision(),probeFile=join(directory,"qc-probe.json");
  await run(["ffprobe","-v","error","-show_streams","-show_format","-of","json","-o",probeFile,path],directory,access,signal);
  const probe=JSON.parse(boundedText(probeFile)) as {streams?:Record<string,unknown>[];format?:Record<string,unknown>};
  rmSync(probeFile,{force:true});
  const video=probe.streams?.find(stream=>stream.codec_type==="video"),audio=probe.streams?.find(stream=>stream.codec_type==="audio");
  if(!video)fail("The file carries no video stream, so it cannot be checked as a film.");
  const durationSec=Number(probe.format?.duration??video!.duration??0);
  if(!Number.isFinite(durationSec)||durationSec<=0)fail("The file reports no playable duration.");
  const programme:PictureQcMeasurement["programme"]={
    durationSec,width:Number(video!.width),height:Number(video!.height),frameRate:String(video!.r_frame_rate??""),
    pixelFormat:String(video!.pix_fmt??""),video:String(video!.codec_name??""),
    audio:audio?String(audio.codec_name??""):null,channels:audio?Number(audio.channels):null,sampleRate:audio?Number(audio.sample_rate):null,
    bytes:statSync(path).size,
  };
  const filters=[PICTURE_QC_RECIPE.black,PICTURE_QC_RECIPE.freeze,"signalstats",
    "metadata=print:key=lavfi.signalstats.YMIN:file=qc-ymin.txt","metadata=print:key=lavfi.signalstats.YMAX:file=qc-ymax.txt"].join(",");
  const log=await run(["ffmpeg","-hide_banner","-nostdin","-nostats","-v","info","-protocol_whitelist","file,pipe","-i",path,
    "-map","0:v:0","-vf",filters,...(audio?["-map","0:a:0","-af","volumedetect"]:[]),"-f","null","-"],directory,access,signal);
  const minimums=statistic(directory,"qc-ymin.txt","YMIN"),maximums=statistic(directory,"qc-ymax.txt","YMAX");
  rmSync(join(directory,"qc-ymin.txt"),{force:true});rmSync(join(directory,"qc-ymax.txt"),{force:true});
  const measurement:PictureQcMeasurement={programme,
    picture:{
      blackSpans:spans(log,/black_start:([\d.]+)/g,/black_end:([\d.]+)/g,durationSec),
      freezeSpans:spans(log,/freeze_start:\s*([\d.]+)/g,/freeze_end:\s*([\d.]+)/g,durationSec),
      lumaMin:minimums.length?Math.min(...minimums):null,lumaMax:maximums.length?Math.max(...maximums):null,
      framesSampled:Math.min(minimums.length,maximums.length),
    },
    sound:{
      meanVolumeDb:decibels(/mean_volume:\s*(\S+) dB/.exec(log)?.[1]),
      maxVolumeDb:decibels(/max_volume:\s*(\S+) dB/.exec(log)?.[1]),
    }};
  return pictureQcReport(measurement,{sha256:await hash(path,signal),bytes:programme.bytes},runtimeRevision);
}
