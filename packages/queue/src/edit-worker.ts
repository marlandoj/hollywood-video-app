import {existsSync,mkdirSync,mkdtempSync,realpathSync,rmSync} from "node:fs";
import {join,resolve,sep} from "node:path";
import type {Job,DurableJobStore} from "./index";
import type {PostgresJobStore} from "../../storage/src/jobs";
import {PostgresCostLedger} from "../../storage/src/ledger";
import type {WorkerContext} from "./worker";
import {assertEditBindingAvailable,assertEditPermission,validateEditJob,validateEditOutput} from "../../planner/src/edit-jobs";
import {editFail} from "../../planner/src/edit-timeline";
import {renderEditJob,sealEditJob,verifyEditMedia} from "../../generator/src/edit-media";
import {copyDialogueFiles} from "../../generator/src/dialogue-replacement";
import {contentHash} from "../../generator/src/capabilities";
import {assertEditFreeSpace,editWorkspaceGuard} from "../../generator/src/edit-workspace";
import {withEditSourceAccess} from "../../generator/src/edit-source-media";
import {throttledEditAccess} from "./edit-access";
export async function processEditJob(job:Job,store:DurableJobStore|PostgresJobStore,artifactRoot:string,context:WorkerContext,workerId:string,leaseMs:number,signal:AbortSignal,now:()=>number,deadline:number):Promise<Job>{
  validateEditJob(job,job.editCheckpoint?undefined:now());const plan=job.pictureEdit!;if(plan.storage!==(context.artifacts?"s3":"local"))editFail("The editorial storage backend changed after admission.");
  // HV-025-05: media verification calls access() before every retained file, and a picture edit
  // retains every graphic frame. The lease and permission check runs at most once a second, as the
  // workspace guard does, and always before admission, checkpoint and completion.
  const gate=throttledEditAccess(()=>{signal.throwIfAborted();if(now()>deadline)editFail("The editorial render exceeded its processing timeout.");},async()=>{
    await store.heartbeat(job.id,workerId,now(),leaseMs);
    if(context.ledger instanceof PostgresCostLedger)await context.ledger.assertEditPermission(job,workerId,now());
    else{const project=await context.projects?.peekProject(job.projectId);assertEditPermission(plan,project,now());const current=await store.get(job.id);if(current?.editCheckpoint)validateEditOutput(current,current.editCheckpoint);else for(const binding of plan.bindings)assertEditBindingAvailable(binding,await store.get(binding.owner.jobId),now());}
  }),access=()=>gate(),verified=()=>gate(true);
  await verified();mkdirSync(artifactRoot,{recursive:true});const root=realpathSync(artifactRoot),scratch=mkdtempSync(join(root,".edit-worker-"));let owned:string|undefined,output:NonNullable<Job["output"]>|undefined;
  try{
    if(job.editCheckpoint){output=job.editCheckpoint;if(context.artifacts){assertEditFreeSpace(root,output.editorial!.files.reduce((n,f)=>n+f.bytes,0)*3);const disk=editWorkspaceGuard(root,()=>[scratch]);await withEditSourceAccess(async()=>{disk();await access();},signal,active=>copyDialogueFiles(job,output!.editorial!.files,root,scratch,active,context.artifacts));}await verifyEditMedia(job,output,context.artifacts?scratch:root,access,signal);}
    else{
      const jobRoot=resolve(root,job.projectId,job.id);mkdirSync(jobRoot,{recursive:true});if(realpathSync(jobRoot)!==jobRoot||!jobRoot.startsWith(root+sep))editFail("The editorial output escaped its job.");owned=join(jobRoot,"edit-"+crypto.randomUUID());
      const report=await renderEditJob(job,root,owned,access,signal,context.artifacts);output=await sealEditJob(job,root,owned,report,signal);
      if(context.artifacts)await context.artifacts.checkpointEdit(job,workerId,output,leaseMs,signal,access);
      else{await verifyEditMedia(job,output,root,access,signal);await verified();await store.checkpointEdit(job.id,workerId,output,now(),leaseMs);}
    }
    await verified();return await store.complete(job.id,workerId,output,now());
  }finally{
    if(existsSync(scratch)){if(!scratch.startsWith(root+sep)||realpathSync(scratch)!==scratch)editFail("Editorial worker scratch escaped its workspace.");rmSync(scratch,{recursive:true,force:true});}
    if(owned&&existsSync(owned)){const current=await store.get(job.id);if(context.artifacts||!current?.editCheckpoint||!output||contentHash(current.editCheckpoint)!==contentHash(output)){if(!owned.startsWith(resolve(root,job.projectId,job.id)+sep)||realpathSync(owned)!==owned)editFail("Editorial worker output escaped its owner.");rmSync(owned,{recursive:true,force:true});}}
  }
}
