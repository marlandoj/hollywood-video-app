import {contentHash as hash} from "../../generator/src/capabilities";
import {validateCurrentFilmMixedJobPlan,type CurrentFilmJobV3} from "./current-film-mixed-jobs";
import {CURRENT_FILM_ORIGIN_LIMIT} from "./current-film-proof-limits";
import {EDIT_STORAGE_LIMITS} from "./edit-resources";
import {editValidationKey} from "./edit-validation-key";
import type {RenderFile} from "./shot-reuse";

export const CURRENT_FILM_ORIGINS_LIMITS={
  metadataBytes:64*1024**2,origins:CURRENT_FILM_ORIGIN_LIMIT,files:EDIT_STORAGE_LIMITS.files,
  ownedBytes:EDIT_STORAGE_LIMITS.outputBytes,path:1024,fileBytes:8*1024**3,
} as const;
export interface CurrentFilmOrigins {
  schema:"hv-current-film-origins/1";projectId:string;jobId:string;jobPlanRevision:string;
  origins:{originId:string;bindingRevision:string;receiptRevision:string;
    copies:{original:RenderFile;carrier:RenderFile;owned:RenderFile}[]}[];
  revision:string;
}
function fail(message:string):never {throw new Error(message);}
function ownerId(value:unknown):asserts value is string {
  if(typeof value!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(value))fail("Use a bounded independent current-film originals owner.");
}
function portable<T>(value:T):T {
  if(!editValidationKey(value,CURRENT_FILM_ORIGINS_LIMITS.metadataBytes))fail("Retain bounded portable current-film originals metadata without accessors or hidden values.");
  return structuredClone(value);
}
function exact(value:unknown,keys:string[]):void {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))fail("Retain exact current-film originals fields.");
}
function file(value:RenderFile):void {
  exact(value,["path","sha256","bytes"]);
  if(typeof value.path!=="string"||value.path.length>CURRENT_FILM_ORIGINS_LIMITS.path||!/^[A-Za-z0-9._/-]+$/.test(value.path)
    ||value.path.split("/").some(part=>!part||part==="."||part===".."))fail("Current-film original copy paths must fit the bounded portable namespace.");
  if(typeof value.sha256!=="string"||!/^[a-f0-9]{64}$/.test(value.sha256)||!Number.isSafeInteger(value.bytes)||value.bytes<1||value.bytes>CURRENT_FILM_ORIGINS_LIMITS.fileBytes)fail("Retain exact bounded current-film original file bytes and digests.");
}
function budget(){
  let count=0,bytes=0,metadata=1024;const owned=new Set<string>();
  return (copy:CurrentFilmOrigins["origins"][number]["copies"][number])=>{
    for(const item of [copy.original,copy.carrier,copy.owned])file(item);
    if(++count>CURRENT_FILM_ORIGINS_LIMITS.files||(bytes+=copy.owned.bytes)>CURRENT_FILM_ORIGINS_LIMITS.ownedBytes)fail("The complete current-film originals inventory exceeds its file or byte capacity.");
    if(owned.has(copy.owned.path))fail("Current-film originals require distinct owned copy paths.");owned.add(copy.owned.path);
    // Bound expansion while deriving rows, before a large full manifest is built.
    metadata+=Buffer.byteLength(JSON.stringify(copy))+1;
    if(metadata>CURRENT_FILM_ORIGINS_LIMITS.metadataBytes)fail("The complete current-film originals inventory exceeds its metadata capacity.");
  };
}

/** Derive complete direct-origin copy metadata from the validated admitted plan.
 * Original Jobs/records/captures remain unchanged in that plan's source catalog.
 * This neither reads bytes nor establishes held custody, availability or permission.
 * Bootstrap/proof dependency closure and combined scratch/output capacity remain
 * separate runtime gates; checking its owner here does not copy that dependency. */
export function compileCurrentFilmOrigins(raw:CurrentFilmJobV3,jobId:string):CurrentFilmOrigins {
  ownerId(jobId);const plan=validateCurrentFilmMixedJobPlan(raw),projectId=plan.projectId;ownerId(projectId);
  if(plan.library.origin?.request.source.job.id===jobId
    ||plan.origins.some(origin=>origin.binding.source.job.id===jobId||origin.binding.owner.jobId===jobId))fail("Retain current-film originals under an independent target job.");
  const check=budget(),origins:CurrentFilmOrigins["origins"]=[];
  for(const origin of plan.origins){
    const {binding}=origin,prefix=`${projectId}/${jobId}/originals/${origin.id}/`,copies:CurrentFilmOrigins["origins"][number]["copies"]=[];
    for(const [index,original] of binding.source.files.entries()){
      const carrier=binding.files[index]!,copy={original,carrier,owned:{...original,path:prefix+original.path}};
      check(copy);copies.push(copy);
    }
    origins.push({originId:origin.id,bindingRevision:binding.revision,receiptRevision:binding.source.revision,copies});
  }
  const body={schema:"hv-current-film-origins/1" as const,projectId,jobId,jobPlanRevision:plan.revision,origins};
  return portable({...body,revision:hash(body)});
}

/** Recompile every origin and file, including unselected shots and final source
 * artifacts. Resealing a partial or redirected inventory cannot change the plan. */
export function validateCurrentFilmOrigins(value:CurrentFilmOrigins,plan:CurrentFilmJobV3,jobId:string):CurrentFilmOrigins {
  const input=portable(value);exact(input,["schema","projectId","jobId","jobPlanRevision","origins","revision"]);
  if(!Array.isArray(input.origins)||input.origins.length>CURRENT_FILM_ORIGINS_LIMITS.origins)fail("Retain the complete bounded current-film direct-origin catalog.");
  const check=budget(),ids=new Set<string>();
  for(const origin of input.origins){
    exact(origin,["originId","bindingRevision","receiptRevision","copies"]);
    if(ids.has(origin.originId))fail("Retain each current-film direct origin exactly once.");ids.add(origin.originId);
    if(!Array.isArray(origin.copies)||origin.copies.length===0||origin.copies.length>CURRENT_FILM_ORIGINS_LIMITS.files)fail("Retain the complete bounded current-film original copy list.");
    for(const copy of origin.copies){exact(copy,["original","carrier","owned"]);check(copy);}
  }
  const expected=compileCurrentFilmOrigins(plan,jobId);
  if(hash(input)!==hash(expected))fail("Current-film originals differ from the exact plan, source inventory or carrier mapping.");
  return expected;
}
