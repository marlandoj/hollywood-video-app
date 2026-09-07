import {afterAll,beforeAll,expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,dirname} from "node:path";
import {ProjectService} from "../../api/src/index";
import {DurableJobStore,type Job} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {currentCasting} from "../../planner/src/casting";
import {directionSnapshot} from "../../planner/src/direction";
import {dialogueSource,createDialogueReplacement,validateDialogueReplacement,validateDialogueReplacementReport} from "../../planner/src/dialogue-replacement";
import {speechRuntimeRevision} from "../src/speech";
import {createProviderPlan} from "../src/catalog";
import {replaceLockedDialogue,inspectDialogueSource,sealDialogueExport,verifyDialogueMedia} from "../src/dialogue-replacement";
import {createAudioDelivery} from "../src/audio-delivery";
import {prepareAudioMedia} from "../src/audio-media";
import {audioTimelineRuntimeRevision} from "../src/audio-timeline";
import {compileAudioLine} from "../../planner/src/audio-performances";
import {audioTakePlan} from "../../planner/src/audio-jobs";
import {retainAudition} from "../../planner/src/retained-auditions";
import {dialogueBaseline} from "../../planner/src/dialogue-jobs";
import {lineSources} from "../../planner/src/performances";
import {parseFountain} from "../../parser/src/index";
import {CAST_INPUT} from "../../../test/fixtures/casting";
import {AUDIO_POLICY,AUDIO_PCM} from "../../../test/fixtures/audio";
import {DUB_POLICY,localizedLine} from "../../../test/fixtures/localized-audio";
import {dialogueLanguage} from "../../planner/src/dialogue-replacement";

