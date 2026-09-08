import {closeSync,openSync,readSync,writeSync,rmSync,statSync} from "node:fs";
import {join} from "node:path";
import type {EditTimeline} from "../../planner/src/edit-timeline";
import {editFail} from "../../planner/src/edit-errors";
import {editRgbaGroups} from "../../planner/src/edit-rgba";
import type {EditRenderClip} from "../../planner/src/edit-transition-render";
import {soundProcessingCommand} from "./sound-finishing";

type Access=()=>Promise<void>;
/** Keep alpha in its native 8-bit plane: swscale's high-depth round trip changes 128 to 129. */
export function editRgbaResize(scale:string):string{const precise=scale+"+accurate_rnd+bitexact";return `format=rgba,split=2[rgba_color][rgba_alpha];[rgba_color]format=gbrapf32le,premultiply=inplace=1,${precise},unpremultiply=inplace=1,format=rgba[rgba_fitted];[rgba_alpha]alphaextract,${precise},format=gray[rgba_matte];[rgba_fitted][rgba_matte]alphamerge,format=rgba`;}
export function editRgbaTransform(c:EditRenderClip,t:EditTimeline):string{
  const source=t.sources.find(s=>s.id===c.sourceId)!,graphic=source.media==="graphic-rgba",crop=c.crop?`crop=${c.crop.width}:${c.crop.height}:${c.crop.x}:${c.crop.y},`:"",size=c.crop??source,resize=Math.min(t.width/size.width,t.height/size.height)!==1;
  return `${crop}${resize?editRgbaResize(`scale=${t.width}:${t.height}:force_original_aspect_ratio=decrease:flags=bicubic`):"format=rgba"},pad=${t.width}:${t.height}:(ow-iw)/2:(oh-ih)/2:color=${graphic?"black@0":"black"},setsar=1`;
}
function readFrame(fd:number,frame:Buffer){let offset=0;while(offset<frame.length){const count=readSync(fd,frame,offset,frame.length-offset,null);if(!count)editFail("Native-alpha composition lost a source frame.");offset+=count;}}
function writeFrame(fd:number,frame:Buffer){let offset=0;while(offset<frame.length){const count=writeSync(fd,frame,offset,frame.length-offset);if(!count)editFail("Native-alpha composition could not retain its frame.");offset+=count;}}
/** Three reusable frame buffers; no number of clips can increase the resident decoded frame count. */
export async function conformEditRgbaSpan(t:EditTimeline,clips:EditRenderClip[],at:number,frames:number,scratch:string,destination:string,prepare:(clip:EditRenderClip,index:number)=>Promise<string>,access:Access,signal?:AbortSignal):Promise<void>{
  const bytes=t.width*t.height*4,groups=editRgbaGroups(clips,at),canvas=Buffer.alloc(bytes),left=Buffer.alloc(bytes),right=Buffer.alloc(bytes);let previous:string|undefined,index=0;
  for(const [groupIndex,group]of groups.entries()){
    const paths:string[]=[];
    for(const {clip}of group){const raw=await prepare(clip,index++),path=join(scratch,"rgba-layer-"+paths.length+".raw");await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-filter_threads","1","-threads","1","-i",raw,"-map","0:v:0","-vf",editRgbaTransform(clip,t),"-frames:v",String(frames),"-an","-c:v","rawvideo","-threads","1","-pix_fmt","rgba","-fps_mode","passthrough","-f","rawvideo",path],scratch,access,signal);if(statSync(path).size!==bytes*frames)editFail("The fitted native-alpha picture changed its frame count.");rmSync(raw);paths.push(path);}
    const output=join(scratch,"rgba-composite-"+groupIndex+".raw"),fds:number[]=[];let target:number|undefined,base:number|undefined;
    try{
      for(const path of paths)fds.push(openSync(path,"r"));if(previous)base=openSync(previous,"r");target=openSync(output,"wx");
      for(let frame=0;frame<frames;frame++){
        signal?.throwIfAborted();await access();if(base!==undefined)readFrame(base,canvas);else{canvas.fill(0);for(let p=3;p<bytes;p+=4)canvas[p]=255;}readFrame(fds[0]!,left);if(fds[1]!==undefined)readFrame(fds[1],right);
        const weights=editRgbaGroups(clips,at+frame)[groupIndex]!,a=weights[0]!.alpha/65025,b=(weights[1]?.alpha??0)/65025;
        for(let p=0;p<bytes;p+=4){const la=left[p+3]!*a,ra=b?right[p+3]!*b:0,background=1-la-ra;for(let ch=0;ch<3;ch++)canvas[p+ch]=Math.round(left[p+ch]!*la+(b?right[p+ch]!*ra:0)+canvas[p+ch]!*background);}
        writeFrame(target,canvas);await Bun.sleep(0);
      }
    }finally{for(const fd of fds)closeSync(fd);if(base!==undefined)closeSync(base);if(target!==undefined)closeSync(target);}
    for(const path of paths)rmSync(path);if(previous)rmSync(previous);previous=output;
  }
  if(!previous)editFail("Choose a native picture layer before composition.");
  await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-filter_threads","1","-f","rawvideo","-pixel_format","rgba","-video_size",`${t.width}x${t.height}`,"-framerate","30","-threads","1","-i",previous,"-frames:v",String(frames),"-an","-r","30","-c:v","ffv1","-level","3","-threads","1","-pix_fmt","yuv420p","-map_metadata","-1",destination],scratch,access,signal);rmSync(previous);
}
