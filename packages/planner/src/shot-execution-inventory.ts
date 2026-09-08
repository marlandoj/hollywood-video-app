import {contentHash as hash} from "../../generator/src/capabilities";
import {assertRenderedOrigin,assertSpeechInput,renderInputHash,renderShots,validateRenderRecord,type ShotRenderRecord} from "./shot-reuse";
import {validateShotExecutionCapture,type ShotExecutionCapture} from "./shot-execution-capture";
import {TIERS,type Job} from "../../queue/src/index";
import type {VideoClip} from "../../generator/src/index";
import {parseFountain} from "../../parser/src/index";
import {compileShotRenderRecipe} from "./shot-render-recipe";

export interface ShotExecutionInventoryRow {
  shotId:string;recordRevision:string;capture:ShotExecutionCapture|null;
  unavailableReason:null|"legacy-checkpoint"|"reused-source";
}
export const SHOT_EXECUTION_INVENTORY_LIMITS={shots:60,bytes:128*1024**2,nodes:2500000} as const;
export interface ShotExecutionCheckpointPayload {records:ShotRenderRecord[];inventory:ShotExecutionInventoryRow[]}
// Pure historical validation only: bounded digests retain no jobs, media or permissions.
const validCompletedEvidence=new Set<string>();
function fail(reason:string):never{throw new Error(reason);}
function portable<T>(input:T,allowUndefinedProperties=false):T {
  let nodes=0,bytes=0;const active=new Set<object>();
  const visit=(value:unknown,depth:number):void=>{
    if(++nodes>SHOT_EXECUTION_INVENTORY_LIMITS.nodes||depth>180)fail("Worker execution inventory exceeds its metadata capacity.");
    if(typeof value==="string"){bytes+=Buffer.byteLength(value,"utf8");if(bytes>SHOT_EXECUTION_INVENTORY_LIMITS.bytes)fail("Worker execution inventory exceeds its metadata capacity.");return;}
    if(value===null||typeof value==="boolean"||typeof value==="number"&&Number.isFinite(value)&&!Object.is(value,-0))return;
    if(typeof value!=="object"||active.has(value))fail("Retain portable worker execution inventory.");
    const array=Array.isArray(value),keys=Reflect.ownKeys(value),prototype=Object.getPrototypeOf(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)fail("Retain plain execution inventory records.");
    if(array&&keys.length!==value.length+1)fail("Retain dense execution inventory arrays.");active.add(value);
    for(const key of keys){if(array&&key==="length")continue;const field=Object.getOwnPropertyDescriptor(value,key)!;
      if(typeof key!=="string"||!field.enumerable||!Object.hasOwn(field,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))fail("Retain execution inventory without accessors or hidden data.");
      bytes+=Buffer.byteLength(key,"utf8");if(bytes>SHOT_EXECUTION_INVENTORY_LIMITS.bytes)fail("Worker execution inventory exceeds its metadata capacity.");
      if(!array&&field.value===undefined&&allowUndefinedProperties){if(++nodes>SHOT_EXECUTION_INVENTORY_LIMITS.nodes)fail("Worker execution inventory exceeds its metadata capacity.");continue;}visit(field.value,depth+1);
    }active.delete(value);
  };visit(input,0);if(Buffer.byteLength(JSON.stringify(input),"utf8")>SHOT_EXECUTION_INVENTORY_LIMITS.bytes)fail("Worker execution inventory exceeds its metadata capacity.");return structuredClone(input);
}
function storedInventory(job:Job):ShotExecutionInventoryRow[]|undefined {
  const field=Object.getOwnPropertyDescriptor(job,"executionCheckpoints");if(field&&!Object.hasOwn(field,"value"))fail("Retain stored execution fields without accessors.");return field?.value;
}
function validateJobFields(job:Job):Record<string,unknown> {
  const fields:Record<string,unknown>={};
  for(const key of ["id","projectId","stage","tier","scriptText","casting","direction","providerPlan","shotReuse","startedAt","characterSheet","shotTakes","checkpointShots","checkpointFrame","executionCheckpoints","routeDecisions"]){
    const field=Object.getOwnPropertyDescriptor(job,key);if(field&&!Object.hasOwn(field,"value"))fail("Retain admitted execution context without accessors.");
    if(field)fields[key]=field.value;
  }
  return portable(fields,true);
}
function undefinedFields(value:unknown,path:string[]=[],found:string[]=[]):string[] {
  if(value&&typeof value==="object")for(const [key,item]of Object.entries(value)){
    const next=[...path,key];if(item===undefined)found.push(JSON.stringify(next));else undefinedFields(item,next,found);
  }
  return found.sort();
}
/** A complete private record-order inventory. This does not establish worker custody by itself. */
export function validateShotExecutionInventory(input:ShotExecutionInventoryRow[],records:ShotRenderRecord[]):ShotExecutionInventoryRow[] {
  const value=portable({input,records}),rows=value.input,clips=value.records;
  if(!Array.isArray(rows)||!Array.isArray(clips)||rows.length!==clips.length||rows.length>60||new Set(clips.map(record=>record.shotId)).size!==clips.length)fail("Retain one execution inventory row per unique ordered shot record.");
  return rows.map((row,i)=>{
    const record=clips[i]!;validateRenderRecord(record,{projectId:clips[0]!.projectId,id:clips[0]!.jobId});
    if(!row||Object.keys(row).sort().join(",")!=="capture,recordRevision,shotId,unavailableReason"||row.shotId!==record.shotId||row.recordRevision!==record.revision)fail("Execution inventory no longer matches its ordered immutable shot record.");
    if(row.capture!==null){if(row.unavailableReason!==null||record.reusedFrom)fail("A copied or unavailable shot cannot claim a fresh destination execution.");validateShotExecutionCapture(row.capture,record);}
    else if(record.reusedFrom?row.unavailableReason!=="reused-source":row.unavailableReason!=="legacy-checkpoint")fail("Retain the explicit reason this shot has no fresh worker execution capture.");
    return row;
  });
}
export function validateShotExecutionCheckpointPayload(input:ShotExecutionCheckpointPayload):ShotExecutionCheckpointPayload {
  const value=portable(input);if(!value||Object.keys(value).sort().join(",")!=="inventory,records")fail("Retain exact private execution checkpoint fields.");
  return {records:value.records,inventory:validateShotExecutionInventory(value.inventory,value.records)};
}
/** Snapshot envelope validation only. A checkpoint-only snapshot cannot prove render/capture
 * consistency without its separately retained clip manifest; archive media validation must. */
