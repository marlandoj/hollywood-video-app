import {afterAll,beforeAll,expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {currentFilmSourceFixture} from "./current-film-source.fixture";
import {contentHash as hash} from "../../generator/src/capabilities";
import {copyCurrentFilmAdoption} from "../../generator/src/current-film-adoption-media";
import type {VideoClip} from "../../generator/src/index";
import {assembleAsync} from "../../assembler/src/index";
import {ProjectService} from "../../api/src/index";
import {processNextJob} from "../../queue/src/worker";
import type {JobInput} from "../../queue/src/index";
import {bindOriginalEditSource} from "../src/edit-jobs";
import {compileCurrentFilmMixedJob,type CurrentFilmReuseChoice} from "../src/current-film-mixed-jobs";
import {createCurrentFilmMixedCheckpoint,type CurrentFilmMixedCheckpoint,type CurrentFilmMixedCheckpointContext,type CurrentFilmMixedCheckpointRow} from "../src/current-film-mixed-context";
import {compileCurrentFilmJob,type CurrentFilmJobV2} from "../src/current-film-jobs";
import {currentFilmV2Job,type CurrentFilmV2Job} from "../src/current-film-job-context";
import {currentScreenplayHead,saveCurrentScreenplayProposal} from "../src/current-screenplay-library";
import {compileLivingScriptStructure,livingScriptStructureBoundary} from "../src/living-script-structure";
import {compileLivingScriptDocument} from "../src/living-script-document";
import {proposeShotPlanEvolution} from "../src/living-script-current-plan";
import {createCurrentDirectionRequest} from "../src/living-script-current-direction";
import {parseCurrentFilmProbe,type CurrentFilmMediaDigest} from "../src/current-film-clock";
import {createCurrentFilmMixedAssemblyClock,resolveCurrentFilmMixedAssembly,validateCurrentFilmMixedAssemblyClock,type CurrentFilmMixedAssembly,type CurrentFilmMixedAssemblyClock,type CurrentFilmMixedAssemblyEvidence} from "../src/current-film-mixed-clock";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,fresh:CurrentFilmV2Job,context:CurrentFilmMixedCheckpointContext,checkpoint:CurrentFilmMixedCheckpoint,assembly:CurrentFilmMixedAssembly,evidence:CurrentFilmMixedAssemblyEvidence,clock:CurrentFilmMixedAssemblyClock;
const digest=(path:string):CurrentFilmMediaDigest=>{const bytes=readFileSync(path);return {sha256:createHash("sha256").update(bytes).digest("hex"),bytes:bytes.length};};
const reseal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...body}=value;return {...body,revision:hash(body)} as T;};
function probe(path:string,args:string[]){const result=Bun.spawnSync(["ffprobe","-v","error",...args,"-of","json",path],{stdout:"pipe",stderr:"pipe"});if(result.exitCode)throw new Error(result.stderr.toString());return JSON.parse(result.stdout.toString());}
function choice(plan:CurrentFilmJobV2,receipt:typeof f.receipt,ordinal:number,sourceOrdinal:number):CurrentFilmReuseChoice {
  const slot=plan.materialization.slots[ordinal]!,source=currentFilmV2Job(receipt.job).currentFilmCheckpoint!.rows[sourceOrdinal]!;
  return {ordinal,inputRevision:slot.inputRevision,originId:receipt.revision,source:{receiptRevision:receipt.revision,ordinal:sourceOrdinal,logicalShotId:source.logicalShotId,renderId:source.renderId,inputRevision:source.inputRevision,recordRevision:source.record.revision}};
}
function publicClip(slot:CurrentFilmMixedAssembly["slots"][number]):VideoClip {
  // Use the actual old manifest's public metadata/cost for this generic assembler
  // fixture only. No new owning record, private capture or worker charge is made.
  const original=slot.originalRecord,manifest=JSON.parse(readFileSync(join(f.studio.paths.artifactRoot,original.projectId,original.jobId,"clips","manifest.json"),"utf8")) as VideoClip[];
  const saved=manifest.find(value=>value.renderRecord?.revision===original.revision);if(!saved)throw new Error("Actual original clip missing.");
  const {renderRecord:_record,...clip}=saved,files=slot.ownedFiles,root=f.studio.paths.artifactRoot;
  return {...clip,path:join(root,files.video.path),...(files.audio?{audioPath:join(root,files.audio.path)}:{}),...(files.poster?{posterPath:join(root,files.poster.path)}:{}),...(files.sourcePoster?{sourcePosterPath:join(root,files.sourcePoster.path)}:{})};
}
async function measure(context:CurrentFilmMixedCheckpointContext,checkpoint:CurrentFilmMixedCheckpoint,name:string){
  const assembly=resolveCurrentFilmMixedAssembly(context,checkpoint),clips=assembly.slots.map(publicClip);
  const result=await assembleAsync(clips,assembly.slots.map(slot=>slot.target.shot),join(f.studio.root,name),{fps:30,size:`${assembly.outputSize.width}x${assembly.outputSize.height}`,crossfadeSec:assembly.requestedOverlapFrames/30,projectId:assembly.projectId});
  const evidence:CurrentFilmMixedAssemblyEvidence={sourceFrames:clips.map(clip=>Number(probe(clip.path,["-select_streams","v:0","-count_frames","-show_entries","stream=nb_read_frames"]).streams[0].nb_read_frames)),effectiveOverlapFrames:assembly.effectiveOverlapFrames,reason:assembly.reason,
    probe:parseCurrentFilmProbe(probe(result.mp4Path,["-count_frames","-show_streams","-show_format"])),video:digest(result.mp4Path),captions:{srt:digest(result.srtPath),vtt:digest(result.vttPath)}};
  return {assembly,evidence,clock:createCurrentFilmMixedAssemblyClock(context,checkpoint,evidence),result};
}
beforeAll(async()=>{
  f=await currentFilmSourceFixture();
  const accepted=f.accept(),library=accepted.currentScreenplay!,head=currentScreenplayHead(library)!,state=head.state,document=state.context.plan.document,base=document.context.base;
  // The original fixture's last dialogue line is unterminated. Insert a real
  // leading scene, preserving all original physical lines and native identities.
  const patch=compileLivingScriptStructure(base,{baseRevision:base.revision,operations:[{id:"clock-leading-scene",kind:"insert",at:livingScriptStructureBoundary(base,1),text:"EXT. CLOCK - DAWN\nA golden clock gleams.\n\n"}]}),afterDocument=compileLivingScriptDocument({base:patch.after,ancestry:[...document.context.ancestry,patch]}),capacity={tier:"free" as const,maxShots:24 as const};
  const evolution=proposeShotPlanEvolution({previous:state.context.plan,lineage:state.context.lineage,originals:state.context.originals,beforeDocument:document,afterDocument,capacity,requestId:"mixed-clock-move-plan"});
  if(!evolution.review.candidate||evolution.review.conflicts.length)throw new Error("Clock fixture requires exact whole-scene correspondence.");
  const saved=saveCurrentScreenplayProposal(library,{id:"mixed-clock-target",label:"Lead into retained native dialogue",expectedHeadRevision:head.revision,beforeStateRevision:state.revision,afterDocument,capacity,planRequest:evolution.request,directionRequest:createCurrentDirectionRequest(state.direction,evolution.review.candidate,{id:"mixed-clock-direction",settings:[],lines:[],retired:[]})},library.version,Date.now());
  const p=compileCurrentFilmJob(saved.library,{kind:"proposal",revision:saved.proposal.revision},f.plan.request),projects=ProjectService.fromState({...f.projects.snapshot(),projects:[{...accepted,currentScreenplay:saved.library}]}),id="mixed-clock-actual-fresh";
  const input:JobInput={id,projectId:p.projectId,idempotencyKey:id,tier:p.render.tier,stage:p.render.stage,scriptVersion:p.materialization.script.version,scriptText:p.materialization.script.text,casting:p.target.state.casting.candidate!,providerPlan:p.render.providerPlan,currentFilm:p,rightsAttestedAt:f.project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:p.materialization.requestedFrames,costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:180000};
  f.store.enqueue(input);const actual=await processNextJob(f.store,f.studio.paths.artifactRoot,{...f.context,projects});if(actual?.status!=="done")throw new Error("Fresh comparison worker failed: "+actual?.failureReason);fresh=currentFilmV2Job(actual);
  const sourceOrdinal=f.job.currentFilmCheckpoint!.rows.findIndex(row=>Boolean(row.record.clip.speech)),targetOrdinal=p.materialization.slots.findIndex(slot=>slot.logicalShotId===f.plan.materialization.slots[sourceOrdinal]!.logicalShotId);
  if(targetOrdinal!==2||sourceOrdinal!==1)throw new Error("Clock fixture must move the measured source to a different parent address.");
  const plan=compileCurrentFilmMixedJob(p,{origins:[bindOriginalEditSource(f.receipt)],choices:[choice(p,f.receipt,targetOrdinal,sourceOrdinal)]});
  const adoption=await copyCurrentFilmAdoption(plan,fresh.id,targetOrdinal,f.studio.paths.artifactRoot,async()=>{});
  const rows:CurrentFilmMixedCheckpointRow[]=fresh.currentFilmCheckpoint!.rows.map(row=>row.ordinal===targetOrdinal?{kind:"reused",ordinal:row.ordinal,logicalShotId:row.logicalShotId,renderId:row.renderId,inputRevision:row.inputRevision,adoption}:{kind:"generated",...row});
  context={id:fresh.id,projectId:fresh.projectId,startedAt:fresh.startedAt,currentFilm:plan,checkpointShots:0,checkpointFrame:0,routeDecisions:rows.flatMap(row=>row.kind==="generated"?row.capture.routes:[])};
  checkpoint=createCurrentFilmMixedCheckpoint(context,rows);const measured=await measure(context,checkpoint,"mixed-clock-measured-preview");({assembly,evidence,clock}=measured);
  // This is actual generic assembly + independent counted evidence, not an
  // activated mixed worker. Both source and fresh comparison have real custody.
  expect(readFileSync(measured.result.srtPath)).toEqual(readFileSync(join(f.studio.paths.artifactRoot,fresh.projectId,fresh.id,"captions.srt")));
},240000);
afterAll(async()=>{await f?.close();});

