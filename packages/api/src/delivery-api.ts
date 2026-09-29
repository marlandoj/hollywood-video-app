import type {Project,ProjectService} from "./index";
import type {PostgresProjectService} from "../../storage/src/projects";
import {CapacityController,DurableJobStore,type Job,type JobInput} from "../../queue/src/index";
import type {PostgresJobStore} from "../../storage/src/jobs";
import {PostgresCostLedger} from "../../storage/src/ledger";
import type {CostLedger} from "../../operator/src/index";
import {DELIVERY_KINDS,assertDeliveryPermission,assertDeliverySourceAvailable,assertDeliverySourcePermission,assertDeliverySourceRetained,deliveryBindingForJob,deliveryJobPlan,
  deliveryOffers,deliveryTimeoutMs,validateDeliveryOutput,type DeliveryKind} from "../../planner/src/delivery-jobs";
import {editFail} from "../../planner/src/edit-errors";
import {editId,editRecord} from "../../planner/src/edit-timeline";
import {mintArtifactToken} from "./tokens";
import {projectJobs} from "./project-jobs";

interface Context {
  projects:ProjectService|PostgresProjectService;storage:"local"|"s3";ledger:CostLedger|PostgresCostLedger;
  monthlyBudgetUsd:number;filmCapUsd:number;capacity:CapacityController;store:(projectId:string)=>DurableJobStore|PostgresJobStore;
}
/**
 * HV-027-05: what a creator sees of a deliverable.
 *
 * The view carries the same "unavailable" shape the graphic view uses: a deliverable whose project
 * permission has lapsed, or whose link has expired, is shown as unavailable **with the reason**
 * rather than quietly omitted, because a file that disappears without explanation reads as a bug.
 */
