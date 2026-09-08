import {afterAll,beforeAll,expect,spyOn,test} from "bun:test";
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,statSync,symlinkSync,unlinkSync,writeFileSync} from "node:fs";
import {open,type FileHandle} from "node:fs/promises";
import {dirname,join} from "node:path";
import {contentHash as hash} from "../src/capabilities";
import {currentFilmSourceFixture} from "../../planner/test/current-film-source.fixture";
import {bindOriginalEditSource,validateEditBinding} from "../../planner/src/edit-jobs";
import {compileCurrentFilmMixedJob,type CurrentFilmJobV3,type CurrentFilmReuseChoice} from "../../planner/src/current-film-mixed-jobs";
import {compileCurrentFilmAdoption} from "../../planner/src/current-film-adoption";
import {copyCurrentFilmAdoption,verifyCurrentFilmAdoptionMedia} from "../src/current-film-adoption-media";
import type {DialogueArtifactReader} from "../src/dialogue-replacement";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,plan:CurrentFilmJobV3,ordinal:number,root:string;
const access=async()=>{};
function choice():CurrentFilmReuseChoice {
  const slot=f.plan.materialization.slots[ordinal]!,row=f.job.currentFilmCheckpoint!.rows[ordinal]!;
  return {ordinal,inputRevision:slot.inputRevision,originId:f.receipt.revision,source:{receiptRevision:f.receipt.revision,ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:row.record.revision}};
}
function slot(jobId:string){return join(root,plan.projectId,jobId,"reused",`slot-${String(ordinal).padStart(4,"0")}`);}
function scratch(jobId:string){const parent=join(root,plan.projectId,jobId,"reused");return existsSync(parent)?readdirSync(parent).filter(name=>name.startsWith(".adoption-")):[];}
beforeAll(async()=>{
  f=await currentFilmSourceFixture();root=f.studio.paths.artifactRoot;
  ordinal=f.job.currentFilmCheckpoint!.rows.findIndex(row=>Boolean(row.record.files.audio));
  if(ordinal<0)throw new Error("The adoption media fixture requires real native speech.");
  plan=compileCurrentFilmMixedJob(f.plan,{origins:[bindOriginalEditSource(f.receipt)],choices:[choice()]});
},180000);
afterAll(async()=>{await f?.close();});

test("all actual V2 roles and native PCM restore from target-owned bytes without original or carrier directories",async()=>{
  const before=hash(f.receipt),jobId="adoption-media-original",adoption=await copyCurrentFilmAdoption(plan,jobId,ordinal,root,access);
  expect(adoption).toEqual(compileCurrentFilmAdoption(plan,jobId,ordinal));expect(adoption.copies.some(copy=>copy.role==="audio")).toBe(true);
  for(const copy of adoption.copies){expect(readFileSync(join(root,copy.owned.path))).toEqual(readFileSync(join(root,copy.original.path)));}
  await verifyCurrentFilmAdoptionMedia(adoption,plan,jobId,root,access);
  const restored=mkdtempSync(join(f.studio.root,"adoption-independent-"));
  for(const copy of adoption.copies){const target=join(restored,copy.owned.path);mkdirSync(dirname(target),{recursive:true});copyFileSync(join(root,copy.owned.path),target);}
  expect(existsSync(join(restored,plan.projectId,f.job.id))).toBe(false);
  await verifyCurrentFilmAdoptionMedia(adoption,plan,jobId,restored,access);
  expect(readdirSync(join(restored,plan.projectId))).toEqual([jobId]);expect(scratch(jobId)).toEqual([]);
  expect(hash(f.receipt)).toBe(before);
  // A retry verifies an existing copy; copy itself must not replace it.
  await expect(copyCurrentFilmAdoption(plan,jobId,ordinal,root,access)).rejects.toThrow();
  expect(readFileSync(join(root,adoption.copies[0]!.owned.path))).toEqual(readFileSync(join(root,adoption.copies[0]!.original.path)));
},120000);