test("complete mixed assembly detaches original records, target physical intent and exact copied roles",()=>{
  const before=hash({context,checkpoint,source:f.job}),reused=assembly.slots[2]!,generated=assembly.slots[1]!;
  expect(reused.execution.kind).toBe("reused");expect(generated.execution.kind).toBe("generated");
  expect(reused.originalRecord).toEqual(f.job.currentFilmCheckpoint!.rows[1]!.record);expect(reused.originalRecord.jobId).not.toBe(assembly.jobId);
  expect(generated.originalRecord).toEqual(fresh.currentFilmCheckpoint!.rows[1]!.record);
  expect(reused.target.inputRevision).not.toBe(reused.originalRecord.inputHash);expect(reused.target.renderId).toBe(reused.originalRecord.shotId);
  expect(reused.correspondence!.sourceOrdinal).toBe(1);expect(reused.correspondence!.targetOrdinal).toBe(2);
  expect(reused.correspondence!.lines.some(line=>line.source!.line!==line.target!.line)).toBe(true);
  expect(reused.target.pictureIntent).toEqual(context.currentFilm.materialization.slots[2]!.recipe.picturePerformance);
  for(const file of Object.values(reused.ownedFiles))expect(file.path.startsWith(`${assembly.projectId}/${assembly.jobId}/reused/`)).toBe(true);
  expect(assembly).toMatchObject({authority:"historical-only",mediaVerified:false,fps:30});
  const copy=resolveCurrentFilmMixedAssembly(context,checkpoint);copy.slots[0]!.originalRecord.clip.seed++;copy.slots[0]!.target.shot.prompt="changed returned copy";
  expect(hash({context,checkpoint,source:f.job})).toBe(before);expect(resolveCurrentFilmMixedAssembly(context,checkpoint)).toEqual(assembly);
},90000);

