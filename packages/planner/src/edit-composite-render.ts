import type {EditClip,EditSource,EditTimeline} from "./edit-timeline";
import type {EditTrackMatte} from "./edit-composite-types";
import {editCompositeGraph} from "./edit-composite";
import {EditTime} from "./edit-time";
import {editRenderClips,editRenderOrder,type EditRenderClip} from "./edit-transition-render";
import {editRgbaGroups} from "./edit-rgba";
import {rasterEditMasksAsync,editMatteCoverage,type EditCompositeCheckpoint} from "./edit-composite-sampling";

export const EDIT_COMPOSITE_RECIPE={schema:"hv-edit-composite-render/1",source:"full-original-straight-rgba; masks-follow-decoded-original-frame",coverage:"4x4-center-samples; half-open-even-odd-scanline; nearest-q8; source-geometry-extends-through-feather-padding",feather:"separable-box; q8-fractional-outer-taps; round-after-each-axis; invert-after-feather",stack:"replace,max-union,min-intersection,clamped-subtraction",fit:"mask-alpha-first; crop; centered-fit; timeline-fraction-translation; scale; clockwise-rotation-q30-trig; pixel-centers; premultiplied-bilinear; transparent-footprint-padding-for-all-sources",matte:"isolated-dependent-track; timeline-clock; rec709-display-rgb-q16-13933-46871-4732; round-luma-then-alpha; invert-after-alpha",blend:"mask-times-native-alpha-q8; matte-times-alpha-q8; q8-envelope-complementary-pair-weights; transparent-straight-rgba-track-source-over; nearest-rgb-and-alpha-after-group",output:"visible-tracks-in-layer-order; final-opaque-black; yuv-conversion-once",memory:"at-most-four-isolated-track-frames; two-fitted-clips; output-frame; one-original-frame; bounded-source-coverage-workspace"} as const;
export interface EditCompositePixels {width:number;height:number;data:Uint8Array|Uint8ClampedArray}
export type EditCompositeLookup=(sourceId:string,sourceFrame:number)=>Promise<EditCompositePixels>|EditCompositePixels;
export interface EditCompositeFrameOptions {signal?:AbortSignal;access?:()=>Promise<void>;yield?:()=>Promise<void>}
export function editCompositeCheckpoint(options:EditCompositeFrameOptions={}):EditCompositeCheckpoint{let last=-Infinity;return async()=>{options.signal?.throwIfAborted();if(performance.now()-last>=8){await options.access?.();await(options.yield?.()??new Promise<void>(resolve=>setTimeout(resolve,0)));last=performance.now();}options.signal?.throwIfAborted();};}
/** Visible roots plus independently timed active matte dependencies; gaps intentionally contribute zero. */
export function editCompositeDemand(t:EditTimeline,frame:number):{clip:EditRenderClip;sourceFrame:number}[]{
  const active=editRenderClips(t).filter(c=>c.lane==="picture"&&c.at<=frame&&frame<c.at+c.frames).sort(editRenderOrder),needed=new Set<number>(),visit=(layer:number)=>{if(needed.has(layer))return;needed.add(layer);for(const clip of active.filter(c=>c.layer===layer))if(clip.composite?.matte)visit(clip.composite.matte.layer);};
  for(const clip of active)if(!t.matteOnlyLayers?.includes(clip.layer))visit(clip.layer);
  return active.filter(c=>needed.has(c.layer)).map(clip=>({clip,sourceFrame:new EditTime(clip).frame(frame)}));
}
/** Original source masks precede one deterministic premultiplied affine sampling operation. */
export async function fitEditCompositeFrame(clip:EditClip,source:EditSource,sourceFrame:number,input:EditCompositePixels,width:number,height:number,checkpoint:EditCompositeCheckpoint,target=new Uint8Array(width*height*4)):Promise<Uint8Array>{
  if(input.width!==source.width||input.height!==source.height||input.data.length!==source.width*source.height*4||target.length!==width*height*4)throw new Error("Effect composition requires the exact full-resolution original RGBA frame.");
  const masks=clip.composite?.masks,coverage=masks?.length?await rasterEditMasksAsync(masks,sourceFrame,source.width,source.height,checkpoint):undefined,crop=clip.crop??{x:0,y:0,width:source.width,height:source.height},placement=clip.composite?.placement,scale=Math.min(width/crop.width,height/crop.height)*(placement?.scaleQ16??65536)/65536,angle=(placement?.rotationMilliDegrees??0)*Math.PI/180000,cos=Math.round(Math.cos(angle)*1073741824)/1073741824,sin=Math.round(Math.sin(angle)*1073741824)/1073741824,cx=width/2+(placement?.xQ16??0)*width/65536,cy=height/2+(placement?.yQ16??0)*height/65536;
  target.fill(0);
  for(let y=0;y<height;y++){
    for(let x=0;x<width;x++){
      const dx=x+.5-cx,dy=y+.5-cy,sx=(cos*dx+sin*dy)/scale+crop.x+crop.width/2-.5,sy=(-sin*dx+cos*dy)/scale+crop.y+crop.height/2-.5,ix=Math.floor(sx),iy=Math.floor(sy),fx=sx-ix,fy=sy-iy;let alpha=0,r=0,g=0,b=0;
      for(let yy=0;yy<2;yy++)for(let xx=0;xx<2;xx++){
        const px=ix+xx,py=iy+yy;if(px<crop.x||py<crop.y||px>=crop.x+crop.width||py>=crop.y+crop.height)continue;
        const offset=(py*source.width+px)*4,mask=coverage?.[py*source.width+px]??255,a=Math.floor((input.data[offset+3]!*mask+127)/255),weight=(xx?fx:1-fx)*(yy?fy:1-fy),wa=a*weight;alpha+=wa;r+=input.data[offset]!*wa;g+=input.data[offset+1]!*wa;b+=input.data[offset+2]!*wa;
      }
      const out=(y*width+x)*4;target[out+3]=Math.round(alpha);if(alpha>0){target[out]=Math.round(r/alpha);target[out+1]=Math.round(g/alpha);target[out+2]=Math.round(b/alpha);}
    }
    if(y%16===15)await checkpoint();
  }
  return target;
}
export function applyEditTrackMatte(target:Uint8Array,matte:Uint8Array|undefined,settings:EditTrackMatte):void{for(let p=0;p<target.length;p+=4){const coverage=matte?editMatteCoverage(matte[p]!,matte[p+1]!,matte[p+2]!,matte[p+3]!,settings.channel,settings.invert):settings.invert?255:0;target[p+3]=Math.floor((target[p+3]!*coverage+127)/255);}}
/** One group is either one clip or a complementary dissolve pair. Destination remains isolated RGBA. */
export function blendEditCompositeGroup(target:Uint8Array,left:Uint8Array,leftWeight:number,right?:Uint8Array,rightWeight=0):void{
  for(let p=0;p<target.length;p+=4){const la=left[p+3]!*leftWeight/65025,ra=right?right[p+3]!*rightWeight/65025:0,a=la+ra,background=target[p+3]!/255*(1-a),combined=a+background;if(combined<=0){target[p]=target[p+1]=target[p+2]=target[p+3]=0;continue;}for(let ch=0;ch<3;ch++)target[p+ch]=Math.round((left[p+ch]!*la+(right?right[p+ch]!*ra:0)+target[p+ch]!*background)/combined);target[p+3]=Math.round(combined*255);}
}
export async function composeEditCompositeFrame(t:EditTimeline,frame:number,lookup:EditCompositeLookup,options:EditCompositeFrameOptions={}):Promise<Uint8Array>{
  if(!Number.isSafeInteger(frame)||frame<0||frame>=t.frames)throw new Error("Choose a frame within the saved composition.");
  const graph=editCompositeGraph(t),demand=editCompositeDemand(t,frame),checkpoint=editCompositeCheckpoint(options),tracks=new Map<number,Uint8Array>(),bytes=t.width*t.height*4,left=new Uint8Array(bytes),right=new Uint8Array(bytes);await checkpoint();
  for(const layer of graph.order){const clips=demand.filter(d=>d.clip.layer===layer).map(d=>d.clip);if(!clips.length)continue;const isolated=new Uint8Array(bytes);
    for(const group of editRgbaGroups(clips,frame)){for(const [index,{clip}]of group.entries()){const source=t.sources.find(s=>s.id===clip.sourceId)!;await checkpoint();const original=await lookup(clip.sourceId,new EditTime(clip).frame(frame)),fitted=await fitEditCompositeFrame(clip,source,new EditTime(clip).frame(frame),original,t.width,t.height,checkpoint,index?right:left);if(clip.composite?.matte)applyEditTrackMatte(fitted,tracks.get(clip.composite.matte.layer),clip.composite.matte);}
      blendEditCompositeGroup(isolated,left,group[0]!.alpha,group.length===2?right:undefined,group[1]?.alpha??0);await checkpoint();
    }
    tracks.set(layer,isolated);
  }
  const output=new Uint8Array(bytes);for(let p=3;p<bytes;p+=4)output[p]=255;for(const layer of [...tracks.keys()].sort((a,b)=>a-b))if(!t.matteOnlyLayers?.includes(layer)){blendEditCompositeGroup(output,tracks.get(layer)!,255);await checkpoint();}await options.access?.();options.signal?.throwIfAborted();return output;
}