const root=mkdtempSync(join(tmpdir(),"hv-dialogue-replacement-")),artifacts=join(root,"artifacts");
const envKeys=["HV_TOKEN_SECRET","HV_NARRATION","HV_ANIMATIC_CAPTIONS","HV_ANIMATIC_PROVIDER_POOL"],originalEnv=Object.fromEntries(envKeys.map(k=>[k,process.env[k]]));
let source:Job;
let pinned:Awaited<ReturnType<typeof inspectDialogueSource>>;
const hash=(data:Uint8Array)=>createHash("sha256").update(data).digest("hex");
beforeAll(async()=>{
  Object.assign(process.env,{HV_TOKEN_SECRET:"dialogue-replacement-test-secret-at-least-thirty-two",HV_NARRATION:"1",HV_ANIMATIC_CAPTIONS:"0",HV_ANIMATIC_PROVIDER_POOL:'["mock"]'});
  const projects=new ProjectService(join(root,"projects.json")),owner=projects.createAnonymousProject();
  const script="INT. ROOM - DAY\n\nMarla welcomes Kevin.\n\nMARLA\nWelcome to the garden.\n\nKEVIN\nThank you for inviting me.\n\nEXT. PATH - DAY\n\nA quiet path.";
  projects.editScript(owner.token,script);const project=projects.attestRights(owner.token)!;
  projects.saveCharacter(owner.token,crypto.randomUUID(),{...CAST_INPUT,name:"Marla",aliases:[]},0);
  projects.saveCharacter(owner.token,crypto.randomUUID(),{...CAST_INPUT,name:"Kevin",aliases:[]},1);
  const store=new DurableJobStore(join(root,"jobs.json"));
  store.enqueue({id:crypto.randomUUID(),idempotencyKey:"source",projectId:owner.projectId,stage:"animatic",tier:"free",scriptVersion:1,scriptText:script,
    rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:120,timeoutMs:60000,costCapUsd:5,budgetReservedUsd:0,
    retryPolicy:{maxRetries:0,backoffMs:1},providerPlan:createProviderPlan("animatic",5),casting:currentCasting(owner.projectId,projects.snapshot().projects[0]!.castingHistory),direction:directionSnapshot(owner.projectId,0,[],0)});
  source=(await processNextJob(store,artifacts,{projects,ledger:new CostLedger(join(root,"ledger.json")),reviewQueue:new OperatorReviewQueue(join(root,"reviews.json"))}))!;
  expect(source.failureReason??source.cancelReason).toBeUndefined();expect(source.status).toBe("done");
  pinned=await inspectDialogueSource(source,artifacts);
},30000);
afterAll(()=>{rmSync(root,{recursive:true,force:true});for(const [key,value]of Object.entries(originalEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}});
function plan(text="Welcome home.",pace=250){
  const shot=source.output!.shotRenders![0]!,line=shot.clip.speech!.lines[0]!;
  return createDialogueReplacement(source,[{shotId:shot.shotId,index:0,sourceHash:line.source.hash,text,voice:{...line.voice,rateWpm:pace},notes:"A shorter greeting."}],pinned.revision,speechRuntimeRevision(),pinned.files);
}

test("complete Spanish and Arabic dubs preserve picture, original lines, measured timing and independent captions",async()=>{
  const queue=DurableJobStore.fromJobs([]),originalVideo=readFileSync(join(artifacts,source.output!.mp4Path)),scene=parseFountain(source.scriptText).scenes[0]!,originalLines=lineSources(scene.dialogue),shot=source.output!.shotRenders![0]!;
  for(const [language,texts]of [["es",["Bienvenida a casa.","Gracias por invitarme."]],["ar",["أهلاً بك في البيت.","شكراً على الدعوة."]]] as const){
    const edits:{shotId:string;index:number;sourceHash:string;audition:ReturnType<typeof retainAudition>}[]=[];
    for(const [index,original]of originalLines.entries()){
      const line=localizedLine(original,language,texts[index]!),characterId=source.casting!.characters.find(c=>c.name.toUpperCase()===original.character.toUpperCase())!.id;
      const job=queue.enqueue({id:crypto.randomUUID(),projectId:source.projectId,idempotencyKey:language+index,tier:"free",stage:"audio-take",scriptVersion:source.scriptVersion,scriptText:source.scriptText,casting:source.casting,rightsAttestedAt:source.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:0,costCapUsd:.25,budgetReservedUsd:.25,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:60000,audioTake:audioTakePlan(0,characterId,line,DUB_POLICY,"local")});
      queue.claimNext(Date.now(),{},{workerId:"dub-audio"});const delivered=createAudioDelivery(line,crypto.randomUUID(),AUDIO_PCM,[{text:texts[index]!,startSec:0,endSec:.9}],[]),scratch=mkdtempSync(join(artifacts,".dub-audio-")),output=prepareAudioMedia(job,scratch,delivered.report,delivered.wav),directory=join(artifacts,dirname(output.wavPath));mkdirSync(dirname(directory),{recursive:true});renameSync(scratch,directory);queue.checkpointAudio(job.id,"dub-audio",output);
      edits.push({shotId:shot.shotId,index,sourceHash:shot.clip.speech!.lines[index]!.source.hash,audition:retainAudition(queue.completeAudio(job.id,"dub-audio",output))});
    }
    const create=(values=edits,dubLanguage:typeof language|undefined=language)=>createDialogueReplacement(source,values,pinned.revision,"retained-audio",pinned.files,Date.now(),undefined,audioTimelineRuntimeRevision(),dubLanguage);
    expect(()=>create(edits.slice(0,1))).toThrow("every line");expect(()=>createDialogueReplacement(source,edits,pinned.revision,"retained-audio",pinned.files,Date.now(),undefined,audioTimelineRuntimeRevision())).toThrow("target-language track");
    const admitted=create();expect(admitted.schema).toBe("hv-dialogue-replacement/4");expect(admitted.dubLanguage).toBe(language);
    const job=queue.enqueue({id:crypto.randomUUID(),projectId:source.projectId,idempotencyKey:"dub-"+language,tier:"free",stage:"dialogue-replacement",scriptVersion:source.scriptVersion,scriptText:source.scriptText,rightsAttestedAt:source.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:dialogueSource(source).totalFrames,costCapUsd:0,budgetReservedUsd:0,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:60000,dialogueReplacement:{source,plan:admitted,requestHash:admitted.revision,storage:"local"}});
    queue.claimNext(Date.now(),{},{workerId:"dub-application"});const result=await replaceLockedDialogue(source,admitted,artifacts,job.id,async()=>{}),sealed=await sealDialogueExport(job,result,artifacts);queue.checkpointDialogue(job.id,"dub-application",sealed);const complete=queue.complete(job.id,"dub-application",sealed);
    await verifyDialogueMedia(complete,sealed,artifacts);expect(dialogueLanguage(result.report.lines)).toBe(language);expect(validateDialogueReplacementReport(source,result.report)).toEqual(result.report);expect(result.report.sourceVideoSha256).toBe(hash(originalVideo));expect(result.report.totalFrames).toBe(dialogueSource(source).totalFrames);
    const captions=readFileSync(result.captionsPath,"utf8"),srt=readFileSync(result.srtPath,"utf8");for(const [i,line]of result.report.lines.entries()){expect(line.source.text).toBe(originalLines[i]!.text);expect(line.text).toBe(texts[i]!);expect(line.startSample).toBe(shot.clip.speech!.lines[i]!.startSample);expect(line.endSample-line.startSample).toBe(22050);expect(captions).toContain(texts[i]!);expect(srt).toContain(texts[i]!);expect(captions).not.toContain(originalLines[i]!.text);}
    const baseline=dialogueBaseline(complete);expect(baseline.auditionFiles).toHaveLength(4);expect(dialogueLanguage(baseline.lines)).toBe(language);
    const continued=createDialogueReplacement(source,[edits[0]!],pinned.revision,"retained-audio",{video:baseline.files.video,manifest:baseline.files.manifest},Date.now(),baseline,audioTimelineRuntimeRevision(),language);expect(validateDialogueReplacement(source,continued)).toEqual(continued);
    const bad=structuredClone(result.report);bad.lines[0]!.text="Changed";expect(()=>validateDialogueReplacementReport(source,bad)).toThrow();
    expect(readFileSync(join(artifacts,source.output!.mp4Path))).toEqual(originalVideo);
  }
},30000);
test("locked dialogue remux changes one read and captions while retaining every encoded picture frame and untouched PCM",async()=>{
  const originalVideo=readFileSync(join(artifacts,source.output!.mp4Path)),originalWav=readFileSync(join(artifacts,source.output!.shotRenders![0]!.files.audio!.path));
  let checks=0;const admitted=plan(),result=await replaceLockedDialogue(source,admitted,artifacts,"dialogue-version-1",async()=>{checks++;});
  const report=result.report,wav=readFileSync(result.wavPath),original=source.output!.shotRenders![0]!.clip.speech!;
  expect(validateDialogueReplacementReport(source,report)).toEqual(report);
  const badReport=structuredClone(report);badReport.lines[1]!.startSample++;expect(()=>validateDialogueReplacementReport(source,badReport)).toThrow("timing");
  expect(checks).toBeGreaterThanOrEqual(4);expect(report.plan).toEqual(admitted);expect(report.totalFrames).toBe(dialogueSource(source).totalFrames);expect(wav.length).toBe(44+report.totalSamples*2);
  expect(report.sourceVideoSha256).toBe(hash(originalVideo));expect(report.videoSha256).toBe(hash(readFileSync(result.mp4Path)));expect(report.videoSha256).not.toBe(report.sourceVideoSha256);
  expect(report.lines[0]!.source).toEqual(original.lines[0]!.source);expect(report.lines[0]!.text).toBe("Welcome home.");expect(report.lines[0]!.startSample).toBe(original.lines[0]!.startSample);
  expect(report.lines[0]!.endSample).toBeLessThan(original.lines[0]!.endSample);expect(report.lines[0]!.pcmSha256).not.toBe(original.lines[0]!.pcmSha256);
  const kept=report.lines[1]!;expect(kept.replaced).toBe(false);expect(kept.startSample).toBe(original.lines[1]!.startSample);expect(kept.pcmSha256).toBe(original.lines[1]!.pcmSha256);
  expect(wav.subarray(44+kept.startSample*2,44+kept.endSample*2)).toEqual(originalWav.subarray(44+kept.startSample*2,44+kept.endSample*2));
  for(const line of report.lines)expect(hash(wav.subarray(44+line.startSample*2,44+line.endSample*2))).toBe(line.pcmSha256);
  expect(wav.subarray(44+report.lines[0]!.endSample*2,44+kept.startSample*2).every(byte=>byte===0)).toBe(true);
  const captions=readFileSync(result.captionsPath,"utf8");expect(captions).toContain("MARLA: Welcome home.");expect(captions).toContain("KEVIN: Thank you for inviting me.");expect(captions).not.toContain("Welcome to the garden.");
  expect(readFileSync(join(artifacts,source.output!.mp4Path))).toEqual(originalVideo);expect(readFileSync(result.hlsPlaylistPath,"utf8")).toContain("#EXT-X-ENDLIST");
  expect(readdirSync(result.directory).sort()).toEqual(["captions.srt","captions.vtt","dialogue.wav","export.mp4","hls","provenance.json"]);
  await expect(replaceLockedDialogue(source,admitted,artifacts,"dialogue-version-1",async()=>{})).rejects.toThrow("already exists");
},30000);
test("overflow, cancellation and permission revocation leave the source intact and publish no replacement",async()=>{
  await expect(replaceLockedDialogue(source,plan("We have a great deal to discuss before we can begin the long walk through the garden.",80),artifacts,"overflow",async()=>{})).rejects.toThrow("is available in the locked picture");
  expect(existsSync(join(artifacts,source.projectId,"overflow"))).toBe(false);
  const abort=new AbortController();let count=0;
  await expect(replaceLockedDialogue(source,plan(),artifacts,"cancelled",async()=>{if(++count===3)abort.abort(new Error("user cancelled"));},abort.signal)).rejects.toThrow("user cancelled");
  count=0;await expect(replaceLockedDialogue(source,plan(),artifacts,"revoked",async()=>{if(++count===3)throw new Error("cast permission revoked");})).rejects.toThrow("permission revoked");
  expect(["cancelled","revoked"].some(id=>existsSync(join(artifacts,source.projectId,id)))).toBe(false);
  expect(readdirSync(join(artifacts,source.projectId)).some(name=>name.startsWith(".hv-dialogue-"))).toBe(false);
},30000);
test("cancelling active synthesis and revoking access at publication discard the unfinished branch",async()=>{
  const abort=new AbortController();let checks=0,timer:ReturnType<typeof setTimeout>|undefined;
  try{await expect(replaceLockedDialogue(source,plan("The garden is quiet. ".repeat(500),80),artifacts,"active-cancel",async()=>{
    if(++checks===3)timer=setTimeout(()=>abort.abort(new Error("cancel active read")),10);
  },abort.signal)).rejects.toThrow("cancel active read");}finally{if(timer)clearTimeout(timer);}
  checks=0;const publicationCheck=2+source.output!.shotRenders!.length+1;
  await expect(replaceLockedDialogue(source,plan(),artifacts,"late-revoke",async()=>{if(++checks===publicationCheck)throw new Error("permission revoked at publication");})).rejects.toThrow("at publication");
  expect(checks).toBe(publicationCheck);expect(existsSync(join(artifacts,source.projectId,"late-revoke"))).toBe(false);expect(existsSync(join(artifacts,source.projectId,"active-cancel"))).toBe(false);
},30000);
test("source revision, line identity, engine revision and edit fields are strictly bound",async()=>{
  const admitted=plan();expect(validateDialogueReplacement(source,admitted)).toEqual(admitted);
  const changed=structuredClone(admitted);changed.edits[0]!.text="Another reading.";expect(()=>validateDialogueReplacement(source,changed)).toThrow("plan changed");
  expect(()=>createDialogueReplacement(source,admitted.edits,"0".repeat(64),admitted.engineVersion,pinned.files)).toThrow("source cut changed");
  expect(()=>createDialogueReplacement(source,[admitted.edits[0],admitted.edits[0]],admitted.sourceRevision,admitted.engineVersion,pinned.files)).toThrow("only once");
  expect(()=>createDialogueReplacement(source,[{...admitted.edits[0],sourceHash:"f".repeat(64)}],admitted.sourceRevision,admitted.engineVersion,pinned.files)).toThrow("line changed");
  expect(()=>createDialogueReplacement(source,[{...admitted.edits[0],command:"anything"}],admitted.sourceRevision,admitted.engineVersion,pinned.files)).toThrow("supported");
  expect(()=>createDialogueReplacement(source,[{...admitted.edits[0],voice:{voice:"../../unowned"}}],admitted.sourceRevision,admitted.engineVersion,pinned.files)).toThrow("built-in");
  const stale=createDialogueReplacement(source,admitted.edits,admitted.sourceRevision,"espeak-"+"f".repeat(64),pinned.files);await expect(replaceLockedDialogue(source,stale,artifacts,"stale",async()=>{})).rejects.toThrow("runtime changed");
  await expect(replaceLockedDialogue(source,admitted,artifacts,"../foreign",async()=>{})).rejects.toThrow("new job");
  expect(()=>dialogueSource({...source,projectId:crypto.randomUUID()})).toThrow();expect(()=>dialogueSource({...source,linkExpiresAt:new Date(0).toISOString()})).toThrow("unexpired");
});
test("same-size media tampering and burned-in source captions are refused before publishing",async()=>{
  const audioPath=join(artifacts,source.output!.shotRenders![0]!.files.audio!.path),originalAudio=readFileSync(audioPath),bad=Buffer.from(originalAudio);bad[100]^=1;writeFileSync(audioPath,bad);
  try{await expect(replaceLockedDialogue(source,plan(),artifacts,"tampered-audio",async()=>{})).rejects.toThrow("checksum");}finally{writeFileSync(audioPath,originalAudio);}
  const videoPath=join(artifacts,source.output!.mp4Path),originalVideo=readFileSync(videoPath),badVideo=Buffer.from(originalVideo);badVideo[100]^=1;writeFileSync(videoPath,badVideo);
  try{await expect(replaceLockedDialogue(source,plan(),artifacts,"tampered-picture",async()=>{})).rejects.toThrow("checksum");}finally{writeFileSync(videoPath,originalVideo);}
  const burned=structuredClone(source);burned.providerPlan!.pool[0]!.snapshot.postProcessing.push("burn-in-captions");expect(()=>dialogueSource(burned)).toThrow("burned-in captions");
},30000);

test("a retained 48 kHz audition creates an independent locked-picture version and survives subsequent temporary dialogue edits",async()=>{
  const casting=source.casting!,characterId=casting.characters[0]!.id,originalLine=lineSources(parseFountain(source.scriptText).scenes[0]!.dialogue)[0]!;
  const line=compileAudioLine(originalLine,{schema:"hv-audio-voice/1",provider:"cartesia",language:"en",voice:{id:AUDIO_POLICY.voiceId,catalogueRevision:AUDIO_POLICY.catalogueRevision,permissionRevision:AUDIO_POLICY.permissionRevision},controls:{speed:1,volume:1,emotion:"calm"},pronunciations:[]},{sourceHash:originalLine.hash,beforeMs:20,afterMs:30,notes:"Synthetic retained audio integration probe."});
  const queue=DurableJobStore.fromJobs([]),audio=queue.enqueue({id:crypto.randomUUID(),projectId:source.projectId,idempotencyKey:"retained-application-audio",tier:"free",stage:"audio-take",scriptVersion:source.scriptVersion,scriptText:source.scriptText,casting,rightsAttestedAt:source.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,
    totalFrames:0,costCapUsd:.25,budgetReservedUsd:.25,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:60000,audioTake:audioTakePlan(0,characterId,line,AUDIO_POLICY,"local")});
  queue.claimNext(Date.now(),{},{workerId:"audio-source"});const delivered=createAudioDelivery(line,crypto.randomUUID(),AUDIO_PCM.subarray(0,24000*2),[{text:"Welcome",startSec:0,endSec:.5}],[{text:"w",startSec:0,endSec:.1}]);
  const scratch=mkdtempSync(join(artifacts,".retained-input-")),audioOutput=prepareAudioMedia(audio,scratch,delivered.report,delivered.wav),audioDirectory=join(artifacts,dirname(audioOutput.wavPath));mkdirSync(dirname(audioDirectory),{recursive:true});renameSync(scratch,audioDirectory);
  queue.checkpointAudio(audio.id,"audio-source",audioOutput);const audition=retainAudition(queue.completeAudio(audio.id,"audio-source",audioOutput));
  const firstShot=source.output!.shotRenders![0]!,admitted=createDialogueReplacement(source,[{shotId:firstShot.shotId,index:0,sourceHash:firstShot.clip.speech!.lines[0]!.source.hash,audition}],pinned.revision,"retained-audio",pinned.files,Date.now(),undefined,audioTimelineRuntimeRevision());
  expect(admitted.schema).toBe("hv-dialogue-replacement/3");expect(admitted.edits[0]!.voice).toBeNull();
  const createJob=(plan:typeof admitted,key:string)=>{queue.enqueue({id:crypto.randomUUID(),projectId:source.projectId,idempotencyKey:key,tier:"free",stage:"dialogue-replacement",scriptVersion:source.scriptVersion,scriptText:source.scriptText,rightsAttestedAt:source.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,
    totalFrames:dialogueSource(source).totalFrames,costCapUsd:0,budgetReservedUsd:0,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:60000,dialogueReplacement:{source,plan,requestHash:plan.revision,storage:"local"}});return queue.claimNext(Date.now(),{},{workerId:"application"})!;};
  const firstJob=createJob(admitted,"apply-first"),espeak=process.env.HV_ESPEAK_PATH;let first:Awaited<ReturnType<typeof replaceLockedDialogue>>;
  try{process.env.HV_ESPEAK_PATH=join(root,"missing-speech-engine");first=await replaceLockedDialogue(source,admitted,artifacts,firstJob.id,async()=>{});}finally{if(espeak===undefined)delete process.env.HV_ESPEAK_PATH;else process.env.HV_ESPEAK_PATH=espeak;}
  const sealed=await sealDialogueExport(firstJob,first,artifacts);queue.checkpointDialogue(firstJob.id,"application",sealed);const complete=queue.complete(firstJob.id,"application",sealed);
  expect(complete.costUsd).toBe(0);expect(first.report.schema).toBe("hv-dialogue-replacement-result/2");expect(first.report.lines[0]!.audition!.source).toEqual(audition);
  expect(first.report.lines[0]!.voice).toBeNull();expect(first.report.lines[0]!.startSample).toBe(firstShot.clip.speech!.lines[0]!.startSample);expect(first.report.lines[0]!.audition!.conversion.totalSamples).toBe(12128);
  expect(readFileSync(join(first.directory,"auditions",audio.id+".wav"))).toEqual(Buffer.from(delivered.wav));expect(first.report.lines[1]!.pcmSha256).toBe(firstShot.clip.speech!.lines[1]!.pcmSha256);
  const baseline=dialogueBaseline(complete);expect(baseline.schema).toBe("hv-dialogue-baseline/2");expect(baseline.auditionFiles).toHaveLength(2);
  rmSync(audioDirectory,{recursive:true,force:true});
  const next=createDialogueReplacement(source,[{shotId:firstShot.shotId,index:1,sourceHash:firstShot.clip.speech!.lines[1]!.source.hash,text:"My pleasure.",voice:{...firstShot.clip.speech!.lines[1]!.voice,rateWpm:250},notes:"A shorter response."}],pinned.revision,speechRuntimeRevision(),{video:baseline.files.video,manifest:baseline.files.manifest},Date.now(),baseline);
  const nextJob=createJob(next,"apply-next"),second=await replaceLockedDialogue(source,next,artifacts,nextJob.id,async()=>{}),secondOutput=await sealDialogueExport(nextJob,second,artifacts);
  expect(second.report.videoStreamSha256).toBe(first.report.videoStreamSha256);expect(second.report.totalFrames).toBe(first.report.totalFrames);
  expect(second.report.lines[0]!.audition).toEqual(first.report.lines[0]!.audition);expect(second.report.lines[0]!.pcmSha256).toBe(first.report.lines[0]!.pcmSha256);expect(second.report.lines[0]!.replaced).toBe(false);
  expect(second.report.lines[1]!.text).toBe("My pleasure.");expect(second.report.lines[1]!.audition).toBeUndefined();expect(readFileSync(join(second.directory,"auditions",audio.id+".wav"))).toEqual(Buffer.from(delivered.wav));
  const a=first.report.lines[0]!,firstPcm=readFileSync(first.wavPath).subarray(44+a.startSample*2,44+a.endSample*2),nextPcm=readFileSync(second.wavPath).subarray(44+a.startSample*2,44+a.endSample*2);expect(nextPcm).toEqual(firstPcm);
  await verifyDialogueMedia(nextJob,secondOutput,artifacts);const badOriginal=readFileSync(join(second.directory,"auditions",audio.id+".wav"));badOriginal[100]^=1;writeFileSync(join(second.directory,"auditions",audio.id+".wav"),badOriginal);
  await expect(verifyDialogueMedia(nextJob,secondOutput,artifacts)).rejects.toThrow("checksum");
},30000);
