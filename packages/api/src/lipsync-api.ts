import {mkdirSync,mkdtempSync,realpathSync,rmSync} from "node:fs";
import {filmCapFor} from "../../operator/src/film-budget";
import {join,sep} from "node:path";
import type {Project} from "./index";
import {CapacityController,DurableJobStore,type Job,type Tier} from "../../queue/src/index";
import {PostgresJobStore} from "../../storage/src/jobs";
import {PostgresLipSyncLedger} from "../../storage/src/lipsync-ledger";
import type {PostgresArtifactStore} from "../../storage/src/artifacts";
import type {CostLedger} from "../../operator/src/index";
import type {PostgresCostLedger} from "../../storage/src/ledger";
import {contentHash} from "../../generator/src/capabilities";
import {LIPSYNC_CAPABILITY} from "../../generator/src/lipsync-capability";
import {copyDialogueFiles} from "../../generator/src/dialogue-replacement";
import {previewLipSyncFrame} from "../../generator/src/lipsync-media";
import {configuredLipSyncPolicy,validateLipSyncPolicy,lipFail,lipRecord,lipId,lipNumber,lipSame,LipSyncError} from "../../planner/src/lipsync-policy";
import {assertLipSyncPlayback,assertLipSyncPermission,createLipSyncPlan,retainLipSyncSource,lipSyncWindow,lipSyncCutaways,type LipSyncSelection,type LipSyncReview} from "../../planner/src/lipsync";
import {assertSelectedOutput,outputRevision} from "../../planner/src/dialogue-selection";
import {verifyOperatorGrant} from "./tokens";
import {lipSyncPlannedDetections,lipSyncWorkList,savedLipSyncFacePoints,studioLipSyncApprovalUsd,studioLipSyncEnabled,studioLipSyncHoldUsd,studioLipSyncKey,studioLipSyncPlan,STUDIO_KEY_PREFIX,type LipSyncWorkItem,type LipSyncWorkList} from "../../planner/src/lipsync-worklist";
import {configuredFaceDetectionPolicy,detectedLipSyncFacePoints,faceDetectionHoldUsd,validateFaceDetectionPolicy,faceDetectionKey,faceDetectionRecordDetail,faceDetectionRequestHash,sealFaceDetection,type FaceDetectionPolicy,type FaceDetectionRecord} from "../../planner/src/face-detection";
import {FACE_DETECTION_CAPABILITY} from "../../generator/src/face-detection-capability";
import type {FaceDetectionResult,FaceDetector} from "../../generator/src/fal-face-detection";
import {BudgetError} from "../../operator/src/index";
import {assertFilmBudget} from "../../operator/src/film-budget";
import type {LipSyncPolicy} from "../../planner/src/lipsync-policy";
import {projectJobs} from "./project-jobs";

interface Context {root:string;artifacts?:PostgresArtifactStore;ledger:CostLedger|PostgresCostLedger;lipLedger?:PostgresLipSyncLedger;monthlyBudgetUsd:number;filmCapUsd:number;featureCapUsd:number;
  /** HV-022-25: the face-point finder. Only ever injected (the tests' closed mock); nothing builds a live one yet. */
  faceDetector?:FaceDetector;
  store:(id:string)=>DurableJobStore|PostgresJobStore;view:(job:Job,project:Project)=>Promise<Record<string,unknown>>}
const record=(value:unknown,keys:string[])=>{lipRecord(value,keys);return value;};
/** Owner authorization happens at the route boundary and is repeated after media I/O. */
/**
 * HV-022-23: how the studio's work list answers a pass refused part-way through. Every pass admitted before it
 * is committed and held, so once one is, every refusal -- the budget, a pass the ledger would not take, or an
 * unexpected failure such as a lost database connection -- answers with what is already queued. An unexpected
 * failure keeps its 500 (it is still an error to the operator) and keeps its own text out of the answer.
 * A refusal before anything was admitted is answered as before: the budget's 429, otherwise the error itself.
 */
/**
 * HV-022-24: the creator's approval of the lip-sync hold names its amount in dollars, and it must be the hold the
 * list would take now, to the micro-dollar. A missing, malformed or different amount is refused (409) before
 * anything is held. `generationApproved` alone no longer queues anything.
 */
