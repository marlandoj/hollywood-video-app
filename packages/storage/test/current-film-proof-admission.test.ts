import {afterAll,beforeAll,expect,test} from "bun:test";
import type {SQL} from "bun";
import {createHash} from "node:crypto";
import {readFileSync,readdirSync} from "node:fs";
import {dirname,join,relative} from "node:path";
import type {PersistedProject} from "../../api/src/index";
import type {BudgetReservation} from "../../operator/src/index";
import {currentFilmSourceFixture} from "../../planner/test/current-film-source.fixture";
import {compileCurrentFilmMixedJob,type CurrentFilmJobV3} from "../../planner/src/current-film-mixed-jobs";
import {createCurrentFilmPreviewReview,currentFilmV2Job,type CurrentFilmV2Job} from "../../planner/src/current-film-job-context";
import {currentFilmRuntimeRecordedFiles} from "../../planner/src/current-film-runtime-context";
import {compileCurrentFilmProofTarget} from "../../planner/src/current-film-proof-target";
import {compileCurrentFilmProofCopies} from "../../planner/src/current-film-proof-copies";
import type {CurrentFilmMixedJobInput} from "../../planner/src/current-film-mixed-job-context";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {type Job,type JobInput} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {PostgresCostLedger} from "../src/ledger";
import type {StudioDatabase} from "../src/database";
import {resolveCurrentFilmProofContext} from "../src/current-film-proof-context";

type IndexRow={key:string;sha256:string;bytes:number};
type State={project:PersistedProject;jobs:Map<string,Job>;indexes:Map<string,IndexRow[]>;reservations:Map<string,BudgetReservation>;events:unknown[];cap:number|null};
let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,final:Awaited<ReturnType<typeof f.renderFinal>>,currentPreview:CurrentFilmV2Job;
let plan:CurrentFilmJobV3,initial:State,approvedAt:string;
const persisted=<T>(value:T):T=>JSON.parse(JSON.stringify(value));

/** Executes the actual ledger/domain admission code with transactional SQL
 * transport. It does not claim PostgreSQL locks or remote object verification. */
