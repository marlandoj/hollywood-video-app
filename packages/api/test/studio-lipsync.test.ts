import {afterAll,beforeAll,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import {createApiServer,type ApiServer} from "../src/server";
import {createPlacedLipSyncFixture,ownerLipSyncPass,lipFixtureJob,LIPSYNC_POLICY} from "../../../test/fixtures/lipsync";
import {DurableJobStore} from "../../queue/src/index";
import {createLipSyncPlan,retainLipSyncSource} from "../../planner/src/lipsync";
import {previewLipSyncFrame} from "../../generator/src/lipsync-media";
import {contentHash} from "../../generator/src/capabilities";
import {STUDIO_LIPSYNC_ENV} from "../../planner/src/lipsync-worklist";
import {faceDetectionPolicy,FACE_DETECTION_POLICY_ENV} from "../../planner/src/face-detection";
import {FalFaceDetector} from "../../generator/src/fal-face-detection";

/**
 * HV-022-23: the studio's lip-sync work list through the API, on the file store. Off, the route and every view are as
 * before. On, with no policy or no PostgreSQL provider service, it lists and refuses to queue, holding nothing.
 * Queueing with a policy and PostgreSQL is in packages/storage/test/studio-lipsync.test.ts.
 */
const root=mkdtempSync(join(tmpdir(),"hv-studio-lipsync-api-")),keys=["HV_TOKEN_SECRET","HV_NARRATION","HV_ANIMATIC_CAPTIONS","HV_ANIMATIC_PROVIDER_POOL","HV_AUDIO_POLICY_FILE","HV_LIPSYNC_POLICY_FILE",STUDIO_LIPSYNC_ENV],previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
let f:Awaited<ReturnType<typeof createPlacedLipSyncFixture>>,pass:Awaited<ReturnType<typeof ownerLipSyncPass>>,server:ApiServer,stranger:{projectId:string;token:string},foreign:string;
beforeAll(async()=>{
  Object.assign(process.env,{HV_TOKEN_SECRET:"studio-lipsync-api-secret-at-least-thirty-two-characters",HV_NARRATION:"1",HV_ANIMATIC_CAPTIONS:"0",HV_ANIMATIC_PROVIDER_POOL:'["mock"]'});delete process.env[STUDIO_LIPSYNC_ENV];delete process.env.HV_LIPSYNC_POLICY_FILE;
  f=await createPlacedLipSyncFixture(root);process.env.HV_AUDIO_POLICY_FILE=join(root,"audio-policy.json");pass=await ownerLipSyncPass(f,f.first,f.spoken[0]!.shotId);
  // Another owner's project, holding a face point on this very picture, newer than the owner's and elsewhere on the frame.
  const other=f.projects.createAnonymousProject();stranger={projectId:other.projectId,token:other.token};
  const retained=retainLipSyncSource(f.first),preview=await previewLipSyncFrame(retained,f.artifacts,f.spoken[0]!.shotId,0,0);
  const plan=createLipSyncPlan(retained,f.spoken[0]!.shotId,0,{frame:0,width:preview.width,height:preview.height,x:10,y:10,rgbSha256:preview.rgbSha256},LIPSYNC_POLICY,"local",contentHash({stranger:1}),Date.now()+60000);
  const job={...new DurableJobStore(null).enqueue(lipFixtureJob(plan)),projectId:other.projectId};foreign=job.id;
  writeFileSync(join(root,"jobs.json"),JSON.stringify([...JSON.parse(readFileSync(join(root,"jobs.json"),"utf8")),job]));
  server=createApiServer({port:0,hostname:"127.0.0.1",queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),costLedgerPath:join(root,"ledger.json"),artifactRoot:f.artifacts,rateLimit:{api:{limit:10000,windowMs:60000}}});
},120000);
afterAll(async()=>{await server?.stop(true);for(const [k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}if(!resolve(root).startsWith(resolve(tmpdir())+sep+"hv-studio-lipsync-api-"))throw new Error("Unexpected fixture root");rmSync(root,{recursive:true,force:true});});
const call=async(path:string,method="GET",body?:unknown,token=f.owner.token)=>{const r=await fetch(new URL(path,server.url),{method,headers:{authorization:"Bearer "+token,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json() as any};};
const base=()=>"/api/projects/"+f.project.id+"/lip-sync";
const jobs=()=>JSON.parse(readFileSync(join(root,"jobs.json"),"utf8"));
const ledger=()=>{try{return readFileSync(join(root,"ledger.json"),"utf8");}catch{return null;}};
// A view's media links are signed per request, and its seconds-to-expiry count down with the clock, so two reads a
// second boundary apart differ there (the absolute artifactUrlsExpireAt is still compared); everything else exactly.
const stable=(value:unknown)=>contentHash(JSON.parse(JSON.stringify(value).replace(/\/artifacts\/[^/"]+\//g,"/artifacts/signed/").replace(/"artifactUrlsExpireInSeconds":\d+/g,'"artifactUrlsExpireInSeconds":"counting"')));
const switched=async<T>(value:string|undefined,run:()=>Promise<T>)=>{if(value===undefined)delete process.env[STUDIO_LIPSYNC_ENV];else process.env[STUDIO_LIPSYNC_ENV]=value;try{return await run();}finally{delete process.env[STUDIO_LIPSYNC_ENV];}};

test("switched off, the work list is an unknown route and every view hashes as before",async()=>{
  const unknown=await call(base()+"/"+f.second.id+"/no-such-route");expect(unknown).toEqual({status:404,body:{error:"unknown lip-sync route"}});
  for(const value of [undefined,"0","true"])await switched(value,async()=>{
    expect(await call(base()+"/"+f.second.id+"/work-list")).toEqual(unknown);
    expect(await call(base()+"/"+f.second.id+"/work-list","POST",{generationApproved:true,worklistRevision:"0".repeat(64)})).toEqual(unknown);
  });
  const off=await switched(undefined,()=>call("/api/jobs/"+f.second.id)),zero=await switched("0",()=>call("/api/jobs/"+f.second.id)),on=await switched("1",()=>call("/api/jobs/"+f.second.id));
  expect(off.body.studioLipSync).toBeUndefined();expect(stable(zero.body)).toBe(stable(off.body));
  // On, a finished voiced cut says so and nothing else changes.
  const {studioLipSync,...rest}=on.body;expect(studioLipSync).toBe(true);expect(stable(rest)).toBe(stable(off.body));
  // Only a voiced cut says so: the film and the owner's pass are as they were.
  for(const id of [f.film.id,pass.id]){
    const a=await switched(undefined,()=>call("/api/jobs/"+id)),b=await switched("1",()=>call("/api/jobs/"+id));expect(b.body.studioLipSync).toBeUndefined();expect(stable(b.body)).toBe(stable(a.body));
  }
  // The lip-sync catalogue is the same either way.
  const catalogue=await switched(undefined,()=>call(base())),again=await switched("1",()=>call(base()));expect(stable(again.body)).toBe(stable(catalogue.body));
},60000);

test("switched on with no policy, the list holds nothing and queueing is refused with no job or hold",async()=>{
  await switched("1",async()=>{
    const before=JSON.stringify(jobs()),held=ledger(),view=await call(base()+"/"+f.second.id+"/work-list");
    expect(view.status).toBe(200);expect(view.body.enabled).toBe(false);expect(view.body.unavailable).toContain("no current provider policy");
    expect(view.body.workList.items.map((i:any)=>[i.character,i.reason])).toEqual([["MARLA","ready"],["KEVIN","off-camera"],["MARLA","no-face-point"]]);
    expect(view.body.workList.heldUsd).toBeNull();expect(view.body.newHeldUsd).toBeNull();expect(view.body.newPasses).toBe(1);
    const refused=await call(base()+"/"+f.second.id+"/work-list","POST",{generationApproved:true,worklistRevision:view.body.workList.revision});
    // With no policy there is no hold to approve: the answer is that nothing can be queued at all.
    expect(refused.status).toBe(503);expect((await call(base()+"/"+f.second.id+"/work-list","POST",{generationApproved:true,worklistRevision:view.body.workList.revision,holdApprovedUsd:5})).status).toBe(503);expect(refused.body.error).toContain("Nothing is queued or held");
    expect(JSON.stringify(jobs())).toBe(before);expect(ledger()).toBe(held);
  });
},60000);

test("switched on with a policy but no PostgreSQL provider service, the list is priced and queueing is still refused",async()=>{
  process.env.HV_LIPSYNC_POLICY_FILE=join(root,"lipsync-policy.json");
  try{await switched("1",async()=>{
    const before=JSON.stringify(jobs()),held=ledger(),view=await call(base()+"/"+f.second.id+"/work-list");
    expect(view.body.enabled).toBe(false);expect(view.body.unavailable).toContain("PostgreSQL");expect(view.body.workList.heldUsd).toBe(5);expect(view.body.newHeldUsd).toBe(5);
    // The owner's pass sits on the first cut: there its line is already held, so nothing new would be queued.
    const first=await call(base()+"/"+f.first.id+"/work-list");expect(first.body.queued.map((q:any)=>q.shotId)).toEqual([f.spoken[0]!.shotId]);expect(first.body.newPasses).toBe(0);expect(first.body.newHeldUsd).toBe(0);
    // HV-022-24: the creator's approval must name the hold the list would take now, before the provider service is even asked.
    const post=(extra:Record<string,unknown>)=>call(base()+"/"+f.second.id+"/work-list","POST",{generationApproved:true,worklistRevision:view.body.workList.revision,...extra});
    const missing=await post({});expect(missing.status).toBe(409);expect(missing.body.error).toBe("Approve the lip-sync hold, in dollars, before queueing. Nothing is queued or held.");
    const stale=await post({holdApprovedUsd:10});expect(stale.status).toBe(409);expect(stale.body.error).toBe("The lip-sync hold is now $5.00, not the $10.00 approved. Review the current hold before queueing. Nothing is queued or held.");
    for(const holdApprovedUsd of ["5",4.999,Number.NaN,null,-5])expect((await post({holdApprovedUsd})).status).toBe(409);
    // The approved hold to the micro-dollar reaches the next check, which still needs PostgreSQL.
    expect((await post({holdApprovedUsd:5})).status).toBe(503);expect((await post({holdApprovedUsd:5.0000001})).status).toBe(503);
    expect((await post({holdApprovedUsd:5,videoUrl:"https://untrusted.test"})).status).toBe(409);
    expect(JSON.stringify(jobs())).toBe(before);expect(ledger()).toBe(held);
  });}finally{delete process.env.HV_LIPSYNC_POLICY_FILE;}
},60000);

test("the work list is the project's own: another project's cut, token or face point never reaches it",async()=>{
  process.env.HV_LIPSYNC_POLICY_FILE=join(root,"lipsync-policy.json");
  try{await switched("1",async()=>{
    const before=JSON.stringify(jobs()),held=ledger(),mine="/api/projects/"+stranger.projectId+"/lip-sync/"+f.second.id+"/work-list";
    // The stranger names this project's voiced cut under their own project: it is not theirs.
    for(const method of ["GET","POST"])expect(await call(mine,method,method==="POST"?{generationApproved:true,worklistRevision:"0".repeat(64)}:undefined,stranger.token)).toEqual({status:404,body:{error:"unknown retained version"}});
    // Their token on this project's route is refused before any lip-sync code runs.
    const theirs=await call(base()+"/"+f.second.id+"/work-list","GET",undefined,stranger.token);expect(theirs.status).toBe(401);expect(theirs.body.workList).toBeUndefined();
    // Their newer face point on the same picture is not this project's: the owner's own point stands.
    const view=await call(base()+"/"+f.second.id+"/work-list"),ready=view.body.workList.items[0];
    expect(ready.reason).toBe("ready");expect(ready.facePointJobId).toBe(pass.id);expect(ready.facePointJobId).not.toBe(foreign);expect(ready.selection).toEqual(pass.lipSync!.selection);
    expect(JSON.stringify(jobs())).toBe(before);expect(ledger()).toBe(held);
  });}finally{delete process.env.HV_LIPSYNC_POLICY_FILE;}
},60000);

test("the owner's own submit route refuses the studio's request-key prefix, switch on or off",async()=>{
  for(const value of [undefined,"1"])await switched(value,async()=>{
    const before=JSON.stringify(jobs()),refused=await call(base()+"/"+f.second.id,"POST",{idempotencyKey:"studio-lipsync-"+"0".repeat(48),generationApproved:true});
    expect(refused.status).toBe(409);expect(refused.body.error).toContain("reserved for the studio");expect(JSON.stringify(jobs())).toBe(before);
  });
},60000);

test("only a voiced cut the work list can read says so: the film and every lip-sync pass, this project's or another's, never do",async()=>{
  await switched("1",async()=>{
    expect((await call("/api/jobs/"+f.second.id)).body.studioLipSync).toBe(true);
    for(const id of [f.film.id,pass.id,foreign])expect((await call("/api/jobs/"+id)).body.studioLipSync).toBeUndefined();
  });
},60000);

test("HV-022-25: with a detector and the finder's policy but no PostgreSQL provider service, nothing changes and nothing is detected",async()=>{
  const sent:string[]=[],detector=new FalFaceDetector({apiKey:"fixture key",fetchImpl:(async(url:string|URL|Request)=>{sent.push(String(url));return new Response(JSON.stringify({text_output:'{"points":[{"x":0.5,"y":0.5}]}'}));}) as typeof fetch});
  const finder=createApiServer({port:0,hostname:"127.0.0.1",queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),costLedgerPath:join(root,"ledger.json"),artifactRoot:f.artifacts,rateLimit:{api:{limit:10000,windowMs:60000}},faceDetector:detector});
  const policyPath=join(root,"face-detection-policy.json");
  writeFileSync(policyPath,JSON.stringify(faceDetectionPolicy({label:"fal · closed fixture",accountRevision:"a".repeat(64),priceEvidenceSha256:"f".repeat(64),heldUsd:.02,validFrom:"2026-01-01T00:00:00.000Z",expiresAt:"2099-01-01T00:00:00.000Z"})));
  process.env.HV_LIPSYNC_POLICY_FILE=join(root,"lipsync-policy.json");
  const at=async(on:ApiServer,path:string,method="GET",body?:unknown)=>{const r=await fetch(new URL(path,on.url),{method,headers:{authorization:"Bearer "+f.owner.token,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json() as any};};
  try{await switched("1",async()=>{
    const before=JSON.stringify(jobs()),held=ledger(),plainView=await at(server,base()+"/"+f.second.id+"/work-list");
    process.env[FACE_DETECTION_POLICY_ENV]=policyPath;
    try{
      const view=await at(finder,base()+"/"+f.second.id+"/work-list");
      expect(view.body).toEqual(plainView.body);expect(view.body.faceDetection).toBeUndefined();expect(view.body.workList.faceDetection).toBeUndefined();
      expect(view.body.workList.items[2]).toMatchObject({reason:"no-face-point"});expect(view.body.workList.items[2].faceDetection).toBeUndefined();
      expect((await at(finder,base()+"/"+f.second.id+"/work-list","POST",{generationApproved:true,worklistRevision:view.body.workList.revision,holdApprovedUsd:view.body.newHeldUsd})).status).toBe(503);
    }finally{delete process.env[FACE_DETECTION_POLICY_ENV];}
    expect(sent).toEqual([]);expect(JSON.stringify(jobs())).toBe(before);expect(ledger()).toBe(held);
  });}finally{delete process.env.HV_LIPSYNC_POLICY_FILE;await finder.stop(true);}
},60000);
