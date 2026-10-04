import type {Project,ProjectService} from "./index";
import {filmCapFor} from "../../operator/src/film-budget";
import type {PostgresProjectService} from "../../storage/src/projects";
import {CapacityController,DurableJobStore,TIERS,type Job,type JobInput} from "../../queue/src/index";
import type {PostgresJobStore} from "../../storage/src/jobs";
import {PostgresCostLedger} from "../../storage/src/ledger";
import type {CostLedger} from "../../operator/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {parseFountain} from "../../parser/src/index";
import {currentCasting} from "../../planner/src/casting";
import {currentDirection} from "../../planner/src/direction";
import {sameSequence,sequenceRef} from "../../planner/src/sequences";
import {assertOutputPermission} from "../../planner/src/dialogue-selection";
import {FEATURE_FILM_CROSSFADE_FRAMES,FeatureFilmConflict,assertFeatureFilmSourcesAvailable,createFeatureFilmPlan,featureFilmClaim,featureFilmGraphic,featureFilmSources,type FeatureFilmProject} from "../../planner/src/feature-film";
import {projectJobs} from "./project-jobs";

interface Context {
  projects:ProjectService|PostgresProjectService;storage:"local"|"s3";ledger:CostLedger|PostgresCostLedger;
  monthlyBudgetUsd:number;filmCapUsd:number;featureCapUsd:number;capacity:CapacityController;store:(projectId:string)=>DurableJobStore|PostgresJobStore;
}
/** A joined feature is streamed through ffmpeg once: two minutes, plus 50 ms a frame, at most three hours. */
export const featureFilmTimeoutMs=(frames:number)=>Math.min(3*60*60*1000,2*60*1000+frames*50);

function featureProject(project:Project):FeatureFilmProject{
  const script=project.versions.latest();
  return {id:project.id,format:project.format,sequences:project.sequences,scriptVersion:script?.version??0,parsed:parseFountain(script?.text??""),
    casting:currentCasting(project.id,project.castingHistory),direction:currentDirection(project.id,project.directionHistory),approvals:project.animaticApprovals};
}
/** The newest finished final of each sequence of the current split, as the front door and the join read it. */
function latestFinal(jobs:Job[],project:Project,number:number):Job|undefined{
  const ref=sequenceRef(project.sequences!,number);
  return jobs.filter(job=>job.stage==="final"&&job.status==="done"&&sameSequence(job.sequence,ref)).sort((a,b)=>(a.completedAt??"").localeCompare(b.completedAt??"")).at(-1);
}
const sizeOf=(final:Job)=>{const [width,height]=TIERS[final.tier].maxResolution.split("x").map(Number);return {width:width!,height:height!};};

/**
 * HV-030-30: a feature's film, its sequences joined (Release 3 step 7).
 *
 * `GET` answers what the join would be made of: the feature's size (its finals' render size), the join's
 * dissolve, and each sequence of the current split with its newest finished final. `POST` admits the
 * join: one finished film per sequence and the Editor's title and credits, checked by
 * `featureFilmSources`, at $0 under the month and the feature's own film limit like every other job.
 * A repeated request key is the same join; nothing is joined twice.
 */
