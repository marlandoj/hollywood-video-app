import type {EditClip,EditTimeline} from './edit-timeline';
import {EditTime,editPhaseFrame} from './edit-time';
import {editCrossfadeWindow,editCrossfadeAudio,editCrossfadePicture} from './edit-crossfade';
import {editEnvelopeGain,editGainQ20,editPictureAlpha} from './edit-sampling';

export const EDIT_CROSSFADE_RECIPE={schema:'hv-edit-crossfade/1',handles:'integrated-retained-source-clock',picture:'normalized-premultiplied-source-over-q8',audio:'complementary-linear-q20',fades:'replace-covered-adjoining-fades-preserve-outer-phase',captions:'linked-audio-handles-deduplicate-overlapping-source-cues'} as const;
interface RenderFade {at:number;frames:number;side:'outgoing'|'incoming';peerOpacity:number;peerEnvelope:EditClip['envelope'];peerPhase:number}
/** Derived records only. These fields are never accepted as saved owner clip data. */
export interface EditRenderClip extends EditClip {crossfades?:RenderFade[];orderAt?:number}
export function editRenderOrder(a:EditRenderClip,b:EditRenderClip):number{return a.layer-b.layer||(a.orderAt??a.at)-(b.orderAt??b.at)||a.id.localeCompare(b.id);}
function extend(c:EditClip,at:number,end:number):void{
  const clock=new EditTime(c),delta=at-c.at;c.from=clock.frame(at);if(c.timing)c.timing.offset+=delta;c.at=at;c.frames=end-at;
}
export function editRenderClips(t:Pick<EditTimeline,'clips'|'transitions'|'frames'>):EditRenderClip[]{
  if(!t.transitions?.length)return t.clips;
  const clips:EditRenderClip[]=t.clips.map(c=>({...c,orderAt:c.at,envelope:{...c.envelope},...(c.timing?{timing:{...c.timing,points:c.timing.points.map(p=>({...p}))}}:{})})),original=new Map(t.clips.map(c=>[c.id,c])),rendered=new Map(clips.map(c=>[c.id,c]));
  const windows=t.transitions.map(x=>{const left=original.get(x.leftId)!,right=original.get(x.rightId)!;return {...editCrossfadeWindow(left,right,x.frames,x.alignment,t.frames),left,right};});
  for(const w of windows){const left=rendered.get(w.left.id)!,right=rendered.get(w.right.id)!;
    extend(left,left.at,Math.max(left.at+left.frames,w.at+w.frames));extend(right,Math.min(right.at,w.at),right.at+right.frames);
    if(w.left.envelope.from+w.left.envelope.frames===editPhaseFrame(w.left,w.left.at+w.left.frames))left.envelope.fadeOut=0;
    if(w.right.envelope.from===editPhaseFrame(w.right))right.envelope.fadeIn=0;
  }
  for(const w of windows){const left=rendered.get(w.left.id)!,right=rendered.get(w.right.id)!;
    (left.crossfades??=[]).push({at:w.at,frames:w.frames,side:'outgoing',peerOpacity:right.opacity,peerEnvelope:right.envelope,peerPhase:editPhaseFrame(right,w.at)});
    (right.crossfades??=[]).push({at:w.at,frames:w.frames,side:'incoming',peerOpacity:left.opacity,peerEnvelope:left.envelope,peerPhase:editPhaseFrame(left,w.at)});
  }
  for(const c of clips)if(c.lane==='captions'&&c.link){const audio=clips.filter(a=>a.link===c.link&&a.lane!=='picture'&&a.lane!=='captions'&&a.crossfades?.length);if(audio.length)extend(c,Math.min(c.at,...audio.map(a=>a.at)),Math.max(c.at+c.frames,...audio.map(a=>a.at+a.frames)));}
  return clips;
}
function active(c:EditRenderClip,frame:number):RenderFade|undefined{return c.crossfades?.find(x=>frame>=x.at&&frame<x.at+x.frames);}
export function editRenderGainQ20(c:EditRenderClip,phaseSample:number,scale:number,at:number):number{
  const x=active(c,at/1600);if(!x)return editGainQ20(c,phaseSample,scale);
  const weight=editCrossfadeAudio(at-x.at*1600,x.frames*1600)[x.side];return Math.round(scale*editEnvelopeGain(c,phaseSample/1600)*weight/1048576);
}
export function editRenderPictureAlpha(c:EditRenderClip,frame:number):number{
  const phase=editPhaseFrame(c,frame),x=active(c,frame);if(!x)return editPictureAlpha(c,phase);
  const own=c.opacity*editEnvelopeGain(c,phase),peer=x.peerOpacity*editEnvelopeGain({envelope:x.peerEnvelope} as EditClip,x.peerPhase+frame-x.at),u=(frame-x.at)/x.frames;
  return x.side==='outgoing'?editCrossfadePicture(own,peer,u).outgoing:editCrossfadePicture(peer,own,u).incoming;
}
function opacity(c:Pick<EditClip,'opacity'|'envelope'>,phase:number):string{
  const e=c.envelope,p=phase-e.from,terms=['1',...(e.fadeIn?[`(N+${p})/${e.fadeIn}`]:[]),...(e.fadeOut?[`(${e.frames}-N-${p})/${e.fadeOut}`]:[])];let minimum=terms[0]!;for(const term of terms.slice(1))minimum=`min(${minimum},${term})`;return `${c.opacity}*max(0,${minimum})`;
}
/** Spans end at every transition boundary, so each expression has one stable blend role. */
export function editRenderAlphaExpression(c:EditRenderClip,at:number):string{
  const own=opacity(c,editPhaseFrame(c,at)),x=active(c,at);if(!x)return `floor(255*${own})`;
  const u=`((N+${at-x.at})/${x.frames})`;if(x.side==='incoming')return `floor(255*${own}*${u})`;
  const peer=opacity({opacity:x.peerOpacity,envelope:x.peerEnvelope},x.peerPhase+at-x.at),remaining=`(1-(${peer})*${u})`;
  return `if(lte(${remaining},0),0,floor(255*(${own})*(1-${u})/${remaining}))`;
}
