import {contentHash as hash} from "../../generator/src/capabilities";
import {coverageSettings} from "./coverage";
import {editFail} from "./edit-timeline";
import type {EditSourceReceipt} from "./edit-sources";
import type {Shot} from "./index";
import {compileLivingScriptDocument,validateLivingScriptDocument,validateLivingScriptDocumentSource,type LivingScriptDocument,type LivingScriptDocumentSource} from "./living-script-document";
import {validateLivingScriptShotPlan,materializeLivingScriptBaseShots,type LivingScriptShotPlan} from "./living-script-shot-plan";
import {livingScriptSceneViews,livingScriptDialogueGroup,livingScriptDefaultDialogue,materializeLivingScriptShotRecipe,type LivingScriptMaterialRecipe,type LivingScriptSceneView} from "./living-script-shot-recipe";
import {lineSources,type LineSource} from "./performances";

export const CURRENT_SHOT_PLAN_LIMITS={bytes:128*1024**2,nodes:2500000,steps:64,shots:60,allocated:4096,relations:100000} as const;
export type CurrentShotRecipe=LivingScriptMaterialRecipe;
export type CurrentShotFamily="legacy-grouped"|"authored-coverage";
export interface CurrentShot {
  id:string;renderId:string;sceneId:string;recipe:CurrentShotRecipe;seed:number;requestedFrames:number;
  createdBy:string;originalShotId:string|null;revision:string;
}
export interface CurrentShotPlan {
  schema:"hv-living-script-current-plan/2";projectId:string;originRevision:string;previousRevision:string|null;requestRevision:string|null;
  document:LivingScriptDocument;scenes:{sceneId:string;family:CurrentShotFamily;shotIds:string[]}[];shots:CurrentShot[];
  allocations:{id:string;renderId:string;createdBy:string;retiredBy:string|null}[];revision:string;
}
export type CurrentShotSlot={kind:"carry";shotId:string;expectedRecipeRevision:string}|{kind:"revise";shotId:string;recipe:CurrentShotRecipe;seed:number;requestedFrames:number}|{kind:"create";key:string;recipe:CurrentShotRecipe;seed:number;requestedFrames:number};
export interface CurrentShotPlanRequest {
  schema:"hv-living-script-shot-plan-evolution/1";id:string;expectedPlanRevision:string;beforeDocumentRevision:string;afterDocumentRevision:string;
  scenes:{sceneId:string;recipeFamily:CurrentShotFamily;slots:CurrentShotSlot[]}[];retired:{shotId:string;reason:string}[];revision:string;
}
export interface CurrentShotCapacity {tier:"free"|"elevated";maxShots:24|60}
export interface CurrentShotPlanLineage {
  schema:"hv-living-script-shot-plan-lineage/1";
  root:{originalPlan:LivingScriptShotPlan;documentSource:LivingScriptDocumentSource};
  steps:{request:CurrentShotPlanRequest;document:LivingScriptDocument;capacity:CurrentShotCapacity;resultRevision:string}[];revision:string;
}
export interface CurrentShotConflict {code:string;sceneId:string|null;shotId:string|null;reason:string}
export interface CurrentShotLineOccurrence {shotId:string;renderId:string;lineId:string;beatId:string;source:LineSource}
export interface CurrentShotMapping {
  shots:{id:string;renderId:string;beforeOrdinal:number|null;afterOrdinal:number|null;treatment:"unchanged"|"moved"|"revised"|"created"|"retired"|"unresolved"}[];
  lines:{lineId:string;before:CurrentShotLineOccurrence[];after:CurrentShotLineOccurrence[];treatment:"retained"|"introduced"|"removed"|"unresolved"}[];
  /** Physical ancestry is many-to-many for replacements. It never approves a word/timing or performance transfer. */
  relations:{patchRevision:string;operationId:string;kind:"replace"|"insert"|"delete"|"move";beforeLineIds:string[];afterLineIds:string[]}[];
}
export interface CurrentShotPlanReview {
  schema:"hv-living-script-current-plan-review/1";previousRevision:string;request:CurrentShotPlanRequest;
  candidate:CurrentShotPlan|null;proposedLineage:CurrentShotPlanLineage|null;mapping:CurrentShotMapping;conflicts:CurrentShotConflict[];revision:string;
}
export interface CurrentShotEvolutionInput {
  previous:CurrentShotPlan;lineage:CurrentShotPlanLineage;originals:EditSourceReceipt[];
  beforeDocument:LivingScriptDocument;afterDocument:LivingScriptDocument;request:CurrentShotPlanRequest;capacity:CurrentShotCapacity;
}
const seal=<T extends object>(value:T):T&{revision:string}=>({...value,revision:hash(value)});
const same=(a:unknown,b:unknown)=>hash(a)===hash(b);
function exact(value:unknown,keys:string[]):void {if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))editFail("Retain exact current shot-plan fields.");}
function id(value:unknown):void {if(typeof value!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(value))editFail("Retain a bounded shot-plan identity.");}
function digest(value:unknown):void {if(typeof value!=="string"||! /^[a-f0-9]{64}$/.test(value))editFail("Retain an exact shot-plan revision.");}
function portable<T>(input:T):T {
  let nodes=0,bytes=0;const active=new Set<object>();const visit=(value:unknown,depth:number):void=>{
    if(++nodes>CURRENT_SHOT_PLAN_LIMITS.nodes||depth>180)editFail("Current shot-plan metadata exceeds its capacity.");
    if(typeof value==="string"){bytes+=Buffer.byteLength(value,"utf8");if(bytes>CURRENT_SHOT_PLAN_LIMITS.bytes)editFail("Current shot-plan metadata exceeds its capacity.");return;}
    if(value===null||typeof value==="boolean"||typeof value==="number"&&Number.isFinite(value)&&!Object.is(value,-0))return;
    if(typeof value!=="object"||active.has(value))editFail("Retain portable current shot-plan data.");
    const array=Array.isArray(value),keys=Reflect.ownKeys(value),prototype=Object.getPrototypeOf(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)editFail("Retain plain current shot-plan records.");if(array&&keys.length!==value.length+1)editFail("Retain dense current shot-plan arrays.");active.add(value);
    for(const key of keys){if(array&&key==="length")continue;const field=Object.getOwnPropertyDescriptor(value,key)!;if(typeof key!=="string"||!field.enumerable||!Object.hasOwn(field,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))editFail("Retain current shot-plan fields without accessors or hidden values.");bytes+=Buffer.byteLength(key,"utf8");visit(field.value,depth+1);}active.delete(value);
  };visit(input,0);if(Buffer.byteLength(JSON.stringify(input),"utf8")>CURRENT_SHOT_PLAN_LIMITS.bytes)editFail("Current shot-plan metadata exceeds its capacity.");return structuredClone(input);
}
class Budget {
  bytes=0;nodes=0;relations=0;
  add(value:unknown):void {const walk=(v:unknown):void=>{if(++this.nodes>CURRENT_SHOT_PLAN_LIMITS.nodes)editFail("Current shot-plan output exceeds its capacity.");if(v&&typeof v==="object")for(const child of Object.values(v))walk(child);};walk(value);this.bytes+=Buffer.byteLength(JSON.stringify(value),"utf8")+1;if(this.bytes>CURRENT_SHOT_PLAN_LIMITS.bytes)editFail("Current shot-plan output exceeds its capacity.");}
  relation():void {if(++this.relations>CURRENT_SHOT_PLAN_LIMITS.relations)editFail("Current shot-plan correspondence exceeds its capacity.");}
}
const conflict=(code:string,reason:string,sceneId:string|null=null,shotId:string|null=null):CurrentShotConflict=>({code,reason,sceneId,shotId});
const family=(recipe:CurrentShotRecipe):CurrentShotFamily=>recipe.kind==="legacy-default/1"?"legacy-grouped":"authored-coverage";
const rowRecipe=(row:CurrentShot)=>({recipe:row.recipe,renderId:row.renderId,base:{seed:row.seed,requestedFrames:row.requestedFrames}});
function capacity(value:CurrentShotCapacity):void {exact(value,["tier","maxShots"]);if(value.tier!=="free"&&value.tier!=="elevated"||value.maxShots!==(value.tier==="free"?24:60))editFail("Review the exact current shot capacity and tier.");}
function sourceFor(lineage:CurrentShotPlanLineage,originals:EditSourceReceipt[]):EditSourceReceipt {
  if(!Array.isArray(originals)||originals.length!==1)editFail("Retain the exact original source for this shot-plan lineage.");
  const source=originals[0]!;if(source.revision!==lineage.root.originalPlan.source.receiptRevision)editFail("The original shot-plan receipt changed.");return source;
}
function ancestry(before:LivingScriptDocument,after:LivingScriptDocument):void {
  const a=before.context.ancestry,b=after.context.ancestry;
  if(before.projectId!==after.projectId||before.rootScriptRevision!==after.rootScriptRevision||a.length>b.length||a.some((patch,i)=>!same(patch,b[i]))||!same(b[a.length]?.before??after.context.base,before.context.base))editFail("Evolve a shot plan only along its complete exact current document ancestry.");
}
function numeric(seed:number,frames:number):void {if(!Number.isSafeInteger(seed)||seed<0||seed>2147483647||!Number.isInteger(frames)||frames<30||frames>900)editFail("Review a bounded seed and 30–900 requested frames for each shot.");}
function ids(values:unknown,max=20000):asserts values is string[] {if(!Array.isArray(values)||values.length>max||values.some(v=>typeof v!=="string"||! /^[a-f0-9]{64}$/.test(v)))editFail("Retain exact bounded document membership identities.");}
function recipeShape(recipe:CurrentShotRecipe):void {
  if(recipe?.kind==="legacy-default/1"){exact(recipe,["kind","actionBeatIds","headingFallback","dialogue"]);ids(recipe.actionBeatIds);if(typeof recipe.headingFallback!=="boolean")editFail("Choose explicit heading fallback.");}
  else if(recipe?.kind==="authored-coverage/1"){
    exact(recipe,["kind","beatIds","afterBeatId","dialogue","coverage","durationFrames","sceneNotes","shotNotes"]);ids(recipe.beatIds);if(recipe.afterBeatId!==null)digest(recipe.afterBeatId);
    if(!same(coverageSettings(recipe.coverage),recipe.coverage)||recipe.durationFrames!==null&&(!Number.isInteger(recipe.durationFrames)||recipe.durationFrames<30||recipe.durationFrames>900))editFail("Retain exact authored coverage settings and duration.");
    for(const text of [recipe.sceneNotes,recipe.shotNotes])if(typeof text!=="string"||text.length>1200||text.trim()!==text)editFail("Retain bounded reviewed coverage notes.");
  }else editFail("Choose a supported current shot recipe.");
  if(!Array.isArray(recipe.dialogue)||recipe.dialogue.length>20000)editFail("Retain bounded dialogue groups.");for(const group of recipe.dialogue){exact(group,["beatIds","lineIds"]);ids(group.beatIds);ids(group.lineIds);}
}
function requestShape(value:CurrentShotPlanRequest):void {
  exact(value,["schema","id","expectedPlanRevision","beforeDocumentRevision","afterDocumentRevision","scenes","retired","revision"]);
  if(value.schema!=="hv-living-script-shot-plan-evolution/1")editFail("Retain a supported shot-plan evolution request.");id(value.id);for(const h of [value.expectedPlanRevision,value.beforeDocumentRevision,value.afterDocumentRevision,value.revision])digest(h);
  if(!Array.isArray(value.scenes)||value.scenes.length>1000||!Array.isArray(value.retired)||value.retired.length>60)editFail("Retain complete bounded scene and retirement decisions.");
  for(const scene of value.scenes){exact(scene,["sceneId","recipeFamily","slots"]);digest(scene.sceneId);if(!["legacy-grouped","authored-coverage"].includes(scene.recipeFamily)||!Array.isArray(scene.slots)||scene.slots.length>60)editFail("Retain a complete bounded scene shot order.");
    for(const slot of scene.slots){if(slot?.kind==="carry"){exact(slot,["kind","shotId","expectedRecipeRevision"]);digest(slot.shotId);digest(slot.expectedRecipeRevision);}
      else if(slot?.kind==="revise"||slot?.kind==="create"){exact(slot,["kind",slot.kind==="revise"?"shotId":"key","recipe","seed","requestedFrames"]);if(slot.kind==="revise")digest(slot.shotId);else id(slot.key);numeric(slot.seed,slot.requestedFrames);recipeShape(slot.recipe);}
      else editFail("Choose carry, revise or create for each reviewed shot slot.");}
  }
  for(const retired of value.retired){exact(retired,["shotId","reason"]);digest(retired.shotId);if(typeof retired.reason!=="string"||!retired.reason.trim()||retired.reason.length>2000)editFail("Explain every explicit shot retirement.");}
  const {revision,...body}=value;if(hash(body)!==revision)editFail("The reviewed shot-plan request changed.");
}
export function createCurrentShotPlanRequest(previous:CurrentShotPlan,afterDocument:LivingScriptDocument,value:Pick<CurrentShotPlanRequest,"id"|"scenes"|"retired">):CurrentShotPlanRequest {
  const copied=portable({previous,afterDocument,value});exact(copied.value,["id","scenes","retired"]);
  const request=seal({schema:"hv-living-script-shot-plan-evolution/1" as const,...copied.value,expectedPlanRevision:copied.previous.revision,beforeDocumentRevision:copied.previous.document.revision,afterDocumentRevision:copied.afterDocument.revision});requestShape(request);return request;
}
function rootState(root:CurrentShotPlanLineage["root"],source:EditSourceReceipt):CurrentShotPlan {
  exact(root,["originalPlan","documentSource"]);const original=validateLivingScriptShotPlan(source,root.originalPlan),binding=validateLivingScriptDocumentSource(source,root.documentSource);
  // A current-document migration must retain each reviewed evolution separately.
  // The /1 materializer's reordered-document support is not bootstrap authority.
  if(binding.document.context.ancestry.length||!same(binding.document,original.rootDocument))editFail("Bootstrap the current shot plan from the exact original root document with no structural ancestry; review every later evolution explicitly.");
  const materialized=materializeLivingScriptBaseShots(source,original,binding),byRender=new Map(original.shots.map(row=>[row.renderId,row])),shots=materialized.map(shot=>{
    const row=byRender.get(shot.id)!;if(!row.recipe||!row.sceneId)editFail("Resolve the complete original shot recipe before establishing a current plan.");
    const recipe:CurrentShotRecipe=row.recipe.kind==="legacy-default/1"?structuredClone(row.recipe):(({cutRevision:_cut,...data})=>data)(structuredClone(row.recipe));
    return seal({id:row.id,renderId:row.renderId,sceneId:row.sceneId,recipe,seed:row.base.seed,requestedFrames:row.base.requestedFrames,createdBy:original.revision,originalShotId:row.id});
  });
  const scenes=binding.document.scenes.map(scene=>{const rows=shots.filter(row=>row.sceneId===scene.id);if(!rows.length)editFail("Every original scene needs complete planning provenance.");return {sceneId:scene.id,family:family(rows[0]!.recipe),shotIds:rows.map(row=>row.id)};});
  return seal({schema:"hv-living-script-current-plan/2" as const,projectId:original.projectId,originRevision:hash(root),previousRevision:null,requestRevision:null,document:binding.document,scenes,shots,allocations:shots.map(row=>({id:row.id,renderId:row.renderId,createdBy:row.createdBy,retiredBy:null}))});
}
/** Caller supplies accepted original/current state; this pure bootstrap grants no permission or publication authority. */
export function bootstrapCurrentShotPlan(source:EditSourceReceipt,originalPlan:LivingScriptShotPlan,documentSource:LivingScriptDocumentSource):{plan:CurrentShotPlan;lineage:CurrentShotPlanLineage} {
  const copied=portable({source,originalPlan,documentSource}),root={originalPlan:copied.originalPlan,documentSource:copied.documentSource},plan=rootState(root,copied.source),lineage=seal({schema:"hv-living-script-shot-plan-lineage/1" as const,root,steps:[]});return {plan,lineage};
}

