import {contentHash as hash} from "../../generator/src/capabilities";
import {validateProviderPlan,type ProviderPlan} from "../../generator/src/catalog";
import {TIERS,type Tier} from "../../queue/src/index";
import {resolveCurrentScreenplayTarget,type CurrentScreenplayLibrary,type CurrentScreenplayTargetSelector,type CurrentScreenplayTarget} from "./current-screenplay-library";
import {renderCurrentScreenplay} from "./living-script-current-render";
import {livingScriptSceneViews,livingScriptDialogueGroup} from "./living-script-shot-recipe";
import {lineSources,type LineSource} from "./performances";
import {compileShotRenderRecipe,type ShotRenderRecipe} from "./shot-render-recipe";
import type {Shot} from "./index";

export const CURRENT_FILM_JOB_LIMITS={bytes:128*1024**2,nodes:2500000,shots:60} as const;
export const CURRENT_FILM_ENGINE_REVISION=hash({schema:"hv-current-film-engine/2",version:2,fps:30,recipeSchema:"hv-shot-execution/1",recipeEngine:1,providerClasses:"registered-capability-adapter/1",assembly:"concat-if-any-measured/1"});
export interface CurrentFilmJobRequest {role:"preview"|"render";tier:Tier;providerPlan:ProviderPlan}
export interface CurrentFilmPhysicalLine {lineId:string;physicalLineId:string;line:number;start:number;end:number}
export interface CurrentFilmSlot {
  ordinal:number;logicalShotId:string;renderId:string;sceneId:string;sceneIndex:number;heading:string;
  slotRevision:string;baseSeed:number;baseRequestedFrames:number;plannedFrames:number;requestedFrames:number;
  physical:{headingLineId:string;beatIds:string[];lines:CurrentFilmPhysicalLine[];spoken:{lineId:string;beatId:string;source:LineSource}[]};
  /** An ancestry reference only. It does not establish executable media reuse. */
  original:{sourceId:string;receiptRevision:string;logicalShotId:string;renderId:string;recordRevision:string|null}|null;
  shot:Shot;inputRevision:string;recipe:ShotRenderRecipe;
}
export interface CurrentFilmMaterialization {
  schema:"hv-current-film-materialization/2";documentRevision:string;planRevision:string;directionRevision:string;castingRevision:string;
  script:{version:number;text:string;revision:string};slots:CurrentFilmSlot[];
  allocationsRevision:string;retired:{logicalShotId:string;renderId:string;retiredBy:string}[];requestedFrames:number;revision:string;
}
export interface CurrentFilmJobV2 {
  schema:"hv-current-film-job/2";projectId:string;createdAt:string;
  /** Frozen replay evidence. Only the service can establish it is actually saved/current. */
  library:CurrentScreenplayLibrary;selector:CurrentScreenplayTargetSelector;target:CurrentScreenplayTarget;request:CurrentFilmJobRequest;
  baseline:{headRevision:string;libraryRevision:string;documentRevision:string;scriptVersion:number;scriptRevision:string;castingRevision:string;directionRevision:string};
  render:{role:"preview"|"render";stage:"animatic"|"final";tier:Tier;providerPlan:ProviderPlan;engineRevision:string;outputSize:{width:number;height:number};
    assembly:{schema:"hv-current-film-assembly-request/1";fps:30;requestedCrossfadeFrames:0|15;speechPolicy:"concat-if-any-measured"}};
  materialization:CurrentFilmMaterialization;
  /** Reserved separate multi-source reuse inventory; this bring-up admits fresh generation only. */
  origins:[];
  selection:{ordinal:number;logicalShotId:string;renderId:string;inputRevision:string;kind:"generate"}[];
  authority:"historical-only";revision:string;
}
export interface ResolvedCurrentFilmJob {
  schema:"hv-current-film-inputs/2";jobPlanRevision:string;projectId:string;scriptVersion:number;scriptText:string;stage:"animatic"|"final";tier:Tier;providerPlan:ProviderPlan;
  outputSize:{width:number;height:number};slots:CurrentFilmSlot[];shots:Shot[];requestedFrames:number;
}
const seal=<T extends object>(value:T):T&{revision:string}=>({...value,revision:hash(value)});
// Pure replay digests only: no media, current project or permission decisions are cached.
const validatedPlans=new Set<string>();
function fail(message:string):never {throw new Error(message);}
function exact(value:unknown,keys:string[]):void {if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))fail("Retain exact versioned current-film fields.");}
function date(value:unknown):number {if(typeof value!=="string"||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)fail("Retain a canonical current-film creation time.");return Date.parse(value);}
/** Descriptor and capacity checks precede every clone, hash and historical replay. */
function portable<T>(input:T):T {
  let nodes=0,bytes=0;const active=new Set<object>();
  const visit=(value:unknown,depth:number):void=>{
    if(++nodes>CURRENT_FILM_JOB_LIMITS.nodes||depth>180)fail("Current-film job metadata exceeds its capacity.");
    if(typeof value==="string"){bytes+=Buffer.byteLength(value,"utf8");if(bytes>CURRENT_FILM_JOB_LIMITS.bytes)fail("Current-film job metadata exceeds its capacity.");return;}
    if(value===null||typeof value==="boolean"||typeof value==="number"&&Number.isFinite(value)&&!Object.is(value,-0))return;
    if(typeof value!=="object"||active.has(value))fail("Retain portable current-film job data.");
    const array=Array.isArray(value),keys=Reflect.ownKeys(value),prototype=Object.getPrototypeOf(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)fail("Retain plain current-film job records.");
    if(array&&keys.length!==value.length+1)fail("Retain dense current-film job arrays.");active.add(value);
    for(const key of keys){if(array&&key==="length")continue;const field=Object.getOwnPropertyDescriptor(value,key)!;
      if(typeof key!=="string"||!field.enumerable||!Object.hasOwn(field,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))fail("Retain current-film fields without accessors or hidden values.");
      bytes+=Buffer.byteLength(key,"utf8");if(bytes>CURRENT_FILM_JOB_LIMITS.bytes)fail("Current-film job metadata exceeds its capacity.");visit(field.value,depth+1);
    }active.delete(value);
  };visit(input,0);if(Buffer.byteLength(JSON.stringify(input),"utf8")>CURRENT_FILM_JOB_LIMITS.bytes)fail("Current-film job metadata exceeds its capacity.");return structuredClone(input);
}
function frames(seconds:number):number {const value=seconds*30,rounded=Math.round(value);if(!Number.isFinite(value)||!Number.isSafeInteger(rounded)||rounded<1||Math.abs(value-rounded)>1e-7)fail("Current-film requests require exact positive 30 fps frame durations.");return rounded;}

