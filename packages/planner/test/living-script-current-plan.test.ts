import {afterAll,beforeAll,expect,test} from "bun:test";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {contentHash as hash} from "../../generator/src/capabilities";
import type {EditSourceReceipt} from "../src/edit-sources";
import {bootstrapLivingScriptDocument,compileLivingScriptDocument,type LivingScriptDocument} from "../src/living-script-document";
import {bootstrapLivingScriptShotPlan,materializeLivingScriptBaseShots} from "../src/living-script-shot-plan";
import {createLivingScriptStructureBase,compileLivingScriptStructure,livingScriptStructureBlock as block,livingScriptStructureBoundary as boundary,livingScriptStructureLines,type LivingScriptStructureOperation} from "../src/living-script-structure";
import {bootstrapCurrentShotPlan,createCurrentShotPlanRequest,proposeShotPlanEvolution,reviewShotPlanEvolution,validateCurrentShotPlan,materializeCurrentShotPlan,CURRENT_SHOT_PLAN_LIMITS,type CurrentShotPlan,type CurrentShotPlanLineage,type CurrentShotPlanRequest,type CurrentShotPlanReview,type CurrentShotRecipe,type CurrentShotSlot} from "../src/living-script-current-plan";
import {livingScriptSceneViews,livingScriptDialogueGroup} from "../src/living-script-shot-recipe";
import {coverageSettings} from "../src/coverage";

const SCENE="INT. SAME - DAY\r\nSpud opens the gate.\r\n\r\nSPUD\r\nWelcome, friend.\r\nCome inside.\r\n\r\nSpud waves.\r\n\r\n";
const SCRIPT="Title: Current recipes\r\n\r\n"+SCENE+SCENE;
type State={plan:CurrentShotPlan;lineage:CurrentShotPlanLineage};
let fixture:Awaited<ReturnType<typeof dubStudio>>,source:EditSourceReceipt,initial:State;
const reseal=<T extends {revision:string}>(value:T):T=>{const {revision:_revision,...data}=value;return {...data,revision:hash(data)} as T;};
beforeAll(async()=>{
  fixture=await dubStudio(undefined,SCRIPT);source=await inspectEditSource(fixture.film,"Current-plan original",fixture.paths.artifactRoot,async()=>{});
  const base=createLivingScriptStructureBase({projectId:source.job.projectId,version:source.job.scriptVersion,text:source.job.scriptText,locks:[]}),binding=bootstrapLivingScriptDocument(source,{base,ancestry:[]}),original=bootstrapLivingScriptShotPlan(source,binding);
  initial=bootstrapCurrentShotPlan(source,original,binding);
},180000);
afterAll(async()=>{await fixture?.close();});
function change(state:State,operations:LivingScriptStructureOperation[]):LivingScriptDocument {
  const before=state.plan.document,base=before.context.base,patch=compileLivingScriptStructure(base,{baseRevision:base.revision,operations});return compileLivingScriptDocument({base:patch.after,ancestry:[...before.context.ancestry,patch]});
}
const args=(state:State,afterDocument=state.plan.document)=>({previous:state.plan,lineage:state.lineage,originals:[source],beforeDocument:state.plan.document,afterDocument,capacity:{tier:"free" as const,maxShots:24 as const}});
const suggest=(state:State,after:LivingScriptDocument,id:string)=>proposeShotPlanEvolution({...args(state,after),requestId:id});
function accept(review:CurrentShotPlanReview):State {expect(review.conflicts).toEqual([]);expect(review.candidate).not.toBeNull();expect(review.proposedLineage).not.toBeNull();return {plan:review.candidate!,lineage:review.proposedLineage!};}
const material=(state:State)=>materializeCurrentShotPlan(state.plan,state.plan.document,state.lineage,[source]);
function review(state:State,after:LivingScriptDocument,scenes:CurrentShotPlanRequest["scenes"],retired:CurrentShotPlanRequest["retired"]=[],id="owner-review") {
  return reviewShotPlanEvolution({...args(state,after),request:createCurrentShotPlanRequest(state.plan,after,{id,scenes,retired})});
}

