import {expect,test} from "bun:test";
import {mkdtempSync,mkdirSync,renameSync,rmSync,writeFileSync,readFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {ProjectService} from "../../api/src/index";
import {DurableJobStore} from "../../queue/src/index";
import {currentCasting} from "../../planner/src/casting";
import {parseFountain} from "../../parser/src/index";
import {lineSources} from "../../planner/src/performances";
import {compileAudioLine} from "../../planner/src/audio-performances";
import {audioTakePlan,validateAudioPolicy,assertAudioTakePermission} from "../../planner/src/audio-jobs";
import {CartesiaAudioProvider,validateAudioOutcome} from "../src/cartesia-audio";
import {prepareAudioMedia,verifyAudioMedia} from "../src/audio-media";
import {validateAudioInvoice,validateStoredAudioAttempt,type StoredAudioAttempt} from "../../storage/src/audio-ledger";
import {validateSnapshot,type StateSnapshot} from "../../storage/src/snapshots";
import {CostLedger} from "../../operator/src/index";
import {contentHash} from "../src/capabilities";
import {CAST_INPUT} from "../../../test/fixtures/casting";
import {AUDIO_POLICY,audioSse,audioIntent} from "../../../test/fixtures/audio";
function setup(){
  process.env.HV_TOKEN_SECRET="audio-jobs-fixture-secret-at-least-thirty-two-characters";
  const projects=new ProjectService(),owner=projects.createAnonymousProject(),script="INT. GARDEN - DAY\n\nMarla waves.\n\nMARLA\nHello.",characterId=crypto.randomUUID();
  projects.editScript(owner.token,script);projects.attestRights(owner.token);projects.saveCharacter(owner.token,characterId,{...CAST_INPUT,name:"Marla",aliases:[]},0);
  const project=projects.snapshot().projects[0]!,casting=currentCasting(project.id,project.castingHistory),source=lineSources(parseFountain(script).scenes[0]!.dialogue)[0]!;
  const line=compileAudioLine(source,{schema:"hv-audio-voice/1",provider:"cartesia",language:"en",voice:{id:AUDIO_POLICY.voiceId,catalogueRevision:AUDIO_POLICY.catalogueRevision,permissionRevision:AUDIO_POLICY.permissionRevision},controls:{speed:1,volume:1,emotion:"calm"},pronunciations:[]},{sourceHash:source.hash,beforeMs:250,afterMs:500});
  const queue=DurableJobStore.fromJobs([]),input={id:crypto.randomUUID(),projectId:project.id,idempotencyKey:"fixture",tier:"free" as const,stage:"audio-take" as const,scriptVersion:1,scriptText:script,casting,rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,
    totalFrames:0,costCapUsd:.25,budgetReservedUsd:.25,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:180000,audioTake:audioTakePlan(0,characterId,line,AUDIO_POLICY,"local")};
  queue.enqueue(input);const job=queue.claimNext(Date.now(),{},{workerId:"audio-fixture"})!;return {projects,project,queue,input,job,line};
}
test("auditions bind screenplay, character, policy window and idempotent request while rejecting film and zero-cost paths",()=>{
  const f=setup();assertAudioTakePermission(f.job,f.project);
  expect(()=>validateAudioPolicy(AUDIO_POLICY,Date.parse(AUDIO_POLICY.expiresAt))).toThrow("currently valid");
  expect(f.queue.enqueue({...f.input,id:crypto.randomUUID()})).toEqual(f.job);
  expect(()=>f.queue.enqueue({...f.input,audioTake:{...f.input.audioTake,requestHash:"f".repeat(64)}})).toThrow("idempotency");
  expect(()=>assertAudioTakePermission(f.job,{...f.project,versions:[]})).toThrow("screenplay");
  expect(()=>f.queue.recordCost(f.job.id,"audio-fixture",{provider:"cartesia",model:"fixture",prompt_tokens:0,output_frames:0,gpu_seconds:0,total_cost_usd:0})).toThrow("invoice");
  expect(()=>f.queue.complete(f.job.id,"audio-fixture",{} as never)).toThrow("own completion");
  for(const change of [{stage:"final"},{costCapUsd:0},{providerSpec:"mock"},{totalFrames:30},{scriptText:f.input.scriptText.replace("Hello.","Changed.")}])
    expect(()=>DurableJobStore.fromJobs([]).enqueue({...f.input,...change} as never)).toThrow();
});
test("audio checkpoint requires exact owned 48 kHz bytes; changed PCM and invented output cannot publish",async()=>{
  const f=setup(),root=mkdtempSync(join(tmpdir(),"hv-audio-media-")),scratch=join(root,"scratch");mkdirSync(scratch);
  try{
    const provider=new CartesiaAudioProvider({apiKey:"fixture-only",fetchImpl:(async(_url,init)=>audioSse(JSON.parse(String(init!.body)).context_id)) as typeof fetch});
    const result=await provider.synthesize(f.line,{authorize:async()=>({id:f.job.id,heldUsd:.25,priceRevision:AUDIO_POLICY.priceRevision}),assertCurrent:async()=>{},recordOutcome:async o=>validateAudioOutcome(o)});
    const output=prepareAudioMedia(f.job,scratch,result.report,result.wav),destination=join(root,dirname(output.wavPath));mkdirSync(dirname(destination),{recursive:true});renameSync(scratch,destination);verifyAudioMedia(f.job,output,root);
    expect(()=>f.queue.completeAudio(f.job.id,"audio-fixture",output)).toThrow("saved");
    f.queue.checkpointAudio(f.job.id,"audio-fixture",output);expect(f.queue.completeAudio(f.job.id,"audio-fixture",output).audioOutput).toEqual(output);
    const file=join(root,output.wavPath),bytes=readFileSync(file);expect(bytes.readUInt32LE(24)).toBe(48000);bytes[50000]^=1;writeFileSync(file,bytes);
    expect(()=>verifyAudioMedia(f.job,output,root)).toThrow();
  }finally{rmSync(root,{recursive:true,force:true});}
});
test("unknown audio liability survives drained snapshots and refuses discarded holds, forged costs or JSON rollback",()=>{
  const f=setup(),at=new Date().toISOString(),intent=audioIntent(f.line);
  const attempt:StoredAudioAttempt={id:intent.attemptId,jobId:f.job.id,projectId:f.job.projectId,workerId:"audio-fixture",leaseVersion:1,status:"running",estimatedUsd:.25,actualUsd:null,createdAt:at,updatedAt:at,
    audio:{schema:"hv-audio-attempt/1",intent,reservation:{id:f.job.id,priceRevision:AUDIO_POLICY.priceRevision,heldUsd:.25},accountRevision:AUDIO_POLICY.accountRevision,policyRevision:AUDIO_POLICY.revision}};
  f.queue.fail(f.job.id,"audio-fixture","interrupted");
  const snapshot:StateSnapshot={schema:"hv-state/1",projects:f.projects.snapshot(),jobs:f.queue.all(),reviews:[],ledger:{events:[],audioAttempts:[attempt],reservations:[{jobId:f.job.id,stage:"audio-take",amountUsd:.25,remainingUsd:.25,createdAt:at}]}};
  expect(validateSnapshot(snapshot)).toEqual(snapshot);
  expect(()=>validateSnapshot({...snapshot,ledger:{...snapshot.ledger,reservations:[]}})).toThrow("hold");
  expect(()=>validateStoredAudioAttempt({...attempt,actualUsd:0})).toThrow("actual cost");
  const event={projectId:f.project.id,jobId:f.job.id,at,shotId:"audio-line",provider:"cartesia",model:"fixture",stage:"audio-take" as const,total_cost_usd:0,prompt_tokens:0,output_frames:0,gpu_seconds:0};
  expect(()=>validateSnapshot({...snapshot,ledger:{...snapshot.ledger,events:[event]}})).toThrow("provenance");
  const root=mkdtempSync(join(tmpdir(),"hv-audio-rollback-"));try{const file=join(root,"ledger.json");writeFileSync(file,JSON.stringify(snapshot.ledger));expect(()=>new CostLedger(file)).toThrow("PostgreSQL restore");}finally{rmSync(root,{recursive:true,force:true});}
});
test("invoice allocations conserve six-decimal totals and reject duplicate attempts or a successful zero-cost assumption",()=>{
  const f=setup(),data={schema:"hv-audio-invoice-allocation/1" as const,documentSha256:"a".repeat(64),accountRevision:AUDIO_POLICY.accountRevision,totalUsd:.3,at:new Date().toISOString(),allocations:[{attemptId:crypto.randomUUID(),usd:.1},{attemptId:crypto.randomUUID(),usd:.2}]};
  expect(validateAudioInvoice({...data,revision:contentHash(data)}).totalUsd).toBe(.3);
  for(const altered of [{...data,totalUsd:.2},{...data,allocations:[data.allocations[0]!,data.allocations[0]!]},{...data,allocations:[{...data.allocations[0]!,usd:.0000001}]}])
    expect(()=>validateAudioInvoice({...altered,revision:contentHash(altered)})).toThrow();
  expect(()=>validateAudioOutcome({schema:"hv-audio-attempt-outcome/1",intent:audioIntent(f.line),reservation:{id:f.job.id,priceRevision:AUDIO_POLICY.priceRevision,heldUsd:.25},dispatched:true,providerState:"completed",deliveryState:"ready",httpStatus:200,providerRequestId:null,billing:{state:"not-incurred",actualUsd:0},deliveryRevision:"b".repeat(64)})).toThrow("billing");
});
