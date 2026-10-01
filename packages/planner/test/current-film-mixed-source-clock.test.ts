import {afterAll,beforeAll,expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {contentHash as hash} from "../../generator/src/capabilities";
import {copyCurrentFilmOrigins} from "../../generator/src/current-film-origins-media";
import {copyCurrentFilmAdoption} from "../../generator/src/current-film-adoption-media";
import {assembleCurrentFilmMixedAsync} from "../../assembler/src/index";
import {ProjectService} from "../../api/src/index";
import {DurableJobStore,type Job,type JobInput} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {currentFilmSourceFixture} from "./current-film-source.fixture";
import {currentFilmV2Job,type CurrentFilmV2Job} from "../src/current-film-job-context";
import {currentFilmV3Job} from "../src/current-film-runtime-context";
import {currentScreenplayHead,saveCurrentScreenplayProposal} from "../src/current-screenplay-library";
import {compileLivingScriptStructure,livingScriptStructureBoundary} from "../src/living-script-structure";
import {compileLivingScriptDocument} from "../src/living-script-document";
import {proposeShotPlanEvolution} from "../src/living-script-current-plan";
import {createCurrentDirectionRequest} from "../src/living-script-current-direction";
import {compileCurrentFilmJob,type CurrentFilmJobV2} from "../src/current-film-jobs";
import {compileCurrentFilmMixedJob,type CurrentFilmJobV3,type CurrentFilmReuseChoice} from "../src/current-film-mixed-jobs";
import {createCurrentFilmMixedCheckpoint,type CurrentFilmMixedCheckpointRow} from "../src/current-film-mixed-context";
import {createCurrentFilmMixedOutput,validateCurrentFilmMixedOutput,type CurrentFilmMixedJob} from "../src/current-film-mixed-job-context";
import {bindOriginalEditSource} from "../src/edit-jobs";
import {editOriginalJob} from "../src/edit-sources";
import {assertDeliverySourcePermission,deliveryBindingForJob} from "../src/delivery-jobs";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {currentFilmMixedSourceClock,validateCurrentFilmMixedSourceClock,CURRENT_FILM_MIXED_SOURCE_LIMITS,type CurrentFilmMixedSourceClock} from "../src/current-film-mixed-source-clock";

/** Every export records when it was assembled (HV-031-02); these fixtures fix one real instant. */
const assembledAt="2026-09-17T10:00:00.000Z";

let f:Awaited<ReturnType<typeof currentFilmSourceFixture>>,fresh:CurrentFilmV2Job,job:CurrentFilmMixedJob,clock:CurrentFilmMixedSourceClock;
const access=async()=>{};
const reseal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...body}=value;return {...body,revision:hash(body)} as T;};
function choice(plan:CurrentFilmJobV2,receipt:typeof f.receipt,ordinal:number,sourceOrdinal:number):CurrentFilmReuseChoice {
  const slot=plan.materialization.slots[ordinal]!,source=currentFilmV2Job(receipt.job).currentFilmCheckpoint!.rows[sourceOrdinal]!;
  return {ordinal,inputRevision:slot.inputRevision,originId:receipt.revision,source:{receiptRevision:receipt.revision,ordinal:sourceOrdinal,
    logicalShotId:source.logicalShotId,renderId:source.renderId,inputRevision:source.inputRevision,recordRevision:source.record.revision}};
}
/** Real original/fresh records, actual adoption copies and the explicit mixed
 * assembler. Domain completion qualifies historical metadata, not a V3 worker,
 * new provider custody, current permissions or atomic PostgreSQL publication. */