test("real retained root reproduces every base shot and preserves complete original provenance without a reuse grant",()=>{
  const {originalPlan,documentSource}=initial.lineage.root,unchanged=hash({source,initial}),actual=material(initial);
  expect(actual).toEqual(materializeLivingScriptBaseShots(source,originalPlan,documentSource));expect(initial.plan.shots).toHaveLength(4);
  expect(initial.plan.shots.map(row=>row.renderId)).toEqual(["shot-1-1","shot-1-2","shot-2-1","shot-2-2"]);
  expect(initial.plan.allocations.map(row=>row.id)).toEqual(initial.plan.shots.map(row=>row.id));expect(initial.plan.allocations.every(row=>row.retiredBy===null)).toBe(true);
  expect(initial.plan.shots[0]!.requestedFrames).toBe(originalPlan.shots[0]!.base.requestedFrames);expect(originalPlan.shots[0]!.actual!.frames).not.toBe(initial.plan.shots[0]!.requestedFrames);
  expect(initial.plan.shots[0]!.id).not.toBe(initial.plan.shots[2]!.id);expect(initial.plan.scenes[0]!.sceneId).not.toBe(initial.plan.scenes[1]!.sceneId);
  expect(validateCurrentShotPlan(JSON.parse(JSON.stringify(initial.plan)),JSON.parse(JSON.stringify(initial.lineage)),[source])).toEqual(initial.plan);expect(hash({source,initial})).toBe(unchanged);
});

test("bootstrap rejects a valid moved source binding so original-to-current evolution cannot be skipped",()=>{
  const {originalPlan}=initial.lineage.root,document=initial.plan.document,a=document.scenes[0]!,b=document.scenes[1]!,base=document.context.base,moved=change(initial,[{id:"pre-bootstrap-move",kind:"move",block:block(base,b.startLine,b.endLine),to:boundary(base,a.startLine)}]),binding=bootstrapLivingScriptDocument(source,moved.context);
  // This is a legitimate /1 current-document materialization, but not a /2 origin.
  expect(materializeLivingScriptBaseShots(source,originalPlan,binding).map(row=>row.id)).toEqual(["shot-2-1","shot-2-2","shot-1-1","shot-1-2"]);
  expect(()=>bootstrapCurrentShotPlan(source,originalPlan,binding)).toThrow(/exact original root document/);
  const lineage=reseal({...initial.lineage,root:{originalPlan,documentSource:binding}});expect(()=>validateCurrentShotPlan(initial.plan,lineage,[source])).toThrow(/exact original root document/);
  const reviewed=accept(suggest(initial,moved,"explicit-origin-evolution").review);expect(reviewed.lineage.steps).toHaveLength(1);expect(reviewed.plan.allocations).toEqual(initial.plan.allocations);
});

