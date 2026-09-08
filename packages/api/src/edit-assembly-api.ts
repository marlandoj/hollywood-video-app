import {contentHash} from "../../generator/src/capabilities";
import {reviewEditAssembly} from "../../planner/src/edit-assembly-review";
import {reviewEditAssemblyBoundaries} from "../../planner/src/edit-assembly-boundaries";
import {compileEditScriptSource} from "../../planner/src/edit-script-source";
import {projectEditAssemblyScript} from "../../planner/src/edit-assembly-script";
import {editAssemblyStorageEstimate,assertEditAssemblyStorageEstimate} from "../../planner/src/edit-assembly-resources";
import {deriveEditAssemblyParent,assertEditAssemblyCarriers,validateEditAssemblyExpected,type EditAssemblyCarrier,type EditAssemblyExpected,type EditAssemblyRevisionExpected} from "../../planner/src/edit-assembly-parent";
import type {EditAssemblyParent} from "../../planner/src/edit-assembly-types";
import type {EditAssemblyProposal,AcceptedEditAssembly,EditAssemblyProposalInput,EditAssemblyProposalRevision} from "../../planner/src/edit-assembly-proposals";
import {createEditAssemblyProposal,reviseEditAssemblyProposal,acceptEditAssemblyProposal} from "../../planner/src/edit-assembly-proposals";
import type {EditSourceBinding} from "../../planner/src/edit-jobs";
import type {Job} from "../../queue/src/index";
import {editFail,editId,editRecord} from "../../planner/src/edit-timeline";
import type {Project,ProjectService} from "./index";
import type {PostgresProjectService} from "../../storage/src/projects";

interface Context {
  projects:ProjectService|PostgresProjectService;
  job:(projectId:string,id:string)=>Promise<Job|undefined>|Job|undefined;
  bindings:(project:Project,parent:EditAssemblyParent)=>Promise<EditSourceBinding[]>;
}
interface Result {status:number;body:unknown}
type Item=EditAssemblyProposal|AcceptedEditAssembly;
const summary=(item:Item)=>({id:item.id,label:item.label,purpose:item.purpose,revision:item.revision,planRevision:item.plan.revision,frames:item.plan.frames,parentSequenceId:item.plan.parent.sequenceId,parentHistoryRevision:item.plan.parent.historyRevision,...("acceptedAt"in item?{acceptedAt:item.acceptedAt,proposalId:item.proposalId,proposalRevision:item.proposalRevision}:{createdAt:item.createdAt})});
function response(status:number,body:unknown):Result {if(Buffer.byteLength(JSON.stringify(body),"utf8")>8*1024**2)editFail("The assembly response exceeds 8 MiB. Use a smaller parent or fewer ranges.");return {status,body};}
function revision(value:unknown):string {if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))editFail("Use the exact reviewed assembly revision.");return value;}
async function readWhileActive<T>(task:Promise<T>,signal:AbortSignal):Promise<T>{
  signal.throwIfAborted();let abort=()=>{};
  try{return await Promise.race([task,new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();})]);}
  finally{signal.removeEventListener("abort",abort);}
}
function view(item:Item,libraryVersion:number,selected:EditAssemblyCarrier[]){
  const parent=item.plan.parent,bindings=parent.sourceReceipts.map(receipt=>selected.find(carrier=>carrier.binding.source.revision===receipt.receiptRevision)!.binding),resources=editAssemblyStorageEstimate(item.plan,bindings);
  let unavailable:string|null=null;try{assertEditAssemblyStorageEstimate(resources);}catch(error){unavailable=(error as Error).message;}
  const data={libraryVersion,item:{...summary(item),ranges:item.plan.ranges,parent:{sequenceId:parent.sequenceId,historyRevision:parent.historyRevision,timelineRevision:parent.timeline.revision,frames:parent.timeline.frames,width:parent.timeline.width,height:parent.timeline.height,sourceReceipts:parent.sourceReceipts},...("target"in item?{target:item.target}:{})},review:reviewEditAssembly(item.plan,item.purpose),boundaries:reviewEditAssemblyBoundaries(item.plan),sourceBindingsRevision:contentHash(bindings.map(binding=>binding.revision)),resources,unavailable,costUsd:0};
  response(200,data);return data;
}

