import {expect,test} from "bun:test";
import {mkdtempSync,realpathSync,rmSync,readFileSync,renameSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,sep} from "node:path";
import {createApiServer} from "../src/server";
import {ProjectService} from "../src/index";
import {DurableJobStore,LeaseError,type Job} from "../../queue/src/index";
import {processNextJob,type WorkerContext} from "../../queue/src/worker";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {defaultMotionGraphic} from "../../planner/src/motion-graphics";
import {currentGraphics} from "../../planner/src/graphic-library";
import {validateGraphicOutput} from "../../planner/src/graphic-jobs";
import {validateSnapshot,writeStateSnapshot,readStateSnapshot,type StateSnapshot} from "../../storage/src/snapshots";
import {verifyGraphicMedia} from "../../generator/src/graphic-media";
import {contentHash} from "../../generator/src/capabilities";
import {decodePreviewPage} from "../../planner/src/edit-preview-protocol";
import {verifyEditMedia} from "../../generator/src/edit-media";
import {editHistoryState} from "../../planner/src/edit-history";
import {ReferenceBlobStore} from "../../storage/src/references";
import {referenceFal} from "../../../test/fixtures/reference-fal";
// @ts-expect-error -- the studio is a plain browser module with no type declarations.
import {createStudioFlow} from "../../frontend/src/studio.js";
// @ts-expect-error -- the Editor's helpers are a plain browser module with no type declarations.
import {creditRows,filmTitle,frameSize,titleOperation,titlePlans} from "../../frontend/src/titles.js";
function fixture(){
  process.env.HV_TOKEN_SECRET="graphic-studio-fixture-secret-at-least-thirty-two-characters";
  const root=mkdtempSync(join(realpathSync(tmpdir()),"hv-graphic-api-")),statePath=join(root,"projects.json"),queuePath=join(root,"jobs.json"),artifactRoot=join(root,"artifacts"),costLedgerPath=join(root,"ledger.json"),projects=new ProjectService(statePath),owner=projects.createAnonymousProject();projects.attestRights(owner.token);
  const server=createApiServer({port:0,hostname:"127.0.0.1",storage:"json",artifactStorage:"local",statePath,queuePath,artifactRoot,costLedgerPath,operatorDiagnosticsSecret:null}),base=`/api/projects/${owner.projectId}/graphics`,store=new DurableJobStore(queuePath),ledger=new CostLedger(costLedgerPath),context:WorkerContext={projects,ledger,reviewQueue:new OperatorReviewQueue(join(root,"review.json")),graphics:{chromePath:process.env.HV_GRAPHICS_CHROME_PATH??""}};
  const call=(path:string,method="GET",body?:unknown,token:string|null=owner.token)=>fetch(new URL(path,server.url),{method,headers:{...(token?{authorization:"Bearer "+token}:{}),...(body?{"content-type":"application/json"}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const close=async()=>{await server.stop(true);if(!root.startsWith(realpathSync(tmpdir())+sep)||realpathSync(root)!==root)throw new Error("Unsafe fixture cleanup");rmSync(root,{recursive:true,force:true});};
  return {root,projects,owner,server,base,store,ledger,context,artifactRoot,call,close};
}
function draft(){const {revision:_revision,...plan}=defaultMotionGraphic("lower-third",320,180);return {...plan,text:"Marla",secondary:"A fictional character",frames:4,enterFrames:1,exitFrames:1};}
test("owners retain graphic versions, recover saves, reject stale mutations and preserve schema-5 histories",async()=>{
  const f=fixture();try{
    const id=crypto.randomUUID(),input={expectedVersion:0,change:{kind:"save",id,label:"Opening credit",plan:draft()}};
    expect((await f.call(f.base,"GET",undefined,null)).status).toBe(401);
    let response=await f.call(f.base,"PUT",input);expect(response.status).toBe(200);const first=await response.json() as any;expect(first.library.version).toBe(1);
    response=await f.call(f.base,"PUT",input);expect(response.status).toBe(200);expect((await response.json() as any).library).toEqual(first.library);
    expect((await f.call(f.base,"PUT",{...input,change:{...input.change,label:"Conflicting save"}})).status).toBeGreaterThanOrEqual(400);
    response=await f.call(f.base,"PUT",{expectedVersion:1,change:{kind:"save",id,label:"Second credit",plan:{...draft(),text:"Kevin"}}});expect(response.status).toBe(200);
    const second=await response.json() as any;expect(second.library.events[0]).toEqual(first.library.events[0]);expect(second.graphics[0].spec.plan.text).toBe("Kevin");
    await f.call(f.base,"PUT",{expectedVersion:2,change:{kind:"availability",id,available:false}});
    response=await f.call(f.base,"PUT",{expectedVersion:3,change:{kind:"save",id,label:"Hidden revision",plan:draft()}});expect((await response.json() as any).graphics[0].available).toBe(false);
    const project=new ProjectService(join(f.root,"projects.json")),snapshot:StateSnapshot={schema:"hv-state/5",projects:project.snapshot(),jobs:[],ledger:{events:[],reservations:[]},reviews:[]};
    expect(currentGraphics(snapshot.projects.projects[0]!.graphicLibrary!,f.owner.projectId)[0]!.available).toBe(false);expect(()=>validateSnapshot({...snapshot,schema:"hv-state/4"})).toThrow("schema 5");
    const directory=join(f.root,"saved");writeStateSnapshot(directory,snapshot);expect(readStateSnapshot(directory)).toEqual(snapshot);
    const corrupt=structuredClone(snapshot);corrupt.projects.projects[0]!.graphicLibrary!.events[0]!.change={kind:"availability",id,available:true};expect(()=>validateSnapshot(corrupt)).toThrow();
    expect((await f.call(f.base,"PUT",{expectedVersion:4,change:{...input.change,plan:{...draft(),html:"<script>"}}})).status).toBeGreaterThanOrEqual(400);
  }finally{await f.close();}
});
const renderTest=process.env.HV_GRAPHICS_CHROME_PATH?test:test.skip;
renderTest("real graphic jobs retain alpha, recover a complete checkpoint without Chrome, and revoke owned downloads",async()=>{
  const f=fixture();try{
    const id=crypto.randomUUID(),saved=await f.call(f.base,"PUT",{expectedVersion:0,change:{kind:"save",id,label:"Opening credit",plan:draft()}});expect(saved.status).toBe(200);const spec=(await saved.json() as any).graphics[0].spec;
    const request={specRevision:spec.revision,idempotencyKey:crypto.randomUUID(),generationApproved:true},path=f.base+`/${id}/renders`;
    const admitted=await f.call(path,"POST",request);expect(admitted.status).toBe(202);const jobId=(await admitted.json() as any).jobId;
    expect((await(await f.call(path,"POST",request)).json() as any).jobId).toBe(jobId);expect((await f.call(path,"POST",{...request,specRevision:"0".repeat(64)})).status).toBeGreaterThanOrEqual(400);
    const complete=f.store.completeGraphic.bind(f.store);f.store.completeGraphic=()=>{throw new LeaseError(jobId,"fence_changed","lost-worker");};
    const progress=f.store.progressGraphic.bind(f.store),phases:string[]=[];f.store.progressGraphic=(job,worker,value,now,lease)=>{expect(f.store.get(job)!.checkpointFrame).toBe(0);phases.push(value.phase);progress(job,worker,value,now,lease);};
    const interrupted=await processNextJob(f.store,f.artifactRoot,{...f.context,workerId:"capture-worker"});expect(interrupted?.status).toBe("running");expect(interrupted?.failureReason).toBeUndefined();expect(interrupted?.graphicCheckpoint).toBeDefined();expect(interrupted?.checkpointFrame).toBe(4);expect(new Set(phases)).toEqual(new Set(["capture","encode","verify","retain"]));
    f.store.completeGraphic=complete;const resumeAt=Date.parse(interrupted!.leaseExpiresAt!)+1;
    const done=await processNextJob(f.store,f.artifactRoot,{...f.context,workerId:"fresh-worker",graphics:{chromePath:"missing-on-purpose"},now:()=>resumeAt});expect(done?.status).toBe("done");expect(done?.graphicOutput).toEqual(interrupted?.graphicCheckpoint);expect(done?.resumedCount).toBe(1);expect(done?.output).toBeUndefined();expect(done?.costUsd).toBe(0);expect(f.ledger.all()).toHaveLength(0);expect(f.ledger.reservedUsd()).toBe(0);
    validateGraphicOutput(done!,done!.graphicOutput!);await verifyGraphicMedia(done!,done!.graphicOutput!,f.artifactRoot);expect(done!.graphicOutput!.report.frames.some(frame=>frame.transparentPixels>0&&frame.visiblePixels>0)).toBe(true);
    const reordered=JSON.parse(JSON.stringify(done!.graphicOutput),(key,value)=>value&&!Array.isArray(value)&&typeof value==="object"?Object.fromEntries(Object.entries(value).sort(([a],[b])=>b.localeCompare(a))):value);expect(contentHash(reordered)).toBe(contentHash(done!.graphicOutput));validateGraphicOutput(done!,reordered);await verifyGraphicMedia(done!,reordered,f.artifactRoot);
    const view=await(await f.call(f.base+"/jobs/"+jobId)).json() as any;expect(view.output).toBeDefined();const png=await f.call(view.output.framesUrl+"000001.png","GET",undefined,null);expect(png.status).toBe(200);expect(png.headers.get("content-type")).toBe("image/png");
    const manifest=await f.call(view.output.manifestUrl,"GET",undefined,null);expect(manifest.headers.get("content-disposition")).toContain("attachment");expect(manifest.headers.get("content-security-policy")).toContain("sandbox");
    await f.call(f.base,"PUT",{expectedVersion:1,change:{kind:"availability",id,available:false}});expect((await f.call(view.output.framesUrl+"000001.png","GET",undefined,null)).status).toBe(404);
    const unavailable=await(await f.call(f.base+"/jobs/"+jobId)).json() as any;expect(unavailable.output).toBeNull();expect(unavailable.unavailable).toContain("permission");
    await f.call(f.base,"PUT",{expectedVersion:2,change:{kind:"availability",id,available:true}});expect((await f.call(view.output.framesUrl+"000001.png","GET",undefined,null)).status).toBe(200);
    const snapshot:StateSnapshot={schema:"hv-state/5",projects:new ProjectService(join(f.root,"projects.json")).snapshot(),jobs:[done!],ledger:{events:[],reservations:[]},reviews:[]};expect(validateSnapshot(snapshot)).toEqual(snapshot);
    const corrupt=structuredClone(done!) as Job;corrupt.graphicOutput!.files[0]!.path="other/job/index.html";const {revision:_revision,...data}=corrupt.graphicOutput!;corrupt.graphicOutput!.revision=contentHash(data);expect(()=>validateGraphicOutput(corrupt,corrupt.graphicOutput!)).toThrow("file");
    const original=readFileSync(join(f.artifactRoot,done!.graphicOutput!.masterPath));expect(original.length).toBe(done!.graphicOutput!.report.master.bytes);
  }finally{await f.close();}
},120000);

renderTest("owners use a graphic in saved-cut PNG preview and keep editing from an independent retained alpha copy",async()=>{
  const f=fixture();try{
    const id=crypto.randomUUID(),saved=await f.call(f.base,"PUT",{expectedVersion:0,change:{kind:"save",id,label:"Marla lower third",plan:draft()}}),spec=(await saved.json() as any).graphics[0].spec;
    expect((await f.call(f.base+`/${id}/renders`,"POST",{specRevision:spec.revision,idempotencyKey:crypto.randomUUID(),generationApproved:true})).status).toBe(202);
    const graphic=(await processNextJob(f.store,f.artifactRoot,f.context))!;expect(graphic.failureReason??graphic.cancelReason).toBeUndefined();expect(graphic.status).toBe("done");
    const base=`/api/projects/${f.owner.projectId}/editorial`,call=(path:string,method="GET",body?:unknown)=>f.call(base+path,method,body),json=async(path:string)=>{const response=await call(path);expect(await response.clone().text()).not.toContain('"error"');expect(response.status).toBe(200);return response.json() as Promise<any>;};
    expect((await json("")).sources.find((s:any)=>s.jobId===graphic.id)).toMatchObject({stage:"motion-graphic",label:spec.label});const source=(await json("/sources/"+graphic.id)).sources[0];expect(source.facts.media).toBe("graphic-rgba");
    const sequence=crypto.randomUUID(),route="/sequences/"+sequence,created=await call("/sequences","POST",{id:sequence,label:"Graphic assembly",sources:[{jobId:graphic.id,sourceRevision:source.sourceRevision}],firstSourceId:graphic.id,width:320,height:180,expectedVersion:0});expect(await created.clone().text()).not.toContain('"error"');expect(created.status).toBe(201);const state=await created.json() as any;expect(state.timeline.clips.map((c:any)=>c.lane)).toEqual(["picture"]);
    const sessionId=crypto.randomUUID(),session=route+"/preview/"+sessionId,query="?historyRevision="+state.sequence.history.revision;
    const requested=await call(route+"/preview","POST",{id:sessionId,historyRevision:state.sequence.history.revision,from:0,frames:4});expect(requested.status).toBe(202);let preview=await requested.json() as any;const end=Date.now()+60000;while(preview.state!=="ready"){if(Date.now()>end||preview.state==="failed")throw new Error(preview.error??"Graphic preview did not become ready");await Bun.sleep(30);preview=await json(session+query);}
    const packet=await call(session+"/picture/"+graphic.id+"/0"+query+"&sourceKey="+preview.sources[0].sourceKey);expect(packet.status).toBe(200);const page=await decodePreviewPage(new Uint8Array(await packet.arrayBuffer()),{sourceKey:preview.sources[0].sourceKey,from:0,sha256:packet.headers.get("x-hv-preview-sha256")!});expect(page.header.pictureEncoding).toBe("png-rgba");expect(page.picture).toHaveLength(4);expect(page.header.picture.map(p=>p.sourceSha256)).toEqual(graphic.graphicOutput!.report.frames.map(f=>f.rgbaSha256));expect((await call(session+query,"DELETE")).status).toBe(200);
    const render=async()=>{const quote=await json(route+"/renders"),response=await call(route+"/renders","POST",{idempotencyKey:crypto.randomUUID(),generationApproved:true,historyRevision:quote.sequence.historyRevision,sourceBindingsRevision:quote.sourceBindingsRevision,engineVersion:quote.engineVersion,review:{...quote.review,accepted:true}});expect(await response.clone().text()).not.toContain('"error"');expect(response.status).toBe(202);const done=(await processNextJob(f.store,f.artifactRoot,f.context))!;expect(done.failureReason??done.cancelReason).toBeUndefined();expect(done.status).toBe("done");expect(done.costUsd).toBe(0);return done;};
    const first=await render();expect(first.output!.editorial!.prepared.sources[0]!.media.picture.sha256).toBe(graphic.graphicOutput!.report.master.sha256);
    const root=realpathSync(f.artifactRoot),original=realpathSync(join(root,graphic.projectId,graphic.id)),hidden=original+"-hidden";if(!original.startsWith(root+sep)||!hidden.startsWith(root+sep))throw new Error("Unsafe retained graphic fixture move");renameSync(original,hidden);writeFileSync(join(f.root,"jobs.json"),JSON.stringify([first]));
    try{
      await f.call(f.base,"PUT",{expectedVersion:1,change:{kind:"availability",id,available:false}});expect((await call(route+"/renders")).status).toBe(400);await f.call(f.base,"PUT",{expectedVersion:2,change:{kind:"availability",id,available:true}});
      const second=await render();expect(second.pictureEdit!.bindings[0]!.owner.jobId).toBe(first.id);expect(second.output!.editorial!.conform.pictureFrames).toEqual(first.output!.editorial!.conform.pictureFrames);expect(second.output!.editorial!.prepared.sources[0]!.receipt.job.pictureEdit).toBeUndefined();await verifyEditMedia(second,second.output!,f.artifactRoot,async()=>{});
      const snapshot:StateSnapshot={schema:"hv-state/5",projects:new ProjectService(join(f.root,"projects.json")).snapshot(),jobs:[first,second],ledger:{events:[],reservations:[]},reviews:[]};expect(()=>validateSnapshot(snapshot)).not.toThrow();expect(()=>validateSnapshot({...snapshot,schema:"hv-state/4"})).toThrow("schema 5");
    }finally{renameSync(hidden,original);}
  }finally{await f.close();}
},120000);

// HV-025-03: the studio asks whether this host can render graphics before the Editor titles a film.
test("the graphics library says whether this host has the pinned graphics browser",async()=>{
  const saved=process.env.HV_GRAPHICS_CHROME_PATH,f=fixture();try{
    delete process.env.HV_GRAPHICS_CHROME_PATH;
    expect((await(await f.call(f.base)).json() as any).rendering).toEqual({available:false,chromeVersion:"152.0.7977.75"});
    process.env.HV_GRAPHICS_CHROME_PATH="/opt/any/chrome-headless-shell";
    expect((await(await f.call(f.base)).json() as any).rendering).toEqual({available:true,chromeVersion:"152.0.7977.75"});
  }finally{if(saved===undefined)delete process.env.HV_GRAPHICS_CHROME_PATH;else process.env.HV_GRAPHICS_CHROME_PATH=saved;await f.close();}
});

// HV-025-03 end to end at CI size. The studio makes and scores a film with this host's renderer
// hidden, so it shares the scored cut untitled and says so. The Editor's own title and credits then
// render in the pinned browser (their text fits), and the same edit the studio applies lays short
// copies of them over the scored sound mix: the title over the start, the credits after the end
// with the Composer's music under them. That picture edit is shared and opens for the reviewer.
renderTest("the Editor's title and credits render and lay over a scored sound mix that is shared for review",async()=>{
  const script="Title: The Long Way Home\nAuthor: Ana Ruiz\n\nINT. KITCHEN - DAY\n\nMAYA nods.";
  const root=mkdtempSync(join(realpathSync(tmpdir()),"hv-titles-")),config={HV_TOKEN_SECRET:"studio-titles-fixture-secret-at-least-thirty-two-characters",HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_PROVIDER_POOL:'["mock"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0"};
  const original=Object.fromEntries([...Object.keys(config),"HV_GRAPHICS_CHROME_PATH"].map(key=>[key,process.env[key]])),chromePath=process.env.HV_GRAPHICS_CHROME_PATH!;
  const run=(args:string[])=>{const result=Bun.spawnSync(args);if(result.exitCode)throw new Error(result.stderr.toString());return result.stdout;};
  let server:ReturnType<typeof createApiServer>|undefined;
  try{
    Object.assign(process.env,config);
    const paths={queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json")};
    server=createApiServer({port:0,hostname:"127.0.0.1",...paths,operatorDiagnosticsSecret:null,rateLimit:{api:{limit:10000,windowMs:60000}}});
    const store=new DurableJobStore(paths.queuePath),context:WorkerContext={projects:new ProjectService(paths.statePath),ledger:new CostLedger(paths.costLedgerPath),reviewQueue:new OperatorReviewQueue(join(root,"reviews.json")),graphics:{chromePath}};
    const base=server.url.origin,work=async()=>{const job=(await processNextJob(store,paths.artifactRoot,context))!;expect(job.failureReason??job.cancelReason).toBeUndefined();return job;};
    let project:{projectId:string;token:string}|undefined;
    const api=async(path:string,method="GET",body?:unknown)=>{const response=await fetch(base+path,{method,headers:{...(project?{authorization:"Bearer "+project.token}:{}),...(body?{"content-type":"application/json"}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})}),value=await response.json() as any;if(!response.ok)throw new Error(path+" "+response.status+" "+value.error);return value;};
    const flow=createStudioFlow({api:async(path:string,init:RequestInit={})=>{const response=await fetch(base+path,init),value=await response.json() as any;if(!response.ok)throw new Error(path+" "+response.status+" "+value.error);return value;},
      getProject:()=>project,setProject:(value:typeof project)=>{project=value;},wait:async()=>{await processNextJob(store,paths.artifactRoot,context);},fetchImage:async(url:string)=>(await fetch(base+url)).arrayBuffer()});
    // The API has no renderer: the studio shares the scored cut and the Editor says why.
    delete process.env.HV_GRAPHICS_CHROME_PATH;
    await flow.pitch({script,format:"reel",tone:"warm",rightsAttested:true});await flow.plan([]);await flow.approveLook(true);
    const finished=await flow.approveRoughCut(),scored=(await store.get(finished.final.id))!;
    expect([scored.stage,scored.status]).toEqual(["sound-mix","done"]);expect(finished.finishNotes).toEqual(["Editor: titles and credits were skipped because this studio has no graphics renderer installed; the film is shared untitled."]);
    process.env.HV_GRAPHICS_CHROME_PATH=chromePath;
    const graphicsPath=`/api/projects/${project!.projectId}/graphics`,editorial=`/api/projects/${project!.projectId}/editorial`;
    expect((await api(graphicsPath)).rendering).toEqual({available:true,chromeVersion:"152.0.7977.75"});
    const film=(await api(editorial+"/sources/"+scored.id)).sources[0],size=frameSize(film.facts);expect(film.facts.audio).toContain("music");
    const plans=titlePlans({...size,title:filmTitle(script,""),credits:creditRows({script,scored:true}),filmFrames:film.facts.frames});
    expect(plans.title.text).toBe("The Long Way Home");expect(plans.credits.credits[0]).toEqual({role:"Written by",name:"Ana Ruiz"});
    let version=0;
    const render=async(id:string,label:string,plan:unknown)=>{
      const saved=await api(graphicsPath,"PUT",{change:{kind:"save",id,label,plan},expectedVersion:version});version=saved.library.version;const spec=saved.graphics.find((g:any)=>g.spec.id===id).spec;
      const queued=await api(`${graphicsPath}/${id}/renders`,"POST",{idempotencyKey:`${id}-${spec.revision.slice(0,32)}`,specRevision:spec.revision,generationApproved:true});
      const job=await work();expect([job.id,job.status]).toEqual([queued.jobId,"done"]);return job;
    };
    // The studio's own 4 s title and 6 s credits render in the pinned browser: the text fits its safe area.
    await render("crew-title","Editor: opening title",plans.title);await render("crew-credits","Editor: closing credits",plans.credits);
    // Short copies keep the edit within the CI budget; the timeline operation is the studio's own.
    const title=await render("short-title","Short title",{...plans.title,frames:6,enterFrames:2,exitFrames:2}),credits=await render("short-credits","Short credits",{...plans.credits,frames:12,enterFrames:2,exitFrames:2});
    const titleSource=(await api(editorial+"/sources/"+title.id)).sources[0],creditsSource=(await api(editorial+"/sources/"+credits.id)).sources[0],library=await api(editorial);
    const id="crew-titles-"+scored.id,route=editorial+"/sequences/"+id;
    const created=await api(editorial+"/sequences","POST",{id,label:"Editor: titles and credits",sources:[film,titleSource,creditsSource].map(source=>({jobId:source.jobId,sourceRevision:source.sourceRevision})),firstSourceId:film.facts.id,...size,expectedVersion:library.libraryVersion});
    const operation=titleOperation({film:film.facts,title:titleSource.facts,credits:creditsSource.facts});
    await api(route,"PATCH",{expectedVersion:created.libraryVersion,expectedHistoryRevision:created.sequence.history.revision,change:{kind:"edit",label:"Editor: title and credits",operation}});
    const quote=await api(route+"/renders");expect(quote.unavailable).toBeNull();
    const queued=await api(route+"/renders","POST",{idempotencyKey:id,generationApproved:true,historyRevision:quote.sequence.historyRevision,sourceBindingsRevision:quote.sourceBindingsRevision,engineVersion:quote.engineVersion,review:{...quote.review,accepted:true}});
    const titled=await work();expect([titled.id,titled.stage,titled.status,titled.costUsd]).toEqual([queued.jobId,"picture-edit","done",0]);
    const timeline=editHistoryState(titled.pictureEdit!.sequence.history).timeline,frames=film.facts.frames;
    expect(timeline.frames).toBe(frames+12);
    expect(timeline.clips.filter(clip=>clip.id.startsWith("crew-")).map(clip=>[clip.id,clip.sourceId,clip.lane,clip.layer,clip.at,clip.frames]).sort()).toEqual([
      ["crew-credits",credits.id,"picture",0,frames,12],["crew-credits-music",scored.id,"music",0,frames,12],["crew-title",title.id,"picture",1,0,6]]);
    // The export runs the credits' length longer, and the credits are not silent.
    const exported=join(paths.artifactRoot,titled.output!.mp4Path),seconds=Number(run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",exported]).toString());
    expect(Math.abs(seconds-(frames+12)/30)).toBeLessThan(0.1);
    const loudness=/max_volume: (-?[0-9.inf]+) dB/.exec(Bun.spawnSync(["ffmpeg","-v","info","-ss",String(frames/30),"-i",exported,"-af","volumedetect","-f","null","-"]).stderr.toString())!;
    expect(Number(loudness[1])).toBeGreaterThan(-60);
    // The titled cut is what the reviewer sees.
    const link=await api(`/api/projects/${project!.projectId}/reviews`,"POST",{permission:"approve",jobId:titled.id,expectedOutputRevision:titled.output&&(await api("/api/jobs/"+titled.id)).outputRevision,maxViews:2});
    const review=await api("/api/reviews/"+link.reviewUrl.split("/review/")[1]);expect([review.jobId,review.stage]).toEqual([titled.id,"picture-edit"]);
  }finally{await server?.stop(true);rmSync(root,{recursive:true,force:true});for(const [key,value]of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
},300000);

// HV-025-03, the whole studio: the scored cut becomes a titled picture edit (title over the start,
// credits after the end, the Composer's music under them) and is shared. With the studio's full
// 4 s and 6 s graphics the export takes minutes on the JSON store, beyond the graphics CI job's
// budget, so it also needs HV_STUDIO_E2E=1; the test below covers the same path at CI size.
const studioTest=process.env.HV_GRAPHICS_CHROME_PATH&&process.env.HV_STUDIO_E2E?test:test.skip;
studioTest("the Editor titles the scored film through the studio and the titled cut is shared for review",async()=>{
  const script="Title: The Long Way Home\nAuthor: Ana Ruiz\n\nINT. KITCHEN - DAY\n\nMAYA, an old woman, pours tea.\n\nMAYA\nYou came back.\n\nEXT. GARDEN - DAY\n\nMAYA walks to the gate.";
  const root=mkdtempSync(join(realpathSync(tmpdir()),"hv-titles-")),config={HV_TOKEN_SECRET:"studio-titles-fixture-secret-at-least-thirty-two-characters",HV_ANIMATIC_PROVIDER_POOL:'["mock"]',
    HV_PROVIDER_POOL:'["mock","fal:kling-o3-standard-keyframes"]',HV_NARRATION:"1",HV_ANIMATIC_CAPTIONS:"0",FAL_KEY:"studio-titles-fixture-only"},original=Object.fromEntries(Object.keys(config).map(key=>[key,process.env[key]])),realFetch=globalThis.fetch;
  const run=(args:string[])=>{const result=Bun.spawnSync(args);if(result.exitCode)throw new Error(result.stderr.toString());return result.stdout;};
  let server:ReturnType<typeof createApiServer>|undefined;
  try{
    Object.assign(process.env,config);
    const paths={queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json")};
    server=createApiServer({port:0,hostname:"127.0.0.1",...paths,operatorDiagnosticsSecret:null,rateLimit:{api:{limit:10000,windowMs:60000}}});
    const clip=join(root,"clip.mp4");run(["ffmpeg","-y","-v","error","-f","lavfi","-i","color=red:s=320x180:r=30:d=5","-c:v","libx264","-pix_fmt","yuv420p",clip]);
    const still=run(["ffmpeg","-v","error","-f","lavfi","-i","color=red:s=320x180","-frames:v","1","-f","image2pipe","-vcodec","png","-"]),base=server.url.origin,fal=referenceFal(still,readFileSync(clip),base,realFetch);globalThis.fetch=fal.fetchImpl;
    const store=new DurableJobStore(paths.queuePath),context:WorkerContext={projects:new ProjectService(paths.statePath),ledger:new CostLedger(paths.costLedgerPath),references:new ReferenceBlobStore(paths.artifactRoot),reviewQueue:new OperatorReviewQueue(join(root,"reviews.json")),graphics:{chromePath:process.env.HV_GRAPHICS_CHROME_PATH!}};
    const api=async(path:string,init:RequestInit={})=>{const response=await fetch(base+path,init),body=await response.json() as any;if(!response.ok)throw new Error(path+" "+response.status+" "+body.error);return body;};
    let project:{projectId:string;token:string}|undefined;
    const flow=createStudioFlow({api,getProject:()=>project,setProject:(value:typeof project)=>{project=value;},wait:async()=>{await processNextJob(store,paths.artifactRoot,context);},fetchImage:async(url:string)=>(await fetch(base+url)).arrayBuffer()});
    await flow.pitch({script,format:"reel",tone:"warm",rightsAttested:true});await flow.plan([]);await flow.approveLook(true);
    const done=await flow.approveRoughCut();expect(done.finishNotes).toEqual([]);
    const titled=(await store.get(done.final.id))!,jobs=await store.all(),scored=jobs.find(job=>job.stage==="sound-mix")!;
    expect([titled.stage,titled.status,titled.costUsd]).toEqual(["picture-edit","done",0]);expect(scored.status).toBe("done");
    // The titled cut is the scored cut, the title over its start and the credits after its end.
    const timeline=editHistoryState(titled.pictureEdit!.sequence.history).timeline,film=timeline.sources.find(source=>source.id===scored.id)!;
    expect(timeline.frames).toBe(film.frames+180);
    const byId=Object.fromEntries(timeline.clips.map(clip=>[clip.id,clip]));
    expect(byId["crew-title"]).toMatchObject({lane:"picture",layer:1,at:0});expect(byId["crew-credits"]).toMatchObject({lane:"picture",layer:0,at:film.frames,frames:180});
    expect(byId["crew-credits-music"]).toMatchObject({lane:"music",sourceId:scored.id,at:film.frames});
    const graphics=jobs.filter(job=>job.stage==="motion-graphic");expect(graphics.map(job=>[job.graphicRender!.spec.id,job.status]).sort()).toEqual([["crew-credits","done"],["crew-title","done"]]);
    expect(graphics.find(job=>job.graphicRender!.spec.id==="crew-title")!.graphicRender!.spec.plan.text).toBe("The Long Way Home");
    expect(graphics.find(job=>job.graphicRender!.spec.id==="crew-credits")!.graphicRender!.spec.plan.credits.map(row=>row.name)).toContain("Composer (AI crew)");
    // The exported film runs the extra six seconds, and the credits are not silent.
    const exported=join(paths.artifactRoot,titled.output!.mp4Path),seconds=Number(run(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",exported]).toString());
    expect(Math.abs(seconds-(film.frames+180)/30)).toBeLessThan(0.1);
    const credits=/max_volume: (-?[0-9.inf]+) dB/.exec(Bun.spawnSync(["ffmpeg","-v","info","-ss",String(film.frames/30+0.5),"-t","3","-i",exported,"-af","volumedetect","-f","null","-"]).stderr.toString())!;
    expect(Number(credits[1])).toBeGreaterThan(-50);
    // The titled cut is what the reviewer sees.
    const shared=await flow.share(2),token=decodeURIComponent(shared.reviewUrl.split("/review/")[1]!);
    const review=await api("/api/reviews/"+encodeURIComponent(token));expect([review.jobId,review.stage]).toEqual([titled.id,"picture-edit"]);
  }finally{globalThis.fetch=realFetch;await server?.stop(true);rmSync(root,{recursive:true,force:true});for(const [key,value]of Object.entries(original)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
},1500000);
