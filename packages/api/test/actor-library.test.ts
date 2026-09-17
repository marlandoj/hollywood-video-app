import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/server";
import { ProjectService } from "../src/index";
import { CAST_INPUT, CAST_SCRIPT } from "../../../test/fixtures/casting";
import { DeterministicMockImageProvider } from "../../generator/src/image";
import { ReferenceBlobStore } from "../../storage/src/references";
import type { CastingSnapshot } from "../../planner/src/casting";
import type { ActorShare } from "../../planner/src/actor-library";
import type { ReferenceAsset } from "../../planner/src/references";
import {DurableJobStore} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {referenceFal,REFERENCE_IMAGE_MODEL} from "../../../test/fixtures/reference-fal";
const fixtures:{root:string;server:ReturnType<typeof createApiServer>}[]=[];
afterAll(async()=>{for(const value of fixtures){await value.server.stop(true);rmSync(value.root,{recursive:true,force:true});}});
async function fixture() {
  process.env.HV_TOKEN_SECRET="actor-library-api-secret-at-least-thirty-two-characters";
  const root=mkdtempSync(join(tmpdir(),"hv-actor-library-")),paths={queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json")};
  const server=createApiServer({port:0,hostname:"127.0.0.1",...paths,rateLimit:{api:{limit:10000,windowMs:60000}}});fixtures.push({root,server});
  const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const source=await(await call("/api/projects","POST")).json() as {projectId:string;token:string},target=await(await call("/api/projects","POST")).json() as {projectId:string;token:string};
  const base="/api/projects/"+source.projectId,dest="/api/projects/"+target.projectId,id=crypto.randomUUID();
  await call(base+"/script","PUT",{text:CAST_SCRIPT},source.token);await call(dest+"/script","PUT",{text:"EXT. PARK - DAY\n\nSpud waves."},target.token);
  await call(base+"/cast/"+id,"PUT",{expectedVersion:0,character:{...CAST_INPUT,wardrobe:[...CAST_INPUT.wardrobe,{sceneNumber:2,description:"A blue jacket"}]}},source.token);
  const png=readFileSync((await new DeterministicMockImageProvider().generateFrame("A fictional potato",7,{},join(root,"fixture.png"))).path);
  const uploaded=await fetch(new URL(base+"/cast/"+id+"/references",server.url),{method:"POST",headers:{authorization:"Bearer "+source.token,"content-type":"image/png","x-hv-cast-version":"1","x-hv-reference-attested":"true"},body:new Uint8Array(png)});
  expect(uploaded.status).toBe(201);const {asset}=await uploaded.json() as {asset:ReferenceAsset};
  const sharing=base+"/cast/"+id+"/shares",response=await call(sharing,"POST",{expectedVersion:2,attested:true},source.token);expect(response.status).toBe(201);
  const shared=await response.json() as {share:ActorShare;token:string},body={shareToken:shared.token,expectedVersion:0,name:"SPUD",aliases:[],attested:true};
  return {root,paths,server,call,source,target,base,dest,id,asset,sharing,shared,body,projects:new ProjectService(paths.statePath)};
}
test("actor shares grant one revision and its own images, never owner, review or another actor access",async()=>{
  const f=await fixture(),review=await(await f.call(f.base+"/reviews","POST",{permission:"approve"},f.source.token)).json() as {token:string};
  for(const token of [undefined,f.source.token,f.target.token,review.token])expect((await f.call("/api/cast-library/actor","GET",undefined,token)).status).toBe(404);
  const preview=await f.call("/api/cast-library/actor","GET",undefined,f.shared.token);expect(preview.status).toBe(200);expect(preview.headers.get("cache-control")).toBe("private, no-store");
  expect(await preview.json()).toEqual({share:f.shared.share});expect((await f.call(f.base+"/cast","GET",undefined,f.shared.token)).status).toBe(401);
  expect((await f.call(f.base+"/references/"+f.asset.id,"GET",undefined,f.shared.token)).status).toBe(401);
  const image=await f.call("/api/cast-library/actor/references/"+f.asset.id,"GET",undefined,f.shared.token);expect(image.status).toBe(200);expect((await image.arrayBuffer()).byteLength).toBe(f.asset.bytes);
  expect((await f.call("/api/cast-library/actor/references/"+crypto.randomUUID(),"GET",undefined,f.shared.token)).status).toBe(404);
  expect((await f.call(f.sharing,"POST",{expectedVersion:2,attested:false},f.source.token)).status).toBe(400);
  expect((await f.call(f.sharing,"POST",{expectedVersion:2,attested:true},f.target.token)).status).toBe(401);
  expect((await f.call(f.dest+"/cast/import","POST",f.body,review.token)).status).toBe(401);
});
test("imports copy immutable reference bytes, require new permission and retain scene costumes without reassignment",async()=>{
  const f=await fixture();expect((await f.call(f.dest+"/cast/import","POST",{...f.body,attested:false},f.target.token)).status).toBe(400);
  const result=await f.call(f.dest+"/cast/import","POST",f.body,f.target.token);expect(result.status).toBe(200);const cast=(await result.json() as {casting:CastingSnapshot}).casting;
  expect(cast.version).toBe(1);const actor=cast.characters[0]!,asset=actor.references![0]!;expect(actor.permission.status).toBe("pending");expect(actor.sceneBindings).toEqual([]);
  expect(actor.wardrobe).toEqual(CAST_INPUT.wardrobe);expect(actor.costumePresets).toHaveLength(1);expect(asset.id).not.toBe(f.asset.id);expect(asset.projectId).toBe(f.target.projectId);expect(asset.sha256).toBe(f.asset.sha256);
  expect(asset.source).toMatchObject({kind:"actor-share",projectId:f.source.projectId,assetId:f.asset.id,revision:f.shared.share.revision});
  expect((await f.call(f.dest+"/cast/import","POST",f.body,f.target.token)).status).toBe(409);
  await f.call(f.dest+"/rights","POST",{attested:true},f.target.token);const denied=await f.call(f.dest+"/jobs","POST",{},f.target.token);expect(denied.status).toBe(400);expect((await denied.json() as {error:string}).error).toContain("not permitted");
  const mapped=await f.call(f.dest+"/cast/"+actor.id+"/costume-presets","POST",{expectedVersion:1,expectedScriptVersion:1,index:0,sceneNumber:1,action:"apply"},f.target.token);expect(mapped.status).toBe(200);
  const updated=(await mapped.json() as {casting:CastingSnapshot}).casting;expect(updated.characters[0]!.sceneBindings).toEqual([{sceneNumber:1,heading:"EXT. PARK - DAY"}]);
  await f.call(f.sharing+"/"+f.shared.share.id+"/revoke","POST",{},f.source.token);expect((await f.call("/api/cast-library/actor","GET",undefined,f.shared.token)).status).toBe(404);
  const copy=await f.call(f.dest+"/references/"+asset.id,"GET",undefined,f.target.token);expect(copy.status).toBe(200);expect((await copy.arrayBuffer()).byteLength).toBe(asset.bytes);
  expect(f.projects.authorize(f.target.token)!.referenceAssets).toHaveLength(1);expect(f.projects.authorize(f.source.token)!.referenceAssets).toEqual([f.asset]);
});
test("revoking a share while its images copy prevents the final cast commit",async()=>{
  const f=await fixture(),put=ReferenceBlobStore.prototype.put;
  ReferenceBlobStore.prototype.put=async function(asset,data) {await put.call(this,asset,data);if(asset.projectId===f.target.projectId)f.projects.revokeActorShare(f.source.token,f.id,f.shared.share.id);};
  try {
    const result=await f.call(f.dest+"/cast/import","POST",f.body,f.target.token);expect(result.status).toBe(404);
    expect(f.projects.authorize(f.target.token)!.castingHistory).toHaveLength(0);expect(f.projects.authorize(f.target.token)!.referenceAssets).toHaveLength(0);
  } finally {ReferenceBlobStore.prototype.put=put;}
});

test("an imported actor renders from its own bytes after source deletion with fresh destination permission",async()=>{
  const f=await fixture(),response=await f.call(f.dest+"/cast/import","POST",f.body,f.target.token);
  const imported=(await response.json() as {casting:CastingSnapshot}).casting,actor=imported.characters[0]!,asset=actor.references![0]!;
  const references=new ReferenceBlobStore(f.paths.artifactRoot),bytes=await references.read(asset);
  const http=referenceFal(bytes,Buffer.alloc(0),f.server.url.origin),realFetch=globalThis.fetch;
  const configuration={HV_ANIMATIC_PROVIDER_POOL:'["mock","image:fal:flux-2-edit"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0",FAL_KEY:"actor-copy-closed-fixture-only"};
  const previous=Object.fromEntries(Object.keys(configuration).map(key=>[key,process.env[key]]));
  try{
    Object.assign(process.env,configuration);globalThis.fetch=http.fetchImpl;
    await f.call(f.dest+"/rights","POST",{attested:true},f.target.token);
    expect((await f.call(f.dest+"/jobs","POST",{},f.target.token)).status).toBe(400);expect(http.submissions).toHaveLength(0);
    const saved=await f.call(f.dest+"/cast/"+actor.id,"PUT",{expectedVersion:1,character:CAST_INPUT},f.target.token);expect(saved.status).toBe(200);
    const casting=(await saved.json() as {casting:CastingSnapshot}).casting;
    expect(casting.characters[0]!.libraryOrigin).toEqual(actor.libraryOrigin);expect(casting.characters[0]!.references).toEqual([asset]);
    await f.projects.takedown(f.source.projectId,"Closed fixture source deletion",new DurableJobStore(null));
    expect((await f.call("/api/cast-library/actor","GET",undefined,f.shared.token)).status).toBe(404);
    const admitted=await f.call(f.dest+"/jobs","POST",{idempotencyKey:"imported-preview"},f.target.token);expect(admitted.status).toBe(202);
    const ledger=new CostLedger(f.paths.costLedgerPath),job=await processNextJob(new DurableJobStore(f.paths.queuePath),f.paths.artifactRoot,{ledger,references,projects:f.projects,reviewQueue:new OperatorReviewQueue(join(f.root,"reviews.json"))});
    expect(job?.failureReason).toBeUndefined();expect(job?.status).toBe("done");
    expect(http.submissions).toHaveLength(1);expect(http.submissions[0]!.model).toBe(REFERENCE_IMAGE_MODEL);
    expect(http.submissions[0]!.body.image_urls).toEqual(["data:image/png;base64,"+bytes.toString("base64")]);
    const manifest=JSON.parse(readFileSync(join(f.paths.artifactRoot,job!.output!.manifestPath),"utf8"));expect(manifest.casting).toEqual(casting);
    expect(ledger.reservedUsd()).toBe(0);expect(job!.costUsd).toBeCloseTo(.024,6);
  }finally{globalThis.fetch=realFetch;for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
},30_000);
