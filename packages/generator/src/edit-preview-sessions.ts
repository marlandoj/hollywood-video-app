import {existsSync,lstatSync,mkdirSync,mkdtempSync,readdirSync,realpathSync,rmSync} from "node:fs";
import {join,sep} from "node:path";
import {contentHash} from "./capabilities";
import {editSourceBindingReader} from "./edit-media";
import {prepareEditSources,withEditSourceAccess,EDIT_SOURCE_RECIPE} from "./edit-source-media";
import {EditPreviewSource} from "./edit-preview-media";
import {soundRuntimeRevision} from "./sound-audio";
import {assertEditFreeSpace,editWorkspaceGuard} from "./edit-workspace";
import {PREVIEW_RECIPE} from "../../planner/src/edit-preview-protocol";
import {EditConflict,editFail,editId} from "../../planner/src/edit-timeline";
import {validateEditBinding,type EditSourceBinding} from "../../planner/src/edit-jobs";
import type {DialogueArtifactReader} from "./dialogue-replacement";

type Access=(binding:EditSourceBinding)=>Promise<void>;
export interface PreviewSessionIdentity {id:string;projectId:string;sequenceId:string;historyRevision:string}
export interface PreviewSessionLimits {sessions:number;perProject:number;sources:number;pending:number;concurrency:number;bytes:number;workspaceBytes:number;metadataBytes:number;leaseMs:number;idleMs:number;deadlineMs:number}
export const PREVIEW_SESSION_LIMITS:PreviewSessionLimits={sessions:8,perProject:2,sources:32,pending:32,concurrency:2,bytes:32*1024**3,workspaceBytes:96*1024**3,metadataBytes:128*1024**2,leaseMs:60000,idleMs:15*60000,deadlineMs:20*60000};
interface Entry {
  key:string;binding:EditSourceBinding;directory:string;estimate:number;metadata:number;bytes:number;used:number;order:number;readers:number;
  phase:"queued"|"retaining"|"indexing"|"ready"|"removed";users:Set<Session>;controller:AbortController;preview?:EditPreviewSource;timer?:ReturnType<typeof setTimeout>;
}
interface Session extends PreviewSessionIdentity {revision:string;expires:number;entries:Entry[];access:Access;controller:AbortController;error?:string}
export interface PreviewSessionStatus extends PreviewSessionIdentity {state:"preparing"|"ready"|"failed";expiresAt:string;engineVersion:string;completedSources:number;totalSources:number;error?:string;sources:{sourceId:string;sourceKey:string|null;state:string;frames:number;width:number;height:number}[]}
const stopped=()=>new EditConflict("Preview preparation stopped. Prepare the saved cut again.");
function visible(error:unknown):string{return error instanceof EditConflict?error.message:"This preview source could not be prepared. Refresh retained versions and try again.";}
function size(directory:string):number {let bytes=0;const walk=(path:string)=>{const stat=lstatSync(path);if(stat.isSymbolicLink()||realpathSync(path)!==path)editFail("Preview preparation escaped its workspace.");if(stat.isDirectory())for(const name of readdirSync(path))walk(join(path,name));else if(stat.isFile())bytes+=stat.size;else editFail("Invalid preview workspace file.");};walk(directory);return bytes;}
async function wait<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{signal.throwIfAborted();let abort:()=>void=()=>{};try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason??stopped());signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();})]);}finally{signal.removeEventListener("abort",abort);}}

