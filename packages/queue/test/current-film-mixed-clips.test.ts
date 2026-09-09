import {afterAll,beforeAll,expect,test} from "bun:test";
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,writeFileSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
import {createHash} from "node:crypto";
import {currentFilmSourceFixture} from "../../planner/test/current-film-source.fixture";
import {compileCurrentFilmMixedJob} from "../../planner/src/current-film-mixed-jobs";
import {compileCurrentFilmOrigins} from "../../planner/src/current-film-origins";
import {createCurrentFilmMixedCheckpoint,type CurrentFilmMixedCheckpointRow} from "../../planner/src/current-film-mixed-context";
import type {CurrentFilmMixedJob} from "../../planner/src/current-film-mixed-job-context";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {copyCurrentFilmOrigins} from "../../generator/src/current-film-origins-media";
import {copyCurrentFilmAdoption} from "../../generator/src/current-film-adoption-media";
import {checkContinuity,repairLoop,type CostRecord} from "../../generator/src/index";
import {resolveCurrentFilmMixedClips,createCurrentFilmPreparedAdoptionReader} from "../src/current-film-mixed-clips";
import {verifyCurrentFilmMixedMedia} from "../src/current-film-mixed-media";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,root:string,fresh:CurrentFilmMixedJob,reused:CurrentFilmMixedJob;
const digest=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
function prefix(job:CurrentFilmMixedJob,rows:CurrentFilmMixedCheckpointRow[]):CurrentFilmMixedJob {
  const {currentFilmCheckpoint:_old,...base}=job;
  return {...base,currentFilmCheckpoint:createCurrentFilmMixedCheckpoint({...base,checkpointShots:0,checkpointFrame:0},rows),checkpointShots:rows.length,
    checkpointFrame:rows.reduce((sum,row)=>sum+(row.kind==="reused"?row.adoption.frames:Math.round(row.record.clip.durationSec*30)),0)};
}
beforeAll(async()=>{
  f=await currentFilmSourceFixture();root=mkdtempSync(join(f.studio.root,"mixed-clip-reader-"));
  const {currentFilm:_plan,currentFilmCheckpoint:_checkpoint,output:_output,...base}=f.job;
  // Existing actual worker records exercise reconstruction; this does not claim
  // that the independent V3 runtime dispatched or persisted these fixture rows.
  const plan=compileCurrentFilmMixedJob(f.plan,{origins:[],choices:[]});
  fresh={...base,status:"running",completedAt:null,linkExpiresAt:null,currentFilm:plan,currentFilmOrigins:compileCurrentFilmOrigins(plan,f.job.id),checkpointShots:0,checkpointFrame:0};
  const mixed=compileCurrentFilmMixedJob(f.plan,{origins:[bindOriginalEditSource(f.receipt)],choices:f.plan.materialization.slots.map((slot,ordinal)=>({
    ordinal,inputRevision:slot.inputRevision,originId:f.receipt.revision,source:{receiptRevision:f.receipt.revision,ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,
      inputRevision:slot.inputRevision,recordRevision:f.job.currentFilmCheckpoint!.rows[ordinal]!.record.revision}}))});
  reused={...base,id:"mixed-prepared-reader",status:"running",completedAt:null,linkExpiresAt:null,routeDecisions:[],currentFilm:mixed,checkpointShots:0,checkpointFrame:0};
  reused.currentFilmOrigins=await copyCurrentFilmOrigins(mixed,reused.id,f.studio.paths.artifactRoot,async()=>{});
  for(const copy of reused.currentFilmOrigins.origins.flatMap(origin=>origin.copies)){const path=resolve(root,copy.owned.path);mkdirSync(dirname(path),{recursive:true});copyFileSync(resolve(f.studio.paths.artifactRoot,copy.owned.path),path);}
},240000);
afterAll(async()=>{await f?.close();});

test("actual generated prefix reconstructs identically after JSON reload without costs or a clip manifest",async()=>{
  expect(resolveCurrentFilmMixedClips(fresh,f.studio.paths.artifactRoot)).toEqual([]);
  const rows=f.job.currentFilmCheckpoint!.rows.map(row=>({kind:"generated" as const,...row})),first=prefix(fresh,rows.slice(0,1));
  await verifyCurrentFilmMixedMedia(first,f.studio.paths.artifactRoot,async()=>{});
  const before=resolveCurrentFilmMixedClips(first,f.studio.paths.artifactRoot),after=resolveCurrentFilmMixedClips(JSON.parse(JSON.stringify(first)),f.studio.paths.artifactRoot);
  expect(after).toEqual(before);expect(before[0]!.originalRecord).toEqual(rows[0]!.record);
  expect(before[0]!.target.renderId).toBe(rows[0]!.renderId);expect(Object.hasOwn(before[0]!.clip,"cost")).toBe(false);expect(Object.hasOwn(before[0]!.clip,"renderRecord")).toBe(false);
  before[0]!.originalRecord.clip.seed++;expect(resolveCurrentFilmMixedClips(first,f.studio.paths.artifactRoot)[0]!.originalRecord.clip.seed).toBe(rows[0]!.record.clip.seed);
  const completed=prefix(fresh,rows);expect(resolveCurrentFilmMixedClips(completed,f.studio.paths.artifactRoot)).toHaveLength(rows.length);
  const lost=structuredClone(first);lost.routeDecisions=[];expect(()=>resolveCurrentFilmMixedClips(lost,f.studio.paths.artifactRoot)).toThrow("journal");
},90000);

