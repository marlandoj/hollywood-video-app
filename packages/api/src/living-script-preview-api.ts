import {contentHash} from "../../generator/src/capabilities";
import type {Job} from "../../queue/src/index";
import {currentCasting} from "../../planner/src/casting";
import {currentDirection} from "../../planner/src/direction";
import {editFail,editId,editRecord,type EditTimeline} from "../../planner/src/edit-timeline";
import type {EditLibrary} from "../../planner/src/edit-library";
import {assertEditBindingAvailable,type EditSourceBinding} from "../../planner/src/edit-jobs";
import {assertEditOriginalPermission} from "../../planner/src/edit-sources";
import {assertLivingScriptGenerationCurrent} from "../../planner/src/living-script-jobs";
import {acceptLivingScriptProposal,emptyLivingScriptAcceptances} from "../../planner/src/living-script-acceptance-library";
import type {LivingScriptAcceptanceRequest} from "../../planner/src/living-script-acceptance";
import type {Project} from "./index";
import type {EditPreviewApi} from "./edit-preview-api";
import {livingScriptRead} from "./living-script-read";

export const LIVING_SCRIPT_PREVIEW_LIMITS={registrations:4,requestBytes:8*1024**2,metadataBytes:32*1024**2,sessions:32,leaseMs:5*60000,operations:8} as const;
interface Context {
  preview:EditPreviewApi;
  job:(projectId:string,jobId:string)=>Promise<Job|undefined>|Job|undefined;
  bindings:(project:Project,library:EditLibrary,revisions:string[])=>Promise<EditSourceBinding[]>;
  limits?:Partial<{registrations:number;requestBytes:number;metadataBytes:number;sessions:number;leaseMs:number;operations:number}>;
}
export interface LivingScriptPreviewRegistration {
  schema:"hv-living-script-preview/1";id:string;projectId:string;proposalId:string;proposalRevision:string;
  reviewRevision:string;requestHash:string;sequenceId:string;historyRevision:string;timelineRevision:string;expiresAt:string;accepted:false;
}
interface Entry {
  id:string;projectId:string;proposalId:string;proposalRevision:string;proposalHash:string;requestHash:string;
  request:LivingScriptAcceptanceRequest;library:EditLibrary;timeline:EditTimeline;bytes:number;expires:number;
  controller:AbortController;sessions:Map<string,{requestHash:string;released:boolean}>;
}
type Result={status:number;body:unknown}|Response;
const same=(a:unknown,b:unknown)=>contentHash(a)===contentHash(b);
function hash(value:unknown):string{if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))editFail("Retain the exact recut preview revision.");return value;}
/** Inspect descriptors before hashing. A review may never lose fields through serialization. */
function portable<T>(input:T,limit:number):T {
  const active=new Set<object>();let nodes=0;const visit=(value:unknown,depth:number):void=>{
    if(++nodes>500000)editFail("The complete recut preview exceeds its metadata capacity.");
    if(value===null||typeof value==="string"||typeof value==="boolean")return;
    if(typeof value==="number"&&Number.isFinite(value)&&!Object.is(value,-0))return;
    if(typeof value!=="object"||depth>160||active.has(value))editFail("Retain portable recut preview data.");
    const array=Array.isArray(value),prototype=Object.getPrototypeOf(value),keys=Reflect.ownKeys(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)editFail("Retain plain recut preview records.");
    if(array&&keys.length!==value.length+1)editFail("Retain dense recut preview arrays.");active.add(value);
    for(const key of keys){if(array&&key==="length")continue;const property=Object.getOwnPropertyDescriptor(value,key)!;
      if(typeof key!=="string"||!property.enumerable||!Object.hasOwn(property,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))editFail("Retain recut preview fields without accessors or hidden values.");visit(property.value,depth+1);
    }active.delete(value);
  };visit(input,0);if(Buffer.byteLength(JSON.stringify(input),"utf8")>limit)editFail("The complete recut preview exceeds its metadata capacity.");return structuredClone(input);
}

/** Ephemeral review only. The shared preview pool renders a detached library; no project save,
 * generation admission, screenplay/settings adoption or acceptance receipt is persisted. */
