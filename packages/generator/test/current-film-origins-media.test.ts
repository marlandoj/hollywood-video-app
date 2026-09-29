import {afterAll,beforeAll,expect,spyOn,test} from "bun:test";
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,statSync,symlinkSync,unlinkSync,writeFileSync} from "node:fs";
import {open,type FileHandle} from "node:fs/promises";
import {createHash} from "node:crypto";
import {dirname,join} from "node:path";
import {contentHash as hash} from "../src/capabilities";
import {currentFilmSourceFixture} from "../../planner/test/current-film-source.fixture";
import {bindOriginalEditSource,validateEditBinding} from "../../planner/src/edit-jobs";
import {validateEditSourceReceipt,type EditSourceReceipt} from "../../planner/src/edit-sources";
import {compileCurrentFilmMixedJob,type CurrentFilmJobV3,type CurrentFilmReuseChoice} from "../../planner/src/current-film-mixed-jobs";
import {compileCurrentFilmOrigins,type CurrentFilmOrigins} from "../../planner/src/current-film-origins";
import {copyCurrentFilmOrigins,verifyCurrentFilmOriginsMedia} from "../src/current-film-origins-media";
import type {DialogueArtifactReader} from "../src/dialogue-replacement";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,plan:CurrentFilmJobV3,root:string;
const access=async()=>{};
const seal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...body}=value;return {...body,revision:hash(body)} as T;};
function choice(receipt=f.receipt):CurrentFilmReuseChoice {
  const slot=f.plan.materialization.slots[0]!,record=f.job.currentFilmCheckpoint!.rows[0]!.record;
  return {ordinal:0,inputRevision:slot.inputRevision,originId:receipt.revision,source:{receiptRevision:receipt.revision,ordinal:0,
    logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:record.revision}};
}
function destination(jobId:string){return join(root,plan.projectId,jobId,"originals");}
function stagedFile(jobId:string,index:number):string|undefined {const parent=join(root,plan.projectId,jobId,".mixed-copy");if(!existsSync(parent))return;
  return readdirSync(parent).map(name=>join(parent,name,`file-${index}.copy`)).find(path=>existsSync(path));}
function expectValidCache(jobId:string,current=plan){for(const origin of compileCurrentFilmOrigins(current,jobId).origins)for(const copy of origin.copies){const path=join(root,copy.owned.path);
  if(existsSync(path)){expect(statSync(path).size).toBe(copy.owned.bytes);expect(createHash("sha256").update(readFileSync(path)).digest("hex")).toBe(copy.owned.sha256);}}
  const parent=join(root,plan.projectId,jobId,".mixed-copy");if(existsSync(parent))expect(readdirSync(parent)).toEqual([]);}
function copyInto(value:CurrentFilmOrigins,targetRoot:string){
  for(const origin of value.origins)for(const copy of origin.copies){const path=join(targetRoot,copy.owned.path);mkdirSync(dirname(path),{recursive:true});copyFileSync(join(root,copy.owned.path),path);}
}
beforeAll(async()=>{
  f=await currentFilmSourceFixture();root=f.studio.paths.artifactRoot;
  plan=compileCurrentFilmMixedJob(f.plan,{origins:[bindOriginalEditSource(f.receipt)],choices:[choice()]});
},180000);
afterAll(async()=>{await f?.close();});

test("complete actual V2 source media restores solely from the new owned originals tree",async()=>{
  const before=hash({receipt:f.receipt,plan}),jobId="full-origin-copy",value=await copyCurrentFilmOrigins(plan,jobId,root,access);
  expect(value).toEqual(compileCurrentFilmOrigins(plan,jobId));
  expect(value.origins[0]!.copies.map(copy=>copy.original)).toEqual(f.receipt.files);
  for(const copy of value.origins[0]!.copies)expect(readFileSync(join(root,copy.owned.path)).equals(readFileSync(join(root,copy.original.path)))).toBe(true);
  for(const row of f.job.currentFilmCheckpoint!.rows.slice(1))for(const file of Object.values(row.record.files))expect(value.origins[0]!.copies.some(copy=>copy.original.path===file.path)).toBe(true);
  const restored=mkdtempSync(join(f.studio.root,"full-origins-independent-"));copyInto(value,restored);
  expect(existsSync(join(restored,plan.projectId,f.job.id))).toBe(false);expect(existsSync(join(restored,plan.projectId,f.studio.film.id))).toBe(false);
  await verifyCurrentFilmOriginsMedia(value,plan,jobId,restored,access);
  expect(readdirSync(join(restored,plan.projectId))).toEqual([jobId]);expect(readdirSync(destination(jobId))).toEqual([f.receipt.revision]);
  expect(hash({receipt:f.receipt,plan})).toBe(before);
  // A copy retry must not overwrite the already completed tree.
  expect(await copyCurrentFilmOrigins(plan,jobId,root,access,undefined,{async response(){throw new Error("Old carrier gone");}})).toEqual(value);
  await verifyCurrentFilmOriginsMedia(value,plan,jobId,root,access);
},120000);

