import {afterAll,beforeAll,expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {copyFileSync,existsSync,mkdirSync,mkdtempSync,readFileSync,unlinkSync,writeFileSync} from "node:fs";
import {dirname,join} from "node:path";
import {currentFilmSourceFixture} from "../../planner/test/current-film-source.fixture";
import {contentHash as hash} from "../../generator/src/capabilities";
import {copyCurrentFilmAdoption} from "../../generator/src/current-film-adoption-media";
import {ProjectService} from "../../api/src/index";
import {processNextJob} from "../../queue/src/worker";
import type {Job,JobInput} from "../../queue/src/index";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {compileCurrentFilmMixedJob,type CurrentFilmReuseChoice} from "../../planner/src/current-film-mixed-jobs";
import {createCurrentFilmMixedCheckpoint,type CurrentFilmMixedCheckpoint,type CurrentFilmMixedCheckpointContext,type CurrentFilmMixedCheckpointRow} from "../../planner/src/current-film-mixed-context";
import {compileCurrentFilmJob,type CurrentFilmJobV2} from "../../planner/src/current-film-jobs";
import {currentFilmV2Job} from "../../planner/src/current-film-job-context";
import {currentScreenplayHead,saveCurrentScreenplayProposal} from "../../planner/src/current-screenplay-library";
import {compileLivingScriptStructure,livingScriptStructureBoundary} from "../../planner/src/living-script-structure";
import {compileLivingScriptDocument} from "../../planner/src/living-script-document";
import {proposeShotPlanEvolution} from "../../planner/src/living-script-current-plan";
import {createCurrentDirectionRequest} from "../../planner/src/living-script-current-direction";
import {resolveCurrentFilmMixedAssembly,validateCurrentFilmMixedAssemblyClock} from "../../planner/src/current-film-mixed-clock";
import {assembleCurrentFilmMixedAsync,type CurrentFilmMixedExportResult} from "../src/index";
import {createCurrentFilmMixedProvenance,validateCurrentFilmMixedProvenance,prepareCurrentFilmMixedAssembly,type CurrentFilmMixedProvenance} from "../src/current-film-mixed";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,fresh:Job,context:CurrentFilmMixedCheckpointContext,checkpoint:CurrentFilmMixedCheckpoint,ownedRoot:string,outDir:string,result:CurrentFilmMixedExportResult;
const access=async()=>{};
const sha=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
const reseal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...body}=value;return {...body,revision:hash(body)} as T;};
function choice(plan:CurrentFilmJobV2,receipt:typeof f.receipt,ordinal:number,sourceOrdinal:number):CurrentFilmReuseChoice {
  const original=currentFilmV2Job(receipt.job).currentFilmCheckpoint!;
  const slot=plan.materialization.slots[ordinal]!,source=original.rows[sourceOrdinal]!;
  return {ordinal,inputRevision:slot.inputRevision,originId:receipt.revision,source:{receiptRevision:receipt.revision,ordinal:sourceOrdinal,logicalShotId:source.logicalShotId,renderId:source.renderId,inputRevision:source.inputRevision,recordRevision:source.record.revision}};
}
function stage(owner:CurrentFilmMixedCheckpointContext,complete:CurrentFilmMixedCheckpoint){
  const assembly=resolveCurrentFilmMixedAssembly(owner,complete),root=mkdtempSync(join(f.studio.root,"mixed-assembler-owned-"));
  for(const slot of assembly.slots)for(const file of Object.values(slot.ownedFiles)){const path=join(root,file.path);mkdirSync(dirname(path),{recursive:true});copyFileSync(join(f.studio.paths.artifactRoot,file.path),path);}
  return {root,outDir:join(root,assembly.projectId,assembly.jobId),assembly};
}
beforeAll(async()=>{
  f=await currentFilmSourceFixture();
  const accepted=f.accept(),library=accepted.currentScreenplay!,head=currentScreenplayHead(library)!,state=head.state,document=state.context.plan.document,base=document.context.base;
  const patch=compileLivingScriptStructure(base,{baseRevision:base.revision,operations:[{id:"assembler-leading-scene",kind:"insert",at:livingScriptStructureBoundary(base,1),text:"EXT. CLOCK - DAWN\nA golden clock gleams.\n\n"}]}),afterDocument=compileLivingScriptDocument({base:patch.after,ancestry:[...document.context.ancestry,patch]}),capacity={tier:"free" as const,maxShots:24 as const};
  const evolution=proposeShotPlanEvolution({previous:state.context.plan,lineage:state.context.lineage,originals:state.context.originals,beforeDocument:document,afterDocument,capacity,requestId:"mixed-assembler-insert-plan"});
  if(!evolution.review.candidate||evolution.review.conflicts.length)throw new Error("Assembler fixture requires exact whole-scene correspondence.");
  const saved=saveCurrentScreenplayProposal(library,{id:"mixed-assembler-target",label:"Lead into retained dialogue",expectedHeadRevision:head.revision,beforeStateRevision:state.revision,afterDocument,capacity,planRequest:evolution.request,directionRequest:createCurrentDirectionRequest(state.direction,evolution.review.candidate,{id:"mixed-assembler-direction",settings:[],lines:[],retired:[]})},library.version,Date.now());
  const p=compileCurrentFilmJob(saved.library,{kind:"proposal",revision:saved.proposal.revision},f.plan.request),projects=ProjectService.fromState({...f.projects.snapshot(),projects:[{...accepted,currentScreenplay:saved.library}]}),id="mixed-assembler-actual-fresh";
  const input:JobInput={id,projectId:p.projectId,idempotencyKey:id,tier:p.render.tier,stage:p.render.stage,scriptVersion:p.materialization.script.version,scriptText:p.materialization.script.text,casting:p.target.state.casting.candidate!,providerPlan:p.render.providerPlan,currentFilm:p,rightsAttestedAt:f.project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:p.materialization.requestedFrames,costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:180000};
  f.store.enqueue(input);const actual=await processNextJob(f.store,f.studio.paths.artifactRoot,{...f.context,projects});if(actual?.status!=="done")throw new Error("Fresh assembler comparison failed: "+actual?.failureReason);fresh=actual;
  const sourceOrdinal=f.job.currentFilmCheckpoint!.rows.findIndex(row=>Boolean(row.record.clip.speech)),targetOrdinal=p.materialization.slots.findIndex(slot=>slot.logicalShotId===f.plan.materialization.slots[sourceOrdinal]!.logicalShotId);
  if(targetOrdinal!==2||sourceOrdinal!==1)throw new Error("Assembler fixture must shift the measured source clock.");
  const plan=compileCurrentFilmMixedJob(p,{origins:[bindOriginalEditSource(f.receipt)],choices:[choice(p,f.receipt,targetOrdinal,sourceOrdinal)]}),adoption=await copyCurrentFilmAdoption(plan,fresh.id,targetOrdinal,f.studio.paths.artifactRoot,access);
  const rows:CurrentFilmMixedCheckpointRow[]=fresh.currentFilmCheckpoint!.rows.map(row=>row.ordinal===targetOrdinal?{kind:"reused",ordinal:row.ordinal,logicalShotId:row.logicalShotId,renderId:row.renderId,inputRevision:row.inputRevision,adoption}:{kind:"generated",...row});
  context={id:fresh.id,projectId:fresh.projectId,startedAt:fresh.startedAt,currentFilm:plan,checkpointShots:0,checkpointFrame:0,routeDecisions:rows.flatMap(row=>row.kind==="generated"?row.capture.routes:[])};
  checkpoint=createCurrentFilmMixedCheckpoint(context,rows);const staged=stage(context,checkpoint);ownedRoot=staged.root;outDir=staged.outDir;
  result=await assembleCurrentFilmMixedAsync(context,checkpoint,ownedRoot,outDir,{access,degradedShots:[plan.materialization.slots[0]!.renderId]});
},240000);
afterAll(async()=>{await f?.close();});

