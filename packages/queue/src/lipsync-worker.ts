import {existsSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync} from "node:fs";
import {dirname,join,resolve,sep} from "node:path";
import type {Job,DurableJobStore} from "./index";
import type {WorkerContext} from "./worker";
import {PostgresJobStore} from "../../storage/src/jobs";
import {copyDialogueFiles} from "../../generator/src/dialogue-replacement";
import {prepareLipSyncMedia,renderLipSyncVersion,verifyLipSyncPrepared,verifyLipSyncMedia} from "../../generator/src/lipsync-media";
import {lipSyncSourceFiles,validateLipSyncJob} from "../../planner/src/lipsync";
import {LipSyncError} from "../../planner/src/lipsync-policy";
import {LipSyncProviderError} from "../../generator/src/sync-lipsync";
import {exportC2paSigner} from "../../assembler/src/export-credentials";

export async function processLipSyncJob(initial:Job,store:DurableJobStore|PostgresJobStore,artifactRoot:string,context:WorkerContext,workerId:string,leaseMs:number,signal:AbortSignal):Promise<Job>{
  validateLipSyncJob(initial);const lane=context.lipSync;if(!lane||!(store instanceof PostgresJobStore))throw new LipSyncError("Lip-sync needs configured PostgreSQL accounting and a provider policy.");
  if(initial.lipSync!.storage!==(context.artifacts?"s3":"local"))throw new LipSyncError("The lip-sync storage backend changed after admission.");
  let job=initial;const access=async()=>{signal.throwIfAborted();await lane.ledger.assertLipSyncPermission(job,workerId,lane.policy);};await access();
  mkdirSync(artifactRoot,{recursive:true});const root=realpathSync(artifactRoot),scratch=mkdtempSync(join(root,".lipsync-worker-")),owned:{path:string;kind:"prepared"|"output";revision?:string}[]=[];
  try{
    if(job.lipSyncPrepared&&context.artifacts)await context.artifacts.restoreCheckpoint(job,signal);
    if(!job.lipSyncPrepared){
      const source=job.lipSync!.source;await copyDialogueFiles({id:source.jobId,projectId:job.projectId},lipSyncSourceFiles(source),root,scratch,signal,context.artifacts);await access();
      const name="inputs-"+crypto.randomUUID(),temporary=resolve(scratch,job.projectId,job.id,name),prepared=await prepareLipSyncMedia(job,scratch,temporary,access,signal),destination=resolve(root,job.projectId,job.id,name);
      mkdirSync(dirname(destination),{recursive:true});if(realpathSync(dirname(destination))!==dirname(destination)||!destination.startsWith(root+sep))throw new LipSyncError("Prepared lip-sync media escaped its job.");renameSync(temporary,destination);owned.push({path:destination,kind:"prepared",revision:prepared.revision});
      await access();if(context.artifacts)await context.artifacts.checkpointLipSyncPrepared(job,workerId,prepared,leaseMs,signal);else await store.checkpointLipSyncPrepared(job.id,workerId,prepared,Date.now(),leaseMs);
      job=(await store.get(job.id))!;
    }
    const prepared=job.lipSyncPrepared!;await verifyLipSyncPrepared(job,prepared,root,signal);let output=job.lipSyncCheckpoint;
    if(output)await verifyLipSyncMedia(job,output,root,signal);
    else{
      // HV-031-17: the signing configuration is checked before the paid provider call, so a host whose
      // certificate lapsed after startup does not pay for a version it then cannot sign.
      exportC2paSigner();
      const attempt=await lane.ledger.lipSyncAttempt(job.id);if(attempt&&!attempt.lipSync.receipt)throw new LipSyncProviderError("The original lip-sync submission needs reconciliation before another request.","ambiguous");
      const result=await lane.provider.synthesize(job.lipSync!,prepared,{video:readFileSync(join(root,prepared.video.path)),audio:readFileSync(join(root,prepared.audio.path))},lane.ledger.journal(job,workerId,lane.policy),attempt?.lipSync.receipt,signal);await access();
      const directory=resolve(root,job.projectId,job.id,"version-"+crypto.randomUUID());owned.push({path:directory,kind:"output"});output=await renderLipSyncVersion(job,prepared,result.video,result.delivery,root,directory,access,signal);owned.at(-1)!.revision=output.lipSync!.revision;
      await access();if(context.artifacts)await context.artifacts.checkpointLipSync(job,workerId,output,leaseMs,signal);else await store.checkpointLipSync(job.id,workerId,output,Date.now(),leaseMs);
    }
    await access();return await store.complete(job.id,workerId,output);
  }finally{
    if(existsSync(scratch)&&realpathSync(scratch).startsWith(root+sep+".lipsync-worker-"))rmSync(scratch,{recursive:true,force:true});
    const latest=await store.get(job.id);for(const item of owned){const retained=item.kind==="prepared"?latest?.lipSyncPrepared?.revision:latest?.lipSyncCheckpoint?.lipSync?.revision;
      if(existsSync(item.path)&&(context.artifacts||!item.revision||retained!==item.revision)&&realpathSync(item.path).startsWith(resolve(root,job.projectId,job.id)+sep))rmSync(item.path,{recursive:true,force:true});}
  }
}