/** Dollars as the hold is compared: cents when whole cents, otherwise to the micro-dollar, so a refusal never reads as equal amounts. */
const exactUsd=(value:number):string=>{const cents=value.toFixed(2);return Math.round(Number(cents)*1e6)===Math.round(value*1e6)?cents:value.toFixed(6).replace(/0+$/,"");};
export function assertStudioLipSyncHoldApproved(approved:unknown,heldUsd:number):void{
  if(typeof approved!=="number"||!Number.isFinite(approved)||approved<0)lipFail("Approve the lip-sync hold, in dollars, before queueing. Nothing is queued or held.");
  if(Math.round(approved*1e6)!==Math.round(heldUsd*1e6))lipFail(`The lip-sync hold is now $${exactUsd(heldUsd)}, not the $${exactUsd(approved)} approved. Review the current hold before queueing. Nothing is queued or held.`);
}
export function studioLipSyncStop(error:unknown,progress:boolean):{status:number;error:string;reason?:string}|undefined{
  if(error instanceof BudgetError){const changed=/policy changed/.test(error.message);return {status:changed?409:429,error:error.message,reason:changed?"policy_changed":"budget_exhausted"};}
  if(!progress)return undefined;
  if(error instanceof LipSyncError)return {status:207,error:error.message};
  return {status:500,error:"A later pass could not be queued just now. The passes listed here are queued and held."};
}
export class LipSyncApi {
  private inspections=0;
  constructor(private context:Context){}
  async handle(parts:string[],request:Request,project:Project,refresh:()=>Promise<Project|null>,body?:Record<string,unknown>):Promise<{status:number;body:unknown}>{
    const {store,lipLedger,monthlyBudgetUsd,ledger}=this.context,filmCapUsd=filmCapFor(project,this.context),queue=store(project.id),now=Date.now(),policy=configuredLipSyncPolicy();
    let currentPolicy;try{if(policy)currentPolicy=validateLipSyncPolicy(policy,now);}catch{/* An expired policy leaves retained jobs reviewable only when permitted. */}
    if(parts.length===0&&request.method==="GET"){
      const all=await projectJobs(this.context.store,project.id),sources=all.filter(j=>j.status==="done"&&(j.dialogueReplacement||j.lipSync)).map(job=>{
        let unavailable:string|null=null,lines=0;try{assertSelectedOutput(job,project,{jobId:job.id,outputRevision:outputRevision(job)});lines=retainLipSyncSource(job).dialogue.lines.filter(l=>l.audition).length;if(!lines)lipFail("Apply a retained audition to a dialogue line first.");}catch(error){unavailable=(error as Error).message;}
        return {id:job.id,stage:job.stage,completedAt:job.completedAt,lines,unavailable};
      });
      return {status:200,body:{enabled:Boolean(lipLedger&&currentPolicy),policy:currentPolicy?{label:currentPolicy.label,revision:currentPolicy.revision,heldUsd:currentPolicy.heldUsd,maxFrames:currentPolicy.maxFrames,expiresAt:currentPolicy.expiresAt}:null,capabilityRevision:LIPSYNC_CAPABILITY.revision,sources,jobs:await Promise.all(all.filter(j=>j.lipSync).map(j=>this.context.view(j,project))),quality:"owner-rubric/1"}};
    }
    if(!parts[0]||parts.length>2)return {status:404,body:{error:"unknown lip-sync route"}};
    const selected=await queue.get(lipId(parts[0]));if(!selected||selected.projectId!==project.id)return {status:404,body:{error:"unknown retained version"}};
    if(parts[1]==="review"&&request.method==="PUT"){
      const input=record(body,["mouthSync","faceStability","expression","decision","notes","expectedVersion","expectedOutputRevision"]);
      assertLipSyncPlayback(selected,project);const {expectedVersion,expectedOutputRevision,...ratings}=input;
      const version=lipNumber(expectedVersion,0,99,"Review version",true);if(typeof expectedOutputRevision!=="string")lipFail("Choose the output being reviewed.");
      const latest=await refresh();if(!latest)lipFail("The owner session expired. Reopen this project.");assertLipSyncPlayback(selected,latest);
      await queue.reviewLipSync(selected.id,ratings as unknown as Pick<LipSyncReview,"mouthSync"|"faceStability"|"expression"|"decision"|"notes">,version,expectedOutputRevision);
      return {status:200,body:{job:await this.context.view((await queue.get(selected.id))!,latest)}};
    }
    // HV-022-23: the studio's lip-sync work list, only while the operator switches it on. Off, the route is unknown, as before.
    if(parts[1]==="work-list"&&studioLipSyncEnabled()&&["GET","POST"].includes(request.method))return this.workList(selected,request,project,refresh,body,currentPolicy);
    const preview=parts[1]==="preview"&&request.method==="POST",submit=parts.length===1&&request.method==="POST";
    if(!preview&&!submit&&!(parts.length===1&&request.method==="GET"))return {status:404,body:{error:"unknown lip-sync route"}};
    let requestHash:string|undefined,key:string|undefined;
    if(submit){const input=record(body,["idempotencyKey","generationApproved","sourceRevision","policyRevision","capabilityRevision","shotId","lineIndex","selection","operatorGrant"]);
      if(typeof input.idempotencyKey!=="string"||input.idempotencyKey.length<1||input.idempotencyKey.length>128||[...input.idempotencyKey].some(c=>c.charCodeAt(0)<33||c.charCodeAt(0)>126))lipFail("Use a new printable request key of 1–128 characters.");
      // HV-022-23: the studio's passes own this prefix, so an owner key can never stand for, or collide with, one of them.
      if(input.idempotencyKey.startsWith(STUDIO_KEY_PREFIX))lipFail("This request key prefix is reserved for the studio's lip-sync passes. Use a new request key.");
      key=project.id+":"+input.idempotencyKey;requestHash=contentHash({sourceJobId:selected.id,request:Object.fromEntries(Object.entries(input).filter(([k])=>k!=="idempotencyKey"))});
      const existing=(await projectJobs(this.context.store,project.id)).find(j=>j.idempotencyKey===key);if(existing){if(existing.stage!=="lip-sync"||existing.lipSync?.requestHash!==requestHash)lipFail("This request key belongs to another pass. Review a new request.");return {status:202,body:{jobId:existing.id,status:existing.status,stage:existing.stage}};}
      if(!lipLedger||!currentPolicy)return {status:503,body:{error:"Lip-sync generation needs the operator's PostgreSQL provider service and current policy."}};
      if(input.generationApproved!==true||input.policyRevision!==currentPolicy.revision||input.capabilityRevision!==LIPSYNC_CAPABILITY.revision)lipFail("Review the current provider and reserved cost before submitting.");
    }
    assertSelectedOutput(selected,project,{jobId:selected.id,outputRevision:outputRevision(selected)});const source=retainLipSyncSource(selected);
    if(!preview&&!submit)return {status:200,body:{sourceJobId:source.jobId,originalJobId:source.film.id,sourceRevision:source.revision,durationSec:source.dialogue.totalFrames/30,history:source.history,lines:source.dialogue.lines.filter(l=>l.audition).map(l=>({shotId:l.shotId,lineIndex:l.source.index,character:l.source.character,text:l.text,voiceLabel:l.audition!.source.take.policy.label,window:lipSyncWindow(source,l.shotId,l.source.index),cutaways:lipSyncCutaways(source,l.shotId)}))}};
    if(preview)lipRecord(body,["sourceRevision","shotId","lineIndex","frame"]);
    if(body!.sourceRevision!==source.revision)lipFail("The retained cut changed. Reload its lines.");
    const shotId=lipId(body!.shotId),lineIndex=lipNumber(body!.lineIndex,0,127,"Line index",true),selection=submit?record(body!.selection,["frame","width","height","x","y","rgbSha256"]):undefined,frame=lipNumber(selection?.frame??body!.frame,0,899,"Frame",true);
    if(this.inspections>=2)return {status:429,body:{error:"Two speaker frames are being checked. Try again shortly."}};
    this.inspections++;let scratch:string|undefined;
    try{
      const signal=AbortSignal.any([request.signal,AbortSignal.timeout(120000)]),root=this.context.root;let mediaRoot=root;
      if(this.context.artifacts){mkdirSync(root,{recursive:true});scratch=mkdtempSync(join(realpathSync(root),".lipsync-preview-"));mediaRoot=scratch;await copyDialogueFiles({id:source.jobId,projectId:project.id},[source.files.video],root,scratch,signal,this.context.artifacts);}
      const image=await previewLipSyncFrame(source,mediaRoot,shotId,lineIndex,frame,signal),latest=await refresh(),fresh=await queue.get(source.jobId);
      if(!latest||!fresh)lipFail("The retained source is unavailable. Reopen this project.");assertSelectedOutput(fresh,latest,{jobId:fresh.id,outputRevision:source.outputRevision});if(retainLipSyncSource(fresh).revision!==source.revision)lipFail("The source changed while its frame was being checked.");
      if(preview)return {status:200,body:{frame:image.frame,width:image.width,height:image.height,rgbSha256:image.rgbSha256,image:"data:image/png;base64,"+image.png.toString("base64")}};
      if(!lipSame({frame:image.frame,width:image.width,height:image.height,rgbSha256:image.rgbSha256},{frame:selection!.frame,width:selection!.width,height:selection!.height,rgbSha256:selection!.rgbSha256}))lipFail("The selected speaker frame changed. Review the face again.");
      const plan=createLipSyncPlan(source,shotId,lineIndex,selection as unknown as LipSyncSelection,currentPolicy!,this.context.artifacts?"s3":"local",requestHash!),grant=typeof body!.operatorGrant==="string"?verifyOperatorGrant(body!.operatorGrant,project.id):null,tier:Tier=grant?"elevated":"free";
      assertLipSyncPermission(plan,latest);const decision=new CapacityController(monthlyBudgetUsd).decide({tier,runningForProject:(await projectJobs(this.context.store,project.id)).filter(j=>j.status==="running").length,requestedShots:1,sceneCount:1,monthSpendUsd:await ledger.monthSpend()+await ledger.reservedUsd()});
      if(decision.action==="reject")return {status:429,body:{error:decision.message,reason:decision.reason}};
      const job=await lipLedger!.admitLipSync(project.id,{id:crypto.randomUUID(),idempotencyKey:key!,projectId:project.id,tier,stage:"lip-sync",scriptText:source.film.scriptText,scriptVersion:source.film.scriptVersion,rightsAttestedAt:latest.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:source.dialogue.totalFrames,costCapUsd:currentPolicy!.heldUsd,budgetReservedUsd:currentPolicy!.heldUsd,retryPolicy:{maxRetries:2,backoffMs:1500},timeoutMs:30*60*1000,queueAction:decision.action,queueReason:decision.reason,lipSync:plan},configuredLipSyncPolicy,monthlyBudgetUsd,Date.now(),filmCapUsd);
      return {status:202,body:{jobId:job.id,status:job.status,stage:job.stage,heldUsd:currentPolicy!.heldUsd,actualUsd:null}};
    }finally{this.inspections--;if(scratch&&realpathSync(scratch).startsWith(realpathSync(this.context.root)+sep+".lipsync-preview-"))rmSync(scratch,{recursive:true,force:true});}
  }

