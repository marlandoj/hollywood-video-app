import {createHash} from "node:crypto";
import {closeSync,existsSync,lstatSync,mkdirSync,openSync,readFileSync,readSync,realpathSync,rmSync,statSync,writeFileSync,writeSync} from "node:fs";
import {dirname,join,resolve,sep} from "node:path";
import type {RenderFile} from "../../planner/src/shot-reuse";
import {initialEditTimeline,editFail,type EditSource} from "../../planner/src/edit-timeline";
import {PREVIEW_AUDIO_LANES,PREVIEW_PAGE_FRAMES,PREVIEW_RECIPE,PREVIEW_RGBA_RECIPE,encodePreviewPage,previewDimensions,previewPictureFrames,type PreviewLane,type PreviewPageIdentity,type PreviewSelection} from "../../planner/src/edit-preview-protocol";
import type {EditConformSource} from "./edit-conform";
import {editFrameHashes,readEditFrameHashes} from "./edit-picture";
import {soundDigest} from "./sound-media";
import {soundWavHeader,soundRuntimeRevision} from "./sound-audio";
import {soundProcessingCommand} from "./sound-finishing";
import {contentHash} from "./capabilities";
import {editRgbaResize} from "./edit-rgba-picture";
import {assertEditFreeSpace,editWorkspaceGuard} from "./edit-workspace";
type Access=()=>Promise<void>;
const digest=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function local(root:string,file:RenderFile):string {
  if(!/^[A-Za-z0-9._/-]+$/.test(file.path)||file.path.split("/").some(p=>!p||p==="."||p===".."))editFail("Invalid preview source path.");
  const path=resolve(root,file.path);if(!path.startsWith(root+sep)||!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink()||!realpathSync(path).startsWith(root+sep))editFail("A preview source escaped its workspace.");return path;
}
function destination(root:string,path:string):string {const target=resolve(path);if(!target.startsWith(root+sep)||existsSync(target))editFail("Choose a new owned preview destination.");let parent=dirname(target);while(!existsSync(parent))parent=dirname(parent);if(parent!==root&&!parent.startsWith(root+sep)||realpathSync(parent)!==parent||!lstatSync(parent).isDirectory())editFail("Preview destination escaped its workspace.");mkdirSync(target,{recursive:true});if(realpathSync(target)!==target)editFail("Preview destination escaped its workspace.");return target;}
function remove(root:string,path:string):void{if(!path.startsWith(root+sep)||realpathSync(path)!==path)editFail("Preview cleanup escaped its workspace.");rmSync(path,{recursive:true,force:true});}
function read(fd:number,at:number,size:number):Buffer{const bytes=Buffer.alloc(size);if(readSync(fd,bytes,0,size,at)!==size)editFail("A preview waveform was truncated.");return bytes;}
function freeze<T>(value:T):T{if(value&&typeof value==="object"){Object.values(value).forEach(freeze);Object.freeze(value);}return value;}
function checkedAccess(access:Access,disk:()=>void,signal?:AbortSignal){let last=-Infinity;return async(force=false)=>{signal?.throwIfAborted();disk();if(force||Date.now()-last>=1000){await access();last=Date.now();}signal?.throwIfAborted();};}

