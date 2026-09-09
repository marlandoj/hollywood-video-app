import {afterAll,beforeAll,expect,spyOn,test} from "bun:test";
import type {SQL} from "bun";
import {createHash} from "node:crypto";
import {readFileSync,readdirSync} from "node:fs";
import {dirname,join,relative} from "node:path";
import type {Job} from "../../queue/src/index";
import {contentHash as hash} from "../../generator/src/capabilities";
import {currentFilmSourceFixture} from "../../planner/test/current-film-source.fixture";
import {compileCurrentFilmMixedJob,type CurrentFilmJobV3} from "../../planner/src/current-film-mixed-jobs";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {compileCurrentFilmOrigins} from "../../planner/src/current-film-origins";
import {compileCurrentFilmProofClosure,type CurrentFilmProofContext} from "../../planner/src/current-film-proof-closure";
import {compileCurrentFilmProofCopies,validateCurrentFilmProofCopies} from "../../planner/src/current-film-proof-copies";
import {compileCurrentFilmProofTarget} from "../../planner/src/current-film-proof-target";
import type {CurrentFilmMixedJobInput} from "../../planner/src/current-film-mixed-job-context";
import {currentFilmV2Job} from "../../planner/src/current-film-job-context";
import {currentFilmRuntimeRecordedFiles} from "../../planner/src/current-film-runtime-context";
import {resolveCurrentFilmProofContext} from "../src/current-film-proof-context";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,final:Awaited<ReturnType<typeof f.renderFinal>>,plan:CurrentFilmJobV3,context:CurrentFilmProofContext,carrier:Job;
type IndexRow={key:string;sha256:string;bytes:number|string};
let inventories:Map<string,IndexRow[]>;
function transaction(jobs=context.jobs,indexes=inventories,change?:(sql:string,values:unknown[],result:unknown)=>unknown) {
  const calls:{sql:string;values:unknown[]}[]=[];
  // Actual worker metadata and file digests cross a query-boundary double. This
  // tests resolution/fences, not PostgreSQL lock execution or uploaded S3 bytes.
  const tx=(async(parts:TemplateStringsArray,...values:unknown[])=>{
    const sql=parts.join("?");calls.push({sql,values});let result:unknown;
    if(sql.includes("from hv_jobs"))result=(sql.includes("and id=")?jobs.filter(job=>job.id===values[1]):jobs).map(job=>({id:job.id,body:job}));
    else if(sql.includes("from hv_artifacts"))result=indexes.get(String(values[1]))??[];
    else throw new Error("Unexpected proof query");
    // PostgreSQL JSONB drops own optional undefined. Hostile descriptors are
    // deliberately injected after this transport step in the negative cases.
    const transported=JSON.parse(JSON.stringify(result));
    return change?change(sql,values,transported):Object.assign(transported,{count:1,command:"SELECT"});
  }) as unknown as SQL;return {tx,calls};
}
function digest(path:string):IndexRow {const value=readFileSync(join(f.studio.paths.artifactRoot,path));return {key:path,sha256:createHash("sha256").update(value).digest("hex"),bytes:value.length};}
function previewFiles(job:Job):IndexRow[] {
  const output=job.output!,paths=new Set(currentFilmRuntimeRecordedFiles(job).map(file=>file.path));
  for(const path of [output.mp4Path,output.hlsPlaylistPath,output.captionsPath,output.captionsPath.slice(0,-4)+".srt",output.manifestPath,`${job.projectId}/${job.id}/clips/manifest.json`,
    ...(output.storyboard??[]).flatMap(row=>[row.path,...(row.sourcePath?[row.sourcePath]:[])])])paths.add(path);
  const directory=join(f.studio.paths.artifactRoot,dirname(output.hlsPlaylistPath));
  for(const name of readdirSync(directory))paths.add(relative(f.studio.paths.artifactRoot,join(directory,name)).replaceAll("\\","/"));
  return [...paths].sort().map(digest);
}
function proofTarget(){
  const id="proof-context-target",source=final.job,request:CurrentFilmMixedJobInput={id,projectId:plan.projectId,idempotencyKey:id,currentFilm:plan,tier:plan.render.tier,stage:plan.render.stage,
    scriptVersion:plan.materialization.script.version,scriptText:plan.materialization.script.text,casting:plan.target.state.casting.candidate!,providerPlan:plan.render.providerPlan,
    rightsAttestedAt:source.rightsAttestedAt,animaticJobId:source.animaticJobId,animaticApprovedAt:source.animaticApprovedAt,totalFrames:plan.materialization.requestedFrames,
    costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:300000};
  return compileCurrentFilmProofTarget(request);
}
beforeAll(async()=>{
  f=await currentFilmSourceFixture();final=await f.renderFinal();const checked=currentFilmV2Job(final.job),target=checked.currentFilm;
  if(!target)throw new Error("The actual final needs its checked V2 plan.");const slot=target.materialization.slots[0]!,record=checked.currentFilmCheckpoint!.rows[0]!.record;
  plan=compileCurrentFilmMixedJob(target,{origins:[bindOriginalEditSource(final.receipt)],choices:[{ordinal:0,inputRevision:slot.inputRevision,originId:final.receipt.revision,
    source:{receiptRevision:final.receipt.revision,ordinal:0,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:record.revision}}]});
  // This deterministic preparation is only carrier/index metadata. Original
  // measured hashes are real, but no copied bytes or held checkpoint is claimed.
  const {currentFilm:_plan,currentFilmCheckpoint:_checkpoint,output:_output,...base}=final.job;
  const id="aaa-proof-context-carrier";
  carrier={...base,id,idempotencyKey:id,status:"running",currentFilm:plan,currentFilmOrigins:compileCurrentFilmOrigins(plan,id),checkpointShots:0,checkpointFrame:0,
    completedAt:null,linkExpiresAt:null,routeDecisions:[]};
  context={project:f.projects.snapshot().projects[0]!,jobs:[f.studio.film,f.job,final.job,carrier]};
  const bootstrap=plan.library.origin!.request.source;
  inventories=new Map([
    [f.studio.film.id,bootstrap.files.map(file=>({key:file.path,sha256:file.sha256,bytes:file.bytes}))],
    [final.job.id,final.receipt.files.map(file=>({key:file.path,sha256:file.sha256,bytes:file.bytes}))],
    [f.job.id,previewFiles(f.job)],
    [id,carrier.currentFilmOrigins!.origins.flatMap(origin=>origin.copies.map(copy=>({key:copy.owned.path,sha256:copy.owned.sha256,bytes:copy.owned.bytes})))],
  ]);
},240000);
afterAll(async()=>{await f?.close();});

