import {contentHash} from "../../generator/src/capabilities";
import {validatePictureQcReport,type PictureQcReport} from "./picture-qc";
import {EDIT_FPS,editCaptionCues,editRecord} from "./edit-timeline";
import {editNumber} from "./edit-errors";
import type {Job,JobInput} from "../../queue/src/index";
import {assertEditPermission,validateEditPlan} from "./edit-jobs";
import {assertEditAssemblyPermission} from "./edit-assembly-jobs";
import type {PersistedProject,Project} from "../../api/src/index";
import {deliveryReframePlan,type DeliveryFormat,type DeliveryReframePlan} from "./delivery-reframe";
import {assertMezzanineSource,deliveryMezzaninePlan,mezzanineSource,type DeliveryMezzaninePlan,type MezzanineSource} from "./delivery-mezzanine";
import {deliveryOpenCaptionsPlan,validateDeliveryCaptionCheck,type DeliveryCaptionCheck,type DeliveryCaptionTrack,type DeliveryOpenCaptionsPlan,type OpenCaptionFrame} from "./delivery-captions";
import {editVtt} from "../../generator/src/edit-conform";
import {editAssemblyCaptionCues,editAssemblyVtt} from "../../generator/src/edit-assembly-captions";
import {createHash} from "node:crypto";

/**
 * HV-027: what a finished cut can be delivered as, and what binds a deliverable to the film it was
 * made from.
 *
 * HV-027-01 and HV-027-02 built the two deliverables and both ended the same way: nothing calls
 * them, because a finished job's artifact set is sealed three ways and a deliverable cannot be added
 * to a completed job. A deliverable is therefore a **new job that names the old one**, and naming it
 * is the decision this module makes.
 *
 * What a deliverable is bound to is the sealed output's own revision, not the job id. A job id says
 * which render; the output revision says which *bytes*, over the whole retained file list. If the
 * film is rendered again the revision moves, and a deliverable made from the old one is visibly a
 * deliverable of a different film rather than a stale file with the right name.
 *
 * And every kind is answered, including the ones that cannot be made. An offer list that shows only
 * what is possible reads as though the rest had never been considered — the same reason the quality
 * check carries `notChecked` and the continuity report carries comparison counters.
 */
export const DELIVERY_KINDS=["reframe-9:16","reframe-1:1","mezzanine","open-captions","open-captions-9:16","open-captions-1:1"] as const;
export type DeliveryKind=typeof DELIVERY_KINDS[number];
/** HV-027-15: the kinds that burn the film's own captions into the picture, and the frame each burns into. */
const OPEN_CAPTIONS:Partial<Record<DeliveryKind,OpenCaptionFrame>>={"open-captions":"master","open-captions-9:16":"9:16","open-captions-1:1":"1:1"};
/** Only a conform makes a picture master, and only these two stages make a conform. */
export const DELIVERY_SOURCE_STAGES=["picture-edit","assembly-edit"] as const;
export type DeliverySourceStage=typeof DELIVERY_SOURCE_STAGES[number];
const MASTER_SUFFIX="/conform/export.mp4";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const HASH=/^[a-f0-9]{64}$/;
export interface DeliveryFile {path:string;sha256:string;bytes:number}
export interface DeliveryBinding {
  schema:"hv-delivery-binding/1";
  /** The backend the film is retained on, as every other plan records it and every worker checks it. */
  storage:"local"|"s3";
  source:{projectId:string;jobId:string;stage:DeliverySourceStage;outputRevision:string};
  /** The delivered master, exactly as the sealed output names it. */
  master:DeliveryFile;
  /**
   * **Every file the renderer will read, with its digest**, taken from the sealed inventory: the
   * master, the conform's ffconcat index, its picture parts in order, and the final mix.
   *
   * Named rather than discovered, because nothing in this studio enumerates another job's artifacts
   * under `s3` — every cross-job read goes one declared file at a time through the artifact reader,
   * which checks each file's digest and length as it streams it. A plan that said "the conform
   * directory" would work on a local disk and have nothing to ask for on staging.
   */
  files:DeliveryFile[];
  /** What the conform recorded about its own picture and mix. See `mezzanineSource`. */
  conform:MezzanineSource;
  /**
   * HV-027-15: the film's sealed caption track, and how many cues its cut derives. Present only when
   * the sealed file is byte for byte the track the film's own timeline derives, so the cue count is
   * a fact about that file. A binding made before this, or of a film whose track cannot be tied to
   * its cut, has none, and only the burned kinds are refused for it.
   */
  captions?:DeliveryCaptionTrack;
  revision:string;
}
/** A sealed editorial or assembly output: its revision, and the closed inventory that revision covers. */
export interface SealedOutput {revision:string;files:DeliveryFile[]}
export interface DeliveryOffer {kind:DeliveryKind;available:boolean;reason?:string;plan?:DeliveryJobPlan}
export interface DeliveryJobPlan {
  schema:"hv-delivery-plan/1";kind:DeliveryKind;binding:DeliveryBinding;
  reframe?:DeliveryReframePlan;mezzanine?:DeliveryMezzaninePlan;
  /** HV-027-15: the captions burned into this deliverable's picture, and the frame they are burned into. */
  openCaptions?:DeliveryOpenCaptionsPlan;
  /**
   * What makes two requests the same deliverable: the output's revision and the kind, and nothing
   * else — not the job id, which would make a re-render's identical deliverable a different one, and
   * not a clock. The admission route refuses to make a second job carrying a key it already holds.
   */
  idempotencyKey:string;revision:string;
}
type JobLike=Job|JobInput;
const fail:(message:string)=>never=message=>{throw new Error(message);};
const REFRAME:Record<DeliveryKind,DeliveryFormat|null>={"reframe-9:16":"9:16","reframe-1:1":"1:1",mezzanine:null,
  "open-captions":null,"open-captions-9:16":"9:16","open-captions-1:1":"1:1"};
