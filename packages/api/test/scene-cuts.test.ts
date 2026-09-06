import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../src/server";
import {ProjectService} from "../src/index";
import {DurableJobStore,type Job} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {validateSnapshot} from "../../storage/src/snapshots";
const SCRIPT="INT. ROOM - DAY\n\nA red cube rests.\n\nMARLA\nHello.\n\nA blue cube moves.\n\nKEVIN\nWelcome.\n\nEXT. GARDEN - DAY\n\nA lamp glows.";
const originalEnv=Object.fromEntries(["HV_TOKEN_SECRET","HV_ANIMATIC_PROVIDER_POOL","HV_PROVIDER_POOL","HV_NARRATION","HV_ANIMATIC_CAPTIONS"].map(key=>[key,process.env[key]]));afterAll(()=>{for(const [key,value]of Object.entries(originalEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
const fixtures:{root:string;server:ReturnType<typeof createApiServer>}[]=[];afterAll(async()=>{for(const f of fixtures){await f.server.stop(true);rmSync(f.root,{recursive:true,force:true});}});
async function fixture(){
  Object.assign(process.env,{HV_TOKEN_SECRET:"selective-render-api-fixture-secret-at-least-thirty-two",HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_PROVIDER_POOL:'["mock"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0"});
  const root=mkdtempSync(join(tmpdir(),"hv-cuts-api-")),paths={queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json")};
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

test("owner-reviewed coverage renders ordered preview/final shots and selectively regenerates one revised note",async()=>{
  const f=await fixture(),initial=await f.render();await f.approve(initial);
  const review=async(body:unknown)=>{const r=await f.call(f.base+"/direction/scene-cuts","POST",body,f.owner.token);expect(await r.clone().text()).not.toContain('"error"');expect(r.status).toBe(200);return await r.json() as any;};
  const accept=async(r:any)=>{const response=await f.call(f.base+"/direction/scene-cuts/accept","POST",{proposal:r.proposal,removeDirectionIds:r.impact.removeDirectionIds},f.owner.token);expect(await response.clone().text()).not.toContain('"error"');expect(response.status).toBe(200);};
  const proposal=await review({sceneIndex:0,maxShots:24});expect(proposal.impact).toMatchObject({beforeShots:3,afterShots:5,removeDirectionIds:[]});
  expect((await f.call(f.base+"/direction","GET",undefined,f.owner.token)).status).toBe(200);expect(f.projects.authorize(f.owner.token)!.directionHistory).toEqual([]);
  await accept(proposal);expect((await f.enqueue({stage:"final",animaticJobId:initial.id})).status).toBe(409);
  const preview=await f.render({reuseUnchanged:true});expect(preview.output!.shotRenders!.map(s=>s.shotId)).toEqual(["shot-1-10001","shot-1-10002","shot-1-10003","shot-1-10004","shot-2-1"]);
  expect(preview.shotReuse!.shots.map(s=>s.shotId)).toEqual(["shot-2-1"]);await f.approve(preview);
  const final=await f.render({stage:"final",animaticJobId:preview.id,reuseUnchanged:true});
  for(const job of [preview,final]){const m=f.manifest(job);expect(m.direction.sceneCuts).toEqual([proposal.proposal.cut]);expect(m.coverage.scenes[0].inventory.single).toEqual(["shot-1-10002","shot-1-10004"]);const captions=readFileSync(join(f.paths.artifactRoot,job.output!.captionsPath),"utf8");expect(captions.split("Hello.")).toHaveLength(2);expect(captions.split("Welcome.")).toHaveLength(2);expect(captions.indexOf("Hello.")).toBeLessThan(captions.indexOf("Welcome."));}
  const view=await(await f.call(f.base+"/direction","GET",undefined,f.owner.token)).json() as any;expect(view.viewfinderSources.map((s:any)=>s.shotId)).toContain("shot-1-10002");
  const edited=structuredClone(proposal.proposal.cut);edited.shots[1].notes="Tighter on Marla, slower push-in.";edited.shots[1].durationFrames=90;
  const changed=await review({sceneIndex:0,maxShots:24,binding:{...proposal.proposal.binding,directionRevision:view.direction.revision},edits:{shots:edited.shots,notes:edited.notes}});await accept(changed);
  const revised=await f.render({reuseUnchanged:true});expect(revised.output!.shotRenders!.filter(s=>!s.reusedFrom).map(s=>s.shotId)).toEqual(["shot-1-10002"]);await f.approve(revised);
  const revisedFinal=await f.render({stage:"final",animaticJobId:revised.id,reuseUnchanged:true});expect(revisedFinal.output!.shotRenders!.filter(s=>!s.reusedFrom).map(s=>s.shotId)).toEqual(["shot-1-10002"]);
  expect(revised.output!.shotRenders![1]!.clip.durationSec).toBe(3);expect(revisedFinal.output!.shotRenders![1]!.clip.durationSec).toBe(3);
  const snapshot={schema:"hv-state/1" as const,projects:f.projects.snapshot(),jobs:f.store.all(),ledger:{events:f.ledger.all(),reservations:[]},reviews:[]};expect(validateSnapshot(snapshot)).toEqual(snapshot);
  const broken=structuredClone(snapshot);broken.jobs[1]!.direction!.sceneCuts![0]!.shots[1]!.beatIds=[];expect(()=>validateSnapshot(broken)).toThrow();
  expect(f.ledger.monthSpend()).toBe(0);expect(f.ledger.reservedUsd()).toBe(0);
  await f.save("shot-1-10002",{size:"close-up",previewMove:"static"});expect(f.projects.authorize(f.owner.token)!.directionHistory.at(-1)!.sceneCuts).toHaveLength(1);
  await f.call(f.base+"/script","PUT",{text:SCRIPT.replace("Hello.","Goodbye.")},f.owner.token);expect((await f.enqueue()).status).toBe(409);
  const stale=await(await f.call(f.base+"/direction","GET",undefined,f.owner.token)).json() as any;expect(stale.staleSceneIndices).toEqual([0]);expect(stale.staleShotIds).toEqual(["shot-1-10002"]);
},60000);

test("coverage endpoints reject foreign access, stale concurrent acceptance, omitted beats and an over-budget cut without mutation",async()=>{
  const f=await fixture(),other=await(await f.call("/api/projects","POST")).json() as any;
  expect((await f.call(f.base+"/direction/scene-cuts","POST",{sceneIndex:0,maxShots:24},other.token)).status).toBe(401);
  const r=await(await f.call(f.base+"/direction/scene-cuts","POST",{sceneIndex:0,maxShots:24},f.owner.token)).json() as any;
  const bad=structuredClone(r.proposal.cut);bad.shots.pop();expect((await f.call(f.base+"/direction/scene-cuts","POST",{sceneIndex:0,maxShots:24,binding:r.proposal.binding,edits:{shots:bad.shots,notes:""}},f.owner.token)).status).toBe(400);
  const responses=await Promise.all([1,2].map(()=>f.call(f.base+"/direction/scene-cuts/accept","POST",{proposal:r.proposal,removeDirectionIds:[]},f.owner.token)));expect(responses.map(r=>r.status).sort()).toEqual([200,409]);
  const large="INT. ROOM - DAY\n\n"+Array.from({length:25},(_,i)=>`Object ${i} moves.`).join("\n\n");await f.call(f.base+"/script","PUT",{text:large},f.owner.token);
  const proposal=await(await f.call(f.base+"/direction/scene-cuts","POST",{sceneIndex:0,maxShots:24},f.owner.token)).json() as any;expect(proposal.impact.overBudget).toBe(true);
  expect((await f.call(f.base+"/direction/scene-cuts/accept","POST",{proposal:proposal.proposal,removeDirectionIds:[]},f.owner.token)).status).toBe(409);expect(f.projects.authorize(f.owner.token)!.directionHistory).toHaveLength(1);expect(f.store.all()).toEqual([]);expect(f.ledger.reservedUsd()).toBe(0);
});
