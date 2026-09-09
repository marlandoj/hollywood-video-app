// Optional local test evidence only. No workers, token minting, or teardown bypass.
import {createHash} from "node:crypto";
import {constants} from "node:fs";
import {lstat,mkdir,open,opendir,realpath} from "node:fs/promises";
import {dirname,isAbsolute,join,relative,resolve,sep} from "node:path";
import {referenceLocalKey} from "../../planner/src/references";
import {writeStateSnapshot,type StateSnapshot} from "../src/snapshots";

const MiB=1024**2,MAX_BYTES=8*1024**3,MAX_FILES=20000,MAX_ENTRIES=50000,MAX_DEPTH=64;
const METADATA_BYTES=256*MiB,DIAGNOSTIC_BYTES=MiB;
type Check=()=>void;
type Owner={projectId:string;token:string};
type FileRow={path:string;bytes:number;sha256:string};
type Stamp={dev:number;ino:number;size:number;mtimeMs:number;ctimeMs:number};
const sha=(bytes:string|Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const fail=()=>{throw new Error("Optional local browser capture failed its bounded ownership or consistency checks.");};
const same=(a:Stamp,b:Stamp)=>a.dev===b.dev&&a.ino===b.ino&&a.size===b.size&&a.mtimeMs===b.mtimeMs&&a.ctimeMs===b.ctimeMs;
function json(value:unknown):string{const text=JSON.stringify(value);if(typeof text!=="string"||Buffer.byteLength(text)>METADATA_BYTES)fail();return text;}

/** Every component must be an existing real directory; no symbolic-link ancestry. */
async function directory(path:string,check:Check):Promise<void>{
  const absolute=resolve(path),chain:string[]=[];let at=absolute;
  for(;;){chain.push(at);const parent=dirname(at);if(parent===at)break;at=parent;}
  for(const component of chain.reverse()){
    check();const stat=await lstat(component);check();
    if(stat.isSymbolicLink()||!stat.isDirectory())fail();
    const canonical=await realpath(component);
    // Bun 1.4 on Windows reports a drive root as H: instead of H:\.
    const driveRoot=/^[A-Za-z]:\\$/.test(component)&&canonical===component.slice(0,-1);
    if(canonical!==component&&!driveRoot)fail();check();
  }
}
async function ownedDirectory(root:string,path:string,check:Check):Promise<void>{
  if(path!==root&&!path.startsWith(root+sep))fail();await directory(root,check);
  const parts=relative(root,path).split(sep).filter(Boolean);let at=root;
  for(const part of parts){if(part==="."||part==="..")fail();at=join(at,part);check();
    try{await mkdir(at,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
    await directory(at,check);
  }
}
/** An awaited handle read is never abandoned on cancellation. The owning phase
 * drains this promise before teardown; each bounded read/write rechecks signal. */
async function file(source:string,target:string|undefined,limit:number,check:Check,expected?:Stamp):Promise<{bytes:number;sha256:string}>{
  await directory(dirname(source),check);check();const before=await lstat(source);check();
  if(expected&&!same(before,expected))fail();
  if(!before.isFile()||before.isSymbolicLink()||!Number.isSafeInteger(before.size)||before.size<0||before.size>limit)fail();
  const input=await open(source,constants.O_RDONLY|(constants.O_NOFOLLOW??0));let output:Awaited<ReturnType<typeof open>>|undefined;
  try{
    check();if(!same(before,await input.stat()))fail();check();
    if(target){await directory(dirname(target),check);output=await open(target,"wx",0o600);check();}
    const hash=createHash("sha256"),buffer=Buffer.allocUnsafe(MiB);let size=0;
    for(;;){check();const read=await input.read(buffer,0,Math.min(MiB,before.size-size+1),null);check();
      if(!read.bytesRead)break;size+=read.bytesRead;if(size>before.size||size>limit)fail();const chunk=buffer.subarray(0,read.bytesRead);hash.update(chunk);
      if(output){let offset=0;while(offset<chunk.length){check();const written=await output.write(chunk,offset,chunk.length-offset);check();if(!written.bytesWritten)fail();offset+=written.bytesWritten;}}
    }
    check();const after=await input.stat();check();const current=await lstat(source);check();
    if(size!==before.size||!current.isFile()||current.isSymbolicLink()||!same(before,after)||!same(before,current))fail();
    if(output){await output.sync();check();}return {bytes:size,sha256:hash.digest("hex")};
  }finally{try{await output?.close();}finally{await input.close();}}
}
async function write(root:string,path:string,value:unknown,check:Check):Promise<void>{
  const text=json(value);await ownedDirectory(root,dirname(path),check);check();const handle=await open(path,"wx",0o600);
  try{check();await handle.writeFile(text);check();await handle.sync();check();}finally{await handle.close();}
}

/** File namespaces are selected only from validated top-level jobs and the exact
 * project reference catalog. Full job-owned HLS/manifest/proof trees are retained;
 * unrelated project children and undeclared reference files refuse capture. */
async function inventory(root:string,state:StateSnapshot,check:Check):Promise<{path:string;bytes:number}[]>{
  if(state.projects.projects.length!==1)fail();const project=state.projects.projects[0]!;
  const jobs=new Set(state.jobs.map(job=>job.id)),references=new Set((project.referenceAssets??[]).map(referenceLocalKey));
  if(state.jobs.some(job=>job.projectId!==project.id||!["done","failed","cancelled"].includes(job.status))||state.ledger.reservations.length)fail();
  const start=join(root,project.id);await directory(start,check);
  const stack=[{path:start,depth:0}],files:{path:string;bytes:number}[]=[];let entries=0,total=Buffer.byteLength(json(state))+2*MiB;
  while(stack.length){const next=stack.pop()!;if(next.depth>MAX_DEPTH)fail();check();const children=await opendir(next.path);
    for await(const child of children){const name=child.name;check();if(++entries>MAX_ENTRIES||name==="."||name==="..")fail();const path=join(next.path,name),key=relative(root,path).split(sep).join("/");
      const parts=key.split("/"),owner=parts[1];if(parts[0]!==project.id||!owner||owner!=="references"&&!jobs.has(owner))fail();
      const stat=await lstat(path);check();if(stat.isSymbolicLink())fail();
      if(stat.isDirectory()){stack.push({path,depth:next.depth+1});continue;}
      if(!stat.isFile()||owner==="references"&&!references.has(key)||!Number.isSafeInteger(stat.size)||stat.size<0||stat.size>MAX_BYTES)fail();
      total+=stat.size;if(total>MAX_BYTES||files.length>=MAX_FILES)fail();files.push({path:key,bytes:stat.size});
    }
  }
  for(const path of references)if(!files.some(file=>file.path===path))fail();
  return files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
}


/** Windows modes alone do not protect tokens. Operate only on our just-created
 * UUID leaf; existing parent ACLs are never modified. Verify again before auth. */
async function privateAcl(root:string,signal:AbortSignal,check:Check,install=false):Promise<void>{
  if(process.platform!=="win32")fail();await directory(root,check);check();
  const script=String.raw`$ErrorActionPreference='Stop'
$capturePath=$env:HV_CAPTURE_OWNED_DIRECTORY
$captureItem=Get-Item -LiteralPath $capturePath -Force
if(-not $captureItem.PSIsContainer -or ($captureItem.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unsafe capture directory'}
$captureUser=[Security.Principal.WindowsIdentity]::GetCurrent().User
$captureSystem=[Security.Principal.SecurityIdentifier]::new('S-1-5-18')
if($env:HV_CAPTURE_INSTALL_ACL -eq '1'){
  $captureAcl=[Security.AccessControl.DirectorySecurity]::new()
  $captureAcl.SetOwner($captureUser)
  $captureAcl.SetAccessRuleProtection($true,$false)
  foreach($captureSid in @($captureUser,$captureSystem)){
    $captureRule=[Security.AccessControl.FileSystemAccessRule]::new($captureSid,[Security.AccessControl.FileSystemRights]::FullControl,[Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow)
    $captureAcl.AddAccessRule($captureRule)
  }
  Set-Acl -LiteralPath $capturePath -AclObject $captureAcl
}
$captureAcl=Get-Acl -LiteralPath $capturePath
$captureRules=@($captureAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier]))
if(-not $captureAcl.AreAccessRulesProtected -or $captureRules.Count -ne 2 -or $captureAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $captureUser.Value){throw 'Capture ACL unavailable'}
foreach($captureSid in @($captureUser.Value,$captureSystem.Value)){
  $captureMatches=@($captureRules | Where-Object {$_.IdentityReference.Value -eq $captureSid})
  if($captureMatches.Count -ne 1){throw 'Capture ACL identity mismatch'}
  $captureRule=$captureMatches[0]
  if($captureRule.IsInherited -or $captureRule.AccessControlType -ne 'Allow' -or $captureRule.FileSystemRights -ne [Security.AccessControl.FileSystemRights]::FullControl -or $captureRule.InheritanceFlags -ne [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit' -or $captureRule.PropagationFlags -ne 'None'){throw 'Capture ACL rule mismatch'}
}
[Console]::Out.Write('private-acl-ok')`;
  const runtime=join(process.env.SystemRoot??"C:/Windows","System32/WindowsPowerShell/v1.0");
  const child=Bun.spawn([join(runtime,"powershell.exe"),"-NoLogo","-NoProfile","-NonInteractive","-Command",script],{stdout:"pipe",stderr:"pipe",env:{...process.env,PSModulePath:join(runtime,"Modules"),HV_CAPTURE_OWNED_DIRECTORY:root,HV_CAPTURE_INSTALL_ACL:install?"1":"0"}});
  const abort=()=>child.kill();signal.addEventListener("abort",abort,{once:true});if(signal.aborted)abort();
  const stdout=boundedCaptureText(child.stdout),stderr=boundedCaptureText(child.stderr);
  try{const [code,out,err]=await Promise.all([child.exited,stdout,stderr]);check();if(code!==0||err.nonempty||out.text!=="private-acl-ok"||out.truncated)fail();}
  catch(error){child.kill();await Promise.allSettled([child.exited,stdout,stderr]);throw error;}
  finally{signal.removeEventListener("abort",abort);}
}

/** No filesystem work when unset. The explicit opt-in must identify an absent
 * direct UUID child of the precreated private capture parent. Never deletes it. */
export function localSourceBrowserCapture(){
  const requested=process.env.HV_SOURCE_V4_BROWSER_CAPTURE_ROOT;if(!requested)return undefined;
  if(process.env.CI||process.env.GITHUB_ACTIONS)throw new Error("Local browser capture is disabled in CI.");
  const parent=resolve("H:/CodexTemp/hollywood-video-01a0728e/source-v4-browser-captures"),root=resolve(requested);
  if(!isAbsolute(requested)||dirname(root)!==parent||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(relative(parent,root)))fail();
  let reservation:Promise<void>|undefined,aReady=false,diagnostics=0;
  const reserve=(check:Check,signal:AbortSignal)=>reservation??=(async()=>{await directory(parent,check);check();await mkdir(root,{mode:0o700});check();await privateAcl(root,signal,check,true);})();
  const checked=(signal:AbortSignal,current:Check)=>()=>{signal.throwIfAborted();current();};
  return {
    async snapshot(read:()=>StateSnapshot,artifactRoot:string,owner:Owner,signal:AbortSignal,current:Check){
      const check=checked(signal,current);check();await reserve(check,signal);const destination=join(root,"A");await mkdir(destination,{mode:0o700});check();
      const state=read(),before=json(state);if(state.projects.projects[0]?.id!==owner.projectId||!owner.token||owner.token.length>4096)fail();
      // This existing writer performs complete historical metadata validation.
      const snapshotRoot=join(destination,"snapshot");writeStateSnapshot(snapshotRoot,state);check();
      const originals=await inventory(artifactRoot,state,check),copied:FileRow[]=[];
      const outputRoot=join(snapshotRoot,"artifacts");await ownedDirectory(root,outputRoot,check);
      for(const entry of originals){const target=join(outputRoot,entry.path);await ownedDirectory(root,dirname(target),check);
        const copiedFile=await file(join(artifactRoot,entry.path),target,MAX_BYTES,check);if(copiedFile.bytes!==entry.bytes)fail();copied.push({...entry,...copiedFile});}
      if(json(await inventory(artifactRoot,state,check))!==json(originals))fail();
      for(const entry of copied){const original=await file(join(artifactRoot,entry.path),undefined,MAX_BYTES,check),copy=await file(join(outputRoot,entry.path),undefined,MAX_BYTES,check);
        if(original.bytes!==entry.bytes||original.sha256!==entry.sha256||copy.bytes!==entry.bytes||copy.sha256!==entry.sha256)fail();}
      if(json(read())!==before)fail();
      await privateAcl(root,signal,check);
      await write(root,join(destination,"owner.private.json"),{...owner,profile:"dub-studio-fixture/1"},check);
      await write(root,join(destination,"ready.json"),{schema:"hv-local-browser-capture/1",point:"before-first-mixed-save",kind:"validated-snapshot-copy",snapshotSchema:state.schema,
        projectId:owner.projectId,stateSha256:sha(before),files:copied,createdAt:new Date().toISOString(),qualification:"Captured settled metadata and byte-equal owned media; archive/native validation required before independent browser restore."},check);
      aReady=true;
    },
    async archive(source:string,expected:Stamp,state:StateSnapshot,owner:Owner,signal:AbortSignal,current:Check){
      const check=checked(signal,current);check();if(!aReady)fail();await reserve(check,signal);const destination=join(root,"B");await mkdir(destination,{mode:0o700});check();
      if(state.schema!=="hv-state/16"||state.projects.projects.length!==1||state.projects.projects[0]!.id!==owner.projectId||state.jobs.length!==1||state.jobs[0]!.stage!=="picture-edit"||state.jobs[0]!.status!=="done"||state.ledger.reservations.length)fail();
      const target=join(destination,"approved-final.zip"),copied=await file(source,target,MAX_BYTES,check,expected),rechecked=await file(target,undefined,MAX_BYTES,check);
      if(json(copied)!==json(rechecked))fail();
      await privateAcl(root,signal,check);
      await write(root,join(destination,"owner.private.json"),{...owner,profile:"dub-studio-fixture/1"},check);
      await write(root,join(destination,"ready.json"),{schema:"hv-local-browser-capture/1",point:"after-carrier-only-independent-native-reverification",kind:"qualified-archive-copy",
        projectId:owner.projectId,carrierJobId:state.jobs[0]!.id,stateSha256:sha(json(state)),archive:copied,createdAt:new Date().toISOString()},check);
    },
    async diagnostics(code:number,stdout:{text:string;truncated:boolean},stderr:{text:string;truncated:boolean},signal:AbortSignal,current:Check){
      const check=checked(signal,current);check();await reserve(check,signal);if(++diagnostics>4)fail();
      if(Buffer.byteLength(stdout.text)>DIAGNOSTIC_BYTES||Buffer.byteLength(stderr.text)>DIAGNOSTIC_BYTES)fail();
      await write(root,join(root,"diagnostics",`archive-${diagnostics}.private.json`),{code,stdout,stderr},check);
    }
  };
}

/** Drain the complete child stream while retaining only a bounded private prefix.
 * Do not race/cancel an unobserved reader promise; child lifetime stays with test. */
export async function boundedCaptureText(stream:ReadableStream<Uint8Array>):Promise<{text:string;truncated:boolean;nonempty:boolean}>{
  const reader=stream.getReader(),chunks:Uint8Array[]=[];let retained=0,seen=0;
  try{for(;;){const next=await reader.read();if(next.done)break;seen+=next.value.byteLength;
    const keep=Math.min(next.value.byteLength,DIAGNOSTIC_BYTES-retained);if(keep){chunks.push(Uint8Array.from(next.value.subarray(0,keep)));retained+=keep;}}}
  finally{reader.releaseLock();}
  // A byte-bound prefix may end mid-codepoint; keep its replacement UTF-8 bounded.
  let text=Buffer.concat(chunks).toString("utf8");while(Buffer.byteLength(text)>DIAGNOSTIC_BYTES)text=text.slice(0,-1);
  return {text,truncated:seen>retained,nonempty:seen>0};
}
