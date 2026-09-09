import {afterAll,beforeAll,expect,test} from "bun:test";
import type {SQL} from "bun";
import type {PersistedProject} from "../../api/src/index";
import type {Job} from "../../queue/src/index";
import {contentHash as hash} from "../../generator/src/capabilities";
import {createProviderPlan} from "../../generator/src/catalog";
import {currentFilmSourceFixture} from "../../planner/test/current-film-source.fixture";
import {compileCurrentFilmMixedJob,type CurrentFilmJobV3} from "../../planner/src/current-film-mixed-jobs";
import {compileCurrentFilmJob} from "../../planner/src/current-film-jobs";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {validateEditSourceReceipt} from "../../planner/src/edit-sources";
import {compileCurrentFilmOrigins} from "../../planner/src/current-film-origins";
import {createCurrentFilmPreviewReview} from "../../planner/src/current-film-job-context";
import {createCurrentFilmMixedCheckpoint} from "../../planner/src/current-film-mixed-context";
import {createCurrentFilmMixedAssemblyClock} from "../../planner/src/current-film-mixed-clock";
import {createCurrentFilmMixedOutput,createCurrentFilmMixedPreviewReview,type CurrentFilmMixedJob,type CurrentFilmMixedJobInput,type CurrentFilmMixedApproval} from "../../planner/src/current-film-mixed-job-context";
import {currentCasting,castingSnapshot} from "../../planner/src/casting";
import {assertCurrentFilmMixedTransaction,assertCurrentFilmMixedLockedTransaction} from "../src/current-film-mixed-context";
import {StudioDatabase} from "../src/database";
import {SQLResultFixture} from "./sql-result.fixture";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,plan:CurrentFilmJobV3,input:CurrentFilmMixedJobInput,started:CurrentFilmMixedJob;
const enabled=Boolean(process.env.HV_PG_ADMIN_URL&&process.env.HV_WORKER_DATABASE_URL);
function request(p:CurrentFilmJobV3,id:string=crypto.randomUUID()):CurrentFilmMixedJobInput {
  return {id,projectId:p.projectId,idempotencyKey:id,currentFilm:p,tier:p.render.tier,stage:p.render.stage,scriptVersion:p.materialization.script.version,
    scriptText:p.materialization.script.text,casting:p.target.state.casting.candidate!,providerPlan:p.render.providerPlan,rightsAttestedAt:f.project.rightsAttestedAt,
    animaticJobId:null,animaticApprovedAt:null,totalFrames:p.materialization.requestedFrames,costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:1,backoffMs:0},timeoutMs:300000};
}
function running(value:CurrentFilmMixedJobInput):CurrentFilmMixedJob {
  const {currentFilm:_plan,currentFilmCheckpoint:_checkpoint,output:_output,...base}=f.job;
  return {...base,...value,status:"running",startedAt:new Date().toISOString(),completedAt:null,linkExpiresAt:null,checkpointShots:0,checkpointFrame:0,routeDecisions:[]};
}
function prepared(value=started):CurrentFilmMixedJob {return {...structuredClone(value),currentFilmOrigins:compileCurrentFilmOrigins(value.currentFilm,value.id)};}
type IndexRow={key:string;sha256:string;bytes:number|string};
function inventory(value:CurrentFilmMixedJob):IndexRow[] {return value.currentFilmOrigins!.origins.flatMap(origin=>origin.copies.map(copy=>({key:copy.owned.path,sha256:copy.owned.sha256,bytes:copy.owned.bytes})));}
function transaction(saved:CurrentFilmMixedJob|undefined,carriers:(Job|CurrentFilmMixedJob)[]=[],index:IndexRow[]=[]) {
  const calls:{sql:string;values:unknown[]}[]=[],jobs=new Map(carriers.map(job=>[job.id,job]));if(saved)jobs.set(saved.id,saved);
  // Query-boundary fixture only: source/preview metadata comes from real local
  // media, but this in-memory SQL double cannot demonstrate database lock custody.
  const tx=(async(parts:TemplateStringsArray,...values:unknown[])=>{
    const sql=parts.join("?");calls.push({sql,values});
    if(sql.includes("from hv_artifacts"))return new SQLResultFixture(structuredClone(index));
    if(sql.includes("from hv_jobs")){const job=jobs.get(String(values[1]));return new SQLResultFixture(job?[{body:structuredClone(job)}]:[]);}
    throw new Error("Unexpected transaction fixture query");
  }) as unknown as SQL;
  return {tx,calls,jobs};
}
beforeAll(async()=>{
  f=await currentFilmSourceFixture();const ordinal=1,slot=f.plan.materialization.slots[ordinal]!,record=f.job.currentFilmCheckpoint!.rows[ordinal]!.record;
  plan=compileCurrentFilmMixedJob(f.plan,{origins:[bindOriginalEditSource(f.receipt)],choices:[{ordinal,inputRevision:slot.inputRevision,originId:f.receipt.revision,
    source:{receiptRevision:f.receipt.revision,ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:record.revision}}]});
  input=request(plan);started=running(input);
},180000);
afterAll(async()=>{await f?.close();});

