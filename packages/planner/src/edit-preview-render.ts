import type {EditClip,EditTimeline} from "./edit-timeline";
import {PREVIEW_AUDIO_LANES,PREVIEW_PAGE_FRAMES,previewPcmSample,type PreviewLane,type PreviewSelection} from "./edit-preview-protocol.js";
import {editGainScale} from "./edit-sampling.js";
import {editRenderClips,editRenderGainQ20,editRenderPictureAlpha,editRenderOrder,type EditRenderClip} from "./edit-transition-render";
import {EditTime} from "./edit-time";
import {addRetimeAudio,editAudioRange} from "./edit-retime-audio";
export interface PreviewRequest extends PreviewSelection {sourceId:string;from:number}
/** Only request picture and sound used by this window; audio-only pages avoid JPEG decoding. */
export function previewRequests(t:EditTimeline,at:number,frames:number):PreviewRequest[]{
  if(!Number.isSafeInteger(at)||at<0||at>=t.frames||!Number.isSafeInteger(frames)||frames<1||frames>300)throw new Error("Choose a preview window of up to ten seconds.");
  const requests=new Map<string,PreviewRequest>(),clips=editRenderClips(t);
  for(const clip of clips){if(clip.lane==="captions"||clip.lane==="picture")continue;const start=Math.max(at,clip.at),end=Math.min(at+frames,clip.at+clip.frames,t.frames);if(start>=end)continue;
    const range=clip.timing?editAudioRange(new EditTime(clip),start*1600,end*1600,t.sources.find(s=>s.id===clip.sourceId)!.frames*1600):null,first=range?range.start/1600:clip.from+start-clip.at,last=range?range.end/1600:clip.from+end-clip.at;for(let from=Math.floor(first/PREVIEW_PAGE_FRAMES)*PREVIEW_PAGE_FRAMES;from<last;from+=PREVIEW_PAGE_FRAMES){const key=clip.sourceId+":"+from,request=requests.get(key)??{sourceId:clip.sourceId,from,includePicture:false,audioLanes:[]};requests.set(key,request);if(!request.audioLanes.includes(clip.lane))request.audioLanes.push(clip.lane);}
  }
  for(let frame=at;frame<Math.min(t.frames,at+frames);frame++)for(const {clip,sourceFrame}of picture(clips,frame)){
    const from=Math.floor(sourceFrame/PREVIEW_PAGE_FRAMES)*PREVIEW_PAGE_FRAMES,key=clip.sourceId+":"+from,request=requests.get(key)??{sourceId:clip.sourceId,from,includePicture:false,audioLanes:[]};requests.set(key,request);request.includePicture=true;request.pictureFrames??=[];if(!request.pictureFrames.includes(sourceFrame))request.pictureFrames.push(sourceFrame);
  }
  for(const request of requests.values()){request.audioLanes.sort((a,b)=>PREVIEW_AUDIO_LANES.indexOf(a)-PREVIEW_AUDIO_LANES.indexOf(b));request.pictureFrames?.sort((a,b)=>a-b);}return [...requests.values()];
}
export function previewPicture(t:EditTimeline,frame:number):{clip:EditClip;sourceFrame:number;alpha:number}[]{
  if(!Number.isSafeInteger(frame)||frame<0||frame>=t.frames)throw new Error("Choose a frame within the saved cut.");
  return picture(editRenderClips(t),frame);
}
function picture(clips:EditRenderClip[],frame:number):ReturnType<typeof previewPicture>{
  const layers=clips.filter(c=>c.lane==="picture"&&c.at<=frame&&frame<c.at+c.frames).sort(editRenderOrder).map(clip=>{const sourceFrame=clip.timing?new EditTime(clip).frame(frame):clip.from+frame-clip.at;return {clip,sourceFrame,alpha:editRenderPictureAlpha(clip,frame)};});
  let first=0;for(let i=0;i<layers.length;i++)if(layers[i]!.alpha===255)first=i;return layers.slice(first).filter(p=>p.alpha>0);
}
export type PreviewAudioPage=(sourceId:string,lane:PreviewLane,from:number)=>Uint8Array|undefined;
/** Reusable worklet scratch. No source advances and no partial audio plays when a page is missing. */
export class PreviewAudioRenderer {
  readonly #clips:{clip:EditRenderClip;scale:number}[];
  readonly #lanes:Float64Array[];
  readonly #maximum:number;
  readonly #sources:Map<string,number>;
  missing:{sourceId:string;lane:PreviewLane;from:number}|null=null;
  constructor(clips:EditClip[],maximum=4096,sources:Pick<EditTimeline["sources"][number],"id"|"frames">[]=[],transitions:EditTimeline['transitions']=undefined){
    clips=editRenderClips({clips,transitions,frames:108000});
    this.#sources=new Map(sources.map(s=>[s.id,s.frames*1600]));if(clips.some(c=>c.timing&&!this.#sources.has(c.sourceId)))throw new Error("Retimed preview requires retained source lengths.");
    if(!Number.isSafeInteger(maximum)||maximum<1||maximum>32768||clips.length>256)throw new Error("Invalid preview audio capacity.");this.#maximum=maximum;
    // AudioWorklet has no structuredClone; these owned clip records contain only scalar fields and two nested records.
    this.#clips=clips.filter(c=>PREVIEW_AUDIO_LANES.includes(c.lane as PreviewLane)).map(c=>({clip:{...c,envelope:{...c.envelope},crop:c.crop?{...c.crop}:null,...(c.timing?{timing:{...c.timing,points:c.timing.points.map(p=>({...p}))}}:{})},scale:editGainScale(c)}));this.#lanes=PREVIEW_AUDIO_LANES.map(()=>new Float64Array(maximum*2));
  }
  render(at:number,left:Float32Array,right:Float32Array,page:PreviewAudioPage):boolean {
    const count=left.length;if(!Number.isSafeInteger(at)||at<0||at+count>108000*1600||count<1||count>this.#maximum||right.length!==count)throw new Error("Invalid preview audio block.");
    this.missing=null;left.fill(0);right.fill(0);for(const samples of this.#lanes)samples.fill(0,0,count*2);
    for(const {clip,scale} of this.#clips){const start=Math.max(at,clip.at*1600),end=Math.min(at+count,(clip.at+clip.frames)*1600);if(start>=end)continue;
      const lane=clip.lane as PreviewLane,target=this.#lanes[PREVIEW_AUDIO_LANES.indexOf(lane)]!;let sourceSample=clip.from*1600+start-clip.at*1600,cursor=start;
      if(clip.timing){const time=new EditTime(clip),sourceSamples=this.#sources.get(clip.sourceId)!,range=editAudioRange(time,start,end,sourceSamples),pages=new Map<number,Uint8Array>();for(let from=Math.floor(range.start/96000)*60;from*1600<range.end;from+=60){const pcm=page(clip.sourceId,lane,from);if(!pcm){this.missing={sourceId:clip.sourceId,lane,from};return false;}if(pcm.length%6||pcm.length/6!==Math.min(96000,sourceSamples-from*1600))throw new Error("Retimed preview source page changed.");pages.set(from,pcm);}addRetimeAudio(clip,time,start,end,target,at,sourceSamples,(sample,ch)=>{const from=Math.floor(sample/96000)*60;return previewPcmSample(pages.get(from)!,sample-from*1600,ch);},scale);continue;}
      while(cursor<end){const from=Math.floor(sourceSample/(PREVIEW_PAGE_FRAMES*1600))*PREVIEW_PAGE_FRAMES,pcm=page(clip.sourceId,lane,from);if(!pcm){this.missing={sourceId:clip.sourceId,lane,from};return false;}
        const first=sourceSample-from*1600,n=Math.min(end-cursor,PREVIEW_PAGE_FRAMES*1600-first);if(pcm.length%6||first+n>pcm.length/6)throw new Error("Preview samples no longer cover the requested source window.");
        for(let i=0;i<n;i++){const gain=editRenderGainQ20(clip,sourceSample+i,scale,cursor+i),offset=(cursor-at+i)*2;target[offset]!+=previewPcmSample(pcm,first+i,0)*gain/1048576;target[offset+1]!+=previewPcmSample(pcm,first+i,1)*gain/1048576;}cursor+=n;sourceSample+=n;
      }
    }
    // Validate every lane and final sample before exposing any part of the block.
    for(let i=0;i<count*2;i++){let mixed=0;for(const lane of this.#lanes){const value=Math.round(lane[i]!);if(!Number.isFinite(value)||value< -8388608||value>8388607)throw new Error("The edited soundtrack would clip. Reduce overlapping clip levels.");mixed+=value;}if(mixed< -8388608||mixed>8388607)throw new Error("The edited soundtrack would clip. Reduce overlapping clip levels.");this.#lanes[0]![i]=mixed;}
    for(let i=0;i<count;i++){left[i]=this.#lanes[0]![i*2]!/8388608;right[i]=this.#lanes[0]![i*2+1]!/8388608;}return true;
  }
}
