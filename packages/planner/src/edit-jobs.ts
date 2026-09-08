import type {Job,JobInput} from "../../queue/src/index";
import type {Project,PersistedProject} from "../../api/src/index";
import type {RenderFile} from "./shot-reuse";
import type {EditSequence} from "./edit-library";
import {editHistoryReplay,editHistoryState} from "./edit-history";
import {editFail,editId,editNumber,editRecord,editSpeechCuts,editUnmeasuredCuts,editCrossfadeReview,type EditTimeline} from "./edit-timeline";
import {assertEditOriginalPermission,assertEditSourceAvailable,editSourceOutputRevision,validateEditSourceReceipt,type EditSourceReceipt} from "./edit-sources";
import type {PreparedEditSources} from "../../generator/src/edit-source-media";
import {validatePreparedEditSources} from "../../generator/src/edit-source-media";
import {editConformRecipe,type EditConformReport} from "../../generator/src/edit-conform";
import {editPictureRecipe,pictureSpans,editPictureSpanClips,editPictureTransform} from "../../generator/src/edit-picture";
import {editRenderClips} from "./edit-transition-render";
import {EditTime} from "./edit-time";
import {contentHash} from "../../generator/src/capabilities";
import {soundBaseDialogue} from "./sound-jobs";
import {dialogueReportAuditions} from "./dialogue-replacement";
import {editStorageEstimate,assertEditStorageEstimate,EDIT_STORAGE_LIMITS} from "./edit-resources";

