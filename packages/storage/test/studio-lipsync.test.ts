/**
 * HV-022-23 -- the studio queues a voiced cut's ready lip-sync lines on the PostgreSQL ledger.
 *
 * Through the API's work-list route, with the operator's switch on and the closed fixture policy: every new pass
 * is held before any is admitted, against the film's limit, and each is then admitted by the ledger's own
 * lip-sync admission (`admitLipSync`), which reserves its hold in `hv_reservations`. Nothing is dispatched: no
 * worker runs and no key is present. PostgreSQL only; local artifacts.
 */
import {afterAll,beforeAll,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import {StudioDatabase} from "../src/database";
import {createApiServer,type ApiServer} from "../../api/src/server";
import {createPlacedLipSyncFixture,ownerLipSyncPass,LIPSYNC_POLICY} from "../../../test/fixtures/lipsync";
import {STUDIO_LIPSYNC_ENV} from "../../planner/src/lipsync-worklist";
import {DEFAULT_FILM_SPEND_CAP_USD} from "../../operator/src/film-budget";

const enabled=Boolean(process.env.HV_PG_ADMIN_URL&&process.env.HV_API_DATABASE_URL&&process.env.HV_WORKER_DATABASE_URL),pgtest=enabled?test:test.skip;
const keys=["HV_TOKEN_SECRET","HV_NARRATION","HV_ANIMATIC_CAPTIONS","HV_ANIMATIC_PROVIDER_POOL","HV_AUDIO_POLICY_FILE","HV_LIPSYNC_POLICY_FILE","HV_FILM_SPEND_CAP_USD",STUDIO_LIPSYNC_ENV],previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
let root:string,admin:StudioDatabase,server:ApiServer,small:ApiServer,f:Awaited<ReturnType<typeof createPlacedLipSyncFixture>>,owner:Awaited<ReturnType<typeof ownerLipSyncPass>>;
beforeAll(async()=>{if(!enabled)return;
  root=mkdtempSync(join(tmpdir(),"hv-studio-lipsync-pg-"));
  Object.assign(process.env,{HV_TOKEN_SECRET:"studio-lipsync-pg-secret-at-least-thirty-two-characters",HV_NARRATION:"1",HV_ANIMATIC_CAPTIONS:"0",HV_ANIMATIC_PROVIDER_POOL:'["mock"]'});delete process.env[STUDIO_LIPSYNC_ENV];delete process.env.HV_FILM_SPEND_CAP_USD;
  f=await createPlacedLipSyncFixture(root);owner=await ownerLipSyncPass(f,f.first,f.spoken[0]!.shotId,{x:40,y:30});
  process.env.HV_AUDIO_POLICY_FILE=join(root,"audio-policy.json");process.env.HV_LIPSYNC_POLICY_FILE=join(root,"lipsync-policy.json");
  admin=new StudioDatabase(process.env.HV_PG_ADMIN_URL!);await admin.migrate();
  await admin.sql`insert into hv_projects (id,body,created_at,delete_after) values (${f.project.id},${f.project}::jsonb,${f.project.createdAt},${f.project.deleteAfter})`;
  for(const j of [f.first,f.second,f.store.get(owner.id)!])await admin.sql`insert into hv_jobs (id,project_id,idempotency_key,stage,status,tier,body,lease_version) values (${j.id},${j.projectId},${j.idempotencyKey},${j.stage},${j.status},${j.tier},${j}::jsonb,${j.leaseVersion??0})`;
  const studio=()=>createApiServer({port:0,hostname:"127.0.0.1",storage:"postgres",databaseUrl:process.env.HV_API_DATABASE_URL,artifactRoot:f.artifacts,rateLimit:{api:{limit:10000,windowMs:60000}}});
  server=studio();
  // The same studio with a film limit below one pass's $5 hold.
  process.env.HV_FILM_SPEND_CAP_USD="4";try{small=studio();}finally{delete process.env.HV_FILM_SPEND_CAP_USD;}
},180000);
afterAll(async()=>{if(!enabled)return;await server?.stop(true);await small?.stop(true);
  const id=f?.project.id;if(id){await admin.sql`delete from hv_reservations where project_id=${id} or job_id in (select id from hv_jobs where project_id=${id})`;
    for(const table of ["hv_cost_events","hv_provider_attempts","hv_outbox","hv_operator_reviews","hv_artifacts","hv_jobs","hv_reviews"])await admin.sql.unsafe("delete from "+table+" where project_id=$1",[id]);await admin.sql`delete from hv_projects where id=${id}`;}
  await admin?.close();for(const [k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  if(root){if(!resolve(root).startsWith(resolve(tmpdir())+sep+"hv-studio-lipsync-pg-"))throw new Error("Unexpected test root");rmSync(root,{recursive:true,force:true});}
},60000);
const call=async(path:string,method="GET",body?:unknown,on=server)=>{const r=await fetch(new URL(path,on.url),{method,headers:{authorization:"Bearer "+f.owner.token,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json() as any};};
const route=()=>"/api/projects/"+f.project.id+"/lip-sync/"+f.second.id+"/work-list";
const holds=async()=>(await admin.sql`select job_id,stage,amount_usd from hv_reservations where job_id in (select id from hv_jobs where project_id=${f.project.id})`).map((r:any)=>({jobId:r.job_id,stage:r.stage,amountUsd:Number(r.amount_usd)}));
const lipJobs=async()=>(await admin.sql`select id,body from hv_jobs where project_id=${f.project.id} and stage='lip-sync'`).map((r:any)=>r.body) as any[];
const on=async<T>(run:()=>Promise<T>)=>{process.env[STUDIO_LIPSYNC_ENV]="1";try{return await run();}finally{delete process.env[STUDIO_LIPSYNC_ENV];}};

pgtest("switched off, the PostgreSQL studio knows no work list and holds nothing",async()=>{
  expect(await call(route())).toEqual({status:404,body:{error:"unknown lip-sync route"}});
  expect((await call(route(),"POST",{generationApproved:true,worklistRevision:"0".repeat(64)})).status).toBe(404);
  expect(await holds()).toEqual([]);expect((await lipJobs()).map(j=>j.id)).toEqual([owner.id]);
});

pgtest("every pass is held before any is admitted: a list past the film's limit is refused whole",async()=>{await on(async()=>{
  const view=await call(route(),"GET",undefined,small);expect(view.body.enabled).toBe(true);expect(view.body.newPasses).toBe(1);expect(view.body.newHeldUsd).toBe(5);
  const refused=await call(route(),"POST",{generationApproved:true,worklistRevision:view.body.workList.revision},small);
  expect(refused.status).toBe(429);expect(refused.body.reason).toBe("budget_exhausted");expect(refused.body.error).toContain("spending limit of $4.00");
  expect(await holds()).toEqual([]);expect((await lipJobs()).map(j=>j.id)).toEqual([owner.id]);
  // A stale or unapproved list is refused before anything is held.
  expect((await call(route(),"POST",{generationApproved:true,worklistRevision:"0".repeat(64)})).status).toBe(409);
  expect((await call(route(),"POST",{generationApproved:false,worklistRevision:view.body.workList.revision})).status).toBe(409);
  expect(await holds()).toEqual([]);
});},60000);

pgtest("the ready line is admitted once as the owner's own pass would be, with its hold reserved, even when two requests race",async()=>{await on(async()=>{
  const view=await call(route());expect(view.body.workList.items.map((i:any)=>[i.character,i.reason])).toEqual([["MARLA","ready"],["KEVIN","off-camera"],["MARLA","no-face-point"]]);
  // Two studio runs ask at once. The ledger admits the line under its fixed key once; the other answer reuses it and holds nothing.
  const both=await Promise.all([1,2].map(()=>call(route(),"POST",{generationApproved:true,worklistRevision:view.body.workList.revision})));
  const queued=both.find(r=>r.status===202)!,other=both.find(r=>r!==queued)!;
  expect(both.map(r=>r.status).sort()).toEqual([200,202]);
  expect(queued.body.admitted).toHaveLength(1);expect(queued.body.reused).toEqual([]);expect(queued.body.skipped).toEqual([]);expect(queued.body.heldUsd).toBe(5);expect(queued.body.actualUsd).toBeNull();
  const id=queued.body.admitted[0].jobId;
  expect(other.body.admitted).toEqual([]);expect(other.body.heldUsd).toBe(0);expect([...other.body.reused,...other.body.queued].map((q:any)=>q.jobId)).toEqual([id]);
  expect(both.reduce((sum,r)=>sum+r.body.heldUsd,0)).toBe(5);
  const job=(await lipJobs()).find(j=>j.id===id);
  expect(job.status).toBe("queued");expect(job.costCapUsd).toBe(LIPSYNC_POLICY.heldUsd);expect(job.budgetReservedUsd).toBe(LIPSYNC_POLICY.heldUsd);expect(job.idempotencyKey).toMatch(new RegExp("^"+f.project.id+":studio-lipsync-[a-f0-9]{48}$"));
  expect(job.lipSync.source.jobId).toBe(f.second.id);expect(job.lipSync.selection).toEqual(owner.lipSync!.selection);expect(job.lipSync.characterId).toBe(f.marla);expect(job.lipSync.policy.revision).toBe(LIPSYNC_POLICY.revision);
  expect(await holds()).toEqual([{jobId:id,stage:"lip-sync",amountUsd:5}]);
  // Asked again, nothing new is queued or held: the line now holds its pass.
  const again=await call(route(),"POST",{generationApproved:true,worklistRevision:view.body.workList.revision});
  expect(again.status).toBe(200);expect(again.body.admitted).toEqual([]);expect(again.body.heldUsd).toBe(0);expect(again.body.queued).toEqual([{shotId:f.spoken[0]!.shotId,lineIndex:0,jobId:id}]);
  expect((await call(route())).body.newPasses).toBe(0);expect(await holds()).toHaveLength(1);
  // The film's spend now counts it, under the unchanged default limit.
  const spend=await call("/api/projects/"+f.project.id+"/spend");expect(spend.body.heldUsd).toBe(5);expect(spend.body.capUsd).toBe(DEFAULT_FILM_SPEND_CAP_USD);
});},60000);

pgtest("a failed studio pass is the owner's to retry: the studio neither buys the line again nor claims a hold for it",async()=>{await on(async()=>{
  const [studio]=(await lipJobs()).filter(j=>j.id!==owner.id);expect(studio).toBeDefined();
  const stale=(await call(route())).body.workList.revision,before=await holds(),jobsBefore=(await lipJobs()).map(j=>j.id).sort();
  await admin.sql`update hv_jobs set status='failed',body=jsonb_set(jsonb_set(body,'{status}','"failed"'),'{failureReason}','"Fixture: the provider refused the pass."') where id=${studio.id}`;
  const view=await call(route());
  expect(view.body.workList.items.map((i:any)=>[i.character,i.reason])).toEqual([["MARLA","failed-pass"],["KEVIN","off-camera"],["MARLA","no-face-point"]]);
  expect(view.body.failed).toEqual([{shotId:f.spoken[0]!.shotId,lineIndex:0,jobId:studio.id,status:"failed"}]);expect(view.body.queued).toEqual([]);
  expect(view.body.newPasses).toBe(0);expect(view.body.newHeldUsd).toBe(0);expect(view.body.workList.revision).not.toBe(stale);
  // The list it was queued from is stale; the current one admits nothing and claims no hold.
  expect((await call(route(),"POST",{generationApproved:true,worklistRevision:stale})).status).toBe(409);
  const again=await call(route(),"POST",{generationApproved:true,worklistRevision:view.body.workList.revision});
  expect(again.status).toBe(200);expect(again.body.admitted).toEqual([]);expect(again.body.reused).toEqual([]);expect(again.body.heldUsd).toBe(0);
  expect(await holds()).toEqual(before);expect((await lipJobs()).map(j=>j.id).sort()).toEqual(jobsBefore);
});},60000);
