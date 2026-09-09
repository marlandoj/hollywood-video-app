import {contentHash as hash} from "../../generator/src/capabilities";
import {applyShotDirection,directionSettings,directionSource,sourceDirection,validateDirection,staleDirections,type ShotDirection} from "./direction";
import {editFail} from "./edit-timeline";
import type {EditSourceReceipt} from "./edit-sources";
import type {Shot} from "./index";
import {materializeCurrentShotPlan,type CurrentShotPlan,type CurrentShotPlanLineage} from "./living-script-current-plan";
import {lineSources,type LineSource,type LineDirection} from "./performances";
import {validateReference} from "./references";

export interface CurrentDirectionContext {plan:CurrentShotPlan;lineage:CurrentShotPlanLineage;originals:EditSourceReceipt[]}
export interface CurrentDirectionEntry {
  shotId:string;renderId:string;sourceHash:string;
  /** Null retains implicit coverage/default behavior, without inventing a saved direction. */
  settings:ShotDirection|null;lines:{lineId:string;index:number;sourceHash:string}[];
}
export interface CurrentDirectionSnapshot {
  schema:"hv-current-direction/1";projectId:string;planRevision:string;documentRevision:string;entries:CurrentDirectionEntry[];revision:string;
}
export interface CurrentDirectionRequest {
  schema:"hv-current-direction-request/1";id:string;beforeRevision:string;beforePlanRevision:string;afterPlanRevision:string;
  /** A complete, explicit replacement of this shot's settings, including its line choices. */
  settings:{shotId:string;settings:ShotDirection|null}[];
  lines:{shotId:string;lineId:string;targets:{shotId:string;lineId:string}[];reason:string}[];
  retired:{shotId:string;reason:string}[];revision:string;
}
export interface CurrentDirectionReview {
  schema:"hv-current-direction-review/1";beforeRevision:string;request:CurrentDirectionRequest;candidate:CurrentDirectionSnapshot|null;
  changes:{kind:"implicit"|"carried"|"replaced"|"line-carried"|"line-transferred"|"line-dropped"|"retired";shotId:string;lineId:string|null;targetShotId:string|null;targetLineId:string|null}[];
  conflicts:{code:string;shotId:string;lineId:string|null;reason:string}[];revision:string;
}
const seal=<T extends object>(value:T):T&{revision:string}=>({...value,revision:hash(value)});
const same=(a:unknown,b:unknown)=>hash(a)===hash(b);
const exact=(value:unknown,keys:string[]):void=>{if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))editFail("Retain exact versioned direction fields.");};
const digest=(value:unknown):void=>{if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))editFail("Retain an exact direction identity or revision.");};
function portable<T>(input:T):T {
  let nodes=0,bytes=0;const active=new Set<object>();
  const visit=(v:unknown,depth:number):void=>{
    if(++nodes>2500000||depth>180)editFail("Versioned direction metadata exceeds its capacity.");
    if(typeof v==="string"){bytes+=Buffer.byteLength(v,"utf8");if(bytes>128*1024**2)editFail("Versioned direction metadata exceeds its capacity.");return;}
    if(v===null||typeof v==="boolean"||typeof v==="number"&&Number.isFinite(v)&&!Object.is(v,-0))return;
    if(typeof v!=="object"||active.has(v))editFail("Retain portable versioned direction data.");
    const array=Array.isArray(v),keys=Reflect.ownKeys(v),prototype=Object.getPrototypeOf(v);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)editFail("Retain plain direction records.");
    if(array&&keys.length!==v.length+1)editFail("Retain dense direction arrays.");active.add(v);
    for(const key of keys){if(array&&key==="length")continue;const field=Object.getOwnPropertyDescriptor(v,key)!;
      if(typeof key!=="string"||!field.enumerable||!Object.hasOwn(field,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=v.length))editFail("Retain direction fields without accessors or hidden values.");
      bytes+=Buffer.byteLength(key,"utf8");visit(field.value,depth+1);
    }active.delete(v);
  };visit(input,0);if(Buffer.byteLength(JSON.stringify(input),"utf8")>128*1024**2)editFail("Versioned direction metadata exceeds its capacity.");return structuredClone(input);
}
type View={shot:Shot;lines:{lineId:string;source:LineSource}[]};
function views(context:CurrentDirectionContext):Map<string,View> {
  exact(context,["plan","lineage","originals"]);
  const shots=materializeCurrentShotPlan(context.plan,context.plan.document,context.lineage,context.originals);
  return new Map(context.plan.shots.map((row,i)=>[row.id,{shot:shots[i]!,lines:lineSources(shots[i]!.dialogue).map(source=>{
    const lineId=row.recipe.dialogue[source.dialogueIndex]?.lineIds[source.lineIndex];if(!lineId)editFail("Retain exact physical performance membership.");return {lineId,source};
  })}]));
}
function settings(value:ShotDirection|null,projectId:string):ShotDirection|null {
  if(value===null)return null;const checked=directionSettings(value);if(!same(checked,value))editFail("Retain normalized full direction settings.");
  for(const frame of checked.frameAnchors?.frames??[])validateReference(frame.asset,projectId);
  return structuredClone(checked);
}
function bind(context:CurrentDirectionContext,view:Map<string,View>,values:{shotId:string;settings:ShotDirection|null}[]):CurrentDirectionSnapshot {
  if(!Array.isArray(values)||values.length!==context.plan.shots.length||values.some((row,i)=>row.shotId!==context.plan.shots[i]!.id))editFail("Retain one ordered direction binding for every current shot.");
  const entries=values.map(value=>{const current=view.get(value.shotId)!,chosen=settings(value.settings,context.plan.projectId);
    if(chosen)applyShotDirection(current.shot,chosen);
    const lines=(chosen?.lines??[]).map(line=>{const physical=current.lines.find(row=>row.source.index===line.index);if(!physical||physical.source.hash!==line.sourceHash)editFail("Review each performance against its exact current physical line.");return {lineId:physical.lineId,index:line.index,sourceHash:line.sourceHash};});
    return {shotId:value.shotId,renderId:current.shot.id,sourceHash:hash(directionSource(current.shot)),settings:chosen,lines};
  });
  return seal({schema:"hv-current-direction/1" as const,projectId:context.plan.projectId,planRevision:context.plan.revision,documentRevision:context.plan.document.revision,entries});
}
function checked(snapshot:CurrentDirectionSnapshot,context:CurrentDirectionContext,view:Map<string,View>):CurrentDirectionSnapshot {
  exact(snapshot,["schema","projectId","planRevision","documentRevision","entries","revision"]);
  if(!Array.isArray(snapshot.entries)||snapshot.entries.length>60)editFail("Retain bounded complete direction bindings.");
  const result=bind(context,view,snapshot.entries);if(!same(snapshot,result))editFail("The direction snapshot differs from its exact current shot-plan binding.");return result;
}
/** Proposes an initial binding from the actual original film; a seal never establishes acceptance. */
export function bootstrapCurrentDirection(input:CurrentDirectionContext):CurrentDirectionSnapshot {
  const context=portable(input),view=views(context);if(context.lineage.steps.length||context.plan.previousRevision!==null)editFail("Bootstrap direction only at the original current-plan root.");
  const source=context.originals[0]!,direction=source.job.direction;
  if(direction){validateDirection(direction,context.plan.projectId);if(staleDirections([...view.values()].map(v=>v.shot),direction).length)editFail("Review stale original directions before binding current shots.");}
  return bind(context,view,context.plan.shots.map(row=>({shotId:row.id,settings:direction?.entries.find(entry=>entry.source.id===row.renderId)?.settings??null})));
}
/** Validates correspondence and settings only. Caller must supply freshly loaded accepted state. */
const validatedCurrentDirections=new Set<string>();
export function validateCurrentDirection(snapshot:CurrentDirectionSnapshot,input:CurrentDirectionContext):CurrentDirectionSnapshot {
  // The complete historical context is part of the key, including original
  // receipts and lineage. No current authority result or caller object is saved.
  const value=portable({snapshot,input}),key=hash(value);
  if(validatedCurrentDirections.has(key)){validatedCurrentDirections.delete(key);validatedCurrentDirections.add(key);return value.snapshot;}
  const result=checked(value.snapshot,value.input,views(value.input));
  validatedCurrentDirections.add(key);if(validatedCurrentDirections.size>64)validatedCurrentDirections.delete(validatedCurrentDirections.values().next().value!);return result;
}
function requestShape(request:CurrentDirectionRequest):void {
  exact(request,["schema","id","beforeRevision","beforePlanRevision","afterPlanRevision","settings","lines","retired","revision"]);
  if(request.schema!=="hv-current-direction-request/1"||typeof request.id!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(request.id))editFail("Retain a bounded direction review request.");
  for(const value of [request.beforeRevision,request.beforePlanRevision,request.afterPlanRevision,request.revision])digest(value);
  if(!Array.isArray(request.settings)||request.settings.length>60||!Array.isArray(request.lines)||request.lines.length>7680||!Array.isArray(request.retired)||request.retired.length>60)editFail("Retain bounded direction review choices.");
  for(const row of request.settings){exact(row,["shotId","settings"]);digest(row.shotId);}
  for(const row of request.lines){exact(row,["shotId","lineId","targets","reason"]);digest(row.shotId);digest(row.lineId);
    if(!Array.isArray(row.targets)||row.targets.length>128)editFail("Choose bounded explicit performance transfer targets.");
    for(const target of row.targets){exact(target,["shotId","lineId"]);digest(target.shotId);digest(target.lineId);}
  }
  for(const row of request.retired){exact(row,["shotId","reason"]);digest(row.shotId);}
  for(const row of [...request.lines,...request.retired])if(typeof row.reason!=="string"||!row.reason.trim()||row.reason.length>2000)editFail("Explain explicit performance transfers, removals and retired settings.");
  const {revision,...body}=request;if(hash(body)!==revision)editFail("The direction review request changed.");
}
export function createCurrentDirectionRequest(before:CurrentDirectionSnapshot,after:CurrentShotPlan,choices:Pick<CurrentDirectionRequest,"id"|"settings"|"lines"|"retired">):CurrentDirectionRequest {
  const value=portable({before,after,choices});exact(value.choices,["id","settings","lines","retired"]);
  const result=seal({schema:"hv-current-direction-request/1" as const,...value.choices,beforeRevision:value.before.revision,beforePlanRevision:value.before.planRevision,afterPlanRevision:value.after.revision});requestShape(result);return result;
}
/** Physical retention can preserve local overrides; replaced words need explicit owner choices.
 * This pure proposal does not accept settings, grant media rights or approve a performance. */
