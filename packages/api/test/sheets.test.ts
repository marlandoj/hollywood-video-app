import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/server";
import { ProjectService } from "../src/index";
import { DurableJobStore } from "../../queue/src/index";
import { processNextJob } from "../../queue/src/worker";
import { CostLedger, OperatorReviewQueue } from "../../operator/src/index";
import { ReferenceBlobStore } from "../../storage/src/references";
import { DeterministicMockImageProvider } from "../../generator/src/image";
import { fileSha256 } from "../../generator/src/sheet";
import { CAST_INPUT, CAST_SCRIPT } from "../../../test/fixtures/casting";
import { referenceFal, REFERENCE_IMAGE_MODEL } from "../../../test/fixtures/reference-fal";
import type { CastingSnapshot } from "../../planner/src/casting";
import type { ReferenceAsset } from "../../planner/src/references";
import { readStateSnapshot, validateSnapshot, writeStateSnapshot } from "../../storage/src/snapshots";
const fixtures:{root:string;server:ReturnType<typeof createApiServer>}[]=[];
afterAll(async()=>{for(const fixture of fixtures){await fixture.server.stop(true);rmSync(fixture.root,{recursive:true,force:true});}});
async function fixture() {
  process.env.HV_TOKEN_SECRET="sheet-api-fixture-secret-at-least-thirty-two-characters";
  const root=mkdtempSync(join(tmpdir(),"hv-sheet-api-")),paths={queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json")};
  const server=createApiServer({port:0,hostname:"127.0.0.1",...paths,rateLimit:{api:{limit:10000,windowMs:60000}}});fixtures.push({root,server});
  const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const owner=await (await call("/api/projects","POST")).json() as {projectId:string;token:string},base="/api/projects/"+owner.projectId,id=crypto.randomUUID();
  await call(base+"/script","PUT",{text:CAST_SCRIPT},owner.token);await call(base+"/rights","POST",{attested:true},owner.token);
  await call(base+"/cast/"+id,"PUT",{expectedVersion:0,character:CAST_INPUT},owner.token);
  const sheets=base+"/cast/"+id+"/sheets",store=new DurableJobStore(paths.queuePath),projects=new ProjectService(paths.statePath),ledger=new CostLedger(paths.costLedgerPath),references=new ReferenceBlobStore(paths.artifactRoot);
  const request={generationApproved:true,expectedVersion:1,settings:{kind:"turnaround",seed:123,sceneNumber:null}};
  const worker=()=>processNextJob(store,paths.artifactRoot,{ledger,projects,references,reviewQueue:new OperatorReviewQueue(join(root,"reviews.json"))});
  return {root,paths,server,call,owner,base,id,sheets,store,projects,ledger,references,request,worker};
}
test("sheets require explicit current-cast approval and cannot bypass owner or film routes",async()=>{
  const f=await fixture(),other=await fixture();
  const reviewer=await(await f.call(f.base+"/reviews","POST",{permission:"approve"},f.owner.token)).json() as {token:string};
  for(const token of [undefined,other.owner.token,reviewer.token]) {
    expect((await f.call(f.sheets,"GET",undefined,token)).status).toBe(401);
    expect((await f.call(f.sheets,"POST",f.request,token)).status).toBe(401);
  }
  expect((await f.call(f.sheets,"POST",{...f.request,generationApproved:false},f.owner.token)).status).toBe(409);
  expect((await f.call(f.sheets,"POST",{...f.request,expectedVersion:0},f.owner.token)).status).toBe(409);
  expect((await f.call(f.base+"/jobs","POST",{stage:"character-sheet"},f.owner.token)).status).toBe(400);
  expect((await f.call(f.sheets,"POST",f.request,f.owner.token)).status).toBe(202);
  expect((await f.call(f.sheets,"POST",f.request,f.owner.token)).status).toBe(202);expect(f.store.all()).toHaveLength(1);
  const job=f.store.all()[0]!;
  expect((await f.call(f.base+"/animatic/decision","POST",{animaticJobId:job.id,decision:"approved"},f.owner.token)).status).toBe(404);
  expect((await f.call(f.base+"/jobs","POST",{stage:"final",animaticJobId:job.id},f.owner.token)).status).toBe(404);
});

test("real sheet pipeline pins references, seed and provenance; verified batch replacement is one recoverable cast revision",async()=>{
  const f=await fixture();
  const source=readFileSync((await new DeterministicMockImageProvider().generateFrame("A fictional potato",7,{widthxheight:"512x512"},join(f.root,"source.png"))).path);
  const http=referenceFal(source,Buffer.alloc(0),f.server.url.origin),realFetch=globalThis.fetch;
  const configuration={HV_CHARACTER_SHEET_PROVIDER_POOL:'["image:fal:flux-2-edit"]',FAL_KEY:"sheet-contract-fixture-only",HV_NARRATION:"1",HV_ANIMATIC_CAPTIONS:"1"};
  const original=Object.fromEntries(Object.keys(configuration).map(key=>[key,process.env[key]]));
  try {
    Object.assign(process.env,configuration);globalThis.fetch=http.fetchImpl;
    const upload=await fetch(new URL(f.base+"/cast/"+f.id+"/references",f.server.url),{method:"POST",headers:{authorization:"Bearer "+f.owner.token,"content-type":"image/png","x-hv-cast-version":"1","x-hv-reference-attested":"true"},body:new Uint8Array(source)});
    expect(upload.status).toBe(201);const saved=await upload.json() as {asset:ReferenceAsset;casting:CastingSnapshot};
    const admitted=await f.call(f.sheets,"POST",{...f.request,expectedVersion:2},f.owner.token);expect(admitted.status).toBe(202);
    const job=await f.worker();expect(job?.failureReason).toBeUndefined();expect(job?.status).toBe("done");expect(job?.checkpointShots).toBe(4);
    expect(http.submissions).toHaveLength(4);
    const pinned="data:image/png;base64,"+(await f.references.read(saved.asset)).toString("base64");
    for(const submission of http.submissions) {expect(submission.model).toBe(REFERENCE_IMAGE_MODEL);expect(submission.body).toMatchObject({seed:123,image_urls:[pinned],image_size:{width:512,height:512},enable_safety_checker:true});}
    expect(new Set(http.submissions.map(value=>value.body.prompt)).size).toBe(4);
    expect(job!.costUsd).toBeCloseTo(.096,6);expect(f.ledger.reservedUsd()).toBe(0);
    const sheetPath=join(f.paths.artifactRoot,job!.output!.sheetPath!),sheet=readFileSync(sheetPath);
    expect([sheet.readUInt32BE(16),sheet.readUInt32BE(20)]).toEqual([1024,1120]);
    const manifest=JSON.parse(readFileSync(join(f.paths.artifactRoot,job!.output!.manifestPath),"utf8"));
    expect(manifest.characterSheet.sheetSha256).toBe(fileSha256(sheetPath));expect(manifest.characterSheet.views).toHaveLength(4);
    for(const frame of job!.output!.storyboard!)expect(frame.sha256).toBe(fileSha256(join(f.paths.artifactRoot,frame.path)));
    const review=await(await f.call(f.base+"/reviews","POST",{permission:"approve"},f.owner.token)).json() as {token:string};
    expect((await f.call("/api/reviews/"+review.token)).status).toBe(404);
    const route=f.sheets+"/"+job!.id+"/adopt",body={attested:true,expectedVersion:2,viewIds:["sheet-1","sheet-2","sheet-3","sheet-4"]};
    expect((await f.call(route,"POST",body,review.token)).status).toBe(401);
    expect((await f.call(route,"POST",{...body,attested:false},f.owner.token)).status).toBe(400);
    expect((await f.call(route,"POST",{...body,viewIds:["sheet-1","sheet-1"]},f.owner.token)).status).toBe(400);
    expect((await f.call(route,"POST",body,f.owner.token)).status).toBe(400);
    // A late corrupt view must not attach earlier decoded views or increment the cast.
    const corruptPath=join(f.paths.artifactRoot,job!.output!.storyboard![3]!.path),originalBytes=readFileSync(corruptPath);writeFileSync(corruptPath,"corrupt");
    const corrupt=await f.call(route,"POST",{...body,replaceExisting:true},f.owner.token);expect(corrupt.status).toBe(400);
    expect((await corrupt.json() as {error:string}).error).toContain("checksum changed");
    expect(f.projects.authorize(f.owner.token)!.castingHistory).toHaveLength(2);expect(f.projects.authorize(f.owner.token)!.referenceAssets).toHaveLength(1);writeFileSync(corruptPath,originalBytes);
    const adopted=await f.call(route,"POST",{...body,replaceExisting:true},f.owner.token),current=await adopted.json() as {casting:CastingSnapshot;error?:string};
    expect(current.error).toBeUndefined();expect(adopted.status).toBe(200);expect(current.casting.version).toBe(3);expect(current.casting.characters[0]!.references).toHaveLength(4);
    for(const [index,asset]of current.casting.characters[0]!.references!.entries())expect(asset.source).toEqual({kind:"character-sheet",jobId:job!.id,viewId:"sheet-"+(index+1),castingRevision:saved.casting.revision});
    const project=f.projects.authorize(f.owner.token)!;expect(project.referenceAssets).toHaveLength(5);expect(project.castingHistory[1]!.characters[0]!.references).toEqual([saved.asset]);
    expect((await f.call(route,"POST",{...body,expectedVersion:3,replaceExisting:true},f.owner.token)).status).toBe(409);
    const snapshot={schema:"hv-state/1" as const,projects:f.projects.snapshot(),jobs:f.store.all(),ledger:{events:f.ledger.all(),reservations:[]},reviews:[]};
    expect(validateSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(snapshot);
    const missing=structuredClone(snapshot);delete missing.jobs[0]!.output!.sheetPath;expect(()=>validateSnapshot(missing)).toThrow("verified views");
    // The durable snapshot writer requires directory fsync, available on the Linux deployment/CI.
    if(process.platform!=="win32") {writeStateSnapshot(join(f.root,"snapshot"),snapshot);expect(readStateSnapshot(join(f.root,"snapshot"))).toEqual(snapshot);}
    const restored=f.projects.restoreCasting(f.owner.token,2,3)!;expect(restored.characters[0]!.references).toEqual([saved.asset]);expect(restored.characters[0]!.permission.status).toBe("pending");
  } finally {
    globalThis.fetch=realFetch;for(const [key,value]of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
  }
},45_000);

test("revoking project-wide sheet permission between views stops the worker with its first checkpoint intact",async()=>{
  const f=await fixture();expect((await f.call(f.sheets,"POST",f.request,f.owner.token)).status).toBe(202);let reads=0;
  const job=await processNextJob(f.store,f.paths.artifactRoot,{ledger:f.ledger,references:f.references,reviewQueue:new OperatorReviewQueue(join(f.root,"reviews.json")),projects:{peekProject(projectId){
    if(++reads===2)f.projects.saveCharacter(f.owner.token,f.id,{...CAST_INPUT,permission:{...CAST_INPUT.permission,scope:"scenes",sceneNumbers:[1]}},1);
    return f.projects.peekProject(projectId);
  }}});
  expect(reads).toBe(2);expect(job?.status).toBe("failed");expect(job?.failureKind).toBe("policy_refusal");expect(job?.checkpointShots).toBe(1);expect(job?.output).toBeUndefined();
  expect(job?.costUsd).toBe(0);expect(f.ledger.reservedUsd()).toBe(0);
},30_000);

test("a single-view wardrobe sheet cannot be adopted after a screenplay edit",async()=>{
  const f=await fixture();expect((await f.call(f.sheets,"POST",{...f.request,settings:{...f.request.settings,kind:"wardrobe"}},f.owner.token)).status).toBe(202);
  const job=await f.worker();expect(job?.failureReason).toBeUndefined();expect(job?.status).toBe("done");
  const png=readFileSync(join(f.paths.artifactRoot,job!.output!.sheetPath!));expect([png.readUInt32BE(16),png.readUInt32BE(20)]).toEqual([512,560]);
  await f.call(f.base+"/script","PUT",{text:CAST_SCRIPT+"\n\nThe sun rises."},f.owner.token);
  const response=await f.call(f.sheets+"/"+job!.id+"/adopt","POST",{expectedVersion:1,attested:true,viewIds:["sheet-1"]},f.owner.token);
  expect(response.status).toBe(409);expect((await response.json() as {error:string}).error).toContain("screenplay changed");expect(f.projects.authorize(f.owner.token)!.referenceAssets).toHaveLength(0);
},30_000);
