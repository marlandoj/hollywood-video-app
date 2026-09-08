import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,statSync,writeFileSync} from "node:fs";
import {dirname,join,resolve,sep} from "node:path";
import type {RenderFile} from "../../planner/src/shot-reuse";
import {editAssemblyJson,validateEditAssemblyRenderPlan,validateEditAssemblyOutput,type EditAssemblyRenderPlan,type EditAssemblyOutput} from "../../planner/src/edit-assembly-jobs";
import {editFail} from "../../planner/src/edit-timeline";
import {editAssemblyStorageEstimate,assertEditAssemblyStorageEstimate} from "../../planner/src/edit-assembly-resources";
import {prepareEditSources,verifyPreparedEditSources,withEditSourceAccess} from "./edit-source-media";
import {conformEditAssembly,editFrameHashes} from "./edit-conform";
import {editSourceBindingReader} from "./edit-media";
import type {DialogueArtifactReader} from "./dialogue-replacement";
import {soundDigest} from "./sound-media";
import {soundRuntimeRevision} from "./sound-audio";
import {contentHash} from "./capabilities";
import {assertEditFreeSpace,editWorkspaceGuard} from "./edit-workspace";

type Access=()=>Promise<void>;
export interface AssemblyMediaJob {id:string;projectId:string;assemblyEdit:EditAssemblyRenderPlan}
export interface AssemblyMediaOutput {mp4Path:string;hlsPlaylistPath:string;captionsPath:string;manifestPath:string;assembly:EditAssemblyOutput}
function local(root:string,key:string):string {
  if(!/^[A-Za-z0-9._/-]+$/.test(key)||key.split("/").some(part=>!part||part==="."||part===".."))editFail("Invalid assembly export path.");
  const path=resolve(root,key);if(!path.startsWith(root+sep)||!lstatSync(path).isFile()||lstatSync(path).isSymbolicLink()||!realpathSync(path).startsWith(root+sep))editFail("Assembly media escaped its workspace.");return path;
}
function remove(root:string,directory:string):void {if(!directory.startsWith(root+sep)||realpathSync(directory)!==directory)editFail("Assembly verification scratch escaped its workspace.");rmSync(directory,{recursive:true,force:true});}
function manifest(result:Omit<EditAssemblyOutput,"files"|"revision">){return {schema:"hv-edit-assembly-result/1",plan:result.plan,prepared:result.prepared,conform:result.conform};}
function json(path:string):unknown {if(statSync(path).size>192*1024**2)editFail("Assembly provenance exceeds its metadata limit.");return JSON.parse(readFileSync(path,"utf8"));}

/** Retain full original inputs; the independent output clock lives only in the assembly conform. */
export async function renderEditAssemblyJob(job:AssemblyMediaJob,artifactRoot:string,destination:string,access:Access,signal?:AbortSignal,reader?:DialogueArtifactReader):Promise<Omit<EditAssemblyOutput,"files"|"revision">>{
  const plan=job.assemblyEdit,assembly=validateEditAssemblyRenderPlan(plan,Date.now()),root=realpathSync(artifactRoot),directory=resolve(destination),scope=resolve(root,job.projectId,job.id);
  if(plan.bindings.some(binding=>binding.owner.projectId!==job.projectId||binding.owner.jobId===job.id||binding.source.job.id===job.id)||!scope.startsWith(root+sep)||!directory.startsWith(scope+sep)||existsSync(directory))editFail("Choose a new owned assembly export destination.");
  const estimate=editAssemblyStorageEstimate(assembly,plan.bindings);assertEditAssemblyStorageEstimate(estimate);assertEditFreeSpace(root,estimate.workspaceBytes);
  const permission=access,disk=editWorkspaceGuard(root,()=>[directory]);access=async()=>{disk();await permission();};
  if(soundRuntimeRevision()!==plan.engineVersion)editFail("The assembly runtime changed after review.");await access();signal?.throwIfAborted();mkdirSync(directory,{recursive:true});if(realpathSync(directory)!==directory)editFail("The assembly destination escaped its owner.");
  return withEditSourceAccess(access,signal,async active=>{
    const prepared=await prepareEditSources(plan.bindings.map(binding=>binding.source),root,join(directory,"sources"),access,active,editSourceBindingReader(plan.bindings,root,reader));
    const conform=await conformEditAssembly(assembly,prepared.sources.map(source=>source.media),root,join(directory,"conform"),access,active);
    if(soundRuntimeRevision()!==plan.engineVersion)editFail("The assembly runtime changed while rendering.");await access();
    const result={schema:"hv-edit-assembly-output/1" as const,plan:structuredClone(plan),prepared,conform};
    // Only newly generated assembly manifests are canonicalized. Retained original files keep their exact bytes.
    for(const [path,value]of [["sources/sources.json",prepared],["conform/assembly.json",assembly],["conform/timeline.json",assembly.parent.timeline],["conform/conform.json",conform]] as const)writeFileSync(local(root,join(directory,path).slice(root.length+1).split(sep).join("/")),editAssemblyJson(value));
    writeFileSync(join(directory,"provenance.json"),editAssemblyJson(manifest(result)),{flag:"wx"});return result;
  });
}

