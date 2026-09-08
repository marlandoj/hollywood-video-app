import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {contentHash} from "../../generator/src/capabilities";
import {ProjectService} from "../src/index";
import type {EditScriptNavigation} from "../../planner/src/edit-script-types";
import type {LivingScriptAcceptanceRequest} from "../../planner/src/living-script-acceptance";

test("owner HTTP line review, pending render, actual recut, atomic acceptance and selected export survive reload",async()=>{
  const prior=process.env.HV_PROVIDER_POOL;process.env.HV_PROVIDER_POOL='["mock"]';const f=await dubStudio();
  try{
    const json=async(path:string,method="GET",body?:unknown,status=200)=>{const response=await f.call(f.base+path,method,body,f.owner.token),value=await response.json() as any;expect(value.error).toBeUndefined();expect(response.status).toBe(status);return value;};
    // The media baseline is an ordinary approved final. Every revised screenplay action below uses HTTP.
    await json("/animatic/decision","POST",{animaticJobId:f.film.id,decision:"approved"},201);
    await json("/jobs","POST",{idempotencyKey:"owner-original-final",stage:"final",animaticJobId:f.film.id},202);const original=(await f.worker())!;expect(original.status).toBe("done");
    const source=(await json("/editorial/sources/"+original.id)).sources[0],created=await json("/editorial/sequences","POST",{id:"owner-parent",label:"Original cut",sources:[{jobId:original.id,sourceRevision:source.sourceRevision}],firstSourceId:original.id,width:320,height:180,expectedVersion:0},201);
    const navigation=await json("/editorial/sequences/owner-parent/script?historyRevision="+created.sequence.history.revision) as EditScriptNavigation,index=navigation.sources.find(source=>source.sourceId===original.id)!,line=index.entries.find(entry=>entry.kind==="dialogue")!;
    const before=new ProjectService(f.paths.statePath).snapshot().projects[0]!,originalBytes=readFileSync(join(f.paths.artifactRoot,original.output!.mp4Path));
    const quoteRequest={id:"owner-line",label:"Revised welcome",sequenceId:"owner-parent",historyRevision:created.sequence.history.revision,editorialRevision:before.editLibrary!.revision,navigationRevision:navigation.revision,sourceRevision:source.sourceRevision,entryId:line.id,indexRevision:index.revision,replacement:"Welcome back to the garden."};
    const route="/editorial/screenplay",review=await json(route+"/quote","POST",quoteRequest);expect(review.accepted).toBe(false);expect(review.request.patch.before.text).toBe(original.scriptText);expect(review.impact.generation.generateShotIds.length).toBeGreaterThan(0);expect(new ProjectService(f.paths.statePath).snapshot().projects[0]!.versions).toEqual(before.versions);
    const save={request:review.request,expectedVersion:review.expectedVersion,reviewRevision:review.reviewRevision,accepted:true},saved=await json(route+"/proposals","POST",save,201),proposalRoute=route+"/proposals/owner-line";
    expect((await json(route+"/proposals","POST",save)).replayed).toBe(true);expect((await json(proposalRoute)).proposal).toEqual(saved.proposal);
    const generation=proposalRoute+"/generation",previewQuote=(await json(generation+"/quote","POST",{role:"preview"})).quote;
    await json(generation+"/jobs","POST",{quote:previewQuote,idempotencyKey:"owner-revised-preview",generationApproved:true,animaticJobId:null},202);
    const preview=(await f.worker())!;expect(preview.failureReason).toBeUndefined();expect(preview.status).toBe("done");
    const previewReview=await json(generation+"/jobs/"+preview.id+"/decision");await json(generation+"/jobs/"+preview.id+"/decision","POST",{review:previewReview.review,decision:"approved",note:"Use this revised line"},201);
    const renderQuote=(await json(generation+"/quote","POST",{role:"render"})).quote;await json(generation+"/jobs","POST",{quote:renderQuote,idempotencyKey:"owner-revised-final",generationApproved:true,animaticJobId:preview.id},202);
    const revised=(await f.worker())!;expect(revised.failureReason).toBeUndefined();expect(revised.status).toBe("done");expect(revised.output!.shotRenders!.some(record=>Boolean(record.reusedFrom))).toBe(true);
    const actual=await json(proposalRoute+"/sources/"+revised.id);expect(actual.sourceMap.after.sourceId).toBe(revised.id);
    const recut=await json(proposalRoute+"/recut","POST",{generatedJobId:revised.id,operations:[{kind:"replace",clipId:"initial-0",linked:true,sourceId:revised.id,from:0,frames:actual.generated.frames,timing:"preserve",ripple:false}],newSequenceId:"owner-revised-cut",acceptanceId:"owner-acceptance",name:"Revised welcome"});
    expect(recut.accepted).toBe(false);expect(recut.recut.afterTimeline.clips.every((clip:any)=>clip.sourceId===revised.id)).toBe(true);expect(new ProjectService(f.paths.statePath).snapshot().projects[0]!.versions).toEqual(before.versions);
    const acceptance={request:recut.request as LivingScriptAcceptanceRequest,expectedVersion:recut.expectedVersion,proposalRevision:recut.proposalRevision,accepted:true};
    const tampered=structuredClone(acceptance);tampered.request.recutInput.operations.push({kind:"marker",marker:{id:"unreviewed",frame:0,label:"Unreviewed change"}});
    const denied=await f.call(f.base+proposalRoute+"/accept","POST",tampered,f.owner.token);expect(denied.ok).toBe(false);expect(new ProjectService(f.paths.statePath).snapshot().projects[0]!.versions).toEqual(before.versions);
    const adopted=await json(proposalRoute+"/accept","POST",acceptance,201),state=new ProjectService(f.paths.statePath).snapshot(),project=state.projects[0]!;
    expect(project.versions.at(-1)!.text).toBe(review.request.patch.after.text);expect(project.editLibrary!.sequences[0]).toEqual(before.editLibrary!.sequences[0]);expect(adopted.acceptance.sequence.id).toBe("owner-revised-cut");
    expect((await json(proposalRoute+"/accept","POST",acceptance)).replayed).toBe(true);expect(new ProjectService(f.paths.statePath).snapshot()).toEqual(state);
    const renderRoute="/editorial/sequences/owner-revised-cut/renders",exportQuote=await json(renderRoute);await json(renderRoute,"POST",{idempotencyKey:"owner-revised-export",generationApproved:true,historyRevision:exportQuote.sequence.historyRevision,sourceBindingsRevision:exportQuote.sourceBindingsRevision,engineVersion:exportQuote.engineVersion,review:{...exportQuote.review,accepted:true}},202);
    const exported=(await f.worker())!;expect(exported.failureReason).toBeUndefined();expect(exported.status).toBe("done");
    const jobs=await json(""),publicExport=jobs.jobs.find((job:any)=>job.id===exported.id);expect(publicExport.output.mp4Url).toBeDefined();
    await json("/dialogue-selection","PUT",{jobId:exported.id,sourceJobId:"owner-revised-cut",expectedVersion:0,expectedOutputRevision:publicExport.outputRevision});
    const recovered=await json("");expect(recovered.dialogueSelections.entries.at(-1).jobId).toBe(exported.id);expect(new ProjectService(f.paths.statePath).snapshot().projects[0]!.dialogueSelections!.entries.at(-1)!.jobId).toBe(exported.id);
    const media=await f.call(publicExport.output.mp4Url);expect(media.status).toBe(200);expect(contentHash(new Uint8Array(await media.arrayBuffer()))).toBe(contentHash(new Uint8Array(readFileSync(join(f.paths.artifactRoot,exported.output!.mp4Path)))));
    expect(readFileSync(join(f.paths.artifactRoot,exported.output!.captionsPath),"utf8")).toContain(quoteRequest.replacement);expect(readFileSync(join(f.paths.artifactRoot,original.output!.mp4Path))).toEqual(originalBytes);expect(f.ledger.monthSpend()).toBe(0);
  }finally{await f.close();if(prior===undefined)delete process.env.HV_PROVIDER_POOL;else process.env.HV_PROVIDER_POOL=prior;}
},240000);
