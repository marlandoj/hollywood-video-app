import {createHash} from "node:crypto";
import {readFileSync,statSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {soundProcessingCommand} from "./sound-finishing";
import {soundRuntimeRevision} from "./sound-audio";
import {contentHash} from "./capabilities";
import {parseSealedCaptions} from "./delivery-captions";
import {DELIVERY_SDH_RECIPE,validateDeliverySdhCheck,type DeliverySdhCheck,type DeliverySdhPlan} from "../../planner/src/delivery-sdh";

type Access=()=>Promise<void>;
export class DeliverySdhError extends Error {override name="DeliverySdhError";}
const fail:(message:string)=>never=message=>{throw new DeliverySdhError(message);};
export interface SdhSegment {startMs:number;endMs:number;text:string}
export interface DeliverySdhResult {
  schema:"hv-delivery-sdh-result/1";plan:DeliverySdhPlan;recipeRevision:string;runtimeRevision:string;
  file:{path:string;sha256:string;bytes:number};
  delivered:{width:number;height:number;durationSec:number;video:string;audio:string};check:DeliverySdhCheck;revision:string;
}
/**
 * MP4 timed text shows one sample at a time: a cue that begins while another is showing ends the
 * first one (measured: a music cue under a line of dialogue was cut off where the line began, and
 * the rest of the music was lost). So the track is cut into segments at every cue's edges, and each
 * segment shows every cue active across it, one per line, in the order they began.
 */
export function sdhSegments(dialogue:SdhSegment[],sounds:SdhSegment[]):SdhSegment[]{
  // HV-027-16 review: the film's caption ends are ceiled to the millisecond and sound edges floored,
  // so a line ending on frame 1 (33.3 ms) ends at 34 and a sound starting there starts at 33. Edges
  // under 2 ms apart are one edge -- the earlier -- or a 1 ms sliver shows both on that frame.
  const raw=[...new Set([...dialogue,...sounds].flatMap(cue=>[cue.startMs,cue.endMs]))].sort((a,b)=>a-b),kept:number[]=[];
  const snapped=new Map<number,number>();
  for(const edge of raw){if(!kept.length||edge-kept.at(-1)!>=2)kept.push(edge);snapped.set(edge,kept.at(-1)!);}
  const snap=(value:number)=>snapped.get(value)!;
  const cues=[...dialogue,...sounds].map((cue,order)=>({...cue,startMs:snap(cue.startMs),endMs:snap(cue.endMs),order}))
    .filter(cue=>cue.endMs>cue.startMs).sort((a,b)=>a.startMs-b.startMs||a.order-b.order);
  const edges=kept,result:SdhSegment[]=[];
  for(let index=0;index+1<edges.length;index++){
    const from=edges[index]!,to=edges[index+1]!,active=cues.filter(cue=>cue.startMs<=from&&cue.endMs>=to);
    if(!active.length)continue;
    const text=active.map(cue=>cue.text).join("\n"),last=result.at(-1);
    if(last&&last.endMs===from&&last.text===text)last.endMs=to;else result.push({startMs:from,endMs:to,text});
  }
  return result;
}
const stamp=(ms:number,comma=false)=>{const h=Math.floor(ms/3600000),m=Math.floor(ms/60000)%60,s=Math.floor(ms/1000)%60;
  return String(h).padStart(2,"0")+":"+String(m).padStart(2,"0")+":"+String(s).padStart(2,"0")+(comma?",":".")+String(ms%1000).padStart(3,"0");};
export function sdhVtt(segments:SdhSegment[]):string{
  return "WEBVTT\n\n"+segments.map((segment,index)=>"sdh-"+(index+1)+"\n"+stamp(segment.startMs)+" --> "+stamp(segment.endMs)+"\n"
    +segment.text.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")+"\n").join("\n");
}
/**
 * The subtitle track as the delivered file decodes it, read back through SubRip.
 *
 * ffmpeg carries timed text through ASS on the way into MP4, and ASS gives a meaning to braces and
 * backslashes that a caption does not have: measured, `{x}` came back as `\{x\}` and `\N` as a line
 * break. Text holding either is refused by name before anything is written rather than delivered
 * altered, and everything else must come back exactly -- which this reading is what shows.
 */
export function parseSdhReadBack(srt:string):SdhSegment[]{
  const body=srt.replace(/\r\n/g,"\n").replace(/\n+$/,"");
  if(!body)return [];
  return body.split("\n\n").map((block,index)=>{
    const [number,timing,...lines]=block.split("\n");
    const time=/^(\d{2}):(\d{2}):(\d{2}),(\d{3}) --> (\d{2}):(\d{2}):(\d{2}),(\d{3})$/.exec(timing??"");
    if(number!==String(index+1)||!time||!lines.length)fail("The delivered SDH track does not read back as timed text.");
    const ms=(offset:number)=>((Number(time[offset])*60+Number(time[offset+1]))*60+Number(time[offset+2]))*1000+Number(time[offset+3]);
    return {startMs:ms(1),endMs:ms(5),text:lines.join("\n")};
  });
}
const digest=async(path:string,signal?:AbortSignal)=>{const sum=createHash("sha256");
  for await(const chunk of Bun.file(path).stream()){signal?.throwIfAborted();sum.update(chunk);}return sum.digest("hex");};
/** The picture and sound packets of a file, hashed without their container: equal means copied. */
async function streams(path:string,name:string,directory:string,access:Access,signal?:AbortSignal):Promise<string>{
  const out=join(directory,name+"-streams.txt");
  await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-i",path,"-map","0:v:0","-map","0:a:0",
    "-c","copy","-f","streamhash","-hash","sha256","-y",out],directory,access,signal);
  return createHash("sha256").update(readFileSync(out,"utf8")).digest("hex");
}
/**
 * HV-027-16: the master, with an SDH track added beside its own picture and sound.
 *
 * The caption track is the film's own, checked by digest, size and cue count before anything is
 * written. The picture and sound are copied, not encoded, and the render proves it by hashing both
 * files' packets. The subtitle track is read back out of the delivered file and must equal what was
 * written, segment for segment.
 */
