import {expect,test} from "bun:test";
import {mkdtempSync,realpathSync,rmSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {createApiServer} from "../src/server";
import {ProjectService} from "../src/index";
import {DurableJobStore,LeaseError,type Job} from "../../queue/src/index";
import {processNextJob,type WorkerContext} from "../../queue/src/worker";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {defaultMotionGraphic} from "../../planner/src/motion-graphics";
import {currentGraphics} from "../../planner/src/graphic-library";
import {validateGraphicOutput} from "../../planner/src/graphic-jobs";
import {validateSnapshot,writeStateSnapshot,readStateSnapshot,type StateSnapshot} from "../../storage/src/snapshots";
import {verifyGraphicMedia} from "../../generator/src/graphic-media";
import {contentHash} from "../../generator/src/capabilities";
function fixture(){
  process.env.HV_TOKEN_SECRET="graphic-studio-fixture-secret-at-least-thirty-two-characters";
  const root=mkdtempSync(join(realpathSync(tmpdir()),"hv-graphic-api-")),statePath=join(root,"projects.json"),queuePath=join(root,"jobs.json"),artifactRoot=join(root,"artifacts"),costLedgerPath=join(root,"ledger.json"),projects=new ProjectService(statePath),owner=projects.createAnonymousProject();projects.attestRights(owner.token);
  const server=createApiServer({port:0,hostname:"127.0.0.1",storage:"json",artifactStorage:"local",statePath,queuePath,artifactRoot,costLedgerPath,operatorDiagnosticsSecret:null}),base=`/api/projects/${owner.projectId}/graphics`,store=new DurableJobStore(queuePath),ledger=new CostLedger(costLedgerPath),context:WorkerContext={projects,ledger,reviewQueue:new OperatorReviewQueue(join(root,"review.json")),graphics:{chromePath:process.env.HV_GRAPHICS_CHROME_PATH??""}};
  const call=(path:string,method="GET",body?:unknown,token:string|null=owner.token)=>fetch(new URL(path,server.url),{method,headers:{...(token?{authorization:"Bearer "+token}:{}),...(body?{"content-type":"application/json"}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const close=async()=>{await server.stop(true);if(!root.startsWith(realpathSync(tmpdir())+sep)||realpathSync(root)!==root)throw new Error("Unsafe fixture cleanup");rmSync(root,{recursive:true,force:true});};
  return {root,projects,owner,server,base,store,ledger,context,artifactRoot,call,close};
}
function draft(){const {revision:_revision,...plan}=defaultMotionGraphic("lower-third",320,180);return {...plan,text:"Marla",secondary:"A fictional character",frames:4,enterFrames:1,exitFrames:1};}
test("owners retain graphic versions, recover saves, reject stale mutations and preserve schema-5 histories",async()=>{
  const f=fixture();try{
    const id=crypto.randomUUID(),input={expectedVersion:0,change:{kind:"save",id,label:"Opening credit",plan:draft()}};
    expect((await f.call(f.base,"GET",undefined,null)).status).toBe(401);
    let response=await f.call(f.base,"PUT",input);expect(response.status).toBe(200);const first=await response.json() as any;expect(first.library.version).toBe(1);
    response=await f.call(f.base,"PUT",input);expect(response.status).toBe(200);expect((await response.json() as any).library).toEqual(first.library);
    expect((await f.call(f.base,"PUT",{...input,change:{...input.change,label:"Conflicting save"}})).status).toBeGreaterThanOrEqual(400);
    response=await f.call(f.base,"PUT",{expectedVersion:1,change:{kind:"save",id,label:"Second credit",plan:{...draft(),text:"Kevin"}}});expect(response.status).toBe(200);
    const second=await response.json() as any;expect(second.library.events[0]).toEqual(first.library.events[0]);expect(second.graphics[0].spec.plan.text).toBe("Kevin");
    await f.call(f.base,"PUT",{expectedVersion:2,change:{kind:"availability",id,available:false}});
    response=await f.call(f.base,"PUT",{expectedVersion:3,change:{kind:"save",id,label:"Hidden revision",plan:draft()}});expect((await response.json() as any).graphics[0].available).toBe(false);
    const project=new ProjectService(join(f.root,"projects.json")),snapshot:StateSnapshot={schema:"hv-state/5",projects:project.snapshot(),jobs:[],ledger:{events:[],reservations:[]},reviews:[]};
    expect(currentGraphics(snapshot.projects.projects[0]!.graphicLibrary!,f.owner.projectId)[0]!.available).toBe(false);expect(()=>validateSnapshot({...snapshot,schema:"hv-state/4"})).toThrow("schema 5");
    const directory=join(f.root,"saved");writeStateSnapshot(directory,snapshot);expect(readStateSnapshot(directory)).toEqual(snapshot);
    const corrupt=structuredClone(snapshot);corrupt.projects.projects[0]!.graphicLibrary!.events[0]!.change={kind:"availability",id,available:true};expect(()=>validateSnapshot(corrupt)).toThrow();
    expect((await f.call(f.base,"PUT",{expectedVersion:4,change:{...input.change,plan:{...draft(),html:"<script>"}}})).status).toBeGreaterThanOrEqual(400);
  }finally{await f.close();}
});
const renderTest=process.env.HV_GRAPHICS_CHROME_PATH?test:test.skip;
renderTest("real graphic jobs retain alpha, recover a complete checkpoint without Chrome, and revoke owned downloads",async()=>{
  const f=fixture();try{
    const id=crypto.randomUUID(),saved=await f.call(f.base,"PUT",{expectedVersion:0,change:{kind:"save",id,label:"Opening credit",plan:draft()}});expect(saved.status).toBe(200);const spec=(await saved.json() as any).graphics[0].spec;
    const request={specRevision:spec.revision,idempotencyKey:crypto.randomUUID(),generationApproved:true},path=f.base+`/${id}/renders`;
    const admitted=await f.call(path,"POST",request);expect(admitted.status).toBe(202);const jobId=(await admitted.json() as any).jobId;
    expect((await(await f.call(path,"POST",request)).json() as any).jobId).toBe(jobId);expect((await f.call(path,"POST",{...request,specRevision:"0".repeat(64)})).status).toBeGreaterThanOrEqual(400);
    const complete=f.store.completeGraphic.bind(f.store);f.store.completeGraphic=()=>{throw new LeaseError(jobId,"fence_changed","lost-worker");};
    const progress=f.store.progressGraphic.bind(f.store),phases:string[]=[];f.store.progressGraphic=(job,worker,value,now,lease)=>{expect(f.store.get(job)!.checkpointFrame).toBe(0);phases.push(value.phase);progress(job,worker,value,now,lease);};
    const interrupted=await processNextJob(f.store,f.artifactRoot,{...f.context,workerId:"capture-worker"});expect(interrupted?.status).toBe("running");expect(interrupted?.failureReason).toBeUndefined();expect(interrupted?.graphicCheckpoint).toBeDefined();expect(interrupted?.checkpointFrame).toBe(4);expect(new Set(phases)).toEqual(new Set(["capture","encode","verify","retain"]));
    f.store.completeGraphic=complete;const resumeAt=Date.parse(interrupted!.leaseExpiresAt!)+1;
    const done=await processNextJob(f.store,f.artifactRoot,{...f.context,workerId:"fresh-worker",graphics:{chromePath:"missing-on-purpose"},now:()=>resumeAt});expect(done?.status).toBe("done");expect(done?.graphicOutput).toEqual(interrupted?.graphicCheckpoint);expect(done?.resumedCount).toBe(1);expect(done?.output).toBeUndefined();expect(done?.costUsd).toBe(0);expect(f.ledger.all()).toHaveLength(0);expect(f.ledger.reservedUsd()).toBe(0);
    validateGraphicOutput(done!,done!.graphicOutput!);await verifyGraphicMedia(done!,done!.graphicOutput!,f.artifactRoot);expect(done!.graphicOutput!.report.frames.some(frame=>frame.transparentPixels>0&&frame.visiblePixels>0)).toBe(true);
    const reordered=JSON.parse(JSON.stringify(done!.graphicOutput),(key,value)=>value&&!Array.isArray(value)&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>b.localeCompare(a))):value);expect(contentHash(reordered)).toBe(contentHash(done!.graphicOutput));validateGraphicOutput(done!,reordered);await verifyGraphicMedia(done!,reordered,f.artifactRoot);
    const view=await(await f.call(f.base+"/jobs/"+jobId)).json() as any;expect(view.output).toBeDefined();const png=await f.call(view.output.framesUrl+"000001.png","GET",undefined,null);expect(png.status).toBe(200);expect(png.headers.get("content-type")).toBe("image/png");
    const manifest=await f.call(view.output.manifestUrl,"GET",undefined,null);expect(manifest.headers.get("content-disposition")).toContain("attachment");expect(manifest.headers.get("content-security-policy")).toContain("sandbox");
    await f.call(f.base,"PUT",{expectedVersion:1,change:{kind:"availability",id,available:false}});expect((await f.call(view.output.framesUrl+"000001.png","GET",undefined,null)).status).toBe(404);
    const unavailable=await(await f.call(f.base+"/jobs/"+jobId)).json() as any;expect(unavailable.output).toBeNull();expect(unavailable.unavailable).toContain("permission");
    await f.call(f.base,"PUT",{expectedVersion:2,change:{kind:"availability",id,available:true}});expect((await f.call(view.output.framesUrl+"000001.png","GET",undefined,null)).status).toBe(200);
    const snapshot:StateSnapshot={schema:"hv-state/5",projects:new ProjectService(join(f.root,"projects.json")).snapshot(),jobs:[done!],ledger:{events:[],reservations:[]},reviews:[]};expect(validateSnapshot(snapshot)).toEqual(snapshot);
    const corrupt=structuredClone(done!) as Job;corrupt.graphicOutput!.files[0]!.path="other/job/index.html";const {revision:_revision,...data}=corrupt.graphicOutput!;corrupt.graphicOutput!.revision=contentHash(data);expect(()=>validateGraphicOutput(corrupt,corrupt.graphicOutput!)).toThrow("file");
    const original=readFileSync(join(f.artifactRoot,done!.graphicOutput!.masterPath));expect(original.length).toBe(done!.graphicOutput!.report.master.bytes);
  }finally{await f.close();}
},120000);
