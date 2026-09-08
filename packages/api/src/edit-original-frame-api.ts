import {mkdirSync,mkdtempSync,realpathSync,rmSync} from "node:fs";
import {join,sep} from "node:path";
import {EditPreviewSessions,type PreviewSessionIdentity} from "../../generator/src/edit-preview-sessions";
import {editOriginalPng} from "../../generator/src/edit-original-png";
import {contentHash} from "../../generator/src/capabilities";
import {editHistoryState} from "../../planner/src/edit-history";
import {editFail,editId,editNumber} from "../../planner/src/edit-timeline";
import {assertEditBindingAvailable,type EditSourceBinding} from "../../planner/src/edit-jobs";
import {assertEditOriginalPermission} from "../../planner/src/edit-sources";
import {PreviewResponses} from "./preview-response";
import type {Project} from "./index";
import type {Job} from "../../queue/src/index";
import type {DialogueArtifactReader} from "../../generator/src/dialogue-replacement";

interface Context {root:string;reader?:DialogueArtifactReader;job:(projectId:string,jobId:string)=>Promise<Job|undefined>|Job|undefined;bindings:(project:Project,sequenceId:string,sourceIds:Set<string>)=>Promise<EditSourceBinding[]>}
type Result=Response|{status:number;body:unknown};
async function waiting<T>(task:Promise<T>,signal:AbortSignal):Promise<T>{signal.throwIfAborted();let abort=()=>{};try{return await Promise.race([task,new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();})]);}finally{signal.removeEventListener("abort",abort);}}
export class EditOriginalFrameApi {
  readonly #sessions:EditPreviewSessions;readonly #responses=new PreviewResponses(2,60000,"source-png");readonly #identities=new Map<string,PreviewSessionIdentity>();readonly #operations=new Set<Promise<Result>>();readonly #root:string;readonly #directory:string;#closed=false;
  constructor(readonly context:Context){mkdirSync(context.root,{recursive:true});this.#root=realpathSync(context.root);this.#directory=mkdtempSync(join(this.#root,".edit-original-frames-"));this.#sessions=new EditPreviewSessions(context.root,context.reader,{sessions:2,perProject:1,concurrency:1});}
  async handle(request:Request,projectId:string,sequenceId:string,sourceId:string,sourceFrame:number,refresh:()=>Promise<Project|null>):Promise<Result>{
    if(this.#closed)editFail("Original frame service stopped. Reopen the mask editor.");const task=this.#handle(request,projectId,sequenceId,sourceId,sourceFrame,refresh);this.#operations.add(task);try{return await task;}finally{this.#operations.delete(task);}
  }
  async #handle(request:Request,projectId:string,sequenceId:string,sourceId:string,sourceFrame:number,refresh:()=>Promise<Project|null>):Promise<Result>{
    const lease=this.#responses.open(request);let streaming=false;
    try{
      editId(sourceId);const query=new URL(request.url).searchParams,historyRevision=query.get("historyRevision");if([...query.keys()].some(key=>key!=="historyRevision"||query.getAll(key).length!==1)||!historyRevision||!/^[a-f0-9]{64}$/.test(historyRevision))editFail("Choose the saved history for this original frame.");
      const guard=async(signal:AbortSignal|null=lease.signal)=>{signal?.throwIfAborted();const project=signal?await waiting(refresh(),signal):await refresh();if(!project||project.id!==projectId||Date.parse(project.deleteAfter)<=Date.now())editFail("This project is no longer available.");const sequence=project.editLibrary.sequences.find(item=>item.id===sequenceId);if(!sequence||sequence.history.revision!==historyRevision)editFail("The saved cut changed. Reopen this original frame.");const source=editHistoryState(sequence.history).timeline.sources.find(item=>item.id===sourceId);if(!source)editFail("Choose an original admitted to this edit branch.");editNumber(sourceFrame,0,source.frames-1,"Original source frame");return {project,source};};
      const {project,source}=await guard(),bindings=await waiting(this.context.bindings(project,sequenceId,new Set([sourceId])),lease.signal);if(bindings.length!==1)editFail("This original is no longer retained.");
      const active=new Set(this.#sessions.activeIds);for(const [owner,identity]of this.#identities)if(!active.has(identity.id))this.#identities.delete(owner);
      const scopeRevision=contentHash({sourceId,sourceRevision:source.revision,bindingRevision:bindings[0]!.revision}),identity:PreviewSessionIdentity={id:"original-"+contentHash({projectId,sequenceId,historyRevision,scopeRevision}),projectId,sequenceId,historyRevision,scopeRevision},previous=this.#identities.get(projectId);
      if(previous&&previous.id!==identity.id)this.#sessions.release(previous);this.#identities.set(projectId,identity);
      const permission=async(binding:EditSourceBinding)=>{const current=await guard(null);assertEditOriginalPermission(binding.source,current.project);assertEditBindingAvailable(binding,await this.context.job(projectId,binding.owner.jobId));};
      const status=await this.#sessions.start(identity,bindings,permission,lease.signal);if(status.state==="failed"){this.#sessions.release(identity);editFail(status.error??"This original could not be prepared.");}if(status.state!=="ready")return {status:202,body:{historyRevision,state:status.state,completedSources:status.completedSources,totalSources:status.totalSources}};
      return await this.#sessions.withSources(identity,async(sources,access,signal)=>{
        const prepared=sources.find(item=>item.source.id===sourceId);if(!prepared||prepared.source.revision!==source.revision)editFail("The prepared original changed.");
        const raw=await prepared.rawFrame(sourceFrame,join(this.#directory,crypto.randomUUID()),access,signal),png=await editOriginalPng(raw,this.#root,join(this.#directory,crypto.randomUUID()),access,signal);await access();await guard();
        const response=lease.response(png.bytes,png.sha256,async()=>{await guard();await access();},signal,{historyRevision,sourceId,sourceRevision:source.revision,sourceFrame,sourceSha256:raw.sourceSha256,width:raw.width,height:raw.height});streaming=true;return response;
      },lease.signal);
    }finally{if(!streaming)lease.finish();}
  }
  async close(){if(this.#closed)return;this.#closed=true;this.#responses.close();await this.#sessions.close();await Promise.allSettled(this.#operations);if(!this.#directory.startsWith(this.#root+sep)||realpathSync(this.#directory)!==this.#directory)editFail("Original frame cleanup escaped its workspace.");rmSync(this.#directory,{recursive:true,force:true});}
}
