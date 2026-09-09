import {afterAll,beforeAll,expect,spyOn,test} from "bun:test";
import {readFile} from "node:fs/promises";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {contentHash as hash} from "../../generator/src/capabilities";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {createProviderPlan} from "../../generator/src/catalog";
import {synthesizeLines,speechRuntimeRevision} from "../../generator/src/speech";
import {ProjectService} from "../../api/src/index";
import {DurableJobStore,type JobInput} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {bindOriginalEditSource,type EditSourceBinding} from "../src/edit-jobs";
import {compileCurrentFilmJob,type CurrentFilmJobV2} from "../src/current-film-jobs";
import {compileCurrentFilmMixedJob} from "../src/current-film-mixed-jobs";
import {currentFilmV2Job} from "../src/current-film-job-context";
import {currentScreenplayHead,saveCurrentScreenplayProposal,acceptCurrentScreenplayProposal,emptyCurrentScreenplayLibrary,bootstrapCurrentScreenplayLibrary,type CurrentScreenplayLibrary} from "../src/current-screenplay-library";
import {compileLivingScriptDocument,bootstrapLivingScriptDocument} from "../src/living-script-document";
import {bootstrapLivingScriptShotPlan} from "../src/living-script-shot-plan";
import {compileLivingScriptStructure,createLivingScriptStructureBase,livingScriptStructureBlock,livingScriptStructureBoundary} from "../src/living-script-structure";
import {proposeShotPlanEvolution} from "../src/living-script-current-plan";
import {createCurrentDirectionRequest} from "../src/living-script-current-direction";
import {directionSettings,currentDirection,type ShotDirection} from "../src/direction";
import {currentCasting} from "../src/casting";
import {compileShotRenderRecipe,type ShotRenderRecipe} from "../src/shot-render-recipe";
import {compilePerformances} from "../src/performances";
import {picturePerformance,picturePerformancePrompt,pictureBaseRevision} from "../src/picture-performance";
import {parseFountain} from "../../parser/src/index";
import {compileCurrentFilmRetainedExecution,validateCurrentFilmRetainedExecution,compileCurrentFilmExecutionProjection,validateCurrentFilmExecutionProjection,reviewCurrentFilmReuse,validateCurrentFilmReuseReview,type CurrentFilmSourceSelector,type CurrentFilmRetainedExecution} from "../src/current-film-reuse";

