import {expect,test} from "bun:test";
import {blendEditCompositeGroup,editCompositeFitIsIdentity,fitEditCompositeFrame,sampleEditCompositeFrame} from "../src/edit-composite-render";
import type {EditClip,EditSource} from "../src/edit-timeline";

/**
 * HV-025-14: two shortcuts on the compositor's hottest loops, each held to the arithmetic it skips.
 * The G24 cut put a 126-second film through the compositor for a 30-frame overlay; nearly every frame
 * was an unmoved, unmasked, opaque film frame, where the fit is a copy and the blend is the left pixel.
 */
const checkpoint=async()=>{};
function source(width:number,height:number):EditSource{return {id:"film",revision:"r",label:"film",frames:1,width,height,audio:[],captions:[],voices:[],unmeasuredAudio:false};}
function clip(extra:Partial<EditClip>={}):EditClip{return {id:"c",sourceId:"film",lane:"picture",layer:0,at:0,from:0,frames:1,link:null,gainDb:0,opacity:1,crop:null,envelope:{from:0,frames:1,fadeIn:0,fadeOut:0},...extra};}
function noise(bytes:number,seed:number,alphas?:number[]):Uint8Array<ArrayBuffer>{const data=new Uint8Array(bytes);let x=seed>>>0||1;for(let p=0;p<bytes;p++){x^=x<<13;x^=x>>>17;x^=x<<5;x>>>=0;data[p]=x&255;if(alphas&&p%4===3)data[p]=alphas[x%alphas.length]!;}return data;}
/** main's blend loop at 05984fb, copied, as the reference the shortcut must equal. */
function referenceBlend(target:Uint8Array,left:Uint8Array,leftWeight:number,right?:Uint8Array,rightWeight=0){for(let p=0;p<target.length;p+=4){const la=left[p+3]!*leftWeight/65025,ra=right?right[p+3]!*rightWeight/65025:0,a=la+ra,background=target[p+3]!/255*(1-a),combined=a+background;if(combined<=0){target[p]=target[p+1]=target[p+2]=target[p+3]=0;continue;}for(let ch=0;ch<3;ch++)target[p+ch]=Math.round((left[p+ch]!*la+(right?right[p+ch]!*ra:0)+target[p+ch]!*background)/combined);target[p+3]=Math.round(combined*255);}}

test("only an unmoved, unmasked, full-frame clip the timeline's size counts as an identity fit",()=>{
  const s=source(64,36);
  expect(editCompositeFitIsIdentity(clip(),s,64,36)).toBe(true);
  expect(editCompositeFitIsIdentity(clip({crop:{x:0,y:0,width:64,height:36}}),s,64,36)).toBe(true);
  expect(editCompositeFitIsIdentity(clip({composite:{schema:"hv-edit-composite/1",placement:{xQ16:0,yQ16:0,scaleQ16:65536,rotationMilliDegrees:0}}}),s,64,36)).toBe(true);
  expect(editCompositeFitIsIdentity(clip(),s,128,72)).toBe(false);
  expect(editCompositeFitIsIdentity(clip({crop:{x:2,y:0,width:62,height:36}}),s,64,36)).toBe(false);
  for(const placement of [{xQ16:1,yQ16:0,scaleQ16:65536,rotationMilliDegrees:0},{xQ16:0,yQ16:0,scaleQ16:65535,rotationMilliDegrees:0},{xQ16:0,yQ16:0,scaleQ16:65536,rotationMilliDegrees:1}])
    expect(editCompositeFitIsIdentity(clip({composite:{schema:"hv-edit-composite/1",placement}}),s,64,36)).toBe(false);
  expect(editCompositeFitIsIdentity(clip({composite:{schema:"hv-edit-composite/1",masks:[{id:"m",label:"m",sourceRevision:"r",kind:"rectangle",combine:"replace",invert:false,featherQ8:0,keyframes:[{sourceFrame:0,interpolation:"hold",geometry:{xQ16:0,yQ16:0,widthQ16:65536,heightQ16:65536}}]}]}}),s,64,36)).toBe(false);
});

test("the identity fit is the full sampler's bytes, alpha-0 pixels cleared, at odd and production sizes",async()=>{
  for(const [width,height,seed] of [[64,36,7],[33,17,11],[1280,720,13]] as const){
    const s=source(width,height),input={width,height,data:noise(width*height*4,seed,[0,0,1,128,254,255,255,255])};
    for(const c of [clip(),clip({crop:{x:0,y:0,width,height}})]){
      const fast=await fitEditCompositeFrame(c,s,0,input,width,height,checkpoint),full=await sampleEditCompositeFrame(c,s,0,input,width,height,checkpoint);
      expect(Buffer.from(fast).equals(Buffer.from(full))).toBe(true);
    }
    // A reused target is overwritten whole, as a fresh one is.
    const stale=noise(width*height*4,seed+1);await fitEditCompositeFrame(clip(),s,0,input,width,height,checkpoint,stale);
    expect(Buffer.from(stale).equals(Buffer.from(await sampleEditCompositeFrame(clip(),s,0,input,width,height,checkpoint)))).toBe(true);
  }
});

test("the opaque full-weight blend is the reference loop's bytes over every background",()=>{
  const bytes=96*54*4,left=noise(bytes,3,[0,1,77,128,254,255,255,255]),right=noise(bytes,5,[0,64,255]);
  for(const backgroundAlphas of [[255],[0],[0,1,128,255]]){
    const background=noise(bytes,9,backgroundAlphas);
    for(const [leftWeight,withRight,rightWeight] of [[255,false,0],[128,false,0],[0,false,0],[200,true,55],[255,true,0]] as const){
      const fast=background.slice(),reference=background.slice();
      blendEditCompositeGroup(fast,left,leftWeight,withRight?right:undefined,rightWeight);referenceBlend(reference,left,leftWeight,withRight?right:undefined,rightWeight);
      expect(Buffer.from(fast).equals(Buffer.from(reference))).toBe(true);
    }
  }
});
