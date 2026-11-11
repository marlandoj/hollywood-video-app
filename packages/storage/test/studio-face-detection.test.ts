/**
 * HV-022-25 -- the studio's face-point finder on the PostgreSQL ledger, through the API's work-list route.
 *
 * The detector is the closed fal adapter over a mock transport: every reply is a fixture, no key is read and no
 * request leaves the process. Each detection is held under the ledger's lock beside the lip-sync passes, inside
 * the one amount the creator approves, and its pass is admitted as HV-022-23's are. PostgreSQL only; local artifacts.
 */
import {afterAll,beforeAll,expect,test} from "bun:test";
import {mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import {StudioDatabase} from "../src/database";
import {PostgresLipSyncLedger} from "../src/lipsync-ledger";
import {PostgresCostLedger} from "../src/ledger";
import {createApiServer,type ApiServer} from "../../api/src/server";
import {createPlacedLipSyncFixture,ownerLipSyncPass} from "../../../test/fixtures/lipsync";
import {lipSyncWorkList,STUDIO_LIPSYNC_ENV} from "../../planner/src/lipsync-worklist";
import {faceDetectionKey,faceDetectionPolicy,faceDetectionRequestHash,sealFaceDetection,FACE_DETECTION_POLICY_ENV,FACE_DETECTION_STALE_MS,type FaceDetectionRecord} from "../../planner/src/face-detection";
import {castingSnapshot,currentCasting} from "../../planner/src/casting";
import type {FaceDetectionFrame,FaceDetectionResult} from "../../generator/src/fal-face-detection";
import {FalFaceDetector} from "../../generator/src/fal-face-detection";
import {FACE_DETECTION_CAPABILITY,FACE_DETECTION_ENDPOINT} from "../../generator/src/face-detection-capability";
import {previewLipSyncFrame} from "../../generator/src/lipsync-media";
import {retainLipSyncSource} from "../../planner/src/lipsync";
import {DEFAULT_FILM_SPEND_CAP_USD} from "../../operator/src/film-budget";
import {BudgetError} from "../../operator/src/index";

const enabled=Boolean(process.env.HV_PG_ADMIN_URL&&process.env.HV_API_DATABASE_URL&&process.env.HV_WORKER_DATABASE_URL),pgtest=enabled?test:test.skip;
const keys=["HV_TOKEN_SECRET","HV_NARRATION","HV_ANIMATIC_CAPTIONS","HV_ANIMATIC_PROVIDER_POOL","HV_AUDIO_POLICY_FILE","HV_LIPSYNC_POLICY_FILE","HV_FILM_SPEND_CAP_USD",STUDIO_LIPSYNC_ENV,FACE_DETECTION_POLICY_ENV],previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
const FINDER=faceDetectionPolicy({label:"fal · closed fixture",accountRevision:"a".repeat(64),priceEvidenceSha256:"f".repeat(64),heldUsd:.02,validFrom:"2026-01-01T00:00:00.000Z",expiresAt:"2099-01-01T00:00:00.000Z"});
// What the mock fal transport answers next, and every request it was sent.
let answer:()=>Response=()=>new Response("{}",{status:500});const sent:{url:string;body:any}[]=[];
const text=(value:string)=>()=>new Response(JSON.stringify({text_output:value}),{status:200,headers:{"content-type":"application/json"}});
const detector=new FalFaceDetector({apiKey:"fixture key",fetchImpl:(async(url:string|URL|Request,init?:RequestInit)=>{sent.push({url:String(url),body:JSON.parse(String(init?.body))});return answer();}) as typeof fetch});
// Review S2/S3: a detector whose answer each case sets, to see what the route does around it.
let custom:(frame:FaceDetectionFrame)=>Promise<FaceDetectionResult>=async()=>({outcome:"failed",faces:null,point:null,responseSha256:null});
let lineShot:string,root:string,admin:StudioDatabase,api:StudioDatabase,server:ApiServer,plain:ApiServer,small:ApiServer,odd:ApiServer,f:Awaited<ReturnType<typeof createPlacedLipSyncFixture>>,owner:Awaited<ReturnType<typeof ownerLipSyncPass>>;
beforeAll(async()=>{if(!enabled)return;
  root=mkdtempSync(join(tmpdir(),"hv-studio-face-pg-"));
  Object.assign(process.env,{HV_TOKEN_SECRET:"studio face pg fixture, at least thirty-two characters",HV_NARRATION:"1",HV_ANIMATIC_CAPTIONS:"0",HV_ANIMATIC_PROVIDER_POOL:'["mock"]'});
  for(const k of [STUDIO_LIPSYNC_ENV,"HV_FILM_SPEND_CAP_USD",FACE_DETECTION_POLICY_ENV])delete process.env[k];
  f=await createPlacedLipSyncFixture(root);owner=await ownerLipSyncPass(f,f.first,f.spoken[0]!.shotId,{x:40,y:30});
  process.env.HV_AUDIO_POLICY_FILE=join(root,"audio-policy.json");process.env.HV_LIPSYNC_POLICY_FILE=join(root,"lipsync-policy.json");
  writeFileSync(join(root,"face-detection-policy.json"),JSON.stringify(FINDER));
  // The second MARLA line ("Stay a while."): on camera, with no owner point.
  lineShot=lipSyncWorkList(retainLipSyncSource(f.second)).items[2]!.shotId;
  admin=new StudioDatabase(process.env.HV_PG_ADMIN_URL!);await admin.migrate();api=new StudioDatabase(process.env.HV_API_DATABASE_URL!);
  await admin.sql`insert into hv_projects (id,body,created_at,delete_after) values (${f.project.id},${f.project}::jsonb,${f.project.createdAt},${f.project.deleteAfter})`;
  for(const j of [f.first,f.second,f.store.get(owner.id)!])await admin.sql`insert into hv_jobs (id,project_id,idempotency_key,stage,status,tier,body,lease_version) values (${j.id},${j.projectId},${j.idempotencyKey},${j.stage},${j.status},${j.tier},${j}::jsonb,${j.leaseVersion??0})`;
  const studio=(withDetector:boolean)=>createApiServer({port:0,hostname:"127.0.0.1",storage:"postgres",databaseUrl:process.env.HV_API_DATABASE_URL,artifactRoot:f.artifacts,rateLimit:{api:{limit:10000,windowMs:60000}},...(withDetector?{faceDetector:detector}:{})});
  server=studio(true);plain=studio(false);
  odd=createApiServer({port:0,hostname:"127.0.0.1",storage:"postgres",databaseUrl:process.env.HV_API_DATABASE_URL,artifactRoot:f.artifacts,rateLimit:{api:{limit:10000,windowMs:60000}},faceDetector:{capabilityRevision:FACE_DETECTION_CAPABILITY.revision,detect:frame=>custom(frame)}});
  // A film limit that holds the ready pass and the detection, but not the pass a detection may add.
  process.env.HV_FILM_SPEND_CAP_USD="6";try{small=studio(true);}finally{delete process.env.HV_FILM_SPEND_CAP_USD;}
},180000);
afterAll(async()=>{if(!enabled)return;await server?.stop(true);await plain?.stop(true);await small?.stop(true);await odd?.stop(true);
  const id=f?.project.id;if(id){await reset();await admin.sql`delete from hv_reservations where project_id=${id} or job_id in (select id from hv_jobs where project_id=${id})`;
    for(const table of ["hv_face_detections","hv_cost_events","hv_provider_attempts","hv_outbox","hv_operator_reviews","hv_artifacts","hv_jobs","hv_reviews"])await admin.sql.unsafe("delete from "+table+" where project_id=$1",[id]);await admin.sql`delete from hv_projects where id=${id}`;}
  await api?.close();await admin?.close();for(const [k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
  if(root){if(!resolve(root).startsWith(resolve(tmpdir())+sep+"hv-studio-face-pg-"))throw new Error("Unexpected test root");rmSync(root,{recursive:true,force:true});}
},60000);
const call=async(path:string,method="GET",body?:unknown,on=server)=>{const r=await fetch(new URL(path,on.url),{method,headers:{authorization:"Bearer "+f.owner.token,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json() as any};};
const route=()=>"/api/projects/"+f.project.id+"/lip-sync/"+f.second.id+"/work-list";
const holds=async():Promise<{jobId:string;stage:string;amountUsd:number}[]>=>(await admin.sql`select job_id,stage,amount_usd from hv_reservations where project_id=${f.project.id} order by stage,job_id`).map((r:any)=>({jobId:r.job_id,stage:r.stage,amountUsd:Number(r.amount_usd)}));
const detections=async():Promise<FaceDetectionRecord[]>=>(await admin.sql`select body from hv_face_detections where project_id=${f.project.id}`).map((r:any)=>r.body as FaceDetectionRecord);
const studioJobs=async()=>(await admin.sql`select id,body from hv_jobs where project_id=${f.project.id} and stage='lip-sync' and id<>${owner.id}`).map((r:any)=>r.body) as any[];
/** Every pass, detection and hold the studio made goes, so the next case starts from the same film. */
async function reset(){
  const id=f.project.id;
  await admin.sql`delete from hv_reservations where project_id=${id} and (stage='face-detection' or job_id in (select id from hv_jobs where project_id=${id} and stage='lip-sync' and id<>${owner.id}))`;
  await admin.sql`delete from hv_cost_events where project_id=${id} and stage='face-detection'`;
  await admin.sql`delete from hv_face_detections where project_id=${id}`;
  await admin.sql`delete from hv_jobs where project_id=${id} and stage='lip-sync' and id<>${owner.id}`;sent.length=0;
}
const finder=async<T>(run:()=>Promise<T>,policy=true)=>{process.env[STUDIO_LIPSYNC_ENV]="1";if(policy)process.env[FACE_DETECTION_POLICY_ENV]=join(root,"face-detection-policy.json");
  try{return await run();}finally{delete process.env[STUDIO_LIPSYNC_ENV];delete process.env[FACE_DETECTION_POLICY_ENV];}};
/** The held form of a settled record: the same key and request, as a replay would send it. */
const heldOf=(record:FaceDetectionRecord)=>sealFaceDetection({...record,status:"held",outcome:null,faces:null,point:null,responseSha256:null,completedAt:null});
const approve=(view:any,on=server,holdApprovedUsd=view.body.newHeldUsd)=>call(route(),"POST",{generationApproved:true,worklistRevision:view.body.workList.revision,holdApprovedUsd},on);

pgtest("off -- no detector, no detection policy, or the switch off -- the list and its hold are exactly as before, and nothing is asked",async()=>{
  await reset();
  const baseline=await finder(()=>call(route(),"GET",undefined,plain),false);
  expect(baseline.body.faceDetection).toBeUndefined();expect(baseline.body.workList.faceDetection).toBeUndefined();expect(baseline.body.newHeldUsd).toBe(5);
  expect(baseline.body.workList.items.map((i:any)=>[i.character,i.reason])).toEqual([["MARLA","ready"],["KEVIN","off-camera"],["MARLA","no-face-point"]]);
  // A policy with no detector, or a detector with no policy: the same list, to the revision.
  expect((await finder(()=>call(route(),"GET",undefined,plain))).body).toEqual(baseline.body);
  expect((await finder(()=>call(route()),false)).body).toEqual(baseline.body);
  // Switch off with both present: the route is unknown, as before.
  process.env[FACE_DETECTION_POLICY_ENV]=join(root,"face-detection-policy.json");try{expect(await call(route())).toEqual({status:404,body:{error:"unknown lip-sync route"}});}finally{delete process.env[FACE_DETECTION_POLICY_ENV];}
  // Queueing with the finder absent holds the pass alone and never asks a detector.
  const queued=await finder(()=>approve(baseline),false);expect(queued.status).toBe(202);expect(queued.body.heldUsd).toBe(5);expect(queued.body.detections).toBeUndefined();
  expect(sent).toEqual([]);expect(await detections()).toEqual([]);expect((await holds()).map(h=>h.stage)).toEqual(["lip-sync"]);
});

pgtest("one face: the detection is approved with the passes, held once, asked once, and its line's pass is admitted on the detected point",async()=>{await finder(async()=>{
  await reset();answer=text('{"points":[{"x":0.5,"y":0.25}]}');
  const view=await call(route());
  expect(view.body.workList.items.map((i:any)=>[i.character,i.reason,i.faceDetection?.status??null])).toEqual([["MARLA","ready",null],["KEVIN","off-camera",null],["MARLA","no-face-point","planned"]]);
  expect(view.body.faceDetection).toMatchObject({newDetections:1,heldUsdPerDetection:.02,heldUsd:.02,passHeldUsd:5,spentWithoutFace:true});
  expect(view.body.faceDetection.lines).toEqual([{shotId:lineShot,lineIndex:view.body.workList.items[2].lineIndex,character:"MARLA",text:"Stay a while.",frame:view.body.workList.items[2].faceDetection.frame}]);
  // The approval: the ready pass ($5), the detection ($0.02) and the pass it may make possible ($5).
  expect(view.body.newHeldUsd).toBe(10.02);
  // The amount the creator saw before the finder ($5) is not this hold: refused, nothing held, nothing asked.
  for(const holdApprovedUsd of [5,5.02,10,10.03]){const refused=await approve(view,server,holdApprovedUsd);expect(refused.status).toBe(409);expect(refused.body.error).toContain("Nothing is queued or held");}
  expect(sent).toEqual([]);expect(await holds()).toEqual([]);expect(await detections()).toEqual([]);
  const queued=await approve(view);expect(queued.status).toBe(202);
  expect(queued.body.detections).toEqual([{shotId:lineShot,lineIndex:view.body.workList.items[2].lineIndex,detectionId:expect.stringMatching(/^studio-facedetect-[a-f0-9]{48}$/),outcome:"one-face",faces:1,detail:expect.stringContaining("One face found"),replay:false}]);
  expect(queued.body.admitted).toHaveLength(2);expect(queued.body.heldUsd).toBe(10.02);expect(queued.body.detectionHeldUsd).toBe(.02);
  // The detector was asked once, with the verified middle frame of the line, as the pinned request.
  expect(sent).toHaveLength(1);expect(sent[0]!.url).toBe(FACE_DETECTION_ENDPOINT);
  expect(sent[0]!.body).toMatchObject({task_type:"point_detection",detection_prompt:"face",combine_points:false,show_visualization:false,use_ensemble:false});expect(sent[0]!.body.image_url).toMatch(/^data:image\/png;base64,/);
  const [record]=await detections();expect(record).toMatchObject({status:"settled",outcome:"one-face",faces:1,shotId:lineShot,frame:view.body.workList.items[2].faceDetection.frame,policyRevision:FINDER.revision,heldUsd:.02});
  expect(record!.point).toEqual({x:Math.floor(record!.width/2),y:Math.floor(record!.height/4)});
  const passes=await studioJobs(),detected=passes.find(j=>j.lipSync.shotId===lineShot)!;
  expect(detected.lipSync.selection).toEqual({frame:record!.frame,width:record!.width,height:record!.height,x:record!.point!.x,y:record!.point!.y,rgbSha256:record!.rgbSha256});
  expect(detected.idempotencyKey).toMatch(new RegExp("^"+f.project.id+":studio-lipsync-[a-f0-9]{48}$"));expect(detected.costCapUsd).toBe(5);
  expect((await holds()).map(h=>[h.stage,h.amountUsd])).toEqual([["face-detection",.02],["lip-sync",5],["lip-sync",5]]);
  // The finder's line is now held by its pass: nothing is planned again, and the approval is $0.
  const after=await call(route());expect(after.body.newHeldUsd).toBe(0);expect(after.body.faceDetection.newDetections).toBe(0);
  expect(after.body.workList.items[2]).toMatchObject({reason:"ready",facePointJobId:null,detectedPoint:{detectionId:record!.id,source:"detected",provider:"fal",frameSha256:record!.rgbSha256,requestHash:record!.requestHash}});
  const again=await approve(after);expect(again.status).toBe(200);expect(again.body.heldUsd).toBe(0);expect(again.body.detections).toEqual([]);expect(sent).toHaveLength(1);
  const spend=await call("/api/projects/"+f.project.id+"/spend");expect(spend.body.heldUsd).toBe(10.02);expect(spend.body.capUsd).toBe(DEFAULT_FILM_SPEND_CAP_USD);
});},120000);

for(const [name,reply,outcome,faces,detail] of [
  ["two faces",'{"points":[{"x":0.2,"y":0.4},{"x":0.8,"y":0.4}]}',"several-faces",2,"2 faces found; choose the speaker under Direct lip-sync."],
  ["no face",'{"points":[]}',"no-face",0,"No face found; choose the speaker under Direct lip-sync."],
  ["an unparseable answer","face near the centre","unparseable",null,"The detection's answer could not be read with certainty; choose the speaker under Direct lip-sync."],
] as const){
  pgtest(`${name}: the detection's hold is spent, no point is used, the line stays the owner's, and it is never detected again`,async()=>{await finder(async()=>{
    await reset();answer=text(reply);
    const view=await call(route());expect(view.body.newHeldUsd).toBe(10.02);
    const queued=await approve(view);expect(queued.status).toBe(202);
    expect(queued.body.detections).toEqual([expect.objectContaining({outcome,faces,detail,replay:false})]);
    // Only the ready line's pass is admitted: $5 and the $0.02 detection, under the $10.02 approved.
    expect(queued.body.admitted).toHaveLength(1);expect(queued.body.heldUsd).toBe(5.02);expect(queued.body.detectionHeldUsd).toBe(.02);
    expect((await studioJobs()).map(j=>j.lipSync.shotId)).toEqual([f.spoken[0]!.shotId]);
    expect((await holds()).map(h=>[h.stage,h.amountUsd])).toEqual([["face-detection",.02],["lip-sync",5]]);
    expect((await detections()).map(r=>[r.status,r.outcome,r.faces,r.point])).toEqual([["settled",outcome,faces,null]]);
    const after=await call(route()),line=after.body.workList.items[2];
    expect(line).toMatchObject({reason:"no-face-point",included:false,selection:null,faceDetection:{status:"settled",outcome,faces,detail}});
    expect(after.body.faceDetection.newDetections).toBe(0);expect(after.body.newHeldUsd).toBe(0);
    expect((await approve(after)).body.detections).toEqual([]);expect(sent).toHaveLength(1);
  });},120000);
}

pgtest("a detector that does not answer spends its hold and gives no point; a replayed detection is never asked again",async()=>{await finder(async()=>{
  await reset();answer=()=>{throw new TypeError("network down");};
  const view=await call(route()),queued=await approve(view);expect(queued.status).toBe(202);
  expect(queued.body.detections).toEqual([expect.objectContaining({outcome:"failed",faces:null,replay:false,detail:"The face detection did not answer; choose the speaker under Direct lip-sync."})]);expect(queued.body.heldUsd).toBe(5.02);
  // The ledger's own replay of the same detection key returns the record it holds and reserves nothing new.
  const [record]=await detections(),ledger=new PostgresLipSyncLedger(api),before=await holds();
  const again=await ledger.admitFaceDetection(f.project.id,heldOf(record!),()=>FINDER,10000);expect(again.replay).toBe(true);expect(again.record.status).toBe("settled");expect(await holds()).toEqual(before);
  // Settling a settled detection keeps its first result.
  expect((await ledger.settleFaceDetection(f.project.id,record!.id,{outcome:"one-face",faces:1,point:{x:1,y:1},responseSha256:"1".repeat(64)})).outcome).toBe("failed");
  expect(sent).toHaveLength(1);
});},120000);

pgtest("two approvals race: the detection is held once and asked once",async()=>{await finder(async()=>{
  await reset();answer=text('{"points":[{"x":0.5,"y":0.5}]}');
  const view=await call(route()),both=await Promise.all([1,2].map(()=>approve(view)));
  expect(both.map(r=>r.status).sort()).toContain(202);
  for(const r of both)if(r.status!==202)expect([200,409]).toContain(r.status);
  expect(sent).toHaveLength(1);
  expect((await holds()).map(h=>[h.stage,h.amountUsd])).toEqual([["face-detection",.02],["lip-sync",5],["lip-sync",5]]);
  expect(both.reduce((sum,r)=>sum+Math.round((r.body.heldUsd??0)*1e6),0)/1e6).toBe(10.02);
});},120000);

pgtest("a detection held but never finished is not asked again, and the worker posts a detection's hold only once it is settled",async()=>{await finder(async()=>{
  await reset();answer=text('{"points":[{"x":0.5,"y":0.5}]}');
  // The detection is admitted under its key exactly as the route would, and the process stops before asking.
  const view=await call(route()),item=view.body.workList.items[2],frame=item.faceDetection.frame,image=await previewLipSyncFrame(retainLipSyncSource(f.second),f.artifacts,item.shotId,item.lineIndex,frame);
  const record=sealFaceDetection({schema:"hv-face-detection/1",id:faceDetectionKey({sourceJobId:f.second.id,shotId:item.shotId,lineIndex:item.lineIndex,rgbSha256:image.rgbSha256,policyRevision:FINDER.revision}),projectId:f.project.id,sourceJobId:f.second.id,
    picture:view.body.workList.picture,shotId:item.shotId,lineIndex:item.lineIndex,characterId:item.characterId,frame,absoluteFrame:item.window.startFrame+frame,width:image.width,height:image.height,rgbSha256:image.rgbSha256,
    policyRevision:FINDER.revision,capabilityRevision:FACE_DETECTION_CAPABILITY.revision,requestHash:faceDetectionRequestHash(image,FINDER.revision),heldUsd:FINDER.heldUsd,admittedAt:new Date().toISOString(),status:"held",outcome:null,faces:null,point:null,responseSha256:null,completedAt:null});
  const ledger=new PostgresLipSyncLedger(api),first=await ledger.admitFaceDetection(f.project.id,record,()=>FINDER,10000);expect(first.replay).toBe(false);
  expect((await ledger.admitFaceDetection(f.project.id,record,()=>FINDER,10000)).replay).toBe(true);
  expect((await holds()).map(h=>[h.stage,h.amountUsd])).toEqual([["face-detection",.02]]);
  // The list read before the hold is stale; the current one plans no detection, and its approval is the ready pass alone.
  expect((await approve(view)).status).toBe(409);
  const after=await call(route());expect(after.body.workList.items[2].faceDetection).toEqual({status:"held",detectionId:record.id,outcome:null,faces:null,detail:"The face detection for this line did not finish; choose the speaker under Direct lip-sync."});
  expect(after.body.faceDetection.newDetections).toBe(0);expect(after.body.newHeldUsd).toBe(5);
  const queued=await approve(after);expect(queued.status).toBe(202);expect(queued.body.detections).toEqual([]);expect(queued.body.heldUsd).toBe(5);expect(sent).toEqual([]);
  // The worker's reconcile keeps an unfinished detection's hold while its request may still be asking (it is not a job's).
  const workerDb=new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!),worker=new PostgresCostLedger(workerDb);
  try{
    await worker.reconcile(new Set(),0,Date.now()+60000);expect((await holds()).filter(h=>h.stage==="face-detection")).toEqual([{jobId:record.id,stage:"face-detection",amountUsd:.02}]);
    expect((await detections())[0]!.status).toBe("held");
    // Review S1: once it has been held past FACE_DETECTION_STALE_MS, its result is never coming. The worker settles it as
    // failed (no point) and posts its whole hold as cost, once; the detector is never asked.
    const late=Date.now()+FACE_DETECTION_STALE_MS+60000;
    await worker.reconcile(new Set(),0,late);await worker.reconcile(new Set(),0,late);
    expect((await holds()).filter(h=>h.stage==="face-detection")).toEqual([]);
    const events=await admin.sql`select event_key,stage,provider,total_usd from hv_cost_events where project_id=${f.project.id} and stage='face-detection'`;
    expect(events.map((e:any)=>[e.event_key,e.stage,e.provider,Number(e.total_usd)])).toEqual([["face-detection:"+record.id,"face-detection","fal",.02]]);
    expect((await admin.sql`select posted_at from hv_face_detections where id=${record.id}`)[0].posted_at).not.toBeNull();
    const [swept]=await detections();expect(swept).toMatchObject({status:"settled",outcome:"failed",faces:null,point:null,responseSha256:null});
    // A late answer from the request that held it changes nothing: the first result stands.
    expect((await ledger.settleFaceDetection(f.project.id,record.id,{outcome:"one-face",faces:1,point:{x:2,y:2},responseSha256:"2".repeat(64)})).outcome).toBe("failed");
    const line=(await call(route())).body.workList.items[2];
    expect(line).toMatchObject({reason:"no-face-point",included:false,faceDetection:{status:"settled",outcome:"failed"}});
    expect(sent).toEqual([]);
  }finally{await workerDb.close();}
});},120000);

pgtest("the ledger re-checks the caps and the policy under its lock, and a refusal holds nothing",async()=>{await finder(async()=>{
  await reset();answer=text('{"points":[{"x":0.5,"y":0.5}]}');
  // The pre-check: the most the approval can hold ($10.02) is past this film's $6 limit, so nothing is held or asked.
  const view=await call(route(),"GET",undefined,small);expect(view.body.newHeldUsd).toBe(10.02);
  const refused=await approve(view,small);expect(refused.status).toBe(429);expect(refused.body.reason).toBe("budget_exhausted");
  expect(await holds()).toEqual([]);expect(sent).toEqual([]);
  // Under the lock: a film limit already spent, or a changed policy, refuses the detection and writes no row.
  const fd={sealFaceDetection,faceDetectionKey,faceDetectionRequestHash},record=fd.sealFaceDetection({schema:"hv-face-detection/1",id:fd.faceDetectionKey({sourceJobId:f.second.id,shotId:"shot-x",lineIndex:0,rgbSha256:"9".repeat(64),policyRevision:FINDER.revision}),
    projectId:f.project.id,sourceJobId:f.second.id,picture:view.body.workList.picture,shotId:"shot-x",lineIndex:0,characterId:f.marla,frame:0,absoluteFrame:0,width:320,height:240,rgbSha256:"9".repeat(64),
    policyRevision:FINDER.revision,capabilityRevision:FINDER.capabilityRevision,requestHash:fd.faceDetectionRequestHash({width:320,height:240,rgbSha256:"9".repeat(64)},FINDER.revision),heldUsd:.02,admittedAt:new Date().toISOString(),status:"held",outcome:null,faces:null,point:null,responseSha256:null,completedAt:null});
  const ledger=new PostgresLipSyncLedger(api);
  await expect(ledger.admitFaceDetection(f.project.id,record,()=>FINDER,10000,Date.now(),.01)).rejects.toThrow(BudgetError);
  const repriced=faceDetectionPolicy({label:"fal · repriced",accountRevision:"a".repeat(64),priceEvidenceSha256:"e".repeat(64),heldUsd:.05,validFrom:"2026-01-01T00:00:00.000Z",expiresAt:"2099-01-01T00:00:00.000Z"});
  await expect(ledger.admitFaceDetection(f.project.id,record,()=>repriced,10000)).rejects.toThrow("policy changed");
  await expect(ledger.admitFaceDetection(f.project.id,record,()=>undefined,10000)).rejects.toThrow("policy changed");
  // The month's cap is the ledger's own: a cap below what is already held refuses it.
  await expect(ledger.admitFaceDetection(f.project.id,record,()=>FINDER,.01)).rejects.toThrow(BudgetError);
  // Another film's detection cannot be admitted, read or settled from this one.
  await expect(ledger.admitFaceDetection(crypto.randomUUID(),record,()=>FINDER,10000)).rejects.toThrow("Invalid face detection admission");
  expect(await holds()).toEqual([]);expect(await detections()).toEqual([]);
  const first=await ledger.admitFaceDetection(f.project.id,record,()=>FINDER,10000);expect(first.replay).toBe(false);
  expect(await ledger.faceDetections(crypto.randomUUID())).toEqual([]);expect((await ledger.faceDetections(f.project.id)).map(r=>r.id)).toEqual([record.id]);
  await expect(ledger.settleFaceDetection(crypto.randomUUID(),record.id,{outcome:"no-face",faces:0,point:null,responseSha256:null})).rejects.toThrow("Unknown face detection");
  // A detection key replayed with another request is refused, never reused.
  const other=fd.sealFaceDetection({...record,width:640,height:480,requestHash:fd.faceDetectionRequestHash({width:640,height:480,rgbSha256:"9".repeat(64)},FINDER.revision)});
  await expect(ledger.admitFaceDetection(f.project.id,other,()=>FINDER,10000)).rejects.toThrow("belongs to another detection");
  expect((await holds()).map(h=>[h.stage,h.amountUsd])).toEqual([["face-detection",.02]]);
});},120000);

pgtest("an owner's point chosen later wins over the finder's suggestion: the line is ready on the owner's point, never the detected one",async()=>{await finder(async()=>{
  await reset();answer=text('{"points":[{"x":0.5,"y":0.25}]}');
  const view=await call(route());await approve(view);
  const [record]=await detections();expect(record!.outcome).toBe("one-face");
  // The studio's pass on the detected point is withdrawn, and the owner chooses their own point on that line's first frame.
  await admin.sql`delete from hv_reservations where job_id in (select id from hv_jobs where project_id=${f.project.id} and stage='lip-sync' and id<>${owner.id} and body->'lipSync'->>'shotId'=${lineShot})`;
  await admin.sql`delete from hv_jobs where project_id=${f.project.id} and stage='lip-sync' and id<>${owner.id} and body->'lipSync'->>'shotId'=${lineShot}`;
  const mine=await ownerLipSyncPass(f,f.second,lineShot,{x:20,y:22}),job=f.store.get(mine.id)!;
  await admin.sql`insert into hv_jobs (id,project_id,idempotency_key,stage,status,tier,body,lease_version) values (${job.id},${job.projectId},${job.idempotencyKey},${job.stage},'done',${job.tier},${{...job,status:"done"}}::jsonb,0)`;
  try{
    const after=await call(route()),line=after.body.workList.items[2];
    expect(line.facePointJobId).toBe(mine.id);expect(line.detectedPoint).toBeUndefined();expect(line.selection).toMatchObject({x:20,y:22});
  }finally{await admin.sql`delete from hv_jobs where id=${mine.id}`;}
});},120000);

/** Review B1: the film's cast with every character's permission revoked, saved as the film's current casting. */
let castBefore:unknown;
async function revokeCast(){
  const current=(await admin.sql`select body from hv_projects where id=${f.project.id}`)[0].body;castBefore??=current;
  const revoked=structuredClone(current),cast=currentCasting(revoked.id,revoked.castingHistory),characters=structuredClone(cast.characters);
  for(const c of characters)c.permission.status="revoked";revoked.castingHistory!.push(castingSnapshot(revoked.id,cast.version+1,characters,Date.now()));
  await admin.sql`update hv_projects set body=${revoked}::jsonb where id=${f.project.id}`;
}
async function restoreCast(){if(castBefore!==undefined){await admin.sql`update hv_projects set body=${castBefore}::jsonb where id=${f.project.id}`;castBefore=undefined;}}

pgtest("review B1: a withdrawn cast permission sends no frame to the detector, admits no detection and holds nothing",async()=>{await finder(async()=>{
  await reset();answer=text('{"points":[{"x":0.5,"y":0.25}]}');
  const trigger=async(on:boolean)=>{
    if(on){
      await admin.sql.unsafe("create table if not exists hv_test_face_revoke (body jsonb not null)");
      await admin.sql.unsafe(`create or replace function hv_test_face_revoke_fn() returns trigger language plpgsql security definer as $fn$
        begin update hv_projects set body=(select body from hv_test_face_revoke limit 1) where id=new.project_id and exists (select 1 from hv_test_face_revoke); return new; end $fn$`);
      await admin.sql.unsafe("create trigger hv_test_face_revoke_t after insert on hv_reservations for each row when (new.stage = 'lip-sync') execute function hv_test_face_revoke_fn()");
    }else{
      await admin.sql.unsafe("drop trigger if exists hv_test_face_revoke_t on hv_reservations");await admin.sql.unsafe("drop function if exists hv_test_face_revoke_fn()");await admin.sql.unsafe("drop table if exists hv_test_face_revoke");
    }
  };
  try{
    // Withdrawn before the approval: the request is refused before anything is held, and no frame is sent.
    const view=await call(route());expect(view.body.newHeldUsd).toBe(10.02);
    await revokeCast();
    const refused=await approve(view);expect(refused.status).toBe(400);expect(refused.body.error).toContain("not permitted");
    expect(sent).toEqual([]);expect(await detections()).toEqual([]);expect(await holds()).toEqual([]);
    await restoreCast();
    // Withdrawn while the request runs, as the ready line's pass is held: the film is read again before any detection,
    // so the ready pass stays listed as held, and no detection is admitted, held or asked.
    const current=(await admin.sql`select body from hv_projects where id=${f.project.id}`)[0].body,cast=currentCasting(current.id,current.castingHistory),characters=structuredClone(cast.characters);
    for(const c of characters)c.permission.status="revoked";const revoked={...current,castingHistory:[...current.castingHistory,castingSnapshot(current.id,cast.version+1,characters,Date.now())]};
    castBefore=current;await trigger(true);await admin.sql`insert into hv_test_face_revoke (body) values (${revoked}::jsonb)`;
    const midway=await approve(await call(route()));
    expect(midway.status).toBe(207);expect(midway.body.error).toContain("not permitted");
    expect(midway.body).toMatchObject({detections:[],detectionHeldUsd:0,heldUsd:5});expect(midway.body.admitted.map((a:any)=>a.shotId)).toEqual([f.spoken[0]!.shotId]);
    expect(sent).toEqual([]);expect(await detections()).toEqual([]);expect((await holds()).map(h=>h.stage)).toEqual(["lip-sync"]);
  }finally{await trigger(false);await restoreCast();}
});},120000);

pgtest("review S2: a detection held when its result cannot be recorded is still reported as held, never as nothing held",async()=>{await finder(async()=>{
  await reset();
  // More faces than the record can name: the result is refused when it is recorded, after the hold was taken.
  custom=async()=>({outcome:"several-faces",faces:65,point:null,responseSha256:"6".repeat(64)});
  const view=await call(route(),"GET",undefined,odd),queued=await approve(view,odd);
  expect(queued.status).toBe(207);expect(queued.body.error).toBeTruthy();
  expect(queued.body.detections).toEqual([expect.objectContaining({shotId:lineShot,outcome:null,faces:null,replay:false,detail:expect.stringContaining("did not finish")})]);
  // The ready pass ($5) and the held detection ($0.02) are what the request says it holds.
  expect(queued.body.admitted).toHaveLength(1);expect(queued.body.detectionHeldUsd).toBe(.02);expect(queued.body.heldUsd).toBe(5.02);
  expect((await holds()).map(h=>[h.stage,h.amountUsd])).toEqual([["face-detection",.02],["lip-sync",5]]);
  expect((await detections()).map(r=>r.status)).toEqual(["held"]);
});},120000);

pgtest("review S3: the ready lines' passes are admitted before any detection is asked",async()=>{await finder(async()=>{
  await reset();
  let seen:string[]=[];
  custom=async frame=>{seen=(await holds()).map(h=>h.stage);return {outcome:"one-face",faces:1,point:{x:Math.floor(frame.width/2),y:Math.floor(frame.height/2)},responseSha256:"7".repeat(64)};};
  const view=await call(route(),"GET",undefined,odd),queued=await approve(view,odd);expect(queued.status).toBe(202);
  // When the detector was asked, the ready pass and the detection were already held; the detected line's pass came after.
  expect(seen).toEqual(["face-detection","lip-sync"]);
  expect(queued.body.admitted.map((a:any)=>a.shotId)).toEqual([f.spoken[0]!.shotId,lineShot]);expect(queued.body.heldUsd).toBe(10.02);
  expect((await holds()).map(h=>[h.stage,h.amountUsd])).toEqual([["face-detection",.02],["lip-sync",5],["lip-sync",5]]);
});},120000);

pgtest("review O6: another film's session reads none of this film's face detections",async()=>{await finder(async()=>{
  await reset();answer=text('{"points":[]}');
  await approve(await call(route()));expect(await detections()).toHaveLength(1);
  const other=crypto.randomUUID();
  expect(await api.forProject(other,tx=>tx`select * from hv_face_detections`)).toHaveLength(0);
  expect(await api.forProject(f.project.id,tx=>tx`select id from hv_face_detections`)).toHaveLength(1);
});},120000);
