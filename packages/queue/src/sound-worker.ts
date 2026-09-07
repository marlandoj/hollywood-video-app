import {existsSync,mkdirSync,mkdtempSync,realpathSync,rmSync} from "node:fs";
import {join,resolve,sep} from "node:path";
import type {Job,DurableJobStore} from "./index";
import type {WorkerContext} from "./worker";
import type {PostgresJobStore} from "../../storage/src/jobs";
import {PostgresCostLedger} from "../../storage/src/ledger";
import {SoundBlobStore} from "../../storage/src/sound-assets";
import {objectClient} from "../../storage/src/artifacts";
import {assertSoundPermission,assertSoundSourceAvailable,validateSoundJob} from "../../planner/src/sound-jobs";
import {soundFail} from "../../planner/src/sound-assets";
import {renderSoundMix,sealSoundMix,verifySoundMedia} from "../../generator/src/sound-media";
import {copyDialogueFiles} from "../../generator/src/dialogue-replacement";
import {contentHash} from "../../generator/src/capabilities";
export async function processSoundJob(job:Job,store:DurableJobStore|PostgresJobStore,artifactRoot:string,context:WorkerContext,workerId:string,leaseMs:number,signal:AbortSignal,now:()=>number,deadline:number):Promise<Job>{
  validateSoundJob(job,now());const plan=job.soundMix!;if(plan.storage!==(context.artifacts?"s3":"local"))soundFail("The sound storage backend changed after admission.");
  const access=async()=>{signal.throwIfAborted();if(now()>deadline)soundFail("The sound job exceeded its processing timeout.");await store.heartbeat(job.id,workerId,now(),leaseMs);if(context.ledger instanceof PostgresCostLedger)await context.ledger.assertSoundPermission(job,workerId,now());else{const project=await context.projects?.peekProject(job.projectId);assertSoundSourceAvailable(plan,await store.get(plan.source.jobId),now());assertSoundPermission(plan,project,now());}};
  await access();mkdirSync(artifactRoot,{recursive:true});const root=realpathSync(artifactRoot),scratch=mkdtempSync(join(root,".sound-worker-")),blobs=new SoundBlobStore(root,context.artifacts?objectClient():undefined);let owned:string|undefined,output:NonNullable<Job["output"]>|undefined;
  try{
    if(job.soundCheckpoint){output=job.soundCheckpoint;if(context.artifacts)await copyDialogueFiles(job,output.sound!.files,root,scratch,signal,context.artifacts);await verifySoundMedia(job,output,context.artifacts?scratch:root,signal);}
    else{const jobRoot=resolve(root,job.projectId,job.id);mkdirSync(jobRoot,{recursive:true});if(realpathSync(jobRoot)!==jobRoot||!jobRoot.startsWith(root+sep))soundFail("The sound output escaped its job.");owned=join(jobRoot,"sound-"+crypto.randomUUID());
      const report=await renderSoundMix(job,root,owned,(asset,kind)=>blobs.read(asset,kind),access,signal,context.artifacts);output=await sealSoundMix(job,owned,root,report,signal);await verifySoundMedia(job,output,root,signal);await access();
      if(context.artifacts)await context.artifacts.checkpointSound(job,workerId,output,leaseMs,signal);else await store.checkpointSound(job.id,workerId,output,now(),leaseMs);
    }
    await access();return await store.complete(job.id,workerId,output,now());
  }finally{
    if(existsSync(scratch)){if(!scratch.startsWith(root+sep)||realpathSync(scratch)!==scratch)soundFail("The sound worker scratch escaped its workspace.");rmSync(scratch,{recursive:true,force:true});}
    if(owned&&existsSync(owned)){const current=await store.get(job.id);if(context.artifacts||!current?.soundCheckpoint||!output||contentHash(current.soundCheckpoint)!==contentHash(output)){if(!owned.startsWith(resolve(root,job.projectId,job.id)+sep)||realpathSync(owned)!==owned)soundFail("The sound worker output escaped its job.");rmSync(owned,{recursive:true,force:true});}}
  }
}
