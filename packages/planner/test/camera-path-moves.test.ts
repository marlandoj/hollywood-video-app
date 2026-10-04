import {expect,test} from "bun:test";
import {assertCameraPathApplied,cameraPathMoves,CAMERA_MOVE_MIN_CHANGE,type CameraKeyframe,type ShotCameraPath} from "../src/camera-path";

// HV-020-01: a screen-space path read as the moves a provider's camera control takes.
const key=(at:number,x:number,y:number,size:number):CameraKeyframe=>({at,x,y,size,easing:"linear"});
const path=(...keyframes:CameraKeyframe[]):ShotCameraPath=>({mode:"screen-space",keyframes});

test("a path is read as one move per axis: centre right is a pan right, down a tilt down, a shrinking crop a zoom in",()=>{
  expect(cameraPathMoves(path(key(0,0,2500,5000),key(10000,5000,2500,5000)))).toEqual({moves:["pan-right"]});
  expect(cameraPathMoves(path(key(0,5000,2500,5000),key(10000,0,2500,5000)))).toEqual({moves:["pan-left"]});
  expect(cameraPathMoves(path(key(0,2500,5000,5000),key(10000,2500,0,5000)))).toEqual({moves:["tilt-up"]});
  // A zoom about the centre moves x and y but not the centre: it is a zoom only.
  expect(cameraPathMoves(path(key(0,0,0,10000),key(10000,2500,2500,5000)))).toEqual({moves:["zoom-in"]});
  expect(cameraPathMoves(path(key(0,2500,2500,5000),key(10000,0,0,10000)))).toEqual({moves:["zoom-out"]});
  expect(cameraPathMoves(path(key(0,0,0,10000),key(4000,2000,2000,7000),key(10000,5000,5000,5000)))).toEqual({moves:["pan-right","tilt-down","zoom-in"]});
});

test("a path that turns back or barely moves is not a move",()=>{
  expect(cameraPathMoves(path(key(0,0,2500,5000),key(5000,5000,2500,5000),key(10000,2500,2500,5000)))).toEqual({moves:null,reason:"path-reverses"});
  expect(cameraPathMoves(path(key(0,0,0,10000),key(5000,2500,2500,5000),key(10000,0,0,10000)))).toEqual({moves:null,reason:"path-reverses"});
  expect(cameraPathMoves(path(key(0,2500,2500,5000),key(10000,2500,2500,5000)))).toEqual({moves:null,reason:"path-has-no-move"});
  // Below 1% of the frame on every axis is a still camera; at 1% it is a move.
  expect(cameraPathMoves(path(key(0,2500,2500,5000),key(10000,2500+CAMERA_MOVE_MIN_CHANGE-1,2500,5000)))).toEqual({moves:null,reason:"path-has-no-move"});
  expect(cameraPathMoves(path(key(0,2500,2500,5000),key(10000,2500+CAMERA_MOVE_MIN_CHANGE,2500,5000)))).toEqual({moves:["pan-right"]});
});

test("a render's applied report must match its path: native with the path's own moves, a crop with a known reason, legacy with neither",()=>{
  const pan=path(key(0,0,2500,5000),key(10000,5000,2500,5000)),back=path(key(0,0,2500,5000),key(5000,5000,2500,5000),key(10000,0,2500,5000));
  for(const ok of [{},{applied:"native",moves:["pan-right"]},{applied:"local-crop",reason:"provider-has-no-native-camera"},{applied:"local-crop",reason:"move-not-supported"}])
    expect(()=>assertCameraPathApplied(ok,pan)).not.toThrow();
  for(const bad of [{applied:"native",moves:["pan-left"]},{applied:"native",moves:["pan-right","zoom-in"]},{applied:"native"},{applied:"native",moves:["pan-right"],reason:"move-not-supported"},
    {applied:"local-crop"},{applied:"local-crop",reason:"cheaper"},{applied:"local-crop",reason:"move-not-supported",moves:["pan-right"]},{applied:"optical"},{moves:["pan-right"]},{reason:"path-reverses"}])
    expect(()=>assertCameraPathApplied(bad,pan)).toThrow("invalid camera path render provenance");
  // A path that is not a move can never have been sent natively.
  expect(()=>assertCameraPathApplied({applied:"native",moves:[]},back)).toThrow("invalid camera path render provenance");
  expect(()=>assertCameraPathApplied({applied:"local-crop",reason:"path-reverses"},back)).not.toThrow();
});
