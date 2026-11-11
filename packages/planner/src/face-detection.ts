import {readFileSync,statSync} from "node:fs";
import type {Job} from "../../queue/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {FACE_DETECTION_CAPABILITY,FACE_DETECTION_MODEL,FACE_DETECTION_REQUEST} from "../../generator/src/face-detection-capability";
import {faceDetectionDetail,type FaceDetectionOutcome,type FaceDetectionResult} from "../../generator/src/fal-face-detection";
import {lipDate,lipFail,lipHash,lipId,lipNumber,lipRecord,lipSame} from "./lipsync-policy";
import {validateLipSyncPlan} from "./lipsync";

/**
 * HV-022-25: the operator's policy for the studio's face-point finder, and the record of each detection.
 *
 * The finder exists only while this policy is configured (`HV_FACE_DETECTION_POLICY_FILE`), the studio's lip-sync
 * switch is on, and a detector is injected (none is built in any deployment yet). Each detection holds the policy's
 * flat `heldUsd`, approved by the creator with the lip-sync hold, and spends it whether or not a face is found.
 */
export interface FaceDetectionPolicyInput {label:string;accountRevision:string;priceEvidenceSha256:string;heldUsd:number;validFrom:string;expiresAt:string}
export interface FaceDetectionPolicy extends FaceDetectionPolicyInput {schema:"hv-face-detection-policy/1";provider:"fal";model:string;capabilityRevision:string;revision:string}
export function faceDetectionPolicy(input:FaceDetectionPolicyInput):FaceDetectionPolicy{
  lipRecord(input,["label","accountRevision","priceEvidenceSha256","heldUsd","validFrom","expiresAt"]);
  if(typeof input.label!=="string"||!input.label.trim()||input.label.length>100||[...input.label].some(c=>c.charCodeAt(0)<32))lipFail("Name the configured face detection provider.");
  const data={schema:"hv-face-detection-policy/1" as const,provider:"fal" as const,model:FACE_DETECTION_MODEL,capabilityRevision:FACE_DETECTION_CAPABILITY.revision,label:input.label.trim(),
    accountRevision:lipHash(input.accountRevision),priceEvidenceSha256:lipHash(input.priceEvidenceSha256),heldUsd:lipNumber(input.heldUsd,.000001,1000,"Face detection hold"),validFrom:lipDate(input.validFrom),expiresAt:lipDate(input.expiresAt)};
  if(data.heldUsd!==Number(data.heldUsd.toFixed(6))||Date.parse(data.validFrom)>=Date.parse(data.expiresAt))lipFail("Invalid face detection price or validity window.");
  return {...data,revision:contentHash(data)};
}
export function validateFaceDetectionPolicy(policy:FaceDetectionPolicy,now?:number):FaceDetectionPolicy{
  lipRecord(policy,["schema","provider","model","capabilityRevision","label","accountRevision","priceEvidenceSha256","heldUsd","validFrom","expiresAt","revision"]);
  const {schema:_schema,provider:_provider,model:_model,capabilityRevision:_cap,revision:_revision,...input}=policy,result=faceDetectionPolicy(input);
  if(!lipSame(result,policy))lipFail("The face detection policy evidence changed.");
  if(now!==undefined&&(!Number.isFinite(now)||now<Date.parse(result.validFrom)||now>=Date.parse(result.expiresAt)))lipFail("The face detection policy is not currently valid.");return result;
}
/** The flat hold of that many detections, in integer micro-dollars summed. */
export function faceDetectionHoldUsd(items:readonly unknown[],policy:Pick<FaceDetectionPolicy,"heldUsd">):number{return Math.round(policy.heldUsd*1e6)*items.length/1e6;}
export const FACE_DETECTION_POLICY_ENV="HV_FACE_DETECTION_POLICY_FILE";
export function configuredFaceDetectionPolicy(env:Record<string,string|undefined>=process.env):FaceDetectionPolicy|undefined{
  const path=env[FACE_DETECTION_POLICY_ENV];if(!path)return;
  if(statSync(path).size>65536)lipFail("The face detection policy exceeds its limit.");return validateFaceDetectionPolicy(JSON.parse(readFileSync(path,"utf8")));
}

