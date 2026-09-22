import {createHash} from "node:crypto";
import {existsSync,lstatSync,mkdirSync,mkdtempSync,realpathSync,rmSync,statSync} from "node:fs";
import {join,resolve,sep} from "node:path";
import type {Job,JobInput} from "../../queue/src/index";
import {contentHash} from "./capabilities";
import {soundProcessingCommand} from "./sound-finishing";
import {copyDialogueFiles,type DialogueArtifactReader} from "./dialogue-replacement";
import {assertEditFreeSpace} from "./edit-workspace";
import {withEditSourceAccess} from "./edit-source-media";
import {editFrameHashes} from "./edit-conform";
import {renderDeliveryReframe,type DeliveryReframeResult} from "./delivery-reframe";
import {renderDeliveryMezzanine,type DeliveryMezzanineResult} from "./delivery-mezzanine";
import {deliveryConformDirectory,deliveryFileName,validateDeliveryJob,validateDeliveryOutput,
  type DeliveryJobPlan,type DeliveryOutput} from "../../planner/src/delivery-jobs";

type Access=()=>Promise<void>;
export class DeliveryMediaError extends Error {override name="DeliveryMediaError";}
const fail:(message:string)=>never=message=>{throw new DeliveryMediaError(message);};
export interface DeliveryRenderResult {
  plan:DeliveryJobPlan;path:string;
  reframe?:DeliveryReframeResult;mezzanine?:DeliveryMezzanineResult;
}
/** The one path a delivery job may write, guarded the way every other owned output is. */
export function deliveryOutputPath(job:Pick<Job,"id"|"projectId">,plan:DeliveryJobPlan,root:string):string{
  const owner=resolve(root,job.projectId,job.id),path=join(owner,deliveryFileName(plan));
  if(!owner.startsWith(resolve(root)+sep)||!path.startsWith(owner+sep))fail("A deliverable escaped its owner.");
  return path;
}
const digest=async(path:string,signal?:AbortSignal)=>{const sum=createHash("sha256");
  for await(const chunk of Bun.file(path).stream()){signal?.throwIfAborted();sum.update(chunk);}return sum.digest("hex");};
async function describe(path:string,directory:string,access:Access,signal?:AbortSignal):Promise<DeliveryOutput["delivered"]>{
  const probeFile=join(directory,"delivered-probe.json");
  try{
    await soundProcessingCommand(["ffprobe","-v","error","-protocol_whitelist","file,pipe","-show_streams","-show_format","-of","json","-o",probeFile,path],directory,access,signal);
    if(statSync(probeFile).size>8*1024**2)fail("A deliverable's description exceeds its limit.");
    const probe=JSON.parse(await Bun.file(probeFile).text()) as {streams?:Record<string,unknown>[];format?:Record<string,unknown>};
    const video=probe.streams?.find(stream=>stream.codec_type==="video"),audio=probe.streams?.find(stream=>stream.codec_type==="audio");
    if(!video||!audio)fail("A deliverable carries a picture and a soundtrack, and this one does not.");
    const durationSec=Number(probe.format?.duration??0);
    if(!Number.isFinite(durationSec)||durationSec<=0)fail("A deliverable reports no playable duration.");
    return {width:Number(video.width),height:Number(video.height),durationSec,video:String(video.codec_name??""),audio:String(audio.codec_name??"")};
  }catch(error){if(error instanceof SyntaxError)return fail("A deliverable's description could not be read.");throw error;}
  finally{rmSync(probeFile,{force:true});}
}
/**
 * HV-027-05: one deliverable, made from the film's own retained bytes.
 *
 * The source files are copied into a **private scratch** first, one declared file at a time through
 * the artifact reader, which checks each file's digest and length as it streams it. That is the only
 * way another job's bytes reach a worker here, and it is why the plan names every file rather than
 * naming a directory: nothing enumerates another job's artifacts under `s3`.
 *
 * Nothing in the source job is written to. The deliverable is written under this job's own prefix,
 * replacing whatever a previous attempt of **this** job left there, which is the only file it owns.
 */
