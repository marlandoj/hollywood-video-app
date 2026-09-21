import type {EditSourceReceipt} from "./edit-sources";
import {editFail,type EditTimeline} from "./edit-timeline";
import {editRenderClips} from "./edit-transition-render";
import {editCompositeNeeded} from "./edit-composite";
export const EDIT_STORAGE_LIMITS={outputBytes:48*1024**3,workspaceBytes:128*1024**3,files:80000,freeReserveBytes:512*1024**2} as const;
/** Capacity estimate, not a promise about codec compression or archive size. */
export function editStorageEstimate(t:EditTimeline,bindings:{source:Pick<EditSourceReceipt,"files"|"audio"|"facts">}[]){
  const originalBytes=bindings.reduce((sum,b)=>sum+b.source.files.reduce((n,f)=>n+f.bytes,0),0),canonicalBytes=bindings.reduce((sum,b)=>sum+Object.keys(b.source.audio).length*(44+b.source.facts.frames*1600*6),0),laneBytes=7*(44+t.frames*1600*6);
  const edges=[...new Set([0,t.frames,...editRenderClips(t).filter(c=>c.lane==="picture").flatMap(c=>[c.at,c.at+c.frames,...(c.crossfades??[]).flatMap(x=>[x.at,x.at+x.frames])])])].sort((a,b)=>a-b),parts=edges.slice(1).reduce((n,end,i)=>n+Math.ceil((end-edges[i]!)/60),0);
  const pictureBytes=t.frames*t.width*t.height*3,deliveryBytes=t.frames*t.width*t.height*3,metadataBytes=256*1024**2;
  const effects=editCompositeNeeded(t),outputBytes=originalBytes+canonicalBytes+laneBytes+pictureBytes+deliveryBytes+metadataBytes,retimingScratchBytes=t.clips.some(c=>c.lane==="picture"&&c.timing)?Math.max(...t.clips.filter(c=>c.lane==="picture"&&c.timing).map(c=>{const s=t.sources.find(s=>s.id===c.sourceId)!;return (effects||s.media==="graphic-rgba"?s.width*s.height*4:s.width*s.height+2*Math.ceil(s.width/2)*Math.ceil(s.height/2))*60*3;}))+t.width*t.height*3*60*2:0;
  const native=t.sources.filter(s=>s.media==="graphic-rgba"&&t.clips.some(c=>c.lane==="picture"&&c.sourceId===s.id)),rgbaScratchBytes=!effects&&native.length?t.width*t.height*4*60*4+Math.max(...native.map(s=>s.width*s.height*4*60*2)):0,maxSourcePixels=Math.max(...t.sources.map(s=>s.width*s.height)),compositeScratchBytes=effects?t.width*t.height*4*60*6+maxSourcePixels*4*60*3:0,compositeWorkingFrameBytes=effects?t.width*t.height*4*7+maxSourcePixels*4+Math.max(...t.sources.map(s=>(s.width+258)*(s.height+258)))*4:0,workspaceBytes=outputBytes*3+retimingScratchBytes+rgbaScratchBytes+compositeScratchBytes;
  const files=bindings.reduce((n,b)=>n+b.source.files.length+Object.keys(b.source.audio).length,0)+parts+Math.ceil(t.frames/30)+Math.max(t.sources.length,bindings.length)*2+32;
  return {...(retimingScratchBytes?{retimingScratchBytes}:{}),...(rgbaScratchBytes?{rgbaScratchBytes}:{}),...(effects?{compositeScratchBytes,compositeWorkingFrameBytes}:{}),originalBytes,canonicalBytes,laneBytes,pictureBytes,deliveryBytes,metadataBytes,outputBytes,workspaceBytes,files,limits:EDIT_STORAGE_LIMITS};
}
/**
 * HV-025-09: how long an editorial render may take, from the cut it is rendering.
 *
 * Every editorial job carried a flat 30 minutes. That was ample for the fifteen-second reel and far
 * too little for the fifty-second short: its titled picture edit reached the deadline twice and
 * re-queued itself, so the film could not be titled at all. The render is the whole conform, and
 * verification reproduces it, so the time an edit needs grows with its frames. Measured on the
 * staging host, a titled cut costs on the order of a second per frame end to end; this allows two,
 * plus a fixed start-up, and never less than the old half hour or more than four hours.
 */
export const EDIT_RENDER_TIMEOUT={baseMs:120_000,perFrameMs:2_000,minimumMs:30*60_000,maximumMs:4*60*60_000} as const;
export function editRenderTimeoutMs(frames:number):number{
  if(!Number.isInteger(frames)||frames<0)editFail("Count this cut's frames before giving it a deadline.");
  const {baseMs,perFrameMs,minimumMs,maximumMs}=EDIT_RENDER_TIMEOUT;
  return Math.min(maximumMs,Math.max(minimumMs,baseMs+frames*perFrameMs));
}
/**
 * HV-025-10: how long checking an original may take, from the film it is checking.
 *
 * The check does not just hash files: `inspectEditSource` reproduces the source's own conversions,
 * and for a sound mix that means re-deriving the whole mix, its loudness and its delivery master.
 * On the staging host the Release 1 short (fifty seconds, 1,500 frames, 247 MB across 48 files)
 * took 5.7 minutes when the host was quiet and more than fifteen when it was not, so a fixed
 * fifteen-minute allowance abandoned the check and the film could not be titled. The allowance now
 * grows with the film, on the same shape as the render's deadline.
 */
export const EDIT_INSPECTION_TIMEOUT={baseMs:60_000,perFrameMs:1_000,minimumMs:15*60_000,maximumMs:60*60_000} as const;
export function editInspectionTimeoutMs(frames:number):number{
  if(!Number.isInteger(frames)||frames<0)editFail("Count this film's frames before giving its check a deadline.");
  const {baseMs,perFrameMs,minimumMs,maximumMs}=EDIT_INSPECTION_TIMEOUT;
  return Math.min(maximumMs,Math.max(minimumMs,baseMs+frames*perFrameMs));
}
export function assertEditStorageEstimate(estimate:ReturnType<typeof editStorageEstimate>):void {
  if(estimate.files>EDIT_STORAGE_LIMITS.files)editFail("This edit retains too many source files. Use fewer source versions before rendering.");
  if(estimate.outputBytes>EDIT_STORAGE_LIMITS.outputBytes||estimate.workspaceBytes>EDIT_STORAGE_LIMITS.workspaceBytes)editFail("This edit exceeds the current retained-media workspace estimate. Use fewer sources, a shorter assembly or smaller export dimensions; the sequence remains saved.");
}
