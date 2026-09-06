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
import {currentCasting} from "../../planner/src/casting";
import {createShotTakes} from "../../planner/src/takes";
import {createReusePlan} from "../../planner/src/shot-reuse";
const enabled=Boolean(process.env.HV_PG_ADMIN_URL&&process.env.HV_API_DATABASE_URL&&process.env.HV_WORKER_DATABASE_URL),pgtest=enabled?test:test.skip;
const SCRIPT="EXT. GARDEN - DAY\n\nSpud waves.\n\nSPUD\nWelcome home. We have so many stories to share and a wonderful evening ahead of us.";
let admin:StudioDatabase,api:StudioDatabase,worker:StudioDatabase,projects:PostgresProjectService,ledger:PostgresCostLedger,jobs:PostgresJobStore,previousCap:string|null;
const ids:string[]=[];
pgtest("scene coverage acceptance serializes concurrent owners and binds admission to the accepted cut",async()=>{
  const a=await owner(),b=await owner(),proposal=(await projects.reviewSceneCut(a.token,{sceneIndex:0,maxShots:24}))!;
  await expect(projects.acceptSceneCut(b.token,proposal.proposal,[])).rejects.toThrow("changed");
  const results=await Promise.allSettled([projects.acceptSceneCut(a.token,proposal.proposal,[]),projects.acceptSceneCut(a.token,proposal.proposal,[])]);
  expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
  const project=(await projects.authorize(a.token))!,direction=currentDirection(a.projectId,project.directionHistory);expect(direction.sceneCuts).toEqual([proposal.proposal.cut!]);
  await api.forProject(b.projectId,async tx=>expect(await tx`select body from hv_projects where id=${a.projectId}`).toHaveLength(0));
  const admission=new PostgresCostLedger(api),queued=input(a.projectId,direction);await admission.admit(a.projectId,queued,500);
  const next=(await projects.reviewSceneCut(a.token,{sceneIndex:0,maxShots:24,remove:true}))!;await projects.acceptSceneCut(a.token,next.proposal,[]);
  const stale=input(a.projectId,direction);await expect(admission.admit(a.projectId,stale,500)).rejects.toThrow("directions changed");expect(await jobs.get(stale.id)).toBeUndefined();
  await jobs.setStatus(queued.id,"cancelled");await ledger.release(queued.id);
});
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
pgtest("concurrent movement saves use the project lock, retain ownership and preserve film direction",async()=>{
  const a=await owner(),b=await owner(),root=mkdtempSync(join(tmpdir(),"hv-motion-pg-"));
  try{
    const image=await new DeterministicMockImageProvider().generateFrame("A garden",7,{},join(root,"source.png")),normalized=await normalizeReference(readFileSync(image.path),a.projectId,Date.now(),new AbortController().signal,"motion-landscape");
    normalized.asset.source={kind:"shot-anchor",shotId:"shot-1-1",sourceHash:source().sourceHash,label:"Movement source"};await projects.storeFrameAnchorAsset(a.token,normalized.asset,0,1);
    const project=(await projects.authorize(a.token))!,expected={version:0,scriptVersion:1,directionVersion:0,castingRevision:currentCasting(a.projectId,project.castingHistory).revision},input={sourceHash:source().sourceHash,maxShots:24,assetId:normalized.asset.id,appearance:"source-image",prompt:"A leaf moves right.",seed:7,links:[],subjects:[{id:"leaf",label:"Leaf",tracks:[{id:"center",keyframes:[0,80].map((frame,i)=>({frame,x:2500+i*5000,y:5000,easing:"linear",visible:true}))}]}]};
    const results=await Promise.allSettled([projects.saveMotionStudy(a.token,"shot-1-1",input,expected),projects.saveMotionStudy(a.token,"shot-1-1",input,expected)]);
    expect(results.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(results.filter(r=>r.status==="rejected")).toHaveLength(1);
    const saved=(await projects.authorize(a.token))!,study=saved.motionStudies.studies[0]!;expect(saved.motionStudies.version).toBe(1);expect(saved.directionHistory).toEqual([]);
    expect(await projects.currentMotionStudy(a.token,"shot-1-1",study.revision)).toEqual(study);await expect(projects.currentMotionStudy(b.token,"shot-1-1",study.revision)).rejects.toThrow("changed");
    expect((await projects.authorize(b.token))!.motionStudies.studies).toEqual([]);await projects.editScript(a.token,SCRIPT+"\n\nThe light fades.");await expect(projects.currentMotionStudy(a.token,"shot-1-1",study.revision)).rejects.toThrow("changed");
  }finally{rmSync(root,{recursive:true,force:true});}
});
pgtest("selective admission uses current project direction and isolates reusable source jobs under RLS",async()=>{
  const a=await owner(),b=await owner(),root=mkdtempSync(join(tmpdir(),"hv-reuse-pg-")),script="EXT. GARDEN - DAY\n\nA gate opens.\n\nA lamp glows.",admission=new PostgresCostLedger(api);
  const config={HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0"},original=Object.fromEntries(Object.keys(config).map(k=>[k,process.env[k]]));
  try{Object.assign(process.env,config);await projects.editScript(a.token,script);const project=(await projects.authorize(a.token))!,direction=currentDirection(a.projectId,project.directionHistory),casting=currentCasting(a.projectId,project.castingHistory);
    const fresh={...input(a.projectId,direction),scriptVersion:2,scriptText:script,casting,providerPlan:createProviderPlan("animatic",1),totalFrames:120,costCapUsd:2};await admission.admit(a.projectId,fresh,500);
    const run=()=>processNextJob(jobs,root,{ledger,reviewQueue:new PostgresReviewQueue(worker)}),first=await run();expect(first?.failureReason??first?.cancelReason).toBeUndefined();expect(first?.status).toBe("done");
    const id=crypto.randomUUID(),old={...fresh,id,idempotencyKey:id,shotReuse:createReusePlan(first!,[first!])};expect(old.shotReuse.shots).toHaveLength(2);
    await api.forProject(b.projectId,async tx=>expect(await tx`select body from hv_jobs where id=${first!.id}`).toHaveLength(0));
    const entry=directionEntry(planShots(parseFountain(script),7000,24)[0]!,{}),changed=(await projects.saveShotDirection(a.token,"shot-1-1",{lensMm:85},0,2,entry.sourceHash))!;
    await expect(admission.admit(a.projectId,old,500)).rejects.toThrow("directions changed");
    const next={...old,direction:changed};next.shotReuse=createReusePlan(next,[first!]);expect(next.shotReuse.shots.map(r=>r.shotId)).toEqual(["shot-1-2"]);await admission.admit(a.projectId,next,500);
    const completed=await run();expect(completed?.failureReason??completed?.cancelReason).toBeUndefined();expect(completed?.status).toBe("done");expect(completed!.output!.shotRenders!.filter(r=>r.reusedFrom)).toHaveLength(1);
    expect(await admin.sql`select id from hv_provider_attempts where job_id=${completed!.id} and shot_id='shot-1-2'`).toHaveLength(0);expect(await ledger.jobSpend(completed!.id)).toBe(0);
  }finally{for(const [k,v]of Object.entries(original)){if(v===undefined)delete process.env[k];else process.env[k]=v;}rmSync(root,{recursive:true,force:true});}
},20000);
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

pgtest("take stages require their exact approved plan, dispatch each private native anchor, account per take and serialize adoption",async()=>{
  const user=await owner(),root=mkdtempSync(join(tmpdir(),"hv-takes-pg-")),references=new ReferenceBlobStore(root);
  const config={HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_PROVIDER_POOL:'["fal:kling-o3-standard-keyframes"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0",FAL_KEY:"take-pg-closed-fixture-only"},old=Object.fromEntries(Object.keys(config).map(k=>[k,process.env[k]])),realFetch=globalThis.fetch;
  try{Object.assign(process.env,config);
    const image=await new DeterministicMockImageProvider().generateFrame("Fictional garden",1,{},join(root,"image.png")),normalized=await normalizeReference(readFileSync(image.path),user.projectId);
    normalized.asset.source={kind:"shot-anchor",shotId:"shot-1-1",sourceHash:source().sourceHash,label:"Garden take"};await references.put(normalized.asset,normalized.data);await projects.storeFrameAnchorAsset(user.token,normalized.asset,0,1);
    const direction=await save(user,0,{durationFrames:90,frameAnchors:{frames:[{at:0,asset:normalized.asset}],fallback:"stop"}}),casting=currentCasting(user.projectId,(await projects.authorize(user.token))!.castingHistory);
    const settings={shotId:"shot-1-1",sourceHash:source().sourceHash,maxShots:24,takes:[35,85].map((lensMm,i)=>({label:"Take "+"AB"[i],seed:8000+i,settings:{lensMm}}))},shotTakes=createShotTakes(user.projectId,1,casting,direction,parseFountain(SCRIPT),settings);
    const queued={...input(user.projectId,direction),casting,shotTakes,stage:"take-preview" as const,totalFrames:180,providerPlan:withAnchorStoryboard(createProviderPlan("animatic",.5),true)};
    await expect(ledger.admit(user.projectId,{...queued,stage:"animatic"},500)).rejects.toThrow("take-group");
    await ledger.admit(user.projectId,queued,500);const preview=await processNextJob(jobs,root,{ledger,references,reviewQueue:new PostgresReviewQueue(worker)});
    expect(preview?.id).toBe(queued.id);expect(preview?.failureReason??preview?.cancelReason).toBeUndefined();expect(preview?.status).toBe("done");expect(preview!.output!.takeClips!.map(c=>c.mode)).toEqual(["storyboard","storyboard"]);
    const approval=(await projects.recordAnimaticDecision(user.projectId,queued.id,1,"approved","",Date.now(),casting,direction,shotTakes))!;
    const final={...input(user.projectId,direction),casting,shotTakes,stage:"take-final" as const,totalFrames:180,animaticJobId:queued.id,animaticApprovedAt:approval.at,budgetReservedUsd:1,providerPlan:createProviderPlan("final",.5)};
    const altered=createShotTakes(user.projectId,1,casting,direction,parseFountain(SCRIPT),{...settings,takes:settings.takes.map(t=>({...t,seed:t.seed+1}))});
    await expect(ledger.admit(user.projectId,{...final,shotTakes:altered},500)).rejects.toThrow("exact take group");
    const video=await new DeterministicMockProvider().generate("Fictional garden",8000,{seed:8000,durationSec:3,widthxheight:"1280x720"},join(root,"native.mp4"));
    const http=referenceFal(normalized.data,readFileSync(video.path));globalThis.fetch=http.fetchImpl;
    await ledger.admit(user.projectId,final,500);const rendered=await processNextJob(jobs,root,{ledger,references,reviewQueue:new PostgresReviewQueue(worker)});
    expect(rendered?.id).toBe(final.id);expect(rendered?.failureReason??rendered?.cancelReason).toBeUndefined();expect(rendered?.status).toBe("done");expect(http.submissions).toHaveLength(2);
    expect(rendered!.output!.takeClips!.map(c=>c.mode)).toEqual(["video","video"]);expect(rendered!.output!.takeClips!.map(c=>c.costUsd)).toEqual([.252,.252]);expect(await ledger.shotSpend(final.id,"take-a")).toBe(.252);expect(await ledger.jobSpend(final.id)).toBe(.504);
    const attempts=await admin.sql`select status from hv_provider_attempts where job_id=${final.id}`;expect(attempts).toHaveLength(2);expect(attempts.every((a:{status:string})=>a.status==="succeeded")).toBe(true);expect(await admin.sql`select job_id from hv_reservations where job_id=${final.id}`).toHaveLength(0);
    const adoption=await Promise.allSettled([projects.adoptShotTake(user.token,shotTakes,"take-a",1,1),projects.adoptShotTake(user.token,shotTakes,"take-b",1,1)]);
    expect(adoption.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(adoption.filter(r=>r.status==="rejected")).toHaveLength(1);
    expect(currentDirection(user.projectId,(await projects.authorize(user.token))!.directionHistory).version).toBe(2);
    expect(await projects.recordAnimaticDecision(user.projectId,queued.id,1,"approved","",Date.now(),casting,direction,shotTakes)).toBeNull();
  }finally{globalThis.fetch=realFetch;for(const [k,v]of Object.entries(old)){if(v===undefined)delete process.env[k];else process.env[k]=v;}rmSync(root,{recursive:true,force:true});}
},30000);
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
    expect(result?.failureReason).toBeUndefined();
    expect(result?.id).toBe(final.id);expect(result?.status).toBe("cancelled");expect(result?.retriesUsed).toBe(0);expect(http.submissions).toHaveLength(1);
    const attempts=await admin.sql`select status,actual_usd from hv_provider_attempts where job_id=${final.id}`;expect(attempts).toHaveLength(1);expect(attempts[0].status).toBe("failed");expect(Number(attempts[0].actual_usd)).toBe(.42);
    expect(await ledger.jobSpend(final.id)).toBe(.42);expect(await admin.sql`select job_id from hv_reservations where job_id=${final.id}`).toHaveLength(0);
  }finally{globalThis.fetch=realFetch;for(const [k,v]of Object.entries(original)){if(v===undefined)delete process.env[k];else process.env[k]=v;}rmSync(root,{recursive:true,force:true});}
},15000);
