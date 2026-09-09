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
import {editFail,editId,editNumber,editRecord,editSpeechCuts,editUnmeasuredCuts,editCrossfadeReview} from "../../planner/src/edit-timeline";
import {editHistoryState} from "../../planner/src/edit-history";
import {assertEditBindingAvailable,assertEditPermission,bindOriginalEditSource,bindRetainedEditSource,createEditPlan,editRenderReview,type EditSourceBinding,type EditRenderReview} from "../../planner/src/edit-jobs";
import {assertEditOriginalPermission,assertEditOriginalSelection} from "../../planner/src/edit-sources";
import {EDIT_STORAGE_LIMITS,editStorageEstimate,assertEditStorageEstimate} from "../../planner/src/edit-resources";
import type {EditSequence,EditSequenceChange} from "../../planner/src/edit-library";
import {EditPreviewApi,editPreviewVersion} from "./edit-preview-api";
import {LivingScriptPreviewApi} from "./living-script-preview-api";
import {editCompositeReview} from "../../planner/src/edit-composite-review";
import {EditOriginalFrameApi} from "./edit-original-frame-api";
import {EditScriptApi} from "./edit-script-api";
import {EditAssemblyApi} from "./edit-assembly-api";
import {LivingScriptGenerationApi} from "./living-script-generation-api";
import {LivingScriptApi} from "./living-script-api";
import {createEditAssemblyRenderPlan,editAssemblyRenderReview,assertEditAssemblyPermission,type EditAssemblyRenderReview} from "../../planner/src/edit-assembly-jobs";
import {validateEditAssemblyJob} from "../../planner/src/edit-assembly-job-context";
import {editAssemblyStorageEstimate,assertEditAssemblyStorageEstimate} from "../../planner/src/edit-assembly-resources";
import {reviewEditAssembly} from "../../planner/src/edit-assembly-review";
import {reviewEditAssemblyBoundaries} from "../../planner/src/edit-assembly-boundaries";
interface Context {root:string;projects:ProjectService|PostgresProjectService;artifacts?:PostgresArtifactStore;ledger:CostLedger|PostgresCostLedger;monthlyBudgetUsd:number;capacity:CapacityController;store:(projectId:string)=>DurableJobStore|PostgresJobStore;view:(job:Job,project:Project)=>Promise<Record<string,unknown>>}
const sourceView=(binding:EditSourceBinding)=>({jobId:binding.owner.jobId,sourceRevision:binding.source.revision,bindingRevision:binding.revision,outputRevision:binding.owner.outputRevision,expiresAt:binding.owner.linkExpiresAt,facts:binding.source.facts,language:binding.source.language});
const sequenceView=(sequence:EditSequence)=>{const {timeline,head}=editHistoryState(sequence.history);return {id:sequence.id,label:sequence.label,createdAt:sequence.createdAt,historyRevision:sequence.history.revision,head,frames:timeline.frames,width:timeline.width,height:timeline.height};};
const sequenceResponse=(libraryVersion:number,sequence:EditSequence)=>({libraryVersion,sequence,...editHistoryState(sequence.history)});
async function assemblyRead<T>(task:Promise<T>|T,signal:AbortSignal):Promise<T>{signal.throwIfAborted();let abort=()=>{};try{return await Promise.race([Promise.resolve(task),new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();})]);}finally{signal.removeEventListener("abort",abort);}}
export class EditApi {
  private inspections=0;
  private closed=false;
  private preview?:EditPreviewApi;
  private screenplayPreview?:LivingScriptPreviewApi;
  private originals?:EditOriginalFrameApi;
  private scripts?:EditScriptApi;
  private assemblies?:EditAssemblyApi;
  private screenplayGeneration?:LivingScriptGenerationApi;
  private screenplay?:LivingScriptApi;
  private readonly assemblyController=new AbortController();
  private readonly assemblyOperations=new Set<Promise<{status:number;body:unknown}>>();
  constructor(private context:Context){}
  private async binding(project:Project,jobId:string,revision:unknown,refresh:()=>Promise<Project|null>,signal:AbortSignal):Promise<EditSourceBinding>{
    const queue=this.context.store(project.id),job=await assemblyRead(queue.get(editId(jobId)),signal);if(!job||job.projectId!==project.id)editFail("Choose a retained source from this project.");
    if(job.currentFilm?.schema==="hv-current-film-job/3")editFail("Mixed-film editing isn't available in saved sequences yet.");
    if(job.pictureEdit||job.assemblyEdit){if(typeof revision!=="string")editFail("Choose an original retained by this editorial version.");const binding=bindRetainedEditSource(job,revision);assertEditBindingAvailable(binding,job);assertEditOriginalPermission(binding.source,await assemblyRead(refresh(),signal));return binding;}
    const known=project.editLibrary.sources.find(s=>s.job.id===job.id&&s.revision===revision);if(known){const binding=bindOriginalEditSource(known);assertEditBindingAvailable(binding,job);assertEditOriginalPermission(known,await assemblyRead(refresh(),signal));return binding;}
    if(this.inspections>=2)editFail("Two original sources are being checked. Try again shortly.");this.inspections++;
    try{mkdirSync(this.context.root,{recursive:true});const access=async()=>{signal.throwIfAborted();assertEditOriginalSelection(job,await assemblyRead(queue.get(job.id),signal),await assemblyRead(refresh(),signal));};
      await access();const receipt=await assemblyRead(inspectEditSource(job,job.graphicRender?.spec.label??job.stage+" "+job.id.slice(0,8),this.context.root,access,signal,this.context.artifacts,this.context.artifacts?path=>this.context.artifacts!.fileInfo(project.id,job.id,path):undefined),signal);
      if(revision!==undefined&&receipt.revision!==revision)editFail("The original source changed. Inspect it again before saving this sequence.");const binding=bindOriginalEditSource(receipt);assertEditBindingAvailable(binding,await assemblyRead(queue.get(job.id),signal));return binding;
    }finally{this.inspections--;}
  }
  private async retainedBindings(project:Project,sequence:Pick<EditSequence,"sourceRevisions">,sourceIds?:Set<string>):Promise<EditSourceBinding[]>{
    const all=(await this.context.store(project.id).all()).filter(j=>j.projectId===project.id&&j.status==="done").sort((a,b)=>(b.completedAt??"").localeCompare(a.completedAt??"")),bindings:EditSourceBinding[]=[];
    for(const revision of sequence.sourceRevisions){const source=project.editLibrary.sources.find(s=>s.revision===revision);if(!source)editFail("The sequence lost its original source receipt.");if(sourceIds&&!sourceIds.has(source.facts.id))continue;let chosen:EditSourceBinding|undefined;
      for(const job of [...all.filter(j=>j.id===source.job.id),...all.filter(j=>j.pictureEdit||j.assemblyEdit)])try{const binding=job.pictureEdit||job.assemblyEdit?bindRetainedEditSource(job,revision):bindOriginalEditSource(source);assertEditBindingAvailable(binding,job);chosen=binding;break;}catch{/* Another retained carrier may still own these exact originals. */}
      if(!chosen)editFail("An original source is no longer retained. Restore an editorial archive or choose another source.");assertEditOriginalPermission(source,project);bindings.push(chosen);
    }return bindings;
  }
  async close():Promise<void>{this.closed=true;this.assemblyController.abort(new Error("Assembly service stopped."));await this.screenplayPreview?.close();await Promise.all([this.preview?.close(),this.originals?.close(),this.scripts?.close(),this.assemblies?.close(),this.screenplayGeneration?.close(),this.screenplay?.close(),Promise.allSettled(this.assemblyOperations)]);}
  private async assemblyOperation(request:Request,action:(signal:AbortSignal)=>Promise<{status:number;body:unknown}>){if(this.closed)editFail("Assembly service stopped.");if(this.assemblyOperations.size>=2)editFail("Two assembly render requests are running. Retry after they finish.");const signal=AbortSignal.any([request.signal,this.assemblyController.signal,AbortSignal.timeout(30000)]),task=action(signal);this.assemblyOperations.add(task);try{return await task;}finally{this.assemblyOperations.delete(task);}}
  private assemblyService(){return this.assemblies??=new EditAssemblyApi({projects:this.context.projects,job:(id,job)=>this.context.store(id).get(job),bindings:(owner,parent)=>this.retainedBindings(owner,{sourceRevisions:parent.sourceReceipts.map(receipt=>receipt.receiptRevision)})});}
  private scriptService(){return this.scripts??=new EditScriptApi({job:(id,job)=>this.context.store(id).get(job),bindings:(owner,id,sources)=>{const selected=owner.editLibrary.sequences.find(s=>s.id===id);if(!selected)editFail("The saved sequence is unavailable.");return this.retainedBindings(owner,selected,sources);}});}
  private originalService(){return this.originals??=new EditOriginalFrameApi({root:this.context.root,reader:this.context.artifacts,job:(id,job)=>this.context.store(id).get(job),bindings:(owner,id,sources)=>{const selected=owner.editLibrary.sequences.find(s=>s.id===id);if(!selected)editFail("The saved sequence is unavailable.");return this.retainedBindings(owner,selected,sources);}});}
  private previewService(){
    return this.preview??=new EditPreviewApi({root:this.context.root,reader:this.context.artifacts,job:(id,job)=>this.context.store(id).get(job),bindings:(owner,id,sources)=>{const selected=owner.editLibrary.sequences.find(s=>s.id===id);if(!selected)editFail("The saved sequence is unavailable.");return this.retainedBindings(owner,selected,sources);},assemblyBindings:(owner,plan)=>this.retainedBindings(owner,{sourceRevisions:plan.parent.sourceReceipts.map(receipt=>receipt.receiptRevision)})});
  }
  async handle(parts:string[],request:Request,project:Project,token:string,refresh:()=>Promise<Project|null>,body?:Record<string,unknown>):Promise<{status:number;body:unknown}|Response>{
    if(this.closed)editFail("Editorial service stopped. Reopen the editor.");
    if(parts[0]==="screenplay"&&parts[1]==="proposals"&&parts[3]==="recut-preview"){
      this.screenplayPreview??=new LivingScriptPreviewApi({preview:this.previewService(),job:(id,job)=>this.context.store(id).get(job),bindings:(owner,library,revisions)=>this.retainedBindings({...owner,editLibrary:library},{sourceRevisions:revisions})});
      return this.screenplayPreview.handle(parts.slice(4),request,project.id,editId(parts[2]),refresh,body);
    }
    if(parts[0]==="screenplay"&&parts[1]==="proposals"&&parts[3]==="generation"){
      this.screenplayGeneration??=new LivingScriptGenerationApi({...this.context,binding:async(owner,proposal)=>(await this.retainedBindings({...owner,editLibrary:proposal.editorial},{sourceRevisions:[proposal.request.patch.receiptRevision]}))[0]!});
      return this.screenplayGeneration.handle(parts.slice(4),request,project.id,editId(parts[2]),token,refresh,body);
    }
    if(parts[0]==="screenplay"){
      this.screenplay??=new LivingScriptApi({projects:this.context.projects,job:(id,job)=>this.context.store(id).get(job),bindings:(owner,library,revisions)=>this.retainedBindings({...owner,editLibrary:library},{sourceRevisions:revisions}),inspect:(owner,id,revision,refresh,signal)=>this.binding(owner,id,revision,refresh,signal)});
      return this.screenplay.handle(parts.slice(1),request,project.id,token,refresh,body);
    }
    const {projects,store,ledger,capacity,monthlyBudgetUsd}=this.context,queue=store(project.id);
    if(parts[0]==="assemblies"&&["proposals","accepted"].includes(parts[1]??"")&&parts[3]==="preview")return this.previewService().handle(parts.slice(4),request,project.id,editId(parts[2]),refresh,body,parts[1]==="proposals"?"assembly-proposal":"assembly-accepted");
    if(parts[0]==="assemblies"&&parts[1]==="accepted"&&parts.length===5&&parts[3]==="render-requests"&&request.method==="GET")return this.assemblyOperation(request,async signal=>{
      const id=editId(parts[2]),key=parts[4]!;if(!/^[A-Za-z0-9_-]{8,128}$/.test(key)||new URL(request.url).search)editFail("Use the exact assembly render request key.");signal.throwIfAborted();
      const owner=await assemblyRead(refresh(),signal);if(!owner||owner.id!==project.id||!Number.isFinite(Date.parse(owner.deleteAfter))||Date.parse(owner.deleteAfter)<=Date.now())editFail("This project is no longer available.");
      if(!owner.assemblyLibrary.assemblies.some(item=>item.id===id))return {status:404,body:{error:"Unknown accepted assembly."}};
      const job=(await assemblyRead(queue.all(),signal)).find(item=>item.projectId===project.id&&item.idempotencyKey===project.id+":"+key);signal.throwIfAborted();
      const final=await assemblyRead(refresh(),signal);if(!final||final.id!==project.id||!Number.isFinite(Date.parse(final.deleteAfter))||Date.parse(final.deleteAfter)<=Date.now()||!final.assemblyLibrary.assemblies.some(item=>item.id===id))editFail("This saved assembly is no longer available.");
      if(!job)return {status:200,body:{admitted:false}};
      validateEditAssemblyJob(job);if(job.assemblyEdit?.assembly.id!==id)editFail("This request key belongs to another render.");
      assertEditAssemblyPermission(job.assemblyEdit,final);const view=await assemblyRead(this.context.view(job,final),signal);assertEditAssemblyPermission(job.assemblyEdit,await assemblyRead(refresh(),signal));
      return {status:200,body:{admitted:true,job:view,requestHash:job.assemblyEdit.requestHash}};
    });
    if(parts[0]==="assemblies"&&parts[1]==="accepted"&&parts.length===4&&parts[3]==="renders")return this.assemblyOperation(request,signal=>this.assemblyRenders(parts[2]!,request,project,refresh,body,signal));
    if(parts[0]==="assemblies")return this.assemblyService().handle(parts.slice(1),request,project.id,token,refresh,body);
    if(!parts.length&&request.method==="GET"){const all=(await queue.all()).filter(j=>j.projectId===project.id);return {status:200,body:{libraryVersion:project.editLibrary.version,libraryRevision:project.editLibrary.revision,sequences:project.editLibrary.sequences.map(sequenceView),sources:all.filter(j=>j.status==="done"&&j.currentFilm?.schema!=="hv-current-film-job/3"&&["animatic","final","dialogue-replacement","lip-sync","sound-mix","picture-edit","motion-graphic","assembly-edit"].includes(j.stage)).map(j=>({jobId:j.id,stage:j.stage,completedAt:j.completedAt,expiresAt:j.linkExpiresAt,...(j.graphicRender?{label:j.graphicRender.spec.label}:{})})),jobs:await Promise.all(all.filter(j=>j.pictureEdit).map(j=>this.context.view(j,project))),engineVersion:soundRuntimeRevision(),limits:EDIT_STORAGE_LIMITS}};}
    if(parts[0]==="sources"&&parts.length===2&&request.method==="GET"){
      const job=await queue.get(editId(parts[1]));if(job?.projectId===project.id&&(job.pictureEdit||job.assemblyEdit)){assertSelectedOutput(job,project,{jobId:job.id,outputRevision:outputRevision(job)});return {status:200,body:{sources:(job.output!.editorial??job.output!.assembly)!.prepared.sources.map(s=>sourceView(bindRetainedEditSource(job,s.receipt.revision)))}};}
      return {status:200,body:{sources:[sourceView(await this.binding(project,editId(parts[1]),undefined,refresh,request.signal))]}};
    }
    if(parts[0]==="versions"){
      const id=editId(parts[1]);
      if(parts[2]==="preview")return this.previewService().handle(parts.slice(3),request,project.id,id,refresh,body,"version");
      if(parts.length===2&&request.method==="GET"){
        const query=new URL(request.url).searchParams;if([...query.keys()].some(k=>k!=="outputRevision"||query.getAll(k).length!==1))editFail("Use the retained version's output revision.");
        const revision=query.get("outputRevision"),sequence=editPreviewVersion(project,await queue.get(id),revision);return {status:200,body:{jobId:id,outputRevision:revision,sequence,...editHistoryState(sequence.history)}};
      }
      return {status:404,body:{error:"Unknown editorial version route."}};
    }
    if(parts[0]!=="sequences")return {status:404,body:{error:"Unknown editorial route."}};
    if(parts.length===1&&request.method==="POST"){
      const input=editRecord(body,["id","label","sources","firstSourceId","width","height","expectedVersion"]);if(!Array.isArray(input.sources)||!input.sources.length||input.sources.length>16)editFail("Choose one to sixteen retained sources.");
      const bindings:EditSourceBinding[]=[];for(const raw of input.sources){const source=editRecord(raw,["jobId","sourceRevision"]);if(typeof source.sourceRevision!=="string")editFail("Inspect each original before creating the sequence.");bindings.push(await this.binding(project,editId(source.jobId),source.sourceRevision,refresh,request.signal));}
      const current=await refresh();if(!current)editFail("This project is no longer available.");for(const binding of bindings){assertEditBindingAvailable(binding,await queue.get(binding.owner.jobId));assertEditOriginalPermission(binding.source,current);}
      const library=await projects.createEditSequence(token,bindings.map(b=>b.source),editId(input.id),input.label as string,editId(input.firstSourceId),editNumber(input.width,2,1920,"Export width"),editNumber(input.height,2,1080,"Export height"),editNumber(input.expectedVersion,0,100000,"Editorial library version"),Date.now(),bindings);if(!library)editFail("This project is no longer available.");return {status:201,body:sequenceResponse(library.version,library.sequences.find(s=>s.id===input.id)!)};
    }
    if(parts[0]!=="sequences")return {status:404,body:{error:"Unknown editorial route."}};
    const sequence=project.editLibrary.sequences.find(s=>s.id===parts[1]);if(!sequence)return {status:404,body:{error:"Unknown editorial sequence."}};
    if(parts.length===3&&parts[2]==="script"&&request.method==="GET")return this.scriptService().handle(request,project.id,sequence.id,refresh);
    if(parts.length===6&&parts[2]==="sources"&&parts[4]==="frames"&&request.method==="GET")return this.originalService().handle(request,project.id,sequence.id,parts[3]!,Number(parts[5]),refresh);
    if(parts.length===3&&parts[2]==="sources"&&request.method==="POST"){
      const input=editRecord(body,["jobId","sourceRevision","expectedVersion","expectedHistoryRevision"]);if(typeof input.sourceRevision!=="string")editFail("Inspect the retained original before adding it.");const binding=await this.binding(project,editId(input.jobId),input.sourceRevision,refresh,request.signal),current=await refresh();if(!current)editFail("This project is no longer available.");assertEditBindingAvailable(binding,await queue.get(binding.owner.jobId));assertEditOriginalPermission(binding.source,current);request.signal.throwIfAborted();const library=await projects.admitEditSource(token,sequence.id,binding,editNumber(input.expectedVersion,0,100000,"Editorial library version"),input.expectedHistoryRevision as string);if(!library)editFail("This project is no longer available.");return {status:201,body:sequenceResponse(library.version,library.sequences.find(s=>s.id===sequence.id)!)};
    }
    if(parts[2]==="preview"){
      return this.previewService().handle(parts.slice(3),request,project.id,sequence.id,refresh,body);
    }
    if(parts.length===2&&request.method==="GET")return {status:200,body:sequenceResponse(project.editLibrary.version,sequence)};
    if(parts.length===2&&request.method==="PATCH"){
      const input=editRecord(body,["expectedVersion","expectedHistoryRevision","change"]),library=await projects.changeEditSequence(token,sequence.id,input.change as EditSequenceChange,editNumber(input.expectedVersion,0,100000,"Editorial library version"),input.expectedHistoryRevision as string);if(!library)editFail("This project is no longer available.");return {status:200,body:sequenceResponse(library.version,library.sequences.find(s=>s.id===sequence.id)!)};
    }
    if(parts.length!==3||parts[2]!=="renders"||!["GET","POST"].includes(request.method))return {status:404,body:{error:"Unknown editorial route."}};
    const input=body?editRecord(body,["idempotencyKey","generationApproved","historyRevision","sourceBindingsRevision","engineVersion","review"]):undefined;
    if(request.method==="POST"){
      if(!input||input.generationApproved!==true||typeof input.idempotencyKey!=="string"||!/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey))editFail("Review the edit and use a new request key before rendering.");const previous=(await queue.all()).find(j=>j.projectId===project.id&&j.idempotencyKey===project.id+":"+input.idempotencyKey);
      if(previous){if(previous.pictureEdit?.sequence.id!==sequence.id||previous.pictureEdit.requestHash!==contentHash(input))editFail("This request key belongs to a different editorial export.");return {status:202,body:{jobId:previous.id}};}
    }
    const bindings=await this.retainedBindings(project,sequence),timeline=editHistoryState(sequence.history).timeline,engineVersion=soundRuntimeRevision(),sourceBindingsRevision=contentHash(bindings.map(b=>b.revision)),resources=editStorageEstimate(timeline,bindings);
    if(request.method==="GET"){let unavailable:string|null=null;try{assertEditStorageEstimate(resources);}catch(error){unavailable=(error as Error).message;}return {status:200,body:{sequence:sequenceView(sequence),timelineRevision:timeline.revision,sourceBindingsRevision,sources:bindings.map(sourceView),engineVersion,resources,unavailable,costUsd:0,...(editCompositeReview(timeline)?{compositing:editCompositeReview(timeline)}:{}),review:{...editRenderReview(timeline),accepted:false},speechCuts:editSpeechCuts(timeline),unmeasuredAudioCuts:editUnmeasuredCuts(timeline),...(timeline.transitions?.length?{crossfades:editCrossfadeReview(timeline)}:{})}};}
    if(!input||input.historyRevision!==sequence.history.revision||input.sourceBindingsRevision!==sourceBindingsRevision||input.engineVersion!==engineVersion)editFail("The edit, retained sources or runtime changed. Review a fresh export quote.");
    const plan=createEditPlan(sequence,bindings,engineVersion,this.context.artifacts?"s3":"local",contentHash(input),input.review as unknown as EditRenderReview),current=await refresh();assertEditPermission(plan,current);if(current!.editLibrary.sequences.find(s=>s.id===sequence.id)?.history.revision!==sequence.history.revision)editFail("The edit changed during admission. Review a fresh export quote.");
    const decision=capacity.decide({tier:"free",runningForProject:(await queue.all()).filter(j=>j.projectId===project.id&&j.status==="running").length,requestedShots:1,sceneCount:1,monthSpendUsd:await ledger.monthSpend()+await ledger.reservedUsd()});if(decision.action==="reject")return {status:429,body:{error:decision.message,reason:decision.reason}};
    const origin=bindings[0]!.source.job,jobInput:JobInput={id:crypto.randomUUID(),idempotencyKey:project.id+":"+input.idempotencyKey,projectId:project.id,tier:"free",stage:"picture-edit",scriptVersion:origin.scriptVersion,scriptText:origin.scriptText,rightsAttestedAt:current!.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,queueAction:decision.action,queueReason:decision.reason,totalFrames:timeline.frames,costCapUsd:0,budgetReservedUsd:0,retryPolicy:{maxRetries:2,backoffMs:1000},timeoutMs:Number(process.env.HV_JOB_TIMEOUT_MS??30*60*1000),pictureEdit:plan};let job:Job;
    if(ledger instanceof PostgresCostLedger)job=await ledger.admit(project.id,jobInput,monthlyBudgetUsd);
    else{await ledger.reserve(jobInput.id,jobInput.stage,0,monthlyBudgetUsd);try{assertEditPermission(plan,await refresh());for(const binding of bindings)assertEditBindingAvailable(binding,await queue.get(binding.owner.jobId));job=await queue.enqueue(jobInput);}catch(error){await ledger.release(jobInput.id);throw error;}}
    return {status:202,body:{jobId:job.id}};
  }
  private async assemblyRenders(id:string,request:Request,project:Project,refresh:()=>Promise<Project|null>,body:Record<string,unknown>|undefined,signal:AbortSignal):Promise<{status:number;body:unknown}>{
    editId(id);if(!["GET","POST"].includes(request.method))return {status:405,body:{error:"Use GET to review or POST to render this assembly."}};
    if(new URL(request.url).search)editFail("Use the saved assembly render route without query fields.");
    const {ledger,capacity,monthlyBudgetUsd}=this.context,queue=this.context.store(project.id);
    const owner=async()=>{signal.throwIfAborted();const current=await assemblyRead(refresh(),signal);signal.throwIfAborted();if(this.closed||!current||current.id!==project.id||!Number.isFinite(Date.parse(current.deleteAfter))||Date.parse(current.deleteAfter)<=Date.now())editFail("This project is no longer available.");return current;};
    const current=await owner(),assembly=current.assemblyLibrary.assemblies.find(item=>item.id===id);if(!assembly)return {status:404,body:{error:"Unknown accepted assembly."}};
    const input=request.method==="POST"?editRecord(body,["idempotencyKey","generationApproved","assemblyRevision","sourceBindingsRevision","engineVersion","review"]):undefined;
    if(input){
      if(input.generationApproved!==true||typeof input.idempotencyKey!=="string"||!/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey))editFail("Review the accepted assembly and retain a request key before rendering.");
      const previous=(await assemblyRead(queue.all(),signal)).find(job=>job.projectId===project.id&&job.idempotencyKey===project.id+":"+input.idempotencyKey);
      if(previous){validateEditAssemblyJob(previous);if(previous.assemblyEdit?.assembly.id!==id||previous.assemblyEdit.requestHash!==contentHash(input))editFail("This request key belongs to a different assembly export.");assertEditAssemblyPermission(previous.assemblyEdit,await owner());return {status:202,body:{jobId:previous.id}};}
    }
    const bindings=await assemblyRead(this.retainedBindings(current,{sourceRevisions:assembly.plan.parent.sourceReceipts.map(receipt=>receipt.receiptRevision)}),signal),engineVersion=soundRuntimeRevision(),sourceBindingsRevision=contentHash(bindings.map(binding=>binding.revision)),resources=editAssemblyStorageEstimate(assembly.plan,bindings),review=editAssemblyRenderReview(assembly,bindings);
    const check=async()=>{await owner();for(const binding of bindings)assertEditBindingAvailable(binding,await assemblyRead(queue.get(binding.owner.jobId),signal));const refreshed=await owner();if(refreshed.assemblyLibrary.assemblies.find(item=>item.id===id)?.revision!==assembly.revision)editFail("The accepted assembly changed. Review it again.");for(const binding of bindings)assertEditOriginalPermission(binding.source,refreshed);signal.throwIfAborted();return refreshed;};
    if(!input){
      let unavailable:string|null=null;try{assertEditAssemblyStorageEstimate(resources);}catch(error){unavailable=(error as Error).message;}
      const jobs=await assemblyRead(Promise.all((await assemblyRead(queue.all(),signal)).filter(job=>job.projectId===project.id&&job.assemblyEdit?.assembly.id===id).map(job=>this.context.view(job,current))),signal);await check();
      const parent=assembly.plan.parent.timeline;
      return {status:200,body:{assembly:{id,label:assembly.label,revision:assembly.revision,frames:assembly.plan.frames,parentSequenceId:assembly.plan.parent.sequenceId},engineVersion,sourceBindingsRevision,resources,unavailable,costUsd:0,review:{...review,accepted:false},rangeReview:reviewEditAssembly(assembly.plan,assembly.purpose),boundaries:reviewEditAssemblyBoundaries(assembly.plan),parentReview:{review:editRenderReview(parent),speechCuts:editSpeechCuts(parent),unmeasuredAudioCuts:editUnmeasuredCuts(parent),crossfades:editCrossfadeReview(parent),compositing:editCompositeReview(parent)},jobs}};
    }
    if(input.assemblyRevision!==assembly.revision||input.sourceBindingsRevision!==sourceBindingsRevision||input.engineVersion!==engineVersion)editFail("The assembly, retained sources or runtime changed. Review a fresh export quote.");
    const plan=createEditAssemblyRenderPlan(assembly,bindings,engineVersion,this.context.artifacts?"s3":"local",contentHash(input),input.review as unknown as EditAssemblyRenderReview);
    assertEditAssemblyPermission(plan,await check());const decision=capacity.decide({tier:"free",runningForProject:(await assemblyRead(queue.all(),signal)).filter(job=>job.projectId===project.id&&job.status==="running").length,requestedShots:1,sceneCount:1,monthSpendUsd:await assemblyRead(ledger.monthSpend(),signal)+await assemblyRead(ledger.reservedUsd(),signal)});
    if(decision.action==="reject")return {status:429,body:{error:decision.message,reason:decision.reason}};
    const admitted=await check(),origin=bindings[0]!.source.job,inputJob:JobInput={id:crypto.randomUUID(),idempotencyKey:project.id+":"+input.idempotencyKey,projectId:project.id,tier:"free",stage:"assembly-edit",scriptVersion:origin.scriptVersion,scriptText:origin.scriptText,rightsAttestedAt:admitted.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,queueAction:decision.action,queueReason:decision.reason,totalFrames:assembly.plan.frames,costCapUsd:0,budgetReservedUsd:0,retryPolicy:{maxRetries:2,backoffMs:1000},timeoutMs:Number(process.env.HV_JOB_TIMEOUT_MS??30*60*1000),assemblyEdit:plan};let job:Job;
    if(ledger instanceof PostgresCostLedger)job=await ledger.admit(project.id,inputJob,monthlyBudgetUsd);
    else{await ledger.reserve(inputJob.id,inputJob.stage,0,monthlyBudgetUsd);try{assertEditAssemblyPermission(plan,await check());job=await queue.enqueue(inputJob);if(job.id!==inputJob.id)await ledger.release(inputJob.id);}catch(error){await ledger.release(inputJob.id);throw error;}}
    return {status:202,body:{jobId:job.id}};
  }
}
