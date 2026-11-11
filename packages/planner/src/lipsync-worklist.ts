import type {Job} from "../../queue/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {LIPSYNC_CAPABILITY} from "../../generator/src/lipsync-capability";
import {parseFountain} from "../../parser/src/index";
import {renderShots} from "./shot-reuse";
import {lineSources} from "./performances";
import {onCameraSpeakers,speakingDirection,SPEAKING_NAMES_SHOWN} from "./dialogue-placement";
import {createLipSyncPlan,lipSyncWindow,validateLipSyncPlan,validateLipSyncSource,type LipSyncPlan,type LipSyncSelection,type LipSyncSource,type LipSyncWindow} from "./lipsync";
import {lipFail,validateLipSyncPolicy,type LipSyncPolicy} from "./lipsync-policy";
import {faceDetectionRecordDetail,validateFaceDetectionPolicy,type DetectedFacePoint,type FaceDetectionPolicy,type FaceDetectionRecord} from "./face-detection";
import {FACE_DETECTION_CAPABILITY} from "../../generator/src/face-detection-capability";

/**
 * HV-022-23: the studio's lip-sync work list for a voiced cut.
 *
 * The video model renders silent picture and the cast's voices are laid under it (final-dialogue.ts,
 * the studio's `voiceFinal`), so in "The Tide Clock" no mouth moved. HV-030-43 put each feature line on its
 * own speaker's shot and asked the picture model to show them speaking. The lip-sync job (lipsync.ts,
 * docs/LIP-SYNC.md) can redraw a mouth to a line, but it is an owner job: the owner chooses a verified
 * source frame and a face point for every pass.
 *
 * This list says, for every applied line of a voiced cut, whether the studio may lip-sync it, and why not
 * when it may not. It decides nothing about where a face is: a pass is listed as ready only when the owner
 * has already chosen a face point for that shot and character on the same picture, and every other
 * on-camera line is listed as needing one. Nothing here detects a face.
 *
 * HV-022-25: with the studio's face-point finder on (face-detection.ts), a line with no owner point may be ready on
 * the finder's suggestion -- exactly one face found on its verified frame -- or listed with a detection planned for it.
 * The owner's point always wins over a suggestion.
 *
 * Off by default: the list and the studio's queueing exist only when the operator sets
 * `HV_STUDIO_LIPSYNC=1`. The switch never enters a plan, a policy, a project or a job, so with it off every
 * record, hash and revision is what it was.
 */
export const STUDIO_LIPSYNC_ENV="HV_STUDIO_LIPSYNC";
export function studioLipSyncEnabled(env:Record<string,string|undefined>=process.env):boolean{return env[STUDIO_LIPSYNC_ENV]==="1";}

/** Why a line is in or out, in the order the list checks them. */
export type LipSyncWorkReason="ready"|"no-applied-voice"|"no-window"|"unplaced"|"off-camera"|"not-framed"|"already-synced"|"pass-limit"|"too-long"|"failed-pass"|"no-face-point";
export const LIPSYNC_WORK_REASONS:Record<LipSyncWorkReason,string>={
  "ready":"On camera, framed for its speaker, with the owner's face point for this shot on this picture.",
  "no-applied-voice":"The line keeps its temporary voice; lip-sync needs an applied cast take.",
  "no-window":"The line's picture timing on this cut cannot be read, so no lip-sync window can be cut for it.",
  "unplaced":"The feature's plan did not place lines on their speakers' shots, so the line may sit on a wide shot.",
  "off-camera":"The speaker is not on screen (V.O., O.S., or a voice through a device or a door).",
  "not-framed":"The shot was not asked to show this speaker speaking.",
  "already-synced":"This cut already carries a lip-sync pass for the line.",
  "pass-limit":"This cut has reached its 32 retained lip-sync passes.",
  "too-long":"The line is longer than the provider policy's lip-sync duration.",
  "failed-pass":"The studio's pass for this line on this cut failed or was cancelled. Retry it under Direct lip-sync; the studio never buys a line twice by itself.",
  "no-face-point":"The owner has not chosen a face point for this shot and speaker on this picture.",
};