async function reuseFixture(){
  const studio=await dubStudio(undefined,"INT. GARDEN - DAY\r\n\r\nSpud waves.\r\n\r\nSPUD\r\nWelcome home.\r\nWelcome home.\r\n\r\n");
  try{
    const project=structuredClone(studio.projects.snapshot().projects[0]!),source=await inspectEditSource(studio.film,"Reuse root",studio.paths.artifactRoot,async()=>{}),script=project.versions.at(-1)!;
    const base=createLivingScriptStructureBase({projectId:project.id,version:script.version,text:script.text,locks:[]}),documentSource=bootstrapLivingScriptDocument(source,{base,ancestry:[]});
    const library=bootstrapCurrentScreenplayLibrary(emptyCurrentScreenplayLibrary(project.id),{id:"reuse-root",label:"Actual original",script,source,documentSource,originalPlan:bootstrapLivingScriptShotPlan(source,documentSource),baseline:{casting:currentCasting(project.id,project.castingHistory),direction:currentDirection(project.id,project.directionHistory)}},0,Date.now()).library;
    const head=currentScreenplayHead(library)!,state=head.state,document=state.context.plan.document,patch=compileLivingScriptStructure(base,{baseRevision:base.revision,operations:[{id:"insert-opaque-scene",kind:"insert",at:livingScriptStructureBoundary(base,1),text:"EXT. LANTERN - NIGHT\r\nA blue lantern glows.\r\n\r\n"}]}),afterDocument=compileLivingScriptDocument({base:patch.after,ancestry:[patch]}),capacity={tier:"free" as const,maxShots:24 as const};
    const evolution=proposeShotPlanEvolution({previous:state.context.plan,lineage:state.context.lineage,originals:state.context.originals,beforeDocument:document,afterDocument,capacity,requestId:"reuse-insert-plan"});
    if(!evolution.review.candidate||evolution.review.conflicts.length)throw new Error("Actual reuse fixture needs a resolved canonical plan.");
    const saved=saveCurrentScreenplayProposal(library,{id:"reuse-source",label:"Actual opaque source",expectedHeadRevision:head.revision,beforeStateRevision:state.revision,afterDocument,capacity,planRequest:evolution.request,directionRequest:createCurrentDirectionRequest(state.direction,evolution.review.candidate,{id:"reuse-source-direction",settings:[],lines:[],retired:[]})},library.version,Date.now());
    const plan=compileCurrentFilmJob(saved.library,{kind:"proposal",revision:saved.proposal.revision},{role:"preview",tier:"free",providerPlan:createProviderPlan("animatic",5,undefined,{...process.env,HV_ANIMATIC_PROVIDER_POOL:'["mock"]'})});
    const store=new DurableJobStore(join(studio.root,"reuse-jobs.json"));
    const run=async(p:CurrentFilmJobV2,lib:CurrentScreenplayLibrary,acceptedProject=project)=>{
      const projects=ProjectService.fromState({...studio.projects.snapshot(),projects:[{...acceptedProject,currentScreenplay:lib}]}),id=crypto.randomUUID();
      const input:JobInput={id,projectId:p.projectId,idempotencyKey:id,tier:p.render.tier,stage:p.render.stage,scriptVersion:p.materialization.script.version,scriptText:p.materialization.script.text,casting:p.target.state.casting.candidate!,providerPlan:p.render.providerPlan,currentFilm:p,rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:p.materialization.requestedFrames,costCapUsd:5,budgetReservedUsd:5,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:180000};
      store.enqueue(input);const job=await processNextJob(store,studio.paths.artifactRoot,{projects,ledger:studio.ledger,reviewQueue:studio.reviews});if(job?.status!=="done")throw new Error("Actual current-film reuse source failed: "+job?.failureReason);return currentFilmV2Job(job);
    };
    const job=await run(plan,saved.library),receipt=await inspectEditSource(job,"Actual reuse source",studio.paths.artifactRoot,async()=>{});
    const accept=()=>{const accepted=acceptCurrentScreenplayProposal(saved.library,{id:"reuse-source-accept",proposalRevision:saved.proposal.revision,expectedHeadRevision:head.revision},saved.library.version,Date.now());return {...structuredClone(project),currentScreenplay:accepted.library,versions:[...project.versions,...accepted.versions],castingHistory:[...(project.castingHistory??[]),accepted.acceptance.state.casting.candidate!]};};
    return {studio,plan,job,receipt,accept,run,close:()=>studio.close()};
  }catch(error){await studio.close();throw error;}
}
let fixture:Awaited<ReturnType<typeof reuseFixture>>,binding:EditSourceBinding,moved:CurrentFilmJobV2,retained:CurrentFilmRetainedExecution[],originalHash:string;
const targetProjects=new Map<string,Awaited<ReturnType<typeof reuseFixture>> extends {accept:()=>infer P}?P:never>();
const reseal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...body}=value;return {...body,revision:hash(body)} as T;};
const selector=(ordinal:number):CurrentFilmSourceSelector=>{const slot=fixture.plan.materialization.slots[ordinal]!,row=fixture.job.currentFilmCheckpoint!.rows[ordinal]!;return {receiptRevision:fixture.receipt.revision,ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recordRevision:row.record.revision};};
function target(id:string,settings?:ShotDirection):CurrentFilmJobV2 {
  const accepted=fixture.accept(),library=accepted.currentScreenplay!,head=currentScreenplayHead(library)!,state=head.state,document=state.context.plan.document,base=document.context.base,last=document.scenes.at(-1)!;
  const patch=compileLivingScriptStructure(base,{baseRevision:base.revision,operations:[{id:id+"-move",kind:"move",block:livingScriptStructureBlock(base,last.startLine,last.endLine),to:livingScriptStructureBoundary(base,document.scenes[0]!.startLine)}]}),afterDocument=compileLivingScriptDocument({base:patch.after,ancestry:[...document.context.ancestry,patch]}),capacity={tier:"free" as const,maxShots:24 as const};
  const evolution=proposeShotPlanEvolution({previous:state.context.plan,lineage:state.context.lineage,originals:state.context.originals,beforeDocument:document,afterDocument,capacity,requestId:id+"-plan"});
  expect(evolution.review.conflicts).toEqual([]);expect(evolution.review.candidate).not.toBeNull();
  const candidate=evolution.review.candidate!,saved=saveCurrentScreenplayProposal(library,{id,label:"Exact whole-scene move",expectedHeadRevision:head.revision,beforeStateRevision:state.revision,afterDocument,capacity,planRequest:evolution.request,directionRequest:createCurrentDirectionRequest(state.direction,candidate,{id:id+"-direction",settings:settings?[{shotId:candidate.shots[0]!.id,settings}]:[],lines:[],retired:[]})},library.version,Date.now());
  const result=compileCurrentFilmJob(saved.library,{kind:"proposal",revision:saved.proposal.revision},fixture.plan.request,Date.now());targetProjects.set(result.revision,accepted);return result;
}
beforeAll(async()=>{
  fixture=await reuseFixture();binding=bindOriginalEditSource(fixture.receipt);originalHash=hash({job:fixture.job,receipt:fixture.receipt});
  retained=fixture.plan.materialization.slots.map((_,ordinal)=>compileCurrentFilmRetainedExecution(binding,selector(ordinal)));moved=target("reuse-moved-scenes");
},180000);
afterAll(async()=>{await fixture?.close();});