async function completed(plan:CurrentFilmJobV3,original:CurrentFilmV2Job,id:string,reused:Map<number,CurrentFilmReuseChoice>):Promise<CurrentFilmMixedJob>{
  const {output:_output,currentFilmCheckpoint:_checkpoint,...prior}=structuredClone(original),root=f.studio.paths.artifactRoot;
  const owner:CurrentFilmMixedJob={...prior,id,idempotencyKey:id,currentFilm:plan,status:"running",startedAt:id===original.id?original.startedAt:new Date().toISOString(),completedAt:null,linkExpiresAt:null,
    claimedBy:"source-clock-fixture",leaseExpiresAt:new Date(Date.now()+300000).toISOString(),checkpointShots:0,checkpointFrame:0,routeDecisions:[]};
  owner.currentFilmOrigins=await copyCurrentFilmOrigins(plan,id,root,access);
  const rows:CurrentFilmMixedCheckpointRow[]=[];
  for(const slot of plan.materialization.slots){
    if(reused.has(slot.ordinal))rows.push({kind:"reused",ordinal:slot.ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,
      adoption:await copyCurrentFilmAdoption(plan,id,slot.ordinal,root,access)});
    else {if(id!==original.id)throw new Error("Never rename a fresh original record in this fixture.");rows.push({kind:"generated",...original.currentFilmCheckpoint!.rows[slot.ordinal]!});}
  }
  owner.routeDecisions=rows.flatMap(row=>row.kind==="generated"?row.capture.routes:[]);
  owner.currentFilmCheckpoint=createCurrentFilmMixedCheckpoint(owner,rows);owner.checkpointShots=rows.length;
  owner.checkpointFrame=rows.reduce((sum,row)=>sum+(row.kind==="reused"?row.adoption.frames:Math.round(row.record.clip.durationSec*30)),0);
  const result=await assembleCurrentFilmMixedAsync(owner,owner.currentFilmCheckpoint,root,join(root,owner.projectId,id,"exports",crypto.randomUUID()),{assembledAt,access});
  const relative=(path:string)=>path.slice(root.length+1).replaceAll("\\","/");
  const output={mp4Path:relative(result.mp4Path),hlsPlaylistPath:relative(result.hlsPlaylistPath),captionsPath:relative(result.vttPath),manifestPath:relative(result.manifestPath),
    currentFilm:createCurrentFilmMixedOutput(owner,result.currentFilmMixedClock,[])};
  // A held V3 job completes through the store (HV-016-28).
  const done=DurableJobStore.fromJobs([owner as unknown as Job]).complete(id,"source-clock-fixture",output);
  expect(done.status).toBe("done");validateCurrentFilmMixedOutput(currentFilmV3Job(done),output);
  return currentFilmV3Job(done);
}
beforeAll(async()=>{
  f=await currentFilmSourceFixture();
  const accepted=f.accept(),library=accepted.currentScreenplay!,head=currentScreenplayHead(library)!,state=head.state,document=state.context.plan.document,base=document.context.base;
  const patch=compileLivingScriptStructure(base,{baseRevision:base.revision,operations:[{id:"source-clock-lead",kind:"insert",at:livingScriptStructureBoundary(base,1),text:"EXT. CLOCK - DAWN\nA golden clock gleams.\n\n"}]}),
    afterDocument=compileLivingScriptDocument({base:patch.after,ancestry:[...document.context.ancestry,patch]}),capacity={tier:"free" as const,maxShots:24 as const};
  const evolution=proposeShotPlanEvolution({previous:state.context.plan,lineage:state.context.lineage,originals:state.context.originals,beforeDocument:document,afterDocument,capacity,requestId:"mixed-source-plan"});
  if(!evolution.review.candidate||evolution.review.conflicts.length)throw new Error("Require exact whole-scene source correspondence.");
  const saved=saveCurrentScreenplayProposal(library,{id:"mixed-source-proposal",label:"Lead into retained speech",expectedHeadRevision:head.revision,beforeStateRevision:state.revision,afterDocument,capacity,
    planRequest:evolution.request,directionRequest:createCurrentDirectionRequest(state.direction,evolution.review.candidate,{id:"mixed-source-direction",settings:[],lines:[],retired:[]})},library.version);
  const plan=compileCurrentFilmJob(saved.library,{kind:"proposal",revision:saved.proposal.revision},f.plan.request),id="mixed-source-fresh";
  const projects=ProjectService.fromState({...f.projects.snapshot(),projects:[{...accepted,currentScreenplay:saved.library}]});
  const input:JobInput={id,projectId:plan.projectId,idempotencyKey:id,currentFilm:plan,tier:plan.render.tier,stage:plan.render.stage,
    scriptVersion:plan.materialization.script.version,scriptText:plan.materialization.script.text,casting:plan.target.state.casting.candidate!,providerPlan:plan.render.providerPlan,
    rightsAttestedAt:f.project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:plan.materialization.requestedFrames,costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:180000};
  f.store.enqueue(input);const actual=await processNextJob(f.store,f.studio.paths.artifactRoot,{...f.context,projects});
  if(actual?.status!=="done")throw new Error("Actual source comparison failed: "+actual?.failureReason);fresh=currentFilmV2Job(actual);
  const sourceOrdinal=f.job.currentFilmCheckpoint!.rows.findIndex(row=>Boolean(row.record.clip.speech)),targetOrdinal=plan.materialization.slots.findIndex(slot=>slot.logicalShotId===f.plan.materialization.slots[sourceOrdinal]!.logicalShotId);
  if(sourceOrdinal!==1||targetOrdinal!==2)throw new Error("This fixture must move actual repeated speech to a later physical address.");
  const selected=choice(plan,f.receipt,targetOrdinal,sourceOrdinal),mixed=compileCurrentFilmMixedJob(plan,{origins:[bindOriginalEditSource(f.receipt)],choices:[selected]});
  job=await completed(mixed,fresh,fresh.id,new Map([[targetOrdinal,selected]]));clock=currentFilmMixedSourceClock(job);
},300000);
afterAll(async()=>{await f?.close();});

