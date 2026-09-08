import type {Project,ProjectService} from "./index";
import type {PostgresProjectService} from "../../storage/src/projects";
import type {Job} from "../../queue/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {createProviderPlan,withAnchorStoryboard} from "../../generator/src/catalog";
import {currentCasting} from "../../planner/src/casting";
import {currentDirection} from "../../planner/src/direction";
import {renderShots} from "../../planner/src/shot-reuse";
import {editFail,editId,editNumber,editRecord,type EditOperation} from "../../planner/src/edit-timeline";
import type {EditLibrary} from "../../planner/src/edit-library";
import {assertEditBindingAvailable,type EditSourceBinding} from "../../planner/src/edit-jobs";
import {assertEditOriginalPermission} from "../../planner/src/edit-sources";
import {deriveEditAssemblyParent,assertEditAssemblyCarriers,type EditAssemblyCarrier} from "../../planner/src/edit-assembly-parent";
import {compileLivingScriptPatch} from "../../planner/src/living-script-patch";
import {compileLivingScriptCandidate} from "../../planner/src/living-script-candidate";
import {createLivingScriptProposal,type LivingScriptProposal,type LivingScriptProposalRequest} from "../../planner/src/living-script-proposals";
import {compileLivingScriptSourceMap} from "../../planner/src/living-script-source-map";
import {compileLivingScriptRecut,type LivingScriptRecutInput} from "../../planner/src/living-script-recut";
import {compileLivingScriptAcceptance,type LivingScriptAcceptanceRequest} from "../../planner/src/living-script-acceptance";
import {assertLivingScriptGenerationCurrent} from "../../planner/src/living-script-jobs";
import {livingScriptRead} from "./living-script-read";

