import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/server";
import { DeterministicMockImageProvider } from "../../generator/src/image";
import { CAST_INPUT, CAST_SCRIPT } from "../../../test/fixtures/casting";
import type { CastingSnapshot } from "../../planner/src/casting";
import type { ReferenceAsset } from "../../planner/src/references";
import { ProjectService } from "../src/index";
import { DurableJobStore } from "../../queue/src/index";
import { processNextJob } from "../../queue/src/worker";
import { CostLedger, OperatorReviewQueue } from "../../operator/src/index";
import { ReferenceBlobStore } from "../../storage/src/references";
import { DeterministicMockProvider } from "../../generator/src/index";
import { referenceFal, REFERENCE_IMAGE_MODEL, REFERENCE_VIDEO_MODEL } from "../../../test/fixtures/reference-fal";
const root = mkdtempSync(join(tmpdir(),"hv-reference-api-"));
let server: ReturnType<typeof createApiServer>, png: Buffer;
beforeAll(async () => {
  process.env.HV_TOKEN_SECRET = "reference-api-fixture-secret-with-thirty-two-characters";
  png = readFileSync((await new DeterministicMockImageProvider().generateFrame("A fictional potato",7,{},join(root,"fixture.png"))).path);
  server = createApiServer({port:0,hostname:"127.0.0.1",queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),
    artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json"),rateLimit:{api:{limit:1000,windowMs:60000}}});
});
afterAll(async () => {await server?.stop(true);rmSync(root,{recursive:true,force:true});});
const call = async (path: string, method="GET", body?:unknown, token?:string) => fetch(new URL(path,server.url),{method,
  headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
async function fixture() {
  const owner = await (await call("/api/projects","POST")).json() as {projectId:string;token:string};
  const base = "/api/projects/"+owner.projectId, id = crypto.randomUUID();
  await call(base+"/script","PUT",{text:CAST_SCRIPT},owner.token);
  await call(base+"/rights","POST",{attested:true},owner.token);
  await call(base+"/cast/"+id,"PUT",{expectedVersion:0,character:CAST_INPUT},owner.token);
  const upload = (token=owner.token,version=1,attested=true) => fetch(new URL(base+"/cast/"+id+"/references",server.url),{method:"POST",
    headers:{authorization:"Bearer "+token,"content-type":"image/png","x-hv-cast-version":String(version),"x-hv-reference-attested":String(attested)},body:new Uint8Array(png)});
  return {owner,base,id,upload};
}
test("private reference routes require owner access, attestation and the current cast revision",async () => {
  const f=await fixture(), other=await fixture();
  expect((await f.upload(other.owner.token)).status).toBe(401);
  const review=await (await call(f.base+"/reviews","POST",{permission:"approve"},f.owner.token)).json() as {token:string};
  expect((await f.upload(review.token)).status).toBe(401);
  expect((await f.upload(f.owner.token,1,false)).status).toBe(400);
  const response=await f.upload();expect(response.status).toBe(201);
  const saved=await response.json() as {casting:CastingSnapshot;asset:ReferenceAsset};
  expect(saved.casting.version).toBe(2);expect(saved.casting.characters[0]!.references).toEqual([saved.asset]);
  expect((await f.upload()).status).toBe(409);
  const path=f.base+"/references/"+saved.asset.id;
  expect((await call(path,"GET",undefined,other.owner.token)).status).toBe(401);
  expect((await call(path,"GET",undefined,review.token)).status).toBe(401);
  const image=await call(path,"GET",undefined,f.owner.token);
  expect(image.headers.get("cache-control")).toBe("private, no-store");expect(image.headers.get("content-type")).toBe("image/png");
  expect((await image.arrayBuffer()).byteLength).toBe(saved.asset.bytes);
});
test("reference-conditioned scenes cannot silently fall back to text-only providers",async () => {
  const f=await fixture(), saved=await (await f.upload()).json() as {asset:ReferenceAsset};
  const denied=await call(f.base+"/jobs","POST",{},f.owner.token);
  expect(denied.status).toBe(400);expect((await denied.json() as {error:string}).error).toContain("references");
  const detached=await call(f.base+"/cast/"+f.id+"/references/"+saved.asset.id+"/remove","POST",{expectedVersion:2},f.owner.token);
  expect(detached.status).toBe(200);
  const admitted=await call(f.base+"/jobs","POST",{},f.owner.token);
  expect(admitted.status).toBe(202);
});

test("private reference bytes and cast hashes survive real preview, approval and final pipelines with closed vendor HTTP fixtures",async () => {
  const paths={queuePath:join(root,"flow-jobs.json"),statePath:join(root,"flow-projects.json"),artifactRoot:join(root,"flow-artifacts"),costLedgerPath:join(root,"flow-ledger.json")};
  const flow=createApiServer({port:0,hostname:"127.0.0.1",...paths});
  const source=readFileSync((await new DeterministicMockImageProvider().generateFrame("A fictional potato",7,{widthxheight:"640x512"},join(root,"flow.png"))).path);
  const video=readFileSync((await new DeterministicMockProvider().generate("A fictional potato",7,{seed:7,durationSec:3,widthxheight:"1280x720"},join(root,"flow.mp4"))).path);
  const http=referenceFal(source,video,flow.url.origin), realFetch=globalThis.fetch;
  const configuration={HV_ANIMATIC_PROVIDER_POOL:'["mock","image:fal:flux-2-edit"]',HV_PROVIDER_POOL:'["mock","fal:kling-o3-standard-reference"]',
    HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0",FAL_KEY:"reference-contract-fixture-only"};
  const original=Object.fromEntries(Object.keys(configuration).map(key=>[key,process.env[key]]));
  const callFlow=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,flow.url),{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  try {
    Object.assign(process.env,configuration);globalThis.fetch=http.fetchImpl;
    const owner=await (await callFlow("/api/projects","POST")).json() as {projectId:string;token:string};
    const base="/api/projects/"+owner.projectId, characterId=crypto.randomUUID();
    await callFlow(base+"/script","PUT",{text:"EXT. GARDEN - DAY\n\nSpud waves beside the gate."},owner.token);
    await callFlow(base+"/rights","POST",{attested:true},owner.token);
    await callFlow(base+"/cast/"+characterId,"PUT",{expectedVersion:0,character:CAST_INPUT},owner.token);
    const upload=await fetch(new URL(base+"/cast/"+characterId+"/references",flow.url),{method:"POST",headers:{authorization:"Bearer "+owner.token,"content-type":"image/png","x-hv-cast-version":"1","x-hv-reference-attested":"true"},body:new Uint8Array(png)});
    expect(upload.status).toBe(201);const saved=await upload.json() as {asset:ReferenceAsset;casting:CastingSnapshot};
    const references=new ReferenceBlobStore(paths.artifactRoot), store=new DurableJobStore(paths.queuePath), ledger=new CostLedger(paths.costLedgerPath);
    const pinned="data:image/png;base64,"+(await references.read(saved.asset)).toString("base64");
    const worker=()=>processNextJob(store,paths.artifactRoot,{ledger,references,projects:new ProjectService(paths.statePath),reviewQueue:new OperatorReviewQueue(join(root,"flow-reviews.json"))});
    const admit=async(body:unknown)=>{const response=await callFlow(base+"/jobs","POST",body,owner.token);const data=await response.json() as {jobId:string;error?:string};if(response.status!==202)throw new Error(data.error);return data;};
    const admitted=await admit({idempotencyKey:"reference-preview"}), preview=await worker();
    expect(preview?.id).toBe(admitted.jobId);expect(preview?.failureReason).toBeUndefined();expect(preview?.status).toBe("done");
    expect(http.submissions).toHaveLength(1);expect(http.submissions[0]!.model).toBe(REFERENCE_IMAGE_MODEL);
    expect(http.submissions[0]!.body).toMatchObject({image_urls:[pinned],image_size:{width:640,height:512},enable_safety_checker:true,enable_prompt_expansion:false,num_inference_steps:28,output_format:"png"});
    expect(preview!.costUsd).toBeCloseTo(.024,6);expect(preview?.output?.storyboard?.[0]?.caption).not.toContain("Cast direction");
    expect((await callFlow(base+"/animatic/decision","POST",{animaticJobId:admitted.jobId,decision:"approved"},owner.token)).status).toBe(201);
    const finalAdmitted=await admit({stage:"final",animaticJobId:admitted.jobId}), final=await worker();
    expect(final?.id).toBe(finalAdmitted.jobId);expect(final?.failureReason).toBeUndefined();expect(final?.status).toBe("done");
    expect(http.submissions).toHaveLength(2);expect(http.submissions[1]!.model).toBe(REFERENCE_VIDEO_MODEL);
    expect(http.submissions[1]!.body).toMatchObject({image_urls:[pinned],duration:"3",aspect_ratio:"16:9",generate_audio:false});
    expect(http.submissions[1]!.body.prompt).toContain("@Image1");expect(http.submissions[1]!.body).not.toHaveProperty("seed");
    expect(final!.costUsd).toBeCloseTo(.252,6);expect(ledger.reservedUsd()).toBe(0);
    for (const job of [preview!,final!]) {
      const manifest=JSON.parse(readFileSync(join(paths.artifactRoot,job.output!.manifestPath),"utf8"));
      expect(manifest.casting).toEqual(saved.casting);
      expect(manifest.casting.characters[0].references[0].sha256).toBe(saved.asset.sha256);
      expect(JSON.stringify(job.routeDecisions)).not.toContain("data:image");
    }
  } finally {
    globalThis.fetch=realFetch;
    for (const [key,value] of Object.entries(original)) {if(value===undefined)delete process.env[key];else process.env[key]=value;}
    await flow.stop(true);
  }
},30_000);
