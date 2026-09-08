import {expect,test} from "bun:test";
import {existsSync,readFileSync,realpathSync,renameSync,writeFileSync} from "node:fs";
import {join,sep} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {DurableJobStore} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {contentHash} from "../src/capabilities";
import {bindRetainedEditSource,assertEditBindingAvailable} from "../../planner/src/edit-jobs";
import {validateEditAssemblyJob} from "../../planner/src/edit-assembly-job-context";
import {stateSnapshotSchema,validateSnapshot,type StateSnapshot} from "../../storage/src/snapshots";

test("owner assembly jobs retain independent exports and recover checkpoints without earlier carriers while enforcing current rights",async()=>{
  const f=await dubStudio();try{
    const base=f.base+"/editorial",call=(path:string,method="GET",body?:unknown)=>f.call(base+path,method,body,f.owner.token);
    const ok=async(path:string,method="GET",body?:unknown,status=200)=>{const response=await call(path,method,body),value=await response.json() as any;expect(value.error).toBeUndefined();expect(response.status).toBe(status);return value;};
    const source=(await ok("/sources/"+f.film.id)).sources[0],sequenceId=crypto.randomUUID();
    const parent=await ok("/sequences","POST",{id:sequenceId,label:"Assembly parent",sources:[{jobId:f.film.id,sourceRevision:source.sourceRevision}],firstSourceId:f.film.id,width:32,height:24,expectedVersion:0},201);
    const proposal=await ok("/assemblies/proposals","POST",{sequenceId,input:{id:crypto.randomUUID(),label:"Repeated short cut",purpose:"trailer",ranges:[{id:"later",fromFrame:20,toFrame:30,reason:"Later read first."},{id:"earlier",fromFrame:0,toFrame:5,reason:"Return to opening."},{id:"repeat",fromFrame:20,toFrame:25,reason:"Repeat the selected beat."}]},expected:{libraryVersion:0,historyRevision:parent.sequence.history.revision}},201);
    const accepted=await ok("/assemblies/proposals/"+proposal.item.id+"/accept","POST",{proposalRevision:proposal.item.revision,assemblyId:crypto.randomUUID(),expected:{libraryVersion:proposal.libraryVersion,historyRevision:parent.sequence.history.revision},reviewRevision:proposal.review.revision,boundariesRevision:proposal.boundaries.revision,sourceBindingsRevision:proposal.sourceBindingsRevision,accepted:true},201);
    const route="/assemblies/accepted/"+accepted.item.id+"/renders",quote=await ok(route);
    expect(quote.resources.childFrames).toBe(20);expect(quote.costUsd).toBe(0);expect(quote.review.accepted).toBe(false);expect(quote.review.sourceBindingsRevision).toBe(quote.sourceBindingsRevision);expect(contentHash(quote.parentReview.review)).toBe(quote.review.parentReviewRevision);
    const payload={idempotencyKey:crypto.randomUUID(),generationApproved:true,assemblyRevision:quote.assembly.revision,sourceBindingsRevision:quote.sourceBindingsRevision,engineVersion:quote.engineVersion,review:{...quote.review,accepted:true}},before=f.store.all().length;
    for(const altered of [{...payload,generationApproved:false},{...payload,review:{...payload.review,accepted:false}},{...payload,sourceBindingsRevision:contentHash("changed")},{...payload,review:{...payload.review,parentReviewRevision:contentHash("unreviewed parent")}},{...payload,extra:true}])expect((await call(route,"POST",altered)).status).toBe(400);
    expect(f.store.all()).toHaveLength(before);
    const admitted=await ok(route,"POST",payload,202),submitted=f.store.get(admitted.jobId)!;expect(submitted.stage).toBe("assembly-edit");expect(submitted.assemblyEdit!.assembly.id).toBe(accepted.item.id);
    expect((await ok(route,"POST",payload,202)).jobId).toBe(submitted.id);expect((await call(route,"POST",{...payload,review:{...payload.review,accepted:false}})).status).toBe(400);
    for(const changed of [{...submitted,pictureEdit:{}},{...submitted,stage:"final"},{...submitted,providerSpec:"mock"},{...submitted,costUsd:.01},{...submitted,totalFrames:21}])expect(()=>validateEditAssemblyJob(changed as any)).toThrow();
    const done=(await f.worker())!;expect(done.failureReason??done.cancelReason).toBeUndefined();expect(done.status).toBe("done");expect(done.id).toBe(submitted.id);expect(done.costUsd).toBe(0);expect(done.cost).toBeUndefined();expect(done.assemblyCheckpoint).toEqual(done.output);expect(done.output!.assembly!.conform.picture.pictureFrames).toHaveLength(20);
    const viewResponse=await f.call("/api/jobs/"+done.id,"GET",undefined,f.owner.token),view=await viewResponse.json() as any;expect(viewResponse.status).toBe(200);expect(view.assemblyEdit.assemblyId).toBe(accepted.item.id);expect(view.assemblyEdit.bindings).toBeUndefined();expect(view.assemblyEdit.assembly).toBeUndefined();expect(view.assemblyCheckpoint).toBeUndefined();
    for(const key of ["mp4Url","captionsUrl","assemblyUrl","timelineUrl","conformReportUrl","deliveryMasterUrl"]){expect(view.output[key]).toContain("/artifacts/");expect((await fetch(new URL(view.output[key],f.server.url))).status).toBe(200);}
    expect((await f.call(f.base+"/dialogue-selection","PUT",{jobId:done.id,sourceJobId:accepted.item.id,expectedVersion:0,expectedOutputRevision:view.outputRevision},f.owner.token)).status).toBe(200);
    const binding=bindRetainedEditSource(done,source.sourceRevision);expect(binding.source.job.id).toBe(f.film.id);assertEditBindingAvailable(binding,done);
    const root=realpathSync(f.paths.artifactRoot),original=realpathSync(join(root,f.film.projectId,f.film.id));if(!original.startsWith(root+sep))throw new Error("Unsafe assembly source fixture");renameSync(original,original+"-hidden");
    try{
      writeFileSync(f.paths.queuePath,JSON.stringify(f.store.all().filter(job=>job.id!==f.film.id)));
      const nextQuote=await ok(route);expect(nextQuote.sourceBindingsRevision).not.toBe(quote.sourceBindingsRevision);
      const nextBody={...payload,idempotencyKey:crypto.randomUUID(),sourceBindingsRevision:nextQuote.sourceBindingsRevision,review:{...nextQuote.review,accepted:true}},next=await ok(route,"POST",nextBody,202),second=(await f.worker())!;
      expect(second.id).toBe(next.jobId);expect(second.failureReason??second.cancelReason).toBeUndefined();expect(second.status).toBe("done");expect(second.output!.assembly!.conform.picture.pictureFrames).toEqual(done.output!.assembly!.conform.picture.pictureFrames);expect(second.output!.assembly!.conform.audio.audio).toEqual(done.output!.assembly!.conform.audio.audio);
      const firstCarrier=realpathSync(join(root,done.projectId,done.id));if(!firstCarrier.startsWith(root+sep))throw new Error("Unsafe assembly carrier fixture");renameSync(firstCarrier,firstCarrier+"-hidden");
      try{
        const interrupted={...second,status:"running" as const,output:undefined,completedAt:null,linkExpiresAt:null,leaseExpiresAt:new Date(0).toISOString()},recovery=DurableJobStore.fromJobs([interrupted]);
        const recovered=(await processNextJob(recovery,root,{projects:f.projects,ledger:f.ledger,reviewQueue:f.reviews,workerId:"assembly-recovery"}))!;
        expect(recovered.failureReason??recovered.cancelReason).toBeUndefined();expect(recovered.status).toBe("done");expect(recovered.output).toEqual(second.output);expect(recovered.resumedCount).toBe(1);expect(recovered.costUsd).toBe(0);
        const snapshot:StateSnapshot={schema:"hv-state/7",projects:JSON.parse(readFileSync(f.paths.statePath,"utf8")),jobs:[recovered],ledger:{events:[],reservations:[]},reviews:[]};expect(validateSnapshot(snapshot).jobs).toHaveLength(1);expect(()=>validateSnapshot({...snapshot,schema:"hv-state/6"})).toThrow();
        for(const status of ["failed","cancelled"] as const){const abandoned={...recovered,status,output:undefined,completedAt:null,linkExpiresAt:null};expect(validateSnapshot({...snapshot,jobs:[abandoned]}).jobs[0]!.assemblyCheckpoint).toEqual(recovered.output);}
        for(const status of ["queued","running"] as const)expect(()=>validateSnapshot({...snapshot,jobs:[{...recovered,status,output:undefined,completedAt:null,linkExpiresAt:null}]})).toThrow("drained");
        const projectOnly=structuredClone(snapshot.projects);for(const project of projectOnly.projects)delete project.assemblyLibrary;expect(stateSnapshotSchema(projectOnly,[recovered])).toBe("hv-state/7");expect(validateSnapshot({...snapshot,projects:projectOnly}).jobs).toHaveLength(1);
        writeFileSync(f.paths.queuePath,JSON.stringify([recovered]));
        const freshView=await(await f.call("/api/jobs/"+recovered.id,"GET",undefined,f.owner.token)).json() as any;
        expect(f.projects.revokeCharacterPermission(f.owner.token,f.id,1)).not.toBeNull();
        expect((await fetch(new URL(freshView.output.mp4Url,f.server.url))).status).toBe(404);
        const denied=DurableJobStore.fromJobs([interrupted]),failed=(await processNextJob(denied,root,{projects:f.projects,ledger:f.ledger,reviewQueue:f.reviews,workerId:"assembly-denied"}))!;expect(failed.status).toBeOneOf(["failed","cancelled"]);expect(failed.output).toBeUndefined();expect(existsSync(join(root,second.projectId,second.id))).toBe(true);
      }finally{renameSync(firstCarrier+"-hidden",firstCarrier);}
    }finally{renameSync(original+"-hidden",original);}
    expect(f.ledger.all().filter(event=>event.stage==="assembly-edit")).toHaveLength(0);
  }finally{await f.close();}
},180000);