test("admission and unprepared execution lock the actual carrier; caller preparation never substitutes for it",async()=>{
  const before=hash({input,started,project:f.project,source:f.job}),live=transaction(undefined,[f.job]);
  await assertCurrentFilmMixedTransaction(live.tx,input,f.project);
  expect(live.calls.map(call=>call.values)).toEqual([[input.projectId,input.id],[input.projectId,f.job.id]]);
  expect(live.calls.every(call=>call.sql.endsWith("for share"))).toBe(true);
  const held=transaction(started,[f.job]);await assertCurrentFilmMixedTransaction(held.tx,started,f.project);
  const forged=transaction(started);await expect(assertCurrentFilmMixedTransaction(forged.tx,prepared(),f.project)).rejects.toThrow(/carrier|source/);
  expect(forged.calls.some(call=>call.sql.includes("hv_artifacts"))).toBe(false);
  await expect(assertCurrentFilmMixedTransaction(transaction(undefined).tx,started,f.project)).rejects.toThrow("admitted mixed");
  await expect(assertCurrentFilmMixedTransaction(transaction(undefined,[f.job]).tx,{...input,currentFilmOrigins:prepared().currentFilmOrigins} as unknown as CurrentFilmMixedJobInput,f.project)).rejects.toThrow();
  for(const source of [{...f.job,linkExpiresAt:new Date(Date.now()-1).toISOString()},{...f.job,projectId:"foreign-project"},{...f.job,status:"cancelled" as const}])
    await expect(assertCurrentFilmMixedTransaction(transaction(started,[source]).tx,started,f.project)).rejects.toThrow();
  expect(hash({input,started,project:f.project,source:f.job})).toBe(before);
},90000);

test("only complete saved indexed preparation survives absent old carriers and an origins-only restarted caller",async()=>{
  const saved=prepared(),index=inventory(saved),held=transaction(saved,[],index.map(row=>({...row,bytes:String(row.bytes)}))),before=hash(saved);
  // The claimed process predates preparation. Saved state, not caller progress,
  // determines custody; no clip prefix or original carrier exists in this fixture.
  await assertCurrentFilmMixedTransaction(held.tx,started,f.project);
  expect(held.calls).toHaveLength(2);expect(held.calls[1]!.sql).toContain("order by key limit 100001 for share");
  expect(held.calls[1]!.values).toEqual([saved.projectId,saved.id]);expect(saved.checkpointShots).toBe(0);expect(saved.checkpointFrame).toBe(0);expect(saved.startedAt).toBe(started.startedAt);
  await assertCurrentFilmMixedTransaction(transaction(saved,[],index).tx,JSON.parse(JSON.stringify(saved)),f.project);
  const expired=Date.parse(f.job.linkExpiresAt!)+1;expect(expired).toBeLessThan(Date.parse(f.project.deleteAfter));
  await expect(assertCurrentFilmMixedTransaction(transaction(started,[f.job]).tx,started,f.project,expired)).rejects.toThrow(/source|carrier|expired/);
  await assertCurrentFilmMixedTransaction(transaction(saved,[],index).tx,started,f.project,expired);
  expect(hash(saved)).toBe(before);
},90000);