test("authenticated retained carrier mapping copies every original file, including the unselected inventory",async()=>{
  const binding=bindOriginalEditSource(f.receipt),carrierId="full-origin-carrier";
  binding.owner.jobId=carrierId;binding.owner.outputRevision="a".repeat(64);
  binding.files=binding.files.map((file,index)=>{const path=`${plan.projectId}/${carrierId}/media/file-${index}`,target=join(root,path);mkdirSync(dirname(target),{recursive:true});copyFileSync(join(root,file.path),target);return {...file,path};});
  const checked=validateEditBinding(seal(binding)),retained=compileCurrentFilmMixedJob(f.plan,{origins:[checked],choices:[choice()]}),requested:string[]=[];
  const reader:DialogueArtifactReader={async response(projectId,jobId,key,request){
    expect(projectId).toBe(plan.projectId);expect(jobId).toBe(carrierId);expect(request.signal.aborted).toBe(false);requested.push(key);
    const file=checked.files.find(item=>item.path===key);return file?new Response(Bun.file(join(root,key)).stream(),{headers:{etag:'"'+file.sha256+'"',"content-length":String(file.bytes)}}):null;
  }};
  const jobId="full-origin-retained",value=await copyCurrentFilmOrigins(retained,jobId,root,access,undefined,reader);
  expect(requested).toEqual(binding.files.map(file=>file.path));expect(requested.length).toBeGreaterThan(Object.keys(f.job.currentFilmCheckpoint!.rows[0]!.record.files).length);
  const restored=mkdtempSync(join(f.studio.root,"full-origins-carrier-independent-"));copyInto(value,restored);
  expect(existsSync(join(restored,plan.projectId,carrierId))).toBe(false);expect(existsSync(join(restored,plan.projectId,f.job.id))).toBe(false);
  await verifyCurrentFilmOriginsMedia(value,retained,jobId,restored,access);
},120000);

test("failed carrier reads preserve only complete verified cache files and preexisting destinations",async()=>{
  const sibling=join(root,"full-origin-neighbor.txt");writeFileSync(sibling,"untouched neighbor");
  for(const mode of ["missing","wrong-header","corrupt","oversize"] as const){
    const jobId=`full-origin-${mode}`,reader:DialogueArtifactReader={async response(_projectId,_jobId,key){
      if(mode==="missing")return null;const file=f.receipt.files.find(item=>item.path===key)!,bytes=Buffer.from(readFileSync(join(root,key)));
      if(mode==="corrupt")bytes[bytes.length-1]=bytes[bytes.length-1]!^1;
      return new Response(mode==="oversize"?Buffer.concat([bytes,Buffer.from([0])]):bytes,{headers:{etag:'"'+(mode==="wrong-header"?"b".repeat(64):file.sha256)+'"',"content-length":String(file.bytes)}});
    }};
    await expect(copyCurrentFilmOrigins(plan,jobId,root,access,undefined,reader)).rejects.toThrow();
    expectValidCache(jobId);expect(readFileSync(sibling,"utf8")).toBe("untouched neighbor");
  }
  const jobId="full-origin-preexisting";mkdirSync(destination(jobId),{recursive:true});const sentinel=join(destination(jobId),"prior.txt");writeFileSync(sentinel,"prior partial custody");
  await expect(copyCurrentFilmOrigins(plan,jobId,root,access)).rejects.toThrow();expect(readFileSync(sentinel,"utf8")).toBe("prior partial custody");
},120000);

