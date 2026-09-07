import type {EditSourceReceipt} from "./edit-sources";
import {editFail,type EditTimeline} from "./edit-timeline";
export const EDIT_STORAGE_LIMITS={outputBytes:48*1024**3,workspaceBytes:128*1024**3,files:80000,freeReserveBytes:512*1024**2} as const;
/** Capacity estimate, not a promise about codec compression or archive size. */
export function editStorageEstimate(t:EditTimeline,bindings:{source:Pick<EditSourceReceipt,"files"|"audio"|"facts">}[]){
  const originalBytes=bindings.reduce((sum,b)=>sum+b.source.files.reduce((n,f)=>n+f.bytes,0),0),canonicalBytes=bindings.reduce((sum,b)=>sum+Object.keys(b.source.audio).length*(44+b.source.facts.frames*1600*6),0),laneBytes=7*(44+t.frames*1600*6);
  const edges=[...new Set([0,t.frames,...t.clips.filter(c=>c.lane==="picture").flatMap(c=>[c.at,c.at+c.frames])])].sort((a,b)=>a-b),parts=edges.slice(1).reduce((n,end,i)=>n+Math.ceil((end-edges[i]!)/60),0);
  const pictureBytes=t.frames*t.width*t.height*3,deliveryBytes=t.frames*t.width*t.height*3,metadataBytes=256*1024**2;
  const outputBytes=originalBytes+canonicalBytes+laneBytes+pictureBytes+deliveryBytes+metadataBytes,workspaceBytes=outputBytes*3;
  const files=bindings.reduce((n,b)=>n+b.source.files.length+Object.keys(b.source.audio).length,0)+parts+Math.ceil(t.frames/30)+t.sources.length*2+32;
  return {originalBytes,canonicalBytes,laneBytes,pictureBytes,deliveryBytes,metadataBytes,outputBytes,workspaceBytes,files,limits:EDIT_STORAGE_LIMITS};
}
export function assertEditStorageEstimate(estimate:ReturnType<typeof editStorageEstimate>):void {
  if(estimate.files>EDIT_STORAGE_LIMITS.files)editFail("This edit retains too many source files. Use fewer source versions before rendering.");
  if(estimate.outputBytes>EDIT_STORAGE_LIMITS.outputBytes||estimate.workspaceBytes>EDIT_STORAGE_LIMITS.workspaceBytes)editFail("This edit exceeds the current retained-media workspace estimate. Use fewer sources, a shorter assembly or smaller export dimensions; the sequence remains saved.");
}
