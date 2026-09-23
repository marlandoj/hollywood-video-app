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
const decibels=(value:string):number|null=>{
  if(/^-inf$/i.test(value))return null;
  if(!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value))fail("The level meter returned an invalid value: "+value.slice(0,30));
  return Number(value);
};
/**
 * HV-026-04: "not measured" and "measured as silence" are different facts and were the same value.
 * A missing mean became a `silent-programme` failure asserting a measurement nobody took, and a
 * missing peak disabled the clipping check without saying so.
 *
 * A log carrying neither line now measures as `null` -- unmeasured, and reported as such. A log
 * carrying one line of the pair is refused, because volumedetect prints both or neither: half a
 * reading means the log is not the log this check thinks it is reading.
 */
function soundLevels(log:string):PictureQcMeasurement["sound"]{
  const mean=/mean_volume:\s*(\S+) dB/.exec(log)?.[1],peak=/max_volume:\s*(\S+) dB/.exec(log)?.[1];
  if(mean===undefined&&peak===undefined)return null;
  if(mean===undefined||peak===undefined)return fail("The level meter reported a "+(mean===undefined?"peak with no mean":"mean with no peak")+". Run the check again.");
  return {meanVolumeDb:decibels(mean),maxVolumeDb:decibels(peak)};
}
/**
 * Spans are reported closed: a span running to the end of the programme ends at its duration.
 *
 * HV-026-04: the two lists are zipped by index, so a log that lost a start would shift every later
 * pair and the mismatched ones would be dropped by the length check — a quality check silently
 * reporting fewer defects than it found, which is the worst failure available to it. A list that
 * cannot be paired is refused instead.
 */
function spans(log:string,start:RegExp,end:RegExp,durationSec:number,what:string):PictureQcSpan[]{
  const starts=[...log.matchAll(start)].map(match=>Number(match[1])),ends=[...log.matchAll(end)].map(match=>Number(match[1]));
  if(ends.length>starts.length||starts.length-ends.length>1)fail("The "+what+" detector reported "+starts.length+" starts and "+ends.length+" ends, which cannot be paired. Run the check again.");
  const paired=starts.map((from,index)=>({fromSec:from,toSec:ends[index]??durationSec}));
  if(paired.some(span=>!Number.isFinite(span.fromSec)||!Number.isFinite(span.toSec)||span.toSec<=span.fromSec))
    fail("The "+what+" detector reported a span that does not run forwards. Run the check again.");
  return paired;
}
/** Reduced as it is read: a spread over a million per-frame values overflows the call stack. */
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
/**
 * The smallest or largest of a per-frame statistic (HV-026-07).
 *
 * The reducer is written out rather than passed as `values.reduce(Math.min)`, which is how this read
 * every film's luma range as `NaN`: `reduce` hands its callback four arguments and the fourth is the
 * array, so `Math.min(11, 20, 1, [11, 20, 30])` coerces the array and answers `NaN`. A single-frame
 * film was the only one that escaped, because `reduce` skips the callback entirely for one element.
 */
const extreme=(values:number[],pick:(a:number,b:number)=>number)=>values.length?values.reduce((best,value)=>pick(best,value)):null;
export interface PictureQcDetectors {blackSpans:PictureQcSpan[];freezeSpans:PictureQcSpan[];sound:PictureQcMeasurement["sound"]}
/**
 * Everything this check reads out of ffmpeg's log, in one pure function.
 *
 * Only the detectors' own lines are read. The log also carries the file's name and its metadata
 * tags, and a title reading "black_start:0.0" must not put a phantom span in a delivery report.
 *
 * Separated from the decode so the refusals below can be shown rather than argued about: a log that
 * has lost a line is not something a test can ask ffmpeg for, and every path through here is a
 * delivery report saying something about a film.
 */
export function readDetectors(log:string,durationSec:number,hasAudio:boolean):PictureQcDetectors{
  const detector=(name:string)=>log.split(/\r?\n/).filter(line=>line.includes("["+name+" @ ")).join("\n");
  return {
    blackSpans:spans(detector("blackdetect"),/black_start:\s*([\d.]+)/g,/black_end:\s*([\d.]+)/g,durationSec,"black"),
    freezeSpans:spans(detector("freezedetect"),/freeze_start:\s*([\d.]+)/g,/freeze_end:\s*([\d.]+)/g,durationSec,"freeze"),
    // No audio stream means no meter was run, which is a different fact from a meter that ran and
    // printed nothing; both measure as null here, and the report tells them apart by the stream.
    sound:hasAudio?soundLevels(detector("Parsed_volumedetect_0")):null,
  };
}
/** A malformed description is a refusal of this check, not a SyntaxError escaping to the caller. */
const readJson=(path:string):unknown=>{try{return JSON.parse(boundedText(path));}catch(error){if(error instanceof PictureQcError)throw error;return fail("The file's description could not be read.");}};
const hash=async(path:string,signal?:AbortSignal)=>{const digest=createHash("sha256");for await(const chunk of Bun.file(path).stream()){signal?.throwIfAborted();digest.update(chunk);}return digest.digest("hex");};
/**
 * One probe and one decode. Nothing is written beside the film and no pixel is changed, so this can
 * be run on a delivered master as often as it is wanted without touching what was delivered.
 */
export async function measurePictureQc(path:string,directory:string,access:Access,signal?:AbortSignal):Promise<PictureQcReport>{
  const runtimeRevision=soundRuntimeRevision(),scratch=["qc-probe.json","qc-ymin.txt","qc-ymax.txt"];
  // HV-026-04: the scratch was removed on the way past, so any refusal left three files in the
  // caller's directory -- which is often the directory the film is in -- and the next run read them.
  try{
    const probeFile=join(directory,scratch[0]!);
    await run(["ffprobe","-v","error","-show_streams","-show_format","-of","json","-o",probeFile,path],directory,access,signal);
    const probe=readJson(probeFile) as {streams?:Record<string,unknown>[];format?:Record<string,unknown>};
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
      "metadata=print:key=lavfi.signalstats.YMIN:file="+scratch[1],"metadata=print:key=lavfi.signalstats.YMAX:file="+scratch[2]].join(",");
    const log=await run(["ffmpeg","-hide_banner","-nostdin","-nostats","-v","info","-protocol_whitelist","file,pipe","-i",path,
      "-map","0:v:0","-vf",filters,...(audio?["-map","0:a:0","-af","volumedetect"]:[]),"-f","null","-"],directory,access,signal);
    const {blackSpans,freezeSpans,sound}=readDetectors(log,durationSec,Boolean(audio));
    const minimums=statistic(directory,scratch[1]!,"YMIN"),maximums=statistic(directory,scratch[2]!,"YMAX");
    const measurement:PictureQcMeasurement={programme,
      picture:{blackSpans,freezeSpans,lumaMin:extreme(minimums,Math.min),lumaMax:extreme(maximums,Math.max),
        framesSampled:Math.min(minimums.length,maximums.length)},
      sound};
    return pictureQcReport(measurement,{sha256:await hash(path,signal),bytes:programme.bytes},runtimeRevision);
  }finally{for(const name of scratch)rmSync(join(directory,name),{force:true});}
}