/** Reproduce all active current shots. This never dispatches, grants current authority or selects reuse. */
export function compileCurrentFilmJob(library:CurrentScreenplayLibrary,selector:CurrentScreenplayTargetSelector,request:CurrentFilmJobRequest,now=Date.now()):CurrentFilmJobV2 {
  const input=portable({library,selector,request,now});exact(input.request,["role","tier","providerPlan"]);
  if(!Number.isSafeInteger(input.now)||input.now<0||input.now>8640000000000000)fail("Choose a bounded current-film creation time.");
  if(!["preview","render"].includes(input.request.role)||!["free","elevated"].includes(input.request.tier))fail("Choose a current-film role and exact tier.");
  const {library:checkedLibrary,target,head}=resolveCurrentScreenplayTarget(input.library,input.selector);
  if(!head||!target.state.casting.candidate)fail("Resolve a saved complete current-screenplay target before compiling a film.");
  const targetCreatedAt=target.kind==="accepted"?head.createdAt:checkedLibrary.proposals.find(row=>row.revision===input.selector.revision)!.createdAt;
  if(input.now<date(targetCreatedAt))fail("A current-film job cannot predate its saved screenplay target.");
  const state=target.state,document=state.context.plan.document,stage=input.request.role==="preview"?"animatic":"final",providerPlan=validateProviderPlan(input.request.providerPlan);
  if(providerPlan.stage!==stage)fail("The current-film provider plan must match its exact role and stage.");
  const size=stage==="animatic"?"640x360":TIERS[input.request.tier].maxResolution,[width,height]=size.split("x").map(Number) as [number,number];
  const baseline={headRevision:target.headRevision,libraryRevision:checkedLibrary.revision,documentRevision:head.state.context.plan.document.revision,scriptVersion:head.script.version,
    scriptRevision:head.state.context.plan.document.scriptRevision,castingRevision:head.state.casting.candidate!.revision,directionRevision:head.state.direction.revision};
  const current=target.kind==="accepted"?{documentRevision:document.revision,casting:state.casting.candidate!}:{documentRevision:baseline.documentRevision,casting:head.state.casting.candidate!};
  const shots=renderCurrentScreenplay({context:state.context,direction:state.direction,casting:state.casting},current,input.now),plan=state.context.plan;
  if(!shots.length||shots.length!==plan.shots.length||shots.length>TIERS[input.request.tier].maxShots||shots.length>CURRENT_FILM_JOB_LIMITS.shots)fail("Compile the complete active current-film inventory within the chosen tier; never truncate slots.");
  const views=livingScriptSceneViews(document),original=state.context.originals[0]!;
  const identities={documentRevision:document.revision,planRevision:plan.revision,directionRevision:state.direction.revision,castingRevision:state.casting.candidate!.revision};
  const slots:CurrentFilmSlot[]=shots.map((shot,ordinal)=>{
    const row=plan.shots[ordinal]!,view=views.get(row.sceneId);if(!view||shot.id!==row.renderId||shot.sceneIndex!==view.document.sceneIndex)fail("The complete effective shot order differs from its current physical plan.");
    const membership=row.recipe.kind==="legacy-default/1"?row.recipe.actionBeatIds:row.recipe.beatIds;
    const beatIds=[...new Set([...membership,...row.recipe.dialogue.flatMap(group=>group.beatIds),...(row.recipe.kind==="authored-coverage/1"&&row.recipe.afterBeatId?[row.recipe.afterBeatId]:[])])];
    const beats=beatIds.map(id=>{const beat=view.physicalBeats.get(id);if(!beat)fail("The current shot lost its physical beat membership.");return beat;});
    const owners=new Map(row.recipe.dialogue.flatMap(group=>group.beatIds.flatMap(beatId=>livingScriptDialogueGroup(view,[beatId]).lineIds.map(lineId=>[lineId,beatId] as const))));
    const spoken=lineSources(shot.dialogue).map(source=>{const lineId=row.recipe.dialogue[source.dialogueIndex]?.lineIds[source.lineIndex],beatId=lineId?owners.get(lineId):undefined;
      if(!lineId||!beatId)fail("The current shot lost a spoken physical line or its exact dialogue beat.");return {lineId,beatId,source};});
    const lineIds=new Set([view.document.headingLineId,...beats.flatMap(beat=>beat.lineIds)]),lines=document.lines.filter(line=>lineIds.has(line.id)).map(line=>({lineId:line.id,physicalLineId:line.physicalLineId,line:line.line,start:line.start,end:line.end}));
    if(lines.length!==lineIds.size)fail("The current shot contains unavailable physical lines.");
    const physical={headingLineId:view.document.headingLineId,beatIds,lines,spoken};
    const recipe=compileShotRenderRecipe({projectId:target.projectId,stage,shot,sceneHeading:view.document.heading,outputSize:size,providerPlan,
      // Built-in registry factories publish this exact adapter discriminator; runtime
      // must still instantiate and compare its actual provider-class vector before dispatch.
      richAnimaticProviders:providerPlan.pool.map(entry=>entry.snapshot.adapter==="rich-animatic")});
    const sourceShot=row.originalShotId===null?null:state.context.lineage.root.originalPlan.shots.find(value=>value.id===row.originalShotId);
    if(row.originalShotId!==null&&!sourceShot)fail("An inherited current slot lost its immutable original planning identity.");
    const sourceRecord=sourceShot?original.job.output?.shotRenders?.find(value=>value.shotId===sourceShot.renderId):undefined;
    const sourceIdentity=sourceShot?{sourceId:original.facts.id,receiptRevision:original.revision,logicalShotId:sourceShot.id,renderId:sourceShot.renderId,recordRevision:sourceRecord?.revision??null}:null;
    const inputRevision=hash({schema:"hv-current-shot-input/2",engineRevision:CURRENT_FILM_ENGINE_REVISION,projectId:target.projectId,...identities,scriptRevision:document.scriptRevision,
      stage,tier:input.request.tier,providerPlanRevision:providerPlan.revision,ordinal,logicalShotId:row.id,renderId:row.renderId,sceneId:row.sceneId,slotRevision:row.revision,physical,shot,recipeRevision:recipe.revision});
    return {ordinal,logicalShotId:row.id,renderId:row.renderId,sceneId:row.sceneId,sceneIndex:shot.sceneIndex,heading:view.document.heading,slotRevision:row.revision,baseSeed:row.seed,baseRequestedFrames:row.requestedFrames,
      plannedFrames:frames(shot.durationSec),requestedFrames:frames(recipe.dispatch.params.durationSec!),physical,original:sourceIdentity,shot,inputRevision,recipe};
  });
  const requestedFrames=slots.reduce((sum,slot)=>sum+slot.requestedFrames,0);if(!Number.isSafeInteger(requestedFrames))fail("Current-film requested frames exceed exact integer capacity.");
  const materialization=seal({schema:"hv-current-film-materialization/2" as const,...identities,script:{version:document.context.base.version,text:document.context.base.text,revision:document.scriptRevision},slots,
    allocationsRevision:hash(plan.allocations),retired:plan.allocations.filter(row=>row.retiredBy!==null).map(row=>({logicalShotId:row.id,renderId:row.renderId,retiredBy:row.retiredBy!})),requestedFrames});
  return portable(seal({schema:"hv-current-film-job/2" as const,projectId:target.projectId,createdAt:new Date(input.now).toISOString(),library:checkedLibrary,selector:input.selector,target,request:{...input.request,providerPlan},baseline,
    render:{role:input.request.role,stage,tier:input.request.tier,providerPlan,engineRevision:CURRENT_FILM_ENGINE_REVISION,outputSize:{width,height},assembly:{schema:"hv-current-film-assembly-request/1" as const,fps:30 as const,requestedCrossfadeFrames:stage==="animatic"?0 as const:15 as const,speechPolicy:"concat-if-any-measured" as const}},
    materialization,origins:[] as [],selection:slots.map(slot=>({ordinal:slot.ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,kind:"generate" as const})),authority:"historical-only" as const}));
}

