import {createHash} from "node:crypto";
import type {Project,PersistedProject} from "../../api/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {editConformRecipe,type EditAssemblyConformReport} from "../../generator/src/edit-conform";
import {editPictureRecipe,pictureSpans,editPictureSpanClips,editPictureTransform} from "../../generator/src/edit-picture";
import {validatePreparedEditSources,type PreparedEditSources} from "../../generator/src/edit-source-media";
import {editAssemblyVtt} from "../../generator/src/edit-assembly-captions";
import {validateEditBinding,editRenderReview,type EditSourceBinding} from "./edit-jobs";
import {assertEditOriginalPermission} from "./edit-sources";
import {validateEditAssemblyPlan} from "./edit-assembly-clock";
import {validateEditAssemblyLibrary,type AcceptedEditAssembly} from "./edit-assembly-proposals";
import {reviewEditAssembly} from "./edit-assembly-review";
import {reviewEditAssemblyBoundaries} from "./edit-assembly-boundaries";
import {editAssemblyStorageEstimate,assertEditAssemblyStorageEstimate} from "./edit-assembly-resources";
import {EDIT_STORAGE_LIMITS} from "./edit-resources";
import {EditTime} from "./edit-time";
import {editFail,editId,editNumber,editSpeechCuts,editUnmeasuredCuts,editCrossfadeReview} from "./edit-timeline";
import type {EditAssemblyPlan} from "./edit-assembly-types";
import type {RenderFile} from "./shot-reuse";
import {exportSidecarProblem,type ProvenanceCredentials} from "./provenance";