/**
 * The conform directory is derived from the master's own path rather than carried beside it, because
 * two fields that must agree are two fields that can disagree. Every conform writes its export to
 * `<conform>/export.mp4` — `sealEditJob` and `sealEditAssemblyJob` both do — so a master path that
 * does not end that way is not a master this studio made.
 */
export function deliveryConformDirectory(masterPath:string):string{
  if(!masterPath.endsWith(MASTER_SUFFIX))fail("A deliverable is made from a conform's own master, at conform/export.mp4. This film's master is elsewhere.");
  return masterPath.slice(0,-"/export.mp4".length);
}
/**
 * HV-027-05: how long a deliverable may take, from the film it is made from.
 *
 * A flat allowance is the mistake `editRenderTimeoutMs` was written to fix -- "every editorial job
 * carried a flat 30 minutes… far too little for the fifty-second short". A deliverable costs *more*
 * I/O per frame than the conform it reads: a mezzanine copies the whole lossless picture master,
 * probes it with a full decode, copy-muxes it, hashes its frames, and hashes them again at
 * verification. A reframe decodes once and encodes once.
 *
 * These figures are bounds, not measurements. The first real film will say what they should be, and
 * the bounds are deliberately generous rather than tight.
 */
/**
 * HV-027-06 adds one decode to the seal, for the quality check, and does **not** move these
 * numbers. The per-frame allowance is already 3,000 ms for a mezzanine and 1,500 for a reframe --
 * seconds of wall time per frame, against decodes that run far faster than real time -- and above
 * about 2.6 minutes of film the binding constraint is `maximumMs`, not the per-frame figure at all.
 * Raising a deadline that is already clamped would change nothing except where the clamp bites.
 */
