import {afterAll,beforeAll,expect,test} from "bun:test";
import {currentFilmSourceFixture} from "./current-film-source.fixture";
import {bindOriginalEditSource} from "../src/edit-jobs";
import {compileCurrentFilmMixedJob,type CurrentFilmReuseChoice} from "../src/current-film-mixed-jobs";
import {compileCurrentFilmAdoption} from "../src/current-film-adoption";
import {advanceCurrentFilmMixedCheckpoint,createCurrentFilmMixedCheckpoint,currentFilmMixedRowFrames,validateCurrentFilmMixedCheckpoint,type CurrentFilmMixedCheckpoint,type CurrentFilmMixedCheckpointContext,type CurrentFilmMixedCheckpointRow} from "../src/current-film-mixed-context";
import {contentHash as hash} from "../../generator/src/capabilities";
import {processNextJob} from "../../queue/src/worker";
import type {Job,JobInput} from "../../queue/src/index";
import {renderRecord} from "../src/shot-reuse";
import {createShotExecutionCapture} from "../src/shot-execution-capture";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,fresh:Job,context:CurrentFilmMixedCheckpointContext,rows:CurrentFilmMixedCheckpointRow[];
beforeAll(async()=>{
  f=await currentFilmSourceFixture();
  // A separate all-fresh V2 worker supplies authentic target-owned fresh evidence.
  // This tests V3 metadata, not an activated mixed worker or avoided provider calls.
  const p=f.plan,id="mixed-checkpoint-fresh-evidence";
  const input:JobInput={id,projectId:p.projectId,idempotencyKey:id,tier:p.render.tier,stage:p.render.stage,scriptVersion:p.materialization.script.version,
    scriptText:p.materialization.script.text,casting:p.target.state.casting.candidate!,providerPlan:p.render.providerPlan,currentFilm:p,rightsAttestedAt:f.project.rightsAttestedAt,
    animaticJobId:null,animaticApprovedAt:null,totalFrames:p.materialization.requestedFrames,costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:300000};
  f.store.enqueue(input);const result=await processNextJob(f.store,f.studio.paths.artifactRoot,f.context);
  if(result?.status!=="done")throw new Error("The independent fresh checkpoint fixture did not complete.");fresh=result;
  const ordinal=1,slot=p.materialization.slots[ordinal]!,record=f.job.currentFilmCheckpoint!.rows[ordinal]!.record;
  const choice:CurrentFilmReuseChoice={ordinal,inputRevision:slot.inputRevision,originId:f.receipt.revision,
    source:{receiptRevision:f.receipt.revision,ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:record.revision}};
  const plan=compileCurrentFilmMixedJob(p,{origins:[bindOriginalEditSource(f.receipt)],choices:[choice]});
  context={id:fresh.id,projectId:fresh.projectId,startedAt:fresh.startedAt,currentFilm:plan,checkpointShots:0,checkpointFrame:0,
    routeDecisions:fresh.currentFilmCheckpoint!.rows[0]!.capture.routes};
  rows=[{kind:"generated",...fresh.currentFilmCheckpoint!.rows[0]!},{kind:"reused",ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,
    inputRevision:slot.inputRevision,adoption:compileCurrentFilmAdoption(plan,fresh.id,ordinal)}];
},180000);
afterAll(async()=>{await f?.close();});
const frames=(values:CurrentFilmMixedCheckpointRow[])=>values.reduce((sum,row)=>sum+currentFilmMixedRowFrames(row),0);
function reseal(value:CurrentFilmMixedCheckpoint):CurrentFilmMixedCheckpoint {const {revision:_revision,...body}=value;return {...body,revision:hash(body)};}

test("mixed checkpoint advances authentic generated and explicitly adopted rows without rewriting original execution",()=>{
  const before=hash({receipt:f.receipt,source:f.job,target:fresh}),first=createCurrentFilmMixedCheckpoint(context,rows.slice(0,1));
  expect(advanceCurrentFilmMixedCheckpoint(context,first,1,frames(first.rows))).toEqual(first);
  const held={...context,currentFilmCheckpoint:first,checkpointShots:1,checkpointFrame:frames(first.rows)},next=createCurrentFilmMixedCheckpoint(held,rows);
  expect(advanceCurrentFilmMixedCheckpoint(held,next,2,frames(rows))).toEqual(next);
  expect(next.schema).toBe("hv-current-film-checkpoint/3");expect(next.rows[1]!.kind).toBe("reused");
  expect(Object.hasOwn(next.rows[1]!,"record")).toBe(false);expect(Object.hasOwn(next.rows[1]!,"capture")).toBe(false);
  expect(hash({receipt:f.receipt,source:f.job,target:fresh})).toBe(before);
  expect(context.routeDecisions).toEqual(fresh.currentFilmCheckpoint!.rows[0]!.capture.routes);
},90000);

