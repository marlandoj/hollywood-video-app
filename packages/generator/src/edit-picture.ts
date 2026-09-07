import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,statSync,writeFileSync} from "node:fs";
import {join,sep} from "node:path";
import {soundProcessingCommand} from "./sound-finishing";
import {soundDigest} from "./sound-media";
import {editEnvelopeGain,editFail,validateEditTimeline,type EditClip,type EditTimeline} from "../../planner/src/edit-timeline";

type Access=()=>Promise<void>;
export const EDIT_PICTURE_RECIPE={schema:"hv-edit-picture/2",maxPartFrames:60,seek:"whole-second-accurate-then-frame-offset",sourceValidation:"decoded-frame-hash-each-selected-range",composition:"sequential-spans-sequential-layers",decoderThreads:1,filterThreads:1,alpha:"floor-255-opacity-source-relative-linear-envelope",master:"ffv1-yuv420p-parts",timing:"frame-counter-30fps"} as const;
export interface EditPicturePart {file:string;at:number;frames:number;layers:{clipId:string;sourceId:string;from:number;seekSeconds:number;filter:string}[]}
export interface EditPictureResult {recipe:typeof EDIT_PICTURE_RECIPE;parts:EditPicturePart[];concatFile:string;sourceFrameFiles:{sourceId:string;file:string}[]}

