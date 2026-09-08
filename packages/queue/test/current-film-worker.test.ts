import {afterAll,beforeAll,expect,spyOn,test} from "bun:test";
import {copyFileSync,mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {createHash} from "node:crypto";
import {dirname,join} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {ProjectService,type PersistedState} from "../../api/src/index";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {createProviderPlan} from "../../generator/src/catalog";
import {contentHash} from "../../generator/src/capabilities";
import {DeterministicMockProvider,RichAnimaticProvider,type VideoClip} from "../../generator/src/index";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {currentCasting} from "../../planner/src/casting";
import {currentDirection} from "../../planner/src/direction";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {bootstrapLivingScriptDocument,compileLivingScriptDocument} from "../../planner/src/living-script-document";
import {bootstrapLivingScriptShotPlan} from "../../planner/src/living-script-shot-plan";
import {createLivingScriptStructureBase,compileLivingScriptStructure,livingScriptStructureBoundary} from "../../planner/src/living-script-structure";
import {proposeShotPlanEvolution} from "../../planner/src/living-script-current-plan";
import {createCurrentDirectionRequest} from "../../planner/src/living-script-current-direction";
import {currentScreenplayHead} from "../../planner/src/current-screenplay-library";
import {compileCurrentFilmJob,type CurrentFilmJobV2} from "../../planner/src/current-film-jobs";
import {createCurrentFilmPreviewReview,createCurrentFilmOutput,currentFilmRecordedFiles,createCurrentFilmCheckpoint,advanceCurrentFilmCheckpoint,validateCurrentFilmOutput,validateCurrentFilmClips} from "../../planner/src/current-film-job-context";
import {createCurrentFilmAssemblyClock} from "../../planner/src/current-film-clock";
import {sealCurrentFilmClip,verifyCurrentFilmMedia} from "../src/current-film-media";
import {DurableJobStore,type Job,type JobInput} from "../src/index";
import {processNextJob,type WorkerContext} from "../src/worker";

let studio:Awaited<ReturnType<typeof dubStudio>>,plan:CurrentFilmJobV2,state:PersistedState,opaque:string;
beforeAll(async()=>{
  studio=await dubStudio(undefined,"INT. FIRST - DAY\nSpud waves.\n\nSPUD\nWelcome, friend.\nCome inside.\n\nINT. SECOND - NIGHT\nSpud opens a gate.\n\nSPUD\nThe garden is ready.\n");
  const source=await inspectEditSource(studio.film,"Current-worker origin",studio.paths.artifactRoot,async()=>{}),project=studio.projects.snapshot().projects[0]!,script=project.versions.at(-1)!,base=createLivingScriptStructureBase({projectId:project.id,version:script.version,text:script.text,locks:[]}),documentSource=bootstrapLivingScriptDocument(source,{base,ancestry:[]});
  const origin=studio.projects.bootstrapCurrentScreenplay(studio.owner.token,{id:"worker-root",label:"Original current film",script,source,documentSource,originalPlan:bootstrapLivingScriptShotPlan(source,documentSource),baseline:{casting:currentCasting(project.id,project.castingHistory??[]),direction:currentDirection(project.id,project.directionHistory??[])}},0,{binding:bindOriginalEditSource(source),current:studio.film})!;
  const head=currentScreenplayHead(origin.library)!,context=head.state.context,patch=compileLivingScriptStructure(base,{baseRevision:base.revision,operations:[{id:"insert-current-scene",kind:"insert",at:livingScriptStructureBoundary(base,1),text:"EXT. NEW - NIGHT\nA blue lantern glows.\n\n"}]}),afterDocument=compileLivingScriptDocument({base:patch.after,ancestry:[patch]}),capacity={tier:"free" as const,maxShots:24 as const};
  const evolution=proposeShotPlanEvolution({previous:context.plan,lineage:context.lineage,originals:context.originals,beforeDocument:context.plan.document,afterDocument,capacity,requestId:"current-worker-plan"});expect(evolution.review.conflicts).toEqual([]);
  const saved=studio.projects.saveCurrentScreenplayProposal(studio.owner.token,{id:"worker-proposal",label:"New scene before retained scenes",expectedHeadRevision:head.revision,beforeStateRevision:head.state.revision,afterDocument,planRequest:evolution.request,capacity,directionRequest:createCurrentDirectionRequest(head.state.direction,evolution.review.candidate!,{id:"worker-direction",settings:[],lines:[],retired:[]})},origin.library.version)!;
  plan=compileCurrentFilmJob(saved.library,{kind:"proposal",revision:saved.proposal.revision},{role:"preview",tier:"free",providerPlan:createProviderPlan("animatic",5)});state=studio.projects.snapshot();opaque=plan.materialization.slots.find(slot=>slot.original===null)!.renderId;expect(opaque).toMatch(/^shot-v2-[a-f0-9]{40}$/);
},180000);
afterAll(async()=>{await studio?.close();});
function fixture(id:string,jobPlan=plan){const path=join(studio.root,id+"-queue.json"),store=new DurableJobStore(path),projects=ProjectService.fromState(state),input:JobInput={id,projectId:plan.projectId,idempotencyKey:id,tier:plan.render.tier,stage:jobPlan.render.stage,scriptVersion:jobPlan.materialization.script.version,scriptText:jobPlan.materialization.script.text,casting:jobPlan.target.state.casting.candidate!,providerPlan:jobPlan.render.providerPlan,currentFilm:jobPlan,rightsAttestedAt:state.projects[0]!.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:jobPlan.materialization.requestedFrames,costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:1,backoffMs:0},timeoutMs:300000};
  const context:WorkerContext={projects,ledger:new CostLedger(join(studio.root,id+"-ledger.json")),reviewQueue:new OperatorReviewQueue(join(studio.root,id+"-reviews.json"))};return {path,store,projects,input,context,manifest:join(studio.paths.artifactRoot,plan.projectId,id,"clips/manifest.json")};}

