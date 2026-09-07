import {existsSync,lstatSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,rmSync,statSync,writeFileSync} from "node:fs";
import {dirname,join,resolve,sep} from "node:path";
import type {Job,JobInput} from "../../queue/src/index";
import type {RenderFile} from "../../planner/src/shot-reuse";
import {validateEditJob,validateEditPlan,validateEditOutput,type EditPlan,type EditOutput} from "../../planner/src/edit-jobs";
import {editFail} from "../../planner/src/edit-timeline";
import {prepareEditSources,verifyPreparedEditSources,withEditSourceAccess} from "./edit-source-media";
import {conformEdit,editFrameHashes} from "./edit-conform";
import type {DialogueArtifactReader} from "./dialogue-replacement";
import {soundDigest} from "./sound-media";
import {soundRuntimeRevision} from "./sound-audio";
import {contentHash} from "./capabilities";
type Access=()=>Promise<void>;
function local(root:string,key:string):string {if(!/^[A-Za-z0-9._/-]+$/.test(key)||key.split("/").some(p=>!p||p==="."||p===".."))editFail("Invalid editorial export path.");const p=resolve(root,key);if(!p.startsWith(root+sep)||!lstatSync(p).isFile()||lstatSync(p).isSymbolicLink()||!realpathSync(p).startsWith(root+sep))editFail("Editorial export media escaped its workspace.");return p;}
function remove(root:string,directory:string):void {if(!directory.startsWith(root+sep)||realpathSync(directory)!==directory)editFail("Editorial verification scratch escaped its workspace.");rmSync(directory,{recursive:true,force:true});}
function manifest(result:Omit<EditOutput,"files"|"revision">){return {schema:"hv-edit-result/1",plan:result.plan,prepared:result.prepared,conform:result.conform};}
/** Map original identities to the current owner's exact copies; receipts never nest another editorial job. */
export function editBindingReader(plan:EditPlan,artifactRoot:string,reader?:DialogueArtifactReader):DialogueArtifactReader {
  validateEditPlan(plan);const root=realpathSync(artifactRoot);
  return {async response(projectId,jobId,key,request){
    const binding=plan.bindings.find(b=>b.source.job.projectId===projectId&&b.source.job.id===jobId),index=binding?.source.files.findIndex(f=>f.path===key)??-1;
    if(!binding||index<0)editFail("Editorial preparation requested unowned source media.");const file=binding.files[index]!;
    if(reader)return reader.response(binding.owner.projectId,binding.owner.jobId,file.path,request);
    return new Response(Bun.file(local(root,file.path)).stream(),{headers:{etag:'"'+file.sha256+'"',"content-length":String(file.bytes)}});
  }};
}
export async function renderEditJob(job:Job|JobInput,artifactRoot:string,destination:string,access:Access,signal?:AbortSignal,reader?:DialogueArtifactReader):Promise<Omit<EditOutput,"files"|"revision">>{
  validateEditJob(job,Date.now());const plan=job.pictureEdit!,timeline=validateEditPlan(plan),root=realpathSync(artifactRoot),directory=resolve(destination),scope=resolve(root,job.projectId,job.id);
  if(!directory.startsWith(scope+sep)||existsSync(directory))editFail("Choose a new owned editorial export destination.");
  if(soundRuntimeRevision()!==plan.engineVersion)editFail("The editorial runtime changed after review.");await access();signal?.throwIfAborted();mkdirSync(directory,{recursive:true});if(realpathSync(directory)!==directory)editFail("The editorial destination escaped its owner.");
  return withEditSourceAccess(access,signal,async active=>{
    const prepared=await prepareEditSources(plan.bindings.map(b=>b.source),root,join(directory,"sources"),access,active,editBindingReader(plan,root,reader));
    const conform=await conformEdit(timeline,prepared.sources.map(s=>s.media),root,join(directory,"conform"),access,active);
    if(soundRuntimeRevision()!==plan.engineVersion)editFail("The editorial runtime changed while rendering.");await access();
    const result={schema:"hv-edit-output/1" as const,plan,prepared,conform};writeFileSync(join(directory,"provenance.json"),JSON.stringify(manifest(result),null,2)+"\n",{flag:"wx"});return result;
  });
}
export async function sealEditJob(job:Job|JobInput,artifactRoot:string,directory:string,result:Omit<EditOutput,"files"|"revision">,signal?:AbortSignal):Promise<NonNullable<Job["output"]>>{
  const root=realpathSync(artifactRoot),target=realpathSync(directory),scope=resolve(root,job.projectId,job.id);if(!target.startsWith(scope+sep))editFail("An editorial export escaped its owner.");const files:RenderFile[]=[];
  async function visit(path:string):Promise<void>{for(const entry of readdirSync(path,{withFileTypes:true})){signal?.throwIfAborted();const next=join(path,entry.name);if(entry.isSymbolicLink())editFail("Editorial artifacts cannot be links.");if(entry.isDirectory())await visit(next);else if(entry.isFile()){if(files.length>=80000)editFail("Editorial artifacts exceeded their inventory limit.");files.push({path:next.slice(root.length+1).split(sep).join("/"),...await soundDigest(next,signal)});}else editFail("Invalid editorial artifact.");}}
  await visit(target);files.sort((a,b)=>a.path.localeCompare(b.path));const prefix=target.slice(root.length+1).split(sep).join("/")+"/",data={...result,files},output={mp4Path:prefix+"conform/export.mp4",hlsPlaylistPath:prefix+"conform/hls/index.m3u8",captionsPath:prefix+"conform/captions.vtt",manifestPath:prefix+"provenance.json",editorial:{...data,revision:contentHash(data)}};
  validateEditOutput(job,output);return output;
}
function json(path:string):unknown {if(statSync(path).size>192*1024**2)editFail("Editorial provenance exceeds its metadata limit.");return JSON.parse(readFileSync(path,"utf8"));}
/** Reproduce source conversions and the full conform before accepting a recovered checkpoint. */
export async function verifyEditMedia(job:Job|JobInput,output:NonNullable<Job["output"]>,artifactRoot:string,access:Access,signal?:AbortSignal):Promise<void>{
  validateEditOutput(job,output);const root=realpathSync(artifactRoot),result=output.editorial!,directory=dirname(local(root,output.manifestPath)),plan=job.pictureEdit!;
  if(soundRuntimeRevision()!==plan.engineVersion)editFail("Restore the recorded editorial runtime before verifying this export.");
  await withEditSourceAccess(access,signal,async active=>{
    for(const file of result.files){await access();const actual=await soundDigest(local(root,file.path),active);if(actual.sha256!==file.sha256||actual.bytes!==file.bytes)editFail("A retained editorial artifact failed checksum verification.");}
    if(contentHash(json(local(root,output.manifestPath)))!==contentHash(manifest(result))||contentHash(json(join(directory,"conform/timeline.json")))!==contentHash(validateEditPlan(plan))||contentHash(json(join(directory,"conform/conform.json")))!==contentHash(result.conform))editFail("The editorial provenance no longer matches its checkpoint.");
    const playlist=readFileSync(local(root,output.hlsPlaylistPath),"utf8"),segments=playlist.split(/\r?\n/).map(s=>s.trim()).filter(s=>s&&!s.startsWith("#")),hlsPrefix=output.hlsPlaylistPath.slice(0,-"index.m3u8".length),ownedSegments=result.files.filter(f=>f.path.startsWith(hlsPrefix)&&f.path.endsWith(".ts")).map(f=>f.path.slice(hlsPrefix.length)).sort();
    if(!playlist.startsWith("#EXTM3U")||!playlist.includes("#EXT-X-ENDLIST")||!segments.length||segments.some(s=>!/^segment-\d{3,5}\.ts$/.test(s))||new Set(segments).size!==segments.length||contentHash(segments.slice().sort())!==contentHash(ownedSegments))editFail("The editorial HLS playlist changed its owned segments.");
    await verifyPreparedEditSources(result.prepared,root,join(directory,"sources"),access,active);
    const scratch=mkdtempSync(join(root,".edit-verify-"));try{
      const rebuilt=await conformEdit(validateEditPlan(plan),result.prepared.sources.map(s=>s.media),root,join(scratch,"conform"),access,active);
      if(contentHash(rebuilt)!==contentHash(result.conform))editFail("The editorial checkpoint does not reproduce its original source frames or samples.");
      const exported=result.files.find(f=>f.path===output.mp4Path)!;if((await soundDigest(join(scratch,"conform/export.mp4"),active)).sha256!==exported.sha256)editFail("The editorial delivery differs from its reproduced conform.");
      for(const [i,part]of result.conform.picture.parts.entries()){const hashes=await editFrameHashes(join(directory,"conform",part.file),part.frames,join(scratch,"part-"+i+"-frames.txt"),scratch,access,active);if(contentHash(hashes)!==contentHash(rebuilt.pictureFrames.slice(part.at,part.at+part.frames)))editFail("An editorial master part differs from its reproduced conform.");}
    }finally{remove(root,scratch);}
  });
}
