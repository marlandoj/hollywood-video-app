import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../src/server";
import {ProjectService} from "../src/index";
import {DurableJobStore,LeaseError} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {validateSnapshot,type StateSnapshot} from "../../storage/src/snapshots";
import {CAST_INPUT} from "../../../test/fixtures/casting";
const SCRIPT="INT. ROOM - DAY\n\nMarla greets Kevin.\n\nMARLA\nWelcome to the garden.\n\nKEVIN\nThank you for inviting me.\n\nEXT. PATH - DAY\n\nA lamp glows.";
const keys=["HV_TOKEN_SECRET","HV_ANIMATIC_PROVIDER_POOL","HV_PROVIDER_POOL","HV_NARRATION","HV_ANIMATIC_CAPTIONS","HV_ESPEAK_PATH"],saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
const fixtures:{root:string;server:ReturnType<typeof createApiServer>}[]=[];
afterAll(async()=>{for(const f of fixtures){await f.server.stop(true);rmSync(f.root,{recursive:true,force:true});}for(const [key,value]of Object.entries(saved)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
async function fixture(){
  Object.assign(process.env,{HV_TOKEN_SECRET:"dialogue-api-fixture-at-least-thirty-two-characters",HV_NARRATION:"1",HV_ANIMATIC_CAPTIONS:"0",HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_PROVIDER_POOL:'["image:mock"]'});
  const root=mkdtempSync(join(tmpdir(),"hv-dialogue-api-")),paths={queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json")};
  const server=createApiServer({port:0,hostname:"127.0.0.1",...paths,rateLimit:{api:{limit:10000,windowMs:60000}}});fixtures.push({root,server});
  const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const owner=await(await call("/api/projects","POST")).json() as any,base="/api/projects/"+owner.projectId;
  await call(base+"/script","PUT",{text:SCRIPT},owner.token);await call(base+"/rights","POST",{attested:true},owner.token);
  const id=crypto.randomUUID(),character={...CAST_INPUT,name:"Marla",aliases:[],voice:{voice:"en-us+f3",rateWpm:110}};expect((await call(base+"/cast/"+id,"PUT",{character,expectedVersion:0},owner.token)).status).toBe(200);
  const projects=new ProjectService(paths.statePath),store=new DurableJobStore(paths.queuePath),ledger=new CostLedger(paths.costLedgerPath),context={projects,ledger,reviewQueue:new OperatorReviewQueue(join(root,"reviews.json"))};
  expect((await call(base+"/jobs","POST",{idempotencyKey:"source"},owner.token)).status).toBe(202);
  const source=(await processNextJob(store,paths.artifactRoot,context))!;expect(source.failureReason??source.cancelReason).toBeUndefined();expect(source.status).toBe("done");
  const path=base+"/dialogue/"+source.id,quote=await(await call(path,"GET",undefined,owner.token)).json() as any;expect(quote.error).toBeUndefined();
  const body={idempotencyKey:crypto.randomUUID(),sourceRevision:quote.sourceRevision,sourceFilesRevision:quote.sourceFilesRevision,engineVersion:quote.engineVersion,generationApproved:true,
    edits:[{shotId:quote.lines[0].shotId,index:quote.lines[0].index,sourceHash:quote.lines[0].sourceHash,text:"Welcome home.",voice:{...quote.lines[0].voice,rateWpm:250},notes:"A brief greeting."}]};
  const enqueue=(value:Record<string,unknown>=body)=>call(path,"POST",value,owner.token),worker=(over:Record<string,unknown>={})=>processNextJob(store,paths.artifactRoot,{...context,...over});
  return {root,paths,server,call,owner,base,id,character,projects,store,ledger,source,path,quote,body,enqueue,worker};
}
test("owner-bound ADR jobs work on an earlier cut, retain picture and PCM, expose signed audio, and have independent idempotency",async()=>{
  const f=await fixture(),foreign=await(await f.call("/api/projects","POST")).json() as any;
  expect((await f.call(f.path,"GET",undefined,foreign.token)).status).toBe(401);expect((await f.call("/api/projects/"+foreign.projectId+"/dialogue/"+f.source.id,"GET",undefined,foreign.token)).status).toBe(404);
  await f.call(f.base+"/script","PUT",{text:SCRIPT.replace("Welcome to the garden.","A completely different screenplay line.")},f.owner.token);
  const admitted=await f.enqueue();expect(await admitted.clone().text()).not.toContain('"error"');expect(admitted.status).toBe(202);const target=(await f.worker())!;
  expect(target.failureReason??target.cancelReason).toBeUndefined();expect(target.status).toBe("done");expect(target.stage).toBe("dialogue-replacement");expect(target.scriptVersion).toBe(1);expect(target.providerPlan).toBeUndefined();expect(target.routeDecisions).toBeUndefined();
  expect(target.output!.dialogue!.report.lines[0]!.text).toBe("Welcome home.");expect(target.output!.dialogue!.report.lines[1]!.pcmSha256).toBe(f.source.output!.shotRenders![0]!.clip.speech!.lines[1]!.pcmSha256);
  const view=await(await f.call("/api/jobs/"+target.id,"GET",undefined,f.owner.token)).json() as any;expect(view.dialogueCheckpoint).toBeUndefined();expect(view.dialogueReplacement.source).toBeUndefined();expect(view.dialogue.report.lines).toHaveLength(2);
  const wav=await fetch(new URL(view.output.audioUrl,f.server.url));expect(wav.status).toBe(200);expect(wav.headers.get("content-type")).toContain("audio/wav");expect(Buffer.from(await wav.arrayBuffer())).toEqual(readFileSync(join(f.paths.artifactRoot,target.output!.dialogue!.wavPath)));
  expect((await(await f.enqueue()).json() as any).jobId).toBe(target.id);expect((await f.enqueue({...f.body,edits:[{...f.body.edits[0],text:"A different read."}]})).status).toBe(409);
  expect((await f.call(f.base+"/jobs","POST",{idempotencyKey:f.body.idempotencyKey},f.owner.token)).status).toBe(409);
  expect(f.ledger.all().filter(e=>e.jobId===target.id)).toEqual([]);expect(f.ledger.reservedUsd()).toBe(0);
  const snapshot:StateSnapshot={schema:"hv-state/1",projects:f.projects.snapshot(),jobs:f.store.all(),ledger:{events:f.ledger.all(),reservations:[]},reviews:[]};expect(validateSnapshot(snapshot)).toEqual(snapshot);
  const corrupted=structuredClone(snapshot),job=corrupted.jobs.find(j=>j.id===target.id)!;job.dialogueCheckpoint!.dialogue!.report.lines[0]!.startSample++;expect(()=>validateSnapshot(corrupted)).toThrow();
  const independent=structuredClone(snapshot);independent.jobs=[target];independent.ledger={events:[],reservations:[]};expect(validateSnapshot(independent)).toEqual(independent);
},30000);
test("interrupted ADR resumes the checkpoint without resynthesizing, including when the local speech engine is unavailable",async()=>{
  const f=await fixture();expect((await f.enqueue()).status).toBe(202);
  const checkpoint=f.store.checkpointDialogue.bind(f.store);f.store.checkpointDialogue=(...args)=>{checkpoint(...args);throw new LeaseError(args[0],"lease_expired",args[1]);};
  const partial=(await f.worker())!;f.store.checkpointDialogue=checkpoint;expect(partial.status).toBe("running");expect(partial.dialogueCheckpoint).toBeTruthy();
  const old=process.env.HV_ESPEAK_PATH;process.env.HV_ESPEAK_PATH=join(f.root,"no-engine");
  try{const resumed=(await f.worker({now:()=>Date.now()+600000}))!;expect(resumed.failureReason??resumed.cancelReason).toBeUndefined();expect(resumed.status).toBe("done");expect(resumed.resumedCount).toBe(1);expect(resumed.output).toEqual(partial.dialogueCheckpoint);}finally{if(old===undefined)delete process.env.HV_ESPEAK_PATH;else process.env.HV_ESPEAK_PATH=old;}
},30000);
test("tampered checkpoints and revoked current cast permissions cannot publish dialogue jobs",async()=>{
  const f=await fixture();expect((await f.enqueue()).status).toBe(202);const checkpoint=f.store.checkpointDialogue.bind(f.store);
  f.store.checkpointDialogue=(...args)=>{checkpoint(...args);throw new LeaseError(args[0],"lease_expired",args[1]);};const partial=(await f.worker())!;f.store.checkpointDialogue=checkpoint;
  const path=join(f.paths.artifactRoot,partial.dialogueCheckpoint!.dialogue!.wavPath),bad=readFileSync(path);bad[100]^=1;writeFileSync(path,bad);
  const rejected=(await f.worker({now:()=>Date.now()+600000}))!;expect(rejected.status).toBe("cancelled");expect(rejected.cancelReason).toContain("checksum");expect(rejected.output).toBeUndefined();
  expect((await f.enqueue({...f.body,idempotencyKey:crypto.randomUUID()})).status).toBe(202);f.projects.saveCharacter(f.owner.token,f.id,{...f.character,permission:{...f.character.permission,status:"revoked"}},1);
  const revoked=(await f.worker())!;expect(revoked.status).toBe("failed");expect(revoked.failureKind).toBe("policy_refusal");expect(revoked.output).toBeUndefined();expect(f.ledger.all().filter(e=>e.jobId===revoked.id)).toEqual([]);
},30000);
test("stale source quotes, unapproved work and line reassignment are refused before queue admission",async()=>{
  const f=await fixture(),before=f.store.all().length;
  expect((await f.enqueue({...f.body,sourceFilesRevision:"a".repeat(64)})).status).toBe(409);expect((await f.enqueue({...f.body,engineVersion:"espeak-"+"f".repeat(64)})).status).toBe(409);
  expect((await f.enqueue({...f.body,generationApproved:false})).status).toBe(409);expect((await f.enqueue({...f.body,edits:[{...f.body.edits[0],sourceHash:"f".repeat(64)}]})).status).toBe(400);
  expect((await f.enqueue({...f.body,sourceJobId:"body-cannot-override-source-path"})).status).toBe(400);
  expect(f.store.all()).toHaveLength(before);expect(f.ledger.reservedUsd()).toBe(0);
  expect((await f.enqueue()).status).toBe(202);const expired=(await f.worker({now:()=>Date.now()+31*86400000}))!;expect(expired.status).toBe("cancelled");expect(expired.output).toBeUndefined();
  const drained:StateSnapshot={schema:"hv-state/1",projects:f.projects.snapshot(),jobs:f.store.all(),ledger:{events:f.ledger.all(),reservations:[]},reviews:[]};expect(validateSnapshot(drained)).toEqual(drained);
},20000);
