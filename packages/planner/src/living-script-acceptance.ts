import {createHash} from "node:crypto";
import type {ScriptVersion} from "../../parser/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {castingSnapshot,validateCasting,type CastingSnapshot} from "./casting";
import {directionSnapshot,validateDirection,type DirectionSnapshot} from "./direction";
import {validateEditLibrary,type EditLibrary} from "./edit-library";
import {editHistoryReplay} from "./edit-history";
import {editFail,editId,editNumber} from "./edit-timeline";
import {compileEditScriptSource} from "./edit-script-source";
import {compileLivingScriptPatch} from "./living-script-patch";
import {compileLivingScriptRecut,type LivingScriptRecut,type LivingScriptRecutInput,type LivingScriptRecutSource} from "./living-script-recut";
import {validateLivingScriptSettings,type LivingScriptSettingsBaseline} from "./living-script-settings";

export const LIVING_SCRIPT_ACCEPTANCE_LIMITS={inputBytes:128*1024**2,responseBytes:128*1024**2,receiptBytes:1024**2} as const;
export interface LivingScriptAcceptanceContext {
  projectId:string;editorial:EditLibrary;currentScript:{version:number;text:string};
  currentCasting:CastingSnapshot;currentDirection:DirectionSnapshot;
}
export interface LivingScriptAcceptanceRequest {
  id:string;name:string;reviewRevision:string;baseline:LivingScriptSettingsBaseline;recutInput:LivingScriptRecutInput;recut:LivingScriptRecut;
}
interface ScriptIdentity {version:number;sha256:string;scriptRevision:string}
export interface LivingScriptAcceptance {
  schema:"hv-living-script-acceptance/1";id:string;projectId:string;name:string;acceptedAt:string;requestHash:string;
  reviewRevision:string;patchRevision:string;generationRevision:string;sourceMapRevision:string;recutRevision:string;
  beforeScript:ScriptIdentity;afterScript:ScriptIdentity;
  beforeSource:LivingScriptRecutSource;afterSource:LivingScriptRecutSource;
  line:{beforeEntryId:string;afterEntryId:string;protectedLines:number[]};
  parent:{sequenceId:string;rootRevision:string;eventCount:number;historyRevision:string;timelineRevision:string};
  sequence:{id:string;createdAt:string;rootRevision:string;eventCount:number;historyRevision:string;timelineRevision:string;sourceReceipts:{sourceId:string;receiptRevision:string}[]};
  beforeEditorialRevision:string;afterEditorialRevision:string;castingRevision:string;directionRevision:string;afterCastingRevision:string;afterDirectionRevision:string;revision:string;
}
export interface LivingScriptAcceptanceBundle {nextEditLibrary:EditLibrary;nextScript:ScriptVersion;nextCasting:CastingSnapshot;nextDirection:DirectionSnapshot;acceptance:LivingScriptAcceptance}
export interface LivingScriptAcceptanceRetained {projectId:string;versions:ScriptVersion[];editorial:EditLibrary}

