import {afterAll,beforeAll,expect,spyOn,test} from "bun:test";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {contentHash as hash} from "../../generator/src/capabilities";
import {createProviderPlan} from "../../generator/src/catalog";
import {currentCasting} from "../src/casting";
import {currentDirection,directionSettings} from "../src/direction";
import {bootstrapLivingScriptDocument,compileLivingScriptDocument,type LivingScriptDocument} from "../src/living-script-document";
import {bootstrapLivingScriptShotPlan} from "../src/living-script-shot-plan";
import {proposeShotPlanEvolution} from "../src/living-script-current-plan";
import {createCurrentDirectionRequest} from "../src/living-script-current-direction";
import {createLivingScriptStructureBase,compileLivingScriptStructure,livingScriptStructureBlock as block,livingScriptStructureBoundary as boundary,type LivingScriptStructureOperation} from "../src/living-script-structure";
import {renderShots} from "../src/shot-reuse";
import {compileShotRenderRecipe} from "../src/shot-render-recipe";
import {emptyCurrentScreenplayLibrary,bootstrapCurrentScreenplayLibrary,saveCurrentScreenplayProposal,acceptCurrentScreenplayProposal,currentScreenplayHead,type CurrentScreenplayLibrary,type CurrentScreenplayProposalRequest} from "../src/current-screenplay-library";
import {compileCurrentFilmJob,validateCurrentFilmJobPlan,resolveCurrentFilmJob,type CurrentFilmJobRequest,type CurrentFilmJobV2} from "../src/current-film-jobs";

const SCENE="INT. SAME - DAY\r\nSpud waves.\r\n\r\nSPUD\r\nWelcome, friend.\r\nCome inside.\r\n\r\n";
let studio:Awaited<ReturnType<typeof dubStudio>>,root:CurrentScreenplayLibrary,rootJob:CurrentFilmJobV2,at:number;
const reseal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...body}=value;return {...body,revision:hash(body)} as T;};
const request=(role:"preview"|"render"="preview",rich=true):CurrentFilmJobRequest=>({role,tier:"free",providerPlan:createProviderPlan(role==="preview"?"animatic":"final",5,undefined,role==="preview"?{HV_ANIMATIC_PROVIDER_POOL:JSON.stringify([rich?"mock":"legacy-mock"])}:{HV_PROVIDER_POOL:'["mock"]'})});
const compile=(library:CurrentScreenplayLibrary,now=at+100)=>compileCurrentFilmJob(library,{kind:"accepted",revision:library.headRevision!},request(),now);
beforeAll(async()=>{
  studio=await dubStudio(undefined,"Title: Current runtime\r\n\r\n"+SCENE+SCENE);
  const source=await inspectEditSource(studio.film,"Immutable runtime origin",studio.paths.artifactRoot,async()=>{}),project=studio.projects.snapshot().projects.find(row=>row.id===studio.owner.projectId)!,script=project.versions.find(row=>row.version===source.job.scriptVersion)!;
  const base=createLivingScriptStructureBase({projectId:project.id,version:script.version,text:script.text,locks:[]}),documentSource=bootstrapLivingScriptDocument(source,{base,ancestry:[]});at=Date.now();
  root=bootstrapCurrentScreenplayLibrary(emptyCurrentScreenplayLibrary(project.id),{id:"current-runtime-origin",label:"Retained worker origin",script,source,documentSource,originalPlan:bootstrapLivingScriptShotPlan(source,documentSource),baseline:{casting:currentCasting(project.id,project.castingHistory),direction:currentDirection(project.id,project.directionHistory)}},0,at).library;
  rootJob=compile(root);
},180000);
afterAll(async()=>{await studio?.close();});
function change(document:LivingScriptDocument,operations:LivingScriptStructureOperation[]):LivingScriptDocument {
  const patch=compileLivingScriptStructure(document.context.base,{baseRevision:document.context.base.revision,operations});return compileLivingScriptDocument({base:patch.after,ancestry:[...document.context.ancestry,patch]});
}
function propose(library:CurrentScreenplayLibrary,afterDocument:LivingScriptDocument,id:string):CurrentScreenplayProposalRequest {
  const head=currentScreenplayHead(library)!,state=head.state,capacity={tier:"free" as const,maxShots:24 as const},plan=proposeShotPlanEvolution({previous:state.context.plan,lineage:state.context.lineage,originals:state.context.originals,beforeDocument:state.context.plan.document,afterDocument,capacity,requestId:id+"-plan"});
  expect(plan.review.conflicts).toEqual([]);expect(plan.review.candidate).not.toBeNull();
  return {id,label:"Review "+id,expectedHeadRevision:head.revision,beforeStateRevision:state.revision,afterDocument,planRequest:plan.request,capacity,directionRequest:createCurrentDirectionRequest(state.direction,plan.review.candidate!,{id:id+"-direction",settings:[],lines:[],retired:plan.request.retired})};
}
function adopt(library:CurrentScreenplayLibrary,input:CurrentScreenplayProposalRequest,now:number){
  const saved=saveCurrentScreenplayProposal(library,input,library.version,now),accepted=acceptCurrentScreenplayProposal(saved.library,{id:input.id+"-acceptance",proposalRevision:saved.proposal.revision,expectedHeadRevision:input.expectedHeadRevision},saved.library.version,now+1);
  return {saved,accepted};
}
function replaceLine(library:CurrentScreenplayLibrary,text:string,id:string):LivingScriptDocument {
  const state=currentScreenplayHead(library)!.state,document=state.context.plan.document,line=document.lines.find(row=>row.id===state.context.plan.shots[0]!.recipe.dialogue[0]!.lineIds[0])!;
  return change(document,[{id,kind:"replace",block:block(document.context.base,line.line,line.line+1),text}]);
}