test("three successive multiline replacement, equal-scene reorder and dialogue insertion retain IDs/seeds while materializing exact current text",()=>{
  const frozen=hash({source,initial}),oldLine=initial.plan.shots[0]!.recipe.dialogue[0]!.lineIds[0]!,physical=initial.plan.document.lines.find(line=>line.id===oldLine)!,base=initial.plan.document.context.base;
  const firstDoc=change(initial,[{id:"replace-spoken-line",kind:"replace",block:block(base,physical.line,physical.line+1),text:"A different welcome.\r\nStay for a while.\r\n"}]),one=suggest(initial,firstDoc,"multiline"),first=accept(one.review);
  expect(one).toEqual(suggest(initial,firstDoc,"multiline"));expect(first.plan.shots.map(row=>[row.id,row.renderId,row.seed])).toEqual(initial.plan.shots.map(row=>[row.id,row.renderId,row.seed]));
  expect(material(first)[0]!.dialogue[0]!.lines).toEqual(["A different welcome.","Stay for a while.","Come inside."]);
  expect(one.review.mapping.shots.map(row=>row.treatment)).toEqual(["revised","unchanged","unchanged","unchanged"]);
  const replacement=one.review.mapping.relations.find(row=>row.kind==="replace")!;expect(replacement.beforeLineIds).toEqual([oldLine]);expect(replacement.afterLineIds).toHaveLength(2);expect(replacement.afterLineIds).not.toContain(oldLine);
  expect(one.review.mapping.lines.find(row=>row.lineId===oldLine)!.treatment).toBe("removed");expect(replacement.afterLineIds.every(id=>one.review.mapping.lines.find(row=>row.lineId===id)?.treatment==="introduced")).toBe(true);
  const secondScene=first.plan.document.scenes[1]!,firstScene=first.plan.document.scenes[0]!,nextBase=first.plan.document.context.base,secondDoc=change(first,[{id:"move-equal-scene",kind:"move",block:block(nextBase,secondScene.startLine,secondScene.endLine),to:boundary(nextBase,firstScene.startLine)}]),two=suggest(first,secondDoc,"reorder"),second=accept(two.review);
  expect(two.request.scenes).toEqual([]);expect(second.plan.shots.map(row=>row.id)).toEqual([first.plan.shots[2]!.id,first.plan.shots[3]!.id,first.plan.shots[0]!.id,first.plan.shots[1]!.id]);
  expect(material(second).map(({sceneIndex:_index,...row})=>row)).toEqual([material(first)[2],material(first)[3],material(first)[0],material(first)[1]].map(row=>{const {sceneIndex:_index,...rest}=row!;return rest;}));
  expect(two.review.mapping.shots.every(row=>row.treatment==="moved")).toBe(true);
  const keepLine=second.plan.shots[2]!.recipe.dialogue[0]!.lineIds.at(-1)!,last=second.plan.document.lines.find(row=>row.id===keepLine)!,thirdDoc=change(second,[{id:"insert-dialogue",kind:"insert",at:boundary(second.plan.document.context.base,last.line+1),text:"The garden is ready.\r\n"}]),three=suggest(second,thirdDoc,"more-dialogue"),third=accept(three.review);
  expect(material(third)[2]!.dialogue[0]!.lines).toEqual(["A different welcome.","Stay for a while.","Come inside.","The garden is ready."]);
  expect(third.plan.allocations).toEqual(initial.plan.allocations);expect(third.lineage.steps.map(step=>step.request.id)).toEqual(["multiline","reorder","more-dialogue"]);
  expect(validateCurrentShotPlan(third.plan,third.lineage,[source])).toEqual(third.plan);expect(hash({source,initial})).toBe(frozen);
});

test("new and deleted scene proposals allocate locally, retain retirement history and never resurrect equal text",()=>{
  const base=initial.plan.document.context.base,at=initial.plan.document.scenes[1]!.startLine,text="EXT. NEW - NIGHT\r\nSpud looks up.\r\n\r\n",addedDoc=change(initial,[{id:"new-scene",kind:"insert",at:boundary(base,at),text}]),addedProposal=suggest(initial,addedDoc,"add-plan"),added=accept(addedProposal.review),newRow=added.plan.shots.find(row=>!initial.plan.shots.some(old=>old.id===row.id))!;
  expect(newRow.renderId).toMatch(/^shot-v2-[a-f0-9]{40}$/);expect(newRow.originalShotId).toBeNull();expect(added.plan.shots.filter(row=>row.id!==newRow.id)).toEqual(initial.plan.shots);
  const scene=added.plan.document.scenes.find(row=>row.id===newRow.sceneId)!,deletedDoc=change(added,[{id:"delete-new",kind:"delete",block:block(added.plan.document.context.base,scene.startLine,scene.endLine)}]),deletion=suggest(added,deletedDoc,"delete-plan"),deleted=accept(deletion.review);
  expect(deletion.request.retired).toEqual([{shotId:newRow.id,reason:expect.any(String)}]);expect(deleted.plan.allocations.find(row=>row.id===newRow.id)!.retiredBy).toBe(deletion.request.revision);expect(deleted.plan.shots).toEqual(initial.plan.shots);
  const readdedDoc=change(deleted,[{id:"return-text",kind:"insert",at:boundary(deleted.plan.document.context.base,deleted.plan.document.scenes[1]!.startLine),text}]),returned=accept(suggest(deleted,readdedDoc,"return-plan").review),returnedRow=returned.plan.shots.find(row=>!initial.plan.shots.some(old=>old.id===row.id))!;
  expect(returnedRow.id).not.toBe(newRow.id);expect(returnedRow.renderId).not.toBe(newRow.renderId);expect(returned.plan.allocations).toHaveLength(initial.plan.shots.length+2);
  const forged=createCurrentShotPlanRequest(deleted.plan,readdedDoc,{id:"resurrect",retired:[],scenes:[{sceneId:readdedDoc.scenes[1]!.id,recipeFamily:"legacy-grouped",slots:[{kind:"revise",shotId:newRow.id,recipe:returnedRow.recipe,seed:newRow.seed,requestedFrames:newRow.requestedFrames}]}]});
  expect(()=>reviewShotPlanEvolution({...args(deleted,readdedDoc),request:forged})).toThrow(/active shot|retired/);
});

