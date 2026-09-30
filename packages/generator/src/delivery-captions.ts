import {createHash} from "node:crypto";
import {readFileSync,rmSync,statSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {soundProcessingCommand} from "./sound-finishing";
import {soundRuntimeRevision} from "./sound-audio";
import {contentHash} from "./capabilities";
import {encodeDeliveryCut,type DeliveryReframeResult} from "./delivery-reframe";
import {DELIVERY_OPEN_CAPTIONS_RECIPE,validateDeliveryCaptionCheck,validateDeliveryOpenCaptionsPlan,
  type DeliveryCaptionCheck,type DeliveryOpenCaptionsPlan} from "../../planner/src/delivery-captions";

type Access=()=>Promise<void>;
export class DeliveryCaptionsError extends Error {override name="DeliveryCaptionsError";}
const fail:(message:string)=>never=message=>{throw new DeliveryCaptionsError(message);};
export interface SealedCaptionCue {id:string;startMs:number;endMs:number;text:string}
export interface DeliveryOpenCaptionsResult {
  schema:"hv-delivery-open-captions-result/1";plan:DeliveryOpenCaptionsPlan;recipeRevision:string;runtimeRevision:string;
  file:{path:string;sha256:string;bytes:number};delivered:DeliveryReframeResult["delivered"];check:DeliveryCaptionCheck;revision:string;
}
const TIME=/^(\d{2}):(\d{2}):(\d{2})\.(\d{3}) --> (\d{2}):(\d{2}):(\d{2})\.(\d{3})$/;
const ms=(h:string,m:string,s:string,f:string)=>((Number(h)*60+Number(m))*60+Number(s))*1000+Number(f);
/**
 * The film's sealed WebVTT, read back exactly as the conform writes it (`editVtt`, `editAssemblyVtt`):
 * a header, then an identity, a timing line and the text of each cue, separated by one blank line.
 *
 * Read strictly rather than leniently. This file is the film's own and its digest was checked on the
 * way in, so anything this reader does not recognise is a file this studio did not write -- and a
 * lenient reader would burn whatever it guessed.
 */
export function parseSealedCaptions(text:string):SealedCaptionCue[]{
  if(!text.startsWith("WEBVTT\n\n"))fail("The film's caption track is not the WebVTT its conform writes.");
  const body=text.slice("WEBVTT\n\n".length);
  if(!body)return [];
  if(!body.endsWith("\n"))fail("The film's caption track ends inside a cue.");
  return body.slice(0,-1).split("\n\n").map((block,index)=>{
    const [id,timing,...lines]=block.split("\n"),time=TIME.exec(timing??"");
    if(!id||!time||!lines.length||lines.some(line=>!line))fail("Caption cue "+(index+1)+" of the film's track is not a cue its conform writes.");
    const startMs=ms(time[1]!,time[2]!,time[3]!,time[4]!),endMs=ms(time[5]!,time[6]!,time[7]!,time[8]!);
    if(endMs<=startMs)fail("Caption cue "+(index+1)+" of the film's track ends before it starts.");
    // The conform escapes exactly these three, in this order; they are undone in the reverse order.
    const decoded=lines.join("\n").replace(/&lt;/g,"<").replace(/&gt;/g,">").replace(/&amp;/g,"&");
    return {id:id!,startMs,endMs,text:decoded};
  });
}
const cs=(value:number)=>{const h=Math.floor(value/360000),m=Math.floor(value/6000)%60,s=Math.floor(value/100)%60;
  return h+":"+String(m).padStart(2,"0")+":"+String(s).padStart(2,"0")+"."+String(value%100).padStart(2,"0");};
/** Centiseconds: a start is floored and an end is ceiled, so no cue is shown later or ended sooner. */
export const openCaptionCentiseconds=(cue:SealedCaptionCue)=>({start:Math.floor(cue.startMs/10),end:Math.ceil(cue.endMs/10)});
/**
 * A caption's words as literal text for libass. An unescaped brace opens an override block, and a
 * backslash before `n`, `N` or `h` is a line break or a hard space, so the text is made inert rather
 * than trusted: braces are escaped, and a word joiner -- which draws nothing -- follows every
 * backslash, so no backslash in a line of dialogue can combine with the letter after it.
 */
export function openCaptionText(text:string):string{
  return text.replace(/\\/g,"\\\u2060").replace(/\{/g,"\\{").replace(/\}/g,"\\}").split("\n").join("\\N");
}
/** The caption layer, as an ASS script laid out for the delivered frame and nothing else. */
export function openCaptionsScript(plan:DeliveryOpenCaptionsPlan,cues:SealedCaptionCue[],only?:number):string{
  const {width,height}=plan.output,{font,fontSize,outline,marginH,marginV}=plan.style;
  return ["[Script Info]","ScriptType: v4.00+","PlayResX: "+width,"PlayResY: "+height,"WrapStyle: 0","ScaledBorderAndShadow: yes","YCbCr Matrix: None","",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Default,"+font+","+fontSize+",&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,"+outline+",0,2,"+marginH+","+marginH+","+marginV+",1","",
    "[Events]","Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ...cues.flatMap((cue,index)=>{if(only!==undefined&&index!==only)return [];const {start,end}=openCaptionCentiseconds(cue);
      return ["Dialogue: 0,"+cs(start)+","+cs(end)+",Default,,0,0,0,,"+openCaptionText(cue.text)];}),""].join("\n");
}
/**
 * The frame a 30 fps picture shows a cue on, or null if it lands on none.
 *
 * libass is asked for the time of each frame in whole milliseconds, truncated, so frame `n` shows a
 * cue when `start <= floor(n*1000/30) < end`. The middle of the cue is preferred, because that is
 * the frame least likely to be shared with its neighbour; failing that, the first frame inside it.
 */