export async function editFrameHashes(path:string,frames:number,destination:string,cwd:string,access:Access,signal?:AbortSignal):Promise<string[]>{
  await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-threads","1","-i",path,"-map","0:v:0","-an","-c:v","rawvideo","-threads","1","-pix_fmt","yuv420p","-fps_mode","passthrough","-f","framehash",destination],cwd,access,signal);
  return readEditFrameHashes(destination,frames);
}
export function readEditFrameHashes(destination:string,frames:number):string[]{
  if(statSync(destination).size>24*1024**2)editFail("Frame evidence exceeded its limit.");const text=readFileSync(destination,"utf8");if(!/^#tb 0: 1\/30\r?$/m.test(text))editFail("Editorial sources require a constant 30 fps time base.");
  const hashes=text.split(/\r?\n/).filter(l=>l&&!l.startsWith("#")).map((l,index)=>{const fields=l.split(",").map(s=>s.trim());if(fields.length!==6||Number(fields[1])!==index||Number(fields[2])!==index||Number(fields[3])!==1||!/^[a-f0-9]{64}$/.test(fields[5]!))editFail("Editorial frames lost their constant-rate source timing.");return fields[5]!;});if(hashes.length!==frames)editFail("The editorial picture has the wrong frame count.");return hashes;
}
export function pictureSpans(timeline:EditTimeline):{at:number;frames:number;clips:EditClip[]}[]{
  const t=validateEditTimeline(timeline),clips=t.clips.filter(c=>c.lane==="picture").sort((a,b)=>a.layer-b.layer||a.at-b.at||a.id.localeCompare(b.id)),edges=[...new Set([0,t.frames,...clips.flatMap(c=>[c.at,c.at+c.frames])])].sort((a,b)=>a-b),spans:ReturnType<typeof pictureSpans>=[];
  for(let i=0;i<edges.length-1;i++)for(let at=edges[i]!;at<edges[i+1]!;at+=60){const frames=Math.min(60,edges[i+1]!-at);spans.push({at,frames,clips:clips.filter(c=>c.at<=at&&c.at+c.frames>=at+frames)});}return spans;
}
function alpha(c:EditClip,from:number):string{const e=c.envelope,phase=from-e.from,terms=["1",...(e.fadeIn?[`(N+${phase})/${e.fadeIn}`]:[]),...(e.fadeOut?[`(${e.frames}-N-${phase})/${e.fadeOut}`]:[])];let minimum=terms[0]!;for(const term of terms.slice(1))minimum=`min(${minimum},${term})`;return `floor(255*${c.opacity}*max(0,${minimum}))`;}
function transform(c:EditClip,from:number,t:EditTimeline):string{
  const crop=c.crop?`crop=${c.crop.width}:${c.crop.height}:${c.crop.x}:${c.crop.y},`:"",a=c.opacity!==1||c.envelope.fadeIn||c.envelope.fadeOut?`,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='${alpha(c,from)}':interpolation=nearest`:"";
  return `${crop}scale=${t.width}:${t.height}:force_original_aspect_ratio=decrease,pad=${t.width}:${t.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuva420p${a}`;
}
const ffv1=["-an","-r","30","-c:v","ffv1","-level","3","-threads","1","-pix_fmt","yuv420p","-map_metadata","-1"];
/** Never decode a whole cut through parallel trim branches. At most two video inputs run in one process. */
export async function conformEditPicture(timeline:EditTimeline,sources:Map<string,string>,directory:string,access:Access,signal?:AbortSignal):Promise<{picture:EditPictureResult;pictureFrames:string[]}>{
  const t=validateEditTimeline(timeline),root=realpathSync(directory),pictureRoot=join(root,"picture");mkdirSync(pictureRoot);const scratch=mkdtempSync(join(root,".picture-work-")),sourceFrames=new Map<string,string[]>(),sourceFrameFiles:EditPictureResult["sourceFrameFiles"]=[],parts:EditPicturePart[]=[],pictureFrames:string[]=[];
  try{
    for(const id of new Set(t.clips.filter(c=>c.lane==="picture").map(c=>c.sourceId))){const s=t.sources.find(s=>s.id===id)!,path=sources.get(id);if(!path)editFail("A picture source is unavailable.");const file="picture/source-"+sourceFrames.size+"-frames.txt";sourceFrames.set(id,await editFrameHashes(path,s.frames,join(root,file),scratch,access,signal));sourceFrameFiles.push({sourceId:id,file});}
    for(const [index,span]of pictureSpans(t).entries()){
      await access();signal?.throwIfAborted();const name="part-"+String(index).padStart(5,"0")+".mkv",file="picture/"+name,part:EditPicturePart={file,at:span.at,frames:span.frames,layers:[]};let previous:string|undefined,lastHashes:string[]|undefined;
      // An opaque fitted picture covers the canvas, including its padding. Hidden lower layers need no composite.
      let first=0;for(let i=0;i<span.clips.length;i++){const c=span.clips[i]!,from=c.from+span.at-c.at;if(c.opacity===1&&editEnvelopeGain(c,from)===1&&editEnvelopeGain(c,from+span.frames-1)===1)first=i;}
      for(const [i,c]of span.clips.slice(first).entries()){
        const from=c.from+span.at-c.at,seekSeconds=Math.floor(from/30),offset=from-seekSeconds*30,source=sources.get(c.sourceId)!,raw=join(scratch,`raw-${i}.mkv`),rawHashesPath=join(scratch,`raw-${i}.txt`),decoded=join(scratch,`composite-${i}.mkv`);
        await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-threads","1","-ss",String(seekSeconds),"-accurate_seek","-i",source,"-map","0:v:0","-vf",`trim=start_frame=${offset}:end_frame=${offset+span.frames},settb=1/30,setpts=N`,"-frames:v",String(span.frames),...ffv1,raw],scratch,access,signal);
        const hashes=await editFrameHashes(raw,span.frames,rawHashesPath,scratch,access,signal),expected=sourceFrames.get(c.sourceId)!.slice(from,from+span.frames);if(hashes.some((h,i)=>h!==expected[i]))editFail("An editorial seek returned different source frames. Rebuild the source's constant-rate picture.");
        const filter=transform(c,from,t),s=t.sources.find(s=>s.id===c.sourceId)!,identity=c.opacity===1&&!c.crop&&s.width===t.width&&s.height===t.height&&editEnvelopeGain(c,from)===1&&editEnvelopeGain(c,from+span.frames-1)===1;
        part.layers.push({clipId:c.id,sourceId:c.sourceId,from,seekSeconds,filter});
        if(!previous&&identity){previous=raw;lastHashes=hashes;rmSync(rawHashesPath);continue;}
        const base=previous?["-threads","1","-i",previous]:["-f","lavfi","-i",`color=c=black:s=${t.width}x${t.height}:r=30:d=${span.frames/30}`],graph=`[0:v:0]settb=1/30,setpts=N[base];[1:v:0]settb=1/30,setpts=N,${filter}[clip];[base][clip]overlay=eof_action=pass:repeatlast=0:shortest=1:format=yuv420,trim=end_frame=${span.frames},settb=1/30,setpts=N[out]`;
        await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-filter_complex_threads","1",...base,"-threads","1","-i",raw,"-filter_complex",graph,"-map","[out]","-frames:v",String(span.frames),...ffv1,decoded],scratch,access,signal);
        if(previous)rmSync(previous);rmSync(raw);rmSync(rawHashesPath);previous=decoded;lastHashes=undefined;
      }
      if(previous){copyFileSync(previous,join(root,file),1);rmSync(previous);}else await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-f","lavfi","-i",`color=c=black:s=${t.width}x${t.height}:r=30`,"-frames:v",String(span.frames),...ffv1,join(root,file)],scratch,access,signal);
      const partHashes=lastHashes??await editFrameHashes(join(root,file),span.frames,join(scratch,"part-hashes.txt"),scratch,access,signal);pictureFrames.push(...partHashes);if(!lastHashes)rmSync(join(scratch,"part-hashes.txt"));await soundDigest(join(root,file),signal);parts.push(part);
    }
    const concatFile="picture/index.ffconcat";writeFileSync(join(root,concatFile),"ffconcat version 1.0\n"+parts.map(p=>`file '${p.file.slice("picture/".length)}'\nduration ${p.frames/30}\n`).join(""),{flag:"wx"});
    return {picture:{recipe:EDIT_PICTURE_RECIPE,parts,concatFile,sourceFrameFiles},pictureFrames};
  }finally{if(!scratch.startsWith(root+sep)||realpathSync(scratch)!==scratch)editFail("Editorial scratch escaped its workspace.");rmSync(scratch,{recursive:true,force:true});}
}