export async function renderDeliveryJob(job:Job|JobInput,artifactRoot:string,workspace:string,access:Access,signal?:AbortSignal,reader?:DialogueArtifactReader):Promise<DeliveryRenderResult>{
  validateDeliveryJob(job);const plan=job.delivery!,binding=plan.binding;
  const root=realpathSync(artifactRoot),work=realpathSync(workspace);
  if(!work.startsWith(root+sep))fail("A delivery workspace belongs inside the artifact root.");
  const sources=join(work,"sources");mkdirSync(sources,{recursive:true});
  await access();signal?.throwIfAborted();
  // The copy is the largest single step here and it used to run with the workspace guard, the
  // deadline and the permission re-read all suspended for its whole duration -- which for a
  // mezzanine of a long film is the studio's biggest unguarded disk write. Every sibling worker
  // reserves the space first and ticks `access()` through the copy; this one does too.
  const wanted=binding.files.reduce((total,file)=>total+file.bytes,0);
  assertEditFreeSpace(root,wanted*2);
  await withEditSourceAccess(access,signal,active=>
    copyDialogueFiles({id:binding.source.jobId,projectId:binding.source.projectId},binding.files,root,sources,active,reader));
  const verified=realpathSync(sources),master=join(verified,binding.master.path);
  if(!lstatSync(master).isFile())fail("This film's master is not a file.");
  const destination=deliveryOutputPath(job,plan,root);
  mkdirSync(resolve(destination,".."),{recursive:true});
  // A previous attempt of this job may have left a partial file under the one name this job owns.
  // Nothing else can be at that path: it carries this job's own identity.
  rmSync(destination,{force:true});
  const scratch=mkdtempSync(join(work,"render-"));
  await access();signal?.throwIfAborted();
  try{
    if(plan.kind==="mezzanine"){
      const conform=join(verified,deliveryConformDirectory(binding.master.path));
      const mezzanine=await renderDeliveryMezzanine(conform,plan.mezzanine!,destination,scratch,access,signal);
      return {plan,path:destination,mezzanine};
    }
    const reframe=await renderDeliveryReframe(master,plan.reframe!,destination,scratch,access,signal);
    return {plan,path:destination,reframe};
  }finally{rmSync(scratch,{recursive:true,force:true});}
}
export async function sealDeliveryJob(job:Job|JobInput,artifactRoot:string,result:DeliveryRenderResult,access:Access,signal?:AbortSignal):Promise<DeliveryOutput>{
  const root=realpathSync(artifactRoot),path=deliveryOutputPath(job,result.plan,root);
  if(path!==result.path||!existsSync(path))fail("This delivery job wrote nothing to seal.");
  const scratch=mkdtempSync(join(root,".delivery-seal-"));
  try{
    const data={schema:"hv-delivery-output/1" as const,planRevision:result.plan.revision,
      resultRevision:(result.mezzanine??result.reframe)!.revision,
      file:{path:path.slice(root.length+1).split(sep).join("/"),sha256:await digest(path,signal),bytes:statSync(path).size},
      delivered:await describe(path,scratch,access,signal)};
    const output={...data,revision:contentHash(data)};
    validateDeliveryOutput(job,output);
    return output;
  }finally{rmSync(scratch,{recursive:true,force:true});}
}
/**
 * A retained deliverable is checked against what it claims to be, not merely against its own digest.
 *
 * The digest says the bytes have not changed; the probe says they are still the film's shape; and for
 * a mezzanine the decoded frames are hashed and compared with the **conform's own** recorded hashes,
 * which is the same proof the render made and the only one that says "this is that film".
 *
 * A reframe is not reproduced. Re-encoding it would cost a full render to compare an encoder against
 * itself, and would say nothing the digest and the probe do not. That is a smaller claim than
 * editorial's verify-by-reproduction and it is stated rather than implied.
 */
export async function verifyDeliveryMedia(job:Job|JobInput,output:DeliveryOutput,artifactRoot:string,access:Access,signal?:AbortSignal,retained?:string):Promise<void>{
  validateDeliveryOutput(job,output);const plan=job.delivery!;
  const root=realpathSync(artifactRoot),owner=retained===undefined?root:realpathSync(retained),path=deliveryOutputPath(job,plan,owner);
  if(path.slice(owner.length+1).split(sep).join("/")!==output.file.path)fail("A deliverable is retained under its own job and nowhere else.");
  if(!existsSync(path)||lstatSync(path).isSymbolicLink()||!lstatSync(path).isFile())fail("This deliverable is missing from its own job.");
  await access();
  if(statSync(path).size!==output.file.bytes||await digest(path,signal)!==output.file.sha256)fail("This deliverable failed checksum verification.");
  const scratch=mkdtempSync(join(root,".delivery-verify-"));
  try{
    if(contentHash(await describe(path,scratch,access,signal))!==contentHash(output.delivered))fail("This deliverable is no longer the file its record describes.");
    if(plan.kind!=="mezzanine")return;
    const frames=await editFrameHashes(path,plan.binding.conform.frames,join(scratch,"frames.txt"),scratch,access,signal);
    if(contentHash(frames)!==plan.binding.conform.pictureFramesSha256)
      fail("This mezzanine's picture is not the frames its film recorded. It is not a master of this film.");
  }finally{rmSync(scratch,{recursive:true,force:true});}
}