function database(seed=initial,change?:(sql:string,values:unknown[],result:unknown)=>unknown){
  let state=structuredClone(seed);const calls:{sql:string;values:unknown[]}[]=[],writes:string[]=[];
  const db={async forProject<T>(projectId:string,fn:(tx:SQL)=>Promise<T>):Promise<T>{
    const local=structuredClone(state);
    const tx=(async(parts:TemplateStringsArray,...values:unknown[])=>{
      const sql=parts.join("?").replace(/\s+/g," ").trim();calls.push({sql,values:structuredClone(values)});let result:unknown;
      if(sql.startsWith("insert into hv_budget_accounts")){local.cap??=Number(values[0]);result=[];}
      else if(sql.startsWith("select monthly_cap_usd"))result=[{monthly_cap_usd:local.cap}];
      else if(sql.includes("from hv_projects"))result=local.project.id===projectId?[{body:local.project,taken_down_at:null}]:[];
      else if(sql.startsWith("select id,body from hv_jobs")){
        const id=sql.includes("and id=?")?String(values[1]):undefined;
        result=[...local.jobs.values()].filter(job=>job.projectId===projectId&&(id===undefined||job.id===id)).sort((a,b)=>a.id.localeCompare(b.id)).map(job=>({id:job.id,body:job}));
      }else if(sql.includes("from hv_jobs")){
        let jobs=[...local.jobs.values()].filter(job=>job.projectId===projectId);
        if(sql.includes("idempotency_key = ?"))jobs=jobs.filter(job=>job.idempotencyKey===values[1]);
        else if(sql.includes("status in ('queued', 'running')"))jobs=jobs.filter(job=>["queued","running"].includes(job.status));
        else jobs=jobs.filter(job=>job.id===String(values[sql.includes("project_id=? and id=?")?1:0]));
        result=jobs.map(body=>({body}));
      }else if(sql.includes("from hv_artifacts"))result=local.indexes.get(String(values[1]))??[];
      else if(sql.startsWith("select body from hv_reservations")){const body=local.reservations.get(String(values[0]));result=body?[{body}]:[];}
      else if(sql.includes("as spent,")&&sql.includes("as held"))result=[{spent:0,held:[...local.reservations.values()].reduce((sum,value)=>sum+value.remainingUsd,0)}];
      else if(sql.startsWith("select coalesce(sum(total_usd)"))result=[{total:0}];
      else if(sql.startsWith("insert into hv_reservations")){writes.push("reserve");const body=values[4] as BudgetReservation;local.reservations.set(body.jobId,persisted(body));result=[];}
      else if(sql.startsWith("insert into hv_jobs")){writes.push("enqueue");const body=values[6] as Job,existing=[...local.jobs.values()].find(job=>job.projectId===body.projectId&&job.idempotencyKey===body.idempotencyKey);
        if(existing)result=[];else{local.jobs.set(body.id,persisted(body));result=[{id:body.id}];}
      }else if(sql.startsWith("update hv_jobs set body")){const body=values[0] as Job;local.jobs.set(body.id,persisted(body));result=[];}
      else if(sql.startsWith("insert into hv_outbox")){local.events.push(persisted(values));result=[];}
      else throw new Error("Unexpected proof-admission SQL: "+sql);
      const transported=persisted(result);return change?change(sql,values,transported):transported;
    }) as unknown as SQL;
    const result=await fn(tx);state=local;return result;
  }} as unknown as StudioDatabase;
  return {db,ledger:new PostgresCostLedger(db),calls,writes,get state(){return state;}};
}
function digest(path:string):IndexRow {const bytes=readFileSync(join(f.studio.paths.artifactRoot,path));return {key:path,sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length};}
function previewIndex(job:Job):IndexRow[]{
  const output=job.output!,paths=new Set(currentFilmRuntimeRecordedFiles(job).map(file=>file.path));
  for(const path of [output.mp4Path,output.hlsPlaylistPath,output.captionsPath,output.captionsPath.slice(0,-4)+".srt",output.manifestPath,`${job.projectId}/${job.id}/clips/manifest.json`,
    ...(output.storyboard??[]).flatMap(row=>[row.path,...(row.sourcePath?[row.sourcePath]:[])])])paths.add(path);
  for(const name of readdirSync(join(f.studio.paths.artifactRoot,dirname(output.hlsPlaylistPath))))paths.add(relative(f.studio.paths.artifactRoot,join(f.studio.paths.artifactRoot,dirname(output.hlsPlaylistPath),name)).replaceAll("\\","/"));
  return [...paths].sort().map(digest);
}
function input(id=crypto.randomUUID(),key=id):CurrentFilmMixedJobInput {
  return {id,projectId:plan.projectId,idempotencyKey:key,currentFilm:plan,tier:plan.render.tier,stage:plan.render.stage,scriptVersion:plan.materialization.script.version,
    scriptText:plan.materialization.script.text,casting:plan.target.state.casting.candidate!,providerPlan:plan.render.providerPlan,rightsAttestedAt:initial.project.rightsAttestedAt,
    animaticJobId:currentPreview.id,animaticApprovedAt:approvedAt,totalFrames:plan.materialization.requestedFrames,costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:300000};
}
beforeAll(async()=>{
  f=await currentFilmSourceFixture();final=await f.renderFinal();const source=currentFilmV2Job(final.job),target=source.currentFilm;
  if(!target)throw new Error("The source requires an actual V2 final plan.");const slot=target.materialization.slots[0]!,record=source.currentFilmCheckpoint!.rows[0]!.record;
  plan=compileCurrentFilmMixedJob(target,{origins:[bindOriginalEditSource(final.receipt)],choices:[{ordinal:0,inputRevision:slot.inputRevision,originId:final.receipt.revision,
    source:{receiptRevision:final.receipt.revision,ordinal:0,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:record.revision}}]});
  // A separate actually rendered current preview lets missing older source-preview
  // history pass current approval checks yet fail the new historical closure gate.
  const p=f.plan,id="proof-admission-current-preview",request:JobInput={id,projectId:p.projectId,idempotencyKey:id,currentFilm:p,tier:p.render.tier,stage:p.render.stage,
    scriptVersion:p.materialization.script.version,scriptText:p.materialization.script.text,casting:p.target.state.casting.candidate!,providerPlan:p.render.providerPlan,rightsAttestedAt:f.project.rightsAttestedAt,
    animaticJobId:null,animaticApprovedAt:null,totalFrames:p.materialization.requestedFrames,costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:300000};
  f.store.enqueue(request);const completed=await processNextJob(f.store,f.studio.paths.artifactRoot,f.context);
  if(!completed||completed.status!=="done")throw new Error("Actual proof-admission current preview failed: "+(completed?.failureReason??completed?.cancelReason));currentPreview=currentFilmV2Job(completed);
  approvedAt=f.projects.recordCurrentFilmDecision(f.studio.owner.token,currentPreview,createCurrentFilmPreviewReview(currentPreview),"approved","Current target preview")!.approval.at;
  const project=f.projects.snapshot().projects[0]!,bootstrap=plan.library.origin!.request.source;
  initial={project:structuredClone(project),jobs:new Map([f.studio.film,f.job,final.job,currentPreview].map(job=>[job.id,persisted(job)])),indexes:new Map([
    [f.studio.film.id,bootstrap.files.map(file=>({key:file.path,sha256:file.sha256,bytes:file.bytes}))],
    [final.job.id,final.receipt.files.map(file=>({key:file.path,sha256:file.sha256,bytes:file.bytes}))],
    [f.job.id,previewIndex(f.job)],[currentPreview.id,previewIndex(currentPreview)],
  ]),reservations:new Map(),events:[],cap:null};
},300000);
afterAll(async()=>{await f?.close();});