test("real worker-backed root reproduces every execution recipe while retaining immutable source identities and measured durations separately",()=>{
  const frozen=hash({root,job:studio.film}),slots=rootJob.materialization.slots,legacy=renderShots(studio.film,at);
  expect(rootJob.schema).toBe("hv-current-film-job/2");expect(rootJob.authority).toBe("historical-only");expect(slots.map(row=>row.shot)).toEqual(legacy);
  expect(slots).toHaveLength(2);expect(slots.map(row=>row.renderId)).toEqual(["shot-1-1","shot-2-1"]);expect(slots.map(row=>row.ordinal)).toEqual([0,1]);
  expect(slots[0]!.physical.spoken[0]!.lineId).not.toBe(slots[1]!.physical.spoken[0]!.lineId);expect(slots[0]!.physical.spoken[0]!.source.text).toBe(slots[1]!.physical.spoken[0]!.source.text);
  for(const [index,slot]of slots.entries()){
    expect(slot.recipe).toEqual(compileShotRenderRecipe({projectId:root.projectId,stage:"animatic",shot:legacy[index]!,sceneHeading:slot.heading,outputSize:"640x360",providerPlan:rootJob.render.providerPlan,richAnimaticProviders:[true]}));
    const observed=studio.film.output!.shotExecutions![index]!.capture!.observation.recipe;expect(slot.recipe.dispatch).toEqual(observed.dispatch);expect(slot.recipe.references).toEqual(observed.references);expect(slot.recipe.anchors).toEqual(observed.anchors);
    expect(slot.original!.sourceId).toBe(root.origin!.request.source.facts.id);expect(slot.original!.receiptRevision).toBe(root.origin!.request.source.revision);expect(slot.original!.renderId).toBe(studio.film.output!.shotRenders![index]!.shotId);
    expect(slot.original!.recordRevision).toBe(studio.film.output!.shotRenders![index]!.revision);expect(slot.plannedFrames).toBe(legacy[index]!.durationSec*30);expect(slot.requestedFrames).toBe(slot.plannedFrames);
    expect(slot.requestedFrames).not.toBe(root.origin!.request.originalPlan.shots[index]!.actual!.frames);expect(slot.baseRequestedFrames).toBe(root.origin!.request.originalPlan.shots[index]!.base.requestedFrames);
    const document=root.origin!.state.context.plan.document;for(const line of slot.physical.lines){const actual=document.lines.find(row=>row.id===line.lineId)!;expect(document.context.base.text.slice(line.start,line.end)).toBe(actual.text);expect(line.physicalLineId).toBe(actual.physicalLineId);}
  }
  expect(rootJob.materialization.requestedFrames).toBe(slots.reduce((sum,row)=>sum+row.plannedFrames,0));expect(rootJob.origins).toEqual([]);expect(rootJob.selection.every(row=>row.kind==="generate")).toBe(true);expect(rootJob.render.assembly.requestedCrossfadeFrames).toBe(0);
  expect(resolveCurrentFilmJob(rootJob).shots).toEqual(legacy);expect(validateCurrentFilmJobPlan(JSON.parse(JSON.stringify(rootJob)))).toEqual(rootJob);expect(hash({root,job:studio.film})).toBe(frozen);
},30000);