export function validateShotExecutionInventoryMetadata(input:ShotExecutionInventoryRow[],job:Pick<Job,"id"|"projectId"|"checkpointShots">):ShotExecutionInventoryRow[] {
  const rows=portable(input),digest=(value:unknown)=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
  if(!Array.isArray(rows)||rows.length>60||rows.length!==job.checkpointShots||new Set(rows.map(row=>row?.shotId)).size!==rows.length)fail("Retain the complete unique private checkpoint inventory.");
  for(const row of rows){
    if(!row||Object.keys(row).sort().join(",")!=="capture,recordRevision,shotId,unavailableReason"||typeof row.shotId!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(row.shotId)||!digest(row.recordRevision))fail("Retain exact private checkpoint identities.");
    if(row.capture===null){if(!["legacy-checkpoint","reused-source"].includes(row.unavailableReason??""))fail("Retain an explicit unavailable checkpoint reason.");continue;}
    const capture=row.capture;
    if(!capture||Object.keys(capture).sort().join(",")!=="currentAuthority,custody,inputHash,jobId,observation,projectId,ranking,recordRevision,revision,routeDecisionIds,routes,schema,shotId"||row.unavailableReason!==null||capture.schema!=="hv-shot-execution-capture/1"||capture.projectId!==job.projectId||capture.jobId!==job.id||capture.shotId!==row.shotId||capture.recordRevision!==row.recordRevision||capture.custody!=="unverified"||capture.currentAuthority!==false||!digest(capture.inputHash)||!digest(capture.revision))fail("Retain the private capture envelope for this exact checkpoint owner.");
    const {revision,...data}=capture;if(hash(data)!==revision)fail("The private checkpoint capture seal changed.");
  }
  return rows;
}
/** Historical validation uses the retained admission and start time, never current permissions. */
export function validateJobExecutionRecords(job:Job,records:ShotRenderRecord[],complete=false):void {
  validateJobFields(job);
  const checked=portable(records),at=Date.parse(job.startedAt??"");
  if(!["animatic","final"].includes(job.stage)||job.characterSheet||job.shotTakes||!Number.isSafeInteger(at))fail("Worker execution evidence requires an admitted film and its render start.");
  const planned=renderShots(job,at);
  if(!Array.isArray(checked)||checked.length>planned.length||complete&&checked.length!==planned.length)fail("Complete every admitted shot before publishing execution custody.");
  for(const [i,record]of checked.entries()){
    validateRenderRecord(record,job);assertRenderedOrigin(record,job);
    if(planned[i]!.id!==record.shotId||renderInputHash(job,planned[i]!)!==record.inputHash)fail("Worker execution records differ from the exact admitted input prefix.");
    assertSpeechInput(record,planned[i]!);
  }
}
function validateAdmittedCaptures(job:Job,checked:ShotExecutionCheckpointPayload):void {
  const planned=renderShots(job,Date.parse(job.startedAt??"")),parsed=parseFountain(job.scriptText);
  for(const [i,row]of checked.inventory.entries())if(row.capture){
    const shot=planned[i]!,heading=parsed.scenes[shot.sceneIndex]?.heading;
    const expected=compileShotRenderRecipe({projectId:job.projectId,stage:job.stage as "animatic"|"final",shot,outputSize:job.stage==="animatic"?"640x360":TIERS[job.tier].maxResolution,
      providerPlan:job.providerPlan!,richAnimaticProviders:job.providerPlan!.pool.map(entry=>entry.snapshot.adapter==="rich-animatic"),...(heading===undefined?{}:{sceneHeading:heading})});
    if(hash(expected)!==hash(row.capture.observation.recipe))fail("The captured execution recipe differs from its admitted screenplay inputs.");
  }
}
function validateCapturedJournal(job:Job,checked:ShotExecutionCheckpointPayload):void {
  const journal=job.routeDecisions??[],ids=new Set(journal.map(route=>route.id));
  if(ids.size!==journal.length)fail("The durable routing journal contains duplicate decisions.");
  for(const row of checked.inventory)if(row.capture)for(const route of row.capture.routes){
    const saved=journal.find(value=>value.id===route.id);
    if(!saved||hash(saved)!==hash(route))fail("The captured route differs from its durable worker journal.");
  }
}
export function validateJobExecutionCheckpoint(job:Job,input:ShotExecutionCheckpointPayload):ShotExecutionCheckpointPayload {
  const checked=validateShotExecutionCheckpointPayload(input);validateJobExecutionRecords(job,checked.records);validateAdmittedCaptures(job,checked);validateCapturedJournal(job,checked);return checked;
}
/** Optional private completed evidence must equal the complete immutable checkpoint. */
export function validateShotExecutionOutput(job:Job,output:NonNullable<Job["output"]>):void {
  // Legacy outputs retain their old validation path, while relevant descriptors are checked
  // before deciding whether private execution evidence is present.
  const fields=["shotExecutions","shotRenders"].map(key=>Object.getOwnPropertyDescriptor(output,key));
  if(fields.some(field=>field&&!Object.hasOwn(field,"value")))fail("Retain completed execution fields without accessors.");
  const [inventory,records]=fields.map(field=>field?.value);
  const saved=storedInventory(job);
  if(saved===undefined&&inventory===undefined)return;
  const context=validateJobFields(job);
  if(!saved||!inventory||!records)fail("Checkpoint the complete private execution inventory before completing its film.");
  const portableOutput=portable({records,inventory}),key=hash({context,undefinedFields:undefinedFields(context),...portableOutput});
  if(validCompletedEvidence.has(key)){validCompletedEvidence.delete(key);validCompletedEvidence.add(key);return;}
  const checked=validateShotExecutionCheckpointPayload({records,inventory});
  if(checked.records.length!==job.checkpointShots||checked.records.reduce((frames,record)=>frames+Math.round(record.clip.durationSec*30),0)!==job.checkpointFrame)fail("Completed execution evidence lost its exact checkpoint count or frames.");
  validateJobExecutionRecords(job,checked.records,true);
  validateAdmittedCaptures(job,checked);validateCapturedJournal(job,checked);
  const previous=validateShotExecutionInventory(saved,checked.records);
  if(hash(checked.inventory)!==hash(previous))fail("Completed execution evidence must equal its immutable worker checkpoint.");
  validCompletedEvidence.add(key);if(validCompletedEvidence.size>64)validCompletedEvidence.delete(validCompletedEvidence.values().next().value!);
}
/** Clip manifests remain public media metadata; captures live only in the private inventory.
 * This preflight may use the worker's stale admitted job. The held checkpoint transaction
 * separately binds routes to the current durable journal before granting checkpoint custody. */
