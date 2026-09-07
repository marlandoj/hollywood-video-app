import {afterAll,beforeAll,expect,test} from "bun:test";
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {StudioDatabase} from "../src/database";
import {PostgresJobStore} from "../src/jobs";
import {PostgresAudioLedger,type AudioInvoice} from "../src/audio-ledger";
import {PostgresCostLedger} from "../src/ledger";
import {PostgresReviewQueue} from "../src/reviews";
import {PostgresRetention} from "../src/retention";
import {PostgresArtifactStore,objectClient} from "../src/artifacts";
import {exportStateSnapshot,importStateSnapshot} from "../src/snapshots";
import {exportProjectArchive,importProjectArchive} from "../src/archives";
import {createApiServer,type ApiServer} from "../../api/src/server";
import {processNextJob} from "../../queue/src/worker";
import {LeaseError} from "../../queue/src/index";
import {CartesiaAudioProvider} from "../../generator/src/cartesia-audio";
import {contentHash} from "../../generator/src/capabilities";
import {verifyAudioMedia} from "../../generator/src/audio-media";
import {verifyDialogueMedia} from "../../generator/src/dialogue-replacement";
import {outputRevision} from "../../planner/src/dialogue-selection";
import {CAST_INPUT} from "../../../test/fixtures/casting";
import {AUDIO_POLICY,AUDIO_PCM,audioSse,audioIntent} from "../../../test/fixtures/audio";
import {CARTESIA_PHRASE_CAPABILITY} from "../../generator/src/audio-capabilities";
import {AZURE_AUDIO_CAPABILITY} from "../../generator/src/azure-capability";
import {AZURE_POLICY,AZURE_PROFILE,azureFixture} from "../../../test/fixtures/azure-audio";
const enabled=Boolean(process.env.HV_PG_ADMIN_URL&&process.env.HV_API_DATABASE_URL&&process.env.HV_WORKER_DATABASE_URL&&process.env.HV_S3_ENDPOINT&&process.env.HV_S3_FLEET_TEST_BUCKET),pgtest=enabled?test:test.skip;
let admin:StudioDatabase,worker:StudioDatabase,restored:StudioDatabase,applicationRestored:StudioDatabase,nativeApplicationRestored:StudioDatabase,nativeRestored:StudioDatabase,server:ApiServer,root:string,wire:ReturnType<typeof Bun.serve>,calls=0,provider:CartesiaAudioProvider;
const ids:string[]=[],objectKeys=new Set<string>(),name="hv_audio_test_"+crypto.randomUUID().replaceAll("-",""),policies=[AUDIO_POLICY],oldSecret=process.env.HV_TOKEN_SECRET;
const replica=()=>objectClient({...process.env,HV_S3_BUCKET:process.env.HV_S3_FLEET_TEST_BUCKET});
// Each restore database belongs to one test. Remove only its known replica
// objects so the next portable import exercises a genuinely empty bucket.
async function releaseReplica(database:StudioDatabase){
  for(const row of await database.sql`select object_key from hv_artifacts`){objectKeys.add(row.object_key);await replica().file(row.object_key).delete();}
}
beforeAll(async()=>{if(!enabled)return;
  process.env.HV_TOKEN_SECRET="audio-pg-fixture-secret-at-least-thirty-two-characters";root=mkdtempSync(join(tmpdir(),"hv-audio-pg-"));
  admin=new StudioDatabase(process.env.HV_PG_ADMIN_URL!);worker=new StudioDatabase(process.env.HV_WORKER_DATABASE_URL!);await admin.migrate();
  await admin.sql.unsafe('CREATE DATABASE "'+name+'"');const url=new URL(process.env.HV_PG_ADMIN_URL!);url.pathname="/"+name;restored=new StudioDatabase(url.href);await restored.migrate();
  await admin.sql.unsafe('CREATE DATABASE "'+name+'_application"');url.pathname="/"+name+"_application";applicationRestored=new StudioDatabase(url.href);await applicationRestored.migrate();
  await admin.sql.unsafe('CREATE DATABASE "'+name+'_native"');url.pathname="/"+name+"_native";nativeApplicationRestored=new StudioDatabase(url.href);await nativeApplicationRestored.migrate();
  await admin.sql.unsafe('CREATE DATABASE "'+name+'_native_audio"');url.pathname="/"+name+"_native_audio";nativeRestored=new StudioDatabase(url.href);await nativeRestored.migrate();
  server=createApiServer({port:0,hostname:"127.0.0.1",storage:"postgres",artifactStorage:"s3",databaseUrl:process.env.HV_API_DATABASE_URL,artifactRoot:join(root,"api"),audioPolicies:()=>policies,rateLimit:{api:{limit:10000,windowMs:60000}}});
  wire=Bun.serve({port:0,hostname:"127.0.0.1",async fetch(request){calls++;const body=await request.json() as any;return audioSse(body.context_id);}});
  provider=new CartesiaAudioProvider({apiKey:"fixture-not-a-real-key",fetchImpl:(async(_url,init)=>fetch(wire.url,init)) as typeof fetch});
});
afterAll(async()=>{if(!enabled)return;await server?.stop(true);await wire?.stop(true);
  for(const id of ids){for(const row of await admin.sql`select object_key from hv_artifacts where project_id=${id}`)objectKeys.add(row.object_key);
    await admin.sql`delete from hv_reservations where job_id in (select job_id from hv_provider_attempts where project_id=${id} union select id from hv_jobs where project_id=${id})`;
    for(const table of ["hv_cost_events","hv_provider_attempts","hv_outbox","hv_operator_reviews","hv_artifacts","hv_jobs","hv_reviews"])await admin.sql.unsafe("delete from "+table+" where project_id=$1",[id]);await admin.sql`delete from hv_projects where id=${id}`;}
  for(const key of objectKeys){await objectClient().file(key).delete();await replica().file(key).delete();}
  await worker?.close();await restored?.close();await applicationRestored?.close();await nativeApplicationRestored?.close();await nativeRestored?.close();if(!/^hv_audio_test_[a-f0-9]{32}$/.test(name))throw new Error("Unexpected fixture database");await admin.sql.unsafe('DROP DATABASE "'+name+'"');await admin.sql.unsafe('DROP DATABASE "'+name+'_application"');await admin.sql.unsafe('DROP DATABASE "'+name+'_native"');await admin.sql.unsafe('DROP DATABASE "'+name+'_native_audio"');await admin.close();rmSync(root,{recursive:true,force:true});
  if(oldSecret===undefined)delete process.env.HV_TOKEN_SECRET;else process.env.HV_TOKEN_SECRET=oldSecret;
});
const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
async function owner(policy=AUDIO_POLICY){
  const owner=await(await call("/api/projects","POST")).json() as any;ids.push(owner.projectId);const base="/api/projects/"+owner.projectId,actorId=crypto.randomUUID(),character={...CAST_INPUT,name:"Marla",aliases:[]};
  await call(base+"/script","PUT",{text:"INT. GARDEN - DAY\n\nMarla waves.\n\nMARLA\nHello."},owner.token);await call(base+"/rights","POST",{attested:true},owner.token);
  expect((await call(base+"/cast/"+actorId,"PUT",{character,expectedVersion:0},owner.token)).status).toBe(200);
  const quote=await(await call(base+"/audio-takes","GET",undefined,owner.token)).json() as any;expect(quote.enabled).toBe(true);
  const body={idempotencyKey:"audition",generationApproved:true,sceneIndex:0,lineIndex:0,sourceHash:quote.lines[0].source.hash,characterId:actorId,voiceId:policy.voiceId,policyRevision:policy.revision,controls:policy.provider==="azure"?AZURE_PROFILE.controls:{emotion:"calm"},beforeMs:250,afterMs:500,...(policy.provider==="azure"?{nativeCapabilityRevision:AZURE_AUDIO_CAPABILITY.revision}: {})};
  return {...owner,base,actorId,character,body};
}
const invoice=(attempts:{attemptId:string;usd:number}[],documentSha256="a".repeat(64),accountRevision=AUDIO_POLICY.accountRevision):AudioInvoice=>{
  const data={schema:"hv-audio-invoice-allocation/1" as const,documentSha256,accountRevision,totalUsd:Number(attempts.reduce((n,a)=>n+a.usd,0).toFixed(6)),allocations:attempts,at:new Date().toISOString()};return {...data,revision:contentHash(data)};
};
pgtest("native voice admission, one dispatch, word timing and provider billing survive PostgreSQL and S3 archive restore",async()=>{
  policies.push(AZURE_POLICY);
  try{
    const restored=nativeRestored;
    const o=await owner(AZURE_POLICY),path=o.base+"/audio-takes",ledger=new PostgresAudioLedger(worker),operator=new PostgresAudioLedger(admin),store=new PostgresJobStore(worker),f=azureFixture(),cache=join(root,"native"),artifacts=new PostgresArtifactStore(worker,cache),phrases=[{start:0,end:6,text:"Hello.",emphasis:"strong" as const}],body={...o.body,phrases,phraseCapabilityRevision:AZURE_AUDIO_CAPABILITY.revision};
    const held=await ledger.reservedUsd();for(const patch of [{nativeCapabilityRevision:undefined},{nativeCapabilityRevision:CARTESIA_PHRASE_CAPABILITY.revision},{alignment:"words-and-phonemes"},{controls:{...AZURE_PROFILE.controls,style:"calm"}},{providerTranscript:"forged"},{phrases:[{...phrases[0],volume:.8}]}])expect((await call(path,"POST",{...body,...patch},o.token)).status).toBeOneOf([400,409]);expect(await ledger.reservedUsd()).toBe(held);
    const saved=await call(o.base+"/cast/"+o.actorId+"/audio-voice","PUT",{expectedVersion:1,voiceId:AZURE_POLICY.voiceId,policyRevision:AZURE_POLICY.revision,controls:AZURE_PROFILE.controls},o.token);expect(saved.status).toBe(200);
    const responses=await Promise.all([call(path,"POST",body,o.token),call(path,"POST",body,o.token)]);for(const r of responses)expect(r.status).toBe(202);const admitted=await Promise.all(responses.map(r=>r.json() as Promise<any>));expect(admitted[0].jobId).toBe(admitted[1].jobId);
    const done=(await processNextJob(store,cache,{ledger,reviewQueue:new PostgresReviewQueue(worker),artifacts,audio:{provider:f.provider,ledger,policy:()=>AZURE_POLICY},workerId:"native-audition"}))!;expect(done.failureReason??done.cancelReason).toBeUndefined();expect(done.status).toBe("done");expect(f.calls).toHaveLength(1);expect(done.audioOutput!.report.plan.phrases).toEqual(phrases);expect(done.audioOutput!.report.alignment.phonemes).toEqual([]);
    const attempt=(await ledger.audioAttempt(done.id))!;expect(attempt.audio.intent.provider).toBe("azure");expect((await admin.sql`select provider from hv_provider_attempts where id=${attempt.id}`)[0].provider).toBe("azure");
    const billData={schema:"hv-audio-invoice-allocation/1" as const,documentSha256:contentHash({native:attempt.id}),accountRevision:AZURE_POLICY.accountRevision,totalUsd:.11,at:new Date().toISOString(),allocations:[{attemptId:attempt.id,usd:.11}]},bill={...billData,revision:contentHash(billData)};await operator.settleAudioInvoice(bill);
    const snapshot=await exportStateSnapshot(admin,o.projectId);expect(snapshot.ledger.events[0]!.provider).toBe("azure");expect(snapshot.ledger.events[0]!.total_cost_usd).toBe(.11);await importStateSnapshot(restored,snapshot,500);
    expect((await restored.sql`select provider from hv_provider_attempts where id=${attempt.id}`)[0].provider).toBe("azure");expect((await new PostgresAudioLedger(restored).audioAttempt(done.id))!.audio.invoice!.usd).toBe(.11);
    await artifacts.restoreCheckpoint(done);verifyAudioMedia(done,done.audioOutput!,cache);const copied=new PostgresArtifactStore(restored,cache,replica());await copied.importCompletedJob(done,done.audioOutput!.files.map(file=>join(cache,file.path)));
    const readerRoot=join(root,"native-restored"),reader=new PostgresArtifactStore(restored,readerRoot,replica());await reader.restoreCheckpoint(done);verifyAudioMedia(done,done.audioOutput!,readerRoot);for(const row of await restored.sql`select object_key from hv_artifacts where project_id=${o.projectId}`)objectKeys.add(row.object_key);
    const view=await(await call("/api/jobs/"+done.id,"GET",undefined,o.token)).json() as any;expect(view.audioTake.settings.controls.intensity).toBe(1.4);expect(view.audioTake.settings.phrases).toEqual(phrases);expect(view.audioBilling.actualUsd).toBe(.11);expect((await fetch(new URL(view.output.audioUrl,server.url))).status).toBe(200);
    policies.splice(policies.indexOf(AZURE_POLICY),1);expect((await fetch(new URL(view.output.audioUrl,server.url))).status).toBe(404);expect(f.calls).toHaveLength(1);
  }finally{const i=policies.indexOf(AZURE_POLICY);if(i>=0)policies.splice(i,1);await releaseReplica(nativeRestored);}
},60000);
pgtest("reviewed phrase auditions preserve ranges and wire evidence through one admission, dispatch and retained playback",async()=>{
  const o=await owner(),path=o.base+"/audio-takes",view=await(await call(path,"GET",undefined,o.token)).json() as any,phrases=[{start:0,end:6,text:"Hello.",speed:.8,pauseAfterMs:400}],body={...o.body,phrases,phraseCapabilityRevision:view.phraseCapabilityRevision},ledger=new PostgresAudioLedger(worker),store=new PostgresJobStore(worker);
  expect(view.phraseCapabilityRevision).toBe(CARTESIA_PHRASE_CAPABILITY.revision);const reserved=await ledger.reservedUsd();
  for(const patch of [{phraseCapabilityRevision:undefined},{phraseCapabilityRevision:"f".repeat(64)},{providerTranscript:"forged"},{phrases:[{...phrases[0],text:"Goodbye."}]},{phrases:[{...phrases[0],emphasis:"strong"}]}])expect((await call(path,"POST",{...body,...patch},o.token)).status).toBeOneOf([400,409]);expect(await ledger.reservedUsd()).toBe(reserved);
  const responses=await Promise.all([call(path,"POST",body,o.token),call(path,"POST",body,o.token)]);for(const response of responses)expect(response.status).toBe(202);const ids=await Promise.all(responses.map(r=>r.json() as Promise<any>));expect(ids[0].jobId).toBe(ids[1].jobId);
  expect((await call(path,"POST",{...body,phrases:[{...phrases[0],speed:1}]},o.token)).status).toBe(409);
  const cache=join(root,"phrase-audition"),before=calls,done=(await processNextJob(store,cache,{ledger,reviewQueue:new PostgresReviewQueue(worker),artifacts:new PostgresArtifactStore(worker,cache),audio:{provider,ledger,policy:()=>AUDIO_POLICY},workerId:"phrase-audition"}))!;
  expect(done.failureReason??done.cancelReason).toBeUndefined();expect(done.status).toBe("done");expect(calls-before).toBe(1);expect(done.audioOutput!.report.plan.phrases).toEqual(phrases);expect(done.audioTake!.line.providerTranscript).toBe('<speed ratio="0.8"/>Hello.<speed ratio="1"/><break time="400ms"/>');
  const saved=await(await call("/api/jobs/"+done.id,"GET",undefined,o.token)).json() as any;expect(saved.audioTake.settings.phrases).toEqual(phrases);expect((await fetch(new URL(saved.output.audioUrl,server.url))).status).toBe(200);expect((await ledger.audioAttempt(done.id))!.audio.intent.capabilityRevision).toBe(CARTESIA_PHRASE_CAPABILITY.revision);
  expect((await exportStateSnapshot(admin,o.projectId)).jobs[0]!.audioTake!.line.phrases).toEqual(phrases);
},30000);
pgtest("scene edits serialize and stale audition admission cannot reserve funds; admitted reads retain their original intent",async()=>{
  const o=await owner(),path=o.base+"/audio-takes",scenePath=o.base+"/cast/"+o.actorId+"/scene-performance",quote=await(await call(path,"GET",undefined,o.token)).json() as any;
  const body={expectedVersion:1,expectedScriptVersion:1,sceneNumber:1,sourceHash:quote.scenes[0].sourceHash,notes:"Keep the greeting measured.",controls:{emotion:"sad",speed:.8},picture:{emotion:"sad",intensity:"restrained",gestures:["hold-still"]}};
  const writes=await Promise.all([call(scenePath,"PUT",body,o.token),call(scenePath,"PUT",{...body,notes:"An uncertain greeting."},o.token)]);expect(writes.map(r=>r.status).sort()).toEqual([200,409]);
  const updated=await(await call(path,"GET",undefined,o.token)).json() as any,memory=updated.lines[0].memory;
  expect(memory.schema).toBe("hv-scene-performance/2");expect(memory.picture).toEqual(body.picture);
  expect((await call(path,"POST",o.body,o.token)).status).toBe(409);const reviewed={...o.body,performanceRevision:memory.revision,controls:{emotion:"neutral"}};
  const admitted=await call(path,"POST",reviewed,o.token);expect(admitted.status).toBe(202);const result=await admitted.json() as any,store=new PostgresJobStore(worker),job=(await store.get(result.jobId))!,ledger=new PostgresAudioLedger(worker);
  expect(job.audioTake!.line.profile.controls).toEqual({emotion:"neutral",speed:.8,volume:1});expect(job.audioTake!.line.notes).toBe(memory.notes);
  expect((await call(scenePath,"PUT",{...body,expectedVersion:2,notes:"Now a cheerful welcome."},o.token)).status).toBe(200);
  const reserved=await ledger.reservedUsd();await expect(ledger.admitAudio(o.projectId,{...job,id:crypto.randomUUID(),idempotencyKey:o.projectId+":late-admission"},()=>AUDIO_POLICY,500)).rejects.toThrow("Scene performance changed");expect(await ledger.reservedUsd()).toBe(reserved);
  expect((await call(path,"POST",{...reviewed,idempotencyKey:"outdated-review"},o.token)).status).toBe(409);const replay=await call(path,"POST",reviewed,o.token);expect(replay.status).toBe(202);expect((await replay.json() as any).jobId).toBe(job.id);
  const cache=join(root,"scene-memory"),done=(await processNextJob(store,cache,{ledger,reviewQueue:new PostgresReviewQueue(worker),artifacts:new PostgresArtifactStore(worker,cache),audio:{provider,ledger,policy:()=>AUDIO_POLICY},workerId:"scene-memory"}))!;
  expect(done.failureReason??done.cancelReason).toBeUndefined();expect(done.status).toBe("done");expect(done.audioOutput!.report.plan.memory).toEqual(memory);
  const view=await(await call("/api/jobs/"+done.id,"GET",undefined,o.token)).json() as any;expect(view.audioTake.memory).toEqual(memory);expect(view.audioTake.settings.controls.emotion).toBe("neutral");
},30000);
for(const native of [false,true])pgtest((native?"native ":"")+"retained audio application owns its S3 evidence, resumes without dispatch, restores independently and keeps its original invoice",async()=>{
  const testRoot=join(root,native?"native-application":"cartesia-application");mkdirSync(testRoot);
  const policy=native?AZURE_POLICY:AUDIO_POLICY,f=azureFixture(),selectedProvider=native?f.provider:provider;if(native)policies.push(policy);
  const keys=["HV_NARRATION","HV_ANIMATIC_CAPTIONS","HV_ANIMATIC_PROVIDER_POOL","HV_AUDIO_POLICY_FILE"],previous=Object.fromEntries(keys.map(k=>[k,process.env[k]])),policyPath=join(testRoot,"application-policies.json");
  writeFileSync(policyPath,JSON.stringify({schema:"hv-audio-policies/1",policies:[policy]}));Object.assign(process.env,{HV_NARRATION:"1",HV_ANIMATIC_CAPTIONS:"0",HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_AUDIO_POLICY_FILE:policyPath});
  try{
    const restored=native?nativeApplicationRestored:applicationRestored;
    const o=await owner(policy),store=new PostgresJobStore(worker),ledger=new PostgresCostLedger(worker),audioLedger=new PostgresAudioLedger(worker),operator=new PostgresAudioLedger(admin),cacheA=join(testRoot,"apply-first"),cacheB=join(testRoot,"apply-resume"),artifactsA=new PostgresArtifactStore(worker,cacheA),artifactsB=new PostgresArtifactStore(worker,cacheB),context={ledger,reviewQueue:new PostgresReviewQueue(worker)};
    const memoryView=await(await call(o.base+"/audio-takes","GET",undefined,o.token)).json() as any;
    const memorySave=await call(o.base+"/cast/"+o.actorId+"/scene-performance","PUT",{expectedVersion:1,expectedScriptVersion:1,sceneNumber:1,sourceHash:memoryView.scenes[0].sourceHash,notes:"A measured welcome.",controls:{speed:.8},picture:{emotion:"calm",intensity:"restrained",gestures:["smile"]}},o.token);expect(memorySave.status).toBe(200);
    const memory=(await memorySave.json() as any).casting.characters[0].scenePerformances[0];
    const direction=await(await call(o.base+"/direction","GET",undefined,o.token)).json() as any,shot=direction.plan[0];
    expect((await call(o.base+"/direction/"+shot.source.id,"PUT",{expectedVersion:0,expectedScriptVersion:1,sourceHash:shot.sourceHash,settings:{picture:[{characterId:o.actorId,baseRevision:shot.pictureCharacters[0].baseRevision,controls:{intensity:"heightened",gestures:["open-palms"]}}]}},o.token)).status).toBe(200);
    expect((await call(o.base+"/jobs","POST",{idempotencyKey:"picture"},o.token)).status).toBe(202);
    const film=(await processNextJob(store,cacheA,{...context,artifacts:artifactsA,workerId:"picture"}))!;expect(film.failureReason??film.cancelReason).toBeUndefined();expect(film.status).toBe("done");
    expect(film.output!.picturePerformances![0]!.intent.characters[0]!.controls).toEqual({emotion:"calm",intensity:"heightened",gestures:["open-palms"]});
    const phrases=[{start:0,end:6,text:"Hello.",speed:.9,pauseAfterMs:250,...(native?{emphasis:"strong" as const}:{})}];
    expect((await call(o.base+"/audio-takes","POST",{...o.body,performanceRevision:memory.revision,phrases,phraseCapabilityRevision:native?AZURE_AUDIO_CAPABILITY.revision:CARTESIA_PHRASE_CAPABILITY.revision},o.token)).status).toBe(202);
    const audio=(await processNextJob(store,cacheA,{...context,ledger:audioLedger,artifacts:artifactsA,audio:{provider:selectedProvider,ledger:audioLedger,policy:()=>policy},workerId:"audition"}))!;expect(audio.failureReason??audio.cancelReason).toBeUndefined();expect(audio.status).toBe("done");
    process.env.HV_NARRATION="0";const beforeCalls=native?f.calls.length:calls,attempt=(await audioLedger.audioAttempt(audio.id))!,path=o.base+"/dialogue/"+film.id,quote=await(await call(path,"GET",undefined,o.token)).json() as any;
    expect(quote.error).toBeUndefined();expect(quote.temporaryEnabled).toBe(false);expect(quote.lines[0].auditions).toHaveLength(1);
    const take=quote.lines[0].auditions[0],body={idempotencyKey:"apply-retained",generationApproved:true,sourceRevision:quote.sourceRevision,sourceFilesRevision:quote.sourceFilesRevision,engineVersion:quote.engineVersion,conversionEngineVersion:quote.conversionEngineVersion,
      edits:[{shotId:quote.lines[0].shotId,index:0,sourceHash:quote.lines[0].sourceHash,auditionJobId:audio.id,auditionRevision:take.revision}]};
    const admitted=await Promise.all([call(path,"POST",body,o.token),call(path,"POST",body,o.token)]);for(const response of admitted){expect(await response.clone().text()).not.toContain('"error"');expect(response.status).toBe(202);}const ids=await Promise.all(admitted.map(r=>r.json() as Promise<any>));expect(ids[0].jobId).toBe(ids[1].jobId);
    const checkpoint=artifactsA.checkpointDialogue.bind(artifactsA);artifactsA.checkpointDialogue=async(...args)=>{await checkpoint(...args);throw new LeaseError(args[0].id,"lease_expired",args[1]);};
    const partial=(await processNextJob(store,cacheA,{...context,artifacts:artifactsA,workerId:"apply-interrupted"}))!;expect(partial.failureReason??partial.cancelReason).toBeUndefined();expect(partial.status).toBe("running");expect(partial.dialogueCheckpoint).toBeTruthy();
    artifactsA.checkpointDialogue=checkpoint;const done=(await processNextJob(new PostgresJobStore(worker),cacheB,{...context,artifacts:artifactsB,workerId:"apply-resumed",now:()=>Date.now()+600000}))!;
    expect(done.failureReason??done.cancelReason).toBeUndefined();expect(done.status).toBe("done");expect(done.output).toEqual(partial.dialogueCheckpoint);expect(done.resumedCount).toBe(1);expect(native?f.calls.length:calls).toBe(beforeCalls);
    expect(done.output!.dialogue!.report.lines[0]!.audition!.source.jobId).toBe(audio.id);expect(done.output!.dialogue!.files.filter(f=>f.path.includes("/auditions/"))).toHaveLength(2);
    expect(done.output!.dialogue!.report.lines[0]!.audition!.source.take.line.memory).toEqual(memory);
    expect(done.output!.dialogue!.report.lines[0]!.audition!.source.take.line.phrases).toEqual(phrases);
    expect(await admin.sql`select id from hv_provider_attempts where job_id=${done.id}`).toHaveLength(0);expect(await admin.sql`select id from hv_cost_events where job_id=${done.id}`).toHaveLength(0);expect(await admin.sql`select job_id from hv_reservations where job_id=${done.id}`).toHaveLength(0);
    const view=await(await call("/api/jobs/"+done.id,"GET",undefined,o.token)).json() as any;expect(view.appliedAuditionBilling).toEqual([{jobId:audio.id,voiceLabel:policy.label,state:"unreconciled",actualUsd:null,heldUsd:.25}]);expect(view.costUsd).toBe(0);
    const signed=view.output.audioUrl;expect((await fetch(new URL(signed,server.url))).status).toBe(200);
    expect((await call(o.base+"/dialogue-selection","PUT",{jobId:done.id,sourceJobId:film.id,expectedVersion:0,expectedOutputRevision:outputRevision(done)},o.token)).status).toBe(200);
    // Each case owns an empty database and releases its objects from the separate CI bucket.
    const archive=join(testRoot,"applied-voice.hv.zip"),exported=await exportProjectArchive(admin,o.projectId,join(testRoot,"apply-archive-prepared"),archive);expect(exported.jobs).toBe(3);
    const sourceBucket=process.env.HV_S3_BUCKET;try{process.env.HV_S3_BUCKET=process.env.HV_S3_FLEET_TEST_BUCKET;const imported=await importProjectArchive(restored,archive,join(testRoot,"apply-archive-imported"),.1);expect(imported.jobs).toBe(3);expect(imported.mediaFiles).toBeGreaterThan(done.output!.dialogue!.files.length);}finally{if(sourceBucket===undefined)delete process.env.HV_S3_BUCKET;else process.env.HV_S3_BUCKET=sourceBucket;}
    const recoveredRoot=join(testRoot,"apply-archive-reader"),reader=new PostgresArtifactStore(restored,recoveredRoot,replica());await reader.restoreCheckpoint(done);await verifyDialogueMedia(done,done.output!,recoveredRoot);
    const restoredFilm=(await new PostgresJobStore(restored).get(film.id))!;expect(restoredFilm.output!.picturePerformances).toEqual(film.output!.picturePerformances);await reader.restoreCheckpoint(restoredFilm);
    expect((await new PostgresJobStore(restored).get(audio.id))!.audioTake!.line.memory).toEqual(memory);
    expect((await new PostgresJobStore(restored).get(audio.id))!.audioTake!.line.phrases).toEqual(phrases);
    const restoredLedger=new PostgresAudioLedger(restored);expect((await restoredLedger.audioAttempt(audio.id))!.actualUsd).toBeNull();expect((await exportStateSnapshot(restored,o.projectId)).projects.projects[0]!.dialogueSelections!.entries.at(-1)!.jobId).toBe(done.id);
    for(const row of await restored.sql`select object_key from hv_artifacts where project_id=${o.projectId}`)objectKeys.add(row.object_key);
    const bill=invoice([{attemptId:attempt.id,usd:.08}],contentHash({application:attempt.id}),policy.accountRevision);await Promise.all([operator.settleAudioInvoice(bill),operator.settleAudioInvoice(bill)]);await restoredLedger.settleAudioInvoice(bill);
    const settled=await(await call("/api/jobs/"+done.id,"GET",undefined,o.token)).json() as any;expect(settled.appliedAuditionBilling[0]).toMatchObject({actualUsd:.08,heldUsd:0,state:"invoice-allocated"});expect(settled.costUsd).toBe(0);expect(await admin.sql`select id from hv_cost_events where job_id=${audio.id}`).toHaveLength(1);expect(await admin.sql`select job_id from hv_reservations where job_id=${audio.id}`).toHaveLength(0);
    // A persisted output does not authorize completing a second job after permission withdrawal.
    expect((await call(path,"POST",{...body,idempotencyKey:"withdraw-at-completion"},o.token)).status).toBe(202);
    artifactsA.checkpointDialogue=async(...args)=>{await checkpoint(...args);writeFileSync(policyPath,JSON.stringify({schema:"hv-audio-policies/1",policies:[]}));};
    const withdrawn=(await processNextJob(store,cacheA,{...context,artifacts:artifactsA,workerId:"withdrawn"}))!;expect(withdrawn.status).toBe("failed");expect(withdrawn.failureKind).toBe("policy_refusal");expect(withdrawn.output).toBeUndefined();expect(native?f.calls.length:calls).toBe(beforeCalls);
    expect((await fetch(new URL(signed,server.url))).status).toBe(404);expect((await call(path,"POST",{...body,idempotencyKey:"withdrawn-admission"},o.token)).status).toBe(400);
  }finally{if(native){const i=policies.indexOf(policy);if(i>=0)policies.splice(i,1);}for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}await releaseReplica(native?nativeApplicationRestored:applicationRestored);}
},60000);
pgtest("one RLS admission and provider dispatch survive S3 worker recovery, archive restore and invoice settlement",async()=>{
  const o=await owner(),path=o.base+"/audio-takes",ledger=new PostgresAudioLedger(worker),operator=new PostgresAudioLedger(admin),first=new PostgresJobStore(worker),next=new PostgresJobStore(worker),cacheA=join(root,"first"),cacheB=join(root,"next"),artifactsA=new PostgresArtifactStore(worker,cacheA),artifactsB=new PostgresArtifactStore(worker,cacheB),policy=(id:string)=>policies.find(p=>p.voiceId===id);
  const context={ledger,reviewQueue:new PostgresReviewQueue(worker),audio:{provider,ledger,policy}};
  const admitted=await Promise.all(Array.from({length:2},async()=>{const response=await call(path,"POST",o.body,o.token);expect(await response.clone().text()).not.toContain('"error"');expect(response.status).toBe(202);return await response.json() as any;}));expect(new Set(admitted.map(j=>j.jobId)).size).toBe(1);
  expect((await call(path,"POST",{...o.body,controls:{emotion:"angry"}},o.token)).status).toBe(409);
  expect((await call(path,"POST",{...o.body,idempotencyKey:"stale",sourceHash:"f".repeat(64)},o.token)).status).toBe(409);
  expect((await call(path,"POST",{...o.body,idempotencyKey:"forged",policy:AUDIO_POLICY},o.token)).status).toBe(400);
  const checkpoint=artifactsA.checkpointAudio.bind(artifactsA);artifactsA.checkpointAudio=async(...args)=>{await checkpoint(...args);throw new LeaseError(args[0].id,"lease_expired",args[1]);};
  const before=calls,partial=(await processNextJob(first,cacheA,{...context,artifacts:artifactsA,workerId:"interrupted"}))!;artifactsA.checkpointAudio=checkpoint;
  expect(partial.failureReason??partial.cancelReason).toBeUndefined();expect(partial.status).toBe("running");expect(partial.audioCheckpoint).toBeTruthy();expect(calls-before).toBe(1);
  const done=(await processNextJob(next,cacheB,{...context,artifacts:artifactsB,workerId:"resumed",now:()=>Date.now()+600000}))!;
  expect(done.failureReason??done.cancelReason).toBeUndefined();expect(done.status).toBe("done");expect(done.audioOutput).toEqual(partial.audioCheckpoint);expect(calls-before).toBe(1);
  await expect(first.completeAudio(done.id,"interrupted",done.audioOutput!)).rejects.toThrow("fence_changed");
  const attempt=(await ledger.audioAttempt(done.id))!;expect(attempt.status).toBe("unknown");expect(attempt.actualUsd).toBeNull();expect((await admin.sql`select remaining_usd from hv_reservations where job_id=${done.id}`)[0].remaining_usd).toBe("0.250000");
  await expect(new PostgresCostLedger(worker).finishAttempt(attempt.id,"succeeded")).rejects.toThrow("Audio");
  await expect(ledger.recordForJob({projectId:o.projectId,jobId:done.id,at:new Date().toISOString(),shotId:"audio-line",provider:"cartesia",model:attempt.audio.intent.model,total_cost_usd:0,prompt_tokens:0,output_frames:0,gpu_seconds:0})).rejects.toThrow("invoice");
  const view=await(await call("/api/jobs/"+done.id,"GET",undefined,o.token)).json() as any;expect(view.audioBilling.actualUsd).toBeNull();expect(JSON.stringify(view)).not.toContain("licenceEvidenceSha256");
  const wav=await fetch(new URL(view.output.audioUrl,server.url)),bytes=Buffer.from(await wav.arrayBuffer());expect(wav.status).toBe(200);expect(bytes.readUInt32LE(24)).toBe(48000);expect(bytes.subarray(44+12000*2,44+60000*2)).toEqual(AUDIO_PCM);
  const foreign=await owner();expect((await call("/api/jobs/"+done.id,"GET",undefined,foreign.token)).status).toBe(404);
  const snapshot=await exportStateSnapshot(admin,o.projectId);expect(snapshot.ledger.audioAttempts?.[0]?.actualUsd).toBeNull();await importStateSnapshot(restored,snapshot,.1);
  const restoredLedger=new PostgresAudioLedger(restored);expect(await restoredLedger.reservedUsd()).toBe(.25);await expect(restoredLedger.reserve(crypto.randomUUID(),"audio-take",.01,.1)).rejects.toThrow("capacity");
  await artifactsB.restoreCheckpoint(done);verifyAudioMedia(done,done.audioOutput!,cacheB);
  const copied=new PostgresArtifactStore(restored,cacheB,replica());await copied.importCompletedJob(done,done.audioOutput!.files.map(f=>join(cacheB,f.path)));
  const downloaded=new PostgresArtifactStore(restored,join(root,"archive-reader"),replica());await downloaded.restoreCheckpoint(done);verifyAudioMedia(done,done.audioOutput!,join(root,"archive-reader"));
  for(const row of await restored.sql`select object_key from hv_artifacts where project_id=${o.projectId}`)objectKeys.add(row.object_key);
  const bill=invoice([{attemptId:attempt.id,usd:.12}]);await expect(ledger.settleAudioInvoice(bill)).rejects.toThrow("operator database role");
  await Promise.all([operator.settleAudioInvoice(bill),operator.settleAudioInvoice(bill)]);await restoredLedger.settleAudioInvoice(bill);
  expect((await operator.audioAttempt(done.id))!.actualUsd).toBe(.12);expect(await restoredLedger.reservedUsd()).toBe(0);expect(await admin.sql`select job_id from hv_reservations where job_id=${done.id}`).toHaveLength(0);
  expect(await admin.sql`select id from hv_cost_events where job_id=${done.id}`).toHaveLength(1);
  await expect(operator.settleAudioInvoice(invoice([{attemptId:attempt.id,usd:.13}]))).rejects.toThrow("different");
  const settled=await exportStateSnapshot(admin,o.projectId);expect(settled.ledger.events[0]!.total_cost_usd).toBe(.12);expect(JSON.stringify(settled.ledger)).not.toContain('"allocations"');
  expect((await call(o.base+"/cast/"+o.actorId,"PUT",{expectedVersion:1,character:{...o.character,permission:{...o.character.permission,status:"revoked"}}},o.token)).status).toBe(200);
  expect((await fetch(new URL(view.output.audioUrl,server.url))).status).toBe(404);
},60000);
pgtest("a crash after intent never redispatches; late outcomes and scoped invoice receipts survive content purge",async()=>{
  const o=await owner(),other=await owner(),ledger=new PostgresAudioLedger(worker),operator=new PostgresAudioLedger(admin),store=new PostgresJobStore(worker),next=new PostgresJobStore(worker),policy=()=>AUDIO_POLICY;
  expect((await call(o.base+"/audio-takes","POST",o.body,o.token)).status).toBe(202);
  const job=(await store.claimNext(Date.now(),{},{workerId:"original"}))!,intent=audioIntent(job.audioTake!.line),journal=ledger.journal(job,"original",policy),held=await journal.authorize(intent,job.audioTake!.line);
  await expect(journal.authorize(audioIntent(job.audioTake!.line),job.audioTake!.line)).rejects.toThrow("already dispatched");
  const before=calls,failed=(await processNextJob(next,join(root,"ambiguous"),{ledger,reviewQueue:new PostgresReviewQueue(worker),audio:{provider,ledger,policy},artifacts:new PostgresArtifactStore(worker,join(root,"ambiguous")),workerId:"recovery",now:()=>Date.now()+600000}))!;
  expect(failed.status).toBe("failed");expect(failed.failureReason).toContain("already dispatched");expect(calls).toBe(before);
  expect((await ledger.audioAttempt(job.id))!.actualUsd).toBeNull();expect((await exportStateSnapshot(admin,o.projectId)).ledger.reservations).toHaveLength(1);
  await admin.sql`update hv_projects set taken_down_at=now() where id=${o.projectId}`;expect(await new PostgresRetention(admin).purgeProject(o.projectId)).toBe(true);
  await journal.recordOutcome({schema:"hv-audio-attempt-outcome/1",intent,reservation:held,dispatched:true,providerState:"unconfirmed",deliveryState:"withheld",httpStatus:null,providerRequestId:null,billing:{state:"unreconciled",actualUsd:null},deliveryRevision:null});
  expect((await ledger.audioAttempt(job.id))!.audio.outcome!.billing.actualUsd).toBeNull();
  expect((await call(other.base+"/audio-takes","POST",other.body,other.token)).status).toBe(202);
  const otherJob=(await store.claimNext(Date.now(),{},{workerId:"other"}))!,otherIntent=audioIntent(otherJob.audioTake!.line);
  const otherJournal=ledger.journal(otherJob,"other",policy),otherHold=await otherJournal.authorize(otherIntent,otherJob.audioTake!.line);await store.fail(otherJob.id,"other","fixture dispatch interrupted");
  const wrongAccount={...invoice([{attemptId:otherIntent.attemptId,usd:.11}],"c".repeat(64)),accountRevision:"f".repeat(64)}, {revision:_revision,...wrongData}=wrongAccount;
  await expect(operator.settleAudioInvoice({...wrongData,revision:contentHash(wrongData)})).rejects.toThrow("scope");
  const bill=invoice([{attemptId:intent.attemptId,usd:.09},{attemptId:otherIntent.attemptId,usd:.11}],"b".repeat(64));await operator.settleAudioInvoice(bill);await ledger.release(otherJob.id);
  await otherJournal.recordOutcome({schema:"hv-audio-attempt-outcome/1",intent:otherIntent,reservation:otherHold,dispatched:true,providerState:"completed",deliveryState:"withheld",httpStatus:200,providerRequestId:null,billing:{state:"unreconciled",actualUsd:null},deliveryRevision:null});
  expect((await ledger.audioAttempt(otherJob.id))!.status).toBe("succeeded");expect((await ledger.audioAttempt(otherJob.id))!.actualUsd).toBe(.11);
  expect((await operator.audioAttempt(job.id))!.actualUsd).toBe(.09);expect(await admin.sql`select job_id from hv_reservations where job_id=${job.id}`).toHaveLength(0);
  const scoped=await exportStateSnapshot(admin,other.projectId);expect(JSON.stringify(scoped)).not.toContain(intent.attemptId);expect(scoped.ledger.events[0]!.total_cost_usd).toBe(.11);
  await expect(operator.settleAudioInvoice({...bill,accountRevision:"f".repeat(64)})).rejects.toThrow();
},60000);
pgtest("voice policy withdrawal, screenplay edits and cast revocation stop dispatch and release unused holds",async()=>{
  const ledger=new PostgresAudioLedger(worker),store=new PostgresJobStore(worker),cache=join(root,"withdrawn"),artifacts=new PostgresArtifactStore(worker,cache),before=calls;
  for(const change of ["policy","script","cast"]){
    const o=await owner();expect((await call(o.base+"/audio-takes","POST",o.body,o.token)).status).toBe(202);
    if(change==="policy")policies.splice(0);
    if(change==="script")await call(o.base+"/script","PUT",{text:"INT. GARDEN - DAY\n\nMARLA\nChanged."},o.token);
    if(change==="cast")await call(o.base+"/cast/"+o.actorId,"PUT",{expectedVersion:1,character:{...o.character,permission:{...o.character.permission,status:"revoked"}}},o.token);
    try{
      const job=(await processNextJob(store,cache,{ledger,reviewQueue:new PostgresReviewQueue(worker),artifacts,audio:{provider,ledger,policy:id=>policies.find(p=>p.voiceId===id)},workerId:"withdrawn-"+change}))!;
      expect(["failed","cancelled"]).toContain(job.status);expect(job.audioOutput).toBeUndefined();expect(await ledger.audioAttempt(job.id)).toBeUndefined();
      expect(await admin.sql`select job_id from hv_reservations where job_id=${job.id}`).toHaveLength(0);
    }finally{if(!policies.length)policies.push(AUDIO_POLICY);}
  }
  expect(calls).toBe(before);
},60000);
pgtest("concurrent character voice saves have one winner; owner audition views retain its settings after assignment removal",async()=>{
  const o=await owner(),path=o.base+"/cast/"+o.actorId+"/audio-voice",profile={expectedVersion:1,voiceId:AUDIO_POLICY.voiceId,policyRevision:AUDIO_POLICY.revision,controls:{speed:1.2,volume:.9,emotion:"calm"},pronunciations:[{word:"Hello",say:"Welcome"}]};
  const edits=await Promise.all([call(path,"PUT",profile,o.token),call(path,"PUT",{...profile,controls:{...profile.controls,speed:1.3}},o.token)]);expect(edits.map(r=>r.status).sort()).toEqual([200,409]);
  const voiceState=await(await call(o.base+"/audio-takes","GET",undefined,o.token)).json() as any,chosen=voiceState.characters[0].profile;expect(voiceState.castingVersion).toBe(2);expect(chosen.voice.permissionRevision).toBe(AUDIO_POLICY.permissionRevision);
  const requested={...o.body,controls:chosen.controls,pronunciations:chosen.pronunciations};expect((await call(o.base+"/audio-takes","POST",requested,o.token)).status).toBe(202);
  const queued=await(await call(o.base+"/audio-takes","GET",undefined,o.token)).json() as any;expect(queued.jobs[0].audioBilling).toEqual({state:"reserved",actualUsd:null,heldUsd:.25});
  const ledger=new PostgresAudioLedger(worker),store=new PostgresJobStore(worker),cache=join(root,"profile"),done=(await processNextJob(store,cache,{ledger,artifacts:new PostgresArtifactStore(worker,cache),reviewQueue:new PostgresReviewQueue(worker),audio:{provider,ledger,policy:()=>AUDIO_POLICY},workerId:"profile"}))!;
  expect(done.status).toBe("done");expect(done.audioTake!.line.profile.controls).toEqual(chosen.controls);expect(done.audioTake!.line.spokenText).toBe("Welcome.");
  const view=await(await call("/api/jobs/"+done.id,"GET",undefined,o.token)).json() as any;expect(view.audioBilling).toEqual({state:"unreconciled",actualUsd:null,heldUsd:.25});expect(view.audioTake.settings.pronunciations).toEqual(chosen.pronunciations);
  expect((await call(path,"PUT",{expectedVersion:2,clear:true},o.token)).status).toBe(200);
  const after=await(await call(o.base+"/audio-takes","GET",undefined,o.token)).json() as any;expect(after.characters[0].profile).toBeNull();expect(after.jobs[0].audioUnavailable).toBeNull();expect(after.jobs[0].audioTake.settings.controls).toEqual(chosen.controls);expect((await fetch(new URL(after.jobs[0].output.audioUrl,server.url))).status).toBe(200);
  const archived=await exportStateSnapshot(admin,o.projectId);expect(archived.jobs[0]!.casting!.characters[0]!.audioVoice).toEqual(chosen);expect(archived.projects.projects[0]!.castingHistory!.at(-1)!.characters[0]!.audioVoice).toBeUndefined();
  const bill=invoice([{attemptId:done.audioOutput!.report.attemptId,usd:.08}],"d".repeat(64));await new PostgresAudioLedger(admin).settleAudioInvoice(bill);
  expect((await(await call("/api/jobs/"+done.id,"GET",undefined,o.token)).json() as any).audioBilling).toEqual({state:"invoice-allocated",actualUsd:.08,heldUsd:0});
},60000);
