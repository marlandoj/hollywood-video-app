import {ProjectService,type Project} from "./index";
import type {PostgresProjectService} from "../../storage/src/projects";
import {PostgresCostLedger} from "../../storage/src/ledger";
import type {PostgresJobStore} from "../../storage/src/jobs";
import {BudgetError,type CostLedger} from "../../operator/src/index";
import {TIERS,DurableJobStore,type CapacityController,type Job,type JobInput} from "../../queue/src/index";
import {contentHash,matchCapability,videoRequirements} from "../../generator/src/capabilities";
import {createProviderPlan,withAnchorStoryboard} from "../../generator/src/catalog";
import {parseFountain} from "../../parser/src/index";
import {frameAnchorRequest} from "../../planner/src/frame-anchors";
import {renderShots} from "../../planner/src/shot-reuse";
import {editFail,editId,editRecord} from "../../planner/src/edit-timeline";
import type {EditSourceBinding} from "../../planner/src/edit-jobs";
import type {LivingScriptProposal} from "../../planner/src/living-script-proposals";
import {createLivingScriptJobPlan,validateLivingScriptJobPlan,assertLivingScriptGenerationCurrent,type LivingScriptJobPlan} from "../../planner/src/living-script-jobs";
import {assertLivingScriptIdempotency,assertLivingScriptPreviewApproval,createLivingScriptPreviewReview,type LivingScriptPreviewReview} from "../../planner/src/living-script-job-context";
import {livingScriptRead} from "./living-script-read";
import {projectJobs} from "./project-jobs";