export class FeatureFilmApi {
  constructor(private context:Context){}
  async handle(request:Request,project:Project,refresh:()=>Promise<Project|null>,body?:Record<string,unknown>):Promise<{status:number;body:unknown}>{
    const {ledger,capacity,monthlyBudgetUsd}=this.context,queue=this.context.store(project.id);
    if(project.format!=="feature"||!project.sequences)return {status:409,body:{error:"Only a feature the Showrunner split into sequences is joined into one film."}};
    const jobs=await projectJobs(this.context.store,project.id);
    if(request.method==="GET"){
      const sequences=project.sequences.sequences.map((sequence,index)=>{const final=latestFinal(jobs,project,index+1);
        return {number:index+1,firstScene:sequence.firstScene,lastScene:sequence.lastScene,final:final?{jobId:final.id,frames:final.totalFrames}:null};});
      const first=latestFinal(jobs,project,1);
      return {status:200,body:{planRevision:project.sequences.revision,size:first?sizeOf(first):null,crossfadeFrames:FEATURE_FILM_CROSSFADE_FRAMES,sequences,costUsd:0,
        jobs:jobs.filter(job=>job.featureFilm).map(job=>({jobId:job.id,status:job.status,planRevision:job.featureFilm!.planRevision}))}};
    }
    if(request.method!=="POST")return {status:405,body:{error:"Use GET to review or POST to join the feature."}};
    if(!body||Object.keys(body).sort().join(",")!=="credits,generationApproved,idempotencyKey,sequences,title"||body.generationApproved!==true||typeof body.idempotencyKey!=="string"||!/^[A-Za-z0-9_-]{8,128}$/.test(body.idempotencyKey))
      return {status:400,body:{error:"Approve the join and use a request key: {idempotencyKey, generationApproved: true, sequences, title, credits}."}};
    const requestHash=contentHash(body),previous=jobs.find(job=>job.idempotencyKey===project.id+":"+body.idempotencyKey);
    if(previous){if(previous.featureFilm?.requestHash!==requestHash)throw new FeatureFilmConflict("This request key belongs to a different job. Use a new key.");return {status:202,body:{jobId:previous.id,admitted:false}};}
    const claim=featureFilmClaim({sequences:body.sequences,title:body.title,credits:body.credits}),current=await refresh();
    if(!current)return {status:401,body:{error:"unauthorized"}};
    const {plan:split,sequences,films}=featureFilmSources(featureProject(current),claim,jobs);
    for(const film of films)assertOutputPermission(film.job,current);
    const final=jobs.find(job=>job.id===sequences[0]!.finalJobId)!,size=sizeOf(final),script=current.versions.latest()!;
    const title=featureFilmGraphic("title",claim.title,jobs,project.id),credits=featureFilmGraphic("credits",claim.credits,jobs,project.id);
    const plan=createFeatureFilmPlan({planRevision:split.revision,scriptVersion:script.version,sequences,films,title,credits,...size,storage:this.context.storage,requestHash});
    const totalFrames=Math.max(1,films.reduce((sum,film)=>sum+film.job.totalFrames,0)+(credits?.frames??0));
    const decision=capacity.decide({tier:"free",requestedUsd:0,runningForProject:jobs.filter(job=>job.status==="running").length,requestedShots:1,sceneCount:1,monthSpendUsd:await ledger.monthSpend()+await ledger.reservedUsd()});
    if(decision.action==="reject")return {status:429,body:{error:decision.message,reason:decision.reason}};
    const jobInput:JobInput={id:crypto.randomUUID(),idempotencyKey:project.id+":"+body.idempotencyKey,projectId:project.id,tier:"free",stage:"feature-film",scriptVersion:script.version,scriptText:script.text,
      rightsAttestedAt:current.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,queueAction:decision.action,queueReason:decision.reason,totalFrames,costCapUsd:0,budgetReservedUsd:0,
      retryPolicy:{maxRetries:2,backoffMs:1000},timeoutMs:Number(process.env.HV_JOB_TIMEOUT_MS??featureFilmTimeoutMs(totalFrames)),featureFilm:plan};
    let job:Job;
    if(ledger instanceof PostgresCostLedger)job=await ledger.admit(project.id,jobInput,monthlyBudgetUsd,filmCapFor(current,this.context));
    else{
      await ledger.reserve(jobInput.id,jobInput.stage,0,monthlyBudgetUsd);
      try{const latest=new Map<string,Job|undefined>();for(const id of [...plan.films.map(film=>film.job.id),...[plan.title,plan.credits].flatMap(value=>value?[value.jobId]:[])])latest.set(id,await queue.get(id)??undefined);
        assertFeatureFilmSourcesAvailable(plan,id=>latest.get(id));job=await queue.enqueue(jobInput);}
      catch(error){await ledger.release(jobInput.id);throw error;}
    }
    return {status:202,body:{jobId:job.id,admitted:true}};
  }
}
