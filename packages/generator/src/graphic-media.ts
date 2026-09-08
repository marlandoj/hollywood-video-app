import {realpathSync,statSync} from "node:fs";
import {dirname,join,relative,resolve,sep} from "node:path";
import type {Job} from "../../queue/src/index";
import {graphicInventory,validateGraphicOutput,type GraphicOutput} from "../../planner/src/graphic-jobs";
import type {GraphicRenderReceipt} from "./graphic-receipt";
import {contentHash} from "./capabilities";
import {soundDigest} from "./sound-media";
import {verifyGraphicBundle} from "./graphic-render";
import {editFail} from "../../planner/src/edit-errors";
export async function sealGraphicJob(job:Job,root:string,directory:string,report:GraphicRenderReceipt,access:()=>Promise<void>,signal?:AbortSignal):Promise<GraphicOutput>{
  const base=realpathSync(root),owned=realpathSync(directory);if(owned!==resolve(directory)||!owned.startsWith(resolve(base,job.projectId,job.id)+sep))editFail("The graphic escaped its job directory.");
  await verifyGraphicBundle(owned,report.revision,access,signal);const files=[];
  for(const entry of graphicInventory(report)){await access();signal?.throwIfAborted();const path=join(owned,entry.file),digest=await soundDigest(path,signal);files.push({path:relative(base,path).replaceAll("\\","/"),...digest});}
  const prefix=relative(base,owned).replaceAll("\\","/")+"/",data={schema:"hv-graphic-output/1" as const,planRevision:job.graphicRender!.revision,report,masterPath:prefix+"graphic.mkv",manifestPath:prefix+"graphic.json",files};
  const output={...data,revision:contentHash(data)};validateGraphicOutput(job,output);return output;
}
export async function verifyGraphicMedia(job:Job,output:GraphicOutput,root:string,access:()=>Promise<void>=async()=>{},signal?:AbortSignal):Promise<void>{
  validateGraphicOutput(job,output);const base=realpathSync(root),owned=dirname(resolve(base,output.manifestPath));if(realpathSync(owned)!==owned||!owned.startsWith(resolve(base,job.projectId,job.id)+sep))editFail("The retained graphic escaped its owner.");
  for(const file of output.files){await access();signal?.throwIfAborted();const path=resolve(base,file.path);if(realpathSync(path)!==path||statSync(path).size!==file.bytes||(await soundDigest(path,signal)).sha256!==file.sha256)editFail("A retained graphic file changed.");}
  const receipt=await verifyGraphicBundle(owned,output.report.revision,access,signal);if(contentHash(receipt)!==contentHash(output.report))editFail("The retained graphic differs from its completed job.");
}