test("an authenticated distinct carrier serves every selected role and the original metadata stays unchanged",async()=>{
  const binding=bindOriginalEditSource(f.receipt),carrierId="adoption-retained-carrier",before=hash(f.receipt);
  binding.owner.jobId=carrierId;binding.owner.outputRevision="a".repeat(64);
  binding.files=binding.files.map((file,index)=>{const path=`${plan.projectId}/${carrierId}/original/file-${index}`,target=join(root,path);mkdirSync(dirname(target),{recursive:true});copyFileSync(join(root,file.path),target);return {...file,path};});
  const {revision:_revision,...body}=binding,checked=validateEditBinding({...body,revision:hash(body)}),retained=compileCurrentFilmMixedJob(f.plan,{origins:[checked],choices:[choice()]});
  const requested:string[]=[],reader:DialogueArtifactReader={async response(projectId,jobId,key,request){
    expect(projectId).toBe(plan.projectId);expect(jobId).toBe(carrierId);expect(request.signal.aborted).toBe(false);requested.push(key);
    const file=checked.files.find(value=>value.path===key);if(!file)return null;
    return new Response(Bun.file(join(root,key)).stream(),{headers:{etag:'"'+file.sha256+'"',"content-length":String(file.bytes)}});
  }};
  const targetId="adoption-media-retained",adoption=await copyCurrentFilmAdoption(retained,targetId,ordinal,root,access,undefined,reader);
  expect(requested).toEqual(adoption.copies.map(copy=>copy.carrier.path));
  for(const copy of adoption.copies){expect(copy.original.path).not.toBe(copy.carrier.path);expect(readFileSync(join(root,copy.owned.path))).toEqual(readFileSync(join(root,copy.carrier.path)));}
  const restored=mkdtempSync(join(f.studio.root,"adoption-retained-independent-"));
  for(const copy of adoption.copies){const path=join(restored,copy.owned.path);mkdirSync(dirname(path),{recursive:true});copyFileSync(join(root,copy.owned.path),path);}
  expect(existsSync(join(restored,plan.projectId,f.job.id))).toBe(false);expect(existsSync(join(restored,plan.projectId,carrierId))).toBe(false);
  await verifyCurrentFilmAdoptionMedia(adoption,retained,targetId,restored,access);expect(hash(f.receipt)).toBe(before);
},120000);

test("missing or dishonest carrier responses cannot publish partial copies or overwrite neighboring jobs",async()=>{
  const sentinel=join(root,"adoption-neighbor.txt");writeFileSync(sentinel,"preserve this independent file");
  for(const mode of ["missing","corrupt","oversize"] as const){
    const jobId=`adoption-media-${mode}`,reader:DialogueArtifactReader={async response(_projectId,_jobId,key){
      if(mode==="missing")return null;const file=f.receipt.files.find(value=>value.path===key)!;
      const bytes=Buffer.from(readFileSync(join(root,key)));bytes[bytes.length-1]=bytes[bytes.length-1]!^1;
      return new Response(mode==="oversize"?Buffer.concat([bytes,Buffer.from([0])]):bytes,{headers:{etag:'"'+file.sha256+'"',"content-length":String(file.bytes)}});
    }};
    await expect(copyCurrentFilmAdoption(plan,jobId,ordinal,root,access,undefined,reader)).rejects.toThrow();
    expect(existsSync(slot(jobId))).toBe(false);expect(scratch(jobId)).toEqual([]);expect(readFileSync(sentinel,"utf8")).toBe("preserve this independent file");
  }
},120000);