/** Exact historical replay at admission time, with no current project/provider/custody grant. */
export function validateCurrentFilmJobPlan(raw:CurrentFilmJobV2):CurrentFilmJobV2 {
  const value=portable(raw);exact(value,["schema","projectId","createdAt","library","selector","target","request","baseline","render","materialization","origins","selection","authority","revision"]);
  if(value.schema!=="hv-current-film-job/2")fail("Use the explicit version-two current-film discriminator.");
  const key=hash(value);if(validatedPlans.has(key)){validatedPlans.delete(key);validatedPlans.add(key);return value;}
  const expected=compileCurrentFilmJob(value.library,value.selector,value.request,date(value.createdAt));
  if(hash(expected)!==key)fail("The current-film plan differs from its complete historical target, slot inventory or execution inputs.");
  validatedPlans.add(key);if(validatedPlans.size>64)validatedPlans.delete(validatedPlans.values().next().value!);return expected;
}
/** V2-only resolver. Legacy jobs retain their existing resolver, never a fallback from here. */
export function resolveCurrentFilmJob(raw:CurrentFilmJobV2):ResolvedCurrentFilmJob {
  const plan=validateCurrentFilmJobPlan(raw);return structuredClone({schema:"hv-current-film-inputs/2",jobPlanRevision:plan.revision,projectId:plan.projectId,scriptVersion:plan.materialization.script.version,scriptText:plan.materialization.script.text,
    stage:plan.render.stage,tier:plan.render.tier,providerPlan:plan.render.providerPlan,outputSize:plan.render.outputSize,slots:plan.materialization.slots,shots:plan.materialization.slots.map(slot=>slot.shot),requestedFrames:plan.materialization.requestedFrames});
}
