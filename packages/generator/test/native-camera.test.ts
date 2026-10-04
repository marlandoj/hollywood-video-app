import {afterAll,afterEach,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {baseCapability,cameraControlPlan,capability,matchCapability,validateCapability,videoRequirements} from "../src/capabilities";
import {FAL_MODELS,FalVideoProvider,falVideoCapability,type FalModelSpec} from "../src/fal";
import {RoutedGenerator,type RouteDecision} from "../src/router";
import {FailoverGenerator,sunkCostsOf,type CostRecord,type ProviderAdapter} from "../src/index";
import type {NativeCameraMove,ShotCameraPath} from "../../planner/src/camera-path";

/**
 * HV-020-01. No model in the pool documents a camera-control input in this repository, so the
 * supporting model here is a fixture: `fixture_camera_moves` is not a vendor parameter. It proves
 * the plumbing -- capability, request, crop skipped, provenance -- not that any vendor honours it.
 */
const root=mkdtempSync(join(tmpdir(),"hv-native-camera-"));afterAll(()=>rmSync(root,{recursive:true,force:true}));
const API="https://fal.test",MEDIA="https://v3.fal.media/files/halves.mp4",FIXTURE="fixture-camera";
function run(args:string[]){const p=Bun.spawnSync(args);if(p.exitCode)throw new Error(p.stderr.toString());return p.stdout;}
// Red left half, blue right half: a local crop of the left half reads red, the whole frame reads both.
const halves=join(root,"halves.mp4");run(["ffmpeg","-y","-v","error","-f","lavfi","-i","color=red:s=640x360:r=30:d=5,drawbox=x=320:y=0:w=320:h=360:color=blue:t=fill","-c:v","libx264","-pix_fmt","yuv420p",halves]);
const pixel=(file:string,frame=0)=>run(["ffmpeg","-v","error","-i",file,"-vf",`select=eq(n\\,${frame}),scale=1:1`,"-frames:v","1","-pix_fmt","rgb24","-f","rawvideo","-"]);
const panRight:ShotCameraPath={mode:"screen-space",keyframes:[{at:0,x:0,y:2500,size:5000,easing:"linear"},{at:10000,x:5000,y:2500,size:5000,easing:"linear"}]};
const panAndZoom:ShotCameraPath={mode:"screen-space",keyframes:[{at:0,x:0,y:0,size:10000,easing:"linear"},{at:10000,x:5000,y:2500,size:5000,easing:"smooth"}]};
const fixtureSpec=(moves:NativeCameraMove[]):FalModelSpec=>({
  endpoint:"fixture/camera-video",billedDurationsSec:[5],aspectRatios:["16:9"],usdPerBilledSecond:.07,supportsSeed:false,durationInput:sec=>String(sec),extraInput:{},
  cameraControl:{moves,input:requested=>({fixture_camera_moves:[...requested]})},
});
afterEach(()=>{delete FAL_MODELS[FIXTURE];});
function fakeFal(endpoint:string){
  const submits:Record<string,unknown>[]=[],json=(body:unknown)=>new Response(JSON.stringify(body),{headers:{"content-type":"application/json"}});
  const fetchImpl=(async(input:RequestInfo|URL,init?:RequestInit)=>{const url=String(input);
    if(init?.method==="POST"&&url===`${API}/${endpoint}`){submits.push(JSON.parse(String(init.body)));return json({request_id:"req-1"});}
    if(url.endsWith("/requests/req-1/status"))return json({status:"COMPLETED"});
    if(url.endsWith("/requests/req-1"))return json({video:{url:MEDIA}});
    if(url===MEDIA)return new Response(Bun.file(halves));
    return new Response("unexpected",{status:404});}) as typeof fetch;
  return {submits,fetchImpl};
}
const params={seed:9,shotId:"shot-1",widthxheight:"640x360",fps:30,durationSec:2};
const router=(adapter:ProviderAdapter,decisions:RouteDecision[]=[])=>new RoutedGenerator({candidates:[{id:"fal:"+adapter.model,adapter}],maxAttemptUsd:5,onDecision:async d=>{decisions.push(d);}});

test("every fal model in the pool is camera: none, and its admitted capability revision is unchanged",()=>{
  // The revisions on main before HV-020-01. An absent field, not an empty list, keeps them.
  const before:Record<string,string>={
    "kling-o3-standard-keyframes":"05a7045b25c9feb8b7d778c08c60137c9a07e061fdeef10d8da8af1ea218ffec",
    "kling-o3-standard-reference":"a3e29d7f6b113487b3da6c8b0316ef28b3ed95bc956815c8751c2e0b694730e4",
    "kling-v2.5-turbo-pro":"5b1ca8899db0c642d6fe5becb664bc2ad9f55427798b0bc0670fd198081cc6c3",
    "veo3-fast":"a840dfc4b1e341ef4efedb5e40586be7eeabcd79a73a1637dd190cf7dc45aef3"};
  expect(Object.keys(FAL_MODELS).sort()).toEqual(Object.keys(before).sort());
  for(const [key,revision] of Object.entries(before)){const snapshot=falVideoCapability(key);
    expect(FAL_MODELS[key]!.cameraControl).toBeUndefined();expect(snapshot.nativeCamera).toBeUndefined();expect(snapshot.revision).toBe(revision);
    expect(cameraControlPlan(snapshot,panRight)).toEqual({applied:"local-crop",reason:"provider-has-no-native-camera"});}
});

test("a capability declares native moves only as a non-empty set of known moves",()=>{
  const definition=baseCapability("fixture","fixture-model","video");
  expect(capability({...definition,nativeCamera:{moves:["pan-right","zoom-in"]}}).nativeCamera).toEqual({moves:["pan-right","zoom-in"]});
  for(const nativeCamera of [{moves:[]},{moves:["dolly-in"]},{moves:["pan-right","pan-right"]},{moves:["pan-right"],speed:3},null,{moves:"pan-right"}])
    expect(()=>capability({...definition,nativeCamera} as never)).toThrow("Invalid provider capability configuration.");
});

test("the request body carries the camera control for a supporting model, and the move is not cropped again",async()=>{
  FAL_MODELS[FIXTURE]=fixtureSpec(["pan-left","pan-right","zoom-in"]);
  const fal=fakeFal("fixture/camera-video"),provider=new FalVideoProvider({model:FIXTURE,apiKey:"k",apiBase:API,fetchImpl:fal.fetchImpl,pollMs:1});
  expect(provider.capabilities.nativeCamera).toEqual({moves:["pan-left","pan-right","zoom-in"]});
  const decisions:RouteDecision[]=[],clip=await router(provider,decisions).generate("A garden gate",9,{...params,cameraPath:panRight},join(root,"native.mp4"));
  expect(fal.submits).toHaveLength(1);
  expect(fal.submits[0]).toEqual({prompt:"A garden gate",duration:"5",aspect_ratio:"16:9",fixture_camera_moves:["pan-right"]});
  expect(clip.cameraPathControl).toEqual({mode:"screen-space",keyframes:panRight.keyframes,outputFrames:60,applied:"native",moves:["pan-right"]});
  expect(clip.routing!.adaptations).toContain("native camera control: pan-right");
  expect(clip.routing!.adaptations.join("|")).not.toContain("digital framing applied locally");
  expect(decisions[0]!.candidates[0]!.adaptations).toContain("native camera control: pan-right");
  // No local crop: the first frame still shows both halves of the provider's frame.
  const first=pixel(clip.path,0);expect(first[0]!).toBeGreaterThan(90);expect(first[2]!).toBeGreaterThan(90);
},30000);

test("an unsupported model falls back to the local crop, sends nothing, and records why",async()=>{
  const fal=fakeFal(FAL_MODELS["kling-v2.5-turbo-pro"]!.endpoint),provider=new FalVideoProvider({model:"kling-v2.5-turbo-pro",apiKey:"k",apiBase:API,fetchImpl:fal.fetchImpl,pollMs:1});
  const clip=await router(provider).generate("A garden gate",9,{...params,cameraPath:panRight},join(root,"crop.mp4"));
  expect(Object.keys(fal.submits[0]!).sort()).toEqual(["aspect_ratio","duration","negative_prompt","prompt"]);
  expect(clip.cameraPathControl).toEqual({mode:"screen-space",keyframes:panRight.keyframes,outputFrames:60,applied:"local-crop",reason:"provider-has-no-native-camera"});
  expect(clip.routing!.adaptations).toContain("screen-space camera path; digital framing applied locally");
  // The crop ran: the first frame is the red left half only.
  const first=pixel(clip.path,0);expect(first[0]!).toBeGreaterThan(240);expect(first[2]!).toBeLessThan(20);
},30000);

test("a supporting model that lacks one of the path's moves falls back to the crop with that reason",async()=>{
  FAL_MODELS[FIXTURE]=fixtureSpec(["pan-right"]);
  const fal=fakeFal("fixture/camera-video"),provider=new FalVideoProvider({model:FIXTURE,apiKey:"k",apiBase:API,fetchImpl:fal.fetchImpl,pollMs:1});
  const clip=await router(provider).generate("A garden gate",9,{...params,cameraPath:panAndZoom},join(root,"partial.mp4"));
  expect(fal.submits[0]).not.toHaveProperty("fixture_camera_moves");
  expect(clip.cameraPathControl).toMatchObject({applied:"local-crop",reason:"move-not-supported"});
  expect(clip.cameraPathControl).not.toHaveProperty("moves");
  const reverses:ShotCameraPath={mode:"screen-space",keyframes:[{at:0,x:0,y:2500,size:5000,easing:"linear"},{at:5000,x:5000,y:2500,size:5000,easing:"linear"},{at:10000,x:0,y:2500,size:5000,easing:"linear"}]};
  expect(cameraControlPlan(provider.capabilities,reverses)).toEqual({applied:"local-crop",reason:"path-reverses"});
  expect(matchCapability(provider.capabilities,videoRequirements({...params,cameraPath:reverses}),5).adaptations).toContain("screen-space camera path; digital framing applied locally");
},30000);

test("eligibility, price and the requirements hash are the same whether the move is native or cropped",()=>{
  FAL_MODELS[FIXTURE]=fixtureSpec(["pan-right"]);
  const native=falVideoCapability(FIXTURE),none=capability((({schema:_s,revision:_r,priceVersion:_p,nativeCamera:_n,...rest})=>rest)(native));
  const request=videoRequirements({...params,cameraPath:panRight}),a=matchCapability(native,request,5),b=matchCapability(none,request,5);
  expect([a.eligible,a.reasons,a.estimateUsd,a.billedDurationSec]).toEqual([b.eligible,b.reasons,b.estimateUsd,b.billedDurationSec]);
  expect(a.adaptations.filter(x=>!x.includes("camera"))).toEqual(b.adaptations.filter(x=>!x.includes("camera")));
  expect(request).not.toHaveProperty("nativeCamera");
});

test("declaring native camera moves is a capability revision change, refused for a pinned route like any other",async()=>{
  const base=falVideoCapability("kling-v2.5-turbo-pro"),{schema:_s,revision:_r,priceVersion:_p,...definition}=base;
  const declared=capability({...definition,nativeCamera:{moves:["pan-right"]}});
  expect(declared.revision).not.toBe(base.revision);expect(declared.priceVersion).toBe(base.priceVersion);
  expect(()=>validateCapability({...base,nativeCamera:{moves:["pan-right"]}})).toThrow("Provider capability integrity failed.");
  let current=base,calls=0;
  const adapter:ProviderAdapter={name:"fal",model:base.model,get capabilities(){return current;},generate:async()=>{calls++;throw new Error("must not dispatch");}};
  const pinned=router(adapter);current=declared;
  await expect(pinned.generate("A garden gate",9,{...params,cameraPath:panRight},join(root,"drift.mp4"))).rejects.toThrow("capability-changed");
  expect(calls).toBe(0);
});

test("a provider that declares a native move but does not confirm it is stopped, its cost kept once, with no failover",async()=>{
  const definition=baseCapability("fixture","fixture-model","video");definition.output.nativeResolution="requested";definition.nativeCamera={moves:["pan-right"]};
  const cost:CostRecord={provider:"fixture",model:"fixture-model",prompt_tokens:0,output_frames:60,gpu_seconds:5,total_cost_usd:.35};
  let called=0,fallback=0;const drained:CostRecord[]=[];
  const silent:ProviderAdapter={name:"fixture",model:"fixture-model",capabilities:capability(definition),generate:async(_p,seed,_q,path)=>{called++;return {path,seed,provider:"fixture",model:"fixture-model",durationSec:2,fingerprint:"a".repeat(64),cost};}};
  const gen=new FailoverGenerator(silent,{...silent,generate:async(...args)=>{fallback++;return silent.generate(...args);}});
  let error:unknown;try{await gen.generate("A garden gate",9,{...params,cameraPath:panRight,onAttemptCost:c=>{drained.push(c);}},join(root,"silent.mp4"));}catch(e){error=e;}
  expect(error).toMatchObject({name:"FramingError"});expect((error as Error).message).toContain("did not confirm");
  expect([called,fallback]).toEqual([1,0]);expect(drained).toEqual([cost]);expect(sunkCostsOf(error)).toEqual([cost]);
  // And the reverse: a clip claiming a native move its capability never declared.
  const {nativeCamera:_declared,...undeclared}=definition,none=capability(undeclared);
  const claims:ProviderAdapter={name:"fixture",model:"fixture-model",capabilities:none,generate:async(_p,seed,_q,path)=>({path,seed,provider:"fixture",model:"fixture-model",durationSec:2,fingerprint:"a".repeat(64),cost,
    cameraPathControl:{mode:"screen-space",keyframes:panRight.keyframes,outputFrames:60,applied:"native",moves:["pan-right"]}})};
  await expect(new FailoverGenerator(claims,claims).generate("A garden gate",9,{...params,cameraPath:panRight},join(root,"claims.mp4"))).rejects.toThrow("does not declare");
});