test("complete actual mixed source keeps target intent, original records/captures and owned roles distinct",()=>{
  const before=hash({job,original:f.job}),reused=clock.spans[2]!,generated=clock.spans[0]!;
  expect(clock).toMatchObject({schema:"hv-current-film-mixed-source-clock/1",authority:"historical-only",mediaVerified:false,sourceId:job.id});
  expect(reused.execution.kind).toBe("reused");expect(reused.originalRecord).toEqual(f.job.currentFilmCheckpoint!.rows[1]!.record);expect(reused.originalCapture).toEqual(f.job.currentFilmCheckpoint!.rows[1]!.capture);
  expect(reused.originalRecord.jobId).not.toBe(job.id);expect(reused.target.inputRevision).not.toBe(reused.originalRecord.inputHash);
  expect(generated.execution.kind).toBe("generated");expect(generated.originalRecord).toEqual(fresh.currentFilmCheckpoint!.rows[0]!.record);expect(generated.originalCapture).toEqual(fresh.currentFilmCheckpoint!.rows[0]!.capture);
  expect(reused.correspondence!.lines.some(line=>line.source!.line!==line.target!.line)).toBe(true);
  for(const file of Object.values(reused.ownedFiles))expect(file.path.startsWith(`${job.projectId}/${job.id}/reused/`)).toBe(true);
  const copy=currentFilmMixedSourceClock(job);copy.spans[2]!.originalRecord.clip.seed++;copy.spans[0]!.originalCapture.routes.reverse();copy.spans[2]!.spoken[0]!.source.text="changed returned copy";
  expect(hash({job,original:f.job})).toBe(before);expect(currentFilmMixedSourceClock(job)).toEqual(clock);
},90000);

test("repeated equal text retains separate physical voices and exact globally rounded native positions",()=>{
  const span=clock.spans[2]!,lines=span.spoken.filter(line=>line.original.source.text==="Welcome home.");expect(lines).toHaveLength(2);
  expect(new Set(lines.map(line=>line.lineId)).size).toBe(2);expect(new Set(lines.map(line=>line.voiceId)).size).toBe(2);
  expect(span.startFrame).toBeGreaterThan(f.job.output!.currentFilm!.assembly.spans[1]!.startFrame);
  const round48=(native:number)=>Number((BigInt(native)*320n+73n)/147n);
  for(const value of span.spoken){
    const original=span.originalRecord.clip.speech!.lines.find(line=>line.source.hash===value.original.source.hash)!;
    expect(value.recordStartSample).toBe(original.startSample);expect(value.recordEndSample).toBe(original.endSample);
    expect(value.nativeStartSample).toBe(span.startFrame*735+original.startSample);expect(value.nativeEndSample).toBe(span.startFrame*735+original.endSample);
    expect(value.startSample).toBe(round48(value.nativeStartSample));expect(value.endSample).toBe(round48(value.nativeEndSample));
    expect(value.startSample).toBeLessThan(value.endSample);expect(value.endSample).toBeLessThanOrEqual(span.endSample);
    expect(value.pcmSha256).toBe(original.pcmSha256);expect(value.performedText).toBe(original.spokenText);
    expect(span.target.physical.spoken.find(line=>line.lineId===value.lineId)?.source).toEqual(value.source);
    expect(clock.voices.find(voice=>voice.id===value.voiceId)).toEqual({id:value.voiceId,lane:"dialogue",start:value.startSample,end:value.endSample});
  }
  expect(clock.spans.map(span=>[span.startFrame,span.endFrame])).toEqual(fresh.output!.currentFilm!.assembly.spans.map(span=>[span.startFrame,span.endFrame]));
  expect(readFileSync(join(f.studio.paths.artifactRoot,job.output!.captionsPath)).equals(readFileSync(join(f.studio.paths.artifactRoot,fresh.output!.captionsPath)))).toBe(true);
  expect(clock.isolatedDialogue).toBe(true);expect(clock.effectiveOverlapFrames).toBe(0);
},90000);

