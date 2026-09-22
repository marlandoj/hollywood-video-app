import {createHash} from "node:crypto";
import {existsSync,rmSync,statSync} from "node:fs";
import {join} from "node:path";
import {soundProcessingCommand} from "./sound-finishing";
import {soundRuntimeRevision} from "./sound-audio";
import {editFrameHashes} from "./edit-conform";
import {contentHash} from "./capabilities";
import {DELIVERY_MEZZANINE_RECIPE,validateDeliveryMezzaninePlan,type DeliveryMezzaninePlan} from "../../planner/src/delivery-mezzanine";

type Access=()=>Promise<void>;
export class DeliveryMezzanineError extends Error {override name="DeliveryMezzanineError";}
const fail:(message:string)=>never=message=>{throw new DeliveryMezzanineError(message);};
export interface DeliveryMezzanineResult {
  schema:"hv-delivery-mezzanine-result/1";plan:DeliveryMezzaninePlan;recipeRevision:string;runtimeRevision:string;
  file:{path:string;sha256:string;bytes:number};
  delivered:{width:number;height:number;frames:number;durationSec:number;video:string;pixelFormat:string;audio:string;channels:number;sampleRate:number};
  /** The mezzanine's own decoded frames, hashed. Equal to the conform's by construction and by check. */
  pictureFramesSha256:string;revision:string;
}
const hash=async(path:string,signal?:AbortSignal)=>{const digest=createHash("sha256");for await(const chunk of Bun.file(path).stream()){signal?.throwIfAborted();digest.update(chunk);}return digest.digest("hex");};
const stream=(probe:{streams?:Record<string,unknown>[]},type:string)=>probe.streams?.find(value=>value.codec_type===type);
async function describe(args:string[],file:string,directory:string,access:Access,signal?:AbortSignal):Promise<{streams?:Record<string,unknown>[];format?:Record<string,unknown>}>{
  await soundProcessingCommand(["ffprobe","-v","error","-protocol_whitelist","file,pipe",...args,"-show_streams","-show_format","-of","json","-o",file],directory,access,signal);
  if(statSync(file).size>8*1024**2)fail("A mezzanine description exceeds its limit.");
  try{return JSON.parse(await Bun.file(file).text());}catch{return fail("A mezzanine description could not be read.");}
}
/**
 * The mezzanine: the conform's own two streams, copied into one file another edit suite can open.
 *
 * Nothing is encoded. `-c:v copy -c:a copy` moves the FFV1 picture master and the 24-bit mix without
 * touching a sample, which is what makes the claim in the result mean anything: the mezzanine's
 * decoded frames are hashed and compared with the frame hashes the **conform itself** recorded, and
 * a single differing frame is refused. Sixty-four bytes of plan carry that proof, so the comparison
 * costs one decode of the file just written and nothing else.
 *
 * The conform is read and never written: this can be run on a sealed editorial output as often as
 * it is wanted.
 */