test("actual preview and exact complete retained indexes resolve with deterministic locks, detached historical context and no byte claim",async()=>{
  const before=hash({plan,context,indexes:[...inventories]}),db=transaction(),resolved=await resolveCurrentFilmProofContext(db.tx,plan,context.project);
  expect(resolved.closure).toEqual(compileCurrentFilmProofClosure(plan,resolved.frozenContext));
  expect(resolved.closure).toEqual(compileCurrentFilmProofClosure(plan,JSON.parse(JSON.stringify(resolved.frozenContext))));
  expect(resolved.carriers.find(row=>row.receiptRevision===final.receipt.revision)?.jobId).toBe(carrier.id);
  expect(resolved.previews).toEqual([{jobId:f.job.id,files:inventories.get(f.job.id)!.map(row=>({path:row.key,sha256:row.sha256,bytes:Number(row.bytes)})).sort((a,b)=>a.path.localeCompare(b.path))}]);
  expect(resolved.metadataOnly).toBe(true);expect(resolved.bytesVerified).toBe(false);expect(resolved.hlsContentsVerified).toBe(false);expect(resolved.currentAuthority).toBe(false);
  const locks=db.calls.filter(call=>call.sql.endsWith("for share")),jobLocks=locks.filter(call=>call.sql.includes("hv_jobs")),indexLocks=locks.filter(call=>call.sql.includes("hv_artifacts"));
  const ids=[...new Set([...resolved.carriers.map(row=>row.jobId),f.job.id])].sort();
  expect(jobLocks.map(call=>call.values[1])).toEqual(ids);expect(indexLocks.map(call=>call.values[1])).toEqual(ids);expect(locks.slice(0,ids.length)).toEqual(jobLocks);
  expect(db.calls[0]!.sql).toContain("order by id limit 1025");expect(indexLocks.every(call=>call.sql.includes("order by key limit 100001"))).toBe(true);
  resolved.frozenContext.jobs[0]!.notifications.push("detached");expect(hash({plan,context,indexes:[...inventories]})).toBe(before);
},90000);