function sceneContent(scene:LivingScriptDocument["scenes"][number]):string {return hash({id:scene.id,heading:scene.heading,beats:scene.beats.map(beat=>({id:beat.id,kind:beat.kind,lineIds:beat.lineIds,contentRevision:beat.contentRevision}))});}
function validateSceneRows(view:LivingScriptSceneView,kind:CurrentShotFamily,rows:CurrentShot[]):CurrentShotConflict[] {
  const issues:CurrentShotConflict[]=[],add=(code:string,reason:string,shotId:string|null=null)=>issues.push(conflict(code,reason,view.document.id,shotId));
  if(!rows.length){add("empty-scene","Give every current scene a complete shot plan.");return issues;}
  if(rows.some(row=>family(row.recipe)!==kind)){add("recipe-family","Review one consistent planning recipe family for the whole affected scene.");return issues;}
  try {
    if(kind==="legacy-grouped"){
      const recipes=rows.map(row=>row.recipe as Extract<CurrentShotRecipe,{kind:"legacy-default/1"}>),actions=view.document.beats.filter(beat=>beat.kind==="action").map(beat=>beat.id);
      if(!same(recipes.flatMap(recipe=>recipe.actionBeatIds),actions)||recipes.some(recipe=>actions.length?!recipe.actionBeatIds.length||recipe.headingFallback:!recipe.headingFallback||recipe.actionBeatIds.length)||!actions.length&&rows.length!==1)add("action-coverage","Account for every current action exactly once in order, with heading fallback only for an action-free scene.");
      if(!same(recipes[0]!.dialogue,livingScriptDefaultDialogue(view))||recipes.slice(1).some(recipe=>recipe.dialogue.length))add("dialogue-coverage","Legacy grouping places complete current dialogue blocks in the first shot, including transition continuations.");
    }else {
      const expected=view.document.beats.filter(beat=>beat.kind!=="transition").map(beat=>beat.id),delivered:string[]=[];
      for(const row of rows){const recipe=row.recipe as Extract<CurrentShotRecipe,{kind:"authored-coverage/1"}>;
        if(recipe.beatIds.length){if(recipe.afterBeatId!==null)add("alternate-anchor","Narrative coverage owns its beats and cannot also be a silent alternate view.",row.id);delivered.push(...recipe.beatIds);}
        else if(!["reaction","cutaway","establishing","master","insert"].includes(recipe.coverage.role)||recipe.afterBeatId!==(delivered.at(-1)??null))add("alternate-anchor","Choose a surviving immediately preceding beat for this silent alternate view, or the opening boundary.",row.id);
        const groups=recipe.beatIds.filter(id=>view.beats.get(id)?.kind==="dialogue").map(id=>livingScriptDialogueGroup(view,[id]));if(!same(recipe.dialogue,groups))add("dialogue-coverage","Bind authored dialogue to the exact ordered current beat and physical lines.",row.id);
        if(row.requestedFrames!==(recipe.durationFrames??60))add("authored-duration","Keep the base authored duration consistent with its coverage recipe; effective direction is reviewed separately.",row.id);
      }
      if(!same(delivered,expected))add("beat-coverage","Deliver every current action and dialogue beat exactly once in screenplay order; preserve transitions as untimed screenplay evidence.");
    }
    // Reject invalid membership before expanding current text. Repeated hostile line IDs
    // must not multiply a bounded screenplay into an unbounded temporary prompt.
    if(!issues.length)for(const row of rows)try{materializeLivingScriptShotRecipe(rowRecipe(row),view);}catch(error){add("unmapped-recipe",String((error as Error).message),row.id);}
  }catch(error){add("unmapped-recipe",String((error as Error).message));}
  return issues;
}
function compileStep(previous:CurrentShotPlan,document:LivingScriptDocument,request:CurrentShotPlanRequest,limit:CurrentShotCapacity,usedRequests:Set<string>):{candidate:CurrentShotPlan|null;conflicts:CurrentShotConflict[];draft:CurrentShot[]} {
  requestShape(request);capacity(limit);ancestry(previous.document,document);
  if(request.expectedPlanRevision!==previous.revision||request.beforeDocumentRevision!==previous.document.revision||request.afterDocumentRevision!==document.revision)editFail("The reviewed previous plan or exact document changed.");
  if(usedRequests.has(request.id))editFail("This shot-plan request identity was already used; retain its exact history instead of submitting it again.");
  const conflicts:CurrentShotConflict[]=[],budget=new Budget(),beforeScenes=new Map(previous.document.scenes.map(scene=>[scene.id,scene])),beforeViews=livingScriptSceneViews(previous.document),views=livingScriptSceneViews(document),oldRows=new Map(previous.shots.map(row=>[row.id,row])),decisions=new Map<string,CurrentShotPlanRequest["scenes"][number]>(),retired=new Set<string>(),consumed=new Set<string>(),newKeys=new Set<string>();
  if(!document.complete)conflicts.push(conflict("unbound-document","Resolve unsupported or rejected current physical structure before compiling the entire plan."));
  for(const decision of request.scenes){if(decisions.has(decision.sceneId)||!views.has(decision.sceneId))editFail("Review each existing current scene at most once; removed scenes use explicit shot retirement.");decisions.set(decision.sceneId,decision);}
  for(const row of request.retired){if(retired.has(row.shotId)||!oldRows.has(row.shotId))editFail("Retire each active previous shot at most once; retired identities cannot be resurrected.");retired.add(row.shotId);}
  const allocations=structuredClone(previous.allocations),issued=new Set(allocations.flatMap(row=>[row.id,row.renderId])),shots:CurrentShot[]=[],scenes:CurrentShotPlan["scenes"]=[];
  budget.add({document,request,allocations});
  for(const scene of document.scenes){const decision=decisions.get(scene.id),oldScene=previous.scenes.find(row=>row.sceneId===scene.id),old=beforeScenes.get(scene.id),rows:CurrentShot[]=[];const kind:CurrentShotFamily=decision?.recipeFamily??oldScene?.family??"legacy-grouped";
    if(!decision){
      if(!old||!oldScene||sceneContent(old)!==sceneContent(scene))conflicts.push(conflict("scene-review-required","Review the complete affected scene; no new, changed or deleted membership is silently inferred.",scene.id));
      if(oldScene)for(const shotId of oldScene.shotIds){const row=oldRows.get(shotId)!;budget.add(row);consumed.add(row.id);rows.push(structuredClone(row));}
    }else for(const slot of decision.slots){
      let row:CurrentShot;
      if(slot.kind==="create"){
        if(newKeys.has(slot.key))editFail("Use distinct creation keys throughout the reviewed request.");newKeys.add(slot.key);
        const logical=hash({schema:"hv-current-shot-identity/1",projectId:previous.projectId,originRevision:previous.originRevision,previousRevision:previous.revision,requestId:request.id,key:slot.key}),renderId="shot-v2-"+logical.slice(0,40);
        if(issued.has(logical)||issued.has(renderId))editFail("A new shot collides with an issued or retired identity.");issued.add(logical);issued.add(renderId);
        row=seal({id:logical,renderId,sceneId:scene.id,recipe:structuredClone(slot.recipe),seed:slot.seed,requestedFrames:slot.requestedFrames,createdBy:request.revision,originalShotId:null});allocations.push({id:logical,renderId,createdBy:request.revision,retiredBy:null});
      }else{
        const oldRow=oldRows.get(slot.shotId);if(!oldRow||consumed.has(slot.shotId)||retired.has(slot.shotId))editFail("Carry or revise each active shot exactly once; retired identities cannot return.");consumed.add(slot.shotId);
        if(slot.kind==="carry"){
          if(slot.expectedRecipeRevision!==oldRow.revision)editFail("The carried shot recipe changed.");row=structuredClone(oldRow);
          if(oldRow.sceneId!==scene.id)conflicts.push(conflict("scene-transfer-review","Use an explicit revised shot to transfer its membership to a different scene.",scene.id,row.id));
          try{const before=materializeLivingScriptShotRecipe(rowRecipe(row),beforeViews.get(oldRow.sceneId)!),after=materializeLivingScriptShotRecipe(rowRecipe(row),views.get(scene.id)!);const withoutIndex=({sceneIndex:_index,...value}:Shot)=>value;if(!same(withoutIndex(before),withoutIndex(after)))conflicts.push(conflict("changed-carried-content","Review current changed content explicitly; carrying a shot cannot adopt different words or scene meaning.",scene.id,row.id));}catch{conflicts.push(conflict("changed-carried-membership","Review changed, replaced or unbound physical membership explicitly.",scene.id,row.id));}
        }else row=seal({id:oldRow.id,renderId:oldRow.renderId,sceneId:scene.id,recipe:structuredClone(slot.recipe),seed:slot.seed,requestedFrames:slot.requestedFrames,createdBy:oldRow.createdBy,originalShotId:oldRow.originalShotId});
      }
      budget.add(row);rows.push(row);if(shots.length+rows.length>CURRENT_SHOT_PLAN_LIMITS.allocated)editFail("The complete proposed shot inventory exceeds its bounded capacity; review fewer decisions without truncation.");
    }
    for(const row of rows)if(retired.has(row.id))editFail("A retired shot cannot also remain in the candidate plan.");
    conflicts.push(...validateSceneRows(views.get(scene.id)!,kind,rows));shots.push(...rows);scenes.push({sceneId:scene.id,family:kind,shotIds:rows.map(row=>row.id)});
  }
  for(const row of previous.shots)if(!consumed.has(row.id)&&!retired.has(row.id))conflicts.push(conflict("unaccounted-shot","Explicitly carry, revise or retire every previous shot, including removed scenes.",row.sceneId,row.id));
  if(shots.length>limit.maxShots)conflicts.push(conflict("shot-capacity",`The complete current plan requires ${shots.length} shots; ${limit.tier} permits ${limit.maxShots}. Review local grouping or capacity without omitting shots.`));
  if(allocations.length>CURRENT_SHOT_PLAN_LIMITS.allocated)conflicts.push(conflict("allocation-capacity","The retained identity registry reached its capacity; do not discard retirement history."));
  if(new Set(shots.map(row=>row.id)).size!==shots.length||new Set(shots.map(row=>row.renderId)).size!==shots.length)editFail("Every candidate shot identity must be unique.");
  for(const allocation of allocations)if(retired.has(allocation.id))allocation.retiredBy=request.revision;
  budget.add(conflicts);
  const candidate=conflicts.length?null:seal({schema:"hv-living-script-current-plan/2" as const,projectId:previous.projectId,originRevision:previous.originRevision,previousRevision:previous.revision,requestRevision:request.revision,document,scenes,shots,allocations});
  if(candidate)budget.add(candidate);return {candidate,conflicts,draft:shots};
}

