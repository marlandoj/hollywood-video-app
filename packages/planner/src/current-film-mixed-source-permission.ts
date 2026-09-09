import type {Job} from "../../queue/src/index";
import type {Project,PersistedProject} from "../../api/src/index";
import {contentHash as hash} from "../../generator/src/capabilities";
import {currentFilmV3Job} from "./current-film-runtime-context";
import {validateCurrentFilmMixedOutput,type CurrentFilmMixedJob} from "./current-film-mixed-job-context";
import {validateCompletedCurrentFilmSource} from "./current-film-job-context";
import type {CurrentFilmJobV2} from "./current-film-jobs";
import {snapshotCurrentFilmVersions} from "./current-film-authority";
import {resolveProjectCurrentScreenplay} from "./current-screenplay-library";
import {currentCasting,assertCharacterPermission,type CastingSnapshot} from "./casting";
import {assertFrameAnchorCatalog} from "./frame-anchors";
import {validateReference} from "./references";
import {editValidationKey} from "./edit-validation-key";
import {editFail} from "./edit-timeline";

const sourceBytes=256*1024**2,authorityBytes=128*1024**2;
function time(value:unknown):number {
  if(typeof value!=="string"||!Number.isSafeInteger(Date.parse(value))||Date.parse(value)<0||new Date(value).toISOString()!==value)
    editFail("Retain canonical completed mixed-film source times.");
  return Date.parse(value);
}

/** Historical metadata only. Current grants, carrier/index custody and actual
 * media verification remain separate. The returned complete job is detached. */
// Cache identity assumes the application's trusted serialization intrinsics.
// Altered hooks keep the original descriptor/hash/clone/validation path. Use
// captured descriptor functions here so a hook is inspected without invoking it.
const cacheDescriptor=Object.getOwnPropertyDescriptor,cachePrototype=Object.getPrototypeOf,cacheHasOwn=Object.hasOwn;
const cacheObjectPrototype=Object.prototype,cacheArrayPrototype=Array.prototype;
const cacheArrayIteratorPrototype=cachePrototype([][Symbol.iterator]());
const cacheIntrinsics:readonly (readonly [object,PropertyKey,unknown])[]=[
  [globalThis,"Object",Object],[globalThis,"Array",Array],[globalThis,"JSON",JSON],
  [globalThis,"Reflect",Reflect],[globalThis,"structuredClone",structuredClone],
  [globalThis,"Number",Number],[globalThis,"Buffer",Buffer],
  [Object,"getOwnPropertyDescriptor",Object.getOwnPropertyDescriptor],[Object,"getPrototypeOf",Object.getPrototypeOf],
  [Object,"keys",Object.keys],[Object,"hasOwn",Object.hasOwn],[Reflect,"ownKeys",Reflect.ownKeys],
  [Object,"is",Object.is],[Number,"isFinite",Number.isFinite],[Buffer,"byteLength",Buffer.byteLength],
  [Array,"isArray",Array.isArray],[JSON,"stringify",JSON.stringify],
  [cacheArrayPrototype,"map",Array.prototype.map],[cacheArrayPrototype,"sort",Array.prototype.sort],
  [cacheArrayPrototype,"join",Array.prototype.join],
  [cacheArrayPrototype,Symbol.iterator,Array.prototype[Symbol.iterator]],
  [cacheArrayIteratorPrototype,"next",cacheDescriptor(cacheArrayIteratorPrototype,"next")!.value],
];
function sourceCacheIntrinsicsEligible():boolean {
  for(let index=0;index<cacheIntrinsics.length;index++){
    const entry=cacheIntrinsics[index]!,field=cacheDescriptor(entry[0],entry[1]);
    if(!field||!cacheHasOwn(field,"value")||field.value!==entry[2])return false;
  }
  return cachePrototype(cacheObjectPrototype)===null&&cachePrototype(cacheArrayPrototype)===cacheObjectPrototype
    &&!cacheDescriptor(cacheObjectPrototype,"toJSON")&&!cacheDescriptor(cacheArrayPrototype,"toJSON");
}
const validatedCompletedMixedSources=new Set<string>();
export function validateCompletedCurrentFilmMixedSource(input:Job):CurrentFilmMixedJob {
  const cacheable=sourceCacheIntrinsicsEligible();
  const key=editValidationKey(input,sourceBytes);
  if(!key)editFail("Retain bounded portable completed mixed-film source evidence.");
  // Preserve the original clone fence even on a hit: a Proxy must not become
  // accepted merely because it can impersonate an already validated body.
  const detached=structuredClone(input);
  if(cacheable&&sourceCacheIntrinsicsEligible()&&validatedCompletedMixedSources.has(key)){
    validatedCompletedMixedSources.delete(key);validatedCompletedMixedSources.add(key);
    return detached as CurrentFilmMixedJob;
  }
  const job=currentFilmV3Job(detached);
  if(job.status!=="done"||!job.currentFilmProof||!job.currentFilmOrigins||!job.currentFilmCheckpoint||!job.output
    ||time(job.completedAt)<time(job.startedAt)||time(job.completedAt)<time(job.currentFilmProof.preparedAt)
    ||time(job.linkExpiresAt)<=time(job.completedAt))editFail("Choose a completed V3 source with its exact prepared proof, complete output and historical lifetime.");
  // Full output replay checks every generated capture/journal, adopted row,
  // complete checkpoint, measured clock, original inventory and proof binding.
  validateCurrentFilmMixedOutput(job,job.output);
  if(job.output.currentFilm.proofRevision!==job.currentFilmProof.revision)
    editFail("The completed mixed source lost its exact prepared-proof output binding.");
  if(cacheable&&sourceCacheIntrinsicsEligible()){
    validatedCompletedMixedSources.add(key);
    if(validatedCompletedMixedSources.size>64)validatedCompletedMixedSources.delete(validatedCompletedMixedSources.values().next().value!);
  }
  return job;
}

