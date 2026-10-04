import type {Project,ProjectService} from "./index";
import {filmCapFor} from "../../operator/src/film-budget";
import type {PostgresProjectService} from "../../storage/src/projects";
import {CapacityController,DurableJobStore,type Job,type JobInput} from "../../queue/src/index";
import type {PostgresJobStore} from "../../storage/src/jobs";
import {PostgresCostLedger} from "../../storage/src/ledger";
import type {CostLedger} from "../../operator/src/index";
import {DELIVERY_KINDS,assertDeliveryOffered,assertDeliveryPermission,assertDeliverySourceAvailable,assertDeliverySourcePermission,assertDeliverySourceRetained,deliveryBindingForJob,deliveryJobPlan,
  deliveryOffers,deliveryTimeoutMs,validateDeliveryOutput,type DeliveryKind} from "../../planner/src/delivery-jobs";
import {COLOR_GRADE_NEUTRAL,COLOR_GRADE_RECIPE,COLOR_LOOKS,COLOR_LOOK_IDS} from "../../planner/src/color-grade";
import {editFail} from "../../planner/src/edit-errors";
import {editId,editRecord} from "../../planner/src/edit-timeline";
import {mintArtifactToken} from "./tokens";
import {projectJobs} from "./project-jobs";
import {HERO_DEFAULTS,HERO_DENOISE,HERO_ENGINES,HERO_FRAME_RATES,HERO_HEIGHTS,HERO_LIMITS,HERO_STAGES,heroChainRequests,heroJobPlan,heroShotBindingFor,heroTotalFrames,
  type HeroDeliveryOutput} from "../../planner/src/hero-chain";

interface Context {
  projects:ProjectService|PostgresProjectService;storage:"local"|"s3";ledger:CostLedger|PostgresCostLedger;
  monthlyBudgetUsd:number;filmCapUsd:number;featureCapUsd:number;capacity:CapacityController;store:(projectId:string)=>DurableJobStore|PostgresJobStore;
}
/**
 * HV-027-05: what a creator sees of a deliverable.
 *
 * The view carries the same "unavailable" shape the graphic view uses: a deliverable whose project
 * permission has lapsed, or whose link has expired, is shown as unavailable **with the reason**
 * rather than quietly omitted, because a file that disappears without explanation reads as a bug.
 */