export function openCaptionFrame(cue:SealedCaptionCue):number|null{
  const {start,end}=openCaptionCentiseconds(cue),from=start*10,to=end*10,at=(n:number)=>Math.floor(n*100/3);
  const shows=(n:number)=>at(n)>=from&&at(n)<to,middle=Math.floor((from+to)/2*3/100);
  if(shows(middle))return middle;
  const first=Math.ceil(from*3/100);
  return shows(first)?first:null;
}
/** Which cues are measured: every one that is shown, or an even spread of them including both ends. */
export function openCaptionSamples(shown:number[]):number[]{
  const limit=DELIVERY_OPEN_CAPTIONS_RECIPE.limits.sampledCues;
  if(shown.length<=limit)return shown;
  return [...new Set(Array.from({length:limit},(_,index)=>shown[Math.round(index*(shown.length-1)/(limit-1))]!))];
}
/**
 * Draw each sampled cue alone on a black frame of the delivered size and read back where its ink
 * landed. The same script, the same renderer and the same frame the burn used, minus the picture: the
 * layer that was composited over the film, measured on its own.
 */
async function measureCaptionLayer(plan:DeliveryOpenCaptionsPlan,cues:SealedCaptionCue[],sha256:string,directory:string,access:Access,signal?:AbortSignal):Promise<DeliveryCaptionCheck>{
  const {width,height}=plan.output,threshold=DELIVERY_OPEN_CAPTIONS_RECIPE.limits.inkThreshold;
  const frames=cues.map(openCaptionFrame),shown=frames.flatMap((frame,index)=>frame===null?[]:[index]);
  const sampled:DeliveryCaptionCheck["sampled"]=[];
  for(const cue of openCaptionSamples(shown)){
    signal?.throwIfAborted();
    const frame=frames[cue]!,script=join(directory,"layer.ass"),raw=join(directory,"layer.raw");
    writeFileSync(script,openCaptionsScript(plan,cues,cue));
    try{
      // One frame of black at the cue's own time, so the renderer is asked exactly what the burn asked it.
      await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-f","lavfi","-i","color=c=black:s="+width+"x"+height+":r=30:d=0.03",
        "-vf","setpts="+frame+"/(30*TB),ass=filename=layer.ass","-fps_mode","passthrough",
        "-frames:v","1","-f","rawvideo","-pix_fmt","gray","-y","layer.raw"],directory,access,signal);
      if(statSync(raw).size!==width*height)fail("Caption cue "+(cue+1)+" could not be drawn on a "+width+" by "+height+" frame.");
      const pixels=readFileSync(raw);let ink=0,x0=width,y0=height,x1=-1,y1=-1;
      for(let y=0;y<height;y++)for(let x=0;x<width;x++)if(pixels[y*width+x]!>=threshold){ink++;if(x<x0)x0=x;if(x>x1)x1=x;if(y<y0)y0=y;if(y>y1)y1=y;}
      sampled.push({cue,frame,ink,box:ink?{x0,y0,x1,y1}:{x0:0,y0:0,x1:0,y1:0}});
    }finally{rmSync(script,{force:true});rmSync(raw,{force:true});}
  }
  return {schema:"hv-delivery-caption-check/1",captionsSha256:sha256,cues:cues.length,betweenFrames:cues.length-shown.length,frame:{width,height},sampled};
}
const digest=async(path:string,signal?:AbortSignal)=>{const sum=createHash("sha256");
  for await(const chunk of Bun.file(path).stream()){signal?.throwIfAborted();sum.update(chunk);}return sum.digest("hex");};
