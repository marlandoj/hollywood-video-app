import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,renameSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve,sep,dirname} from "node:path";
import {createApiServer} from "../src/server";
import {ProjectService} from "../src/index";
import {DurableJobStore,LeaseError} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {validateSnapshot,type StateSnapshot} from "../../storage/src/snapshots";
import {CAST_INPUT} from "../../../test/fixtures/casting";
import {outputRevision} from "../../planner/src/dialogue-selection";
import {currentCasting} from "../../planner/src/casting";
import {lineSources} from "../../planner/src/performances";
import {parseFountain} from "../../parser/src/index";
import {compileAudioLine} from "../../planner/src/audio-performances";
import {audioTakePlan} from "../../planner/src/audio-jobs";
import {createAudioDelivery} from "../../generator/src/audio-delivery";
import {prepareAudioMedia} from "../../generator/src/audio-media";
import {AUDIO_POLICY,AUDIO_PCM} from "../../../test/fixtures/audio";
import {fetchSpeechLine} from "../../frontend/src/speech-player.js";
const SCRIPT="INT. ROOM - DAY\n\nMarla greets Kevin.\n\nMARLA\nWelcome to the garden.\n\nKEVIN\nThank you for inviting me.\n\nEXT. PATH - DAY\n\nA lamp glows.";
const keys=["HV_TOKEN_SECRET","HV_ANIMATIC_PROVIDER_POOL","HV_PROVIDER_POOL","HV_NARRATION","HV_ANIMATIC_CAPTIONS","HV_ESPEAK_PATH","HV_AUDIO_POLICY_FILE"],saved=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
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
  const report=target.output!.dialogue!.report,retained=report.lines[1]!;
  expect(Buffer.from(await fetchSpeechLine(new URL(view.output.audioUrl,f.server.url).href,report,retained))).toEqual(readFileSync(join(f.paths.artifactRoot,target.output!.dialogue!.wavPath)).subarray(44+retained.startSample*2,44+retained.endSample*2));
  expect((await(await f.enqueue()).json() as any).jobId).toBe(target.id);expect((await f.enqueue({...f.body,edits:[{...f.body.edits[0],text:"A different read."}]})).status).toBe(409);
  expect((await f.call(f.base+"/jobs","POST",{idempotencyKey:f.body.idempotencyKey},f.owner.token)).status).toBe(409);
  expect(f.ledger.all().filter(e=>e.jobId===target.id)).toEqual([]);expect(f.ledger.reservedUsd()).toBe(0);
  const snapshot:StateSnapshot={schema:"hv-state/11",projects:f.projects.snapshot(),jobs:f.store.all(),ledger:{events:f.ledger.all(),reservations:[]},reviews:[]};expect(validateSnapshot(snapshot)).toEqual(snapshot);
  expect(snapshot.jobs.some(job=>(job.executionCheckpoints??job.dialogueReplacement?.source.executionCheckpoints??[]).length>0)).toBe(true);expect(()=>validateSnapshot({...snapshot,schema:"hv-state/10"})).toThrow("schema 11");
  const corrupted=structuredClone(snapshot),job=corrupted.jobs.find(j=>j.id===target.id)!;job.dialogueCheckpoint!.dialogue!.report.lines[0]!.startSample++;expect(()=>validateSnapshot(corrupted)).toThrow();
  const independent=structuredClone(snapshot);independent.jobs=[target];independent.ledger={events:[],reservations:[]};expect(validateSnapshot(independent)).toEqual(independent);
},30000);
test("chosen dialogue exports survive reload, roll back retained bytes and keep review links on their original output",async()=>{
  const f=await fixture();expect((await f.enqueue()).status).toBe(202);const v1=(await f.worker())!;
  const choose=(job:typeof v1,version:number,over:Record<string,unknown>={})=>f.call(f.base+"/dialogue-selection","PUT",{jobId:job.id,sourceJobId:f.source.id,expectedVersion:version,expectedOutputRevision:outputRevision(job),...over},f.owner.token);
  const saved=await choose(v1,0);expect(await saved.clone().text()).not.toContain('"error"');expect(saved.status).toBe(200);
  expect((await choose(f.source,0)).status).toBe(409);expect((await choose(v1,1,{sourceJobId:crypto.randomUUID()})).status).toBe(409);expect((await choose(v1,1,{expectedOutputRevision:"a".repeat(64)})).status).toBe(409);
  const reopened=new ProjectService(f.paths.statePath).authorize(f.owner.token)!;expect(reopened.dialogueSelections.version).toBe(1);expect(reopened.dialogueSelections.entries[0]!.jobId).toBe(v1.id);
  const linkResponse=await f.call(f.base+"/reviews","POST",{permission:"approve",jobId:v1.id,expectedOutputRevision:outputRevision(v1)},f.owner.token);expect(linkResponse.status).toBe(201);const link=await linkResponse.json() as any;
  expect((await choose(f.source,1)).status).toBe(200);
  const state=await(await f.call(f.base,"GET",undefined,f.owner.token)).json() as any;expect(state.dialogueSelections.version).toBe(2);expect(state.dialogueExport.job.id).toBe(f.source.id);
  const reviewed=await(await f.call("/api/reviews/"+link.token)).json() as any;expect(reviewed.jobId).toBe(v1.id);expect(reviewed.output.mp4Url).toContain(v1.id);
  const foreign=await(await f.call("/api/projects","POST")).json() as any;expect((await f.call("/api/projects/"+foreign.projectId+"/dialogue-selection","PUT",{jobId:v1.id,sourceJobId:f.source.id,expectedVersion:0,expectedOutputRevision:outputRevision(v1)},foreign.token)).status).toBe(404);
  expect((await choose(v1,2)).status).toBe(200);
  const snapshot:StateSnapshot={schema:"hv-state/11",projects:new ProjectService(f.paths.statePath).snapshot(),jobs:f.store.all(),ledger:{events:f.ledger.all(),reservations:[]},reviews:[]};expect(validateSnapshot(snapshot)).toEqual(snapshot);
  expect(snapshot.jobs.some(job=>(job.executionCheckpoints??job.dialogueReplacement?.source.executionCheckpoints??[]).length>0)).toBe(true);expect(()=>validateSnapshot({...snapshot,schema:"hv-state/10"})).toThrow("schema 11");
  const changed=structuredClone(snapshot);changed.projects.projects[0]!.dialogueSelections!.entries[0]!.jobId=f.source.id;expect(()=>validateSnapshot(changed)).toThrow();
  const old=process.env.HV_ESPEAK_PATH;process.env.HV_ESPEAK_PATH=join(f.root,"missing-engine");try{expect((await choose(f.source,3)).status).toBe(200);expect((await choose(v1,4)).status).toBe(200);}finally{if(old===undefined)delete process.env.HV_ESPEAK_PATH;else process.env.HV_ESPEAK_PATH=old;}
  expect(()=>f.projects.selectDialogueVersion(f.owner.token,{...v1,linkExpiresAt:new Date(Date.now()-1).toISOString()},f.source.id,5,outputRevision(v1))).toThrow("expired");
  const wavPath=join(f.paths.artifactRoot,v1.output!.dialogue!.wavPath),wav=readFileSync(wavPath),bad=Buffer.from(wav);bad[100]^=1;writeFileSync(wavPath,bad);expect((await choose(v1,5)).status).toBe(400);writeFileSync(wavPath,wav);
  f.projects.saveCharacter(f.owner.token,f.id,{...f.character,permission:{...f.character.permission,status:"revoked"}},1);
  expect((await choose(v1,5)).status).toBe(400);const revoked=await(await f.call(f.base,"GET",undefined,f.owner.token)).json() as any;expect(revoked.dialogueExport.job).toBeUndefined();expect(revoked.dialogueExport.error).toBeTruthy();
  expect((await f.call("/api/reviews/"+link.token)).status).toBe(400);
  expect((await f.call("/api/reviews/"+link.token+"/decision","POST",{decision:"approved"})).status).toBe(400);
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
  const drained:StateSnapshot={schema:"hv-state/11",projects:f.projects.snapshot(),jobs:f.store.all(),ledger:{events:f.ledger.all(),reservations:[]},reviews:[]};expect(validateSnapshot(drained)).toEqual(drained);
  expect(drained.jobs.some(job=>(job.executionCheckpoints??job.dialogueReplacement?.source.executionCheckpoints??[]).length>0)).toBe(true);expect(()=>validateSnapshot({...drained,schema:"hv-state/10"})).toThrow("schema 11");
},20000);

