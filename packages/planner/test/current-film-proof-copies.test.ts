import {afterAll,beforeAll,expect,spyOn,test} from "bun:test";
import {createHash} from "node:crypto";
import {readFileSync,readdirSync} from "node:fs";
import {dirname,join} from "node:path";
import {currentFilmSourceFixture} from "./current-film-source.fixture";
import {contentHash as hash} from "../../generator/src/capabilities";
import {DurableJobStore,type JobInput} from "../../queue/src/index";
import {bindOriginalEditSource} from "../src/edit-jobs";
import {compileCurrentFilmMixedJob,type CurrentFilmJobV3} from "../src/current-film-mixed-jobs";
import {currentFilmV2Job} from "../src/current-film-job-context";
import {currentFilmRuntimeRecordedFiles} from "../src/current-film-runtime-context";
import {compileCurrentFilmProofClosure} from "../src/current-film-proof-closure";
import * as closureCompiler from "../src/current-film-proof-closure";
import {compileCurrentFilmProofTarget} from "../src/current-film-proof-target";
import {compileCurrentFilmProofCopies,resolveCurrentFilmProofCopies,validateCurrentFilmProofCopies,validateCurrentFilmProofPreviewFiles,freezeCurrentFilmProofContext,type CurrentFilmProofCopies,type CurrentFilmProofSelection} from "../src/current-film-proof-copies";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,plan:CurrentFilmJobV3,selection:CurrentFilmProofSelection,proof:CurrentFilmProofCopies;
const targetId="proof-copy-target";
const reseal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...body}=value;return {...body,revision:hash(body)} as T;};
beforeAll(async()=>{
  f=await currentFilmSourceFixture();const final=await f.renderFinal(),source=currentFilmV2Job(final.job),base=source.currentFilm;
  if(!base)throw new Error("Use the actual final source plan.");const slot=base.materialization.slots[0]!,row=source.currentFilmCheckpoint!.rows[0]!;
  plan=compileCurrentFilmMixedJob(base,{origins:[bindOriginalEditSource(final.receipt)],choices:[{ordinal:0,inputRevision:slot.inputRevision,originId:final.receipt.revision,
    source:{receiptRevision:final.receipt.revision,ordinal:0,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:row.record.revision}}]});
  const frozenContext=freezeCurrentFilmProofContext({project:f.projects.snapshot().projects[0]!,jobs:[f.studio.film,f.job,final.job,f.studio.spanish[0]!]});
  const closure=compileCurrentFilmProofClosure(plan,frozenContext);
  const previews=closure.previews.map(({job})=>{
    const output=job.output!,paths=new Set(currentFilmRuntimeRecordedFiles(job).map(file=>file.path));
    for(const path of [output.mp4Path,output.hlsPlaylistPath,output.captionsPath,output.captionsPath.slice(0,-4)+".srt",output.manifestPath,`${job.projectId}/${job.id}/clips/manifest.json`])paths.add(path);
    const prefix=output.hlsPlaylistPath.slice(0,-"index.m3u8".length);
    for(const name of readdirSync(join(f.studio.paths.artifactRoot,dirname(output.hlsPlaylistPath))))paths.add(prefix+name);
    return {jobId:job.id,files:[...paths].sort().map(path=>{const bytes=readFileSync(join(f.studio.paths.artifactRoot,path));return {path,bytes:bytes.length,sha256:createHash("sha256").update(bytes).digest("hex")};})};
  });
  selection={frozenContext,carriers:closure.receipts.map(({receipt,candidates})=>{const {files:_files,...candidate}=candidates[0]!;return {receiptRevision:receipt.revision,...candidate};}),previews};
  proof=compileCurrentFilmProofCopies(plan,targetId,selection);
},240000);
afterAll(async()=>{await f?.close();});

