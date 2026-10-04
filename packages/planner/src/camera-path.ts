import {framingSettings,type ShotFraming} from "./framing";

export interface CameraKeyframe extends ShotFraming {at:number;easing:"linear"|"smooth"}
/** Timed digital framing in the uncropped image, not a physical camera trajectory. */
export interface ShotCameraPath {mode:"screen-space";keyframes:CameraKeyframe[]}
export function cameraPathSettings(input:unknown):ShotCameraPath {
  const value=input as ShotCameraPath;
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!=="keyframes,mode"||value.mode!=="screen-space"||!Array.isArray(value.keyframes)||value.keyframes.length<2||value.keyframes.length>8)throw new Error("Use a screen-space camera path with 2–8 keyframes.");
  const keyframes=value.keyframes.map((point,i)=>{
    if(!point||typeof point!=="object"||Array.isArray(point)||Object.keys(point).sort().join(",")!=="at,easing,size,x,y"||!Number.isInteger(point.at)||point.at<0||point.at>10000||(i>0&&point.at<=value.keyframes[i-1]!.at)||!["linear","smooth"].includes(point.easing))throw new Error("Camera keyframes need increasing times from 0 to 10000 and linear or smooth easing.");
    return {at:point.at,...framingSettings({x:point.x,y:point.y,size:point.size}),easing:point.easing};
  });
  if(keyframes[0]!.at!==0||keyframes.at(-1)!.at!==10000)throw new Error("Keep camera keyframes at the first and last frame (0 and 10000).");
  return {mode:"screen-space",keyframes};
}
export function cameraPathFrames(path:ShotCameraPath,frames:number):number[] {
  const value=cameraPathSettings(path);
  if(!Number.isInteger(frames)||frames<2||frames>36000)throw new Error("Camera paths need at least two output frames.");
  const positions=value.keyframes.map(p=>Math.round(p.at*(frames-1)/10000));
  if(positions.some((p,i)=>i>0&&p<=positions[i-1]!))throw new Error("Camera keyframes collide at this duration. Space them farther apart or increase the duration.");
  return positions;
}
export function sampleCameraPath(path:ShotCameraPath,frame:number,frames:number):ShotFraming {
  const points=cameraPathSettings(path).keyframes,positions=cameraPathFrames(path,frames);
  if(!Number.isFinite(frame))throw new Error("Choose a finite camera preview frame.");
  const at=Math.min(frames-1,Math.max(0,frame));let i=0;while(i<points.length-2&&at>positions[i+1]!)i++;
  const a=points[i]!,b=points[i+1]!,t=(at-positions[i]!)/(positions[i+1]!-positions[i]!),u=a.easing==="smooth"?t*t*(3-2*t):t;
  const size=Math.round(a.size+(b.size-a.size)*u);
  return {x:Math.min(10000-size,Math.round(a.x+(b.x-a.x)*u)),y:Math.min(10000-size,Math.round(a.y+(b.y-a.y)*u)),size};
}
export function assertCameraPathContext(params:{cameraPath?:ShotCameraPath;frameAnchors?:unknown;cameraMove?:string|null;routingRequirements?:{nativeResolution?:boolean};fps?:number;durationSec?:number}):void {
  if(params.cameraPath===undefined)return;cameraPathSettings(params.cameraPath);
  if(params.frameAnchors)throw new Error("Camera paths change anchored pixels. Remove the path or frame anchors before rendering.");
  if(params.cameraMove&&params.cameraMove!=="static")throw new Error("Set storyboard motion to Automatic or Static when using a camera path.");
  if(params.routingRequirements?.nativeResolution)throw new Error("A digital camera path is incompatible with a native-resolution requirement.");
  cameraPathFrames(params.cameraPath,Math.round((params.fps??30)*(params.durationSec??1)));
}
/** One still emits all frames; a decoded video emits one output per input frame. */
export function cameraPathFilter(path:ShotCameraPath,width:number,height:number,fps:number,frames:number,still=false):string {
  const points=cameraPathSettings(path).keyframes,positions=cameraPathFrames(path,frames);
  if(![width,height].every(n=>Number.isInteger(n)&&n>=16&&n<=8192&&n%2===0)||!Number.isInteger(fps)||fps<1||fps>120)throw new Error("Choose even camera output dimensions and an integer frame rate.");
  const variable=still?"on":"in";
  const expression=(key:"x"|"y"|"size")=>{
    let result=String(points.at(-1)![key]);
    for(let i=points.length-2;i>=0;i--){const a=points[i]!,b=points[i+1]!,t=`min(1,max(0,(${variable}-${positions[i]})/${positions[i+1]!-positions[i]!}))`,u=a.easing==="smooth"?`(${t})*(${t})*(3-2*(${t}))`:t;
      result=`if(lte(${variable},${positions[i+1]}),${a[key]}+(${b[key]-a[key]})*(${u}),${result})`;}
    return result;
  };
  return `zoompan=z='10000/(${expression("size")})':x='iw*(${expression("x")})/10000':y='ih*(${expression("y")})/10000':d=${still?frames:1}:s=${width}x${height}:fps=${fps},setsar=1`;
}