test("actual measured mixed media binds new frame positions, original native samples and exact captions",()=>{
  expect(clock.schema).toBe("hv-current-film-clock/3");expect(clock.checkpointRevision).toBe(checkpoint.revision);expect(clock.reason).toBe("measured-speech");expect(clock.effectiveOverlapFrames).toBe(0);
  expect(clock.spans.map(span=>[span.startFrame,span.endFrame])).toEqual(fresh.output!.currentFilm!.assembly.spans.map(span=>[span.startFrame,span.endFrame]));
  expect(clock.rawFrames).toBe(clock.frames);expect(clock.probe.audio.sampleRate).toBe(44100);expect(clock.outputSize).toEqual(context.currentFilm.render.outputSize);
  const reused=assembly.slots[2]!,report=reused.originalRecord.clip.speech!;
  expect(report.lines.filter(line=>line.source.text==="Welcome home.")).toHaveLength(2);
  for(const line of reused.correspondence!.spoken){expect(line.nativeSamples).not.toBeNull();const recorded=report.lines.find(value=>value.source.hash===line.source!.source.hash)!;
    expect(line.nativeSamples).toEqual({start:recorded.startSample,end:recorded.endSample});
    const start=clock.spans[2]!.startFrame,originalStart=f.job.output!.currentFilm!.assembly.spans[1]!.startFrame;
    expect(start).toBeGreaterThan(originalStart);expect(start*735+recorded.startSample-(originalStart*735+recorded.startSample)).toBe((start-originalStart)*735);
  }
  expect(clock.captions.srt).toEqual(evidence.captions.srt);expect(clock.video).toEqual(evidence.video);expect(clock.frames).toBe(fresh.output!.currentFilm!.assembly.frames);
  expect(validateCurrentFilmMixedAssemblyClock(context,checkpoint,clock)).toEqual(clock);
  const serialized=JSON.stringify(clock);expect(serialized).not.toContain('"currentFilmCheckpoint"');expect(serialized).not.toContain('"originalRecord"');expect(serialized).not.toContain('"binding":');
},90000);

