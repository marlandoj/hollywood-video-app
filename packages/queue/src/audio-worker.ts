import {existsSync,mkdirSync,mkdtempSync,realpathSync,renameSync,rmSync} from "node:fs";
import {dirname,join,resolve,sep} from "node:path";
import {PostgresJobStore} from "../../storage/src/jobs";
import type {DurableJobStore,Job} from "./index";
import type {WorkerContext} from "./worker";
import {AudioJobError,validateAudioTake,type AudioTakeOutput} from "../../planner/src/audio-jobs";
import {prepareAudioMedia,verifyAudioMedia} from "../../generator/src/audio-media";
import {contentHash} from "../../generator/src/capabilities";

export async function processAudioJob(job:Job,store:DurableJobStore|PostgresJobStore,artifactRoot:string,context:WorkerContext,workerId:string,leaseMs:number,signal:AbortSignal):Promise<Job>{
  validateAudioTake(job);const audio=context.audio;
  if(!audio||!(store instanceof PostgresJobStore))throw new AudioJobError("Audio auditions require configured PostgreSQL accounting and an authorized voice policy.");
  if(job.audioTake!.storage!==(context.artifacts?"s3":"local"))throw new AudioJobError("The audio storage backend changed after admission.");
  const access=async()=>{signal.throwIfAborted();await audio.ledger.assertAudioPermission(job,workerId,audio.policy);};
  await access();mkdirSync(artifactRoot,{recursive:true});const root=realpathSync(artifactRoot);let scratch:string|undefined,owned:string|undefined,generated:AudioTakeOutput|undefined;
  try{
    let output=job.audioCheckpoint;
    if(output){if(context.artifacts)await context.artifacts.restoreCheckpoint(job,signal);verifyAudioMedia(job,output,root);}
    else{
      const existing=await audio.ledger.audioAttempt(job.id);
      if(existing)throw new AudioJobError("This line was already dispatched without a saved checkpoint. Reconcile the original attempt before creating a new audition.");
      const result=await audio.provider.synthesize(job.audioTake!.line,audio.ledger.journal(job,workerId,audio.policy),signal);
      await access();scratch=mkdtempSync(join(root,".audio-worker-"));output=prepareAudioMedia(job,scratch,result.report,result.wav);generated=output;
      const destination=resolve(root,dirname(output.wavPath));mkdirSync(dirname(destination),{recursive:true});
      if(!destination.startsWith(root+sep)||realpathSync(dirname(destination))!==dirname(destination))throw new AudioJobError("Audio output escaped its job.");
      renameSync(scratch,destination);scratch=undefined;owned=destination;verifyAudioMedia(job,output,root);await access();
      if(context.artifacts)await context.artifacts.checkpointAudio(job,workerId,output,leaseMs,signal);
      else await store.checkpointAudio(job.id,workerId,output,Date.now(),leaseMs);
    }
    await access();return await store.completeAudio(job.id,workerId,output);
  }finally{
    if(scratch&&existsSync(scratch))rmSync(scratch,{recursive:true,force:true});
    if(owned&&existsSync(owned)){
      const saved=(await store.get(job.id))?.audioCheckpoint;
      if(context.artifacts||!saved||!generated||contentHash(saved)!==contentHash(generated)){
        // Only this invocation's uniquely named destination is removed. A durable
        // local checkpoint survives; S3 workers may discard their private cache.
        rmSync(owned,{recursive:true,force:true});
      }
    }
  }
}