function portable<T>(input:T,limit:number):T {
  const active=new Set<object>();const visit=(value:unknown,depth:number):void=>{
    if(value===null||typeof value==="string"||typeof value==="boolean")return;
    if(typeof value==="number"){if(!Number.isFinite(value)||Object.is(value,-0))editFail("Retain finite linked acceptance values.");return;}
    if(typeof value!=="object"||depth>128||active.has(value))editFail("Retain portable linked acceptance metadata.");
    const array=Array.isArray(value),prototype=Object.getPrototypeOf(value),keys=Reflect.ownKeys(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)editFail("Retain plain linked acceptance records.");
    if(array&&keys.length!==value.length+1)editFail("Retain dense linked acceptance arrays.");active.add(value);
    for(const key of keys){if(array&&key==="length")continue;const property=Object.getOwnPropertyDescriptor(value,key)!;if(typeof key!=="string"||!property.enumerable||!Object.hasOwn(property,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))editFail("Retain enumerable linked acceptance fields without accessors.");visit(property.value,depth+1);}active.delete(value);
  };visit(input,0);if(Buffer.byteLength(JSON.stringify(input),"utf8")>limit)editFail("The complete linked acceptance exceeds its metadata capacity.");return structuredClone(input);
}
function exact(value:unknown,keys:string[]):void {if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))editFail("Retain the exact linked acceptance fields.");}
function hash(value:unknown):void {if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))editFail("Retain a complete linked acceptance revision.");}
function iso(value:unknown):boolean {if(typeof value!=="string")return false;const time=Date.parse(value);return Number.isFinite(time)&&new Date(time).toISOString()===value;}
function label(value:unknown):string {if(typeof value!=="string"||!value.trim()||value.length>160||[...value].some(char=>char.charCodeAt(0)<32))editFail("Name the independent recut in 160 readable characters or fewer.");return value.trim();}
function identity(version:number,text:string):ScriptIdentity{return {version,sha256:createHash("sha256").update(text,"utf8").digest("hex"),scriptRevision:contentHash({scriptVersion:version,scriptText:text})};}
function sourceIdentity(value:LivingScriptRecutSource):void {exact(value,["sourceId","sourceRevision","receiptRevision","indexRevision"]);editId(value.sourceId);for(const name of ["sourceRevision","receiptRevision","indexRevision"] as const)hash(value[name]);}

/** Detached metadata transform. The service must fence current state and permissions, persist all
 * all members atomically, and handle exact replay before calling this stale-version check. */