export async function sealEditAssemblyJob(job:AssemblyMediaJob,artifactRoot:string,directory:string,result:Omit<EditAssemblyOutput,"files"|"revision">,signal?:AbortSignal):Promise<AssemblyMediaOutput>{
  const root=realpathSync(artifactRoot),target=realpathSync(directory),scope=resolve(root,job.projectId,job.id);if(!scope.startsWith(root+sep)||!target.startsWith(scope+sep))editFail("An assembly export escaped its owner.");
  const files:RenderFile[]=[];
  async function visit(path:string):Promise<void>{for(const entry of readdirSync(path,{withFileTypes:true})){signal?.throwIfAborted();const next=join(path,entry.name);if(entry.isSymbolicLink())editFail("Assembly artifacts cannot be links.");if(entry.isDirectory())await visit(next);else if(entry.isFile()){if(files.length>=80000)editFail("Assembly artifacts exceeded their inventory limit.");files.push({path:next.slice(root.length+1).split(sep).join("/"),...await soundDigest(next,signal)});}else editFail("Invalid assembly artifact.");}}
  await visit(target);files.sort((a,b)=>a.path.localeCompare(b.path));const prefix=target.slice(root.length+1).split(sep).join("/")+"/",data={...result,files},output={mp4Path:prefix+"conform/export.mp4",hlsPlaylistPath:prefix+"conform/hls/index.m3u8",captionsPath:prefix+"conform/captions.vtt",manifestPath:prefix+"provenance.json",assembly:{...data,revision:contentHash(data)}};
  validateEditAssemblyOutput(job,output);return output;
}

/** Reproduce original conversions and selected parent output before publishing a recovered checkpoint. */
export async function verifyEditAssemblyMedia(job:AssemblyMediaJob,output:AssemblyMediaOutput,artifactRoot:string,access:Access,signal?:AbortSignal):Promise<void>{
  validateEditAssemblyOutput(job,output);const root=realpathSync(artifactRoot),result=output.assembly,directory=dirname(local(root,output.manifestPath)),plan=job.assemblyEdit,assembly=validateEditAssemblyRenderPlan(plan);
  const estimate=editAssemblyStorageEstimate(assembly,plan.bindings);assertEditFreeSpace(root,estimate.outputBytes*2);let scratchPath:string|undefined;
  const permission=access,disk=editWorkspaceGuard(root,()=>[directory,...(scratchPath?[scratchPath]:[])]);access=async()=>{disk();await permission();};
  if(soundRuntimeRevision()!==plan.engineVersion)editFail("Restore the recorded assembly runtime before verifying this export.");
  await withEditSourceAccess(access,signal,async active=>{
    for(const file of result.files){await access();const actual=await soundDigest(local(root,file.path),active);if(actual.sha256!==file.sha256||actual.bytes!==file.bytes)editFail("A retained assembly artifact failed checksum verification.");}
    if(contentHash(json(local(root,output.manifestPath)))!==contentHash(manifest(result))||contentHash(json(join(directory,"conform/assembly.json")))!==contentHash(assembly)||contentHash(json(join(directory,"conform/timeline.json")))!==contentHash(assembly.parent.timeline)||contentHash(json(join(directory,"conform/conform.json")))!==contentHash(result.conform))editFail("Assembly provenance no longer matches its checkpoint.");
    const playlist=readFileSync(local(root,output.hlsPlaylistPath),"utf8"),segments=playlist.split(/\r?\n/).map(value=>value.trim()).filter(value=>value&&!value.startsWith("#")),hlsPrefix=output.hlsPlaylistPath.slice(0,-"index.m3u8".length),ownedSegments=result.files.filter(file=>file.path.startsWith(hlsPrefix)&&file.path.endsWith(".ts")).map(file=>file.path.slice(hlsPrefix.length)).sort();
    if(!playlist.startsWith("#EXTM3U")||!playlist.includes("#EXT-X-ENDLIST")||!segments.length||segments.some(value=>!/^segment-\d{3,5}\.ts$/.test(value))||new Set(segments).size!==segments.length||contentHash(segments.slice().sort())!==contentHash(ownedSegments))editFail("The assembly HLS playlist changed its owned segments.");
    await verifyPreparedEditSources(result.prepared,root,join(directory,"sources"),access,active);
    const scratch=mkdtempSync(join(root,".assembly-verify-"));scratchPath=scratch;try{
      const rebuilt=await conformEditAssembly(assembly,result.prepared.sources.map(source=>source.media),root,join(scratch,"conform"),access,active);
      if(contentHash(rebuilt)!==contentHash(result.conform))editFail("The assembly checkpoint does not reproduce its original frames or samples.");
      const exported=result.files.find(file=>file.path===output.mp4Path)!;if((await soundDigest(join(scratch,"conform/export.mp4"),active)).sha256!==exported.sha256)editFail("The assembly delivery differs from its reproduced conform.");
      for(const [index,part]of result.conform.picture.picture.parts.entries()){const hashes=await editFrameHashes(join(directory,"conform",part.file),part.frames,join(scratch,"part-"+index+"-frames.txt"),scratch,access,active);if(contentHash(hashes)!==contentHash(rebuilt.picture.pictureFrames.slice(part.at,part.at+part.frames)))editFail("An assembly master part differs from its reproduced conform.");}
    }finally{remove(root,scratch);}
  });
}
