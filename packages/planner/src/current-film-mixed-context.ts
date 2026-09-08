import type {Job} from "../../queue/src/index";
import {contentHash as hash} from "../../generator/src/capabilities";
import {validateCurrentFilmMixedJobPlan,type CurrentFilmJobV3} from "./current-film-mixed-jobs";
import {validateCurrentFilmAdoption,type CurrentFilmAdoption} from "./current-film-adoption";
import {assertSpeechInput,validateRenderRecord,type ShotRenderRecord} from "./shot-reuse";
import {validateShotExecutionCapture,type ShotExecutionCapture} from "./shot-execution-capture";
import {editValidationKey} from "./edit-validation-key";

interface SlotIdentity {ordinal:number;logicalShotId:string;renderId:string;inputRevision:string}
export type CurrentFilmMixedCheckpointRow=SlotIdentity&(
  {kind:"generated";record:ShotRenderRecord;capture:ShotExecutionCapture}
  |{kind:"reused";adoption:CurrentFilmAdoption}
);
export interface CurrentFilmMixedCheckpoint {
  schema:"hv-current-film-checkpoint/3";projectId:string;jobId:string;jobPlanRevision:string;
  materializationRevision:string;rows:CurrentFilmMixedCheckpointRow[];revision:string;
}
/** An explicit validation context, not an admitted Job. Runtime activation still
 * requires held source/rights/media checks and the version-three worker. */
export type CurrentFilmMixedCheckpointContext=Pick<Job,"id"|"projectId"|"startedAt"|"routeDecisions"|"checkpointShots"|"checkpointFrame">&{
  currentFilm:CurrentFilmJobV3;currentFilmCheckpoint?:CurrentFilmMixedCheckpoint;
};
const same=(a:unknown,b:unknown)=>hash(a)===hash(b);
function fail(message:string):never {throw new Error(message);}
function portable<T>(value:T):T {
  if(!editValidationKey(value,256*1024**2))fail("Retain bounded portable mixed current-film checkpoint evidence.");
  return structuredClone(value);
}
function exact(value:unknown,keys:string[]):void {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))fail("Retain exact mixed current-film checkpoint fields.");
}
function time(value:unknown):number {
  if(typeof value!=="string"||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)fail("Retain canonical mixed current-film execution time.");return Date.parse(value);
}
export function currentFilmMixedRowFrames(row:CurrentFilmMixedCheckpointRow):number {
  const frames=row.kind==="reused"?row.adoption.frames:row.record.clip.durationSec*30,rounded=Math.round(frames);
  if(!Number.isSafeInteger(rounded)||rounded<1||Math.abs(frames-rounded)>1e-7)fail("Retain exact positive 30 fps mixed current-film durations.");
  return rounded;
}

function checkedRows(context:CurrentFilmMixedCheckpointContext,plan:CurrentFilmJobV3,rows:CurrentFilmMixedCheckpointRow[]):void {
  if(!Array.isArray(rows)||rows.length>plan.selection.length)fail("Retain the complete ordered mixed current-film prefix.");
  if(rows.length&&time(context.startedAt)<time(plan.createdAt))fail("Mixed current-film execution cannot precede its admitted target.");
  const paths=new Set<string>();
  for(const [index,row] of rows.entries()){
    const slot=plan.materialization.slots[index]!,selection=plan.selection[index]!;
    if(row.ordinal!==index||row.logicalShotId!==slot.logicalShotId||row.renderId!==slot.renderId||row.inputRevision!==slot.inputRevision)fail("The mixed current-film prefix changed its slot order or inputs.");
    let files:{path:string}[];
    if(row.kind==="generated"){
      exact(row,["kind","ordinal","logicalShotId","renderId","inputRevision","record","capture"]);
      if(selection.kind!=="generate")fail("A selected retained take cannot silently become fresh generation.");
      validateRenderRecord(row.record,context);
      if(row.record.shotId!==slot.renderId||row.record.inputHash!==slot.inputRevision||row.record.reusedFrom)fail("Retain the actual fresh record under its target owner and input.");
      assertSpeechInput(row.record,slot.shot);validateShotExecutionCapture(row.capture,row.record);
      if(!same(row.capture.observation.recipe,slot.recipe))fail("The fresh mixed current-film capture differs from its admitted recipe.");
      files=Object.values(row.record.files);
    }else if(row.kind==="reused"){
      exact(row,["kind","ordinal","logicalShotId","renderId","inputRevision","adoption"]);
      if(selection.kind!=="reuse")fail("A fresh slot cannot silently become a retained take.");
      const adoption=validateCurrentFilmAdoption(row.adoption,plan,context.id);
      if(adoption.target.ordinal!==index)fail("The adoption belongs to a different target slot.");
      files=adoption.copies.map(copy=>copy.owned);
    }else fail("Retain an explicit generated or reused checkpoint row.");
    for(const file of files){if(paths.has(file.path))fail("Mixed current-film slots require distinct owned media paths.");paths.add(file.path);}
    currentFilmMixedRowFrames(row);
  }
}