test("successive dialogue versions copy inherited reads exactly and use their own media after original picture expiry",async()=>{
  const f=await fixture();f.projects.extendRetention(f.owner.projectId,60,"Dialogue version retention fixture");expect((await f.enqueue()).status).toBe(202);
  const v1=(await f.worker({now:()=>Date.now()+2*86400000}))!;expect(v1.status).toBe("done");
  const make=async(parent:typeof v1,index:number,text:string)=>{const path=f.base+"/dialogue/"+parent.id,quote=await(await f.call(path,"GET",undefined,f.owner.token)).json() as any;expect(quote.error).toBeUndefined();expect(quote.originalJobId).toBe(f.source.id);expect(quote.lines[0].text).toBe("Welcome home.");
    const body={idempotencyKey:crypto.randomUUID(),generationApproved:true,sourceRevision:quote.sourceRevision,sourceFilesRevision:quote.sourceFilesRevision,baselineRevision:quote.baselineRevision,engineVersion:quote.engineVersion,
      edits:[{shotId:quote.lines[index].shotId,index:quote.lines[index].index,sourceHash:quote.lines[index].sourceHash,text,voice:quote.lines[index].voice}]};
    expect((await f.call(path,"POST",{...body,baselineRevision:"f".repeat(64)},f.owner.token)).status).toBe(409);
    const response=await f.call(path,"POST",body,f.owner.token);expect(await response.clone().text()).not.toContain('"error"');expect(response.status).toBe(202);return {path,body};};
  await make(v1,1,"My pleasure.");const v2=(await f.worker({now:()=>Date.now()+2*86400000}))!;expect(v2.failureReason??v2.cancelReason).toBeUndefined();expect(v2.status).toBe("done");
  const lines1=v1.output!.dialogue!.report.lines,lines2=v2.output!.dialogue!.report.lines;
  expect(v2.dialogueReplacement!.plan.baseline!.jobId).toBe(v1.id);expect(v2.dialogueReplacement!.source.id).toBe(f.source.id);expect(v2.dialogueReplacement!.source.dialogueReplacement).toBeUndefined();
  expect(lines2[0]!.text).toBe("Welcome home.");expect(lines2[0]!.pcmSha256).toBe(lines1[0]!.pcmSha256);expect(lines2[0]!.endSample).toBe(lines1[0]!.endSample);expect(lines2[0]!.replaced).toBe(false);expect(lines2[1]!.text).toBe("My pleasure.");
  const pcm=(job:typeof v1,index:number)=>{const line=job.output!.dialogue!.report.lines[index]!;return readFileSync(join(f.paths.artifactRoot,job.output!.dialogue!.wavPath)).subarray(44+line.startSample*2,44+line.endSample*2);};expect(pcm(v2,0)).toEqual(pcm(v1,0));
  await make(v2,0,"Hello again.");
  for(const id of [f.source.id,v1.id]){const path=resolve(f.paths.artifactRoot,f.owner.projectId,id);expect(path.startsWith(resolve(f.root)+sep)).toBe(true);rmSync(path,{recursive:true});}
  const v3=(await f.worker({now:()=>Date.now()+31*86400000}))!;expect(v3.failureReason??v3.cancelReason).toBeUndefined();expect(v3.status).toBe("done");expect(v3.output!.dialogue!.report.lines[0]!.text).toBe("Hello again.");expect(pcm(v3,1)).toEqual(pcm(v2,1));expect(v3.output!.dialogue!.report.videoStreamSha256).toBe(v1.output!.dialogue!.report.videoStreamSha256);
  const independent:StateSnapshot={schema:"hv-state/11",projects:f.projects.snapshot(),jobs:[v3],ledger:{events:[],reservations:[]},reviews:[]};expect(validateSnapshot(independent)).toEqual(independent);
  expect(independent.jobs.some(job=>(job.executionCheckpoints??job.dialogueReplacement?.source.executionCheckpoints??[]).length>0)).toBe(true);expect(()=>validateSnapshot({...independent,schema:"hv-state/10"})).toThrow("schema 11");
  const corrupted=structuredClone(independent);corrupted.jobs[0]!.dialogueReplacement!.plan.baseline!.lines[1]!.text="An invented inherited read.";expect(()=>validateSnapshot(corrupted)).toThrow();
  await make(v2,0,"Hello again.");const wav=join(f.paths.artifactRoot,v2.output!.dialogue!.wavPath),bad=readFileSync(wav);bad[100]^=1;writeFileSync(wav,bad);
  const tampered=(await f.worker())!;expect(tampered.status).toBe("cancelled");expect(tampered.cancelReason).toContain("checksum");expect(tampered.output).toBeUndefined();
},40000);

