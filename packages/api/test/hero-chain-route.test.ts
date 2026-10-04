import {afterAll,expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {mkdtempSync,readFileSync,rmSync,statSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../src/server";
import {ProjectService} from "../src/index";
import {DurableJobStore,type Job} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {validateDeliveryOutput} from "../../planner/src/delivery-jobs";
import type {HeroDeliveryOutput} from "../../planner/src/hero-chain";

/**
 * HV-019-15: a creator makes a hero render of one shot of their finished final render, through the
 * desk API -- owner-only, admitted as a deliverable at zero cost, made by the worker, and served.
 */
const SCRIPT="INT. WORKSHOP - NIGHT\n\nA lantern swings above the bench.";
const keys=["HV_TOKEN_SECRET","HV_ANIMATIC_PROVIDER_POOL","HV_PROVIDER_POOL","HV_ANIMATIC_CAPTIONS"],original=Object.fromEntries(keys.map(key=>[key,process.env[key]]));
const roots:string[]=[],servers:ReturnType<typeof createApiServer>[]=[];
afterAll(async()=>{for(const server of servers)await server.stop(true);for(const root of roots)rmSync(root,{recursive:true,force:true});
  for(const [key,value] of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
const sha=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function probe(path:string){
  const run=Bun.spawnSync(["ffprobe","-v","error","-select_streams","v:0","-count_frames","-show_entries","stream=width,height,r_frame_rate,nb_read_frames","-of","json",path],{stdout:"pipe"});
  const video=JSON.parse(run.stdout.toString()).streams[0];return {width:Number(video.width),height:Number(video.height),fps:String(video.r_frame_rate),frames:Number(video.nb_read_frames)};
}
async function studio(){
  Object.assign(process.env,{HV_TOKEN_SECRET:"hero-chain-route-fixture-secret-at-least-thirty-two",HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_PROVIDER_POOL:'["image:mock"]',HV_ANIMATIC_CAPTIONS:"0"});
  const root=mkdtempSync(join(tmpdir(),"hv-hero-route-"));roots.push(root);
  const paths={queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json")};
  const server=createApiServer({port:0,hostname:"127.0.0.1",...paths,rateLimit:{api:{limit:10000,windowMs:60000}}});servers.push(server);
  const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,keepalive:false,
    headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const project=async()=>{const owner=await(await call("/api/projects","POST")).json() as {projectId:string;token:string},base="/api/projects/"+owner.projectId;
    for(const [path,body] of [["/script",{text:SCRIPT}],["/rights",{attested:true}]] as const){const response=await call(base+path,path==="/script"?"PUT":"POST",body,owner.token);if(!response.ok)throw new Error(await response.text());}
    return {owner,base};};
  const store=new DurableJobStore(paths.queuePath),projects=new ProjectService(paths.statePath),ledger=new CostLedger(paths.costLedgerPath);
  const worker=()=>processNextJob(store,paths.artifactRoot,{projects,ledger,reviewQueue:new OperatorReviewQueue(join(root,"reviews.json"))});
  return {paths,call,project,store,worker};
}

test("an owner makes a hero render of one shot of a final render, and every stage's file and provenance is served",async()=>{
  const f=await studio(),{owner,base}=await f.project(),other=await f.project();
  const call=(path:string,method="GET",body?:unknown)=>f.call(path,method,body,owner.token);
  const json=async(path:string,method="GET",body?:unknown)=>{const response=await call(path,method,body),text=await response.text();
    if(!response.ok)throw new Error(path+" "+response.status+" "+text);return JSON.parse(text);};
  const finished=async()=>{const job=(await f.worker())!;expect({status:job.status,failed:job.failureReason??null}).toEqual({status:"done",failed:null});return job;};
  // A rough cut, approved, then the final: the film a hero shot is chosen from.
  await json(base+"/jobs","POST",{idempotencyKey:crypto.randomUUID()});const animatic=await finished();
  expect((await call(base+"/animatic/decision","POST",{animaticJobId:animatic.id,decision:"approved"})).status).toBe(201);
  await json(base+"/jobs","POST",{idempotencyKey:crypto.randomUUID(),stage:"final",animaticJobId:animatic.id});const film=await finished();
  expect(film.stage).toBe("final");
  const record=film.output!.shotRenders![0]!,clip=join(f.paths.artifactRoot,record.files.video.path),source=probe(clip);
  const hero=base+"/deliveries/hero/"+film.id;

  // Every shot of the film is answered, with the chain's choices and its limits.
  const offered=await json(hero);
  expect(offered.sourceJobId).toBe(film.id);
  expect(offered.shots.map((shot:any)=>[shot.shotId,shot.available,shot.sha256])).toEqual(film.output!.shotRenders!.map(value=>[value.shotId,true,value.files.video.sha256]));
  expect(offered.options).toMatchObject({stages:["denoise","frame-rate","upscale"],replacesShotInCut:false,costUsd:0,
    limits:{source:{maxWidth:1920,maxHeight:1080,maxFps:60,maxDurationSec:10},output:{maxWidth:3840,maxHeight:2160,maxFps:60}}});
  expect(offered.options.engines.every((engine:any)=>engine.provider==="local"&&engine.paid===false)).toBe(true);

  // Owner-only: no token, another project's token, and a rough cut instead of a final are all refused.
  expect((await f.call(hero)).status).toBe(401);
  expect((await f.call(hero,"POST",{idempotencyKey:crypto.randomUUID(),shotId:record.shotId})).status).toBe(401);
  expect((await f.call(hero,"GET",undefined,other.owner.token)).status).toBe(401);
  expect((await f.call(other.base+"/deliveries/hero/"+film.id,"GET",undefined,other.owner.token)).status).toBe(404);
  expect((await f.call(other.base+"/deliveries/hero/"+film.id,"POST",{idempotencyKey:crypto.randomUUID(),shotId:record.shotId},other.owner.token)).status).toBe(404);
  expect((await call(base+"/deliveries/hero/"+animatic.id)).status).toBe(404);
  // Limits and choices are refused by name before anything is queued.
  for(const [body,reason] of [[{fps:120},"24, 25, 30, 48, 50, 60 fps"],[{height:4320},"720, 1080, 1440, 2160 lines"],[{denoise:"heavy"},"denoise strength"],
    [{shotId:"shot-9-9"},"no rendered shot called shot-9-9"],[{engine:"acme-upscaler"},"Use only supported"]] as const){
    const response=await call(hero,"POST",{idempotencyKey:crypto.randomUUID(),shotId:record.shotId,...body});
    expect({status:response.status,error:(await response.json() as any).error}).toMatchObject({status:400,error:expect.stringContaining(reason)});
  }
  expect(f.store.all().filter(job=>job.stage==="delivery")).toEqual([]);

  // Ask for one, and let the worker make it.
  const fps=heroRate(source.fps),height=source.height<1080?1080:2160,key=crypto.randomUUID();
  const asked=await json(hero,"POST",{idempotencyKey:key,shotId:record.shotId,denoise:"light",fps,height});
  expect((await json(hero,"POST",{idempotencyKey:key,shotId:record.shotId,denoise:"light",fps,height})).jobId).toBe(asked.jobId);
  expect((await json(hero,"POST",{idempotencyKey:crypto.randomUUID(),shotId:record.shotId,denoise:"light",fps,height})).jobId).toBe(asked.jobId);
  expect((await call(hero,"POST",{idempotencyKey:key,shotId:record.shotId,denoise:"strong",fps,height})).status).toBe(400);
  const made:Job=await finished();
  expect(made.id).toBe(asked.jobId);
  expect({stage:made.stage,costUsd:made.costUsd,costCapUsd:made.costCapUsd,reserved:made.budgetReservedUsd}).toEqual({stage:"delivery",costUsd:0,costCapUsd:0,reserved:0});
  validateDeliveryOutput(made,made.deliveryOutput!);
  const output=made.deliveryOutput as HeroDeliveryOutput,chain=output.chain;

  // Three artifacts, each read back by ffprobe at the size and rate its stage was asked for.
  const files=chain.stages.map(stage=>join(f.paths.artifactRoot,stage.output.path)),width=Math.round(source.width*height/source.height/2)*2;
  expect(files.map(probe).map(({width,height,fps})=>({width,height,fps}))).toEqual([
    {width:source.width,height:source.height,fps:source.fps},{width:source.width,height:source.height,fps:fps+"/1"},{width,height,fps:fps+"/1"}]);
  expect(probe(files[0]!).frames).toBe(source.frames);
  // Each stage's provenance links its input to its output by digest, back to the shot's own clip.
  expect(chain.source).toMatchObject({jobId:film.id,shotId:record.shotId,renderRevision:record.revision,sha256:sha(readFileSync(clip))});
  chain.stages.forEach((stage,at)=>{
    expect(stage.input.sha256).toBe(at?chain.stages[at-1]!.output.sha256:record.files.video.sha256);
    expect(stage.output.sha256).toBe(sha(readFileSync(files[at]!)));
    expect([stage.provider,stage.spendUsd]).toEqual(["local",0]);
  });
  // The film itself is untouched: a hero render is a deliverable beside it, not a change to its cut.
  expect(sha(readFileSync(clip))).toBe(record.files.video.sha256);
  expect((f.store.get(film.id) as Job).output).toEqual(film.output);

  // Listed with every stage and every file linked, and the result served to its owner.
  const listed=(await json(base+"/deliveries")).jobs.find((job:any)=>job.id===made.id);
  expect(listed).toMatchObject({kind:"hero",shotId:record.shotId,sourceJobId:film.id,unavailable:null,costUsd:0});
  expect(listed.output.hero.stages.map((stage:any)=>[stage.stage,stage.sha256])).toEqual(chain.stages.map(stage=>[stage.stage,stage.output.sha256]));
  for(const [url,file] of [[listed.output.url,output.file],...listed.output.hero.stages.map((stage:any,at:number)=>[stage.url,chain.stages[at]!.output])] as [string,{sha256:string;bytes:number}][]){
    const response=await f.call(url);expect(response.status).toBe(200);const bytes=new Uint8Array(await response.arrayBuffer());
    expect({sha256:sha(bytes),bytes:bytes.byteLength}).toEqual({sha256:file.sha256,bytes:file.bytes});
  }
  const served=await f.call(listed.output.hero.recordUrl);expect(served.status).toBe(200);
  expect(await served.json()).toEqual(JSON.parse(readFileSync(join(f.paths.artifactRoot,output.files[3]!.path),"utf8")));
  // A file the job does not retain is not served under its token.
  expect((await f.call(listed.output.url.replace("3-upscale.mp4","4-extra.mp4"))).status).toBe(404);
  expect(statSync(files[2]!).size).toBe(output.file.bytes);
  // The film's own hero list shows the job too.
  expect((await json(hero)).jobs.map((job:any)=>job.id)).toEqual([made.id]);
},300_000);

/** A frame rate the chain offers that differs from the shot's own. */
function heroRate(rational:string):number{const [n,d]=rational.split("/").map(Number);return (n as number)/(d as number)===60?30:60;}
