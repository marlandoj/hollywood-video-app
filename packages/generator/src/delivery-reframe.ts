import {createHash} from "node:crypto";
import {statSync} from "node:fs";
import {join} from "node:path";
import {soundProcessingCommand} from "./sound-finishing";
import {soundRuntimeRevision} from "./sound-audio";
import {DELIVERY_REFRAME_RECIPE,validateDeliveryReframePlan,type DeliveryReframePlan} from "../../planner/src/delivery-reframe";
import {contentHash} from "./capabilities";

type Access=()=>Promise<void>;
export class DeliveryReframeError extends Error {override name="DeliveryReframeError";}
const fail:(message:string)=>never=message=>{throw new DeliveryReframeError(message);};
export interface DeliveryReframeResult {
  schema:"hv-delivery-reframe-result/1";plan:DeliveryReframePlan;recipeRevision:string;runtimeRevision:string;
  file:{path:string;sha256:string;bytes:number};
  delivered:{width:number;height:number;durationSec:number;video:string;audio:string|null;channels:number|null;sampleRate:number|null};
  revision:string;
}
const hash=async(path:string,signal?:AbortSignal)=>{const digest=createHash("sha256");for await(const chunk of Bun.file(path).stream()){signal?.throwIfAborted();digest.update(chunk);}return digest.digest("hex");};
/**
 * One decode of a finished master into one cut of it. The picture is cropped and re-encoded; the
 * sound is copied, so a reframe cannot change what the film sounds like. Nothing about the master
 * is touched, and the result is checked against the plan before it is returned.
 */
export async function renderDeliveryReframe(master:string,plan:DeliveryReframePlan,destination:string,directory:string,access:Access,signal?:AbortSignal):Promise<DeliveryReframeResult>{
  const valid=validateDeliveryReframePlan(plan),runtimeRevision=soundRuntimeRevision();
  const delivered=await encodeDeliveryCut(master,{source:valid.source,output:valid.output,filter:valid.filter},destination,directory,access,signal);
  const data={schema:"hv-delivery-reframe-result/1" as const,plan:valid,recipeRevision:contentHash(DELIVERY_REFRAME_RECIPE),runtimeRevision,
    file:{path:destination,sha256:await hash(destination,signal),bytes:statSync(destination).size},delivered};
  return {...data,revision:contentHash(data)};
}
/** What an encoded cut is asked to be: the master it reads, the frame it delivers, and the filter between them. */
export interface DeliveryCutSpec {source:{width:number;height:number;durationSec:number};output:{width:number;height:number};filter:string}
/**
 * HV-027-15: the encode a reframe makes, shared with the burned deliverables so that a cut with
 * captions in it is held to exactly the same checks as a cut without: the master's dimensions before
 * anything is encoded, the delivered frame, the master's own soundtrack, no build version anywhere,
 * and the master's length. `filter` runs from `directory`, so a filter may name a file inside it.
 */
