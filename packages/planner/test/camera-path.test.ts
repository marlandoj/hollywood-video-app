import {expect,test} from "bun:test";
import {cameraPathSettings,cameraPathFrames,sampleCameraPath,type ShotCameraPath} from "../src/camera-path";
import {directionSettings} from "../src/direction";
import {videoRequirements,matchCapability,baseCapability,capability} from "../../generator/src/capabilities";
const path:ShotCameraPath={mode:"screen-space",keyframes:[{at:0,x:0,y:2500,size:5000,easing:"smooth"},{at:10000,x:5000,y:0,size:5000,easing:"linear"}]};
test("camera keyframes interpolate bounded crops at exact output frames without changing old direction defaults",()=>{
  expect(directionSettings({})).not.toHaveProperty("cameraPath");expect(directionSettings({cameraPath:null})).not.toHaveProperty("cameraPath");
  expect(cameraPathFrames(path,121)).toEqual([0,120]);expect(sampleCameraPath(path,0,121)).toEqual({x:0,y:2500,size:5000});expect(sampleCameraPath(path,120,121)).toEqual({x:5000,y:0,size:5000});
  expect(sampleCameraPath(path,30,121).x).toBe(781);expect(sampleCameraPath(path,60,121)).toEqual({x:2500,y:1250,size:5000});
  for(let frame=0;frame<121;frame++){const crop=sampleCameraPath(path,frame,121);expect(crop.x+crop.size).toBeLessThanOrEqual(10000);expect(crop.y+crop.size).toBeLessThanOrEqual(10000);}
  for(const mutate of [(p:ShotCameraPath)=>p.keyframes[0]!.at=1,(p:ShotCameraPath)=>p.keyframes[1]!.at=0,(p:ShotCameraPath)=>p.keyframes[1]!.x=5001,(p:ShotCameraPath)=>p.keyframes[1]!.y=NaN,(p:ShotCameraPath)=>p.keyframes[0]!.size=Infinity]){const value=structuredClone(path);mutate(value);expect(()=>cameraPathSettings(value)).toThrow();}
  expect(()=>cameraPathSettings({...path,subject:"SPUD"})).toThrow();
  expect(sampleCameraPath({mode:"screen-space",keyframes:[{at:0,x:0,y:0,size:10000,easing:"linear"},{at:10000,x:1,y:1,size:9999,easing:"linear"}]},1,3)).toEqual({x:0,y:0,size:10000});
  const collision={...path,keyframes:[path.keyframes[0]!,{...path.keyframes[0]!,at:1},path.keyframes[1]!]};expect(()=>cameraPathFrames(collision,30)).toThrow("collide");
});
test("quote requirements disclose local camera framing and refuse incompatible constraints before dispatch",()=>{
  const input={cameraPath:path,widthxheight:"640x360",fps:30,durationSec:4};const requirements=videoRequirements(input),match=matchCapability(capability(baseCapability("fixture","fixture","video")),requirements,0);
  expect(requirements.cameraPath).toEqual(path);expect(match.eligible).toBe(true);expect(match.adaptations).toContain("screen-space camera path; digital framing applied locally");
  expect(()=>videoRequirements({...input,routingRequirements:{nativeResolution:true}})).toThrow("native-resolution");
  expect(()=>videoRequirements({...input,frameAnchors:{mode:"native",frames:[{at:0}]}})).toThrow("anchored pixels");
  expect(()=>directionSettings({cameraPath:path,previewMove:"push-in"})).toThrow("Automatic or Static");
  expect(directionSettings({cameraPath:path,framing:{x:2000,y:2000,size:5000}}).framing).toEqual({x:2000,y:2000,size:5000});
});