export async function renderDeliveryMezzanine(conformDirectory:string,plan:DeliveryMezzaninePlan,destination:string,directory:string,access:Access,signal?:AbortSignal):Promise<DeliveryMezzanineResult>{
  const valid=validateDeliveryMezzaninePlan(plan),runtimeRevision=soundRuntimeRevision();
  const concat=join(conformDirectory,"picture/index.ffconcat"),mix=join(conformDirectory,"audio/final.wav");
  for(const [what,path] of [["picture master",concat],["final mix",mix]] as const)
    if(!existsSync(path))fail("This conform has no retained "+what+", so no mezzanine can be made from it. Render the edit again.");
  if(existsSync(destination))fail("Choose a mezzanine path that does not exist yet.");
  const scratch=["mezzanine-probe.json","mezzanine-frames.txt"];
  try{
    const probeFile=join(directory,scratch[0]!);
    // The picture master is checked against the plan before anything is written: a rewrap cannot fix
    // a source that is not the one the plan describes, and it would produce a file that looks right.
    const picture=stream(await describe(["-f","concat","-safe","1","-count_frames","-i",concat],probeFile,directory,access,signal),"video");
    if(!picture)fail("This conform's picture master carries no video stream.");
    const source=valid.source,output=valid.output;
    for(const [what,found,wanted] of [["codec",String(picture.codec_name??""),output.video],["pixel format",String(picture.pix_fmt??""),output.pixelFormat],
      ["frame rate",String(picture.r_frame_rate??""),"30/1"],["width",String(picture.width??""),String(source.width)],
      ["height",String(picture.height??""),String(source.height)],["frame count",String(picture.nb_read_frames??""),String(source.frames)]] as const)
      if(found!==wanted)fail("This conform's picture master has a "+what+" of "+(found||"nothing")+" and the plan describes "+wanted+".");
    const sound=stream(await describe(["-i",mix],probeFile,directory,access,signal),"audio");
    if(!sound)fail("This conform's final mix carries no audio stream.");
    if(String(sound.codec_name??"")!==output.audio||Number(sound.sample_rate)!==output.sampleRate||Number(sound.channels)!==output.channels)
      fail("This conform's final mix is not the studio's canonical stereo 48 kHz 24-bit sound.");
    if(statSync(mix).size!==source.mixBytes)fail("This conform's final mix changed size after the plan was made.");
    // Copy, do not encode. This is the whole increment.
    // `+bitexact` so the file does not carry the host's ffmpeg build version: a master that varies
    // with a patch release is a master that cannot be compared with itself.
    await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-threads","1","-f","concat","-safe","1","-i",concat,"-i",mix,
      "-map","0:v:0","-map","1:a:0","-c:v","copy","-c:a","copy","-r","30","-map_metadata","-1","-fflags","+bitexact","-flags:v","+bitexact",
      "-frames:v",String(source.frames),destination],directory,access,signal);
    const after=await describe(["-i",destination],probeFile,directory,access,signal);
    const video=stream(after,"video"),audio=stream(after,"audio");
    if(!video||!audio)fail("The mezzanine lost one of the two streams it is made of.");
    const durationSec=Number(after.format?.duration??0);
    if(!Number.isFinite(durationSec)||Math.abs(durationSec-output.durationSec)>1/30)
      fail("The mezzanine runs "+durationSec.toFixed(3)+" s and the film runs "+output.durationSec.toFixed(3)+" s.");
    if(Number(video.width)!==output.width||Number(video.height)!==output.height||String(video.codec_name??"")!==output.video||String(video.pix_fmt??"")!==output.pixelFormat)
      fail("The mezzanine's picture is not the picture master it was copied from.");
    if(String(audio.codec_name??"")!==output.audio||Number(audio.sample_rate)!==output.sampleRate||Number(audio.channels)!==output.channels)
      fail("The mezzanine's sound is not the mix it was copied from.");
    // The recipe says what metadata the file carries; this is where that stops being an assertion.
    // Matroska writes a per-stream DURATION for itself and a writing-app string; nothing else --
    // no encoder version, no source path, no tag the film brought with it -- may be there.
    const tags=(value:Record<string,unknown>|undefined)=>Object.keys((value?.tags??{}) as Record<string,unknown>).map(key=>key.toLowerCase());
    const encoder=String(((after.format?.tags??{}) as Record<string,unknown>).encoder??((after.format?.tags??{}) as Record<string,unknown>).ENCODER??"");
    if(tags(after.format).some(key=>key!=="encoder")||/\d/.test(encoder))fail("The mezzanine carries metadata this recipe does not deliver: "+tags(after.format).join(", ")+" "+encoder);
    for(const stream of [video,audio])if(tags(stream).some(key=>key!=="duration"))fail("The mezzanine's streams carry metadata this recipe does not deliver.");
    // The claim, checked: these are the conform's own frames, not merely frames of the same size.
    const frames=await editFrameHashes(destination,output.frames,join(directory,scratch[1]!),directory,access,signal);
    const pictureFramesSha256=contentHash(frames);
    if(pictureFramesSha256!==source.pictureFramesSha256)
      fail("The mezzanine's picture does not match the frames this conform recorded. It was not copied from this film's picture master.");
    const data={schema:"hv-delivery-mezzanine-result/1" as const,plan:valid,recipeRevision:contentHash(DELIVERY_MEZZANINE_RECIPE),runtimeRevision,
      file:{path:destination,sha256:await hash(destination,signal),bytes:statSync(destination).size},
      delivered:{width:Number(video.width),height:Number(video.height),frames:output.frames,durationSec,video:String(video.codec_name),
        pixelFormat:String(video.pix_fmt),audio:String(audio.codec_name),channels:Number(audio.channels),sampleRate:Number(audio.sample_rate)},
      pictureFramesSha256};
    return {...data,revision:contentHash(data)};
  }finally{for(const name of scratch)rmSync(join(directory,name),{force:true});}
}
