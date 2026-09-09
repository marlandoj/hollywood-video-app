import {afterAll,beforeAll,expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {mkdtempSync,readFileSync,readdirSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,relative} from "node:path";
import {contentHash as hash} from "../../generator/src/capabilities";
import {currentFilmSourceFixture} from "../../planner/test/current-film-source.fixture";
import {compileCurrentFilmMixedJob} from "../../planner/src/current-film-mixed-jobs";
import type {CurrentFilmMixedJob} from "../../planner/src/current-film-mixed-job-context";
import {compileCurrentFilmProofTarget} from "../../planner/src/current-film-proof-target";
import {compileCurrentFilmProofClosure} from "../../planner/src/current-film-proof-closure";
import {compileCurrentFilmProofCopies,freezeCurrentFilmProofContext} from "../../planner/src/current-film-proof-copies";
import {createCurrentFilmPreparedProof} from "../../planner/src/current-film-prepared-proof";
import {currentFilmRuntimeRecordedFiles} from "../../planner/src/current-film-runtime-context";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {stateSnapshotSchema,validateSnapshot,type StateSnapshot} from "../src/snapshots";
import {snapshotUsesCurrentFilmProof,validateCurrentScreenplayRecovery} from "../src/current-screenplay-snapshots";
import {verifyCurrentFilmMixedArchive} from "../../../scripts/verify-current-film-mixed-archive";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,prepared:CurrentFilmMixedJob,snapshot:StateSnapshot;
beforeAll(async()=>{
  f=await currentFilmSourceFixture();const final=await f.renderFinal(),source=final.job,basePlan=source.currentFilm!;
  const slot=basePlan.materialization.slots[0]!,record=source.currentFilmCheckpoint!.rows[0]!.record;
  const plan=compileCurrentFilmMixedJob(basePlan,{origins:[bindOriginalEditSource(final.receipt)],choices:[{ordinal:0,inputRevision:slot.inputRevision,originId:final.receipt.revision,
    source:{receiptRevision:final.receipt.revision,ordinal:0,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:record.revision}}]});
  const {currentFilm:_plan,currentFilmCheckpoint:_checkpoint,output:_output,...base}=source;
  const startedAt=new Date(Date.parse(source.completedAt!)+1).toISOString();
  prepared={...base,id:"proof-snapshot-owner",idempotencyKey:"proof-snapshot-owner",currentFilm:plan,status:"failed",checkpointShots:0,checkpointFrame:0,
    costUsd:0,cost:undefined,routeDecisions:[],claimedBy:null,leaseExpiresAt:null,startedAt,completedAt:null,linkExpiresAt:null,failureReason:"Interrupted after proof preparation"};
  const target=compileCurrentFilmProofTarget(prepared),frozenContext=freezeCurrentFilmProofContext({project:f.projects.snapshot().projects[0]!,jobs:[f.studio.film,f.job,source]});
  const closure=compileCurrentFilmProofClosure(plan,frozenContext,target),root=f.studio.paths.artifactRoot;
  const previews=closure.previews.map(({job})=>{
    const output=job.output!,paths=new Set(currentFilmRuntimeRecordedFiles(job).map(file=>file.path));
    for(const path of [output.mp4Path,output.hlsPlaylistPath,output.captionsPath,output.captionsPath.slice(0,-4)+".srt",output.manifestPath,`${job.projectId}/${job.id}/clips/manifest.json`,
      ...(output.storyboard??[]).flatMap(row=>[row.path,...(row.sourcePath?[row.sourcePath]:[])])])paths.add(path);
    for(const name of readdirSync(join(root,dirname(output.hlsPlaylistPath))))paths.add(relative(root,join(root,dirname(output.hlsPlaylistPath),name)).replaceAll("\\","/"));
    return {jobId:job.id,files:[...paths].sort().map(path=>{const bytes=readFileSync(join(root,path));return {path,sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length};})};
  });
  const carriers=closure.receipts.map(({receipt,candidates})=>{const candidate=candidates.find(value=>value.kind==="original")!;
    return {receiptRevision:receipt.revision,kind:candidate.kind,jobId:candidate.jobId,jobRevision:candidate.jobRevision,evidenceRevision:candidate.evidenceRevision};});
  const specification=compileCurrentFilmProofCopies(plan,prepared.id,{frozenContext,carriers,previews,target});
  // Actual immutable source/preview evidence; preparation here is a metadata
  // format fixture, not a claim that owned proof bytes were copied or checkpointed.
  prepared.currentFilmProof=createCurrentFilmPreparedProof(prepared,specification,Date.parse(startedAt)+1);
  snapshot={schema:"hv-state/15",projects:f.projects.snapshot(),jobs:[prepared],ledger:{events:[],reservations:[]},reviews:[]};
},300000);
afterAll(async()=>{await f?.close();});

test("schema 15 retains proof-only historical source and target preview contexts without synthetic top-level jobs",()=>{
  expect(stateSnapshotSchema(snapshot.projects,snapshot.jobs)).toBe("hv-state/15");expect(validateSnapshot(snapshot)).toEqual(snapshot);
  expect(snapshot.jobs.map(job=>job.id)).toEqual([prepared.id]);expect(prepared.currentFilmOrigins).toBeUndefined();expect(prepared.currentFilmCheckpoint).toBeUndefined();expect(prepared.output).toBeUndefined();
  const marker=prepared.currentFilmProof!,before=hash(snapshot);
  expect(marker.specification.target?.animaticJobId).toBe(f.job.id);expect(marker.specification.frozenContext.jobs.some(job=>job.id===f.job.id)).toBe(true);
  expect(()=>validateCurrentScreenplayRecovery(snapshot.projects,snapshot.jobs)).not.toThrow();expect(hash(snapshot)).toBe(before);
  expect(validateSnapshot(JSON.parse(JSON.stringify(snapshot)))).toEqual(JSON.parse(JSON.stringify(snapshot)));
  const independentApproval=structuredClone(snapshot);independentApproval.projects.projects[0]!.animaticApprovals=[];
  expect(()=>validateSnapshot(independentApproval)).not.toThrow();
  const absent=structuredClone(snapshot);delete absent.jobs[0]!.currentFilmProof;
  expect(stateSnapshotSchema(absent.projects,absent.jobs)).toBe("hv-state/14");
},90000);

test("all older schemas reject proof downgrade and exact marker/capture ownership cannot be bypassed",()=>{
  for(let schema=1;schema<=14;schema++)expect(()=>validateSnapshot({...snapshot,schema:`hv-state/${schema}` as StateSnapshot["schema"]})).toThrow("schema 15");
  for(const schema of ["hv-current-film-prepared-proof/1","hv-current-film-proof-copies/1","hv-current-film-proof-target/1","hv-current-film-proof-closure/1"]){
    const changed=structuredClone(snapshot);Object.assign(changed.jobs[0]!,{abandoned:{schema}});expect(snapshotUsesCurrentFilmProof(changed.projects,changed.jobs)).toBe(true);expect(()=>validateSnapshot(changed)).toThrow("unowned");
  }
  let reads=0;const hidden=structuredClone(snapshot);Object.defineProperty(hidden.jobs[0],"currentFilmProof",{enumerable:true,get(){reads++;return prepared.currentFilmProof;}});
  expect(()=>validateSnapshot(hidden)).toThrow("accessors");expect(reads).toBe(0);
  const alias=structuredClone(snapshot);Object.assign(alias.jobs[0]!,{extra:alias.jobs[0]!.currentFilmProof});expect(()=>validateSnapshot(alias)).toThrow();
},90000);

test("re-sealed missing preview, changed owned file, execution time, or foreign nested source refuses",()=>{
  for(const mutate of [
    (job:CurrentFilmMixedJob)=>{job.currentFilmProof!.specification.frozenContext.jobs=job.currentFilmProof!.specification.frozenContext.jobs.filter(value=>value.id!==f.job.id);},
    (job:CurrentFilmMixedJob)=>{job.currentFilmProof!.specification.carriers[0]!.copies[0]!.owned.sha256="a".repeat(64);},
    (job:CurrentFilmMixedJob)=>{job.startedAt=new Date(Date.parse(job.startedAt!)+10).toISOString();},
    (job:CurrentFilmMixedJob)=>{job.currentFilmProof!.specification.frozenContext.jobs[0]!.projectId="foreign";},
  ]){
    const changed=structuredClone(prepared);mutate(changed);const proof=changed.currentFilmProof!,{revision:_copy,...copyBody}=proof.specification;proof.specification={...copyBody,revision:hash(copyBody)};
    const {revision:_marker,...body}=proof;changed.currentFilmProof={...body,revision:hash(body)};
    expect(()=>validateSnapshot({...snapshot,jobs:[changed]})).toThrow();
  }
  for(const status of ["queued","running"] as const)expect(()=>validateSnapshot({...snapshot,jobs:[{...prepared,status}]})).toThrow("drained");
},90000);

test("proof-only media requires its complete owned inventory even before origins or slot one",async()=>{
  const root=mkdtempSync(join(tmpdir(),"hv-proof-archive-empty-"));
  try{await expect(verifyCurrentFilmMixedArchive(prepared,root)).rejects.toThrow("complete owned inventory");}finally{rmSync(root,{recursive:true,force:true});}
},90000);