test("explicit mixed assembler preserves original native speech and matches independently generated target captions",async()=>{
  const before=hash({context,checkpoint,original:f.job}),clock=result.currentFilmMixedClock,prepared=await prepareCurrentFilmMixedAssembly(context,checkpoint,ownedRoot,outDir,{access});
  expect(Object.hasOwn(result,"currentFilmClock")).toBe(false);expect(clock.schema).toBe("hv-current-film-clock/3");expect(clock.effectiveOverlapFrames).toBe(0);expect(clock.reason).toBe("measured-speech");
  expect(clock.spans.map(span=>[span.startFrame,span.endFrame])).toEqual(fresh.output!.currentFilm!.assembly.spans.map(span=>[span.startFrame,span.endFrame]));
  expect(clock.spans[2]!.startFrame).toBeGreaterThan(f.job.output!.currentFilm!.assembly.spans[1]!.startFrame);
  expect(readFileSync(result.srtPath)).toEqual(readFileSync(join(f.studio.paths.artifactRoot,fresh.projectId,fresh.id,"captions.srt")));
  expect(readFileSync(result.vttPath)).toEqual(readFileSync(join(f.studio.paths.artifactRoot,fresh.output!.captionsPath)));
  expect(clock.video.sha256).toBe(sha(readFileSync(result.mp4Path)));expect(clock.captions.srt.sha256).toBe(sha(readFileSync(result.srtPath)));expect(readFileSync(result.hlsPlaylistPath,"utf8")).toContain("#EXTM3U");
  expect(prepared.clips.every(clip=>!Object.hasOwn(clip,"cost")&&!Object.hasOwn(clip,"renderRecord"))).toBe(true);
  expect(prepared.assembly.slots[2]!.originalRecord).toEqual(f.job.currentFilmCheckpoint!.rows[1]!.record);
  expect(prepared.clips[2]!.speech).toEqual(f.job.currentFilmCheckpoint!.rows[1]!.record.clip.speech);
  expect(result.degradedShots).toEqual([context.currentFilm.materialization.slots[0]!.renderId]);expect(hash({context,checkpoint,original:f.job})).toBe(before);
  expect(validateCurrentFilmMixedAssemblyClock(context,checkpoint,clock)).toEqual(clock);
},90000);