test("internal locked-row checks use saved preparation without re-reading target or trusting claimed progress",async()=>{
  const saved=prepared(),all=inventory(saved),db=transaction(saved,[],all),before=structuredClone(saved);
  // The artifact adapter owns the target FOR UPDATE/lease check. This isolated
  // fixture qualifies the subsequent helper, not actual PostgreSQL locking.
  const held=await assertCurrentFilmMixedLockedTransaction(db.tx,saved,started,f.project);
  expect(held).toEqual(saved);expect(db.calls).toHaveLength(1);expect(db.calls[0]!.sql).toContain("hv_artifacts");expect(db.calls[0]!.sql).toContain("order by key limit 100001 for share");
  held.currentFilmOrigins!.origins[0]!.copies[0]!.owned.sha256="f".repeat(64);expect(saved).toEqual(before);
  const unprepared=transaction(started);
  await expect(assertCurrentFilmMixedLockedTransaction(unprepared.tx,started,saved,f.project)).rejects.toThrow(/carrier|source/);
  expect(unprepared.calls.some(call=>call.sql.includes("hv_artifacts"))).toBe(false);
  expect(unprepared.calls.map(call=>call.values[1])).toEqual([f.job.id]);
  const vanished=transaction(undefined);
  await expect(assertCurrentFilmMixedLockedTransaction(vanished.tx,{...saved,currentFilm:undefined} as unknown as Job,started,f.project)).rejects.toThrow();expect(vanished.calls).toEqual([]);
},90000);

test("locked-row input comparison and complete current index remain mandatory for concurrent callers",async()=>{
  const saved=prepared(),all=inventory(saved),db=transaction(saved,[],all);
  const results=await Promise.allSettled([
    assertCurrentFilmMixedLockedTransaction(db.tx,saved,started,f.project),
    assertCurrentFilmMixedLockedTransaction(db.tx,saved,{...started,timeoutMs:started.timeoutMs+1},f.project),
  ]);
  expect(results.map(result=>result.status)).toEqual(["fulfilled","rejected"]);expect(db.calls).toHaveLength(1);
  for(const changed of [all.slice(1),all.map((row,index)=>index?row:{...row,sha256:"a".repeat(64)}),[...all,{...all[0]!,key:`${saved.projectId}/${saved.id}/originals/unowned.wav`}]]){
    const index=transaction(saved,[],changed);await expect(assertCurrentFilmMixedLockedTransaction(index.tx,saved,started,f.project)).rejects.toThrow(/index|artifact|original/);expect(index.calls).toHaveLength(1);
  }
  for(const project of [undefined,{...f.project,rightsAttestedAt:null},f.accept()]){
    const current=transaction(saved,[],all);await expect(assertCurrentFilmMixedLockedTransaction(current.tx,saved,started,project)).rejects.toThrow();expect(current.calls).toEqual([]);
  }
  let reads=0;const hostile=structuredClone(saved);Object.defineProperty(hostile,"currentFilmOrigins",{enumerable:true,get(){reads++;return saved.currentFilmOrigins;}});
  const refused=transaction(saved,[],all);await expect(assertCurrentFilmMixedLockedTransaction(refused.tx,hostile,started,f.project)).rejects.toThrow();expect(reads).toBe(0);expect(refused.calls).toEqual([]);
},90000);