export function validateShotExecutionClips(job:Job,clips:VideoClip[],inventory?:ShotExecutionInventoryRow[]):ShotExecutionCheckpointPayload|undefined {
  const saved=storedInventory(job);inventory??=saved;if(inventory===undefined)return;
  validateJobFields(job);
  const safeClips=portable(clips,true),checked=validateShotExecutionCheckpointPayload({records:safeClips.map(clip=>clip.renderRecord!),inventory});
  validateJobExecutionRecords(job,checked.records);
  validateAdmittedCaptures(job,checked);
  for(const [i,clip]of safeClips.entries()){
    const {path:_path,audioPath:_audioPath,posterPath:_posterPath,sourcePosterPath:_sourcePosterPath,cost:_cost,renderRecord:_record,...metadata}=clip;
    if(hash(metadata)!==hash(checked.records[i]!.clip))fail("The checkpoint clip differs from its immutable execution record.");
    for(const [field,kind]of [["path","video"],["audioPath","audio"],["posterPath","poster"],["sourcePosterPath","sourcePoster"]] as const)if(Boolean(clip[field])!==Boolean(checked.records[i]!.files[kind]))fail("The checkpoint lost an immutable rendered media role.");
  }
  return checked;
}
/** Called under the job's held mutation. Only the already durable legacy prefix may introduce
 * historical absence; a newly generated appended shot requires a real capture. */
export function advanceShotExecutionInventory(previous:ShotExecutionInventoryRow[]|undefined,next:ShotExecutionInventoryRow[],records:ShotRenderRecord[],checkpointShots:number):ShotExecutionInventoryRow[] {
  const value=portable({previous:previous??null,next,records,checkpointShots}),checked=validateShotExecutionInventory(value.next,value.records);
  if(!Number.isSafeInteger(value.checkpointShots)||value.checkpointShots<0||value.checkpointShots>checked.length)fail("Execution inventory cannot truncate the durable shot checkpoint.");
  if(value.previous!==null){
    if(!Array.isArray(value.previous)||value.previous.length!==value.checkpointShots)fail("The durable execution inventory lost its complete checkpoint prefix.");
    validateShotExecutionInventory(value.previous,value.records.slice(0,value.checkpointShots));
    if(hash(value.previous)!==hash(checked.slice(0,value.checkpointShots)))fail("Previously checkpointed worker execution evidence is immutable.");
  }
  for(const row of checked.slice(value.checkpointShots))if(row.unavailableReason==="legacy-checkpoint")fail("A newly generated shot requires its actual worker capture; historical absence cannot be appended.");
  return checked;
}