test("aborting a stalled carrier read releases promptly and cancels its body without keeping partial media",async()=>{
  const jobId="adoption-media-abort",controller=new AbortController();let entered!:()=>void,cancelled=0;
  const waiting=new Promise<void>(resolve=>{entered=resolve;}),reader:DialogueArtifactReader={async response(_projectId,_jobId,key){const file=f.receipt.files.find(value=>value.path===key)!;
    return new Response(new ReadableStream<Uint8Array>({pull(){entered();return new Promise<void>(()=>{});},cancel(){cancelled++;}},{highWaterMark:0}),{headers:{etag:'"'+file.sha256+'"',"content-length":String(file.bytes)}});
  }};
  const pending=copyCurrentFilmAdoption(plan,jobId,ordinal,root,access,controller.signal,reader);await waiting;
  const start=performance.now();controller.abort();await expect(pending).rejects.toThrow();
  expect(performance.now()-start).toBeLessThan(1500);expect(cancelled).toBe(1);expect(existsSync(slot(jobId))).toBe(false);expect(scratch(jobId)).toEqual([]);
},120000);

test("current access is checked during streamed copying and a revoked source never leaves a completed target",async()=>{
  const jobId="adoption-media-revoked";let revoked=false,checks=0;
  const current=async()=>{checks++;if(revoked)throw new Error("Current source rights withdrawn.");};
  const reader:DialogueArtifactReader={async response(_projectId,_jobId,key){const file=f.receipt.files.find(value=>value.path===key)!,bytes=readFileSync(join(root,key));let part=0;
    return new Response(new ReadableStream<Uint8Array>({pull(target){if(part++===0)target.enqueue(bytes.subarray(0,Math.floor(bytes.length/2)));else{revoked=true;target.enqueue(bytes.subarray(Math.floor(bytes.length/2)));target.close();}}}),{headers:{etag:'"'+file.sha256+'"',"content-length":String(file.bytes)}});
  }};
  await expect(copyCurrentFilmAdoption(plan,jobId,ordinal,root,current,undefined,reader)).rejects.toThrow("rights withdrawn");
  expect(checks).toBeGreaterThan(2);expect(existsSync(slot(jobId))).toBe(false);expect(scratch(jobId)).toEqual([]);
},120000);

test("restored missing or corrupt roles refuse verification while preserving all existing destination files",async()=>{
  const jobId="adoption-media-restore-errors",adoption=await copyCurrentFilmAdoption(plan,jobId,ordinal,root,access),copy=adoption.copies.find(value=>value.role==="audio")!,path=join(root,copy.owned.path),bytes=readFileSync(path);
  const corrupted=Buffer.from(bytes);corrupted[44]=corrupted[44]!^1;writeFileSync(path,corrupted);
  await expect(verifyCurrentFilmAdoptionMedia(adoption,plan,jobId,root,access)).rejects.toThrow("checksum");expect(readFileSync(path)).toEqual(corrupted);
  unlinkSync(path);await expect(verifyCurrentFilmAdoptionMedia(adoption,plan,jobId,root,access)).rejects.toThrow();
  expect(existsSync(join(root,adoption.copies.find(value=>value.role==="video")!.owned.path))).toBe(true);
  writeFileSync(path,bytes);await verifyCurrentFilmAdoptionMedia(adoption,plan,jobId,root,access);expect(scratch(jobId)).toEqual([]);
},120000);

test("publication checks abort and current rights between chunks of an actual native WAV",async()=>{
  for(const mode of ["abort","revoke"] as const){
    const jobId=`adoption-publication-${mode}`,adoption=compileCurrentFilmAdoption(plan,jobId,ordinal),wav=adoption.copies.find(copy=>copy.role==="audio")!;
    expect(wav.owned.bytes).toBeGreaterThan(64*1024);const path=join(root,wav.owned.path),controller=new AbortController();let interruptedAt=0,partialBytes=0;
    const current=async()=>{if(existsSync(path)){const size=statSync(path).size;if(size>0&&size<wav.owned.bytes){partialBytes=size;interruptedAt=performance.now();
      if(mode==="abort")controller.abort();else throw new Error("Current source rights withdrawn during publication.");}}};
    await expect(copyCurrentFilmAdoption(plan,jobId,ordinal,root,current,controller.signal)).rejects.toThrow();
    expect(partialBytes).toBe(64*1024);expect(performance.now()-interruptedAt).toBeLessThan(1500);
    expect(existsSync(slot(jobId))).toBe(false);expect(scratch(jobId)).toEqual([]);
    expect(readFileSync(join(root,wav.original.path)).length).toBe(wav.original.bytes);
  }
},120000);

