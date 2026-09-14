import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../../packages/api/src/server";
import {ProjectService} from "../../packages/api/src/index";
import {DurableJobStore,type Job} from "../../packages/queue/src/index";
import {processNextJob} from "../../packages/queue/src/worker";
import {CostLedger,OperatorReviewQueue} from "../../packages/operator/src/index";
import {scenePerformanceSource} from "../../packages/planner/src/performance-memory";
import {parseFountain} from "../../packages/parser/src/index";
import {CAST_INPUT} from "./casting";
export const PICTURE_SCRIPT="EXT. GARDEN - DAY\n\nSpud waits beside the gate.\n\nSpud opens the gate.\n\nINT. ROOM - NIGHT\n\nA lantern glows.";
export async function pictureStudio(root=mkdtempSync(join(tmpdir(),"hv-picture-studio-"))){
  const config={HV_TOKEN_SECRET:"picture-studio-fixture-secret-at-least-thirty-two-characters",HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_PROVIDER_POOL:'["mock"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0"},original=Object.fromEntries(Object.keys(config).map(k=>[k,process.env[k]]));Object.assign(process.env,config);
  const paths={queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json")},server=createApiServer({port:0,hostname:"127.0.0.1",...paths,rateLimit:{api:{limit:10000,windowMs:60000}}});
  const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,keepalive:false,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const owner=await(await call("/api/projects","POST")).json() as {projectId:string;token:string},base="/api/projects/"+owner.projectId,id=crypto.randomUUID();
  for(const [path,method,body]of [["/script","PUT",{text:PICTURE_SCRIPT}],["/rights","POST",{attested:true}],["/cast/"+id,"PUT",{expectedVersion:0,character:CAST_INPUT}]] as const){const r=await call(base+path,method,body,owner.token);if(!r.ok)throw new Error(await r.text());}
  const view=()=>call(base+"/direction","GET",undefined,owner.token).then(r=>r.json() as Promise<any>),scene=async(picture:unknown,expectedVersion?:number)=>{const cast=await(await call(base+"/cast","GET",undefined,owner.token)).json() as any;return call(base+"/cast/"+id+"/scene-performance","PUT",{expectedVersion:expectedVersion??cast.casting.version,expectedScriptVersion:1,sceneNumber:1,sourceHash:scenePerformanceSource(parseFountain(PICTURE_SCRIPT).scenes[0]!),notes:"Keep the welcome understated.",controls:{},picture},owner.token);};
  const save=async(settings:unknown,shotId="shot-1-1")=>{const state=await view();return call(base+"/direction/"+shotId,"PUT",{settings,sourceHash:state.plan.find((p:any)=>p.source.id===shotId).sourceHash,expectedVersion:state.direction.version,expectedScriptVersion:state.scriptVersion},owner.token);};
  const projects=new ProjectService(paths.statePath),store=new DurableJobStore(paths.queuePath),ledger=new CostLedger(paths.costLedgerPath),reviews=new OperatorReviewQueue(join(root,"reviews.json"));
  const worker=()=>processNextJob(store,paths.artifactRoot,{projects,ledger,reviewQueue:reviews});
  const enqueue=(body:Record<string,unknown>={})=>call(base+"/jobs","POST",{idempotencyKey:crypto.randomUUID(),...body},owner.token);
  const render=async(body:Record<string,unknown>={})=>{const r=await enqueue(body);if(r.status!==202)throw new Error(await r.text());const job=await worker();if(job?.status!=="done")throw new Error(JSON.stringify(job));return job;};
  const manifest=(job:Job)=>JSON.parse(readFileSync(join(paths.artifactRoot,job.output!.manifestPath),"utf8"));
  return {root,paths,server,call,owner,base,id,view,scene,save,projects,store,ledger,reviews,worker,enqueue,render,manifest,async close(remove=true){await server.stop(true);if(remove)rmSync(root,{recursive:true,force:true});for(const [k,v]of Object.entries(original)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}};
}