export function reviewCurrentDirection(input:{before:CurrentDirectionContext;after:CurrentDirectionContext;snapshot:CurrentDirectionSnapshot;request:CurrentDirectionRequest}):CurrentDirectionReview {
  const value=portable(input);exact(value,["before","after","snapshot","request"]);const beforeViews=views(value.before),afterViews=views(value.after),snapshot=checked(value.snapshot,value.before,beforeViews),request=value.request;requestShape(request);
  const oldHistory=value.before.lineage,newHistory=value.after.lineage;
  if(!same(oldHistory.root,newHistory.root)||oldHistory.steps.length>newHistory.steps.length||oldHistory.steps.some((step,i)=>!same(step,newHistory.steps[i])))editFail("Review settings only along the exact retained current-plan lineage.");
  if(request.beforeRevision!==snapshot.revision||request.beforePlanRevision!==value.before.plan.revision||request.afterPlanRevision!==value.after.plan.revision)editFail("The current direction review baseline changed.");
  const conflicts:CurrentDirectionReview["conflicts"]=[],changes:CurrentDirectionReview["changes"]=[],old=new Map(snapshot.entries.map(row=>[row.shotId,row]));
  const replacements=new Map(request.settings.map(row=>[row.shotId,row.settings])),decisions=new Map(request.lines.map(row=>[row.shotId+":"+row.lineId,row])),retired=new Set(request.retired.map(row=>row.shotId));
  if(replacements.size!==request.settings.length||decisions.size!==request.lines.length||retired.size!==request.retired.length)editFail("Choose each settings replacement, line decision and retirement once.");
  for(const row of request.settings)if(!afterViews.has(row.shotId))editFail("Replace settings only for an actual current shot.");
  for(const shotId of retired)if(!old.has(shotId)||afterViews.has(shotId))editFail("A settings retirement must identify a removed original shot.");
  const values=new Map<string,ShotDirection|null>();
  for(const [shotId]of afterViews){const previous=old.get(shotId),chosen=replacements.has(shotId)?settings(replacements.get(shotId)!,snapshot.projectId):previous?.settings?structuredClone(previous.settings):null;
    if(chosen&&!replacements.has(shotId)&&chosen.lines)chosen.lines=[];
    values.set(shotId,chosen);changes.push({kind:replacements.has(shotId)?"replaced":previous?"carried":"implicit",shotId,lineId:null,targetShotId:null,targetLineId:null});
  }
  const used=new Set<string>(),assigned=new Set<string>();
  const add=(shotId:string,lineId:string,direction:LineDirection,fromShotId:string,fromLineId:string,explicit:boolean):void=>{
    const target=afterViews.get(shotId),physical=target?.lines.find(row=>row.lineId===lineId);
    if(!physical)editFail("Select an exact current spoken physical line for this performance transfer.");
    if(replacements.has(shotId))editFail("A complete settings replacement cannot overlap a separate line transfer.");
    const key=shotId+":"+lineId;if(assigned.has(key))editFail("Multiple old performances require an explicit single settings replacement at their shared target.");assigned.add(key);
    const chosen=values.get(shotId)??directionSettings({});chosen.lines??=[];
    if(physical.source.index>127||chosen.lines.length>=128)editFail("A shot supports at most 128 directed spoken lines; review complete performance coverage.");
    chosen.lines.push({...direction,index:physical.source.index,sourceHash:physical.source.hash});values.set(shotId,chosen);
    changes.push({kind:explicit?"line-transferred":"line-carried",shotId:fromShotId,lineId:fromLineId,targetShotId:shotId,targetLineId:lineId});
  };
  for(const entry of snapshot.entries){
    if(!afterViews.has(entry.shotId)&&entry.settings!==null){if(!retired.has(entry.shotId))conflicts.push({code:"retired-settings",shotId:entry.shotId,lineId:null,reason:"Review disposal or explicit transfer of this retired shot's saved artistic settings."});else changes.push({kind:"retired",shotId:entry.shotId,lineId:null,targetShotId:null,targetLineId:null});}
    for(const line of entry.lines){const decisionKey=entry.shotId+":"+line.lineId,decision=decisions.get(decisionKey),direction=entry.settings!.lines!.find(row=>row.index===line.index)!;
      if(replacements.has(entry.shotId)){if(decision)editFail("Choose a complete settings replacement or individual line decisions, without overlapping them.");continue;}
      if(decision){used.add(decisionKey);for(const target of decision.targets)add(target.shotId,target.lineId,direction,entry.shotId,line.lineId,true);
        if(!decision.targets.length)changes.push({kind:"line-dropped",shotId:entry.shotId,lineId:line.lineId,targetShotId:null,targetLineId:null});continue;}
      const before=beforeViews.get(entry.shotId)!.lines.find(row=>row.lineId===line.lineId)!,after=afterViews.get(entry.shotId)?.lines.find(row=>row.lineId===line.lineId);
      const meaning=(source:LineSource)=>({character:source.character,text:source.text,cues:source.cues});
      if(after&&same(meaning(before.source),meaning(after.source)))add(entry.shotId,line.lineId,direction,entry.shotId,line.lineId,false);
      else conflicts.push({code:"line-review",shotId:entry.shotId,lineId:line.lineId,reason:"This directed line was removed, replaced, transferred or changed speaker/cues. Explicitly choose its new physical targets or remove the override."});
    }
  }
  if(used.size!==decisions.size)editFail("Every line decision must identify an existing saved physical-line override.");
  for(const chosen of values.values())if(chosen?.lines)chosen.lines.sort((a,b)=>a.index-b.index);
  const candidate=conflicts.length?null:bind(value.after,afterViews,value.after.plan.shots.map(row=>({shotId:row.id,settings:values.get(row.id)!})));
  return portable(seal({schema:"hv-current-direction-review/1" as const,beforeRevision:snapshot.revision,request,candidate,changes,conflicts}));
}
/** Apply once to freshly resolved/cast shots; current casting, reference and publication checks remain mandatory at the service boundary. */
export function applyCurrentDirection(snapshot:CurrentDirectionSnapshot,input:CurrentDirectionContext,resolved:Shot[]):Shot[] {
  const value=portable({snapshot,input,resolved}),view=views(value.input),state=checked(value.snapshot,value.input,view);
  if(value.resolved.length!==state.entries.length)editFail("Apply directions to the complete ordered current shot plan.");
  return state.entries.map((entry,i)=>{const shot=value.resolved[i]!,base=view.get(entry.shotId)!.shot;
    if(shot.id!==entry.renderId||hash(directionSource(shot))!==entry.sourceHash||shot.seed!==base.seed||shot.durationSec!==base.durationSec||!same(shot.coverageIntent??null,base.coverageIntent??null)||!same(shot.cutDurationFrames??null,base.cutDurationFrames??null))editFail("The resolved shot no longer matches its current direction source.");
    if(shot.direction!==undefined||shot.directionRevision!==undefined)editFail("Apply current direction once to the resolved base/cast shot, before any other shot direction.");
    const chosen=entry.settings??(shot.coverageIntent?sourceDirection(shot):null);return chosen?{...applyShotDirection(shot,chosen),directionRevision:state.revision}:shot;
  });
}