test("locked V3 dispatch validates both complete modes before custody and cannot skip sibling guards",async()=>{
  const saved=prepared(),all=inventory(saved);
  for(const field of ["livingScript","pictureEdit","assemblyEdit","soundMix","audioTake","executionCheckpoints"]){
    for(const changed of ["saved","claimed"]){
      const current=structuredClone(saved),claim=structuredClone(started);
      Object.defineProperty(changed==="saved"?current:claim,field,{enumerable:true,value:{}});
      const db=transaction(saved,[],all);
      await expect(assertCurrentFilmMixedLockedTransaction(db.tx,current,claim,f.project)).rejects.toThrow("another job mode");expect(db.calls).toEqual([]);
    }
  }
  for(const [current,claim]of [[f.job,started],[saved,f.job]]){
    const db=transaction(saved,[],all);
    await expect(assertCurrentFilmMixedLockedTransaction(db.tx,current!,claim!,f.project)).rejects.toThrow("version changed");expect(db.calls).toEqual([]);
  }
  let reads=0;
  for(const hidden of [false,true]){
    const current=structuredClone(saved);
    Object.defineProperty(current,"currentFilm",hidden?{enumerable:false,value:current.currentFilm}:{enumerable:true,get(){reads++;return saved.currentFilm;}});
    const db=transaction(saved,[],all);await expect(assertCurrentFilmMixedLockedTransaction(db.tx,current,started,f.project)).rejects.toThrow();expect(reads).toBe(0);expect(db.calls).toEqual([]);
  }
},90000);

test("checked saved row is detached before awaited index reads and a later changed saved body is refused",async()=>{
  const saved=prepared(),original=structuredClone(saved),all=inventory(saved);let changed=false;
  const tx=(async(parts:TemplateStringsArray)=>{
    if(!parts.join("").includes("hv_artifacts"))throw new Error("Unexpected locked target reread");
    saved.currentFilmOrigins!.origins[0]!.copies[0]!.owned.sha256="a".repeat(64);changed=true;return structuredClone(all);
  }) as unknown as SQL;
  const held=await assertCurrentFilmMixedLockedTransaction(tx,saved,started,f.project);
  expect(changed).toBe(true);expect(held).toEqual(original);
  const next=transaction(saved,[],all);await expect(assertCurrentFilmMixedLockedTransaction(next.tx,saved,started,f.project)).rejects.toThrow();expect(next.calls).toEqual([]);
},90000);

test("locked index refuses indexed accessors, sparse rows and over-capacity arrays without reading them",async()=>{
  const saved=prepared(),all=inventory(saved);let reads=0;
  const getter=structuredClone(all);Object.defineProperty(getter,"0",{enumerable:true,get(){reads++;return all[0];}});
  const sparse=structuredClone(all);delete sparse[0];
  const oversized:IndexRow[]=[];oversized.length=100001;Object.defineProperty(oversized,"0",{enumerable:true,get(){reads++;return all[0];}});
  for(const index of [getter,sparse,oversized]){
    const tx=(async(parts:TemplateStringsArray)=>{if(!parts.join("").includes("hv_artifacts"))throw new Error("Unexpected carrier fallback");return index;}) as unknown as SQL;
    await expect(assertCurrentFilmMixedLockedTransaction(tx,saved,started,f.project)).rejects.toThrow("bounded complete");expect(reads).toBe(0);
  }
  const portable=structuredClone(all);Object.defineProperty(portable,"command",{get(){reads++;throw new Error("Driver metadata must not run");}});
  const tx=(async()=>portable) as unknown as SQL;await assertCurrentFilmMixedLockedTransaction(tx,saved,started,f.project);expect(reads).toBe(0);
},90000);

