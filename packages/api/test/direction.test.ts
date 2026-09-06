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
import {DeterministicMockImageProvider,DeterministicMockProvider} from "../../generator/src/index";
import {referenceFal,REFERENCE_IMAGE_MODEL,REFERENCE_VIDEO_MODEL} from "../../../test/fixtures/reference-fal";
import {CAST_INPUT} from "../../../test/fixtures/casting";
import type {DirectionEntry,DirectionSnapshot} from "../../planner/src/direction";
const SCRIPT="EXT. GARDEN - DAY\n\nSpud waves beside the gate.";
const fixtures:{root:string;server:ReturnType<typeof createApiServer>}[]=[];
afterAll(async()=>{for(const f of fixtures){await f.server.stop(true);rmSync(f.root,{recursive:true,force:true});}});
interface View {direction:DirectionSnapshot;plan:DirectionEntry[];scriptVersion:number;staleShotIds:string[]}
async function fixture(){
  process.env.HV_TOKEN_SECRET="shot-direction-api-fixture-secret-at-least-thirty-two-characters";
  const root=mkdtempSync(join(tmpdir(),"hv-direction-api-")),paths={queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json")};
  const server=createApiServer({port:0,hostname:"127.0.0.1",...paths,rateLimit:{api:{limit:10000,windowMs:60000}}});fixtures.push({root,server});
  const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const owner=await(await call("/api/projects","POST")).json() as {projectId:string;token:string},base="/api/projects/"+owner.projectId;
  await call(base+"/script","PUT",{text:SCRIPT},owner.token);await call(base+"/rights","POST",{attested:true},owner.token);
  const view=()=>call(base+"/direction","GET",undefined,owner.token).then(response=>response.json() as Promise<View>);
  const save=async(settings:unknown,version?:number)=>{const state=await view();return call(base+"/direction/shot-1-1","PUT",{settings,sourceHash:state.plan[0]!.sourceHash,expectedVersion:version??state.direction.version,expectedScriptVersion:state.scriptVersion},owner.token);};
  const projects=new ProjectService(paths.statePath),store=new DurableJobStore(paths.queuePath),ledger=new CostLedger(paths.costLedgerPath),references=new ReferenceBlobStore(paths.artifactRoot);
  const worker=()=>processNextJob(store,paths.artifactRoot,{projects,ledger,references,reviewQueue:new OperatorReviewQueue(join(root,"reviews.json"))});
  return {root,paths,server,call,owner,base,view,save,projects,store,ledger,worker};
}
test("shot routes require owner scope, current revision and exact source; a changed script needs explicit review",async()=>{
  const f=await fixture(),other=await(await f.call("/api/projects","POST")).json() as {token:string};
  const review=await(await f.call(f.base+"/reviews","POST",{permission:"approve"},f.owner.token)).json() as {token:string};
  for(const token of [undefined,other.token,review.token])expect((await f.call(f.base+"/direction","GET",undefined,token)).status).toBe(401);
  const response=await f.call(f.base+"/direction","GET",undefined,f.owner.token);expect(response.headers.get("cache-control")).toBe("private, no-store");
  const before=await f.view();expect((await f.save({lensMm:85,previewMove:"push-in"})).status).toBe(200);expect((await f.save({},0)).status).toBe(409);
  await f.call(f.base+"/script","PUT",{text:SCRIPT.replace("gate","bridge")},f.owner.token);
  expect((await f.view()).staleShotIds).toEqual(["shot-1-1"]);expect((await f.call(f.base+"/jobs","POST",{},f.owner.token)).status).toBe(409);expect(f.store.all()).toHaveLength(0);
  expect((await f.call(f.base+"/direction/shot-1-1","PUT",{settings:{lensMm:85},sourceHash:before.plan[0]!.sourceHash,expectedVersion:1,expectedScriptVersion:2},f.owner.token)).status).toBe(409);
  expect((await f.save({lensMm:85})).status).toBe(200);expect((await f.view()).staleShotIds).toEqual([]);
  expect((await f.call(f.base+"/direction/restore","POST",{version:1,expectedVersion:2},f.owner.token)).status).toBe(200);expect((await f.view()).staleShotIds).toEqual(["shot-1-1"]);
  expect((await f.call(f.base+"/direction/shot-1-1/remove","POST",{expectedVersion:3},f.owner.token)).status).toBe(200);expect((await f.view()).direction.entries).toEqual([]);
});
test("unsupported preview motion and prohibited direction refuse admission without calls or reservations",async()=>{
  const f=await fixture(),previous=process.env.HV_ANIMATIC_PROVIDER_POOL;
  try{process.env.HV_ANIMATIC_PROVIDER_POOL='["legacy-mock"]';await f.save({previewMove:"pan-left",durationFrames:120});
    const denied=await f.call(f.base+"/jobs","POST",{},f.owner.token);expect(denied.status).toBe(400);expect((await denied.json() as {error:string}).error).toContain("camera");expect(f.store.all()).toHaveLength(0);
    await f.save({durationFrames:120});const admitted=await f.call(f.base+"/jobs","POST",{},f.owner.token);expect(admitted.status).toBe(202);
    const job=await f.worker();expect(job?.status).toBe("done");const manifest=JSON.parse(readFileSync(join(f.paths.artifactRoot,job!.output!.manifestPath),"utf8"));expect(manifest.shots[0].durationSec).toBe(4);
    await f.save({performance:"deepfake of a real celebrity"});expect((await f.call(f.base+"/jobs","POST",{},f.owner.token)).status).toBe(400);expect(f.store.all()).toHaveLength(1);expect(f.ledger.reservedUsd()).toBe(0);
  }finally{if(previous===undefined)delete process.env.HV_ANIMATIC_PROVIDER_POOL;else process.env.HV_ANIMATIC_PROVIDER_POOL=previous;}
});
test("saved directions reach real preview and final pipelines with private actor bytes, fixed timing and approval invalidation",async()=>{
  const f=await fixture(),id=crypto.randomUUID();await f.call(f.base+"/cast/"+id,"PUT",{expectedVersion:0,character:CAST_INPUT},f.owner.token);
  const png=readFileSync((await new DeterministicMockImageProvider().generateFrame("Fictional character",7,{widthxheight:"640x512"},join(f.root,"reference.png"))).path);
  const video=readFileSync((await new DeterministicMockProvider().generate("Fictional character",7,{seed:7,durationSec:5,widthxheight:"1280x720"},join(f.root,"reference.mp4"))).path);
  const upload=await fetch(new URL(f.base+"/cast/"+id+"/references",f.server.url),{method:"POST",headers:{authorization:"Bearer "+f.owner.token,"content-type":"image/png","x-hv-cast-version":"1","x-hv-reference-attested":"true"},body:new Uint8Array(png)});expect(upload.status).toBe(201);
  const settings={durationFrames:120,previewMove:"pan-left",size:"close-up",angle:"low",heightM:1.2,lensMm:85,lensType:"spherical",movement:"dolly",movementSpeed:"Slow",screenDirection:"left-to-right",keyLight:"Soft window",fillLight:"White card",backLight:"Warm practical",motivatedSources:"A window",temperatureK:3200,contrastRatio:4,timeOfDay:"Morning",blocking:"Spud crosses to the gate.",eyelines:"Toward the gate",performance:"Wait, then smile.",soundIntent:"Quiet garden ambience",transitionIntent:"Cut on the turn"};
  expect((await f.save(settings)).status).toBe(200);const first=(await f.view()).direction;
  const config={HV_ANIMATIC_PROVIDER_POOL:'["mock","image:fal:flux-2-edit"]',HV_PROVIDER_POOL:'["mock","fal:kling-o3-standard-reference"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0",FAL_KEY:"shot-direction-closed-fixture-only"};
  const original=Object.fromEntries(Object.keys(config).map(key=>[key,process.env[key]])),http=referenceFal(png,video,f.server.url.origin),realFetch=globalThis.fetch;
  try{Object.assign(process.env,config);globalThis.fetch=http.fetchImpl;
    const admit=async(body:unknown)=>{const response=await f.call(f.base+"/jobs","POST",body,f.owner.token);const data=await response.json() as {jobId:string;error?:string};if(response.status!==202)throw new Error(data.error);return data.jobId;};
    const previewId=await admit({}),preview=await f.worker();expect(preview?.id).toBe(previewId);expect(preview?.failureReason).toBeUndefined();expect(preview?.status).toBe("done");
    expect(preview?.routeDecisions?.[0]?.requirements.cameraMove).toBe("pan-left");expect(preview?.routeDecisions?.[0]?.requirements.durationSec).toBe(4);
    expect(preview!.output!.storyboard![0]!.caption).not.toContain("Shot direction");expect(http.submissions[0]!.model).toBe(REFERENCE_IMAGE_MODEL);expect(http.submissions[0]!.body.prompt).toContain("Focal length in mm: 85");
    expect((await f.call(f.base+"/animatic/decision","POST",{animaticJobId:previewId,decision:"approved"},f.owner.token)).status).toBe(201);
    await f.save({...settings,previewMove:"pan-right",lensMm:35});
    expect((await f.call(f.base+"/animatic/decision","POST",{animaticJobId:previewId,decision:"approved"},f.owner.token)).status).toBe(409);
    expect((await f.call(f.base+"/jobs","POST",{stage:"final",animaticJobId:previewId},f.owner.token)).status).toBe(409);expect(http.submissions).toHaveLength(1);
    const nextId=await admit({}),next=await f.worker();expect(nextId).not.toBe(previewId);expect(next?.status).toBe("done");
    const approval=await f.call(f.base+"/animatic/decision","POST",{animaticJobId:nextId,decision:"approved"},f.owner.token);expect(approval.status).toBe(201);expect((await approval.json() as {directionVersion:number}).directionVersion).toBe(2);
    const finalId=await admit({stage:"final",animaticJobId:nextId}),final=await f.worker();expect(final?.id).toBe(finalId);expect(final?.status).toBe("done");expect(final?.routeDecisions?.[0]?.requirements.cameraMove).toBeNull();
    expect(http.submissions).toHaveLength(3);expect(http.submissions[2]!.model).toBe(REFERENCE_VIDEO_MODEL);expect(http.submissions[2]!.body).toMatchObject({duration:"4",generate_audio:false});expect(http.submissions[2]!.body.prompt).toContain("Camera movement intent: dolly");expect(http.submissions[2]!.body.prompt).toContain("Color temperature in kelvin: 3200");
    for(const job of [preview!,next!,final!]){const manifest=JSON.parse(readFileSync(join(f.paths.artifactRoot,job.output!.manifestPath),"utf8"));expect(manifest.direction).toEqual(job.direction);expect(manifest.shots[0].durationSec).toBe(4);expect(manifest.shots[0].requestedDurationSec).toBe(4);expect(manifest.casting.characters[0].references).toHaveLength(1);}
    expect(preview!.direction).toEqual(first);expect(final!.direction!.version).toBe(2);expect(f.ledger.reservedUsd()).toBe(0);expect(f.ledger.monthSpend()).toBeCloseTo(.384,6);
  }finally{globalThis.fetch=realFetch;for(const [key,value]of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
},30_000);
