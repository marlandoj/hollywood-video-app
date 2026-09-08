import {copyFileSync,existsSync,mkdirSync,readFileSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {dirname,join,resolve,sep} from "node:path";
import {contentHash} from "./capabilities";
import {soundRuntimeRevision} from "./sound-audio";
import {soundDigest} from "./sound-media";
import {soundProcessingCommand} from "./sound-finishing";
import {editWorkspaceGuard} from "./edit-workspace";
import type {EditPreviewSource} from "./edit-preview-media";
import {conformEditRgbaSpan} from "./edit-rgba-picture";
import {conformEditCompositeSpan} from "./edit-composite-picture";
import {editPictureRecipe,editPictureSpanClips,editPictureOpaque,editPictureTransform,pictureSpans,readEditFrameHashes} from "./edit-picture";
import {EditAssemblyClock,validateEditAssemblyPlan} from "../../planner/src/edit-assembly-clock";
import type {EditAssemblyPlan} from "../../planner/src/edit-assembly-types";
import {editFail} from "../../planner/src/edit-timeline";
import {editCompositeNeeded} from "../../planner/src/edit-composite";
import {composeEditCompositeFrame} from "../../planner/src/edit-composite-render";
import {editRgbaNeeded} from "../../planner/src/edit-rgba";
import {EditTime} from "../../planner/src/edit-time";
import type {EditRenderClip} from "../../planner/src/edit-transition-render";
import {encodePreviewPage,previewDimensions,PREVIEW_PAGE_FRAMES,PREVIEW_COMPOSITE_RECIPE,type PreviewPageIdentity,type PreviewSelection} from "../../planner/src/edit-preview-protocol";
const ffv1=["-an","-r","30","-c:v","ffv1","-level","3","-threads","1","-pix_fmt","yuv420p","-map_metadata","-1"];
type Access=()=>Promise<void>;

/** Bounded child blocks evaluate original parent spans; sparse callers use exactly the same recipe. */
export class EditAssemblyPreviewPicture {
  readonly sourceKey:string;readonly dimensions:{width:number;height:number};readonly #plan:EditAssemblyPlan;readonly #clock:EditAssemblyClock;readonly #sources:Map<string,EditPreviewSource>;readonly #root:string;readonly #engine=soundRuntimeRevision();readonly #spans:ReturnType<typeof pictureSpans>;
  constructor(plan:EditAssemblyPlan,sources:EditPreviewSource[],root:string){
    this.#plan=validateEditAssemblyPlan(plan);this.#clock=new EditAssemblyClock(this.#plan);this.#spans=pictureSpans(this.#plan.parent.timeline);this.#root=realpathSync(root);this.#sources=new Map(sources.map(source=>[source.source.id,source]));this.dimensions=Object.freeze(previewDimensions(this.#plan.parent.timeline.width,this.#plan.parent.timeline.height));
    if(this.#sources.size!==sources.length||sources.some(source=>source.engineVersion!==this.#engine||contentHash(source.source)!==contentHash(this.#plan.parent.timeline.sources.find(original=>original.id===source.source.id))))editFail("Prepare the assembly parent's unchanged original sources.");
    this.sourceKey=contentHash({schema:"hv-preview-assembly-picture/1",recipe:PREVIEW_COMPOSITE_RECIPE,plan:this.#plan.revision,parentRecipe:editPictureRecipe(this.#plan.parent.timeline),finalColor:"parent-yuv420p-master-to-rgba-then-final-lanczos",engineVersion:this.#engine,sources:sources.map(source=>source.sourceKey).sort()});
  }
  identity(from:number,selection?:PreviewSelection):PreviewPageIdentity {
    const frames=Math.min(PREVIEW_PAGE_FRAMES,this.#plan.frames-from),selected=selection?.pictureFrames;
    if(!Number.isSafeInteger(from)||from<0||from>=this.#plan.frames||from%PREVIEW_PAGE_FRAMES||selection?.includePicture!==true||!Array.isArray(selection.audioLanes)||selection.audioLanes.length||!Array.isArray(selected)||!selected.length||selected.length>16||selected.some((frame,index)=>!Number.isSafeInteger(frame)||frame<from||frame>=from+frames||index>0&&frame<=selected[index-1]!))editFail("Choose at most sixteen distinct ordered child frames within their assembly picture page.");
    return {sourceKey:this.sourceKey,sourceId:"timeline-picture",sourceRevision:this.#plan.revision,engineVersion:this.#engine,sourceFrames:this.#plan.frames,from,frames,...this.dimensions,includePicture:true,audioLanes:[],pictureFrames:[...selected],pictureEncoding:"png-rgba",picturePurpose:"timeline-composite"};
  }
  /** Reserve sixteen MiB for encoded output and containers; source pairs and layer files determine chunk size. */
  #chunkCapacity(clips:EditRenderClip[]):number {
    const t=this.#plan.parent.timeline,effects=editCompositeNeeded(t),native=editRgbaNeeded(t,clips),sourceBytes=Math.max(0,...clips.map(clip=>{const source=t.sources.find(source=>source.id===clip.sourceId)!;return effects||source.media==="graphic-rgba"?source.width*source.height*4:source.width*source.height+2*Math.ceil(source.width/2)*Math.ceil(source.height/2);})),canvas=t.width*t.height*4;
    return Math.min(16,Math.floor(48*1024**2/(sourceBytes*3+canvas*(effects?6:native?4:3))));
  }
  async #render(at:number,frames:number,clips:EditRenderClip[],scratch:string,master:string,access:Access,signal?:AbortSignal){
    const t=this.#plan.parent.timeline,effects=editCompositeNeeded(t),sourceDirectories:string[]=[],prepare=async(clip:EditRenderClip,index:number)=>{const source=this.#sources.get(clip.sourceId);if(!source)editFail("A parent picture original is outside the prepared assembly window.");const directory=join(scratch,"source-"+index),time=new EditTime(clip);sourceDirectories.push(directory);return source.losslessFrames(Array.from({length:frames},(_,frame)=>time.frame(at+frame)),directory,access,signal,effects);};
    if(effects&&this.#chunkCapacity(clips)<1){
      // A maximum-size original may not fit a retained pair. Keep the existing single-frame memory evaluator.
      if(frames!==1)editFail("The assembly effect batch exceeded its frame capacity.");
      const data=await composeEditCompositeFrame(t,at,async(id,originalFrame)=>{const source=this.#sources.get(id);if(!source)editFail("A parent matte dependency is outside the prepared assembly window.");return source.rawFrame(originalFrame,join(scratch,crypto.randomUUID()),access,signal);},{access,signal,yield:()=>Bun.sleep(0)}),raw=join(scratch,"composed.rgba");writeFileSync(raw,data,{flag:"wx"});
      await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-filter_threads","1","-f","rawvideo","-pixel_format","rgba","-video_size",`${t.width}x${t.height}`,"-framerate","30","-threads","1","-i",raw,"-frames:v","1",...ffv1,master],scratch,access,signal);rmSync(raw);
    }else if(effects)await conformEditCompositeSpan(t,clips,at,frames,scratch,master,prepare,access,signal);
    else if(editRgbaNeeded(t,clips))await conformEditRgbaSpan(t,clips,at,frames,scratch,master,prepare,access,signal);
    else{
      let previous:string|undefined;
      for(const [index,clip]of clips.entries()){
        const raw=await prepare(clip,index),source=t.sources.find(source=>source.id===clip.sourceId)!,identity=!clip.crop&&source.width===t.width&&source.height===t.height&&editPictureOpaque(clip,at,frames);
        if(!previous&&identity){previous=raw;continue;}
        const decoded=join(scratch,"composite-"+index+".mkv"),base=previous?["-threads","1","-i",previous]:["-f","lavfi","-i",`color=c=black:s=${t.width}x${t.height}:r=30:d=${frames/30}`],graph=`[0:v:0]settb=1/30,setpts=N[base];[1:v:0]settb=1/30,setpts=N,${editPictureTransform(clip,at,t)}[clip];[base][clip]overlay=eof_action=pass:repeatlast=0:shortest=1:format=yuv420,trim=end_frame=${frames},settb=1/30,setpts=N[out]`;
        await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-filter_complex_threads","1",...base,"-threads","1","-i",raw,"-filter_complex",graph,"-map","[out]","-frames:v",String(frames),...ffv1,decoded],scratch,access,signal);
        if(previous)rmSync(previous);rmSync(raw);previous=decoded;
      }
      if(previous){copyFileSync(previous,master,1);rmSync(previous);}else await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-f","lavfi","-i",`color=c=black:s=${t.width}x${t.height}:r=30`,"-frames:v",String(frames),...ffv1,master],scratch,access,signal);
    }
    for(const path of sourceDirectories){if(!path.startsWith(scratch+sep)||realpathSync(path)!==path)editFail("Assembly picture source cleanup escaped its workspace.");rmSync(path,{recursive:true,force:true});}
  }
  async page(from:number,path:string,access:Access,signal?:AbortSignal,selection?:PreviewSelection){
    const identity=this.identity(from,selection),target=resolve(path),parentDirectory=dirname(target);await access();signal?.throwIfAborted();
    if(!target.startsWith(this.#root+sep)||existsSync(target)||parentDirectory!==this.#root&&!parentDirectory.startsWith(this.#root+sep)||realpathSync(parentDirectory)!==parentDirectory)editFail("Choose an owned assembly picture destination.");mkdirSync(target);
    const disk=editWorkspaceGuard(this.#root,()=>[target],{bytes:64*1024**2,files:32});let last=-Infinity;
    const permission=async(force=false)=>{signal?.throwIfAborted();if(force||Date.now()-last>=1000){await access();disk();if(soundRuntimeRevision()!==this.#engine)editFail("The assembly picture runtime changed.");last=Date.now();}signal?.throwIfAborted();};
    const remove=(path:string)=>{if(!path.startsWith(target+sep)||realpathSync(path)!==path)editFail("Assembly picture scratch escaped its workspace.");rmSync(path,{recursive:true,force:true});};
    try{
      const selected=identity.pictureFrames!,pictures:{frame:number;sourceSha256:string;data:Uint8Array}[]=[],retained=new Map<number,{sourceSha256:string;data:Uint8Array}>(),t=this.#plan.parent.timeline;let index=0;
      while(index<selected.length){
        await permission(true);const frame=selected[index]!,address=this.#clock.frame(frame),parentFrame=address.parentFrame,cached=retained.get(parentFrame);
        if(cached){pictures.push({frame,...cached});index++;continue;}
        const span=this.#spans.find(span=>span.at<=parentFrame&&parentFrame<span.at+span.frames)!;let frames=1;
        const possible=editPictureSpanClips({at:parentFrame,frames:Math.min(span.at+span.frames-parentFrame,selected.length-index),clips:span.clips},t.sources,t),capacity=Math.max(1,this.#chunkCapacity(possible));
        while(frames<capacity&&index+frames<selected.length&&selected[index+frames]===frame+frames&&parentFrame+frames<span.at+span.frames){const next=this.#clock.frame(selected[index+frames]!);if(next.rangeId!==address.rangeId||next.parentFrame!==parentFrame+frames||retained.has(next.parentFrame))break;frames++;}
        const clips=editPictureSpanClips({at:parentFrame,frames,clips:span.clips},t.sources,t),scratch=join(target,"work"),master=join(scratch,"master.mkv");mkdirSync(scratch);await this.#render(parentFrame,frames,clips,scratch,master,permission,signal);
        // One decode authenticates every full-resolution finished frame and encodes its final resized PNG.
        const hashes=join(scratch,"master.txt"),graph=`[0:v:0]format=rgba,split=2[full][image];[image]scale=${this.dimensions.width}:${this.dimensions.height}:flags=lanczos+accurate_rnd,format=rgba,setsar=1[preview]`;
        await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-filter_complex_threads","1","-threads","1","-i",master,"-filter_complex",graph,"-map","[full]","-an","-c:v","rawvideo","-threads","1","-pix_fmt","rgba","-frames:v",String(frames),"-fps_mode","passthrough","-f","framehash",hashes,"-map","[preview]","-an","-c:v","png","-threads","1","-pix_fmt","rgba","-frames:v",String(frames),"-fps_mode","passthrough","-start_number","0",join(scratch,"frame-%02d.png")],scratch,permission,signal);
        const fullHashes=readEditFrameHashes(hashes,frames);for(let offset=0;offset<frames;offset++){const value={sourceSha256:fullHashes[offset]!,data:readFileSync(join(scratch,"frame-"+String(offset).padStart(2,"0")+".png"))};retained.set(parentFrame+offset,value);pictures.push({frame:selected[index+offset]!,...value});}remove(scratch);index+=frames;
      }
      const packet=await encodePreviewPage(identity,pictures,[]);await permission(true);const output=join(target,"page.hvp");writeFileSync(output,packet,{flag:"wx"});await permission(true);return {identity,file:{path:output.slice(this.#root.length+1).split(sep).join("/"),...await soundDigest(output,signal)}};
    }catch(error){if(!target.startsWith(this.#root+sep)||realpathSync(target)!==target)editFail("Assembly picture cleanup escaped its workspace.");rmSync(target,{recursive:true,force:true});throw error;}
  }
}