export function deliveryJobView(job:Job,project:Project,source:Job|undefined):Record<string,unknown>{
  let unavailable:string|null=null;const expiresAt=Math.min(Date.parse(job.linkExpiresAt??project.deleteAfter),Date.parse(project.deleteAfter));
  try{
    assertDeliveryPermission(job.delivery!,project);
    // HV-027-14: and the source film's cast permission, which the file is made of.
    assertDeliverySourcePermission(source,project);
    // HV-026-07: `assertDeliveryOffered` validates the output as before, and withholds a grade whose
    // own check found it clipped what the cut did not or left the broadcast tolerance.
    if(job.deliveryOutput){assertDeliveryOffered(job);if(expiresAt<=Date.now())editFail("This deliverable has expired.");}
  }catch(error){unavailable=(error as Error).message;}
  const output=job.status==="done"&&!unavailable?job.deliveryOutput:undefined;
  const token=output?mintArtifactToken(job.projectId,job.id,expiresAt):undefined;
  return {id:job.id,stage:job.stage,status:job.status,kind:job.delivery?.kind,
    sourceJobId:job.delivery?.binding.source.jobId,sourceOutputRevision:job.delivery?.binding.source.outputRevision,
    resumedCount:job.resumedCount,failureReason:job.failureReason??null,unavailable,costUsd:job.costUsd,
    completedAt:job.completedAt,expiresAt:output?new Date(expiresAt).toISOString():null,
    output:output?{revision:output.revision,url:`/artifacts/${token}/${output.file.path}`,bytes:output.file.bytes,
      sha256:output.file.sha256,...output.delivered,
      // HV-027-06. The verdict and the findings, not the whole measurement: a creator is being told
      // whether to look at the file before they send it, and the numbers behind that answer are for
      // the operator's own check, which reads the retained report. `notChecked` travels with the
      // findings because a check that shows only what it found reads as a clean bill of health.
      quality:{verdict:output.quality.verdict,findings:output.quality.findings.map(finding=>
        ({code:finding.code,severity:finding.severity,message:finding.message})),notChecked:output.quality.notChecked},
      // HV-027-15: what the burn measured of its own caption layer, in the creator's terms: how many
      // cues are burned, how many were drawn and found inside the frame, and how many no frame of a
      // 30 fps picture can show. Where each one's ink landed stays in the retained record.
      ...(output.captions?{captions:{cues:output.captions.cues,checked:output.captions.sampled.length,betweenFrames:output.captions.betweenFrames}}:{}),
      // HV-027-16: what the SDH track holds -- the film's lines, the sounds it describes -- and that it read back as written.
      ...(output.sdh?{sdh:{dialogue:output.sdh.dialogue,sounds:output.sdh.sounds,segments:output.sdh.segments}}:{}),
      // HV-019-15: a hero render shows each stage's provenance and a link to each file it retains.
      ...(output.schema==="hv-hero-output/1"?{hero:heroView(output,`/artifacts/${token}/`)}:{})}:null,
    ...(job.delivery?.kind==="hero"?{shotId:job.delivery.binding.source.shotId,chain:job.delivery.chain.stages.map(stage=>({index:stage.index,stage:stage.stage,engine:stage.engine,
      provider:stage.provider,spendUsd:stage.spendUsd,params:stage.params}))}:{}),
    // HV-026-07: a grade shows its decision and its check even when it is withheld -- the check is the
    // reason, and a reason nobody can read is not one.
    ...(job.delivery?.grade?{grade:{decision:job.delivery.grade.decision,revision:job.delivery.grade.revision,
      look:{id:job.delivery.grade.look.id,label:COLOR_LOOKS[job.delivery.grade.look.id].label},
      check:job.deliveryOutput?.grade?{verdict:job.deliveryOutput.grade.verdict,measurement:job.deliveryOutput.grade.measurement,levels:job.deliveryOutput.grade.levels,
        findings:job.deliveryOutput.grade.findings,notChecked:job.deliveryOutput.grade.notChecked}:null}}:{})};
}
/** HV-019-15: what a creator sees of a made hero render: each stage's record in their terms, and every file linked. */
function heroView(output:HeroDeliveryOutput,prefix:string):Record<string,unknown>{
  const chain=output.chain;
  return {source:{jobId:chain.source.jobId,shotId:chain.source.shotId,renderRevision:chain.source.renderRevision,sha256:chain.source.sha256,
      width:chain.source.probe.width,height:chain.source.probe.height,fps:chain.source.probe.fps,frames:chain.source.probe.frames},
    stages:chain.stages.map(stage=>({index:stage.index,stage:stage.stage,engine:stage.engine,provider:stage.provider,spendUsd:stage.spendUsd,filter:stage.filter,
      ffmpeg:stage.runtime.ffmpeg,inputSha256:stage.input.sha256,sha256:stage.output.sha256,bytes:stage.output.bytes,url:prefix+stage.output.path,
      width:stage.probe.width,height:stage.probe.height,fps:stage.probe.fps,frames:stage.probe.frames})),
    credentials:chain.credentials.type,chainRevision:chain.revision,
    recordUrl:prefix+output.files.find(file=>file.path.endsWith("/provenance.json"))!.path,
    sidecarUrl:output.files.some(file=>file.path.endsWith("/provenance.c2pa"))?prefix+output.files.find(file=>file.path.endsWith("/provenance.c2pa"))!.path:null};
}
/** HV-019-15: the choices a hero chain offers, and the limits it runs inside. */
export function heroOptions():Record<string,unknown>{
  return {stages:[...HERO_STAGES],defaults:HERO_DEFAULTS,denoise:Object.keys(HERO_DENOISE),frameRates:[...HERO_FRAME_RATES],heights:[...HERO_HEIGHTS],limits:HERO_LIMITS,
    engines:Object.values(HERO_ENGINES).map(engine=>({id:engine.id,stage:engine.stage,provider:engine.provider,paid:engine.paid,description:engine.description})),
    replacesShotInCut:false,costUsd:0};
}
/**
 * HV-026-07: a sealed grade whose own check withheld it, still within its link. Validated rather than
 * read off the verdict field, so a job whose output does not add up is not taken for a made grade.
 */
