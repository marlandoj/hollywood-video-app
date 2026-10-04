import {createHash} from "node:crypto";
import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,rmSync,statSync,writeFileSync} from "node:fs";
import {join,resolve,sep} from "node:path";
import type {Job,JobInput} from "../../queue/src/index";
import {contentHash} from "./capabilities";
import {soundProcessingCommand} from "./sound-finishing";
import {measurePictureQc} from "./picture-qc";
import {exportC2paSigner,exportCredentials} from "../../assembler/src/export-credentials";
import {PROVENANCE_SIDECAR_NAME} from "../../planner/src/provenance";
import {HERO_DIRECTORY,assertHeroFrameRateChanges,assertHeroSourceProbe,assertHeroStageProbe,heroDerivation,heroInventory,heroStageArgs,heroStageFileName,heroStageFilter,
  validateHeroJobPlan,validateHeroProbe,type HeroChainRecord,type HeroDeliveryOutput,type HeroJobPlan,type HeroProbe,type HeroStageRecord} from "../../planner/src/hero-chain";
import type {RenderFile} from "../../planner/src/shot-reuse";

type Access=()=>Promise<void>;
export class HeroMediaError extends Error {override name="HeroMediaError";}
const fail:(message:string)=>never=message=>{throw new HeroMediaError(message);};
const digest=async(path:string,signal?:AbortSignal)=>{const sum=createHash("sha256");
  for await(const chunk of Bun.file(path).stream()){signal?.throwIfAborted();sum.update(chunk);}return sum.digest("hex");};
export interface HeroRenderResult {chain:HeroChainRecord;directory:string}

/** The ffmpeg build on this host: its version string and a digest of its whole banner. */
export function heroRuntime():HeroStageRecord["runtime"]{
  const result=Bun.spawnSync(["ffmpeg","-version"],{stdin:"ignore",stdout:"pipe",stderr:"pipe",timeout:10000}),banner=result.stdout.toString().replace(/\r\n/g,"\n");
  const version=/^ffmpeg version (\S{1,64})/.exec(banner)?.[1];
  if(result.exitCode!==0||!version||!/^[A-Za-z0-9._+~:-]{1,64}$/.test(version))fail("Install ffmpeg before making a hero render.");
  return {ffmpeg:version,revision:contentHash({schema:"hv-hero-runtime/1",banner})};
}
/**
 * The ffprobe reading every stage is gated on. Frames are counted by decoding, not read from the
 * container's header, because a header can claim any number.
 */
export async function probeHero(path:string,directory:string,access:Access,signal?:AbortSignal):Promise<HeroProbe>{
  const probeFile=join(directory,"hero-probe.json");
  try{
    await soundProcessingCommand(["ffprobe","-v","error","-protocol_whitelist","file,pipe","-select_streams","v:0","-count_frames",
      "-show_entries","stream=codec_name,width,height,r_frame_rate,nb_read_frames,pix_fmt:format=duration","-of","json","-o",probeFile,path],directory,access,signal);
    if(statSync(probeFile).size>1024**2)fail("A hero file's description exceeds its limit.");
    const probe=JSON.parse(readFileSync(probeFile,"utf8")) as {streams?:Record<string,unknown>[];format?:Record<string,unknown>};
    const video=probe.streams?.[0];if(!video)fail("This file has no picture.");
    return validateHeroProbe({width:Number(video.width),height:Number(video.height),fps:String(video.r_frame_rate??""),frames:Number(video.nb_read_frames),
      durationSec:Math.round(Number(probe.format?.duration??0)*1000)/1000,codec:String(video.codec_name??""),pixFmt:String(video.pix_fmt??"")});
  }catch(error){if(error instanceof SyntaxError)return fail("A hero file's description could not be read.");throw error;}
  finally{rmSync(probeFile,{force:true});}
}
/** The one directory a hero render may write, under its own job and nowhere else. */
export function heroOutputDirectory(job:Pick<Job,"id"|"projectId">,root:string):string{
  const owner=resolve(root,job.projectId,job.id),directory=join(owner,HERO_DIRECTORY);
  if(!owner.startsWith(resolve(root)+sep)||!directory.startsWith(owner+sep))fail("A hero render escaped its owner.");
  return directory;
}
/**
 * The chain, run on the shot's own file. Each stage reads the file the one before it wrote, runs the
 * filter its plan and that file derive, and is gated on an ffprobe reading of what it wrote before
 * the next stage may start. The result is signed exactly as an export is when the host holds a key,
 * and the chain's record -- the provenance of every stage -- is written beside it.
 */
