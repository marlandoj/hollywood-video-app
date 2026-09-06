import {validateReference,type ReferenceAsset} from "./references";
import {contentHash} from "../../generator/src/capabilities";
export interface ShotFrameAnchors {
  frames:{at:number;asset:ReferenceAsset}[];
  fallback:"stop"|"storyboard";
}
/** Anchors use normalized shot time. Source bytes remain in the private reference catalog. */
export function frameAnchorSettings(input:unknown):ShotFrameAnchors {
  if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("Use a frame anchor record.");
  const value={fallback:"stop",...input} as ShotFrameAnchors;
  if(Object.keys(value).sort().join(",")!=="fallback,frames"||!["stop","storyboard"].includes(value.fallback)||!Array.isArray(value.frames)||value.frames.length<1||value.frames.length>5)
    throw new Error("Choose one to five frame anchors and a supported fallback.");
  let previous=-1;
  const frames=value.frames.map(frame=>{
    if(!frame||Object.keys(frame).sort().join(",")!=="asset,at"||!Number.isInteger(frame.at)||frame.at<0||frame.at>10000||frame.at<=previous)
      throw new Error("Frame anchors must have unique increasing times from 0 to 10000.");
    previous=frame.at;return {at:frame.at,asset:validateReference(frame.asset,frame.asset?.projectId)};
  });
  if(frames[0]!.at!==0)throw new Error("Choose a first frame before adding other anchors.");
  return {frames,fallback:value.fallback};
}
export function assertFrameAnchorCatalog(anchors:ShotFrameAnchors|undefined,projectId:string,catalog:ReferenceAsset[]):void {
  if(!anchors)return;
  for(const frame of frameAnchorSettings(anchors).frames){
    validateReference(frame.asset,projectId);
    if(!catalog.some(asset=>contentHash(asset)===contentHash(frame.asset)))throw new Error("A frame anchor is missing from this project's private image catalog.");
  }
}

export function frameAnchorRequest(anchors:ShotFrameAnchors|undefined,stage:string) {
  if(!anchors)return undefined;
  return {frames:anchors.frames.map(f=>({at:f.at})),mode:(stage==="animatic"?"storyboard":anchors.fallback==="storyboard"?"prefer-native":"native") as "storyboard"|"prefer-native"|"native"};
}
