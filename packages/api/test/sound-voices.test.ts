import {expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {createLipSyncFixture,completeLipSyncFixture} from "../../../test/fixtures/lipsync";
import {createApiServer} from "../src/server";
import {processNextJob} from "../../queue/src/worker";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {verifySoundMedia} from "../../generator/src/sound-media";
import {soundBaseDialogue} from "../../planner/src/sound-jobs";
import {contentHash} from "../../generator/src/capabilities";
import {validateSnapshot,type StateSnapshot} from "../../storage/src/snapshots";

test("sound versions preserve translated dialogue, narration, captions and original audition evidence",async()=>{
  const f=await dubStudio();try{
    const text="Detrás de la puerta comienza otra historia.",take=await f.seedNarration("Beyond the gate another story begins.","es",text),q=await f.quote(),receipt=q.narration.takes.find((a:any)=>a.jobId===take.id);
    const body={...f.requestBody(q),narration:{language:"es",reviewed:true,cues:[{id:crypto.randomUUID(),role:"voice-over",startSample:0,gainDb:-12,duckDb:-18,attackMs:100,releaseMs:200,auditionJobId:take.id,auditionRevision:receipt.revision}]}};
    expect((await f.call(f.base+"/dialogue/"+f.film.id,"POST",body,f.owner.token)).status).toBe(202);const source=(await f.worker())!;expect(source.failureReason).toBeUndefined();expect(source.status).toBe("done");
    const path=f.base+"/sound-mixes/"+source.id,quote=await(await f.call(path,"GET",undefined,f.owner.token)).json() as any;
    expect(quote.language).toBe("es");expect((await f.call(path,"POST",{idempotencyKey:crypto.randomUUID(),generationApproved:true,sourceRevision:quote.sourceRevision,engineVersion:quote.engineVersion,session:{reviewed:true,dialogueGainDb:-3,narrationGainDb:0,cues:[]}},f.owner.token)).status).toBe(202);
    const done=(await f.worker())!;expect(done.failureReason??done.cancelReason).toBeUndefined();expect(done.status).toBe("done");await verifySoundMedia(done,done.output!,f.paths.artifactRoot);
    const report=done.output!.sound!.report;expect(report.videoStreamSha256).toBe(source.output!.dialogue!.report.videoStreamSha256);expect(report.baseVoiceSourceSha256.dialogue).toBe(source.output!.dialogue!.report.narration!.duckedWavSha256);expect(soundBaseDialogue(done.soundMix!.source.base)).toEqual(source.output!.dialogue!.report);expect(report.peaks.narration).toBeGreaterThan(0);
    expect(readFileSync(join(f.paths.artifactRoot,done.output!.captionsPath))).toEqual(readFileSync(join(f.paths.artifactRoot,source.output!.captionsPath)));
    const view=await(await f.call("/api/jobs/"+done.id,"GET",undefined,f.owner.token)).json() as any;expect(view.captionLanguage).toBe("es");expect(view.appliedAuditionBilling.map((b:any)=>b.jobId).sort()).toEqual([...f.spanish.map(j=>j.id),take.id].sort());expect(view.appliedAuditionBilling.every((b:any)=>b.actualUsd===null)).toBe(true);
    const snapshot:StateSnapshot={schema:"hv-state/11",projects:f.projects.snapshot(),jobs:[done],reviews:[],ledger:{events:[],reservations:[]}};expect(validateSnapshot(snapshot).jobs).toHaveLength(1);
    expect(snapshot.jobs[0]!.soundMix!.source.base.dialogueReplacement!.source.executionCheckpoints!.length).toBeGreaterThan(0);expect(()=>validateSnapshot({...snapshot,schema:"hv-state/10"})).toThrow("schema 11");
  }finally{await f.close();}
},120000);

test("sound after accepted lip-sync owns its transformed picture, voice stems and quality review",async()=>{
  const root=mkdtempSync(join(tmpdir(),"hv-sound-lip-")),keys=["HV_TOKEN_SECRET","HV_NARRATION","HV_ANIMATIC_CAPTIONS","HV_ANIMATIC_PROVIDER_POOL","HV_AUDIO_POLICY_FILE","HV_LIPSYNC_POLICY_FILE"],previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));let server:ReturnType<typeof createApiServer>|undefined;
  try{
    Object.assign(process.env,{HV_TOKEN_SECRET:"sound-lip-fixture-secret-at-least-thirty-two-characters",HV_NARRATION:"1",HV_ANIMATIC_CAPTIONS:"0",HV_ANIMATIC_PROVIDER_POOL:'["mock"]'});const f=await createLipSyncFixture(root,true);process.env.HV_AUDIO_POLICY_FILE=join(root,"audio-policy.json");process.env.HV_LIPSYNC_POLICY_FILE=join(root,"lipsync-policy.json");const result=await completeLipSyncFixture(f);
    server=createApiServer({port:0,hostname:"127.0.0.1",queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),costLedgerPath:join(root,"ledger.json"),artifactRoot:f.artifacts});const base="/api/projects/"+f.project.id,call=(path:string,method="GET",body?:unknown)=>fetch(new URL(path,server!.url),{method,headers:{authorization:"Bearer "+f.owner.token,"content-type":"application/json"},...(body?{body:JSON.stringify(body)}:{})});
    expect((await call(base+"/sound-mixes/"+result.done.id)).status).toBeOneOf([400,409]);
    expect((await call(base+"/lip-sync/"+result.done.id+"/review","PUT",{mouthSync:4,faceStability:4,expression:4,decision:"accept",notes:"Synthetic local fixture only.",expectedVersion:0,expectedOutputRevision:contentHash(result.done.output)})).status).toBe(200);
    const path=base+"/sound-mixes/"+result.done.id,q=await(await call(path)).json() as any;expect(q.error).toBeUndefined();expect((await call(path,"POST",{idempotencyKey:crypto.randomUUID(),generationApproved:true,sourceRevision:q.sourceRevision,engineVersion:q.engineVersion,session:{reviewed:true,dialogueGainDb:0,narrationGainDb:0,cues:[]}})).status).toBe(202);
    const done=(await processNextJob(f.store,f.artifacts,{projects:f.projects,ledger:new CostLedger(join(root,"ledger.json")),reviewQueue:new OperatorReviewQueue(join(root,"reviews.json"))}))!;expect(done.failureReason??done.cancelReason).toBeUndefined();expect(done.status).toBe("done");await verifySoundMedia(done,done.output!,f.artifacts);
    expect(done.soundMix!.source.base.lipSyncReviews!.entries.at(-1)!.decision).toBe("accept");expect(done.soundMix!.source.base.output).toEqual(result.done.output);expect(done.output!.sound!.report.peaks.narration).toBeGreaterThan(0);expect(readFileSync(join(f.artifacts,done.output!.captionsPath))).toEqual(readFileSync(join(f.artifacts,result.done.output!.captionsPath)));
    const snapshot:StateSnapshot={schema:"hv-state/11",projects:f.projects.snapshot(),jobs:[done],reviews:[],ledger:{events:[],reservations:[]}};expect(validateSnapshot(snapshot).jobs).toHaveLength(1);
    expect(done.soundMix!.source.base.lipSync!.source.film.executionCheckpoints!.length).toBeGreaterThan(0);expect(()=>validateSnapshot({...snapshot,schema:"hv-state/10"})).toThrow("schema 11");
  }finally{await server?.stop(true);rmSync(root,{recursive:true,force:true});for(const [k,v]of Object.entries(previous)){if(v===undefined)delete process.env[k];else process.env[k]=v;}}
},120000);