test("an exact shared target/source preview is retained once, locked once and survives proof-copy JSON reconstruction",async()=>{
  const target=proofTarget(),before=structuredClone(target),db=transaction(),resolved=await resolveCurrentFilmProofContext(db.tx,plan,context.project,target);
  expect(resolved.target).toEqual(target);expect(resolved.closure.targetApproval?.previewJobId).toBe(f.job.id);expect(resolved.previews.map(row=>row.jobId)).toEqual([f.job.id]);
  expect(db.calls.filter(call=>call.sql.endsWith("for share")&&call.sql.includes("hv_jobs")&&call.values[1]===f.job.id)).toHaveLength(1);
  expect(db.calls.filter(call=>call.sql.endsWith("for share")&&call.sql.includes("hv_artifacts")&&call.values[1]===f.job.id)).toHaveLength(1);
  const {frozenContext,carriers,previews}=resolved,copies=compileCurrentFilmProofCopies(plan,target.jobId,{frozenContext,carriers,previews,target:resolved.target!});
  expect(copies.target).toEqual(target);expect(copies.previews.map(row=>row.jobId)).toEqual([f.job.id]);
  expect(validateCurrentFilmProofCopies(JSON.parse(JSON.stringify(copies)),plan,target.jobId)).toEqual(copies);
  resolved.target!.jobId="changed-result";expect(target).toEqual(before);
},90000);

test("target evidence is descriptor-validated before SQL and detached throughout awaited discovery",async()=>{
  let reads=0;const target=proofTarget();Object.defineProperty(target,"jobId",{enumerable:true,get(){reads++;return "hostile";}});
  const rejected=transaction();await expect(resolveCurrentFilmProofContext(rejected.tx,plan,context.project,target)).rejects.toThrow("accessors");expect(reads).toBe(0);expect(rejected.calls).toEqual([]);
  const stable=proofTarget(),before=structuredClone(stable),db=transaction(context.jobs,inventories,(sql,_values,result)=>{
    if(sql.includes("order by id limit"))stable.animaticJobId="changed-during-read";return result;
  });
  const resolved=await resolveCurrentFilmProofContext(db.tx,plan,context.project,stable);
  expect(stable.animaticJobId).toBe("changed-during-read");expect(resolved.target).toEqual(before);expect(resolved.closure.targetApproval?.previewJobId).toBe(f.job.id);
},90000);

test("missing historical original uses complete carrier; incomplete carrier falls back only during discovery and expiry never grants current permission",async()=>{
  const noOriginal=context.jobs.filter(job=>job.id!==final.job.id),resolved=await resolveCurrentFilmProofContext(transaction(noOriginal).tx,plan,context.project);
  expect(resolved.carriers.find(row=>row.receiptRevision===final.receipt.revision)?.jobId).toBe(carrier.id);
  const partial=new Map(inventories);partial.set(carrier.id,inventories.get(carrier.id)!.slice(1));
  expect((await resolveCurrentFilmProofContext(transaction(context.jobs,partial).tx,plan,context.project)).carriers.find(row=>row.receiptRevision===final.receipt.revision)?.jobId).toBe(final.job.id);
  await expect(resolveCurrentFilmProofContext(transaction(noOriginal,partial).tx,plan,context.project)).rejects.toThrow("complete exact indexed carrier");
  // The exact historically admitted lifetime is unchanged; wall clock expiry is
  // outside this resolver, as are current project grants and publication access.
  const expiredAt=Math.max(...context.jobs.map(job=>Date.parse(job.linkExpiresAt??job.completedAt!)).filter(Number.isFinite))+1;
  const now=spyOn(Date,"now").mockReturnValue(expiredAt);
  try{
    const historic=await resolveCurrentFilmProofContext(transaction(context.jobs.filter(job=>job.id!==carrier.id)).tx,plan,context.project);
    expect(Date.parse(final.job.linkExpiresAt!)).toBeLessThan(Date.now());expect(historic.carriers.find(row=>row.receiptRevision===final.receipt.revision)?.jobId).toBe(final.job.id);
    expect(historic.currentAuthority).toBe(false);
  }finally{now.mockRestore();}
},90000);

