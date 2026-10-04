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
import {measurePictureQc} from "./picture-qc";
import {renderDeliveryReframe,type DeliveryReframeResult} from "./delivery-reframe";
import {renderDeliveryMezzanine,type DeliveryMezzanineResult} from "./delivery-mezzanine";
import {renderDeliveryOpenCaptions,type DeliveryOpenCaptionsResult} from "./delivery-captions";
import {renderDeliverySdh,type DeliverySdhResult} from "./delivery-sdh";
import {EDIT_FPS} from "../../planner/src/edit-timeline";
import {renderColorGrade,type ColorGradeResult} from "./color-grade";
import {colorGradeCheck} from "../../planner/src/color-grade";
import {deliveryConformDirectory,deliveryFileName,deliveryReadFiles,isHeroPlan,validateDeliveryJob,validateDeliveryOutput,
  type DeliveryJobPlan,type DeliveryOutput,type DeliveryResult} from "../../planner/src/delivery-jobs";
import type {HeroDeliveryOutput,HeroJobPlan} from "../../planner/src/hero-chain";
import {renderHeroChain,sealHeroJob,verifyHeroMedia,type HeroRenderResult} from "./hero-chain";

type Access=()=>Promise<void>;
export class DeliveryMediaError extends Error {override name="DeliveryMediaError";}
const fail:(message:string)=>never=message=>{throw new DeliveryMediaError(message);};
export interface DeliveryRenderResult {
  plan:DeliveryJobPlan;path:string;
  reframe?:DeliveryReframeResult;mezzanine?:DeliveryMezzanineResult;openCaptions?:DeliveryOpenCaptionsResult;grade?:ColorGradeResult;sdh?:DeliverySdhResult;
}
/** HV-019-15: a hero render's chain, as the worker hands it to the seal. */
export interface HeroDeliveryRender {plan:HeroJobPlan;hero:HeroRenderResult}
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
export async function renderDeliveryJob(job:Job|JobInput,artifactRoot:string,workspace:string,access:Access,signal?:AbortSignal,reader?:DialogueArtifactReader):Promise<DeliveryRenderResult|HeroDeliveryRender>{
  validateDeliveryJob(job);
  const root=realpathSync(artifactRoot),work=realpathSync(workspace);
  if(!work.startsWith(root+sep))fail("A delivery workspace belongs inside the artifact root.");
  const sources=join(work,"sources");mkdirSync(sources,{recursive:true});
  await access();signal?.throwIfAborted();
  // HV-019-15: a hero render reads one shot's clip from its film, through the same reader, and runs its chain.
  if(isHeroPlan(job.delivery)){
    const hero=job.delivery,shot=hero.binding.shot.video;
    assertEditFreeSpace(root,shot.bytes*2);
    await withEditSourceAccess(access,signal,active=>
      copyDialogueFiles({id:hero.binding.source.jobId,projectId:hero.binding.source.projectId},[shot],root,sources,active,reader));
    const source=join(realpathSync(sources),shot.path);
    if(!lstatSync(source).isFile())fail("This shot's clip is not a file.");
    return {plan:hero,hero:await renderHeroChain(job,source,root,work,access,signal)};
  }
  const plan=job.delivery as DeliveryJobPlan,binding=plan.binding;
  // The copy is the largest single step here and it used to run with the workspace guard, the
  // deadline and the permission re-read all suspended for its whole duration -- which for a
  // mezzanine of a long film is the studio's biggest unguarded disk write. Every sibling worker
  // reserves the space first and ticks `access()` through the copy; this one does too.
  // HV-027-08: what this kind reads, not everything it is bound to. The binding names the whole
  // sealed conform for every kind; only the mezzanine opens the conform directory.
  const needed=deliveryReadFiles(plan);
  const wanted=needed.reduce((total,file)=>total+file.bytes,0);
  assertEditFreeSpace(root,wanted*2);
  await withEditSourceAccess(access,signal,active=>
    copyDialogueFiles({id:binding.source.jobId,projectId:binding.source.projectId},needed,root,sources,active,reader));
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
    // HV-027-15: the film's own sealed captions, burned into the master's frame or a reframe of it.
    if(plan.openCaptions){
      const captions=join(verified,plan.openCaptions.captions.path);
      if(!lstatSync(captions).isFile())fail("This film's caption track is not a file.");
      const openCaptions=await renderDeliveryOpenCaptions(master,captions,plan.openCaptions,
        {width:binding.conform.width,height:binding.conform.height,durationSec:binding.conform.frames/EDIT_FPS},destination,scratch,access,signal);
      return {plan,path:destination,openCaptions};
    }
    // HV-026-07: a grade reads the master and nothing else, like a reframe.
    if(plan.kind==="grade"){
      const grade=await renderColorGrade(master,plan.grade!,destination,scratch,access,signal);
      return {plan,path:destination,grade};
    }
    // HV-027-16: the master itself, with an SDH track beside its picture and sound.
    if(plan.sdh){
      const captions=join(verified,plan.sdh.captions.path);
      if(!lstatSync(captions).isFile())fail("This film's caption track is not a file.");
      const sdh=await renderDeliverySdh(master,captions,plan.sdh,destination,scratch,access,signal);
      return {plan,path:destination,sdh};
    }
    const reframe=await renderDeliveryReframe(master,plan.reframe!,destination,scratch,access,signal);
    return {plan,path:destination,reframe};
  }finally{rmSync(scratch,{recursive:true,force:true});}
}
export async function sealDeliveryJob(job:Job|JobInput,artifactRoot:string,rendered:DeliveryRenderResult|HeroDeliveryRender,access:Access,signal?:AbortSignal):Promise<DeliveryResult>{
  if("hero" in rendered){const output=await sealHeroJob(job,artifactRoot,rendered.hero,access,signal);validateDeliveryOutput(job,output);return output;}
  const result=rendered,root=realpathSync(artifactRoot),path=deliveryOutputPath(job,result.plan,root);
  if(path!==result.path||!existsSync(path))fail("This delivery job wrote nothing to seal.");
  const scratch=mkdtempSync(join(root,".delivery-seal-"));
  try{
    // HV-027-06. The check reads the file once and returns its digest and size beside the
    // measurement, so the deliverable's digest of record *is* the one the check measured -- rather
    // than a second full read of a file that can be gigabytes of lossless picture. `describe` still
    // probes independently: two readings of one file, seconds apart, that the validator makes
    // agree.
    const quality=await measurePictureQc(path,scratch,access,signal);
    const data={schema:"hv-delivery-output/1" as const,planRevision:result.plan.revision,
      resultRevision:(result.mezzanine??result.openCaptions??result.sdh??result.reframe??result.grade)!.revision,
      file:{path:path.slice(root.length+1).split(sep).join("/"),sha256:quality.source.sha256,bytes:quality.source.bytes},
      delivered:await describe(path,scratch,access,signal),quality,
      // HV-027-15: the burn's own measurement of its caption layer, kept beside the picture check.
      ...(result.openCaptions?{captions:result.openCaptions.check}:{}),
      // HV-026-07: the grade is judged on what it clipped as it was made and on the levels the quality
      // check just read from the file -- the file the render wrote, byte for byte.
      ...(result.grade?{grade:(()=>{
        if(result.grade.file.sha256!==quality.source.sha256||result.grade.file.bytes!==quality.source.bytes)
          fail("The graded cut changed between being made and being checked.");
        return colorGradeCheck(result.plan.grade!,quality.source,result.grade.measurement,{lumaMin:quality.picture.lumaMin,lumaMax:quality.picture.lumaMax});
      })()}:{}),
      // HV-027-16: the SDH render's proof of its own track, and that the picture and sound are the master's.
      ...(result.sdh?{sdh:result.sdh.check}:{})};
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
export async function verifyDeliveryMedia(job:Job|JobInput,result:DeliveryResult,artifactRoot:string,access:Access,signal?:AbortSignal,retained?:string):Promise<void>{
  validateDeliveryOutput(job,result);
  if(result.schema==="hv-hero-output/1")return verifyHeroMedia(job,result as HeroDeliveryOutput,artifactRoot,access,signal,retained);
  const output=result as DeliveryOutput,plan=job.delivery as DeliveryJobPlan;
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