/** Ephemeral owner sessions pin authenticated originals. No request creates a render job or review receipt. */
export class EditPreviewSessions {
  readonly #root:string;readonly #directory:string;readonly #limits:PreviewSessionLimits;readonly #reader?:DialogueArtifactReader;
  readonly #engine=soundRuntimeRevision();readonly #entries=new Map<string,Entry>();readonly #sessions=new Map<string,Session>();readonly #queue:Entry[]=[];readonly #tasks=new Set<Promise<void>>();readonly #reads=new Set<Promise<unknown>>();readonly #disk:()=>void;readonly #sweep:ReturnType<typeof setInterval>;
  readonly #controller=new AbortController();
  #running=0;#order=0;#closed=false;#admissions=0;#maintenanceError?:unknown;
  constructor(root:string,reader?:DialogueArtifactReader,limits:Partial<PreviewSessionLimits>={}){
    this.#limits={...PREVIEW_SESSION_LIMITS,...limits};const l=this.#limits;
    for(const [key,min,max]of [["sessions",1,32],["perProject",1,8],["sources",1,64],["pending",1,64],["concurrency",1,2],["bytes",64*1024**2,128*1024**3],["workspaceBytes",128*1024**2,256*1024**3],["metadataBytes",1024**2,256*1024**2],["leaseMs",100,120000],["idleMs",100,3600000],["deadlineMs",100,3600000]] as const)if(!Number.isSafeInteger(l[key])||l[key]<min||l[key]>max)editFail("Invalid preview preparation capacity.");
    if(l.workspaceBytes<l.bytes)editFail("Preview workspace must include retained originals.");
    this.#root=realpathSync(root);this.#reader=reader;this.#directory=mkdtempSync(join(this.#root,".edit-preview-sources-"));
    // Include leftover process directories in the guard; a restart never makes their disk usage invisible.
    this.#disk=editWorkspaceGuard(this.#root,()=>readdirSync(this.#root).filter(n=>n.startsWith(".edit-preview-sources-")).map(n=>join(this.#root,n)),{bytes:l.workspaceBytes,files:200000});
    this.#sweep=setInterval(()=>{try{this.#expire();this.#evict();}catch(error){this.#maintenanceError=error;for(const session of this.#sessions.values())session.controller.abort(error);}},Math.min(2000,l.leaseMs/2));this.#sweep.unref();
  }
  get stats(){return {sessions:this.#sessions.size,sources:this.#entries.size,running:this.#running,queued:this.#queue.length,bytes:[...this.#entries.values()].reduce((n,e)=>n+e.bytes,0),reservedBytes:[...this.#entries.values()].reduce((n,e)=>n+(e.phase==="ready"?e.bytes:e.estimate),0),closed:this.#closed};}
  get activeIds():string[]{this.#expire();return [...this.#sessions.keys()];}
  #removeFiles(path:string){if(!existsSync(path))return;if(!path.startsWith(this.#root+sep)||realpathSync(path)!==path||path!==this.#directory&&!path.startsWith(this.#directory+sep))editFail("Preview cleanup escaped its workspace.");rmSync(path,{recursive:true,force:true});}
  #remove(entry:Entry){if(entry.phase==="removed")return;const running=entry.phase==="retaining"||entry.phase==="indexing";entry.phase="removed";entry.controller.abort(stopped());clearTimeout(entry.timer);this.#entries.delete(entry.key);const index=this.#queue.indexOf(entry);if(index!==-1)this.#queue.splice(index,1);if(!running&&!entry.readers)this.#removeFiles(entry.directory);}
  #release(session:Session){session.controller.abort(stopped());this.#sessions.delete(session.id);for(const entry of session.entries){entry.users.delete(session);if(!entry.users.size&&entry.phase!=="ready")this.#remove(entry);}}
  #fail(session:Session,error:unknown){if(session.error)return;session.error=visible(error);session.controller.abort(error);for(const entry of session.entries){entry.users.delete(session);if(!entry.users.size&&entry.phase!=="ready")this.#remove(entry);}}
  #expire(){const now=Date.now();for(const session of this.#sessions.values())if(session.expires<=now)this.#release(session);}
  #evict(bytes=0,count=0,metadata=0,keep=new Set<string>()){
    const available=[...this.#entries.values()].filter(e=>e.phase==="ready"&&!e.users.size&&!e.readers&&!keep.has(e.key)).sort((a,b)=>a.order-b.order);
    for(const entry of available){const current=this.stats,meta=[...this.#entries.values()].reduce((n,e)=>n+e.metadata,0);if(current.bytes+bytes<=this.#limits.bytes&&current.reservedBytes+bytes<=this.#limits.workspaceBytes&&current.sources+count<=this.#limits.sources&&meta+metadata<=this.#limits.metadataBytes&&Date.now()-entry.used<this.#limits.idleMs)break;this.#remove(entry);}
  }
  #session(identity:PreviewSessionIdentity):Session {this.#expire();if(this.#closed)throw stopped();if(this.#maintenanceError)editFail("Preview workspace is unavailable. Restart the preview service after checking its storage.");const session=this.#sessions.get(identity.id);if(!session||session.projectId!==identity.projectId||session.sequenceId!==identity.sequenceId||session.historyRevision!==identity.historyRevision)editFail("This preview session expired or belongs to another saved cut. Prepare the current cut again.");return session;}
  #view(session:Session):PreviewSessionStatus {return {id:session.id,projectId:session.projectId,sequenceId:session.sequenceId,historyRevision:session.historyRevision,state:session.error?"failed":session.entries.every(e=>e.phase==="ready")?"ready":"preparing",expiresAt:new Date(session.expires).toISOString(),engineVersion:this.#engine,completedSources:session.entries.filter(e=>e.phase==="ready").length,totalSources:session.entries.length,...(session.error?{error:session.error}:{}),sources:session.entries.map(e=>({sourceId:e.binding.source.facts.id,sourceKey:e.preview?.sourceKey??null,state:e.phase,frames:e.binding.source.facts.frames,...(e.preview?.dimensions??{width:0,height:0})}))};}
  async start(identity:PreviewSessionIdentity,input:EditSourceBinding[],access:Access,signal?:AbortSignal):Promise<PreviewSessionStatus>{
    if(this.#admissions>=2)editFail("Preview admission is busy. Retry shortly.");this.#admissions++;const active=AbortSignal.any([this.#controller.signal,AbortSignal.timeout(30000),...(signal?[signal]:[])]);try{return await this.#start({...identity},input,access,active);}finally{this.#admissions--;}
  }
  async #start(identity:PreviewSessionIdentity,input:EditSourceBinding[],access:Access,signal?:AbortSignal):Promise<PreviewSessionStatus>{
    this.#expire();if(this.#closed)throw stopped();for(const id of [identity.id,identity.projectId,identity.sequenceId])editId(id);if(!/^[a-f0-9]{64}$/.test(identity.historyRevision))editFail("Choose the current saved history revision.");
    if(this.#maintenanceError)editFail("Preview workspace is unavailable. Restart the preview service after checking its storage.");if(!Array.isArray(input)||input.length>16||Buffer.byteLength(JSON.stringify(input))>64*1024**2)editFail("Choose up to sixteen originals within the preview metadata limit.");
    const bindings=input.map(b=>validateEditBinding(b,Date.now()));if(bindings.some(b=>b.owner.projectId!==identity.projectId)||new Set(bindings.map(b=>b.source.facts.id)).size!==bindings.length)editFail("Choose distinct originals owned by this project.");
    const revision=contentHash({identity,bindings:bindings.map(b=>b.revision),engineVersion:this.#engine});
    for(const binding of bindings){signal?.throwIfAborted();if(signal)await wait(access(binding),signal);else await access(binding);}signal?.throwIfAborted();if(this.#closed)throw stopped();if(soundRuntimeRevision()!==this.#engine)editFail("Restart preview preparation with the current media runtime.");
    const previous=this.#sessions.get(identity.id);if(previous){if(previous.revision!==revision)editFail("This preview request identity belongs to another saved cut.");previous.expires=Date.now()+this.#limits.leaseMs;return this.#view(previous);}
    if(this.#sessions.size>=this.#limits.sessions||[...this.#sessions.values()].filter(s=>s.projectId===identity.projectId).length>=this.#limits.perProject)editFail("Preview session capacity is full. Close another preview and try again.");
    const planned=bindings.map(binding=>{const key=contentHash({binding:binding.revision,engineVersion:this.#engine,recipe:PREVIEW_RECIPE,sourceRecipe:EDIT_SOURCE_RECIPE}),original=binding.files.reduce((n,f)=>n+f.bytes,0),canonical=binding.source.facts.audio.length*(44+binding.source.facts.frames*1600*6);return {binding,key,metadata:Buffer.byteLength(JSON.stringify(binding)),estimate:(original+canonical)*3+64*1024**2};}),fresh=planned.filter(p=>!this.#entries.has(p.key)),estimate=fresh.reduce((n,p)=>n+p.estimate,0),metadata=fresh.reduce((n,p)=>n+p.metadata,0);
    this.#evict(estimate,fresh.length,metadata,new Set(planned.map(p=>p.key)));const current=this.stats;
    if(current.sources+fresh.length>this.#limits.sources||this.#queue.length+this.#running+fresh.length>this.#limits.pending||current.reservedBytes+estimate>this.#limits.workspaceBytes||[...this.#entries.values()].reduce((n,e)=>n+e.metadata,0)+metadata>this.#limits.metadataBytes)editFail("Preview originals exceed current preparation capacity. Close another preview or prepare fewer active sources.");
    if(planned.some(p=>p.estimate/3>this.#limits.bytes))editFail("An original exceeds preview storage capacity. Use a shorter retained source.");this.#disk();assertEditFreeSpace(this.#root,estimate);
    const session:Session={...identity,revision,expires:Date.now()+this.#limits.leaseMs,entries:[],access,controller:new AbortController()};this.#sessions.set(session.id,session);
    for(const p of planned){let entry=this.#entries.get(p.key);if(!entry){entry={...p,directory:join(this.#directory,crypto.randomUUID()),bytes:0,used:Date.now(),order:++this.#order,readers:0,phase:"queued",users:new Set(),controller:new AbortController()};this.#entries.set(p.key,entry);this.#queue.push(entry);const timed=entry;entry.timer=setTimeout(()=>{const error=new EditConflict("Preview source preparation timed out. Try a shorter retained source.");for(const user of Array.from(timed.users))this.#fail(user,error);this.#remove(timed);},this.#limits.deadlineMs);entry.timer.unref();}entry.users.add(session);entry.order=++this.#order;session.entries.push(entry);}
    this.#drain();return this.#view(session);
  }
  async #access(entry:Entry){this.#disk();entry.controller.signal.throwIfAborted();this.#expire();let permitted=0;for(const session of Array.from(entry.users)){if(session.controller.signal.aborted)continue;try{await wait(session.access(entry.binding),session.controller.signal);permitted++;}catch(error){this.#fail(session,error);}}if(!permitted)throw stopped();entry.controller.signal.throwIfAborted();}
  #drain(){while(!this.#closed&&this.#running<this.#limits.concurrency&&this.#queue.length){const entry=this.#queue.shift()!;if(entry.phase!=="queued")continue;entry.phase="retaining";this.#running++;
    const task=(async()=>{try{await this.#access(entry);mkdirSync(entry.directory);const permission=()=>this.#access(entry);
        const prepared=await withEditSourceAccess(permission,entry.controller.signal,active=>prepareEditSources([entry.binding.source],this.#root,join(entry.directory,"sources"),permission,active,editSourceBindingReader([entry.binding],this.#root,this.#reader)));entry.controller.signal.throwIfAborted();entry.phase="indexing";
        const preview=await EditPreviewSource.prepare(entry.binding.source.facts,prepared.sources[0]!.media,this.#root,join(entry.directory,"index"),permission,entry.controller.signal);await permission();const bytes=size(entry.directory);this.#evict(bytes);
        if(this.stats.bytes+bytes>this.#limits.bytes)editFail("Preview originals fill the retained cache. Close another preview and retry.");entry.preview=preview;entry.bytes=bytes;entry.phase="ready";entry.used=Date.now();entry.order=++this.#order;clearTimeout(entry.timer);
      }catch(error){for(const session of Array.from(entry.users))this.#fail(session,error);this.#remove(entry);this.#removeFiles(entry.directory);}finally{this.#running--;queueMicrotask(()=>this.#drain());}
    })();this.#tasks.add(task);void task.finally(()=>this.#tasks.delete(task)).catch(()=>{});
  }}
  async status(identity:PreviewSessionIdentity,signal?:AbortSignal):Promise<PreviewSessionStatus>{const session=this.#session(identity),active=AbortSignal.any([session.controller.signal,...(signal?[signal]:[])]);if(!session.error){try{for(const entry of session.entries){active.throwIfAborted();await wait(session.access(entry.binding),active);}}catch(error){if(signal?.aborted)throw error;this.#fail(session,error);}}this.#session(identity);session.expires=Date.now()+this.#limits.leaseMs;return this.#view(session);}
  async withSources<T>(identity:PreviewSessionIdentity,run:(sources:EditPreviewSource[],access:()=>Promise<void>,signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{
    const task=this.#withSources(identity,run,signal);this.#reads.add(task);try{return await task;}finally{this.#reads.delete(task);}
  }
  async #withSources<T>(identity:PreviewSessionIdentity,run:(sources:EditPreviewSource[],access:()=>Promise<void>,signal:AbortSignal)=>Promise<T>,signal?:AbortSignal):Promise<T>{
    const session=this.#session(identity);if(session.error)editFail(session.error);if(session.entries.some(e=>e.phase!=="ready"))editFail("Preview originals are still preparing. Wait for the source checks to finish.");const active=AbortSignal.any([session.controller.signal,...(signal?[signal]:[])]),access=async()=>{active.throwIfAborted();this.#session(identity);if(soundRuntimeRevision()!==this.#engine)editFail("Restart preview preparation with the current media runtime.");for(const entry of session.entries)await wait(session.access(entry.binding),active);active.throwIfAborted();};
    session.entries.forEach(e=>e.readers++);try{await access();const result=await run(session.entries.map(e=>e.preview!),access,active);await access();return result;}finally{for(const entry of session.entries){entry.readers--;entry.used=Date.now();entry.order=++this.#order;if(entry.phase==="removed"&&!entry.readers)this.#removeFiles(entry.directory);}}
  }
  release(identity:PreviewSessionIdentity):void{this.#release(this.#session(identity));this.#evict();}
  async close():Promise<void>{this.#closed=true;this.#controller.abort(stopped());clearInterval(this.#sweep);for(const session of this.#sessions.values())this.#release(session);for(const entry of this.#entries.values())this.#remove(entry);await Promise.allSettled([...this.#tasks,...this.#reads]);this.#removeFiles(this.#directory);}
}