/** Derive immutable progress metadata. This function does not verify copied
 * bytes or turn historical source routes into new provider calls. */
export function createCurrentFilmMixedCheckpoint(context:CurrentFilmMixedCheckpointContext,rows:CurrentFilmMixedCheckpointRow[]):CurrentFilmMixedCheckpoint {
  const input=portable({context,rows}),owner=input.context,plan=validateCurrentFilmMixedJobPlan(owner.currentFilm);
  if(![owner.id,owner.projectId].every(value=>typeof value==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(value))||owner.projectId!==plan.projectId
    ||plan.library.origin?.request.source.job.id===owner.id
    ||plan.origins.some(origin=>origin.binding.source.job.id===owner.id||origin.binding.owner.jobId===owner.id))fail("Retain an independent mixed current-film target owner.");
  checkedRows(owner,plan,input.rows);
  const body={schema:"hv-current-film-checkpoint/3" as const,projectId:owner.projectId,jobId:owner.id,jobPlanRevision:plan.revision,materializationRevision:plan.materialization.revision,rows:input.rows};
  return {...body,revision:hash(body)};
}
export function validateCurrentFilmMixedCheckpoint(context:CurrentFilmMixedCheckpointContext,value:CurrentFilmMixedCheckpoint):CurrentFilmMixedCheckpoint {
  const input=portable({context,value});exact(input.value,["schema","projectId","jobId","jobPlanRevision","materializationRevision","rows","revision"]);
  const expected=createCurrentFilmMixedCheckpoint(input.context,input.value.rows);
  if(!same(input.value,expected))fail("The mixed current-film checkpoint lost its exact context or seal.");return expected;
}

/** The caller must supply the held durable context. Generated captures require
 * its journal; original captures remain exclusively in the retained catalog. */
export function advanceCurrentFilmMixedCheckpoint(context:CurrentFilmMixedCheckpointContext,value:CurrentFilmMixedCheckpoint,shots:number,frames:number):CurrentFilmMixedCheckpoint {
  const input=portable({context,value,shots,frames}),held=input.context,next=validateCurrentFilmMixedCheckpoint(held,input.value),previous=held.currentFilmCheckpoint;
  if(next.rows.length!==input.shots||next.rows.reduce((sum,row)=>sum+currentFilmMixedRowFrames(row),0)!==input.frames)fail("Mixed current-film progress differs from its measured prefix.");
  if(!Number.isSafeInteger(held.checkpointShots)||held.checkpointShots<0||held.checkpointShots>input.shots)fail("A mixed current-film checkpoint cannot truncate its durable prefix.");
  if(previous){
    validateCurrentFilmMixedCheckpoint(held,previous);
    if(previous.rows.length!==held.checkpointShots||previous.rows.reduce((sum,row)=>sum+currentFilmMixedRowFrames(row),0)!==held.checkpointFrame
      ||!same(previous.rows,next.rows.slice(0,held.checkpointShots)))fail("The durable mixed current-film prefix is immutable.");
  }else if(held.checkpointShots!==0||held.checkpointFrame!==0)fail("A mixed current-film checkpoint cannot invent missing historical custody.");
  const journal=held.routeDecisions??[];
  if(new Set(journal.map(route=>route.id)).size!==journal.length)fail("The mixed current-film durable journal contains duplicate decisions.");
  const originalRoutes=new Set(held.currentFilm.origins.flatMap(origin=>origin.binding.source.job.routeDecisions?.map(route=>route.id)??[]));
  if(journal.some(route=>originalRoutes.has(route.id)))fail("Original source routes cannot establish new mixed current-film journal custody.");
  for(const row of next.rows)if(row.kind==="generated")for(const route of row.capture.routes){
    const saved=journal.find(value=>value.id===route.id);
    if(!saved||!same(saved,route))fail("The fresh mixed current-film capture is absent from its held durable journal.");
  }
  return next;
}