test("multiline replacement then equal-scene reorder and insertion compile exact current lines, order and inherited seeds without rewriting originals",()=>{
  const frozen=hash(root),first=adopt(root,propose(root,replaceLine(root,"Welcome back.\r\nStay for a while.\r\n","replace-line"),"multiline"),at+1),pending=compileCurrentFilmJob(first.saved.library,{kind:"proposal",revision:first.saved.proposal.revision},request(),at+2),one=first.accepted.library,head=currentScreenplayHead(one)!,document=head.state.context.plan.document;
  expect(pending.baseline.documentRevision).toBe(rootJob.materialization.documentRevision);expect(pending.materialization.documentRevision).not.toBe(pending.baseline.documentRevision);expect(pending.materialization.script.version).toBe(rootJob.materialization.script.version+1);
  expect(pending.materialization.slots[0]!.shot.dialogue[0]!.lines).toEqual(["Welcome back.","Stay for a while.","Come inside."]);
  expect(pending.materialization.slots.map(row=>[row.logicalShotId,row.renderId,row.baseSeed,row.original])).toEqual(rootJob.materialization.slots.map(row=>[row.logicalShotId,row.renderId,row.baseSeed,row.original]));
  const moved=change(document,[{id:"move-scene",kind:"move",block:block(document.context.base,document.scenes[1]!.startLine,document.scenes[1]!.endLine),to:boundary(document.context.base,document.scenes[0]!.startLine)}]),last=moved.lines.find(row=>row.id===head.state.context.plan.shots[0]!.recipe.dialogue[0]!.lineIds.at(-1))!,inserted=change(moved,[{id:"insert-spoken",kind:"insert",at:boundary(moved.context.base,last.line+1),text:"The garden is ready.\r\n"}]),second=adopt(one,propose(one,inserted,"move-insert"),at+10),two=compile(second.accepted.library),slots=two.materialization.slots;
  expect(slots.map(row=>row.renderId)).toEqual(["shot-2-1","shot-1-1"]);expect(slots.map(row=>row.sceneIndex)).toEqual([0,1]);expect(slots.map(row=>row.original)).toEqual([...rootJob.materialization.slots].reverse().map(row=>row.original));
  expect(slots[1]!.shot.dialogue[0]!.lines).toEqual(["Welcome back.","Stay for a while.","Come inside.","The garden is ready."]);expect(slots[1]!.physical.spoken.map(row=>row.source.text)).toEqual(slots[1]!.shot.dialogue[0]!.lines);
  expect(slots[1]!.physical.spoken.map(row=>row.lineId)).toEqual(second.accepted.acceptance.state.context.plan.shots[1]!.recipe.dialogue[0]!.lineIds);
  expect(slots.map(row=>row.inputRevision)).not.toEqual([...rootJob.materialization.slots].reverse().map(row=>row.inputRevision));expect(two.materialization.script.text).toBe(inserted.context.base.text);expect(two.materialization.retired).toEqual([]);
  expect(validateCurrentFilmJobPlan(pending)).toEqual(pending);expect(()=>compileCurrentFilmJob(second.accepted.library,pending.selector,request(),at+100)).toThrow(/current head/);expect(hash(root)).toBe(frozen);
},90000);

test("new slots and complete retirement registry remain separate from immutable original media",()=>{
  const doc=root.origin!.state.context.plan.document,text="EXT. NEW - NIGHT\r\nA lantern flickers.\r\n\r\n",added=change(doc,[{id:"insert-scene",kind:"insert",at:boundary(doc.context.base,doc.scenes[1]!.startLine),text}]),one=adopt(root,propose(root,added,"add-scene"),at+1).accepted.library,addedJob=compile(one),fresh=addedJob.materialization.slots.find(row=>row.original===null)!;
  expect(fresh.renderId).toMatch(/^shot-v2-[a-f0-9]{40}$/);expect(addedJob.materialization.slots).toHaveLength(3);expect(addedJob.selection).toHaveLength(3);expect(fresh.shot.dialogue).toEqual([]);
  const current=currentScreenplayHead(one)!.state.context.plan.document,scene=current.scenes.find(row=>row.id===fresh.sceneId)!,removed=change(current,[{id:"remove-scene",kind:"delete",block:block(current.context.base,scene.startLine,scene.endLine)}]),two=adopt(one,propose(one,removed,"retire-scene"),at+10).accepted.library,result=compile(two);
  expect(result.materialization.slots.map(row=>row.renderId)).toEqual(rootJob.materialization.slots.map(row=>row.renderId));expect(result.materialization.retired).toEqual([{logicalShotId:fresh.logicalShotId,renderId:fresh.renderId,retiredBy:expect.any(String)}]);expect(result.materialization.allocationsRevision).not.toBe(rootJob.materialization.allocationsRevision);
  const forged=structuredClone(result);forged.materialization.slots.push(fresh);forged.materialization=reseal(forged.materialization);expect(()=>validateCurrentFilmJobPlan(reseal(forged))).toThrow(/complete historical/);
},90000);

