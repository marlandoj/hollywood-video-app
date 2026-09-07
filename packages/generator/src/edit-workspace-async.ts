import {lstat,readdir,realpath,statfs} from "node:fs/promises";
import {join,resolve,sep} from "node:path";
import {editFail} from "../../planner/src/edit-timeline";
import {EDIT_STORAGE_LIMITS} from "../../planner/src/edit-resources";
type Limits={bytes:number;files:number};
function stopped(){return new Error("Preview workspace checking stopped. Reopen the current preview.");}
function missing(error:unknown){return (error as NodeJS.ErrnoException)?.code==="ENOENT";}
export async function assertEditFreeSpaceAsync(root:string,requiredBytes:number){
  const disk=await statfs(root,{bigint:true});if(disk.bavail*disk.bsize<BigInt(Math.ceil(requiredBytes+EDIT_STORAGE_LIMITS.freeReserveBytes)))editFail("The editorial worker needs more free workspace. Free space or use a smaller assembly, then retry the saved sequence.");
}
/** Read-only traversal; completed cache entries can be evicted between filesystem reads. */
export async function scanEditWorkspace(root:string,paths:readonly string[],limits:Limits,signal:AbortSignal):Promise<void>{
  signal.throwIfAborted();const base=await realpath(root);signal.throwIfAborted();if(base!==root)editFail("Editorial workspace escaped its owner.");
  await assertEditFreeSpaceAsync(base,0);signal.throwIfAborted();let bytes=0,files=0;
  const visit=async(path:string):Promise<void>=>{
    signal.throwIfAborted();let stat,canonical;
    try{stat=await lstat(path);signal.throwIfAborted();if(stat.isSymbolicLink())editFail("Editorial workspace escaped its owner.");canonical=await realpath(path);}catch(error){signal.throwIfAborted();if(missing(error))return;throw error;}
    signal.throwIfAborted();if(canonical!==path||!canonical.startsWith(base+sep))editFail("Editorial workspace escaped its owner.");
    if(stat.isDirectory()){
      let names:string[];try{names=await readdir(path);}catch(error){signal.throwIfAborted();if(missing(error))return;throw error;}
      for(const name of names){signal.throwIfAborted();await visit(join(path,name));}
    }else if(stat.isFile()){bytes+=stat.size;files++;if(bytes>limits.bytes||files>limits.files)editFail("Editorial processing exceeded its workspace capacity. The sequence is saved; reduce its sources or export size before retrying.");}
    else editFail("Invalid editorial workspace file.");
  };
  const scoped=[...new Set(paths.map(path=>resolve(path)))];
  for(const path of scoped){signal.throwIfAborted();if(!path.startsWith(base+sep))editFail("Editorial workspace escaped its owner.");if(!scoped.some(other=>other!==path&&path.startsWith(other+sep)))await visit(path);}
  signal.throwIfAborted();
}
async function waiting(task:Promise<void>,signal:AbortSignal){
  signal.throwIfAborted();let abort=()=>{};
  try{await Promise.race([task,new Promise<never>((_resolve,reject)=>{abort=()=>reject(signal.reason??stopped());signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();})]);}
  finally{signal.removeEventListener("abort",abort);}
}
/** One scan at a time, at most once per second. A failed check stays failed until a new scan succeeds. */
export class EditWorkspaceCheck {
  readonly #controller=new AbortController();#task?:Promise<void>;#running=false;#at=-Infinity;
  constructor(readonly scan:(signal:AbortSignal)=>Promise<void>,readonly now=()=>performance.now()){}
  async check(signal?:AbortSignal):Promise<void>{
    const active=signal?AbortSignal.any([this.#controller.signal,signal]):this.#controller.signal;active.throwIfAborted();const at=this.now();
    if(!this.#task||!this.#running&&(at<this.#at||at-this.#at>=1000)){
      this.#at=at;this.#running=true;
      this.#task=Promise.resolve().then(()=>{this.#controller.signal.throwIfAborted();return this.scan(this.#controller.signal);}).finally(()=>{this.#running=false;});
      void this.#task.catch(()=>{});
    }
    await waiting(this.#task,active);active.throwIfAborted();
  }
  // Node filesystem reads cannot be interrupted mid-call. Detach callers immediately; the one
  // read-only scan checks this signal before issuing any further I/O and retains no open directory.
  close(){this.#controller.abort(stopped());}
}