export const DELIVERY_TIMEOUT={baseMs:120_000,mezzaninePerFrameMs:3_000,reframePerFrameMs:1_500,minimumMs:30*60_000,maximumMs:4*60*60_000} as const;
export function deliveryTimeoutMs(kind:DeliveryKind,frames:number):number{
  if(!Number.isInteger(frames)||frames<1)fail("Count this film's frames before giving its deliverable a deadline.");
  const {baseMs,mezzaninePerFrameMs,reframePerFrameMs,minimumMs,maximumMs}=DELIVERY_TIMEOUT;
  return Math.min(maximumMs,Math.max(minimumMs,baseMs+frames*(kind==="mezzanine"?mezzaninePerFrameMs:reframePerFrameMs)));
}
const PART=/^part-\d{5}\.mkv$/;
const file=(value:DeliveryFile|undefined,prefix:string,what:string):DeliveryFile=>{
  if(!value||typeof value.path!=="string"||!value.path.startsWith(prefix)||!/^[A-Za-z0-9._/-]{1,1024}$/.test(value.path)
    ||value.path.split("/").some(segment=>!segment||segment==="."||segment===".."))fail("A deliverable reads "+what+" from inside the film's own job and nowhere else.");
  if(!HASH.test(value.sha256)||!Number.isSafeInteger(value.bytes)||value.bytes<1)fail("Name "+what+"'s bytes and their digest.");
  return {path:value.path,sha256:value.sha256,bytes:value.bytes};
};
export function deliveryBinding(input:Omit<DeliveryBinding,"schema"|"revision">):DeliveryBinding{
  const {storage,source,master,files,conform,captions}=input??{};
  if(!source||!master||!conform||!Array.isArray(files))fail("Name the finished film a deliverable is made from.");
  if(storage!=="local"&&storage!=="s3")fail("Choose the configured storage backend for this film.");
  if(!UUID.test(source.projectId)||!UUID.test(source.jobId))fail("Name the film's project and job.");
  if(!DELIVERY_SOURCE_STAGES.includes(source.stage))fail("Only a picture edit or an assembly makes a master to deliver from.");
  if(!HASH.test(source.outputRevision))fail("Name the sealed output revision this deliverable is made from.");
  const prefix=source.projectId+"/"+source.jobId+"/";
  const checkedMaster=file(master,prefix,"the delivered master");
  const conformDirectory=deliveryConformDirectory(checkedMaster.path);
  // The mezzanine planner is the one place that knows what a conform's own record has to look like.
  // Asking it here means a binding cannot be built around a conform that does not add up, whether or
  // not a mezzanine is the deliverable being asked for.
  const checkedConform=assertMezzanineSource(conform);
  const index=conformDirectory+"/picture/index.ffconcat",mix=conformDirectory+"/audio/final.wav";
  const checked=files.map((value,at)=>file(value,prefix,"file "+at));
  if(new Set(checked.map(value=>value.path)).size!==checked.length)fail("A deliverable names each file it reads once.");
  const byPath=new Map(checked.map(value=>[value.path,value]));
  for(const [path,what] of [[checkedMaster.path,"delivered master"],[index,"picture master's index"],[mix,"final mix"]] as const)
    if(!byPath.has(path))fail("This film's sealed inventory does not contain its "+what+", so nothing can be delivered from it.");
  if(contentHash(byPath.get(checkedMaster.path))!==contentHash(checkedMaster))fail("The delivered master is named twice with different bytes.");
  // The mix's size is arithmetic the conform cannot disagree with, so the inventory is checked
  // against it: a mix of another length means this binding is not describing this film.
  if(byPath.get(mix)!.bytes!==checkedConform.mixBytes)
    fail("This film's final mix is retained as "+byPath.get(mix)!.bytes+" bytes and "+checkedConform.frames+" frames of its sound is "+checkedConform.mixBytes+" bytes.");
  const parts=checked.filter(value=>value.path.startsWith(conformDirectory+"/picture/")&&PART.test(value.path.slice((conformDirectory+"/picture/").length)));
  if(!parts.length)fail("This film's picture master has no retained parts, so no lossless master can be made of it.");
  if(parts.reduce((total,part)=>total+part.bytes,0)!==checkedConform.pictureBytes)
    fail("This film's retained picture parts weigh "+parts.reduce((total,part)=>total+part.bytes,0)+" bytes and the conform recorded "+checkedConform.pictureBytes+".");
  // HV-027-15: a caption track is one of the files this binding already names, at the conform's own
  // path and with the same bytes, or it is not this film's.
  let track:DeliveryCaptionTrack|undefined;
  if(captions!==undefined){
    const named=byPath.get(conformDirectory+"/captions.vtt");
    if(!captions||!named||captions.path!==named.path||captions.sha256!==named.sha256||captions.bytes!==named.bytes)
      fail("This film's caption track is not the one its sealed inventory names.");
    if(!Number.isInteger(captions.cues)||captions.cues<0||captions.cues>4096)fail("Count this film's caption cues.");
    track={path:named.path,sha256:named.sha256,bytes:named.bytes,cues:captions.cues};
  }
  const data={schema:"hv-delivery-binding/1" as const,storage,
    source:{projectId:source.projectId,jobId:source.jobId,stage:source.stage,outputRevision:source.outputRevision},
    master:checkedMaster,files:checked.slice().sort((a,b)=>a.path.localeCompare(b.path,"en-US")),conform:checkedConform,...(track?{captions:track}:{})};
  return {...data,revision:contentHash(data)};
}
/**
 * The binding for a finished job, built from what that job actually sealed.
 *
 * Every digest and size comes from the **sealed inventory**, not from a fresh look at the disk: the
 * inventory is what `editorial.revision` is computed over and what verification reproduces, so a
 * deliverable bound to it is bound to the bytes the job was completed with. A sealed output that
 * names a master its own inventory does not contain is refused here rather than delivered from.
 *
 * The file list is selected here and carried in the binding, rather than discovered by the renderer,
 * because nothing in this studio enumerates another job's artifacts under `s3`.
 */
