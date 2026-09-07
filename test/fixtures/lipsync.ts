import {mkdirSync,mkdtempSync,renameSync,writeFileSync,readFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {ProjectService} from "../../packages/api/src/index";
import {DurableJobStore,type JobInput} from "../../packages/queue/src/index";
import {processNextJob} from "../../packages/queue/src/worker";
import {CostLedger,OperatorReviewQueue} from "../../packages/operator/src/index";
import {currentCasting} from "../../packages/planner/src/casting";
import {directionSnapshot} from "../../packages/planner/src/direction";
import {createProviderPlan} from "../../packages/generator/src/catalog";
import {compileAudioLine} from "../../packages/planner/src/audio-performances";
import {audioTakePlan} from "../../packages/planner/src/audio-jobs";
import {lineSources} from "../../packages/planner/src/performances";
import {parseFountain} from "../../packages/parser/src/index";
import {createAudioDelivery} from "../../packages/generator/src/audio-delivery";
import {prepareAudioMedia} from "../../packages/generator/src/audio-media";
import {retainAudition} from "../../packages/planner/src/retained-auditions";
import {createDialogueReplacement,dialogueSource} from "../../packages/planner/src/dialogue-replacement";
import {inspectDialogueSource,replaceLockedDialogue,sealDialogueExport} from "../../packages/generator/src/dialogue-replacement";
import {audioTimelineRuntimeRevision} from "../../packages/generator/src/audio-timeline";
import {createLipSyncPlan,retainLipSyncSource,type LipSyncPlan} from "../../packages/planner/src/lipsync";
import {lipSyncPolicy} from "../../packages/planner/src/lipsync-policy";
import {previewLipSyncFrame,prepareLipSyncMedia,renderLipSyncVersion} from "../../packages/generator/src/lipsync-media";
import {SyncLipSyncProvider,type LipSyncReceipt} from "../../packages/generator/src/sync-lipsync";
import {contentHash} from "../../packages/generator/src/capabilities";
import {CAST_INPUT} from "./casting";
import {AUDIO_PCM,AUDIO_POLICY} from "./audio";
import {narrationRead,narrationLineSource} from "../../packages/planner/src/narration-read";
import {narrationTrack,narrationSceneWindows,type NarrationTrack} from "../../packages/planner/src/narration-mix";

export const LIPSYNC_POLICY=lipSyncPolicy({label:"Sync · closed fixture",accountRevision:"a".repeat(64),licenceEvidenceSha256:"b".repeat(64),priceEvidenceSha256:"c".repeat(64),outputHosts:["output.sync.so"],heldUsd:5,maxFrames:900,validFrom:"2026-01-01T00:00:00.000Z",expiresAt:"2099-01-01T00:00:00.000Z"});
export function lipFixtureJob(plan:LipSyncPlan,id=crypto.randomUUID(),key=id):JobInput{return {id,projectId:plan.source.projectId,idempotencyKey:key,tier:"free",stage:"lip-sync",scriptText:plan.source.film.scriptText,scriptVersion:plan.source.film.scriptVersion,rightsAttestedAt:plan.source.film.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:plan.source.dialogue.totalFrames,costCapUsd:plan.policy.heldUsd,budgetReservedUsd:plan.policy.heldUsd,retryPolicy:{maxRetries:2,backoffMs:1},timeoutMs:60000,lipSync:plan};}
/** Entirely local synthetic qualification. No production policy or network call. */
export async function createLipSyncFixture(root:string,withNarration=false){
  const projects=new ProjectService(join(root,"projects.json")),owner=projects.createAnonymousProject(),script="EXT. WALKWAY - DAY\n\nAn empty walkway.\n\nINT. GARDEN - DAY\n\nMarla waves.\n\nMARLA\nHello.\n\nKEVIN\nWelcome to our garden.\n\nEXT. PATH - DAY\n\nA quiet path.",actorId=crypto.randomUUID(),artifacts=join(root,"artifacts"),store=new DurableJobStore(join(root,"jobs.json"));
  projects.editScript(owner.token,script);projects.attestRights(owner.token);projects.saveCharacter(owner.token,actorId,{...CAST_INPUT,name:"Marla",aliases:[]},0);
  const project=projects.snapshot().projects[0]!,casting=currentCasting(project.id,project.castingHistory);
  store.enqueue({id:crypto.randomUUID(),projectId:project.id,idempotencyKey:"picture",stage:"animatic",tier:"free",scriptVersion:1,scriptText:script,rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:120,costCapUsd:5,budgetReservedUsd:0,retryPolicy:{maxRetries:0,backoffMs:1},timeoutMs:60000,providerPlan:createProviderPlan("animatic",5),casting,direction:directionSnapshot(project.id,0,[],0)});
  const film=(await processNextJob(store,artifacts,{projects,ledger:new CostLedger(join(root,"ledger.json")),reviewQueue:new OperatorReviewQueue(join(root,"reviews.json"))}))!;
  if(film.status!=="done")throw new Error(film.failureReason??film.cancelReason??"Fixture film failed");
  const source=lineSources(parseFountain(script).scenes[1]!.dialogue)[0]!,line=compileAudioLine(source,{schema:"hv-audio-voice/1",provider:"cartesia",language:"en",voice:{id:AUDIO_POLICY.voiceId,catalogueRevision:AUDIO_POLICY.catalogueRevision,permissionRevision:AUDIO_POLICY.permissionRevision},controls:{speed:1,volume:1,emotion:"calm"},pronunciations:[]});
  store.enqueue({id:crypto.randomUUID(),projectId:project.id,idempotencyKey:"audio",stage:"audio-take",tier:"free",scriptVersion:1,scriptText:script,rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:0,costCapUsd:.25,budgetReservedUsd:.25,retryPolicy:{maxRetries:0,backoffMs:1},timeoutMs:60000,casting,audioTake:audioTakePlan(1,actorId,line,AUDIO_POLICY,"local")});
  const audio=store.claimNext(Date.now(),{},{workerId:"fixture-audio"})!,delivered=createAudioDelivery(line,crypto.randomUUID(),AUDIO_PCM.subarray(0,14400*2),[{text:"Hello.",startSec:0,endSec:.25}],[{text:"h",startSec:0,endSec:.1}]);
  const scratch=mkdtempSync(join(artifacts,".audio-")),audioOutput=prepareAudioMedia(audio,scratch,delivered.report,delivered.wav),target=join(artifacts,dirname(audioOutput.wavPath));mkdirSync(dirname(target),{recursive:true});renameSync(scratch,target);store.checkpointAudio(audio.id,"fixture-audio",audioOutput);const audition=retainAudition(store.completeAudio(audio.id,"fixture-audio",audioOutput));
  let narration:NarrationTrack|undefined;
  if(withNarration){
    const read=narrationRead({text:"Another voice guides the story.",reviewed:true}),source=narrationLineSource(read,"Marla"),voice=compileAudioLine(source,line.profile,{sourceHash:source.hash,beforeMs:0,afterMs:0},"words");
    store.enqueue({id:crypto.randomUUID(),projectId:project.id,idempotencyKey:"narrator",stage:"audio-take",tier:"free",scriptVersion:1,scriptText:script,rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:0,costCapUsd:.25,budgetReservedUsd:.25,retryPolicy:{maxRetries:0,backoffMs:1},timeoutMs:60000,casting,audioTake:audioTakePlan(1,actorId,voice,AUDIO_POLICY,"local",Date.now(),undefined,read)});
    const audio=store.claimNext(Date.now(),{},{workerId:"fixture-narrator"})!,delivered=createAudioDelivery(voice,crypto.randomUUID(),AUDIO_PCM,[{text:read.text,startSec:0,endSec:.9}],[]),scratch=mkdtempSync(join(artifacts,".narrator-")),output=prepareAudioMedia(audio,scratch,delivered.report,delivered.wav),target=join(artifacts,dirname(output.wavPath));mkdirSync(dirname(target),{recursive:true});renameSync(scratch,target);store.checkpointAudio(audio.id,"fixture-narrator",output);const take=retainAudition(store.completeAudio(audio.id,"fixture-narrator",output));
    narration=narrationTrack(film,{language:"en",reviewed:true,cues:[{id:crypto.randomUUID(),role:"voice-over",startSample:narrationSceneWindows(film).find(w=>w.sceneIndex===1)!.startSample,gainDb:-12,duckDb:-12,attackMs:100,releaseMs:100,audition:take}]},dialogueSource(film).totalFrames*735,"en");
  }
  const pinned=await inspectDialogueSource(film,artifacts),shot=film.output!.shotRenders!.find(r=>r.clip.speech?.lines.length)!,plan=createDialogueReplacement(film,[{shotId:shot.shotId,index:0,sourceHash:shot.clip.speech!.lines[0]!.source.hash,audition}],pinned.revision,"retained-audio",pinned.files,Date.now(),undefined,audioTimelineRuntimeRevision(),undefined,narration);
  store.enqueue({id:crypto.randomUUID(),projectId:project.id,idempotencyKey:"dialogue",stage:"dialogue-replacement",tier:"free",scriptVersion:1,scriptText:script,rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:dialogueSource(film).totalFrames,costCapUsd:0,budgetReservedUsd:0,retryPolicy:{maxRetries:0,backoffMs:1},timeoutMs:60000,dialogueReplacement:{source:film,plan,requestHash:plan.revision,storage:"local"}});
  const dialogue=store.claimNext(Date.now(),{},{workerId:"fixture-dialogue"})!,result=await replaceLockedDialogue(film,plan,artifacts,dialogue.id,async()=>{}),output=await sealDialogueExport(dialogue,result,artifacts);store.checkpointDialogue(dialogue.id,"fixture-dialogue",output);const done=store.complete(dialogue.id,"fixture-dialogue",output),retained=retainLipSyncSource(done);
  const preview=await previewLipSyncFrame(retained,artifacts,shot.shotId,0,0),selection={frame:0,width:preview.width,height:preview.height,x:Math.floor(preview.width/2),y:Math.floor(preview.height/2),rgbSha256:preview.rgbSha256};
  const lipPlan=createLipSyncPlan(retained,shot.shotId,0,selection,LIPSYNC_POLICY,"local",contentHash({fixture:true})),job=store.enqueue(lipFixtureJob(lipPlan));store.claimNext(Date.now(),{},{workerId:"fixture-lipsync"});
  const prepared=await prepareLipSyncMedia(job,artifacts,join(artifacts,job.projectId,job.id,"prepared"),async()=>{});store.checkpointLipSyncPrepared(job.id,"fixture-lipsync",prepared);
  writeFileSync(join(root,"audio-policy.json"),JSON.stringify({schema:"hv-audio-policies/1",policies:[AUDIO_POLICY]}));writeFileSync(join(root,"lipsync-policy.json"),JSON.stringify(LIPSYNC_POLICY));
  return {projects,owner,project,actorId,store,artifacts,film,dialogue:done,audition,plan:lipPlan,job:store.get(job.id)!,prepared,preview};
}
export async function completeLipSyncFixture(f:Awaited<ReturnType<typeof createLipSyncFixture>>){
  const video=readFileSync(join(f.artifacts,f.prepared.video.path)),audio=readFileSync(join(f.artifacts,f.prepared.audio.path)),remote={id:crypto.randomUUID(),model:"sync-3",createdAt:new Date().toISOString(),status:"COMPLETED",outputUrl:"https://output.sync.so/fixture.mp4"};let receipt:LipSyncReceipt|undefined;
  const provider=new SyncLipSyncProvider({apiKey:"closed-fixture-only",pollMs:1,fetchImpl:(async(url:unknown,init?:RequestInit)=>String(url).includes("output.sync.so")?new Response(video):Response.json(remote,{status:init?.method==="POST"?201:200})) as typeof fetch});
  const delivered=await provider.synthesize(f.plan,f.prepared,{video,audio},{authorize:async()=>({id:f.job.id,priceRevision:LIPSYNC_POLICY.priceRevision,heldUsd:LIPSYNC_POLICY.heldUsd}),assertCurrent:async()=>{},observe:async value=>{receipt=structuredClone(value);}}),output=await renderLipSyncVersion(f.job,f.prepared,delivered.video,delivered.delivery,f.artifacts,join(f.artifacts,f.job.projectId,f.job.id,"output"),async()=>{});
  f.store.checkpointLipSync(f.job.id,"fixture-lipsync",output);const done=f.store.complete(f.job.id,"fixture-lipsync",output);return {done,receipt:receipt!};
}