function replay(lineage:CurrentShotPlanLineage,originals:EditSourceReceipt[]):CurrentShotPlan {
  exact(lineage,["schema","root","steps","revision"]);if(lineage.schema!=="hv-living-script-shot-plan-lineage/1"||!Array.isArray(lineage.steps)||lineage.steps.length>CURRENT_SHOT_PLAN_LIMITS.steps)editFail("Retain a bounded complete shot-plan lineage.");const {revision,...data}=lineage;if(hash(data)!==revision)editFail("The shot-plan lineage seal changed.");
  let current=rootState(lineage.root,sourceFor(lineage,originals));const requests=new Set<string>();
  for(const step of lineage.steps){exact(step,["request","document","capacity","resultRevision"]);const document=validateLivingScriptDocument(step.document),result=compileStep(current,document,step.request,step.capacity,requests);
    if(!result.candidate||result.candidate.revision!==step.resultRevision)editFail("The exact accepted shot-plan evolution cannot be replayed completely.");requests.add(step.request.id);current=result.candidate;}
  return current;
}
export function validateCurrentShotPlan(plan:CurrentShotPlan,lineage:CurrentShotPlanLineage,originals:EditSourceReceipt[]):CurrentShotPlan {
  const copied=portable({plan,lineage,originals}),compiled=replay(copied.lineage,copied.originals);if(!same(compiled,copied.plan))editFail("The current shot plan differs from its complete replayed lineage.");return compiled;
}
function occurrences(rows:CurrentShot[],document:LivingScriptDocument,budget:Budget,unresolved:(row:CurrentShot)=>boolean=()=>false):CurrentShotLineOccurrence[] {
  const views=livingScriptSceneViews(document),result:CurrentShotLineOccurrence[]=[];
  for(const row of rows){const view=views.get(row.sceneId);if(!view||unresolved(row))continue;
    let shot:Shot,owners:Map<string,string>;
    try{shot=materializeLivingScriptShotRecipe(rowRecipe(row),view);owners=new Map(row.recipe.dialogue.flatMap(group=>group.beatIds.flatMap(beatId=>livingScriptDialogueGroup(view,[beatId]).lineIds.map(lineId=>[lineId,beatId] as const))));}catch{continue;/* Unresolved recipes have no invented line occurrence. */}
    for(const source of lineSources(shot.dialogue)){const lineId=row.recipe.dialogue[source.dialogueIndex]!.lineIds[source.lineIndex]!,value={shotId:row.id,renderId:row.renderId,lineId,beatId:owners.get(lineId)!,source};budget.add(value);result.push(value);}
  }
  return result;
}
function mapping(previous:CurrentShotPlan,after:LivingScriptDocument,draft:CurrentShot[],request:CurrentShotPlanRequest,conflicts:CurrentShotConflict[]):CurrentShotMapping {
  const budget=new Budget(),newer=new Map(draft.map((row,i)=>[row.id,{row,ordinal:i}])),older=new Map(previous.shots.map((row,i)=>[row.id,{row,ordinal:i}])),retired=new Set(request.retired.map(row=>row.shotId)),revised=new Set(request.scenes.flatMap(scene=>scene.slots.filter(slot=>slot.kind==="revise").map(slot=>slot.shotId)));
  const unresolvedScenes=new Set(conflicts.filter(row=>row.sceneId&&!row.shotId).map(row=>row.sceneId)),unresolvedShots=new Set(conflicts.filter(row=>row.shotId).map(row=>row.shotId)),unresolved=(row:CurrentShot)=>unresolvedScenes.has(row.sceneId)||unresolvedShots.has(row.id);
  const shots:CurrentShotMapping["shots"]=previous.shots.map((row,i)=>{const next=newer.get(row.id);return {id:row.id,renderId:row.renderId,beforeOrdinal:i,afterOrdinal:next?.ordinal??null,treatment:!next?retired.has(row.id)?"retired":"unresolved":unresolved(next.row)?"unresolved":revised.has(row.id)||row.revision!==next.row.revision?"revised":i!==next.ordinal||previous.document.scenes.find(s=>s.id===row.sceneId)?.sceneIndex!==after.scenes.find(s=>s.id===row.sceneId)?.sceneIndex?"moved":"unchanged"};});
  for(const [i,row]of draft.entries())if(!older.has(row.id))shots.push({id:row.id,renderId:row.renderId,beforeOrdinal:null,afterOrdinal:i,treatment:unresolved(row)?"unresolved":"created"});
  const beforeLines=new Map<string,CurrentShotLineOccurrence[]>(),afterLines=new Map<string,CurrentShotLineOccurrence[]>();
  for(const [values,target]of [[occurrences(previous.shots,previous.document,budget),beforeLines],[occurrences(draft,after,budget,unresolved),afterLines]] as const)for(const row of values){const list=target.get(row.lineId)??[];list.push(row);target.set(row.lineId,list);}
  const currentLines=new Set<string>();for(const view of livingScriptSceneViews(after).values())for(const beat of view.document.beats)if(beat.kind==="dialogue")for(const lineId of livingScriptDialogueGroup(view,[beat.id]).lineIds)currentLines.add(lineId);
  const lines:CurrentShotMapping["lines"]=[...new Set([...beforeLines.keys(),...currentLines])].map(lineId=>({lineId,before:beforeLines.get(lineId)??[],after:afterLines.get(lineId)??[],treatment:afterLines.has(lineId)?beforeLines.has(lineId)?"retained":"introduced":currentLines.has(lineId)?"unresolved":"removed"}));
  const relations:CurrentShotMapping["relations"]=[],chain=after.context.ancestry;
  for(let i=previous.document.context.ancestry.length;i<chain.length;i++){
    const patch=chain[i]!,before=compileLivingScriptDocument({base:patch.before,ancestry:chain.slice(0,i)}),current=compileLivingScriptDocument({base:patch.after,ancestry:chain.slice(0,i+1)});
    const introduced=new Map<string,string[]>();for(const row of patch.introduced){const values=introduced.get(row.operationId)??[];values.push(current.lines[row.line-1]!.id);introduced.set(row.operationId,values);}
    for(const operation of patch.request.operations){budget.relation();const beforeLineIds=operation.kind==="insert"?[]:before.lines.slice(operation.block.startLine-1,operation.block.endLine-1).map(row=>row.id),afterLineIds=operation.kind==="replace"||operation.kind==="insert"?introduced.get(operation.id)??[]:operation.kind==="move"?beforeLineIds:[],relation={patchRevision:patch.revision,operationId:operation.id,kind:operation.kind,beforeLineIds,afterLineIds};budget.add(relation);relations.push(relation);}
  }
  budget.add({shots,lines});return {shots,lines,relations};
}
export function reviewShotPlanEvolution(input:CurrentShotEvolutionInput):CurrentShotPlanReview {
  const copied=portable(input);exact(copied,["previous","lineage","originals","beforeDocument","afterDocument","request","capacity"]);
  const previous=validateCurrentShotPlan(copied.previous,copied.lineage,copied.originals),before=validateLivingScriptDocument(copied.beforeDocument),after=validateLivingScriptDocument(copied.afterDocument);
  if(!same(before,previous.document))editFail("The supplied before document is not the exact accepted current plan context.");
  if(copied.lineage.steps.length>=CURRENT_SHOT_PLAN_LIMITS.steps)editFail("The complete evolution history reached its bounded replay capacity.");
  const result=compileStep(previous,after,copied.request,copied.capacity,new Set(copied.lineage.steps.map(step=>step.request.id)));
  const proposedLineage=result.candidate?seal({schema:copied.lineage.schema,root:copied.lineage.root,steps:[...copied.lineage.steps,{request:copied.request,document:after,capacity:copied.capacity,resultRevision:result.candidate.revision}]}):null;
  const review=seal({schema:"hv-living-script-current-plan-review/1" as const,previousRevision:previous.revision,request:copied.request,candidate:result.candidate,proposedLineage,mapping:mapping(previous,after,result.draft,copied.request,result.conflicts),conflicts:result.conflicts});portable(review);return review;
}
export function materializeCurrentShotPlan(plan:CurrentShotPlan,document:LivingScriptDocument,lineage:CurrentShotPlanLineage,originals:EditSourceReceipt[]):Shot[] {
  const copied=portable({plan,document,lineage,originals}),checked=validateCurrentShotPlan(copied.plan,copied.lineage,copied.originals),current=validateLivingScriptDocument(copied.document);if(!same(current,checked.document))editFail("Materialize only the exact complete current document bound to this plan.");
  const views=livingScriptSceneViews(current),budget=new Budget();return checked.shots.map(row=>{const result=materializeLivingScriptShotRecipe(rowRecipe(row),views.get(row.sceneId)!);budget.add(result);return result;});
}