test("abort and independent current-permission timers cancel stalled carrier streams",async()=>{
  for(const mode of ["abort","revoke"] as const){
    const jobId=`full-origin-stalled-${mode}`,controller=new AbortController();let entered!:()=>void,cancelled=0,revoked=false,checks=0;
    const waiting=new Promise<void>(resolve=>{entered=resolve;}),current=async()=>{checks++;if(revoked)throw new Error("Origin rights withdrawn while waiting.");};
    const reader:DialogueArtifactReader={async response(_projectId,_jobId,key){const file=f.receipt.files.find(item=>item.path===key)!;
      return new Response(new ReadableStream<Uint8Array>({pull(){entered();return new Promise<void>(()=>{});},cancel(){cancelled++;}},{highWaterMark:0}),{headers:{etag:'"'+file.sha256+'"',"content-length":String(file.bytes)}});
    }};
    const pending=copyCurrentFilmOrigins(plan,jobId,root,current,controller.signal,reader);await waiting;
    const start=performance.now();if(mode==="abort")controller.abort();else revoked=true;
    await expect(pending).rejects.toThrow();expect(performance.now()-start).toBeLessThan(mode==="abort"?1500:3500);
    expect(cancelled).toBe(1);expect(checks).toBeGreaterThan(2);expectValidCache(jobId);
  }
},120000);

test("asynchronous bounded publication lets independent abort and permission timers interrupt native WAV writes",async()=>{
  const handle=await open(join(f.studio.root,"origins-write-prototype"),"wx"),prototype=Object.getPrototypeOf(handle) as FileHandle,write=prototype.write;await handle.close();
  // A valid native WAV can fit in one logical MiB block. Exercise actual short
  // writes without padding or resealing that historical audio.
  let largeRequest=false;
  const delayed=spyOn(prototype,"write").mockImplementation((async function(this:FileHandle,buffer:Uint8Array,offset?:number,length?:number,position?:number|null){
    const requested=length??buffer.byteLength-(offset??0);largeRequest ||= requested>64*1024;
    await new Promise<void>(resolve=>setTimeout(resolve,4));return Reflect.apply(write,this,[buffer,offset,Math.min(requested,64*1024),position]);
  }) as FileHandle["write"]);
  try{for(const mode of ["abort","revoke"] as const){
    const jobId=`full-origin-write-${mode}`,value=compileCurrentFilmOrigins(plan,jobId),original=f.job.currentFilmCheckpoint!.rows.find(row=>row.record.files.audio)!.record.files.audio!;
    const copy=value.origins[0]!.copies.find(item=>item.original.path===original.path)!,fileIndex=value.origins.flatMap(origin=>origin.copies).findIndex(item=>item.owned.path===copy.owned.path),controller=new AbortController();
    expect(copy.owned.bytes).toBeGreaterThan(64*1024);let timer:ReturnType<typeof setTimeout>|undefined,revoked=false,firedAt=0,partial=0;
    const current=async()=>{if(revoked)throw new Error("Origin rights withdrawn by independent timer.");
      const path=stagedFile(jobId,fileIndex);if(!timer&&path){const bytes=statSync(path).size;if(bytes>0&&bytes<copy.owned.bytes){partial=bytes;timer=setTimeout(()=>{firedAt=performance.now();if(mode==="abort")controller.abort();else revoked=true;},0);}}
    };
    try{await expect(copyCurrentFilmOrigins(plan,jobId,root,current,controller.signal)).rejects.toThrow();
      expect(partial).toBe(64*1024);expect(largeRequest).toBe(true);expect(firedAt).toBeGreaterThan(0);expect(performance.now()-firedAt).toBeLessThan(1500);expectValidCache(jobId);
    }finally{clearTimeout(timer);}
  }}finally{delayed.mockRestore();}
},120000);