test("owner applies a retained audition with no speech runtime, resumes its checkpoint and retains selection while voice withdrawal blocks signed playback",async()=>{
  const f=await fixture(),policyPath=join(f.root,"audio-policy.json");writeFileSync(policyPath,JSON.stringify({schema:"hv-audio-policies/1",policies:[AUDIO_POLICY]}));process.env.HV_AUDIO_POLICY_FILE=policyPath;
  const project=f.projects.snapshot().projects[0]!,casting=currentCasting(project.id,project.castingHistory),original=lineSources(parseFountain(SCRIPT).scenes[0]!.dialogue)[0]!;
  const line=compileAudioLine(original,{schema:"hv-audio-voice/1",provider:"cartesia",language:"en",voice:{id:AUDIO_POLICY.voiceId,catalogueRevision:AUDIO_POLICY.catalogueRevision,permissionRevision:AUDIO_POLICY.permissionRevision},controls:{speed:1,volume:1,emotion:"calm"},pronunciations:[]},{sourceHash:original.hash,beforeMs:0,afterMs:0});
  // Seed owned synthetic audio only. Actual provider journalling is covered by PostgreSQL tests.
  const audio=f.store.enqueue({id:crypto.randomUUID(),projectId:project.id,idempotencyKey:"seeded-retained-audio",stage:"audio-take",tier:"free",scriptVersion:1,scriptText:SCRIPT,casting,rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,
    totalFrames:0,costCapUsd:.25,budgetReservedUsd:.25,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:60000,audioTake:audioTakePlan(0,f.id,line,AUDIO_POLICY,"local")});
  f.store.claimNext(Date.now(),{},{workerId:"seed"});const delivered=createAudioDelivery(line,crypto.randomUUID(),AUDIO_PCM.subarray(0,24000*2),[{text:"Welcome",startSec:0,endSec:.5}],[{text:"w",startSec:0,endSec:.1}]);
  const scratch=mkdtempSync(join(f.paths.artifactRoot,".seed-audition-")),output=prepareAudioMedia(audio,scratch,delivered.report,delivered.wav),directory=join(f.paths.artifactRoot,dirname(output.wavPath));mkdirSync(dirname(directory),{recursive:true});renameSync(scratch,directory);
  f.store.checkpointAudio(audio.id,"seed",output);f.store.completeAudio(audio.id,"seed",output);
  const priorEngine=process.env.HV_ESPEAK_PATH,priorNarration=process.env.HV_NARRATION;
  try{
    process.env.HV_ESPEAK_PATH=join(f.root,"no-speech-executable");process.env.HV_NARRATION="0";
    const quote=await(await f.call(f.path,"GET",undefined,f.owner.token)).json() as any;expect(quote.error).toBeUndefined();expect(quote.temporaryEnabled).toBe(false);expect(quote.lines[0].auditions).toHaveLength(1);expect(quote.lines[1].auditions).toEqual([]);
    const take=quote.lines[0].auditions[0];expect(take.unavailable).toBeNull();expect(take.durationSec).toBe(.5);
    const body={...f.body,idempotencyKey:crypto.randomUUID(),engineVersion:quote.engineVersion,conversionEngineVersion:quote.conversionEngineVersion,edits:[{shotId:quote.lines[0].shotId,index:0,sourceHash:quote.lines[0].sourceHash,auditionJobId:take.jobId,auditionRevision:take.revision}]};
    expect((await f.enqueue({...body,edits:[{...body.edits[0],audition:{anything:true}}]})).status).toBe(400);
    expect((await f.enqueue({...body,edits:[{...body.edits[0],auditionRevision:"f".repeat(64)}]})).status).toBe(409);
    expect((await f.enqueue({...body,edits:[{...body.edits[0],auditionJobId:crypto.randomUUID()}]})).status).toBe(400);
    expect((await f.enqueue({...body,edits:[{...body.edits[0],index:1,sourceHash:quote.lines[1].sourceHash}]})).status).toBe(400);
    const costsBefore=f.ledger.all(),admitted=await Promise.all([f.enqueue(body),f.enqueue(body)]);expect(admitted.map(r=>r.status)).toEqual([202,202]);const ids=await Promise.all(admitted.map(r=>r.json() as Promise<any>));expect(ids[0].jobId).toBe(ids[1].jobId);
    const checkpoint=f.store.checkpointDialogue.bind(f.store);f.store.checkpointDialogue=(...args)=>{checkpoint(...args);throw new LeaseError(args[0],"lease_expired",args[1]);};
    const partial=(await f.worker())!;f.store.checkpointDialogue=checkpoint;expect(partial.failureReason??partial.cancelReason).toBeUndefined();expect(partial.status).toBe("running");expect(partial.dialogueCheckpoint).toBeTruthy();
    const done=(await f.worker({now:()=>Date.now()+600000}))!;expect(done.failureReason??done.cancelReason).toBeUndefined();expect(done.status).toBe("done");expect(done.output).toEqual(partial.dialogueCheckpoint);expect(done.resumedCount).toBe(1);expect(f.ledger.all()).toEqual(costsBefore);expect(f.ledger.reservedUsd()).toBe(0);
    const view=await(await f.call("/api/jobs/"+done.id,"GET",undefined,f.owner.token)).json() as any;expect(view.dialogue.report.lines[0].voice).toBeNull();expect(view.dialogue.report.lines[0].audition.source.jobId).toBe(audio.id);
    expect(view.appliedAuditionBilling).toEqual([{jobId:audio.id,voiceLabel:AUDIO_POLICY.label,state:"unavailable",actualUsd:null,heldUsd:null}]);
    const signed=view.output.audioUrl;expect((await fetch(new URL(signed,f.server.url))).status).toBe(200);
    const choose=(job:typeof done,version:number)=>f.call(f.base+"/dialogue-selection","PUT",{jobId:job.id,sourceJobId:f.source.id,expectedVersion:version,expectedOutputRevision:outputRevision(job)},f.owner.token);
    expect((await choose(done,0)).status).toBe(200);const link=await(await f.call(f.base+"/reviews","POST",{permission:"read",jobId:done.id,expectedOutputRevision:outputRevision(done)},f.owner.token)).json() as any;expect(link.token).toBeTruthy();
    expect((await f.enqueue({...body,idempotencyKey:crypto.randomUUID()})).status).toBe(202);
    f.store.checkpointDialogue=(...args)=>{checkpoint(...args);writeFileSync(policyPath,JSON.stringify({schema:"hv-audio-policies/1",policies:[]}));};
    const withdrawn=(await f.worker())!;expect(withdrawn.status).toBe("failed");expect(withdrawn.failureKind).toBe("policy_refusal");expect(withdrawn.output).toBeUndefined();expect(f.ledger.reservedUsd()).toBe(0);
    f.store.checkpointDialogue=checkpoint;writeFileSync(policyPath,JSON.stringify({schema:"hv-audio-policies/1",policies:[AUDIO_POLICY]}));
    const independent:StateSnapshot={schema:"hv-state/11",projects:f.projects.snapshot(),jobs:[done],ledger:{events:[],reservations:[]},reviews:[]};expect(validateSnapshot(independent)).toEqual(independent);
    expect(independent.jobs.some(job=>(job.executionCheckpoints??job.dialogueReplacement?.source.executionCheckpoints??[]).length>0)).toBe(true);expect(()=>validateSnapshot({...independent,schema:"hv-state/10"})).toThrow("schema 11");
    rmSync(directory,{recursive:true,force:true});expect((await fetch(new URL(signed,f.server.url))).status).toBe(200);expect((await choose(f.source,1)).status).toBe(200);expect((await(await f.call("/api/reviews/"+link.token)).json() as any).jobId).toBe(done.id);
    writeFileSync(policyPath,JSON.stringify({schema:"hv-audio-policies/1",policies:[]}));expect((await fetch(new URL(signed,f.server.url))).status).toBe(404);expect((await choose(done,2)).status).toBe(400);
    const unavailable=await(await f.call("/api/jobs/"+done.id,"GET",undefined,f.owner.token)).json() as any;expect(unavailable.output).toBeUndefined();expect(unavailable.mediaUnavailable).toContain("no longer authorized");expect((await f.call("/api/reviews/"+link.token)).status).toBe(400);
  }finally{if(priorEngine===undefined)delete process.env.HV_ESPEAK_PATH;else process.env.HV_ESPEAK_PATH=priorEngine;if(priorNarration===undefined)delete process.env.HV_NARRATION;else process.env.HV_NARRATION=priorNarration;}
},30000);
