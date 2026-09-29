import {expect,test} from "bun:test";
import {assertCurrentFilmMixedControls} from "../src/current-film-mixed-controls";
import {directionSettings} from "../src/direction";
import {renderRecord,validateRenderRecord,type RenderClip} from "../src/shot-reuse";
import type {Shot} from "../src/index";
import type {ReferenceAsset} from "../src/references";

const clip:RenderClip={provider:"mock",model:"mock-v1",seed:1,durationSec:2,fingerprint:"a".repeat(64)},base:Shot={id:"shot-1",sceneIndex:0,prompt:"An empty room",dialogue:[],durationSec:2,seed:1};
const camera=directionSettings({durationFrames:60,cameraPath:{mode:"screen-space",keyframes:[{at:0,x:0,y:0,size:10000,easing:"linear"},{at:10000,x:500,y:500,size:9000,easing:"smooth"}]}});
const asset:ReferenceAsset={schema:"hv-reference/1",id:"00000000-0000-4000-8000-000000000001",projectId:"project",sha256:"b".repeat(64),originalSha256:"c".repeat(64),bytes:100,width:32,height:32,contentType:"image/png",createdAt:"2026-09-08T00:00:00.000Z",attestedAt:"2026-09-08T00:00:00.000Z"};
const anchored=(fallback:"stop"|"storyboard"="stop",middle=false):Shot=>({...base,direction:directionSettings({frameAnchors:{fallback,frames:(middle?[0,5000,10000]:[0,10000]).map(at=>({at,asset}))}})});

test("mixed camera evidence requires exact keyframes, actual row frames and an admitted control",()=>{
  const shot={...base,direction:camera},good={...clip,cameraPathControl:{mode:"screen-space" as const,keyframes:camera.cameraPath!.keyframes,outputFrames:60}};
  expect(()=>assertCurrentFilmMixedControls(good,shot,"animatic")).not.toThrow();
  expect(()=>assertCurrentFilmMixedControls(clip,shot,"animatic")).toThrow("camera path report");
  expect(()=>assertCurrentFilmMixedControls(good,base,"animatic")).toThrow("camera path report");
  for(const changed of [{...good,cameraPathControl:{...good.cameraPathControl,outputFrames:59}},
    {...good,cameraPathControl:{...good.cameraPathControl,keyframes:good.cameraPathControl.keyframes.map((key,index)=>index?{...key,x:600}:key)}},
    {...good,durationSec:3}])expect(()=>assertCurrentFilmMixedControls(changed,shot,"animatic")).toThrow("camera report");
  // A recomputed generic record seal alone did not prove its admitted camera report.
  const record=renderRecord({projectId:"project",jobId:"job",shotId:base.id,inputHash:"d".repeat(64),clip:{...good,cameraPathControl:{...good.cameraPathControl,outputFrames:59}},files:{video:{path:"project/job/clips/shot.mp4",bytes:100,sha256:"e".repeat(64)}},origin:{jobId:"job",shotId:base.id}});
  expect(()=>validateRenderRecord(record,{projectId:"project",id:"job"})).not.toThrow();
  expect(()=>assertCurrentFilmMixedControls(record.clip,shot,"animatic")).toThrow("camera report");
});

test("mixed frame-anchor evidence binds preview/final fallback modes and exact positions",()=>{
  const preview={...clip,frameAnchorControl:{mode:"storyboard" as const,positions:[0,10000]}},native={...clip,frameAnchorControl:{mode:"native" as const,positions:[0,10000]}};
  expect(()=>assertCurrentFilmMixedControls(preview,anchored(),"animatic")).not.toThrow();
  expect(()=>assertCurrentFilmMixedControls(native,anchored(),"final")).not.toThrow();
  expect(()=>assertCurrentFilmMixedControls(preview,anchored("storyboard"),"final")).not.toThrow();
  expect(()=>assertCurrentFilmMixedControls(native,anchored(),"animatic")).toThrow("anchor report");
  expect(()=>assertCurrentFilmMixedControls(preview,anchored(),"final")).toThrow("anchor report");
  expect(()=>assertCurrentFilmMixedControls({...native,frameAnchorControl:{...native.frameAnchorControl,positions:[0,5000,10000]}},anchored("storyboard",true),"final")).toThrow("anchor report");
  expect(()=>assertCurrentFilmMixedControls({...preview,frameAnchorControl:{...preview.frameAnchorControl,positions:[10000,0]}},anchored(),"animatic")).toThrow("anchor report");
  expect(()=>assertCurrentFilmMixedControls(clip,anchored(),"animatic")).toThrow("anchor report");
  expect(()=>assertCurrentFilmMixedControls(preview,base,"animatic")).toThrow("anchor report");
});

test("unchanged plain rows stay compatible while null controls cannot hide malformed metadata",()=>{
  expect(()=>assertCurrentFilmMixedControls(clip,base,"animatic")).not.toThrow();
  for(const key of ["cameraPathControl","frameAnchorControl"])expect(()=>assertCurrentFilmMixedControls(Object.assign({},clip,{[key]:null}),base,"animatic")).toThrow("explicit");
});