/**
 * HV-027-15: one decode of the master into one cut with the film's own captions burned into it.
 *
 * The caption track is checked before anything is encoded: its digest and size are the ones the plan
 * names, and it holds the number of cues the film's own cut derives. The picture is cropped first when
 * the frame is a reframe, then captioned, so the captions are laid out for the frame that is
 * delivered. After the encode, the caption layer is measured on its own and the burn is refused if a
 * cue drew nothing or ran off the frame.
 */
export async function renderDeliveryOpenCaptions(master:string,captionsPath:string,plan:DeliveryOpenCaptionsPlan,source:{width:number;height:number;durationSec:number},
  destination:string,directory:string,access:Access,signal?:AbortSignal):Promise<DeliveryOpenCaptionsResult>{
  const valid=validateDeliveryOpenCaptionsPlan(plan),runtimeRevision=soundRuntimeRevision();
  if(statSync(captionsPath).size!==valid.captions.bytes||await digest(captionsPath,signal)!==valid.captions.sha256)
    fail("The caption track this deliverable was given is not the film's own sealed track.");
  const cues=parseSealedCaptions(readFileSync(captionsPath,"utf8"));
  if(cues.length!==valid.captions.cues)fail("The film's sealed caption track carries "+cues.length+" cues and its cut derives "+valid.captions.cues+".");
  writeFileSync(join(directory,"captions.ass"),openCaptionsScript(valid,cues));
  const filter=(valid.crop?valid.crop+",":"")+"ass=filename=captions.ass";
  const delivered=await encodeDeliveryCut(master,{source,output:valid.output,filter},destination,directory,access,signal);
  const check=await measureCaptionLayer(valid,cues,valid.captions.sha256,directory,access,signal);
  try{validateDeliveryCaptionCheck(check,valid);}
  catch(error){
    const cue=/Caption cue (\d+)/.exec((error as Error).message)?.[1];
    fail((error as Error).message+(cue?" It reads: \""+cues[Number(cue)-1]!.text.replace(/\n/g," ").slice(0,120)+"\"":""));
  }
  const data={schema:"hv-delivery-open-captions-result/1" as const,plan:valid,recipeRevision:contentHash(DELIVERY_OPEN_CAPTIONS_RECIPE),runtimeRevision,
    file:{path:destination,sha256:await digest(destination,signal),bytes:statSync(destination).size},delivered,check};
  return {...data,revision:contentHash(data)};
}