export function deliveryBindingFor(
  job:{projectId:string;id:string;stage:string},
  output:{mp4Path:string;editorial?:SealedOutput;assembly?:SealedOutput},
  conform:Parameters<typeof mezzanineSource>[0],
  timeline:Parameters<typeof mezzanineSource>[1],
  storage:DeliveryBinding["storage"],
  /** HV-027-15: the caption track the film's own cut derives, to be matched against the sealed one. */
  captions?:{text:string;cues:number},
):DeliveryBinding{
  const stage=job?.stage as DeliverySourceStage;
  if(!DELIVERY_SOURCE_STAGES.includes(stage))fail("Only a picture edit or an assembly makes a master to deliver from.");
  const sealed=stage==="picture-edit"?output?.editorial:output?.assembly;
  if(!sealed?.revision||!Array.isArray(sealed.files))fail("This film has not been sealed, so there is nothing to deliver from it yet.");
  const master=sealed.files.find(value=>value.path===output.mp4Path);
  if(!master)fail("This film's sealed inventory does not contain the master it names. Render it again before delivering from it.");
  const directory=deliveryConformDirectory(master.path),picture=directory+"/picture/";
  const parts=sealed.files.filter(value=>value.path.startsWith(picture)&&PART.test(value.path.slice(picture.length)))
    .sort((a,b)=>a.path.localeCompare(b.path,"en-US"));
  // The conform says how many parts it made. The inventory says which files it kept. A film whose
  // inventory holds a different number of parts than its own record claims is not one to deliver
  // from, and saying which two numbers disagree is more use than a missing file later.
  if(parts.length!==conform?.picture?.parts?.length)
    fail("This film records "+(conform?.picture?.parts?.length??0)+" picture parts and its sealed inventory retains "+parts.length+".");
  // HV-027-15: the sealed caption track is named when it is exactly the one the cut derives.
  const sealedCaptions=sealed.files.find(value=>value.path===directory+"/captions.vtt");
  const tied=Boolean(captions&&sealedCaptions&&createHash("sha256").update(captions.text).digest("hex")===sealedCaptions.sha256);
  const wanted=[master.path,directory+"/picture/index.ffconcat",directory+"/audio/final.wav",...(tied?[sealedCaptions!.path]:[]),...parts.map(part=>part.path)];
  const files=wanted.map(path=>{
    const found=sealed.files.find(value=>value.path===path);
    if(!found)fail("This film's sealed inventory does not contain "+path.slice(directory.length+1)+", so nothing can be delivered from it.");
    return found;
  });
  return deliveryBinding({storage,source:{projectId:job.projectId,jobId:job.id,stage,outputRevision:sealed.revision},
    master:{path:master.path,sha256:master.sha256,bytes:master.bytes},files,
    conform:mezzanineSource(conform,timeline,parts.map(part=>part.bytes)),
    ...(tied?{captions:{path:sealedCaptions!.path,sha256:sealedCaptions!.sha256,bytes:sealedCaptions!.bytes,cues:captions!.cues}}:{})});
}
/**
 * The binding for a finished job, read entirely out of the job's own body.
 *
 * Both facts the binding needs beyond the inventory — what the conform recorded, and the film's
 * dimensions — are already in the sealed output and the admitted plan. Nothing is fetched and no file
 * is opened, so an offer list costs a job read.
 */
