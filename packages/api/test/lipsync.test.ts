import {afterAll,beforeAll,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,sep} from "node:path";
import {createApiServer,type ApiServer} from "../src/server";
import {createLipSyncFixture,completeLipSyncFixture,LIPSYNC_POLICY} from "../../../test/fixtures/lipsync";
import {validateSnapshot,type StateSnapshot} from "../../storage/src/snapshots";
import type {StoredLipSyncAttempt} from "../../storage/src/lipsync-ledger";
import {CostLedger} from "../../operator/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {mintArtifactToken} from "../src/tokens";
const root=mkdtempSync(join(tmpdir(),"hv-lipsync-api-")),keys=["HV_TOKEN_SECRET","HV_NARRATION","HV_ANIMATIC_CAPTIONS","HV_ANIMATIC_PROVIDER_POOL","HV_AUDIO_POLICY_FILE","HV_LIPSYNC_POLICY_FILE"],previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
let f:Awaited<ReturnType<typeof createLipSyncFixture>>,result:Awaited<ReturnType<typeof completeLipSyncFixture>>,server:ApiServer;
beforeAll(async()=>{Object.assign(process.env,{HV_TOKEN_SECRET:"lipsync-api-fixture-secret-at-least-thirty-two-characters",HV_NARRATION:"1",HV_ANIMATIC_CAPTIONS:"0",HV_ANIMATIC_PROVIDER_POOL:'["mock"]'});f=await createLipSyncFixture(root);process.env.HV_AUDIO_POLICY_FILE=join(root,"audio-policy.json");process.env.HV_LIPSYNC_POLICY_FILE=join(root,"lipsync-policy.json");result=await completeLipSyncFixture(f);server=createApiServer({port:0,hostname:"127.0.0.1",queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),costLedgerPath:join(root,"ledger.json"),artifactRoot:f.artifacts,rateLimit:{api:{limit:10000,windowMs:60000}}});},60000);
afterAll(async()=>{await server?.stop(true);for(const [k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}if(!resolve(root).startsWith(resolve(tmpdir())+sep+"hv-lipsync-api-"))throw new Error("Unexpected fixture root");rmSync(root,{recursive:true,force:true});});
const call=(path:string,method="GET",body?:unknown,token=f.owner.token)=>fetch(new URL(path,server.url),{method,headers:{authorization:"Bearer "+token,"content-type":"application/json"},...(body===undefined?{}:{body:JSON.stringify(body)})});
test("owner can inspect a verified speaker frame; local generation stays disabled and private provider inputs are not exposed",async()=>{
  const base="/api/projects/"+f.project.id+"/lip-sync",view=await(await call(base)).json() as any;expect(view.enabled).toBe(false);expect(view.sources.filter((s:any)=>!s.unavailable)).toHaveLength(2);
  expect((await call(base,"GET",undefined,"foreign")).status).toBe(401);const quote=await(await call(base+"/"+f.dialogue.id)).json() as any;expect(quote.lines[0].character).toBe("MARLA");
  const previewBody={sourceRevision:quote.sourceRevision,shotId:quote.lines[0].shotId,lineIndex:0,frame:0},preview=await(await call(base+"/"+f.dialogue.id+"/preview","POST",previewBody)).json() as any;expect(preview.rgbSha256).toBe(f.preview.rgbSha256);expect(preview.image.startsWith("data:image/png;base64,")).toBe(true);
  expect((await call(base+"/"+f.dialogue.id+"/preview","POST",{...previewBody,sourceRevision:"0".repeat(64)})).status).toBe(409);
  expect((await call(base+"/"+f.dialogue.id+"/preview","POST",{...previewBody,videoUrl:"https://untrusted.test"})).status).toBe(409);
  expect((await call(base+"/"+f.dialogue.id,"POST",{idempotencyKey:"disabled",generationApproved:true})).status).toBe(503);
  const job=await(await call("/api/jobs/"+result.done.id)).json() as any;expect(job.lipSync.source).toBeUndefined();expect(job.lipSyncPrepared).toBeUndefined();expect(job.lipSyncCheckpoint).toBeUndefined();expect(job.lipSyncBilling.actualUsd).toBeNull();expect((await fetch(new URL(job.output.mp4Url,server.url))).status).toBe(200);
  const token=mintArtifactToken(f.project.id,result.done.id,Date.now()+60000);expect((await fetch(new URL("/artifacts/"+token+"/"+f.prepared.video.path,server.url))).status).toBe(404);
},30000);
test("quality reviews bind exact output, reject stale updates, gate chosen export and preserve the earlier cut",async()=>{
  const base="/api/projects/"+f.project.id,revision=contentHash(result.done.output),selection={jobId:result.done.id,sourceJobId:f.film.id,expectedVersion:0,expectedOutputRevision:revision};
  expect((await call(base+"/dialogue-selection","PUT",selection)).status).toBe(409);
  const review={mouthSync:4,faceStability:4,expression:4,decision:"accept",notes:"Synthetic fixture assessment only.",expectedVersion:0,expectedOutputRevision:revision};
  expect((await call(base+"/lip-sync/"+result.done.id+"/review","PUT",{...review,expectedOutputRevision:"1".repeat(64)})).status).toBe(409);
  expect((await call(base+"/lip-sync/"+result.done.id+"/review","PUT",review)).status).toBe(200);expect((await call(base+"/lip-sync/"+result.done.id+"/review","PUT",review)).status).toBe(409);
  expect((await call(base+"/dialogue-selection","PUT",selection)).status).toBe(200);const state=await(await call(base)).json() as any;expect(state.dialogueExport.job.id).toBe(result.done.id);expect(state.dialogueSelections.version).toBe(1);
  expect((await call(base+"/dialogue-selection","PUT",{...selection,jobId:f.dialogue.id,expectedVersion:1,expectedOutputRevision:contentHash(f.dialogue.output)})).status).toBe(200);expect(f.store.get(result.done.id)!.lipSyncReviews!.entries).toHaveLength(1);
});
test("drained lip-sync snapshots retain unknown liability, reject schema downgrade and preserve tombstoned billing",()=>{
  const at=new Date().toISOString(),receipt=result.receipt,attempt:StoredLipSyncAttempt={id:receipt.intent.attemptId,jobId:f.job.id,projectId:f.project.id,shotId:f.plan.shotId,workerId:"fixture-lipsync",leaseVersion:1,status:"unknown",estimatedUsd:5,actualUsd:null,createdAt:at,updatedAt:at,lipSync:{schema:"hv-lipsync-attempt/1",intent:receipt.intent,reservation:receipt.reservation,accountRevision:LIPSYNC_POLICY.accountRevision,policyRevision:LIPSYNC_POLICY.revision,receipt}};
  const state:StateSnapshot={schema:"hv-state/2",projects:f.projects.snapshot(),jobs:[f.store.get(result.done.id)!],reviews:[],ledger:{events:[],lipSyncAttempts:[attempt],reservations:[{jobId:f.job.id,stage:"lip-sync",amountUsd:5,remainingUsd:5,createdAt:at}]}};expect(validateSnapshot(state)).toEqual(state);
  expect(()=>validateSnapshot({...state,schema:"hv-state/1"})).toThrow("schema 2");expect(()=>validateSnapshot({...state,ledger:{...state.ledger,reservations:[]}})).toThrow("hold");
  const changed=structuredClone(state);changed.ledger.lipSyncAttempts![0]!.lipSync.receipt!.remote!.id="different";expect(()=>validateSnapshot(changed)).toThrow();
  const tombstone={...state,projects:{version:1 as const,projects:[],reviewLinks:[],takenDown:[f.project.id],takedownLog:[{projectId:f.project.id,at,reason:"content removed"}]},jobs:[]};expect(validateSnapshot(tombstone)).toEqual(tombstone);
  const path=join(root,"lip-ledger.json");writeFileSync(path,JSON.stringify(state.ledger));expect(()=>new CostLedger(path)).toThrow("PostgreSQL restore");
});
test("revoked voice permission withholds lip-sync playback and a previously selected export",async()=>{
  const saved=readFileSync(join(root,"audio-policy.json"));const view=await(await call("/api/jobs/"+result.done.id)).json() as any;
  try{writeFileSync(join(root,"audio-policy.json"),JSON.stringify({schema:"hv-audio-policies/1",policies:[]}));expect((await fetch(new URL(view.output.mp4Url,server.url))).status).toBe(404);const denied=await(await call("/api/jobs/"+result.done.id)).json() as any;expect(denied.output).toBeUndefined();expect(denied.mediaUnavailable).toBeTruthy();}finally{writeFileSync(join(root,"audio-policy.json"),saved);}
});
