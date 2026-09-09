import {contentHash as hash} from "../../generator/src/capabilities";
import {CURRENT_FILM_JOB_LIMITS,validateCurrentFilmJobPlan,type CurrentFilmJobV2} from "./current-film-jobs";
import {validateEditBinding,type EditSourceBinding} from "./edit-jobs";
import {editValidationKey} from "./edit-validation-key";
import {compileCurrentFilmRetainedExecution,reviewCurrentFilmReuse} from "./current-film-reuse";

import {CURRENT_FILM_ORIGIN_LIMIT} from "./current-film-proof-limits";
export {CURRENT_FILM_ORIGIN_LIMIT} from "./current-film-proof-limits";
export type CurrentFilmSourceSelector=Parameters<typeof compileCurrentFilmRetainedExecution>[1];
export interface CurrentFilmOrigin {id:string;binding:EditSourceBinding}
export interface CurrentFilmReuseChoice {
  ordinal:number;inputRevision:string;originId:string;source:CurrentFilmSourceSelector;
}
type TargetSlot=CurrentFilmJobV2["selection"][number];
export type CurrentFilmMixedSelection=TargetSlot|Omit<TargetSlot,"kind">&{
  kind:"reuse";originId:string;source:CurrentFilmSourceSelector;reviewRevision:string;policy:"retain-selected-successful-take/1";
};
/** V3 changes selection/custody, not the V2 generation recipe or physical inputs.
 * The deduplicated source catalog is private historical evidence, never authority. */
export interface CurrentFilmJobV3 extends Omit<CurrentFilmJobV2,"schema"|"origins"|"selection"|"revision"> {
  schema:"hv-current-film-job/3";origins:CurrentFilmOrigin[];selection:CurrentFilmMixedSelection[];revision:string;
}
export interface CurrentFilmMixedRequest {origins:EditSourceBinding[];choices:CurrentFilmReuseChoice[]}
const seal=<T extends object>(value:T):T&{revision:string}=>({...value,revision:hash(value)});
function fail(message:string):never {throw new Error(message);}
function portable<T>(value:T):T {
  if(!editValidationKey(value,CURRENT_FILM_JOB_LIMITS.bytes))fail("Retain bounded portable current-film selection evidence without accessors or hidden values.");
  return structuredClone(value);
}
function exact(value:unknown,keys:string[]):void {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))fail("Retain exact current-film selection fields.");
}
function sourceId(value:unknown):asserts value is string {if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))fail("Retain an exact source receipt revision.");}

/** Pure planning only. Held admission must separately resolve every original or
 * retained carrier, live grants and actual bytes; no missing reuse becomes inference. */
export function compileCurrentFilmMixedJob(target:CurrentFilmJobV2,request:CurrentFilmMixedRequest):CurrentFilmJobV3 {
  const input=portable({target,request});exact(input.request,["origins","choices"]);
  const base=validateCurrentFilmJobPlan(input.target),slots=base.materialization.slots;
  if(!Array.isArray(input.request.origins)||input.request.origins.length>CURRENT_FILM_ORIGIN_LIMIT
    ||!Array.isArray(input.request.choices)||input.request.choices.length>slots.length)fail("Retain the complete bounded current-film source selection.");
  const origins=input.request.origins.map(binding=>{
    const checked=validateEditBinding(binding),id=checked.source.revision;sourceId(id);
    if(checked.source.schema!=="hv-edit-source/3"||!checked.source.job.currentFilm||checked.source.job.projectId!==base.projectId)fail("Choose a retained canonical film from the target project.");
    return {id,binding:checked};
  }).sort((a,b)=>a.id.localeCompare(b.id));
  if(new Set(origins.map(origin=>origin.id)).size!==origins.length)fail("Choose one carrier for each original source; never duplicate its full evidence per slot.");
  const choices=new Map<number,CurrentFilmReuseChoice>(),used=new Set<string>();
  for(const choice of input.request.choices){
    exact(choice,["ordinal","inputRevision","originId","source"]);sourceId(choice.originId);
    if(!Number.isSafeInteger(choice.ordinal)||choice.ordinal<0||choice.ordinal>=slots.length||choices.has(choice.ordinal))fail("Select each current-film target ordinal at most once.");
    const slot=slots[choice.ordinal]!;
    if(choice.inputRevision!==slot.inputRevision||!origins.some(origin=>origin.id===choice.originId))fail("The selected target input or retained origin changed.");
    choices.set(choice.ordinal,choice);used.add(choice.originId);
  }
  if(origins.some(origin=>!used.has(origin.id)))fail("A current-film plan cannot retain an unused source catalog entry.");
  const selection:CurrentFilmMixedSelection[]=base.selection.map(targetSlot=>{
    const choice=choices.get(targetSlot.ordinal);if(!choice)return targetSlot;
    const origin=origins.find(value=>value.id===choice.originId)!;
    const retained=compileCurrentFilmRetainedExecution(origin.binding,choice.source),review=reviewCurrentFilmReuse(base,targetSlot.ordinal,retained);
    if(review.status!=="consistent")fail("This selected source cannot be adopted with the target's exact execution and physical bindings.");
    return {...targetSlot,kind:"reuse",originId:origin.id,source:choice.source,reviewRevision:review.revision,policy:"retain-selected-successful-take/1"};
  });
  const {revision:_revision,...body}=base;
  return portable(seal({...body,schema:"hv-current-film-job/3" as const,origins,selection}));
}

