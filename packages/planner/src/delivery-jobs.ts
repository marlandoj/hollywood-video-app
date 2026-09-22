import {contentHash} from "../../generator/src/capabilities";
import {EDIT_FPS} from "./edit-timeline";
import {deliveryReframePlan,type DeliveryFormat,type DeliveryReframePlan} from "./delivery-reframe";
import {assertMezzanineSource,deliveryMezzaninePlan,mezzanineSource,type DeliveryMezzaninePlan,type MezzanineSource} from "./delivery-mezzanine";

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
export const DELIVERY_KINDS=["reframe-9:16","reframe-1:1","mezzanine"] as const;
export type DeliveryKind=typeof DELIVERY_KINDS[number];
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
  revision:string;
}
/** A sealed editorial or assembly output: its revision, and the closed inventory that revision covers. */
export interface SealedOutput {revision:string;files:DeliveryFile[]}
export interface DeliveryOffer {kind:DeliveryKind;available:boolean;reason?:string;plan?:DeliveryJobPlan}
export interface DeliveryJobPlan {
  schema:"hv-delivery-plan/1";kind:DeliveryKind;binding:DeliveryBinding;
  reframe?:DeliveryReframePlan;mezzanine?:DeliveryMezzaninePlan;
  /**
   * The same deliverable of the same sealed output is the same job. It is the output's revision and
   * the kind and nothing else: not the job id, which would make a re-render's identical deliverable
   * a different one, and not a clock.
   */
  idempotencyKey:string;revision:string;
}
const fail:(message:string)=>never=message=>{throw new Error(message);};
const REFRAME:Record<DeliveryKind,DeliveryFormat|null>={"reframe-9:16":"9:16","reframe-1:1":"1:1",mezzanine:null};
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
const PART=/^part-\d{5}\.mkv$/;
const file=(value:DeliveryFile|undefined,prefix:string,what:string):DeliveryFile=>{
  if(!value||typeof value.path!=="string"||!value.path.startsWith(prefix)||!/^[A-Za-z0-9._/-]{1,1024}$/.test(value.path)
    ||value.path.split("/").some(segment=>!segment||segment==="."||segment===".."))fail("A deliverable reads "+what+" from inside the film's own job and nowhere else.");
  if(!HASH.test(value.sha256)||!Number.isSafeInteger(value.bytes)||value.bytes<1)fail("Name "+what+"'s bytes and their digest.");
  return {path:value.path,sha256:value.sha256,bytes:value.bytes};
};
export function deliveryBinding(input:Omit<DeliveryBinding,"schema"|"revision">):DeliveryBinding{
  const {storage,source,master,files,conform}=input??{};
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
  const data={schema:"hv-delivery-binding/1" as const,storage,
    source:{projectId:source.projectId,jobId:source.jobId,stage:source.stage,outputRevision:source.outputRevision},
    master:checkedMaster,files:checked.slice().sort((a,b)=>a.path.localeCompare(b.path,"en-US")),conform:checkedConform};
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
  const wanted=[master.path,directory+"/picture/index.ffconcat",directory+"/audio/final.wav",...parts.map(part=>part.path)];
  const files=wanted.map(path=>{
    const found=sealed.files.find(value=>value.path===path);
    if(!found)fail("This film's sealed inventory does not contain "+path.slice(directory.length+1)+", so nothing can be delivered from it.");
    return found;
  });
  return deliveryBinding({storage,source:{projectId:job.projectId,jobId:job.id,stage,outputRevision:sealed.revision},
    master:{path:master.path,sha256:master.sha256,bytes:master.bytes},files,
    conform:mezzanineSource(conform,timeline,parts.map(part=>part.bytes))});
}
/** A retained binding is re-derived from its own parts rather than trusted. */
export function validateDeliveryBinding(binding:DeliveryBinding):DeliveryBinding{
  if(!binding||binding.schema!=="hv-delivery-binding/1")fail("Use a delivery binding.");
  const rebuilt=deliveryBinding({storage:binding.storage,source:binding.source,master:binding.master,files:binding.files,conform:binding.conform});
  if(contentHash(rebuilt)!==contentHash(binding))fail("This delivery binding does not match the film it names.");
  return rebuilt;
}
export function deliveryJobPlan(binding:DeliveryBinding,kind:DeliveryKind):DeliveryJobPlan{
  if(!DELIVERY_KINDS.includes(kind))fail("Choose a deliverable this studio makes: "+DELIVERY_KINDS.join(", ")+".");
  const valid=validateDeliveryBinding(binding),format=REFRAME[kind];
  const data={schema:"hv-delivery-plan/1" as const,kind,binding:valid,
    ...(format?{reframe:deliveryReframePlan({width:valid.conform.width,height:valid.conform.height,durationSec:valid.conform.frames/EDIT_FPS},format)}
      :{mezzanine:deliveryMezzaninePlan(valid.conform)}),
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