export interface EditAssemblyRenderReview {
  assemblyRevision:string;planRevision:string;rangeReviewRevision:string;boundariesRevision:string;
  parentReviewRevision:string;sourceBindingsRevision:string;resourcesRevision:string;accepted:true;
}
export interface EditAssemblyRenderPlan {
  schema:"hv-edit-assembly-render-plan/1";assembly:AcceptedEditAssembly;bindings:EditSourceBinding[];
  engineVersion:string;storage:"local"|"s3";requestHash:string;review:EditAssemblyRenderReview;revision:string;
}
export interface EditAssemblyOutput {
  schema:"hv-edit-assembly-output/1";plan:EditAssemblyRenderPlan;prepared:PreparedEditSources;
  conform:EditAssemblyConformReport;
  /** HV-031-17: the export's content-credential block, absent only on records made before it. */
  credentials?:ProvenanceCredentials;files:RenderFile[];revision:string;
}
/** HV-031-17: `c2paPath` is the signed sidecar beside `manifestPath`, present only when the host holds a key. */
export interface EditAssemblyOutputEnvelope {mp4Path:string;hlsPlaylistPath:string;captionsPath:string;manifestPath:string;c2paPath?:string;assembly:EditAssemblyOutput}
/** The assembly's own record, as `provenance.json` holds it. */
export function editAssemblyRecord(result:Omit<EditAssemblyOutput,"files"|"revision">){return {schema:"hv-edit-assembly-result/1",plan:result.plan,prepared:result.prepared,conform:result.conform,...(result.credentials?{credentials:result.credentials}:{})};}
/** JSONB may reorder object keys; owned assembly manifests use deterministic bytes before hashing. */
export function editAssemblyJson(value:unknown):string {
  const ordered=(item:unknown):unknown=>Array.isArray(item)?item.map(ordered):item!==null&&typeof item==="object"?Object.fromEntries(Object.entries(item).sort(([a],[b])=>a<b?-1:a>b?1:0).map(([key,value])=>[key,ordered(value)])):item;
  return JSON.stringify(ordered(value),null,2)+"\n";
}
export interface EditAssemblyOutputJob {id:string;projectId:string;assemblyEdit?:EditAssemblyRenderPlan}
const same=(a:unknown,b:unknown)=>contentHash(a)===contentHash(b);
const sha=(text:string)=>createHash("sha256").update(text).digest("hex");
function hash(value:unknown):void {if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))editFail("Retain a complete assembly render revision.");}
function exact(value:unknown,keys:string[]):void {
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))editFail("Use only the supported assembly render fields.");
}
/** Inspect descriptors before hashes or JSON can erase unsupported values or execute accessors. */
function portable(value:unknown,limit:number):void {
  const active=new Set<object>();const visit=(item:unknown,depth:number):void=>{
    if(item===null||typeof item==="string"||typeof item==="boolean")return;
    if(typeof item==="number"){if(!Number.isFinite(item)||Object.is(item,-0))editFail("Retain finite assembly render numbers.");return;}
    if(typeof item!=="object"||depth>128||active.has(item))editFail("Retain portable, non-cyclic assembly render metadata.");
    const array=Array.isArray(item),prototype=Object.getPrototypeOf(item);if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)editFail("Retain plain assembly render records.");
    active.add(item);const keys=Reflect.ownKeys(item);if(array&&keys.length!==item.length+1)editFail("Retain dense assembly render arrays.");
    for(const key of keys){if(array&&key==="length")continue;const descriptor=Object.getOwnPropertyDescriptor(item,key)!;
      if(typeof key!=="string"||!descriptor.enumerable||!Object.hasOwn(descriptor,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=item.length))editFail("Retain plain enumerable assembly render values.");visit(descriptor.value,depth+1);}
    active.delete(item);
  };visit(value,0);if(Buffer.byteLength(JSON.stringify(value),"utf8")>limit)editFail("The assembly render metadata exceeds its capacity.");
}
function unchanged(value:{revision:string}):void {hash(value.revision);const {revision,...data}=value;if(revision!==contentHash(data))editFail("The assembly render receipt changed after sealing.");}
function accepted(value:AcceptedEditAssembly):EditAssemblyPlan {
  // Reuse the canonical acceptance validator with its required original proposal, without changing any parent or range.
  const proposal={id:value.proposalId,label:value.label,purpose:value.purpose,createdAt:value.proposalCreatedAt,plan:value.plan,revision:value.proposalRevision};
  const data={schema:"hv-edit-assembly-library/1" as const,version:1,proposals:[proposal],assemblies:[value]};
  validateEditAssemblyLibrary({...data,revision:contentHash(data)});return validateEditAssemblyPlan(value.plan);
}
function originals(plan:EditAssemblyPlan,bindings:EditSourceBinding[],now?:number):void {
  if(!Array.isArray(bindings)||bindings.length!==plan.parent.sourceReceipts.length)editFail("Retain every original assembly source binding in parent order.");
  for(const [i,expected]of plan.parent.sourceReceipts.entries()){
    const binding=validateEditBinding(bindings[i]!,now);
    if(binding.source.facts.id!==expected.sourceId||binding.source.revision!==expected.receiptRevision||!same(binding.source.facts,plan.parent.timeline.sources[i]))editFail("The assembly render changed its original source or measured facts.");
  }
  if(new Set(bindings.map(binding=>binding.owner.projectId)).size!==1)editFail("Assembly source carriers must belong to one project.");
}
function review(assembly:AcceptedEditAssembly,bindings:EditSourceBinding[]):EditAssemblyRenderReview {
  const plan=assembly.plan;return {assemblyRevision:assembly.revision,planRevision:plan.revision,
    rangeReviewRevision:reviewEditAssembly(plan,assembly.purpose).revision,boundariesRevision:reviewEditAssemblyBoundaries(plan).revision,
    parentReviewRevision:contentHash(editRenderReview(plan.parent.timeline)),sourceBindingsRevision:contentHash(bindings.map(binding=>binding.revision)),
    resourcesRevision:contentHash(editAssemblyStorageEstimate(plan,bindings)),accepted:true};
}
/** Carrier identity and capacity are part of the exact review, even when retained ranges omit their media. */
export function editAssemblyRenderReview(assembly:AcceptedEditAssembly,bindings:EditSourceBinding[]):EditAssemblyRenderReview {
  portable({assembly,bindings},96*1024**2);const plan=accepted(assembly);originals(plan,bindings);return review(assembly,bindings);
}
export function createEditAssemblyRenderPlan(assembly:AcceptedEditAssembly,bindings:EditSourceBinding[],engineVersion:string,storage:EditAssemblyRenderPlan["storage"],requestHash:string,reviewed:EditAssemblyRenderReview,now=Date.now()):EditAssemblyRenderPlan {
  const data={schema:"hv-edit-assembly-render-plan/1" as const,assembly,bindings,engineVersion,storage,requestHash,review:reviewed};portable(data,96*1024**2);
  const plan={...data,revision:contentHash(data)};validateEditAssemblyRenderPlan(plan,now);return structuredClone(plan);
}
/** Without now this validates retained historical evidence; live admission additionally checks leases and capacity. */
export function validateEditAssemblyRenderPlan(plan:EditAssemblyRenderPlan,now?:number):EditAssemblyPlan {
  portable(plan,96*1024**2);exact(plan,["schema","assembly","bindings","engineVersion","storage","requestHash","review","revision"]);
  if(now!==undefined)editNumber(now,0,8_640_000_000_000_000,"Assembly render time");
  if(plan.schema!=="hv-edit-assembly-render-plan/1"||typeof plan.engineVersion!=="string"||!/^ffmpeg-sound-[a-f0-9]{64}$/.test(plan.engineVersion)||!["local","s3"].includes(plan.storage))editFail("Retain a supported assembly render runtime and storage.");
  const inner=accepted(plan.assembly);originals(inner,plan.bindings,now);hash(plan.requestHash);
  if(!same(plan.review,review(plan.assembly,plan.bindings)))editFail("Review the current assembly ranges, boundaries, parent edits, source carriers and capacity before rendering.");
  unchanged(plan);if(now!==undefined)assertEditAssemblyStorageEstimate(editAssemblyStorageEstimate(inner,plan.bindings));return inner;
}
export function assertEditAssemblyPermission(plan:EditAssemblyRenderPlan,project:Project|PersistedProject|undefined|null,now=Date.now()):void {
  // A checkpoint retains originals independently of its earlier carriers; only admission checks those leases.
  validateEditAssemblyRenderPlan(plan);for(const binding of plan.bindings)assertEditOriginalPermission(binding.source,project,now);
}
function owned(file:RenderFile,job:EditAssemblyOutputJob):void {
  exact(file,["path","bytes","sha256"]);hash(file.sha256);editNumber(file.bytes,1,8*1024**3,"Assembly artifact bytes");
  if(typeof file.path!=="string"||file.path.length>1024||!file.path.startsWith(job.projectId+"/"+job.id+"/")||!/^[A-Za-z0-9._/-]+$/.test(file.path)||file.path.split("/").some(part=>!part||part==="."||part===".."))editFail("An assembly artifact escaped its owner.");
}
/** Pure checkpoint validation. File checksums and decoded recovery are independently verified by the media layer. */
export function validateEditAssemblyOutput(job:EditAssemblyOutputJob,output:Omit<EditAssemblyOutputEnvelope,"assembly">&{assembly?:EditAssemblyOutput}):void {
  editId(job.id);editId(job.projectId);const plan=job.assemblyEdit;if(!plan)editFail("An assembly export requires its own reviewed render plan.");const inner=validateEditAssemblyRenderPlan(plan),parent=inner.parent.timeline;
  if(plan.bindings.some(binding=>binding.owner.projectId!==job.projectId||binding.owner.jobId===job.id||binding.source.job.id===job.id))editFail("The assembly output changed its isolated job owner.");
  portable(output,256*1024**2);exact(output,["mp4Path","hlsPlaylistPath","captionsPath","manifestPath",...(Object.hasOwn(output,"c2paPath")?["c2paPath"]:[]),"assembly"]);
  const result=output.assembly;if(!result)editFail("An assembly export requires its own media receipt.");exact(result,["schema","plan","prepared","conform",...(Object.hasOwn(result,"credentials")?["credentials"]:[]),"files","revision"]);
  if(result.schema!=="hv-edit-assembly-output/1"||!same(result.plan,plan))editFail("The assembly export differs from its reviewed render plan.");
  const suffix="conform/export.mp4";if(typeof output.mp4Path!=="string"||!output.mp4Path.endsWith(suffix))editFail("The assembly export lost its owned delivery path.");
  const prefix=output.mp4Path.slice(0,-suffix.length);
  if(!prefix.startsWith(job.projectId+"/"+job.id+"/")||prefix===job.projectId+"/"+job.id+"/"||output.captionsPath!==prefix+"conform/captions.vtt"||output.manifestPath!==prefix+"provenance.json"||output.hlsPlaylistPath!==prefix+"conform/hls/index.m3u8")editFail("The assembly export escaped its job.");
  validatePreparedEditSources(result.prepared,prefix+"sources");
  if(result.prepared.engineVersion!==plan.engineVersion||!same(result.prepared.sources.map(source=>source.receipt),plan.bindings.map(binding=>binding.source)))editFail("The assembly export lost its original source preparation.");
  const report=result.conform;exact(report,["schema","plan","engineVersion","recipeRevision","picture","audio","captionsSha256","sourceFiles","rangeReview","boundaryReview","parentSpeechCuts","parentUnmeasuredAudioCuts","parentCrossfades","revision"]);
  const parentRecipeRevision=contentHash(editConformRecipe(parent)),recipeRevision=contentHash({schema:"hv-edit-assembly-media/1",join:inner.join,parent:editConformRecipe(parent),captionTime:"parent-cues-intersect-samples-then-floor-start-ceil-end-ms"});
  if(report.schema!=="hv-edit-assembly-conform/1"||!same(report.plan,inner)||report.engineVersion!==plan.engineVersion||report.recipeRevision!==recipeRevision||!same(report.rangeReview,reviewEditAssembly(inner,"custom"))||!same(report.boundaryReview,reviewEditAssemblyBoundaries(inner))||!same(report.parentSpeechCuts,editSpeechCuts(parent))||!same(report.parentUnmeasuredAudioCuts,editUnmeasuredCuts(parent))||!same(report.parentCrossfades,editCrossfadeReview(parent)))editFail("The assembly conform changed its parent recipe or reviewed cuts.");
  const picture=report.picture;exact(picture,["schema","planRevision","parentTimelineRevision","parentRecipeRevision","frames","picture","pictureFrames","revision"]);
  if(picture.schema!=="hv-edit-assembly-picture/1"||picture.planRevision!==inner.revision||picture.parentTimelineRevision!==parent.revision||picture.parentRecipeRevision!==contentHash(editPictureRecipe(parent))||picture.frames!==inner.frames)editFail("The assembly picture changed its original parent identity.");
  const media=picture.picture;exact(media,["recipe","parts","concatFile","sourceFrameFiles"]);
  if(!same(media.recipe,editPictureRecipe(parent))||media.concatFile!=="picture/index.ffconcat"||!Array.isArray(media.parts))editFail("The assembly picture changed its retained parent recipe.");
  const spans=pictureSpans(parent);let partIndex=0,outputAt=0;
  for(const range of inner.ranges){for(const span of spans){const at=Math.max(range.fromFrame,span.at),end=Math.min(range.toFrame,span.at+span.frames);if(at>=end)continue;
    const part=media.parts[partIndex];exact(part,["file","at","frames","layers"]);const frames=end-at;
    if(part!.file!=="picture/part-"+String(partIndex).padStart(5,"0")+".mkv"||part!.at!==outputAt+at-range.fromFrame||part!.frames!==frames)editFail("Assembly picture parts changed their selected parent windows.");
    const clips=editPictureSpanClips({...span,at,frames},parent.sources,parent),layers=clips.map(clip=>{const time=new EditTime(clip),from=time.frame(at);return {clipId:clip.id,sourceId:clip.sourceId,from,seekSeconds:Math.floor(from/30),filter:editPictureTransform(clip,at,parent),...(clip.timing?{sourceFrames:Array.from({length:frames},(_,index)=>time.frame(at+index))}:{})};});
    if(!same(part!.layers,layers))editFail("An assembly picture layer changed its original parent source clock, order or composition.");partIndex++;
  }outputAt+=range.toFrame-range.fromFrame;}
  if(media.parts.length!==partIndex||outputAt!==inner.frames)editFail("Assembly picture parts lost selected frames.");
  const pictureIds=[...new Set(parent.clips.filter(clip=>clip.lane==="picture").map(clip=>clip.sourceId))];
  if(!same(media.sourceFrameFiles,pictureIds.map((sourceId,index)=>({sourceId,file:"picture/source-"+index+"-frames.txt"}))))editFail("The assembly lost original picture frame evidence.");
  if(!Array.isArray(picture.pictureFrames)||picture.pictureFrames.length!==inner.frames)editFail("The assembly master lost decoded frame evidence.");picture.pictureFrames.forEach(hash);unchanged(picture);
  const audio=report.audio;exact(audio,["schema","planRevision","parentTimelineRevision","parentRecipeRevision","join","frames","peaks","audio","revision"]);
  if(audio.schema!=="hv-edit-assembly-audio/1"||audio.planRevision!==inner.revision||audio.parentTimelineRevision!==parent.revision||audio.parentRecipeRevision!==parentRecipeRevision||audio.join!==inner.join||audio.frames!==inner.frames)editFail("The assembly soundtrack changed its original parent identity.");
  const lanes=["mix","dialogue","narration","music","ambience","effects","final"] as const;exact(audio.audio,[...lanes]);exact(audio.peaks,[...lanes]);
  for(const lane of lanes){hash(audio.audio[lane]);editNumber(audio.peaks[lane],0,8388608,"Assembly sample peak");}unchanged(audio);
  const used=new Map<string,RenderFile>();for(const clip of parent.clips){const source=result.prepared.sources.find(source=>source.media.id===clip.sourceId)!.media,file=clip.lane==="picture"?source.picture:clip.lane==="captions"?undefined:source.audio[clip.lane];if(file)used.set(file.path,file);}
  if(!same(report.sourceFiles,[...used.values()].sort((a,b)=>a.path.localeCompare(b.path))))editFail("The assembly conform lost its complete parent source addresses.");
  const captions=editAssemblyVtt(inner);if(report.captionsSha256!==sha(captions))editFail("The assembly captions changed their selected parent cue clocks.");unchanged(report);
  if(!Array.isArray(result.files)||result.files.length>EDIT_STORAGE_LIMITS.files)editFail("Invalid assembly artifact inventory.");
  const inventory=new Map<string,RenderFile>();let bytes=0;for(const file of result.files){owned(file,job);if(inventory.has(file.path))editFail("Assembly artifact paths must be distinct.");inventory.set(file.path,file);bytes+=file.bytes;}
  if(bytes>EDIT_STORAGE_LIMITS.outputBytes)editFail("The assembly export exceeded its retained-media capacity.");
  const required=new Set<string>(),find=(name:string)=>{const file=inventory.get(prefix+name);if(!file)editFail("The assembly export is missing "+name+".");required.add(file.path);return file;};
  for(const name of ["provenance.json","sources/sources.json","conform/export.mp4","conform/captions.vtt","conform/assembly.json","conform/timeline.json","conform/conform.json","conform/export-frames.txt","conform/export-probe.json","conform/hls/index.m3u8","conform/picture/index.ffconcat"])find(name);
  const textFile=(name:string,text:string)=>{const file=find(name);if(file.sha256!==sha(text)||file.bytes!==Buffer.byteLength(text,"utf8"))editFail("The assembly export changed "+name+".");};
  const jsonFile=(name:string,value:unknown)=>textFile(name,editAssemblyJson(value));
  jsonFile("sources/sources.json",result.prepared);jsonFile("conform/assembly.json",inner);jsonFile("conform/timeline.json",parent);jsonFile("conform/conform.json",report);
  jsonFile("provenance.json",editAssemblyRecord(result));
  // HV-031-17: the record's credentials name this export, and its sidecar when the export is signed.
  const credentialProblem=exportSidecarProblem(output,result.credentials,find("conform/export.mp4").sha256,result.files);if(credentialProblem)editFail(credentialProblem);if(output.c2paPath!==undefined)required.add(output.c2paPath);textFile("conform/captions.vtt",captions);
  textFile("conform/picture/index.ffconcat","ffconcat version 1.0\n"+media.parts.map(part=>`file '${part.file.slice("picture/".length)}'\nduration ${part.frames/30}\n`).join(""));
  for(const source of result.prepared.sources)for(const file of [...source.copies.map(copy=>copy.copy),...Object.values(source.media.audio)]){if(!same(inventory.get(file.path),file))editFail("The assembly export changed a retained original or canonical waveform.");required.add(file.path);}
  for(const lane of lanes){const file=find("conform/audio/"+lane+".wav");if(file.sha256!==audio.audio[lane]||file.bytes!==44+inner.frames*1600*6)editFail("An assembly sound lane changed its waveform or child duration.");}
  for(const part of media.parts)find("conform/"+part.file);for(const file of media.sourceFrameFiles)find("conform/"+file.file);for(const [index]of pictureIds.entries())find("conform/source-"+index+"-probe.json");
  const extra=result.files.filter(file=>!required.has(file.path));if(!extra.length||extra.some(file=>!file.path.startsWith(prefix)||!/^conform\/hls\/segment-\d{3,5}\.ts$/.test(file.path.slice(prefix.length))))editFail("The assembly export contains missing or unexpected delivery artifacts.");
  unchanged(result);
}
