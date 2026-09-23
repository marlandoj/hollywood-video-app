import {lstatSync,realpathSync} from "node:fs";
import {resolve,sep} from "node:path";
import type {Project} from "./index";
import {CapacityController,DurableJobStore,type Job,type JobInput} from "../../queue/src/index";
import type {PostgresJobStore} from "../../storage/src/jobs";
import {PostgresCostLedger} from "../../storage/src/ledger";
import type {CostLedger} from "../../operator/src/index";
import type {PostgresArtifactStore} from "../../storage/src/artifacts";
import {artifactKey} from "../../storage/src/artifacts";
import {contentHash} from "../../generator/src/capabilities";
import {soundRuntimeRevision} from "../../generator/src/sound-audio";
import {soundDigest} from "../../generator/src/sound-media";
import {audioRecord} from "../../planner/src/audio-performances";
import {soundFail,soundId,soundAssetAvailable} from "../../planner/src/sound-assets";
import {assertSoundPermission,assertSoundSourceAvailable,createSoundPlan,retainSoundSource,soundVoiceWindows,soundBaseFilm,soundBaseFrames,soundCaptionLanguage} from "../../planner/src/sound-jobs";
import {projectJobs} from "./project-jobs";
interface Context {root:string;artifacts?:PostgresArtifactStore;ledger:CostLedger|PostgresCostLedger;monthlyBudgetUsd:number;filmCapUsd:number;capacity:CapacityController;store:(projectId:string)=>DurableJobStore|PostgresJobStore;view:(job:Job,project:Project)=>Promise<Record<string,unknown>>}
export class SoundApi {
  constructor(private context:Context){}
  private info(job:Job,path:string){artifactKey(path,job.projectId,job.id);if(this.context.artifacts)return this.context.artifacts.fileInfo(job.projectId,job.id,path);const root=realpathSync(this.context.root),file=resolve(root,path);if(!lstatSync(file).isFile()||lstatSync(file).isSymbolicLink()||!realpathSync(file).startsWith(root+sep))soundFail("The retained sound source is outside its workspace.");return soundDigest(file).then(d=>({path,...d}));}
  async handle(parts:string[],request:Request,project:Project,refresh:()=>Promise<Project|null>,body?:Record<string,unknown>):Promise<{status:number;body:unknown}>{
    const {store,ledger,monthlyBudgetUsd,capacity}=this.context,queue=store(project.id);
    if(!parts.length&&request.method==="GET"){
      const all=await projectJobs(this.context.store,project.id),sources=[];
      for(const job of all.filter(j=>j.status==="done"&&["animatic","final","dialogue-replacement","lip-sync","sound-mix"].includes(j.stage))){let unavailable:string|null=null;try{if(!job.output||!job.linkExpiresAt||Date.parse(job.linkExpiresAt)<=Date.now())soundFail("This cut is no longer retained.");if(job.lipSync&&job.lipSyncReviews?.entries.at(-1)?.decision!=="accept")soundFail("Accept the lip-sync quality review first.");}catch(error){unavailable=(error as Error).message;}sources.push({id:job.id,stage:job.stage,completedAt:job.completedAt,unavailable});}
      return {status:200,body:{sources,jobs:await Promise.all(all.filter(j=>j.soundMix).map(j=>this.context.view(j,project))),library:project.soundLibrary,engineVersion:soundRuntimeRevision()}};
    }
    if(parts.length!==1)return {status:404,body:{error:"Unknown sound mix route."}};const id=soundId(parts[0]),selected=await queue.get(id);if(!selected||selected.projectId!==project.id)return {status:404,body:{error:"Unknown retained cut."}};
    const input=body?audioRecord(body,["idempotencyKey","generationApproved","sourceRevision","engineVersion","session"]):undefined;
    if(request.method==="POST"){
      if(!input||input.generationApproved!==true||typeof input.idempotencyKey!=="string"||!/^[A-Za-z0-9_-]{8,128}$/.test(input.idempotencyKey))soundFail("Review this sound session and use a new request key before rendering.");const previous=(await projectJobs(this.context.store,project.id)).find(j=>j.idempotencyKey===project.id+":"+input.idempotencyKey);
      if(previous){if(previous.soundMix?.requestHash!==contentHash(input))soundFail("This key belongs to a different sound session.");return {status:202,body:{jobId:previous.id}};}
    }
    const source=await retainSoundSource(selected,path=>this.info(selected,path)),engineVersion=soundRuntimeRevision(),empty={reviewed:true,dialogueGainDb:0,narrationGainDb:0,cues:[]},inspection=createSoundPlan(source,empty,engineVersion,this.context.artifacts?"s3":"local",contentHash({source:source.revision,inspection:true})),current=await refresh();assertSoundPermission(inspection,current);
    if(request.method==="GET")return {status:200,body:{sourceJobId:selected.id,originalJobId:soundBaseFilm(source.base).id,sourceRevision:source.revision,engineVersion,durationSec:soundBaseFrames(source.base)/30,sampleRate:48000,language:soundCaptionLanguage(source.base),session:selected.soundMix?.session??null,voiceWindows:soundVoiceWindows(source.base),library:current!.soundLibrary,costUsd:0}};
    if(request.method!=="POST"||!input)return {status:404,body:{error:"Unknown sound mix route."}};
    if(input.sourceRevision!==source.revision||input.engineVersion!==engineVersion)soundFail("The selected picture, sound source or runtime changed. Review a fresh quote.");
    const submitted=audioRecord(input.session,["reviewed","dialogueGainDb","narrationGainDb","cues","finishing","restoration"]);if(!Array.isArray(submitted.cues)||submitted.cues.length>64)soundFail("Use up to 64 sound cues.");
    const cues=submitted.cues.map(raw=>{const c=audioRecord(raw,["id","assetId","assetRevision","role","start","frames","trimIn","trimOut","loop","gainDb","balance","fadeIn","fadeOut","duckDb","duckAttack","duckRelease"]),asset=current!.soundLibrary.assets.find(a=>a.id===c.assetId&&a.revision===c.assetRevision);if(!asset||!soundAssetAvailable(current!.soundLibrary,asset))soundFail("Choose an available, unchanged sound recording.");const {assetId:_id,assetRevision:_revision,...settings}=c;return {...settings,asset};});
    const plan=createSoundPlan(source,{...submitted,cues},engineVersion,this.context.artifacts?"s3":"local",contentHash(input));assertSoundPermission(plan,current);
    const decision=capacity.decide({tier:"free",runningForProject:(await projectJobs(this.context.store,project.id)).filter(j=>j.status==="running").length,requestedShots:1,sceneCount:1,monthSpendUsd:await ledger.monthSpend()+await ledger.reservedUsd()});if(decision.action==="reject")return {status:429,body:{error:decision.message,reason:decision.reason}};
    const jobInput:JobInput={id:crypto.randomUUID(),idempotencyKey:project.id+":"+input.idempotencyKey,projectId:project.id,tier:"free",stage:"sound-mix",scriptVersion:source.base.scriptVersion,scriptText:source.base.scriptText,rightsAttestedAt:current!.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,queueAction:decision.action,queueReason:decision.reason,totalFrames:soundBaseFrames(source.base),costCapUsd:0,budgetReservedUsd:0,retryPolicy:{maxRetries:2,backoffMs:1000},timeoutMs:Number(process.env.HV_JOB_TIMEOUT_MS??30*60*1000),soundMix:plan};let job:Job;
    if(ledger instanceof PostgresCostLedger)job=await ledger.admit(project.id,jobInput,monthlyBudgetUsd,this.context.filmCapUsd);
    else{await ledger.reserve(jobInput.id,jobInput.stage,0,monthlyBudgetUsd);try{const current=await refresh();assertSoundSourceAvailable(plan,await queue.get(selected.id));assertSoundPermission(plan,current);job=await queue.enqueue(jobInput);}catch(error){await ledger.release(jobInput.id);throw error;}}
    return {status:202,body:{jobId:job.id}};
  }
}
