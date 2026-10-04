import {createHash} from "node:crypto";
import {contentHash} from "../../generator/src/capabilities";
import {parseFountain} from "../../parser/src/index";
import {currentDirection} from "../../planner/src/direction";
import {editFail,editId} from "../../planner/src/edit-timeline";
import {editCmx3600,editOtio} from "../../planner/src/edit-interchange";
import {FeatureFilmConflict,assertFeatureFilmSourcesAvailable} from "../../planner/src/feature-film";
import {featureInterchangeCut} from "../../planner/src/feature-interchange";
import {stalePlanReason} from "../../planner/src/sequences";
import {assertOutputPermission} from "../../planner/src/dialogue-selection";
import type {Project} from "./index";
import type {Job} from "../../queue/src/index";

interface Context {jobs:(projectId:string)=>Promise<Job[]>}
const FORMATS={otio:{type:"application/json; charset=utf-8",extension:"otio",write:editOtio},edl:{type:"text/plain; charset=utf-8",extension:"edl",write:editCmx3600}} as const;
const refuse=(message:string):never=>{throw new FeatureFilmConflict(message);};
async function waiting<T>(task:Promise<T>,signal:AbortSignal):Promise<T>{signal.throwIfAborted();let abort=()=>{};try{return await Promise.race([task,new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();})]);}finally{signal.removeEventListener("abort",abort);}}

/**
 * HV-023-05: the owner's joined feature (a finished `feature-film` job, HV-030-30) as an OTIO or CMX
 * 3600 download, written by HV-023-04's writers from `featureInterchangeCut`. Like HV-023-04's export
 * it is metadata only — no media is decoded, no job admitted, nothing spent — and it checks before and
 * after writing that the project is available, the job is this feature's newest finished join of its
 * current split and screenplay, every film and graphic it joined is still the one admitted and retained,
 * and every film's cast still permits it (`assertOutputPermission`, as the feature's review link does).
 */
export class FeatureInterchangeApi {
  readonly #controller=new AbortController();readonly #operations=new Set<Promise<Response>>();#closed=false;
  constructor(readonly context:Context){}
  async handle(request:Request,projectId:string,jobId:string,format:string,refresh:()=>Promise<Project|null>):Promise<Response>{
    if(this.#closed)editFail("Interchange export stopped. Reopen the studio.");if(this.#operations.size>=2)editFail("Interchange export is busy. Retry after the current exports finish.");
    const active=AbortSignal.any([request.signal,this.#controller.signal,AbortSignal.timeout(30000)]),task=this.#handle(request,projectId,jobId,format,refresh,active);this.#operations.add(task);try{return await task;}finally{this.#operations.delete(task);}
  }
  async #handle(request:Request,projectId:string,jobId:string,format:string,refresh:()=>Promise<Project|null>,signal:AbortSignal):Promise<Response>{
    editId(projectId);editId(jobId);if(!Object.hasOwn(FORMATS,format))editFail("Choose otio or edl for interchange export.");const writer=FORMATS[format as keyof typeof FORMATS];
    if(request.method!=="GET"||new URL(request.url).search)editFail("Export the feature's cut with a plain GET.");
    const guard=async()=>{
      signal.throwIfAborted();const project=await waiting(refresh(),signal);
      if(!project||project.id!==projectId||!Number.isFinite(Date.parse(project.deleteAfter))||Date.parse(project.deleteAfter)<=Date.now())editFail("This project is no longer available.");
      if(project.format!=="feature"||!project.sequences)return refuse("Only a feature the Showrunner split into sequences has a joined film to export.");
      const jobs=await waiting(this.context.jobs(projectId),signal),job=jobs.find(value=>value.id===jobId);
      if(!job||job.projectId!==projectId||job.stage!=="feature-film"||!job.featureFilm)return refuse("That isn't one of this feature's joined films.");
      if(job.status!=="done"||!job.output)refuse("The feature's film isn't finished. Export its cut after the join completes.");
      if(!Number.isFinite(Date.parse(job.linkExpiresAt??""))||Date.parse(job.linkExpiresAt!)<=Date.now())refuse("The feature's film is no longer kept. Join the feature again.");
      const script=project.versions.latest();
      if(job.featureFilm.planRevision!==project.sequences.revision||!script||job.scriptVersion!==script.version
        ||stalePlanReason(project.sequences,script.version,parseFountain(script.text),currentDirection(project.id,project.directionHistory)))
        refuse("The feature changed after this join: its screenplay or its split into sequences is newer. Join the feature again before exporting its cut.");
      const newer=jobs.find(value=>value.id!==job.id&&value.stage==="feature-film"&&value.status==="done"&&Date.parse(value.completedAt??"")>Date.parse(job.completedAt??""));
      if(newer)refuse("A newer join of the feature is finished. Export that one.");
      assertFeatureFilmSourcesAvailable(job.featureFilm,id=>jobs.find(value=>value.id===id));
      assertOutputPermission(job,project);
      return {project,job};
    };
    const first=await guard(),cut=featureInterchangeCut(first.job),text=writer.write(cut);
    await new Promise<void>(resolve=>setImmediate(resolve));
    // Again after writing, so a film taken down, a permission withdrawn or a new join never leaves as a file.
    const final=await guard();if(contentHash(final.job)!==contentHash(first.job))refuse("The feature's film changed while its cut was written. Export again.");
    signal.throwIfAborted();
    const bytes=new TextEncoder().encode(text);
    return new Response(bytes,{status:200,headers:{"content-type":writer.type,"content-length":String(bytes.length),"content-disposition":"attachment; filename=\""+jobId+"."+writer.extension+"\"","cache-control":"private, no-store","x-content-type-options":"nosniff","referrer-policy":"no-referrer","x-hv-interchange-sha256":createHash("sha256").update(bytes).digest("hex")}});
  }
  async close():Promise<void>{if(this.#closed)return;this.#closed=true;this.#controller.abort(new Error("Interchange export stopped."));await Promise.allSettled(this.#operations);}
}
