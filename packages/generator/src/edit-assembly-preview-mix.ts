import {existsSync,lstatSync,mkdirSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {dirname,join,resolve,sep} from "node:path";
import {contentHash} from "./capabilities";
import {soundRuntimeRevision} from "./sound-audio";
import {soundDigest} from "./sound-media";
import {editWorkspaceGuard} from "./edit-workspace";
import type {EditPreviewSource} from "./edit-preview-media";
import {editConformRecipe} from "./edit-conform";
import {EditAssemblyClock,validateEditAssemblyPlan} from "../../planner/src/edit-assembly-clock";
import type {EditAssemblyPlan} from "../../planner/src/edit-assembly-types";
import {EDIT_AUDIO_LANES,editFail} from "../../planner/src/edit-timeline";
import {editGainScale} from "../../planner/src/edit-sampling";
import {editRenderClips,editRenderGainQ20} from "../../planner/src/edit-transition-render";
import {EditTime} from "../../planner/src/edit-time";
import {addRetimeAudio,editAudioRange,EDIT_AUDIO_BLOCK} from "../../planner/src/edit-retime-audio";
import {encodePreviewPage,PREVIEW_PAGE_FRAMES,PREVIEW_RECIPE,type PreviewLane,type PreviewPageIdentity,type PreviewSelection} from "../../planner/src/edit-preview-protocol";
type Access=()=>Promise<void>;
function sample(value:number):number {const result=Math.round(value);if(!Number.isFinite(value)||result< -8388608||result>8388607)editFail("The assembly soundtrack would clip. Reduce overlapping parent clip levels before previewing.");return result;}
function pcmSample(bytes:Uint8Array,offset:number):number {const value=bytes[offset]!+bytes[offset+1]!*256+bytes[offset+2]!*65536;return value>=8388608?value-16777216:value;}

/** A child page evaluates only its selected parent windows, with the parent's exact lane rounding and source clocks. */
export class EditAssemblyPreviewMix {
  readonly sourceKey:string;readonly #plan:EditAssemblyPlan;readonly #clock:EditAssemblyClock;readonly #sources:Map<string,EditPreviewSource>;readonly #root:string;readonly #engine=soundRuntimeRevision();
  constructor(plan:EditAssemblyPlan,sources:EditPreviewSource[],root:string){
    this.#plan=validateEditAssemblyPlan(plan);this.#clock=new EditAssemblyClock(this.#plan);this.#root=realpathSync(root);this.#sources=new Map(sources.map(source=>[source.source.id,source]));
    if(this.#sources.size!==sources.length||sources.some(source=>source.engineVersion!==this.#engine||contentHash(source.source)!==contentHash(this.#plan.parent.timeline.sources.find(original=>original.id===source.source.id))))editFail("Prepare the assembly parent's unchanged original sources.");
    this.sourceKey=contentHash({schema:"hv-preview-assembly-mix/1",recipe:PREVIEW_RECIPE,plan:this.#plan.revision,parentRecipe:editConformRecipe(this.#plan.parent.timeline),engineVersion:this.#engine,sources:sources.map(source=>source.sourceKey).sort()});
  }
  identity(from:number,selection:PreviewSelection={includePicture:false,audioLanes:["mix"]}):PreviewPageIdentity {
    if(!Number.isSafeInteger(from)||from<0||from>=this.#plan.frames||from%PREVIEW_PAGE_FRAMES||selection.includePicture!==false||!Array.isArray(selection.audioLanes)||selection.audioLanes.length!==1||selection.audioLanes[0]!=="mix"||selection.pictureFrames!==undefined)editFail("Choose a complete assembly soundtrack page boundary.");
    return {sourceKey:this.sourceKey,sourceId:"timeline-audio",sourceRevision:this.#plan.revision,engineVersion:this.#engine,sourceFrames:this.#plan.frames,from,frames:Math.min(PREVIEW_PAGE_FRAMES,this.#plan.frames-from),width:2,height:2,includePicture:false,audioLanes:["mix"]};
  }
  async page(from:number,path:string,access:Access,signal?:AbortSignal,selection?:PreviewSelection){
    const identity=this.identity(from,selection),start=from*1600,count=identity.frames*1600,lanes=EDIT_AUDIO_LANES.map(()=>new Float64Array(count*2)),target=resolve(path);
    await access();signal?.throwIfAborted();if(soundRuntimeRevision()!==this.#engine)editFail("Prepare assembly audio with the current media runtime.");
    if(!target.startsWith(this.#root+sep)||existsSync(target))editFail("Choose a new owned assembly mix destination.");let parent=dirname(target);while(!existsSync(parent))parent=dirname(parent);
    if(parent!==this.#root&&!parent.startsWith(this.#root+sep)||realpathSync(parent)!==parent||!lstatSync(parent).isDirectory())editFail("Assembly preview mixing escaped its workspace.");mkdirSync(target,{recursive:true});
    if(realpathSync(target)!==target)editFail("Assembly preview mixing escaped its workspace.");
    const disk=editWorkspaceGuard(this.#root,()=>[target],{bytes:2*1024**2,files:1});let last=-Infinity;
    const permission=async(force=false)=>{signal?.throwIfAborted();disk();if(force||Date.now()-last>=1000){await access();if(soundRuntimeRevision()!==this.#engine)editFail("The assembly preview runtime changed.");last=Date.now();}signal?.throwIfAborted();};
    try{
      const clips=editRenderClips(this.#plan.parent.timeline);
      for(const window of this.#clock.spans(start,start+count)){
        const offset=window.parentStartSample-(window.outputStartSample-start),stop=window.parentStartSample+window.samples;
        for(const clip of clips){
          const lane=EDIT_AUDIO_LANES.indexOf(clip.lane as PreviewLane),begin=Math.max(window.parentStartSample,clip.at*1600),end=Math.min(stop,(clip.at+clip.frames)*1600);if(lane<0||begin>=end)continue;
          const source=this.#sources.get(clip.sourceId);if(!source)editFail("An original for this assembly soundtrack window is not prepared.");const scale=editGainScale(clip),output=lanes[lane]!;
          if(clip.timing){const time=new EditTime(clip),sourceSamples=source.source.frames*1600,pages=new Map<number,Uint8Array>();
            for(let cursor=begin;cursor<end;cursor+=EDIT_AUDIO_BLOCK){const endBlock=Math.min(end,cursor+EDIT_AUDIO_BLOCK),range=editAudioRange(time,cursor,endBlock,sourceSamples),needed=new Set<number>();
              for(let page=Math.floor(range.start/96000)*60;page*1600<range.end;page+=60)needed.add(page);for(const page of pages.keys())if(!needed.has(page))pages.delete(page);
              for(const page of needed)if(!pages.has(page))pages.set(page,await source.audioPage(page,clip.lane as PreviewLane,permission,signal));
              addRetimeAudio(clip,time,cursor,endBlock,output,offset,sourceSamples,(sample,channel)=>{const page=Math.floor(sample/96000)*60;return pcmSample(pages.get(page)!,(sample-page*1600)*6+channel*3);},scale);await Bun.sleep(0);await permission();
            }continue;
          }
          let at=begin,original=clip.from*1600+begin-clip.at*1600;
          while(at<end){const pageFrom=Math.floor(original/(PREVIEW_PAGE_FRAMES*1600))*PREVIEW_PAGE_FRAMES,pcm=await source.audioPage(pageFrom,clip.lane as PreviewLane,permission,signal),sourceOffset=original-pageFrom*1600,length=Math.min(end-at,pcm.length/6-sourceOffset);if(length<1)editFail("Original samples no longer cover this assembly range.");
            for(let i=0;i<length;i++){const gain=editRenderGainQ20(clip,original+i,scale,at+i),index=(at-offset+i)*2;output[index]!+=pcmSample(pcm,(sourceOffset+i)*6)*gain/1048576;output[index+1]!+=pcmSample(pcm,(sourceOffset+i)*6+3)*gain/1048576;}at+=length;original+=length;
          }
        }
        await permission();
      }
      const pcm=Buffer.alloc(count*6);for(let index=0;index<count*2;index++){let value=0;for(const lane of lanes)value+=sample(lane[index]!);pcm.writeIntLE(sample(value),index*3,3);}
      const packet=await encodePreviewPage(identity,[],[{lane:"mix",data:pcm}]);await permission(true);const output=join(target,"page.hvp");writeFileSync(output,packet,{flag:"wx"});await permission(true);
      return {identity,file:{path:output.slice(this.#root.length+1).split(sep).join("/"),...await soundDigest(output,signal)}};
    }catch(error){if(!target.startsWith(this.#root+sep)||realpathSync(target)!==target)editFail("Assembly mix cleanup escaped its workspace.");rmSync(target,{recursive:true,force:true});throw error;}
  }
}
