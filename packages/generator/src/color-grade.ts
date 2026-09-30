import {createHash} from "node:crypto";
import {existsSync,readFileSync,rmSync,statSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {soundProcessingCommand} from "./sound-finishing";
import {soundRuntimeRevision} from "./sound-audio";
import {contentHash} from "./capabilities";
import {assertDeliveredMp4Metadata} from "./delivery-reframe";
import {COLOR_GRADE_RECIPE,colorGradeGraph,colorGradeLevelsGraph,colorGradeTally,validateColorGradePlan,type ColorGradeMeasurement,type ColorGradePlan} from "../../planner/src/color-grade";

type Access=()=>Promise<void>;
export class ColorGradeError extends Error {override name="ColorGradeError";}
const fail:(message:string)=>never=message=>{throw new ColorGradeError(message);};
export interface ColorGradeResult {
  schema:"hv-color-grade-result/1";plan:ColorGradePlan;recipeRevision:string;runtimeRevision:string;
  file:{path:string;sha256:string;bytes:number};
  delivered:{width:number;height:number;durationSec:number;video:string;audio:string|null};
  /** What the grade clipped that the cut had not, and how much of the graded file leaves the tolerance. */
  measurement:ColorGradeMeasurement;
  revision:string;
}
const REPOSITORY=resolve(import.meta.dir,"../../..");
const hash=async(path:string,signal?:AbortSignal)=>{const digest=createHash("sha256");for await(const chunk of Bun.file(path).stream()){signal?.throwIfAborted();digest.update(chunk);}return digest.digest("hex");};
const probe=async(path:string,file:string,directory:string,access:Access,signal?:AbortSignal)=>{
  await soundProcessingCommand(["ffprobe","-v","error","-show_streams","-show_format","-of","json","-o",file,path],directory,access,signal);
  if(statSync(file).size>8*1024**2)fail("A description of the cut exceeds its limit.");
  try{return JSON.parse(readFileSync(file,"utf8")) as {streams?:Record<string,unknown>[];format?:Record<string,unknown>};}
  catch{return fail("A description of the cut could not be read.");}
};
/** One reading per frame, in order, read only from the statistic's own lines. */
function statistic(path:string,key:string):number[]{
  if(!existsSync(path))fail("The grade was not measured.");
  if(statSync(path).size>32*1024**2)fail("A grade's measurement exceeds its limit.");
  const values:number[]=[],prefix="lavfi.signalstats."+key+"=";
  for(const line of readFileSync(path,"utf8").split(/\r?\n/)){
    if(!line.startsWith(prefix))continue;
    const value=Number(line.slice(prefix.length));
    if(!Number.isFinite(value)||value<0||value>255)fail("A reading of the grade was not a number.");
    values.push(value);
  }
  return values;
}
/** A share of the frame: the mask is 255 where clipped and 0 elsewhere, so its mean luma is the share times 255. */
const shares=(path:string)=>statistic(path,"YAVG").map(value=>value/255);

/**
 * The look, read from the file shipped in the repository and checked against the digest the plan was
 * bound to, then written into the scratch under the one name the filter reads. A look edited on disk
 * after the grade was decided is refused rather than applied.
 */
function stageLook(plan:ColorGradePlan,directory:string):void{
  const path=resolve(REPOSITORY,plan.look.file);
  if(!path.startsWith(REPOSITORY+"/packages/generator/looks/")||!existsSync(path))fail("The "+plan.look.id+" look is not in the studio's library.");
  const bytes=readFileSync(path);
  if(bytes.length!==plan.look.bytes||createHash("sha256").update(bytes).digest("hex")!==plan.look.sha256)
    fail("The "+plan.look.id+" look on disk is not the look this grade was decided with.");
  writeFileSync(join(directory,"look.cube"),bytes);
}
/**
 * One decode of a finished cut into one graded cut of it, and the measure of what the grade did.
 *
 * The first pass grades the picture and, in the same decode, compares the graded pixels with the cut's
 * own: a pixel counts only when the grade put one of its channels at 0 or full scale and the cut had
 * not. The second reads the graded file back as encoded, for the share of each frame's luma outside
 * the tolerance. The picture is re-encoded and the sound is copied, so a grade cannot change what the
 * film sounds like. The cut is read and never written.
 */
export async function renderColorGrade(master:string,plan:ColorGradePlan,destination:string,directory:string,access:Access,signal?:AbortSignal):Promise<ColorGradeResult>{
  const valid=validateColorGradePlan(plan),runtimeRevision=soundRuntimeRevision();
  const scratch=["grade-probe.json","look.cube","grade-ceiling.txt","grade-floor.txt","grade-below.txt","grade-above.txt"],probeFile=join(directory,scratch[0]!);
  if(existsSync(destination))fail("Choose a graded cut path that does not exist yet.");
  try{
    const before=await probe(master,probeFile,directory,access,signal);
    const sourceVideo=before.streams?.find(stream=>stream.codec_type==="video");
    if(!sourceVideo)fail("The cut has no picture to grade.");
    if(Number(sourceVideo!.width)!==valid.source.width||Number(sourceVideo!.height)!==valid.source.height)
      fail("This grade was decided for a "+valid.source.width+" by "+valid.source.height+" cut and this one is "+sourceVideo!.width+" by "+sourceVideo!.height+".");
    const hasAudio=Boolean(before.streams?.some(stream=>stream.codec_type==="audio"));
    stageLook(valid,directory);
    for(const name of scratch.slice(2))rmSync(join(directory,name),{force:true});
    await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-threads","1","-i",master,
      "-filter_complex",colorGradeGraph(valid,{ceiling:scratch[2]!,floor:scratch[3]!}),"-filter_complex_threads","1",
      "-map","[graded]",...(hasAudio?["-map","0:a:0"]:[]),
      "-c:v","libx264","-preset","veryfast","-crf","18","-threads","1","-pix_fmt","yuv420p","-r","30",...(hasAudio?["-c:a","copy"]:[]),
      // The same metadata rules as a reframe: no build version in the container, the stream tags or
      // the picture bitstream.
      "-map_metadata","-1","-fflags","+bitexact","-flags:v","+bitexact","-bsf:v","filter_units=remove_types=6","-movflags","+faststart",destination,
      "-map","[ceiling]","-f","null","-","-map","[floor]","-f","null","-"],directory,access,signal);
    await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-threads","1","-i",destination,
      "-filter_complex",colorGradeLevelsGraph({below:scratch[4]!,above:scratch[5]!}),"-filter_complex_threads","1",
      "-map","[below]","-f","null","-","-map","[above]","-f","null","-"],directory,access,signal);
    const [ceiling,floor,below,above]=scratch.slice(2).map(name=>shares(join(directory,name)));
    // A measurement that did not see every frame is not a measurement of this grade.
    for(const values of [ceiling!,floor!,below!,above!])if(values.length!==valid.source.frames)
      fail("The grade was measured over "+values.length+" frames, and the cut has "+valid.source.frames+".");
    const after=await probe(destination,probeFile,directory,access,signal);
    const video=after.streams?.find(stream=>stream.codec_type==="video"),audio=after.streams?.find(stream=>stream.codec_type==="audio");
    if(!video)fail("The graded cut has no picture.");
    if(Number(video!.width)!==valid.source.width||Number(video!.height)!==valid.source.height)
      fail("The graded cut is "+video!.width+" by "+video!.height+" and the cut is "+valid.source.width+" by "+valid.source.height+".");
    if(hasAudio&&!audio)fail("The graded cut lost the cut's soundtrack.");
    assertDeliveredMp4Metadata(after,[video,audio],fail);
    const durationSec=Number(after.format?.duration??0),wanted=valid.source.frames/30;
    if(!Number.isFinite(durationSec)||Math.abs(durationSec-wanted)>0.5)
      fail("The graded cut runs "+durationSec.toFixed(2)+" s and the cut runs "+wanted.toFixed(2)+" s.");
    const data={schema:"hv-color-grade-result/1" as const,plan:valid,recipeRevision:contentHash(COLOR_GRADE_RECIPE),runtimeRevision,
      file:{path:destination,sha256:await hash(destination,signal),bytes:statSync(destination).size},
      delivered:{width:Number(video!.width),height:Number(video!.height),durationSec,video:String(video!.codec_name??""),audio:audio?String(audio.codec_name??""):null},
      measurement:{framesMeasured:ceiling!.length,ceiling:colorGradeTally(ceiling!),floor:colorGradeTally(floor!),below:colorGradeTally(below!),above:colorGradeTally(above!)}};
    return {...data,revision:contentHash(data)};
  }finally{for(const name of scratch)rmSync(join(directory,name),{force:true});}
}
