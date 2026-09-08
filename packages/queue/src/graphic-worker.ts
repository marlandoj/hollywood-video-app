import {existsSync,mkdirSync,mkdtempSync,realpathSync,rmSync} from "node:fs";
import {join,resolve,sep} from "node:path";
import type {Job,DurableJobStore} from "./index";
import type {PostgresJobStore} from "../../storage/src/jobs";
import type {WorkerContext} from "./worker";
import {assertGraphicPermission,validateGraphicJob,type GraphicOutput} from "../../planner/src/graphic-jobs";
import {editFail} from "../../planner/src/edit-errors";
import {renderMotionGraphic} from "../../generator/src/graphic-render";
import {sealGraphicJob,verifyGraphicMedia} from "../../generator/src/graphic-media";
import {copyDialogueFiles} from "../../generator/src/dialogue-replacement";
import {contentHash} from "../../generator/src/capabilities";
import {assertEditFreeSpace} from "../../generator/src/edit-workspace";
import {withEditSourceAccess} from "../../generator/src/edit-source-media";
import {checkPrompt,SafetyRefusalError} from "../../safety/src/index";
export async function processGraphicJob(job:Job,store:DurableJobStore|PostgresJobStore,artifactRoot:string,context:WorkerContext,workerId:string,leaseMs:number,signal:AbortSignal,now:()=>number,deadline:number):Promise<Job>{
  validateGraphicJob(job);const plan=job.graphicRender!;if(plan.storage!==(context.artifacts?"s3":"local"))editFail("The graphic storage backend changed after admission.");
  const p=plan.spec.plan,verdict=checkPrompt([p.text,p.secondary,...p.credits.flatMap(c=>[c.role,c.name])].join("\n"));if(!verdict.allowed)throw new SafetyRefusalError(verdict);
  const access=async()=>{signal.throwIfAborted();if(now()>deadline)editFail("The graphic exceeded its processing timeout.");await store.heartbeat(job.id,workerId,now(),leaseMs);assertGraphicPermission(plan,await context.projects?.peekProject(job.projectId),now());const current=await store.get(job.id);if(current?.graphicRender?.revision!==plan.revision)editFail("The graphic plan changed during processing.");};
  await access();mkdirSync(artifactRoot,{recursive:true});const root=realpathSync(artifactRoot),scratch=mkdtempSync(join(root,".graphic-worker-"));let owned:string|undefined,output:GraphicOutput|undefined;
  try{
    if(job.graphicCheckpoint){output=job.graphicCheckpoint;if(context.artifacts){assertEditFreeSpace(root,output.files.reduce((n,f)=>n+f.bytes,0)*2);await withEditSourceAccess(access,signal,active=>copyDialogueFiles(job,output!.files,root,scratch,active,context.artifacts));}await verifyGraphicMedia(job,output,context.artifacts?scratch:root,access,signal);}
    else{
      const chromePath=context.graphics?.chromePath??process.env.HV_GRAPHICS_CHROME_PATH;if(!chromePath)editFail("Install the pinned graphics browser before rendering.");const parent=resolve(root,job.projectId,job.id);mkdirSync(parent,{recursive:true});if(realpathSync(parent)!==parent||!parent.startsWith(root+sep))editFail("The graphic output escaped its job.");let progressAt=-Infinity;
      const rendered=await renderMotionGraphic(plan.spec.plan,parent,{chromePath,signal,access,progress:async(completed,_total,phase)=>{if(phase!=="capture"||now()-progressAt>=1000||completed===job.totalFrames){await store.progressGraphic(job.id,workerId,{phase,capturedFrames:completed,at:new Date(now()).toISOString()},now(),leaseMs);progressAt=now();}}});owned=rendered.directory;
      output=await sealGraphicJob(job,root,owned,rendered.receipt,access,signal);await store.progressGraphic(job.id,workerId,{phase:"retain",capturedFrames:job.totalFrames,at:new Date(now()).toISOString()},now(),leaseMs);
      if(context.artifacts)await context.artifacts.checkpointGraphic(job,workerId,output,leaseMs,signal,access);else{await access();await store.checkpointGraphic(job.id,workerId,output,now(),leaseMs);}
    }
    await access();return await store.completeGraphic(job.id,workerId,output,now());
  }finally{
    if(existsSync(scratch)){if(!scratch.startsWith(root+sep)||realpathSync(scratch)!==scratch)editFail("Graphic scratch escaped its workspace.");rmSync(scratch,{recursive:true,force:true});}
    if(owned&&existsSync(owned)){const current=await store.get(job.id);if(context.artifacts||!current?.graphicCheckpoint||!output||contentHash(current.graphicCheckpoint)!==contentHash(output)){if(!owned.startsWith(resolve(root,job.projectId,job.id)+sep)||realpathSync(owned)!==owned)editFail("Graphic cleanup escaped its owner.");rmSync(owned,{recursive:true,force:true});}}
  }
}
