import {contentHash as hash} from "../../generator/src/capabilities";
import type {Project,PersistedProject} from "../../api/src/index";
import {VersionStore,type ScriptVersion} from "../../parser/src/index";
import {currentCasting,type CastingSnapshot} from "./casting";
import {currentDirection,type DirectionSnapshot} from "./direction";
import type {ReferenceAsset} from "./references";
import {CURRENT_FILM_JOB_LIMITS,validateCurrentFilmJobPlan,type CurrentFilmJobV2} from "./current-film-jobs";
import {validateCurrentFilmMixedJobPlan,type CurrentFilmJobV3} from "./current-film-mixed-jobs";
import {resolveCurrentScreenplayTarget,type CurrentScreenplayLibrary} from "./current-screenplay-library";
import {assertCurrentScreenplaySettings} from "./current-screenplay-authority";

function fail(message:string):never {throw new Error(message);}
function field<T>(value:object,key:string):T|undefined {
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(descriptor&&(!descriptor.enumerable||!Object.hasOwn(descriptor,"value")))fail("Retain current-film authority fields without accessors or hidden values.");
  return descriptor?.value as T|undefined;
}
/** Bound only the authority projection, never clone unrelated project data or cache permissions. */
function portable<T>(input:T):T {
  let nodes=0,bytes=0;const active=new Set<object>();
  const visit=(value:unknown,depth:number):void=>{
    if(++nodes>CURRENT_FILM_JOB_LIMITS.nodes||depth>180)fail("Current-film authority exceeds its metadata capacity.");
    if(typeof value==="string"){bytes+=Buffer.byteLength(value,"utf8");if(bytes>CURRENT_FILM_JOB_LIMITS.bytes)fail("Current-film authority exceeds its metadata capacity.");return;}
    if(value===null||typeof value==="boolean"||typeof value==="number"&&Number.isFinite(value)&&!Object.is(value,-0))return;
    if(typeof value!=="object"||active.has(value))fail("Retain portable current-film authority.");
    const array=Array.isArray(value),keys=Reflect.ownKeys(value),prototype=Object.getPrototypeOf(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)fail("Retain plain current-film authority records.");
    if(array&&keys.length!==value.length+1)fail("Retain dense current-film authority arrays.");active.add(value);
    for(const key of keys){if(array&&key==="length")continue;const entry=Object.getOwnPropertyDescriptor(value,key)!;
      if(typeof key!=="string"||!entry.enumerable||!Object.hasOwn(entry,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))fail("Retain current-film authority without accessors or hidden values.");
      bytes+=Buffer.byteLength(key,"utf8");if(bytes>CURRENT_FILM_JOB_LIMITS.bytes)fail("Current-film authority exceeds its metadata capacity.");visit(entry.value,depth+1);
    }active.delete(value);
  };visit(input,0);if(Buffer.byteLength(JSON.stringify(input),"utf8")>CURRENT_FILM_JOB_LIMITS.bytes)fail("Current-film authority exceeds its metadata capacity.");return structuredClone(input);
}
export function snapshotCurrentFilmVersions(value:unknown):ScriptVersion[] {
  if(Array.isArray(value))return value;
  if(!(value instanceof VersionStore)||Object.getPrototypeOf(value)!==VersionStore.prototype)fail("Retain the current durable screenplay history.");
  // Check the trusted store's data before invoking its actual prototype method. An overridden
  // history method or getter from a caller cannot supply a different authority snapshot.
  const data:Record<string,unknown>={};for(const key of Reflect.ownKeys(value)){
    if(typeof key!=="string")fail("Retain portable screenplay history.");data[key]=field(value,key);
  }portable(data);return VersionStore.prototype.history.call(value);
}
/** The caller supplies a freshly authorized project under its admission/dispatch/publication
 * fence. Embedded historical evidence is not authority. Target generation permission
 * never substitutes for separate current source/carrier checks on a mixed plan. */
