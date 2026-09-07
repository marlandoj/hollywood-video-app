import {mkdirSync} from "node:fs";
import {EditPreviewSessions,type PreviewSessionIdentity,type PreviewSessionLimits,type PreviewSessionStatus} from "../../generator/src/edit-preview-sessions";
import {EditPreviewPageCache} from "../../generator/src/edit-preview-cache";
import {EditPreviewMix} from "../../generator/src/edit-preview-mix";
import {contentHash} from "../../generator/src/capabilities";
import {previewRequests} from "../../planner/src/edit-preview-render";
import {PREVIEW_PAGE_FRAMES} from "../../planner/src/edit-preview-protocol";
import {editFail,editId,editNumber,editRecord,type EditTimeline} from "../../planner/src/edit-timeline";
import {editHistoryState} from "../../planner/src/edit-history";
import {assertEditBindingAvailable,type EditSourceBinding} from "../../planner/src/edit-jobs";
import {assertEditOriginalPermission} from "../../planner/src/edit-sources";
import {PreviewResponses} from "./preview-response";
import type {Project} from "./index";
import type {Job} from "../../queue/src/index";
import type {DialogueArtifactReader} from "../../generator/src/dialogue-replacement";
type Sources=ConstructorParameters<typeof EditPreviewMix>[1];
interface Scope {identity:PreviewSessionIdentity;timeline:EditTimeline;from:number;frames:number;revision:string;mix?:{renderer:EditPreviewMix;sources:Sources}}
interface Context {root:string;reader?:DialogueArtifactReader;job:(projectId:string,jobId:string)=>Promise<Job|undefined>|Job|undefined;bindings:(project:Project,sequenceId:string,sourceIds:Set<string>)=>Promise<EditSourceBinding[]>;limits?:Partial<PreviewSessionLimits>}
type Result={status:number;body:unknown}|Response;
async function waiting<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{signal.throwIfAborted();let abort=()=>{};try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason);signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();})]);}finally{signal.removeEventListener("abort",abort);}}
export class EditPreviewApi {
  readonly #sessions:EditPreviewSessions;readonly #pages:EditPreviewPageCache;readonly #responses=new PreviewResponses();readonly #scopes=new Map<string,Scope>();readonly #operations=new Set<Promise<Result>>();#closed=false;
  constructor(readonly context:Context){mkdirSync(context.root,{recursive:true});this.#sessions=new EditPreviewSessions(context.root,context.reader,context.limits);try{this.#pages=new EditPreviewPageCache(context.root,{readers:8});}catch(error){void this.#sessions.close();throw error;}}
  async handle(parts:string[],request:Request,projectId:string,sequenceId:string,refresh:()=>Promise<Project|null>,body?:Record<string,unknown>):Promise<Result>{const task=this.#handle(parts,request,projectId,sequenceId,refresh,body);this.#operations.add(task);try{return await task;}finally{this.#operations.delete(task);}}
  async #handle(parts:string[],request:Request,projectId:string,sequenceId:string,refresh:()=>Promise<Project|null>,body?:Record<string,unknown>):Promise<Result>{
    if(this.#closed)editFail("Preview service stopped. Reopen the editor.");const lease=this.#responses.open(request);let streaming=false;
    try{
      const active=new Set(this.#sessions.activeIds);for(const id of this.#scopes.keys())if(!active.has(id))this.#scopes.delete(id);
      const query=new URL(request.url).searchParams,allowed=parts.length>1?["historyRevision","sourceKey"]:["historyRevision"];if([...query.keys()].some(k=>!allowed.includes(k)||query.getAll(k).length!==1))editFail("Use only the current preview identity parameters.");
      const historyRevision=request.method==="POST"?body?.historyRevision:query.get("historyRevision");if(typeof historyRevision!=="string"||!/^[a-f0-9]{64}$/.test(historyRevision))editFail("Choose the saved cut's current history revision.");
      const guard=async()=>{lease.signal.throwIfAborted();const current=await waiting(refresh(),lease.signal);if(!current||current.id!==projectId||Date.parse(current.deleteAfter)<=Date.now())editFail("This project is no longer available.");const sequence=current.editLibrary.sequences.find(s=>s.id===sequenceId);if(!sequence||request.method!=="DELETE"&&sequence.history.revision!==historyRevision)editFail("The saved cut changed. Prepare its current version before previewing.");return {current,sequence};};
      const {current,sequence}=await guard();
      if(!parts.length&&request.method==="POST"){
        const input=editRecord(body,["id","historyRevision","from","frames"]),id=editId(input.id),timeline=editHistoryState(sequence.history).timeline,from=editNumber(input.from,0,timeline.frames-1,"Preview start"),frames=editNumber(input.frames,1,300,"Preview window");if(from%PREVIEW_PAGE_FRAMES)editFail("Prepare preview windows from a complete page boundary.");
        const length=Math.min(timeline.frames-from,Math.ceil(frames/PREVIEW_PAGE_FRAMES)*PREVIEW_PAGE_FRAMES),wanted=new Set(previewRequests(timeline,from,length).map(p=>p.sourceId)),bindings=wanted.size?await waiting(this.context.bindings(current,sequenceId,wanted),lease.signal):[],identity={id,projectId,sequenceId,historyRevision},revision=contentHash({identity,from,frames:length,timeline:timeline.revision});if(bindings.length!==wanted.size)editFail("An original for this playhead window is unavailable.");
        const previous=this.#scopes.get(id);if(previous&&previous.revision!==revision)editFail("This preview request identity belongs to a different playhead window.");
        // A session outlives its initial HTTP request, so its checks use its own cancellation lifecycle.
        const access=async(binding:EditSourceBinding)=>{const owner=await refresh();if(!owner||owner.id!==projectId||Date.parse(owner.deleteAfter)<=Date.now()||owner.editLibrary.sequences.find(s=>s.id===sequenceId)?.history.revision!==historyRevision)editFail("The project or saved cut changed. Prepare the current cut again.");assertEditOriginalPermission(binding.source,owner);assertEditBindingAvailable(binding,await this.context.job(projectId,binding.owner.jobId));};
        const status=await this.#sessions.start(identity,bindings,access,lease.signal);this.#scopes.set(id,previous??{identity,timeline,from,frames:length,revision});await guard();return {status:202,body:await this.#status(status,this.#scopes.get(id)!,lease.signal)};
      }
      const id=editId(parts[0]),scope=this.#scopes.get(id),identity={id,projectId,sequenceId,historyRevision};if(!scope&&parts.length===1&&request.method==="DELETE")return {status:200,body:{stopped:true}};if(!scope||scope.identity.projectId!==projectId||scope.identity.sequenceId!==sequenceId||scope.identity.historyRevision!==historyRevision)editFail("This preview session expired or belongs to another saved cut. Prepare the current cut again.");
      if(parts.length===1&&request.method==="DELETE"){this.#sessions.release(identity);this.#scopes.delete(id);return {status:200,body:{stopped:true}};}
      if(parts.length===1&&request.method==="GET")return {status:200,body:await this.#status(await this.#sessions.status(identity,lease.signal),scope,lease.signal)};
      if(request.method!=="GET"||!((parts[1]==="picture"&&parts.length===4)||(parts[1]==="audio"&&parts.length===3)))return {status:404,body:{error:"Unknown preview route."}};
      const sourceKey=query.get("sourceKey");if(!sourceKey||!/^[a-f0-9]{64}$/.test(sourceKey))editFail("Choose the current prepared media identity.");
      return await this.#sessions.withSources(identity,async(sources,permission,signal)=>{
        const access=async()=>{await guard();await permission();};let page;
        if(parts[1]==="picture"){const source=sources.find(s=>s.source.id===parts[2]),from=Number(parts[3]),wanted=previewRequests(scope.timeline,scope.from,scope.frames).find(p=>p.sourceId===parts[2]&&p.from===from&&p.includePicture);if(!source||source.sourceKey!==sourceKey)editFail("This prepared picture changed. Refresh the preview window.");if(!wanted)editFail("Prepare the requested picture window first.");page=await this.#pages.read(source,from,access,signal,{includePicture:true,audioLanes:[],pictureFrames:wanted.pictureFrames});}
        else{const from=Number(parts[2]);if(!Number.isSafeInteger(from)||from<scope.from||from>=scope.from+scope.frames||from%PREVIEW_PAGE_FRAMES)editFail("Prepare the requested soundtrack window first.");const mix=this.#mix(scope,sources);if(mix.sourceKey!==sourceKey)editFail("This prepared soundtrack changed. Refresh the preview window.");page=await this.#pages.read(mix,from,access,signal,{includePicture:false,audioLanes:["mix"]});}
        await access();const response=lease.response(page.bytes,page.sha256,access,signal);streaming=true;return response;
      },lease.signal);
    }catch(error){lease.finish();throw error;}finally{if(!streaming)lease.finish();}
  }
  // Session sources and the saved timeline are immutable. Call only inside withSources so owner,
  // history, original permission and runtime are checked again even when the mix already exists.
  #mix(scope:Scope,sources:Sources){
    // A repeated admission can race lease expiry and prepare new source instances with the same keys.
    if(!scope.mix||scope.mix.sources.length!==sources.length||scope.mix.sources.some((source,i)=>source!==sources[i]))scope.mix={renderer:new EditPreviewMix(scope.timeline,sources,this.context.root),sources};
    return scope.mix.renderer;
  }
  async #status(status:PreviewSessionStatus,scope:Scope,signal?:AbortSignal){const audio=status.state==="ready"?await this.#sessions.withSources(scope.identity,async sources=>({sourceKey:this.#mix(scope,sources).sourceKey,sampleRate:48000,channels:2}),signal):null;return {...status,from:scope.from,frames:scope.frames,timelineRevision:scope.timeline.revision,pageFrames:PREVIEW_PAGE_FRAMES,audio};}
  async close(){this.#closed=true;this.#responses.close();await this.#pages.close();await this.#sessions.close();await Promise.allSettled(this.#operations);this.#scopes.clear();}
}