test("actual worker source retains complete owned roles, captures and repeated native line samples without claiming custody",async()=>{
  expect(retained).toHaveLength(2);expect(retained.some(row=>row.source.renderId.startsWith("shot-v2-"))).toBe(true);
  for(const item of retained){
    const row=fixture.job.currentFilmCheckpoint!.rows[item.source.ordinal]!;
    expect(item.captureRevision).toBe(row.capture.revision);expect(item.files.map(file=>String(file.role)).sort()).toEqual(Object.keys(row.record.files).sort());
    expect(item.frames).toBe(fixture.job.output!.currentFilm!.assembly.spans[item.source.ordinal]!.frames);
    for(const file of item.files){const bytes=await readFile(join(fixture.studio.paths.artifactRoot,file.carrier.path));expect(bytes.byteLength).toBe(file.original.bytes);expect(createHash("sha256").update(bytes).digest("hex")).toBe(file.original.sha256);}
    expect(item).toMatchObject({authority:"historical-only",custody:"unverified",mediaVerified:false});expect(validateCurrentFilmRetainedExecution(item)).toEqual(item);
  }
  const speech=fixture.job.currentFilmCheckpoint!.rows.find(row=>row.record.clip.speech)!.record.clip.speech!;
  expect(speech.lines.map(line=>line.source.text)).toEqual(["Welcome home.","Welcome home."]);expect(speech.lines[0]!.source.hash).not.toBe(speech.lines[1]!.source.hash);expect(speech.lines[0]!.endSample).toBeLessThan(speech.lines[1]!.startSample);
},30000);