test("missing and corrupt unselected originals refuse restore without modifying retained files",async()=>{
  const jobId="full-origin-restore-errors",value=await copyCurrentFilmOrigins(plan,jobId,root,access),original=f.job.currentFilmCheckpoint!.rows.slice(1).find(row=>row.record.files.audio)!.record.files.audio!;
  const copy=value.origins[0]!.copies.find(item=>item.original.path===original.path)!,path=join(root,copy.owned.path),bytes=readFileSync(path),broken=Buffer.from(bytes);broken[44]=broken[44]!^1;
  writeFileSync(path,broken);await expect(verifyCurrentFilmOriginsMedia(value,plan,jobId,root,access)).rejects.toThrow("checksum");expect(readFileSync(path).equals(broken)).toBe(true);
  unlinkSync(path);await expect(verifyCurrentFilmOriginsMedia(value,plan,jobId,root,access)).rejects.toThrow();
  expect(existsSync(join(root,value.origins[0]!.copies[0]!.owned.path))).toBe(true);writeFileSync(path,bytes);
  await verifyCurrentFilmOriginsMedia(value,plan,jobId,root,access);
},120000);

test("even resealed original manifest bytes must reproduce the actual complete picture provenance",async()=>{
  for(const mode of ["claim","records"] as const){
    const receipt:EditSourceReceipt=structuredClone(f.receipt),manifest=JSON.parse(readFileSync(join(root,f.job.output!.manifestPath),"utf8"));
    if(mode==="claim")manifest.credentials.claim="unrelated media";else manifest.shots.pop();
    const bytes=Buffer.from(JSON.stringify(manifest)),file=receipt.files.find(item=>item.path===receipt.job.output!.manifestPath)!;
    file.bytes=bytes.length;file.sha256=createHash("sha256").update(bytes).digest("hex");
    const source=validateEditSourceReceipt(seal(receipt)),mixed=compileCurrentFilmMixedJob(f.plan,{origins:[bindOriginalEditSource(source)],choices:[choice(source)]});
    const reader:DialogueArtifactReader={async response(_projectId,_jobId,key){const entry=source.files.find(item=>item.path===key)!;
      return new Response(key===file.path?bytes:Bun.file(join(root,key)).stream(),{headers:{etag:'"'+entry.sha256+'"',"content-length":String(entry.bytes)}});
    }};
    const jobId=`full-origin-manifest-${mode}`;await expect(copyCurrentFilmOrigins(mixed,jobId,root,access,undefined,reader)).rejects.toThrow("picture provenance");
    expectValidCache(jobId,mixed);
  }
},120000);

test("a late authority refusal preserves exact cache bytes without completing while all-fresh origins need no media tree",async()=>{
  const jobId="full-origin-final-access",value=compileCurrentFilmOrigins(plan,jobId);let complete=false;
  const current=async()=>{if(value.origins.every(origin=>origin.copies.every(copy=>existsSync(join(root,copy.owned.path))&&statSync(join(root,copy.owned.path)).size===copy.owned.bytes))){complete=true;throw new Error("Origin target withdrawn after complete copy.");}};
  await expect(copyCurrentFilmOrigins(plan,jobId,root,current)).rejects.toThrow("after complete copy");expect(complete).toBe(true);expectValidCache(jobId);
  const fresh=compileCurrentFilmMixedJob(f.plan,{origins:[],choices:[]}),empty=await copyCurrentFilmOrigins(fresh,"full-origin-empty",root,access);
  expect(empty.origins).toEqual([]);expect(existsSync(destination("full-origin-empty"))).toBe(false);await verifyCurrentFilmOriginsMedia(empty,fresh,"full-origin-empty",root,access);
},120000);

test("linked directories and accessor-bearing plans cannot redirect source or target file access",async()=>{
  const jobId="full-origin-linked",other=join(root,plan.projectId,"full-origin-other");mkdirSync(other,{recursive:true});writeFileSync(join(other,"sentinel"),"preserved");
  mkdirSync(join(root,plan.projectId,jobId),{recursive:true});symlinkSync(other,destination(jobId),process.platform==="win32"?"junction":"dir");
  await expect(copyCurrentFilmOrigins(plan,jobId,root,access)).rejects.toThrow();expect(readdirSync(other)).toEqual(["sentinel"]);
  let reads=0;const input=structuredClone(plan);Object.defineProperty(input,"origins",{enumerable:true,get(){reads++;return plan.origins;}});
  await expect(copyCurrentFilmOrigins(input,"full-origin-accessor",root,access)).rejects.toThrow("portable");expect(reads).toBe(0);expect(existsSync(destination("full-origin-accessor"))).toBe(false);
},120000);
