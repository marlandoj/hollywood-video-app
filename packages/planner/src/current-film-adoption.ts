import {contentHash as hash} from "../../generator/src/capabilities";
import {resolveCurrentFilmMixedReuse,type CurrentFilmJobV3,type CurrentFilmSourceSelector} from "./current-film-mixed-jobs";
import {editValidationKey} from "./edit-validation-key";
import type {RenderFile,ShotRenderRecord} from "./shot-reuse";

export const CURRENT_FILM_ADOPTION_LIMITS={bytes:64*1024,copies:4} as const;
type Role=keyof ShotRenderRecord["files"];
export interface CurrentFilmAdoption {
  schema:"hv-current-film-adoption/1";projectId:string;jobId:string;jobPlanRevision:string;originId:string;
  sourceSelector:CurrentFilmSourceSelector;
  target:{ordinal:number;logicalShotId:string;renderId:string;inputRevision:string};
  captureRevision:string;reviewRevision:string;frames:number;
  copies:{role:Role;original:RenderFile;carrier:RenderFile;owned:RenderFile}[];
  correspondenceRevision:string;revision:string;
}
const names:Record<Role,string>={video:"video.mp4",audio:"audio.wav",poster:"poster.png",sourcePoster:"source-poster.png"};
function fail(message:string):never {throw new Error(message);}
function ownerId(value:unknown):asserts value is string {
  if(typeof value!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(value))fail("Use a bounded independent current-film adoption owner.");
}
function portable<T>(value:T):T {
  if(!editValidationKey(value,CURRENT_FILM_ADOPTION_LIMITS.bytes))fail("Retain bounded portable current-film adoption metadata without accessors or hidden fields.");
  return structuredClone(value);
}
function exact(value:unknown,keys:string[]):void {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))fail("Retain exact current-film adoption fields.");
}

/** Derive a copy specification from the selected original and reviewed V3 target.
 * This does not read files, establish custody, check current permission, or prove
 * that any copy exists. The original record and capture remain in the catalog. */
export function compileCurrentFilmAdoption(plan:CurrentFilmJobV3,jobId:string,ordinal:number):CurrentFilmAdoption {
  ownerId(jobId);
  const resolved=resolveCurrentFilmMixedReuse(plan,ordinal),{projectId,jobPlanRevision,selection,retained,review}=resolved;
  ownerId(projectId);
  if(jobId===retained.binding.source.job.id||jobId===retained.binding.owner.jobId)fail("Adopt the selected media into an independent target job.");
  const prefix=`${projectId}/${jobId}/reused/slot-${String(selection.ordinal).padStart(4,"0")}/`;
  const copies=retained.files.map(({role,original,carrier})=>({role,original,carrier,owned:{...original,path:prefix+names[role]}}));
  if(!copies.length||copies.length>CURRENT_FILM_ADOPTION_LIMITS.copies||!copies.some(copy=>copy.role==="video")
    ||new Set(copies.map(copy=>copy.role)).size!==copies.length||new Set(copies.map(copy=>copy.owned.path)).size!==copies.length)fail("Retain every distinct original media role in the target adoption.");
  const body={schema:"hv-current-film-adoption/1" as const,projectId,jobId,jobPlanRevision,originId:selection.originId,
    sourceSelector:selection.source,target:{ordinal:selection.ordinal,logicalShotId:selection.logicalShotId,renderId:selection.renderId,inputRevision:selection.inputRevision},
    captureRevision:retained.captureRevision,reviewRevision:review.revision,frames:retained.frames,copies,correspondenceRevision:hash(review.correspondence)};
  return portable({...body,revision:hash(body)});
}

/** Replay metadata derivation against the exact admitted selection. A resealed
 * copy list cannot replace the source, target, measured frames or correspondence. */
export function validateCurrentFilmAdoption(value:CurrentFilmAdoption,plan:CurrentFilmJobV3,jobId:string):CurrentFilmAdoption {
  const input=portable(value);
  exact(input,["schema","projectId","jobId","jobPlanRevision","originId","sourceSelector","target","captureRevision","reviewRevision","frames","copies","correspondenceRevision","revision"]);
  exact(input.target,["ordinal","logicalShotId","renderId","inputRevision"]);
  exact(input.sourceSelector,["receiptRevision","ordinal","logicalShotId","renderId","inputRevision","recordRevision"]);
  if(!Array.isArray(input.copies)||input.copies.length<1||input.copies.length>CURRENT_FILM_ADOPTION_LIMITS.copies)fail("Retain the complete bounded current-film adoption copy list.");
  for(const copy of input.copies){exact(copy,["role","original","carrier","owned"]);for(const file of [copy.original,copy.carrier,copy.owned])exact(file,["path","sha256","bytes"]);}
  const expected=compileCurrentFilmAdoption(plan,jobId,input.target.ordinal);
  if(hash(input)!==hash(expected))fail("The adoption differs from its selected source, target or reviewed media correspondence.");
  return expected;
}
