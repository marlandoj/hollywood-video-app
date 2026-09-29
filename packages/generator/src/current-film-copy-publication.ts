import {linkSync,lstatSync,mkdirSync,mkdtempSync,opendirSync,realpathSync,rmdirSync,unlinkSync,type Stats} from "node:fs";
import {open,type FileHandle} from "node:fs/promises";
import {createHash} from "node:crypto";
import {dirname,join,sep} from "node:path";
import {EDIT_STORAGE_LIMITS} from "../../planner/src/edit-resources";
import {editValidationKey} from "../../planner/src/edit-validation-key";
import type {RenderFile} from "../../planner/src/shot-reuse";
import {audioAbortable} from "./audio-stream";
import {assertEditFreeSpace} from "./edit-workspace";
import {currentFilmWorkspaceGuard} from "./current-film-workspace";
import {withEditSourceAccess} from "./edit-source-media";

export type CurrentFilmCopyScope = {
  projectId:string;jobId:string;jobPlanRevision:string;ordinal:number|null;specificationRevision:string;
}&({kind:"origins"|"adoption"}|{kind:"proof";largeFiles:RenderFile[]});
type Access=()=>Promise<void>;
const fail=(message:string):never=>{throw new Error(message);};
const exact=(value:object,keys:string[])=>{if(Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))fail("Retain exact current-film copy fields.");};
function stat(path:string):Stats|undefined {try{return lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return;throw error;}}
function same(stat:Stats,identity:Stats):boolean {return stat.dev===identity.dev&&stat.ino===identity.ino;}
function components(root:string,key:string,create=false):string {
  let path=root;
  for(const part of key.split("/")){
    path=join(path,part);if(create)try{mkdirSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
    const value=stat(path);if(!value){if(create)fail("The current-film copy directory disappeared.");return path;}
    if(value.isSymbolicLink()||realpathSync(path)!==path||!value.isDirectory())fail("Current-film copy refuses linked or non-directory components.");
  }return path;
}
function filePath(root:string,file:RenderFile):string {
  components(root,dirname(file.path).split(sep).join("/"));const path=join(root,file.path),value=stat(path);
  if(value&&(value.isSymbolicLink()||!value.isFile()||realpathSync(path)!==path||value.size!==file.bytes))fail("Existing current-film copy bytes or owned paths changed.");return path;
}
/** Reject unexpected final entries without touching them. Only exact expected
 * ancestor directories and a subset of full expected files may already exist. */
function subset(root:string,prefix:string,files:RenderFile[]):void {
  components(root,prefix);const path=join(root,prefix);if(!stat(path))return;
  const expected=new Set(files.map(file=>file.path)),directories=new Set<string>([prefix]);
  for(const file of files){let parent=dirname(file.path).split(sep).join("/");while(parent.startsWith(prefix+"/")){directories.add(parent);parent=dirname(parent).split(sep).join("/");}}
  let count=0;const walk=(key:string)=>{const directory=opendirSync(join(root,key));try{for(let item=directory.readSync();item;item=directory.readSync()){
    if(++count>EDIT_STORAGE_LIMITS.files*4)fail("The current-film copy namespace exceeds its capacity.");
    const child=key+"/"+item.name,path=join(root,child),value=lstatSync(path);
    if(value.isSymbolicLink()||realpathSync(path)!==path)fail("Current-film copy refuses linked entries.");
    if(value.isDirectory()){if(!directories.has(child))fail("The current-film copy contains an unknown directory.");walk(child);}
    else if(!value.isFile()||!expected.has(child))fail("The current-film copy contains an unknown file.");
  }}finally{directory.closeSync();}};walk(prefix);
}
async function checkedFile(root:string,file:RenderFile,access:Access,signal:AbortSignal,blockBytes:number):Promise<boolean> {
  const path=filePath(root,file),before=stat(path);if(!before)return false;
  const handle=await open(path,"r");try{
    const held=await handle.stat();if(!same(held,before)||held.size!==file.bytes)fail("The current-film copy changed while opening it.");
    const buffer=Buffer.alloc(blockBytes),hash=createHash("sha256");let bytes=0;
    // The exact recorded length bounds this read. The final inode/size and
    // digest checks detect growth or truncation without an extra EOF read.
    while(bytes<file.bytes){signal.throwIfAborted();await audioAbortable(access(),signal);signal.throwIfAborted();const {bytesRead}=await handle.read(buffer,0,Math.min(buffer.length,file.bytes-bytes),null);
      if(!bytesRead)break;bytes+=bytesRead;if(bytes>file.bytes)fail("Existing current-film copy exceeds its recorded size.");hash.update(buffer.subarray(0,bytesRead));}
    const after=stat(path);if(bytes!==file.bytes||hash.digest("hex")!==file.sha256||!after||!same(after,held)||after.size!==file.bytes)fail("Existing current-film copy failed checksum verification.");
    signal.throwIfAborted();return true;
  }finally{await handle.close();}
}
/** One logical current-film read holds at most its bounded block plus the current raw
 * chunk. Every raw pull remains abortable; the caller checks current authority
 * before each logical block and write, while its access monitor stays active.
 * A raw-pull cap yields small partial blocks and refuses empty busy loops. */
function copyBlockReader(reader:ReadableStreamDefaultReader<Uint8Array>,signal:AbortSignal,blockBytes:number):{read:()=>Promise<ReadableStreamReadResult<Uint8Array>>;exhausted:()=>boolean} {
  let pending:Uint8Array|undefined,offset=0,ended=false;
  return {exhausted:()=>ended&&!pending,read:async()=>{
    signal.throwIfAborted();if(ended&&!pending)return {done:true,value:undefined};
    const block=new Uint8Array(blockBytes);let length=0,pulls=0;
    while(length<blockBytes){
      signal.throwIfAborted();
      if(pending){
        const count=Math.min(blockBytes-length,pending.byteLength-offset);block.set(pending.subarray(offset,offset+count),length);length+=count;offset+=count;
        if(offset===pending.byteLength){pending=undefined;offset=0;}
      }else if(ended)break;
      else {if(pulls===1024){if(!length)fail("The current-film copy stream made no bounded progress.");break;}pulls++;
        const next=await audioAbortable(reader.read(),signal);signal.throwIfAborted();
        if(next.done)ended=true;else if(next.value.byteLength)pending=next.value;
      }
    }
    return length?{done:false,value:block.subarray(0,length)}:{done:true,value:undefined};
  }};
}
function cleanup(stage:string,identity:Stats,temporary:Map<string,Stats>):void {
  const current=stat(stage);if(!current)return;
  if(current.isSymbolicLink()||!current.isDirectory()||realpathSync(stage)!==stage||!same(current,identity))fail("The private current-film copy staging identity changed.");
  for(const [path,owned] of temporary){const value=stat(path);if(!value)continue;
    if(value.isSymbolicLink()||!value.isFile()||realpathSync(path)!==path||!same(value,owned))fail("The private current-film copy file identity changed.");unlinkSync(path);}
  // Never recurse through discovered paths or delete another attempt's staging.
  rmdirSync(stage);
}

/** Internal byte preparation, never custody or permission. Caller supplies the
 * exact compiled scope/files and must verify complete native media before using
 * the result in its held checkpoint. Published names are never written/deleted. */
export async function prepareCurrentFilmCopyFiles(
  artifactRoot:string,input:CurrentFilmCopyScope,inputFiles:RenderFile[],
  read:(file:RenderFile,signal:AbortSignal)=>Promise<Response>,access:Access,signal?:AbortSignal,
):Promise<void> {
  signal?.throwIfAborted();if(!editValidationKey({input,inputFiles},64*1024**2))fail("Retain bounded portable current-film copy metadata.");
  const {input:scope,inputFiles:files}=structuredClone({input,inputFiles});
  exact(scope,["projectId","jobId","jobPlanRevision","kind","ordinal","specificationRevision",...(scope.kind==="proof"?["largeFiles"]:[])]);
  for(const id of [scope.projectId,scope.jobId])if(typeof id!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(id))fail("Use an exact current-film copy owner.");
  for(const revision of [scope.jobPlanRevision,scope.specificationRevision])if(typeof revision!=="string"||!/^[a-f0-9]{64}$/.test(revision))fail("Bind the complete current-film copy specification.");
  if(!["origins","adoption","proof"].includes(scope.kind)||(scope.kind!=="adoption"?scope.ordinal!==null:!Number.isSafeInteger(scope.ordinal)||scope.ordinal!<0||scope.ordinal!>=60))fail("Use an exact current-film copy phase.");
  // All current-film copy phases use at most one MiB per logical read/write and
  // digest read. Origins/adoption previously checked at 64 KiB: this deliberately
  // changes the byte interval, never caches authority. Every partial write, raw
  // pull cancellation, live access monitor and final publication fence remains.
  const blockBytes=1024*1024;
  const jobKey=scope.projectId+"/"+scope.jobId,prefix=jobKey+(scope.kind==="origins"?"/originals":scope.kind==="proof"?"/proof":"/reused/slot-"+String(scope.ordinal).padStart(4,"0"));
  if(!Array.isArray(files)||!files.length||files.length>EDIT_STORAGE_LIMITS.files)fail("Retain a complete bounded copy inventory.");
  const large=new Map<string,RenderFile>();
  if(scope.kind==="proof"){
    if(!Array.isArray(scope.largeFiles)||scope.largeFiles.length>256)fail("Retain the bounded exact proof picture allowlist.");
    for(const value of scope.largeFiles){exact(value,["path","sha256","bytes"]);
      if(typeof value.path!=="string"||!value.path.endsWith(".mp4")||large.has(value.path))fail("Retain distinct exact proof picture roles.");large.set(value.path,value);}
  }
  let total=0;const keys=new Set<string>();for(const file of files){exact(file,["path","sha256","bytes"]);
    if(typeof file.path!=="string"||file.path.length>1024||!file.path.startsWith(prefix+"/")||!/^[A-Za-z0-9._/-]+$/.test(file.path)||file.path.split("/").some(part=>!part||part==="."||part==="..")||keys.has(file.path))fail("Current-film copies must have distinct exact owned paths.");
    const allowed=large.get(file.path);
    if(allowed&&(allowed.sha256!==file.sha256||allowed.bytes!==file.bytes))fail("The exact proof picture allowlist changed.");
    if(typeof file.sha256!=="string"||!/^[a-f0-9]{64}$/.test(file.sha256)||!Number.isSafeInteger(file.bytes)||file.bytes<1||file.bytes>(allowed?EDIT_STORAGE_LIMITS.workspaceBytes:8*1024**3)||(total+=file.bytes)>(scope.kind==="proof"?EDIT_STORAGE_LIMITS.workspaceBytes:EDIT_STORAGE_LIMITS.outputBytes))fail("Current-film copy bytes exceed their capacity.");keys.add(file.path);}
  if([...large.keys()].some(key=>!keys.has(key)))fail("Retain only proof pictures in the exact copy inventory.");
  const rootStat=lstatSync(artifactRoot);if(rootStat.isSymbolicLink()||!rootStat.isDirectory())fail("Use a real current-film copy workspace.");const root=realpathSync(artifactRoot);
  await withEditSourceAccess(access,signal,async active=>{
    await audioAbortable(access(),active);subset(root,prefix,files);
    components(root,jobKey,true);const guard=currentFilmWorkspaceGuard(root,scope.projectId,scope.jobId);guard.check(true);
    const current=async()=>{active.throwIfAborted();guard.check();await audioAbortable(access(),active);active.throwIfAborted();components(root,jobKey);};
    const missing:RenderFile[]=[];for(const file of files){
      // Missing proof roles need only synchronous owned-path inspection here.
      // Existing bytes are checked with fresh access inside checkedFile, and
      // every source read/publication below still has its own current fence.
      active.throwIfAborted();if(scope.kind!=="proof")await current();
      if(!await checkedFile(root,file,current,active,blockBytes))missing.push(file);
    }
    if(scope.kind==="proof")guard.check(true,{bytes:missing.reduce((bytes,file)=>bytes+file.bytes,0),files:missing.length});
    assertEditFreeSpace(root,missing.reduce((bytes,file)=>bytes+file.bytes,0));
    if(!missing.length){subset(root,prefix,files);await current();guard.check(true);return;}
    const stagingParent=components(root,jobKey+"/.mixed-copy",true),stage=mkdtempSync(join(stagingParent,"attempt-")),identity=lstatSync(stage),temporary=new Map<string,Stats>();
    try{for(const [index,file] of missing.entries()){
      await current();if(await checkedFile(root,file,current,active,blockBytes))continue;
      const response=await audioAbortable(read(structuredClone(file),active),active,late=>{void late?.body?.cancel().catch(()=>{});});
      if(!response?.ok||!response.body||response.headers.get("etag")!=='"'+file.sha256+'"'||response.headers.get("content-length")!==String(file.bytes)){
        void response?.body?.cancel().catch(()=>{});fail("The authenticated current-film copy carrier changed or disappeared.");}
      const path=join(stage,`file-${index}.copy`),reader=response.body!.getReader(),blocks=copyBlockReader(reader,active,blockBytes);let output:FileHandle|undefined;
      try{
        output=await open(path,"wx");temporary.set(path,await output.stat());const hash=createHash("sha256");let bytes=0;
        // A short block may already have observed stream EOF. Do not
        // schedule another authority check for a read that cannot occur.
        while(!blocks.exhausted()){await current();const next=await blocks.read();active.throwIfAborted();if(next.done)break;
          bytes+=next.value.byteLength;if(bytes>file.bytes)fail("The current-film copy stream exceeds its recorded size.");hash.update(next.value);
          for(let offset=0;offset<next.value.byteLength;){await current();const length=Math.min(blockBytes,next.value.byteLength-offset),{bytesWritten}=await output.write(next.value,offset,length);
            if(bytesWritten<1)fail("The current-film copy could not write its complete body.");offset+=bytesWritten;}
        }
        if(bytes!==file.bytes||hash.digest("hex")!==file.sha256)fail("The staged current-film copy failed checksum verification.");
      }finally{void reader.cancel().then(()=>reader.releaseLock()).catch(()=>{});await output?.close();}
      // The closed, independently checked inode is immutable from this point.
      const local={...file,path:path.slice(root.length+1).split(sep).join("/")};await checkedFile(root,local,current,active,blockBytes);await current();
      components(root,dirname(file.path).split(sep).join("/"),true);const destination=filePath(root,file);
      try{linkSync(path,destination);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw new Error("Atomic no-clobber current-film publication is unavailable on this filesystem.",{cause:error});
        if(!await checkedFile(root,file,current,active,blockBytes))fail("The competing current-film copy disappeared.");}
      // Removing only our temporary name cannot remove another holder's final file.
      const held=stat(path);if(!held||!same(held,temporary.get(path)!))fail("The private current-film copy file changed before release.");unlinkSync(path);temporary.delete(path);await current();
    }
      subset(root,prefix,files);for(const file of files)if(!await checkedFile(root,file,current,active,blockBytes))fail("The complete current-film copy lost a role.");await current();
      // The periodic monitor must not omit a fast operation's final capacity check.
      guard.check(true);
    }finally{cleanup(stage,identity,temporary);}
  });
}