export interface EditMediaOwner {projectId:string;jobId:string;outputRevision:string;completedAt:string;linkExpiresAt:string}
export interface EditSourceBinding {schema:"hv-edit-binding/1";source:EditSourceReceipt;owner:EditMediaOwner;files:RenderFile[];revision:string}
export interface EditRenderReview {timelineRevision:string;speechCutsRevision:string;unmeasuredCutsRevision:string;crossfadesRevision?:string;accepted:boolean}
export interface EditPlan {schema:"hv-edit-plan/1";sequence:EditSequence;bindings:EditSourceBinding[];engineVersion:string;storage:"local"|"s3";requestHash:string;review:EditRenderReview;revision:string}
export interface EditOutput {schema:"hv-edit-output/1";plan:EditPlan;prepared:PreparedEditSources;conform:EditConformReport;files:RenderFile[];revision:string}
const same=(a:unknown,b:unknown)=>contentHash(a)===contentHash(b);
function hash(value:unknown):void {if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))editFail("Retain a valid editorial revision.");}
function date(value:unknown):number {if(typeof value!=="string"||!Number.isFinite(Date.parse(value)))editFail("Retain a valid editorial media date.");return Date.parse(value);}
function owned(file:RenderFile,owner:Pick<EditMediaOwner,"projectId"|"jobId">):void {
  editRecord(file,["path","bytes","sha256"]);hash(file.sha256);editNumber(file.bytes,1,8*1024**3,"Editorial artifact bytes");
  if(typeof file.path!=="string"||file.path.length>1024||!file.path.startsWith(owner.projectId+"/"+owner.jobId+"/")||!/^[A-Za-z0-9._/-]+$/.test(file.path)||file.path.split("/").some(p=>!p||p==="."||p===".."))editFail("An editorial artifact escaped its owner.");
}
export function validateEditBinding(binding:EditSourceBinding,now?:number):EditSourceBinding {
  editRecord(binding,["schema","source","owner","files","revision"]);validateEditSourceReceipt(binding.source);const owner=binding.owner;editRecord(owner,["projectId","jobId","outputRevision","completedAt","linkExpiresAt"]);editId(owner.projectId);editId(owner.jobId);hash(owner.outputRevision);
  if(binding.schema!=="hv-edit-binding/1"||owner.projectId!==binding.source.job.projectId||date(owner.linkExpiresAt)<=date(owner.completedAt)||now!==undefined&&date(owner.linkExpiresAt)<=now||!Array.isArray(binding.files)||binding.files.length!==binding.source.files.length||new Set(binding.files.map(f=>f.path)).size!==binding.files.length)editFail("The owned editorial source is unavailable or changed.");
  for(const [i,file]of binding.files.entries()){owned(file,owner);const original=binding.source.files[i]!;if(file.bytes!==original.bytes||file.sha256!==original.sha256)editFail("An editorial source copy differs from its original.");}
  const {revision,...data}=binding;if(!same(JSON.parse(JSON.stringify(binding)),binding)||revision!==contentHash(data))editFail("The owned editorial source binding changed.");return structuredClone(binding);
}
export function bindOriginalEditSource(source:EditSourceReceipt):EditSourceBinding {
  validateEditSourceReceipt(source);const job=source.job,data={schema:"hv-edit-binding/1" as const,source:structuredClone(source),owner:{projectId:job.projectId,jobId:job.id,outputRevision:editSourceOutputRevision(job),completedAt:job.completedAt!,linkExpiresAt:job.linkExpiresAt!},files:structuredClone(source.files)};
  return validateEditBinding({...data,revision:contentHash(data)});
}
/** A later export carries original files, never another editorial job or a lossy previous picture. */
export function bindRetainedEditSource(job:Job,sourceRevision:string):EditSourceBinding {
  if(job.status!=="done"||!job.output?.editorial)editFail("Choose a completed retained editorial version.");validateEditOutput(job,job.output);
  const retained=job.output.editorial.prepared.sources.find(s=>s.receipt.revision===sourceRevision);if(!retained)editFail("That editorial version does not retain this original source.");
  const data={schema:"hv-edit-binding/1" as const,source:structuredClone(retained.receipt),owner:{projectId:job.projectId,jobId:job.id,outputRevision:contentHash(job.output),completedAt:job.completedAt!,linkExpiresAt:job.linkExpiresAt!},files:retained.copies.map(c=>c.copy)};
  return validateEditBinding({...data,revision:contentHash(data)});
}
export function assertEditBindingAvailable(binding:EditSourceBinding,current:Job|undefined,now=Date.now()):void {
  validateEditBinding(binding,now);const owner=binding.owner;
  if(!current||current.id!==owner.jobId||current.projectId!==owner.projectId||current.status!=="done"||!(current.output||current.graphicOutput)||editSourceOutputRevision(current)!==owner.outputRevision||current.completedAt!==owner.completedAt||current.linkExpiresAt!==owner.linkExpiresAt)editFail("An editorial source carrier changed or expired. Review available versions again.");
  if(!current.pictureEdit)assertEditSourceAvailable(binding.source,current,now);
  const expected=current.pictureEdit?bindRetainedEditSource(current,binding.source.revision):bindOriginalEditSource(binding.source);
  if(!same(expected,binding)||!current.pictureEdit&&(current.id!==binding.source.job.id||!same(current.lipSyncReviews??null,binding.source.job.lipSyncReviews??null)))editFail("The editorial source no longer matches its retained carrier.");
}
export function editRenderReview(timeline:EditTimeline):EditRenderReview {return {timelineRevision:timeline.revision,speechCutsRevision:contentHash(editSpeechCuts(timeline)),unmeasuredCutsRevision:contentHash(editUnmeasuredCuts(timeline)),...(timeline.transitions?.length?{crossfadesRevision:contentHash(editCrossfadeReview(timeline))}:{}),accepted:true};}
export function editCaptionLanguage(plan:EditPlan):string {
  const {timeline}=editHistoryState(plan.sequence.history),ids=new Set(timeline.clips.filter(c=>c.lane==="captions").map(c=>c.sourceId)),languages=[...new Set(plan.bindings.filter(b=>ids.has(b.source.facts.id)).map(b=>b.source.language))];return languages.length===1?languages[0]!:"mul";
}
/** Preserve the accounting lineage of every retained original, including unused handles. */
export function editPerformanceReceipts(plan:EditPlan){
  const bases=plan.bindings.map(b=>b.source.job.soundMix?.source.base??b.source.job),auditions=bases.flatMap(base=>{const report=soundBaseDialogue(base);return report?dialogueReportAuditions(report).flatMap(line=>line.audition?[line.audition.source]:[]):[];}),passes=bases.flatMap(base=>base.output?.lipSync?.report.history??[]);
  const unique=<T extends {jobId:string;revision:string}>(values:T[])=>{const map=new Map<string,T>();for(const value of values){const previous=map.get(value.jobId);if(previous&&previous.revision!==value.revision)editFail("An editorial source changed its original performance receipt.");map.set(value.jobId,value);}return [...map.values()];};
  return {auditions:unique(auditions),lipSync:unique(passes)};
}
export function createEditPlan(sequence:EditSequence,bindings:EditSourceBinding[],engineVersion:string,storage:EditPlan["storage"],requestHash:string,review:EditRenderReview,now=Date.now()):EditPlan {
  const data={schema:"hv-edit-plan/1" as const,sequence:structuredClone(sequence),bindings:structuredClone(bindings),engineVersion,storage,requestHash,review:structuredClone(review)},plan={...data,revision:contentHash(data)};validateEditPlan(plan,now);return plan;
}
export function validateEditPlan(plan:EditPlan,now?:number):EditTimeline {
  editRecord(plan,["schema","sequence","bindings","engineVersion","storage","requestHash","review","revision"]);const sequence=plan.sequence;editRecord(sequence,["id","label","createdAt","sourceRevisions","history"]);editId(sequence.id);date(sequence.createdAt);
  if(typeof sequence.label!=="string"||!sequence.label.trim()||sequence.label.length>160||sequence.history.id!==sequence.id)editFail("Retain a named editorial sequence.");
  const {state:{timeline},catalog,receipts}=editHistoryReplay(sequence.history);
  if(plan.schema!=="hv-edit-plan/1"||!/^ffmpeg-sound-[a-f0-9]{64}$/.test(plan.engineVersion)||!["local","s3"].includes(plan.storage)||!Array.isArray(plan.bindings)||plan.bindings.length!==catalog.length||!Array.isArray(sequence.sourceRevisions)||sequence.sourceRevisions.length!==catalog.length||JSON.stringify(plan).length>96*1024**2)editFail("The editorial render plan changed or exceeds its metadata limit.");
  for(const [i,source]of catalog.entries()){const binding=validateEditBinding(plan.bindings[i]!,now);if(sequence.sourceRevisions[i]!==binding.source.revision||receipts[source.id]&&receipts[source.id]!==binding.source.revision||!same(source,binding.source.facts))editFail("The editorial plan changed an original source or its measured facts.");}
  if(new Set(plan.bindings.map(b=>b.owner.projectId)).size!==1||!same(plan.review,editRenderReview(timeline)))editFail("Review the current speech cuts and unmeasured audio before rendering.");hash(plan.requestHash);const {revision,...data}=plan;if(revision!==contentHash(data))editFail("The editorial plan changed after review.");if(now!==undefined)assertEditStorageEstimate(editStorageEstimate(timeline,plan.bindings));return timeline;
}
export function assertEditPermission(plan:EditPlan,project:Project|PersistedProject|undefined|null,now=Date.now()):void {validateEditPlan(plan);for(const binding of plan.bindings)assertEditOriginalPermission(binding.source,project,now);}
export function assertEditIdempotency(existing:Job|undefined,input:JobInput):void {
  if(existing&&(existing.pictureEdit||input.pictureEdit||existing.stage==="picture-edit"||input.stage==="picture-edit")&&(existing.stage!==input.stage||existing.pictureEdit?.revision!==input.pictureEdit?.revision))editFail("This key belongs to a different editorial plan. Use a new key for another export.");
}
export function validateEditJob(job:Job|JobInput,now?:number):void {
  if((job.stage==="picture-edit")!==Boolean(job.pictureEdit))editFail("An editorial render requires its own reviewed timeline.");
  if(!job.pictureEdit){if(job.editCheckpoint||job.output?.editorial)editFail("A different job cannot carry editorial media.");return;}
  const plan=job.pictureEdit,timeline=validateEditPlan(plan,now),origin=plan.bindings[0]!.source.job;
  if(job.projectId!==origin.projectId||plan.bindings.some(b=>b.owner.jobId===job.id||b.source.job.id===job.id)||job.scriptText!==origin.scriptText||job.scriptVersion!==origin.scriptVersion||job.totalFrames!==timeline.frames||!job.rightsAttestedAt||job.costCapUsd!==0||job.budgetReservedUsd!==0||job.providerPlan||job.providerSpec||job.casting||job.direction||job.shotReuse||job.shotTakes||job.characterSheet||job.dialogueReplacement||job.dialogueCheckpoint||job.audioTake||job.audioCheckpoint||job.audioOutput||job.lipSync||job.lipSyncPrepared||job.lipSyncCheckpoint||job.lipSyncReviews||job.soundMix||job.soundCheckpoint||job.animaticJobId||job.animaticApprovedAt)editFail("Invalid isolated editorial job context.");
}
export function validateEditOutput(job:Job|JobInput,output:NonNullable<Job["output"]>):void {
  validateEditJob(job);editRecord(output,["mp4Path","hlsPlaylistPath","captionsPath","manifestPath","editorial"]);const plan=job.pictureEdit!,timeline=validateEditPlan(plan),result=output.editorial!;editRecord(result,["schema","plan","prepared","conform","files","revision"]);
  if(result.schema!=="hv-edit-output/1"||!same(result.plan,plan))editFail("The editorial export differs from its reviewed plan.");
  const suffix="conform/export.mp4",prefix=output.mp4Path.slice(0,-suffix.length);if(!prefix.startsWith(job.projectId+"/"+job.id+"/")||output.mp4Path!==prefix+suffix||output.captionsPath!==prefix+"conform/captions.vtt"||output.manifestPath!==prefix+"provenance.json"||output.hlsPlaylistPath!==prefix+"conform/hls/index.m3u8")editFail("The editorial export escaped its job.");
  validatePreparedEditSources(result.prepared,prefix+"sources");
  if(result.prepared.engineVersion!==plan.engineVersion||!same(result.prepared.sources.map(s=>s.receipt),plan.bindings.map(b=>b.source)))editFail("The editorial export lost original source preparation.");
  const report=result.conform;if(report.schema!=="hv-edit-conform-result/1"||report.engineVersion!==plan.engineVersion||report.timelineRevision!==timeline.revision||report.recipeRevision!==contentHash(editConformRecipe(timeline))||!same(report.speechCuts,editSpeechCuts(timeline))||!same(report.unmeasuredAudioCuts,editUnmeasuredCuts(timeline))||!same(report.crossfades??null,timeline.transitions?.length?editCrossfadeReview(timeline):null)||!timeline.transitions?.length&&Object.hasOwn(report,"crossfades"))editFail("The editorial conform changed its admitted timeline.");
  editRecord(report,["schema","timelineRevision","engineVersion","recipeRevision","picture","pictureFrames","peaks","audio","captionsSha256","sourceFiles","speechCuts","unmeasuredAudioCuts","crossfades"]);
  const renderedClips=editRenderClips(timeline);if(timeline.transitions?.length||timeline.sources.some(s=>s.media==="graphic-rgba")){const expected=pictureSpans(timeline);if(!Array.isArray(report.picture?.parts)||report.picture.parts.length!==expected.length)editFail('The crossfade picture spans changed.');for(const [i,span]of expected.entries()){const part=report.picture.parts[i]!,clips=editPictureSpanClips(span,timeline.sources);if(part.at!==span.at||part.frames!==span.frames||!Array.isArray(part.layers)||part.layers.length!==clips.length||clips.some((c,j)=>part.layers[j]!.clipId!==c.id||part.layers[j]!.filter!==editPictureTransform(c,span.at,timeline)))editFail('The crossfade composition changed its saved layers or blend.');}}
  editRecord(report.picture,["recipe","parts","concatFile","sourceFrameFiles"]);if(!same(report.picture.recipe,editPictureRecipe(timeline))||report.picture.concatFile!=="picture/index.ffconcat"||!Array.isArray(report.picture.parts)||report.picture.parts.length>2400+(timeline.transitions?.length??0)*2||!Array.isArray(report.picture.sourceFrameFiles))editFail("Invalid editorial picture recipe or parts.");
  let cursor=0;for(const [i,part]of report.picture.parts.entries()){editRecord(part,["file","at","frames","layers"]);editNumber(part.frames,1,60,"Editorial part frames");if(part.file!=="picture/part-"+String(i).padStart(5,"0")+".mkv"||part.at!==cursor||!Array.isArray(part.layers)||part.layers.length>256)editFail("Editorial picture parts changed their timeline.");cursor+=part.frames;for(const layer of part.layers){editRecord(layer,["clipId","sourceId","from","seekSeconds","filter","sourceFrames"]);const clip=renderedClips.find(c=>c.id===layer.clipId&&c.lane==="picture");if(!clip||layer.sourceId!==clip.sourceId||part.at<clip.at||part.at+part.frames>clip.at+clip.frames||layer.from!==new EditTime(clip).frame(part.at)||!same(layer.sourceFrames??null,clip.timing?Array.from({length:part.frames},(_,i)=>new EditTime(clip).frame(part.at+i)):null)||!clip.timing&&Object.hasOwn(layer,"sourceFrames")||layer.seekSeconds!==Math.floor(layer.from/30)||typeof layer.filter!=="string"||layer.filter.length>4000)editFail("An editorial picture layer changed its source.");}}
  if(cursor!==timeline.frames)editFail("Editorial picture parts lost frames.");const pictureIds=[...new Set(timeline.clips.filter(c=>c.lane==="picture").map(c=>c.sourceId))];if(!same(report.picture.sourceFrameFiles,pictureIds.map((sourceId,i)=>({sourceId,file:"picture/source-"+i+"-frames.txt"}))))editFail("Editorial picture source evidence changed.");
  const used=new Map<string,RenderFile>();for(const clip of timeline.clips){const media=result.prepared.sources.find(s=>s.media.id===clip.sourceId)!.media,file=clip.lane==="picture"?media.picture:clip.lane==="captions"?undefined:media.audio[clip.lane];if(file)used.set(file.path,file);}if(!same(report.sourceFiles,[...used.values()].sort((a,b)=>a.path.localeCompare(b.path))))editFail("The conform lost its original source addresses.");
  if(!Array.isArray(result.files)||result.files.length>EDIT_STORAGE_LIMITS.files||new Set(result.files.map(f=>f.path)).size!==result.files.length)editFail("Invalid editorial artifact inventory.");result.files.forEach(f=>owned(f,{projectId:job.projectId,jobId:job.id}));if(result.files.reduce((n,f)=>n+f.bytes,0)>EDIT_STORAGE_LIMITS.outputBytes)editFail("The editorial export exceeded its retained-media capacity.");
  const required=new Set<string>(),find=(name:string)=>{const f=result.files.find(f=>f.path===prefix+name);if(!f)editFail("The editorial export is missing "+name+".");required.add(f.path);return f;};
  for(const name of ["provenance.json","sources/sources.json","conform/export.mp4","conform/captions.vtt","conform/timeline.json","conform/conform.json","conform/export-frames.txt","conform/export-probe.json","conform/hls/index.m3u8","conform/picture/index.ffconcat"])find(name);
  for(const source of result.prepared.sources)for(const expected of [...source.copies.map(c=>c.copy),...Object.values(source.media.audio)]){if(!result.files.some(f=>same(f,expected)))editFail("The editorial export changed retained source media.");required.add(expected.path);}
  if(!Array.isArray(report.pictureFrames)||report.pictureFrames.length!==timeline.frames)editFail("The editorial master lost decoded frame evidence.");report.pictureFrames.forEach(hash);hash(report.captionsSha256);
  const audioLanes=["mix","dialogue","narration","music","ambience","effects","final"] as const;editRecord(report.audio,[...audioLanes]);editRecord(report.peaks,[...audioLanes]);for(const lane of audioLanes){hash(report.audio[lane]);editNumber(report.peaks[lane],0,8388608,"Editorial sample peak");const file=find("conform/audio/"+lane+".wav");if(file.sha256!==report.audio[lane]||file.bytes!==44+timeline.frames*1600*6)editFail("An editorial sound lane changed.");}
  if(find("conform/captions.vtt").sha256!==report.captionsSha256)editFail("The editorial caption track changed.");for(const part of report.picture.parts)find("conform/"+part.file);for(const file of report.picture.sourceFrameFiles)find("conform/"+file.file);
  for(const [i]of pictureIds.entries())find("conform/source-"+i+"-probe.json");if(result.files.some(f=>!required.has(f.path)&&!/^conform\/hls\/segment-\d{3,5}\.ts$/.test(f.path.slice(prefix.length))))editFail("The editorial export contains unexpected artifacts.");
  const {revision,...data}=result;if(revision!==contentHash(data))editFail("The editorial output receipt changed.");
}