test("actual silent final adoption retains the odd fifteen-frame dissolve and source-owned provenance",async()=>{
  const original=await f.renderFinal(),p=original.job.currentFilm!,id="mixed-clock-final-adoption",choices=p.materialization.slots.map((_,ordinal)=>choice(p,original.receipt,ordinal,ordinal));
  expect(original.job.currentFilmCheckpoint!.rows.every(row=>!row.record.clip.speech)).toBe(true);
  const plan=compileCurrentFilmMixedJob(p,{origins:[bindOriginalEditSource(original.receipt)],choices}),owner:CurrentFilmMixedCheckpointContext={id,projectId:p.projectId,startedAt:new Date().toISOString(),currentFilm:plan,checkpointShots:0,checkpointFrame:0,routeDecisions:[]},rows:CurrentFilmMixedCheckpointRow[]=[];
  for(const slot of p.materialization.slots)rows.push({kind:"reused",ordinal:slot.ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,adoption:await copyCurrentFilmAdoption(plan,id,slot.ordinal,f.studio.paths.artifactRoot,async()=>{})});
  const complete=createCurrentFilmMixedCheckpoint(owner,rows),actual=await measure(owner,complete,"mixed-clock-measured-final"),clock=actual.clock;
  expect(clock.requestedOverlapFrames).toBe(15);expect(clock.effectiveOverlapFrames).toBe(15);expect(clock.reason).toBe("requested-crossfade");expect(clock.frames).toBe(clock.rawFrames-15*(clock.spans.length-1));
  expect(clock.spans[1]!.startFrame).toBe(clock.spans[0]!.endFrame-15);expect(clock.probe.video.frames).toBe(original.job.output!.currentFilm!.assembly.frames);
  expect(clock.spans.every(span=>span.execution.kind==="reused")).toBe(true);expect(validateCurrentFilmMixedAssemblyClock(owner,complete,clock)).toEqual(clock);
  expect(readFileSync(actual.result.srtPath)).toEqual(readFileSync(join(f.studio.paths.artifactRoot,original.job.projectId,original.job.id,"captions.srt")));
},180000);

