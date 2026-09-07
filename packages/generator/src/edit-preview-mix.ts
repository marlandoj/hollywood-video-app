import {existsSync,lstatSync,mkdirSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {dirname,join,resolve,sep} from "node:path";
import {contentHash} from "./capabilities";
import {soundRuntimeRevision} from "./sound-audio";
import {soundDigest} from "./sound-media";
import {editWorkspaceGuard} from "./edit-workspace";
import {EditPreviewSource} from "./edit-preview-media";
import {EDIT_AUDIO_LANES,editFail,validateEditTimeline,type EditTimeline} from "../../planner/src/edit-timeline";
import {editGainQ20,editGainScale} from "../../planner/src/edit-sampling";
import {encodePreviewPage,PREVIEW_PAGE_FRAMES,PREVIEW_RECIPE,type PreviewLane,type PreviewPageIdentity,type PreviewSelection} from "../../planner/src/edit-preview-protocol";
type Access=()=>Promise<void>;
function pcmSample(bytes:Uint8Array,offset:number):number{const n=bytes[offset]!+bytes[offset+1]!*256+bytes[offset+2]!*65536;return n>=8388608?n-16777216:n;}
function sample(value:number):number{const n=Math.round(value);if(!Number.isFinite(value)||n< -8388608||n>8388607)editFail("The edited soundtrack would clip. Reduce overlapping clip levels before previewing.");return n;}
/** Mix only a requested two-second timeline window. Scratch is six lanes plus one source page. */
export class EditPreviewMix {
  readonly sourceKey:string;readonly #timeline:EditTimeline;readonly #sources:Map<string,EditPreviewSource>;readonly #root:string;readonly #engine=soundRuntimeRevision();
  constructor(timeline:EditTimeline,sources:EditPreviewSource[],artifactRoot:string){
    this.#timeline=validateEditTimeline(timeline);this.#root=realpathSync(artifactRoot);this.#sources=new Map(sources.map(s=>[s.source.id,s]));
    if(this.#sources.size!==sources.length||sources.some(s=>s.engineVersion!==this.#engine||contentHash(s.source)!==contentHash(this.#timeline.sources.find(t=>t.id===s.source.id))))editFail("Prepared preview originals no longer match the saved timeline.");
    this.sourceKey=contentHash({schema:"hv-preview-timeline-mix/1",recipe:PREVIEW_RECIPE,timeline:this.#timeline.revision,engineVersion:this.#engine,sources:sources.map(s=>s.sourceKey).sort()});
  }
  identity(from:number,selection:PreviewSelection={includePicture:false,audioLanes:["mix"]}):PreviewPageIdentity {
    if(!Number.isSafeInteger(from)||from<0||from>=this.#timeline.frames||from%PREVIEW_PAGE_FRAMES||selection.includePicture!==false||selection.audioLanes.length!==1||selection.audioLanes[0]!=="mix")editFail("Choose a complete preview soundtrack page boundary.");
    return {sourceKey:this.sourceKey,sourceId:"timeline-audio",sourceRevision:this.#timeline.revision,engineVersion:this.#engine,sourceFrames:this.#timeline.frames,from,frames:Math.min(PREVIEW_PAGE_FRAMES,this.#timeline.frames-from),width:2,height:2,includePicture:false,audioLanes:["mix"]};
  }
  async page(from:number,path:string,access:Access,signal?:AbortSignal,selection?:PreviewSelection){
    const identity=this.identity(from,selection),start=from*1600,count=identity.frames*1600,lanes=EDIT_AUDIO_LANES.map(()=>new Float64Array(count*2)),target=resolve(path);
    await access();signal?.throwIfAborted();if(soundRuntimeRevision()!==this.#engine)editFail("Prepare the soundtrack with the current media runtime.");
    if(!target.startsWith(this.#root+sep)||existsSync(target))editFail("Choose a new owned preview mix destination.");let parent=dirname(target);while(!existsSync(parent))parent=dirname(parent);if(parent!==this.#root&&!parent.startsWith(this.#root+sep)||realpathSync(parent)!==parent||!lstatSync(parent).isDirectory())editFail("Preview mixing escaped its workspace.");mkdirSync(target,{recursive:true});
    const disk=editWorkspaceGuard(this.#root,()=>[target],{bytes:2*1024**2,files:1});let last=-Infinity;const permission=async(force=false)=>{signal?.throwIfAborted();disk();if(force||Date.now()-last>=1000){await access();last=Date.now();}signal?.throwIfAborted();};
    try{
      for(const clip of this.#timeline.clips){const lane=EDIT_AUDIO_LANES.indexOf(clip.lane as PreviewLane),begin=Math.max(start,clip.at*1600),end=Math.min(start+count,(clip.at+clip.frames)*1600);if(lane<0||begin>=end)continue;
        const source=this.#sources.get(clip.sourceId);if(!source)editFail("An original for this soundtrack window is not prepared yet. Prepare the current playhead window.");const scale=editGainScale(clip),output=lanes[lane]!;let at=begin,original=clip.from*1600+begin-clip.at*1600;
        while(at<end){const pageFrom=Math.floor(original/(PREVIEW_PAGE_FRAMES*1600))*PREVIEW_PAGE_FRAMES,pcm=await source.audioPage(pageFrom,clip.lane as PreviewLane,permission,signal),offset=original-pageFrom*1600,length=Math.min(end-at,pcm.length/6-offset);if(length<1)editFail("Preview source samples no longer cover this edit.");
          for(let i=0;i<length;i++){const gain=editGainQ20(clip,original+i,scale),index=(at-start+i)*2;output[index]!+=pcmSample(pcm,(offset+i)*6)*gain/1048576;output[index+1]!+=pcmSample(pcm,(offset+i)*6+3)*gain/1048576;}at+=length;original+=length;
        }
      }
      const pcm=Buffer.alloc(count*6);for(let i=0;i<count*2;i++){let value=0;for(const lane of lanes)value+=sample(lane[i]!);pcm.writeIntLE(sample(value),i*3,3);}
      const packet=await encodePreviewPage(identity,[],[{lane:"mix",data:pcm}]);await permission(true);writeFileSync(join(target,"page.hvp"),packet,{flag:"wx"});if(soundRuntimeRevision()!==this.#engine)editFail("Preview mixing runtime changed.");await permission(true);
      return {identity,file:{path:join(target,"page.hvp").slice(this.#root.length+1).split(sep).join("/"),...await soundDigest(join(target,"page.hvp"),signal)}};
    }catch(error){if(!target.startsWith(this.#root+sep)||realpathSync(target)!==target)editFail("Preview mix cleanup escaped its workspace.");rmSync(target,{recursive:true,force:true});throw error;}
  }
}
