import {afterAll,beforeAll,expect,test} from "bun:test";
import {currentFilmSourceFixture} from "../../planner/test/current-film-source.fixture";
import {compileCurrentFilmMixedJob} from "../../planner/src/current-film-mixed-jobs";
import {compileCurrentFilmOrigins} from "../../planner/src/current-film-origins";
import {createCurrentFilmMixedCheckpoint} from "../../planner/src/current-film-mixed-context";
import {createCurrentFilmMixedAssemblyClock} from "../../planner/src/current-film-mixed-clock";
import {createCurrentFilmMixedOutput,type CurrentFilmMixedJob} from "../../planner/src/current-film-mixed-job-context";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {contentHash} from "../../generator/src/capabilities";
import {snapshotUsesCurrentFilmMixed,validateCurrentScreenplayRecovery} from "../src/current-screenplay-snapshots";
import type {PersistedState} from "../../api/src/index";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,completed:CurrentFilmMixedJob,prepared:CurrentFilmMixedJob,projects:PersistedState;
beforeAll(async()=>{
  f=await currentFilmSourceFixture();projects=f.projects.snapshot();
  // Authentic V2 records and clock are used only as a V3 metadata-format fixture.
  // These converted envelopes do not establish actual V3 worker/media recovery.
  const plan=compileCurrentFilmMixedJob(f.plan,{origins:[],choices:[]});
  const {currentFilm:_plan,currentFilmCheckpoint:_checkpoint,output:_output,...base}=f.job;
  const owner:CurrentFilmMixedJob={...base,currentFilm:plan,currentFilmOrigins:compileCurrentFilmOrigins(plan,base.id),checkpointShots:0,checkpointFrame:0};
  const rows=f.job.currentFilmCheckpoint!.rows.map(row=>({kind:"generated" as const,...row}));
  completed={...owner,currentFilmCheckpoint:createCurrentFilmMixedCheckpoint(owner,rows),checkpointShots:rows.length,checkpointFrame:f.job.checkpointFrame};
  const old=f.job.output!.currentFilm!.assembly;
  const clock=createCurrentFilmMixedAssemblyClock(completed,completed.currentFilmCheckpoint!,{sourceFrames:old.spans.map(span=>span.frames),effectiveOverlapFrames:old.effectiveOverlapFrames,
    reason:old.reason,probe:old.probe,video:old.video,captions:{srt:old.captions.srt,vtt:old.captions.vtt}});
  const {mp4Path,hlsPlaylistPath,captionsPath,manifestPath}=f.job.output!;
  completed.output={mp4Path,hlsPlaylistPath,captionsPath,manifestPath,currentFilm:createCurrentFilmMixedOutput(completed,clock)};
  const ordinal=1,slot=f.plan.materialization.slots[ordinal]!,record=f.job.currentFilmCheckpoint!.rows[ordinal]!.record;
  const reused=compileCurrentFilmMixedJob(f.plan,{origins:[bindOriginalEditSource(f.receipt)],choices:[{ordinal,inputRevision:slot.inputRevision,originId:f.receipt.revision,
    source:{receiptRevision:f.receipt.revision,ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:record.revision}}]});
  prepared={...base,id:"mixed-origins-recovery-owner",idempotencyKey:"mixed-origins-recovery-owner",currentFilm:reused,status:"cancelled",checkpointShots:0,checkpointFrame:0,
    routeDecisions:[],costUsd:0,claimedBy:null,leaseExpiresAt:null,completedAt:null,linkExpiresAt:null};
  prepared.currentFilmOrigins=compileCurrentFilmOrigins(reused,prepared.id);
},180000);
afterAll(async()=>{await f?.close();});

test("V3 recovery registers exact generated and retained-original capture owners including zero-shot preparation",()=>{
  expect(snapshotUsesCurrentFilmMixed(projects,[f.job])).toBe(false);
  expect(snapshotUsesCurrentFilmMixed(projects,[completed])).toBe(true);
  expect(snapshotUsesCurrentFilmMixed(projects,[prepared])).toBe(true);
  const captures=validateCurrentScreenplayRecovery(projects,[completed]);
  for(const row of completed.currentFilmCheckpoint!.rows)if(row.kind==="generated")expect(captures.has(row.capture)).toBe(true);
  const retained=validateCurrentScreenplayRecovery(projects,[prepared]);
  for(const row of prepared.currentFilm.origins[0]!.binding.source.job.currentFilmCheckpoint!.rows)if("capture" in row)expect(retained.has(row.capture)).toBe(true);
  const before=structuredClone(prepared);delete before.currentFilmOrigins;
  expect(()=>validateCurrentScreenplayRecovery(projects,[before])).not.toThrow();
},90000);

