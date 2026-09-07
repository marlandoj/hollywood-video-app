import {createHash} from "node:crypto";
import {conformEditPicture,editFrameHashes,type EditPictureResult} from "./edit-picture";
export {editFrameHashes} from "./edit-picture";
import {closeSync,existsSync,lstatSync,mkdirSync,openSync,readFileSync,readSync,realpathSync,statSync,writeFileSync,writeSync} from "node:fs";
import {join,resolve,sep} from "node:path";
import {contentHash} from "./capabilities";
import {soundWavHeader,soundRuntimeRevision} from "./sound-audio";
import {soundProcessingCommand} from "./sound-finishing";
import {soundDigest} from "./sound-media";
import {validateExport} from "../../assembler/src/index";
import type {RenderFile} from "../../planner/src/shot-reuse";
import {EDIT_AUDIO_LANES,editCaptionCues,editEnvelopeGain,editFail,editSpeechCuts,editUnmeasuredCuts,validateEditTimeline,type EditTimeline} from "../../planner/src/edit-timeline";

type Access=()=>Promise<void>;
type Lane=typeof EDIT_AUDIO_LANES[number];
export interface EditConformSource {id:string;picture:RenderFile;audio:Partial<Record<Lane,RenderFile>>}
export const EDIT_CONFORM_RECIPE={schema:"hv-edit-conform-recipe/2",fps:30,sampleRate:48000,samplesPerFrame:1600,pictureMaster:"ffv1-yuv420p-sequential-parts",export:"h264-crf18-aac256k",background:"black",audio:"q20-gain-source-relative-linear-fades-s24le",sum:"round-each-lane-then-integer-sum-reject-clipping",captionTime:"48k-source-samples-floor-start-ceil-end-ms",pictureTiming:"verified-whole-second-seek-frame-offset-sequential-spans"} as const;
export interface EditConformReport {schema:"hv-edit-conform-result/1";timelineRevision:string;engineVersion:string;recipeRevision:string;picture:EditPictureResult;pictureFrames:string[];peaks:Record<Lane|"final",number>;audio:Record<Lane|"final",string>;captionsSha256:string;sourceFiles:RenderFile[];speechCuts:ReturnType<typeof editSpeechCuts>;unmeasuredAudioCuts:string[]}
function local(root:string,key:string):string{if(!/^[A-Za-z0-9._/-]+$/.test(key)||key.split("/").some(p=>!p||p==="."||p===".."))editFail("Invalid editorial media path.");const p=resolve(root,key);if(!p.startsWith(root+sep)||!lstatSync(p).isFile()||lstatSync(p).isSymbolicLink()||!realpathSync(p).startsWith(root+sep))editFail("Editorial media escaped its workspace.");return p;}
async function verifyFile(root:string,file:RenderFile,signal?:AbortSignal):Promise<string>{const path=local(root,file.path),d=await soundDigest(path,signal);if(d.sha256!==file.sha256||d.bytes!==file.bytes)editFail("A retained editorial source changed.");return path;}
function read(fd:number,position:number,length:number):Buffer{const b=Buffer.alloc(length);if(readSync(fd,b,0,length,position)!==length)editFail("An editorial waveform changed while reading.");return b;}
function sample(v:number):number{const n=Math.round(v);if(!Number.isFinite(v)||n< -8388608||n>8388607)editFail("The edited soundtrack would clip. Reduce overlapping clip levels before rendering.");return n;}

