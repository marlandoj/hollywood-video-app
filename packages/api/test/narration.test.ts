import {expect,test} from "bun:test";
import {readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {verifyDialogueMedia} from "../../generator/src/dialogue-replacement";
import {validateSnapshot,type StateSnapshot} from "../../storage/src/snapshots";
import {outputRevision} from "../../planner/src/dialogue-selection";
import {retainLipSyncSource} from "../../planner/src/lipsync";
import {validateAudioTake} from "../../planner/src/audio-jobs";
import {audioPcmHash} from "../../generator/src/audio-delivery";
import {lipCommand} from "../../generator/src/lipsync-media";

test("reviewed narration renders separate stems, preserves source reads and survives independent continued exports",async()=>{
  const f=await dubStudio();try{
    const narrationText="Beyond the gate, another story begins.",previewBody={characterId:f.id,sceneIndex:0,expectedScriptVersion:1,narration:{text:narrationText,reviewed:true}},previewPath=f.base+"/audio-takes/narration-source";
    expect((await f.call(previewPath,"POST",previewBody)).status).toBe(401);
    for(const patch of [{expectedScriptVersion:2},{sceneIndex:99},{narration:{text:narrationText,reviewed:false}},{narration:{text:"<speak>Read this</speak>",reviewed:true}}])expect((await f.call(previewPath,"POST",{...previewBody,...patch},f.owner.token)).status).toBeOneOf([400,409]);
    const preview=await(await f.call(previewPath,"POST",previewBody,f.owner.token)).json() as any;expect(preview.source.text).toBe(narrationText);expect(preview.narration.review).toBe("owner-reviewed");expect(f.store.all()).toHaveLength(4);
    const take=await f.seedNarration(narrationText);expect(take.audioTake!.schema).toBe("hv-audio-take/2");expect(()=>validateAudioTake(take)).not.toThrow();expect(take.scriptText).not.toContain(narrationText);
    const studio=await(await f.call(f.base+"/audio-takes","GET",undefined,f.owner.token)).json() as any;expect(studio.jobs.find((j:any)=>j.id===take.id).audioTake.narration.text).toBe(narrationText);
    const q=await f.quote(),a=q.narration.takes.find((t:any)=>t.jobId===take.id);expect(a.unavailable).toBeNull();expect(q.lines.every((l:any)=>l.auditions.every((t:any)=>t.jobId!==take.id))).toBe(true);
    const cue={id:crypto.randomUUID(),role:"narration",startSample:22050,gainDb:-12,duckDb:-18,attackMs:100,releaseMs:200,auditionJobId:a.jobId,auditionRevision:a.revision};
    const body={idempotencyKey:crypto.randomUUID(),generationApproved:true,sourceRevision:q.sourceRevision,sourceFilesRevision:q.sourceFilesRevision,baselineRevision:null,engineVersion:q.engineVersion,conversionEngineVersion:q.conversionEngineVersion,edits:[],narration:{language:"en",reviewed:true,cues:[cue]}},path=f.base+"/dialogue/"+f.film.id;
    const before=f.store.all().length;
    for(const narration of [{...body.narration,reviewed:false},{...body.narration,language:"es"},{...body.narration,cues:[{...cue,startSample:22050*5}]},{...body.narration,cues:[{...cue,gainDb:6}]},{...body.narration,cues:[{...cue,auditionRevision:"f".repeat(64)}]},{...body.narration,cues:[cue,cue]}])expect((await f.call(path,"POST",{...body,narration},f.owner.token)).status).toBeOneOf([400,409]);
    expect(f.store.all()).toHaveLength(before);
    const response=await f.call(path,"POST",body,f.owner.token);expect(await response.clone().text()).not.toContain('"error"');expect(response.status).toBe(202);const id=(await response.json() as any).jobId;
    expect((await(await f.call(path,"POST",body,f.owner.token)).json() as any).jobId).toBe(id);
    const job=await f.worker();expect(job?.failureReason??job?.cancelReason).toBeUndefined();expect(job?.status).toBe("done");await verifyDialogueMedia(job!,job!.output!,f.paths.artifactRoot);
    const report=job!.output!.dialogue!.report,mix=report.narration!,baseDir=job!.output!.mp4Path.slice(0,-"export.mp4".length),wav=(name:string)=>readFileSync(join(f.paths.artifactRoot,baseDir+name));
    expect(mix.track.cues[0]!.audition.jobId).toBe(take.id);expect(mix.sourceAudioSha256).toBe(report.audioSha256);expect(report.lines.map(l=>l.text)).toEqual(["Welcome to the garden.","Come inside, friend."]);expect(report.lines.every(l=>!l.replaced)).toBe(true);
    const dry=wav("dialogue.wav"),master=wav("mix.wav"),voice=wav("narration.wav"),ducked=wav("ducked-dialogue.wav");expect(master.length).toBe(dry.length);expect(audioPcmHash(master)).toBe(mix.mixWavSha256);expect(master.equals(dry)).toBe(false);expect(voice.subarray(44,44+22050*2).every(b=>b===0)).toBe(true);
    expect(ducked.subarray(44,44+19000*2)).toEqual(dry.subarray(44,44+19000*2));expect(ducked.subarray(44+50000*2)).toEqual(dry.subarray(44+50000*2));expect(Math.max(...Object.values(mix.peaks))).toBeLessThan(32768);
    expect(wav("captions.vtt").toString().replace(/\s+/g," ")).toContain(narrationText);expect(wav("captions.vtt").toString()).toContain("Come inside, friend.");
    const view=await(await f.call("/api/jobs/"+id,"GET",undefined,f.owner.token)).json() as any;for(const key of ["mixUrl","narrationUrl","duckedDialogueUrl"]){expect(view.output[key]).toContain("/artifacts/");expect((await fetch(new URL(view.output[key],f.server.url))).status).toBe(200);}expect(view.appliedAuditionBilling.map((b:any)=>b.jobId)).toContain(take.id);
    // Mixed-dialogue restoration owns the original narration WAV/report and all stems.
    const snapshot:StateSnapshot={schema:"hv-state/11",projects:JSON.parse(readFileSync(f.paths.statePath,"utf8")),jobs:f.store.all().filter(j=>!j.audioTake),ledger:{events:f.ledger.all(),reservations:[]},reviews:[]};expect(validateSnapshot(snapshot).jobs).toHaveLength(2);
    expect(snapshot.jobs.some(job=>(job.executionCheckpoints??job.dialogueReplacement?.source.executionCheckpoints??[]).length>0)).toBe(true);expect(()=>validateSnapshot({...snapshot,schema:"hv-state/10"})).toThrow("schema 11");
    const continued=await f.quote(id);expect(continued.narration.current.cues[0].auditionJobId).toBe(take.id);
    const nextBody={...body,idempotencyKey:crypto.randomUUID(),sourceRevision:continued.sourceRevision,sourceFilesRevision:continued.sourceFilesRevision,baselineRevision:continued.baselineRevision,narration:{...body.narration,cues:[{...cue,startSample:55125}]}};
    expect((await f.call(f.base+"/dialogue/"+id,"POST",{...nextBody,narration:undefined},f.owner.token)).status).toBeOneOf([400,409]);
    expect((await f.call(f.base+"/dialogue/"+id,"POST",nextBody,f.owner.token)).status).toBe(202);const second=await f.worker();expect(second?.failureReason??second?.cancelReason).toBeUndefined();expect(second?.status).toBe("done");await verifyDialogueMedia(second!,second!.output!,f.paths.artifactRoot);
    expect(second!.output!.dialogue!.report.audioSha256).toBe(report.audioSha256);expect(second!.output!.dialogue!.report.videoStreamSha256).toBe(report.videoStreamSha256);expect(second!.output!.dialogue!.report.narration!.mixWavSha256).not.toBe(mix.mixWavSha256);
    const decoded=join(f.root,"decoded-mix.pcm");await lipCommand(["ffmpeg","-v","error","-i",join(f.paths.artifactRoot,second!.output!.mp4Path),"-map","0:a:0","-ar","22050","-ac","1","-f","s16le",decoded],f.root);
    const actual=readFileSync(decoded),secondMix=readFileSync(join(f.paths.artifactRoot,second!.output!.mp4Path.slice(0,-"export.mp4".length)+"mix.wav"));let dot=0,aa=0,bb=0;
    for(let i=3*22050;i<Math.floor(3.4*22050);i++){const a=actual.readInt16LE(i*2),b=secondMix.readInt16LE(44+i*2);dot+=a*b;aa+=a*a;bb+=b*b;}expect(bb).toBeGreaterThan(0);expect(dot/Math.sqrt(aa*bb)).toBeGreaterThan(.98);
    expect((await f.call(f.base+"/dialogue-selection","PUT",{jobId:second!.id,sourceJobId:f.film.id,expectedVersion:0,expectedOutputRevision:outputRevision(second!)},f.owner.token)).status).toBe(200);
    const lipSource=retainLipSyncSource(second!);expect(lipSource.schema).toBe("hv-lipsync-source/2");expect(lipSource.files.narration).toHaveLength(4);expect(lipSource.files.audio.sha256).toBe(report.audioSha256);
    const original=Buffer.from(master);master[60000]^=1;writeFileSync(join(f.paths.artifactRoot,baseDir+"mix.wav"),master);await expect(verifyDialogueMedia(job!,job!.output!,f.paths.artifactRoot)).rejects.toThrow("checksum");writeFileSync(join(f.paths.artifactRoot,baseDir+"mix.wav"),original);
  }finally{await f.close();}
},60000);

for(const silent of [false,true])test(silent?"reviewed narration adds speech to silent picture and can restore the silent mix":"reviewed narration and dubbed dialogue export one consistent language track",async()=>{
  const f=await dubStudio(undefined,silent?"INT. GARDEN - DAY\n\nSpud opens the gate.":undefined);try{
    const text="Tras la puerta comienza otra historia.",take=await f.seedNarration("Beyond the gate, another story begins.","es",text),q=await f.quote(),receipt=q.narration.takes.find((t:any)=>t.jobId===take.id);
    expect(q.lines.length).toBe(silent?0:2);
    const body={...f.requestBody(q),narration:{language:"es",reviewed:true,cues:[{id:crypto.randomUUID(),role:"voice-over",startSample:0,gainDb:-12,duckDb:-18,attackMs:100,releaseMs:200,auditionJobId:take.id,auditionRevision:receipt.revision}]}};
    const response=await f.call(f.base+"/dialogue/"+f.film.id,"POST",body,f.owner.token);expect(await response.clone().text()).not.toContain('"error"');expect(response.status).toBe(202);
    const mixed=await f.worker();expect(mixed?.failureReason??mixed?.cancelReason).toBeUndefined();expect(mixed?.status).toBe("done");await verifyDialogueMedia(mixed!,mixed!.output!,f.paths.artifactRoot);
    const report=mixed!.output!.dialogue!.report,directory=join(f.paths.artifactRoot,mixed!.output!.mp4Path.slice(0,-"export.mp4".length)),wav=(name:string)=>readFileSync(join(directory,name)),captions=wav("captions.vtt").toString().replace(/\s+/g," ");
    expect(report.narration!.track.language).toBe("es");expect(captions).toContain(text);expect(captions).not.toContain("Beyond the gate");
    const view=await(await f.call("/api/jobs/"+mixed!.id,"GET",undefined,f.owner.token)).json() as any;expect(view.captionLanguage).toBe("es");
    const continued=await f.quote(mixed!.id);expect(continued.dubLanguage).toBe("es");expect(continued.narration.current.cues[0].auditionJobId).toBe(take.id);
    if(!silent){expect(captions).toContain("Bienvenida al jardín.");expect(captions).toContain("Entra, amigo.");expect(report.lines.every(l=>l.audition?.source.take.line.localization?.language==="es")).toBe(true);}
    else{
      expect(report.lines).toHaveLength(0);expect(wav("dialogue.wav").subarray(44).every(b=>b===0)).toBe(true);expect(wav("mix.wav").subarray(44).some(b=>b!==0)).toBe(true);
      const cleared={...f.requestBody(continued),conversionEngineVersion:undefined,edits:[],narration:{language:"es",reviewed:true,cues:[]}};
      expect((await f.call(f.base+"/dialogue/"+mixed!.id,"POST",cleared,f.owner.token)).status).toBe(202);
      const restored=await f.worker();expect(restored?.failureReason??restored?.cancelReason).toBeUndefined();expect(restored?.status).toBe("done");await verifyDialogueMedia(restored!,restored!.output!,f.paths.artifactRoot);
      const restoredReport=restored!.output!.dialogue!.report;expect(restoredReport.videoStreamSha256).toBe(report.videoStreamSha256);expect(restoredReport.narration!.track.cues).toHaveLength(0);expect(restoredReport.narration!.mixWavSha256).toBe(restoredReport.audioSha256);
      expect(readFileSync(join(f.paths.artifactRoot,restored!.output!.mp4Path.slice(0,-"export.mp4".length)+"captions.srt"),"utf8").trim()).toBe("");
    }
  }finally{await f.close();}
},60000);