test("whole-scene structural movement changes physical provenance while exact captured payload, native speech and selected repair take remain equivalent",()=>{
  expect(moved.materialization.slots.map(slot=>slot.renderId)).toEqual([...fixture.plan.materialization.slots].reverse().map(slot=>slot.renderId));
  for(const item of retained){
    const ordinal=moved.materialization.slots.findIndex(slot=>slot.logicalShotId===item.source.logicalShotId),review=reviewCurrentFilmReuse(moved,ordinal,item),capture=fixture.job.currentFilmCheckpoint!.rows[item.source.ordinal]!.capture;
    expect(review.status).toBe("consistent");expect(review.differences).toEqual([]);expect(review.sourceProjection).toEqual(review.targetProjection!);expect(review.sourceProjection!.emission).toEqual(capture.observation.emission);
    expect(review.target.inputRevision).not.toBe(item.source.inputRevision);expect(review.target.recipeRevision).toBe(review.source.recipeRevision);
    expect(review.choice).toEqual({attempt:capture.observation.attempt,providerIndex:capture.observation.providerIndex,fallbackIndex:capture.observation.fallbackIndex});
    expect(review.correspondence.sourceOrdinal).not.toBe(review.correspondence.targetOrdinal);expect(review.correspondence.lines.every(line=>line.source!.line!==line.target!.line&&line.source!.lineId===line.target!.lineId)).toBe(true);
    expect(review.correspondence.spoken.every(line=>line.nativeSamples!==null&&line.source!.source.hash===line.target!.source.hash)).toBe(true);
    expect(review).toMatchObject({authority:"historical-only",custody:"unverified",mediaVerified:false});expect(validateCurrentFilmReuseReview(review,moved,item)).toEqual(review);
    expect(JSON.stringify(review)).not.toContain('"currentFilmCheckpoint"');expect(JSON.stringify(review)).not.toContain('"binding":');
  }
  expect(hash({job:fixture.job,receipt:fixture.receipt})).toBe(originalHash);
},60000);

test("real reviewed direction changes refuse old selected bytes for a changed seed, camera, duration or performed line",()=>{
  const source=retained.find(row=>fixture.plan.materialization.slots[row.source.ordinal]!.physical.spoken.length)!,slot=fixture.plan.materialization.slots[source.source.ordinal]!,line=slot.physical.spoken[0]!;
  const variants=[directionSettings({seed:slot.shot.seed+1}),directionSettings({previewMove:"push-in"}),directionSettings({durationFrames:90}),directionSettings({lines:[{index:0,sourceHash:line.source.hash,rateWpm:140,pitch:70,level:100,beforeMs:100,afterMs:200,notes:"A deliberate welcome."}]})];
  for(const [i,settings]of variants.entries()){
    const changed=target("reuse-settings-"+i,settings),review=reviewCurrentFilmReuse(changed,0,source);expect(review.status).toBe("different");expect(review.differences).toContain("emission");
    if(i===3){expect(review.differences).toContain("nativeSpeech");expect(review.correspondence.spoken.map(row=>row.lineId)).toEqual(slot.physical.spoken.map(row=>row.lineId));}
  }
},90000);

test("fresh execution of the reordered V2 target matches its projected actual capture and original still/native bytes",async()=>{
  // This runs the unchanged all-fresh V2 worker. It independently tests the pure
  // comparison; it does not claim that a mixed/reuse worker is integrated yet.
  const actual=await fixture.run(moved,moved.library,targetProjects.get(moved.revision)!);
  for(const item of retained){
    const ordinal=moved.materialization.slots.findIndex(slot=>slot.logicalShotId===item.source.logicalShotId),row=actual.currentFilmCheckpoint!.rows[ordinal]!,old=fixture.job.currentFilmCheckpoint!.rows[item.source.ordinal]!,observed=row.capture.observation;
    const projection=compileCurrentFilmExecutionProjection(moved.materialization.slots[ordinal]!.recipe,{attempt:observed.attempt,providerIndex:observed.providerIndex,fallbackIndex:observed.fallbackIndex});
    expect(projection.emission).toEqual(observed.emission);expect(observed.emission).toEqual(old.capture.observation.emission);
    for(const role of ["poster","sourcePoster","audio"] as const)if(old.record.files[role]){expect(row.record.files[role]!.sha256).toBe(old.record.files[role]!.sha256);expect(row.record.files[role]!.bytes).toBe(old.record.files[role]!.bytes);}
    expect(row.record.clip.speech??null).toEqual(old.record.clip.speech??null);expect(row.record.inputHash).not.toBe(old.record.inputHash);
  }
  expect(actual.output!.currentFilm!.assembly.spans.map(span=>span.logicalShotId)).toEqual(moved.materialization.slots.map(slot=>slot.logicalShotId));expect(hash({job:fixture.job,receipt:fixture.receipt})).toBe(originalHash);
},180000);