test("proof resolution and copy capacity complete before reservation and enqueue without creating custody",async()=>{
  const io=database(),request=input(),before=structuredClone(io.state),target=compileCurrentFilmProofTarget(request);
  const resolution=await io.db.forProject(plan.projectId,tx=>resolveCurrentFilmProofContext(tx,plan,initial.project,target));
  const {frozenContext,carriers,previews}=resolution,copies=compileCurrentFilmProofCopies(plan,request.id,{frozenContext,carriers,previews,target:resolution.target!});
  expect(currentPreview.id).not.toBe(f.job.id);expect(resolution.closure.targetApproval?.previewJobId).toBe(currentPreview.id);expect(copies.target).toEqual(target);
  expect(copies.previews.map(row=>row.jobId).sort()).toEqual([f.job.id,currentPreview.id].sort());
  expect(copies.frozenContext.jobs.some(job=>job.id===currentPreview.id)).toBe(true);expect(copies.frozenContext.jobs.some(job=>job.id===f.job.id)).toBe(true);
  const admissionStart=io.calls.length,job=await io.ledger.admit(plan.projectId,request,500);
  expect(job.id).toBe(request.id);expect(job.status).toBe("queued");expect(job.currentFilm).toEqual(plan);expect(io.writes).toEqual(["reserve","enqueue"]);
  expect(job.currentFilmOrigins).toBeUndefined();expect(job.currentFilmCheckpoint).toBeUndefined();expect(job.output).toBeUndefined();expect(Object.keys(job).some(key=>key.toLowerCase().includes("proof"))).toBe(false);
  expect(io.state.project).toEqual(before.project);expect(io.state.indexes).toEqual(before.indexes);expect(io.state.reservations.size).toBe(1);expect(io.state.jobs.size).toBe(before.jobs.size+1);
  const lastProofIndex=io.calls.reduce((last,call,index)=>call.sql.includes("hv_artifacts")&&call.sql.endsWith("for share")?index:last,-1),reservation=io.calls.findIndex(call=>call.sql.startsWith("insert into hv_reservations")),enqueue=io.calls.findIndex(call=>call.sql.startsWith("insert into hv_jobs"));
  expect(lastProofIndex).toBeGreaterThan(-1);expect(reservation).toBeGreaterThan(lastProofIndex);expect(enqueue).toBeGreaterThan(reservation);
  for(const id of [f.job.id,currentPreview.id]){
    expect(io.calls.slice(admissionStart).filter(call=>call.sql.startsWith("select id,body")&&call.sql.endsWith("for share")&&call.values[1]===id)).toHaveLength(1);
    expect(io.calls.slice(admissionStart).filter(call=>call.sql.includes("hv_artifacts")&&call.sql.endsWith("for share")&&call.values[1]===id)).toHaveLength(1);
  }
},90000);

test("missing distinct target preview index refuses despite complete historical proof and valid current approval",async()=>{
  const seed=structuredClone(initial);seed.indexes.delete(currentPreview.id);
  const io=database(seed),before=structuredClone(io.state);await expect(io.ledger.admit(plan.projectId,input(),500)).rejects.toThrow("Retain the bounded complete historical preview index.");
  expect(seed.jobs.has(currentPreview.id)).toBe(true);expect(seed.indexes.get(f.job.id)).toEqual(initial.indexes.get(f.job.id));
  expect(io.calls.some(call=>call.sql.includes("hv_artifacts")&&call.values[1]===currentPreview.id)).toBe(true);
  expect(io.writes).toEqual([]);expect(io.state).toEqual(before);
},90000);

