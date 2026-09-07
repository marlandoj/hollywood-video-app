import {mkdirSync} from "node:fs";
import type {Project,ProjectService} from "./index";
import type {PostgresProjectService} from "../../storage/src/projects";
import {CapacityController,DurableJobStore,type Job,type JobInput} from "../../queue/src/index";
import type {PostgresJobStore} from "../../storage/src/jobs";
import {PostgresCostLedger} from "../../storage/src/ledger";
import type {CostLedger} from "../../operator/src/index";
import type {PostgresArtifactStore} from "../../storage/src/artifacts";
import {contentHash} from "../../generator/src/capabilities";
import {soundRuntimeRevision} from "../../generator/src/sound-audio";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {assertSelectedOutput,outputRevision} from "../../planner/src/dialogue-selection";
import {editFail,editId,editNumber,editRecord,editSpeechCuts,editUnmeasuredCuts} from "../../planner/src/edit-timeline";
import {editHistoryState} from "../../planner/src/edit-history";
import {assertEditBindingAvailable,assertEditPermission,bindOriginalEditSource,bindRetainedEditSource,createEditPlan,type EditSourceBinding,type EditRenderReview} from "../../planner/src/edit-jobs";
import {assertEditOriginalPermission} from "../../planner/src/edit-sources";
import {EDIT_STORAGE_LIMITS,editStorageEstimate,assertEditStorageEstimate} from "../../planner/src/edit-resources";
import type {EditSequence,EditSequenceChange} from "../../planner/src/edit-library";
interface Context {root:string;projects:ProjectService|PostgresProjectService;artifacts?:PostgresArtifactStore;ledger:CostLedger|PostgresCostLedger;monthlyBudgetUsd:number;capacity:CapacityController;store:(projectId:string)=>DurableJobStore|PostgresJobStore;view:(job:Job,project:Project)=>Promise<Record<string,unknown>>}
const sourceView=(binding:EditSourceBinding)=>({jobId:binding.owner.jobId,sourceRevision:binding.source.revision,bindingRevision:binding.revision,outputRevision:binding.owner.outputRevision,expiresAt:binding.owner.linkExpiresAt,facts:binding.source.facts,language:binding.source.language});
const sequenceView=(sequence:EditSequence)=>{const {timeline,head}=editHistoryState(sequence.history);return {id:sequence.id,label:sequence.label,createdAt:sequence.createdAt,historyRevision:sequence.history.revision,head,frames:timeline.frames,width:timeline.width,height:timeline.height};};
export class EditApi {
  private inspections=0;
  constructor(private context:Context){}
  private async binding(project:Project,jobId:string,revision:unknown,refresh:()=>Promise<Project|null>,signal:AbortSignal):Promise<EditSourceBinding>{
    const queue=this.context.store(project.id),job=await queue.get(editId(jobId));if(!job||job.projectId!==project.id)editFail("Choose a retained source from this project.");
    if(job.pictureEdit){if(typeof revision!=="string")editFail("Choose an original retained by this editorial version.");const binding=bindRetainedEditSource(job,revision);assertEditBindingAvailable(binding,job);assertEditOriginalPermission(binding.source,await refresh());return binding;}
    const known=project.editLibrary.sources.find(s=>s.job.id===job.id&&s.revision===revision);if(known){const binding=bindOriginalEditSource(known);assertEditBindingAvailable(binding,job);assertEditOriginalPermission(known,await refresh());return binding;}
    if(this.inspections>=2)editFail("Two original sources are being checked. Try again shortly.");this.inspections++;
    try{mkdirSync(this.context.root,{recursive:true});const access=async()=>{signal.throwIfAborted();const current=await queue.get(job.id);assertSelectedOutput(current,await refresh(),{jobId:job.id,outputRevision:outputRevision(job)});};
      await access();const receipt=await inspectEditSource(job,job.stage+" "+job.id.slice(0,8),this.context.root,access,signal,this.context.artifacts,this.context.artifacts?path=>this.context.artifacts!.fileInfo(project.id,job.id,path):undefined);
      if(revision!==undefined&&receipt.revision!==revision)editFail("The original source changed. Inspect it again before saving this sequence.");const binding=bindOriginalEditSource(receipt);assertEditBindingAvailable(binding,await queue.get(job.id));return binding;
    }finally{this.inspections--;}
  }
  private async retainedBindings(project:Project,sequence:EditSequence):Promise<EditSourceBinding[]>{
    const all=(await this.context.store(project.id).all()).filter(j=>j.projectId===project.id&&j.status==="done").sort((a,b)=>(b.completedAt??"").localeCompare(a.completedAt??"")),bindings:EditSourceBinding[]=[];
    for(const revision of sequence.sourceRevisions){const source=project.editLibrary.sources.find(s=>s.revision===revision);if(!source)editFail("The sequence lost its original source receipt.");let chosen:EditSourceBinding|undefined;
      for(const job of [...all.filter(j=>j.id===source.job.id),...all.filter(j=>j.pictureEdit)])try{const binding=job.pictureEdit?bindRetainedEditSource(job,revision):bindOriginalEditSource(source);assertEditBindingAvailable(binding,job);chosen=binding;break;}catch{/* Another retained carrier may still own these exact originals. */}
      if(!chosen)editFail("An original source is no longer retained. Restore an editorial archive or choose another source.");assertEditOriginalPermission(source,project);bindings.push(chosen);
    }return bindings;
  }
  async handle(parts:string[],request:Request,project:Project,token:string,refresh:()=>Promise<Project|null>,body?:Record<string,unknown>):Promise<{status:number;body:unknown}>{
    const {projects,store,ledger,capacity,monthlyBudgetUsd}=this.context,queue=store(project.id);
    if(!parts.length&&request.method==="GET"){const all=(await queue.all()).filter(j=>j.projectId===project.id);return {status:200,body:{libraryVersion:project.editLibrary.version,sequences:project.editLibrary.sequences.map(sequenceView),sources:all.filter(j=>j.status==="done"&&["animatic","final","dialogue-replacement","lip-sync","sound-mix","picture-edit"].includes(j.stage)).map(j=>({jobId:j.id,stage:j.stage,completedAt:j.completedAt,expiresAt:j.linkExpiresAt})),jobs:await Promise.all(all.filter(j=>j.pictureEdit).map(j=>this.context.view(j,project))),engineVersion:soundRuntimeRevision(),limits:EDIT_STORAGE_LIMITS}};}
    if(parts[0]==="sources"&&parts.length===2&&request.method==="GET"){
      const job=await queue.get(editId(parts[1]));if(job?.projectId===project.id&&job.pictureEdit){assertSelectedOutput(job,project,{jobId:job.id,outputRevision:outputRevision(job)});return {status:200,body:{sources:job.output!.editorial!.prepared.sources.map(s=>sourceView(bindRetainedEditSource(job,s.receipt.revision)))}};}
      return {status:200,body:{sources:[sourceView(await this.binding(project,editId(parts[1]),undefined,refresh,request.signal))]}};
    }
    if(parts[0]!=="sequences")return {status:404,body:{error:"Unknown editorial route."}};
    if(parts.length===1&&request.method==="POST"){
      const input=editRecord(body,["id","label","sources","firstSourceId","width","height","expectedVersion"]);if(!Array.isArray(input.sources)||!input.sources.length||input.sources.length>16)editFail("Choose one to sixteen retained sources.");
      const bindings:EditSourceBinding[]=[];for(const raw of input.sources){const source=editRecord(raw,["jobId","sourceRevision"]);if(typeof source.sourceRevision!=="string")editFail("Inspect each original before creating the sequence.");bindings.push(await this.binding(project,editId(source.jobId),source.sourceRevision,refresh,request.signal));}
      const current=await refresh();if(!current)editFail("This project is no longer available.");for(const binding of bindings){assertEditBindingAvailable(binding,await queue.get(binding.owner.jobId));assertEditOriginalPermission(binding.source,current);}
      const library=await projects.createEditSequence(token,bindings.map(b=>b.source),editId(input.id),input.label as string,editId(input.firstSourceId),editNumber(input.width,2,1920,"Export width"),editNumber(input.height,2,1080,"Export height"),editNumber(input.expectedVersion,0,100000,"Editorial library version"),Date.now(),bindings);if(!library)editFail("This project is no longer available.");return {status:201,body:{libraryVersion:library.version,sequence:library.sequences.find(s=>s.id===input.id)}};
    }
    const sequence=project.editLibrary.sequences.find(s=>s.id===parts[1]);if(!sequence)return {status:404,body:{error:"Unknown editorial sequence."}};
    if(parts.length===2&&request.method==="GET")return {status:200,body:{libraryVersion:project.editLibrary.version,sequence,timeline:editHistoryState(sequence.history).timeline}};
    if(parts.length===2&&request.method==="PATCH"){
      const input=editRecord(body,["expectedVersion","expectedHistoryRevision","change"]),library=await projects.changeEditSequence(token,sequence.id,input.change as EditSequenceChange,editNumber(input.expectedVersion,0,100000,"Editorial library version"),input.expectedHistoryRevision as string);if(!library)editFail("This project is no longer available.");return {status:200,body:{libraryVersion:library.version,sequence:library.sequences.find(s=>s.id===sequence.id)}};
    }
    if(parts.length!==3||parts[2]!=="renders"||!["GET","POST"].includes(request.method))return {status:404,body:{error:"Unknown editorial route."}};
    const input=body?editRecord(body,["idempotencyKey","generationApproved","historyRevision","sourceBindingsRevision","engineVersion","review"]):undefined;
    if(request.method==="POST"){
      if(!input||input.generationApproved!==true||typeof input.idempotencyKey!=="string"||!/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey))editFail("Review the edit and use a new request key before rendering.");const previous=(await queue.all()).find(j=>j.projectId===project.id&&j.idempotencyKey===project.id+":"+input.idempotencyKey);
      if(previous){if(previous.pictureEdit?.sequence.id!==sequence.id||previous.pictureEdit.requestHash!==contentHash(input))editFail("This request key belongs to a different editorial export.");return {status:202,body:{jobId:previous.id}};}
    }
    const bindings=await this.retainedBindings(project,sequence),timeline=editHistoryState(sequence.history).timeline,engineVersion=soundRuntimeRevision(),sourceBindingsRevision=contentHash(bindings.map(b=>b.revision)),resources=editStorageEstimate(timeline,bindings);
    if(request.method==="GET"){let unavailable:string|null=null;try{assertEditStorageEstimate(resources);}catch(error){unavailable=(error as Error).message;}return {status:200,body:{sequence:sequenceView(sequence),timelineRevision:timeline.revision,sourceBindingsRevision,sources:bindings.map(sourceView),engineVersion,resources,unavailable,costUsd:0,speechCuts:editSpeechCuts(timeline),unmeasuredAudioCuts:editUnmeasuredCuts(timeline)}};}
    if(!input||input.historyRevision!==sequence.history.revision||input.sourceBindingsRevision!==sourceBindingsRevision||input.engineVersion!==engineVersion)editFail("The edit, retained sources or runtime changed. Review a fresh export quote.");
    const plan=createEditPlan(sequence,bindings,engineVersion,this.context.artifacts?"s3":"local",contentHash(input),input.review as unknown as EditRenderReview),current=await refresh();assertEditPermission(plan,current);if(current!.editLibrary.sequences.find(s=>s.id===sequence.id)?.history.revision!==sequence.history.revision)editFail("The edit changed during admission. Review a fresh export quote.");
    const decision=capacity.decide({tier:"free",runningForProject:(await queue.all()).filter(j=>j.projectId===project.id&&j.status==="running").length,requestedShots:1,sceneCount:1,monthSpendUsd:await ledger.monthSpend()+await ledger.reservedUsd()});if(decision.action==="reject")return {status:429,body:{error:decision.message,reason:decision.reason}};
    const origin=bindings[0]!.source.job,jobInput:JobInput={id:crypto.randomUUID(),idempotencyKey:project.id+":"+input.idempotencyKey,projectId:project.id,tier:"free",stage:"picture-edit",scriptVersion:origin.scriptVersion,scriptText:origin.scriptText,rightsAttestedAt:current!.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,queueAction:decision.action,queueReason:decision.reason,totalFrames:timeline.frames,costCapUsd:0,budgetReservedUsd:0,retryPolicy:{maxRetries:2,backoffMs:1000},timeoutMs:Number(process.env.HV_JOB_TIMEOUT_MS??30*60*1000),pictureEdit:plan};let job:Job;
    if(ledger instanceof PostgresCostLedger)job=await ledger.admit(project.id,jobInput,monthlyBudgetUsd);
    else{await ledger.reserve(jobInput.id,jobInput.stage,0,monthlyBudgetUsd);try{assertEditPermission(plan,await refresh());for(const binding of bindings)assertEditBindingAvailable(binding,await queue.get(binding.owner.jobId));job=await queue.enqueue(jobInput);}catch(error){await ledger.release(jobInput.id);throw error;}}
    return {status:202,body:{jobId:job.id}};
  }
}