function recipe(change:(shot:CurrentFilmJobV2["materialization"]["slots"][number]["shot"])=>void,ordinal=1):ShotRenderRecipe {
  const slot=fixture.plan.materialization.slots[ordinal]!,shot=structuredClone(slot.shot);change(shot);
  return compileShotRenderRecipe({projectId:fixture.plan.projectId,stage:fixture.plan.render.stage,shot,sceneHeading:slot.heading,outputSize:"640x360",providerPlan:fixture.plan.render.providerPlan,richAnimaticProviders:[true]});
}
test("execution projection retains provider-visible IDs and emission omissions, all line settings and each actual repair ordinal",()=>{
  const row=fixture.job.currentFilmCheckpoint!.rows[1]!,choice={attempt:row.capture.observation.attempt,providerIndex:0,fallbackIndex:0},original=compileCurrentFilmExecutionProjection(row.capture.observation.recipe,choice);
  expect(original.emission).toEqual(row.capture.observation.emission);expect(original.nativeSpeech.kind).toBe("espeak-lines/1");
  const edits:Parameters<typeof recipe>[0][]=[shot=>{shot.id+="-renamed";},shot=>{shot.seed++;},shot=>{shot.prompt+=" A new lens.";},shot=>{shot.performances=compilePerformances(shot.dialogue,shot.performances);shot.performances[0]!.notes="Preserve this artistic note.";}];
  for(const edit of edits)expect(compileCurrentFilmExecutionProjection(recipe(edit),choice).revision).not.toBe(original.revision);
  const next=compileCurrentFilmExecutionProjection(row.capture.observation.recipe,{...choice,attempt:(choice.attempt+1)%3});expect(next.emission.seed).not.toBe(original.emission.seed);
  expect(original.emission.undefinedKeys).toContain("referenceFrames");expect(original.emission.undefinedKeys).toContain("frameAnchors");
  expect(validateCurrentFilmExecutionProjection(original,row.capture.observation.recipe,choice)).toEqual(original);
  expect(()=>compileCurrentFilmExecutionProjection(row.capture.observation.recipe,{...choice,attempt:3})).toThrow(/bounded/);
},30000);

test("the complete admitted provider route stays bound even when the first selected provider and emitted payload match",()=>{
  const providerPlan=createProviderPlan("animatic",5,undefined,{...process.env,HV_ANIMATIC_PROVIDER_POOL:'["mock","legacy-mock"]'}),expanded=compileCurrentFilmJob(moved.library,moved.selector,{...moved.request,providerPlan}),source=retained[1]!,review=reviewCurrentFilmReuse(expanded,0,source);
  expect(review.sourceProjection!.emission).toEqual(review.targetProjection!.emission);expect(review.status).toBe("different");expect(review.differences).toContain("providers");
  expect(review.targetProjection!.providers.plan.pool).toHaveLength(2);
  const historical=moved.target.state.context.originals[0]!,oldBinding=bindOriginalEditSource(historical);expect(()=>compileCurrentFilmRetainedExecution(oldBinding,{...selector(0),receiptRevision:historical.revision})).toThrow();
},30000);

