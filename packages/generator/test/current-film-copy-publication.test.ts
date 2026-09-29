import {afterEach,expect,spyOn,test} from "bun:test";
import * as fs from "node:fs";
import type {FileHandle} from "node:fs/promises";
import {createHash} from "node:crypto";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {pathToFileURL} from "node:url";
import {spawn,type ChildProcessWithoutNullStreams} from "node:child_process";
import {prepareCurrentFilmCopyFiles,type CurrentFilmCopyScope} from "../src/current-film-copy-publication";
import * as workspace from "../src/current-film-workspace";
import {EDIT_STORAGE_LIMITS} from "../../planner/src/edit-resources";
import type {RenderFile} from "../../planner/src/shot-reuse";

const roots:string[]=[],children:ChildProcessWithoutNullStreams[]=[];
function fixture(jobId="copy-job",firstBytes=160*1024){
  const root=fs.mkdtempSync(join(tmpdir(),"hv-copy-publication-"));roots.push(root);
  const scope:CurrentFilmCopyScope={projectId:"copy-project",jobId,jobPlanRevision:"a".repeat(64),kind:"adoption",ordinal:0,specificationRevision:"b".repeat(64)};
  const bodies=[Buffer.alloc(firstBytes,1),Buffer.alloc(64*1024+17,2)];
  const files:RenderFile[]=bodies.map((body,index)=>({path:`${scope.projectId}/${jobId}/reused/slot-0000/role-${index}.bin`,bytes:body.length,sha256:createHash("sha256").update(body).digest("hex")}));
  const response=(file:RenderFile)=>new Response(bodies[files.findIndex(value=>value.path===file.path)]!,{headers:{etag:'"'+file.sha256+'"',"content-length":String(file.bytes)}});
  return {root,scope,files,bodies,response};
}
afterEach(async()=>{for(const child of children.splice(0)){if(child.exitCode===null&&child.signalCode===null)child.kill("SIGKILL");await new Promise<void>(resolve=>{if(child.exitCode!==null||child.signalCode!==null)resolve();else child.once("exit",()=>resolve());});}
  for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
const access=async()=>{};
const digest=(path:string)=>createHash("sha256").update(fs.readFileSync(path)).digest("hex");
function copyBlocks(kind:CurrentFilmCopyScope["kind"],jobId:string,chunkBytes=Infinity){
  const f=fixture(jobId),common={projectId:f.scope.projectId,jobId,jobPlanRevision:f.scope.jobPlanRevision,specificationRevision:f.scope.specificationRevision};
  const scope:CurrentFilmCopyScope=kind==="proof"?{...common,kind,ordinal:null,largeFiles:[]}:{...common,kind,ordinal:kind==="adoption"?0:null},body=Buffer.alloc(2*1024**2+17,7);
  const prefix=kind==="proof"?"proof/previews/original/project/original":kind==="origins"?"originals/receipt/project/original":"reused/slot-0000";
  const file:RenderFile={path:`${scope.projectId}/${scope.jobId}/${prefix}/role.bin`,bytes:body.length,sha256:createHash("sha256").update(body).digest("hex")};
  let pulls=0,cancels=0;
  const response=(bytes:Uint8Array=body)=>{let offset=0;return new Response(new ReadableStream<Uint8Array>({pull(controller){
    if(offset===bytes.length){controller.close();return;}pulls++;const end=Math.min(bytes.length,offset+chunkBytes);controller.enqueue(bytes.subarray(offset,end));offset=end;
  },cancel(){cancels++;}},{highWaterMark:0}),{headers:{etag:'"'+file.sha256+'"',"content-length":String(file.bytes)}});};
  const stagedBytes=()=>{const parent=join(f.root,scope.projectId,scope.jobId,".mixed-copy");if(!fs.existsSync(parent))return 0;
    return Math.max(0,...fs.readdirSync(parent).flatMap(directory=>fs.readdirSync(join(parent,directory)).map(name=>fs.statSync(join(parent,directory,name)).size)));};
  return {...f,scope,body,file,response,stagedBytes,get pulls(){return pulls;},get cancels(){return cancels;}};
}

for(const kind of ["proof","origins","adoption"] as const){
test(`${kind} blocks require observed EOF and refuse a byte beyond an exact MiB boundary`,async()=>{
  const f=copyBlocks(kind,kind+"-observed-eof"),body=f.body.subarray(0,1024**2),file={...f.file,bytes:body.length,sha256:createHash("sha256").update(body).digest("hex")};
  const response=(extra:boolean)=>{let next=0;return new Response(new ReadableStream<Uint8Array>({pull(controller){
    if(next++===0)controller.enqueue(body);else if(extra&&next===2)controller.enqueue(new Uint8Array([9]));else controller.close();
  }},{highWaterMark:0}),{headers:{etag:'"'+file.sha256+'"',"content-length":String(file.bytes)}});};
  await expect(prepareCurrentFilmCopyFiles(f.root,f.scope,[file],async()=>response(true),access)).rejects.toThrow("exceeds its recorded size");
  expect(fs.existsSync(join(f.root,file.path))).toBe(false);
  await expect(prepareCurrentFilmCopyFiles(f.root,f.scope,[file],async()=>new Response(body.subarray(0,body.length-1),{
    headers:{etag:'"'+file.sha256+'"',"content-length":String(file.bytes)}}),access)).rejects.toThrow("checksum");
  expect(fs.existsSync(join(f.root,file.path))).toBe(false);
  await prepareCurrentFilmCopyFiles(f.root,f.scope,[file],async()=>response(false),access);
  expect(digest(join(f.root,file.path))).toBe(file.sha256);
});

for(const chunkBytes of [Infinity,64*1024]){
const producer=Number.isFinite(chunkBytes)?"fragmented":"single-chunk";
test(`${kind} ${producer} copies use bounded one-MiB writes and rechecks without changing immutable published bytes`,async()=>{
  const f=copyBlocks(kind,kind+"-blocks-"+producer,chunkBytes),progress=new Set<number>();let reads=0,checks=0;
  await prepareCurrentFilmCopyFiles(f.root,f.scope,[f.file],async()=>{reads++;return f.response();},async()=>{checks++;const bytes=f.stagedBytes();if(bytes)progress.add(bytes);});
  expect([...progress]).toEqual([1024**2,2*1024**2,f.file.bytes]);expect(reads).toBe(1);expect(digest(join(f.root,f.file.path))).toBe(f.file.sha256);
  expect(f.pulls).toBe(Number.isFinite(chunkBytes)?33:1);expect(checks).toBeLessThan(40);
  const identity=fs.statSync(join(f.root,f.file.path)).ino;checks=0;
  await prepareCurrentFilmCopyFiles(f.root,f.scope,[f.file],async()=>{throw new Error("the old carrier is gone");},async()=>{checks++;});
  // A complete replay still checks every bounded read and final authority. This
  // bound distinguishes one-MiB verification from the old 33+64-KiB read loop.
  expect(checks).toBeGreaterThanOrEqual(7);expect(checks).toBeLessThan(20);
  expect(fs.statSync(join(f.root,f.file.path)).ino).toBe(identity);expect(digest(join(f.root,f.file.path))).toBe(f.file.sha256);
});

test(`${kind} ${producer} copying can abort between one-MiB blocks before any fixed path is published`,async()=>{
  const f=copyBlocks(kind,kind+"-block-abort-"+producer,chunkBytes),controller=new AbortController(),reason=new Error("revoked between copy blocks");let observed=0;
  await expect(prepareCurrentFilmCopyFiles(f.root,f.scope,[f.file],async()=>f.response(),async()=>{
    const bytes=f.stagedBytes();if(bytes){observed=bytes;controller.abort(reason);}
  },controller.signal)).rejects.toThrow("Audio request interrupted.");expect(controller.signal.reason).toBe(reason);
  expect(observed).toBe(1024**2);expect(fs.existsSync(join(f.root,f.file.path))).toBe(false);
  expect(f.pulls).toBe(Number.isFinite(chunkBytes)?16:1);expect(f.cancels).toBe(1);
  expect(fs.readdirSync(join(f.root,f.scope.projectId,f.scope.jobId,".mixed-copy"))).toEqual([]);
  await prepareCurrentFilmCopyFiles(f.root,f.scope,[f.file],async()=>f.response(),access);
  expect(digest(join(f.root,f.file.path))).toBe(f.file.sha256);
});

test(`later ${producer} ${kind}-block corruption refuses both staged and existing bytes without clobbering either holder`,async()=>{
  const f=copyBlocks(kind,kind+"-block-corruption-"+producer,chunkBytes),corrupt=Buffer.from(f.body);corrupt[1024**2+9]=corrupt[1024**2+9]!^1;
  await expect(prepareCurrentFilmCopyFiles(f.root,f.scope,[f.file],async()=>f.response(corrupt),access)).rejects.toThrow("checksum");
  expect(fs.existsSync(join(f.root,f.file.path))).toBe(false);
  await prepareCurrentFilmCopyFiles(f.root,f.scope,[f.file],async()=>f.response(),access);
  const path=join(f.root,f.file.path),identity=fs.statSync(path).ino;fs.writeFileSync(path,corrupt);
  let reads=0;await expect(prepareCurrentFilmCopyFiles(f.root,f.scope,[f.file],async()=>{reads++;return f.response();},access)).rejects.toThrow("checksum");
  expect(reads).toBe(0);expect(fs.statSync(path).ino).toBe(identity);expect(fs.readFileSync(path)).toEqual(corrupt);
});
}

test(`${kind} existing-byte verification checks fresh access before another one-MiB read`,async()=>{
  const f=copyBlocks(kind,kind+"-existing-revocation");await prepareCurrentFilmCopyFiles(f.root,f.scope,[f.file],async()=>f.response(),access);
  const handle=await fs.promises.open(join(f.root,"read-prototype"),"wx"),prototype=Object.getPrototypeOf(handle) as FileHandle,read=prototype.read;await handle.close();
  let readBytes=0,carrierReads=0;
  const observe=spyOn(prototype,"read").mockImplementation((async function(this:FileHandle,buffer:Uint8Array,offset?:number,length?:number,position?:number|null){
    const result=await Reflect.apply(read,this,[buffer,offset,length,position]);readBytes+=result.bytesRead;return result;
  }) as FileHandle["read"]);
  const path=join(f.root,f.file.path),identity=fs.statSync(path).ino;
  try{await expect(prepareCurrentFilmCopyFiles(f.root,f.scope,[f.file],async()=>{carrierReads++;throw new Error("old carrier unavailable");},async()=>{
    if(readBytes>=1024**2)throw new Error("current copy authority revoked");
  })).rejects.toThrow("current copy authority revoked");}
  finally{observe.mockRestore();}
  expect(readBytes).toBe(1024**2);expect(carrierReads).toBe(0);expect(fs.statSync(path).ino).toBe(identity);expect(digest(path)).toBe(f.file.sha256);
});

test(`${kind} cancellation interrupts a pending raw read inside an incomplete logical block`,async()=>{
  const f=copyBlocks(kind,kind+"-raw-abort"),controller=new AbortController();let enter!:()=>void,release!:()=>void,pulls=0,cancels=0;
  const entered=new Promise<void>(resolve=>{enter=resolve;}),pending=new Promise<void>(resolve=>{release=resolve;});
  const response=new Response(new ReadableStream<Uint8Array>({async pull(stream){
    if(++pulls===1){stream.enqueue(f.body.subarray(0,64*1024));return;}enter();await pending;
  },cancel(){cancels++;}},{highWaterMark:0}),{headers:{etag:'"'+f.file.sha256+'"',"content-length":String(f.file.bytes)}});
  const task=prepareCurrentFilmCopyFiles(f.root,f.scope,[f.file],async()=>response,access,controller.signal);
  await entered;const reason=new Error("raw copy read revoked");controller.abort(reason);release();
  await expect(task).rejects.toThrow("Audio request interrupted.");expect(controller.signal.reason).toBe(reason);expect(pulls).toBe(2);expect(cancels).toBe(1);
  expect(fs.existsSync(join(f.root,f.file.path))).toBe(false);
  expect(fs.readdirSync(join(f.root,f.scope.projectId,f.scope.jobId,".mixed-copy"))).toEqual([]);
});

test(`empty ${kind} chunks refuse after bounded raw pulls and cancel without publishing files`,async()=>{
  const f=copyBlocks(kind,kind+"-empty-pulls");let pulls=0,cancels=0;
  const response=new Response(new ReadableStream<Uint8Array>({pull(stream){pulls++;stream.enqueue(new Uint8Array());},cancel(){cancels++;}},{highWaterMark:0}),
    {headers:{etag:'"'+f.file.sha256+'"',"content-length":String(f.file.bytes)}});
  await expect(prepareCurrentFilmCopyFiles(f.root,f.scope,[f.file],async()=>response,access)).rejects.toThrow("no bounded progress");
  expect(pulls).toBe(1024);expect(cancels).toBe(1);expect(fs.existsSync(join(f.root,f.file.path))).toBe(false);
  expect(fs.readdirSync(join(f.root,f.scope.projectId,f.scope.jobId,".mixed-copy"))).toEqual([]);
});

test(`tiny ${kind} chunks yield partial blocks for fresh access and retain the complete remaining file`,async()=>{
  const f=copyBlocks(kind,kind+"-tiny-pulls"),checked=new Set<number>(),progress=new Set<number>();let pulls=0,offset=0;
  const response=new Response(new ReadableStream<Uint8Array>({pull(stream){
    if((pulls===1024||pulls===2048)&&!checked.has(pulls))throw new Error("Raw copy pulls continued before fresh access");
    if(offset===f.body.length){stream.close();return;}
    const end=Math.min(f.body.length,offset+(pulls<2048?1:64*1024));pulls++;stream.enqueue(f.body.subarray(offset,end));offset=end;
  }},{highWaterMark:0}),{headers:{etag:'"'+f.file.sha256+'"',"content-length":String(f.file.bytes)}});
  await prepareCurrentFilmCopyFiles(f.root,f.scope,[f.file],async()=>response,async()=>{
    if(pulls===1024||pulls===2048)checked.add(pulls);const bytes=f.stagedBytes();if(bytes)progress.add(bytes);
  });
  expect([...checked]).toEqual([1024,2048]);expect([...progress].slice(0,2)).toEqual([1024,2048]);
  expect(fs.statSync(join(f.root,f.file.path)).size).toBe(f.file.bytes);expect(digest(join(f.root,f.file.path))).toBe(f.file.sha256);
});

test(`current refusal after a tiny ${kind} block cancels before another batch of raw pulls`,async()=>{
  const f=copyBlocks(kind,kind+"-tiny-refused",1);
  await expect(prepareCurrentFilmCopyFiles(f.root,f.scope,[f.file],async()=>f.response(),async()=>{
    if(f.pulls>=1024)throw new Error("tiny copy access revoked");
  })).rejects.toThrow("tiny copy access revoked");
  expect(f.pulls).toBe(1024);expect(f.cancels).toBe(1);expect(fs.existsSync(join(f.root,f.file.path))).toBe(false);
  expect(fs.readdirSync(join(f.root,f.scope.projectId,f.scope.jobId,".mixed-copy"))).toEqual([]);
});
}

test("explicit proof copies preserve original hierarchy, immutable replay and exact picture-only size policy",async()=>{
  const f=fixture(),scope:CurrentFilmCopyScope={...f.scope,kind:"proof",ordinal:null,largeFiles:[]};
  const files=f.files.map((file,index)=>({...file,path:`${scope.projectId}/${scope.jobId}/proof/previews/original/project/original/${index}.mp4`}));
  let reads=0;const read=async(file:RenderFile)=>{reads++;return new Response(f.bodies[files.findIndex(value=>value.path===file.path)]!,{headers:{etag:'"'+file.sha256+'"',"content-length":String(file.bytes)}});};
  await prepareCurrentFilmCopyFiles(f.root,scope,files,read,access);expect(reads).toBe(2);
  const identities=files.map(file=>fs.statSync(join(f.root,file.path)).ino);
  await prepareCurrentFilmCopyFiles(f.root,scope,files,async()=>{throw new Error("old proof carrier disappeared");},access);
  expect(files.map(file=>fs.statSync(join(f.root,file.path)).ino)).toEqual(identities);
  const large={...files[0]!,bytes:8*1024**3+1};
  await expect(prepareCurrentFilmCopyFiles(f.root,scope,[large],read,access)).rejects.toThrow("capacity");
  await expect(prepareCurrentFilmCopyFiles(f.root,{...scope,largeFiles:[{...large,sha256:"f".repeat(64)}]},[large],read,access)).rejects.toThrow("allowlist changed");
  await expect(prepareCurrentFilmCopyFiles(f.root,{...scope,largeFiles:[{...large,path:large.path+".wav"}]},[large],read,access)).rejects.toThrow("picture roles");
  await expect(prepareCurrentFilmCopyFiles(f.root,{...scope,largeFiles:[large]},files,read,access)).rejects.toThrow("allowlist changed");
  expect(reads).toBe(2);
});

test("proof preparation refuses combined existing and pending bytes before reading any carrier",async()=>{
  const f=fixture(),scope:CurrentFilmCopyScope={...f.scope,kind:"proof",ordinal:null,largeFiles:[]},orphan=join(f.root,scope.projectId,scope.jobId,"retained.bin");
  fs.mkdirSync(join(orphan,".."),{recursive:true});fs.writeFileSync(orphan,"retained");
  const files=f.files.map(file=>({...file,path:file.path.replace("/reused/slot-0000/","/proof/")})),original=fs.lstatSync;
  const nearLimit=spyOn(fs,"lstatSync").mockImplementation(((path:fs.PathLike,options?:unknown)=>{const value=Reflect.apply(original,fs,[path,options]);
    if(String(path)===orphan)Object.defineProperty(value,"size",{value:EDIT_STORAGE_LIMITS.workspaceBytes-1});return value;}) as typeof fs.lstatSync);
  let reads=0;try{await expect(prepareCurrentFilmCopyFiles(f.root,scope,files,async()=>{reads++;throw new Error("must not read");},access)).rejects.toThrow("capacity");}
  finally{nearLimit.mockRestore();}
  expect(reads).toBe(0);expect(fs.readFileSync(orphan,"utf8")).toBe("retained");expect(files.some(file=>fs.existsSync(join(f.root,file.path)))).toBe(false);
});

test("complete and valid partial files are immutable idempotent preparation without source reads",async()=>{
  const f=fixture();let reads=0;
  await prepareCurrentFilmCopyFiles(f.root,f.scope,f.files,async file=>{reads++;return f.response(file);},access);expect(reads).toBe(2);
  const identities=f.files.map(file=>fs.statSync(join(f.root,file.path)).ino);
  await prepareCurrentFilmCopyFiles(f.root,f.scope,f.files,async()=>{throw new Error("Old carrier gone");},access);
  expect(f.files.map(file=>fs.statSync(join(f.root,file.path)).ino)).toEqual(identities);
  fs.unlinkSync(join(f.root,f.files[1]!.path));const requested:string[]=[];
  await prepareCurrentFilmCopyFiles(f.root,f.scope,f.files,async file=>{requested.push(file.path);return f.response(file);},access);
  expect(requested).toEqual([f.files[1]!.path]);expect(fs.statSync(join(f.root,f.files[0]!.path)).ino).toBe(identities[0]!);
  for(const file of f.files)expect(digest(join(f.root,file.path))).toBe(file.sha256);
  expect(fs.readdirSync(join(f.root,f.scope.projectId,f.scope.jobId,".mixed-copy"))).toEqual([]);
});

test("unknown, truncated, corrupt and linked fixed entries refuse without replacement or deletion",async()=>{
  for(const mode of ["unknown","truncated","corrupt","linked"] as const){const f=fixture(mode),path=join(f.root,f.files[0]!.path);if(mode!=="linked")fs.mkdirSync(join(path,".."),{recursive:true});
    const neighbor=join(f.root,"neighbor","role-0.bin");fs.mkdirSync(join(neighbor,".."));fs.writeFileSync(neighbor,f.bodies[0]!);
    if(mode==="unknown")fs.writeFileSync(join(path,"..","unknown.bin"),"preserve");
    else if(mode==="linked"){fs.mkdirSync(join(path,"../.."),{recursive:true});fs.symlinkSync(join(neighbor,".."),join(path,".."),process.platform==="win32"?"junction":"dir");}
    else fs.writeFileSync(path,mode==="truncated"?f.bodies[0]!.subarray(0,8):Buffer.alloc(f.files[0]!.bytes,3));
    const before=fs.existsSync(path)&&mode!=="linked"?fs.readFileSync(path):null;let reads=0;
    await expect(prepareCurrentFilmCopyFiles(f.root,f.scope,f.files,async file=>{reads++;return f.response(file);},access)).rejects.toThrow();
    expect(reads).toBe(0);expect(fs.readFileSync(neighbor)).toEqual(f.bodies[0]!);if(before)expect(fs.readFileSync(path)).toEqual(before);
    if(mode==="linked")expect(fs.lstatSync(join(path,"..")).isSymbolicLink()).toBe(true);if(mode==="unknown")expect(fs.readFileSync(join(path,"..","unknown.bin"),"utf8")).toBe("preserve");
  }
});

test("late current refusal preserves the complete byte cache but never returns success",async()=>{
  const f=fixture();let deny=false,checks=0;const current=async()=>{checks++;if(deny)throw new Error("Current permission revoked");if(f.files.every(file=>fs.existsSync(join(f.root,file.path)))){deny=true;throw new Error("Current permission revoked");}};
  await expect(prepareCurrentFilmCopyFiles(f.root,f.scope,f.files,async file=>f.response(file),current)).rejects.toThrow("permission revoked");
  expect(checks).toBeGreaterThan(3);for(const file of f.files)expect(digest(join(f.root,file.path))).toBe(file.sha256);
  await expect(prepareCurrentFilmCopyFiles(f.root,f.scope,f.files,async()=>{throw new Error("no old source");},current)).rejects.toThrow("permission revoked");
  await prepareCurrentFilmCopyFiles(f.root,f.scope,f.files,async()=>{throw new Error("no old source");},access);
});

test("whole-job orphan capacity and portable metadata refuse before reading carriers",async()=>{
  const f=fixture(),orphan=join(f.root,f.scope.projectId,f.scope.jobId,".mixed-copy","old-attempt","orphan.copy");fs.mkdirSync(join(orphan,".."),{recursive:true});fs.writeFileSync(orphan,"preserved orphan");
  const original=fs.lstatSync,large=spyOn(fs,"lstatSync").mockImplementation(((path:fs.PathLike,options?:unknown)=>{const value=Reflect.apply(original,fs,[path,options]);
    if(String(path)===orphan)Object.defineProperty(value,"size",{value:EDIT_STORAGE_LIMITS.workspaceBytes+1});return value;}) as typeof fs.lstatSync);
  let reads=0;try{await expect(prepareCurrentFilmCopyFiles(f.root,f.scope,f.files,async file=>{reads++;return f.response(file);},access)).rejects.toThrow("capacity");}finally{large.mockRestore();}
  expect(reads).toBe(0);expect(fs.readFileSync(orphan,"utf8")).toBe("preserved orphan");
  const hostile=structuredClone(f.scope);Object.defineProperty(hostile,"jobId",{enumerable:true,get(){reads++;return f.scope.jobId;}});
  await expect(prepareCurrentFilmCopyFiles(f.root,hostile,f.files,async file=>f.response(file),access)).rejects.toThrow("portable");expect(reads).toBe(0);
  await expect(prepareCurrentFilmCopyFiles(f.root,f.scope,[{...f.files[0]!,bytes:8*1024**3+1}],async file=>f.response(file),access)).rejects.toThrow("capacity");
});

test("the final whole-job capacity check cannot be skipped by the periodic monitor",async()=>{
  const f=fixture(),orphan=join(f.root,f.scope.projectId,f.scope.jobId,".mixed-copy","crashed","orphan.copy");fs.mkdirSync(join(orphan,".."),{recursive:true});fs.writeFileSync(orphan,"retained");
  const original=fs.lstatSync,clock=spyOn(Date,"now").mockReturnValue(Date.now());
  const nearLimit=spyOn(fs,"lstatSync").mockImplementation(((path:fs.PathLike,options?:unknown)=>{const value=Reflect.apply(original,fs,[path,options]);
    if(String(path)===orphan)Object.defineProperty(value,"size",{value:EDIT_STORAGE_LIMITS.workspaceBytes-1});return value;}) as typeof fs.lstatSync);
  try{await expect(prepareCurrentFilmCopyFiles(f.root,f.scope,f.files,async file=>f.response(file),access)).rejects.toThrow("capacity");}
  finally{nearLimit.mockRestore();clock.mockRestore();}
  for(const file of f.files)expect(digest(join(f.root,file.path))).toBe(file.sha256);
  expect(fs.readFileSync(orphan,"utf8")).toBe("retained");
});

test("copy preparation refuses bounded empty crash-directory traversal before reading a carrier",async()=>{
  const f=fixture(),owner=join(f.root,f.scope.projectId,f.scope.jobId),abandoned=join(owner,".mixed-copy","old-attempt");
  fs.mkdirSync(abandoned,{recursive:true});for(let i=0;i<17;i++)fs.mkdirSync(join(abandoned,`empty-${i}`));
  const neighbor=join(f.root,f.scope.projectId,"other-job","retained.bin");fs.mkdirSync(join(neighbor,".."),{recursive:true});fs.writeFileSync(neighbor,"untouched neighboring job");
  // Exercise the real iterative scanner with a tighter internal count, rather
  // than allocating nearly a million filesystem entries in this regression.
  const construct=workspace.currentFilmWorkspaceGuard,guard=spyOn(workspace,"currentFilmWorkspaceGuard").mockImplementation((root,projectId,jobId)=>construct(root,projectId,jobId,{bytes:EDIT_STORAGE_LIMITS.workspaceBytes,files:4}));
  let reads=0;
  try{await expect(prepareCurrentFilmCopyFiles(f.root,f.scope,f.files,async file=>{reads++;return f.response(file);},access)).rejects.toThrow("directory-entry bound");}
  finally{guard.mockRestore();}
  expect(reads).toBe(0);expect(fs.readdirSync(abandoned)).toHaveLength(17);expect(fs.readFileSync(neighbor,"utf8")).toBe("untouched neighboring job");
  expect(f.files.some(file=>fs.existsSync(join(f.root,file.path)))).toBe(false);
});

// These actual child processes use tiny deterministic bytes, never providers.
// IPC gates expose real crash/overlap boundaries without production test hooks.
function child(f:ReturnType<typeof fixture>,mode:string){
  const script=join(f.root,`child-${crypto.randomUUID()}.ts`),config=join(f.root,`config-${crypto.randomUUID()}.json`);
  fs.writeFileSync(config,JSON.stringify({scope:f.scope,files:f.files}));
  const module=pathToFileURL(join(import.meta.dir,"../src/current-film-copy-publication.ts")).href;
  fs.writeFileSync(script,`import {prepareCurrentFilmCopyFiles} from ${JSON.stringify(module)};
import {existsSync,readdirSync,statSync,readFileSync} from "node:fs";import {join} from "node:path";
const [root,mode,config]=process.argv.slice(2),{scope,files}=JSON.parse(readFileSync(config,"utf8"));
let released=false,revoked=false,entered=false,release;const gate=new Promise(r=>release=r);process.stdin.on("data",data=>{revoked=String(data).includes("revoke");released=true;release();});
const present=()=>files.filter(f=>existsSync(join(root,f.path))).length;
const staged=()=>{const base=join(root,scope.projectId,scope.jobId,".mixed-copy");if(!existsSync(base))return 0;return readdirSync(base).flatMap(dir=>readdirSync(join(base,dir)).map(name=>statSync(join(base,dir,name)).size)).reduce((a,b)=>Math.max(a,b),0);};
const access=async()=>{if(revoked)throw new Error("stale lease");const bytes=staged();if(!entered&&!released&&(mode==="partial"&&present()===1||["stream","race"].includes(mode)&&bytes>=1024**2&&bytes<files[0].bytes)){entered=true;console.log("GATE");await gate;if(revoked)throw new Error("stale lease");}};
try{await prepareCurrentFilmCopyFiles(root,scope,files,async file=>{const index=files.findIndex(f=>f.path===file.path);return new Response(Buffer.alloc(file.bytes,index+1),{headers:{etag:'"'+file.sha256+'"',"content-length":String(file.bytes)}});},access);
console.log("DONE");if(mode==="complete")await gate;process.exit(0);}catch(error){console.log("REFUSED "+error.message);process.exit(3);}`);
  const processChild=spawn(process.execPath,[script,f.root,mode,config],{stdio:["pipe","pipe","pipe"],windowsHide:true});children.push(processChild);
  let output="",errors="";const listeners=new Set<()=>void>();processChild.stdout.on("data",value=>{output+=String(value);for(const notify of listeners)notify();});processChild.stderr.on("data",value=>{errors+=String(value);});
  const wait=(word:string)=>new Promise<void>((resolve,reject)=>{const timeout=setTimeout(()=>{listeners.delete(check);reject(new Error(`Child did not reach ${word}: ${output} ${errors}`));},20000);
    function check(){if(output.includes(word)){clearTimeout(timeout);listeners.delete(check);resolve();}}
    listeners.add(check);check();});
  const done=()=>new Promise<number|null>(resolve=>{if(processChild.exitCode!==null||processChild.signalCode!==null)resolve(processChild.exitCode);else processChild.once("exit",code=>resolve(code));});
  return {process:processChild,wait,done};
}

test("actual process death during a stream and partial/full publication resumes exact fixed bytes",async()=>{
  for(const mode of ["stream","partial","complete"]){const f=fixture(mode,2*1024**2+17),running=child(f,mode);await running.wait(mode==="complete"?"DONE":"GATE");
    if(mode==="stream"){
      const parent=join(f.root,f.scope.projectId,f.scope.jobId,".mixed-copy"),sizes=fs.readdirSync(parent).flatMap(name=>fs.readdirSync(join(parent,name)).map(file=>fs.statSync(join(parent,name,file)).size));
      expect(sizes).toEqual([1024**2]);expect(sizes[0]!).toBeLessThan(f.files[0]!.bytes);
    }
    running.process.kill("SIGKILL");await running.done();
    const before=f.files.filter(file=>fs.existsSync(join(f.root,file.path))),requested:string[]=[];for(const file of before)expect(digest(join(f.root,file.path))).toBe(file.sha256);
    await prepareCurrentFilmCopyFiles(f.root,f.scope,f.files,async file=>{requested.push(file.path);return f.response(file);},access);
    expect(requested).toEqual(f.files.filter(file=>!before.some(value=>value.path===file.path)).map(file=>file.path));
    for(const file of f.files)expect(digest(join(f.root,file.path))).toBe(file.sha256);
    if(mode==="stream")expect(fs.readdirSync(join(f.root,f.scope.projectId,f.scope.jobId,".mixed-copy")).length).toBe(1);
  }
},90000);

test("real overlapping attempts verify the winner and stale cleanup cannot delete published roles",async()=>{
  for(const revoke of [false,true]){const f=fixture(revoke?"stale":"overlap",2*1024**2+17),old=child(f,"race");await old.wait("GATE");const winner=child(f,"run");await winner.wait("DONE");expect(await winner.done()).toBe(0);
    const identities=f.files.map(file=>fs.statSync(join(f.root,file.path)).ino);old.process.stdin.write(revoke?"revoke\n":"continue\n");await old.wait(revoke?"REFUSED stale lease":"DONE");expect(await old.done()).toBe(revoke?3:0);
    expect(f.files.map(file=>fs.statSync(join(f.root,file.path)).ino)).toEqual(identities);for(const file of f.files)expect(digest(join(f.root,file.path))).toBe(file.sha256);
    expect(fs.readdirSync(join(f.root,f.scope.projectId,f.scope.jobId,".mixed-copy"))).toEqual([]);
  }
},90000);