export function deliveryBindingForJob(job:Job,storage:DeliveryBinding["storage"]):DeliveryBinding{
  if(!job?.output)fail("This film has not been sealed, so there is nothing to deliver from it yet.");
  if(job.stage==="picture-edit"){
    const conform=job.output.editorial?.conform;
    if(!conform||!job.pictureEdit)fail("This picture edit did not retain the record a deliverable is made from.");
    const timeline=validateEditPlan(job.pictureEdit);
    return deliveryBindingFor(job,job.output,{pictureFrames:conform.pictureFrames,picture:conform.picture},
      {width:timeline.width,height:timeline.height,frames:timeline.frames},storage,{text:editVtt(timeline),cues:editCaptionCues(timeline).length});
  }
  const assembly=job.output.assembly?.conform;
  if(job.stage!=="assembly-edit"||!assembly)fail("Only a picture edit or an assembly makes a master to deliver from.");
  return deliveryBindingFor(job,job.output,{pictureFrames:assembly.picture.pictureFrames,picture:assembly.picture.picture},
    {width:assembly.plan.parent.timeline.width,height:assembly.plan.parent.timeline.height,frames:assembly.plan.frames},storage,
    {text:editAssemblyVtt(assembly.plan),cues:editAssemblyCaptionCues(assembly.plan).length});
}
/** A retained binding is re-derived from its own parts rather than trusted. */
export function validateDeliveryBinding(binding:DeliveryBinding):DeliveryBinding{
  if(!binding||binding.schema!=="hv-delivery-binding/1")fail("Use a delivery binding.");
  const rebuilt=deliveryBinding({storage:binding.storage,source:binding.source,master:binding.master,files:binding.files,conform:binding.conform,
    ...(binding.captions!==undefined?{captions:binding.captions}:{})});
  if(contentHash(rebuilt)!==contentHash(binding))fail("This delivery binding does not match the film it names.");
  return rebuilt;
}
/**
 * The files a delivery of this kind actually opens, out of the inventory it is bound to (HV-027-08).
 *
 * The binding names every file of the sealed conform, for every kind, because nothing enumerates
 * another job's artifacts under `s3` and the binding is made before a kind is chosen. That is right
 * for a *binding* -- it is what this job is bound to -- and wrong for a *copy*: only the mezzanine
 * reads the conform directory. A reframe opens the master and nothing else.
 *
 * `renderDeliveryJob` copied all of them and reserved twice their size before it started, so a 1:1
 * crop of a finished film pulled the whole lossless picture master through the artifact reader,
 * re-digested it, and was refused outright on a host without the headroom -- with the editorial
 * worker's message, for bytes the job never opens.
 */
export function deliveryReadFiles(plan:DeliveryJobPlan):DeliveryFile[]{
  // HV-027-15: a burned deliverable opens the master and the caption track it burns.
  const burned=plan.openCaptions?.captions.path;
  return plan.kind==="mezzanine"?[...plan.binding.files]:plan.binding.files.filter(file=>file.path===plan.binding.master.path||file.path===burned);
}
export function deliveryJobPlan(binding:DeliveryBinding,kind:DeliveryKind):DeliveryJobPlan{
  if(!DELIVERY_KINDS.includes(kind))fail("Choose a deliverable this studio makes: "+DELIVERY_KINDS.join(", ")+".");
  const valid=validateDeliveryBinding(binding),format=REFRAME[kind],frame=OPEN_CAPTIONS[kind];
  const reframe=format?deliveryReframePlan({width:valid.conform.width,height:valid.conform.height,durationSec:valid.conform.frames/EDIT_FPS},format):undefined;
  const data={schema:"hv-delivery-plan/1" as const,kind,binding:valid,
    ...(reframe?{reframe}:frame?{}:{mezzanine:deliveryMezzaninePlan(valid.conform)}),
    // HV-027-15: the captions are burned into the reframe's own frame, after its crop, so they are
    // laid out for the frame that is delivered rather than cropped off the side of the master's.
    ...(frame?{openCaptions:deliveryOpenCaptionsPlan(valid.captions,frame,reframe?reframe.output:{width:valid.conform.width,height:valid.conform.height},reframe?reframe.filter:null)}:{}),
    idempotencyKey:contentHash({schema:"hv-delivery-idempotency/1",outputRevision:valid.source.outputRevision,kind})};
  return {...data,revision:contentHash(data)};
}
/**
 * Every kind, answered.
 *
 * A kind that cannot be made carries the reason the planner that refused it gave, so a creator is
 * told "a 9:16 cut of this master would be 202 by 360, under the 256-pixel minimum" rather than
 * being shown a shorter list and left to guess why.
 */
export function deliveryOffers(binding:DeliveryBinding):DeliveryOffer[]{
  const valid=validateDeliveryBinding(binding);
  return DELIVERY_KINDS.map(kind=>{
    try{return {kind,available:true,plan:deliveryJobPlan(valid,kind)};}
    catch(error){return {kind,available:false,reason:error instanceof Error?error.message:"This deliverable cannot be made from this film."};}
  });
}
/** A retained plan is re-derived from its own binding rather than trusted. */
export function validateDeliveryPlan(plan:DeliveryJobPlan):DeliveryJobPlan{
  if(!plan||plan.schema!=="hv-delivery-plan/1")fail("Use a delivery plan.");
  const rebuilt=deliveryJobPlan(plan.binding,plan.kind);
  if(contentHash(rebuilt)!==contentHash(plan))fail("This delivery plan does not match the film it names.");
  return rebuilt;
}
/**
 * The one file a delivery job writes, so its inventory is closed before the job is made rather than
 * discovered from whatever the renderer happened to leave on disk.
 */