export async function encodeDeliveryCut(master:string,spec:DeliveryCutSpec,destination:string,directory:string,access:Access,signal?:AbortSignal):Promise<DeliveryReframeResult["delivered"]>{
  const valid=spec,probeFile=join(directory,"reframe-probe.json");
  await soundProcessingCommand(["ffprobe","-v","error","-show_streams","-show_format","-of","json","-o",probeFile,master],directory,access,signal);
  const before=JSON.parse(Bun.file(probeFile).size>8*1024**2?fail("The master's description exceeds its limit."):await Bun.file(probeFile).text()) as {streams?:Record<string,unknown>[]};
  const sourceVideo=before.streams?.find(stream=>stream.codec_type==="video");
  if(!sourceVideo)fail("The master has no picture to reframe.");
  if(Number(sourceVideo.width)!==valid.source.width||Number(sourceVideo.height)!==valid.source.height)
    fail("This plan was made for a "+valid.source.width+" by "+valid.source.height+" master and this one is "+sourceVideo.width+" by "+sourceVideo.height+".");
  const hasAudio=Boolean(before.streams?.some(stream=>stream.codec_type==="audio"));
  await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-threads","1","-i",master,
    "-map","0:v:0",...(hasAudio?["-map","0:a:0"]:[]),"-vf",valid.filter,"-filter_threads","1",
    "-c:v","libx264","-preset","veryfast","-crf","18","-threads","1","-pix_fmt","yuv420p","-r","30",
    // The mix is the master's. Copying it is the difference between a cut of the film and a new one.
    ...(hasAudio?["-c:a","copy"]:[]),
    // HV-027-07: the recipe said "metadata stripped" and `-map_metadata -1` alone does not strip
    // ffmpeg's own. `+bitexact` takes the build versions out of the container and the stream tag,
    // and the SEI filter takes x264's build string and its whole option line out of the bitstream,
    // where `-map_metadata` never reached. HV-027-05 did the first of those for the mezzanine and
    // this file was not changed with it.
    "-map_metadata","-1","-fflags","+bitexact","-flags:v","+bitexact","-bsf:v","filter_units=remove_types=6",
    "-movflags","+faststart","-y",destination],directory,access,signal);
  await soundProcessingCommand(["ffprobe","-v","error","-show_streams","-show_format","-of","json","-o",probeFile,destination],directory,access,signal);
  const after=JSON.parse(await Bun.file(probeFile).text()) as {streams?:Record<string,unknown>[];format?:Record<string,unknown>};
  const video=after.streams?.find(stream=>stream.codec_type==="video"),audio=after.streams?.find(stream=>stream.codec_type==="audio");
  if(!video)fail("The delivered cut has no picture.");
  if(Number(video.width)!==valid.output.width||Number(video.height)!==valid.output.height)
    fail("The delivered cut is "+video.width+" by "+video.height+" and the plan asked for "+valid.output.width+" by "+valid.output.height+".");
  if(hasAudio&&!audio)fail("The delivered cut lost the master's soundtrack.");
  // The recipe says what metadata the cut carries; this is where that stops being an assertion.
  // What is allowed is the container's own brands and the MP4's structural per-stream tags -- no
  // build version anywhere, which is what "stripped" was taken to mean and never was.
  const keys=(value:Record<string,unknown>|undefined)=>Object.keys((value?.tags??{}) as Record<string,unknown>).map(key=>key.toLowerCase());
  const FORMAT_TAGS=["major_brand","minor_version","compatible_brands"],STREAM_TAGS=["language","handler_name","vendor_id","encoder"];
  // A build version, not any digit: "Lavc libx264" is the encoder's name and "libx264" carries a
  // number that is part of it. What must not be here is a library build -- `Lavf60.16.100`,
  // `Lavc60.31.102` -- or any dotted version beside it.
  const BUILD=/lav[fc]\s*\d|\d+\.\d+/i;
  const versioned=(value:Record<string,unknown>|undefined)=>Object.entries((value?.tags??{}) as Record<string,unknown>)
    .filter(([key,text])=>/^encoder$/i.test(key)&&BUILD.test(String(text))).map(([,text])=>String(text));
  if(keys(after.format).some(key=>!FORMAT_TAGS.includes(key))||versioned(after.format).length)
    fail("The delivered cut carries metadata this recipe does not deliver: "+[...keys(after.format),...versioned(after.format)].join(", "));
  for(const stream of [video,audio].filter(Boolean) as Record<string,unknown>[])
    if(keys(stream).some(key=>!STREAM_TAGS.includes(key))||versioned(stream).length)
      fail("The delivered cut's streams carry metadata this recipe does not deliver: "+[...keys(stream),...versioned(stream)].join(", "));
  const durationSec=Number(after.format?.duration??0);
  if(!Number.isFinite(durationSec)||Math.abs(durationSec-valid.source.durationSec)>0.5)
    fail("The delivered cut runs "+durationSec.toFixed(2)+" s and the master runs "+valid.source.durationSec.toFixed(2)+" s.");
  return {width:Number(video.width),height:Number(video.height),durationSec,video:String(video.codec_name??""),
    audio:audio?String(audio.codec_name??""):null,channels:audio?Number(audio.channels):null,sampleRate:audio?Number(audio.sample_rate):null};
}