/** Owner metadata workflow. Media admission and continuous preview use separate explicit contracts. */
export class EditAssemblyApi {
  readonly #controller=new AbortController();readonly #operations=new Set<Promise<Result>>();#closed=false;
  constructor(readonly context:Context){}
  async handle(parts:string[],request:Request,projectId:string,token:string,refresh:()=>Promise<Project|null>,body?:Record<string,unknown>):Promise<Result>{
    if(this.#closed)editFail("Assembly service stopped. Reopen the editor.");if(this.#operations.size>=2)editFail("Two assembly requests are running. Retry after they finish.");
    const signal=AbortSignal.any([request.signal,this.#controller.signal,AbortSignal.timeout(30000)]),task=this.#handle(parts,request,projectId,token,refresh,body,signal);
    this.#operations.add(task);try{return await task;}finally{this.#operations.delete(task);}
  }
  async #handle(parts:string[],request:Request,projectId:string,token:string,refresh:()=>Promise<Project|null>,body:Record<string,unknown>|undefined,signal:AbortSignal):Promise<Result>{
    editId(projectId);if(new URL(request.url).search)editFail("Use the saved assembly route without query fields.");
    const owner=async()=>{signal.throwIfAborted();const project=await readWhileActive(refresh(),signal);signal.throwIfAborted();if(!project||project.id!==projectId||!Number.isFinite(Date.parse(project.deleteAfter))||Date.parse(project.deleteAfter)<=Date.now())editFail("This project is no longer available.");return project;};
    const initial=await owner();
    const carriers=async(parent:EditAssemblyParent):Promise<EditAssemblyCarrier[]>=>{
      const project=await owner(),bindings=await readWhileActive(this.context.bindings(project,parent),signal),selected:EditAssemblyCarrier[]=[];
      for(const binding of bindings){signal.throwIfAborted();selected.push({binding,current:await readWhileActive(Promise.resolve(this.context.job(projectId,binding.owner.jobId)),signal)});}
      assertEditAssemblyCarriers(parent,await owner(),selected);return selected;
    };
    const detail=async(item:Item,libraryVersion:number)=>{
      const selected=await carriers(item.plan.parent),project=await owner();
      if(project.assemblyLibrary.version!==libraryVersion)editFail("The assembly library changed. Reload this proposal.");
      const current="acceptedAt"in item?project.assemblyLibrary.assemblies.find(a=>a.id===item.id):project.assemblyLibrary.proposals.find(p=>p.id===item.id);
      if(current?.revision!==item.revision)editFail("The saved assembly changed. Reload its review.");
      const result=view(item,libraryVersion,selected);
      // Check availability again after projection/capacity work, before returning retained metadata.
      for(const carrier of selected)carrier.current=await readWhileActive(Promise.resolve(this.context.job(projectId,carrier.binding.owner.jobId)),signal);
      const final=await owner(),retained="acceptedAt"in item?final.assemblyLibrary.assemblies.find(a=>a.id===item.id):final.assemblyLibrary.proposals.find(p=>p.id===item.id);
      assertEditAssemblyCarriers(item.plan.parent,final,selected);if(final.assemblyLibrary.version!==libraryVersion||retained?.revision!==item.revision)editFail("The assembly changed while loading its review. Reload it.");return result;
    };
    if(!parts.length&&request.method==="GET")return response(200,{libraryVersion:initial.assemblyLibrary.version,proposals:initial.assemblyLibrary.proposals.map(summary),assemblies:initial.assemblyLibrary.assemblies.map(summary)});
    if(parts.length===1&&parts[0]==="proposals"&&request.method==="POST"){
      const input=editRecord(body,["sequenceId","input","expected"]),sequenceId=editId(input.sequenceId),expected=input.expected as EditAssemblyExpected;validateEditAssemblyExpected(expected);
      const parent=deriveEditAssemblyParent(projectId,initial.editLibrary,sequenceId,expected.historyRevision),selected=await carriers(parent);signal.throwIfAborted();
      const candidate=createEditAssemblyProposal(initial.assemblyLibrary,input.input as EditAssemblyProposalInput,parent,expected.libraryVersion);view(candidate.proposals.at(-1)!,candidate.version,selected);
      const library=await this.context.projects.createAssemblyProposal(token,sequenceId,input.input as EditAssemblyProposalInput,expected,selected);
      if(!library)editFail("This project is no longer available.");const proposal=library.proposals.find(p=>p.id===(input.input as EditAssemblyProposalInput).id)!;
      return response(201,await detail(proposal,library.version));
    }
    if(parts.length<2||!["proposals","accepted"].includes(parts[0]!))return response(404,{error:"Unknown assembly route."});
    const id=editId(parts[1]),item=parts[0]==="proposals"?initial.assemblyLibrary.proposals.find(p=>p.id===id):initial.assemblyLibrary.assemblies.find(a=>a.id===id);
    if(!item)return response(404,{error:"Unknown saved assembly."});
    if(parts.length===3&&parts[2]==="script"&&request.method==="GET"){
      const selected=await carriers(item.plan.parent),sources=[];
      for(const receipt of item.plan.parent.sourceReceipts){
        signal.throwIfAborted();sources.push(compileEditScriptSource(selected.find(carrier=>carrier.binding.source.revision===receipt.receiptRevision)!.binding.source));
        await new Promise<void>(resolve=>setImmediate(resolve));
      }
      signal.throwIfAborted();const navigation=projectEditAssemblyScript(item.id,item.revision,item.plan,sources);
      for(const carrier of selected)carrier.current=await readWhileActive(Promise.resolve(this.context.job(projectId,carrier.binding.owner.jobId)),signal);
      const final=await owner(),retained=parts[0]==="proposals"?final.assemblyLibrary.proposals.find(proposal=>proposal.id===id):final.assemblyLibrary.assemblies.find(assembly=>assembly.id===id);
      assertEditAssemblyCarriers(item.plan.parent,final,selected);if(final.assemblyLibrary.version!==initial.assemblyLibrary.version||retained?.revision!==item.revision)editFail("The assembly changed while loading its screenplay. Reload it.");
      return response(200,navigation);
    }
    if(parts.length===2&&request.method==="GET")return response(200,await detail(item,initial.assemblyLibrary.version));
    if(parts[0]!=="proposals")return response(404,{error:"Unknown accepted assembly route."});
    if(parts.length===2&&request.method==="PATCH"){
      const input=editRecord(body,["input","expected"]),expected=input.expected as EditAssemblyRevisionExpected;validateEditAssemblyExpected(expected,true);
      const parent=deriveEditAssemblyParent(projectId,initial.editLibrary,item.plan.parent.sequenceId,expected.historyRevision),selected=await carriers(parent);signal.throwIfAborted();
      const candidate=reviseEditAssemblyProposal(initial.assemblyLibrary,id,input.input as EditAssemblyProposalRevision,parent,expected.libraryVersion,expected.proposalRevision);view(candidate.proposals.find(proposal=>proposal.id===id)!,candidate.version,selected);
      const library=await this.context.projects.reviseAssemblyProposal(token,id,input.input as EditAssemblyProposalRevision,expected,selected);if(!library)editFail("This project is no longer available.");
      return response(200,await detail(library.proposals.find(p=>p.id===id)!,library.version));
    }
    if(parts.length===3&&parts[2]==="accept"&&request.method==="POST"){
      const input=editRecord(body,["proposalRevision","assemblyId","expected","reviewRevision","boundariesRevision","sourceBindingsRevision","accepted"]);
      const proposalRevision=revision(input.proposalRevision),assemblyId=editId(input.assemblyId),expected=input.expected as EditAssemblyExpected;validateEditAssemblyExpected(expected);
      const previous=initial.assemblyLibrary.assemblies.find(a=>a.id===assemblyId&&a.proposalId===id&&a.proposalRevision===proposalRevision),reviewed:Item=previous??item;
      if(input.accepted!==true||(!previous&&item.revision!==proposalRevision)||revision(input.reviewRevision)!==reviewEditAssembly(reviewed.plan,reviewed.purpose).revision||revision(input.boundariesRevision)!==reviewEditAssemblyBoundaries(reviewed.plan).revision)editFail("Review the current ranges and sound boundaries before saving this assembly.");
      const selected=await carriers(reviewed.plan.parent),bindings=reviewed.plan.parent.sourceReceipts.map(receipt=>selected.find(carrier=>carrier.binding.source.revision===receipt.receiptRevision)!.binding);
      revision(input.sourceBindingsRevision);if(!previous&&input.sourceBindingsRevision!==contentHash(bindings.map(binding=>binding.revision)))editFail("The retained source carrier changed. Review this assembly again.");
      const parent=previous?.plan.parent??deriveEditAssemblyParent(projectId,initial.editLibrary,reviewed.plan.parent.sequenceId,expected.historyRevision),candidate=acceptEditAssemblyProposal(initial.assemblyLibrary,id,proposalRevision,assemblyId,parent,expected.libraryVersion);view(candidate.assembly,candidate.library.version,selected);
      signal.throwIfAborted();const result=await this.context.projects.acceptAssemblyProposal(token,id,proposalRevision,assemblyId,expected,selected);if(!result)editFail("This project is no longer available.");
      return response(result.replayed?200:201,{...await detail(result.assembly,result.library.version),replayed:result.replayed});
    }
    return response(404,{error:"Unknown assembly operation."});
  }
  async close():Promise<void>{if(this.#closed)return;this.#closed=true;this.#controller.abort(new Error("Assembly service stopped."));await Promise.allSettled(this.#operations);}
}
