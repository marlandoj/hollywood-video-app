import type {EditClip} from "./edit-timeline";
/** Shared by full conform and preview. Splits retain source-relative fades; trim/settings edits reanchor them. */
export function editEnvelopeGain(c:EditClip,sourceFrame:number):number{const e=c.envelope,p=sourceFrame-e.from;return Math.max(0,Math.min(1,e.fadeIn?p/e.fadeIn:1,e.fadeOut?(e.frames-p)/e.fadeOut:1));}
export function editGainScale(c:EditClip):number{return Math.round(10**(c.gainDb/20)*1048576);}
export function editGainQ20(c:EditClip,sourceSample:number,scale:number):number{return Math.round(scale*editEnvelopeGain(c,sourceSample/1600));}
export function editPictureAlpha(c:EditClip,sourceFrame:number):number{return Math.floor(255*c.opacity*editEnvelopeGain(c,sourceFrame));}
