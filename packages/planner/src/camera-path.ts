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
