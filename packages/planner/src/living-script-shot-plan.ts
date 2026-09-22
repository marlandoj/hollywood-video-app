import {contentHash} from "../../generator/src/capabilities";
import {parseFountain} from "../../parser/src/index";
import {TIERS} from "../../queue/src/index";
import type {ShotCoverage} from "./coverage";
import {compileEditScriptSource} from "./edit-script-source";
import type {EditScriptWindow} from "./edit-script-types";
import type {EditSourceReceipt} from "./edit-sources";
import {editFail} from "./edit-timeline";
import {type Shot} from "./index";
import {bootstrapLivingScriptDocument,compileLivingScriptDocument,validateLivingScriptDocumentSource,type LivingScriptDocument,type LivingScriptDocumentSource} from "./living-script-document";
import {livingScriptSceneViews as sceneViews,livingScriptDialogueGroup as dialogueGroup,livingScriptDefaultDialogue as defaultDialogue,materializeLivingScriptShotRecipe as materializeRow} from "./living-script-shot-recipe";
import {lineSources,type LineSource} from "./performances";
import {sourcePlan} from "./scene-cuts";
import {renderShots,renderInputHash,type ShotRenderRecord} from "./shot-reuse";

export const LIVING_SCRIPT_SHOT_PLAN_LIMITS={bytes:64*1024**2,nodes:1000000,shots:60,windows:100000} as const;
export interface LivingScriptShotDialogue {beatIds:string[];lineIds:string[]}
export type LivingScriptBaseRecipe = {
  kind:"legacy-default/1";actionBeatIds:string[];headingFallback:boolean;dialogue:LivingScriptShotDialogue[];
} | {
  kind:"authored-coverage/1";beatIds:string[];afterBeatId:string|null;dialogue:LivingScriptShotDialogue[];
  coverage:ShotCoverage;durationFrames:number|null;sceneNotes:string;shotNotes:string;cutRevision:string;
};
export interface LivingScriptShotIssue {code:string;shotId:string|null;sceneId:string|null;reason:string}
export interface LivingScriptPlannedShot {
  id:string;renderId:string;sceneId:string|null;originalOrdinal:number;sceneOrdinal:number;
  recipe:LivingScriptBaseRecipe|null;
  base:{seed:number;requestedFrames:number;shotRevision:string};
  directed:{seed:number;requestedFrames:number;shotRevision:string;inputHash:string};
  actual:{recordOrdinal:number;recordRevision:string;inputHash:string;seed:number;durationSec:number;frames:number|null;origin:ShotRenderRecord["origin"];reusedFrom:ShotRenderRecord["reusedFrom"]|null}|null;
  /** physicalLineId is the stable document line.id, not its version-specific physicalLineId. */
  lines:{source:LineSource;physicalLineId:string;beatId:string;entryId:string|null}[];
  windows:{entryId:string;window:EditScriptWindow}[];
}
export interface LivingScriptShotPlan {
  schema:"hv-living-script-shot-plan/1";projectId:string;rootDocument:LivingScriptDocument;
  source:LivingScriptDocumentSource["source"];rootBindingRevision:string;
  planning:{kind:"source-plan/1";baseSeed:7000;maxShots:number;stage:string;tier:string;historicalAt:string;castingRevision:string|null;directionRevision:string|null;providerPlanRevision:string};
  shots:LivingScriptPlannedShot[];recordInventory:{ordinal:number;shotId:string;revision:string;inputHash:string}[];
  issues:LivingScriptShotIssue[];indexWarnings:string[];provenanceComplete:boolean;reuseAuthority:false;revision:string;
}
export interface LivingScriptShotPlanReview {
  schema:"hv-living-script-shot-plan-review/1";projectId:string;planRevision:string;documentRevision:string;bindingRevision:string;
  shots:{id:string;renderId:string;sceneId:string|null;originalOrdinal:number;currentOrdinal:number|null;sceneIndex:number|null;status:"unchanged"|"moved"|"conflict";conflicts:LivingScriptShotIssue[]}[];
  introducedSceneIds:string[];conflicts:LivingScriptShotIssue[];materializable:boolean;reuseAuthority:false;revision:string;
}
const hash=contentHash;
const seal=<T extends object>(value:T):T&{revision:string}=>({...value,revision:hash(value)});
/** Descriptor traversal precedes every external field read, JSON/hash call and clone. */
function portable<T>(input:T):T {
  let nodes=0,bytes=0;const active=new Set<object>();
  const visit=(value:unknown,depth:number):void=>{
    if(++nodes>LIVING_SCRIPT_SHOT_PLAN_LIMITS.nodes||depth>160)editFail("The shot plan exceeds its metadata capacity.");
    if(typeof value==="string"){bytes+=Buffer.byteLength(value,"utf8");if(bytes>LIVING_SCRIPT_SHOT_PLAN_LIMITS.bytes)editFail("The shot plan exceeds its metadata capacity.");return;}
    if(value===null||typeof value==="boolean"||typeof value==="number"&&Number.isFinite(value)&&!Object.is(value,-0))return;
    if(typeof value!=="object"||active.has(value))editFail("Retain portable shot-plan data.");
    const array=Array.isArray(value),keys=Reflect.ownKeys(value),prototype=Object.getPrototypeOf(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)editFail("Retain plain shot-plan records.");
    if(array&&keys.length!==value.length+1)editFail("Retain dense shot-plan arrays.");active.add(value);
    for(const key of keys){if(array&&key==="length")continue;const field=Object.getOwnPropertyDescriptor(value,key)!;
      if(typeof key!=="string"||!field.enumerable||!Object.hasOwn(field,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))editFail("Retain shot-plan data without accessors or hidden fields.");
      bytes+=Buffer.byteLength(key,"utf8");visit(field.value,depth+1);
    }active.delete(value);
  };visit(input,0);if(Buffer.byteLength(JSON.stringify(input),"utf8")>LIVING_SCRIPT_SHOT_PLAN_LIMITS.bytes)editFail("The shot plan exceeds its metadata capacity.");return structuredClone(input);
}
class Budget {
  bytes=0;nodes=0;windows=0;
  add(value:unknown):void {const visit=(item:unknown):void=>{if(++this.nodes>LIVING_SCRIPT_SHOT_PLAN_LIMITS.nodes)editFail("The shot plan exceeds its incremental output capacity.");if(item&&typeof item==="object")for(const v of Object.values(item))visit(v);};visit(value);this.bytes+=Buffer.byteLength(JSON.stringify(value),"utf8")+1;if(this.bytes>LIVING_SCRIPT_SHOT_PLAN_LIMITS.bytes)editFail("The shot plan exceeds its incremental output capacity.");}
  window():void {if(++this.windows>LIVING_SCRIPT_SHOT_PLAN_LIMITS.windows)editFail("The shot plan exceeds its source-window capacity.");}
}
const issue=(code:string,reason:string,shotId:string|null=null,sceneId:string|null=null):LivingScriptShotIssue=>({code,shotId,sceneId,reason});
function directFilm(source:EditSourceReceipt):void {
  const job=source.job;
  const derived=["dialogueReplacement","lipSync","soundMix","pictureEdit","assemblyEdit","graphicRender","delivery","shotTakes","characterSheet"] as const;
  if(!job||!["animatic","final"].includes(job.stage)||derived.some(key=>job[key]!==undefined))
    editFail("Bootstrap the shot plan from a direct original film receipt; derived-source correspondence requires explicit review.");
  if(!Array.isArray(job.output?.shotRenders)||job.output.shotRenders.length>LIVING_SCRIPT_SHOT_PLAN_LIMITS.shots)editFail("Retain a complete source inventory within the 60-shot planning capacity.");
}
function compileRoot(source:EditSourceReceipt,binding:LivingScriptDocumentSource):LivingScriptShotPlan {
  directFilm(source);
  const current=validateLivingScriptDocumentSource(source,binding),base=current.document.context.ancestry[0]?.before??current.document.context.base;
  const rootDocument=compileLivingScriptDocument({base,ancestry:[]}),rootBinding=bootstrapLivingScriptDocument(source,rootDocument.context),index=compileEditScriptSource(source),job=source.job;
  const at=Date.parse(job.startedAt??job.completedAt??""),maxShots=TIERS[job.tier].maxShots,baseShots=sourcePlan(parseFountain(base.text),job.direction,7000,maxShots),directed=renderShots(job,at),records=job.output!.shotRenders!;
  if(baseShots.length>LIVING_SCRIPT_SHOT_PLAN_LIMITS.shots||directed.length!==baseShots.length)editFail("The complete original shot plan exceeds its supported capacity or input inventory.");
  const views=sceneViews(rootDocument),byIndex=new Map([...views.values()].map(view=>[view.scene.index,view])),baseGroups=new Map<number,Shot[]>();
  for(const shot of baseShots){const group=baseGroups.get(shot.sceneIndex)??[];group.push(shot);baseGroups.set(shot.sceneIndex,group);}
  const issues:LivingScriptShotIssue[]=[],shots:LivingScriptPlannedShot[]=[],budget=new Budget(),windows=new Map<string,LivingScriptPlannedShot["windows"]>(),entriesByLine=new Map<number,string>();
  for(const entry of index.entries){if(entry.kind==="dialogue"&&entry.startLine!==null)entriesByLine.set(entry.startLine,entry.id);for(const window of entry.windows){budget.window();if(!window.shotId)continue;const values=windows.get(window.shotId)??[],value={entryId:entry.id,window};budget.add(value);values.push(value);windows.set(window.shotId,values);}}
  const recordInventory=records.map((record,ordinal)=>({ordinal,shotId:record.shotId,revision:record.revision,inputHash:record.inputHash}));
  const planning={kind:"source-plan/1" as const,baseSeed:7000 as const,maxShots,stage:job.stage,tier:job.tier,historicalAt:new Date(at).toISOString(),castingRevision:job.casting?.revision??null,directionRevision:job.direction?.revision??null,providerPlanRevision:job.providerPlan!.revision};
  budget.add({schema:"hv-living-script-shot-plan/1",projectId:job.projectId,rootDocument,source:rootBinding.source,rootBindingRevision:rootBinding.revision,planning,recordInventory,indexWarnings:index.warnings});
  if(!rootDocument.complete)issues.push(issue("unbound-document","The source contains unsupported or unbound physical constructs; review their planning membership."));
  const fullOrder=records.length===baseShots.length&&new Set(records.map(record=>record.shotId)).size===records.length&&records.every((record,i)=>record.shotId===baseShots[i]!.id);
  if(!fullOrder)issues.push(issue("record-order","The retained records do not establish the complete unique original shot order."));
  for(const [ordinal,shot]of baseShots.entries()){
    const view=byIndex.get(shot.sceneIndex),group=baseGroups.get(shot.sceneIndex)!,sceneOrdinal=group.findIndex(value=>value.id===shot.id),rendered=directed[ordinal]!;
    if(rendered.id!==shot.id||rendered.sceneIndex!==shot.sceneIndex)editFail("The original directed plan changed its ordered shot identity.");
    let recipe:LivingScriptBaseRecipe|null=null;
    if(view&&view.document.beats.length===view.scene.beats!.length){
      const stable=new Map(view.document.beats.map(beat=>[beat.parserBeatId,beat.id])),cut=job.direction?.sceneCuts?.find(value=>value.source.sceneIndex===shot.sceneIndex),authored=cut?.shots.find(value=>value.id===shot.id);
      if(authored&&cut){const beatIds=authored.beatIds.map(id=>stable.get(id)!);recipe={kind:"authored-coverage/1",beatIds,afterBeatId:authored.afterBeatId?stable.get(authored.afterBeatId)!:null,dialogue:beatIds.filter(id=>view.beats.get(id)!.kind==="dialogue").map(id=>dialogueGroup(view,[id])),coverage:structuredClone(authored.coverage),durationFrames:authored.durationFrames,sceneNotes:cut.notes,shotNotes:authored.notes,cutRevision:cut.revision};}
      else if(!cut){const actions=view.document.beats.filter(beat=>beat.kind==="action"),size=Math.floor(actions.length/group.length),extra=actions.length%group.length,start=sceneOrdinal*size+Math.min(sceneOrdinal,extra);
        recipe={kind:"legacy-default/1",actionBeatIds:actions.slice(start,start+size+(sceneOrdinal<extra?1:0)).map(beat=>beat.id),headingFallback:actions.length===0,dialogue:sceneOrdinal===0?defaultDialogue(view):[]};}
    }
    const recordOrdinal=records.findIndex(record=>record.shotId===shot.id),record=records[recordOrdinal],actualFrames=record?Math.round(record.clip.durationSec*30):null;
    const row:LivingScriptPlannedShot={id:hash({schema:"hv-living-script-shot-identity/1",rootScriptRevision:rootDocument.scriptRevision,receiptRevision:source.revision,originalOrdinal:ordinal,renderId:shot.id}),renderId:shot.id,sceneId:view?.document.id??null,originalOrdinal:ordinal,sceneOrdinal,recipe,
      base:{seed:shot.seed,requestedFrames:shot.durationSec*30,shotRevision:hash(shot)},directed:{seed:rendered.seed,requestedFrames:rendered.durationSec*30,shotRevision:hash(rendered),inputHash:renderInputHash(job,rendered)},
      actual:record?{recordOrdinal,recordRevision:record.revision,inputHash:record.inputHash,seed:record.clip.seed,durationSec:record.clip.durationSec,frames:Math.abs(actualFrames!/30-record.clip.durationSec)<1e-6?actualFrames:null,origin:structuredClone(record.origin),reusedFrom:structuredClone(record.reusedFrom??null)}:null,lines:[],windows:windows.get(shot.id)??[]};
    if(!recipe||!view)issues.push(issue("unmapped-recipe","The original shot lacks exact physical recipe membership.",row.id,row.sceneId));
    else {
      if(hash(materializeRow(row,view))!==hash(shot))editFail("The physical shot recipe does not reproduce the original source plan exactly.");
      const lineOwners=new Map(recipe.dialogue.flatMap(g=>g.beatIds.flatMap(id=>dialogueGroup(view,[id]).lineIds.map(lineId=>[lineId,id] as const))));
      row.lines=lineSources(shot.dialogue).map(line=>{const physicalLineId=recipe!.dialogue[line.dialogueIndex]!.lineIds[line.lineIndex]!,physical=view.physical.get(physicalLineId)!;return {source:line,physicalLineId,beatId:lineOwners.get(physicalLineId)!,entryId:entriesByLine.get(physical.line)??null};});
      if(row.lines.some(line=>line.entryId===null))issues.push(issue("unbound-line-index","A planned spoken line lacks an exact source-index entry.",row.id,row.sceneId));
    }
    if(!record)issues.push(issue("missing-record","No exact original render record is retained for this planned shot.",row.id,row.sceneId));
    else if(record.inputHash!==row.directed.inputHash)editFail("The original render record differs from the reconstructed directed input.");
    if(!row.windows.some(value=>value.window.evidence==="shot-coverage"))issues.push(issue("unbound-source-clock","Retained metadata does not establish this shot's exact source interval.",row.id,row.sceneId));
    if(record&&row.actual!.frames===null)issues.push(issue("unbound-frame-duration","The actual render duration has no exact 30 fps frame count.",row.id,row.sceneId));
    // Windows were budgeted before retention; count the other row fields once.
    budget.add({...row,windows:[]});shots.push(row);
  }
  budget.add(issues);
  return seal({schema:"hv-living-script-shot-plan/1" as const,projectId:job.projectId,rootDocument,source:rootBinding.source,rootBindingRevision:rootBinding.revision,planning,shots,recordInventory,issues,indexWarnings:index.warnings,provenanceComplete:issues.length===0,reuseAuthority:false as const});
}
/** Metadata provenance only. Current permissions, carrier custody, effective settings and reuse
 * eligibility remain caller responsibilities. A recipe match never approves media reuse. */