test("incomplete selections, substituted owning records, source counts and resealed clock facts reject",()=>{
  const prefix=createCurrentFilmMixedCheckpoint(context,checkpoint.rows.slice(0,1));expect(()=>resolveCurrentFilmMixedAssembly(context,prefix)).toThrow("every selected slot");
  for(const mutate of [
    (value:CurrentFilmMixedCheckpoint)=>{value.rows.reverse();},
    (value:CurrentFilmMixedCheckpoint)=>{value.jobId="wrong-target";},
    (value:CurrentFilmMixedCheckpoint)=>{const row=value.rows[2]!;if(row.kind==="reused")row.adoption.copies[0]!.owned.path="other/owner/video.mp4";},
  ]){const changed=structuredClone(checkpoint);mutate(changed);expect(()=>resolveCurrentFilmMixedAssembly(context,reseal(changed))).toThrow();}
  for(const mutate of [
    (value:CurrentFilmMixedAssemblyEvidence)=>{value.sourceFrames[0]!++;},
    (value:CurrentFilmMixedAssemblyEvidence)=>{value.sourceFrames.pop();},
    (value:CurrentFilmMixedAssemblyEvidence)=>{value.sourceFrames[0]=0;},
    (value:CurrentFilmMixedAssemblyEvidence)=>{value.effectiveOverlapFrames=15;},
    (value:CurrentFilmMixedAssemblyEvidence)=>{value.probe.video.width=32;},
    (value:CurrentFilmMixedAssemblyEvidence)=>{value.probe.video.durationTicks++;},
    (value:CurrentFilmMixedAssemblyEvidence)=>{value.probe.audio.sampleRate=48000 as 44100;},
  ]){const changed=structuredClone(evidence);mutate(changed);expect(()=>createCurrentFilmMixedAssemblyClock(context,checkpoint,changed)).toThrow();}
  for(const mutate of [
    (value:CurrentFilmMixedAssemblyClock)=>{value.schema="hv-current-film-clock/2" as typeof value.schema;},
    (value:CurrentFilmMixedAssemblyClock)=>{value.spans[0]!.startFrame++;},
    (value:CurrentFilmMixedAssemblyClock)=>{value.spans[0]!.ownedFilesRevision="a".repeat(64);},
    (value:CurrentFilmMixedAssemblyClock)=>{value.spans[0]!.execution.captureRevision="a".repeat(64);},
    (value:CurrentFilmMixedAssemblyClock)=>{value.checkpointRevision="b".repeat(64);},
    (value:CurrentFilmMixedAssemblyClock)=>{value.rawFrames++;},
    (value:CurrentFilmMixedAssemblyClock)=>{Object.assign(value,{extra:undefined});},
  ]){const changed=structuredClone(clock);mutate(changed);expect(()=>validateCurrentFilmMixedAssemblyClock(context,checkpoint,reseal(changed))).toThrow();}
},90000);

test("portable validation precedes getter reads and rejects hidden, sparse and nonfinite evidence",()=>{
  let reads=0;const hostile=structuredClone(context);Object.defineProperty(hostile,"currentFilm",{enumerable:true,get(){reads++;return context.currentFilm;}});
  expect(()=>resolveCurrentFilmMixedAssembly(hostile,checkpoint)).toThrow("portable");expect(reads).toBe(0);
  const hidden=structuredClone(evidence);Object.defineProperty(hidden,"secret",{value:1,enumerable:false});expect(()=>createCurrentFilmMixedAssemblyClock(context,checkpoint,hidden)).toThrow("portable");
  const sparse=structuredClone(evidence);delete sparse.sourceFrames[0];expect(()=>createCurrentFilmMixedAssemblyClock(context,checkpoint,sparse)).toThrow("portable");
  const nonfinite=structuredClone(evidence);nonfinite.sourceFrames[0]=Number.NaN;expect(()=>createCurrentFilmMixedAssemblyClock(context,checkpoint,nonfinite)).toThrow("portable");
  const oversized=structuredClone(clock);Object.assign(oversized,{extra:"x".repeat(16*1024**2)});expect(()=>validateCurrentFilmMixedAssemblyClock(context,checkpoint,oversized)).toThrow("portable");
});
