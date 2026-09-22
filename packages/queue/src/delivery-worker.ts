import {existsSync,mkdirSync,mkdtempSync,realpathSync,rmSync} from "node:fs";
import {join,sep} from "node:path";
import type {Job,DurableJobStore} from "./index";
import type {PostgresJobStore} from "../../storage/src/jobs";
import {PostgresCostLedger} from "../../storage/src/ledger";
import type {WorkerContext} from "./worker";
import {assertDeliveryPermission,assertDeliverySourceAvailable,deliveryFileName,validateDeliveryJob} from "../../planner/src/delivery-jobs";
import {renderDeliveryJob,sealDeliveryJob,verifyDeliveryMedia,DeliveryMediaError} from "../../generator/src/delivery-media";
import {editWorkspaceGuard} from "../../generator/src/edit-workspace";
import {withEditSourceAccess} from "../../generator/src/edit-source-media";
import {copyDialogueFiles} from "../../generator/src/dialogue-replacement";

/**
 * HV-027-05: one deliverable, from a film this project still holds.
 *
 * A delivery job reads a finished film's retained bytes and writes one file. It dispatches no
 * provider, so there is nothing to reserve and nothing to reconcile; what it does need is the same
 * fenced permission re-read every other independent media job takes, because the film it is made
 * from may have been taken down since the job was admitted.
 */
export async function processDeliveryJob(job:Job,store:DurableJobStore|PostgresJobStore,artifactRoot:string,context:WorkerContext,workerId:string,leaseMs:number,signal:AbortSignal,now:()=>number,deadline:number):Promise<Job>{
  validateDeliveryJob(job);const plan=job.delivery!;
  if(plan.binding.storage!==(context.artifacts?"s3":"local"))throw new DeliveryMediaError("The delivery storage backend changed after admission.");
  mkdirSync(artifactRoot,{recursive:true});
  const root=realpathSync(artifactRoot),workspace=mkdtempSync(join(root,".delivery-worker-"));
  const disk=editWorkspaceGuard(root,()=>[workspace]);
  const access=async()=>{
    disk();signal.throwIfAborted();
    if(now()>deadline)throw new DeliveryMediaError("The delivery render exceeded its processing timeout.");
    await store.heartbeat(job.id,workerId,now(),leaseMs);
    if(context.ledger instanceof PostgresCostLedger)await context.ledger.assertDeliveryPermission(job,workerId,now());
    else{
      assertDeliveryPermission(plan,await context.projects?.peekProject(job.projectId),now());
      assertDeliverySourceAvailable(plan.binding,await store.get(plan.binding.source.jobId));
    }
  };
  try{
    await access();
    // A resumed job re-verifies what it already wrote instead of rendering it again: the deliverable
    // is one file and its checkpoint is the whole thing.
    //
    // Under `s3` the retained copy is fetched back through the artifact reader first. Verifying the
    // worker's own cache would check a file that is not the one anybody will be served -- and a job
    // resuming on another host, or after the cache was cleared, would have no file to check at all
    // and would die `failed` with its deliverable sitting safely in the object store.
    if(job.deliveryCheckpoint){
      if(context.artifacts){
        await withEditSourceAccess(access,signal,active=>
          copyDialogueFiles(job,[job.deliveryCheckpoint!.file],root,workspace,active,context.artifacts));
        await verifyDeliveryMedia(job,job.deliveryCheckpoint,root,access,signal,workspace);
      }else await verifyDeliveryMedia(job,job.deliveryCheckpoint,root,access,signal);
    }
    else{
      const result=await renderDeliveryJob(job,root,workspace,access,signal,context.artifacts);
      const output=await sealDeliveryJob(job,root,result,access,signal);
      if(context.artifacts)await context.artifacts.checkpointDelivery(job,workerId,output,leaseMs,signal,access);
      else{await verifyDeliveryMedia(job,output,root,access,signal);await access();await store.checkpointDelivery(job.id,workerId,output,now(),leaseMs);}
    }
    await access();
    const current=await store.get(job.id);
    if(!current?.deliveryCheckpoint)throw new DeliveryMediaError("This delivery job has no retained deliverable to publish.");
    return await store.completeDelivery(job.id,workerId,current.deliveryCheckpoint,now());
  }finally{
    // The guard cannot throw from here without replacing whatever the job was already reporting, so
    // a scratch path that has moved under us is left alone rather than removed blindly.
    if(existsSync(workspace)&&workspace.startsWith(root+sep)&&realpathSync(workspace)===workspace)rmSync(workspace,{recursive:true,force:true});
    // Under `s3` the local copy is a cache of something the object store now holds, and nothing
    // else counts it: the workspace guard walks only the workspace, and the retention sweeper only
    // clears purged projects. Left behind, every deliverable this worker ever made stays on its
    // disk for the life of the process.
    if(context.artifacts)try{
      const owner=join(root,job.projectId,job.id),retained=join(owner,deliveryFileName(plan));
      if(existsSync(retained)&&retained.startsWith(owner+sep)&&realpathSync(owner)===owner)rmSync(retained,{force:true});
    }catch{/* a cache that cannot be cleaned is not a reason to fail a finished job */}
  }
}
