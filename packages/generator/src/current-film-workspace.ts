import {lstatSync,opendirSync,realpathSync,type Dir} from "node:fs";
import {join} from "node:path";
import {assertEditFreeSpace} from "./edit-workspace";
import {EDIT_STORAGE_LIMITS} from "../../planner/src/edit-resources";
import {editValidationKey} from "../../planner/src/edit-validation-key";

/** Whole-job runtime bound, including generated attempts, delivery and abandoned
 * staging. This is not a forecast or proof that a project fits an archive.
 * Internal callers may tighten limits; they cannot expand the existing ceiling. */
export function currentFilmWorkspaceGuard(artifactRoot:string,projectId:string,jobId:string,
  limits={bytes:EDIT_STORAGE_LIMITS.workspaceBytes,files:EDIT_STORAGE_LIMITS.files*3}):{check:(force?:boolean,additional?:{bytes:number;files:number})=>void} {
  if(!editValidationKey({projectId,jobId,limits},4096)||![projectId,jobId].every(id=>typeof id==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(id))
    ||Object.keys(limits).sort().join(",")!=="bytes,files"||!Number.isSafeInteger(limits.bytes)||limits.bytes<1||limits.bytes>EDIT_STORAGE_LIMITS.workspaceBytes
    ||!Number.isSafeInteger(limits.files)||limits.files<1||limits.files>EDIT_STORAGE_LIMITS.files*3)throw new Error("Use bounded current-film workspace limits and exact owners.");
  const bounds={...limits},root=realpathSync(artifactRoot);
  if(lstatSync(artifactRoot).isSymbolicLink()||!lstatSync(root).isDirectory())throw new Error("Use a real current-film workspace.");
  const owner=join(root,projectId,jobId);let last=-Infinity;
  return {check(force=false,additional){
    // A pending copy set is added only to this scan. It does not reserve disk or
    // predict future generation; concurrent writes remain runtime-guarded.
    if(additional&&(!editValidationKey(additional,4096)||Object.keys(additional).sort().join(",")!=="bytes,files"
      ||![additional.bytes,additional.files].every(value=>Number.isSafeInteger(value)&&value>=0)
      ||additional.bytes>bounds.bytes||additional.files>bounds.files))throw new Error("Current-film pending copies exceed bounded workspace capacity.");
    let path=root,present=true;
    for(const part of [projectId,jobId]){
      path=join(path,part);let stat;
      try{stat=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT"){present=false;break;}throw error;}
      if(stat.isSymbolicLink()||!stat.isDirectory()||realpathSync(path)!==path)throw new Error("Current-film workspace ownership cannot follow linked or changed directories.");
    }
    const now=Date.now();if(!force&&!additional&&now-last<1000)return;last=now;assertEditFreeSpace(root,additional?.bytes??0);if(!present)return;
    // Directory handles bound both allocation and traversal: empty abandoned
    // directories count as entries, and no recursive call can exhaust the stack.
    const stack:{directory:Dir;path:string;depth:number}[]=[{directory:opendirSync(owner),path:owner,depth:0}];
    let entries=0,files=additional?.files??0,bytes=additional?.bytes??0;
    try{while(stack.length){const frame=stack.at(-1)!,entry=frame.directory.readSync();
      if(!entry){frame.directory.closeSync();stack.pop();continue;}
      if(++entries>bounds.files*4)throw new Error("Current-film workspace capacity exceeds its directory-entry bound.");
      const path=join(frame.path,entry.name),stat=lstatSync(path);
      if(stat.isSymbolicLink()||realpathSync(path)!==path)throw new Error("Current-film workspace ownership cannot follow linked entries.");
      if(stat.isDirectory()){
        if(frame.depth>=220)throw new Error("Current-film workspace capacity exceeds its directory-depth bound.");
        stack.push({directory:opendirSync(path),path,depth:frame.depth+1});
      }else if(stat.isFile()){
        files++;bytes+=stat.size;if(files>bounds.files||bytes>bounds.bytes)throw new Error("Current-film processing exceeded its workspace capacity.");
      }else throw new Error("Current-film workspace requires regular owned files.");
    }}finally{for(const frame of stack)frame.directory.closeSync();}
  }};
}