/** A face point the owner chose for a pass, in the picture's own frame numbering. */
export interface LipSyncFacePoint {jobId:string;picture:string;shotId:string;characterId:string;absoluteFrame:number;width:number;height:number;x:number;y:number;rgbSha256:string;admittedAt:string}
/**
 * HV-022-25: present only while the studio's face-point finder is on (`faceDetection` in the list's options). A
 * ready line's point came from the finder when `detectedPoint` names its detection; a line that still needs a point
 * says whether a detection is planned for it on approval, or what an earlier one found.
 */
export type LipSyncItemDetection={status:"planned";frame:number;heldUsd:number}|{status:"held"|"settled";detectionId:string;outcome:FaceDetectionRecord["outcome"];faces:number|null;detail:string};
export interface LipSyncWorkItem {shotId:string;lineIndex:number;sceneIndex:number|null;character:string;characterId:string|null;text:string;window:LipSyncWindow|null;
  reason:LipSyncWorkReason;included:boolean;selection:LipSyncSelection|null;facePointJobId:string|null;heldUsd:number|null;
  detectedPoint?:{detectionId:string}&DetectedFacePoint["provenance"];faceDetection?:LipSyncItemDetection}
export interface LipSyncListDetection {policyRevision:string;capabilityRevision:string;heldUsdPerDetection:number;planned:number;heldUsd:number}
export interface LipSyncWorkList {schema:"hv-lipsync-worklist/1";sourceJobId:string;sourceRevision:string;picture:string;placement:"speaker"|null;
  policyRevision:string|null;capabilityRevision:string;heldUsdPerPass:number|null;items:LipSyncWorkItem[];passes:number;needFacePoint:number;heldUsd:number|null;
  faceDetection?:LipSyncListDetection;revision:string}

/**
 * Which decoded picture a source is. Dialogue replacement copies the film's H.264 packets, so every voiced
 * cut of one final has the same frames and names them by its elementary stream hash. A lip-sync output is a
 * new encode of the whole film, so its frames are its own: a face point chosen on one never stands for the other.
 */
export function lipSyncPicture(source:LipSyncSource):string{
  return source.history.length?"lipsync-export:"+source.files.video.sha256:"video-stream:"+source.dialogue.videoStreamSha256;
}

/**
 * The face points owners chose for the project's lip-sync passes. A pass that failed or was cancelled offers
 * none (its point may be why), and neither does one whose plan no longer validates. A pass the studio queued
 * offers none either: it copied an owner's point and chose nothing (`studioLipSyncKey`).
 *
 * Fail closed on the owner's review: a pass whose latest review is not an accept, or rates anything under 3
 * (the rubric's own "visible issue", lipsync.ts), offers none. A pass not yet reviewed still offers its point:
 * the owner chose it on a decoded frame, and the review rates the provider's output, not the choice.
 */
export function savedLipSyncFacePoints(jobs:Job[]):LipSyncFacePoint[]{
  return jobs.flatMap(job=>{
    if(!job.lipSync||job.status==="failed"||job.status==="cancelled"||STUDIO_KEY.test(job.idempotencyKey))return [];
    const review=job.lipSyncReviews?.entries.at(-1);
    if(review&&(review.decision!=="accept"||Math.min(review.mouthSync,review.faceStability,review.expression)<3))return [];
    let plan:LipSyncPlan;try{plan=validateLipSyncPlan(job.lipSync);}catch{return [];}
    return [{jobId:job.id,picture:lipSyncPicture(plan.source),shotId:plan.shotId,characterId:plan.characterId,absoluteFrame:plan.window.startFrame+plan.selection.frame,
      width:plan.selection.width,height:plan.selection.height,x:plan.selection.x,y:plan.selection.y,rgbSha256:plan.selection.rgbSha256,admittedAt:plan.admittedAt}];
  });
}

