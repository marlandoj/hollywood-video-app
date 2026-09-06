import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ProjectService} from "../../api/src/index";
import {DurableJobStore,type Job} from "../../queue/src/index";
import {currentCasting,castingSnapshot} from "../src/casting";
import {parseFountain} from "../../parser/src/index";
import {lineSources} from "../src/performances";
import {compileAudioLine} from "../src/audio-performances";
import {audioTakePlan} from "../src/audio-jobs";
import {prepareAudioMedia} from "../../generator/src/audio-media";
import {createAudioDelivery} from "../../generator/src/audio-delivery";
import {createProviderPlan} from "../../generator/src/catalog";
import {contentHash} from "../../generator/src/capabilities";
import {proposeSceneCut} from "../src/scene-cuts";
import {directionSnapshot} from "../src/direction";
import {renderShots} from "../src/shot-reuse";
import {retainAudition,validateRetainedAudition,filmLineSource,assertAuditionMatchesFilm,assertRetainedAuditionAvailable,assertRetainedAuditionPermission} from "../src/retained-auditions";
import {CAST_INPUT} from "../../../test/fixtures/casting";
import {AUDIO_POLICY,AUDIO_PCM} from "../../../test/fixtures/audio";
const folders:string[]=[],oldSecret=process.env.HV_TOKEN_SECRET;
afterAll(()=>{for(const root of folders)rmSync(root,{recursive:true,force:true});if(oldSecret===undefined)delete process.env.HV_TOKEN_SECRET;else process.env.HV_TOKEN_SECRET=oldSecret;});
function fixture(index=1){
  process.env.HV_TOKEN_SECRET="retained-audition-fixture-secret-at-least-thirty-two";
  const projects=new ProjectService(),owner=projects.createAnonymousProject(),script="INT. GARDEN - DAY\n\nMarla waves.\n\nMARLA\nHello.\n\nMarla waits.\n\nMARLA\nHello.\n\nKevin waves.\n\nKEVIN\nHello.",actor=crypto.randomUUID();
  projects.editScript(owner.token,script);projects.attestRights(owner.token);projects.saveCharacter(owner.token,actor,{...CAST_INPUT,name:"Marla",aliases:[]},0);
  const project=projects.snapshot().projects[0]!,casting=currentCasting(project.id,project.castingHistory),scene=parseFountain(script).scenes[0]!,source=lineSources(scene.dialogue)[index]!;
  const line=compileAudioLine(source,{schema:"hv-audio-voice/1",provider:"cartesia",language:"en",voice:{id:AUDIO_POLICY.voiceId,catalogueRevision:AUDIO_POLICY.catalogueRevision,permissionRevision:AUDIO_POLICY.permissionRevision},controls:{speed:1,volume:1,emotion:"calm"},pronunciations:[]});
  const queue=DurableJobStore.fromJobs([]),job=queue.enqueue({id:crypto.randomUUID(),projectId:project.id,idempotencyKey:"retained",tier:"free",stage:"audio-take",scriptVersion:1,scriptText:script,casting,rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,
    totalFrames:0,costCapUsd:.25,budgetReservedUsd:.25,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:60000,audioTake:audioTakePlan(0,actor,line,AUDIO_POLICY,"local")});
  queue.claimNext(Date.now(),{},{workerId:"receipt-fixture"});const root=mkdtempSync(join(tmpdir(),"hv-retained-audition-"));folders.push(root);
  const audio=createAudioDelivery(line,crypto.randomUUID(),AUDIO_PCM,[{text:"Hello.",startSec:0,endSec:.9}],[{text:"h",startSec:0,endSec:.1}]),output=prepareAudioMedia(job,root,audio.report,audio.wav);
  queue.checkpointAudio(job.id,"receipt-fixture",output);const done=queue.completeAudio(job.id,"receipt-fixture",output),receipt=retainAudition(done);
  const film={...done,id:crypto.randomUUID(),stage:"animatic",audioTake:undefined,audioOutput:undefined,audioCheckpoint:undefined,providerPlan:createProviderPlan("animatic",5),
    direction:directionSnapshot(project.id,1,[],Date.now(),[proposeSceneCut(scene)])} as Job;
  return {projects,owner,project,actor,queue,done,receipt,film,root};
}
test("retained audition receipts are independent evidence without copied settlement authority",()=>{
  const f=fixture();expect(validateRetainedAudition(f.receipt)).toEqual(f.receipt);expect(f.receipt).not.toHaveProperty("costUsd");expect(f.receipt).not.toHaveProperty("invoice");
  expect(f.receipt.output.report.attemptId).toBe(f.done.audioOutput!.report.attemptId);expect(f.receipt.output.files).toEqual(f.done.audioOutput!.files);
  expect(()=>assertRetainedAuditionAvailable(f.receipt,f.done)).not.toThrow();expect(()=>retainAudition({...f.done,status:"running"})).toThrow("completed");
  expect(()=>assertRetainedAuditionAvailable(f.receipt,undefined)).toThrow("changed or expired");
  const forged=structuredClone(f.receipt);forged.output.report.plan.notes="different";expect(()=>validateRetainedAudition(forged)).toThrow();
  const polluted={...f.receipt,invoice:{usd:0}};expect(()=>validateRetainedAudition(polluted)).toThrow("supported");
});
test("ordered coverage binds repeated dialogue to the correct original occurrence despite reset shot indices",()=>{
  const f=fixture(),shots=renderShots(f.film),spoken=shots.filter(s=>s.dialogue.length);expect(spoken).toHaveLength(3);
  const target=filmLineSource(f.film,spoken[1]!.id,0);expect(target.source.index).toBe(1);expect(target.source.text).toBe("Hello.");expect(target.source.hash).toBe(f.receipt.take.line.source.hash);
  expect(()=>assertAuditionMatchesFilm(f.receipt,f.film,spoken[1]!.id,0)).not.toThrow();
  const recast=castingSnapshot(f.film.projectId,2,f.film.casting!.characters.map(c=>({...c,id:crypto.randomUUID()})));
  expect(()=>assertAuditionMatchesFilm(f.receipt,{...f.film,casting:recast},spoken[1]!.id,0)).toThrow("different cast character");
  expect(()=>assertAuditionMatchesFilm(f.receipt,f.film,spoken[0]!.id,0)).toThrow("different screenplay line");expect(()=>assertAuditionMatchesFilm(f.receipt,f.film,spoken[2]!.id,0)).toThrow("different screenplay line");
  expect(()=>assertAuditionMatchesFilm(f.receipt,{...f.film,projectId:crypto.randomUUID(),casting:undefined,direction:undefined},"shot-1-1",1)).toThrow();
  expect(()=>filmLineSource(f.film,spoken[1]!.id,1)).toThrow("unavailable");
  const noCoverage={...f.film,direction:directionSnapshot(f.film.projectId,0,[],0)},original=renderShots(noCoverage).find(s=>s.dialogue.length)!;
  expect(()=>assertAuditionMatchesFilm(f.receipt,noCoverage,original.id,1)).not.toThrow();
});
test("derived audition permission survives original media expiry but refuses cast or voice withdrawal",()=>{
  const f=fixture();expect(()=>assertRetainedAuditionPermission(f.receipt,f.project,AUDIO_POLICY)).not.toThrow();
  // Use the real receipt at a later clock for retention; historical receipt hashes remain immutable.
  const afterExpiry=Date.parse(f.done.linkExpiresAt!)+1;expect(()=>assertRetainedAuditionAvailable(f.receipt,f.done,afterExpiry)).toThrow("unexpired");
  const extended={...f.project,deleteAfter:new Date(afterExpiry+100000).toISOString()};expect(()=>assertRetainedAuditionPermission(f.receipt,extended,AUDIO_POLICY,afterExpiry)).not.toThrow();
  expect(()=>assertRetainedAuditionPermission(f.receipt,f.project,undefined)).toThrow("no longer authorized");
  const different={...AUDIO_POLICY,permissionRevision:"f".repeat(64)};expect(()=>assertRetainedAuditionPermission(f.receipt,f.project,different)).toThrow();
  const revoked=structuredClone(f.project);revoked.castingHistory!.at(-1)!.characters[0]!.permission.status="revoked";
  const snapshot=revoked.castingHistory!.at(-1)!;snapshot.revision=contentHash({projectId:snapshot.projectId,version:snapshot.version,characters:snapshot.characters});
  expect(()=>assertRetainedAuditionPermission(f.receipt,revoked,AUDIO_POLICY)).toThrow("not permitted");
});