export function compileLivingScriptAcceptance(context:LivingScriptAcceptanceContext,request:LivingScriptAcceptanceRequest,now=Date.now()):LivingScriptAcceptanceBundle {
  const args=portable({context,request},LIVING_SCRIPT_ACCEPTANCE_LIMITS.inputBytes),current=args.context,asked=args.request;
  exact(current,["projectId","editorial","currentScript","currentCasting","currentDirection"]);exact(current.currentScript,["version","text"]);exact(asked,["id","name","reviewRevision","baseline","recutInput","recut"]);
  editId(current.projectId);editId(asked.id);const name=label(asked.name);hash(asked.reviewRevision);editNumber(now,0,8640000000000000,"Linked acceptance time");
  const editorial=validateEditLibrary(current.editorial,current.projectId),input=asked.recutInput;
  if(input.projectId!==current.projectId||contentHash(input.library)!==contentHash(editorial))editFail("The editorial library changed after this linked recut review.");
  if(current.currentScript.version!==input.patch.before.version||current.currentScript.text!==input.patch.before.text)editFail("The current screenplay changed after this linked recut review.");
  const casting=validateCasting(current.currentCasting,current.projectId),direction=validateDirection(current.currentDirection,current.projectId),settings=validateLivingScriptSettings(asked.baseline,input.candidate,current.projectId);
  if(contentHash(casting)!==contentHash(current.currentCasting)||contentHash(direction)!==contentHash(current.currentDirection)||contentHash(casting)!==contentHash(asked.baseline.casting)||contentHash(direction)!==contentHash(asked.baseline.direction))editFail("Current cast or direction differs from the reviewed screenplay baseline.");
  const reviewTime=Date.parse(asked.recut.createdAt);if(!iso(asked.recut.createdAt)||now<reviewTime)editFail("Accept a linked recut after its retained review time.");
  const recut=compileLivingScriptRecut({...input,library:editorial},reviewTime);
  if(asked.reviewRevision!==recut.revision||contentHash(recut)!==contentHash(asked.recut))editFail("The reviewed linked recut changed. Compare its complete generated media and operations again.");
  const acceptedAt=new Date(now).toISOString(),nextScript:ScriptVersion={version:input.patch.after.version,text:input.patch.after.text,createdAt:acceptedAt,parentVersion:input.patch.before.version};
  const sources=[...editorial.sources];if(!sources.some(source=>source.revision===input.generated.revision))sources.push(structuredClone(input.generated));
  const sequence={id:recut.sequenceId,label:name,createdAt:acceptedAt,sourceRevisions:recut.sourceReceipts.map(binding=>binding.receiptRevision),history:structuredClone(recut.history)},data={schema:editorial.schema,version:editorial.version+1,sources,sequences:[...editorial.sequences,sequence]},nextEditLibrary=validateEditLibrary({...data,revision:contentHash(data)},current.projectId);
  const parent=editorial.sequences.find(sequence=>sequence.id===recut.parent.sequenceId)!;
  const value:Omit<LivingScriptAcceptance,"revision">={schema:"hv-living-script-acceptance/1",id:asked.id,projectId:current.projectId,name,acceptedAt,requestHash:contentHash({schema:"hv-living-script-accept-request/1",...asked}),reviewRevision:asked.reviewRevision,patchRevision:recut.patchRevision,generationRevision:recut.generationRevision,sourceMapRevision:recut.sourceMapRevision,recutRevision:recut.revision,beforeScript:identity(input.patch.before.version,input.patch.before.text),afterScript:identity(nextScript.version,nextScript.text),beforeSource:recut.beforeSource,afterSource:recut.afterSource,line:{beforeEntryId:input.patch.mapping.oldEntryId,afterEntryId:recut.newLineEntryId,protectedLines:input.patch.protectedLines},parent:{sequenceId:recut.parent.sequenceId,rootRevision:parent.history.root.revision,eventCount:parent.history.events.length,historyRevision:recut.parent.historyRevision,timelineRevision:recut.parent.timeline.revision},sequence:{id:sequence.id,createdAt:sequence.createdAt,rootRevision:sequence.history.root.revision,eventCount:sequence.history.events.length,historyRevision:sequence.history.revision,timelineRevision:recut.afterTimeline.revision,sourceReceipts:recut.sourceReceipts},beforeEditorialRevision:editorial.revision,afterEditorialRevision:nextEditLibrary.revision,castingRevision:casting.revision,directionRevision:direction.revision,afterCastingRevision:settings.casting.revision,afterDirectionRevision:settings.direction.revision};
  const acceptance=portable({...value,revision:contentHash(value)},LIVING_SCRIPT_ACCEPTANCE_LIMITS.receiptBytes);
  return portable({nextEditLibrary,nextScript,nextCasting:settings.casting,nextDirection:settings.direction,acceptance},LIVING_SCRIPT_ACCEPTANCE_LIMITS.responseBytes);
}

/** Verify retained linkage after restore or later edits. Later sequence renames, appended events
 * and screenplay versions are allowed. The durable ledger must also retain the full reviewed
 * request to revalidate baseline settings, exact settings succession and generation/recut approval;
 * compact hashes alone do not grant authority. Historical settings come from retained receipts
 * and that request, never the project's rolling cast/direction history. */
