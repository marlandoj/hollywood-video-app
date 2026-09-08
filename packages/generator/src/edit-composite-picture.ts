import {closeSync,openSync,readSync,writeSync,rmSync,statSync} from "node:fs";
import {join} from "node:path";
import type {EditTimeline} from "../../planner/src/edit-timeline";
import {editCompositeGraph} from "../../planner/src/edit-composite";
import {editCompositeCheckpoint,fitEditCompositeFrame,applyEditTrackMatte,blendEditCompositeGroup} from "../../planner/src/edit-composite-render";
import {EditTime} from "../../planner/src/edit-time";
import {editRgbaGroups} from "../../planner/src/edit-rgba";
import type {EditRenderClip} from "../../planner/src/edit-transition-render";
import {editFail} from "../../planner/src/edit-errors";
import {soundProcessingCommand} from "./sound-finishing";
type Access=()=>Promise<void>;
function readFrame(fd:number,buffer:Buffer,frame:number){let offset=0;while(offset<buffer.length){const read=readSync(fd,buffer,offset,buffer.length-offset,frame*buffer.length+offset);if(!read)editFail("Effect composition lost a retained frame.");offset+=read;}}
function writeFrame(fd:number,buffer:Buffer){let offset=0;while(offset<buffer.length){const written=writeSync(fd,buffer,offset,buffer.length-offset);if(!written)editFail("Effect composition could not retain its frame.");offset+=written;}}
/** Decode two selected clips at most; isolated dependency tracks live in bounded sixty-frame files. */
export async function conformEditCompositeSpan(t:EditTimeline,clips:EditRenderClip[],at:number,frames:number,scratch:string,destination:string,prepare:(clip:EditRenderClip,index:number)=>Promise<string>,access:Access,signal?:AbortSignal):Promise<void>{
  const bytes=t.width*t.height*4,tracks=new Map<number,string>(),graph=editCompositeGraph(t),canvas=Buffer.alloc(bytes),left=Buffer.alloc(bytes),right=Buffer.alloc(bytes),matte=Buffer.alloc(bytes),sourceBuffer=Buffer.alloc(Math.max(...t.sources.map(s=>s.width*s.height*4))),checkpoint=editCompositeCheckpoint({access,signal,yield:()=>Bun.sleep(0)});let prepared=0;
  for(const layer of graph.order){const layerClips=clips.filter(c=>c.layer===layer);let previous:string|undefined;
    for(const [groupIndex,group]of editRgbaGroups(layerClips,at).entries()){
      const paths:string[]=[];
      for(const {clip}of group){const raw=await prepare(clip,prepared++),source=t.sources.find(s=>s.id===clip.sourceId)!,path=join(scratch,"effect-original-"+paths.length+".raw");await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-filter_threads","1","-threads","1","-i",raw,"-map","0:v:0","-frames:v",String(frames),"-an","-c:v","rawvideo","-threads","1","-pix_fmt","rgba","-fps_mode","passthrough","-f","rawvideo",path],scratch,access,signal);if(statSync(path).size!==source.width*source.height*4*frames)editFail("An effect source changed its decoded frame count.");rmSync(raw);paths.push(path);}
      const output=join(scratch,`effect-layer-${layer}-group-${groupIndex}.raw`),fds:number[]=[],matteFds=new Map<number,number>();let base:number|undefined,target:number|undefined;
      try{
        paths.forEach(path=>fds.push(openSync(path,"r")));if(previous)base=openSync(previous,"r");target=openSync(output,"wx");for(const {clip}of group){const dependency=clip.composite?.matte?.layer,path=dependency===undefined?undefined:tracks.get(dependency);if(path&&!matteFds.has(dependency!))matteFds.set(dependency!,openSync(path,"r"));}
        for(let frame=0;frame<frames;frame++){
          await checkpoint();if(base===undefined)canvas.fill(0);else readFrame(base,canvas,frame);
          for(const [index,{clip}]of group.entries()){const source=t.sources.find(s=>s.id===clip.sourceId)!,original=sourceBuffer.subarray(0,source.width*source.height*4),fitted=index?right:left;readFrame(fds[index]!,original,frame);await fitEditCompositeFrame(clip,source,new EditTime(clip).frame(at+frame),{width:source.width,height:source.height,data:original},t.width,t.height,checkpoint,fitted);if(clip.composite?.matte){const fd=matteFds.get(clip.composite.matte.layer);if(fd!==undefined)readFrame(fd,matte,frame);applyEditTrackMatte(fitted,fd===undefined?undefined:matte,clip.composite.matte);}}
          const weights=editRgbaGroups(layerClips,at+frame)[groupIndex]!;blendEditCompositeGroup(canvas,left,weights[0]!.alpha,group.length===2?right:undefined,weights[1]?.alpha??0);writeFrame(target,canvas);await checkpoint();
        }
      }finally{for(const fd of [...fds,...matteFds.values()])closeSync(fd);if(base!==undefined)closeSync(base);if(target!==undefined)closeSync(target);}
      paths.forEach(path=>rmSync(path));if(previous)rmSync(previous);previous=output;
    }
    if(previous)tracks.set(layer,previous);
  }
  const combined=join(scratch,"effect-visible.raw"),visible=[...tracks.keys()].filter(layer=>!t.matteOnlyLayers?.includes(layer)).sort((a,b)=>a-b),fds:number[]=[];let target:number|undefined;
  try{for(const layer of visible)fds.push(openSync(tracks.get(layer)!,"r"));target=openSync(combined,"wx");for(let frame=0;frame<frames;frame++){canvas.fill(0);for(let p=3;p<bytes;p+=4)canvas[p]=255;for(const fd of fds){readFrame(fd,left,frame);blendEditCompositeGroup(canvas,left,255);await checkpoint();}writeFrame(target,canvas);await checkpoint();}}
  finally{fds.forEach(fd=>closeSync(fd));if(target!==undefined)closeSync(target);}
  for(const path of tracks.values())rmSync(path);
  await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-filter_threads","1","-f","rawvideo","-pixel_format","rgba","-video_size",`${t.width}x${t.height}`,"-framerate","30","-threads","1","-i",combined,"-frames:v",String(frames),"-an","-r","30","-c:v","ffv1","-level","3","-threads","1","-pix_fmt","yuv420p","-map_metadata","-1",destination],scratch,access,signal);rmSync(combined);await access();
}