test("locked final checks preserve latest withdrawal, current expiry and approval-before-original-execution",async()=>{
  const p=compileCurrentFilmMixedJob(compileCurrentFilmJob(f.saved.library,f.plan.selector,{role:"render",tier:"free",providerPlan:createProviderPlan("final",5,undefined,{...process.env,HV_PROVIDER_POOL:'["mock"]'})}),{origins:[],choices:[]});
  const clock=Date.now(),at=new Date(clock+5).toISOString(),cast=p.target.state.casting.candidate!,direction=p.library.origin!.request.baseline.direction;
  const approved:CurrentFilmMixedApproval={animaticJobId:f.job.id,scriptVersion:p.materialization.script.version,decision:"approved",note:"Exact actual preview",at,
    castingVersion:cast.version,castingRevision:cast.revision,directionVersion:direction.version,directionRevision:direction.revision,currentFilmReview:createCurrentFilmPreviewReview(f.job)};
  const project={...f.project,animaticApprovals:[approved]},base=running({...request(p),animaticJobId:f.job.id,animaticApprovedAt:at}),saved=prepared({...base,startedAt:new Date(clock+10).toISOString()});
  const valid=transaction(saved,[f.job],[]);expect(await assertCurrentFilmMixedLockedTransaction(valid.tx,saved,base,project,clock+20)).toEqual(saved);
  expect(valid.calls.map(call=>call.values[1])).toEqual([saved.id,f.job.id]);expect(valid.calls[0]!.sql).toContain("hv_artifacts");expect(valid.calls[1]!.sql).toContain("for share");
  const late={...saved,startedAt:new Date(clock).toISOString()};
  await expect(assertCurrentFilmMixedLockedTransaction(transaction(late,[f.job],[]).tx,late,base,project,clock+20)).rejects.toThrow("late, expired");
  const withdrawn={...project,animaticApprovals:[approved,{...approved,decision:"changes_requested" as const}]};
  await expect(assertCurrentFilmMixedLockedTransaction(transaction(saved,[f.job],[]).tx,saved,base,withdrawn,clock+20)).rejects.toThrow("decision");
  await expect(assertCurrentFilmMixedLockedTransaction(transaction(saved,[f.job],[]).tx,saved,base,project,Date.parse(f.job.linkExpiresAt!)+1)).rejects.toThrow("expired");
},90000);

test("indexed preparation refuses missing unselected originals, corrupt metadata and unexpected paths without carrier fallback",async()=>{
  const saved=prepared(),all=inventory(saved),unselected=f.job.currentFilmCheckpoint!.rows[2]!.record.files.video;
  const omitted=all.filter(row=>!row.key.endsWith("/"+unselected.path));expect(omitted.length).toBe(all.length-1);
  for(const rows of [omitted,all.slice(1),all.map((row,i)=>i?row:{...row,bytes:Number(row.bytes)+1}),all.map((row,i)=>i?row:{...row,sha256:"a".repeat(64)}),
    [...all,{...all[0]!,key:`${saved.projectId}/${saved.id}/originals/unreviewed.wav`}],[...all,all[0]!],all.map((row,i)=>i?row:{...row,bytes:"NaN"})]){
    const held=transaction(saved,[f.job],rows);await expect(assertCurrentFilmMixedTransaction(held.tx,started,f.project)).rejects.toThrow(/index|artifact|original/);
    expect(held.calls).toHaveLength(2);
  }
  const changed=structuredClone(saved);changed.currentFilmOrigins!.origins[0]!.copies.pop();
  const {revision:_revision,...body}=changed.currentFilmOrigins!;changed.currentFilmOrigins!.revision=hash(body);
  await expect(assertCurrentFilmMixedTransaction(transaction(changed,[],all).tx,started,f.project)).rejects.toThrow();
},90000);

test("current rights, saved target, source grants and immutable inputs remain mandatory after preparation",async()=>{
  const saved=prepared(),all=inventory(saved),revoked=structuredClone(f.project),cast=currentCasting(revoked.id,revoked.castingHistory),characters=structuredClone(cast.characters);
  characters[0]!.permission.status="revoked";revoked.castingHistory!.push(castingSnapshot(revoked.id,cast.version+1,characters,Date.now()));
  for(const project of [undefined,{...f.project,rightsAttestedAt:null},{...f.project,deleteAfter:new Date().toISOString()},revoked,f.accept()])
    await expect(assertCurrentFilmMixedTransaction(transaction(saved,[],all).tx,started,project)).rejects.toThrow();
  await expect(assertCurrentFilmMixedTransaction(transaction(saved,[],all).tx,{...started,timeoutMs:started.timeoutMs+1},f.project)).rejects.toThrow("admitted");
  await expect(assertCurrentFilmMixedTransaction(transaction(saved,[],all).tx,{...input,timeoutMs:input.timeoutMs+1},f.project)).rejects.toThrow("different admitted");
},90000);