/** One detection on one decoded frame of one line. `status` is `held` until its result is recorded, then `settled`. */
export interface FaceDetectionRecord {schema:"hv-face-detection/1";id:string;projectId:string;sourceJobId:string;picture:string;shotId:string;lineIndex:number;characterId:string;
  frame:number;absoluteFrame:number;width:number;height:number;rgbSha256:string;policyRevision:string;capabilityRevision:string;requestHash:string;heldUsd:number;admittedAt:string;
  status:"held"|"settled";outcome:FaceDetectionOutcome|null;faces:number|null;point:{x:number;y:number}|null;responseSha256:string|null;completedAt:string|null;revision:string}
const OUTCOMES:FaceDetectionOutcome[]=["one-face","no-face","several-faces","out-of-bounds","unparseable","failed"];
export const FACE_DETECTION_KEY_PREFIX="studio-facedetect-";

/** The detection key: fixed by the cut, the shot, the line, the decoded frame and the policy, so one detection is never paid twice. */
export function faceDetectionKey(input:{sourceJobId:string;shotId:string;lineIndex:number;rgbSha256:string;policyRevision:string}):string{
  return FACE_DETECTION_KEY_PREFIX+contentHash({sourceJobId:input.sourceJobId,shotId:input.shotId,lineIndex:input.lineIndex,frameSha256:input.rgbSha256,policyRevision:input.policyRevision}).slice(0,48);
}
/** What is asked of the provider for one frame, hashed: the pinned capability, its request fields and the frame. */
export function faceDetectionRequestHash(frame:{width:number;height:number;rgbSha256:string},policyRevision:string):string{
  return contentHash({schema:"hv-face-detection-request/1",capabilityRevision:FACE_DETECTION_CAPABILITY.revision,request:FACE_DETECTION_REQUEST,frame:{width:frame.width,height:frame.height,rgbSha256:frame.rgbSha256},policyRevision});
}
/** A record sealed by its own revision, so a stored result cannot be edited into another point. */
export function sealFaceDetection(data:Omit<FaceDetectionRecord,"revision">):FaceDetectionRecord{
  const {revision:_ignored,...rest}=data as FaceDetectionRecord;return validateFaceDetectionRecord({...rest,revision:contentHash(rest)});
}
export function validateFaceDetectionRecord(value:FaceDetectionRecord):FaceDetectionRecord{
  lipRecord(value,["schema","id","projectId","sourceJobId","picture","shotId","lineIndex","characterId","frame","absoluteFrame","width","height","rgbSha256","policyRevision","capabilityRevision","requestHash","heldUsd","admittedAt","status","outcome","faces","point","responseSha256","completedAt","revision"]);
  if(value.schema!=="hv-face-detection/1"||typeof value.id!=="string"||!new RegExp("^"+FACE_DETECTION_KEY_PREFIX+"[a-f0-9]{48}$").test(value.id))lipFail("Invalid face detection record.");
  [value.projectId,value.sourceJobId,value.shotId,value.characterId].forEach(lipId);
  if(typeof value.picture!=="string"||!/^(?:video-stream|lipsync-export):[a-f0-9]{64}$/.test(value.picture))lipFail("Invalid face detection picture.");
  lipNumber(value.lineIndex,0,127,"Line index",true);lipNumber(value.frame,0,899,"Detection frame",true);lipNumber(value.absoluteFrame,value.frame,1e7,"Detection frame",true);
  lipNumber(value.width,64,4096,"Frame width",true);lipNumber(value.height,64,4096,"Frame height",true);[value.rgbSha256,value.policyRevision,value.capabilityRevision,value.requestHash].forEach(lipHash);
  lipNumber(value.heldUsd,.000001,1000,"Face detection hold");if(value.heldUsd!==Number(value.heldUsd.toFixed(6)))lipFail("Invalid face detection hold.");lipDate(value.admittedAt);
  if(value.id!==faceDetectionKey({...value})||value.requestHash!==faceDetectionRequestHash(value,value.policyRevision))lipFail("The face detection record changed.");
  if(value.status==="held"){if(value.outcome!==null||value.faces!==null||value.point!==null||value.responseSha256!==null||value.completedAt!==null)lipFail("An unfinished face detection has a result.");}
  else if(value.status==="settled"){
    if(!OUTCOMES.includes(value.outcome!))lipFail("Invalid face detection outcome.");lipDate(value.completedAt);
    if(value.faces!==null)lipNumber(value.faces,0,64,"Faces found",true);if(value.responseSha256!==null)lipHash(value.responseSha256);
    if(value.outcome==="one-face"){lipRecord(value.point,["x","y"]);lipNumber(value.point.x,0,value.width-1,"Face position X",true);lipNumber(value.point.y,0,value.height-1,"Face position Y",true);if(value.faces!==1)lipFail("Invalid face detection outcome.");}
    else if(value.point!==null)lipFail("Only one face found gives a point.");
  }else lipFail("Invalid face detection status.");
  const {revision,...data}=value;if(lipHash(revision)!==contentHash(data))lipFail("The face detection record changed.");
  return structuredClone(value);
}
/** The settled record of a held detection: only a point the strict reading found, with exactly one face. */
export function settleFaceDetection(record:FaceDetectionRecord,result:FaceDetectionResult,now=Date.now()):FaceDetectionRecord{
  const held=validateFaceDetectionRecord(record);if(held.status!=="held")lipFail("This face detection already has its result.");
  const point=result.outcome==="one-face"&&result.point?{x:result.point.x,y:result.point.y}:null;
  return sealFaceDetection({...held,status:"settled",outcome:point?"one-face":result.outcome==="one-face"?"unparseable":result.outcome,faces:point?1:result.faces,point,responseSha256:result.responseSha256,completedAt:new Date(now).toISOString()});
}
export function faceDetectionRecordDetail(record:Pick<FaceDetectionRecord,"status"|"outcome"|"faces">):string{return faceDetectionDetail(record.status==="settled"?record.outcome:null,record.faces);}