test("public version-three provenance is a reproducible whitelist of actual original and target evidence",()=>{
  const manifest=JSON.parse(readFileSync(result.manifestPath,"utf8")) as CurrentFilmMixedProvenance,clock=result.currentFilmMixedClock;
  expect(manifest.spec).toBe("hv-provenance/3.0");expect(manifest.shots[2]!.kind).toBe("reused");expect(manifest.shots[2]!.original.jobId).toBe(f.job.id);
  expect(manifest.shots[2]!.original.inputRevision).not.toBe(manifest.shots[2]!.inputRevision);expect(manifest.shots[2]!.recordedSpeechRevision).toBe(hash(f.job.currentFilmCheckpoint!.rows[1]!.record.clip.speech));
  expect(manifest.shots[2]!.recordedPictureRevision).toBe(f.job.currentFilmCheckpoint!.rows[1]!.record.clip.picturePerformance?.revision??null);
  expect(manifest.shots[2]!.targetPictureRevision).toBe(context.currentFilm.materialization.slots[2]!.recipe.picturePerformance?.revision??null);
  expect(manifest.shots[0]!.degraded).toBe(true);expect(createCurrentFilmMixedProvenance(context,checkpoint,clock,result.degradedShots)).toEqual(manifest);
  expect(validateCurrentFilmMixedProvenance(manifest,context,checkpoint,clock,result.degradedShots)).toEqual(manifest);
  const keys=new Set<string>();const walk=(value:unknown)=>{if(value&&typeof value==="object")for(const [key,child]of Object.entries(value)){keys.add(key);walk(child);}};walk(manifest);
  for(const privateKey of ["capture","observation","ranking","routes","routing","binding","origins","library","casting","direction","sourceFiles","ownedFiles","path","cost","renderRecord","speech","picturePerformance"])expect(keys.has(privateKey)).toBe(false);
  for(const mutate of [(value:CurrentFilmMixedProvenance)=>{value.shots[2]!.original.jobId=context.id;},(value:CurrentFilmMixedProvenance)=>{value.shots[2]!.recordedSpeechRevision="a".repeat(64);},(value:CurrentFilmMixedProvenance)=>{Object.assign(value,{privateCapture:{revision:"b".repeat(64)}});}]){const changed=structuredClone(manifest);mutate(changed);expect(()=>validateCurrentFilmMixedProvenance(changed,context,checkpoint,clock,result.degradedShots)).toThrow();}
},90000);

