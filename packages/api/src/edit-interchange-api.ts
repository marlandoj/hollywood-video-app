import {createHash} from "node:crypto";
import {contentHash} from "../../generator/src/capabilities";
import {editHistoryState} from "../../planner/src/edit-history";
import {editFail,editId} from "../../planner/src/edit-timeline";
import {assertEditBindingAvailable,type EditSourceBinding} from "../../planner/src/edit-jobs";
import {assertEditOriginalPermission} from "../../planner/src/edit-sources";
import {editCmx3600,editInterchangeCut,editOtio} from "../../planner/src/edit-interchange";
import type {Project} from "./index";
import type {Job} from "../../queue/src/index";

interface Context {job:(projectId:string,jobId:string)=>Promise<Job|undefined>|Job|undefined;bindings:(project:Project,sequenceId:string,sourceIds:Set<string>)=>Promise<EditSourceBinding[]>}
const FORMATS={otio:{type:"application/json; charset=utf-8",extension:"otio",write:editOtio},edl:{type:"text/plain; charset=utf-8",extension:"edl",write:editCmx3600}} as const;
async function waiting<T>(task:Promise<T>,signal:AbortSignal):Promise<T>{signal.throwIfAborted();let abort=()=>{};try{return await Promise.race([task,new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();})]);}finally{signal.removeEventListener("abort",abort);}}

/**
 * HV-023-04: the owner's saved cut as an OTIO or CMX 3600 download. Metadata only: this service
 * never decodes media, admits a job or spends. It makes the same checks as script navigation
 * (EditScriptApi) — saved history, retained originals, their carriers and current permission —
 * before and after writing, so a withdrawn permission or a changed cut never leaves as a file.
 */
export class EditInterchangeApi {
  readonly #controller=new AbortController();readonly #operations=new Set<Promise<Response>>();#closed=false;
  constructor(readonly context:Context){}
  async handle(request:Request,projectId:string,sequenceId:string,format:string,refresh:()=>Promise<Project|null>):Promise<Response>{
    if(this.#closed)editFail("Interchange export stopped. Reopen the editor.");if(this.#operations.size>=2)editFail("Interchange export is busy. Retry after the current exports finish.");
    const active=AbortSignal.any([request.signal,this.#controller.signal,AbortSignal.timeout(30000)]),task=this.#handle(request,projectId,sequenceId,format,refresh,active);this.#operations.add(task);try{return await task;}finally{this.#operations.delete(task);}
  }
  async #handle(request:Request,projectId:string,sequenceId:string,format:string,refresh:()=>Promise<Project|null>,signal:AbortSignal):Promise<Response>{
    editId(projectId);editId(sequenceId);if(!Object.hasOwn(FORMATS,format))editFail("Choose otio or edl for interchange export.");const writer=FORMATS[format as keyof typeof FORMATS];
    const query=new URL(request.url).searchParams,historyRevision=query.get("historyRevision");if(request.method!=="GET"||[...query.keys()].some(key=>key!=="historyRevision"||query.getAll(key).length!==1)||!historyRevision||!/^[a-f0-9]{64}$/.test(historyRevision))editFail("Choose the saved history to export.");
    const guard=async()=>{signal.throwIfAborted();const project=await waiting(refresh(),signal);if(!project||project.id!==projectId||!Number.isFinite(Date.parse(project.deleteAfter))||Date.parse(project.deleteAfter)<=Date.now())editFail("This project is no longer available.");const sequence=project.editLibrary.sequences.find(s=>s.id===sequenceId);if(!sequence||sequence.history.id!==sequenceId||sequence.history.revision!==historyRevision)editFail("The saved cut changed. Reload it before exporting.");return {project,sequence,timeline:editHistoryState(sequence.history).timeline};};
    const first=await guard(),wanted=new Set(first.timeline.clips.filter(c=>c.lane==="picture").map(c=>c.sourceId));
    const check=async(current:Awaited<ReturnType<typeof guard>>,bindings:EditSourceBinding[])=>{
      if(current.timeline.revision!==first.timeline.revision||bindings.length!==wanted.size||new Set(bindings.map(b=>b.source.facts.id)).size!==bindings.length)editFail("Interchange export lost a retained original.");
      for(const binding of bindings){signal.throwIfAborted();const facts=current.timeline.sources.find(s=>s.id===binding.source.facts.id),known=current.project.editLibrary.sources.find(s=>s.revision===binding.source.revision);
        if(binding.owner.projectId!==projectId||!facts||!known||!current.sequence.sourceRevisions.includes(binding.source.revision)||contentHash(facts)!==contentHash(binding.source.facts)||contentHash(known)!==contentHash(binding.source))editFail("The exported original differs from this saved edit branch.");
        assertEditOriginalPermission(binding.source,current.project);assertEditBindingAvailable(binding,await waiting(Promise.resolve(this.context.job(projectId,binding.owner.jobId)),signal));
      }
    };
    const bindings=await waiting(this.context.bindings(first.project,sequenceId,wanted),signal);await check(await guard(),bindings);
    const cut=editInterchangeCut({sequenceId,label:first.sequence.label,historyRevision,timeline:first.timeline,sources:bindings.map(b=>({sourceId:b.source.facts.id,jobId:b.source.job.id,stage:b.source.job.stage,sourceRevision:b.source.facts.revision}))});
    const text=writer.write(cut);await new Promise<void>(resolve=>setImmediate(resolve));signal.throwIfAborted();
    // A fresh selection catches a removed carrier even when another export can now retain the same original.
    const current=await guard(),fresh=await waiting(this.context.bindings(current.project,sequenceId,wanted),signal);
    const revisions=(items:EditSourceBinding[])=>items.map(b=>b.revision).sort();if(contentHash(revisions(fresh))!==contentHash(revisions(bindings)))editFail("The retained source carrier changed. Export again.");
    await check(await guard(),fresh);const final=await guard();for(const binding of fresh)assertEditOriginalPermission(binding.source,final.project);signal.throwIfAborted();
    const bytes=new TextEncoder().encode(text);
    return new Response(bytes,{status:200,headers:{"content-type":writer.type,"content-length":String(bytes.length),"content-disposition":"attachment; filename=\""+sequenceId+"."+writer.extension+"\"","cache-control":"private, no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer","x-hv-interchange-sha256":createHash("sha256").update(bytes).digest("hex")}});
  }
  async close():Promise<void>{if(this.#closed)return;this.#closed=true;this.#controller.abort(new Error("Interchange export stopped."));await Promise.allSettled(this.#operations);}
}