const micro=(usd:number)=>Math.round(usd*1e6);
/** HV-022-23: the request-key prefix only the studio's passes use; the owner's submit route refuses it. */
export const STUDIO_KEY_PREFIX="studio-lipsync-";
const STUDIO_KEY=/(?:^|:)studio-lipsync-[a-f0-9]{48}$/;

/**
 * The work list for one voiced cut. `policy` is the operator's current lip-sync policy, or undefined when
 * none is configured: the list is still computed, with no hold and no duration check.
 */
export interface LipSyncFinderInput {policy:FaceDetectionPolicy;points:DetectedFacePoint[];records:FaceDetectionRecord[]}
export function lipSyncWorkList(source:LipSyncSource,options:{facePoints?:LipSyncFacePoint[];policy?:LipSyncPolicy;now?:number;studioPasses?:Pick<Job,"idempotencyKey"|"status">[];faceDetection?:LipSyncFinderInput}={}):LipSyncWorkList{
  const retained=validateLipSyncSource(source,options.now),policy=options.policy?validateLipSyncPolicy(options.policy,options.now):undefined,film=retained.film;
  // HV-022-25: the finder is considered only with both policies; without it every field, hash and revision is as before.
  const finder=options.faceDetection&&policy?{...options.faceDetection,policy:validateFaceDetectionPolicy(options.faceDetection.policy,options.now)}:undefined;
  const placement=film.sequence?.dialoguePlacement==="speaker"?"speaker" as const:null,picture=lipSyncPicture(retained);
  const shots=renderShots(film,Date.parse(film.startedAt??film.completedAt??"")),scenes=parseFountain(film.scriptText).scenes;
  // Each shot's first scene speech: a placed scene's shots carry its speeches in order (dialogue-placement.ts).
  const firstSpeech=new Map<string,number>(),seen=new Map<number,number>();
  for(const shot of shots){const before=seen.get(shot.sceneIndex)??0;firstSpeech.set(shot.id,before);seen.set(shot.sceneIndex,before+shot.dialogue.length);}
  // A line whose studio key already names a failed or cancelled pass is not bought again by the studio (`failed-pass`).
  const stopped=new Set((options.studioPasses??[]).filter(j=>j.status==="failed"||j.status==="cancelled").flatMap(j=>STUDIO_KEY.exec(j.idempotencyKey)?.[0].replace(/^:/,"")??[]));
  const points=[...(options.facePoints??[])].filter(p=>p.picture===picture).sort((a,b)=>b.admittedAt.localeCompare(a.admittedAt)||a.jobId.localeCompare(b.jobId));
  const detected=[...(finder?.points??[])].filter(p=>p.picture===picture).sort((a,b)=>b.admittedAt.localeCompare(a.admittedAt)||a.detectionId.localeCompare(b.detectionId));
  const records=[...(finder?.records??[])].filter(r=>r.picture===picture).sort((a,b)=>b.admittedAt.localeCompare(a.admittedAt)||a.id.localeCompare(b.id));
  const items=retained.dialogue.lines.map((line):LipSyncWorkItem=>{
    const shot=shots.find(s=>s.id===line.shotId),characterId=line.audition?.source.take.characterId??null;
    const base={shotId:line.shotId,lineIndex:line.source.index,sceneIndex:shot?.sceneIndex??null,character:line.source.character,characterId,text:line.text,window:null as LipSyncWindow|null,selection:null,facePointJobId:null,heldUsd:null};
    const out=(reason:LipSyncWorkReason,window:LipSyncWindow|null=null):LipSyncWorkItem=>({...base,window,reason,included:false});
    if(!line.audition)return out("no-applied-voice");
    let window:LipSyncWindow;try{window=lipSyncWindow(retained,line.shotId,line.source.index);}catch{return out("no-window");}
    if(!placement)return out("unplaced",window);
    const scene=shot&&scenes[shot.sceneIndex],start=shot?firstSpeech.get(shot.id)!:0,block=shot?.dialogue[line.source.dialogueIndex];
    // A shot whose speeches are not its scene's, in order (accepted coverage, or a plan this can't read), is not one the placement framed.
    if(!shot||!scene||!block||shot.dialogue.some((b,i)=>JSON.stringify(b)!==JSON.stringify(scene.dialogue[start+i])))return out("not-framed",window);
    const flags=shot.dialogue.map((_,i)=>scene.offCameraDialogue?.[start+i]===true);
    if(flags[line.source.dialogueIndex]||!lineSources([block]).length)return out("off-camera",window);
    // Framed for its speaker: the shot's prompt carries the speaking sentence, and the sentence names this speaker (the first three are named).
    const named=onCameraSpeakers(shot.dialogue,flags).slice(0,SPEAKING_NAMES_SHOWN).map(n=>n.toLocaleUpperCase("en-US")),sentence=speakingDirection(shot.dialogue,flags);
    if(!sentence||!shot.prompt.includes(sentence)||!named.includes(block.character.trim().toLocaleUpperCase("en-US")))return out("not-framed",window);
    if(retained.history.some(p=>p.shotId===line.shotId&&p.lineIndex===line.source.index))return out("already-synced",window);
    if(retained.history.length>=32)return out("pass-limit",window);
    if(policy&&window.frames>policy.maxFrames)return out("too-long",window);
    if(policy&&stopped.has(studioKeyFor(retained.jobId,line.shotId,line.source.index,policy.revision)))return out("failed-pass",window);
    const inWindow=(p:{shotId:string;characterId:string;absoluteFrame:number})=>p.shotId===line.shotId&&p.characterId===characterId&&p.absoluteFrame>=window.startFrame&&p.absoluteFrame<window.startFrame+window.frames;
    const point=points.find(inWindow);
    if(point)return {...base,window,reason:"ready",included:true,facePointJobId:point.jobId,heldUsd:policy?policy.heldUsd:null,
      selection:{frame:point.absoluteFrame-window.startFrame,width:point.width,height:point.height,x:point.x,y:point.y,rgbSha256:point.rgbSha256}};
    if(!finder||!characterId)return out("no-face-point",window);
    // HV-022-25: no owner point, so the finder's suggestion, if one face was found on this picture; the owner's point always wins.
    const suggestion=detected.find(inWindow);
    if(suggestion)return {...base,window,reason:"ready",included:true,facePointJobId:null,heldUsd:policy!.heldUsd,
      selection:{frame:suggestion.absoluteFrame-window.startFrame,width:suggestion.width,height:suggestion.height,x:suggestion.x,y:suggestion.y,rgbSha256:suggestion.rgbSha256},
      detectedPoint:{detectionId:suggestion.detectionId,...suggestion.provenance}};
    // A line detected before on this picture, under any policy, is never detected again: its result stands, or the owner chooses.
    const earlier=records.find(r=>r.shotId===line.shotId&&r.lineIndex===line.source.index);
    if(earlier)return {...out("no-face-point",window),faceDetection:{status:earlier.status,detectionId:earlier.id,outcome:earlier.outcome,faces:earlier.faces,detail:earlier.outcome==="one-face"?"The studio's suggested face point was not accepted; choose the speaker under Direct lip-sync.":faceDetectionRecordDetail(earlier)}};
    return {...out("no-face-point",window),faceDetection:{status:"planned",frame:lipSyncDetectionFrame(window),heldUsd:finder.policy.heldUsd}};
  });
  const passes=items.filter(i=>i.included).length;
  const data={schema:"hv-lipsync-worklist/1" as const,sourceJobId:retained.jobId,sourceRevision:retained.revision,picture,placement,policyRevision:policy?.revision??null,capabilityRevision:LIPSYNC_CAPABILITY.revision,
    heldUsdPerPass:policy?.heldUsd??null,items,passes,needFacePoint:items.filter(i=>i.reason==="no-face-point").length,heldUsd:policy?micro(policy.heldUsd)*passes/1e6:null,
    ...(finder?{faceDetection:lipSyncListDetection(finder.policy,items.filter(i=>i.faceDetection?.status==="planned").length)}:{})};
  return {...data,revision:contentHash(data)};
}