export function assertCurrentFilmGenerationCurrent(plan:CurrentFilmJobV2|CurrentFilmJobV3,project:Project|PersistedProject|null|undefined,now=Date.now()):void {
  const checked=plan&&field<string>(plan,"schema")==="hv-current-film-job/3"?validateCurrentFilmMixedJobPlan(plan as CurrentFilmJobV3):validateCurrentFilmJobPlan(plan as CurrentFilmJobV2);
  if(!Number.isSafeInteger(now)||now<0||now>8640000000000000||now<Date.parse(checked.createdAt))fail("Use a current generation time at or after the saved film plan.");
  if(!project||field<string>(project,"id")!==checked.projectId)fail("The current-film project is unavailable.");
  const library=field<CurrentScreenplayLibrary>(project,"currentScreenplay");if(!library)fail("Save the current screenplay target before generation.");
  const current=portable({id:checked.projectId,library,versions:snapshotCurrentFilmVersions(field(project,"versions")),
    deleteAfter:field<string>(project,"deleteAfter")??null,rightsAttestedAt:field<string|null>(project,"rightsAttestedAt")??null,
    castingHistory:field<CastingSnapshot[]>(project,"castingHistory")??[],directionHistory:field<DirectionSnapshot[]>(project,"directionHistory")??[],referenceAssets:field<ReferenceAsset[]>(project,"referenceAssets")??[]});
  if(!current.deleteAfter||!Number.isFinite(Date.parse(current.deleteAfter))||Date.parse(current.deleteAfter)<=now
    ||!current.rightsAttestedAt||!Number.isFinite(Date.parse(current.rightsAttestedAt))||Date.parse(current.rightsAttestedAt)>now)fail("The current-film project rights or retention are unavailable.");
  const resolved=resolveCurrentScreenplayTarget(current.library,checked.selector),saved=resolved.library,head=resolved.head;
  if(saved.projectId!==checked.projectId||saved.version<checked.library.version||hash(saved.origin)!==hash(checked.library.origin)
    ||hash(saved.proposals.slice(0,checked.library.proposals.length))!==hash(checked.library.proposals)
    ||hash(saved.acceptances.slice(0,checked.library.acceptances.length))!==hash(checked.library.acceptances)
    ||head.revision!==checked.baseline.headRevision||hash(resolved.target)!==hash(checked.target))fail("The saved current-film head, target or exact proposal history changed.");
  if(current.versions.length>100000)fail("Retain bounded durable screenplay versions.");
  const retained=new Map<number,ScriptVersion>();let previous=0;
  for(const version of current.versions){if(!Number.isSafeInteger(version.version)||version.version<=previous)fail("Retain ordered unique durable screenplay versions.");retained.set(version.version,version);previous=version.version;}
  for(const required of [saved.origin!.request.script,...saved.acceptances.flatMap(row=>row.versions)])
    if(hash(retained.get(required.version)??null)!==hash(required))fail("The current film lost an exact durable accepted screenplay version.");
  if(hash(current.versions.at(-1)??null)!==hash(head.script))fail("The current screenplay changed outside the saved film ancestry.");
  const casting=currentCasting(current.id,current.castingHistory),direction=currentDirection(current.id,current.directionHistory);
  if(hash(casting)!==hash(head.state.casting.candidate)||casting.revision!==checked.baseline.castingRevision
    ||head.state.direction.revision!==checked.baseline.directionRevision||head.state.context.plan.document.revision!==checked.baseline.documentRevision
    ||head.script.version!==checked.baseline.scriptVersion||head.state.context.plan.document.scriptRevision!==checked.baseline.scriptRevision
    ||hash(direction)!==hash(saved.origin!.request.baseline.direction))fail("The current film's cast, direction or screenplay baseline changed. Review the latest settings.");
  const actual=assertCurrentScreenplaySettings(resolved.target.state,{projectId:current.id,documentRevision:head.state.context.plan.document.revision,casting,
    rightsAttestedAt:current.rightsAttestedAt,deleteAfter:current.deleteAfter,referenceAssets:current.referenceAssets},now);
  if(hash(actual)!==hash(checked.materialization.slots.map(slot=>slot.shot)))fail("Current permissions or settings no longer reproduce the complete admitted film.");
}
