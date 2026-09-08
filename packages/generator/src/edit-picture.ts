import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,statSync,writeFileSync,openSync,readSync,writeSync,closeSync} from "node:fs";
import {createHash} from "node:crypto";
import {join,sep} from "node:path";
import {soundProcessingCommand} from "./sound-finishing";
import {soundDigest} from "./sound-media";
import {editFail,validateEditTimeline,type EditTimeline} from "../../planner/src/edit-timeline";
import {EditTime,EDIT_TIME_RECIPE} from "../../planner/src/edit-time";
import {EDIT_RGBA_RECIPE,editRgbaNeeded} from "../../planner/src/edit-rgba";
import {conformEditRgbaSpan,editRgbaTransform} from "./edit-rgba-picture";
import {editRenderClips,editRenderOrder,editRenderPictureAlpha,editRenderAlphaExpression,EDIT_CROSSFADE_RECIPE,type EditRenderClip} from "../../planner/src/edit-transition-render";

type Access=()=>Promise<void>;
export const EDIT_PICTURE_RECIPE={schema:"hv-edit-picture/2",maxPartFrames:60,seek:"whole-second-accurate-then-frame-offset",sourceValidation:"decoded-frame-hash-each-selected-range",composition:"sequential-spans-sequential-layers",decoderThreads:1,filterThreads:1,alpha:"floor-255-opacity-source-relative-linear-envelope",master:"ffv1-yuv420p-parts",timing:"frame-counter-30fps"} as const;
export function editPictureRecipe(t:EditTimeline){const base=t.clips.some(c=>c.timing)?{...EDIT_PICTURE_RECIPE,schema:"hv-edit-picture/3",seek:"whole-second-selected-frame-reconstruction",alpha:"floor-255-opacity-output-phase-linear-envelope",timing:"integrated-source-clock-at-30fps",time:EDIT_TIME_RECIPE}:EDIT_PICTURE_RECIPE,transition=t.transitions?.length?{...base,schema:"hv-edit-picture/4",crossfade:EDIT_CROSSFADE_RECIPE}:base;return editRgbaNeeded(t,t.clips)?{...transition,schema:"hv-edit-picture/5",rgba:EDIT_RGBA_RECIPE}:transition;}
export interface EditPicturePart {file:string;at:number;frames:number;layers:{clipId:string;sourceId:string;from:number;seekSeconds:number;filter:string;sourceFrames?:number[]}[]}
export interface EditPictureResult {recipe:ReturnType<typeof editPictureRecipe>;parts:EditPicturePart[];concatFile:string;sourceFrameFiles:{sourceId:string;file:string}[]}