export async function renderHeroChain(job:Job|JobInput,source:string,artifactRoot:string,workspace:string,access:Access,signal?:AbortSignal):Promise<HeroRenderResult>{
  const plan=validateHeroJobPlan(job.delivery as HeroJobPlan),binding=plan.binding;
  // The host's signer is loaded before anything is encoded, as every exporting stage does.
  const signer=exportC2paSigner(),runtime=heroRuntime();
  const root=realpathSync(artifactRoot),directory=heroOutputDirectory(job,root),relative=(path:string)=>path.slice(root.length+1).split(sep).join("/");
  if(!lstatSync(source).isFile()||statSync(source).size!==binding.shot.video.bytes||await digest(source,signal)!==binding.shot.video.sha256)
    fail("The shot changed before its hero render began.");
  // A previous attempt of this job may have left partial files under the one directory it owns.
  rmSync(directory,{recursive:true,force:true});mkdirSync(directory,{recursive:true});
  if(realpathSync(directory)!==directory)fail("A hero render escaped its owner.");
  const scratch=mkdtempSync(join(realpathSync(workspace),"hero-"));
  try{
    await access();
    const sourceProbe=await probeHero(source,scratch,access,signal);
    assertHeroSourceProbe(sourceProbe,binding);
    const stages:HeroStageRecord[]=[];let input=source,inputFile={sha256:binding.shot.video.sha256,bytes:binding.shot.video.bytes},probe=sourceProbe;
    for(const stage of plan.chain.stages){
      signal?.throwIfAborted();
      assertHeroFrameRateChanges(stage,probe);
      const filter=heroStageFilter(stage,probe),args=heroStageArgs(filter),output=join(directory,heroStageFileName(stage));
      await soundProcessingCommand(args.map(value=>value==="<input>"?input:value==="<output>"?output:value),scratch,access,signal);
      const written=await probeHero(output,scratch,access,signal);
      assertHeroStageProbe(stage,probe,written);
      const data={schema:"hv-hero-stage/1" as const,index:stage.index,stage:stage.stage,engine:stage.engine,provider:stage.provider,spendUsd:stage.spendUsd,params:structuredClone(stage.params),
        input:inputFile,filter,args,runtime,output:{path:relative(output),sha256:await digest(output,signal),bytes:statSync(output).size},probe:written};
      stages.push({...data,revision:contentHash(data)});
      input=output;inputFile={sha256:data.output.sha256,bytes:data.output.bytes};probe=written;
    }
    const sourceRecord={projectId:binding.source.projectId,jobId:binding.source.jobId,shotId:binding.source.shotId,renderRevision:binding.shot.renderRevision,
      sha256:binding.shot.video.sha256,bytes:binding.shot.video.bytes,probe:sourceProbe};
    await access();
    // The signed manifest names what the result was derived from: the shot, its render record, the
    // bytes the first stage read, and the digest of every stage's record.
    const {credentials}=await exportCredentials(signer,{mp4Path:input,recordDirectory:directory,spec:"hv-hero-chain/1",projectId:job.projectId,
      derivedFrom:heroDerivation(sourceRecord,stages)},signal);
    const data={schema:"hv-hero-chain/1" as const,planRevision:plan.revision,bindingRevision:binding.revision,source:sourceRecord,stages,credentials};
    const chain={...data,revision:contentHash(data)};
    writeFileSync(join(directory,"provenance.json"),JSON.stringify(chain,null,2)+"\n");
    return {chain,directory};
  }finally{rmSync(scratch,{recursive:true,force:true});}
}
/**
 * The hero deliverable, sealed: every file it retains named with its digest, the chain's record, and
 * the picture check every deliverable carries, run on the chain's result.
 */
export async function sealHeroJob(job:Job|JobInput,artifactRoot:string,result:HeroRenderResult,access:Access,signal?:AbortSignal):Promise<HeroDeliveryOutput>{
  const plan=job.delivery as HeroJobPlan,root=realpathSync(artifactRoot),directory=heroOutputDirectory(job,root);
  if(directory!==result.directory||!existsSync(directory))fail("This hero render wrote nothing to seal.");
  const signed=result.chain.credentials.type==="c2pa-sidecar",files:RenderFile[]=[];
  for(const path of heroInventory(job,plan,signed)){
    const local=join(root,...path.split("/"));
    if(!existsSync(local)||lstatSync(local).isSymbolicLink()||!lstatSync(local).isFile())fail("This hero render is missing "+path.slice(path.lastIndexOf("/")+1)+".");
    files.push({path,sha256:await digest(local,signal),bytes:statSync(local).size});
  }
  const last=result.chain.stages.at(-1)!.output,scratch=mkdtempSync(join(root,".hero-seal-"));
  try{
    const quality=await measurePictureQc(join(root,...last.path.split("/")),scratch,access,signal);
    const data={schema:"hv-hero-output/1" as const,planRevision:plan.revision,file:{...last},files,chain:result.chain,quality};
    return {...data,revision:contentHash(data)};
  }finally{rmSync(scratch,{recursive:true,force:true});}
}
/**
 * A retained hero render, checked against its record: every file's bytes, the chain's record as it
 * was written, and the result's own probe against the one its last stage was gated on.
 */
export async function verifyHeroMedia(job:Job|JobInput,output:HeroDeliveryOutput,artifactRoot:string,access:Access,signal?:AbortSignal,retained?:string):Promise<void>{
  const root=realpathSync(artifactRoot),owner=retained===undefined?root:realpathSync(retained);
  for(const file of output.files){
    const local=join(owner,...file.path.split("/"));
    if(!local.startsWith(owner+sep)||!existsSync(local)||lstatSync(local).isSymbolicLink()||!lstatSync(local).isFile())fail("This hero render is missing from its own job.");
    await access();
    if(statSync(local).size!==file.bytes||await digest(local,signal)!==file.sha256)fail("This hero render failed checksum verification.");
  }
  const record=output.files.find(file=>file.path.endsWith("/provenance.json"))!;
  let written:unknown;try{written=JSON.parse(readFileSync(join(owner,...record.path.split("/")),"utf8"));}catch{return fail("This hero render's record could not be read.");}
  if(contentHash(written)!==contentHash(output.chain))fail("This hero render's record is not the chain it was sealed with.");
  if(output.chain.credentials.type==="c2pa-sidecar"&&!output.files.some(file=>file.path.endsWith("/"+PROVENANCE_SIDECAR_NAME)))fail("This hero render's C2PA sidecar is missing.");
  const scratch=mkdtempSync(join(root,".hero-verify-"));
  try{
    if(contentHash(await probeHero(join(owner,...output.file.path.split("/")),scratch,access,signal))!==contentHash(output.chain.stages.at(-1)!.probe))
      fail("This hero render's result is no longer the file its record describes.");
  }finally{rmSync(scratch,{recursive:true,force:true});}
}