export function bootstrapLivingScriptShotPlan(source:EditSourceReceipt,binding:LivingScriptDocumentSource):LivingScriptShotPlan {
  const copied=portable({source,binding});return compileRoot(copied.source,copied.binding);
}
export function validateLivingScriptShotPlan(source:EditSourceReceipt,plan:LivingScriptShotPlan):LivingScriptShotPlan {
  const copied=portable({source,plan});directFilm(copied.source);
  const binding=bootstrapLivingScriptDocument(copied.source,copied.plan.rootDocument.context),compiled=compileRoot(copied.source,binding);
  if(hash(compiled)!==hash(copied.plan))editFail("The saved shot plan or its original provenance changed.");return compiled;
}
function mapping(plan:LivingScriptShotPlan,binding:LivingScriptDocumentSource):LivingScriptShotPlanReview {
  const document=binding.document;
  if(document.projectId!==plan.projectId||document.rootScriptRevision!==plan.rootDocument.scriptRevision||hash(document.context.ancestry[0]?.before??document.context.base)!==hash(plan.rootDocument.context.base)||hash(binding.source)!==hash(plan.source))editFail("Review this plan against its exact original document ancestry and source binding.");
  const before=new Map(plan.rootDocument.scenes.map(scene=>[scene.id,scene])),after=new Map(document.scenes.map(scene=>[scene.id,scene])),views=sceneViews(document),conflicts:LivingScriptShotIssue[]=[],budget=new Budget();
  const introducedSceneIds=document.scenes.filter(scene=>!before.has(scene.id)).map(scene=>scene.id);
  for(const sceneId of introducedSceneIds)conflicts.push(issue("introduced-scene","An introduced or replaced scene needs an explicit current screenplay shot plan.",null,sceneId));
  if(!document.complete)conflicts.push(issue("unbound-document","Resolve the current unsupported physical constructs before materializing a complete shot plan."));
  const sceneConflicts=new Map<string,LivingScriptShotIssue[]>();
  for(const [id,old]of before){const current=after.get(id),values:LivingScriptShotIssue[]=[];
    if(!current)values.push(issue("missing-scene","The original scene was deleted, replaced or became unbound; explicitly review its shots.",null,id));
    else {
      if(old.heading!==current.heading)values.push(issue("changed-heading","Review the current scene heading and its planning context.",null,id));
      if(hash(old.beats.map(b=>b.id))!==hash(current.beats.map(b=>b.id)))values.push(issue("changed-beat-membership","Inserted, deleted, reordered, replaced, split or merged beats require an explicit scene replan.",null,id));
      else for(let i=0;i<old.beats.length;i++){const a=old.beats[i]!,b=current.beats[i]!;
        if(hash(a.lineIds)!==hash(b.lineIds))values.push(issue(a.lineIds.length===b.lineIds.length?"replaced-physical-line":"changed-line-membership",a.lineIds.length===b.lineIds.length?"An original physical line was replaced; equal text cannot inherit its identity.":"A beat gained or lost physical lines; review its exact dialogue/action membership.",null,id));
        else if(a.contentRevision!==b.contentRevision||a.kind!==b.kind||a.character!==b.character)values.push(issue("changed-beat-content","The beat's current content or speaker role needs explicit replanning.",null,id));
      }
    }
    // One code/reason per scene; many equal-sized replacements cannot amplify every shot's report.
    sceneConflicts.set(id,[...new Map(values.map(value=>[value.code,value])).values()]);
  }
  const ordered=plan.shots.filter(row=>row.sceneId&&after.has(row.sceneId)).sort((a,b)=>after.get(a.sceneId!)!.sceneIndex-after.get(b.sceneId!)!.sceneIndex||a.sceneOrdinal-b.sceneOrdinal),ordinals=new Map(ordered.map((row,i)=>[row.id,i]));
  const shots=plan.shots.map(row=>{
    const scene=row.sceneId?after.get(row.sceneId):undefined,values:LivingScriptShotIssue[]=(row.sceneId?sceneConflicts.get(row.sceneId)??[]:[]).map(value=>({...value,shotId:row.id}));
    if(!row.recipe||!row.sceneId)values.push(issue("unmapped-recipe","The original recipe has no exact supported physical membership.",row.id,row.sceneId));
    if(!values.length&&scene){try{materializeRow(row,views.get(scene.id)!);}catch{values.push(issue("unmaterializable-recipe","The canonical current recipe cannot be materialized without an explicit replan.",row.id,row.sceneId));}}
    const currentOrdinal=ordinals.get(row.id)??null,result={id:row.id,renderId:row.renderId,sceneId:row.sceneId,originalOrdinal:row.originalOrdinal,currentOrdinal,sceneIndex:scene?.sceneIndex??null,status:values.length?"conflict" as const:currentOrdinal!==row.originalOrdinal||scene?.sceneIndex!==before.get(row.sceneId!)?.sceneIndex?"moved" as const:"unchanged" as const,conflicts:values};
    budget.add(result);conflicts.push(...values);return result;
  });
  budget.add(conflicts);
  return seal({schema:"hv-living-script-shot-plan-review/1" as const,projectId:plan.projectId,planRevision:plan.revision,documentRevision:document.revision,bindingRevision:binding.revision,shots,introducedSceneIds,conflicts,materializable:conflicts.length===0,reuseAuthority:false as const});
}
export function reviewLivingScriptShotPlan(source:EditSourceReceipt,plan:LivingScriptShotPlan,binding:LivingScriptDocumentSource):LivingScriptShotPlanReview {
  const copied=portable({source,plan,binding}),checked=validateLivingScriptShotPlan(copied.source,copied.plan),current=validateLivingScriptDocumentSource(copied.source,copied.binding);return mapping(checked,current);
}
export function materializeLivingScriptBaseShots(source:EditSourceReceipt,plan:LivingScriptShotPlan,binding:LivingScriptDocumentSource):Shot[] {
  const copied=portable({source,plan,binding}),checked=validateLivingScriptShotPlan(copied.source,copied.plan),current=validateLivingScriptDocumentSource(copied.source,copied.binding),review=mapping(checked,current);
  if(!review.materializable)editFail("Review every structural shot-plan conflict before materializing the complete current screenplay.");
  const views=sceneViews(current.document),rows=new Map(checked.shots.map(row=>[row.id,row])),budget=new Budget();
  return [...review.shots].sort((a,b)=>a.currentOrdinal!-b.currentOrdinal!).map(value=>{const shot=materializeRow(rows.get(value.id)!,views.get(value.sceneId!)!);budget.add(shot);return shot;});
}