function generationBase(value:CurrentFilmJobV3):CurrentFilmJobV2 {
  const {revision:_revision,...body}=value;
  return seal({...body,schema:"hv-current-film-job/2" as const,origins:[] as [],selection:value.materialization.slots.map(slot=>({
    ordinal:slot.ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,kind:"generate" as const,
  }))});
}

/** Recompute both original execution comparison and full target materialization.
 * A changed source, carrier, target, review or ordering cannot retain a sealed plan. */
const validatedMixedPlans=new Set<string>();
export function validateCurrentFilmMixedJobPlan(raw:CurrentFilmJobV3):CurrentFilmJobV3 {
  const key=editValidationKey(raw,CURRENT_FILM_JOB_LIMITS.bytes);
  if(!key)fail("Retain bounded portable current-film selection evidence without accessors or hidden values.");
  // The fresh descriptor/size check already hashes the complete portable body.
  // Cloning preserves that digest, including explicit optional undefined fields.
  const value=structuredClone(raw);
  // Only successful immutable replay is cached. Full descriptors, capacity and
  // content are checked on every call; live rights, custody and media are separate.
  if(validatedMixedPlans.has(key)){validatedMixedPlans.delete(key);validatedMixedPlans.add(key);return value;}
  exact(value,["schema","projectId","createdAt","library","selector","target","request","baseline","render","materialization","origins","selection","authority","revision"]);
  if(value.schema!=="hv-current-film-job/3"||!Array.isArray(value.origins)||value.origins.length>CURRENT_FILM_ORIGIN_LIMIT
    ||!Array.isArray(value.selection)||value.selection.length!==value.materialization.slots.length)fail("Use the explicit complete version-three current-film selection.");
  for(const origin of value.origins){exact(origin,["id","binding"]);if(origin.id!==origin.binding.source.revision)fail("The current-film source catalog identity changed.");}
  const choices:CurrentFilmReuseChoice[]=[];
  for(const selection of value.selection){
    if(selection.kind==="generate")exact(selection,["ordinal","logicalShotId","renderId","inputRevision","kind"]);
    else if(selection.kind==="reuse"){
      exact(selection,["ordinal","logicalShotId","renderId","inputRevision","kind","originId","source","reviewRevision","policy"]);
      if(selection.policy!=="retain-selected-successful-take/1")fail("Choose the explicit retained-successful-take policy.");
      choices.push({ordinal:selection.ordinal,inputRevision:selection.inputRevision,originId:selection.originId,source:selection.source});
    }else fail("Every current-film slot needs an explicit fresh or retained selection.");
  }
  const expected=compileCurrentFilmMixedJob(generationBase(value),{origins:value.origins.map(origin=>origin.binding),choices});
  if(hash(expected)!==key)fail("The current-film selection differs from its exact original, target or reviewed execution.");
  validatedMixedPlans.add(key);if(validatedMixedPlans.size>64)validatedMixedPlans.delete(validatedMixedPlans.values().next().value!);
  return expected;
}

/** Resolve a selected take without exposing a fresh-only plan that could discard
 * the admitted selection. Returned evidence is transient and still historical-only. */
export function resolveCurrentFilmMixedReuse(raw:CurrentFilmJobV3,ordinal:number){
  const plan=validateCurrentFilmMixedJobPlan(raw);
  if(!Number.isSafeInteger(ordinal)||ordinal<0||ordinal>=plan.selection.length)fail("Choose an exact selected current-film ordinal.");
  const selection=plan.selection[ordinal]!;
  if(selection.kind!=="reuse")fail("The target slot requires fresh generation, not a retained take.");
  const origin=plan.origins.find(value=>value.id===selection.originId)!;
  const retained=compileCurrentFilmRetainedExecution(origin.binding,selection.source),review=reviewCurrentFilmReuse(generationBase(plan),ordinal,retained);
  if(review.status!=="consistent"||review.revision!==selection.reviewRevision)fail("The selected current-film reuse review changed.");
  return {projectId:plan.projectId,jobPlanRevision:plan.revision,selection,retained,review};
}