test("adoption reads complete prepared originals after old carriers are absent and restores exact source identity",async()=>{
  expect(existsSync(resolve(root,f.job.projectId,f.job.id))).toBe(false);
  expect(existsSync(resolve(root,reused.projectId,reused.id,"clips","manifest.json"))).toBe(false);
  await verifyCurrentFilmMixedMedia(reused,root,async()=>{});let checks=0;
  const reader=createCurrentFilmPreparedAdoptionReader(reused,root,async()=>{checks++;}),rows:CurrentFilmMixedCheckpointRow[]=[];
  for(const slot of reused.currentFilm.materialization.slots){
    const adoption=await copyCurrentFilmAdoption(reused.currentFilm,reused.id,slot.ordinal,root,async()=>{},undefined,reader);
    rows.push({kind:"reused",ordinal:slot.ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,adoption});
    const saved=prefix(reused,rows),clips=resolveCurrentFilmMixedClips(JSON.parse(JSON.stringify(saved)),root);
    expect(clips).toHaveLength(rows.length);expect(clips.at(-1)!.originalRecord).toEqual(f.job.currentFilmCheckpoint!.rows[slot.ordinal]!.record);
    expect(clips.at(-1)!.clip.path.startsWith(resolve(root,reused.projectId,reused.id))).toBe(true);
    expect(Object.hasOwn(clips.at(-1)!.clip,"cost")).toBe(false);expect(Object.hasOwn(clips.at(-1)!.clip,"renderRecord")).toBe(false);
    for(const copy of adoption.copies)expect(digest(readFileSync(resolve(root,copy.owned.path)))).toBe(copy.original.sha256);
  }
  reused=prefix(reused,rows);await verifyCurrentFilmMixedMedia(reused,root,async()=>{});expect(checks).toBeGreaterThan(rows.length);
  expect(existsSync(resolve(root,f.job.projectId,f.job.id))).toBe(false);
},180000);

test("prepared reader rejects unselected tuples, changed bytes, revocation and cancellation",async()=>{
  const role=reused.currentFilmOrigins!.origins[0]!.copies.find(copy=>copy.original.path===f.job.currentFilmCheckpoint!.rows[0]!.record.files.video.path)!,key=role.carrier.path,carrierId=key.split("/")[1]!;
  const reader=createCurrentFilmPreparedAdoptionReader(reused,root,async()=>{}),request=()=>new Request("http://127.0.0.1/internal-test");
  await expect(reader.response("foreign",carrierId,key,request())).rejects.toThrow("unselected");
  await expect(reader.response(reused.projectId,reused.id,key,request())).rejects.toThrow("unselected");
  await expect(reader.response(reused.projectId,carrierId,f.job.output!.mp4Path,request())).rejects.toThrow("unselected");
  await expect(reader.response(reused.projectId,carrierId,key,new Request("http://127.0.0.1/internal-test",{method:"POST"}))).rejects.toThrow("unselected");
  const response=await reader.response(reused.projectId,carrierId,key,request());
  expect(response!.headers.get("etag")).toBe('"'+role.carrier.sha256+'"');expect(response!.headers.get("content-length")).toBe(String(role.carrier.bytes));expect(digest(new Uint8Array(await response!.arrayBuffer()))).toBe(role.carrier.sha256);
  const path=resolve(root,role.owned.path),original=readFileSync(path);
  try{const bytes=Buffer.from(original);bytes[bytes.length-1]^=1;writeFileSync(path,bytes);const changed=await reader.response(reused.projectId,carrierId,key,request());await expect(changed!.arrayBuffer()).rejects.toThrow("checksum");}finally{writeFileSync(path,original);}
  let allowed=true;const revocable=createCurrentFilmPreparedAdoptionReader(reused,root,async()=>{if(!allowed)throw new Error("fixture revoked");});
  const pending=await revocable.response(reused.projectId,carrierId,key,request());allowed=false;await expect(pending!.arrayBuffer()).rejects.toThrow("revoked");
  const controller=new AbortController(),cancellable=createCurrentFilmPreparedAdoptionReader(reused,root,async()=>{},controller.signal),waiting=await cancellable.response(reused.projectId,carrierId,key,request());
  controller.abort(new Error("fixture stopped"));await expect(waiting!.arrayBuffer()).rejects.toThrow("fixture stopped");
  const other=new AbortController(),byRequest=await reader.response(reused.projectId,carrierId,key,new Request("http://127.0.0.1/internal-test",{signal:other.signal}));other.abort(new Error("request stopped"));await expect(byRequest!.arrayBuffer()).rejects.toThrow("request stopped");
},90000);

test("continuity and repair consume only previous fingerprint while new generation costs stay intact",async()=>{
  const record=f.job.currentFilmCheckpoint!.rows[0]!.record,previous={fingerprint:record.clip.fingerprint};
  expect(checkContinuity("target",previous,previous)).toEqual({shotId:"target",score:1,passed:true});
  const mismatch={fingerprint:Buffer.from(Buffer.from(previous.fingerprint,"hex").map(value=>255-value)).toString("hex")};
  const cost:CostRecord={provider:"mock",model:"mock",prompt_tokens:1,output_frames:30,gpu_seconds:0,total_cost_usd:0};
  // The generator's accounting shape stays mandatory for newly generated clips.
  const actualClip={...record.clip,path:resolve(f.studio.paths.artifactRoot,record.files.video.path),cost};
  const queue:{shotId:string;score:number}[]=[];let calls=0;
  const result=await repairLoop("target",previous,async attempt=>{calls++;return {...actualClip,fingerprint:attempt===0?mismatch.fingerprint:previous.fingerprint};},queue);
  expect(calls).toBe(2);expect(result.outcome.attempts).toBe(1);expect(result.sunkCosts).toEqual([actualClip.cost]);expect(result.clip.cost).toEqual(actualClip.cost);expect(queue).toHaveLength(1);
});