test("mixed checkpoint refuses fallback to generation, swapped original records and resealed target changes",()=>{
  const wrongKind:CurrentFilmMixedCheckpointRow={kind:"generated",...fresh.currentFilmCheckpoint!.rows[1]!};
  expect(()=>createCurrentFilmMixedCheckpoint(context,[rows[0]!,wrongKind])).toThrow("silently");
  expect(()=>createCurrentFilmMixedCheckpoint(context,[{kind:"generated",...f.job.currentFilmCheckpoint!.rows[0]!}])).toThrow();
  const checkpoint=createCurrentFilmMixedCheckpoint(context,rows);
  for(const mutate of [
    (value:CurrentFilmMixedCheckpoint)=>{value.rows.reverse();},
    (value:CurrentFilmMixedCheckpoint)=>{value.jobId="different-owner";},
    (value:CurrentFilmMixedCheckpoint)=>{value.rows[1]!.inputRevision="f".repeat(64);},
    (value:CurrentFilmMixedCheckpoint)=>{const row=value.rows[1]!;if(row.kind==="reused")row.adoption.frames++;},
    (value:CurrentFilmMixedCheckpoint)=>{Object.assign(value.rows[1]!,{record:f.job.currentFilmCheckpoint!.rows[1]!.record});},
  ]){const changed=structuredClone(checkpoint);mutate(changed);expect(()=>validateCurrentFilmMixedCheckpoint(context,reseal(changed))).toThrow();}
},90000);

test("mixed checkpoint requires held fresh journal custody and exact durable progress",()=>{
  const first=createCurrentFilmMixedCheckpoint(context,rows.slice(0,1)),next=createCurrentFilmMixedCheckpoint(context,rows);
  expect(()=>advanceCurrentFilmMixedCheckpoint({...context,routeDecisions:[]},next,2,frames(rows))).toThrow("held durable journal");
  expect(()=>advanceCurrentFilmMixedCheckpoint({...context,routeDecisions:[...context.routeDecisions!,...context.routeDecisions!]},next,2,frames(rows))).toThrow("duplicate");
  expect(()=>advanceCurrentFilmMixedCheckpoint({...context,routeDecisions:[...context.routeDecisions!,...f.job.currentFilmCheckpoint!.rows[1]!.capture.routes]},next,2,frames(rows))).toThrow("Original source routes");
  expect(()=>advanceCurrentFilmMixedCheckpoint(context,next,2,frames(rows)+1)).toThrow("measured prefix");
  expect(()=>advanceCurrentFilmMixedCheckpoint({...context,checkpointShots:1,checkpointFrame:frames(first.rows)},next,2,frames(rows))).toThrow("missing historical custody");
  const held={...context,currentFilmCheckpoint:next,checkpointShots:2,checkpointFrame:frames(rows)};
  expect(()=>advanceCurrentFilmMixedCheckpoint(held,first,1,frames(first.rows))).toThrow("truncate");
  expect(()=>advanceCurrentFilmMixedCheckpoint({...held,checkpointFrame:frames(rows)-1},next,2,frames(rows))).toThrow("immutable");
  const journal=structuredClone(context.routeDecisions!);journal[0]!.seed++;
  expect(()=>advanceCurrentFilmMixedCheckpoint({...context,routeDecisions:journal},next,2,frames(rows))).toThrow("held durable journal");
},90000);

test("mixed checkpoint clones callers and refuses hostile descriptors and original owners",()=>{
  expect(()=>createCurrentFilmMixedCheckpoint({...context,id:f.job.id},[])).toThrow("independent");
  expect(()=>createCurrentFilmMixedCheckpoint({...context,startedAt:null},rows)).toThrow("canonical");
  expect(()=>createCurrentFilmMixedCheckpoint({...context,startedAt:"2000-01-01T00:00:00.000Z"},rows)).toThrow("precede");
  const checkpoint=createCurrentFilmMixedCheckpoint(context,rows),copy=validateCurrentFilmMixedCheckpoint(context,checkpoint);
  copy.rows.reverse();expect(validateCurrentFilmMixedCheckpoint(context,checkpoint)).toEqual(checkpoint);
  let reads=0;const hostile=structuredClone(checkpoint);Object.defineProperty(hostile,"rows",{enumerable:true,get(){reads++;return rows;}});
  expect(()=>validateCurrentFilmMixedCheckpoint(context,hostile)).toThrow("portable");expect(reads).toBe(0);
},90000);

test("mixed checkpoint rejects a resealed silent clip whose positive duration rounds to zero frames",()=>{
  const row=structuredClone(rows[0]!);if(row.kind!=="generated"||row.record.clip.speech)throw new Error("Use the actual silent generated slot.");
  const {schema:_schema,revision:_revision,...body}=row.record;
  row.record=renderRecord({...body,clip:{...body.clip,durationSec:1e-12}});
  row.capture=createShotExecutionCapture(row.record,{observation:row.capture.observation,ranking:row.capture.ranking,routes:row.capture.routes});
  expect(()=>createCurrentFilmMixedCheckpoint(context,[row])).toThrow("positive 30 fps");
},90000);