test("a final access refusal removes a complete new copy without deleting the existing original",async()=>{
  const jobId="adoption-publication-final-check",adoption=compileCurrentFilmAdoption(plan,jobId,ordinal);let sawComplete=false;
  const current=async()=>{if(adoption.copies.every(copy=>existsSync(join(root,copy.owned.path))&&statSync(join(root,copy.owned.path)).size===copy.owned.bytes)){
    sawComplete=true;throw new Error("Current target was withdrawn after copying.");}};
  await expect(copyCurrentFilmAdoption(plan,jobId,ordinal,root,current)).rejects.toThrow("after copying");
  expect(sawComplete).toBe(true);expect(existsSync(slot(jobId))).toBe(false);expect(scratch(jobId)).toEqual([]);
  for(const copy of adoption.copies)expect(existsSync(join(root,copy.original.path))).toBe(true);
},120000);

test("publication yields to independent abort and revocation timers while access checks resolve immediately",async()=>{
  // Simulate slower local writes without delaying authority or replacing file bytes.
  // The original synchronous publication path never reaches this asynchronous hook.
  const handle=await open(join(f.studio.root,"adoption-write-prototype"),"wx"),prototype=Object.getPrototypeOf(handle) as FileHandle,write=prototype.write;await handle.close();
  const delayed=spyOn(prototype,"write").mockImplementation((async function(this:FileHandle,buffer:Uint8Array,offset?:number,length?:number,position?:number|null){
    await new Promise<void>(resolve=>setTimeout(resolve,4));return Reflect.apply(write,this,[buffer,offset,length,position]);
  }) as FileHandle["write"]);
  try{
  for(const mode of ["abort","revoke"] as const){
    const jobId=`adoption-publication-timer-${mode}`,adoption=compileCurrentFilmAdoption(plan,jobId,ordinal),wav=adoption.copies.find(copy=>copy.role==="audio")!,path=join(root,wav.owned.path);
    expect(wav.owned.bytes).toBeGreaterThan(64*1024);const controller=new AbortController();let timer:ReturnType<typeof setTimeout>|undefined,revoked=false,firedAt=0,observedBytes=0,timerBytes=0;
    const current=async()=>{
      if(revoked)throw new Error("Current rights revoked by independent timer.");
      if(!timer&&existsSync(path)){const size=statSync(path).size;if(size>0&&size<wav.owned.bytes){observedBytes=size;timer=setTimeout(()=>{
        firedAt=performance.now();timerBytes=statSync(path).size;if(mode==="abort")controller.abort();else revoked=true;
      },0);}}
    };
    try{await expect(copyCurrentFilmAdoption(plan,jobId,ordinal,root,current,controller.signal)).rejects.toThrow();
      expect(observedBytes).toBe(64*1024);expect(timerBytes).toBeLessThan(wav.owned.bytes);expect(firedAt).toBeGreaterThan(0);expect(performance.now()-firedAt).toBeLessThan(1500);
      expect(existsSync(slot(jobId))).toBe(false);expect(scratch(jobId)).toEqual([]);
    }finally{clearTimeout(timer);}
  }
  }finally{delayed.mockRestore();}
},120000);

test("an in-workspace directory junction cannot redirect adopted output into another owner",async()=>{
  const jobId="adoption-media-linked",outside=join(root,plan.projectId,"adoption-other-owner");mkdirSync(outside,{recursive:true});
  const parent=join(root,plan.projectId,jobId);mkdirSync(parent,{recursive:true});symlinkSync(outside,join(parent,"reused"),process.platform==="win32"?"junction":"dir");
  await expect(copyCurrentFilmAdoption(plan,jobId,ordinal,root,access)).rejects.toThrow("linked");expect(readdirSync(outside)).toEqual([]);
},120000);