interface Context {
  projects:ProjectService|PostgresProjectService;ledger:CostLedger|PostgresCostLedger;capacity:CapacityController;monthlyBudgetUsd:number;filmCapUsd:number;
  store:(projectId:string)=>DurableJobStore|PostgresJobStore;
  binding:(project:Project,proposal:LivingScriptProposal)=>Promise<EditSourceBinding>;
  view:(job:Job,project:Project)=>Promise<Record<string,unknown>>;
}
export interface LivingScriptGenerationQuote {
  schema:"hv-living-script-generation-quote/1";plan:LivingScriptJobPlan;totalFrames:number;
  costCapUsd:number;budgetReservedUsd:number;minimumEstimateUsd:number;maximumEstimateUsd:number;timeoutMs:number;revision:string;
}
interface Result {status:number;body:unknown}
function response(status:number,body:unknown):Result {if(Buffer.byteLength(JSON.stringify(body),"utf8")>8*1024**2)editFail("The complete pending generation review exceeds 8 MiB.");return {status,body};}
function quote(plan:LivingScriptJobPlan):LivingScriptGenerationQuote {
  validateLivingScriptJobPlan(plan);const shots=renderShots(plan.inputs),stage=plan.inputs.stage;
  if(stage!=="animatic"&&stage!=="final")editFail("Choose a screenplay preview or final film.");
  const costCapUsd=stage==="animatic"?Number(process.env.HV_ANIMATIC_COST_CAP_USD??5):Number(process.env.HV_COST_CAP_PER_SHOT_USD??5)*Math.max(shots.length,1);
  if(!Number.isFinite(costCapUsd)||costCapUsd<=0)throw new BudgetError("Invalid pending generation budget.");
  const provider=plan.inputs.providerPlan!,current=withAnchorStoryboard(createProviderPlan(stage,stage==="animatic"?costCapUsd:costCapUsd/Math.max(shots.length,1),provider.requirements),shots.some(shot=>shot.direction?.frameAnchors&&(stage==="animatic"||shot.direction.frameAnchors.fallback==="storyboard")));
  if(contentHash(current)!==contentHash(provider))editFail("Provider configuration or budget changed. Review a new screenplay proposal before generation.");
  const rich=provider.pool.some(entry=>entry.snapshot.adapter==="rich-animatic");let minimumEstimateUsd=0,maximumEstimateUsd=0;
  for(const shot of shots){
    if(plan.shotReuse.shots.some(record=>record.shotId===shot.id))continue;
    const requirements=videoRequirements({performances:shot.performances,widthxheight:stage==="animatic"?"640x360":TIERS[plan.inputs.tier].maxResolution,fps:30,
      durationSec:stage==="animatic"&&!rich&&!shot.direction?.frameAnchors&&shot.direction?.durationFrames==null?1:shot.durationSec,
      framing:shot.direction?.framing,cameraPath:shot.direction?.cameraPath,frameAnchors:frameAnchorRequest(shot.direction?.frameAnchors,stage),
      ...(stage==="animatic"&&shot.direction?.previewMove?{cameraMove:shot.direction.previewMove}:{}),referenceFrames:shot.referenceAssets?.map(asset=>asset.id),routingRequirements:provider.requirements});
    const matches=provider.pool.map(entry=>matchCapability(entry.snapshot,requirements,provider.maxShotUsd)),eligible=matches.filter(match=>match.eligible);
    if(!eligible.length){const reasons=[...new Set(matches.flatMap(match=>match.reasons))];if(reasons.every(reason=>reason==="price"))throw new BudgetError("No configured provider fits the pending shot budget.");editFail("No configured provider supports these pending render requirements: "+reasons.join(", ")+".");}
    minimumEstimateUsd+=Math.min(...eligible.map(match=>match.estimateUsd!));maximumEstimateUsd+=Math.max(...eligible.map(match=>match.estimateUsd!));
  }
  if(minimumEstimateUsd>costCapUsd+1e-9)throw new BudgetError("The revised film exceeds its generation budget.");
  const timeoutMs=Number(process.env.HV_JOB_TIMEOUT_MS??30*60*1000);if(!Number.isSafeInteger(timeoutMs)||timeoutMs<=0)editFail("The generation timeout configuration is invalid.");
  const data={schema:"hv-living-script-generation-quote/1" as const,plan,totalFrames:shots.reduce((total,shot)=>total+Math.round(shot.durationSec*30),0),costCapUsd,
    budgetReservedUsd:provider.pool.some(entry=>entry.snapshot.price.unit!=="free")&&plan.shotReuse.shots.length!==shots.length?costCapUsd:0,minimumEstimateUsd,maximumEstimateUsd,timeoutMs};
  return {...data,revision:contentHash(data)};
}
function checkedQuote(value:unknown):LivingScriptGenerationQuote {
  const q=editRecord(value,["schema","plan","totalFrames","costCapUsd","budgetReservedUsd","minimumEstimateUsd","maximumEstimateUsd","timeoutMs","revision"]) as unknown as LivingScriptGenerationQuote;
  if(q.schema!=="hv-living-script-generation-quote/1")editFail("Retain the complete pending generation quote.");validateLivingScriptJobPlan(q.plan);
  const {revision,...data}=q;if(typeof revision!=="string"||contentHash(data)!==revision)editFail("The pending generation quote changed. Review it again.");
  return q;
}
function input(q:LivingScriptGenerationQuote,idempotencyKey:string,project:Project,preview:Job|undefined,approvedAt:string|null):JobInput {
  const plan=q.plan;return {id:crypto.randomUUID(),idempotencyKey:project.id+":"+idempotencyKey,...plan.inputs,livingScript:plan,shotReuse:plan.shotReuse,
    totalFrames:q.totalFrames,costCapUsd:q.costCapUsd,budgetReservedUsd:q.budgetReservedUsd,timeoutMs:q.timeoutMs,retryPolicy:{maxRetries:2,backoffMs:1000},
    ...(plan.inputs.stage==="animatic"?{providerSpec:plan.inputs.providerPlan!.pool[0]!.spec}:{}),rightsAttestedAt:project.rightsAttestedAt,animaticJobId:preview?.id??null,animaticApprovedAt:approvedAt};
}