/** Ephemeral, process-owned index. Original frames and PCM pages are authenticated once. */
export class EditPreviewSource {
  readonly sourceKey:string;
  readonly source:EditSource;
  readonly engineVersion:string;
  readonly dimensions:{width:number;height:number};
  #root:string;
  #media:EditConformSource;
  #frames:Buffer;
  #audio:Partial<Record<PreviewLane,string[]>>;
  private constructor(source:EditSource,media:EditConformSource,root:string,frames:string[],audio:Partial<Record<PreviewLane,string[]>>,engineVersion:string){
    this.source=freeze(structuredClone(source));this.#media=structuredClone(media);this.#root=root;this.#frames=Buffer.from(frames.join(""),"hex");this.#audio=audio;this.engineVersion=engineVersion;this.dimensions=Object.freeze(previewDimensions(source.width,source.height));
    this.sourceKey=contentHash({recipe:source.media==="graphic-rgba"?PREVIEW_RGBA_RECIPE:PREVIEW_RECIPE,engineVersion,source,media:{picture:media.picture,...Object.fromEntries(PREVIEW_AUDIO_LANES.filter(l=>media.audio[l]).map(l=>[l,media.audio[l]]))}});
    Object.freeze(this);
  }
  static async prepare(source:EditSource,media:EditConformSource,artifactRoot:string,path:string,access:Access,signal?:AbortSignal):Promise<EditPreviewSource>{
    source=structuredClone(source);media=structuredClone(media);
    initialEditTimeline([source],source.id,16,16);if(media.id!==source.id||contentHash(Object.keys(media.audio).sort())!==contentHash(source.audio.slice().sort()))editFail("Preview media lost its source or sound lanes.");
    const root=realpathSync(artifactRoot),engineVersion=soundRuntimeRevision();await access();signal?.throwIfAborted();assertEditFreeSpace(root,128*1024**2);const target=destination(root,path),disk=editWorkspaceGuard(root,()=>[target],{bytes:32*1024**2,files:4}),permission=checkedAccess(access,disk,signal);
    try{
      const picture=local(root,media.picture),actual=await soundDigest(picture,signal);if(actual.sha256!==media.picture.sha256||actual.bytes!==media.picture.bytes)editFail("Preview picture checksum changed.");
      const probe=join(target,"source-probe.json");await soundProcessingCommand(["ffprobe","-v","error","-protocol_whitelist","file,pipe","-show_entries",source.media==="graphic-rgba"?"stream=codec_type,codec_name,pix_fmt,width,height,r_frame_rate":"stream=codec_type,width,height,r_frame_rate","-of","json","-o",probe,picture],target,permission,signal);
      if(statSync(probe).size>64*1024)editFail("Preview source metadata exceeded its limit.");const video=JSON.parse(readFileSync(probe,"utf8")).streams.filter((s:any)=>s.codec_type==="video");if(video.length!==1||video[0].width!==source.width||video[0].height!==source.height||video[0].r_frame_rate!=="30/1")editFail("Preview source dimensions or rate changed.");
      if(source.media==="graphic-rgba"&&(video[0].codec_name!=="ffv1"||video[0].pix_fmt!=="bgra"))editFail("Preview native alpha requires its retained graphic format.");
      const frames=await editFrameHashes(picture,source.frames,join(target,"source-frames.txt"),target,permission,signal,source.media==="graphic-rgba"?"rgba":"yuv420p"),audio:Partial<Record<PreviewLane,string[]>>={};
      for(const lane of source.audio){
        const file=media.audio[lane]!,sourcePath=local(root,file),samples=source.frames*1600,fd=openSync(sourcePath,"r");try{
          const header=read(fd,0,44),hash=createHash("sha256").update(header),pages:string[]=[];
          if(statSync(sourcePath).size!==file.bytes||file.bytes!==44+samples*6||!header.equals(soundWavHeader(samples)))editFail("Preview sound must retain canonical 48 kHz stereo 24-bit samples.");
          for(let at=0;at<samples;at+=PREVIEW_PAGE_FRAMES*1600){if(at%(32*PREVIEW_PAGE_FRAMES*1600)===0)await new Promise<void>(resolve=>setImmediate(resolve));await permission();const pcm=read(fd,44+at*6,Math.min(PREVIEW_PAGE_FRAMES*1600,samples-at)*6);hash.update(pcm);pages.push(digest(pcm));}
          if(hash.digest("hex")!==file.sha256)editFail("Preview sound checksum changed.");audio[lane]=pages;
        }finally{closeSync(fd);}
      }
      if(soundRuntimeRevision()!==engineVersion)editFail("Preview runtime changed while indexing.");await permission(true);return new EditPreviewSource(source,media,root,frames,audio,engineVersion);
    }catch(error){remove(root,target);throw error;}
  }
  async rawFrame(frame:number,path:string,access:Access,signal?:AbortSignal):Promise<{width:number;height:number;data:Uint8Array;sourceSha256:string}>{
    if(!Number.isSafeInteger(frame)||frame<0||frame>=this.source.frames)editFail("Choose a retained original frame.");
    await access();signal?.throwIfAborted();if(soundRuntimeRevision()!==this.engineVersion)editFail("Prepare original frames with the current runtime.");
    const target=destination(this.#root,path),bytes=this.source.width*this.source.height*4,disk=editWorkspaceGuard(this.#root,()=>[target],{bytes:bytes+1024**2,files:3}),permission=checkedAccess(access,disk,signal);
    try{
      const native=this.source.media==="graphic-rgba",format=native?"rgba":"yuv420p",seek=Math.floor(frame/30),offset=frame-seek*30,hashes=join(target,"original.txt"),decoded=join(target,"original.rgba"),graph=`[0:v:0]trim=start_frame=${offset}:end_frame=${offset+1},setpts=PTS-STARTPTS,format=${format},split=2[original][color];[color]format=rgba[decoded]`;
      await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-filter_complex_threads","1","-threads","1","-ss",String(seek),"-accurate_seek","-i",local(this.#root,this.#media.picture),"-filter_complex",graph,"-map","[original]","-an","-c:v","rawvideo","-threads","1","-pix_fmt",format,"-frames:v","1","-f","framehash",hashes,"-map","[decoded]","-an","-c:v","rawvideo","-threads","1","-pix_fmt","rgba","-frames:v","1","-f","rawvideo",decoded],target,permission,signal);
      const original=readEditFrameHashes(hashes,1)[0];if(original!==this.#frames.subarray(frame*32,(frame+1)*32).toString("hex")||statSync(decoded).size!==bytes)editFail("The requested original frame changed.");
      await permission(true);const data=readFileSync(decoded);signal?.throwIfAborted();return {width:this.source.width,height:this.source.height,data,sourceSha256:digest(data)};
    }finally{remove(this.#root,target);}
  }
  /** Internal picture input: retain film YUV or native alpha without a lossy RGBA round trip. Caller owns the returned directory. */
  async losslessFrame(frame:number,path:string,access:Access,signal?:AbortSignal):Promise<string>{
    if(!Number.isSafeInteger(frame)||frame<0||frame>=this.source.frames)editFail("Choose a retained original frame.");
    await access();signal?.throwIfAborted();if(soundRuntimeRevision()!==this.engineVersion)editFail("Prepare original frames with the current runtime.");
    const target=destination(this.#root,path),disk=editWorkspaceGuard(this.#root,()=>[target],{bytes:64*1024**2,files:2}),permission=checkedAccess(access,disk,signal);
    try{
      const native=this.source.media==="graphic-rgba",format=native?"rgba":"yuv420p",seek=Math.floor(frame/30),offset=frame-seek*30,hashes=join(target,"original.txt"),output=join(target,"frame.mkv"),graph=`[0:v:0]trim=start_frame=${offset}:end_frame=${offset+1},settb=1/30,setpts=N,format=${format},split=2[original][retained]`;
      await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-filter_complex_threads","1","-threads","1","-ss",String(seek),"-accurate_seek","-i",local(this.#root,this.#media.picture),"-filter_complex",graph,"-map","[original]","-an","-c:v","rawvideo","-threads","1","-pix_fmt",format,"-frames:v","1","-f","framehash",hashes,"-map","[retained]","-an","-r","30","-c:v","ffv1","-level","3","-threads","1","-pix_fmt",native?"bgra":"yuv420p","-frames:v","1","-map_metadata","-1",output],target,permission,signal);
      if(readEditFrameHashes(hashes,1)[0]!==this.#frames.subarray(frame*32,(frame+1)*32).toString("hex"))editFail("The requested original frame changed.");
      rmSync(hashes);if(soundRuntimeRevision()!==this.engineVersion)editFail("The original frame runtime changed.");await permission(true);return output;
    }catch(error){remove(this.#root,target);throw error;}
  }
  /** Batch only requested original addresses; authenticate distinct frames before reconstructing held frames. */
  async losslessFrames(frames:number[],path:string,access:Access,signal?:AbortSignal,rgba=false):Promise<string>{
    if(Array.isArray(frames))frames=[...frames];
    if(!Array.isArray(frames)||!frames.length||frames.length>16||frames.some((frame,index)=>!Number.isSafeInteger(frame)||frame<0||frame>=this.source.frames||index>0&&frame<frames[index-1]!))editFail("Choose at most sixteen ordered retained original frames.");
    const native=this.source.media==="graphic-rgba",originalFormat=native?"rgba":"yuv420p",format=native||rgba?"rgba":"yuv420p",bytes=format==="rgba"?this.source.width*this.source.height*4:this.source.width*this.source.height+2*Math.ceil(this.source.width/2)*Math.ceil(this.source.height/2),unique=[...new Set(frames)],held=unique.length!==frames.length;
    if(bytes*frames.length*(held?3:1)>48*1024**2)editFail("The retained original batch exceeds its bounded picture workspace.");
    await access();signal?.throwIfAborted();if(soundRuntimeRevision()!==this.engineVersion)editFail("Prepare original frames with the current runtime.");
    const target=destination(this.#root,path),disk=editWorkspaceGuard(this.#root,()=>[target],{bytes:64*1024**2,files:4}),permission=checkedAccess(access,disk,signal),output=join(target,"frame.mkv"),hashes=join(target,"original.txt"),selected=join(target,"selected.raw"),ordered=join(target,"ordered.raw"),seek=Math.floor(unique[0]!/30),select=unique.map(frame=>`eq(n,${frame-seek*30})`).join("+"),graph=`[0:v:0]select='${select}',settb=1/30,setpts=N,format=${originalFormat},split=2[original][color];[color]format=${format}[retained]`,encode=["-an","-r","30","-c:v","ffv1","-level","3","-threads","1","-pix_fmt",format==="rgba"?"bgra":"yuv420p","-map_metadata","-1"];
    try{
      await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-filter_complex_threads","1","-threads","1","-ss",String(seek),"-accurate_seek","-i",local(this.#root,this.#media.picture),"-filter_complex",graph,"-map","[original]","-an","-c:v","rawvideo","-threads","1","-pix_fmt",originalFormat,"-frames:v",String(unique.length),"-fps_mode","passthrough","-f","framehash",hashes,"-map","[retained]",...(held?["-an","-c:v","rawvideo","-threads","1","-pix_fmt",format]:encode),"-frames:v",String(unique.length),...(held?["-fps_mode","passthrough","-f","rawvideo",selected]:[output])],target,permission,signal);
      const actual=readEditFrameHashes(hashes,unique.length);if(actual.some((hash,index)=>hash!==this.#frames.subarray(unique[index]!*32,(unique[index]!+1)*32).toString("hex")))editFail("The requested original frames changed.");rmSync(hashes);
      if(held){
        if(statSync(selected).size!==unique.length*bytes)editFail("The retained original batch lost a frame.");const input=openSync(selected,"r");let destination:number|undefined;
        try{destination=openSync(ordered,"wx");const buffer=Buffer.alloc(bytes);let previous=-1;for(const frame of frames){await permission();if(frame!==previous){if(readSync(input,buffer,0,bytes,unique.indexOf(frame)*bytes)!==bytes)editFail("A retained original frame was truncated.");previous=frame;}let offset=0;while(offset<bytes){const written=writeSync(destination,buffer,offset,bytes-offset);if(!written)editFail("A retained original hold was truncated.");offset+=written;}}}
        finally{closeSync(input);if(destination!==undefined)closeSync(destination);}rmSync(selected);
        await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-f","rawvideo","-pixel_format",format,"-video_size",`${this.source.width}x${this.source.height}`,"-framerate","30","-threads","1","-i",ordered,"-frames:v",String(frames.length),...encode,output],target,permission,signal);rmSync(ordered);
      }
      if(soundRuntimeRevision()!==this.engineVersion)editFail("The original frame runtime changed.");await permission(true);return output;
    }catch(error){remove(this.#root,target);throw error;}
  }
  identity(from:number,selection:PreviewSelection={includePicture:true,audioLanes:PREVIEW_AUDIO_LANES.filter(l=>this.source.audio.includes(l))}):PreviewPageIdentity {
    if(!Number.isSafeInteger(from)||from<0||from>=this.source.frames||from%PREVIEW_PAGE_FRAMES)editFail("Choose a retained preview page boundary.");
    if(typeof selection.includePicture!=="boolean"||!Array.isArray(selection.audioLanes)||selection.audioLanes.some(l=>!this.source.audio.includes(l))||new Set(selection.audioLanes).size!==selection.audioLanes.length||!selection.includePicture&&!selection.audioLanes.length)editFail("Choose available preview picture or sound lanes.");
    const frames=Math.min(PREVIEW_PAGE_FRAMES,this.source.frames-from),selected=selection.pictureFrames;
    if(selected!==undefined&&(!selection.includePicture||!Array.isArray(selected)||!selected.length||selected.length>frames||selected.some((n,i)=>!Number.isSafeInteger(n)||n<from||n>=from+frames||i>0&&n<=selected[i-1]!)))editFail("Choose distinct ordered picture frames within this preview page.");
    return {sourceKey:this.sourceKey,sourceId:this.source.id,sourceRevision:this.source.revision,engineVersion:this.engineVersion,sourceFrames:this.source.frames,from,frames,...this.dimensions,includePicture:selection.includePicture,audioLanes:PREVIEW_AUDIO_LANES.filter(l=>selection.audioLanes.includes(l)),...(selected?{pictureFrames:[...selected]}:{}),...(this.source.media==="graphic-rgba"?{pictureEncoding:"png-rgba" as const}:{})};
  }
  /** Read already-canonical PCM. Mix/session boundaries check runtime; each page checks access and its indexed hash. */
  async audioPage(from:number,lane:PreviewLane,access:Access,signal?:AbortSignal):Promise<Uint8Array>{
    const identity=this.identity(from,{includePicture:false,audioLanes:[lane]});await new Promise<void>(resolve=>setImmediate(resolve));await access();signal?.throwIfAborted();
    const fd=openSync(local(this.#root,this.#media.audio[lane]!),"r");try{const pcm=read(fd,44+from*1600*6,identity.frames*1600*6);if(digest(pcm)!==this.#audio[lane]![from/PREVIEW_PAGE_FRAMES])editFail("Preview source samples changed.");signal?.throwIfAborted();return pcm;}finally{closeSync(fd);}
  }
  /** One decode feeds original frame hashes and resized JPEGs; hashes must match the full source index. */
  async page(from:number,path:string,access:Access,signal?:AbortSignal,selection?:PreviewSelection):Promise<{identity:PreviewPageIdentity;file:RenderFile}>{
    const identity=this.identity(from,selection),root=this.#root,native=identity.pictureEncoding==="png-rgba",extension=native?"png":"jpg";await access();signal?.throwIfAborted();if(soundRuntimeRevision()!==this.engineVersion)editFail("Prepare preview media with the current runtime.");assertEditFreeSpace(root,128*1024**2);
    const target=destination(root,path),disk=editWorkspaceGuard(root,()=>[target],{bytes:64*1024**2,files:70}),permission=checkedAccess(access,disk,signal),seek=Math.floor(from/30),offset=from-seek*30;
    try{
      const pictures=[],selected=previewPictureFrames(identity);
      if(identity.includePicture){
      const select=identity.pictureFrames?`select='${selected.map(n=>`eq(n,${n-from})`).join("+")}',`:"",resize=`scale=${identity.width}:${identity.height}:flags=lanczos`,image=native?(identity.width===this.source.width&&identity.height===this.source.height?"format=rgba,setsar=1":editRgbaResize(resize)+",setsar=1"):`${resize},setsar=1,format=yuvj420p`,graph=`[0:v:0]trim=start_frame=${offset}:end_frame=${offset+identity.frames},${select}settb=1/30,setpts=N,${native?"format=rgba,":""}split=2[original][image];[image]${image}[preview]`;
      const hashes=join(target,"selected-frames.txt");await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-protocol_whitelist","file,pipe","-filter_complex_threads","1","-threads","1","-ss",String(seek),"-accurate_seek","-i",local(root,this.#media.picture),"-filter_complex",graph,"-map","[original]","-an","-c:v","rawvideo","-threads","1","-pix_fmt",native?"rgba":"yuv420p","-frames:v",String(selected.length),"-fps_mode","passthrough","-f","framehash",hashes,"-map","[preview]","-an","-c:v",native?"png":"mjpeg",...(native?[]:["-q:v","5"]),"-threads","1","-frames:v",String(selected.length),"-fps_mode","passthrough",join(target,"frame-%03d."+extension)],target,permission,signal);
      const original=readEditFrameHashes(hashes,selected.length),expected=selected.map(n=>this.#frames.subarray(n*32,(n+1)*32).toString("hex"));if(original.some((h,i)=>h!==expected[i]))editFail("Preview seek returned different original frames.");
      for(let i=0;i<selected.length;i++){await permission();signal?.throwIfAborted();const path=join(target,"frame-"+String(i+1).padStart(3,"0")+"."+extension);if(statSync(path).size>512*1024)editFail("A preview frame exceeded its size limit.");pictures.push({frame:selected[i]!,sourceSha256:expected[i]!,data:readFileSync(path)});}rmSync(hashes);
      }
      const audio:{lane:PreviewLane;data:Uint8Array}[]=[];for(const lane of identity.audioLanes){await permission();signal?.throwIfAborted();const fd=openSync(local(root,this.#media.audio[lane]!),"r");try{const pcm=read(fd,44+from*1600*6,identity.frames*1600*6);if(digest(pcm)!==this.#audio[lane]![from/PREVIEW_PAGE_FRAMES])editFail("Preview source samples changed.");audio.push({lane,data:pcm});}finally{closeSync(fd);}}
      const packet=await encodePreviewPage(identity,pictures,audio),output=join(target,"page.hvp");await permission(true);writeFileSync(output,packet,{flag:"wx"});
      if(identity.includePicture)for(let i=0;i<selected.length;i++)rmSync(join(target,"frame-"+String(i+1).padStart(3,"0")+"."+extension));await permission(true);if(soundRuntimeRevision()!==this.engineVersion)editFail("Preview runtime changed while building a page.");
      return {identity,file:{path:output.slice(root.length+1).split(sep).join("/"),...await soundDigest(output,signal)}};
    }catch(error){remove(root,target);throw error;}
  }
}
