import type {Project,ProjectService} from "./index";
import type {PostgresProjectService} from "../../storage/src/projects";
import {CapacityController,DurableJobStore,type Job,type JobInput} from "../../queue/src/index";
import type {PostgresJobStore} from "../../storage/src/jobs";
import {PostgresCostLedger} from "../../storage/src/ledger";
import type {CostLedger} from "../../operator/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {compileGraphic} from "../../generator/src/graphic-composition";
import {assertGraphicPermission,graphicJobPlan,validateGraphicOutput} from "../../planner/src/graphic-jobs";
import {currentGraphics,type GraphicChange} from "../../planner/src/graphic-library";
import {defaultMotionGraphic,GRAPHIC_CHROME_VERSION,GRAPHIC_KINDS,motionGraphic,type MotionGraphic} from "../../planner/src/motion-graphics";
import {editFail,editNumber} from "../../planner/src/edit-errors";
import {editId,editRecord} from "../../planner/src/edit-timeline";
import {checkPrompt,SafetyRefusalError} from "../../safety/src/index";
import {mintArtifactToken} from "./tokens";
import {projectJobs} from "./project-jobs";
interface Context {projects:ProjectService|PostgresProjectService;storage:"local"|"s3";ledger:CostLedger|PostgresCostLedger;monthlyBudgetUsd:number;filmCapUsd:number;capacity:CapacityController;store:(projectId:string)=>DurableJobStore|PostgresJobStore}
export function graphicJobView(job:Job,project:Project):Record<string,unknown>{
  let unavailable:string|null=null;const expiresAt=Math.min(Date.parse(job.linkExpiresAt??project.deleteAfter),Date.parse(project.deleteAfter));
  try{assertGraphicPermission(job.graphicRender!,project);if(job.graphicOutput){validateGraphicOutput(job,job.graphicOutput);if(expiresAt<=Date.now())editFail("This graphic export has expired.");}}catch(error){unavailable=(error as Error).message;}
  const output=job.status==="done"&&!unavailable?job.graphicOutput:undefined,token=output?mintArtifactToken(job.projectId,job.id,expiresAt):undefined;
  return {id:job.id,stage:job.stage,status:job.status,spec:job.graphicRender?.spec,progress:job.graphicProgress??null,retainedFrames:job.checkpointFrame,totalFrames:job.totalFrames,resumedCount:job.resumedCount,failureReason:job.failureReason??null,unavailable,costUsd:job.costUsd,completedAt:job.completedAt,expiresAt:output?new Date(expiresAt).toISOString():null,
    output:output?{revision:output.revision,masterUrl:`/artifacts/${token}/${output.masterPath}`,manifestUrl:`/artifacts/${token}/${output.manifestPath}`,framesUrl:`/artifacts/${token}/${output.manifestPath.slice(0,-"graphic.json".length)}frames/`,frames:output.report.plan.frames,width:output.report.plan.width,height:output.report.plan.height}:null};
}
export class GraphicApi {
  constructor(private context:Context){}
  async handle(parts:string[],request:Request,project:Project,token:string,refresh:()=>Promise<Project|null>,body?:Record<string,unknown>):Promise<{status:number;body:unknown}>{
    const {projects,ledger,capacity,monthlyBudgetUsd}=this.context,queue=this.context.store(project.id);
    if(!parts.length&&request.method==="GET")return {status:200,body:{library:project.graphicLibrary,graphics:currentGraphics(project.graphicLibrary,project.id),jobs:(await projectJobs(this.context.store,project.id)).filter(j=>j.graphicRender).map(j=>graphicJobView(j,project)),defaults:GRAPHIC_KINDS.map(kind=>defaultMotionGraphic(kind)),rendering:{available:Boolean(process.env.HV_GRAPHICS_CHROME_PATH),chromeVersion:GRAPHIC_CHROME_VERSION},costUsd:0}};
    if(!parts.length&&request.method==="PUT"){
      const input=editRecord(body,["change","expectedVersion"]),change=editRecord(input.change,["kind","id","label","plan","available"]);let normalized:GraphicChange;
      if(change.kind==="save"){editRecord(change,["kind","id","label","plan"]);const plan=motionGraphic(change.plan as MotionGraphic);compileGraphic(plan);normalized={kind:"save",id:editId(change.id),label:change.label as string,plan};}else{editRecord(change,["kind","id","available"]);if(change.kind!=="availability")editFail("Choose save, hide or restore for this graphic.");normalized={kind:"availability",id:editId(change.id),available:change.available as boolean};}
      const library=await projects.saveGraphic(token,normalized,editNumber(input.expectedVersion,0,1000,"Graphic library version"));if(!library)editFail("This project is no longer available.");return {status:200,body:{library,graphics:currentGraphics(library,project.id)}};
    }
    if(parts[0]==="jobs"&&parts.length===2&&request.method==="GET"){const job=await queue.get(editId(parts[1]));if(!job?.graphicRender||job.projectId!==project.id)return {status:404,body:{error:"Graphic render not found."}};return {status:200,body:graphicJobView(job,project)};}
    if(parts.length!==2||parts[1]!=="renders"||request.method!=="POST")return {status:404,body:{error:"Unknown graphic route."}};
    const id=editId(parts[0]),input=editRecord(body,["idempotencyKey","specRevision","generationApproved"]);
    if(input.generationApproved!==true||typeof input.idempotencyKey!=="string"||!/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey))editFail("Review this saved graphic before rendering with a new request key.");
    const requestHash=contentHash({id,...input}),previous=(await projectJobs(this.context.store,project.id)).find(j=>j.idempotencyKey===project.id+":"+input.idempotencyKey);
    if(previous){if(previous.graphicRender?.requestHash!==requestHash)editFail("This request key belongs to another graphic render.");return {status:202,body:{jobId:previous.id}};}
    const saved=currentGraphics(project.graphicLibrary,project.id).find(g=>g.spec.id===id);if(!saved?.available||saved.spec.revision!==input.specRevision)editFail("The saved graphic changed or was hidden. Review its current version.");
    const p=saved.spec.plan,verdict=checkPrompt([p.text,p.secondary,...p.credits.flatMap(c=>[c.role,c.name])].join("\n"));if(!verdict.allowed)throw new SafetyRefusalError(verdict);
    const plan=graphicJobPlan(saved.spec,this.context.storage,requestHash),current=await refresh();assertGraphicPermission(plan,current);
    const decision=capacity.decide({tier:"free",requestedUsd:0,runningForProject:(await projectJobs(this.context.store,project.id)).filter(j=>j.status==="running").length,requestedShots:1,sceneCount:1,monthSpendUsd:await ledger.monthSpend()+await ledger.reservedUsd()});if(decision.action==="reject")return {status:429,body:{error:decision.message,reason:decision.reason}};
    const jobInput:JobInput={id:crypto.randomUUID(),idempotencyKey:project.id+":"+input.idempotencyKey,projectId:project.id,tier:"free",stage:"motion-graphic",scriptVersion:0,scriptText:"",rightsAttestedAt:current!.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,queueAction:decision.action,queueReason:decision.reason,totalFrames:p.frames,costCapUsd:0,budgetReservedUsd:0,retryPolicy:{maxRetries:2,backoffMs:1000},timeoutMs:30*60*1000,graphicRender:plan};let job:Job;
    if(ledger instanceof PostgresCostLedger)job=await ledger.admit(project.id,jobInput,monthlyBudgetUsd,this.context.filmCapUsd);else{await ledger.reserve(jobInput.id,jobInput.stage,0,monthlyBudgetUsd);try{assertGraphicPermission(plan,await refresh());job=await queue.enqueue(jobInput);}catch(error){await ledger.release(jobInput.id);throw error;}}
    return {status:202,body:{jobId:job.id}};
  }
}