/** Owner generation retains the quoted plan across retry and never commits its proposed screenplay. */
export class LivingScriptGenerationApi {
  readonly #controller=new AbortController();readonly #operations=new Set<Promise<Result>>();#closed=false;
  constructor(readonly context:Context){}
  async handle(parts:string[],request:Request,projectId:string,proposalId:string,token:string,refresh:()=>Promise<Project|null>,body?:Record<string,unknown>):Promise<Result>{
    if(this.#closed)editFail("Screenplay generation stopped. Reopen the editor.");if(this.#operations.size>=2)editFail("Two screenplay requests are running. Retry when they finish.");
    const signal=AbortSignal.any([request.signal,this.#controller.signal,AbortSignal.timeout(30000)]),task=this.#handle(parts,request,projectId,proposalId,token,refresh,body,signal);
    this.#operations.add(task);try{return await task;}finally{this.#operations.delete(task);}
  }
  async #handle(parts:string[],request:Request,projectId:string,proposalId:string,token:string,refresh:()=>Promise<Project|null>,body:Record<string,unknown>|undefined,signal:AbortSignal):Promise<Result>{
    editId(projectId);editId(proposalId);if(new URL(request.url).search)editFail("Use the saved screenplay generation route without query fields.");
    const read=<T>(task:()=>Promise<T>|T)=>livingScriptRead(task,signal);
    const owner=async()=>{const project=await read(refresh);signal.throwIfAborted();if(!project||project.id!==projectId||!Number.isFinite(Date.parse(project.deleteAfter))||Date.parse(project.deleteAfter)<=Date.now())editFail("This project is no longer available.");return project;};
    const project=await owner(),proposal=project.livingScriptProposals.proposals.find(item=>item.request.id===proposalId);if(!proposal)return response(404,{error:"Unknown screenplay proposal."});
    const store=this.context.store(projectId),job=async(id:unknown)=>{const found=await read(()=>store.get(editId(id)));signal.throwIfAborted();if(!found||found.projectId!==projectId||found.livingScript?.proposal.revision!==proposal.revision)editFail("Choose a generation from this exact screenplay proposal.");return found;};
    const current=async(plan:LivingScriptJobPlan)=>{if(contentHash(plan.proposal)!==contentHash(proposal))editFail("The quote belongs to another screenplay proposal.");const carrier=await read(()=>store.get(plan.binding.owner.jobId)),latest=await owner();assertLivingScriptGenerationCurrent(plan,latest,carrier);return {project:latest,carrier};};
    if(parts.length===1&&parts[0]==="quote"&&request.method==="POST"){
      const asked=editRecord(body,["role"]);if(asked.role!=="render"&&asked.role!=="preview")editFail("Choose a revised preview or the reviewed film render.");
      const binding=await read(()=>this.context.binding(project,proposal)),candidate=proposal.request.candidate,shots=renderShots({...candidate,stage:"animatic"});
      const plan=createLivingScriptJobPlan(proposal,binding,asked.role==="render"?{role:"render"}:{role:"preview",providerPlan:withAnchorStoryboard(createProviderPlan("animatic",Number(process.env.HV_ANIMATIC_COST_CAP_USD??5)),shots.some(shot=>Boolean(shot.direction?.frameAnchors)))});
      await current(plan);const result=quote(plan);await current(plan);return response(200,{quote:result,generatedShots:plan.shotReuse.forceShotIds,reusedShots:plan.shotReuse.shots.map(record=>record.shotId),generationApproved:false});
    }
    if(parts.length===1&&parts[0]==="jobs"&&request.method==="GET"){
      const jobs=(await read(()=>projectJobs(this.context.store,projectId))).filter(item=>item.livingScript?.proposal.revision===proposal.revision),views=[];
      for(const item of jobs){const current=await owner();views.push(await read(()=>this.context.view(item,current)));signal.throwIfAborted();}await owner();return response(200,{proposalRevision:proposal.revision,jobs:views});
    }
    if(parts.length===3&&parts[0]==="jobs"&&parts[2]==="decision"){
      const preview=await job(parts[1]),review=createLivingScriptPreviewReview(preview),state=await current(preview.livingScript!);
      if(request.method==="GET"){const view=await read(()=>this.context.view(preview,state.project)),latest=await current(preview.livingScript!);return response(200,{job:view,review,approval:latest.project.animaticApprovals.find(value=>value.animaticJobId===preview.id)??null});}
      if(request.method==="POST"){
        const asked=editRecord(body,["review","decision","note"]);if(asked.decision!=="approved"&&asked.decision!=="changes_requested")editFail("Approve the revised preview or request changes.");
        signal.throwIfAborted();const result=await this.context.projects.recordLivingScriptDecision(token,preview,asked.review as LivingScriptPreviewReview,asked.decision,asked.note as string,{binding:preview.livingScript!.binding,current:state.carrier});
        if(!result)editFail("This project is no longer available.");return response(result.replayed?200:201,result);
      }
    }
    if(parts.length===1&&parts[0]==="jobs"&&request.method==="POST"){
      const asked=editRecord(body,["quote","idempotencyKey","generationApproved","animaticJobId"]),q=checkedQuote(asked.quote);
      if(asked.generationApproved!==true||typeof asked.idempotencyKey!=="string"||!/^[A-Za-z0-9_-]{8,128}$/.test(asked.idempotencyKey)||!(asked.animaticJobId===null||typeof asked.animaticJobId==="string"))editFail("Review generation and retain its request key and preview selection.");
      if(contentHash(q.plan.proposal)!==contentHash(proposal))editFail("This quote belongs to another screenplay proposal.");
      const previous=(await read(()=>projectJobs(this.context.store,projectId))).find(item=>item.idempotencyKey===projectId+":"+asked.idempotencyKey);
      if(previous){
        const retry=input(q,asked.idempotencyKey,{...project,rightsAttestedAt:previous.rightsAttestedAt},asked.animaticJobId?{id:asked.animaticJobId} as Job:undefined,previous.animaticApprovedAt);
        assertLivingScriptIdempotency(previous,retry);await owner();return response(202,{jobId:previous.id,stage:previous.stage,status:previous.status,replayed:true});
      }
      if(contentHash(quote(q.plan))!==contentHash(q))editFail("The generation estimate or runtime changed. Review a fresh quote.");
      const state=await current(q.plan),preview=asked.animaticJobId?await job(asked.animaticJobId):undefined,approval=preview?state.project.animaticApprovals.find(value=>value.animaticJobId===preview.id):undefined;
      const submitted=input(q,asked.idempotencyKey,state.project,preview,approval?.at??null);if(submitted.stage==="final")assertLivingScriptPreviewApproval(submitted,preview,approval);else if(preview)editFail("A pending preview cannot consume another preview approval.");
      const {ledger,capacity,monthlyBudgetUsd,filmCapUsd}=this.context,shots=renderShots(q.plan.inputs),decision=capacity.decide({tier:q.plan.inputs.tier,runningForProject:(await read(()=>projectJobs(this.context.store,projectId))).filter(item=>item.status==="running").length,requestedShots:shots.length,sceneCount:parseFountain(q.plan.inputs.scriptText).scenes.length,monthSpendUsd:await read(()=>ledger.monthSpend())+await read(()=>ledger.reservedUsd())});
      if(decision.action==="reject")return response(429,{error:decision.message,reason:decision.reason});submitted.queueAction=decision.action;submitted.queueReason=decision.reason;signal.throwIfAborted();let result:Job;
      if(ledger instanceof PostgresCostLedger)result=await ledger.admit(projectId,submitted,monthlyBudgetUsd,filmCapUsd);
      else {
        const projects=this.context.projects;if(!(projects instanceof ProjectService)||!(store instanceof DurableJobStore))editFail("Local pending admission requires the matching local project and job stores.");
        await ledger.reserve(submitted.id,submitted.stage,submitted.budgetReservedUsd??0,monthlyBudgetUsd);
        try{
          // The local writers are synchronous within this process. Keep the final owner,
          // original and preview reads in the same uninterrupted block as enqueue.
          signal.throwIfAborted();const final=projects.authorize(token),carrier=store.get(q.plan.binding.owner.jobId),freshPreview=preview?store.get(preview.id):undefined;
          assertLivingScriptGenerationCurrent(q.plan,final,carrier);if(submitted.stage==="final")assertLivingScriptPreviewApproval(submitted,freshPreview,freshPreview?final!.animaticApprovals.find(value=>value.animaticJobId===freshPreview.id):undefined);
          result=store.enqueue(submitted);
        }catch(error){await ledger.release(submitted.id);throw error;}
        if(result.id!==submitted.id)await ledger.release(submitted.id);
      }
      return response(202,{jobId:result.id,stage:result.stage,status:result.status,replayed:false});
    }
    return response(404,{error:"Unknown screenplay generation route."});
  }
  async close():Promise<void>{this.#closed=true;this.#controller.abort(new Error("Screenplay generation service stopped."));await Promise.allSettled(this.#operations);}
}