test("complete proof copies preserve exact original hierarchy, preview inventory and persisted JSON while pruning unrelated jobs",()=>{
  const before=hash({plan,selection}),closure=compileCurrentFilmProofClosure(plan,selection.frozenContext);
  expect(proof.carriers).toHaveLength(closure.receipts.length);expect(proof.previews.map(value=>value.jobId)).toEqual([f.job.id]);
  expect(proof.frozenContext.jobs.some(job=>job.id===f.studio.spanish[0]!.id)).toBe(false);
  expect(Object.keys(proof.frozenContext.project).every(key=>["id","currentScreenplay","versions","animaticApprovals","referenceAssets","livingScriptProposals"].includes(key))).toBe(true);
  let count=0,bytes=0;
  for(const group of [...proof.carriers,...proof.previews])for(const copy of group.copies){
    count++;bytes+=copy.owned.bytes;expect(copy.owned.path.endsWith("/"+copy.original.path)).toBe(true);
    expect(copy.owned.path.startsWith(`${proof.projectId}/${targetId}/proof/`)).toBe(true);
    expect(copy.carrier.sha256).toBe(copy.original.sha256);expect(copy.owned.sha256).toBe(copy.original.sha256);expect(copy.owned.bytes).toBe(copy.original.bytes);
  }
  expect(proof.files).toBe(count);expect(proof.bytes).toBe(bytes);expect(proof.mediaVerified).toBe(false);expect(proof.currentAuthority).toBe(false);
  expect(validateCurrentFilmProofCopies(JSON.parse(JSON.stringify(proof)),plan,targetId)).toEqual(proof);
  expect(hash({plan,selection})).toBe(before);
},90000);

test("an actual admitted unrelated target is removed from discovery without changing its proof specification",()=>{
  const original=selection.frozenContext.jobs.find(job=>job.currentFilm?.schema==="hv-current-film-job/2"&&job.stage==="final");
  if(!original)throw new Error("Retain the actual reviewed final fixture.");
  const input:JobInput={id:targetId,projectId:plan.projectId,idempotencyKey:targetId,currentFilm:plan,tier:plan.render.tier,stage:plan.render.stage,
    scriptVersion:plan.materialization.script.version,scriptText:plan.materialization.script.text,casting:plan.target.state.casting.candidate!,providerPlan:plan.render.providerPlan,
    rightsAttestedAt:f.project.rightsAttestedAt,animaticJobId:original.animaticJobId,animaticApprovedAt:original.animaticApprovedAt,
    totalFrames:plan.materialization.requestedFrames,costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:300000};
  const store=DurableJobStore.fromJobs([]),admitted=store.enqueue(input),before=hash(admitted);
  expect(admitted.status).toBe("queued");expect(admitted.currentFilmOrigins).toBeUndefined();expect(admitted.currentFilmCheckpoint).toBeUndefined();
  const supplied={...selection,frozenContext:{project:selection.frozenContext.project,jobs:[...selection.frozenContext.jobs,admitted]}};
  const actual=compileCurrentFilmProofCopies(plan,targetId,supplied);
  expect(actual).toEqual(proof);expect(actual.frozenContext.jobs.some(job=>job.id===targetId)).toBe(false);
  expect(validateCurrentFilmProofCopies(JSON.parse(JSON.stringify(actual)),plan,targetId)).toEqual(proof);
  expect(hash(store.get(targetId))).toBe(before);
},90000);

test("resealing incomplete or redirected original and preview copies cannot change frozen requirements",()=>{
  for(const mutate of [
    (value:CurrentFilmProofCopies)=>{value.carriers[0]!.copies.pop();},
    (value:CurrentFilmProofCopies)=>{value.carriers[0]!.copies[0]!.owned.path=`${proof.projectId}/${targetId}/proof/redirected.bin`;},
    (value:CurrentFilmProofCopies)=>{value.carriers[0]!.copies[0]!.carrier.sha256="a".repeat(64);},
    (value:CurrentFilmProofCopies)=>{value.previews[0]!.copies=value.previews[0]!.copies.filter(copy=>!copy.original.path.endsWith(".ts"));},
    (value:CurrentFilmProofCopies)=>{value.previews[0]!.jobRevision="b".repeat(64);},
    (value:CurrentFilmProofCopies)=>{value.files--;},
  ]){const changed=structuredClone(proof);mutate(changed);expect(()=>validateCurrentFilmProofCopies(reseal(changed),plan,targetId)).toThrow();}
  expect(()=>validateCurrentFilmProofCopies(proof,plan,"different-target")).toThrow();
},90000);

test("proof selection requires each exact carrier and historical preview with unchanged indexed native media",()=>{
  for(const mutate of [
    (value:CurrentFilmProofSelection)=>{value.carriers.pop();},
    (value:CurrentFilmProofSelection)=>{value.carriers[0]!.jobRevision="c".repeat(64);},
    (value:CurrentFilmProofSelection)=>{value.previews=[];},
    (value:CurrentFilmProofSelection)=>{value.previews[0]!.files=value.previews[0]!.files.filter(file=>!file.path.endsWith("/clips/manifest.json"));},
    (value:CurrentFilmProofSelection)=>{const native=value.previews[0]!.files.find(file=>file.path.endsWith(".wav"));if(!native)throw new Error("Retain the actual native preview waveform.");native.sha256="d".repeat(64);},
  ]){const changed=structuredClone(selection);mutate(changed);expect(()=>compileCurrentFilmProofCopies(plan,targetId,changed)).toThrow();}
  expect(()=>compileCurrentFilmProofCopies(plan,selection.carriers[0]!.jobId,selection)).toThrow("independent");
},90000);