test("general indexed delivery metadata permits the final-film ceiling without widening original copy roles",async()=>{
  const saved=prepared(),all=inventory(saved),delivery={key:`${saved.projectId}/${saved.id}/export.mp4`,sha256:"c".repeat(64),bytes:String(128*1024**3)};
  // Index classification only: this does not claim a real large MP4 or authorize
  // its output; publication separately binds exact clock/path/actual bytes.
  await assertCurrentFilmMixedTransaction(transaction(saved,[],[...all,delivery]).tx,started,f.project);
  await expect(assertCurrentFilmMixedTransaction(transaction(saved,[],[...all,{...delivery,bytes:String(128*1024**3+1)}]).tx,started,f.project)).rejects.toThrow("bounded indexed");
  await expect(assertCurrentFilmMixedTransaction(transaction(saved,[],all.map((row,index)=>index?row:{...row,bytes:9*1024**3})).tx,started,f.project)).rejects.toThrow("complete artifact index");
},90000);

test("two validated origin receipts sharing a carrier acquire that carrier once; all-fresh V3 has an explicit empty preparation",async()=>{
  const second=structuredClone(f.receipt);second.facts.label="Second labelled inspection of the same original";
  const {revision:_revision,...body}=second,receipt=validateEditSourceReceipt({...body,revision:hash(body)});
  const origins=[bindOriginalEditSource(f.receipt),bindOriginalEditSource(receipt)];
  const choices=origins.map((binding,ordinal)=>{const slot=f.plan.materialization.slots[ordinal]!,record=f.job.currentFilmCheckpoint!.rows[ordinal]!.record;
    return {ordinal,inputRevision:slot.inputRevision,originId:binding.source.revision,source:{receiptRevision:binding.source.revision,ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:record.revision}};});
  const duplicate=request(compileCurrentFilmMixedJob(f.plan,{origins,choices})),held=transaction(undefined,[f.job]);
  await assertCurrentFilmMixedTransaction(held.tx,duplicate,f.project);expect(held.calls.map(call=>call.values[1])).toEqual([duplicate.id,f.job.id]);
  const fresh=running(request(compileCurrentFilmMixedJob(f.plan,{origins:[],choices:[]}))),empty=prepared(fresh),tx=transaction(empty,[],[]);
  await assertCurrentFilmMixedTransaction(tx.tx,fresh,f.project);expect(empty.currentFilmOrigins!.origins).toEqual([]);expect(tx.calls).toHaveLength(2);
},90000);

