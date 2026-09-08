import type {EditTimeline} from "./edit-timeline";
import {editEnvelopeGain} from "./edit-sampling";
import {editPhaseFrame} from "./edit-time";
import {editRenderPictureAlpha,type EditRenderClip} from "./edit-transition-render";

export const EDIT_RGBA_RECIPE={schema:"hv-edit-rgba/1",source:"straight-rgba-decoded-frame-hashes",fit:"identity-when-unscaled; premultiply-float-rgb-before-bicubic-scale-unpremultiply-after; scale-native-8-bit-alpha-separately; accurate_rnd-and-bitexact; transparent-graphic-padding; opaque-film-padding",opacity:"native-alpha/255-times-floor-255-envelope/255",dissolve:"q8-envelope-then-complementary-linear-weights-add-premultiplied-colors-and-alpha-before-source-over",composition:"sequential-groups-round-rgb-over-opaque-background",memory:"compositor-three-rgba-frames-at-most",master:"convert-final-span-once-to-ffv1-yuv420p"} as const;
export function editRgbaNeeded(t:Pick<EditTimeline,"sources">,clips:EditRenderClip[]):boolean{return clips.some(c=>c.lane==="picture"&&t.sources.some(s=>s.id===c.sourceId&&s.media==="graphic-rgba"));}
export interface EditRgbaLayer {clip:EditRenderClip;alpha:number}
/** Transition validation guarantees adjacent pair members with no third picture on their layer. */
export function editRgbaGroups(clips:EditRenderClip[],frame:number):EditRgbaLayer[][]{
  const groups:EditRgbaLayer[][]=[];
  for(let i=0;i<clips.length;i++){
    const clip=clips[i]!,fade=clip.crossfades?.find(x=>frame>=x.at&&frame<x.at+x.frames);
    if(!fade){groups.push([{clip,alpha:editRenderPictureAlpha(clip,frame)}]);continue;}
    const next=clips[++i],peer=next?.crossfades?.find(x=>frame>=x.at&&frame<x.at+x.frames);
    if(fade.side!=="outgoing"||!next||next.layer!==clip.layer||peer?.side!=="incoming"||peer.at!==fade.at||peer.frames!==fade.frames)throw new Error("A native-alpha dissolve lost its ordered picture pair.");
    const u=(frame-fade.at)/fade.frames,weight=(c:EditRenderClip,w:number)=>Math.floor(255*c.opacity*editEnvelopeGain(c,editPhaseFrame(c,frame)))*w;
    groups.push([{clip,alpha:weight(clip,1-u)},{clip:next,alpha:weight(next,u)}]);
  }
  return groups;
}
