import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../src/server";
import {ProjectService} from "../src/index";
import {DurableJobStore} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {ReferenceBlobStore} from "../../storage/src/references";
import {validateSnapshot,type StateSnapshot} from "../../storage/src/snapshots";
import {referenceFal} from "../../../test/fixtures/reference-fal";
import type {DirectionEntry,DirectionSnapshot} from "../../planner/src/direction";
import type {ReferenceAsset} from "../../planner/src/references";
const SCRIPT="EXT. GARDEN - DAY\n\nSpud waves beside the gate.";
const fixtures:{root:string;server:ReturnType<typeof createApiServer>}[]=[];
afterAll(async()=>{for(const f of fixtures){await f.server.stop(true);rmSync(f.root,{recursive:true,force:true});}});
interface View {direction:DirectionSnapshot;plan:DirectionEntry[];scriptVersion:number;anchorAssets:ReferenceAsset[]}
const run=(args:string[])=>{const p=Bun.spawnSync(args);if(p.exitCode)throw new Error(p.stderr.toString());return p.stdout;};
function png(color:string){return run(["ffmpeg","-v","error","-f","lavfi","-i",`color=${color}:s=320x180`,"-frames:v","1","-f","image2pipe","-vcodec","png","-"]);}
async function fixture(){
  process.env.HV_TOKEN_SECRET="frame-anchor-api-fixture-secret-at-least-thirty-two-characters";
  const root=mkdtempSync(join(tmpdir(),"hv-anchor-api-")),paths={queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json")};
  const server=createApiServer({port:0,hostname:"127.0.0.1",...paths,rateLimit:{api:{limit:10000,windowMs:60000}}});fixtures.push({root,server});
  const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const owner=await(await call("/api/projects","POST")).json() as {projectId:string;token:string},base="/api/projects/"+owner.projectId;
  await call(base+"/script","PUT",{text:SCRIPT},owner.token);await call(base+"/rights","POST",{attested:true},owner.token);
  const view=()=>call(base+"/direction","GET",undefined,owner.token).then(response=>response.json() as Promise<View>);
  const save=async(settings:unknown)=>{const state=await view();return call(base+"/direction/shot-1-1","PUT",{settings,sourceHash:state.plan[0]!.sourceHash,expectedVersion:state.direction.version,expectedScriptVersion:state.scriptVersion},owner.token);};
  const upload=async(data:Buffer,headers:Record<string,string>={})=>{const state=await view();return fetch(new URL(base+"/direction/shot-1-1/anchors?label=Garden",server.url),{method:"POST",headers:{authorization:"Bearer "+owner.token,"content-type":"image/png","x-hv-reference-attested":"true","x-hv-direction-version":String(state.direction.version),"x-hv-script-version":String(state.scriptVersion),"x-hv-source-hash":state.plan[0]!.sourceHash,...headers},body:new Uint8Array(data)});};
  const projects=new ProjectService(paths.statePath),store=new DurableJobStore(paths.queuePath),ledger=new CostLedger(paths.costLedgerPath),references=new ReferenceBlobStore(paths.artifactRoot);
  const worker=()=>processNextJob(store,paths.artifactRoot,{projects,ledger,references,reviewQueue:new OperatorReviewQueue(join(root,"reviews.json"))});
  return {root,paths,server,call,owner,base,view,save,upload,projects,store,ledger,references,worker};
}
test("private uploads preserve the direction draft and reject stale, unauthorized or forged anchor records",async()=>{
  const f=await fixture(),data=png("red"),other=await(await f.call("/api/projects","POST")).json() as {token:string};
  const preflight=await fetch(new URL(f.base+"/direction/shot-1-1/anchors",f.server.url),{method:"OPTIONS",headers:{origin:"http://localhost:8081","access-control-request-method":"POST","access-control-request-headers":"x-hv-direction-version,x-hv-script-version,x-hv-source-hash"}});
  expect(preflight.status).toBe(204);for(const key of ["x-hv-direction-version","x-hv-script-version","x-hv-source-hash"])expect(preflight.headers.get("access-control-allow-headers")).toContain(key);
  const review=await(await f.call(f.base+"/reviews","POST",{permission:"approve"},f.owner.token)).json() as {token:string};
  for(const token of [other.token,review.token])expect((await f.upload(data,{authorization:"Bearer "+token})).status).toBe(401);
  expect((await f.upload(data,{"x-hv-reference-attested":"false"})).status).toBe(400);
  expect((await f.upload(data,{"x-hv-direction-version":"99"})).status).toBe(409);
  expect((await f.upload(data,{"x-hv-source-hash":"0".repeat(64)})).status).toBe(409);
  expect((await f.upload(Buffer.from("bad PNG"))).status).toBe(400);
  const response=await f.upload(data);expect(response.status).toBe(201);const {asset}=await response.json() as {asset:ReferenceAsset};
  const state=await f.view();expect(state.direction.version).toBe(0);expect(state.anchorAssets).toEqual([asset]);expect(asset.source).toEqual({kind:"shot-anchor",shotId:"shot-1-1",sourceHash:state.plan[0]!.sourceHash,label:"Garden"});
  const image=await f.call(f.base+"/references/"+asset.id,"GET",undefined,f.owner.token);expect(image.headers.get("cache-control")).toBe("private, no-store");expect(Buffer.from(await image.arrayBuffer())).toEqual(Buffer.from(await f.references.read(asset)));
  expect((await f.call(f.base+"/references/"+asset.id,"GET",undefined,review.token)).status).toBe(401);
  const anchors={frames:[{at:0,asset}],fallback:"stop" as const};expect((await f.save({frameAnchors:anchors})).status).toBe(200);
  expect((await f.save({frameAnchors:{...anchors,frames:[{at:0,asset:{...asset,id:crypto.randomUUID()}}]}})).status).toBe(400);
  expect((await f.save({frameAnchors:{...anchors,frames:[{at:5000,asset}]}})).status).toBe(400);
  const stateSnapshot:StateSnapshot={schema:"hv-state/1",projects:JSON.parse(readFileSync(f.paths.statePath,"utf8")),jobs:[],ledger:{events:[],reservations:[]},reviews:[]};
  expect(validateSnapshot(stateSnapshot).projects.projects[0]!.directionHistory![0]!.entries[0]!.settings.frameAnchors).toEqual(anchors);
  const forged=structuredClone(stateSnapshot);forged.projects.projects[0]!.referenceAssets=[];expect(()=>validateSnapshot(forged)).toThrow("private image catalog");
},15000);
test("preview uses private anchor images, final stops without native support, and explicit fallback survives approval and provenance",async()=>{
  const f=await fixture(),config={HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_PROVIDER_POOL:'["mock"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0"},original=Object.fromEntries(Object.keys(config).map(k=>[k,process.env[k]]));
  try{Object.assign(process.env,config);
    const assets:ReferenceAsset[]=[];for(const color of ["red","lime","blue"])assets.push((await(await f.upload(png(color))).json() as {asset:ReferenceAsset}).asset);
    const anchors={frames:assets.map((asset,i)=>({at:i*5000,asset})),fallback:"stop"};expect((await f.save({durationFrames:121,previewMove:"static",frameAnchors:anchors})).status).toBe(200);
    const render=async(body:unknown={})=>{const admitted=await f.call(f.base+"/jobs","POST",body,f.owner.token);expect(admitted.status).toBe(202);const job=await f.worker();expect(job?.failureReason??job?.cancelReason).toBeUndefined();expect(job?.status).toBe("done");return job!;};
    const first=await render();expect((await f.call(f.base+"/animatic/decision","POST",{animaticJobId:first.id,decision:"approved"},f.owner.token)).status).toBe(201);
    const denied=await f.call(f.base+"/jobs","POST",{stage:"final",animaticJobId:first.id},f.owner.token);expect(denied.status).toBe(400);expect((await denied.json() as {error:string}).error).toContain("frame-anchors");
    expect((await f.save({durationFrames:121,frameAnchors:{...anchors,fallback:"storyboard"}})).status).toBe(200);
    expect((await f.call(f.base+"/jobs","POST",{stage:"final",animaticJobId:first.id},f.owner.token)).status).toBe(409);
    const preview=await render();await f.call(f.base+"/animatic/decision","POST",{animaticJobId:preview.id,decision:"approved"},f.owner.token);
    const final=await render({stage:"final",animaticJobId:preview.id});
    for(const job of [first,preview,final]){const manifest=JSON.parse(readFileSync(join(f.paths.artifactRoot,job.output!.manifestPath),"utf8"));expect(manifest.shots[0].frameAnchorControl).toEqual({mode:"storyboard",positions:[0,5000,10000]});expect(manifest.shots[0].durationSec).toBe(121/30);expect(manifest.shots[0].routing.adaptations).toContain("provided-anchor-stills; no generated subject motion");}
    expect(f.ledger.reservedUsd()).toBe(0);expect(f.ledger.monthSpend()).toBe(0);
    expect(final.output!.frameAnchorRenders).toEqual([{shotId:"shot-1-1",mode:"storyboard",positions:[0,5000,10000]}]);
    const publicFinal=await(await f.call("/api/jobs/"+final.id,"GET",undefined,f.owner.token)).json() as {frameAnchorRenders:unknown};expect(publicFinal.frameAnchorRenders).toEqual(final.output!.frameAnchorRenders);
    const review=await(await f.call(f.base+"/reviews","POST",{permission:"read"},f.owner.token)).json() as {token:string};
    const reviewed=await(await f.call("/api/reviews/"+review.token)).json() as {frameAnchorRenders:unknown};expect(reviewed.frameAnchorRenders).toEqual(final.output!.frameAnchorRenders);
    const snapshot:StateSnapshot={schema:"hv-state/1",projects:JSON.parse(readFileSync(f.paths.statePath,"utf8")),jobs:f.store.all(),ledger:{events:[],reservations:[]},reviews:[]};expect(validateSnapshot(snapshot).jobs).toHaveLength(3);
    const missing=structuredClone(snapshot);missing.projects.projects[0]!.directionHistory=[];missing.projects.projects[0]!.referenceAssets=[];expect(()=>validateSnapshot(missing)).toThrow("private image catalog");
    const wrongMode=structuredClone(snapshot);wrongMode.jobs[0]!.output!.frameAnchorRenders![0]!.mode="native";expect(()=>validateSnapshot(wrongMode)).toThrow("render provenance");
  }finally{for(const [k,v]of Object.entries(original)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
},45000);
test("native final dispatch pins both private images and endpoint timing through the admitted worker plan",async()=>{
  const f=await fixture(),raw=join(f.root,"native.mp4");run(["ffmpeg","-y","-v","error","-f","lavfi","-i","color=red:s=320x180:r=30:d=5,drawbox=color=blue:t=fill:enable='eq(n,149)'","-c:v","libx264","-pix_fmt","yuv420p",raw]);
  const http=referenceFal(png("red"),readFileSync(raw),f.server.url.origin),realFetch=globalThis.fetch,config={HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_PROVIDER_POOL:'["mock","fal:kling-o3-standard-keyframes"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0",HV_ROUTING_STRATEGY:"cost",FAL_KEY:"frame-anchor-contract-fixture-only"},original=Object.fromEntries(Object.keys(config).map(k=>[k,process.env[k]]));
  try{Object.assign(process.env,config);globalThis.fetch=http.fetchImpl;
    const assets:ReferenceAsset[]=[];for(const color of ["red","blue"])assets.push((await(await f.upload(png(color))).json() as {asset:ReferenceAsset}).asset);
    expect((await f.save({durationFrames:121,frameAnchors:{frames:assets.map((asset,i)=>({at:i*10000,asset})),fallback:"storyboard"}})).status).toBe(200);
    expect((await f.call(f.base+"/jobs","POST",{},f.owner.token)).status).toBe(202);const preview=await f.worker();expect(preview?.status).toBe("done");expect(http.submissions).toHaveLength(0);
    await f.call(f.base+"/animatic/decision","POST",{animaticJobId:preview!.id,decision:"approved"},f.owner.token);
    expect((await f.call(f.base+"/jobs","POST",{stage:"final",animaticJobId:preview!.id},f.owner.token)).status).toBe(202);const final=await f.worker();expect(final?.failureReason??final?.cancelReason).toBeUndefined();expect(final?.status).toBe("done");expect(http.submissions).toHaveLength(1);
    expect(http.submissions[0]!.body.start_image_url).toBe("data:image/png;base64,"+(await f.references.read(assets[0]!)).toString("base64"));expect(http.submissions[0]!.body.end_image_url).toBe("data:image/png;base64,"+(await f.references.read(assets[1]!)).toString("base64"));
    const manifest=JSON.parse(readFileSync(join(f.paths.artifactRoot,final!.output!.manifestPath),"utf8"));expect(manifest.shots[0].frameAnchorControl).toEqual({mode:"native",positions:[0,10000],timing:{sourceFrames:150,outputFrames:121}});expect(f.ledger.monthSpend()).toBe(.42);expect(f.ledger.reservedUsd()).toBe(0);
  }finally{globalThis.fetch=realFetch;for(const [k,v]of Object.entries(original)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
},45000);