export function validateLivingScriptAcceptance(input:LivingScriptAcceptance,retained:LivingScriptAcceptanceRetained):LivingScriptAcceptance {
  const receipt=portable(input,LIVING_SCRIPT_ACCEPTANCE_LIMITS.receiptBytes),context=portable(retained,LIVING_SCRIPT_ACCEPTANCE_LIMITS.inputBytes);
  exact(receipt,["schema","id","projectId","name","acceptedAt","requestHash","reviewRevision","patchRevision","generationRevision","sourceMapRevision","recutRevision","beforeScript","afterScript","beforeSource","afterSource","line","parent","sequence","beforeEditorialRevision","afterEditorialRevision","castingRevision","directionRevision","afterCastingRevision","afterDirectionRevision","revision"]);exact(context,["projectId","versions","editorial"]);
  if(receipt.schema!=="hv-living-script-acceptance/1"||receipt.projectId!==context.projectId||receipt.name!==label(receipt.name)||!iso(receipt.acceptedAt))editFail("Invalid retained linked acceptance identity.");editId(receipt.id);editId(receipt.projectId);
  for(const key of ["requestHash","reviewRevision","patchRevision","generationRevision","sourceMapRevision","recutRevision","beforeEditorialRevision","afterEditorialRevision","castingRevision","directionRevision","afterCastingRevision","afterDirectionRevision","revision"] as const)hash(receipt[key]);
  const {revision,...data}=receipt;if(revision!==contentHash(data)||receipt.reviewRevision!==receipt.recutRevision)editFail("The linked acceptance seal changed.");
  for(const script of [receipt.beforeScript,receipt.afterScript]){exact(script,["version","sha256","scriptRevision"]);editNumber(script.version,1,Number.MAX_SAFE_INTEGER,"Retained screenplay version");hash(script.sha256);hash(script.scriptRevision);}
  if(receipt.afterScript.version!==receipt.beforeScript.version+1||!Array.isArray(context.versions))editFail("Retain the exact linked screenplay version succession.");
  let previous=0;for(const version of context.versions){exact(version,["version","text","createdAt","parentVersion"]);editNumber(version.version,1,Number.MAX_SAFE_INTEGER,"Retained screenplay version");if(version.version<=previous||typeof version.text!=="string"||version.text.length>200000||!iso(version.createdAt)||version.parentVersion!==null&&(!Number.isSafeInteger(version.parentVersion)||version.parentVersion<1||version.parentVersion>=version.version))editFail("Retain ordered screenplay history for linked acceptance.");previous=version.version;}
  const before=context.versions.find(version=>version.version===receipt.beforeScript.version),after=context.versions.find(version=>version.version===receipt.afterScript.version);
  if(!before||!after||contentHash(identity(before.version,before.text))!==contentHash(receipt.beforeScript)||contentHash(identity(after.version,after.text))!==contentHash(receipt.afterScript)||after.parentVersion!==before.version||after.createdAt!==receipt.acceptedAt)editFail("The accepted screenplay texts or explicit parent/version changed.");
  sourceIdentity(receipt.beforeSource);sourceIdentity(receipt.afterSource);exact(receipt.line,["beforeEntryId","afterEntryId","protectedLines"]);hash(receipt.line.beforeEntryId);hash(receipt.line.afterEntryId);
  const library=validateEditLibrary(context.editorial,context.projectId),old=library.sources.find(source=>source.revision===receipt.beforeSource.receiptRevision),next=library.sources.find(source=>source.revision===receipt.afterSource.receiptRevision);if(!old||!next)editFail("The linked acceptance lost its independently retained original sources.");
  const casting=validateCasting(next.job.casting??castingSnapshot(context.projectId,0,[],0),context.projectId),direction=validateDirection(next.job.direction??directionSnapshot(context.projectId,0,[],0),context.projectId);
  if(casting.revision!==receipt.afterCastingRevision||direction.revision!==receipt.afterDirectionRevision)editFail("The accepted cast or direction differs from its retained generated film.");
  const oldIndex=compileEditScriptSource(old),newIndex=compileEditScriptSource(next),asSource=(index:typeof oldIndex)=>({sourceId:index.sourceId,sourceRevision:index.sourceRevision,receiptRevision:index.receiptRevision,indexRevision:index.revision});
  if(contentHash(asSource(oldIndex))!==contentHash(receipt.beforeSource)||contentHash(asSource(newIndex))!==contentHash(receipt.afterSource)||oldIndex.scriptRevision!==receipt.beforeScript.scriptRevision||newIndex.scriptRevision!==receipt.afterScript.scriptRevision)editFail("The linked acceptance lost its exact original screenplay source identities.");
  const revised=newIndex.entries.find(entry=>entry.id===receipt.line.afterEntryId);if(!revised||revised.kind!=="dialogue")editFail("The accepted revised dialogue entry is unavailable.");
  const patch=compileLivingScriptPatch(old,{entryId:receipt.line.beforeEntryId,indexRevision:oldIndex.revision,currentScript:{version:before.version,text:before.text},replacement:revised.text,protectedLines:receipt.line.protectedLines});
  if(patch.revision!==receipt.patchRevision||patch.after.text!==after.text||patch.line.physicalLine!==revised.startLine||revised.endLine!==revised.startLine||patch.mapping.sceneIndex!==revised.sceneIndex)editFail("The accepted physical screenplay line changed during restoration.");
  exact(receipt.parent,["sequenceId","rootRevision","eventCount","historyRevision","timelineRevision"]);editId(receipt.parent.sequenceId);hash(receipt.parent.rootRevision);hash(receipt.parent.historyRevision);hash(receipt.parent.timelineRevision);editNumber(receipt.parent.eventCount,0,1000,"Retained parent history length");
  const parent=library.sequences.find(sequence=>sequence.id===receipt.parent.sequenceId);if(!parent||parent.history.root.revision!==receipt.parent.rootRevision||parent.history.events.length<receipt.parent.eventCount)editFail("The linked acceptance lost its retained parent history.");
  const parentData={schema:parent.history.schema,id:parent.id,root:parent.history.root,events:parent.history.events.slice(0,receipt.parent.eventCount)},parentPrefix={...parentData,revision:contentHash(parentData)},parentReplay=editHistoryReplay(parentPrefix);
  if(parentPrefix.revision!==receipt.parent.historyRevision||parentReplay.state.timeline.revision!==receipt.parent.timelineRevision)editFail("The accepted parent history prefix changed.");
  exact(receipt.sequence,["id","createdAt","rootRevision","eventCount","historyRevision","timelineRevision","sourceReceipts"]);editId(receipt.sequence.id);for(const key of ["rootRevision","historyRevision","timelineRevision"] as const)hash(receipt.sequence[key]);editNumber(receipt.sequence.eventCount,1,1000,"Accepted recut history length");
  if(receipt.sequence.id===receipt.parent.sequenceId||receipt.sequence.createdAt!==receipt.acceptedAt||receipt.sequence.rootRevision!==receipt.parent.timelineRevision)editFail("The accepted recut lost its independent frozen parent.");
  const sequence=library.sequences.find(sequence=>sequence.id===receipt.sequence.id);if(!sequence||sequence.createdAt!==receipt.sequence.createdAt||sequence.history.events.length<receipt.sequence.eventCount||sequence.history.root.revision!==receipt.sequence.rootRevision)editFail("The linked acceptance lost its retained recut history.");
  const prefixData={schema:sequence.history.schema,id:sequence.id,root:sequence.history.root,events:sequence.history.events.slice(0,receipt.sequence.eventCount)},prefix={...prefixData,revision:contentHash(prefixData)},replay=editHistoryReplay(prefix),full=editHistoryReplay(sequence.history);
  if(prefix.revision!==receipt.sequence.historyRevision||replay.state.timeline.revision!==receipt.sequence.timelineRevision||!Array.isArray(receipt.sequence.sourceReceipts))editFail("The accepted recut history prefix changed.");
  const bindings=replay.catalog.map(source=>({sourceId:source.id,receiptRevision:sequence.sourceRevisions[full.catalog.findIndex(item=>item.id===source.id)]!}));
  if(contentHash(bindings)!==contentHash(receipt.sequence.sourceReceipts)||!bindings.some(binding=>binding.receiptRevision===receipt.beforeSource.receiptRevision)||!bindings.some(binding=>binding.receiptRevision===receipt.afterSource.receiptRevision))editFail("The accepted recut lost exact historical source bindings.");
  const parentBindings=new Map(editHistoryReplay(parent.history).catalog.map((source,index)=>[source.id,parent.sourceRevisions[index]!])),acceptedBindings=new Map(bindings.map(binding=>[binding.sourceId,binding.receiptRevision]));
  if(parentReplay.state.timeline.sources.some(source=>parentBindings.get(source.id)!==acceptedBindings.get(source.id)))editFail("The accepted parent lost its exact original receipt bindings.");
  return receipt;
}
