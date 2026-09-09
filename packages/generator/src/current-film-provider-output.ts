import {randomUUID} from "node:crypto";
import {lstatSync,mkdirSync,realpathSync,type Stats} from "node:fs";
import {basename,dirname,isAbsolute,join,resolve,sep} from "node:path";
import type {CostRecord,VideoClip} from "./index";
import {currentFilmWorkspaceGuard} from "./current-film-workspace";
import {editValidationKey} from "../../planner/src/edit-validation-key";

export interface CurrentFilmProviderOwner {projectId:string;jobId:string}
function fail(message:string):never {throw new Error(message);}
function components(root:string,key:string,create=false):string {
  let path=root;
  for(const part of key.split("/")){
    path=join(path,part);
    if(create)try{mkdirSync(path);}catch(error){if((error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
    const stat=lstatSync(path);
    if(stat.isSymbolicLink()||!stat.isDirectory()||realpathSync(path)!==path)fail("Current-film provider output refuses linked or changed directories.");
  }
  return path;
}
function own(value:object,key:string):unknown {
  const descriptor=Object.getOwnPropertyDescriptor(value,key);
  if(descriptor&&(!("value" in descriptor)||!descriptor.enumerable))fail("Current-film provider output requires plain returned media fields.");
  return descriptor?.value;
}
function returnedCosts(clip:unknown):CostRecord[] {
  if(!clip||typeof clip!=="object"||Array.isArray(clip))return [];
  // Preserve only the provider's actual cost evidence; never invoke a returned
  // accessor while attempting to report an invalid output or create a new cost.
  const data=(key:string)=>{const descriptor=Object.getOwnPropertyDescriptor(clip,key);return descriptor&&"value" in descriptor?descriptor.value:undefined;};
  const cost=data("cost"),sunkCost=data("sunkCost"),sunkCosts=data("sunkCosts");
  if(!editValidationKey({cost,sunkCost,sunkCosts},256*1024))return [];
  return [...(Array.isArray(sunkCosts)?sunkCosts:[]),...(sunkCost?[sunkCost]:[]),...(cost?[cost]:[])] as CostRecord[];
}
function withCosts(error:unknown,costs:CostRecord[]):Error {
  const original=error instanceof Error?error:new Error(String(error));
  if(!costs.length)return original;
  // Abort reasons belong to the caller. The executor later attaches its charged
  // costs to that original reason; mutating it here would duplicate the evidence.
  const failure=new Error(original.message,{cause:error});failure.name=original.name;
  return Object.assign(failure,{sunkCosts:costs});
}
function returnedRoles(clip:unknown,root:string,key:string,target:string,identity:Stats):void {
  if(!clip||typeof clip!=="object"||Array.isArray(clip))fail("Current-film provider output requires an actual returned clip.");
  const directory=components(root,key),current=lstatSync(directory);
  if(current.dev!==identity.dev||current.ino!==identity.ino)fail("The current-film provider invocation directory changed identity.");
  const paths=new Set<string>();
  for(const field of ["path","audioPath","posterPath","sourcePosterPath"]){
    const value=own(clip,field);
    if(value===undefined&&field!=="path")continue;
    if(typeof value!=="string"||value.length>4096||!isAbsolute(value)||value.split(/[\\/]/).some(part=>part==="."||part===".."))fail("Current-film provider roles require exact absolute invocation paths.");
    const path=resolve(value);
    if(dirname(path)!==directory||field==="path"&&path!==target||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/.test(basename(path))||paths.has(path))fail("Current-film provider roles must be distinct files in their exact invocation directory.");
    const stat=lstatSync(path);
    if(stat.isSymbolicLink()||!stat.isFile()||stat.size<1||realpathSync(path)!==path)fail("Current-film provider roles must be nonempty regular unlinked files.");
    paths.add(path);
  }
}

/** Local placement for a checked V3 worker, not admission, byte provenance or
 * current authority. Every actual provider call gets a fresh directory, even
 * fallback calls within the same repair/lease. No output or orphan is removed.
 * The caller retains all live lease, route, budget and completed-media checks. */
export async function withCurrentFilmProviderOutput<T extends VideoClip>(
  artifactRoot:string,input:CurrentFilmProviderOwner,fileName:string,
  dispatch:(path:string)=>Promise<T>,signal?:AbortSignal,
):Promise<T> {
  signal?.throwIfAborted();
  if(!editValidationKey({input,fileName},4096))fail("Use bounded portable current-film provider ownership.");
  const {input:owner,fileName:name}=structuredClone({input,fileName});
  if(Object.keys(owner).sort().join(",")!=="jobId,projectId"||![owner.projectId,owner.jobId].every(id=>typeof id==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(id))
    ||typeof name!=="string"||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,195}\.mp4$/.test(name)||typeof dispatch!=="function")fail("Use an exact current-film provider owner and safe MP4 basename.");
  if(typeof artifactRoot!=="string"||lstatSync(artifactRoot).isSymbolicLink()||!lstatSync(artifactRoot).isDirectory())fail("Use a real current-film provider workspace.");
  const root=realpathSync(artifactRoot),guard=currentFilmWorkspaceGuard(root,owner.projectId,owner.jobId);guard.check(true);
  const parent=owner.projectId+"/"+owner.jobId+"/clips/attempts";
  components(root,parent,true);
  const key=parent+"/"+randomUUID(),directory=join(root,key);
  mkdirSync(directory);const identity=lstatSync(components(root,key)),target=join(directory,name);
  guard.check(true);signal?.throwIfAborted();
  // Dispatch exceptions, including provider-recorded sunk costs, pass through
  // untouched. Only our post-dispatch refusal needs the successful call's cost.
  const clip=await dispatch(target.split(sep).join("/"));
  const costs=returnedCosts(clip);
  try{signal?.throwIfAborted();returnedRoles(clip,root,key,target,identity);guard.check(true);signal?.throwIfAborted();return clip;}
  catch(error){throw withCosts(error,costs);}
}
