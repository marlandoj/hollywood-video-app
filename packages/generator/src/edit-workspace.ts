import {existsSync,lstatSync,readdirSync,realpathSync,statfsSync} from "node:fs";
import {join,resolve,sep} from "node:path";
import {editFail} from "../../planner/src/edit-timeline";
import {EDIT_STORAGE_LIMITS} from "../../planner/src/edit-resources";
export function assertEditFreeSpace(root:string,requiredBytes:number):void {
  const disk=statfsSync(root,{bigint:true});if(disk.bavail*disk.bsize<BigInt(Math.ceil(requiredBytes+EDIT_STORAGE_LIMITS.freeReserveBytes)))editFail("The editorial worker needs more free workspace. Free space or use a smaller assembly, then retry the saved sequence.");
}
/** Check owned working directories and free space at most once per second. */
export function editWorkspaceGuard(root:string,paths:()=>string[],limits:{bytes:number;files:number}={bytes:EDIT_STORAGE_LIMITS.workspaceBytes,files:EDIT_STORAGE_LIMITS.files*3}):()=>void {
  const base=realpathSync(root);let last=-Infinity;
  return ()=>{const now=Date.now();if(now-last<1000)return;last=now;assertEditFreeSpace(base,0);let bytes=0,files=0;
    const visit=(path:string)=>{const stat=lstatSync(path);if(stat.isSymbolicLink()||!realpathSync(path).startsWith(base+sep))editFail("Editorial workspace escaped its owner.");if(stat.isDirectory()){for(const name of readdirSync(path))visit(join(path,name));}else if(stat.isFile()){bytes+=stat.size;files++;if(bytes>limits.bytes||files>limits.files)editFail("Editorial processing exceeded its workspace capacity. The sequence is saved; reduce its sources or export size before retrying.");}else editFail("Invalid editorial workspace file.");};
    const scoped=[...new Set(paths().map(path=>resolve(path)))];for(const path of scoped){if(!path.startsWith(base+sep))editFail("Editorial workspace escaped its owner.");if(existsSync(path)&&!scoped.some(other=>other!==path&&path.startsWith(other+sep)))visit(path);}
  };
}