export interface CurrentShotPlanProposalInput extends Omit<CurrentShotEvolutionInput,"request"> {requestId:string}
/** A deterministic suggestion, not acceptance. One local new-scene group preserves all action
 * and dialogue; owners can refine its slots. Unsupported regrouping stays explicitly unresolved. */
export function proposeShotPlanEvolution(input:CurrentShotPlanProposalInput):{schema:"hv-living-script-shot-plan-proposal/1";policy:"retain-groups/1";request:CurrentShotPlanRequest;review:CurrentShotPlanReview;revision:string} {
  const copied=portable(input);exact(copied,["previous","lineage","originals","beforeDocument","afterDocument","capacity","requestId"]);id(copied.requestId);
  const previous=validateCurrentShotPlan(copied.previous,copied.lineage,copied.originals),document=validateLivingScriptDocument(copied.afterDocument);ancestry(previous.document,document);
  const views=livingScriptSceneViews(document),beforeViews=livingScriptSceneViews(previous.document),before=new Map(previous.document.scenes.map(scene=>[scene.id,scene])),scenes:CurrentShotPlanRequest["scenes"]=[],retired:CurrentShotPlanRequest["retired"]=[];
  for(const old of previous.document.scenes)if(!views.has(old.id))for(const row of previous.shots.filter(shot=>shot.sceneId===old.id))retired.push({shotId:row.id,reason:"Review retirement of this shot because its original physical scene was removed or replaced."});
  for(const scene of document.scenes){const old=before.get(scene.id),view=views.get(scene.id)!;
    if(!old){const key="scene-"+scene.id,actions=scene.beats.filter(beat=>beat.kind==="action").map(beat=>beat.id),recipe:CurrentShotRecipe={kind:"legacy-default/1",actionBeatIds:actions,headingFallback:!actions.length,dialogue:livingScriptDefaultDialogue(view)},seed=parseInt(hash({originRevision:previous.originRevision,previousRevision:previous.revision,requestId:copied.requestId,key}).slice(0,8),16)%2147483648;
      scenes.push({sceneId:scene.id,recipeFamily:"legacy-grouped",slots:[{kind:"create",key,recipe,seed,requestedFrames:60}]});continue;}
    if(sceneContent(old)===sceneContent(scene))continue;
    if(old.heading!==scene.heading||!same(old.beats.map(beat=>({id:beat.id,kind:beat.kind})),scene.beats.map(beat=>({id:beat.id,kind:beat.kind}))))continue;
    const saved=previous.scenes.find(row=>row.sceneId===scene.id)!,rows=saved.shotIds.map(id=>previous.shots.find(row=>row.id===id)!);
    const slots:CurrentShotSlot[]=rows.map((row,index)=>{
      const recipe=structuredClone(row.recipe);recipe.dialogue=recipe.kind==="legacy-default/1"?index===0?livingScriptDefaultDialogue(view):[]:recipe.beatIds.filter(id=>view.beats.get(id)?.kind==="dialogue").map(id=>livingScriptDialogueGroup(view,[id]));
      const withoutIndex=({sceneIndex:_index,...shot}:Shot)=>shot,current={...row,recipe},contentUnchanged=same(withoutIndex(materializeLivingScriptShotRecipe(rowRecipe(row),beforeViews.get(scene.id)!)),withoutIndex(materializeLivingScriptShotRecipe(rowRecipe(current),view)));
      return same(recipe,row.recipe)&&contentUnchanged?{kind:"carry",shotId:row.id,expectedRecipeRevision:row.revision}:{kind:"revise",shotId:row.id,recipe,seed:row.seed,requestedFrames:row.requestedFrames};
    });scenes.push({sceneId:scene.id,recipeFamily:saved.family,slots});
  }
  const request=createCurrentShotPlanRequest(previous,document,{id:copied.requestId,scenes,retired}),review=reviewShotPlanEvolution({previous,lineage:copied.lineage,originals:copied.originals,beforeDocument:copied.beforeDocument,afterDocument:document,capacity:copied.capacity,request});
  return seal({schema:"hv-living-script-shot-plan-proposal/1" as const,policy:"retain-groups/1" as const,request,review});
}
