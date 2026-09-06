import {readFileSync} from "node:fs";
import {normalizeReference,ReferenceBlobStore} from "../src/references";
import {DeterministicMockImageProvider} from "../../generator/src/image";
import {withAnchorStoryboard} from "../../generator/src/catalog";
import {referenceFal} from "../../../test/fixtures/reference-fal";
import {afterAll,beforeAll,expect,test} from "bun:test";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {StudioDatabase} from "../src/database";
import {PostgresProjectService} from "../src/projects";
import {PostgresCostLedger} from "../src/ledger";
import {PostgresJobStore} from "../src/jobs";
import {PostgresReviewQueue} from "../src/reviews";
import {planShots} from "../../planner/src/index";
import {parseFountain} from "../../parser/src/index";
import {currentDirection,directionEntry,type DirectionSnapshot} from "../../planner/src/direction";
import {createProviderPlan} from "../../generator/src/catalog";
import {processNextJob} from "../../queue/src/worker";
import type {JobInput} from "../../queue/src/index";
import {DeterministicMockProvider} from "../../generator/src/index";
const enabled=Boolean(process.env.HV_PG_ADMIN_URL&&process.env.HV_API_DATABASE_URL&&process.env.HV_WORKER_DATABASE_URL),pgtest=enabled?test:test.skip;
const SCRIPT="EXT. GARDEN - DAY\n\nSpud waves.\n\nSPUD\nWelcome home. We have so many stories to share and a wonderful evening ahead of us.";
let admin:StudioDatabase,api:StudioDatabase,worker:StudioDatabase,projects:PostgresProjectService,ledger:PostgresCostLedger,jobs:PostgresJobStore,previousCap:string|null;
const ids:string[]=[];
beforeAll(async()=>{if(!enabled)return;process.env.HV_TOKEN_SECRET="direction-postgres-fixture-secret-at-least-thirty-two-characters";
  admin=new StudioDatabase(process.env.HV_PG_ADMIN_URL!);await admin.migrate();api=new StudioDatabase(process.env.HV_API_DATABASE_URL!);worker=new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!);
  projects=new PostgresProjectService(api);ledger=new PostgresCostLedger(worker);jobs=new PostgresJobStore(worker);previousCap=(await admin.sql`select monthly_cap_usd from hv_budget_accounts where id='operator'`)[0]?.monthly_cap_usd??null;
});
afterAll(async()=>{if(!enabled)return;for(const id of ids){await admin.sql`delete from hv_reservations where job_id in (select id from hv_jobs where project_id=${id})`;for(const table of ["hv_cost_events","hv_provider_attempts","hv_outbox","hv_jobs","hv_reviews"])await admin.sql.unsafe("delete from "+table+" where project_id=$1",[id]);await admin.sql`delete from hv_projects where id=${id}`;}
  if(previousCap===null)await admin.sql`delete from hv_budget_accounts where id='operator'`;else await admin.sql`update hv_budget_accounts set monthly_cap_usd=${previousCap} where id='operator'`;
  await Promise.all([admin.close(),api.close(),worker.close()]);
});
async function owner(){const value=await projects.createAnonymousProject();ids.push(value.projectId);await projects.editScript(value.token,SCRIPT);await projects.attestRights(value.token);return value;}
const source=()=>directionEntry(planShots(parseFountain(SCRIPT),7000,24)[0]!,{});
async function save(user:Awaited<ReturnType<typeof owner>>,version:number,settings:unknown={lensMm:85,coverage:{role:"master",subjects:["SPUD"],axis:"garden",cameraSide:"a"}}){return (await projects.saveShotDirection(user.token,"shot-1-1",settings,version,1,source().sourceHash))!;}
function input(projectId:string,direction:DirectionSnapshot):JobInput {const id=crypto.randomUUID();return {id,projectId,idempotencyKey:id,tier:"free",stage:"animatic",scriptVersion:1,scriptText:SCRIPT,direction,rightsAttestedAt:new Date().toISOString(),animaticJobId:null,animaticApprovedAt:null,totalFrames:60,costCapUsd:1,budgetReservedUsd:0,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:60000};}
pgtest("concurrent direction saves have one winner under hv_api RLS and preserve script, rights and isolation",async()=>{
  const a=await owner(),b=await owner(),results=await Promise.allSettled([save(a,0),save(a,0,{lensMm:35})]);
  expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);expect(results.filter(result=>result.status==="rejected")).toHaveLength(1);
  const project=(await projects.authorize(a.token))!;expect(project.directionHistory).toHaveLength(1);expect(project.versions.latest()!.text).toBe(SCRIPT);expect(project.rightsAttestedAt).toBeTruthy();expect((await projects.authorize(b.token))!.directionHistory).toHaveLength(0);
  await api.forProject(b.projectId,async tx=>expect(await tx`select id from hv_projects where id=${a.projectId}`).toHaveLength(0));
  const role=(await api.sql`select rolbypassrls from pg_roles where rolname=current_user`)[0];expect(role.rolbypassrls).toBe(false);
});
pgtest("admission and approval recheck the current direction while holding the project lock",async()=>{
  const user=await owner(),first=await save(user,0),preview=input(user.projectId,first);await ledger.admit(user.projectId,preview,500);await jobs.setStatus(preview.id,"done");
  const approved=await projects.recordAnimaticDecision(user.projectId,preview.id,1,"approved","",Date.now(),undefined,first);expect(approved!.directionRevision).toBe(first.revision);
  const second=await save(user,1,{lensMm:35});expect(await projects.recordAnimaticDecision(user.projectId,preview.id,1,"approved","",Date.now(),undefined,first)).toBeNull();
  const stale=input(user.projectId,first);await expect(ledger.admit(user.projectId,stale,500)).rejects.toThrow("directions changed");expect(await jobs.get(stale.id)).toBeUndefined();
  const final={...input(user.projectId,second),stage:"final" as const,animaticJobId:preview.id,animaticApprovedAt:approved!.at};await expect(ledger.admit(user.projectId,final,500)).rejects.toThrow("current shot directions");expect(await jobs.get(final.id)).toBeUndefined();
  await projects.editScript(user.token,SCRIPT.replace("waves","leaves"));const current=(await projects.authorize(user.token))!;
  expect(currentDirection(user.projectId,current.directionHistory)).toEqual(second);
  await expect(projects.saveShotDirection(user.token,"shot-1-1",{},2,1,source().sourceHash)).rejects.toThrow("screenplay changed");
});
pgtest("fixed-duration speech refusal makes no image request, stops retries and releases paid PostgreSQL holds",async()=>{
  const user=await owner(),direction=await save(user,0,{durationFrames:30,previewMove:"static"}),root=mkdtempSync(join(tmpdir(),"hv-direction-speech-"));
  const config={HV_ANIMATIC_PROVIDER_POOL:'["image:fal:flux-schnell"]',HV_NARRATION:"1",HV_ANIMATIC_CAPTIONS:"0",FAL_KEY:"direction-speech-closed-fixture-only"},original=Object.fromEntries(Object.keys(config).map(key=>[key,process.env[key]]));
  const realFetch=globalThis.fetch;let requests=0;
  try{Object.assign(process.env,config);globalThis.fetch=(async()=>{requests++;throw new Error("Unexpected provider HTTP request in a preflight-refusal fixture.");}) as unknown as typeof fetch;
    const queued={...input(user.projectId,direction),totalFrames:30,budgetReservedUsd:1,providerPlan:createProviderPlan("animatic",1),retryPolicy:{maxRetries:2,backoffMs:0}};
    await ledger.admit(user.projectId,queued,500);const job=await processNextJob(jobs,root,{ledger,reviewQueue:new PostgresReviewQueue(worker)});
    expect(job?.id).toBe(queued.id);expect(job?.status).toBe("cancelled");expect(job?.cancelReason).toContain("selected shot duration");expect(job?.retriesUsed).toBe(0);expect(requests).toBe(0);
    const attempts=await admin.sql`select status,estimated_usd from hv_provider_attempts where job_id=${queued.id}`;expect(attempts).toHaveLength(1);expect(attempts[0].status).toBe("failed");expect(Number(attempts[0].estimated_usd)).toBeGreaterThan(0);
    expect(await admin.sql`select job_id from hv_reservations where job_id=${queued.id}`).toHaveLength(0);expect(await admin.sql`select id from hv_cost_events where job_id=${queued.id}`).toHaveLength(0);
  }finally{globalThis.fetch=realFetch;for(const [key,value]of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}rmSync(root,{recursive:true,force:true});}
},15000);
pgtest("local framing failure settles a paid PostgreSQL attempt once, releases the hold and cancels retries",async()=>{
  const user=await owner(),direction=await save(user,0,{durationFrames:30,framing:{x:5000,y:2500,size:5000}}),root=mkdtempSync(join(tmpdir(),"hv-direction-framing-"));
  const paid=new DeterministicMockProvider({costPerShotUsd:.03}),backup=new DeterministicMockProvider({costPerShotUsd:.04});let calls=0,fallbacks=0;
  const primary={name:paid.name,model:paid.model,capabilities:paid.capabilities,generate:async(...args:Parameters<typeof paid.generate>)=>{calls++;const clip=await paid.generate(...args);writeFileSync(clip.path,"unreadable returned video");return clip;}};
  const secondary={name:backup.name,model:backup.model,capabilities:backup.capabilities,generate:async(...args:Parameters<typeof backup.generate>)=>{fallbacks++;return backup.generate(...args);}};
  try{const queued={...input(user.projectId,direction),totalFrames:30,budgetReservedUsd:1,retryPolicy:{maxRetries:2,backoffMs:0}};await ledger.admit(user.projectId,queued,500);
    const job=await processNextJob(jobs,root,{ledger,primary,secondary,reviewQueue:new PostgresReviewQueue(worker)});
    expect(job?.id).toBe(queued.id);expect(job?.status).toBe("cancelled");expect(job?.cancelReason).toContain("Local framing failed");expect(job?.retriesUsed).toBe(0);expect([calls,fallbacks]).toEqual([1,0]);
    const attempts=await admin.sql`select status,estimated_usd,actual_usd from hv_provider_attempts where job_id=${queued.id}`;expect(attempts).toHaveLength(1);expect(attempts[0].status).toBe("failed");expect(Number(attempts[0].estimated_usd)).toBe(.03);expect(Number(attempts[0].actual_usd)).toBe(.03);
    const events=await admin.sql`select total_usd from hv_cost_events where job_id=${queued.id}`;expect(events).toHaveLength(1);expect(Number(events[0].total_usd)).toBe(.03);expect(await ledger.jobSpend(queued.id)).toBe(.03);
    expect(await admin.sql`select job_id from hv_reservations where job_id=${queued.id}`).toHaveLength(0);
  }finally{rmSync(root,{recursive:true,force:true});}
},15000);

