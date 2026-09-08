import {afterAll,beforeAll,expect,spyOn,test} from "bun:test";
import {mkdirSync,readFileSync,writeFileSync} from "node:fs";
import {join} from "node:path";
import {createHash} from "node:crypto";
import {decodePng} from "@hyperframes/engine";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {ProjectService,type PersistedState,type Project} from "../src/index";
import {EditPreviewApi} from "../src/edit-preview-api";
import {LivingScriptPreviewApi} from "../src/living-script-preview-api";
import {DurableJobStore} from "../../queue/src/index";
import {prepareEditSources} from "../../generator/src/edit-source-media";
import {conformEditAudio} from "../../generator/src/edit-conform";
import {conformEditPicture} from "../../generator/src/edit-picture";
import {soundProcessingCommand} from "../../generator/src/sound-finishing";
import {bindOriginalEditSource,type EditSourceBinding} from "../../planner/src/edit-jobs";
import {compileLivingScriptRecut} from "../../planner/src/living-script-recut";
import type {LivingScriptAcceptanceRequest} from "../../planner/src/living-script-acceptance";
import type {EditLibrary} from "../../planner/src/edit-library";
import {decodePreviewPage,previewDigest} from "../../planner/src/edit-preview-protocol";

let fixture:Awaited<ReturnType<typeof dubStudio>>,snapshot:PersistedState,asked:LivingScriptAcceptanceRequest,proposalRevision:string,proposalId:string;
const hash=(bytes:Uint8Array)=>createHash("sha256").update(bytes).digest("hex");
beforeAll(async()=>{
  const previous=process.env.HV_PROVIDER_POOL;process.env.HV_PROVIDER_POOL='["mock"]';fixture=await dubStudio();
  try{
    const json=async(path:string,method="GET",body?:unknown,status=200)=>{const response=await fixture.call(fixture.base+path,method,body,fixture.owner.token),value=await response.json() as any;expect(value.error).toBeUndefined();expect(response.status).toBe(status);return value;};
    await json("/animatic/decision","POST",{animaticJobId:fixture.film.id,decision:"approved"},201);
    await json("/jobs","POST",{idempotencyKey:"recut-preview-original",stage:"final",animaticJobId:fixture.film.id},202);const original=(await fixture.worker())!;expect(original.status).toBe("done");
    const source=(await json("/editorial/sources/"+original.id)).sources[0],saved=await json("/editorial/sequences","POST",{id:"preview-parent",label:"Original cut",sources:[{jobId:original.id,sourceRevision:source.sourceRevision}],firstSourceId:original.id,width:32,height:24,expectedVersion:0},201);
    const navigation=await json("/editorial/sequences/preview-parent/script?historyRevision="+saved.sequence.history.revision),index=navigation.sources.find((source:any)=>source.sourceId===original.id),entry=index.entries.find((entry:any)=>entry.kind==="dialogue"),current=fixture.projects.peekProject(fixture.owner.projectId)!;
    const review=await json("/editorial/screenplay/quote","POST",{id:"preview-line",label:"Revised greeting",sequenceId:"preview-parent",historyRevision:saved.sequence.history.revision,editorialRevision:current.editLibrary.revision,navigationRevision:navigation.revision,sourceRevision:source.sourceRevision,entryId:entry.id,indexRevision:index.revision,replacement:"Welcome back to the garden."});
    const proposal=await json("/editorial/screenplay/proposals","POST",{request:review.request,expectedVersion:review.expectedVersion,reviewRevision:review.reviewRevision,accepted:true},201);proposalId=proposal.proposal.request.id;proposalRevision=proposal.proposal.revision;
    const route="/editorial/screenplay/proposals/"+proposalId,generation=route+"/generation",previewQuote=(await json(generation+"/quote","POST",{role:"preview"})).quote;
    await json(generation+"/jobs","POST",{quote:previewQuote,idempotencyKey:"recut-preview-pending",generationApproved:true,animaticJobId:null},202);const preview=(await fixture.worker())!;expect(preview.status).toBe("done");
    const decision=await json(generation+"/jobs/"+preview.id+"/decision");await json(generation+"/jobs/"+preview.id+"/decision","POST",{review:decision.review,decision:"approved",note:"Reviewed changed performance"},201);
    const renderQuote=(await json(generation+"/quote","POST",{role:"render"})).quote;await json(generation+"/jobs","POST",{quote:renderQuote,idempotencyKey:"recut-preview-final",generationApproved:true,animaticJobId:preview.id},202);const generated=(await fixture.worker())!;expect(generated.status).toBe("done");
    const actual=await json(route+"/sources/"+generated.id);expect(actual.generated.frames).toBeGreaterThan(90);
    const recut=await json(route+"/recut","POST",{generatedJobId:generated.id,operations:[
      {kind:"replace",clipId:"initial-0",linked:true,sourceId:generated.id,from:0,frames:actual.generated.frames,timing:"preserve",ripple:false},
      {kind:"trim",clipId:"initial-0",linked:true,edge:"in",delta:15,ripple:true},
      {kind:"trim",clipId:"initial-0",linked:true,edge:"out",delta:70-(actual.generated.frames-15),ripple:true},
      {kind:"composite",clipId:"initial-0",composite:{schema:"hv-edit-composite/1",placement:{xQ16:16384,yQ16:0,scaleQ16:49152,rotationMilliDegrees:0}}},
    ],newSequenceId:"preview-revised-cut",acceptanceId:"preview-acceptance",name:"Reviewed trimmed welcome"});
    asked=recut.request;expect(asked.recut.afterTimeline.frames).toBe(70);snapshot=fixture.projects.snapshot();
  }finally{if(previous===undefined)delete process.env.HV_PROVIDER_POOL;else process.env.HV_PROVIDER_POOL=previous;}
},240000);
afterAll(async()=>{await fixture?.close();});