test("complete preview discovery cannot substitute a hash for missing HLS, clips manifest, measured native roles or exact safe SQL byte counts",async()=>{
  const original=inventories.get(f.job.id)!,native=currentFilmRuntimeRecordedFiles(f.job)[0]!.path;
  for(const rejected of [original.filter(row=>row.key!==f.job.output!.hlsPlaylistPath),original.filter(row=>!row.key.endsWith(".ts")),original.filter(row=>!row.key.endsWith("clips/manifest.json")),
    original.map(row=>row.key===native?{...row,sha256:"a".repeat(64)}:row),original.map((row,i)=>i?row:{...row,bytes:"9007199254740992"}),
    original.map((row,i)=>i?row:{...row,bytes:"01"}),original.map((row,i)=>i?row:{...row,bytes:-1}),[...original,original[0]!],
    [...original,{...original[0]!,key:`${f.job.projectId}/${f.job.id}/../foreign`}]] ){
    const changed=new Map(inventories);changed.set(f.job.id,rejected);await expect(resolveCurrentFilmProofContext(transaction(context.jobs,changed).tx,plan,context.project)).rejects.toThrow();
  }
  const strings=new Map([...inventories].map(([id,files])=>[id,files.map(file=>({...file,bytes:String(file.bytes)}))]));
  expect((await resolveCurrentFilmProofContext(transaction(context.jobs,strings).tx,plan,context.project)).previews[0]!.files).toEqual(original.map(row=>({path:row.key,sha256:row.sha256,bytes:Number(row.bytes)})).sort((a,b)=>a.path.localeCompare(b.path)));
},90000);

test("chosen job/body and complete index changes after discovery fail without choosing another carrier",async()=>{
  for(const kind of ["body","index","missing"]){
    const db=transaction(context.jobs,inventories,(sql,values,result)=>{
      const checked=structuredClone(result);
      if(sql.endsWith("for share")&&values[1]===carrier.id){
        if(kind==="missing"&&sql.includes("hv_jobs"))return [];
        if(kind==="body"&&sql.includes("hv_jobs"))(checked as {body:Job}[])[0]!.body.notifications.push("changed under lock");
        if(kind==="index"&&sql.includes("hv_artifacts"))(checked as IndexRow[])[0]!.bytes=Number((checked as IndexRow[])[0]!.bytes)+1;
      }return checked;
    });
    await expect(resolveCurrentFilmProofContext(db.tx,plan,context.project)).rejects.toThrow("retry the transaction");
  }
},90000);

test("portable checks reject getters before any reads, conflicting same-ID rows and complete-query truncation",async()=>{
  let reads=0;const project=structuredClone(context.project);Object.defineProperty(project,"id",{enumerable:true,get(){reads++;return f.job.projectId;}});
  const empty=transaction();await expect(resolveCurrentFilmProofContext(empty.tx,plan,project)).rejects.toThrow("accessors");expect(reads).toBe(0);expect(empty.calls).toEqual([]);
  for(const where of ["body","array","index"]){
    const db=transaction(context.jobs,inventories,(sql,_values,result)=>{
      const checked=structuredClone(result);
      if(where==="body"&&sql.includes("hv_jobs"))Object.defineProperty((checked as object[])[0]!,"body",{enumerable:true,get(){reads++;return f.job;}});
      if(where==="array"&&sql.includes("hv_jobs"))Object.defineProperty(checked,"0",{enumerable:true,get(){reads++;return {id:f.job.id,body:f.job};}});
      if(where==="index"&&sql.includes("hv_artifacts"))Object.defineProperty((checked as object[])[0]!,"sha256",{enumerable:true,get(){reads++;return "a".repeat(64);}});
      return checked;
    });await expect(resolveCurrentFilmProofContext(db.tx,plan,context.project)).rejects.toThrow("accessors");expect(reads).toBe(0);
  }
  const different=structuredClone(context.jobs[0]!);different.notifications.push("conflicting");
  await expect(resolveCurrentFilmProofContext(transaction([...context.jobs,different]).tx,plan,context.project)).rejects.toThrow("same-ID");
  const tooManyJobs:unknown[]=[];tooManyJobs.length=1025;
  const over=transaction(context.jobs,inventories,(sql,_values,result)=>sql.includes("hv_jobs")?tooManyJobs:result);
  await expect(resolveCurrentFilmProofContext(over.tx,plan,context.project)).rejects.toThrow("do not truncate");
  const tooManyFiles:unknown[]=[];tooManyFiles.length=100001;
  const indexOver=transaction(context.jobs,inventories,(sql,_values,result)=>sql.includes("hv_artifacts")?tooManyFiles:result);
  await expect(resolveCurrentFilmProofContext(indexOver.tx,plan,context.project)).rejects.toThrow("do not truncate");
},90000);