test("missing historical preview or its complete index refuses before any reservation or enqueue",async()=>{
  for(const change of ["preview","index"] as const){const seed=structuredClone(initial);
    if(change==="preview")seed.jobs.delete(f.job.id);else seed.indexes.set(f.job.id,seed.indexes.get(f.job.id)!.filter(file=>file.key!==f.job.output!.manifestPath));
    const io=database(seed),before=structuredClone(io.state);await expect(io.ledger.admit(plan.projectId,input(),500)).rejects.toThrow(change==="preview"?"actual saved preview":"required role");
    expect(io.writes).toEqual([]);expect(io.state).toEqual(before);expect(io.calls.some(call=>call.sql.startsWith("select id,body from hv_jobs"))).toBe(true);
  }
},90000);

test("mutated bootstrap evidence and a changed historical preview at its final lock cannot reach spend",async()=>{
  const seed=structuredClone(initial);seed.jobs.get(f.studio.film.id)!.output!.shotRenders![0]!.files.video.sha256="a".repeat(64);
  const corrupted=database(seed),before=structuredClone(corrupted.state);await expect(corrupted.ledger.admit(plan.projectId,input(),500)).rejects.toThrow();expect(corrupted.writes).toEqual([]);expect(corrupted.state).toEqual(before);
  let changed=false;const raced=database(initial,(sql,values,result)=>{
    if(sql.startsWith("select id,body from hv_jobs")&&sql.endsWith("for share")&&values[1]===f.job.id){const rows=result as {id:string;body:Job}[];rows[0]!.body.costUsd+=.01;changed=true;}return result;
  });
  await expect(raced.ledger.admit(plan.projectId,input(),500)).rejects.toThrow("retry the transaction");expect(changed).toBe(true);expect(raced.writes).toEqual([]);expect(raced.state).toEqual(initial);
},90000);

test("declared complete proof copies exceeding workspace capacity refuse before spend",async()=>{
  const seed=structuredClone(initial),prefix=f.job.output!.hlsPlaylistPath.slice(0,-"index.m3u8".length);
  // Metadata-only oversized segment declarations: this is a pre-copy capacity
  // refusal, not a claim these large objects exist or passed byte verification.
  for(let index=0;index<17;index++)seed.indexes.get(f.job.id)!.push({key:prefix+`segment-${99000+index}.ts`,sha256:"b".repeat(64),bytes:8*1024**3});
  const io=database(seed),before=structuredClone(io.state);await expect(io.ledger.admit(plan.projectId,input(),500)).rejects.toThrow("capacity");expect(io.writes).toEqual([]);expect(io.state).toEqual(before);
  expect(io.calls.some(call=>call.sql.includes("from hv_artifacts")&&call.sql.endsWith("for share"))).toBe(true);
},90000);

test("exact admitted replay keeps its original reservation without re-discovering withdrawn history",async()=>{
  const io=database(),request=input(),admitted=await io.ledger.admit(plan.projectId,request,500);io.state.jobs.delete(f.job.id);io.state.indexes.delete(f.job.id);io.state.indexes.delete(currentPreview.id);
  const before=structuredClone(io.state),callCount=io.calls.length,writeCount=io.writes.length;
  expect(await io.ledger.admit(plan.projectId,{...request,id:crypto.randomUUID()},500)).toEqual(admitted);expect(io.state).toEqual(before);expect(io.writes).toHaveLength(writeCount);
  expect(io.calls.slice(callCount).some(call=>call.sql.includes("hv_projects")||call.sql.startsWith("select id,body")||call.sql.includes("hv_artifacts"))).toBe(false);
  await expect(io.ledger.admit(plan.projectId,{...request,id:crypto.randomUUID(),costCapUsd:4},500)).rejects.toThrow();expect(io.state).toEqual(before);expect(io.writes).toHaveLength(writeCount);
  await expect(io.ledger.admit(plan.projectId,input(),500)).rejects.toThrow("actual saved preview");expect(io.state).toEqual(before);expect(io.writes).toHaveLength(writeCount);
},90000);
