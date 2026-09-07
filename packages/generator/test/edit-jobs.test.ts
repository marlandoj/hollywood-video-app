import {expect,test} from "bun:test";
import {join,sep} from "node:path";
import {readFileSync,realpathSync,renameSync,writeFileSync,existsSync} from "node:fs";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspectEditSource} from "../src/edit-source-media";
import {renderEditJob,sealEditJob,verifyEditMedia} from "../src/edit-media";
import {soundRuntimeRevision} from "../src/sound-audio";
import {contentHash} from "../src/capabilities";
import {bindOriginalEditSource,bindRetainedEditSource,assertEditBindingAvailable,assertEditPermission,createEditPlan,editRenderReview,validateEditPlan,type EditPlan} from "../../planner/src/edit-jobs";
import {editHistoryState} from "../../planner/src/edit-history";
import {DurableJobStore,type JobInput} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {outputRevision} from "../../planner/src/dialogue-selection";
import {validateSnapshot,type StateSnapshot} from "../../storage/src/snapshots";
function input(plan:EditPlan):JobInput {const source=plan.bindings[0]!.source.job;return {id:crypto.randomUUID(),idempotencyKey:crypto.randomUUID(),projectId:source.projectId,tier:"free",stage:"picture-edit",scriptVersion:source.scriptVersion,scriptText:source.scriptText,rightsAttestedAt:source.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,totalFrames:validateEditPlan(plan).frames,costCapUsd:0,budgetReservedUsd:0,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:120000,pictureEdit:plan};}
test("editorial jobs checkpoint exact conforms and continue from owned originals without the first source job or files",async()=>{
  const f=await dubStudio();try{
    const root=f.paths.artifactRoot,receipt=await inspectEditSource(f.film,"Original performances",root,async()=>{}),sequenceId=crypto.randomUUID();
    let library=f.projects.createEditSequence(f.owner.token,[receipt],sequenceId,"Reordered cut",f.film.id,640,360,0)!;
    library=f.projects.changeEditSequence(f.owner.token,sequenceId,{kind:"edit",label:"Split opening",operation:{kind:"split",clipId:"initial-0",linked:true,at:30,rightIds:{"initial-0":"later-picture","initial-1":"later-mix","initial-2":"later-captions"},rightLink:"later"}},library.version,library.sequences[0]!.history.revision)!;
    library=f.projects.changeEditSequence(f.owner.token,sequenceId,{kind:"edit",label:"Move later read first",operation:{kind:"reorder",clipId:"later-picture",at:0}},library.version,library.sequences[0]!.history.revision)!;
    const sequence=library.sequences[0]!,timeline=editHistoryState(sequence.history).timeline,plan=createEditPlan(sequence,[bindOriginalEditSource(receipt)],soundRuntimeRevision(),"local",contentHash("first"),editRenderReview(timeline)),submitted=input(plan),store=DurableJobStore.fromJobs([f.film]);
    expect(store.enqueue(submitted).pictureEdit).toEqual(plan);expect(store.enqueue(submitted).id).toBe(submitted.id);
    expect(()=>store.enqueue({...submitted,pictureEdit:{...plan,revision:"0".repeat(64)}})).toThrow("different editorial plan");
    const job=store.claimNext(Date.now(),{},{workerId:"editor"})!,access=async()=>{store.heartbeat(job.id,"editor");assertEditPermission(plan,f.projects.peekProject(f.owner.projectId));for(const binding of plan.bindings)assertEditBindingAvailable(binding,store.get(binding.owner.jobId));};
    expect(()=>store.checkpoint(job.id,"editor",1,1)).toThrow("owned media checkpoint");
    const directory=join(root,job.projectId,job.id,"edit"),render=await renderEditJob(job,root,directory,access),output=await sealEditJob(job,root,directory,render);await verifyEditMedia(job,output,root,access);
    expect(()=>store.complete(job.id,"editor",output)).toThrow("saved editorial checkpoint");
    expect(()=>store.checkpointEdit(job.id,"other-worker",output)).toThrow();store.checkpointEdit(job.id,"editor",output);const done=store.complete(job.id,"editor",output);expect(done.costUsd).toBe(0);expect(done.cost).toBeUndefined();
    expect(output.editorial!.conform.audio.final).not.toBe(output.editorial!.prepared.sources[0]!.media.audio.mix!.sha256);
    const retained=bindRetainedEditSource(done,receipt.revision);expect(retained.source).toEqual(receipt);expect(retained.files.find((_,i)=>receipt.files[i]!.path===f.film.output!.mp4Path)!.sha256).toBe(receipt.files.find(file=>file.path===f.film.output!.mp4Path)!.sha256);
    const continued=createEditPlan(sequence,[retained],plan.engineVersion,"local",contentHash("second"),editRenderReview(timeline)),next=input(continued),onlyEdited=DurableJobStore.fromJobs([done]);onlyEdited.enqueue(next);
    const original=realpathSync(join(root,f.film.projectId,f.film.id));if(!original.startsWith(realpathSync(root)+sep))throw new Error("Unsafe editorial recovery fixture");renameSync(original,original+"-hidden");
    try{
      const context={projects:f.projects,ledger:f.ledger,reviewQueue:f.reviews,workerId:"continued"},nextJob=(await processNextJob(onlyEdited,root,context))!;expect(nextJob.failureReason??nextJob.cancelReason).toBeUndefined();expect(nextJob.status).toBe("done");const nextOutput=nextJob.output!;
      expect(nextOutput.editorial!.conform.pictureFrames).toEqual(output.editorial!.conform.pictureFrames);expect(nextOutput.editorial!.conform.audio).toEqual(output.editorial!.conform.audio);
      expect(nextOutput.editorial!.plan.bindings[0]!.owner.jobId).toBe(done.id);expect(nextOutput.editorial!.plan.bindings[0]!.source.job.pictureEdit).toBeUndefined();
      expect(readFileSync(join(root,nextOutput.editorial!.prepared.sources[0]!.media.picture.path))).toEqual(readFileSync(join(root,output.editorial!.prepared.sources[0]!.media.picture.path)));
      const carrier=realpathSync(join(root,done.projectId,done.id));if(!carrier.startsWith(realpathSync(root)+sep))throw new Error("Unsafe editorial carrier fixture");renameSync(carrier,carrier+"-hidden");
      try{
        const recovering=DurableJobStore.fromJobs([{...nextJob,status:"running",output:undefined,completedAt:null,linkExpiresAt:null,leaseExpiresAt:new Date(0).toISOString()}]);
        const recovered=(await processNextJob(recovering,root,{...context,workerId:"recovery"}))!;expect(recovered.failureReason??recovered.cancelReason).toBeUndefined();expect(recovered.status).toBe("done");expect(recovered.output).toEqual(nextOutput);expect(recovered.resumedCount).toBe(1);expect(recovered.costUsd).toBe(0);
        writeFileSync(f.paths.queuePath,JSON.stringify([recovered]));
        const view=await(await f.call("/api/jobs/"+next.id,"GET",undefined,f.owner.token)).json() as any;expect(view.pictureEdit.sequenceId).toBe(sequence.id);expect(view.pictureEdit.bindings).toBeUndefined();expect(view.editCheckpoint).toBeUndefined();
        for(const key of ["mp4Url","captionsUrl","deliveryMasterUrl","timelineUrl","conformReportUrl"]){expect(view.output[key]).toContain("/artifacts/");expect((await fetch(new URL(view.output[key],f.server.url))).status).toBe(200);}
        expect((await f.call(f.base+"/dialogue-selection","PUT",{jobId:next.id,sourceJobId:sequence.id,expectedVersion:0,expectedOutputRevision:outputRevision(recovered)},f.owner.token)).status).toBe(200);
        const snapshot:StateSnapshot={schema:"hv-state/4",projects:JSON.parse(readFileSync(f.paths.statePath,"utf8")),jobs:[recovered],ledger:{events:[],reservations:[]},reviews:[]};expect(validateSnapshot(snapshot).jobs).toHaveLength(1);expect(()=>validateSnapshot({...snapshot,schema:"hv-state/3"})).toThrow("schema 4");
      }finally{renameSync(carrier+"-hidden",carrier);}
      const denied=input(continued),deniedStore=DurableJobStore.fromJobs([done]);deniedStore.enqueue(denied);
      const rejected=await processNextJob(deniedStore,root,{...context,projects:{peekProject:()=>null}});expect(rejected?.status).toBeOneOf(["failed","cancelled"]);expect(rejected?.editCheckpoint).toBeUndefined();expect(existsSync(join(root,denied.projectId,denied.id))).toBe(false);
      const cancelled=input(continued),cancelledStore=DurableJobStore.fromJobs([done]);cancelledStore.enqueue(cancelled);
      expect((await processNextJob(cancelledStore,root,{...context,onJobStarted:async j=>{cancelledStore.cancel(j.id,"continued","Cancel test");}}))?.status).toBe("cancelled");expect(existsSync(join(root,cancelled.projectId,cancelled.id))).toBe(false);
      expect(f.ledger.all().filter(e=>[next.id,denied.id,cancelled.id].includes(e.jobId??""))).toHaveLength(0);
    }finally{renameSync(original+"-hidden",original);}
    expect(()=>createEditPlan(sequence,[retained],plan.engineVersion,"local",contentHash("unreviewed"),{...editRenderReview(timeline),accepted:false})).toThrow("Review the current");
  }finally{await f.close();}
},180000);