function field<T>(value:object,key:string):T|undefined {
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(descriptor&&(!descriptor.enumerable||!Object.hasOwn(descriptor,"value")))
    editFail("Retain current mixed-source authority without accessors or hidden values.");
  return descriptor?.value as T|undefined;
}
function freshAuthority(project:Project|PersistedProject|null|undefined,projectId:string,now:number){
  if(!project||typeof project!=="object"||Array.isArray(project)||field<string>(project,"id")!==projectId
    ||!Number.isSafeInteger(now)||now<0||now>8640000000000000)editFail("The current mixed-source project is unavailable.");
  const projection={id:projectId,
    currentScreenplay:field<PersistedProject["currentScreenplay"]>(project,"currentScreenplay"),
    versions:snapshotCurrentFilmVersions(field(project,"versions")),
    rightsAttestedAt:field<string|null>(project,"rightsAttestedAt")??null,deleteAfter:field<string>(project,"deleteAfter")??null,
    castingHistory:field<PersistedProject["castingHistory"]>(project,"castingHistory")??[],
    referenceAssets:field<PersistedProject["referenceAssets"]>(project,"referenceAssets")??[]};
  if(!editValidationKey(projection,authorityBytes))editFail("Retain bounded portable current mixed-source authority.");
  const current=structuredClone(projection);
  if(!current.rightsAttestedAt||!Number.isFinite(Date.parse(current.rightsAttestedAt))||Date.parse(current.rightsAttestedAt)>now
    ||!current.deleteAfter||!Number.isFinite(Date.parse(current.deleteAfter))||Date.parse(current.deleteAfter)<=now)
    editFail("Current project rights or retention are unavailable for this mixed film.");
  const {library,head}=resolveProjectCurrentScreenplay(current.currentScreenplay,{projectId,versions:current.versions});
  if(!head||hash(current.versions.at(-1)??null)!==hash(head.script))
    editFail("Review the current screenplay ancestry before using this retained mixed film.");
  const casting=currentCasting(projectId,current.castingHistory),document=head.state.context.plan.document,
    catalog=new Set(current.referenceAssets.map(asset=>hash(validateReference(asset,projectId))));
  return {current,library,casting,document,catalog};
}
type HistoricalPlan=Pick<CurrentFilmJobV2,"library"|"materialization">;
function historicalPermission(plan:HistoricalPlan,savedCasting:CastingSnapshot|undefined,authority:ReturnType<typeof freshAuthority>,now:number):void {
  const {current,library,casting,document,catalog}=authority;
  if(hash(library.origin)!==hash(plan.library.origin)||library.version<plan.library.version
    ||hash(library.proposals.slice(0,plan.library.proposals.length))!==hash(plan.library.proposals)
    ||hash(library.acceptances.slice(0,plan.library.acceptances.length))!==hash(plan.library.acceptances))
    editFail("The retained mixed film or original execution lost its saved canonical ancestry.");
  for(const slot of plan.materialization.slots){
    const scene=document.scenes.find(value=>value.headingLineId===slot.physical.headingLineId);
    for(const id of slot.shot.characterIds??[]){
      const saved=savedCasting?.characters.find(value=>value.id===id),character=casting.characters.find(value=>value.id===id);
      if(!saved||!character)editFail("A retained target or original execution character is no longer in this project's cast.");
      assertCharacterPermission(saved,slot.sceneIndex+1,now);
      if(character.permission.scope==="scenes"&&!scene)editFail("The retained physical scene no longer has a current scene-scoped character grant.");
      const number=scene?scene.sceneIndex+1:slot.sceneIndex+1;assertCharacterPermission(character,number,now);
      if(character.permission.scope==="scenes"&&character.sceneBindings.find(binding=>binding.sceneNumber===number)?.heading!==scene!.heading)
        editFail("The current character grant belongs to a different physical scene.");
      for(const asset of saved.references??[])if(!catalog.has(hash(validateReference(asset,current.id))))
        editFail("A retained target or original execution reference is no longer available in this project's catalog.");
    }
    assertFrameAnchorCatalog(slot.shot.direction?.frameAnchors,current.id,current.referenceAssets);
  }
}

/** The caller supplies its freshly authorized project. Historical preview approval
 * cannot replace current target grants or the original executions' distinct grants.
 * Carrier expiration, artifact custody and media bytes are checked by the caller. */
export function assertCurrentFilmMixedSourcePermission(input:Job,project:Project|PersistedProject|null|undefined,now=Date.now()):void {
  const job=validateCompletedCurrentFilmMixedSource(input),authority=freshAuthority(project,job.projectId,now);
  historicalPermission(job.currentFilm,job.casting,authority,now);
  for(const origin of job.currentFilm.origins){
    const source=origin.binding.source.job,plan=validateCompletedCurrentFilmSource(source);
    historicalPermission(plan,source.casting,authority,now);
  }
}