export async function renderDeliverySdh(master:string,captionsPath:string,plan:DeliverySdhPlan,destination:string,directory:string,access:Access,signal?:AbortSignal):Promise<DeliverySdhResult>{
  const runtimeRevision=soundRuntimeRevision();
  if(statSync(captionsPath).size!==plan.captions.bytes||await digest(captionsPath,signal)!==plan.captions.sha256)
    fail("The caption track this deliverable was given is not the film's own sealed track.");
  const dialogue=parseSealedCaptions(readFileSync(captionsPath,"utf8"));
  if(dialogue.length!==plan.captions.cues)fail("The film's sealed caption track carries "+dialogue.length+" cues and its cut derives "+plan.captions.cues+".");
  const segments=sdhSegments(dialogue.map(cue=>({startMs:cue.startMs,endMs:cue.endMs,text:cue.text})),plan.sounds);
  const unsafe=segments.findIndex(segment=>/[{}\\]/.test(segment.text));
  if(unsafe>=0)fail("SDH segment "+(unsafe+1)+" holds a brace or a backslash, which MP4 timed text cannot carry unaltered: \""+segments[unsafe]!.text.replace(/\n/g," / ").slice(0,120)+"\"");
  const vtt=join(directory,"sdh.vtt");writeFileSync(vtt,sdhVtt(segments));
  await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-i",master,"-i",vtt,
    "-map","0:v:0","-map","0:a:0","-map","1:0","-c:v","copy","-c:a","copy","-c:s","mov_text",
    "-metadata:s:s:0","handler_name=SDH","-disposition:s:0","hearing_impaired+captions",
    "-map_metadata","-1","-fflags","+bitexact","-movflags","+faststart","-y",destination],directory,access,signal);
  const probeFile=join(directory,"sdh-probe.json");
  await soundProcessingCommand(["ffprobe","-v","error","-show_streams","-show_format","-of","json","-o",probeFile,destination],directory,access,signal);
  const probe=JSON.parse(await Bun.file(probeFile).text()) as {streams?:Record<string,any>[];format?:Record<string,unknown>};
  const video=probe.streams?.filter(stream=>stream.codec_type==="video"),audio=probe.streams?.filter(stream=>stream.codec_type==="audio"),
    text=probe.streams?.filter(stream=>stream.codec_type==="subtitle");
  if(video?.length!==1||audio?.length!==1)fail("The SDH deliverable carries the master's one picture and one soundtrack.");
  if(Number(video[0]!.width)!==plan.output.width||Number(video[0]!.height)!==plan.output.height)
    fail("The SDH deliverable is "+video[0]!.width+" by "+video[0]!.height+" and the master is "+plan.output.width+" by "+plan.output.height+".");
  if(text?.length!==1||text[0]!.codec_name!=="mov_text"||text[0]!.disposition?.hearing_impaired!==1||text[0]!.tags?.handler_name!=="SDH")
    fail("The SDH deliverable carries one timed-text track marked for the hearing impaired.");
  const back=join(directory,"sdh-back.srt");
  await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-i",destination,"-map","0:s:0","-f","srt","-y",back],directory,access,signal);
  const readBack=parseSdhReadBack(readFileSync(back,"utf8"));
  const [masterStreams,deliveredStreams]=[await streams(master,"master",directory,access,signal),await streams(destination,"delivered",directory,access,signal)];
  const check:DeliverySdhCheck={schema:"hv-delivery-sdh-check/1",captionsSha256:plan.captions.sha256,dialogue:dialogue.length,sounds:plan.sounds.length,
    segments:segments.length,segmentsSha256:contentHash(segments),readBackSha256:contentHash(readBack),masterStreams,deliveredStreams,
    track:{codec:"mov_text",hearingImpaired:true,handler:"SDH"}};
  validateDeliverySdhCheck(check,plan);
  const durationSec=Number(probe.format?.duration??0);
  const data={schema:"hv-delivery-sdh-result/1" as const,plan,recipeRevision:contentHash(DELIVERY_SDH_RECIPE),runtimeRevision,
    file:{path:destination,sha256:await digest(destination,signal),bytes:statSync(destination).size},
    delivered:{width:Number(video[0]!.width),height:Number(video[0]!.height),durationSec,video:String(video[0]!.codec_name),audio:String(audio[0]!.codec_name)},check};
  return {...data,revision:contentHash(data)};
}