interface Context {
  projects:ProjectService|PostgresProjectService;
  job:(projectId:string,id:string)=>Promise<Job|undefined>|Job|undefined;
  bindings:(project:Project,library:EditLibrary,revisions:string[])=>Promise<EditSourceBinding[]>;
  inspect:(project:Project,jobId:string,revision:unknown,refresh:()=>Promise<Project|null>,signal:AbortSignal)=>Promise<EditSourceBinding>;
}
interface Result {status:number;body:unknown}
const same=(a:unknown,b:unknown)=>contentHash(a)===contentHash(b);
const proposalSummary=(proposal:LivingScriptProposal)=>({id:proposal.request.id,label:proposal.request.label,revision:proposal.revision,createdAt:proposal.createdAt,sequenceId:proposal.request.sequenceId,beforeVersion:proposal.request.patch.before.version,proposedVersion:proposal.request.patch.after.version,replacement:proposal.request.patch.replacement});
function response(status:number,body:unknown):Result {if(Buffer.byteLength(JSON.stringify(body),"utf8")>8*1024**2)editFail("The complete screenplay review exceeds 8 MiB. Use a smaller saved cut.");return {status,body};}
function hash(value:unknown):string {if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))editFail("Retain the exact screenplay review revision.");return value;}
/** Proposal and recut reviews retain their full request for reload and exact atomic acceptance. */
export class LivingScriptApi {
  readonly #controller=new AbortController();readonly #operations=new Set<Promise<Result>>();#closed=false;
  constructor(readonly context:Context){}
  async handle(parts:string[],request:Request,projectId:string,token:string,refresh:()=>Promise<Project|null>,body?:Record<string,unknown>):Promise<Result>{
    if(this.#closed)editFail("Screenplay review stopped. Reopen the editor.");if(this.#operations.size>=2)editFail("Two screenplay reviews are running. Retry when they finish.");
    const signal=AbortSignal.any([request.signal,this.#controller.signal,AbortSignal.timeout(30000)]),task=this.#handle(parts,request,projectId,token,refresh,body,signal);
    this.#operations.add(task);try{return await task;}finally{this.#operations.delete(task);}
  }
  async #handle(parts:string[],request:Request,projectId:string,token:string,refresh:()=>Promise<Project|null>,body:Record<string,unknown>|undefined,signal:AbortSignal):Promise<Result>{
    editId(projectId);if(new URL(request.url).search)editFail("Use the saved screenplay review route without query fields.");
    const read=<T>(task:()=>Promise<T>|T)=>livingScriptRead(task,signal);
    const owner=async()=>{const project=await read(refresh);signal.throwIfAborted();if(!project||project.id!==projectId||!Number.isFinite(Date.parse(project.deleteAfter))||Date.parse(project.deleteAfter)<=Date.now())editFail("This project is no longer available.");return project;};
    const initial=await owner();
    const carriers=async(library:EditLibrary,revisions:string[])=>{
      const project=await owner(),bindings=await read(()=>this.context.bindings(project,library,revisions)),selected:EditAssemblyCarrier[]=[];
      for(const binding of bindings){selected.push({binding,current:await read(()=>this.context.job(projectId,binding.owner.jobId))});signal.throwIfAborted();}
      const current=await owner();for(const carrier of selected){assertEditBindingAvailable(carrier.binding,carrier.current);assertEditOriginalPermission(carrier.binding.source,current);}return selected;
    };
    const proposalCarriers=async(proposal:LivingScriptProposal)=>{
      const selected=await carriers(proposal.editorial,proposal.impact.parent.sourceReceipts.map(source=>source.receiptRevision));assertEditAssemblyCarriers(proposal.impact.parent,await owner(),selected);return selected;
    };
    if(!parts.length&&request.method==="GET")return response(200,{proposalVersion:initial.livingScriptProposals.version,acceptanceVersion:initial.livingScriptAcceptances.version,proposals:initial.livingScriptProposals.proposals.map(proposalSummary),acceptances:initial.livingScriptAcceptances.records.map(record=>record.acceptance)});
    if(parts.length===1&&parts[0]==="quote"&&request.method==="POST"){
      const asked=editRecord(body,["id","label","sequenceId","historyRevision","editorialRevision","navigationRevision","sourceRevision","entryId","indexRevision","replacement"]),sequenceId=editId(asked.sequenceId),parent=deriveEditAssemblyParent(projectId,initial.editLibrary,sequenceId,hash(asked.historyRevision));
      if(hash(asked.editorialRevision)!==initial.editLibrary.revision)editFail("The saved cuts changed. Reload the screenplay before editing.");
      const source=initial.editLibrary.sources.find(source=>source.revision===hash(asked.sourceRevision));if(!source||!parent.sourceReceipts.some(item=>item.receiptRevision===source.revision)||!['animatic','final'].includes(source.job.stage))editFail("Choose a direct film source from this saved cut.");
      const selected=await carriers(initial.editLibrary,parent.sourceReceipts.map(source=>source.receiptRevision));assertEditAssemblyCarriers(parent,await owner(),selected);
      const script=initial.versions.latest();if(!script)editFail("Retain the current screenplay before editing a source line.");
      const patch=compileLivingScriptPatch(source,{entryId:hash(asked.entryId),indexRevision:hash(asked.indexRevision),currentScript:{version:script.version,text:script.text},replacement:asked.replacement as string}),baseline={casting:currentCasting(projectId,initial.castingHistory),direction:currentDirection(projectId,initial.directionHistory)},stage=source.job.stage as "animatic"|"final",tier=source.job.tier;
      const shots=renderShots({...source.job,casting:baseline.casting,direction:baseline.direction}),cap=stage==="animatic"?Number(process.env.HV_ANIMATIC_COST_CAP_USD??5):Number(process.env.HV_COST_CAP_PER_SHOT_USD??5),providerPlan=withAnchorStoryboard(createProviderPlan(stage,cap,source.job.providerPlan!.requirements),shots.some(shot=>shot.direction?.frameAnchors&&(stage==="animatic"||shot.direction.frameAnchors.fallback==="storyboard")));
      const settings=compileLivingScriptCandidate(source,patch,{projectId,currentScript:{version:script.version,text:script.text},baseline,stage,tier,providerPlan});
      const proposed:LivingScriptProposalRequest={id:editId(asked.id),label:asked.label as string,sequenceId,historyRevision:parent.historyRevision,editorialRevision:initial.editLibrary.revision,navigationRevision:hash(asked.navigationRevision),patch,candidate:settings.candidateInputs,baseline};
      const reviewed=createLivingScriptProposal(initial.livingScriptProposals,projectId,initial.editLibrary,proposed,initial.livingScriptProposals.version),current=await owner();
      if(current.editLibrary.revision!==initial.editLibrary.revision||!same(current.versions.latest(),script)||!same(currentCasting(projectId,current.castingHistory),baseline.casting)||!same(currentDirection(projectId,current.directionHistory),baseline.direction))editFail("The screenplay, cut or performance settings changed during review. Reload this line.");
      assertEditAssemblyCarriers(parent,current,await carriers(initial.editLibrary,parent.sourceReceipts.map(source=>source.receiptRevision)));
      return response(200,{request:proposed,expectedVersion:initial.livingScriptProposals.version,impact:reviewed.proposal.impact,reviewRevision:contentHash({request:proposed,impact:reviewed.proposal.impact}),settings,accepted:false});
    }
    if(parts.length===1&&parts[0]==="proposals"&&request.method==="POST"){
      const asked=editRecord(body,["request","expectedVersion","reviewRevision","accepted"]),proposed=asked.request as LivingScriptProposalRequest,expectedVersion=editNumber(asked.expectedVersion,0,100000,"Screenplay proposal version"),reviewed=createLivingScriptProposal(initial.livingScriptProposals,projectId,initial.editLibrary,proposed,expectedVersion);
      if(asked.accepted!==true||hash(asked.reviewRevision)!==contentHash({request:proposed,impact:reviewed.proposal.impact}))editFail("Review the exact line, performance bindings and cut impact before saving this proposal.");
      const selected=await proposalCarriers(reviewed.proposal);signal.throwIfAborted();const saved=await this.context.projects.createLivingScriptProposal(token,proposed,expectedVersion,selected);if(!saved)editFail("This project is no longer available.");
      return response(saved.replayed?200:201,{proposal:saved.proposal,proposalVersion:saved.library.version,replayed:saved.replayed});
    }
    if(parts.length<2||parts[0]!=="proposals")return response(404,{error:"Unknown screenplay review route."});
    const id=editId(parts[1]),proposal=initial.livingScriptProposals.proposals.find(item=>item.request.id===id);if(!proposal)return response(404,{error:"Unknown saved screenplay proposal."});
    if(parts.length===2&&request.method==="GET"){
      let unavailable:string|null=null;try{await proposalCarriers(proposal);}catch(error){signal.throwIfAborted();unavailable=(error as Error).message;}
      await owner();return response(200,{proposal,proposalVersion:initial.livingScriptProposals.version,acceptanceVersion:initial.livingScriptAcceptances.version,acceptance:initial.livingScriptAcceptances.records.find(record=>record.proposalRevision===proposal.revision)?.acceptance??null,unavailable});
    }
    if(parts.length===4&&parts[2]==="sources"&&request.method==="GET"){
      const job=await read(()=>this.context.job(projectId,editId(parts[3])));if(!job?.livingScript||job.projectId!==projectId||job.livingScript.request.role!=="render"||!same(job.livingScript.proposal,proposal))editFail("Choose the completed revised film from this screenplay proposal.");
      const check=async()=>{const carrier=await read(()=>this.context.job(projectId,job.livingScript!.binding.owner.jobId)),current=await owner();assertLivingScriptGenerationCurrent(job.livingScript!,current,carrier);return current;};
      const current=await check(),binding=await read(()=>this.context.inspect(current,job.id,undefined,()=>read(refresh),signal)),original=proposal.editorial.sources.find(source=>source.revision===proposal.request.patch.receiptRevision)!,sourceMap=compileLivingScriptSourceMap(original,proposal.request.patch,proposal.impact.generation,binding.source);
      await check();await proposalCarriers(proposal);return response(200,{generated:binding.source.facts,sourceRevision:binding.source.revision,sourceMap,parent:proposal.impact.parent.timeline,warnings:sourceMap.warnings});
    }
    if(parts.length===3&&parts[2]==="recut"&&request.method==="POST"){
      const asked=editRecord(body,["generatedJobId","operations","newSequenceId","acceptanceId","name"]),generatedJob=await read(()=>this.context.job(projectId,editId(asked.generatedJobId)));
      if(!generatedJob?.livingScript||generatedJob.projectId!==projectId||generatedJob.livingScript.request.role!=="render"||!same(generatedJob.livingScript.proposal,proposal))editFail("Choose the completed revised film from this exact screenplay proposal.");
      const check=async()=>{const carrier=await read(()=>this.context.job(projectId,generatedJob.livingScript!.binding.owner.jobId)),current=await owner();assertLivingScriptGenerationCurrent(generatedJob.livingScript!,current,carrier);return current;};
      const inspected=await check(),generated=(await read(()=>this.context.inspect(inspected,generatedJob.id,undefined,()=>read(refresh),signal))).source,selected=await proposalCarriers(proposal),original=proposal.editorial.sources.find(source=>source.revision===proposal.request.patch.receiptRevision)!;
      const sourceMap=compileLivingScriptSourceMap(original,proposal.request.patch,proposal.impact.generation,generated),input:LivingScriptRecutInput={projectId,library:proposal.editorial,sequenceId:proposal.request.sequenceId,historyRevision:proposal.request.historyRevision,patch:proposal.request.patch,candidate:proposal.request.candidate,navigationRevision:proposal.request.navigationRevision,generated,sourceMap,operations:asked.operations as EditOperation[],newSequenceId:editId(asked.newSequenceId)},recut=compileLivingScriptRecut(input);
      const acceptance:LivingScriptAcceptanceRequest={id:editId(asked.acceptanceId),name:asked.name as string,reviewRevision:recut.revision,baseline:proposal.request.baseline,recutInput:input,recut},current=await check(),script=current.versions.latest()!;
      compileLivingScriptAcceptance({projectId,editorial:current.editLibrary,currentScript:{version:script.version,text:script.text},currentCasting:currentCasting(projectId,current.castingHistory),currentDirection:currentDirection(projectId,current.directionHistory)},acceptance);
      assertEditAssemblyCarriers(proposal.impact.parent,current,selected);return response(200,{request:acceptance,expectedVersion:current.livingScriptAcceptances.version,proposalRevision:proposal.revision,sourceMap,recut,accepted:false});
    }
    if(parts.length===3&&parts[2]==="accept"&&request.method==="POST"){
      const asked=editRecord(body,["request","expectedVersion","proposalRevision","accepted"]);if(asked.accepted!==true||hash(asked.proposalRevision)!==proposal.revision)editFail("Compare and accept the exact revised screenplay and cut together.");
      const acceptance=asked.request as LivingScriptAcceptanceRequest;
      if(!acceptance?.recutInput?.generated||!same(acceptance.recutInput.patch,proposal.request.patch)||!same(acceptance.recutInput.candidate,proposal.request.candidate))editFail("The acceptance request belongs to another screenplay proposal.");
      const generated=acceptance.recutInput.generated,library={...acceptance.recutInput.library,sources:[...acceptance.recutInput.library.sources.filter(source=>source.revision!==generated.revision),generated]},selected=await carriers(library,acceptance.recut.sourceReceipts.map(item=>item.receiptRevision));
      if(generated.job.livingScript?.request.role!=="render"||!same(generated.job.livingScript.proposal,proposal))editFail("Accept only the reviewed pending film from this exact screenplay proposal.");
      signal.throwIfAborted();const result=await this.context.projects.acceptLivingScriptProposal(token,id,proposal.revision,acceptance,editNumber(asked.expectedVersion,0,100000,"Screenplay acceptance version"),selected);if(!result)editFail("This project is no longer available.");
      return response(result.replayed?200:201,{acceptance:result.record.acceptance,acceptanceVersion:result.library.version,replayed:result.replayed});
    }
    return response(404,{error:"Unknown screenplay proposal operation."});
  }
  async close():Promise<void>{this.#closed=true;this.#controller.abort(new Error("Screenplay review service stopped."));await Promise.allSettled(this.#operations);}
}