test("exact completed V2 and V3 preview decisions work; stale, ordinary and changed latest decisions refuse",async()=>{
  const p=compileCurrentFilmMixedJob(compileCurrentFilmJob(f.saved.library,f.plan.selector,{role:"render",tier:"free",providerPlan:createProviderPlan("final",5,undefined,{...process.env,HV_PROVIDER_POOL:'["mock"]'})}),{origins:[],choices:[]});
  const at=new Date().toISOString(),final={...request(p),animaticJobId:f.job.id,animaticApprovedAt:at},cast=p.target.state.casting.candidate!,direction=p.library.origin!.request.baseline.direction;
  const decision:CurrentFilmMixedApproval={animaticJobId:f.job.id,scriptVersion:final.scriptVersion,decision:"approved",note:"Actual completed preview",at,
    castingVersion:cast.version,castingRevision:cast.revision,directionVersion:direction.version,directionRevision:direction.revision,currentFilmReview:createCurrentFilmPreviewReview(f.job)};
  const project={...f.project,animaticApprovals:[decision]} as PersistedProject;
  await assertCurrentFilmMixedTransaction(transaction(undefined,[f.job]).tx,final,project);
  for(const changed of [{...decision,decision:"changes_requested" as const},{...decision,currentFilmReview:{...decision.currentFilmReview!,outputRevision:"a".repeat(64)}},{...decision,currentFilmReview:undefined}])
    await expect(assertCurrentFilmMixedTransaction(transaction(undefined,[f.job]).tx,final,{...project,animaticApprovals:[decision,changed]} as PersistedProject)).rejects.toThrow();
  await expect(assertCurrentFilmMixedTransaction(transaction(undefined,[{...f.studio.film,id:f.job.id}]).tx,final,project)).rejects.toThrow();
  await expect(assertCurrentFilmMixedTransaction(transaction(undefined,[f.job]).tx,{...final,animaticApprovedAt:new Date(Date.parse(at)-1).toISOString()},project)).rejects.toThrow();
  // Format-only V3 preview envelope around real measured V2 facts. This tests
  // explicit approval dispatch, not a claim that the V3 worker has rendered it.
  const fresh=compileCurrentFilmMixedJob(f.plan,{origins:[],choices:[]}),base=running(request(fresh,f.job.id));base.startedAt=f.job.startedAt;base.routeDecisions=f.job.routeDecisions;base.currentFilmOrigins=compileCurrentFilmOrigins(fresh,base.id);
  const rows=f.job.currentFilmCheckpoint!.rows.map(row=>({kind:"generated" as const,...row})),preview:CurrentFilmMixedJob={...base,currentFilmCheckpoint:createCurrentFilmMixedCheckpoint(base,rows),checkpointShots:rows.length,checkpointFrame:f.job.checkpointFrame};
  const old=f.job.output!.currentFilm!.assembly,clock=createCurrentFilmMixedAssemblyClock(preview,preview.currentFilmCheckpoint!,{sourceFrames:old.spans.map(span=>span.frames),effectiveOverlapFrames:old.effectiveOverlapFrames,reason:old.reason,probe:old.probe,video:old.video,captions:{vtt:old.captions.vtt,srt:old.captions.srt}});
  const {mp4Path,hlsPlaylistPath,captionsPath,manifestPath}=f.job.output!;preview.output={mp4Path,hlsPlaylistPath,captionsPath,manifestPath,currentFilm:createCurrentFilmMixedOutput(preview,clock)};preview.status="done";preview.completedAt=f.job.completedAt;preview.linkExpiresAt=f.job.linkExpiresAt;
  await assertCurrentFilmMixedTransaction(transaction(undefined,[preview]).tx,final,{...project,animaticApprovals:[{...decision,currentFilmReview:createCurrentFilmMixedPreviewReview(preview)}]} as PersistedProject);
},90000);

test("input and saved/index accessors are rejected before reads or carrier fallback",async()=>{
  let reads=0;const getter={...input};Object.defineProperty(getter,"currentFilm",{enumerable:true,get(){reads++;return plan;}});
  const tx=transaction(undefined,[f.job]);await expect(assertCurrentFilmMixedTransaction(tx.tx,getter,f.project)).rejects.toThrow();expect(reads).toBe(0);expect(tx.calls).toEqual([]);
  const badSaved=prepared();Object.defineProperty(badSaved,"currentFilmOrigins",{enumerable:true,get(){reads++;return prepared().currentFilmOrigins;}});
  const badTarget=(async()=>[{body:badSaved}]) as unknown as SQL;
  await expect(assertCurrentFilmMixedTransaction(badTarget,started,f.project)).rejects.toThrow();expect(reads).toBe(0);
  const saved=prepared(),rows=inventory(saved);Object.defineProperty(rows[0]! ,"sha256",{enumerable:true,get(){reads++;return "a".repeat(64);}});
  const raw=(async(parts:TemplateStringsArray)=>parts.join("").includes("hv_artifacts")?rows:[{body:saved}]) as unknown as SQL;
  await expect(assertCurrentFilmMixedTransaction(raw,started,f.project)).rejects.toThrow("bounded complete");expect(reads).toBe(0);
},90000);

