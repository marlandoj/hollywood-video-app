import {createHash} from "node:crypto";
import {existsSync,mkdtempSync,readFileSync,realpathSync,rmSync,statSync} from "node:fs";
import {join,sep} from "node:path";
import {contentHash} from "./capabilities";
import {editWorkspaceGuard} from "./edit-workspace";
import {PREVIEW_MAX_BYTES,type PreviewPageIdentity,type PreviewSelection} from "../../planner/src/edit-preview-protocol";
import type {RenderFile} from "../../planner/src/shot-reuse";
import type {EditPreviewSource} from "./edit-preview-media";
type Source=Pick<EditPreviewSource,"sourceKey"|"identity"|"page">;
type Access=()=>Promise<void>;
type Result={identity:PreviewPageIdentity;file:RenderFile};
type Consumer={access:Access;controller:AbortController;signal:AbortSignal};
interface Entry {
  key:string;source:Source;identity:PreviewPageIdentity;directory:string;controller:AbortController;consumers:Set<Consumer>;
  state:"queued"|"running"|"ready"|"removed";used:number;order:number;result?:Result;promise:Promise<Result>;resolve:(result:Result)=>void;reject:(error:unknown)=>void;
  timer?:ReturnType<typeof setTimeout>;
}
export interface PreviewCacheLimits {bytes:number;pages:number;concurrency:number;pending:number;readers:number;idleMs:number;deadlineMs:number}
export const PREVIEW_CACHE_LIMITS:PreviewCacheLimits={bytes:512*1024**2,pages:512,concurrency:2,pending:32,readers:32,idleMs:15*60*1000,deadlineMs:60000};
function interrupted(){return new Error("Preview loading stopped. Prepare or request the current frame again.");}
async function waiting<T>(promise:Promise<T>,signal:AbortSignal):Promise<T>{
  signal.throwIfAborted();let abort:()=>void=()=>{};try{return await Promise.race([promise,new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason??interrupted());signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();})]);}finally{signal.removeEventListener("abort",abort);}
}
/** Private process-owned LRU. Consumers share work, while cancellation and permission stay independent. */
export class EditPreviewPageCache {
  readonly #root:string;
  readonly #directory:string;
  readonly #limits:PreviewCacheLimits;
  readonly #entries=new Map<string,Entry>();
  readonly #queue:Entry[]=[];
  readonly #tasks=new Set<Promise<void>>();
  readonly #controller=new AbortController();
  readonly #disk:()=>void;
  #bytes=0;#running=0;#readers=0;#order=0;#closed=false;
  constructor(root:string,limits:Partial<PreviewCacheLimits>={}){
    this.#limits={...PREVIEW_CACHE_LIMITS,...limits};const l=this.#limits;
    if(!Number.isSafeInteger(l.bytes)||l.bytes<PREVIEW_MAX_BYTES||l.bytes>2*1024**3||!Number.isSafeInteger(l.pages)||l.pages<1||l.pages>4096||!Number.isSafeInteger(l.concurrency)||l.concurrency<1||l.concurrency>4||!Number.isSafeInteger(l.pending)||l.pending<1||l.pending>64||!Number.isSafeInteger(l.readers)||l.readers<1||l.readers>128||!Number.isSafeInteger(l.idleMs)||l.idleMs<1000||l.idleMs>3600000||!Number.isSafeInteger(l.deadlineMs)||l.deadlineMs<100||l.deadlineMs>120000)throw new Error("Invalid preview cache capacity.");
    this.#root=realpathSync(root);this.#directory=mkdtempSync(join(this.#root,".edit-preview-pages-"));
    this.#disk=editWorkspaceGuard(this.#root,()=>[this.#directory],{bytes:l.bytes+l.concurrency*64*1024**2,files:l.pages+l.concurrency*70});
  }
  get stats(){return {pages:[...this.#entries.values()].filter(e=>e.state==="ready").length,bytes:this.#bytes,running:this.#running,pending:[...this.#entries.values()].filter(e=>e.state==="queued"||e.state==="running").length,queued:this.#queue.length,readers:this.#readers,closed:this.#closed};}
  #removeFiles(path:string){if(!existsSync(path))return;if(!path.startsWith(this.#root+sep)||realpathSync(path)!==path||path!==this.#directory&&!path.startsWith(this.#directory+sep))throw new Error("Preview cache cleanup escaped its workspace.");rmSync(path,{recursive:true,force:true});}
  #remove(entry:Entry,error:unknown=interrupted()){
    if(entry.state==="removed")return;const running=entry.state==="running";
    if(entry.state==="ready")this.#bytes-=entry.result!.file.bytes;
    const queued=this.#queue.indexOf(entry);if(queued!==-1)this.#queue.splice(queued,1);
    clearTimeout(entry.timer);entry.state="removed";entry.reject(error);entry.controller.abort(error);this.#entries.delete(entry.key);
    // A running producer removes its files only after it has stopped writing.
    if(!running)this.#removeFiles(entry.directory);
  }
  #evict(bytes:number,pages:number){const available=[...this.#entries.values()].filter(e=>e.state==="ready"&&!e.consumers.size).sort((a,b)=>a.order-b.order);let remaining=this.stats.pages;
    for(const entry of available){if(this.#bytes+bytes<=this.#limits.bytes&&remaining+pages<=this.#limits.pages&&Date.now()-entry.used<this.#limits.idleMs)break;this.#remove(entry);remaining--;}
    if(this.#bytes+bytes>this.#limits.bytes||remaining+pages>this.#limits.pages)throw new Error("Preview pages are busy. Wait for current frame requests to finish and retry.");
  }
  async #access(entry:Entry){this.#disk();entry.controller.signal.throwIfAborted();let permitted=0;
    // Snapshot the readers: new requests can arrive while permission checks await I/O.
    for(const consumer of Array.from(entry.consumers)){if(consumer.signal.aborted)continue;try{await waiting(consumer.access(),consumer.signal);consumer.signal.throwIfAborted();permitted++;}catch(error){consumer.controller.abort(error);}}
    if(!permitted)throw interrupted();entry.controller.signal.throwIfAborted();
  }
  #drain(){while(!this.#closed&&this.#running<this.#limits.concurrency&&this.#queue.length){const entry=this.#queue.shift()!;if(entry.state!=="queued")continue;entry.state="running";this.#running++;
    const task=(async()=>{try{const result=await entry.source.page(entry.identity.from,entry.directory,()=>this.#access(entry),entry.controller.signal,{includePicture:entry.identity.includePicture,audioLanes:entry.identity.audioLanes,...(entry.identity.pictureFrames?{pictureFrames:entry.identity.pictureFrames}:{})});await this.#access(entry);
        if(contentHash(result.identity)!==contentHash(entry.identity)||result.file.path!==join(entry.directory,"page.hvp").slice(this.#root.length+1).split(sep).join("/")||result.file.bytes<1||result.file.bytes>PREVIEW_MAX_BYTES)throw new Error("The prepared preview page changed its identity or capacity.");
        this.#evict(result.file.bytes,1);clearTimeout(entry.timer);entry.result=result;entry.state="ready";entry.used=Date.now();entry.order=++this.#order;this.#bytes+=result.file.bytes;entry.resolve(result);
      }catch(error){this.#remove(entry,error);this.#removeFiles(entry.directory);}
      finally{this.#running--;queueMicrotask(()=>this.#drain());}
    })();this.#tasks.add(task);void task.finally(()=>this.#tasks.delete(task)).catch(()=>{});
  }}
  async read(source:Source,from:number,access:Access,signal?:AbortSignal,selection?:PreviewSelection):Promise<{identity:PreviewPageIdentity;sha256:string;bytes:Uint8Array}>{
    if(this.#closed)throw interrupted();if(this.#readers>=this.#limits.readers)throw new Error("Preview reader capacity is full. Wait for current requests and retry.");this.#readers++;
    const deadline=new AbortController(),timer=setTimeout(()=>deadline.abort(new Error("Preview loading timed out. Request the frame again.")),this.#limits.deadlineMs);timer.unref();
    const combined=AbortSignal.any([this.#controller.signal,deadline.signal,...(signal?[signal]:[])]);
    try{return await this.#read(source,from,access,combined,selection);}finally{clearTimeout(timer);this.#readers--;}
  }
  async #read(source:Source,from:number,access:Access,signal?:AbortSignal,selection?:PreviewSelection):Promise<{identity:PreviewPageIdentity;sha256:string;bytes:Uint8Array}>{
    if(signal)await waiting(access(),signal);else await access();signal?.throwIfAborted();if(this.#closed)throw interrupted();const identity=source.identity(from,selection),key=contentHash(identity);this.#evict(0,0);let entry=this.#entries.get(key);
    if(!entry){if(this.stats.pending>=this.#limits.pending)throw new Error("Preview request capacity is full. Wait for current requests before loading more frames.");let resolve!:(result:Result)=>void,reject!:(error:unknown)=>void;const promise=new Promise<Result>((a,b)=>{resolve=a;reject=b;});void promise.catch(()=>{});
      entry={key,source,identity,directory:join(this.#directory,crypto.randomUUID()),controller:new AbortController(),consumers:new Set(),state:"queued",used:Date.now(),order:++this.#order,promise,resolve,reject};this.#entries.set(key,entry);this.#queue.push(entry);
      const timed=entry;entry.timer=setTimeout(()=>this.#remove(timed,new Error("Preview preparation timed out. Request the frame again.")),this.#limits.deadlineMs);entry.timer.unref();
    }
    const controller=new AbortController(),combined=AbortSignal.any([controller.signal,entry.controller.signal,...(signal?[signal]:[])]),consumer:Consumer={access,controller,signal:combined};entry.consumers.add(consumer);this.#drain();
    try{const result=entry.state==="ready"?entry.result!:await waiting(entry.promise,combined);await waiting(access(),combined);combined.throwIfAborted();if(this.#closed)throw interrupted();
      let bytes:Uint8Array;
      try{const path=join(this.#root,result.file.path);if(!path.startsWith(entry.directory+sep)||realpathSync(path)!==path||statSync(path).size!==result.file.bytes)throw new Error("Invalid cached page.");
        bytes=readFileSync(path);if(createHash("sha256").update(bytes).digest("hex")!==result.file.sha256)throw new Error("Invalid cached page.");
      }catch{const error=new Error("The cached preview page changed. Request it again.");this.#remove(entry,error);throw error;}
      entry.used=Date.now();entry.order=++this.#order;return {identity:structuredClone(result.identity),sha256:result.file.sha256,bytes};
    }finally{entry.consumers.delete(consumer);if(!entry.consumers.size&&entry.state!=="ready")this.#remove(entry);}
  }
  async close():Promise<void>{this.#closed=true;this.#controller.abort(interrupted());for(const entry of this.#entries.values())this.#remove(entry);await Promise.allSettled(this.#tasks);this.#removeFiles(this.#directory);}
}
