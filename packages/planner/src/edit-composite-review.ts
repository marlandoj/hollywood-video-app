import type {EditTimeline} from "./edit-timeline";
import {editCompositeNeeded} from "./edit-composite";
import {editRenderClips} from "./edit-transition-render";
/** Saved, source-addressed settings and track gaps requiring visual review. */
export function editCompositeReview(t:EditTimeline){
  if(!editCompositeNeeded(t))return null;
  const clips=t.clips.filter(c=>c.composite).map(c=>({clipId:c.id,maskCount:c.composite!.masks?.length??0,keyframeCount:(c.composite!.masks??[]).reduce((n,m)=>n+m.keyframes.length,0),...(c.composite!.matte?{matte:c.composite!.matte}:{}),...(c.composite!.placement?{placement:c.composite!.placement}:{})})),warnings:string[]=[],rendered=editRenderClips(t);
  if(clips.some(c=>c.maskCount))warnings.push("Masks follow original source-frame keys. Review interpolation, feathered edges and borrowed dissolve handles in the saved preview.");
  for(const clip of rendered.filter(c=>c.lane==="picture"&&c.composite?.matte)){
    const matte=clip.composite!.matte!,ranges=rendered.filter(c=>c.lane==="picture"&&c.layer===matte.layer).map(c=>({from:Math.max(clip.at,c.at),end:Math.min(clip.at+clip.frames,c.at+c.frames)})).filter(r=>r.end>r.from).sort((a,b)=>a.from-b.from);let covered=clip.at,gap=false;
    for(const range of ranges){if(range.from>covered)gap=true;covered=Math.max(covered,range.end);}if(covered<clip.at+clip.frames)gap=true;
    if(gap)warnings.push("Clip "+clip.id+" uses picture "+matte.layer+" through a track gap. The "+(matte.invert?"inverted matte reveals":"matte hides")+" the clip during that gap.");
  }
  for(const layer of t.matteOnlyLayers??[])if(!t.clips.some(c=>c.composite?.matte?.layer===layer))warnings.push("Picture "+layer+" is matte-only and has no saved consumers; it is hidden from the exported picture.");
  return {timelineRevision:t.revision,matteOnlyLayers:t.matteOnlyLayers??[],clips,warnings};
}