export function deliveryFileName(plan:DeliveryJobPlan):string{
  validateDeliveryPlan(plan);
  return plan.kind==="mezzanine"?"mezzanine.mkv":plan.kind.replace(":","x")+".mp4";
}

/**
 * HV-027-04: the delivery job itself.
 *
 * A delivery job reads a sealed output and writes **one file**. It dispatches no provider, so its
 * cost is zero by construction rather than by policy — the ledger refuses a cost attributed to one,
 * exactly as it does for a graphic.
 */
export interface DeliveryOutput {
  schema:"hv-delivery-output/1";planRevision:string;
  /** The renderer's own result revision, so the output names the run that produced it. */
  resultRevision:string;
  file:{path:string;sha256:string;bytes:number};
  delivered:{width:number;height:number;durationSec:number;video:string;audio:string};
  /**
   * HV-027-06: the quality check HV-026-01 built, run on the file this job delivered.
   *
   * Four increments built a check and nothing measured a delivered file as part of delivering it;
   * HV-027-01 measured its cuts by hand, in a test. The report is retained beside the deliverable
   * because a measurement that is not kept is a measurement nobody can be shown, and it is bound to
   * the file by `source.sha256`, so it cannot drift onto a different deliverable.
   *
   * The verdict does **not** gate publication. Every `fail` this check can reach on a deliverable --
   * a silent programme, a soundtrack at or above full scale -- is inherited from the master the
   * deliverable copies, and the delivery route offers no way to fix a master. Refusing here would
   * make a film undeliverable with no remedy, which is a product decision and not a build one; the
   * report says what was measured and the creator decides.
   */
  quality:PictureQcReport;
  /** HV-027-15: a burned deliverable's check of its own caption layer. Only a burned kind carries one. */
  captions?:DeliveryCaptionCheck;
  revision:string;
}
/** A reframe re-encodes the picture and copies the sound; a mezzanine copies both. */
const DELIVERED_CODECS:Record<DeliveryKind,{video:string;audio:string}>={
  "reframe-9:16":{video:"h264",audio:"aac"},"reframe-1:1":{video:"h264",audio:"aac"},mezzanine:{video:"ffv1",audio:"pcm_s24le"},
  "open-captions":{video:"h264",audio:"aac"},"open-captions-9:16":{video:"h264",audio:"aac"},"open-captions-1:1":{video:"h264",audio:"aac"}};
/** A reframe is an H.264 encode of a crop; nothing this studio makes approaches this. */
const REFRAME_BYTE_CEILING=8*1024**3;
export function deliveryOutputCeiling(plan:DeliveryJobPlan):number{
  return plan.kind==="mezzanine"?plan.mezzanine!.estimatedBytes:REFRAME_BYTE_CEILING;
}
/** The one file a delivery job may retain, under its own job's prefix and nowhere else. */
export function deliveryInventory(job:{projectId:string;id:string},plan:DeliveryJobPlan):string[]{
  return [job.projectId+"/"+job.id+"/"+deliveryFileName(plan)];
}
export function assertDeliveryPermission(plan:DeliveryJobPlan,project:{id:string;rightsAttestedAt:string|null;deleteAfter:string}|null|undefined,now=Date.now()):void{
  const valid=validateDeliveryPlan(plan);
  if(!project||project.id!==valid.binding.source.projectId||!project.rightsAttestedAt||Date.parse(project.rightsAttestedAt)>now||Date.parse(project.deleteAfter)<=now)
    fail("This film's project permission is no longer available, so nothing can be delivered from it.");
}
/**
 * HV-027-14: a deliverable is the source film's own frames, so it carries the source film's cast and
 * source permission, re-read wherever the deliverable is listed, served, admitted or rendered.
 * `assertDeliveryPermission` above reads only the project's; a revoked character's likeness went on
 * being served, listed and newly rendered in the 1:1 crop and the mezzanine of a cut that itself
 * was no longer served. The source's own permission check is the one its media path runs.
 */
