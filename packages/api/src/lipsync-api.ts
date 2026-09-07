import {mkdirSync,mkdtempSync,realpathSync,rmSync} from "node:fs";
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
import {configuredLipSyncPolicy,validateLipSyncPolicy,lipFail,lipRecord,lipId,lipNumber,lipSame} from "../../planner/src/lipsync-policy";
import {assertLipSyncPlayback,assertLipSyncPermission,createLipSyncPlan,retainLipSyncSource,lipSyncWindow,lipSyncCutaways,type LipSyncSelection,type LipSyncReview} from "../../planner/src/lipsync";
import {assertSelectedOutput,outputRevision} from "../../planner/src/dialogue-selection";
import {verifyOperatorGrant} from "./tokens";

interface Context {root:string;artifacts?:PostgresArtifactStore;ledger:CostLedger|PostgresCostLedger;lipLedger?:PostgresLipSyncLedger;monthlyBudgetUsd:number;
  store:(id:string)=>DurableJobStore|PostgresJobStore;view:(job:Job,project:Project)=>Promise<Record<string,unknown>>}
const record=(value:unknown,keys:string[])=>{lipRecord(value,keys);return value;};
/** Owner authorization happens at the route boundary and is repeated after media I/O. */
export class LipSyncApi {
  private inspections=0;
  constructor(private context:Context){}
  async handle(parts:string[],request:Request,project:Project,refresh:()=>Promise<Project|null>,body?:Record<string,unknown>):Promise<{status:number;body:unknown}>{
    const {store,lipLedger,monthlyBudgetUsd,ledger}=this.context,queue=store(project.id),now=Date.now(),policy=configuredLipSyncPolicy();
    let currentPolicy;try{if(policy)currentPolicy=validateLipSyncPolicy(policy,now);}catch{/* An expired policy leaves retained jobs reviewable only when permitted. */}
    if(parts.length===0&&request.method==="GET"){
      const all=(await queue.all()).filter(j=>j.projectId===project.id),sources=all.filter(j=>j.status==="done"&&(j.dialogueReplacement||j.lipSync)).map(job=>{
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
    const preview=parts[1]==="preview"&&request.method==="POST",submit=parts.length===1&&request.method==="POST";
    if(!preview&&!submit&&!(parts.length===1&&request.method==="GET"))return {status:404,body:{error:"unknown lip-sync route"}};
    let requestHash:string|undefined,key:string|undefined;
    if(submit){const input=record(body,["idempotencyKey","generationApproved","sourceRevision","policyRevision","capabilityRevision","shotId","lineIndex","selection","operatorGrant"]);
      if(typeof input.idempotencyKey!=="string"||input.idempotencyKey.length<1||input.idempotencyKey.length>128||[...input.idempotencyKey].some(c=>c.charCodeAt(0)<33||c.charCodeAt(0)>126))lipFail("Use a new printable request key of 1–128 characters.");
      key=project.id+":"+input.idempotencyKey;requestHash=contentHash({sourceJobId:selected.id,request:Object.fromEntries(Object.entries(input).filter(([k])=>k!=="idempotencyKey"))});
      const existing=(await queue.all()).find(j=>j.projectId===project.id&&j.idempotencyKey===key);if(existing){if(existing.stage!=="lip-sync"||existing.lipSync?.requestHash!==requestHash)lipFail("This request key belongs to another pass. Review a new request.");return {status:202,body:{jobId:existing.id,status:existing.status,stage:existing.stage}};}
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
      assertLipSyncPermission(plan,latest);const decision=new CapacityController(monthlyBudgetUsd).decide({tier,runningForProject:(await queue.all()).filter(j=>j.projectId===project.id&&j.status==="running").length,requestedShots:1,sceneCount:1,monthSpendUsd:await ledger.monthSpend()+await ledger.reservedUsd()});
      if(decision.action==="reject")return {status:429,body:{error:decision.message,reason:decision.reason}};
      const job=await lipLedger!.admitLipSync(project.id,{id:crypto.randomUUID(),idempotencyKey:key!,projectId:project.id,tier,stage:"lip-sync",scriptText:source.film.scriptText,scriptVersion:source.film.scriptVersion,rightsAttestedAt:latest.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:source.dialogue.totalFrames,costCapUsd:currentPolicy!.heldUsd,budgetReservedUsd:currentPolicy!.heldUsd,retryPolicy:{maxRetries:2,backoffMs:1500},timeoutMs:30*60*1000,queueAction:decision.action,queueReason:decision.reason,lipSync:plan},configuredLipSyncPolicy,monthlyBudgetUsd);
      return {status:202,body:{jobId:job.id,status:job.status,stage:job.stage,heldUsd:currentPolicy!.heldUsd,actualUsd:null}};
    }finally{this.inspections--;if(scratch&&realpathSync(scratch).startsWith(realpathSync(this.context.root)+sep+".lipsync-preview-"))rmSync(scratch,{recursive:true,force:true});}
  }
}