function withheldGrade(job:Job):boolean{
  if(job.delivery?.kind!=="grade"||!job.deliveryOutput||!(Date.parse(job.linkExpiresAt??"")>Date.now()))return false;
  try{validateDeliveryOutput(job,job.deliveryOutput);}catch{return false;}
  return job.deliveryOutput.grade?.verdict==="withheld";
}
/**
 * HV-026-08: the finished cuts a deliverable can be made from, newest first, each answered.
 *
 * A panel that is to grade a cut has to be able to name one, and nothing listed them: the delivery
 * routes took a cut's job id and assumed the caller had it. A cut that cannot be delivered from — no
 * longer retained, its cast permission gone, its seal not what a deliverable binds to — is listed
 * with the reason the offer route would give, rather than left out, as every other list here does.
 */
export function deliverySources(jobs:Job[],project:Project,storage:"local"|"s3"):Record<string,unknown>[]{
  return jobs.filter(job=>job.status==="done"&&job.output&&(job.stage==="picture-edit"||job.stage==="assembly-edit"))
    .sort((a,b)=>Date.parse(b.completedAt??"")-Date.parse(a.completedAt??"")||a.id.localeCompare(b.id))
    .map(job=>{
      let unavailable:string|null=null,binding;
      try{assertDeliverySourceRetained(job);assertDeliverySourcePermission(job,project);binding=deliveryBindingForJob(job,storage);}
      catch(error){unavailable=(error as Error).message;}
      return {id:job.id,stage:job.stage,completedAt:job.completedAt??null,unavailable,
        ...(binding?{width:binding.conform.width,height:binding.conform.height,durationSec:binding.conform.frames/30}:{})};
    });
}
/** HV-026-07: what a grade can be made of, answered beside the offers so a panel needs nothing else. */
export function colorGradeOptions():Record<string,unknown>{
  return {controls:COLOR_GRADE_RECIPE.bounds,step:COLOR_GRADE_RECIPE.step,neutral:COLOR_GRADE_NEUTRAL,
    looks:COLOR_LOOK_IDS.map(id=>({id,label:COLOR_LOOKS[id].label,description:COLOR_LOOKS[id].description})),
    thresholds:COLOR_GRADE_RECIPE.thresholds,notChecked:COLOR_GRADE_RECIPE.notChecked};
}
export class DeliveryApi {
  constructor(private context:Context){}
  async handle(parts:string[],request:Request,project:Project,_token:string,refresh:()=>Promise<Project|null>,body?:Record<string,unknown>):Promise<{status:number;body:unknown}>{
    const {ledger,capacity,monthlyBudgetUsd}=this.context,queue=this.context.store(project.id);
    const mine=await projectJobs(this.context.store,project.id),view=(job:Job)=>deliveryJobView(job,project,mine.find(value=>value.id===job.delivery?.binding.source.jobId));
    // HV-019-15: a hero render of one shot of a final render.
    if(parts[0]==="hero")return this.hero(parts.slice(1),request,project,refresh,body,mine,view);
    // Every deliverable this project has asked for, whatever film it came from.
    if(!parts.length&&request.method==="GET")
      return {status:200,body:{kinds:[...DELIVERY_KINDS],sources:deliverySources(mine,project,this.context.storage),jobs:mine.filter(job=>job.delivery).map(view),costUsd:0}};
    if(!parts.length||parts.length>1)return {status:404,body:{error:"Unknown delivery route."}};
    const source=mine.find(job=>job.id===editId(parts[0]));
    if(!source||source.status!=="done"||!source.output)return {status:404,body:{error:"This film is not finished, so there is nothing to deliver from it."}};
    let binding;
    // HV-027-14: nothing is offered or made from a film no longer retained, or whose cast permission is gone.
    try{assertDeliverySourceRetained(source);assertDeliverySourcePermission(source,project);binding=deliveryBindingForJob(source,this.context.storage);}
    catch(error){return {status:409,body:{error:(error as Error).message}};}
    // Every kind is answered, including the ones this master cannot make, each with the reason.
    if(request.method==="GET")
      return {status:200,body:{sourceJobId:source.id,outputRevision:binding.source.outputRevision,
        offers:deliveryOffers(binding).map(offer=>({kind:offer.kind,available:offer.available,reason:offer.reason??null,
          output:offer.plan?(offer.plan.kind==="mezzanine"?offer.plan.mezzanine!.output
            // HV-027-15: a burned deliverable is offered with the frame it burns into and the cues it burns.
            :offer.plan.openCaptions?{...offer.plan.openCaptions.output,estimatedBytes:null,captionCues:offer.plan.openCaptions.captions.cues}
            :offer.plan.kind==="grade"?{width:offer.plan.grade!.source.width,height:offer.plan.grade!.source.height,estimatedBytes:null}
            // HV-027-16: an SDH track is offered with the lines and the sounds it will carry.
            :offer.plan.sdh?{...offer.plan.sdh.output,estimatedBytes:null,captionCues:offer.plan.sdh.captions.cues,soundCues:offer.plan.sdh.sounds.length}
            :{...offer.plan.reframe!.output,estimatedBytes:null}):null,
          estimatedBytes:offer.plan?.mezzanine?.estimatedBytes??null})),
        grade:colorGradeOptions(),
        jobs:mine.filter(job=>job.delivery?.binding.source.jobId===source.id).map(view)}};
    if(request.method!=="POST")return {status:404,body:{error:"Unknown delivery route."}};
    const input=editRecord(body,["idempotencyKey","kind","grade"]);
    if(typeof input.idempotencyKey!=="string"||!/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey))editFail("Ask for this deliverable with a new request key.");
    if(!DELIVERY_KINDS.includes(input.kind as DeliveryKind))editFail("Choose a deliverable this studio makes: "+DELIVERY_KINDS.join(", ")+".");
    // HV-026-07: a grade names its decision; the planner refuses one on any other kind, and a grade without one.
    const plan=deliveryJobPlan(binding,input.kind as DeliveryKind,input.grade);
    const previous=mine.find(job=>job.idempotencyKey===project.id+":"+input.idempotencyKey);
    if(previous){
      if(previous.delivery?.idempotencyKey!==plan.idempotencyKey)editFail("This request key belongs to another deliverable.");
      return {status:202,body:{jobId:previous.id}};
    }
    // The same deliverable of the same sealed output is the same job, whatever request key asks for
    // it. Two keys asking for one file would render it twice and retain it twice.
    //
    // HV-027-10: only a job that is making the file, or made one that can still be fetched. A failed
    // or cancelled deliverable -- disk headroom, a timeout past its retries, a host restart -- used to
    // be "the same job" forever: every new request was answered 202 with the failed job's id and
    // nothing was queued, so one transient failure blocked that deliverable of that film for good.
    // An expired one was the same. Either is asked for again as a new job.
    //
    // HV-026-07: and a grade its own check withheld. It has no output to fetch, but it is made: the same
    // decision on the same cut renders the same clipping again, so a new key for it is answered with the
    // withheld job and its reasons rather than another render. An expired one is asked for again.
    const made=mine.find(job=>job.delivery?.idempotencyKey===plan.idempotencyKey&&(job.status==="queued"||job.status==="running"
      ||job.status==="done"&&(view(job).output!==null||withheldGrade(job))));
    if(made)return {status:202,body:{jobId:made.id}};
    // HV-027-09: the film is read again here. `source` came out of the `mine` snapshot at the top of
    // this handler and `binding` was derived from that same object three lines later, so asking
    // whether the one still matches the other could not fail -- the check that exists to refuse "a
    // film rendered again since the deliverable was planned" was comparing the plan with itself.
    const current=await refresh();assertDeliveryPermission(plan,current);assertDeliverySourceAvailable(binding,await queue.get(source.id)??undefined);
    const fresh=await queue.get(source.id)??undefined;assertDeliverySourceRetained(fresh);assertDeliverySourcePermission(fresh,current);
    const decision=capacity.decide({tier:"free",requestedUsd:0,runningForProject:mine.filter(job=>job.status==="running").length,requestedShots:1,sceneCount:1,
      monthSpendUsd:await ledger.monthSpend()+await ledger.reservedUsd()});
    if(decision.action==="reject")return {status:429,body:{error:decision.message,reason:decision.reason}};
    const jobInput:JobInput={id:crypto.randomUUID(),idempotencyKey:project.id+":"+input.idempotencyKey,projectId:project.id,tier:"free",
      stage:"delivery",scriptVersion:0,scriptText:"",rightsAttestedAt:current!.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,
      queueAction:decision.action,queueReason:decision.reason,totalFrames:binding.conform.frames,costCapUsd:0,budgetReservedUsd:0,
      retryPolicy:{maxRetries:2,backoffMs:1000},timeoutMs:deliveryTimeoutMs(plan.kind,binding.conform.frames),delivery:plan};
    let job:Job;
    if(ledger instanceof PostgresCostLedger)job=await ledger.admit(project.id,jobInput,monthlyBudgetUsd,filmCapFor(project,this.context));
    else{
      await ledger.reserve(jobInput.id,jobInput.stage,0,monthlyBudgetUsd);
      // The local store has no transaction to hold the source still, so it is read once more at the
      // last moment before the job exists -- the narrowest window this backend can offer.
      try{assertDeliveryPermission(plan,await refresh());assertDeliverySourceAvailable(binding,await queue.get(source.id)??undefined);job=await queue.enqueue(jobInput);}
      catch(error){await ledger.release(jobInput.id);throw error;}
    }
    return {status:202,body:{jobId:job.id}};
  }
  /**
   * HV-019-15: `GET …/deliveries/hero/:filmJobId` answers every shot of a finished final render --
   * which can be made a hero render and why the others cannot -- with the chain's choices and limits;
   * `POST` admits one, as a delivery job at zero cost. Owner-only, like every delivery route.
   */
  private async hero(parts:string[],request:Request,project:Project,refresh:()=>Promise<Project|null>,body:Record<string,unknown>|undefined,mine:Job[],view:(job:Job)=>Record<string,unknown>):Promise<{status:number;body:unknown}>{
    const {ledger,capacity,monthlyBudgetUsd}=this.context,queue=this.context.store(project.id);
    if(parts.length!==1)return {status:404,body:{error:"Unknown hero route."}};
    const source=mine.find(job=>job.id===editId(parts[0]));
    if(!source||source.stage!=="final"||source.status!=="done"||!source.output)return {status:404,body:{error:"This final render is not finished, so none of its shots can be made a hero render."}};
    try{assertDeliverySourceRetained(source);assertDeliverySourcePermission(source,project);}
    catch(error){return {status:409,body:{error:(error as Error).message}};}
    if(request.method==="GET")
      return {status:200,body:{sourceJobId:source.id,options:heroOptions(),
        shots:(source.output.shotRenders??[]).map(record=>{
          try{const binding=heroShotBindingFor(source,record.shotId,this.context.storage);
            return {shotId:record.shotId,available:true,reason:null,durationSec:binding.shot.durationSec,provider:binding.shot.provider,model:binding.shot.model,sha256:binding.shot.video.sha256};}
          catch(error){return {shotId:record.shotId,available:false,reason:(error as Error).message,durationSec:record.clip?.durationSec??null};}
        }),
        jobs:mine.filter(job=>job.delivery?.kind==="hero"&&job.delivery.binding.source.jobId===source.id).map(view)}};
    if(request.method!=="POST")return {status:404,body:{error:"Unknown hero route."}};
    const input=editRecord(body,["idempotencyKey","shotId","denoise","fps","height"]);
    if(typeof input.idempotencyKey!=="string"||!/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey))editFail("Ask for this hero render with a new request key.");
    if(typeof input.shotId!=="string")editFail("Choose the shot to make a hero render of.");
    const plan=heroJobPlan(heroShotBindingFor(source,editId(input.shotId),this.context.storage),heroChainRequests({denoise:input.denoise,fps:input.fps,height:input.height}));
    const previous=mine.find(job=>job.idempotencyKey===project.id+":"+input.idempotencyKey);
    if(previous){
      if(previous.delivery?.idempotencyKey!==plan.idempotencyKey)editFail("This request key belongs to another deliverable.");
      return {status:202,body:{jobId:previous.id}};
    }
    // The same chain on the same shot of the same film is the same job, as every deliverable is.
    const made=mine.find(job=>job.delivery?.idempotencyKey===plan.idempotencyKey&&(job.status==="queued"||job.status==="running"||job.status==="done"&&view(job).output!==null));
    if(made)return {status:202,body:{jobId:made.id}};
    const current=await refresh();assertDeliveryPermission(plan,current);assertDeliverySourceAvailable(plan.binding,await queue.get(source.id)??undefined);
    const fresh=await queue.get(source.id)??undefined;assertDeliverySourceRetained(fresh);assertDeliverySourcePermission(fresh,current);
    const decision=capacity.decide({tier:"free",requestedUsd:0,runningForProject:mine.filter(job=>job.status==="running").length,requestedShots:1,sceneCount:1,
      monthSpendUsd:await ledger.monthSpend()+await ledger.reservedUsd()});
    if(decision.action==="reject")return {status:429,body:{error:decision.message,reason:decision.reason}};
    const totalFrames=heroTotalFrames(plan);
    const jobInput:JobInput={id:crypto.randomUUID(),idempotencyKey:project.id+":"+input.idempotencyKey,projectId:project.id,tier:"free",
      stage:"delivery",scriptVersion:0,scriptText:"",rightsAttestedAt:current!.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,
      queueAction:decision.action,queueReason:decision.reason,totalFrames,costCapUsd:0,budgetReservedUsd:0,
      // Decoded, interpolated and encoded at up to UHD: the mezzanine's per-frame allowance, as a bound and not a measurement.
      retryPolicy:{maxRetries:2,backoffMs:1000},timeoutMs:deliveryTimeoutMs("mezzanine",totalFrames),delivery:plan};
    let job:Job;
    if(ledger instanceof PostgresCostLedger)job=await ledger.admit(project.id,jobInput,monthlyBudgetUsd,filmCapFor(project,this.context));
    else{
      await ledger.reserve(jobInput.id,jobInput.stage,0,monthlyBudgetUsd);
      try{assertDeliveryPermission(plan,await refresh());assertDeliverySourceAvailable(plan.binding,await queue.get(source.id)??undefined);job=await queue.enqueue(jobInput);}
      catch(error){await ledger.release(jobInput.id);throw error;}
    }
    return {status:202,body:{jobId:job.id}};
  }
}