/** What the studio's queueing asks for a ready line, hashed as the job's request (so a retry is the same request). */
export function studioLipSyncRequestHash(list:LipSyncWorkList,item:LipSyncWorkItem):string{
  if(!item.included||!item.selection||!list.policyRevision)lipFail("Only a ready line with a current policy can be queued.");
  return contentHash({sourceJobId:list.sourceJobId,request:{schema:"hv-studio-lipsync-request/1",sourceRevision:list.sourceRevision,shotId:item.shotId,lineIndex:item.lineIndex,
    selection:item.selection,facePointJobId:item.facePointJobId,...(item.detectedPoint?{facePointDetectionId:item.detectedPoint.detectionId}:{}),policyRevision:list.policyRevision,capabilityRevision:list.capabilityRevision}});
}
/** The request key for a ready line: fixed by the cut, the line and the policy, so the studio never pays twice for one. */
export function studioLipSyncKey(list:LipSyncWorkList,item:LipSyncWorkItem):string{return studioKeyFor(list.sourceJobId,item.shotId,item.lineIndex,list.policyRevision);}
function studioKeyFor(sourceJobId:string,shotId:string,lineIndex:number,policyRevision:string|null):string{
  return STUDIO_KEY_PREFIX+contentHash({sourceJobId,shotId,lineIndex,policyRevision}).slice(0,48);
}
/** The plan of one ready line: the existing owner plan, made from the owner's saved face point. */
export function studioLipSyncPlan(source:LipSyncSource,list:LipSyncWorkList,item:LipSyncWorkItem,policy:LipSyncPolicy,storage:LipSyncPlan["storage"],now=Date.now()):LipSyncPlan{
  if(policy.revision!==list.policyRevision||source.revision!==list.sourceRevision)lipFail("Review the current lip-sync work list before queueing.");
  return createLipSyncPlan(source,item.shotId,item.lineIndex,item.selection!,policy,storage,studioLipSyncRequestHash(list,item),now);
}
/** The hold of that many passes (included lines, or passes newly admitted), in integer micro-dollars summed. */
export function studioLipSyncHoldUsd(items:readonly unknown[],policy:LipSyncPolicy):number{return micro(policy.heldUsd)*items.length/1e6;}