test("actual V2 worker dispatches the complete pending opaque-ID film and records measured speech/assembly without publishing its screenplay",async()=>{
  const f=fixture("current-complete"),before=contentHash(f.projects.snapshot()),generate=RichAnimaticProvider.prototype.generate,calls:{shotId:string;seed:number;dialogue:unknown}[]=[];
  const observed=spyOn(RichAnimaticProvider.prototype,"generate").mockImplementation(function(this:RichAnimaticProvider,...args:Parameters<typeof generate>){calls.push({shotId:args[2].shotId!,seed:args[1],dialogue:structuredClone(args[2].dialogue)});return generate.apply(this,args);});
  let done:Job;try{f.store.enqueue(f.input);done=(await processNextJob(f.store,studio.paths.artifactRoot,f.context))!;}finally{observed.mockRestore();}
  expect(done!.failureReason??done!.cancelReason).toBeUndefined();expect(done!.status).toBe("done");expect(calls.map(row=>row.shotId)).toContain(opaque);
  expect([...new Set(calls.map(row=>row.shotId))]).toEqual(plan.materialization.slots.map(slot=>slot.renderId));expect(done!.executionCheckpoints).toBeUndefined();expect(done!.output!.shotRenders).toBeUndefined();expect(done!.output!.shotExecutions).toBeUndefined();
  const checkpoint=done!.currentFilmCheckpoint!,output=done!.output!.currentFilm!,clips=JSON.parse(readFileSync(f.manifest,"utf8")) as VideoClip[];expect(checkpoint.rows).toHaveLength(plan.materialization.slots.length);expect(validateCurrentFilmClips(done!,clips,checkpoint)).toEqual(checkpoint);
  expect(output.checkpointRevision).toBe(checkpoint.revision);expect(output.records.map(row=>row.renderId)).toEqual(plan.materialization.slots.map(slot=>slot.renderId));expect(output.assembly.frames).toBe(done!.checkpointFrame);expect(output.assembly.probe.audio.sampleRate).toBe(44100);expect(output.assembly.reason).toBe("measured-speech");
  for(const [index,row]of checkpoint.rows.entries()){const slot=plan.materialization.slots[index]!;expect(row.inputRevision).toBe(slot.inputRevision);expect(row.record.inputHash).toBe(slot.inputRevision);expect(row.capture.observation.recipe).toEqual(slot.recipe);expect(row.capture.observation.emission.params.shotId).toBe(slot.renderId);expect(row.capture.routes).toEqual(row.capture.routeDecisionIds.map(id=>done!.routeDecisions!.find(route=>route.id===id)!));}
  expect(checkpoint.rows.some(row=>row.record.clip.speech?.lines.length)).toBe(true);expect(contentHash(f.projects.snapshot())).toBe(before);expect(new DurableJobStore(f.path).get(done!.id)).toEqual(done!);
  await expect(sealCurrentFilmClip(done!,plan.materialization.slots[0]!,clips[0]!,studio.paths.artifactRoot,new AbortController().signal)).rejects.toThrow("existing render record");
  assertAdversarialEvidence(done!);await assertMediaEvidence(done!);
  for(const file of [f.manifest,join(studio.paths.artifactRoot,done!.output!.manifestPath)]){expect(readFileSync(file,"utf8")).not.toContain("hv-shot-execution-capture/1");expect(readFileSync(file,"utf8")).not.toContain("hv-current-screenplay-library/1");}
},300000);