/** A face point the studio's finder suggested: the owner's point fields, with the detection named instead of a pass. */
export interface DetectedFacePoint {detectionId:string;picture:string;shotId:string;characterId:string;absoluteFrame:number;width:number;height:number;x:number;y:number;rgbSha256:string;admittedAt:string;
  provenance:{source:"detected";provider:"fal";model:string;frameSha256:string;requestHash:string;policyRevision:string;capabilityRevision:string}}

/**
 * The points the finder suggested, under the owner-point rules of HV-022-23/24: a point whose studio pass failed or
 * was cancelled, or whose latest review is not an accept or rates anything under 3, is not offered again. A pass that
 * used it is found by its plan: the same picture, shot, speaker, frame and point.
 */
export function detectedLipSyncFacePoints(records:FaceDetectionRecord[],jobs:Job[]):DetectedFacePoint[]{
  const spoiled=jobs.flatMap(job=>{
    if(!job.lipSync)return [];const review=job.lipSyncReviews?.entries.at(-1);
    const bad=job.status==="failed"||job.status==="cancelled"||Boolean(review&&(review.decision!=="accept"||Math.min(review.mouthSync,review.faceStability,review.expression)<3));
    if(!bad)return [];try{const plan=validateLipSyncPlan(job.lipSync);return [plan];}catch{return [];}
  });
  return records.flatMap(raw=>{
    let r:FaceDetectionRecord;try{r=validateFaceDetectionRecord(raw);}catch{return [];}
    if(r.status!=="settled"||r.outcome!=="one-face"||!r.point)return [];
    const point=r.point;
    if(spoiled.some(p=>p.shotId===r.shotId&&p.characterId===r.characterId&&p.window.startFrame+p.selection.frame===r.absoluteFrame&&p.selection.x===point.x&&p.selection.y===point.y&&p.selection.rgbSha256===r.rgbSha256))return [];
    return [{detectionId:r.id,picture:r.picture,shotId:r.shotId,characterId:r.characterId,absoluteFrame:r.absoluteFrame,width:r.width,height:r.height,x:point.x,y:point.y,rgbSha256:r.rgbSha256,admittedAt:r.admittedAt,
      provenance:{source:"detected",provider:"fal",model:FACE_DETECTION_MODEL,frameSha256:r.rgbSha256,requestHash:r.requestHash,policyRevision:r.policyRevision,capabilityRevision:r.capabilityRevision}}];
  });
}