/** Each clip addresses exact source samples. Processing is bounded by a chunk and has no hidden normalization. */
export async function conformEditAudio(timeline:EditTimeline,sources:EditConformSource[],root:string,directory:string,access:Access,signal?:AbortSignal):Promise<Pick<EditConformReport,"peaks"|"audio">>{
  const t=validateEditTimeline(timeline),canonical=realpathSync(root),inputs=new Map<string,number>(),outputs=new Map<Lane|"final",number>(),peaks=Object.fromEntries([...EDIT_AUDIO_LANES,"final"].map(l=>[l,0])) as Record<Lane|"final",number>;
  mkdirSync(directory,{recursive:true});try{
    for(const c of t.clips.filter(c=>EDIT_AUDIO_LANES.includes(c.lane as Lane))){const key=c.sourceId+":"+c.lane;if(inputs.has(key))continue;const source=t.sources.find(s=>s.id===c.sourceId)!,file=sources.find(s=>s.id===c.sourceId)?.audio[c.lane as Lane];if(!file)editFail("The retained "+c.lane+" source waveform is missing.");await access();const path=await verifyFile(canonical,file,signal),fd=openSync(path,"r");inputs.set(key,fd);if(statSync(path).size!==44+source.frames*1600*6||!read(fd,0,44).equals(soundWavHeader(source.frames*1600)))editFail("Editorial sound must retain canonical stereo 48 kHz 24-bit samples.");}
    for(const lane of [...EDIT_AUDIO_LANES,"final"] as const){const fd=openSync(join(directory,lane+".wav"),"wx");outputs.set(lane,fd);writeSync(fd,soundWavHeader(t.frames*1600));}
    const clips=t.clips.filter(c=>EDIT_AUDIO_LANES.includes(c.lane as Lane));for(let offset=0;offset<t.frames*1600;offset+=32768){await access();signal?.throwIfAborted();const count=Math.min(32768,t.frames*1600-offset),lanes=Object.fromEntries(EDIT_AUDIO_LANES.map(l=>[l,new Float64Array(count*2)])) as Record<Lane,Float64Array>;
      for(const c of clips){const start=Math.max(offset,c.at*1600),end=Math.min(offset+count,(c.at+c.frames)*1600);if(end<=start)continue;const sourceSample=c.from*1600+start-c.at*1600,pcm=read(inputs.get(c.sourceId+":"+c.lane)!,44+sourceSample*6,(end-start)*6),scale=Math.round(10**(c.gainDb/20)*1048576),target=lanes[c.lane as Lane];
        for(let i=0;i<end-start;i++){const factor=Math.round(scale*editEnvelopeGain(c,(sourceSample+i)/1600));for(let ch=0;ch<2;ch++)target[(start-offset+i)*2+ch]!+=pcm.readIntLE(i*6+ch*3,3)*factor/1048576;}
      }
      const mixed=new Int32Array(count*2);for(const lane of EDIT_AUDIO_LANES){const pcm=Buffer.alloc(count*6);for(let i=0;i<count*2;i++){const v=sample(lanes[lane][i]!);pcm.writeIntLE(v,i*3,3);mixed[i]!+=v;peaks[lane]=Math.max(peaks[lane],Math.abs(v));}writeSync(outputs.get(lane)!,pcm);}
      const final=Buffer.alloc(count*6);for(let i=0;i<count*2;i++){const v=sample(mixed[i]!);final.writeIntLE(v,i*3,3);peaks.final=Math.max(peaks.final,Math.abs(v));}writeSync(outputs.get("final")!,final);
    }
  }finally{for(const fd of [...inputs.values(),...outputs.values()])closeSync(fd);}
  return {peaks,audio:Object.fromEntries(await Promise.all([...EDIT_AUDIO_LANES,"final"].map(async lane=>[lane,(await soundDigest(join(directory,lane+".wav"),signal)).sha256]))) as Record<Lane|"final",string>};
}
function vttTime(samples:number,end=false){const n=end?Math.ceil(samples/48):Math.floor(samples/48),h=Math.floor(n/3600000),m=Math.floor(n/60000)%60,s=Math.floor(n/1000)%60;return String(h).padStart(2,"0")+":"+String(m).padStart(2,"0")+":"+String(s).padStart(2,"0")+"."+String(n%1000).padStart(3,"0");}
export function editVtt(t:EditTimeline):string{return "WEBVTT\n\n"+editCaptionCues(t).map(c=>c.id+"\n"+vttTime(c.start)+" --> "+vttTime(c.end,true)+"\n"+c.text.replace(/\r\n?/g,"\n").replace(/\n{2,}/g,"\n").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")+"\n").join("\n");}
/** This media engine consumes admitted owned sources; the API/queue layer owns permission and source receipts. */
export async function conformEdit(timeline:EditTimeline,sources:EditConformSource[],root:string,destination:string,access:Access,signal?:AbortSignal):Promise<EditConformReport>{
  const t=validateEditTimeline(timeline),canonical=realpathSync(root),engineVersion=soundRuntimeRevision();if(!resolve(destination).startsWith(canonical+sep)||existsSync(destination))editFail("Choose a new owned editorial destination.");mkdirSync(destination,{recursive:true});if(realpathSync(destination)!==resolve(destination))editFail("Editorial destination escaped its workspace.");
  const sourceIds=[...new Set(t.clips.filter(c=>c.lane==="picture").map(c=>c.sourceId))],pictureSources=new Map<string,string>(),sourceFiles:RenderFile[]=[];
  for(const [i,id]of sourceIds.entries()){const s=t.sources.find(s=>s.id===id)!,file=sources.find(s=>s.id===id)?.picture;if(!file)editFail("The retained picture source is missing.");await access();const path=await verifyFile(canonical,file,signal),probePath=join(destination,"source-"+i+"-probe.json");pictureSources.set(id,path);if(!sourceFiles.some(f=>f.path===file.path))sourceFiles.push(file);
    await soundProcessingCommand(["ffprobe","-v","error","-protocol_whitelist","file,pipe","-count_frames","-show_streams","-of","json","-o",probePath,path],destination,access,signal);const streams=JSON.parse(readFileSync(probePath,"utf8")).streams.filter((v:any)=>v.codec_type==="video");if(streams.length!==1||streams[0].width!==s.width||streams[0].height!==s.height||streams[0].r_frame_rate!=="30/1"||Number(streams[0].nb_read_frames)!==s.frames)editFail("The retained editorial source changed its dimensions, frame rate or decoded frame count.");
  }
  for(const c of t.clips.filter(c=>EDIT_AUDIO_LANES.includes(c.lane as Lane))){const file=sources.find(s=>s.id===c.sourceId)?.audio[c.lane as Lane];if(file&&!sourceFiles.some(f=>f.path===file.path))sourceFiles.push(file);}
  const audio=await conformEditAudio(t,sources,canonical,join(destination,"audio"),access,signal),{picture,pictureFrames}=await conformEditPicture(t,pictureSources,destination,access,signal),mp4=join(destination,"export.mp4");
  await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-f","concat","-safe","1","-threads","1","-i",join(destination,picture.concatFile),"-i",join(destination,"audio/final.wav"),"-map","0:v:0","-map","1:a:0","-vf","settb=1/30,setpts=N","-c:v","libx264","-preset","veryfast","-crf","18","-threads","1","-pix_fmt","yuv420p","-r","30","-c:a","aac","-b:a","256k","-ar","48000","-ac","2","-t",String(t.frames/30),"-map_metadata","-1","-movflags","+faststart",mp4],destination,access,signal);
  const probePath=join(destination,"export-probe.json");await soundProcessingCommand(["ffprobe","-v","error","-show_streams","-show_format","-of","json","-o",probePath,mp4],destination,access,signal);validateExport(JSON.parse(readFileSync(probePath,"utf8")),{width:t.width,height:t.height,fps:30,durationSec:t.frames/30});
  await editFrameHashes(mp4,t.frames,join(destination,"export-frames.txt"),destination,access,signal);const captions=editVtt(t);writeFileSync(join(destination,"captions.vtt"),captions,{flag:"wx"});mkdirSync(join(destination,"hls"));
  await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-i",mp4,"-map","0:v:0","-map","0:a:0","-c","copy","-hls_time","2","-hls_list_size","0","-hls_playlist_type","vod","-hls_segment_filename",join(destination,"hls/segment-%03d.ts"),join(destination,"hls/index.m3u8")],destination,access,signal);
  if(soundRuntimeRevision()!==engineVersion)editFail("The editorial runtime changed during export.");const report:EditConformReport={schema:"hv-edit-conform-result/1",timelineRevision:t.revision,engineVersion,recipeRevision:contentHash(EDIT_CONFORM_RECIPE),picture,pictureFrames,...audio,captionsSha256:createHash("sha256").update(captions).digest("hex"),sourceFiles:sourceFiles.sort((a,b)=>a.path.localeCompare(b.path)),speechCuts:editSpeechCuts(t),unmeasuredAudioCuts:editUnmeasuredCuts(t)};writeFileSync(join(destination,"timeline.json"),JSON.stringify(t,null,2)+"\n",{flag:"wx"});writeFileSync(join(destination,"conform.json"),JSON.stringify(report,null,2)+"\n",{flag:"wx"});await access();return report;
}