test("provider role, tier, actual duration fallback and explicit direction remain fully bound",()=>{
  const final=compileCurrentFilmJob(root,{kind:"accepted",revision:root.headRevision!},request("render"),at+100),fallback=compileCurrentFilmJob(root,{kind:"accepted",revision:root.headRevision!},request("preview",false),at+100),elevated=compileCurrentFilmJob(root,{kind:"accepted",revision:root.headRevision!},{...request("render"),tier:"elevated"},at+100);
  expect(final.render.outputSize).toEqual({width:1280,height:720});expect(elevated.render.outputSize).toEqual({width:1920,height:1080});expect(final.render.assembly.requestedCrossfadeFrames).toBe(15);expect(final.materialization.slots.every(row=>row.requestedFrames===row.plannedFrames)).toBe(true);
  expect(fallback.materialization.slots.every(row=>row.requestedFrames===30&&row.recipe.duration.fallback==="one-second-animatic")).toBe(true);expect(final.materialization.slots[0]!.inputRevision).not.toBe(rootJob.materialization.slots[0]!.inputRevision);expect(elevated.materialization.slots[0]!.inputRevision).not.toBe(final.materialization.slots[0]!.inputRevision);
  const after=replaceLine(root,"A carefully directed welcome.\r\n","directed-line"),input=propose(root,after,"directed"),candidate=proposeShotPlanEvolution({previous:root.origin!.state.context.plan,lineage:root.origin!.state.context.lineage,originals:root.origin!.state.context.originals,beforeDocument:root.origin!.state.context.plan.document,afterDocument:after,capacity:input.capacity,requestId:"directed-plan"}).review.candidate!;
  input.directionRequest=createCurrentDirectionRequest(root.origin!.state.direction,candidate,{id:"explicit-settings",settings:[{shotId:candidate.shots[0]!.id,settings:directionSettings({seed:90210,durationFrames:90,previewMove:"push-in"})}],lines:[],retired:[]});
  const saved=saveCurrentScreenplayProposal(root,input,root.version,at+1),directed=compileCurrentFilmJob(saved.library,{kind:"proposal",revision:saved.proposal.revision},request(),at+2).materialization.slots[0]!;
  expect(directed.baseSeed).toBe(rootJob.materialization.slots[0]!.baseSeed);expect(directed.shot.seed).toBe(90210);expect(directed.recipe.dispatch.params.seed).toBe(90210);expect(directed.plannedFrames).toBe(90);expect(directed.requestedFrames).toBe(90);expect(directed.recipe.dispatch.params.cameraMove).toBe("push-in");
  expect(()=>compileCurrentFilmJob(root,{kind:"accepted",revision:root.headRevision!},{...request(),role:"render"},at+1)).toThrow(/role and stage/);expect(()=>compileCurrentFilmJob(saved.library,{kind:"proposal",revision:saved.proposal.revision},request(),at)).toThrow(/predate/);
},60000);

test("a complete 25-slot elevated proposal cannot be silently truncated into a free-tier job",()=>{
  const state=root.origin!.state,document=state.context.plan.document,text=Array.from({length:23},(_,i)=>"EXT. NEW "+i+" - NIGHT\r\nA lantern flickers.\r\n\r\n").join(""),after=change(document,[{id:"many-scenes",kind:"insert",at:boundary(document.context.base,document.scenes[1]!.startLine),text}]),capacity={tier:"elevated" as const,maxShots:60 as const},plan=proposeShotPlanEvolution({previous:state.context.plan,lineage:state.context.lineage,originals:state.context.originals,beforeDocument:document,afterDocument:after,capacity,requestId:"large-plan"});
  expect(plan.review.conflicts).toEqual([]);expect(plan.review.candidate!.shots).toHaveLength(25);
  const saved=saveCurrentScreenplayProposal(root,{id:"many-slots",label:"Complete large inventory",expectedHeadRevision:root.headRevision!,beforeStateRevision:state.revision,afterDocument:after,planRequest:plan.request,capacity,directionRequest:createCurrentDirectionRequest(state.direction,plan.review.candidate!,{id:"large-direction",settings:[],lines:[],retired:[]})},root.version,at+1),selector={kind:"proposal" as const,revision:saved.proposal.revision},before=hash(saved.library);
  expect(()=>compileCurrentFilmJob(saved.library,selector,request(),at+2)).toThrow(/complete active.*never truncate/);
  const result=compileCurrentFilmJob(saved.library,selector,{...request(),tier:"elevated"},at+2);expect(result.materialization.slots).toHaveLength(25);expect(result.selection).toHaveLength(25);expect(new Set(result.selection.map(row=>row.renderId)).size).toBe(25);expect(result.materialization.slots.filter(row=>row.original===null)).toHaveLength(23);expect(hash(saved.library)).toBe(before);
},60000);