test("silent and cue-only native projections match the actual no-synthesis path without eSpeak; spoken targets remain unavailable",async()=>{
  const before={executable:process.env.HV_ESPEAK_PATH,data:process.env.HV_ESPEAK_DATA_PATH};
  process.env.HV_ESPEAK_PATH=join(fixture.studio.root,"deliberately-missing-speech-runtime","espeak-ng");
  process.env.HV_ESPEAK_DATA_PATH=join(fixture.studio.root,"deliberately-missing-speech-data");
  try{
    expect(speechRuntimeRevision()).toBe("espeak-unavailable");
    const providerPlan=createProviderPlan("animatic",5,undefined,{...process.env,HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_NARRATION:"1"}),choice={attempt:0,providerIndex:0,fallbackIndex:0};
    expect(providerPlan.pool[0]!.snapshot.postProcessing).toContain("temporary-narration");expect(providerPlan.pool[0]!.snapshot.postProcessing).toContain("espeak-unavailable");
    const make=(dialogue:{character:string;lines:string[]}[])=>compileShotRenderRecipe({projectId:fixture.plan.projectId,stage:"animatic",shot:{id:"silent-projection",sceneIndex:0,prompt:"A lamp glows.",sourcePrompt:"A lamp glows.",seed:7,durationSec:2,dialogue},sceneHeading:"INT. ROOM - DAY",outputSize:"640x360",providerPlan,richAnimaticProviders:[true]});
    for(const dialogue of [[],[{character:"SPUD",lines:["(quietly)"]}]]){
      const original=make(dialogue),projection=compileCurrentFilmExecutionProjection(original,choice);
      if(original.providers.kind!=="pinned")throw new Error("The native projection fixture must retain its pinned provider plan.");
      expect(projection.nativeSpeech).toEqual({kind:"not-local-synthesis"});expect(projection.providers).toEqual(original.providers);
      expect(projection.emission.params.dialogue).toEqual(dialogue);expect(validateCurrentFilmExecutionProjection(projection,original,choice)).toEqual(projection);
      // This invokes the real synthesis implementation; its empty-line branch neither
      // reads a speech binary nor writes output, and preserves the requested picture clock.
      expect(await synthesizeLines(fixture.studio.root,dialogue,undefined,30,60,undefined,true,undefined,"espeak-unavailable")).toEqual({voice:false,frames:60,durationSec:2});
    }
    const spoken=[{character:"SPUD",lines:["Welcome home."]}];
    expect(()=>compileCurrentFilmExecutionProjection(make(spoken),choice)).toThrow("native speech execution contract is unavailable");
    await expect(synthesizeLines(fixture.studio.root,spoken,undefined,30,60,undefined,true,undefined,"espeak-unavailable")).rejects.toThrow("Install eSpeak NG");
    const target=compileCurrentFilmJob(moved.library,moved.selector,{...moved.request,providerPlan}),source=retained.find(row=>fixture.plan.materialization.slots[row.source.ordinal]!.physical.spoken.length)!,ordinal=target.materialization.slots.findIndex(slot=>slot.logicalShotId===source.source.logicalShotId),review=reviewCurrentFilmReuse(target,ordinal,source);
    expect(review.status).toBe("unavailable");expect(review.sourceProjection).not.toBeNull();expect(review.targetProjection).toBeNull();expect(review.differences).toContain("native-speech-contract");
    expect(()=>compileCurrentFilmMixedJob(target,{origins:[binding],choices:[{ordinal,inputRevision:target.materialization.slots[ordinal]!.inputRevision,originId:fixture.receipt.revision,source:source.source}]})).toThrow("cannot be adopted");
  }finally{
    if(before.executable===undefined)delete process.env.HV_ESPEAK_PATH;else process.env.HV_ESPEAK_PATH=before.executable;
    if(before.data===undefined)delete process.env.HV_ESPEAK_DATA_PATH;else process.env.HV_ESPEAK_DATA_PATH=before.data;
  }
},60000);

test("pure picture projection excludes only physical scene/memory binding while emitted artistic controls remain exact",()=>{
  const scene=parseFountain("INT. ROOM - DAY\nSPUD waves.").scenes[0]!,character={id:"74f87c10-a588-42a5-aa25-972719425f58",name:"SPUD",scenePerformances:[]},picture=picturePerformance([character],scene,[{characterId:character.id,baseRevision:pictureBaseRevision(character,scene),controls:{emotion:"calm"}}])!;
  const original=recipe(shot=>{shot.picturePerformance=picture;shot.prompt+="\n"+picturePerformancePrompt(picture);}),movedPicture=structuredClone(picture);movedPicture.sceneNumber++;movedPicture.sourceHash="a".repeat(64);movedPicture.characters[0]!.memoryRevision="b".repeat(64);
  const {schema:_schema,revision:_revision,...body}=movedPicture;movedPicture.revision=hash(body);
  const movedRecipe=recipe(shot=>{shot.picturePerformance=movedPicture;shot.prompt+="\n"+picturePerformancePrompt(movedPicture);}),choice={attempt:0,providerIndex:0,fallbackIndex:0};
  expect(original.revision).not.toBe(movedRecipe.revision);expect(compileCurrentFilmExecutionProjection(original,choice)).toEqual(compileCurrentFilmExecutionProjection(movedRecipe,choice));
  movedPicture.characters[0]!.controls.emotion="angry";const {schema:_s,revision:_r,...changed}=movedPicture;movedPicture.revision=hash(changed);
  const altered=recipe(shot=>{shot.picturePerformance=movedPicture;shot.prompt+="\n"+picturePerformancePrompt(movedPicture);});expect(compileCurrentFilmExecutionProjection(altered,choice).revision).not.toBe(compileCurrentFilmExecutionProjection(original,choice).revision);
},30000);