async function interrupt(id:string){const f=fixture(id),checkpoint=f.store.checkpoint.bind(f.store);let stopped=false;f.store.enqueue(f.input);const fault=spyOn(f.store,"checkpoint").mockImplementation((...args:Parameters<typeof checkpoint>)=>{const result=checkpoint(...args);if(!stopped){stopped=true;throw new Error("Stop after persisted current-film row");}return result;});
  let job:Job;try{job=(await processNextJob(f.store,studio.paths.artifactRoot,f.context))!;}finally{fault.mockRestore();}expect(stopped).toBe(true);expect(job!.status).toBe("queued");expect(job!.checkpointShots).toBe(1);return {...f,job:job!,clips:JSON.parse(readFileSync(f.manifest,"utf8")) as VideoClip[]};}
test("V2 interrupted resume preserves exact opaque first-row bytes and capture without redispatch",async()=>{
  const f=await interrupt("current-resume"),row=structuredClone(f.job.currentFilmCheckpoint!.rows[0]!),bytes=readFileSync(f.clips[0]!.path),generate=RichAnimaticProvider.prototype.generate,calls:string[]=[];
  const observed=spyOn(RichAnimaticProvider.prototype,"generate").mockImplementation(function(this:RichAnimaticProvider,...args:Parameters<typeof generate>){calls.push(args[2].shotId!);return generate.apply(this,args);});let done:Job;try{done=(await processNextJob(new DurableJobStore(f.path),studio.paths.artifactRoot,f.context))!;}finally{observed.mockRestore();}
  expect(done!.failureReason??done!.cancelReason).toBeUndefined();expect(done!.status).toBe("done");expect(calls).not.toContain(opaque);expect(done!.currentFilmCheckpoint!.rows[0]).toEqual(row);expect(readFileSync(f.clips[0]!.path)).toEqual(bytes);
},180000);
test("V2 resume refuses changed prefix media before any next provider dispatch",async()=>{
  const f=await interrupt("current-corrupt"),before=structuredClone(f.job.currentFilmCheckpoint),original=readFileSync(f.clips[0]!.path);writeFileSync(f.clips[0]!.path,"corrupt");const observed=spyOn(RichAnimaticProvider.prototype,"generate");
  try{const failed=(await processNextJob(new DurableJobStore(f.path),studio.paths.artifactRoot,f.context))!;expect(failed.status).toBe("failed");expect(failed.currentFilmCheckpoint).toEqual(before);expect(observed).not.toHaveBeenCalled();}finally{observed.mockRestore();writeFileSync(f.clips[0]!.path,original);}
},120000);