test("unreviewed changed or removed membership leaves an entire null candidate and complete old inventory",()=>{
  const scene=initial.plan.document.scenes[1]!,removed=change(initial,[{id:"remove-second",kind:"delete",block:block(initial.plan.document.context.base,scene.startLine,scene.endLine)}]),missing=review(initial,removed,[]);
  expect(missing.candidate).toBeNull();expect(missing.proposedLineage).toBeNull();expect(missing.mapping.shots).toHaveLength(initial.plan.shots.length);expect(missing.conflicts.filter(row=>row.code==="unaccounted-shot")).toHaveLength(2);
  const line=initial.plan.document.lines.find(row=>row.id===initial.plan.shots[0]!.recipe.dialogue[0]!.lineIds[0])!,changed=change(initial,[{id:"equal-words",kind:"replace",block:block(initial.plan.document.context.base,line.line,line.line+1),text:line.text}]),unreviewed=review(initial,changed,[]);
  expect(unreviewed.candidate).toBeNull();expect(unreviewed.conflicts.some(row=>row.code==="scene-review-required")).toBe(true);
  expect(unreviewed.mapping.shots.slice(0,2).every(row=>row.treatment==="unresolved")).toBe(true);expect(unreviewed.mapping.lines.some(row=>row.treatment==="unresolved")).toBe(true);expect(unreviewed.mapping.lines.find(row=>row.lineId===line.id)!.treatment).toBe("removed");
  const explicit=accept(suggest(initial,changed,"review-equal").review);expect(material(explicit)).toEqual(material(initial));expect(explicit.plan.shots[0]!.recipe.dialogue[0]!.lineIds[0]).not.toBe(line.id);
});

test("a new physical action requires explicit local regrouping while preserving inherited render identities and seeds",()=>{
  const scene=initial.plan.document.scenes[0]!,action=scene.beats.find(beat=>beat.kind==="action")!,after=change(initial,[{id:"action-continuation",kind:"insert",at:boundary(initial.plan.document.context.base,action.endLine),text:"The gate creaks softly.\r\n"}]),proposal=suggest(initial,after,"action-content");
  expect(proposal.review.candidate).toBeNull();expect(proposal.review.conflicts.some(row=>row.code==="scene-review-required")).toBe(true);
  const row=initial.plan.shots[0]!,recipe=structuredClone(row.recipe);if(recipe.kind!=="legacy-default/1")throw new Error("Legacy fixture required");recipe.actionBeatIds=after.scenes[0]!.beats.filter(beat=>beat.kind==="action").slice(0,2).map(beat=>beat.id);
  const approved=review(initial,after,[{sceneId:scene.id,recipeFamily:"legacy-grouped",slots:[{kind:"revise",shotId:row.id,recipe,seed:row.seed,requestedFrames:row.requestedFrames},{kind:"carry",shotId:initial.plan.shots[1]!.id,expectedRecipeRevision:initial.plan.shots[1]!.revision}]}],[],"local-action-review"),state=accept(approved);
  expect(state.plan.shots.map(row=>row.id)).toEqual(initial.plan.shots.map(row=>row.id));expect(approved.mapping.shots[0]!.treatment).toBe("revised");
  expect(material(state)[0]!.prompt).toContain("The gate creaks softly.");expect(state.plan.shots.map(row=>row.seed)).toEqual(initial.plan.shots.map(row=>row.seed));expect(material(state).slice(1)).toEqual(material(initial).slice(1));
});