test("resealed omitted, reordered, forged inputs and invented reuse fail full historical replay",()=>{
  const corrupt:((job:CurrentFilmJobV2)=>void)[]=[
    job=>{job.materialization.slots.pop();job.selection.pop();},job=>{job.materialization.slots.reverse();},job=>{job.materialization.slots[1]!.renderId=job.materialization.slots[0]!.renderId;},
    job=>{job.materialization.slots[0]!.shot.prompt+=" A different frame.";},job=>{job.materialization.slots[0]!.recipe.dispatch.params.seed++;job.materialization.slots[0]!.recipe=reseal(job.materialization.slots[0]!.recipe);},
    job=>{job.materialization.slots[0]!.physical.spoken[0]!.lineId=job.materialization.slots[1]!.physical.spoken[0]!.lineId;},job=>{job.materialization.slots[0]!.requestedFrames++;},job=>{job.render.outputSize.width=320;},
    job=>{job.target.recordRevision="a".repeat(64);job.target=reseal(job.target);},job=>{job.selection[0]!.inputRevision="b".repeat(64);},job=>{(job.origins as unknown[]).push(job.materialization.slots[0]!.original);},job=>{job.materialization.retired.push({logicalShotId:job.materialization.slots[0]!.logicalShotId,renderId:job.materialization.slots[0]!.renderId,retiredBy:"c".repeat(64)});},
  ];
  for(const alter of corrupt){const job=structuredClone(rootJob);alter(job);job.materialization=reseal(job.materialization);expect(()=>validateCurrentFilmJobPlan(reseal(job))).toThrow(/complete historical/);}
  expect(()=>resolveCurrentFilmJob({...rootJob,schema:"hv-current-film-job/1"} as unknown as CurrentFilmJobV2)).toThrow(/version-two/);
},60000);

test("portable boundary refuses accessors without reads and preserves clone independence and canonical key order",()=>{
  const before=hash(rootJob),job=structuredClone(rootJob);let reads=0;Object.defineProperty(job.materialization.slots[0]!.shot,"prompt",{enumerable:true,get(){reads++;return "intrusion";}});expect(()=>validateCurrentFilmJobPlan(job)).toThrow(/accessors/);expect(reads).toBe(0);
  for(const extra of [undefined,NaN,Infinity,-0,()=>0,Symbol("bad")]){const value=structuredClone(rootJob);Object.assign(value,{extra});expect(()=>validateCurrentFilmJobPlan(value)).toThrow(/portable|exact/);}
  const sparse=structuredClone(rootJob);delete sparse.materialization.slots[0];expect(()=>validateCurrentFilmJobPlan(sparse)).toThrow(/dense/);
  const checked=validateCurrentFilmJobPlan(rootJob),resolved=resolveCurrentFilmJob(rootJob);checked.materialization.slots[0]!.shot.prompt="changed detached plan";resolved.shots[0]!.prompt="changed detached output";expect(hash(rootJob)).toBe(before);
  const reorder=(value:unknown):unknown=>Array.isArray(value)?value.map(reorder):value&&typeof value==="object"?Object.fromEntries(Object.entries(value).reverse().map(([key,item])=>[key,reorder(item)])):value;
  expect(validateCurrentFilmJobPlan(reorder(rootJob) as CurrentFilmJobV2)).toEqual(rootJob);
},30000);

test("historical replay uses the retained compilation time rather than a later wall clock or provider environment",()=>{
  const clock=spyOn(Date,"now").mockReturnValue(at+366*24*60*60*1000),previous=process.env.HV_ANIMATIC_PROVIDER_POOL;
  try {process.env.HV_ANIMATIC_PROVIDER_POOL='["unavailable-future-provider"]';expect(validateCurrentFilmJobPlan(rootJob)).toEqual(rootJob);expect(resolveCurrentFilmJob(rootJob).providerPlan).toEqual(rootJob.render.providerPlan);}
  finally {clock.mockRestore();if(previous===undefined)delete process.env.HV_ANIMATIC_PROVIDER_POOL;else process.env.HV_ANIMATIC_PROVIDER_POOL=previous;}
},30000);