test("actual all-reused silent final preserves fifteen-frame overlaps without invented speech",async()=>{
  const source=await f.renderFinal(),sourceJob=currentFilmV2Job(source.job),plan=sourceJob.currentFilm;
  if(!plan)throw new Error("Require the validated final fixture's current-film plan.");
  const choices=plan.materialization.slots.map((_,ordinal)=>choice(plan,source.receipt,ordinal,ordinal));
  const mixed=compileCurrentFilmMixedJob(plan,{origins:[bindOriginalEditSource(source.receipt)],choices}),final=await completed(mixed,sourceJob,"mixed-source-final",new Map(choices.map(value=>[value.ordinal,value]))),value=currentFilmMixedSourceClock(final);
  expect(value.effectiveOverlapFrames).toBe(15);expect(value.frames).toBe(source.job.output!.currentFilm!.assembly.frames);expect(value.voices).toEqual([]);expect(value.isolatedDialogue).toBe(false);expect(value.unmeasuredAudio).toBe(true);
  for(const [i,span]of value.spans.entries()){expect(span.spoken).toEqual([]);expect(span.execution.kind).toBe("reused");expect(span.originalRecord.jobId).toBe(source.job.id);if(i)expect(value.spans[i-1]!.endFrame-span.startFrame).toBe(15);}
},240000);

test("incomplete output, journal, replaced origin, changed clock and lifetime refuse",()=>{
  for(const change of [
    (value:CurrentFilmMixedJob)=>{value.status="running";},(value:CurrentFilmMixedJob)=>{delete value.output;},
    (value:CurrentFilmMixedJob)=>{value.currentFilmCheckpoint!.rows.pop();},(value:CurrentFilmMixedJob)=>{value.routeDecisions=[];},
    (value:CurrentFilmMixedJob)=>{value.output!.currentFilm.assembly.spans[2]!.startFrame++;},
    (value:CurrentFilmMixedJob)=>{const row=value.currentFilmCheckpoint!.rows[2]!;if(row.kind==="reused")row.adoption.copies[0]!.owned.path="other/owner/video.mp4";},
    (value:CurrentFilmMixedJob)=>{value.completedAt=value.currentFilm.createdAt;value.startedAt=new Date(Date.parse(value.completedAt)+1).toISOString();},
    (value:CurrentFilmMixedJob)=>{value.linkExpiresAt=value.completedAt;},
  ]){const changed=structuredClone(job);change(changed);expect(()=>currentFilmMixedSourceClock(changed)).toThrow();}
  const old=structuredClone(job);old.completedAt=new Date(Date.parse(job.startedAt!)+1).toISOString();old.linkExpiresAt=new Date(Date.parse(old.completedAt)+1).toISOString();
  expect(currentFilmMixedSourceClock(old).sourceOutputRevision).toBe(clock.sourceOutputRevision); // Historical expiry is not current authority.
  expect(()=>currentFilmMixedSourceClock(f.job)).toThrow("explicit mixed");
},90000);

test("resealed physical/sample/capture edits and getter/oversized envelopes refuse",()=>{
  for(const change of [
    (value:CurrentFilmMixedSourceClock)=>{value.spans[2]!.spoken[0]!.lineId=value.spans[2]!.spoken[1]!.lineId;},
    (value:CurrentFilmMixedSourceClock)=>{value.spans[2]!.spoken[0]!.startSample++;},
    (value:CurrentFilmMixedSourceClock)=>{value.spans[2]!.originalCapture.observation.attempt++;},
    (value:CurrentFilmMixedSourceClock)=>{value.spans.reverse();},
  ]){const changed=structuredClone(clock);change(changed);expect(()=>validateCurrentFilmMixedSourceClock(reseal(changed),job)).toThrow("changed");}
  let reads=0;const hostile=structuredClone(job);Object.defineProperty(hostile,"currentFilm",{enumerable:true,get(){reads++;return job.currentFilm;}});
  expect(()=>currentFilmMixedSourceClock(hostile)).toThrow("portable");expect(reads).toBe(0);
  const huge={...clock,padding:"x".repeat(CURRENT_FILM_MIXED_SOURCE_LIMITS.outputBytes)};
  expect(()=>validateCurrentFilmMixedSourceClock(huge,hostile)).toThrow("portable");expect(reads).toBe(0);
  expect(validateCurrentFilmMixedSourceClock(clock,job)).toEqual(clock);
},90000);

test("a finished mixed film is refused by name as an editorial source and as a delivery source",async()=>{
  // HV-016-31: no crash and no bare discriminator mismatch; each refusal says what is unsupported.
  expect(job.status).toBe("done");
  expect(()=>editOriginalJob(job as unknown as Job)).toThrow(/mixed film.*cannot be used as an editorial source/);
  await expect(inspectEditSource(job as unknown as Job,"Mixed source",f.studio.paths.artifactRoot,async()=>{})).rejects.toThrow(/mixed film/);
  // Named before the generic "no longer available" and "Only a picture edit or an assembly" refusals.
  expect(()=>deliveryBindingForJob(job as unknown as Job,"local")).toThrow(/mixed film.*cannot be delivered from yet/);
  expect(()=>assertDeliverySourcePermission(job as unknown as Job,f.project)).toThrow(/mixed film.*cannot be delivered from yet/);
},90000);
