import type {Job,JobInput} from "../../queue/src/index";
import type {PersistedProject} from "../../api/src/index";
import type {CastingSnapshot} from "./casting";
import {contentHash} from "../../generator/src/capabilities";
import {audioHash,audioRecord,AudioPerformanceError} from "./audio-performances";
import {audioTakeHoldUsd,validateAudioTake,validateAudioTakeOutput,assertAudioTakePermission,validateAudioPolicy,type AudioTakePlan,type AudioTakeOutput,type AudioPolicy} from "./audio-jobs";
import {renderShots} from "./shot-reuse";
import {lineSources,type LineSource} from "./performances";
import {parseFountain} from "../../parser/src/index";

/** Flat media/provenance receipt. Settlement authority stays on the original audio job. */
export interface RetainedAudition {
  schema:"hv-retained-audition/1";projectId:string;jobId:string;scriptVersion:number;scriptText:string;
  casting:CastingSnapshot;rightsAttestedAt:string;completedAt:string;linkExpiresAt:string;
  take:AudioTakePlan;output:AudioTakeOutput;revision:string;
}
function fail(s:string):never{throw new AudioPerformanceError(s);}
export class RetainedVoicePermissionError extends Error {override name="SafetyRefusal";}
function receiptJob(receipt:RetainedAudition):JobInput{
  return {id:receipt.jobId,projectId:receipt.projectId,idempotencyKey:"retained:"+receipt.jobId,stage:"audio-take",tier:"free",scriptVersion:receipt.scriptVersion,scriptText:receipt.scriptText,
    casting:receipt.casting,rightsAttestedAt:receipt.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,audioTake:receipt.take,totalFrames:0,
    costCapUsd:audioTakeHoldUsd(receipt.take),budgetReservedUsd:audioTakeHoldUsd(receipt.take),retryPolicy:{maxRetries:0,backoffMs:1000},timeoutMs:60000};
}
export function validateRetainedAudition(receipt:RetainedAudition):RetainedAudition{
  audioRecord(receipt,["schema","projectId","jobId","scriptVersion","scriptText","casting","rightsAttestedAt","completedAt","linkExpiresAt","take","output","revision"]);
  if(receipt.schema!=="hv-retained-audition/1")fail("Invalid retained audition receipt.");
  for(const value of [receipt.rightsAttestedAt,receipt.completedAt,receipt.linkExpiresAt])if(typeof value!=="string"||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)fail("Invalid audition permission or retention date.");
  if(Date.parse(receipt.completedAt)<Date.parse(receipt.take.admittedAt)||Date.parse(receipt.linkExpiresAt)<=Date.parse(receipt.completedAt))fail("The audition completion or retention window changed.");
  const job=receiptJob(receipt);validateAudioTake(job);validateAudioTakeOutput(job,receipt.output);
  const {revision,...data}=receipt;if(audioHash(revision)!==contentHash(data))fail("The retained audition evidence changed.");return structuredClone(receipt);
}
export function retainAudition(job:Job,now=Date.now()):RetainedAudition{
  if(job.stage!=="audio-take"||job.status!=="done"||!job.audioTake||!job.audioOutput||!job.casting||!job.rightsAttestedAt||!job.completedAt||!job.linkExpiresAt||!Number.isFinite(now)||Date.parse(job.linkExpiresAt)<=now)fail("Choose a completed, unexpired audition with retained audio.");
  validateAudioTakeOutput(job,job.audioOutput);
  const data={schema:"hv-retained-audition/1" as const,projectId:job.projectId,jobId:job.id,scriptVersion:job.scriptVersion,scriptText:job.scriptText,casting:job.casting,rightsAttestedAt:job.rightsAttestedAt,
    completedAt:job.completedAt,linkExpiresAt:job.linkExpiresAt,take:job.audioTake,output:job.audioOutput};
  return validateRetainedAudition({...data,revision:contentHash(data)});
}
/** Ordered coverage may split a scene into several shots, resetting local line indices.
 * Match via screenplay order, never by the first occurrence of repeated dialogue text. */
export function filmLineSource(film:Job,shotId:string,index:number):{sceneIndex:number;heading:string;source:LineSource}{
  const shots=renderShots(film,Date.parse(film.startedAt??film.completedAt??"")),shot=shots.find(s=>s.id===shotId);
  if(!shot||!Number.isInteger(index)||index<0)fail("Choose a retained film line.");
  const parsed=parseFountain(film.scriptText),scene=parsed.scenes[shot.sceneIndex];if(!scene)fail("The film scene source is unavailable.");
  let offset=0;for(const current of shots.filter(s=>s.sceneIndex===shot.sceneIndex)){
    const local=lineSources(current.dialogue),original=lineSources(scene.dialogue);
    for(const [i,line]of local.entries()){
      const source=original[offset+i];if(!source||line.text!==source.text||line.character!==source.character||contentHash(line.cues)!==contentHash(source.cues))fail("The film dialogue order no longer matches its screenplay.");
      if(current.id===shotId&&i===index)return {sceneIndex:shot.sceneIndex,heading:scene.heading,source};
    }
    offset+=local.length;
  }
  fail("The selected film line is unavailable.");
}
export function assertAuditionMatchesFilm(receipt:RetainedAudition,film:Job,shotId:string,index:number):void{
  if(receipt.take.narration)fail("A narration take belongs on a separate voice-over track, not a screenplay dialogue line.");
  validateRetainedAudition(receipt);const target=filmLineSource(film,shotId,index),scene=parseFountain(receipt.scriptText).scenes[receipt.take.sceneIndex];
  if(receipt.projectId!==film.projectId||receipt.take.sceneIndex!==target.sceneIndex||scene?.heading!==target.heading||contentHash(receipt.take.line.source)!==contentHash(target.source))fail("The audition belongs to a different screenplay line, character or scene.");
  const character=film.casting?.characters.find(c=>c.id===receipt.take.characterId);
  if(!character||![character.name,...character.aliases].some(name=>name.toLocaleUpperCase("en-US")===target.source.character.toLocaleUpperCase("en-US")))fail("The audition belongs to a different cast character from this picture cut.");
}
/** Finished derived cuts can outlive the audition's media, but never its permission. */
export function assertRetainedAuditionPermission(receipt:RetainedAudition,project:Pick<PersistedProject,"id"|"deleteAfter"|"rightsAttestedAt"|"castingHistory">|undefined,policy:AudioPolicy|undefined,now=Date.now()):void{
  // Historical playback checks project/cast permission and never reads current script versions.
  validateRetainedAudition(receipt);assertAudioTakePermission(receiptJob(receipt),project as PersistedProject|undefined,now,false);
  let authorized=false;try{authorized=Boolean(policy&&validateAudioPolicy(policy,now).permissionRevision===receipt.take.policy.permissionRevision&&policy.voiceId===receipt.take.policy.voiceId);}catch{/* Invalid or expired permission also stops the job without retry. */}
  if(!authorized)throw new RetainedVoicePermissionError("This retained voice is no longer authorized for playback or application.");
}
/** Before a fresh application, the original source job must still own the reviewed take. */
export function assertRetainedAuditionAvailable(receipt:RetainedAudition,job:Job|undefined,now=Date.now()):void{
  if(!job||retainAudition(job,now).revision!==receipt.revision)fail("The retained audition changed or expired. Review an available take.");
}