export async function editFrameHashes(path:string,frames:number,destination:string,cwd:string,access:Access,signal?:AbortSignal,pixelFormat:"yuv420p"|"rgba"="yuv420p"):Promise<string[]>{
  await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-threads","1","-i",path,"-map","0:v:0","-an","-c:v","rawvideo","-threads","1","-pix_fmt",pixelFormat,"-fps_mode","passthrough","-f","framehash",destination],cwd,access,signal);
  return readEditFrameHashes(destination,frames);
}
export function readEditFrameHashes(destination:string,frames:number):string[]{
  if(statSync(destination).size>24*1024**2)editFail("Frame evidence exceeded its limit.");const text=readFileSync(destination,"utf8");if(!/^#tb 0: 1\/30\r?$/m.test(text))editFail("Editorial sources require a constant 30 fps time base.");
  const hashes=text.split(/\r?\n/).filter(l=>l&&!l.startsWith("#")).map((l,index)=>{const fields=l.split(",").map(s=>s.trim());if(fields.length!==6||Number(fields[1])!==index||Number(fields[2])!==index||Number(fields[3])!==1||!/^[a-f0-9]{64}$/.test(fields[5]!))editFail("Editorial frames lost their constant-rate source timing.");return fields[5]!;});if(hashes.length!==frames)editFail("The editorial picture has the wrong frame count.");return hashes;
}
export function pictureSpans(timeline:EditTimeline):{at:number;frames:number;clips:EditRenderClip[]}[]{
  const t=validateEditTimeline(timeline),clips=editRenderClips(t).filter(c=>c.lane==="picture").sort(editRenderOrder),edges=[...new Set([0,t.frames,...clips.flatMap(c=>[c.at,c.at+c.frames,...(c.crossfades??[]).flatMap(x=>[x.at,x.at+x.frames])])])].sort((a,b)=>a-b),spans:ReturnType<typeof pictureSpans>=[];
  for(let i=0;i<edges.length-1;i++)for(let at=edges[i]!;at<edges[i+1]!;at+=60){const frames=Math.min(60,edges[i+1]!-at);spans.push({at,frames,clips:clips.filter(c=>c.at<=at&&c.at+c.frames>=at+frames)});}return spans;
}
export function editPictureTransform(c:EditRenderClip,at:number,t:EditTimeline):string{
  if(editRgbaNeeded(t,editRenderClips(t).filter(c=>c.at<=at&&at<c.at+c.frames)))return editRgbaTransform(c,t);
  const crop=c.crop?`crop=${c.crop.width}:${c.crop.height}:${c.crop.x}:${c.crop.y},`:"",a=c.opacity!==1||c.envelope.fadeIn||c.envelope.fadeOut||c.crossfades?.length?`,geq=lum='lum(X,Y)':cb='cb(X,Y)':cr='cr(X,Y)':a='${editRenderAlphaExpression(c,at)}':interpolation=nearest`:"";
  return `${crop}scale=${t.width}:${t.height}:force_original_aspect_ratio=decrease,pad=${t.width}:${t.height}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuva420p${a}`;
}
export function editPictureOpaque(c:EditRenderClip,at:number,frames:number):boolean{
  if(c.crossfades?.length){for(let frame=at;frame<at+frames;frame++)if(editRenderPictureAlpha(c,frame)!==255)return false;return true;}
  return editRenderPictureAlpha(c,at)===255&&editRenderPictureAlpha(c,at+frames-1)===255;
}
export function editPictureSpanClips(span:{at:number;frames:number;clips:EditRenderClip[]},sources:EditTimeline["sources"]):EditRenderClip[]{if(editRgbaNeeded({sources},span.clips))return span.clips;let first=0;for(let i=0;i<span.clips.length;i++)if(editPictureOpaque(span.clips[i]!,span.at,span.frames))first=i;return span.clips.slice(first);}
const ffv1=["-an","-r","30","-c:v","ffv1","-level","3","-threads","1","-pix_fmt","yuv420p","-map_metadata","-1"];
const sourceFfv1=(pixelFormat:"rgba"|"yuv420p")=>pixelFormat==="rgba"?ffv1.map(v=>v==="yuv420p"?"bgra":v):ffv1;
/** Decode at most sixty distinct requested frames and reconstruct holds with one frame of RAM. */
async function retimedPart(source:string,frames:number[],width:number,height:number,expected:string[],raw:string,scratch:string,access:Access,signal:AbortSignal|undefined,pixelFormat:"rgba"|"yuv420p"){
  const unique=[...new Set(frames)],seek=Math.floor(unique[0]!/30),selected=raw+".selected.raw",ordered=raw+".ordered.raw",bytes=pixelFormat==="rgba"?width*height*4:width*height+2*Math.ceil(width/2)*Math.ceil(height/2),select=unique.map(f=>`eq(n,${f-seek*30})`).join("+");
  await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-threads","1","-ss",String(seek),"-accurate_seek","-i",source,"-map","0:v:0","-vf",`select='${select}',settb=1/30,setpts=N`,"-frames:v",String(unique.length),"-an","-c:v","rawvideo","-threads","1","-pix_fmt",pixelFormat,"-fps_mode","passthrough","-f","rawvideo",selected],scratch,access,signal);
  if(statSync(selected).size!==unique.length*bytes)editFail("Retimed picture decoding lost a selected frame.");
  const input=openSync(selected,"r");let output:number|undefined;
  try{output=openSync(ordered,"wx");const buffer=Buffer.alloc(bytes);let last=-1;
    for(const frame of frames){await access();signal?.throwIfAborted();if(frame!==last){if(readSync(input,buffer,0,bytes,unique.indexOf(frame)*bytes)!==bytes||createHash("sha256").update(buffer).digest("hex")!==expected[frame])editFail("A retimed picture seek returned a different source frame.");last=frame;}let offset=0;while(offset<bytes){const written=writeSync(output,buffer,offset,bytes-offset);if(!written)editFail("Retimed picture writing stopped.");offset+=written;}}
  }finally{closeSync(input);if(output!==undefined)closeSync(output);}
  await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-f","rawvideo","-pixel_format",pixelFormat,"-video_size",`${width}x${height}`,"-framerate","30","-threads","1","-i",ordered,"-frames:v",String(frames.length),...sourceFfv1(pixelFormat),raw],scratch,access,signal);rmSync(selected);rmSync(ordered);
}
/** Never decode a whole cut through parallel trim branches. At most two video inputs run in one process. */
export async function conformEditPicture(timeline:EditTimeline,sources:Map<string,string>,directory:string,access:Access,signal?:AbortSignal):Promise<{picture:EditPictureResult;pictureFrames:string[]}>{
  const t=validateEditTimeline(timeline),root=realpathSync(directory),pictureRoot=join(root,"picture");mkdirSync(pictureRoot);const scratch=mkdtempSync(join(root,".picture-work-")),sourceFrames=new Map<string,string[]>(),sourceFrameFiles:EditPictureResult["sourceFrameFiles"]=[],parts:EditPicturePart[]=[],pictureFrames:string[]=[];
  try{
    for(const id of new Set(t.clips.filter(c=>c.lane==="picture").map(c=>c.sourceId))){const s=t.sources.find(s=>s.id===id)!,path=sources.get(id);if(!path)editFail("A picture source is unavailable.");const file="picture/source-"+sourceFrames.size+"-frames.txt";sourceFrames.set(id,await editFrameHashes(path,s.frames,join(root,file),scratch,access,signal,s.media==="graphic-rgba"?"rgba":"yuv420p"));sourceFrameFiles.push({sourceId:id,file});}
    for(const [index,span]of pictureSpans(t).entries()){
      await access();signal?.throwIfAborted();const name="part-"+String(index).padStart(5,"0")+".mkv",file="picture/"+name,part:EditPicturePart={file,at:span.at,frames:span.frames,layers:[]};let previous:string|undefined,lastHashes:string[]|undefined;
      const clips=editPictureSpanClips(span,t.sources),native=editRgbaNeeded(t,clips),prepare=async(c:EditRenderClip,i:number)=>{
        const time=new EditTime(c),wanted=c.timing?Array.from({length:span.frames},(_,n)=>time.frame(span.at+n)):undefined,from=time.frame(span.at),s=t.sources.find(s=>s.id===c.sourceId)!,seekSeconds=Math.floor(from/30),offset=from-seekSeconds*30,source=sources.get(c.sourceId)!,raw=join(scratch,`raw-${i}.mkv`),rawHashesPath=join(scratch,`raw-${i}.txt`),decoded=join(scratch,`composite-${i}.mkv`);
        const pixelFormat=s.media==="graphic-rgba"?"rgba":"yuv420p";
        if(wanted)await retimedPart(source,wanted,s.width,s.height,sourceFrames.get(c.sourceId)!,raw,scratch,access,signal,pixelFormat);else await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-threads","1","-ss",String(seekSeconds),"-accurate_seek","-i",source,"-map","0:v:0","-vf",`trim=start_frame=${offset}:end_frame=${offset+span.frames},settb=1/30,setpts=N`,"-frames:v",String(span.frames),...sourceFfv1(pixelFormat),raw],scratch,access,signal);
        const hashes=await editFrameHashes(raw,span.frames,rawHashesPath,scratch,access,signal,pixelFormat),expected=wanted?wanted.map(f=>sourceFrames.get(c.sourceId)![f]!):sourceFrames.get(c.sourceId)!.slice(from,from+span.frames);if(hashes.some((h,i)=>h!==expected[i]))editFail("An editorial seek returned different source frames. Rebuild the source's constant-rate picture.");
        const filter=editPictureTransform(c,span.at,t),identity=!c.crop&&s.width===t.width&&s.height===t.height&&editPictureOpaque(c,span.at,span.frames);
        part.layers.push({clipId:c.id,sourceId:c.sourceId,from,seekSeconds,filter,...(wanted?{sourceFrames:wanted}:{})});
        return {raw,rawHashesPath,hashes,filter,identity,decoded};
      };
      if(native)await conformEditRgbaSpan(t,clips,span.at,span.frames,scratch,join(root,file),async(c,i)=>{const p=await prepare(c,i);rmSync(p.rawHashesPath);return p.raw;},access,signal);
      // An opaque fitted film covers the canvas, including its padding. Native alpha uses the path above.
      else for(const [i,c]of clips.entries()){
        const {raw,rawHashesPath,hashes,filter,identity,decoded}=await prepare(c,i);
        if(!previous&&identity){previous=raw;lastHashes=hashes;rmSync(rawHashesPath);continue;}
        const base=previous?["-threads","1","-i",previous]:["-f","lavfi","-i",`color=c=black:s=${t.width}x${t.height}:r=30:d=${span.frames/30}`],graph=`[0:v:0]settb=1/30,setpts=N[base];[1:v:0]settb=1/30,setpts=N,${filter}[clip];[base][clip]overlay=eof_action=pass:repeatlast=0:shortest=1:format=yuv420,trim=end_frame=${span.frames},settb=1/30,setpts=N[out]`;
        await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-filter_complex_threads","1",...base,"-threads","1","-i",raw,"-filter_complex",graph,"-map","[out]","-frames:v",String(span.frames),...ffv1,decoded],scratch,access,signal);
        if(previous)rmSync(previous);rmSync(raw);rmSync(rawHashesPath);previous=decoded;lastHashes=undefined;
      }
      if(previous){copyFileSync(previous,join(root,file),1);rmSync(previous);}else if(!native)await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-f","lavfi","-i",`color=c=black:s=${t.width}x${t.height}:r=30`,"-frames:v",String(span.frames),...ffv1,join(root,file)],scratch,access,signal);
      const partHashes=lastHashes??await editFrameHashes(join(root,file),span.frames,join(scratch,"part-hashes.txt"),scratch,access,signal);pictureFrames.push(...partHashes);if(!lastHashes)rmSync(join(scratch,"part-hashes.txt"));await soundDigest(join(root,file),signal);parts.push(part);
    }
    const concatFile="picture/index.ffconcat";writeFileSync(join(root,concatFile),"ffconcat version 1.0\n"+parts.map(p=>`file '${p.file.slice("picture/".length)}'\nduration ${p.frames/30}\n`).join(""),{flag:"wx"});
    return {picture:{recipe:editPictureRecipe(t),parts,concatFile,sourceFrameFiles},pictureFrames};
  }finally{if(!scratch.startsWith(root+sep)||realpathSync(scratch)!==scratch)editFail("Editorial scratch escaped its workspace.");rmSync(scratch,{recursive:true,force:true});}
}
