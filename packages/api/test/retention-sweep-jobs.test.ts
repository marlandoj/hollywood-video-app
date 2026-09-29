/**
 * HV-031-11 — the retention sweep deleted an expired project, and its queued render went on to run.
 *
 * On the JSON backend `scripts/sweep-expired.ts` is the retention loop. `sweepExpiredProjects`
 * removed the project's record and its media folder, and never touched its jobs. A takedown revokes
 * them; the PostgreSQL purge deletes them. The worker does not look the project up before an
 * ordinary render (`assertPendingContext` returns early for one), so a render queued before the
 * sweep was claimed and rendered after it:
 *
 * - with a paid provider, money was spent on a project retention had already erased;
 * - `artifacts/<projectId>/` was written back, and with the project gone from the state file only
 *   the folder-age sweep would ever remove it.
 *
 * The sweep now stops a swept project's unfinished jobs, as a takedown does, before its media goes,
 * and says why: its retention ended.
 */
import {afterAll,beforeAll,expect,test} from "bun:test";
import {existsSync,mkdirSync,mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const root=mkdtempSync(join(tmpdir(),"hv-retention-sweep-jobs-"));
const paths={statePath:join(root,"state/projects.json"),queuePath:join(root,"queue/jobs.json"),costLedgerPath:join(root,"state/cost-ledger.json"),artifactRoot:join(root,"artifacts")};
const saved=Object.fromEntries(["HV_TOKEN_SECRET","HV_ARTIFACT_ROOT","HV_PROJECT_STATE_PATH","HV_QUEUE_PATH","HV_ANIMATIC_PROVIDER_POOL"].map(key=>[key,process.env[key]]));
Object.assign(process.env,{HV_TOKEN_SECRET:"retention-sweep-jobs-secret-at-least-thirty-two-characters",HV_ARTIFACT_ROOT:paths.artifactRoot,
  HV_PROJECT_STATE_PATH:paths.statePath,HV_QUEUE_PATH:paths.queuePath,HV_ANIMATIC_PROVIDER_POOL:'["mock"]'});
const generous={api:{limit:1_000_000,windowMs:60_000},projectCreate:{limit:1_000_000,windowMs:3600_000},artifacts:{limit:1_000_000,windowMs:60_000}};
let server:ReturnType<typeof import("../src/server").createApiServer>,base:string;
beforeAll(async()=>{
  mkdirSync(join(root,"queue"),{recursive:true});
  const {createApiServer}=await import("../src/server");
  server=createApiServer({port:0,hostname:"127.0.0.1",...paths,rateLimit:generous});base=`http://127.0.0.1:${server.port}`;
});
afterAll(()=>{server.stop(true);rmSync(root,{recursive:true,force:true});for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});

/** A project with a script, rights and a queued render. */
async function queued(){
  const created=await(await fetch(`${base}/api/projects`,{method:"POST"})).json() as {projectId:string;token:string};
  const headers={authorization:`Bearer ${created.token}`,"content-type":"application/json"};
  await fetch(`${base}/api/projects/${created.projectId}/script`,{method:"PUT",headers,body:JSON.stringify({text:"INT. ROOM - DAY\n\nA lamp glows."})});
  await fetch(`${base}/api/projects/${created.projectId}/rights`,{method:"POST",headers,body:JSON.stringify({attested:true})});
  const admitted=await fetch(`${base}/api/projects/${created.projectId}/jobs`,{method:"POST",headers,body:JSON.stringify({})});
  expect(admitted.status).toBe(202);
  return {projectId:created.projectId,jobId:(await admitted.json() as {jobId:string}).jobId};
}

test("a project the sweep removes has its queued render stopped, and the worker renders nothing for it",async()=>{
  const expired=await queued();
  const {sweepExpiredProjects,RETENTION_ENDED_NOTICE}=await import("../../../scripts/sweep-expired");
  expect(sweepExpiredProjects(Date.now()+31*24*3600*1000)).toEqual([expired.projectId]);
  const {DurableJobStore}=await import("../../queue/src/index");
  const store=new DurableJobStore(paths.queuePath),job=store.get(expired.jobId)!;
  expect({status:job.status,reason:job.cancelReason}).toEqual({status:"cancelled",reason:RETENTION_ENDED_NOTICE});
  const {ProjectService}=await import("../src/index");
  const {CostLedger,OperatorReviewQueue}=await import("../../operator/src/index");
  const {processNextJob}=await import("../../queue/src/worker");
  const ran=await processNextJob(store,paths.artifactRoot,{projects:new ProjectService(paths.statePath),ledger:new CostLedger(paths.costLedgerPath),reviewQueue:new OperatorReviewQueue(join(root,"reviews.json"))});
  expect(ran).toBeNull();
  expect(existsSync(join(paths.artifactRoot,expired.projectId))).toBe(false);
},120_000);

test("a project the sweep keeps keeps its queued render",async()=>{
  const kept=await queued();
  const {sweepExpiredProjects}=await import("../../../scripts/sweep-expired");
  expect(sweepExpiredProjects(Date.now())).toEqual([]);
  const {DurableJobStore}=await import("../../queue/src/index");
  expect(new DurableJobStore(paths.queuePath).get(kept.jobId)!.status).toBe("queued");
},120_000);