export function assertDeliverySourcePermission(source:Job|undefined,project:Project|PersistedProject|null|undefined,now=Date.now()):void{
  if(!source||(!source.pictureEdit&&!source.assemblyEdit))fail("The film this deliverable is made from is no longer available.");
  try{if(source.pictureEdit)assertEditPermission(source.pictureEdit,project,now);else assertEditAssemblyPermission(source.assemblyEdit!,project,now);}
  catch(error){fail("This film's cast or source permission is no longer available, so nothing can be delivered from it. "+(error as Error).message);}
}
/**
 * HV-027-14: and a new deliverable is made only from a film still retained. The sound-mix and
 * editorial routes refuse a cut whose link has lapsed; delivery made a fresh 30-day copy of it.
 */
export function assertDeliverySourceRetained(source:Job|undefined,now=Date.now()):void{
  if(!source||!Number.isFinite(Date.parse(source.linkExpiresAt??""))||Date.parse(source.linkExpiresAt!)<=now)
    fail("This film is no longer retained, so nothing new can be delivered from it.");
}
export function validateDeliveryJob(job:JobLike):void{
  if((job.stage==="delivery")!==Boolean(job.delivery))fail("A deliverable requires its own admitted delivery plan.");
  if(!job.delivery){if(job.deliveryCheckpoint||job.deliveryOutput)fail("Only a delivery job can carry a deliverable.");return;}
  const plan=validateDeliveryPlan(job.delivery);
  if(!UUID.test(job.id)||!UUID.test(job.projectId))fail("Use a valid project and job identity.");
  if(plan.binding.source.projectId!==job.projectId)fail("A deliverable is made inside the project the film belongs to.");
  // A job that delivers from itself would be asking for its own sealed output while it is running.
  if(plan.binding.source.jobId===job.id)fail("A deliverable is a new job beside the film, never the film's own job.");
  if(!job.rightsAttestedAt||Date.parse(job.rightsAttestedAt)>Date.now())fail("A deliverable inherits the film's attested rights.");
  if(job.scriptText!==""||job.scriptVersion!==0||job.animaticJobId!==null||job.animaticApprovedAt!==null)
    fail("A deliverable carries no screenplay and no generation history: it is made from a finished file.");
  if(job.totalFrames!==plan.binding.conform.frames)fail("A deliverable runs exactly as long as the film it is made from.");
  if(job.costCapUsd!==0||job.budgetReservedUsd!==0||("costUsd" in job&&job.costUsd!==0)||job.cost)
    fail("A deliverable dispatches no provider, so it reserves and spends nothing.");
  if(job.casting||job.direction||job.shotReuse||job.shotTakes||job.characterSheet||job.dialogueReplacement||job.dialogueCheckpoint
    ||job.audioTake||job.audioCheckpoint||job.audioOutput||job.lipSync||job.lipSyncPrepared||job.lipSyncCheckpoint||job.lipSyncReviews
    ||job.soundMix||job.soundCheckpoint||job.pictureEdit||job.editCheckpoint||job.assemblyEdit||job.assemblyCheckpoint
    ||job.graphicRender||job.graphicCheckpoint||job.graphicOutput||job.graphicProgress
    ||job.providerSpec||job.providerPlan||job.routeDecisions?.length||job.output)
    fail("A deliverable retains its own single file and nothing else.");
}
export function validateDeliveryOutput(job:JobLike,output:DeliveryOutput):void{
  validateDeliveryJob(job);
  const plan=job.delivery;if(!plan)fail("Choose an admitted delivery job.");
  editRecord(output,["schema","planRevision","resultRevision","file","delivered","quality","captions","revision"]);
  const {revision,...data}=output;
  if(output.schema!=="hv-delivery-output/1"||revision!==contentHash(data)||output.planRevision!==plan.revision)fail("The deliverable lost its admitted plan.");
  if(!HASH.test(output.resultRevision))fail("A deliverable names the run that produced it.");
  editRecord(output.file,["path","sha256","bytes"]);
  const [only]=deliveryInventory(job,plan);
  if(output.file.path!==only)fail("A deliverable is retained under its own job and nowhere else.");
  if(!HASH.test(output.file.sha256))fail("A deliverable names its own bytes.");
  editNumber(output.file.bytes,1,deliveryOutputCeiling(plan),"Delivered file bytes");
  editRecord(output.delivered,["width","height","durationSec","video","audio"]);
  const wanted=plan.kind==="mezzanine"?{width:plan.mezzanine!.output.width,height:plan.mezzanine!.output.height}:plan.openCaptions?.output??plan.reframe!.output;
  if(output.delivered.width!==wanted.width||output.delivered.height!==wanted.height)
    fail("This deliverable is "+output.delivered.width+" by "+output.delivered.height+" and the plan asked for "+wanted.width+" by "+wanted.height+".");
  const codecs=DELIVERED_CODECS[plan.kind];
  if(output.delivered.video!==codecs.video||output.delivered.audio!==codecs.audio)
    fail("A "+plan.kind+" is delivered as "+codecs.video+" and "+codecs.audio+", and this one is not.");
  const durationSec=plan.binding.conform.frames/EDIT_FPS;
  if(typeof output.delivered.durationSec!=="number"||!Number.isFinite(output.delivered.durationSec)||Math.abs(output.delivered.durationSec-durationSec)>1)
    fail("This deliverable runs "+output.delivered.durationSec+" s and the film runs "+durationSec+" s.");
  assertDeliveryQuality(output);
  // HV-027-15: a burned deliverable carries the check of its own caption layer, and nothing else does.
  if(plan.openCaptions)validateDeliveryCaptionCheck(output.captions!,plan.openCaptions);
  else if(output.captions!==undefined)fail("Only a burned deliverable carries a caption check.");
}
/**
 * The retained quality check is re-derived from its own measurement, bound to the bytes it
 * measured, and cross-examined against the seal's own probe.
 *
 * Two independent readings of one file: `delivered` comes from the seal's ffprobe and
 * `quality.programme` from the check's. They are taken seconds apart from the same path, so they
 * must agree -- and a report copied from another deliverable, or edited under its own revision,
 * disagrees with one of them. `validatePictureQcReport` already refuses a report whose findings do
 * not follow from its measurement; this is the half that ties the measurement to *this* file.
 */