test("invalid repeated membership remains bounded and cannot manufacture multiplied dialogue occurrences",()=>{
  const row=initial.plan.shots[0]!,recipe=structuredClone(row.recipe);recipe.dialogue=Array(1000).fill(recipe.dialogue[0]!);
  const slots:CurrentShotSlot[]=[{kind:"revise",shotId:row.id,recipe,seed:row.seed,requestedFrames:row.requestedFrames},{kind:"carry",shotId:initial.plan.shots[1]!.id,expectedRecipeRevision:initial.plan.shots[1]!.revision}],result=review(initial,initial.plan.document,[{sceneId:row.sceneId,recipeFamily:"legacy-grouped",slots}],[],"repeated-membership");
  expect(result.candidate).toBeNull();expect(result.conflicts.some(row=>row.code==="dialogue-coverage")).toBe(true);expect(result.mapping.lines).toHaveLength(4);expect(result.mapping.lines.flatMap(line=>line.after)).toHaveLength(2);expect(result.mapping.lines.filter(line=>line.treatment==="unresolved")).toHaveLength(2);
});

test("beat reorder is not silently regrouped and complete explicit scene replacement retains n:m evidence",()=>{
  const scene=initial.plan.document.scenes[0]!,actions=scene.beats.filter(beat=>beat.kind==="action"),base=initial.plan.document.context.base,after=change(initial,[{id:"reorder-action",kind:"move",block:block(base,actions[1]!.startLine,actions[1]!.endLine),to:boundary(base,actions[0]!.startLine)}]),proposal=suggest(initial,after,"no-global-regroup");
  expect(proposal.review.candidate).toBeNull();expect(proposal.review.conflicts.some(row=>row.code==="scene-review-required")).toBe(true);
  const currentScene=after.scenes[0]!,ordered=currentScene.beats.filter(beat=>beat.kind==="action").map(beat=>beat.id),old=initial.plan.shots.filter(row=>row.sceneId===scene.id),slots:CurrentShotSlot[]=old.map((row,i)=>({kind:"revise",shotId:row.id,recipe:{...row.recipe,...(row.recipe.kind==="legacy-default/1"?{actionBeatIds:[ordered[i]!]}:{})},seed:row.seed,requestedFrames:row.requestedFrames})),approved=review(initial,after,[{sceneId:scene.id,recipeFamily:"legacy-grouped",slots}]);
  const accepted=accept(approved);expect(material(accepted)[0]!.prompt).toContain("Spud waves.");expect(material(accepted)[1]!.prompt).toContain("Spud opens the gate.");expect(approved.mapping.relations[0]!.kind).toBe("move");expect(approved.mapping.relations[0]!.beforeLineIds).toEqual(approved.mapping.relations[0]!.afterLineIds);
});