/**
 * HV-020-01. The moves a provider's own camera control can be asked for, read off a screen-space
 * path: the crop's centre moving right is a pan right, moving down a tilt down, and the crop
 * shrinking a zoom in. A screen-space crop cannot tell a dolly from a zoom, so it is a zoom.
 */
export const NATIVE_CAMERA_MOVES=["pan-left","pan-right","tilt-up","tilt-down","zoom-in","zoom-out"] as const;
export type NativeCameraMove=typeof NATIVE_CAMERA_MOVES[number];
/** A net change smaller than 1% of the frame on an axis is not a move on that axis. */
export const CAMERA_MOVE_MIN_CHANGE=100;
/** Why a path was framed locally rather than sent to the provider as camera control. */
export const CAMERA_CROP_REASONS=["provider-has-no-native-camera","move-not-supported","path-reverses","path-has-no-move"] as const;
export type CameraCropReason=typeof CAMERA_CROP_REASONS[number];
export type CameraPathMoves={moves:NativeCameraMove[]}|{moves:null;reason:"path-reverses"|"path-has-no-move"};
/**
 * A provider's camera control takes a move, not a curve: no keyframe times, no easing, no exact
 * extent. So only a path that goes one way on each axis is a move; one that turns back (pans right
 * then left) is not, and stays a local crop.
 */
export function cameraPathMoves(path:ShotCameraPath):CameraPathMoves {
  const points=cameraPathSettings(path).keyframes,axes=[
    {value:(p:CameraKeyframe)=>p.x+p.size/2,less:"pan-left",more:"pan-right"},
    {value:(p:CameraKeyframe)=>p.y+p.size/2,less:"tilt-up",more:"tilt-down"},
    {value:(p:CameraKeyframe)=>p.size,less:"zoom-in",more:"zoom-out"},
  ] as const,moves:NativeCameraMove[]=[];
  for(const axis of axes){
    const steps=points.slice(1).map((p,i)=>axis.value(p)-axis.value(points[i]!));
    if(steps.some(d=>d>0)&&steps.some(d=>d<0))return {moves:null,reason:"path-reverses"};
    const net=axis.value(points.at(-1)!)-axis.value(points[0]!);
    if(Math.abs(net)>=CAMERA_MOVE_MIN_CHANGE)moves.push(net<0?axis.less:axis.more);
  }
  return moves.length?{moves}:{moves:null,reason:"path-has-no-move"};
}
export type CameraPathApplied={applied:"native";moves:NativeCameraMove[]}|{applied:"local-crop";reason:CameraCropReason};
/**
 * Checks the `applied` half of a completed render's camera report against the path it was
 * admitted with. Reports written before HV-020-01 carry no `applied` and were all local crops.
 */
export function assertCameraPathApplied(report:Partial<Record<"applied"|"moves"|"reason",unknown>>,path:ShotCameraPath):void {
  if(report.applied===undefined){if(report.moves!==undefined||report.reason!==undefined)throw new Error("invalid camera path render provenance");return;}
  if(report.applied==="native"){const expected=cameraPathMoves(path).moves;
    if(report.reason!==undefined||!expected||!Array.isArray(report.moves)||JSON.stringify(report.moves)!==JSON.stringify(expected))throw new Error("invalid camera path render provenance");return;}
  if(report.applied!=="local-crop"||report.moves!==undefined||!(CAMERA_CROP_REASONS as readonly unknown[]).includes(report.reason))throw new Error("invalid camera path render provenance");
}