export class LivingScriptPreviewApi {
  readonly #entries=new Map<string,Entry>();readonly #sessions=new Map<string,string>();readonly #operations=new Set<Promise<Result>>();
  readonly #controller=new AbortController();readonly #limits;readonly #timer:ReturnType<typeof setInterval>;#closed=false;
  constructor(readonly context:Context){
    this.#limits={...LIVING_SCRIPT_PREVIEW_LIMITS,...context.limits};
    for(const key of Object.keys(LIVING_SCRIPT_PREVIEW_LIMITS) as (keyof typeof LIVING_SCRIPT_PREVIEW_LIMITS)[])if(!Number.isSafeInteger(this.#limits[key])||this.#limits[key]<1||this.#limits[key]>LIVING_SCRIPT_PREVIEW_LIMITS[key])editFail("Use bounded recut preview capacity.");
    this.#timer=setInterval(()=>this.#expire(),Math.min(1000,this.#limits.leaseMs));this.#timer.unref();
  }
  #release(entry:Entry,id:string){
    const session=entry.sessions.get(id);if(!session)return;session.released=true;
    this.context.preview.releaseSession(entry.projectId,entry.request.recut.sequenceId,entry.request.recut.history.revision,id);
  }
  #remove(entry:Entry){entry.controller.abort(new Error("This recut preview expired. Register its full review again."));for(const id of entry.sessions.keys()){this.#release(entry,id);this.#sessions.delete(id);}this.#entries.delete(entry.id);}
  #expire(){for(const entry of this.#entries.values())if(entry.expires<=Date.now())this.#remove(entry);}
  #live(entry:Entry){this.#controller.signal.throwIfAborted();entry.controller.signal.throwIfAborted();if(this.#entries.get(entry.id)!==entry||entry.expires<=Date.now())editFail("This recut preview expired. Register its full review again.");}
  async #owner(projectId:string,refresh:()=>Promise<Project|null>,signal:AbortSignal){
    const owner=await livingScriptRead(refresh,signal);if(!owner||owner.id!==projectId||!Number.isFinite(Date.parse(owner.deleteAfter))||Date.parse(owner.deleteAfter)<=Date.now())editFail("This project is no longer available.");return owner;
  }
  async #check(entry:Entry,refresh:()=>Promise<Project|null>,signal:AbortSignal,registered=true):Promise<Project>{
    if(registered)this.#live(entry);const read=<T>(task:()=>Promise<T>|T)=>livingScriptRead(task,signal),owner=await this.#owner(entry.projectId,refresh,signal),asked=entry.request,proposal=owner.livingScriptProposals.proposals.find(value=>value.request.id===entry.proposalId);
    const currentScript=owner.versions.latest();
    if(!proposal||proposal.revision!==entry.proposalRevision||contentHash(proposal)!==entry.proposalHash||!currentScript||currentScript.version!==asked.recutInput.patch.before.version||currentScript.text!==asked.recutInput.patch.before.text
      ||!same(owner.editLibrary,asked.recutInput.library)||!same(currentCasting(owner.id,owner.castingHistory),asked.baseline.casting)||!same(currentDirection(owner.id,owner.directionHistory),asked.baseline.direction))editFail("The screenplay, saved cut, settings or proposal changed. Review this recut again.");
    const generated=await read(()=>this.context.job(owner.id,asked.recutInput.generated.job.id));
    if(generated?.status!=="done"||!generated.livingScript||generated.livingScript.request.role!=="render"||!same(generated.livingScript.proposal,proposal))editFail("The revised film is unavailable or belongs to another proposal.");
    const carrier=await read(()=>this.context.job(owner.id,generated.livingScript!.binding.owner.jobId));assertLivingScriptGenerationCurrent(generated.livingScript,owner,carrier);
    // Include every frozen parent original, even when the recut omits it, plus the generated film.
    const revisions=[...proposal.impact.parent.sourceReceipts.map(item=>item.receiptRevision),asked.recutInput.generated.revision].filter((revision,index,all)=>all.indexOf(revision)===index),bindings=await read(()=>this.context.bindings(owner,entry.library,revisions));
    if(bindings.length!==revisions.length||new Set(bindings.map(binding=>binding.source.revision)).size!==revisions.length)editFail("Retain every original and revised source for this recut review.");
    for(const [index,revision]of revisions.entries()){
      const binding=bindings[index]!;if(binding.source.revision!==revision||!entry.library.sources.some(source=>source.revision===revision&&same(source,binding.source)))editFail("The recut preview source binding changed.");
      assertEditOriginalPermission(binding.source,owner);assertEditBindingAvailable(binding,await read(()=>this.context.job(owner.id,binding.owner.jobId)));
    }
    const latest=await this.#owner(owner.id,refresh,signal);
    if(!same(latest.versions.latest(),currentScript)||!same(latest.editLibrary,owner.editLibrary)||!same(latest.castingHistory,owner.castingHistory)||!same(latest.directionHistory,owner.directionHistory)||!same(latest.livingScriptProposals,owner.livingScriptProposals)||!same(latest.referenceAssets,owner.referenceAssets)||latest.rightsAttestedAt!==owner.rightsAttestedAt)editFail("The project changed during recut preview access.");
    if(registered)this.#live(entry);signal.throwIfAborted();return {...latest,editLibrary:structuredClone(entry.library)};
  }
  #view(entry:Entry):LivingScriptPreviewRegistration{return {schema:"hv-living-script-preview/1",id:entry.id,projectId:entry.projectId,proposalId:entry.proposalId,proposalRevision:entry.proposalRevision,reviewRevision:entry.request.reviewRevision,requestHash:entry.requestHash,sequenceId:entry.request.recut.sequenceId,historyRevision:entry.request.recut.history.revision,timelineRevision:entry.timeline.revision,expiresAt:new Date(entry.expires).toISOString(),accepted:false};}
  #descriptor(entry:Entry){return portable({registration:this.#view(entry),sequence:entry.library.sequences.find(sequence=>sequence.id===entry.request.recut.sequenceId)!,timeline:entry.timeline},LIVING_SCRIPT_PREVIEW_LIMITS.requestBytes);}
  async handle(parts:string[],request:Request,projectId:string,proposalId:string,refresh:()=>Promise<Project|null>,body?:Record<string,unknown>):Promise<Result>{
    if(this.#closed)editFail("Recut preview service stopped. Reopen the editor.");if(this.#operations.size>=this.#limits.operations)editFail("Recut preview requests are busy. Retry shortly.");
    const task=this.#handle(parts,request,projectId,proposalId,refresh,body);this.#operations.add(task);try{return await task;}finally{this.#operations.delete(task);}
  }
  async #handle(parts:string[],request:Request,projectId:string,proposalId:string,refresh:()=>Promise<Project|null>,body?:Record<string,unknown>):Promise<Result>{
    this.#expire();editId(projectId);editId(proposalId);const signal=AbortSignal.any([request.signal,this.#controller.signal,AbortSignal.timeout(30000)]),url=new URL(request.url);
    if(!parts.length&&request.method==="POST"){
      if(url.search)editFail("Register a complete recut review without query fields.");
      const input=editRecord(portable(body,this.#limits.requestBytes),["proposalRevision","request"]),proposalRevision=hash(input.proposalRevision),asked=input.request as LivingScriptAcceptanceRequest,owner=await this.#owner(projectId,refresh,signal),proposal=owner.livingScriptProposals.proposals.find(value=>value.request.id===proposalId);
      if(!proposal||proposal.revision!==proposalRevision)editFail("Choose the exact saved screenplay proposal.");
      const currentScript=owner.versions.latest();if(!currentScript)editFail("Retain the current screenplay before previewing a recut.");
      const result=acceptLivingScriptProposal(emptyLivingScriptAcceptances(projectId),owner.livingScriptProposals,{projectId,editorial:owner.editLibrary,currentScript:{version:currentScript.version,text:currentScript.text},currentCasting:currentCasting(projectId,owner.castingHistory),currentDirection:currentDirection(projectId,owner.directionHistory)},proposalId,proposalRevision,asked,0,Date.parse(asked?.recut?.createdAt));
      if(result.replayed)editFail("Preview validation requires a detached complete recut.");
      const id=contentHash({projectId,proposalId,proposalRevision,reviewRevision:asked.reviewRevision}),requestHash=contentHash(input),previous=this.#entries.get(id);
      if(previous&&previous.requestHash!==requestHash)editFail("This recut preview revision already belongs to a different complete review body.");
      const library=result.bundle.nextEditLibrary,timeline=asked.recut.afterTimeline,bytes=Buffer.byteLength(JSON.stringify({request:asked,library,timeline}),"utf8"),entry:Entry=previous??{id,projectId,proposalId,proposalRevision,proposalHash:contentHash(proposal),requestHash,request:asked,library,timeline,bytes,expires:Date.now()+this.#limits.leaseMs,controller:new AbortController(),sessions:new Map()};
      if(!previous&&(this.#entries.size>=this.#limits.registrations||[...this.#entries.values()].reduce((sum,value)=>sum+value.bytes,0)+bytes>this.#limits.metadataBytes))editFail("Close an existing recut preview before retaining another complete review.");
      await this.#check(entry,refresh,signal,Boolean(previous));signal.throwIfAborted();
      const raced=this.#entries.get(id);if(raced&&raced.requestHash!==requestHash)editFail("This recut preview revision belongs to another review body.");
      // Recheck capacity after asynchronous owner/carrier reads; concurrent registrations cannot overbook it.
      if(!raced&&(this.#entries.size>=this.#limits.registrations||[...this.#entries.values()].reduce((sum,value)=>sum+value.bytes,0)+bytes>this.#limits.metadataBytes))editFail("Recut preview registration capacity is full.");
      const saved=raced??entry;saved.expires=Date.now()+this.#limits.leaseMs;this.#entries.set(id,saved);return {status:raced?200:201,body:{...this.#descriptor(saved),replayed:Boolean(raced)}};
    }
    const entry=this.#entries.get(hash(parts[0]));if(!entry||entry.projectId!==projectId||entry.proposalId!==proposalId)editFail("This recut preview expired or belongs to another proposal. Register the complete review again.");this.#live(entry);
    if(parts.length===1){
      if(url.search)editFail("Use the exact registered recut preview without query fields.");
      if(request.method==="DELETE"){await this.#owner(projectId,refresh,signal);this.#remove(entry);return {status:200,body:{stopped:true}};}
      if(request.method!=="GET")return {status:404,body:{error:"Unknown recut preview route."}};
      await this.#check(entry,refresh,signal);return {status:200,body:this.#descriptor(entry)};
    }
    if(parts[1]!=="preview")return {status:404,body:{error:"Unknown recut preview route."}};
    const previewParts=parts.slice(2),historyRevision=entry.request.recut.history.revision,sequenceId=entry.request.recut.sequenceId;
    if(!previewParts.length&&request.method==="POST"){
      const asked=editRecord(portable(body,4096),["id","historyRevision","from","frames"]),id=editId(asked.id),requestHash=contentHash(asked),prior=entry.sessions.get(id),owner=this.#sessions.get(id);
      if(asked.historyRevision!==historyRevision||owner&&owner!==entry.id||prior&&prior.requestHash!==requestHash)editFail("This recut preview session belongs to another review or playhead window.");
      if(!prior&&this.#sessions.size>=this.#limits.sessions)editFail("Recut preview session identities are full. Close a review and retry.");
      entry.sessions.set(id,{requestHash,released:false});this.#sessions.set(id,entry.id);
      const persistent=()=>this.#check(entry,refresh,AbortSignal.any([this.#controller.signal,entry.controller.signal,AbortSignal.timeout(30000)]));
      try{return await this.context.preview.handle([],new Request(request,{signal:AbortSignal.any([signal,entry.controller.signal])}),projectId,sequenceId,persistent,asked);}
      catch(error){this.#release(entry,id);throw error;}
    }
    const id=editId(previewParts[0]),session=entry.sessions.get(id);if(!session||this.#sessions.get(id)!==entry.id||url.searchParams.get("historyRevision")!==historyRevision)editFail("This session was not prepared for this exact recut review.");
    if(previewParts.length===1&&request.method==="DELETE"){
      if([...url.searchParams.keys()].some(key=>key!=="historyRevision")||url.searchParams.getAll("historyRevision").length!==1)editFail("Release the exact recut preview session.");
      await this.#owner(projectId,refresh,signal);this.#release(entry,id);return {status:200,body:{stopped:true}};
    }
    if(session.released)editFail("This recut preview session stopped. Prepare its window again.");
    const persistent=()=>this.#check(entry,refresh,AbortSignal.any([this.#controller.signal,entry.controller.signal,AbortSignal.timeout(30000)]));
    return this.context.preview.handle(previewParts,new Request(request,{signal:AbortSignal.any([signal,entry.controller.signal])}),projectId,sequenceId,persistent,body);
  }
  async close(){if(this.#closed)return;this.#closed=true;this.#controller.abort(new Error("Recut preview service stopped."));clearInterval(this.#timer);for(const entry of this.#entries.values())this.#remove(entry);await Promise.allSettled(this.#operations);}
}