test("indexed preview validation rejects unknown roles, missing segments and over-capacity input before any byte claim",()=>{
  const preview=proof.frozenContext.jobs.find(job=>job.id===f.job.id)!,files=selection.previews[0]!.files;
  expect(validateCurrentFilmProofPreviewFiles(preview,files)).toEqual(files);
  expect(()=>validateCurrentFilmProofPreviewFiles(preview,files.filter(file=>!file.path.endsWith(".ts")))).toThrow("missing");
  expect(()=>validateCurrentFilmProofPreviewFiles(preview,[...files,{...files[0]!,path:`${preview.projectId}/${preview.id}/unreviewed.bin`}])).toThrow("unowned");
  expect(()=>validateCurrentFilmProofPreviewFiles(preview,Array.from({length:80001},()=>files[0]!))).toThrow("bounded");
},90000);

test("proof copy boundaries do not read hostile accessors or persist unrelated private project fields",()=>{
  let reads=0;const hostile=structuredClone(selection);Object.defineProperty(hostile.frozenContext.project,"versions",{enumerable:true,get(){reads++;return [];}});
  expect(()=>compileCurrentFilmProofCopies(plan,targetId,hostile)).toThrow("portable");expect(reads).toBe(0);
  const supplied={project:{...selection.frozenContext.project,privateUnrelatedField:"must be excluded"},jobs:selection.frozenContext.jobs};
  expect(Object.hasOwn(freezeCurrentFilmProofContext(supplied).project,"privateUnrelatedField")).toBe(false);
  const reversed={...selection.frozenContext,jobs:[...selection.frozenContext.jobs].reverse()};
  expect(freezeCurrentFilmProofContext(reversed)).toEqual(freezeCurrentFilmProofContext(selection.frozenContext));
});

test("checked proof resolution reuses the retained closure and returns independent mutable results",()=>{
  const initial=resolveCurrentFilmProofCopies(proof,plan,targetId),before=hash({proof,plan}),expected=compileCurrentFilmProofClosure(plan,proof.frozenContext,proof.target);
  expect(initial.closure).toEqual(expected);expect(initial.proof).toEqual(proof);
  const compiler=spyOn(closureCompiler,"compileCurrentFilmProofClosure");
  try{
    initial.proof.carriers[0]!.copies[0]!.owned.sha256="a".repeat(64);
    initial.closure.receipts[0]!.receipt.facts.label="mutated returned receipt";
    initial.closure.previews[0]!.job.status="failed";
    const restored=resolveCurrentFilmProofCopies(structuredClone(proof),structuredClone(plan),targetId);
    expect(restored.closure).toEqual(expected);expect(restored.proof).toEqual(proof);expect(compiler).not.toHaveBeenCalled();
    expect(restored.closure.mediaVerified).toBe(false);expect(restored.closure.currentAuthority).toBe(false);
    expect(hash({proof,plan})).toBe(before);
  }finally{compiler.mockRestore();}
},90000);

test("warm proof resolution still checks every descriptor and exact full plan rather than its retained seal",()=>{
  resolveCurrentFilmProofCopies(proof,plan,targetId);let reads=0;
  const getter=structuredClone(proof);Object.defineProperty(getter.frozenContext.project,"versions",{enumerable:true,get(){reads++;return [];}});
  expect(()=>resolveCurrentFilmProofCopies(getter,plan,targetId)).toThrow("portable");expect(reads).toBe(0);
  const planGetter=structuredClone(plan);Object.defineProperty(planGetter.materialization.slots[0]!.shot,"prompt",{enumerable:true,get(){reads++;return "forged";}});
  expect(()=>resolveCurrentFilmProofCopies(proof,planGetter,targetId)).toThrow("portable");expect(reads).toBe(0);
  const hidden=structuredClone(proof);Object.defineProperty(hidden,"hidden",{value:"not portable",enumerable:false});
  expect(()=>resolveCurrentFilmProofCopies(hidden,plan,targetId)).toThrow("portable");
  const ownUndefined=structuredClone(proof);Object.defineProperty(ownUndefined,"unreviewed",{value:undefined,enumerable:true});
  expect(()=>resolveCurrentFilmProofCopies(ownUndefined,plan,targetId)).toThrow("exact");
  const nested=structuredClone(plan);nested.materialization.slots[0]!.shot.prompt+=" changed while retaining the prior revision";
  expect(()=>resolveCurrentFilmProofCopies(proof,nested,targetId)).toThrow();
  expect(()=>resolveCurrentFilmProofCopies(proof,reseal(nested),targetId)).toThrow();
  expect(()=>resolveCurrentFilmProofCopies(proof,plan,targetId+"-foreign")).toThrow();
  expect(resolveCurrentFilmProofCopies(proof,plan,targetId).proof).toEqual(proof);
},90000);