function setup(limits:ConstructorParameters<typeof LivingScriptPreviewApi>[0]["limits"]={}){
  const projects=ProjectService.fromState(snapshot),queue=DurableJobStore.fromJobs(fixture.store.all()),root=join(fixture.paths.artifactRoot,"review-"+crypto.randomUUID());mkdirSync(root);
  const io={refresh:async():Promise<Project|null>=>projects.authorize(fixture.owner.token),job:async(projectId:string,id:string)=>{const job=queue.get(id);return job?.projectId===projectId?job:undefined;},bindings:async(_project:Project,library:EditLibrary,revisions:string[]):Promise<EditSourceBinding[]>=>revisions.map(revision=>bindOriginalEditSource(library.sources.find(source=>source.revision===revision)!))};
  const shared=new EditPreviewApi({root:fixture.paths.artifactRoot,job:(...args)=>io.job(...args),bindings:async(project,id,wanted)=>{const sequence=project.editLibrary.sequences.find(sequence=>sequence.id===id)!;return io.bindings(project,project.editLibrary,sequence.sourceRevisions.filter(revision=>wanted.has(project.editLibrary.sources.find(source=>source.revision===revision)!.facts.id)));}});
  const api=new LivingScriptPreviewApi({preview:shared,job:(...args)=>io.job(...args),bindings:(...args)=>io.bindings(...args),limits}),projectId=fixture.owner.projectId;
  const call=(parts:string[]=[],method="POST",body:Record<string,unknown>|undefined={proposalRevision,request:asked},query="",signal?:AbortSignal)=>api.handle(parts,new Request("http://fixture/recut-preview"+query,{method,signal}),projectId,proposalId,()=>io.refresh(),body);
  const register=async(request=asked)=>{const response=await call([],"POST",{proposalRevision,request});if(response instanceof Response)throw new Error("Expected registration metadata");return response.body as any;};
  return {projects,queue,root,io,shared,api,call,register,async close(){await api.close();await shared.close();}};
}
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function promptly<T>(task:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([task,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Preview lifecycle timed out")),1500);})]);}finally{clearTimeout(timer);}}
function alternate(id:string){const input={...structuredClone(asked.recutInput),newSequenceId:"cut-"+id},recut=compileLivingScriptRecut(input,Date.parse(asked.recut.createdAt));return {...structuredClone(asked),id:"accept-"+id,recutInput:input,recut,reviewRevision:recut.revision};}

test("review registration seals exact full-body replay without saving screenplay, cut, settings or job state",async()=>{
  const c=setup();try{
    const before=c.projects.snapshot(),jobs=c.queue.all(),view=await c.register();expect(view.registration).toMatchObject({schema:"hv-living-script-preview/1",proposalId,proposalRevision,reviewRevision:asked.reviewRevision,accepted:false});expect(view.sequence.history).toEqual(asked.recut.history);expect(view.timeline).toEqual(asked.recut.afterTimeline);
    const replay=await c.register();expect(replay.registration.id).toBe(view.registration.id);expect(replay.replayed).toBe(true);expect(c.projects.snapshot()).toEqual(before);expect(c.queue.all()).toEqual(jobs);
    const changed={...structuredClone(asked),name:"Different full acceptance body"};await expect(c.register(changed)).rejects.toThrow(/different complete review body/);
    view.timeline.clips.length=0;const read=await c.call([view.registration.id],"GET",undefined);expect((read as any).body.timeline.clips.length).toBeGreaterThan(0);expect(c.projects.peekProject(fixture.owner.projectId)!.editLibrary.sequences).toHaveLength(1);
    await expect(c.call([view.registration.id],"GET",undefined,"?unknown=1")).rejects.toThrow(/query/);await expect(c.call(["a".repeat(64)],"GET",undefined)).rejects.toThrow(/expired/);
  }finally{await c.close();}
});

test("actual reviewed cut PNG and 48 kHz PCM agree with independent conform, including placement and a second page",async()=>{
  const c=setup();try{
    const before=c.projects.snapshot(),jobs=c.queue.all(),registered=await c.register(),id=registered.registration.id,history=registered.registration.historyRevision,sessionId=crypto.randomUUID(),query="?historyRevision="+history;
    const response=await c.call([id,"preview"],"POST",{id:sessionId,historyRevision:history,from:0,frames:70});expect((response as any).status).toBe(202);
    let status=(response as any).body;const deadline=Date.now()+90000;
    while(status.state!=="ready"){if(status.state==="failed")throw new Error(status.error);if(Date.now()>deadline)throw new Error("Recut preview did not prepare");await Bun.sleep(30);status=(await c.call([id,"preview",sessionId],"GET",undefined,query) as any).body;}
    expect(status.picture).toMatchObject({width:32,height:24,picturePurpose:"timeline-composite",pictureEncoding:"png-rgba"});expect(status.timelineRevision).toBe(asked.recut.afterTimeline.revision);expect(status.totalSources).toBe(1);
    const prepared=await prepareEditSources([asked.recutInput.generated],fixture.paths.artifactRoot,join(c.root,"reference-sources"),async()=>{}),media=prepared.sources.map(source=>source.media),pictureRoot=join(c.root,"reference-picture");mkdirSync(pictureRoot);
    const picture=await conformEditPicture(asked.recut.afterTimeline,new Map(media.map(source=>[source.id,join(fixture.paths.artifactRoot,source.picture.path)])),pictureRoot,async()=>{}),audioRoot=join(c.root,"reference-audio");
    await conformEditAudio(asked.recut.afterTimeline,media,fixture.paths.artifactRoot,audioRoot,async()=>{});const expectedPcm=readFileSync(join(audioRoot,"final.wav")).subarray(44),pcm:Uint8Array[]=[];
    const page=async(parts:string[],sourceKey:string,from:number,extra="")=>{const response=await c.call([id,"preview",sessionId,...parts],"GET",undefined,query+"&sourceKey="+sourceKey+extra);expect(response).toBeInstanceOf(Response);const stream=response as Response;expect(stream.headers.get("cache-control")).toBe("private, no-store");const bytes=new Uint8Array(await stream.arrayBuffer()),sha256=stream.headers.get("x-hv-preview-sha256")!;expect(sha256).toBe(await previewDigest(bytes));return decodePreviewPage(bytes,{sourceKey,from,sha256});};
    for(const from of [0,60]){const decoded=await page(["audio",String(from)],status.audio.sourceKey,from);expect(decoded.header.sourceFrames).toBe(70);pcm.push(decoded.audio.mix!);}expect(hash(Buffer.concat(pcm))).toBe(hash(expectedPcm));
    for(const frame of [0,14,59,60,69]){
      const decoded=await page(["picture","timeline-picture",String(Math.floor(frame/60)*60)],status.picture.sourceKey,Math.floor(frame/60)*60,"&frame="+frame),png=Buffer.from(decoded.picture[0]!),rgba=Buffer.from(decodePng(png).data);
      expect(decoded.header.picture[0]!.frame).toBe(frame);expect(decoded.header.picture[0]!.sourceSha256).toBe(hash(rgba));expect([...rgba.subarray(0,4)]).toEqual([0,0,0,255]);
      const pngPath=join(c.root,"frame-"+frame+".png"),rawPath=join(c.root,"frame-"+frame+".yuv");writeFileSync(pngPath,png);
      // Both recipes make the same final yuv420p conversion. The lossless PNG retains RGBA
      // before that delivery conversion; compare at this shared final color-space boundary.
      await soundProcessingCommand(["ffmpeg","-v","error","-nostdin","-threads","1","-i",pngPath,"-frames:v","1","-an","-c:v","rawvideo","-threads","1","-pix_fmt","yuv420p","-f","rawvideo",rawPath],c.root,async()=>{});expect(hash(readFileSync(rawPath))).toBe(picture.pictureFrames[frame]);
    }
    await expect(c.call([id,"preview","unknown"],"DELETE",undefined,query)).rejects.toThrow(/not prepared/);
    const wrong=await c.register(alternate("other"));await expect(c.call([wrong.registration.id,"preview",sessionId],"GET",undefined,query)).rejects.toThrow(/not prepared/);
    // A settings change invalidates cached pages, while exact captured cleanup remains available.
    c.projects.revokeCharacterPermission(fixture.owner.token,fixture.id,c.projects.peekProject(fixture.owner.projectId)!.castingHistory.at(-1)!.version);
    await expect(page(["audio","0"],status.audio.sourceKey,0)).rejects.toThrow();expect((await c.call([id,"preview",sessionId],"DELETE",undefined,query) as any).body).toEqual({stopped:true});expect((await c.call([id,"preview",sessionId],"DELETE",undefined,query) as any).status).toBe(200);
    expect(c.queue.all()).toEqual(jobs);expect(c.projects.snapshot().projects[0]!.versions).toEqual(before.projects[0]!.versions);expect(c.projects.snapshot().projects[0]!.editLibrary).toEqual(before.projects[0]!.editLibrary);expect(fixture.ledger.monthSpend()).toBe(0);
  }finally{await c.close();}
},240000);

test("registration rejects forged proposal, generated receipt, source map, missing carriers and nonportable bodies",async()=>{
  const c=setup();try{
    for(const mutate of [(value:LivingScriptAcceptanceRequest)=>{value.recutInput.library.revision="0".repeat(64);},(value:LivingScriptAcceptanceRequest)=>{value.recutInput.generated.job.id="unrelated";},(value:LivingScriptAcceptanceRequest)=>{value.recutInput.sourceMap.revision="0".repeat(64);},(value:LivingScriptAcceptanceRequest)=>{value.baseline.direction.version++;}]){const changed=structuredClone(asked);mutate(changed);await expect(c.register(changed)).rejects.toThrow();}
    await expect(c.call([],"POST",{proposalRevision:"a".repeat(64),request:asked})).rejects.toThrow(/proposal/);
    let accessed=false;const body={proposalRevision,request:asked};Object.defineProperty(body,"request",{enumerable:true,get(){accessed=true;return asked;}});await expect(c.call([],"POST",body)).rejects.toThrow(/accessors/);expect(accessed).toBe(false);
    const hidden={proposalRevision,request:asked};Object.defineProperty(hidden,"hidden",{value:true});await expect(c.call([],"POST",hidden)).rejects.toThrow();
    c.io.bindings=async()=>[];await expect(c.register()).rejects.toThrow(/every original/);expect(c.projects.snapshot()).toEqual(snapshot);
  }finally{await c.close();}
});

test("current script, parent cut, owner and original or generated carrier withdrawal invalidate retained reviews",async()=>{
  for(const kind of ["script","cut","owner","original","generated"] as const){const c=setup();try{
    const view=await c.register(),project=c.projects.peekProject(fixture.owner.projectId)!;
    if(kind==="script")project.versions.commit(project.versions.latest()!.text+"\n\nA later line.");
    else if(kind==="cut")c.projects.changeEditSequence(fixture.owner.token,"preview-parent",{kind:"edit",label:"Later cut",operation:{kind:"marker",marker:{id:"later",frame:0,label:"Later"}}},project.editLibrary.version,project.editLibrary.sequences[0]!.history.revision);
    else if(kind==="owner")c.io.refresh=async()=>null;
    else{const get=c.io.job,id=kind==="original"?asked.recutInput.library.sources[0]!.job.id:asked.recutInput.generated.job.id;c.io.job=async(projectId,jobId)=>jobId===id?undefined:get(projectId,jobId);}
    await expect(c.call([view.registration.id],"GET",undefined)).rejects.toThrow();await expect(c.register()).rejects.toThrow();
  }finally{await c.close();}}
});

test("registry limits and expiration are explicit and cannot be overbooked by racing registrations",async()=>{
  const c=setup({registrations:1});try{const results=await Promise.allSettled([c.register(),c.register(alternate("race"))]);expect(results.filter(result=>result.status==="fulfilled")).toHaveLength(1);expect(results.filter(result=>result.status==="rejected")).toHaveLength(1);}finally{await c.close();}
  const small=setup({requestBytes:100});try{await expect(small.register()).rejects.toThrow(/metadata capacity/);}finally{await small.close();}
  const bounded=setup({metadataBytes:100});try{await expect(bounded.register()).rejects.toThrow(/complete review/);}finally{await bounded.close();}
  const expired=setup({leaseMs:100});try{const view=await expired.register();await Bun.sleep(120);await expect(expired.call([view.registration.id],"GET",undefined)).rejects.toThrow(/expired/);const again=await expired.register();expect(again.registration.id).toBe(view.registration.id);expect(again.replayed).toBe(false);}finally{await expired.close();}
});

for(const stop of ["cancel","close"] as const)for(const point of ["owner","carrier","bindings"] as const)test(`recut preview releases stalled ${point} read on ${stop}`,async()=>{
  const c=setup(),entered=deferred<void>(),blocked=deferred<never>(),controller=new AbortController(),stall=()=>{entered.resolve();return blocked.promise;};
  if(point==="owner")c.io.refresh=stall;else if(point==="carrier")c.io.job=stall;else c.io.bindings=stall;
  const pending=c.call([],"POST",{proposalRevision,request:asked},"",controller.signal);void pending.catch(()=>{});
  try{await promptly(entered.promise);if(stop==="cancel")controller.abort(new Error("Cancelled recut read"));else await promptly(c.api.close());await expect(promptly(pending)).rejects.toThrow(stop==="cancel"?"Cancelled recut read":/stopped/);expect(c.projects.snapshot()).toEqual(snapshot);}
  finally{controller.abort();blocked.reject(new Error("Late fixture read"));await Promise.allSettled([pending,c.close()]);}
});

test("close relinquishes late failed admissions and leaves unrelated shared-pool sessions usable",async()=>{
  const c=setup(),entered=deferred<void>(),blocked=deferred<never>();let pending:Promise<unknown>|undefined;
  try{
    const registered=await c.register(),registration=registered.registration,sessionId="late-start",handle=spyOn(c.shared,"handle").mockImplementation(async()=>{entered.resolve();return blocked.promise;}),release=spyOn(c.shared,"releaseSession");
    pending=c.call([registration.id,"preview"],"POST",{id:sessionId,historyRevision:registration.historyRevision,from:0,frames:60});void pending.catch(()=>{});await promptly(entered.promise);
    const closing=c.api.close();expect(release).toHaveBeenCalledTimes(1);blocked.reject(new Error("Late failed shared admission"));await expect(pending).rejects.toThrow("Late failed shared admission");await promptly(closing);
    expect(release).toHaveBeenCalledTimes(2);expect(release).toHaveBeenLastCalledWith(fixture.owner.projectId,registration.sequenceId,registration.historyRevision,sessionId);handle.mockRestore();release.mockRestore();
    const parent=c.projects.peekProject(fixture.owner.projectId)!.editLibrary.sequences[0]!,body={id:"ordinary-still-open",historyRevision:parent.history.revision,from:0,frames:60};
    expect((await c.shared.handle([],new Request("http://fixture/preview",{method:"POST"}),fixture.owner.projectId,parent.id,()=>c.io.refresh(),body) as any).status).toBe(202);
    c.shared.releaseSession(fixture.owner.projectId,parent.id,parent.history.revision,body.id);await expect(c.register()).rejects.toThrow(/stopped/);
  }finally{blocked.reject(new Error("Fixture stopped"));await Promise.allSettled([pending,c.close()]);}
});