test("mixed origins require exact owner, original inventory, execution time and durable counters",()=>{
  for(const mutate of [
    (job:CurrentFilmMixedJob)=>{job.currentFilmOrigins!.origins[0]!.copies.pop();},
    (job:CurrentFilmMixedJob)=>{job.currentFilmOrigins!.jobId="other-owner";},
    (job:CurrentFilmMixedJob)=>{job.currentFilmOrigins!.origins[0]!.copies[0]!.owned.sha256="a".repeat(64);},
    (job:CurrentFilmMixedJob)=>{job.startedAt=null;},
    (job:CurrentFilmMixedJob)=>{job.checkpointShots=1;},
    (job:CurrentFilmMixedJob)=>{job.status="running";},
  ]){const changed=structuredClone(prepared);mutate(changed);const {revision:_revision,...body}=changed.currentFilmOrigins!;
    changed.currentFilmOrigins={...body,revision:contentHash(body)};expect(()=>validateCurrentScreenplayRecovery(projects,[changed])).toThrow();}
  const missing=structuredClone(completed);delete missing.currentFilmOrigins;expect(()=>validateCurrentScreenplayRecovery(projects,[missing])).toThrow();
},90000);

test("mixed recovery rejects orphan markers, aliases, getters and hidden origins without reading them",()=>{
  for(const schema of ["hv-current-film-job/3","hv-current-film-origins/1","hv-current-film-adoption/1","hv-current-film-retained-execution/1",
    "hv-current-film-execution-projection/1","hv-current-film-reuse-review/1","hv-current-film-assembly-inputs/3"]){
    const changed=Object.assign(structuredClone(prepared),{unowned:{schema}});
    expect(snapshotUsesCurrentFilmMixed(projects,[changed])).toBe(true);expect(()=>validateCurrentScreenplayRecovery(projects,[changed])).toThrow();
  }
  const orphan=Object.assign(structuredClone(f.job),{currentFilmOrigins:undefined});
  expect(snapshotUsesCurrentFilmMixed(projects,[orphan])).toBe(true);expect(()=>validateCurrentScreenplayRecovery(projects,[orphan])).toThrow();
  const alias=structuredClone(completed),first=alias.currentFilmCheckpoint!.rows[0]!;
  if(first.kind!=="generated")throw new Error("The format fixture needs a generated row.");
  Object.assign(alias,{unowned:first.capture});expect(()=>validateCurrentScreenplayRecovery(projects,[alias])).toThrow("exact private checkpoint");
  let reads=0;const hostile=structuredClone(prepared);Object.defineProperty(hostile,"currentFilmOrigins",{enumerable:true,get(){reads++;return prepared.currentFilmOrigins;}});
  expect(()=>snapshotUsesCurrentFilmMixed(projects,[hostile])).toThrow("accessors");expect(()=>validateCurrentScreenplayRecovery(projects,[hostile])).toThrow("accessors");expect(reads).toBe(0);
  const hidden=structuredClone(prepared);Object.defineProperty(hidden,"currentFilmOrigins",{value:hidden.currentFilmOrigins,enumerable:false});
  expect(()=>validateCurrentScreenplayRecovery(projects,[hidden])).toThrow("hidden");
},90000);

test("retained originals preserve exact duplicate identity while historical recovery permits later project heads",()=>{
  const laterSource={...structuredClone(f.job),notifications:[...f.job.notifications,"Later delivery notice"]};
  expect(()=>validateCurrentScreenplayRecovery(projects,[prepared,laterSource])).not.toThrow();
  laterSource.linkExpiresAt=new Date(Date.parse(laterSource.linkExpiresAt!)+1000).toISOString();
  expect(()=>validateCurrentScreenplayRecovery(projects,[prepared,laterSource])).toThrow("owning job context");
  const later={...projects,projects:[f.accept()]};expect(()=>validateCurrentScreenplayRecovery(later,[prepared])).not.toThrow();
},90000);
