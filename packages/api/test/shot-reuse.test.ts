import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../src/server";
import {ProjectService} from "../src/index";
import {DurableJobStore,LeaseError,type Job} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {validateSnapshot,type StateSnapshot} from "../../storage/src/snapshots";
import {createReusePlan,renderInputHash,renderShots,renderRecord} from "../../planner/src/shot-reuse";
import {CAST_INPUT} from "../../../test/fixtures/casting";
const SCRIPT="EXT. GARDEN - DAY\n\nSpud waves beside a gate.\n\nThe gate closes.\n\nINT. ROOM - NIGHT\n\nA lamp glows.";
const originalEnv=Object.fromEntries(["HV_TOKEN_SECRET","HV_ANIMATIC_PROVIDER_POOL","HV_PROVIDER_POOL","HV_NARRATION","HV_ANIMATIC_CAPTIONS"].map(key=>[key,process.env[key]]));afterAll(()=>{for(const [key,value]of Object.entries(originalEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
const fixtures:{root:string;server:ReturnType<typeof createApiServer>}[]=[];afterAll(async()=>{for(const f of fixtures){await f.server.stop(true);rmSync(f.root,{recursive:true,force:true});}});
async function fixture(){
  Object.assign(process.env,{HV_TOKEN_SECRET:"selective-render-api-fixture-secret-at-least-thirty-two",HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_PROVIDER_POOL:'["mock"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0"});
  const root=mkdtempSync(join(tmpdir(),"hv-selective-api-")),paths={queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json")};
  const server=createApiServer({port:0,hostname:"127.0.0.1",...paths,rateLimit:{api:{limit:10000,windowMs:60000}}});fixtures.push({root,server});
  const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const owner=await(await call("/api/projects","POST")).json() as {projectId:string;token:string},base="/api/projects/"+owner.projectId;
  await call(base+"/script","PUT",{text:SCRIPT},owner.token);await call(base+"/rights","POST",{attested:true},owner.token);
  const projects=new ProjectService(paths.statePath),store=new DurableJobStore(paths.queuePath),ledger=new CostLedger(paths.costLedgerPath);
  const worker=()=>processNextJob(store,paths.artifactRoot,{projects,ledger,reviewQueue:new OperatorReviewQueue(join(root,"reviews.json"))});
  const enqueue=(body:Record<string,unknown>={})=>call(base+"/jobs","POST",{idempotencyKey:crypto.randomUUID(),...body},owner.token);
  const render=async(body:Record<string,unknown>={})=>{const response=await enqueue(body);expect(await response.clone().text()).not.toContain('"error"');expect(response.status).toBe(202);const result=await worker();expect(result?.failureReason??result?.cancelReason).toBeUndefined();expect(result?.status).toBe("done");return result!;};
  const approve=async(job:Job)=>{const response=await call(base+"/animatic/decision","POST",{animaticJobId:job.id,decision:"approved"},owner.token);expect(response.status).toBe(201);};
  const save=async(shotId:string,settings:unknown)=>{const view=await(await call(base+"/direction","GET",undefined,owner.token)).json() as any;const response=await call(base+"/direction/"+shotId,"PUT",{settings,expectedVersion:view.direction.version,expectedScriptVersion:view.scriptVersion,sourceHash:view.plan.find((p:any)=>p.source.id===shotId).sourceHash},owner.token);expect(response.status).toBe(200);};
  const manifest=(job:Job)=>JSON.parse(readFileSync(join(paths.artifactRoot,job.output!.manifestPath),"utf8"));
  return {root,paths,server,call,owner,base,projects,store,ledger,worker,enqueue,render,approve,save,manifest};
}
test("selective preview and final renders regenerate changed shots, preserve exact media and retain fresh approval",async()=>{
  const f=await fixture(),preview=await f.render();expect(preview.output!.shotRenders).toHaveLength(3);await f.approve(preview);const final=await f.render({stage:"final",animaticJobId:preview.id});
  await f.save("shot-1-1",{durationFrames:90,previewMove:"static"});expect((await f.enqueue({stage:"final",animaticJobId:preview.id,reuseUnchanged:true})).status).toBe(409);
  const next=await f.render({reuseUnchanged:true});expect(next.shotReuse!.shots.map(r=>r.shotId)).toEqual(["shot-1-2","shot-2-1"]);await f.approve(next);
  const nextFinal=await f.render({stage:"final",animaticJobId:next.id,reuseUnchanged:true});
  for(const [before,after]of [[preview,next],[final,nextFinal]]){
    const records=after!.output!.shotRenders!;expect(records.filter(r=>r.reusedFrom)).toHaveLength(2);expect(records[0]!.inputHash).not.toBe(before!.output!.shotRenders![0]!.inputHash);
    for(const record of records.slice(1)){const original=before!.output!.shotRenders!.find(r=>r.shotId===record.shotId)!;expect(record.origin.jobId).toBe(before!.id);expect(record.files.video.sha256).toBe(original.files.video.sha256);expect(record.files.video.path).toContain(after!.id);expect(readFileSync(join(f.paths.artifactRoot,record.files.video.path))).toEqual(readFileSync(join(f.paths.artifactRoot,original.files.video.path)));}
    expect([...new Set(f.ledger.all().filter(e=>e.jobId===after!.id).map(e=>e.shotId))]).toEqual(["shot-1-1"]);
    expect(f.manifest(after!).shots.map((s:any)=>s.renderRecord)).toEqual(records);
  }
  const forced=await f.render({reuseUnchanged:true,forceShotIds:["shot-1-2"]});expect(forced.output!.shotRenders!.filter(r=>!r.reusedFrom).map(r=>r.shotId)).toEqual(["shot-1-2"]);
  const allReused=await f.render({reuseUnchanged:true});expect(allReused.shotReuse!.shots).toHaveLength(3);expect(allReused.budgetReservedUsd).toBe(0);expect(f.ledger.all().filter(e=>e.jobId===allReused.id)).toEqual([]);expect(f.ledger.reservedUsd()).toBe(0);
  const snapshot:StateSnapshot={schema:"hv-state/1",projects:JSON.parse(readFileSync(f.paths.statePath,"utf8")),jobs:f.store.all(),ledger:{events:f.ledger.all(),reservations:[]},reviews:[]};expect(validateSnapshot(snapshot).jobs).toHaveLength(6);
  const corrupt=structuredClone(snapshot),record=corrupt.jobs[0]!.output!.shotRenders![0]!;record.inputHash="0".repeat(64);const {schema:_s,revision:_r,...data}=record;corrupt.jobs[0]!.output!.shotRenders![0]=renderRecord(data);expect(()=>validateSnapshot(corrupt)).toThrow("inputs changed");
},45000);
test("reuse compares actual scene inputs and provider contracts, ignores unrelated revision numbers and refuses unknown forced shots",async()=>{
  const f=await fixture(),first=await f.render();await f.call(f.base+"/script","PUT",{text:SCRIPT.replace("A lamp glows.","A lamp goes dark.")},f.owner.token);
  const next=await f.render({reuseUnchanged:true});expect(next.shotReuse!.shots.map(r=>r.shotId)).toEqual(["shot-1-1","shot-1-2"]);
  const copied={...first,scriptVersion:99,casting:{...first.casting!,version:2}};expect(renderInputHash(copied,renderShots(first)[0]!)).toBe(renderInputHash(first,renderShots(first)[0]!));
  const changed={...next,tier:"elevated" as const};expect(createReusePlan(changed,[first,next]).shots).toEqual([]);
  expect((await f.enqueue({reuseUnchanged:true,forceShotIds:["missing-shot"]})).status).toBe(400);expect((await f.enqueue({forceShotIds:["shot-1-1"]})).status).toBe(400);expect((await f.enqueue({reuseUnchanged:"yes"})).status).toBe(400);
  const other=await(await f.call("/api/projects","POST")).json() as {token:string};expect((await f.call(f.base+"/jobs","POST",{reuseUnchanged:true},other.token)).status).toBe(401);
},20000);
test("tampered or missing source bytes stop reuse without silently dispatching a fresh provider request",async()=>{
  const f=await fixture(),first=await f.render(),record=first.output!.shotRenders![0]!,path=join(f.paths.artifactRoot,record.files.video.path),bytes=readFileSync(path);bytes[bytes.length-1]^=1;writeFileSync(path,bytes);
  expect((await f.enqueue({reuseUnchanged:true})).status).toBe(202);const failed=await f.worker();expect(failed?.status).toBe("cancelled");expect(failed?.cancelReason).toContain("checksum");expect(f.ledger.all().filter(e=>e.jobId===failed!.id)).toEqual([]);expect(f.ledger.reservedUsd()).toBe(0);
  const fresh=await f.render({reuseUnchanged:false});expect(fresh.output!.shotRenders!.every(r=>!r.reusedFrom)).toBe(true);
},20000);
test("cast permission is rechecked after the reusable clip is copied",async()=>{
  const f=await fixture(),id=crypto.randomUUID();f.projects.saveCharacter(f.owner.token,id,CAST_INPUT,0);await f.render();expect((await f.enqueue({reuseUnchanged:true})).status).toBe(202);
  const peek=f.projects.peekProject.bind(f.projects);let calls=0;f.projects.peekProject=(projectId:string)=>{if(++calls===2)f.projects.saveCharacter(f.owner.token,id,{...CAST_INPUT,permission:{...CAST_INPUT.permission,status:"revoked"}},1);return peek(projectId);};
  const result=await f.worker();expect(result?.status).not.toBe("done");expect(result?.output).toBeUndefined();expect(f.ledger.all().filter(e=>e.jobId===result!.id)).toEqual([]);
},20000);
test("an interrupted selective render resumes independent copied clips and rejects checkpoint tampering",async()=>{
  const f=await fixture();await f.render();const checkpoint=f.store.checkpoint.bind(f.store);
  const interrupt=async()=>{expect((await f.enqueue({reuseUnchanged:true})).status).toBe(202);f.store.checkpoint=(...args)=>{checkpoint(...args);throw new LeaseError(args[0],"lease_expired",args[1]);};try{const partial=await f.worker();expect(partial?.status).toBe("running");expect(partial?.checkpointShots).toBe(1);return partial!;}finally{f.store.checkpoint=checkpoint;}};
  const resume=()=>processNextJob(f.store,f.paths.artifactRoot,{projects:f.projects,ledger:f.ledger,reviewQueue:new OperatorReviewQueue(join(f.root,"reviews.json")),now:()=>Date.now()+600000});
  const partial=await interrupt(),completed=await resume();expect(completed?.id).toBe(partial.id);expect(completed?.status).toBe("done");expect(completed?.output!.shotRenders!.filter(r=>r.reusedFrom)).toHaveLength(3);expect(f.ledger.all().filter(e=>e.jobId===completed!.id)).toEqual([]);
  const broken=await interrupt(),clips=JSON.parse(readFileSync(join(f.paths.artifactRoot,f.owner.projectId,broken.id,"clips/manifest.json"),"utf8"));writeFileSync(clips[0].path,"tampered copied checkpoint");
  const rejected=await resume();expect(rejected?.status).toBe("cancelled");expect(rejected?.cancelReason).toContain("resumed shot");expect(f.ledger.all().filter(e=>e.jobId===rejected!.id)).toEqual([]);
},20000);
