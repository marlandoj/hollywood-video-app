import {lstatSync,mkdirSync,realpathSync} from "node:fs";
import {join,resolve,sep} from "node:path";

/** Older exports used the job directory. New workers use an exclusive delivery
 * directory so a late assembler cannot overwrite another holder's result. */
export function currentFilmExportDirectoryKey(root:string,projectId:string,jobId:string,outDir:string):string {
  if(![projectId,jobId].every(id=>typeof id==="string"&&/^[A-Za-z0-9_-]{1,128}$/.test(id))||typeof outDir!=="string")throw new Error("Use the exact target job for mixed-film exports.");
  const owner=`${projectId}/${jobId}`,base=resolve(root,owner),path=resolve(outDir);
  if(path===base)return owner;
  const prefix=resolve(base,"exports"),leaf=path.slice(prefix.length+1);
  if(!path.startsWith(prefix+sep)||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(leaf))throw new Error("Write mixed-film exports only within their exact target job directory or an exclusive delivery directory.");
  return `${owner}/exports/${leaf}`;
}

export function createCurrentFilmExportDirectory(root:string,projectId:string,jobId:string,outDir:string):void {
  const key=currentFilmExportDirectoryKey(root,projectId,jobId,outDir);
  if(lstatSync(root).isSymbolicLink()||!lstatSync(root).isDirectory()||realpathSync(root)!==resolve(root))throw new Error("Use a real mixed-film export root.");
  let path=resolve(root);const parts=key.split("/");
  for(const [index,part]of parts.entries()){
    path=join(path,part);
    // Existing parents are allowed; the UUID leaf is never reused or cleared.
    const exclusive=parts.length===4&&index===3;
    try{mkdirSync(path);}catch(error){if(exclusive||(error as NodeJS.ErrnoException).code!=="EEXIST")throw error;}
    const stat=lstatSync(path);if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(path)!==path)throw new Error("Mixed-film exports cannot follow linked or changed directories.");
  }
}