function dbName(value:string):string {if(!/^hv_mixed_context_[a-f0-9]{32}$/.test(value))throw new Error("Unsafe mixed context fixture database");return value;}
function dbUrl(value:string,name:string):string {const url=new URL(value);url.pathname="/"+dbName(name);return url.href;}
(enabled?test:test.skip)("actual PostgreSQL held index survives vanished carriers and locks preparation against concurrent mutation",async()=>{
  // Index-only fixture deliberately does not upload S3 objects or claim byte
  // custody. Whole-media publication/independent restore has a separate gate.
  const name=dbName("hv_mixed_context_"+crypto.randomUUID().replaceAll("-","")),control=new StudioDatabase(process.env.HV_PG_ADMIN_URL!);let admin:StudioDatabase|undefined,worker:StudioDatabase|undefined,created=false;
  try{
    await control.sql.unsafe('CREATE DATABASE "'+name+'"');created=true;admin=new StudioDatabase(dbUrl(process.env.HV_PG_ADMIN_URL!,name));await admin.migrate();worker=new StudioDatabase(dbUrl(process.env.HV_WORKER_DATABASE_URL!,name));
    const projectId=f.project.id,saved=prepared(),all=inventory(saved);
    await admin.sql`insert into hv_projects(id,body,delete_after) values(${projectId},${f.project}::jsonb,${f.project.deleteAfter})`;
    const put=async(value:Job|CurrentFilmMixedJob)=>{await admin!.sql`insert into hv_jobs(id,project_id,idempotency_key,stage,status,tier,body) values(${value.id},${projectId},${value.idempotencyKey},${value.stage},${value.status},${value.tier},${value}::jsonb) on conflict(id) do update set body=excluded.body,status=excluded.status`;};
    await put(started);await put(f.job);
    const check=async(claim:CurrentFilmMixedJob|CurrentFilmMixedJobInput=started)=>worker!.forProject(projectId,async tx=>{
      const project=(await tx`select body from hv_projects where id=${projectId} for share`)[0]!.body as PersistedProject;
      await tx`select body from hv_jobs where project_id=${projectId} and id=${started.id} for update`;
      await assertCurrentFilmMixedTransaction(tx,claim,project);
    });
    await check();await admin.sql`delete from hv_jobs where id=${f.job.id}`;
    await expect(check(saved)).rejects.toThrow();await put(saved);await expect(check()).rejects.toThrow("artifact index");
    for(const row of all)await admin.sql`insert into hv_artifacts(key,project_id,job_id,sha256,bytes,content_type,backend,object_key) values(${row.key},${projectId},${saved.id},${row.sha256},${row.bytes},'application/octet-stream','s3',${'index-only/'+row.sha256})`;
    await check(JSON.parse(JSON.stringify(saved)));expect((await admin.sql`select body from hv_jobs where id=${saved.id}`)[0]!.body.startedAt).toBe(saved.startedAt);
    await admin.sql`update hv_artifacts set bytes=bytes+1 where key=${all.at(-1)!.key}`;await expect(check()).rejects.toThrow("artifact index");await admin.sql`update hv_artifacts set bytes=bytes-1 where key=${all.at(-1)!.key}`;
    await admin.sql`update hv_projects set body=${{...f.project,rightsAttestedAt:null}}::jsonb where id=${projectId}`;await expect(check()).rejects.toThrow(/rights/);await admin.sql`update hv_projects set body=${f.project}::jsonb where id=${projectId}`;
    await worker.forProject(projectId,async tx=>{
      const project=(await tx`select body from hv_projects where id=${projectId} for share`)[0]!.body as PersistedProject;await tx`select body from hv_jobs where id=${saved.id} for update`;
      await assertCurrentFilmMixedTransaction(tx,started,project);
      await expect(admin!.sql.begin(async other=>{await other`set local lock_timeout='150ms'`;await other`delete from hv_artifacts where key=${all[0]!.key}`;})).rejects.toThrow();
    });
    await admin.sql`delete from hv_artifacts where key=${all[0]!.key}`;await expect(check()).rejects.toThrow("artifact index");
  }finally{await worker?.close();await admin?.close();if(created)await control.sql.unsafe('DROP DATABASE "'+dbName(name)+'" WITH (FORCE)');await control.close();}
},180000);