  /**
   * HV-022-23: GET lists the voiced cut's lip-sync work (planner/src/lipsync-worklist.ts); POST queues its ready
   * lines as the owner's own passes would be queued, one isolated lip-sync job each, from the same cut.
   *
   * The new passes' holds are summed and checked against the film's limit and the month's cap before the first
   * is admitted; each is then checked again, and reserved, by the ledger's own admission under its lock. That
   * second check is what enforces the caps: the first can pass and a concurrent admission still leave room for
   * only some, so a list may be partly admitted, and the answer then says which (207, or 429 when the budget
   * refused the rest). A ready line's saved face point is checked against this cut's decoded frame first; one
   * that no longer matches is skipped, never guessed. Without a current policy or the PostgreSQL provider
   * service nothing is queued or held.
   *
   * Only a pass created by this request is `admitted` and counted in `heldUsd`. A pass the ledger already held
   * under the line's fixed key (a retry, or a concurrent request) is `reused`, and holds nothing new.
   */
  private async workList(selected:Job,request:Request,project:Project,refresh:()=>Promise<Project|null>,body:Record<string,unknown>|undefined,policy:LipSyncPolicy|undefined):Promise<{status:number;body:unknown}>{
    const {store,lipLedger,monthlyBudgetUsd,ledger,faceDetector}=this.context,filmCapUsd=filmCapFor(project,this.context),queue=store(project.id);
    if(request.method==="POST")record(body,["generationApproved","worklistRevision","holdApprovedUsd","operatorGrant"]);
    assertSelectedOutput(selected,project,{jobId:selected.id,outputRevision:outputRevision(selected)});const source=retainLipSyncSource(selected);
    // HV-022-25: the face-point finder is on only with the lip-sync policy, the PostgreSQL provider service, an injected
    // detector and the operator's current detection policy. Off, nothing is read and the list is exactly as before.
    let finder:FaceDetectionPolicy|undefined;if(policy&&lipLedger&&faceDetector){try{const configured=configuredFaceDetectionPolicy();if(configured)finder=validateFaceDetectionPolicy(configured,Date.now());}catch{finder=undefined;}}
    let all=await projectJobs(this.context.store,project.id);
    const listOf=(records:FaceDetectionRecord[]):LipSyncWorkList=>lipSyncWorkList(source,{facePoints:savedLipSyncFacePoints(all),policy,studioPasses:all,
      ...(finder?{faceDetection:{policy:finder,records,points:detectedLipSyncFacePoints(records,all)}}:{})});
    let list=listOf(finder?await lipLedger!.faceDetections(project.id):[]);
    // A line that already holds a pass on this cut, the owner's or the studio's, is not queued again.
    const holding=(item:LipSyncWorkItem)=>all.find(j=>j.lipSync&&j.lipSync.source.jobId===source.jobId&&j.lipSync.shotId===item.shotId&&j.lipSync.lineIndex===item.lineIndex&&!["failed","cancelled"].includes(j.status))?.id??null;
    const queued=list.items.flatMap(item=>{const jobId=holding(item);return jobId?[{shotId:item.shotId,lineIndex:item.lineIndex,jobId}]:[];}),fresh=list.items.filter(item=>item.included&&!holding(item));
    const planned=finder?lipSyncPlannedDetections(list).filter(item=>!holding(item)):[];
    // A line whose studio pass failed or was cancelled is the owner's to retry under Direct lip-sync (`failed-pass`).
    const failed=list.items.filter(item=>item.reason==="failed-pass").flatMap(item=>{const job=all.find(j=>j.idempotencyKey===project.id+":"+studioLipSyncKey(list,item));return job?[{shotId:item.shotId,lineIndex:item.lineIndex,jobId:job.id,status:job.status}]:[];});
    const unavailable=!policy?"Lip-sync is switched on for the studio, but no current provider policy is configured. Nothing is queued or held."
      :!lipLedger?"Lip-sync generation needs the operator's PostgreSQL provider service. Nothing is queued or held.":null;
    // HV-022-25: with the finder on, the approval covers each planned detection's hold and the pass it may make possible.
    const detection=finder?{newDetections:planned.length,heldUsdPerDetection:finder.heldUsd,heldUsd:faceDetectionHoldUsd(planned,finder),
      passHeldUsd:studioLipSyncHoldUsd(planned,policy!),spentWithoutFace:true,lines:planned.map(i=>({shotId:i.shotId,lineIndex:i.lineIndex,character:i.character,text:i.text,frame:i.faceDetection?.status==="planned"?i.faceDetection.frame:null}))}:undefined;
    const answer={enabled:!unavailable,unavailable,workList:list,queued,failed,newPasses:fresh.length,newHeldUsd:policy?(finder?studioLipSyncApprovalUsd(fresh,planned,policy,finder):studioLipSyncHoldUsd(fresh,policy)):null,...(detection?{faceDetection:detection}:{})};
    if(request.method==="GET")return {status:200,body:answer};
    if(!policy)return {status:503,body:{error:unavailable}};
    if(body!.generationApproved!==true||body!.worklistRevision!==list.revision)lipFail("Review the current lip-sync work list before queueing.");
    // HV-022-24: the creator approves the lip-sync hold apart from the film's (the owner's decision of 2026-11-11). The
    // request names the amount they were shown, and only the hold this list would take now is accepted. HV-022-25: with
    // the finder on, that amount includes the planned detections and the passes they may make possible.
    assertStudioLipSyncHoldApproved(body!.holdApprovedUsd,answer.newHeldUsd!);
    if(unavailable)return {status:503,body:{error:unavailable}};
    const finished=(extra:Record<string,unknown>={})=>({...answer,admitted:[],reused:[],skipped:[],heldUsd:0,actualUsd:null,...(finder?{detections:[],detectionHeldUsd:0}:{}),...extra});
    if(!fresh.length&&!planned.length)return {status:200,body:finished()};
    // The new holds are checked together before any is admitted; the ledger enforces each again below.
    const total=answer.newHeldUsd!;
    assertFilmBudget({...await lipLedger!.filmSpend(project.id),capUsd:filmCapUsd},total);
    if(await ledger.monthSpend()+await ledger.reservedUsd()+total>monthlyBudgetUsd+1e-9)throw new BudgetError("The studio's monthly generation budget cannot hold these lip-sync passes.");
    if(this.inspections>=2)return {status:429,body:{error:"Two speaker frames are being checked. Try again shortly."}};
    this.inspections++;let scratch:string|undefined;
    try{
      const signal=AbortSignal.any([request.signal,AbortSignal.timeout(120000)]),root=this.context.root;let mediaRoot=root;
      if(this.context.artifacts){mkdirSync(root,{recursive:true});scratch=mkdtempSync(join(realpathSync(root),".lipsync-preview-"));mediaRoot=scratch;await copyDialogueFiles({id:source.jobId,projectId:project.id},[source.files.video],root,scratch,signal,this.context.artifacts);}
      const admitted:{shotId:string;lineIndex:number;jobId:string}[]=[],reused:{shotId:string;lineIndex:number;jobId:string}[]=[],skipped:{shotId:string;lineIndex:number;reason:string}[]=[];
      const detections:{shotId:string;lineIndex:number;detectionId:string;outcome:FaceDetectionRecord["outcome"];faces:number|null;detail:string;replay:boolean}[]=[];
      const detectionHeldUsd=()=>finder?faceDetectionHoldUsd(detections.filter(d=>!d.replay),finder):0;
      const soFar=()=>({...answer,admitted,reused,skipped,heldUsd:(Math.round(studioLipSyncHoldUsd(admitted,policy!)*1e6)+Math.round(detectionHeldUsd()*1e6))/1e6,actualUsd:null,
        ...(finder?{detections,detectionHeldUsd:detectionHeldUsd()}:{})});
      const progress=()=>admitted.length+reused.length+detections.length>0;
      // HV-022-25: each planned line's middle frame is decoded and verified, its detection admitted and held under the
      // ledger's lock (never twice: the key names the cut, shot, line, frame and policy), and only then asked of the
      // detector, once. A replayed detection is never asked again: its recorded result stands, or it has none.
      for(const item of planned){
        try{
          const frame=item.faceDetection!.status==="planned"?item.faceDetection!.frame:0,image=await previewLipSyncFrame(source,mediaRoot,item.shotId,item.lineIndex,frame,signal);
          const base={sourceJobId:source.jobId,shotId:item.shotId,lineIndex:item.lineIndex,rgbSha256:image.rgbSha256,policyRevision:finder!.revision};
          const held:Omit<FaceDetectionRecord,"revision">={schema:"hv-face-detection/1",id:faceDetectionKey(base),projectId:project.id,sourceJobId:source.jobId,picture:list.picture,shotId:item.shotId,lineIndex:item.lineIndex,characterId:item.characterId!,
            frame,absoluteFrame:item.window!.startFrame+frame,width:image.width,height:image.height,rgbSha256:image.rgbSha256,policyRevision:finder!.revision,capabilityRevision:FACE_DETECTION_CAPABILITY.revision,
            requestHash:faceDetectionRequestHash(image,finder!.revision),heldUsd:finder!.heldUsd,admittedAt:new Date().toISOString(),status:"held",outcome:null,faces:null,point:null,responseSha256:null,completedAt:null};
          const {record:entry,replay}=await lipLedger!.admitFaceDetection(project.id,sealFaceDetection(held),configuredFaceDetectionPolicy,monthlyBudgetUsd,Date.now(),filmCapUsd);
          let settled=entry;
          if(!replay){
            // The detector is asked once, with its own time limit, so its answer is recorded even if the creator's request goes away.
            let result:FaceDetectionResult;try{result=await faceDetector!.detect({png:image.png,width:image.width,height:image.height,rgbSha256:image.rgbSha256},AbortSignal.timeout(60000));}catch{result={outcome:"failed",faces:null,point:null,responseSha256:null};}
            settled=await lipLedger!.settleFaceDetection(project.id,entry.id,result);
          }
          detections.push({shotId:item.shotId,lineIndex:item.lineIndex,detectionId:settled.id,outcome:settled.outcome,faces:settled.faces,detail:faceDetectionRecordDetail(settled),replay});
        }catch(error){
          const stop=studioLipSyncStop(error,progress());if(!stop)throw error;
          return {status:stop.status,body:{...soFar(),error:stop.error,...(stop.reason?{reason:stop.reason}:{}),stoppedAt:{shotId:item.shotId,lineIndex:item.lineIndex}}};
        }
      }
      // The lines the creator approved: the ready ones, and the planned ones whose detection found exactly one face.
      const approved=new Set([...fresh,...planned].map(i=>i.shotId+"#"+i.lineIndex));
      if(planned.length){all=await projectJobs(this.context.store,project.id);list=listOf(await lipLedger!.faceDetections(project.id));}
      const toQueue=list.items.filter(item=>item.included&&!holding(item)&&approved.has(item.shotId+"#"+item.lineIndex));
      const verified:LipSyncWorkItem[]=[];
      for(const item of toQueue){
        const image=await previewLipSyncFrame(source,mediaRoot,item.shotId,item.lineIndex,item.selection!.frame,signal);
        if(lipSame({width:image.width,height:image.height,rgbSha256:image.rgbSha256},{width:item.selection!.width,height:item.selection!.height,rgbSha256:item.selection!.rgbSha256}))verified.push(item);
        else skipped.push({shotId:item.shotId,lineIndex:item.lineIndex,reason:"The saved face point's frame differs on this cut. Choose the face again under Direct lip-sync."});
      }
      const latest=await refresh(),current=await queue.get(source.jobId);
      if(!latest||!current)lipFail("The retained source is unavailable. Reopen this project.");assertSelectedOutput(current,latest,{jobId:current.id,outputRevision:source.outputRevision});if(retainLipSyncSource(current).revision!==source.revision)lipFail("The source changed while its frames were being checked.");
      const grant=typeof body!.operatorGrant==="string"?verifyOperatorGrant(body!.operatorGrant,project.id):null,tier:Tier=grant?"elevated":"free";
      for(const item of verified){
        try{
          const plan=studioLipSyncPlan(source,list,item,policy!,this.context.artifacts?"s3":"local");assertLipSyncPermission(plan,latest);
          const decision=new CapacityController(monthlyBudgetUsd).decide({tier,runningForProject:(await projectJobs(this.context.store,project.id)).filter(j=>j.status==="running").length,requestedShots:1,sceneCount:1,monthSpendUsd:await ledger.monthSpend()+await ledger.reservedUsd()});
          if(decision.action==="reject")return {status:429,body:{...soFar(),error:decision.message,reason:decision.reason}};
          const input={id:crypto.randomUUID(),idempotencyKey:project.id+":"+studioLipSyncKey(list,item),projectId:project.id,tier,stage:"lip-sync" as const,scriptText:source.film.scriptText,scriptVersion:source.film.scriptVersion,rightsAttestedAt:latest.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:source.dialogue.totalFrames,costCapUsd:policy!.heldUsd,budgetReservedUsd:policy!.heldUsd,retryPolicy:{maxRetries:2,backoffMs:1500},timeoutMs:30*60*1000,queueAction:decision.action,queueReason:decision.reason,lipSync:plan};
          const job=await lipLedger!.admitLipSync(project.id,input,configuredLipSyncPolicy,monthlyBudgetUsd,Date.now(),filmCapUsd);
          // The ledger returns the pass it already held under this key (a retry, or a concurrent request): no new hold.
          (job.id===input.id?admitted:reused).push({shotId:item.shotId,lineIndex:item.lineIndex,jobId:job.id});
        }catch(error){
          // A pass refused mid-list leaves the earlier ones admitted and held: say which, never "nothing queued".
          const stop=studioLipSyncStop(error,progress());if(!stop)throw error;
          return {status:stop.status,body:{...soFar(),error:stop.error,...(stop.reason?{reason:stop.reason}:{}),stoppedAt:{shotId:item.shotId,lineIndex:item.lineIndex}}};
        }
      }
      return {status:admitted.length||detections.some(d=>!d.replay)?202:200,body:soFar()};
    }finally{this.inspections--;if(scratch&&realpathSync(scratch).startsWith(realpathSync(this.context.root)+sep+".lipsync-preview-"))rmSync(scratch,{recursive:true,force:true});}
  }
}
