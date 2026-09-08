import {contentHash} from "../../generator/src/capabilities";
import {editHistoryState} from "../../planner/src/edit-history";
import {editFail,editId} from "../../planner/src/edit-timeline";
import {assertEditBindingAvailable,type EditSourceBinding} from "../../planner/src/edit-jobs";
import {assertEditOriginalPermission} from "../../planner/src/edit-sources";
import {compileEditScriptSource} from "../../planner/src/edit-script-source";
import {projectEditScriptNavigation} from "../../planner/src/edit-script-projection";
import type {EditScriptNavigation} from "../../planner/src/edit-script-types";
import type {Project} from "./index";
import type {Job} from "../../queue/src/index";

interface Context {job:(projectId:string,jobId:string)=>Promise<Job|undefined>|Job|undefined;bindings:(project:Project,sequenceId:string,sourceIds:Set<string>)=>Promise<EditSourceBinding[]>}
type Result={status:number;body:EditScriptNavigation};
async function waiting<T>(task:Promise<T>,signal:AbortSignal):Promise<T>{signal.throwIfAborted();let abort=()=>{};try{return await Promise.race([task,new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();})]);}finally{signal.removeEventListener("abort",abort);}}
/** Owner-only metadata projection; this service never decodes media or admits a job. */
export class EditScriptApi {
  readonly #controller=new AbortController();readonly #operations=new Set<Promise<Result>>();#closed=false;
  constructor(readonly context:Context){}
  async handle(request:Request,projectId:string,sequenceId:string,refresh:()=>Promise<Project|null>):Promise<Result>{
    if(this.#closed)editFail("Script navigation service stopped. Reopen the editor.");if(this.#operations.size>=2)editFail("Script navigation is busy. Retry after the current requests finish.");
    const active=AbortSignal.any([request.signal,this.#controller.signal,AbortSignal.timeout(30000)]),task=this.#handle(request,projectId,sequenceId,refresh,active);this.#operations.add(task);try{return await task;}finally{this.#operations.delete(task);}
  }
  async #handle(request:Request,projectId:string,sequenceId:string,refresh:()=>Promise<Project|null>,signal:AbortSignal):Promise<Result>{
    editId(projectId);editId(sequenceId);const query=new URL(request.url).searchParams,historyRevision=query.get("historyRevision");if(request.method!=="GET"||[...query.keys()].some(key=>key!=="historyRevision"||query.getAll(key).length!==1)||!historyRevision||!/^[a-f0-9]{64}$/.test(historyRevision))editFail("Choose the saved history for script navigation.");
    const guard=async()=>{signal.throwIfAborted();const project=await waiting(refresh(),signal);if(!project||project.id!==projectId||!Number.isFinite(Date.parse(project.deleteAfter))||Date.parse(project.deleteAfter)<=Date.now())editFail("This project is no longer available.");const sequence=project.editLibrary.sequences.find(s=>s.id===sequenceId);if(!sequence||sequence.history.id!==sequenceId||sequence.history.revision!==historyRevision)editFail("The saved cut changed. Refresh script navigation.");return {project,sequence,timeline:editHistoryState(sequence.history).timeline};};
    const first=await guard(),wanted=new Set(first.timeline.sources.map(s=>s.id));
    const check=async(current:Awaited<ReturnType<typeof guard>>,bindings:EditSourceBinding[])=>{
      if(current.timeline.revision!==first.timeline.revision||bindings.length!==wanted.size||new Set(bindings.map(b=>b.source.facts.id)).size!==bindings.length)editFail("Script navigation lost a retained original.");
      for(const binding of bindings){signal.throwIfAborted();const facts=current.timeline.sources.find(s=>s.id===binding.source.facts.id),known=current.project.editLibrary.sources.find(s=>s.revision===binding.source.revision);
        if(binding.owner.projectId!==projectId||!facts||!known||!current.sequence.sourceRevisions.includes(binding.source.revision)||contentHash(facts)!==contentHash(binding.source.facts)||contentHash(known)!==contentHash(binding.source))editFail("The script source differs from this saved edit branch.");
        assertEditOriginalPermission(binding.source,current.project);assertEditBindingAvailable(binding,await waiting(Promise.resolve(this.context.job(projectId,binding.owner.jobId)),signal));
      }
    };
    const bindings=await waiting(this.context.bindings(first.project,sequenceId,wanted),signal);await check(await guard(),bindings);
    const sources=[];for(const binding of bindings){signal.throwIfAborted();sources.push(compileEditScriptSource(binding.source));await new Promise<void>(resolve=>setImmediate(resolve));signal.throwIfAborted();}
    const navigation=projectEditScriptNavigation(sequenceId,historyRevision,first.timeline,sources);await new Promise<void>(resolve=>setImmediate(resolve));signal.throwIfAborted();
    // A fresh selection catches a removed carrier even when another export can now retain the same original.
    const current=await guard(),fresh=await waiting(this.context.bindings(current.project,sequenceId,wanted),signal);
    const revisions=(items:EditSourceBinding[])=>items.map(b=>b.revision).sort();if(contentHash(revisions(fresh))!==contentHash(revisions(bindings)))editFail("The retained source carrier changed. Refresh script navigation.");
    await check(await guard(),fresh);const final=await guard();for(const binding of fresh)assertEditOriginalPermission(binding.source,final.project);signal.throwIfAborted();return {status:200,body:navigation};
  }
  async close():Promise<void>{if(this.#closed)return;this.#closed=true;this.#controller.abort(new Error("Script navigation service stopped."));await Promise.allSettled(this.#operations);}
}