/** HV-022-25: the frame the finder looks at for a line: the middle of its window, in window-relative numbering. */
export function lipSyncDetectionFrame(window:LipSyncWindow):number{return Math.floor((window.frames-1)/2);}
function lipSyncListDetection(policy:FaceDetectionPolicy,planned:number):LipSyncListDetection{
  return {policyRevision:policy.revision,capabilityRevision:FACE_DETECTION_CAPABILITY.revision,heldUsdPerDetection:policy.heldUsd,planned,heldUsd:micro(policy.heldUsd)*planned/1e6};
}
/** The lines a detection is planned for on approval (no owner point, no suggestion, never detected on this picture). */
export function lipSyncPlannedDetections(list:LipSyncWorkList):LipSyncWorkItem[]{return list.items.filter(i=>i.faceDetection?.status==="planned");}
/**
 * HV-022-25: the most the creator's approval can hold: each new pass, and for each planned detection its own hold and
 * the pass it would make possible. A detection is spent whether or not it finds a face; its line's pass is held
 * only when exactly one face is found. Integer micro-dollars, summed.
 */
export function studioLipSyncApprovalUsd(passes:readonly unknown[],detections:readonly unknown[],policy:LipSyncPolicy,finder?:FaceDetectionPolicy):number{
  if(detections.length&&!finder)lipFail("A face detection needs the operator's face detection policy.");
  return (micro(policy.heldUsd)*(passes.length+detections.length)+(finder?micro(finder.heldUsd)*detections.length:0))/1e6;
}
