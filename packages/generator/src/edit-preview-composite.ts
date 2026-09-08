import {existsSync,mkdirSync,realpathSync,rmSync,writeFileSync} from "node:fs";
import {dirname,join,resolve,sep} from "node:path";
import {contentHash} from "./capabilities";
import {soundRuntimeRevision} from "./sound-audio";
import {soundDigest} from "./sound-media";
import {editWorkspaceGuard} from "./edit-workspace";
import {editOriginalPng} from "./edit-original-png";
import type {EditPreviewSource} from "./edit-preview-media";
import {editFail,validateEditTimeline,type EditTimeline} from "../../planner/src/edit-timeline";
import {editCompositeNeeded} from "../../planner/src/edit-composite";
import {composeEditCompositeFrame,EDIT_COMPOSITE_RECIPE} from "../../planner/src/edit-composite-render";
import {encodePreviewPage,previewDigest,previewDimensions,PREVIEW_PAGE_FRAMES,PREVIEW_COMPOSITE_RECIPE,type PreviewPageIdentity,type PreviewSelection} from "../../planner/src/edit-preview-protocol";

/** Full original masks and mattes are composed before the final picture is resized. */
export class EditPreviewComposite {
  readonly sourceKey:string;readonly dimensions:{width:number;height:number};readonly #timeline:EditTimeline;readonly #sources:Map<string,EditPreviewSource>;readonly #root:string;readonly #engine=soundRuntimeRevision();
  constructor(timeline:EditTimeline,sources:EditPreviewSource[],root:string){
    this.#timeline=validateEditTimeline(structuredClone(timeline));this.#root=realpathSync(root);this.#sources=new Map(sources.map(s=>[s.source.id,s]));this.dimensions=previewDimensions(timeline.width,timeline.height);
    if(!editCompositeNeeded(timeline)||this.#sources.size!==sources.length||sources.some(s=>s.engineVersion!==this.#engine||contentHash(s.source)!==contentHash(timeline.sources.find(t=>t.id===s.source.id))))editFail("Prepare the saved composition's original sources.");
    this.sourceKey=contentHash({schema:"hv-preview-timeline-composite/1",recipe:PREVIEW_COMPOSITE_RECIPE,composite:EDIT_COMPOSITE_RECIPE,timeline:timeline.revision,engineVersion:this.#engine,sources:sources.map(s=>s.sourceKey).sort()});
  }
  identity(from:number,selection?:PreviewSelection):PreviewPageIdentity {
    const frames=Math.min(PREVIEW_PAGE_FRAMES,this.#timeline.frames-from),selected=selection?.pictureFrames;
    if(!Number.isSafeInteger(from)||from<0||from>=this.#timeline.frames||from%PREVIEW_PAGE_FRAMES||!selection?.includePicture||selection.audioLanes.length||!selected||selected.length!==1||!Number.isSafeInteger(selected[0])||selected[0]!<from||selected[0]!>=from+frames)editFail("Choose one exact frame within the prepared composition page.");
    return {sourceKey:this.sourceKey,sourceId:"timeline-picture",sourceRevision:this.#timeline.revision,engineVersion:this.#engine,sourceFrames:this.#timeline.frames,from,frames,...this.dimensions,includePicture:true,audioLanes:[],pictureFrames:[...selected],pictureEncoding:"png-rgba",picturePurpose:"timeline-composite"};
  }
  async page(from:number,path:string,access:()=>Promise<void>,signal?:AbortSignal,selection?:PreviewSelection){
    const identity=this.identity(from,selection),target=resolve(path),parent=dirname(target);await access();signal?.throwIfAborted();
    if(!target.startsWith(this.#root+sep)||existsSync(target)||parent!==this.#root&&!parent.startsWith(this.#root+sep)||realpathSync(parent)!==parent)editFail("Choose an owned composite preview destination.");mkdirSync(target);
    const disk=editWorkspaceGuard(this.#root,()=>[target],{bytes:64*1024**2,files:8});let last=-Infinity;
    const permission=async(force=false)=>{signal?.throwIfAborted();if(Date.now()-last>=1000||force){await access();disk();if(soundRuntimeRevision()!==this.#engine)editFail("The composite preview runtime changed.");last=Date.now();}signal?.throwIfAborted();};
    try{
      const frame=identity.pictureFrames![0]!,data=await composeEditCompositeFrame(this.#timeline,frame,async(id,sourceFrame)=>{const source=this.#sources.get(id);if(!source)editFail("A matte dependency is outside this prepared window.");return source.rawFrame(sourceFrame,join(target,crypto.randomUUID()),permission,signal);},{signal,access:permission,yield:()=>Bun.sleep(0)});
      const sourceSha256=await previewDigest(data),png=await editOriginalPng({width:this.#timeline.width,height:this.#timeline.height,data},this.#root,join(target,crypto.randomUUID()),permission,signal,this.dimensions),packet=await encodePreviewPage(identity,[{frame,sourceSha256,data:png.bytes}],[]);
      await permission(true);const output=join(target,"page.hvp");writeFileSync(output,packet,{flag:"wx"});await permission(true);return {identity,file:{path:output.slice(this.#root.length+1).split(sep).join("/"),...await soundDigest(output,signal)}};
    }catch(error){if(!target.startsWith(this.#root+sep)||realpathSync(target)!==target)editFail("Composite preview cleanup escaped its workspace.");rmSync(target,{recursive:true,force:true});throw error;}
  }
}
