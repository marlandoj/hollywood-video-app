import {EditTime} from './edit-time';
import {editFail,editNumber} from './edit-errors';
import type {EditClip} from './edit-timeline';

export type EditCrossfadeAlignment='center'|'start'|'end';
export interface EditCrossfadeWindow {at:number;frames:number;cut:number;before:number;after:number}
/** The caller supplies validated, adjacent clips. Original clip records remain untouched. */
export function editCrossfadeWindow(left:EditClip,right:EditClip,frames:number,alignment:EditCrossfadeAlignment,totalFrames:number):EditCrossfadeWindow{
  if(left.id===right.id||left.lane!==right.lane||left.layer!==right.layer||left.at+left.frames!==right.at)editFail('Choose adjacent clips on the same track for a crossfade.');
  editNumber(frames,1,totalFrames,'Crossfade duration');if(!['center','start','end'].includes(alignment))editFail('Align the crossfade with the center, start or end of the cut.');
  const before=alignment==='start'?0:alignment==='end'?frames:Math.floor(frames/2),after=frames-before,cut=right.at,at=cut-before;
  if(before>left.frames||after>right.frames||at<0||at+frames>totalFrames)editFail('Shorten the crossfade to fit the adjacent clip ranges.');
  return {at,frames,cut,before,after};
}

/** Borrow handles through the same integrated source clock as picture, sound and captions. */
export function editCrossfadeSourceRange(clip:EditClip,sourceFrames:number,at:number,frames:number):{first:number;end:number;last:number;firstFrame:number;lastFrame:number}{
  editNumber(at,0,108000-1,'Crossfade handle start');editNumber(frames,1,108000-at,'Crossfade handle duration');editNumber(sourceFrames,1,108000,'Retained source frames');
  const time=new EditTime(clip),first=time.source(at*1600),end=time.source((at+frames)*1600),last=time.source((at+frames)*1600-1);
  if(first<0||first>=sourceFrames*1600||end>sourceFrames*1600||last>=sourceFrames*1600)editFail('The crossfade needs more retained source handles. Shorten it or move the source in/out points.');
  return {first,end,last,firstFrame:time.frame(at),lastFrame:time.frame(at+frames-1)};
}

/** Source-over coefficients for a premultiplied dissolve, including partial opacity. */
export function editCrossfadePicture(outgoing:number,incoming:number,progress:number):{outgoing:number;incoming:number}{
  editNumber(outgoing,0,1,'Outgoing opacity',false);editNumber(incoming,0,1,'Incoming opacity',false);editNumber(progress,0,1,'Crossfade progress',false);
  const upper=incoming*progress,remaining=1-upper,lower=remaining?outgoing*(1-progress)/remaining:0;
  return {outgoing:Math.floor(255*Math.min(1,lower)),incoming:Math.floor(255*upper)};
}

/** Complementary linear gains preserve unity for identical, equally leveled soundtracks. */
export function editCrossfadeAudio(sample:number,samples:number):{outgoing:number;incoming:number}{
  editNumber(samples,1,108000*1600,'Crossfade sample count');editNumber(sample,0,samples,'Crossfade sample');const incoming=Math.round(sample/samples*1048576);return {outgoing:1048576-incoming,incoming};
}
