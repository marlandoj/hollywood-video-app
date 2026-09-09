import {lstatSync,opendirSync,realpathSync} from "node:fs";
import {join,resolve} from "node:path";
import {validateEditSourceReceipt,type EditSourceReceipt} from "../packages/planner/src/edit-sources";
import {verifyEditSourceReceiptMedia} from "../packages/generator/src/edit-source-media";

/** Fixed historical bridge for state16's approved /4 receipt locations. The
 * snapshot verifier selects a complete original/carrier namespace first; this
 * never searches other owners, rewrites Jobs or grants current availability.
 * Existing /1-/3 archive dispatch stays unchanged. */
export async function verifyEditSourceReceiptArchive(raw:EditSourceReceipt,originalNamespace:string,probeScratch:string,signal?:AbortSignal):Promise<void>{
  const receipt=validateEditSourceReceipt(raw);
  if(receipt.schema!=="hv-edit-source/4")throw new Error("Use the version-four receipt archive verifier for this original.");
  const root=resolve(originalNamespace),rootStat=lstatSync(root);
  if(!rootStat.isDirectory()||rootStat.isSymbolicLink()||realpathSync(root)!==root)throw new Error("Use a real original archive namespace.");
  const expected=new Map(receipt.files.map(file=>[file.path,file])),owner=receipt.job.projectId+"/"+receipt.job.id;
  const components=(key:string):string=>{
    let path=root;for(const part of key.split("/")){path=join(path,part);const stat=lstatSync(path);
      if(stat.isSymbolicLink()||realpathSync(path)!==path)throw new Error("Receipt archives cannot follow links or redirected media.");
    }return path;
  };
  const inventory=()=>{
    const stack=[{key:owner,depth:0}],seen=new Set<string>();let nodes=0;
    while(stack.length){signal?.throwIfAborted();const {key,depth}=stack.pop()!;
      if(++nodes>200000||depth>220)throw new Error("Receipt archive traversal exceeds its original bounded inventory.");
      const path=components(key),stat=lstatSync(path);
      if(stat.isDirectory()){
        const handle=opendirSync(path);try{for(let entry=handle.readSync();entry;entry=handle.readSync()){
          if(nodes+stack.length>=200000)throw new Error("Receipt archive traversal exceeds its original bounded inventory.");
          stack.push({key:key+"/"+entry.name,depth:depth+1});
        }}finally{handle.closeSync();}
      }else {
        const file=expected.get(key);
        if(!stat.isFile()||!file||stat.size!==file.bytes||stat.size<1||stat.size>8*1024**3||seen.size>=30000)throw new Error("Receipt archive contains missing, changed or unreviewed owned media.");
        seen.add(key);
      }
    }
    if(seen.size!==expected.size)throw new Error("Receipt archive lost a required original media role.");
  };
  inventory();await verifyEditSourceReceiptMedia(receipt,root,probeScratch,async()=>{},signal);inventory();
}