export function deliveryJobView(job:Job,project:Project,source:Job|undefined):Record<string,unknown>{
  let unavailable:string|null=null;const expiresAt=Math.min(Date.parse(job.linkExpiresAt??project.deleteAfter),Date.parse(project.deleteAfter));
  try{
    assertDeliveryPermission(job.delivery!,project);
    // HV-027-14: and the source film's cast permission, which the file is made of.
    assertDeliverySourcePermission(source,project);
    if(job.deliveryOutput){validateDeliveryOutput(job,job.deliveryOutput);if(expiresAt<=Date.now())editFail("This deliverable has expired.");}
  }catch(error){unavailable=(error as Error).message;}
  const output=job.status==="done"&&!unavailable?job.deliveryOutput:undefined;
  const token=output?mintArtifactToken(job.projectId,job.id,expiresAt):undefined;
  return {id:job.id,stage:job.stage,status:job.status,kind:job.delivery?.kind,
    sourceJobId:job.delivery?.binding.source.jobId,sourceOutputRevision:job.delivery?.binding.source.outputRevision,
    resumedCount:job.resumedCount,failureReason:job.failureReason??null,unavailable,costUsd:job.costUsd,
    completedAt:job.completedAt,expiresAt:output?new Date(expiresAt).toISOString():null,
    output:output?{revision:output.revision,url:`/artifacts/${token}/${output.file.path}`,bytes:output.file.bytes,
      sha256:output.file.sha256,...output.delivered,
      // HV-027-06. The verdict and the findings, not the whole measurement: a creator is being told
      // whether to look at the file before they send it, and the numbers behind that answer are for
      // the operator's own check, which reads the retained report. `notChecked` travels with the
      // findings because a check that shows only what it found reads as a clean bill of health.
      quality:{verdict:output.quality.verdict,findings:output.quality.findings.map(finding=>
        ({code:finding.code,severity:finding.severity,message:finding.message})),notChecked:output.quality.notChecked}}:null};
}
export class DeliveryApi {
  constructor(private context:Context){}
  async handle(parts:string[],request:Request,project:Project,_token:string,refresh:()=>Promise<Project|null>,body?:Record<string,unknown>):Promise<{status:number;body:unknown}>{
    const {ledger,capacity,monthlyBudgetUsd}=this.context,queue=this.context.store(project.id);
    const mine=await projectJobs(this.context.store,project.id),view=(job:Job)=>deliveryJobView(job,project,mine.find(value=>value.id===job.delivery?.binding.source.jobId));
    // Every deliverable this project has asked for, whatever film it came from.
    if(!parts.length&&request.method==="GET")
      return {status:200,body:{kinds:[...DELIVERY_KINDS],jobs:mine.filter(job=>job.delivery).map(view),costUsd:0}};
    if(!parts.length||parts.length>1)return {status:404,body:{error:"Unknown delivery route."}};
    const source=mine.find(job=>job.id===editId(parts[0]));
    if(!source||source.status!=="done"||!source.output)return {status:404,body:{error:"This film is not finished, so there is nothing to deliver from it."}};
    let binding;
    // HV-027-14: nothing is offered or made from a film no longer retained, or whose cast permission is gone.
    try{assertDeliverySourceRetained(source);assertDeliverySourcePermission(source,project);binding=deliveryBindingForJob(source,this.context.storage);}
    catch(error){return {status:409,body:{error:(error as Error).message}};}
    // Every kind is answered, including the ones this master cannot make, each with the reason.
    if(request.method==="GET")
      return {status:200,body:{sourceJobId:source.id,outputRevision:binding.source.outputRevision,
        offers:deliveryOffers(binding).map(offer=>({kind:offer.kind,available:offer.available,reason:offer.reason??null,
          output:offer.plan?(offer.plan.kind==="mezzanine"?offer.plan.mezzanine!.output:{...offer.plan.reframe!.output,estimatedBytes:null}):null,
          estimatedBytes:offer.plan?.mezzanine?.estimatedBytes??null})),
        jobs:mine.filter(job=>job.delivery?.binding.source.jobId===source.id).map(view)}};
    if(request.method!=="POST")return {status:404,body:{error:"Unknown delivery route."}};
    const input=editRecord(body,["idempotencyKey","kind"]);
    if(typeof input.idempotencyKey!=="string"||!/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey))editFail("Ask for this deliverable with a new request key.");
    if(!DELIVERY_KINDS.includes(input.kind as DeliveryKind))editFail("Choose a deliverable this studio makes: "+DELIVERY_KINDS.join(", ")+".");
    const plan=deliveryJobPlan(binding,input.kind as DeliveryKind);
    const previous=mine.find(job=>job.idempotencyKey===project.id+":"+input.idempotencyKey);
    if(previous){
      if(previous.delivery?.idempotencyKey!==plan.idempotencyKey)editFail("This request key belongs to another deliverable.");
      return {status:202,body:{jobId:previous.id}};
    }
    // The same deliverable of the same sealed output is the same job, whatever request key asks for
    // it. Two keys asking for one file would render it twice and retain it twice.
    //
    // HV-027-10: only a job that is making the file, or made one that can still be fetched. A failed
    // or cancelled deliverable -- disk headroom, a timeout past its retries, a host restart -- used to
    // be "the same job" forever: every new request was answered 202 with the failed job's id and
    // nothing was queued, so one transient failure blocked that deliverable of that film for good.
    // An expired one was the same. Either is asked for again as a new job.
    const made=mine.find(job=>job.delivery?.idempotencyKey===plan.idempotencyKey&&(job.status==="queued"||job.status==="running"||job.status==="done"&&view(job).output!==null));
    if(made)return {status:202,body:{jobId:made.id}};
    // HV-027-09: the film is read again here. `source` came out of the `mine` snapshot at the top of
    // this handler and `binding` was derived from that same object three lines later, so asking
    // whether the one still matches the other could not fail -- the check that exists to refuse "a
    // film rendered again since the deliverable was planned" was comparing the plan with itself.
    const current=await refresh();assertDeliveryPermission(plan,current);assertDeliverySourceAvailable(binding,await queue.get(source.id)??undefined);
    const fresh=await queue.get(source.id)??undefined;assertDeliverySourceRetained(fresh);assertDeliverySourcePermission(fresh,current);
    const decision=capacity.decide({tier:"free",requestedUsd:0,runningForProject:mine.filter(job=>job.status==="running").length,requestedShots:1,sceneCount:1,
      monthSpendUsd:await ledger.monthSpend()+await ledger.reservedUsd()});
    if(decision.action==="reject")return {status:429,body:{error:decision.message,reason:decision.reason}};
    const jobInput:JobInput={id:crypto.randomUUID(),idempotencyKey:project.id+":"+input.idempotencyKey,projectId:project.id,tier:"free",
      stage:"delivery",scriptVersion:0,scriptText:"",rightsAttestedAt:current!.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,
      queueAction:decision.action,queueReason:decision.reason,totalFrames:binding.conform.frames,costCapUsd:0,budgetReservedUsd:0,
      retryPolicy:{maxRetries:2,backoffMs:1000},timeoutMs:deliveryTimeoutMs(plan.kind,binding.conform.frames),delivery:plan};
    let job:Job;
    if(ledger instanceof PostgresCostLedger)job=await ledger.admit(project.id,jobInput,monthlyBudgetUsd,this.context.filmCapUsd);
    else{
      await ledger.reserve(jobInput.id,jobInput.stage,0,monthlyBudgetUsd);
      // The local store has no transaction to hold the source still, so it is read once more at the
      // last moment before the job exists -- the narrowest window this backend can offer.
      try{assertDeliveryPermission(plan,await refresh());assertDeliverySourceAvailable(binding,await queue.get(source.id)??undefined);job=await queue.enqueue(jobInput);}
      catch(error){await ledger.release(jobInput.id);throw error;}
    }
    return {status:202,body:{jobId:job.id}};
  }
}
