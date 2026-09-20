import {existsSync,mkdirSync,mkdtempSync,realpathSync,rmSync} from "node:fs";
import {join,resolve,sep} from "node:path";
import type {Job,DurableJobStore} from "./index";
import type {PostgresJobStore} from "../../storage/src/jobs";
import {PostgresCostLedger} from "../../storage/src/ledger";
import type {WorkerContext} from "./worker";
import {assertEditBindingAvailable} from "../../planner/src/edit-jobs";
import {assertEditAssemblyPermission,validateEditAssemblyOutput} from "../../planner/src/edit-assembly-jobs";
import {validateEditAssemblyJob} from "../../planner/src/edit-assembly-job-context";
import {editFail} from "../../planner/src/edit-timeline";
import {renderEditAssemblyJob,sealEditAssemblyJob,verifyEditAssemblyMedia,type AssemblyMediaOutput} from "../../generator/src/edit-assembly-media";
import {copyDialogueFiles} from "../../generator/src/dialogue-replacement";
import {contentHash} from "../../generator/src/capabilities";
import {assertEditFreeSpace,editWorkspaceGuard} from "../../generator/src/edit-workspace";
import {withEditSourceAccess} from "../../generator/src/edit-source-media";
import {throttledEditAccess} from "./edit-access";

export async function processEditAssemblyJob(job:Job,store:DurableJobStore|PostgresJobStore,artifactRoot:string,context:WorkerContext,workerId:string,leaseMs:number,signal:AbortSignal,now:()=>number,deadline:number):Promise<Job>{
  validateEditAssemblyJob(job,job.assemblyCheckpoint?undefined:now());const plan=job.assemblyEdit!,mediaJob={...job,assemblyEdit:plan};if(plan.storage!==(context.artifacts?"s3":"local"))editFail("The assembly storage backend changed after admission.");
  // HV-025-06: media verification calls access() before every retained file it hashes, as the
  // picture edit does (HV-025-05). The lease and permission check runs at most once a second, and is
  // forced before admission, checkpoint and completion; abort and deadline still run on every call.
  const gate=throttledEditAccess(()=>{signal.throwIfAborted();if(now()>deadline)editFail("The assembly render exceeded its processing timeout.");},async()=>{
    await store.heartbeat(job.id,workerId,now(),leaseMs);
    if(context.ledger instanceof PostgresCostLedger)await context.ledger.assertAssemblyContext(job,workerId,now());
    else{
      assertEditAssemblyPermission(plan,await context.projects?.peekProject(job.projectId),now());const current=await store.get(job.id);
      if(!current?.assemblyEdit||contentHash(current.assemblyEdit)!==contentHash(plan))editFail("The assembly plan changed during processing.");
      if(current.assemblyCheckpoint)validateEditAssemblyOutput(mediaJob,current.assemblyCheckpoint);else for(const binding of plan.bindings)assertEditBindingAvailable(binding,await store.get(binding.owner.jobId),now());
    }
  }),access=()=>gate(),verified=()=>gate(true);
  await verified();mkdirSync(artifactRoot,{recursive:true});const root=realpathSync(artifactRoot),scratch=mkdtempSync(join(root,".assembly-worker-"));let owned:string|undefined,output:AssemblyMediaOutput|undefined;
  try{
    if(job.assemblyCheckpoint){
      validateEditAssemblyOutput(mediaJob,job.assemblyCheckpoint);output=job.assemblyCheckpoint as AssemblyMediaOutput;
      if(context.artifacts){assertEditFreeSpace(root,output.assembly.files.reduce((bytes,file)=>bytes+file.bytes,0)*3);const disk=editWorkspaceGuard(root,()=>[scratch]);await withEditSourceAccess(async()=>{disk();await access();},signal,active=>copyDialogueFiles(job,output!.assembly.files,root,scratch,active,context.artifacts));}
      await verifyEditAssemblyMedia(mediaJob,output,context.artifacts?scratch:root,access,signal);
    }else{
      const jobRoot=resolve(root,job.projectId,job.id);mkdirSync(jobRoot,{recursive:true});if(realpathSync(jobRoot)!==jobRoot||!jobRoot.startsWith(root+sep))editFail("The assembly output escaped its job.");owned=join(jobRoot,"assembly-"+crypto.randomUUID());
      const result=await renderEditAssemblyJob(mediaJob,root,owned,access,signal,context.artifacts);output=await sealEditAssemblyJob(mediaJob,root,owned,result,signal);
      if(context.artifacts)await context.artifacts.checkpointAssembly(job,workerId,output,leaseMs,signal,access);
      else{await verifyEditAssemblyMedia(mediaJob,output,root,access,signal);await verified();await store.checkpointAssembly(job.id,workerId,output,now(),leaseMs);}
    }
    await verified();return await store.complete(job.id,workerId,output,now());
  }finally{
    if(existsSync(scratch)){if(!scratch.startsWith(root+sep)||realpathSync(scratch)!==scratch)editFail("Assembly worker scratch escaped its workspace.");rmSync(scratch,{recursive:true,force:true});}
    if(owned&&existsSync(owned)){const current=await store.get(job.id);if(context.artifacts||!current?.assemblyCheckpoint||!output||contentHash(current.assemblyCheckpoint)!==contentHash(output)){if(!owned.startsWith(resolve(root,job.projectId,job.id)+sep)||realpathSync(owned)!==owned)editFail("Assembly worker output escaped its owner.");rmSync(owned,{recursive:true,force:true});}}
  }
}