pgtest("anchor uploads remain source-bound under RLS and a completed native failure settles its known bill without retries",async()=>{
  const user=await owner(),root=mkdtempSync(join(tmpdir(),"hv-anchor-pg-")),references=new ReferenceBlobStore(root);
  const config={HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_PROVIDER_POOL:'["mock","fal:kling-o3-standard-keyframes"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0",FAL_KEY:"anchor-pg-closed-fixture-only"},original=Object.fromEntries(Object.keys(config).map(k=>[k,process.env[k]])),realFetch=globalThis.fetch;
  try{Object.assign(process.env,config);
    const image=await new DeterministicMockImageProvider().generateFrame("A fictional garden",1,{},join(root,"source.png")),normalized=await normalizeReference(readFileSync(image.path),user.projectId);
    normalized.asset.source={kind:"shot-anchor",shotId:"shot-1-1",sourceHash:source().sourceHash,label:"Garden"};await references.put(normalized.asset,normalized.data);
    expect(await projects.storeFrameAnchorAsset(user.token,normalized.asset,0,1)).toEqual(normalized.asset);
    expect((await projects.authorize(user.token))!.directionHistory).toEqual([]);
    const direction=await save(user,0,{durationFrames:121,frameAnchors:{frames:[{at:0,asset:normalized.asset},{at:10000,asset:normalized.asset}],fallback:"storyboard"}});
    await expect(projects.storeFrameAnchorAsset(user.token,{...normalized.asset,id:crypto.randomUUID()},0,1)).rejects.toThrow("directions changed");
    const queued={...input(user.projectId,direction),totalFrames:121,providerPlan:withAnchorStoryboard(createProviderPlan("animatic",1),true)};
    await ledger.admit(user.projectId,queued,500);const preview=await processNextJob(jobs,root,{ledger,references,reviewQueue:new PostgresReviewQueue(worker)});
    expect(preview?.failureReason??preview?.cancelReason).toBeUndefined();expect(preview?.id).toBe(queued.id);expect(preview?.status).toBe("done");
    const approval=(await projects.recordAnimaticDecision(user.projectId,preview!.id,1,"approved","",Date.now(),undefined,direction))!;
    const final={...input(user.projectId,direction),stage:"final" as const,totalFrames:121,animaticJobId:preview!.id,animaticApprovedAt:approval.at,budgetReservedUsd:1,providerPlan:withAnchorStoryboard(createProviderPlan("final",1),true),retryPolicy:{maxRetries:2,backoffMs:0}};
    const http=referenceFal(normalized.data,Buffer.from("unusable completed native video"));globalThis.fetch=http.fetchImpl;
    await ledger.admit(user.projectId,final,500);const result=await processNextJob(jobs,root,{ledger,references,reviewQueue:new PostgresReviewQueue(worker)});
    expect(result?.id).toBe(final.id);expect(result?.status).toBe("cancelled");expect(result?.retriesUsed).toBe(0);expect(http.submissions).toHaveLength(1);
    const attempts=await admin.sql`select status,actual_usd from hv_provider_attempts where job_id=${final.id}`;expect(attempts).toHaveLength(1);expect(attempts[0].status).toBe("failed");expect(Number(attempts[0].actual_usd)).toBe(.42);
    expect(await ledger.jobSpend(final.id)).toBe(.42);expect(await admin.sql`select job_id from hv_reservations where job_id=${final.id}`).toHaveLength(0);
  }finally{globalThis.fetch=realFetch;for(const [k,v]of Object.entries(original)){if(v===undefined)delete process.env[k];else process.env[k]=v;}rmSync(root,{recursive:true,force:true});}
},15000);