test("authored complete-scene conversion and silent anchors use current physical membership, never equal words in another scene",()=>{
  const scene=initial.plan.document.scenes[0]!,view=livingScriptSceneViews(initial.plan.document).get(scene.id)!,beats=scene.beats.filter(beat=>beat.kind!=="transition"),recipe=(beatIds:string[],afterBeatId:string|null=null,role="master"):CurrentShotRecipe=>({kind:"authored-coverage/1",beatIds,afterBeatId,dialogue:beatIds.filter(id=>view.beats.get(id)?.kind==="dialogue").map(id=>livingScriptDialogueGroup(view,[id])),coverage:coverageSettings({role}),durationFrames:60,sceneNotes:"Current scene",shotNotes:""});
  const slots:CurrentShotSlot[]=beats.map((beat,i)=>({kind:"create",key:"coverage-"+i,recipe:recipe([beat.id]),seed:50+i,requestedFrames:60}));slots.splice(1,0,{kind:"create",key:"reaction",recipe:recipe([],beats[0]!.id,"reaction"),seed:99,requestedFrames:60});
  const retired=initial.plan.shots.filter(row=>row.sceneId===scene.id).map(row=>({shotId:row.id,reason:"Review complete authored scene coverage."})),converted=accept(review(initial,initial.plan.document,[{sceneId:scene.id,recipeFamily:"authored-coverage",slots}],retired,"authored"));
  expect(material(converted)[1]!.dialogue).toEqual([]);expect(material(converted)[1]!.prompt).toContain("Silent alternate view after: Spud opens the gate.");expect(converted.plan.allocations.filter(row=>row.retiredBy!==null)).toHaveLength(2);
  const currentRows=converted.plan.shots.filter(row=>row.sceneId===scene.id),bad=currentRows.map(row=>({kind:"revise" as const,shotId:row.id,recipe:structuredClone(row.recipe),seed:row.seed,requestedFrames:row.requestedFrames}));
  (bad[1]!.recipe as Extract<CurrentShotRecipe,{kind:"authored-coverage/1"}>).afterBeatId=beats.at(-1)!.id;
  expect(review(converted,converted.plan.document,[{sceneId:scene.id,recipeFamily:"authored-coverage",slots:bad}],[],"bad-anchor").conflicts.some(row=>row.code==="alternate-anchor")).toBe(true);
  const spoken=bad.find(row=>row.recipe.dialogue.length)!;spoken.recipe.dialogue[0]!.lineIds=initial.plan.shots[2]!.recipe.dialogue[0]!.lineIds;
  const foreign=review(converted,converted.plan.document,[{sceneId:scene.id,recipeFamily:"authored-coverage",slots:bad}],[],"foreign-line");expect(foreign.candidate).toBeNull();expect(foreign.conflicts.some(row=>row.code==="dialogue-coverage")).toBe(true);
});

test("full local proposals expose tier capacity without truncation or partial candidate",()=>{
  const base=initial.plan.document.context.base,text=Array.from({length:22},(_,i)=>`INT. LOCAL ${i} - DAY\r\nSpud waits.\r\n\r\n`).join(""),after=change(initial,[{id:"many-scenes",kind:"insert",at:boundary(base,livingScriptStructureLines(base).length+1),text}]),proposal=suggest(initial,after,"capacity");
  expect(proposal.request.scenes).toHaveLength(22);expect(proposal.review.candidate).toBeNull();expect(proposal.review.proposedLineage).toBeNull();expect(proposal.review.mapping.shots).toHaveLength(26);expect(proposal.review.conflicts.some(row=>row.code==="shot-capacity")).toBe(true);
  const elevated=reviewShotPlanEvolution({...args(initial,after),capacity:{tier:"elevated",maxShots:60},request:proposal.request});expect(accept(elevated).plan.shots).toHaveLength(26);
});