function reseal<T extends {revision:string}>(value:T):T{const {revision:_revision,...body}=value;return {...body,revision:contentHash(body)} as T;}
function assertAdversarialEvidence(job:Job){
  const checkpoint=job.currentFilmCheckpoint!,before=contentHash(job),rows=checkpoint.rows;
  expect(()=>createCurrentFilmCheckpoint(job,[rows[1]!,rows[0]!,...rows.slice(2)])).toThrow("slot order");
  const dropped=createCurrentFilmCheckpoint(job,rows.slice(0,-1));expect(()=>advanceCurrentFilmCheckpoint(job,dropped,dropped.rows.length,dropped.rows.reduce((sum,row)=>sum+Math.round(row.record.clip.durationSec*30),0))).toThrow("truncate");
  const changed=structuredClone(rows);changed[0]!.record.clip.fingerprint=(changed[0]!.record.clip.fingerprint==='a'.repeat(64)?'b':'a').repeat(64);const {schema:_schema,revision:_revision,...recordBody}=changed[0]!.record;changed[0]!.record.revision=contentHash(recordBody);changed[0]!.capture.recordRevision=changed[0]!.record.revision;changed[0]!.capture=reseal(changed[0]!.capture);
  const replaced=createCurrentFilmCheckpoint(job,changed);expect(()=>advanceCurrentFilmCheckpoint(job,replaced,job.checkpointShots,job.checkpointFrame)).toThrow("immutable");
  expect(()=>advanceCurrentFilmCheckpoint({...job,routeDecisions:[]},checkpoint,job.checkpointShots,job.checkpointFrame)).toThrow("durable journal");
  const wrong=structuredClone(checkpoint);wrong.rows[0]!.inputRevision='f'.repeat(64);expect(()=>advanceCurrentFilmCheckpoint(job,reseal(wrong),job.checkpointShots,job.checkpointFrame)).toThrow("slot order");
  const wrongClock=structuredClone(job.output!);wrongClock.currentFilm!.assembly.frames++;wrongClock.currentFilm!.assembly=reseal(wrongClock.currentFilm!.assembly);wrongClock.currentFilm=reseal(wrongClock.currentFilm!);expect(()=>validateCurrentFilmOutput(job,wrongClock)).toThrow("clock");
  for(const startedAt of [null,"not-a-date",new Date(Date.parse(job.currentFilm!.createdAt)-1).toISOString()])expect(()=>advanceCurrentFilmCheckpoint({...job,startedAt},checkpoint,job.checkpointShots,job.checkpointFrame)).toThrow();
  let reads=0;const hostile=structuredClone(checkpoint);Object.defineProperty(hostile.rows[0]!,"capture",{enumerable:true,get(){reads++;throw new Error("Accessor executed");}});expect(()=>advanceCurrentFilmCheckpoint(job,hostile,job.checkpointShots,job.checkpointFrame)).toThrow();expect(reads).toBe(0);expect(contentHash(job)).toBe(before);
}

test("V2 records actual fallback and repaired opaque-film dispatch against each exact canonical recipe",async()=>{
  const previous=process.env.HV_ANIMATIC_PROVIDER_POOL;process.env.HV_ANIMATIC_PROVIDER_POOL='["legacy-mock","mock"]';
  let fallback:CurrentFilmJobV2;try{fallback=compileCurrentFilmJob(plan.library,plan.selector,{...plan.request,providerPlan:createProviderPlan("animatic",5)});}finally{if(previous===undefined)delete process.env.HV_ANIMATIC_PROVIDER_POOL;else process.env.HV_ANIMATIC_PROVIDER_POOL=previous;}
  const f=fixture("current-fallback-repair",fallback!),first=fallback!.materialization.slots[0]!.renderId,second=fallback!.materialization.slots[1]!,generate=RichAnimaticProvider.prototype.generate;
  const failed=spyOn(DeterministicMockProvider.prototype,"generate").mockRejectedValue(new Error("Controlled current-film outage")),success=spyOn(RichAnimaticProvider.prototype,"generate").mockImplementation(async function(this:RichAnimaticProvider,...args:Parameters<typeof generate>){const clip=await generate.apply(this,args);return {...clip,fingerprint:(args[2].shotId===first?'0':'f').repeat(64)};});
  let done:Job;process.env.HV_ANIMATIC_PROVIDER_POOL='["legacy-mock","mock"]';try{f.store.enqueue(f.input);done=(await processNextJob(f.store,studio.paths.artifactRoot,f.context))!;}finally{failed.mockRestore();success.mockRestore();if(previous===undefined)delete process.env.HV_ANIMATIC_PROVIDER_POOL;else process.env.HV_ANIMATIC_PROVIDER_POOL=previous;}
  expect(done!.failureReason??done!.cancelReason).toBeUndefined();expect(done!.status).toBe("done");const captures=done!.currentFilmCheckpoint!.rows.map(row=>row.capture);
  expect(captures[0]!.routes.map(route=>route.selectedId)).toEqual(["legacy-mock","mock"]);expect(captures[0]!.observation).toMatchObject({attempt:0,providerIndex:1,fallbackIndex:1});expect(captures[1]!.observation).toMatchObject({attempt:2,providerIndex:1});
  expect(captures[1]!.observation.emission.seed).toBe(second.shot.seed+20000);expect(captures[1]!.observation.emission.params.seed).toBe(second.shot.seed);expect(captures.map(capture=>capture.observation.recipe)).toEqual(fallback!.materialization.slots.map(slot=>slot.recipe));validateCurrentFilmOutput(done!,done!.output!);expect(done!.costUsd).toBe(0);
},240000);

