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
import type {CoverageReport} from "../../planner/src/coverage";
import {CAMERA_PRESETS} from "../../planner/src/framing";
const SCRIPT="EXT. GARDEN - DAY\n\nSpud waves beside the gate.";
const fixtures:{root:string;server:ReturnType<typeof createApiServer>}[]=[];
afterAll(async()=>{for(const f of fixtures){await f.server.stop(true);rmSync(f.root,{recursive:true,force:true});}});
interface View {direction:DirectionSnapshot;plan:DirectionEntry[];scriptVersion:number;staleShotIds:string[];coverage:CoverageReport;viewfinderSources:{shotId:string;jobId:string;directionVersion:number;url:string}[]}
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
test("saved framing reaches preview and final pixels, keeps private raw sources and refuses native-resolution admission",async()=>{
  const f=await fixture(),config={HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_PROVIDER_POOL:'["mock"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0"},original=Object.fromEntries(Object.keys(config).map(key=>[key,process.env[key]]));
  const framing={x:5000,y:2500,size:5000},settings={...CAMERA_PRESETS[1]!.settings,durationFrames:121,previewMove:"static",framing};
  try{Object.assign(process.env,config);
    expect((await f.view()).viewfinderSources).toEqual([]);expect((await f.save(settings)).status).toBe(200);
    const denied=await f.call(f.base+"/jobs","POST",{renderRequirements:{nativeResolution:true}},f.owner.token);expect(denied.status).toBe(400);expect((await denied.json() as {error:string}).error).toContain("native-resolution");expect(f.store.all()).toHaveLength(0);expect(f.ledger.reservedUsd()).toBe(0);
    await f.save({durationFrames:121,previewMove:"static"});
    const render=async(body:unknown={})=>{const response=await f.call(f.base+"/jobs","POST",body,f.owner.token);expect(response.status).toBe(202);const job=await f.worker();expect(job?.failureReason).toBeUndefined();expect(job?.status).toBe("done");return job!;};
    const first=await render(),firstSource=(await f.view()).viewfinderSources[0]!;expect(firstSource.jobId).toBe(first.id);
    expect(Buffer.from(await(await fetch(new URL(firstSource.url,f.server.url))).arrayBuffer())).toEqual(readFileSync(join(f.paths.artifactRoot,first.output!.storyboard![0]!.path)));
    expect((await f.call(f.base+"/animatic/decision","POST",{animaticJobId:first.id,decision:"approved"},f.owner.token)).status).toBe(201);
    await f.save(settings);expect((await f.view()).viewfinderSources[0]!.jobId).toBe(first.id);
    expect((await f.call(f.base+"/jobs","POST",{stage:"final",animaticJobId:first.id},f.owner.token)).status).toBe(409);
    const preview=await render(),view=await f.view(),source=view.viewfinderSources[0]!,frame=preview.output!.storyboard![0]!;
    expect(source).toMatchObject({shotId:"shot-1-1",jobId:preview.id,directionVersion:3});expect(frame.sourcePath).toBeTruthy();expect(source.url.endsWith(frame.sourcePath!)).toBe(true);
    const raw=await fetch(new URL(source.url,f.server.url));expect(raw.status).toBe(200);expect(raw.headers.get("cache-control")).toBe("private, no-store");
    const rawBytes=Buffer.from(await raw.arrayBuffer());expect(rawBytes).toEqual(readFileSync(join(f.paths.artifactRoot,frame.sourcePath!)));expect(rawBytes).not.toEqual(readFileSync(join(f.paths.artifactRoot,frame.path)));
    expect((await f.call(f.base+"/animatic/decision","POST",{animaticJobId:preview.id,decision:"approved"},f.owner.token)).status).toBe(201);
    const final=await render({stage:"final",animaticJobId:preview.id});
    for(const job of [preview,final]){const manifest=JSON.parse(readFileSync(join(f.paths.artifactRoot,job.output!.manifestPath),"utf8"));expect(manifest.shots[0].appliedFraming).toEqual(framing);expect(manifest.shots[0].durationSec).toBe(121/30);expect(manifest.direction.entries[0].settings.optics).toEqual(settings.optics);}
    expect((await f.view()).viewfinderSources[0]!.jobId).toBe(preview.id);expect(f.ledger.monthSpend()).toBe(0);expect(f.ledger.reservedUsd()).toBe(0);
    await f.call(f.base+"/script","PUT",{text:SCRIPT.replace("gate","bridge")},f.owner.token);expect((await f.view()).viewfinderSources).toEqual([]);
    await f.call(f.base+"/script","PUT",{text:SCRIPT},f.owner.token);expect((await f.view()).viewfinderSources).toHaveLength(1);
    expect((await f.call(f.base+"/cast/"+crypto.randomUUID(),"PUT",{expectedVersion:0,character:CAST_INPUT},f.owner.token)).status).toBe(200);expect((await f.view()).viewfinderSources).toEqual([]);
  }finally{for(const [key,value]of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
},30000);
test("camera paths remain source-bound across film renders, approved revisions and snapshot recovery",async()=>{
  const f=await fixture(),config={HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_PROVIDER_POOL:'["mock"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0"},original=Object.fromEntries(Object.keys(config).map(key=>[key,process.env[key]]));
  const cameraPath:import("../../planner/src/camera-path").ShotCameraPath={mode:"screen-space",keyframes:[{at:0,x:0,y:2500,size:5000,easing:"smooth"},{at:10000,x:5000,y:2500,size:5000,easing:"linear"}]},settings={durationFrames:121,previewMove:"static",cameraPath};
  try{Object.assign(process.env,config);expect((await f.save(settings)).status).toBe(200);
    const refused=await f.call(f.base+"/jobs","POST",{renderRequirements:{nativeResolution:true}},f.owner.token);expect(refused.status).toBe(400);expect(f.store.all()).toHaveLength(0);expect(f.ledger.reservedUsd()).toBe(0);
    const render=async(body:unknown={})=>{const response=await f.call(f.base+"/jobs","POST",body,f.owner.token);expect(response.status).toBe(202);const job=await f.worker();expect(job?.failureReason??job?.cancelReason).toBeUndefined();expect(job?.status).toBe("done");return job!;};
    const preview=await render();expect((await f.call(f.base+"/animatic/decision","POST",{animaticJobId:preview.id,decision:"approved"},f.owner.token)).status).toBe(201);
    const final=await render({stage:"final",animaticJobId:preview.id});
    for(const job of [preview,final]){const applied={mode:"screen-space" as const,keyframes:cameraPath.keyframes,outputFrames:121,applied:"local-crop" as const,reason:"provider-has-no-native-camera" as const};expect(job.output!.cameraPathRenders).toEqual([{shotId:"shot-1-1",...applied}]);
      const manifest=JSON.parse(readFileSync(join(f.paths.artifactRoot,job.output!.manifestPath),"utf8"));expect(manifest.shots[0].cameraPathControl).toEqual(applied);expect(manifest.shots[0].routing.adaptations).toContain("screen-space camera path; digital framing applied locally");expect(manifest.direction.entries[0].settings.cameraPath).toEqual(cameraPath);}
    const source=(await f.view()).viewfinderSources[0]!;expect(source.url.endsWith(preview.output!.storyboard![0]!.sourcePath!)).toBe(true);
    const {validateSnapshot}=await import("../../storage/src/snapshots"),snapshot={schema:"hv-state/11" as const,projects:f.projects.snapshot(),jobs:f.store.all(),ledger:{events:f.ledger.all(),reservations:[]},reviews:[]};expect(validateSnapshot(snapshot)).toEqual(snapshot);
    expect(snapshot.jobs.some(job=>(job.executionCheckpoints??job.dialogueReplacement?.source.executionCheckpoints??[]).length>0)).toBe(true);expect(()=>validateSnapshot({...snapshot,schema:"hv-state/10"})).toThrow("schema 11");
    const broken=structuredClone(snapshot);broken.jobs[0]!.output!.cameraPathRenders![0]!.outputFrames++;expect(()=>validateSnapshot(broken)).toThrow("camera path");
    // HV-020-01: the report says which path was used, and a snapshot cannot claim a native move the path does not make.
    const claimed=structuredClone(snapshot);Object.assign(claimed.jobs[0]!.output!.cameraPathRenders![0]!,{applied:"native",moves:["tilt-up"],reason:undefined});expect(()=>validateSnapshot(claimed)).toThrow("camera path");
    expect((await f.save({...settings,cameraPath:{...cameraPath,keyframes:cameraPath.keyframes.map(p=>({...p,easing:"linear"}))}})).status).toBe(200);
    expect((await f.call(f.base+"/jobs","POST",{stage:"final",animaticJobId:preview.id},f.owner.token)).status).toBe(409);
    await f.call(f.base+"/script","PUT",{text:SCRIPT.replace("gate","bridge")},f.owner.token);expect((await f.call(f.base+"/jobs","POST",{},f.owner.token)).status).toBe(409);expect((await f.view()).viewfinderSources).toEqual([]);
  }finally{for(const [key,value]of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
},30000);

test("coverage findings follow private saved declarations into preview/final provenance and edits invalidate old approval",async()=>{
  const f=await fixture(),script="INT. HALL - DAY\n\nSpud and Molly sit at a table.\n\nSpud opens the letter.\n\nMolly smiles.\n\nSPUD\nHello.\n\nMOLLY\nWelcome.";
  await f.call(f.base+"/script","PUT",{text:script},f.owner.token);await f.call(f.base+"/rights","POST",{attested:true},f.owner.token);
  const set=async(index:number,coverage:unknown)=>{const state=await f.view(),shot=state.plan[index]!;const response=await f.call(f.base+"/direction/"+shot.source.id,"PUT",{settings:{coverage},sourceHash:shot.sourceHash,expectedVersion:state.direction.version,expectedScriptVersion:state.scriptVersion},f.owner.token);expect(response.status).toBe(200);};
  const single=(subject:string,target:string,direction:string)=>({role:"single",subjects:[subject],axis:"table",cameraSide:"a",gazeSubject:subject,gazeTarget:target,gazeDirection:direction});
  expect((await f.view()).coverage.totals.unknowns).toBeGreaterThan(0);
  await set(0,{role:"master",subjects:["SPUD","MOLLY"],axis:"table",cameraSide:"a"});await set(1,single("SPUD","MOLLY","left"));await set(2,single("MOLLY","SPUD","left"));
  const before=await f.view();expect(before.coverage.scenes[0]!.findings.filter(value=>value.code==="eyeline-conflict")).toHaveLength(1);
  const config={HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_PROVIDER_POOL:'["mock"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0"},original=Object.fromEntries(Object.keys(config).map(key=>[key,process.env[key]]));
  try{Object.assign(process.env,config);
    const render=async(body:unknown={})=>{const response=await f.call(f.base+"/jobs","POST",body,f.owner.token);expect(response.status).toBe(202);const job=await f.worker();expect(job?.failureReason).toBeUndefined();expect(job?.status).toBe("done");return job!;};
    const first=await render(),firstManifest=JSON.parse(readFileSync(join(f.paths.artifactRoot,first.output!.manifestPath),"utf8"));expect(firstManifest.coverage).toEqual(before.coverage);
    expect((await f.call(f.base+"/animatic/decision","POST",{animaticJobId:first.id,decision:"approved"},f.owner.token)).status).toBe(201);
    await set(2,single("MOLLY","SPUD","right"));const revised=await f.view();expect(revised.coverage.totals.warnings).toBe(0);expect(revised.coverage.totals.eyelineComparisons).toBe(1);
    expect((await f.call(f.base+"/jobs","POST",{stage:"final",animaticJobId:first.id},f.owner.token)).status).toBe(409);
    const next=await render();expect((await f.call(f.base+"/animatic/decision","POST",{animaticJobId:next.id,decision:"approved"},f.owner.token)).status).toBe(201);
    const final=await render({stage:"final",animaticJobId:next.id}),manifest=JSON.parse(readFileSync(join(f.paths.artifactRoot,final.output!.manifestPath),"utf8"));expect(manifest.coverage).toEqual(revised.coverage);expect(manifest.direction.entries[2].settings.coverage.gazeDirection).toBe("right");
    expect(f.ledger.reservedUsd()).toBe(0);expect(f.ledger.monthSpend()).toBe(0);
    await f.call(f.base+"/script","PUT",{text:script.replace("Molly smiles.","Molly stands.")},f.owner.token);expect((await f.view()).coverage.staleShotIds).toEqual(["shot-1-3"]);expect((await f.call(f.base+"/jobs","POST",{},f.owner.token)).status).toBe(409);
  }finally{for(const [key,value]of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
},30000);
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
  const coveredSettings={...settings,framing:{x:5000,y:2500,size:5000},optics:{sensorWidthMm:36,sensorHeightMm:24,squeeze:1,look:"Restrained contrast"},coverage:{role:"master",subjects:["SPUD"],axis:"garden",cameraSide:"a"}};
  expect((await f.save(coveredSettings)).status).toBe(200);const first=(await f.view()).direction;
  // HV-019-16: the reference vendors first. The mock records references too, so first in configured order it would take these shots.
  const config={HV_ANIMATIC_PROVIDER_POOL:'["image:fal:flux-2-edit","mock"]',HV_PROVIDER_POOL:'["fal:kling-o3-standard-reference","mock"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0",FAL_KEY:"shot-direction-closed-fixture-only"};
  const original=Object.fromEntries(Object.keys(config).map(key=>[key,process.env[key]])),http=referenceFal(png,video,f.server.url.origin),realFetch=globalThis.fetch;
  try{Object.assign(process.env,config);globalThis.fetch=http.fetchImpl;
    const admit=async(body:unknown)=>{const response=await f.call(f.base+"/jobs","POST",body,f.owner.token);const data=await response.json() as {jobId:string;error?:string};if(response.status!==202)throw new Error(data.error);return data.jobId;};
    const previewId=await admit({}),preview=await f.worker();expect(preview?.id).toBe(previewId);expect(preview?.failureReason).toBeUndefined();expect(preview?.status).toBe("done");
    expect(preview?.routeDecisions?.[0]?.requirements.cameraMove).toBe("pan-left");expect(preview?.routeDecisions?.[0]?.requirements.durationSec).toBe(4);
    expect(preview!.output!.storyboard![0]!.caption).not.toContain("Shot direction");expect(http.submissions[0]!.model).toBe(REFERENCE_IMAGE_MODEL);expect(http.submissions[0]!.body.prompt).toContain("Focal length in mm: 85");
    expect((await f.call(f.base+"/animatic/decision","POST",{animaticJobId:previewId,decision:"approved"},f.owner.token)).status).toBe(201);
    expect(http.submissions[0]!.body.prompt).toContain("Coverage role: master");
    await f.save({...coveredSettings,previewMove:"pan-right",lensMm:35});
    expect((await f.call(f.base+"/animatic/decision","POST",{animaticJobId:previewId,decision:"approved"},f.owner.token)).status).toBe(409);
    expect((await f.call(f.base+"/jobs","POST",{stage:"final",animaticJobId:previewId},f.owner.token)).status).toBe(409);expect(http.submissions).toHaveLength(1);
    const nextId=await admit({}),next=await f.worker();expect(nextId).not.toBe(previewId);expect(next?.status).toBe("done");
    const approval=await f.call(f.base+"/animatic/decision","POST",{animaticJobId:nextId,decision:"approved"},f.owner.token);expect(approval.status).toBe(201);expect((await approval.json() as {directionVersion:number}).directionVersion).toBe(2);
    const finalId=await admit({stage:"final",animaticJobId:nextId}),final=await f.worker();expect(final?.id).toBe(finalId);expect(final?.status).toBe("done");expect(final?.routeDecisions?.[0]?.requirements.cameraMove).toBeNull();
    expect(http.submissions).toHaveLength(3);expect(http.submissions[2]!.model).toBe(REFERENCE_VIDEO_MODEL);expect(http.submissions[2]!.body).toMatchObject({duration:"4",generate_audio:false});expect(http.submissions[2]!.body.prompt).toContain("Camera movement intent: dolly");expect(http.submissions[2]!.body.prompt).toContain("Color temperature in kelvin: 3200");expect(http.submissions[2]!.body.prompt).toContain("Coverage role: master");
    for(const job of [preview!,next!,final!]){const manifest=JSON.parse(readFileSync(join(f.paths.artifactRoot,job.output!.manifestPath),"utf8"));expect(manifest.direction).toEqual(job.direction);expect(manifest.shots[0].durationSec).toBe(4);expect(manifest.shots[0].requestedDurationSec).toBe(4);expect(manifest.casting.characters[0].references).toHaveLength(1);}
    for(const job of [preview!,next!,final!]){const manifest=JSON.parse(readFileSync(join(f.paths.artifactRoot,job.output!.manifestPath),"utf8"));expect(manifest.shots[0].appliedFraming).toEqual(coveredSettings.framing);expect(manifest.shots[0].routing.adaptations).toContain("digital-crop");}
    expect(preview!.direction).toEqual(first);expect(final!.direction!.version).toBe(2);expect(f.ledger.reservedUsd()).toBe(0);expect(f.ledger.monthSpend()).toBeCloseTo(.384,6);
    const cameraPath={mode:"screen-space",keyframes:[{at:0,x:0,y:0,size:10000,easing:"smooth"},{at:10000,x:5000,y:2500,size:5000,easing:"linear"}]};
    expect((await f.save({...coveredSettings,previewMove:"static",cameraPath})).status).toBe(200);
    const pathPreviewId=await admit({}),pathPreview=await f.worker();expect(pathPreview?.status).toBe("done");
    expect((await f.call(f.base+"/animatic/decision","POST",{animaticJobId:pathPreviewId,decision:"approved"},f.owner.token)).status).toBe(201);
    await admit({stage:"final",animaticJobId:pathPreviewId});const pathFinal=await f.worker();expect(pathFinal?.failureReason??pathFinal?.cancelReason).toBeUndefined();expect(pathFinal?.status).toBe("done");expect(http.submissions).toHaveLength(5);
    for(const job of [pathPreview!,pathFinal!]){const manifest=JSON.parse(readFileSync(join(f.paths.artifactRoot,job.output!.manifestPath),"utf8"));expect(manifest.shots[0].cameraPathControl).toEqual({mode:"screen-space",keyframes:cameraPath.keyframes,outputFrames:120,applied:"local-crop",reason:"provider-has-no-native-camera"});expect(manifest.shots[0].appliedFraming).toBeUndefined();}
    expect(http.submissions[4]!.body).not.toHaveProperty("cameraPath");expect(http.submissions[4]!.body).not.toHaveProperty("camera_path");expect(http.submissions[4]!.body).not.toHaveProperty("dynamic_masks");expect(http.submissions[4]!.body.image_urls).toHaveLength(1);expect(f.ledger.reservedUsd()).toBe(0);expect(f.ledger.monthSpend()).toBeCloseTo(.744,6);
  }finally{globalThis.fetch=realFetch;for(const [key,value]of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
},30_000);

/**
 * HV-030-06: the shot editor has always offered 1 to 30 s, because a shot direction is
 * provider-agnostic and outlives the pool that renders it. Kling's turbo model renders at most 10,
 * so a duration between the two saved cleanly and was refused at admission by a message that named
 * no number and no shot. The editor is told the pool's own limit, and admission says what it is.
 */
test("the shot editor is told the longest shot the configured providers can render, and admission names it",async()=>{
  const f=await fixture(),config={HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_PROVIDER_POOL:'["mock"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0",FAL_KEY:"shot-duration-limit-fixture-key"};
  const original=Object.fromEntries(Object.keys(config).map(key=>[key,process.env[key]]));
  try{
    Object.assign(process.env,config);
    // A free pool renders the whole contract range, so the editor keeps its own limit.
    expect((await f.view() as unknown as {durationLimitSec:number}).durationLimitSec).toBe(30);
    // Kling's turbo model bills 5 or 10 s and renders no more than 10.
    process.env.HV_PROVIDER_POOL='["fal:kling-v2.5-turbo-pro"]';
    expect((await f.view() as unknown as {durationLimitSec:number}).durationLimitSec).toBe(10);
    // The keyframe model renders up to 15, and the editor follows the pool rather than a constant.
    process.env.HV_PROVIDER_POOL='["fal:kling-o3-standard-reference"]';
    expect((await f.view() as unknown as {durationLimitSec:number}).durationLimitSec).toBe(15);
    // The contract still bounds a save; 30 s is legal direction whatever renders it.
    process.env.HV_PROVIDER_POOL='["fal:kling-v2.5-turbo-pro"]';
    expect((await f.save({durationFrames:900,previewMove:"static"})).status).toBe(200);
    expect((await f.save({durationFrames:901,previewMove:"static"})).status).toBe(400);
    expect((await f.save({durationFrames:29,previewMove:"static"})).status).toBe(400);
    // Admission is where the pool's limit bites, and it now names the shot and the number. A take
    // quote reaches that check without rendering or spending anything.
    const state=await f.view() as unknown as {defaults:Record<string,unknown>;plan:{source:{id:string}}[];sourceHash?:string};
    const quote=await f.call(f.base+"/takes/quote","POST",{stage:"take-final",expectedScriptVersion:1,expectedCastingVersion:0,
      expectedDirectionVersion:(await f.view()).direction.version,
      settings:{shotId:state.plan[0]!.source.id,sourceHash:(await f.view()).plan[0]!.sourceHash,
        takes:[{label:"Long",seed:7000,settings:{...state.defaults,durationFrames:900,previewMove:"static"}},
          {label:"Longer",seed:7001,settings:{...state.defaults,durationFrames:900,previewMove:"static"}}]}},f.owner.token);
    expect(quote.status).toBe(400);
    const {error}=await quote.json() as {error:string};
    expect(error).toMatch(/^No configured provider can render shot \S+ at 30\.0 s; the longest they render is 10 s\./);
    expect(error).toContain("split it into coverage");
    expect(f.store.all()).toHaveLength(0);
    expect(f.ledger.reservedUsd()).toBe(0);
  }finally{for(const [key,value]of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
},30_000);
