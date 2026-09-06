import {existsSync,mkdirSync,mkdtempSync,realpathSync,renameSync,rmSync} from "node:fs";
import {join,resolve,sep} from "node:path";
import type {Job,DurableJobStore} from "./index";
import type {WorkerContext} from "./worker";
import type {PostgresJobStore} from "../../storage/src/jobs";
import {PostgresCostLedger} from "../../storage/src/ledger";
import {dialogueSourceJobId,assertDialogueAccess,assertDialogueSourceAvailable,validateDialogueJob} from "../../planner/src/dialogue-jobs";
import {DialogueReplacementError} from "../../planner/src/dialogue-replacement";
import {copyDialogueFiles,replaceLockedDialogue,sealDialogueExport,verifyDialogueMedia} from "../../generator/src/dialogue-replacement";
import {contentHash} from "../../generator/src/capabilities";

export async function processDialogueJob(job:Job,store:DurableJobStore|PostgresJobStore,artifactRoot:string,context:WorkerContext,
  workerId:string,leaseMs:number,signal:AbortSignal,now:()=>number,deadline:number):Promise<Job>{
  validateDialogueJob(job,now());const selected=job.dialogueReplacement!;
  if(selected.storage!==(context.artifacts?"s3":"local"))throw new DialogueReplacementError("The dialogue storage backend changed after admission.");
  const access=async()=>{
    signal.throwIfAborted();if(now()>deadline)throw new DialogueReplacementError("The dialogue job exceeded its processing timeout.");
    await store.heartbeat(job.id,workerId,now(),leaseMs);
    if(context.ledger instanceof PostgresCostLedger)await context.ledger.assertDialoguePermission(job,workerId,now());
    else {assertDialogueSourceAvailable(job,await store.get(dialogueSourceJobId(job)),now());assertDialogueAccess(selected.source,await context.projects?.peekProject(job.projectId),now(),selected.plan.baseline);}
  };
  await access();mkdirSync(artifactRoot,{recursive:true});const root=realpathSync(artifactRoot),scratch=mkdtempSync(join(root,".dialogue-worker-"));let owned:string|undefined,output:NonNullable<Job["output"]>|undefined;
  try{
    if(job.dialogueCheckpoint){
      output=job.dialogueCheckpoint;
      if(context.artifacts)await copyDialogueFiles(job,output.dialogue!.files,root,scratch,signal,context.artifacts);
      await verifyDialogueMedia(job,output,context.artifacts?scratch:root,signal,now());
    }else{
      const files=selected.plan.baseline?Object.values(selected.plan.baseline.files):[...Object.values(selected.plan.sourceFiles),...selected.source.output!.shotRenders!.flatMap(r=>r.files.audio?[r.files.audio]:[])];
      await copyDialogueFiles({id:dialogueSourceJobId(job),projectId:job.projectId},files,root,scratch,signal,context.artifacts);await access();
      const rendered=await replaceLockedDialogue(selected.source,selected.plan,scratch,job.id,access,signal);
      const jobRoot=resolve(root,job.projectId,job.id);mkdirSync(jobRoot,{recursive:true});if(realpathSync(jobRoot)!==jobRoot||!jobRoot.startsWith(root+sep))throw new DialogueReplacementError("The dialogue output escaped its job.");
      owned=join(jobRoot,"dialogue-"+crypto.randomUUID());await access();renameSync(rendered.directory,owned);
      const relocated={...rendered,directory:owned,mp4Path:join(owned,"export.mp4"),wavPath:join(owned,"dialogue.wav"),captionsPath:join(owned,"captions.vtt"),srtPath:join(owned,"captions.srt"),manifestPath:join(owned,"provenance.json"),hlsPlaylistPath:join(owned,"hls/index.m3u8")};
      output=await sealDialogueExport(job,relocated,root,signal);await access();
      if(context.artifacts)await context.artifacts.checkpointDialogue(job,workerId,output,leaseMs,signal);
      else await store.checkpointDialogue(job.id,workerId,output,now(),leaseMs);
    }
    await access();return await store.complete(job.id,workerId,output,now());
  }finally{
    // Each worker deletes only its own randomly named cache, never the source job or a resumed worker's cache.
    if(existsSync(scratch))rmSync(scratch,{recursive:true,force:true});
    if(owned&&existsSync(owned)){
      const latest=await store.get(job.id),saved=latest?.dialogueCheckpoint;
      if(context.artifacts||!saved||!output||contentHash(saved)!==contentHash(output))rmSync(owned,{recursive:true,force:true});
    }
  }
}