test("V2 withdraws whole-film current permission during the first provider wait before checkpoint or next dispatch",async()=>{
  const f=fixture("current-withdrawal"),generate=RichAnimaticProvider.prototype.generate;let calls=0;
  const observed=spyOn(RichAnimaticProvider.prototype,"generate").mockImplementation(async function(this:RichAnimaticProvider,...args:Parameters<typeof generate>){calls++;const clip=await generate.apply(this,args);const cast=currentCasting(plan.projectId,f.projects.snapshot().projects[0]!.castingHistory);f.projects.revokeCharacterPermission(studio.owner.token,cast.characters[0]!.id,cast.version);return clip;});
  let done:Job;try{f.store.enqueue(f.input);done=(await processNextJob(f.store,studio.paths.artifactRoot,f.context))!;}finally{observed.mockRestore();}
  expect(done!.status).not.toBe("done");expect(calls).toBe(1);expect(done!.checkpointShots).toBe(0);expect(done!.currentFilmCheckpoint).toBeUndefined();expect(done!.output).toBeUndefined();expect(done!.costUsd).toBe(0);expect(currentCasting(plan.projectId,f.projects.snapshot().projects[0]!.castingHistory).version).toBe(plan.target.state.casting.candidate!.version+1);
},120000);

async function assertMediaEvidence(job:Job){
  const restored=join(studio.root,"independent-current-media"),files=currentFilmRecordedFiles(job);for(const file of files){const target=join(restored,file.path);mkdirSync(dirname(target),{recursive:true});copyFileSync(join(studio.paths.artifactRoot,file.path),target);}
  await verifyCurrentFilmMedia(job,restored);expect(files.some(file=>file.path.endsWith(".srt"))).toBe(true);
  const changedAudio=structuredClone(job);changedAudio.output!.currentFilm!.assembly.probe.audio.durationTicks++;changedAudio.output!.currentFilm!.assembly=reseal(changedAudio.output!.currentFilm!.assembly);changedAudio.output!.currentFilm=reseal(changedAudio.output!.currentFilm!);validateCurrentFilmOutput(changedAudio,changedAudio.output!);await expect(verifyCurrentFilmMedia(changedAudio,restored)).rejects.toThrow("actual decoded media");
  const changedFrames=structuredClone(job),checkpoint=changedFrames.currentFilmCheckpoint!,first=checkpoint.rows[0]!;first.record.clip.durationSec+=1/30;const {schema:_schema,revision:_revision,...body}=first.record;first.record.revision=contentHash(body);first.capture.recordRevision=first.record.revision;first.capture=reseal(first.capture);changedFrames.currentFilmCheckpoint=createCurrentFilmCheckpoint(changedFrames,checkpoint.rows);changedFrames.checkpointFrame++;
  const old=job.output!.currentFilm!.assembly,probe=structuredClone(old.probe);probe.video.frames++;probe.video.durationTicks+=probe.video.timeBaseDenominator/(30*probe.video.timeBaseNumerator);
  const clock=createCurrentFilmAssemblyClock({projectId:job.projectId,jobId:job.id,jobPlanRevision:old.jobPlanRevision,materializationRevision:old.materializationRevision,requestedOverlapFrames:old.requestedOverlapFrames,effectiveOverlapFrames:old.effectiveOverlapFrames,reason:old.reason,rows:checkpoint.rows.map(({capture:_capture,...row})=>row),sourceFrames:old.spans.map((span,index)=>span.frames+(index===0?1:0)),probe,video:old.video,captions:{srt:old.captions.srt,vtt:old.captions.vtt}});
  changedFrames.output!.currentFilm=createCurrentFilmOutput(changedFrames,changedFrames.currentFilmCheckpoint,clock);validateCurrentFilmOutput(changedFrames,changedFrames.output!);expect(changedFrames.output!.currentFilm.assembly.video).toEqual(old.video);await expect(verifyCurrentFilmMedia(changedFrames,restored)).rejects.toThrow("decoded 30 fps frame count");
  const caption=join(restored,job.output!.captionsPath),original=readFileSync(caption);writeFileSync(caption,Buffer.from("changed caption bytes"));try{await expect(verifyCurrentFilmMedia(job,restored)).rejects.toThrow("recorded bytes");}finally{writeFileSync(caption,original);}
  await assertSpeechEvidence(job,restored);
  const cancelled=new AbortController();cancelled.abort(new Error("Stopped independent verification"));await expect(verifyCurrentFilmMedia(job,restored,cancelled.signal)).rejects.toThrow("Stopped independent verification");
}