test("all-adopted actual final assembly measures each odd dissolve without restoring original directories",async()=>{
  const original=await f.renderFinal(),p=original.job.currentFilm!,id="mixed-assembler-final-adoption",choices=p.materialization.slots.map((_,ordinal)=>choice(p,original.receipt,ordinal,ordinal));
  const plan=compileCurrentFilmMixedJob(p,{origins:[bindOriginalEditSource(original.receipt)],choices}),owner:CurrentFilmMixedCheckpointContext={id,projectId:p.projectId,startedAt:new Date().toISOString(),currentFilm:plan,checkpointShots:0,checkpointFrame:0,routeDecisions:[]},rows:CurrentFilmMixedCheckpointRow[]=[];
  for(const slot of p.materialization.slots)rows.push({kind:"reused",ordinal:slot.ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,adoption:await copyCurrentFilmAdoption(plan,id,slot.ordinal,f.studio.paths.artifactRoot,access)});
  const complete=createCurrentFilmMixedCheckpoint(owner,rows),staged=stage(owner,complete),result=await assembleCurrentFilmMixedAsync(owner,complete,staged.root,staged.outDir,{access}),clock=result.currentFilmMixedClock;
  expect(existsSync(join(staged.root,p.projectId,original.job.id))).toBe(false);expect(clock.requestedOverlapFrames).toBe(15);expect(clock.effectiveOverlapFrames).toBe(15);
  expect(clock.frames).toBe(clock.rawFrames-15*(clock.spans.length-1));expect(clock.frames).toBe(original.job.output!.currentFilm!.assembly.frames);expect(clock.probe.audio.sampleRate).toBe(44100);
  expect(clock.spans.every(span=>span.execution.kind==="reused")).toBe(true);expect(readFileSync(result.srtPath)).toEqual(readFileSync(join(f.studio.paths.artifactRoot,p.projectId,original.job.id,"captions.srt")));
  expect(validateCurrentFilmMixedProvenance(JSON.parse(readFileSync(result.manifestPath,"utf8")),owner,complete,clock)).toMatchObject({spec:"hv-provenance/3.0"});
},180000);

test("changed or missing owned roles and altered original records refuse before assembly",async()=>{
  for(const mode of ["missing-poster","changed-audio"] as const){const staged=stage(context,checkpoint),slot=staged.assembly.slots[2]!,file=mode==="missing-poster"?slot.ownedFiles.poster!:slot.ownedFiles.audio!;
    expect(file).toBeDefined();const path=join(staged.root,file.path);
    if(mode==="missing-poster")unlinkSync(path);else{const bytes=Buffer.from(readFileSync(path));bytes[44]=bytes[44]!^1;writeFileSync(path,bytes);}
    await expect(assembleCurrentFilmMixedAsync(context,checkpoint,staged.root,staged.outDir,{access})).rejects.toThrow();expect(existsSync(join(staged.outDir,"export.mp4"))).toBe(false);
  }
  const changed=structuredClone(checkpoint),row=changed.rows[0]!;if(row.kind!=="generated")throw new Error("Use real fresh evidence.");row.record.clip.seed++;
  await expect(assembleCurrentFilmMixedAsync(context,reseal(changed),ownedRoot,outDir,{access})).rejects.toThrow();
  await expect(assembleCurrentFilmMixedAsync(context,checkpoint,ownedRoot,join(ownedRoot,"different-owner"),{access})).rejects.toThrow("exact target job");
  expect(sha(readFileSync(result.mp4Path))).toBe(result.currentFilmMixedClock.video.sha256);
},90000);

test("current access and cancellation are checked before media and after asynchronous render steps",async()=>{
  const staged=stage(context,checkpoint),controller=new AbortController();let checks=0;
  await expect(assembleCurrentFilmMixedAsync(context,checkpoint,staged.root,staged.outDir,{access:async()=>{throw new Error("Current target withdrawn.");}})).rejects.toThrow("withdrawn");
  expect(existsSync(join(staged.outDir,"export.mp4"))).toBe(false);
  await expect(assembleCurrentFilmMixedAsync(context,checkpoint,staged.root,staged.outDir,{signal:controller.signal,access:async()=>{checks++;if(existsSync(join(staged.outDir,"export.mp4")))controller.abort();}})).rejects.toThrow();
  expect(checks).toBeGreaterThan(3);expect(controller.signal.aborted).toBe(true);expect(existsSync(join(staged.outDir,"provenance.json"))).toBe(false);
  for(const slot of staged.assembly.slots)for(const file of Object.values(slot.ownedFiles))expect(sha(readFileSync(join(staged.root,file.path)))).toBe(file.sha256);
},90000);