function assertDeliveryQuality(output:DeliveryOutput):void{
  let report:PictureQcReport;
  try{report=validatePictureQcReport(output.quality);}
  catch(error){return fail("This deliverable's quality check is not a reading of its own file. "+(error as Error).message);}
  if(report.source.sha256!==output.file.sha256||report.source.bytes!==output.file.bytes)
    fail("This deliverable's quality check measured different bytes from the ones it was sealed with.");
  const {programme}=report,{delivered}=output;
  if(programme.width!==delivered.width||programme.height!==delivered.height||programme.video!==delivered.video||programme.audio!==delivered.audio)
    fail("This deliverable's two readings of itself disagree about what it is.");
  if(Math.abs(programme.durationSec-delivered.durationSec)>1)
    fail("This deliverable's two readings of itself disagree about how long it runs.");
  if(programme.bytes!==output.file.bytes)fail("This deliverable's quality check measured a file of a different size.");
}
/**
 * A request key that already belongs to a deliverable cannot be reused for a different one.
 *
 * This is the narrower half of the claim. That the *same* deliverable of the same sealed output is
 * one job is enforced where the jobs can be seen — the admission route looks for an existing job
 * carrying this plan's `idempotencyKey` before making a second one — because a validator that is
 * handed one job cannot know about the other.
 */
export function assertDeliveryIdempotency(existing:JobLike|undefined,input:JobLike):void{
  if(!existing||!(existing.delivery||input.delivery||existing.stage==="delivery"||input.stage==="delivery"))return;
  if(existing.stage!==input.stage||existing.delivery?.idempotencyKey!==input.delivery?.idempotencyKey)
    fail("This request key belongs to another deliverable.");
}

/**
 * The film is still the film, at admission.
 *
 * Checked against the source job's own body rather than against the artifact rows, because the body
 * is authoritative in both storage modes and says more: that the job finished, that it sealed under
 * the key its stage seals under, that the revision is the one the binding names, and that the master
 * is in the inventory that revision vouches for. A film rendered again since the deliverable was
 * planned is refused by name, not delivered from the old bytes.
 */
export function assertDeliverySourceAvailable(binding:DeliveryBinding,source:(JobLike&{status?:string})|undefined):void{
  const valid=validateDeliveryBinding(binding);
  if(!source||source.id!==valid.source.jobId||source.projectId!==valid.source.projectId||source.stage!==valid.source.stage||source.status!=="done")
    fail("The film this deliverable is made from is no longer available.");
  const sealed=valid.source.stage==="picture-edit"?source.output?.editorial:source.output?.assembly;
  if(!sealed||sealed.revision!==valid.source.outputRevision)
    fail("This film has been rendered again since the deliverable was planned. Deliver from the cut that is current now.");
  if(!sealed.files.some(file=>file.path===valid.master.path&&file.sha256===valid.master.sha256&&file.bytes===valid.master.bytes))
    fail("The master this deliverable names is not in the film's sealed inventory.");
}