test("stale, forked, resealed or missing histories cannot masquerade as accepted current state",()=>{
  const base=initial.plan.document.context.base,line=initial.plan.document.lines.find(row=>row.id===initial.plan.shots[0]!.recipe.dialogue[0]!.lineIds[0])!,doc=change(initial,[{id:"one",kind:"replace",block:block(base,line.line,line.line+1),text:"A new greeting.\r\n"}]),first=accept(suggest(initial,doc,"first").review);
  const sameId=createCurrentShotPlanRequest(first.plan,doc,{id:"first",scenes:[],retired:[]});expect(()=>reviewShotPlanEvolution({...args(first),request:sameId})).toThrow(/already used/);
  const stale=createCurrentShotPlanRequest(initial.plan,doc,{id:"stale",scenes:[],retired:[]});expect(()=>reviewShotPlanEvolution({...args(first),request:stale})).toThrow(/previous plan/);
  const fork=change(initial,[{id:"other",kind:"replace",block:block(base,line.line,line.line+1),text:"A foreign branch.\r\n"}]);expect(()=>suggest(first,fork,"forked")).toThrow(/ancestry/);
  for(const mutate of [(p:CurrentShotPlan)=>{p.shots[0]!.seed++;},(p:CurrentShotPlan)=>{p.shots.reverse();},(p:CurrentShotPlan)=>{p.allocations[0]!.retiredBy="a".repeat(64);},(p:CurrentShotPlan)=>{p.document.scenes[0]!.id="b".repeat(64);}]){const value=structuredClone(first.plan);mutate(value);expect(()=>validateCurrentShotPlan(reseal(value),first.lineage,[source])).toThrow(/replayed lineage/);}
  const changed=structuredClone(first.lineage);changed.steps[0]!.request.id="forged";changed.steps[0]!.request=reseal(changed.steps[0]!.request);expect(()=>validateCurrentShotPlan(first.plan,reseal(changed),[source])).toThrow(/replayed completely/);
  const missing=structuredClone(first.lineage);missing.steps=[];expect(()=>validateCurrentShotPlan(first.plan,reseal(missing),[source])).toThrow(/replayed lineage/);
  const original=structuredClone(source);original.job.projectId="foreign";expect(()=>validateCurrentShotPlan(first.plan,first.lineage,[original])).toThrow();
  expect(()=>reviewShotPlanEvolution({...args(first),beforeDocument:initial.plan.document,request:createCurrentShotPlanRequest(first.plan,doc,{id:"wrong-before",scenes:[],retired:[]})})).toThrow(/before document/);
  expect(()=>materializeCurrentShotPlan(first.plan,initial.plan.document,first.lineage,[source])).toThrow(/exact complete current document/);
});

test("request identity, portable data and bounded history reject hostile input before getters or expansion",()=>{
  let calls=0;const accessor={...initial.plan,get shots(){calls++;return initial.plan.shots;}};expect(()=>validateCurrentShotPlan(accessor,initial.lineage,[source])).toThrow(/accessors/);expect(calls).toBe(0);
  const sparse=structuredClone(initial.plan);delete sparse.shots[1];expect(()=>validateCurrentShotPlan(sparse,initial.lineage,[source])).toThrow(/dense/);
  const negative=structuredClone(initial.plan);negative.shots[0]!.seed=-0;expect(()=>validateCurrentShotPlan(negative,initial.lineage,[source])).toThrow(/portable/);
  const malformed=structuredClone(initial.lineage);malformed.steps=Array(CURRENT_SHOT_PLAN_LIMITS.steps+1).fill({});expect(()=>validateCurrentShotPlan(initial.plan,reseal(malformed),[source])).toThrow(/bounded complete/);
  const row=initial.plan.shots[0]!,scene=initial.plan.scenes[0]!,duplicate:CurrentShotSlot={kind:"create",key:"same-key",recipe:row.recipe,seed:1,requestedFrames:60};
  expect(()=>review(initial,initial.plan.document,[{sceneId:scene.sceneId,recipeFamily:"legacy-grouped",slots:[duplicate,duplicate]}],[],"duplicate-key")).toThrow(/distinct creation keys/);
  const carry:CurrentShotSlot={kind:"carry",shotId:row.id,expectedRecipeRevision:row.revision};expect(()=>review(initial,initial.plan.document,[{sceneId:scene.sceneId,recipeFamily:"legacy-grouped",slots:[carry,carry]}],[],"duplicate-carry")).toThrow(/exactly once/);
  expect(()=>reviewShotPlanEvolution({...args(initial),capacity:{tier:"free",maxShots:60},request:createCurrentShotPlanRequest(initial.plan,initial.plan.document,{id:"fake-tier",scenes:[],retired:[]})})).toThrow(/exact current shot capacity/);
});