test("actual current preview owner decision retries exactly, admits the opaque mock final and latest rejection stops old approval",async()=>{
  const f=fixture("current-reviewed-preview"),before=f.projects.snapshot().projects[0]!.versions;f.store.enqueue(f.input);const preview=(await processNextJob(f.store,studio.paths.artifactRoot,f.context))!;expect(preview.failureReason??preview.cancelReason).toBeUndefined();expect(preview.status).toBe("done");
  const review=createCurrentFilmPreviewReview(preview),decision=f.projects.recordCurrentFilmDecision(studio.owner.token,preview,review,"approved","Use the actual current film")!;expect(decision.replayed).toBe(false);const saved=f.projects.snapshot();expect(f.projects.recordCurrentFilmDecision(studio.owner.token,preview,review,"approved","Use the actual current film")!.replayed).toBe(true);expect(f.projects.snapshot()).toEqual(saved);
  const render=compileCurrentFilmJob(plan.library,plan.selector,{...plan.request,role:"render",providerPlan:createProviderPlan("final",5,undefined,{HV_PROVIDER_POOL:'["mock"]'})}),request={...fixture("current-reviewed-final",render).input,animaticJobId:preview.id,animaticApprovedAt:decision.approval.at};
  const oldPool=process.env.HV_PROVIDER_POOL;process.env.HV_PROVIDER_POOL='["mock"]';let final:Job;
  try{f.store.enqueue(request);final=(await processNextJob(f.store,studio.paths.artifactRoot,f.context))!;}finally{if(oldPool===undefined)delete process.env.HV_PROVIDER_POOL;else process.env.HV_PROVIDER_POOL=oldPool;}
  expect(final!.failureReason??final!.cancelReason).toBeUndefined();expect(final!.status).toBe("done");expect(final!.currentFilmCheckpoint!.rows.map(row=>row.renderId)).toContain(opaque);expect(final!.output!.currentFilm!.assembly).toMatchObject({requestedOverlapFrames:15,effectiveOverlapFrames:15,reason:"requested-crossfade"});expect(final!.output!.currentFilm!.assembly.frames).toBe(final!.checkpointFrame-15*(render.materialization.slots.length-1));await verifyCurrentFilmMedia(final!,studio.paths.artifactRoot);expect(f.projects.snapshot().projects[0]!.versions).toEqual(before);
  const changed=f.projects.recordCurrentFilmDecision(studio.owner.token,preview,review,"changes_requested","Revise the current cut")!;expect(changed.replayed).toBe(false);expect(f.projects.snapshot().projects[0]!.animaticApprovals.at(-1)!.decision).toBe("changes_requested");
  f.store.enqueue({...request,id:"current-stale-approval",idempotencyKey:"current-stale-approval",retryPolicy:{maxRetries:0,backoffMs:0}});const dispatch=spyOn(DeterministicMockProvider.prototype,"generate");try{const refused=(await processNextJob(f.store,studio.paths.artifactRoot,f.context))!;expect(refused.status).toBe("failed");expect(refused.checkpointShots).toBe(0);expect(refused.output).toBeUndefined();expect(dispatch).not.toHaveBeenCalled();}finally{dispatch.mockRestore();}
},300000);