test("exact source selectors, original roles and captured input reject resealed omissions, invented authority and mutation",()=>{
  const edits:((value:CurrentFilmSourceSelector)=>void)[]=[value=>{value.ordinal=1-value.ordinal;},value=>{value.recordRevision="a".repeat(64);},value=>{value.inputRevision="b".repeat(64);},value=>{value.receiptRevision="c".repeat(64);},value=>{value.renderId+="-target";}];
  for(const edit of edits){const value=selector(0);edit(value);expect(()=>compileCurrentFilmRetainedExecution(binding,value)).toThrow(/selector/);}
  const missing=structuredClone(retained[0]!);missing.files.pop();expect(()=>validateCurrentFilmRetainedExecution(reseal(missing))).toThrow(/execution changed/);
  const review=reviewCurrentFilmReuse(moved,1,retained[0]!),forged=structuredClone(review);Object.assign(forged,{custody:"verified",mediaVerified:true});expect(()=>validateCurrentFilmReuseReview(reseal(forged),moved,retained[0]!)).toThrow(/review changed/);
  const plan=structuredClone(moved);plan.materialization.slots[0]!.recipe.dispatch.params.shotId="invented";plan.materialization.slots[0]!.recipe=reseal(plan.materialization.slots[0]!.recipe);plan.materialization=reseal(plan.materialization);expect(()=>reviewCurrentFilmReuse(reseal(plan),0,retained[1]!)).toThrow();
  const corrupted=structuredClone(binding);currentFilmV2Job(corrupted.source.job).currentFilmCheckpoint!.rows[0]!.capture.observation.emission.prompt+=" invented";expect(()=>compileCurrentFilmRetainedExecution(corrupted,selector(0))).toThrow();
  const copied=validateCurrentFilmRetainedExecution(retained[0]!);copied.files[0]!.original.sha256="d".repeat(64);expect(retained[0]!.files[0]!.original.sha256).not.toBe(copied.files[0]!.original.sha256);expect(hash({job:fixture.job,receipt:fixture.receipt})).toBe(originalHash);
},60000);

test("portable checks precede all access and historical replay ignores later clocks and provider environment",()=>{
  let reads=0;const hostile=structuredClone(binding);Object.defineProperty(hostile,"source",{enumerable:true,get(){reads++;return binding.source;}});expect(()=>compileCurrentFilmRetainedExecution(hostile,selector(0))).toThrow(/accessors/);expect(reads).toBe(0);
  for(const value of [undefined,NaN,-0,Infinity,Symbol("no"),()=>0]){const item=structuredClone(retained[0]!);Object.assign(item,{extra:value});expect(()=>validateCurrentFilmRetainedExecution(item)).toThrow(/portable/);}
  const sparse=structuredClone(retained[0]!);delete sparse.files[0];expect(()=>validateCurrentFilmRetainedExecution(sparse)).toThrow(/dense/);
  const clock=spyOn(Date,"now").mockReturnValue(Date.now()+366*86400000),previous=process.env.HV_ANIMATIC_PROVIDER_POOL;try{process.env.HV_ANIMATIC_PROVIDER_POOL='["not-installed"]';expect(reviewCurrentFilmReuse(moved,1,retained[0]!).status).toBe("consistent");}finally{clock.mockRestore();if(previous===undefined)delete process.env.HV_ANIMATIC_PROVIDER_POOL;else process.env.HV_ANIMATIC_PROVIDER_POOL=previous;}
},60000);