test("warm proof resolution refuses changed frozen jobs, approvals and copies even after outer resealing",()=>{
  resolveCurrentFilmProofCopies(proof,plan,targetId);
  for(const mutate of [
    (value:CurrentFilmProofCopies)=>{value.frozenContext.jobs.find(job=>job.id===f.job.id)!.status="failed";},
    (value:CurrentFilmProofCopies)=>{value.frozenContext.project.animaticApprovals[0]!.decision="changes_requested";},
    (value:CurrentFilmProofCopies)=>{value.carriers[0]!.copies[0]!.owned.sha256="d".repeat(64);},
    (value:CurrentFilmProofCopies)=>{value.frozenContext.project.versions[0]!.text+="\nchanged frozen screenplay";},
  ]){const changed=structuredClone(proof);mutate(changed);expect(()=>resolveCurrentFilmProofCopies(reseal(changed),plan,targetId)).toThrow();}
  expect(resolveCurrentFilmProofCopies(proof,plan,targetId).proof).toEqual(proof);
},90000);

test("cached target proof binds the exact actual preview decision independently of its own seal",()=>{
  const original=selection.frozenContext.jobs.find(job=>job.currentFilm?.schema==="hv-current-film-job/2"&&job.stage==="final");
  if(!original)throw new Error("Retain the actual approved final fixture.");
  const id="proof-cache-reviewed-target",input:JobInput={id,projectId:plan.projectId,idempotencyKey:id,currentFilm:plan,tier:plan.render.tier,stage:plan.render.stage,
    scriptVersion:plan.materialization.script.version,scriptText:plan.materialization.script.text,casting:plan.target.state.casting.candidate!,providerPlan:plan.render.providerPlan,
    rightsAttestedAt:f.project.rightsAttestedAt,animaticJobId:original.animaticJobId,animaticApprovedAt:original.animaticApprovedAt,
    totalFrames:plan.materialization.requestedFrames,costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:300000};
  const target=compileCurrentFilmProofTarget(input),targetProof=compileCurrentFilmProofCopies(plan,id,{...selection,target});
  const resolved=resolveCurrentFilmProofCopies(targetProof,plan,id);
  expect(resolved.closure.targetApproval?.previewJobId).toBe(original.animaticJobId!);
  const changed=structuredClone(targetProof);changed.target=reseal({...changed.target!,animaticApprovedAt:new Date(Date.parse(target.animaticApprovedAt!)+1).toISOString()});
  expect(()=>resolveCurrentFilmProofCopies(reseal(changed),plan,id)).toThrow();
  resolved.closure.targetApproval!.approval.note="mutated returned approval";
  expect(resolveCurrentFilmProofCopies(targetProof,plan,id).closure.targetApproval!.approval.note).not.toBe("mutated returned approval");
},90000);

test("successful proof closure caching has a bounded entry count and evicted inputs still validate fully",()=>{
  const firstId="proof-cache-capacity-0",first=compileCurrentFilmProofCopies(plan,firstId,selection);
  for(let index=1;index<=8;index++)compileCurrentFilmProofCopies(plan,`proof-cache-capacity-${index}`,selection);
  const compiler=spyOn(closureCompiler,"compileCurrentFilmProofClosure");
  try{
    const result=resolveCurrentFilmProofCopies(first,plan,firstId);
    // An evicted result reconstructs discovery and retained closure once each.
    // Returning that checked closure avoids a third downstream reconstruction.
    expect(compiler).toHaveBeenCalledTimes(2);expect(result.proof).toEqual(first);
    expect(result.closure.revision).toBe(first.closureRevision);
    compiler.mockClear();expect(resolveCurrentFilmProofCopies(first,plan,firstId).proof).toEqual(first);expect(compiler).not.toHaveBeenCalled();
  }finally{compiler.mockRestore();}
},90000);