async function assertSpeechEvidence(job:Job,root:string){
  const index=job.currentFilmCheckpoint!.rows.findIndex(row=>Boolean(row.record.clip.speech)),source=job.currentFilmCheckpoint!.rows[index]!.record,path=join(root,source.files.audio!.path),original=readFileSync(path),slot=job.currentFilm!.materialization.slots[index]!;
  expect(index).toBeGreaterThanOrEqual(0);
  for(const kind of ["header","line"] as const){
    const bytes=Buffer.from(original);bytes[kind==="header"?24:44+source.clip.speech!.lines[0]!.startSample*2]^=1;writeFileSync(path,bytes);
    try{
      const changed=structuredClone(job),row=changed.currentFilmCheckpoint!.rows[index]!;row.record.files.audio!.sha256=createHash("sha256").update(bytes).digest("hex");const {schema:_schema,revision:_revision,...body}=row.record;row.record.revision=contentHash(body);row.capture.recordRevision=row.record.revision;row.capture=reseal(row.capture);changed.currentFilmCheckpoint=createCurrentFilmCheckpoint(changed,changed.currentFilmCheckpoint!.rows);
      const old=job.output!.currentFilm!.assembly,clock=createCurrentFilmAssemblyClock({projectId:job.projectId,jobId:job.id,jobPlanRevision:old.jobPlanRevision,materializationRevision:old.materializationRevision,requestedOverlapFrames:old.requestedOverlapFrames,effectiveOverlapFrames:old.effectiveOverlapFrames,reason:old.reason,rows:changed.currentFilmCheckpoint.rows.map(({capture:_capture,...entry})=>entry),sourceFrames:old.spans.map(span=>span.frames),probe:old.probe,video:old.video,captions:{srt:old.captions.srt,vtt:old.captions.vtt}});
      changed.output!.currentFilm=createCurrentFilmOutput(changed,changed.currentFilmCheckpoint,clock);validateCurrentFilmOutput(changed,changed.output!);const error=kind==="header"?"WAV header":"line PCM";await expect(verifyCurrentFilmMedia(changed,root)).rejects.toThrow(error);
      const candidate:VideoClip={...source.clip,path:join(root,source.files.video.path),audioPath:path,...(source.files.poster?{posterPath:join(root,source.files.poster.path)}:{}),...(source.files.sourcePoster?{sourcePosterPath:join(root,source.files.sourcePoster.path)}:{}),cost:{provider:source.clip.provider,model:source.clip.model,prompt_tokens:0,output_frames:Math.round(source.clip.durationSec*30),gpu_seconds:0,total_cost_usd:0}};
      await expect(sealCurrentFilmClip(job,slot,candidate,root,new AbortController().signal)).rejects.toThrow(error);
    }finally{writeFileSync(path,original);}
  }
}

test("local V2 completion rejects an earlier media role overwritten after the last held checkpoint",async()=>{
  const f=fixture("current-late-overwrite"),checkpoint=f.store.checkpoint.bind(f.store);let changed:{path:string;bytes:Buffer}|undefined;
  const fault=spyOn(f.store,"checkpoint").mockImplementation((...args:Parameters<typeof checkpoint>)=>{const result=checkpoint(...args);if(args[2]===plan.materialization.slots.length){const record=f.store.get(f.input.id)!.currentFilmCheckpoint!.rows[0]!.record,path=join(studio.paths.artifactRoot,record.files.poster!.path),bytes=readFileSync(path),corrupt=Buffer.from(bytes);corrupt[corrupt.length-1]^=1;writeFileSync(path,corrupt);changed={path,bytes};}return result;});
  let done:Job;try{f.store.enqueue(f.input);done=(await processNextJob(f.store,studio.paths.artifactRoot,f.context))!;}finally{fault.mockRestore();if(changed)writeFileSync(changed.path,changed.bytes);}
  expect(changed).toBeDefined();expect(done!.status).not.toBe("done");expect(done!.currentFilmCheckpoint!.rows).toHaveLength(plan.materialization.slots.length);expect(done!.output).toBeUndefined();
},180000);
