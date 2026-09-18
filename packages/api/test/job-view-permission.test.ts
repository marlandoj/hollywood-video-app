/**
 * HV-029-04 — the owner's display paths chose their permission check by job shape.
 *
 * HV-029-03 made `/artifacts/` ask one question, answered by the job's stage.
 * The views that hand out the links into `/artifacts/` were left asking a
 * different one. `publicJob` mints an artifact token for **any** job with a
 * retained output, at five call sites, and exactly one of them applied a check:
 *
 *     if((job.dialogueReplacement||job.lipSync||job.soundMix||job.pictureEdit||job.assemblyEdit)&&job.output){…}
 *
 * The same six-optional-fields shape, on the display side. A plain `animatic`
 * or `final` cut carries none of those fields, so an owner whose cast
 * permission had been revoked was still handed a freshly minted `mp4Url`, the
 * per-shot `audioUrl`s, the take clips' URLs and the storyboard frame URLs —
 * plus the shots' speech text. The four other call sites (the project read,
 * the take groups, the character sheets, the dialogue export) had no check at
 * all, for any stage.
 *
 * The media itself is refused by `/artifacts/` since HV-029-03, so what the
 * display paths leaked was the cut's contents and a live token for it, not the
 * bytes. That is still the likeness the revocation was about.
 *
 * The repair: `publicJob` takes a **required** `permission` parameter, and the
 * server passes `mediaPermission` — `artifactPermission(job.stage)` plus the
 * audio take's voice rule — to every call site. An optional parameter would be
 * this increment's own defect one level down: a check hung off something that
 * can be absent.
 */
import {afterAll,expect,test} from "bun:test";
import {mkdirSync,mkdtempSync,readFileSync,renameSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {createApiServer} from "../src/server";
import {verifyToken} from "../src/tokens";
import {ProjectService} from "../src/index";
import {DurableJobStore,type Job} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {ReferenceBlobStore} from "../../storage/src/references";
import {currentCasting} from "../../planner/src/casting";
import {lineSources} from "../../planner/src/performances";
import {parseFountain} from "../../parser/src/index";
import {compileAudioLine} from "../../planner/src/audio-performances";
import {audioTakePlan} from "../../planner/src/audio-jobs";
import {createAudioDelivery} from "../../generator/src/audio-delivery";
import {prepareAudioMedia} from "../../generator/src/audio-media";
import {AUDIO_POLICY,AUDIO_PCM} from "../../../test/fixtures/audio";
import {CAST_INPUT,CAST_SCRIPT} from "../../../test/fixtures/casting";
import {defaultMotionGraphic} from "../../planner/src/motion-graphics";

const REPO_ROOT=resolve(import.meta.dir,"../../..");
/** No dialogue anywhere: the old display gate reached none of its five fields. */
const SILENT="INT. ROOM - DAY\n\nMarla stares at the lamp.\n\nEXT. GARDEN - DAY\n\nMarla walks away.";
/** The same cut with a line, so the per-shot `audioUrl` exists to be withheld. */
const SPOKEN="INT. ROOM - DAY\n\nMarla greets the room.\n\nMARLA\nHello.\n\nEXT. GARDEN - DAY\n\nMarla walks away.";

const envKeys=["HV_TOKEN_SECRET","HV_ANIMATIC_PROVIDER_POOL","HV_PROVIDER_POOL","HV_NARRATION","HV_ANIMATIC_CAPTIONS"];
const originalEnv=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
const fixtures:{root:string;server:ReturnType<typeof createApiServer>}[]=[];
afterAll(async()=>{
  for(const f of fixtures){await f.server.stop(true);rmSync(f.root,{recursive:true,force:true});}
  for(const [key,value] of Object.entries(originalEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
});

/** Every `/artifacts/…` path anywhere in a serialized view, at any depth. */
function artifactLinks(value:unknown):string[]{
  return JSON.stringify(value).split('"').filter(part=>part.startsWith("/artifacts/")).sort();
}
/**
 * The same links, minus the signed token. Each mint carries a fresh nonce, so
 * two views of the same permitted cut hold different bytes for the same file;
 * what "the same links came back" means is the same files, still under a token
 * bound to this project and job.
 */
function artifactFiles(value:unknown,projectId:string,jobId:string):string[]{
  return artifactLinks(value).map(link=>{
    const [,,token,project,job,...rest]=link.split("/");
    expect({project,job}).toEqual({project:projectId,job:jobId});
    expect(verifyToken(token!)).toMatchObject({kind:"artifact",projectId,jobId});
    return rest.join("/");
  }).sort();
}

async function fixture(script:string,narration="0",audioPolicies?:()=>typeof AUDIO_POLICY[]){
  Object.assign(process.env,{HV_TOKEN_SECRET:"job-view-permission-fixture-secret-at-least-thirty",HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_PROVIDER_POOL:'["image:mock"]',HV_NARRATION:narration,HV_ANIMATIC_CAPTIONS:"0"});
  const root=mkdtempSync(join(tmpdir(),"hv-job-view-permission-"));
  const paths={queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json")};
  const server=createApiServer({port:0,hostname:"127.0.0.1",...paths,...(audioPolicies?{audioPolicies}:{}),rateLimit:{api:{limit:10000,windowMs:60000}}});
  fixtures.push({root,server});
  const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const owner=await(await call("/api/projects","POST")).json() as {projectId:string;token:string};
  const base="/api/projects/"+owner.projectId;
  await call(base+"/script","PUT",{text:script},owner.token);
  await call(base+"/rights","POST",{attested:true},owner.token);
  const projects=new ProjectService(paths.statePath),store=new DurableJobStore(paths.queuePath),ledger=new CostLedger(paths.costLedgerPath);
  const worker=()=>processNextJob(store,paths.artifactRoot,{projects,ledger,reviewQueue:new OperatorReviewQueue(join(root,"reviews.json"))});
  const id=crypto.randomUUID(),character={...CAST_INPUT,name:"Marla",aliases:[]};
  expect((await call(base+"/cast/"+id,"PUT",{character,expectedVersion:0},owner.token)).status).toBe(200);
  const render=async():Promise<Job>=>{
    expect((await call(base+"/jobs","POST",{idempotencyKey:crypto.randomUUID()},owner.token)).status).toBe(202);
    const job=await worker();
    expect(job?.failureReason??job?.cancelReason).toBeUndefined();
    expect(job?.status).toBe("done");
    return job!;
  };
  const jobView=async(jobId:string)=>await(await call("/api/jobs/"+jobId,"GET",undefined,owner.token)).json() as Record<string,unknown>;
  const projectView=async()=>await(await call(base,"GET",undefined,owner.token)).json() as {jobs:Record<string,unknown>[]};
  const revoke=()=>projects.saveCharacter(owner.token,id,{...character,permission:{...character.permission,status:"revoked"}},1);
  const restore=()=>projects.saveCharacter(owner.token,id,character,2);
  return {root,paths,server,call,owner,base,projects,store,ledger,worker,render,jobView,projectView,revoke,restore,id,character};
}

/**
 * A character sheet, which is the one rule HV-029-03 could give no behavioural
 * case: its Y9 row -- emptying the character-sheet rule's body -- was measured
 * green because no request in the suite reached that branch. A sheet's views
 * are listed by their own route, which had no permission check of any kind.
 */
async function sheetFixture(){
  Object.assign(process.env,{HV_TOKEN_SECRET:"job-view-permission-sheet-secret-at-least-thirty-two"});
  const root=mkdtempSync(join(tmpdir(),"hv-job-view-sheet-"));
  const paths={queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json")};
  const server=createApiServer({port:0,hostname:"127.0.0.1",...paths,rateLimit:{api:{limit:10000,windowMs:60000}}});
  fixtures.push({root,server});
  const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const owner=await(await call("/api/projects","POST")).json() as {projectId:string;token:string},base="/api/projects/"+owner.projectId,id=crypto.randomUUID();
  await call(base+"/script","PUT",{text:CAST_SCRIPT},owner.token);
  await call(base+"/rights","POST",{attested:true},owner.token);
  expect((await call(base+"/cast/"+id,"PUT",{expectedVersion:0,character:CAST_INPUT},owner.token)).status).toBe(200);
  const sheets=base+"/cast/"+id+"/sheets",store=new DurableJobStore(paths.queuePath),projects=new ProjectService(paths.statePath),ledger=new CostLedger(paths.costLedgerPath),references=new ReferenceBlobStore(paths.artifactRoot);
  const worker=()=>processNextJob(store,paths.artifactRoot,{ledger,projects,references,reviewQueue:new OperatorReviewQueue(join(root,"reviews.json"))});
  return {root,paths,server,call,owner,base,id,sheets,projects,worker};
}

test("a character sheet's listing withholds the likeness it is entirely made of when the character's permission is revoked",async()=>{
  const f=await sheetFixture();
  expect((await f.call(f.sheets,"POST",{generationApproved:true,expectedVersion:1,settings:{kind:"wardrobe",seed:123,sceneNumber:null}},f.owner.token)).status).toBe(202);
  const job=await f.worker();
  expect(job?.failureReason).toBeUndefined();
  expect(job?.status).toBe("done");
  expect(job!.stage).toBe("character-sheet");
  const listing=async()=>(await(await f.call(f.sheets,"GET",undefined,f.owner.token)).json() as {jobs:Record<string,unknown>[]}).jobs.find(row=>row.id===job!.id)!;

  const before=await listing();
  expect(before.mediaUnavailable).toBeNull();
  const links=artifactFiles(before,f.owner.projectId,job!.id);
  expect(job!.output!.sheetPath!.endsWith("/character-sheet.png")).toBe(true);
  expect(links).toContain("character-sheet.png");
  const sheet=await fetch(new URL((before.output as {sheetUrl:string}).sheetUrl,f.server.url));
  expect(sheet.status).toBe(200);

  expect(f.projects.saveCharacter(f.owner.token,f.id,{...CAST_INPUT,permission:{...CAST_INPUT.permission,status:"revoked"}},1)).toBeTruthy();
  const withheld=await listing();
  expect(artifactLinks(withheld)).toEqual([]);
  expect(withheld.output).toBeUndefined();
  expect(withheld.mediaUnavailable).toBeTruthy();

  expect(f.projects.saveCharacter(f.owner.token,f.id,CAST_INPUT,2)).toBeTruthy();
  const after=await listing();
  expect(after.mediaUnavailable).toBeNull();
  expect(artifactFiles(after,f.owner.projectId,job!.id)).toEqual(links);
});

test("a silent cut's owner view stops handing out its links when the character's permission is revoked, and hands out the same links again when it is restored",async()=>{
  const f=await fixture(SILENT);
  const job=await f.render();
  // The fixture must be the shape the old display gate let through, or this is
  // re-testing a path that was already checked.
  expect(job.stage).toBe("animatic");
  expect(job.dialogueReplacement??job.lipSync??job.soundMix??job.pictureEdit??job.assemblyEdit).toBeUndefined();
  const renders=job.output!.shotRenders!;
  expect(renders.length).toBeGreaterThan(0);
  expect(renders.some(render=>render.clip.speech)).toBe(false);

  const before=await f.jobView(job.id);
  expect(before.mediaUnavailable).toBeNull();
  const links=artifactFiles(before,f.owner.projectId,job.id);
  expect(links).toContain("export.mp4");
  expect(links.length).toBeGreaterThan(1);
  expect((before.output as {mp4Url:string}).mp4Url).toContain("/artifacts/");
  expect(before.artifactUrlsExpireAt).toBeTruthy();
  const mp4=new URL((before.output as {mp4Url:string}).mp4Url,f.server.url);
  const served=await fetch(mp4);
  expect(served.status).toBe(200);
  const bytes=Buffer.from(await served.arrayBuffer());
  expect(bytes.byteLength).toBeGreaterThan(0);

  expect(f.revoke()).toBeTruthy();
  const withheld=await f.jobView(job.id);
  // Not "a link that 404s" -- no link at all, anywhere in the document.
  expect(artifactLinks(withheld)).toEqual([]);
  expect(withheld.output).toBeUndefined();
  expect(withheld.artifactUrlsExpireAt).toBeNull();
  expect(withheld.artifactUrlsExpireInSeconds).toBeNull();
  expect(withheld.mediaUnavailable).toContain("Character Marla is not permitted in scene 1");
  // The per-shot rows survive as identity, without their media or their speech.
  expect((withheld.shotRenders as {shotId:string;audioUrl?:string}[]).map(row=>row.shotId)).toEqual(renders.map(row=>row.shotId));
  expect((withheld.shotRenders as {audioUrl?:string}[]).every(row=>row.audioUrl===undefined)).toBe(true);
  expect((withheld.storyboard as {url?:string}[]).every(frame=>frame.url===undefined)).toBe(true);
  // The media path agrees, which is the point of one rule.
  expect((await fetch(mp4)).status).toBe(404);

  expect(f.restore()).toBeTruthy();
  const after=await f.jobView(job.id);
  expect(after.mediaUnavailable).toBeNull();
  expect(artifactFiles(after,f.owner.projectId,job.id)).toEqual(links);
  // A fresh mint, not the one from before: the view re-derives rather than
  // handing back a token it cached past the revocation.
  expect(artifactLinks(after)).not.toEqual(artifactLinks(before));
  const again=await fetch(new URL((after.output as {mp4Url:string}).mp4Url,f.server.url));
  expect(again.status).toBe(200);
  expect(Buffer.from(await again.arrayBuffer()).equals(bytes)).toBe(true);
});

test("the per-shot links a cut carries outside its output map are withheld too",async()=>{
  const f=await fixture(SPOKEN,"1");
  const job=await f.render();
  // `shotRenders[].audioUrl` is built from the minted token's prefix rather
  // than from `signedArtifactUrls`, so deleting `output` alone used to leave
  // it -- a live link to a revoked character's voice, in a view that says the
  // media is unavailable.
  const speaking=job.output!.shotRenders!.filter(render=>render.clip.speech&&render.files.audio);
  expect(speaking.length).toBeGreaterThan(0);

  const before=await f.jobView(job.id);
  const audio=(before.shotRenders as {speech?:string;audioUrl?:string}[]).filter(row=>row.audioUrl!==undefined);
  expect(audio).toHaveLength(speaking.length);
  expect(audio.every(row=>row.audioUrl!.startsWith("/artifacts/"))).toBe(true);
  expect((await fetch(new URL(audio[0]!.audioUrl!,f.server.url))).status).toBe(200);

  expect(f.revoke()).toBeTruthy();
  const withheld=await f.jobView(job.id);
  expect(artifactLinks(withheld)).toEqual([]);
  expect((withheld.shotRenders as {audioUrl?:string}[]).every(row=>row.audioUrl===undefined)).toBe(true);
  // The line itself is the performance, so it goes with the link.
  expect((withheld.shotRenders as {speech?:string}[]).every(row=>row.speech===undefined)).toBe(true);
  expect(withheld.mediaUnavailable).toContain("Character Marla is not permitted in scene 1");

  expect(f.restore()).toBeTruthy();
  const after=await f.jobView(job.id);
  expect((after.shotRenders as {audioUrl?:string}[]).filter(row=>row.audioUrl!==undefined)).toHaveLength(speaking.length);
  expect((await fetch(new URL((after.shotRenders as {audioUrl:string}[]).find(row=>row.audioUrl)!.audioUrl,f.server.url))).status).toBe(200);
});

test("the project read route answers the same way, and an unfinished job is not reported as a permission problem",async()=>{
  const f=await fixture(SILENT);
  const job=await f.render();
  const entry=async()=>(await f.projectView()).jobs.find(row=>row.id===job.id)!;

  const before=await entry();
  expect(before.mediaUnavailable).toBeNull();
  expect(artifactLinks(before).length).toBeGreaterThan(0);

  expect(f.revoke()).toBeTruthy();
  const withheld=await entry();
  expect(artifactLinks(withheld)).toEqual([]);
  expect(withheld.mediaUnavailable).toContain("Character Marla is not permitted in scene 1");
  // The whole listing, not only this job's entry: no other row carries a link
  // minted for a cut this project may no longer show.
  expect(artifactLinks(await f.projectView())).toEqual([]);
  expect(f.restore()).toBeTruthy();

  // A job with nothing retained has no permission question to answer. Asking
  // one anyway would report "this cut is unavailable" for a job that is merely
  // still running, which is a different sentence about a different thing.
  expect((await f.call(f.base+"/jobs","POST",{idempotencyKey:crypto.randomUUID()},f.owner.token)).status).toBe(202);
  const queued=(await f.projectView()).jobs.find(row=>row.id!==job.id)!;
  expect(queued.status).toBe("queued");
  expect(queued.output).toBeUndefined();
  expect(queued.mediaUnavailable).toBeNull();
  expect(artifactLinks(queued)).toEqual([]);
});

test("a take group's listing withholds its clips' links when the cast permission is revoked",async()=>{
  // `GET /api/projects/:id/takes` is the listing the defect table names and
  // the only one with no behavioural case until now. Its rule is
  // `artifactPermission("take-preview")`, which derives its shots from the
  // take plan rather than from `renderShots` -- a different derivation, so a
  // case on a cut does not stand in for it.
  const f=await fixture(SILENT);
  const view=await(await f.call(f.base+"/direction","GET",undefined,f.owner.token)).json() as {scriptVersion:number;plan:{source:{id:string};sourceHash:string}[];direction:{version:number}};
  const settings={shotId:view.plan[0]!.source.id,sourceHash:view.plan[0]!.sourceHash,
    takes:[35,50].map((lensMm,index)=>({label:"Take "+"AB"[index],seed:301+index,settings:{lensMm,durationFrames:30,previewMove:"static"}}))};
  const created=await f.call(f.base+"/takes","POST",{settings,expectedScriptVersion:view.scriptVersion,expectedCastingVersion:1,expectedDirectionVersion:view.direction.version,generationApproved:true},f.owner.token);
  expect(await created.clone().text()).not.toContain('"error"');
  expect(created.status).toBe(202);
  const job=await f.worker();
  expect(job?.status).toBe("done");
  expect(job?.stage).toBe("take-preview");

  const listed=async()=>(await(await f.call(f.base+"/takes","GET",undefined,f.owner.token)).json() as {groups:Record<string,unknown>[]}).groups.find(row=>row.id===job!.id)!;
  const before=await listed();
  expect(before.mediaUnavailable).toBeNull();
  const clips=before.takeClips as {id:string;mp4Url:string;hlsUrl:string;posterUrl:string;captionsUrl:string;manifestUrl:string}[];
  expect(clips).toHaveLength(2);
  expect(clips.every(clip=>clip.mp4Url.startsWith("/artifacts/"))).toBe(true);
  const links=artifactFiles(before,f.owner.projectId,job!.id);
  expect((await fetch(new URL(clips[0]!.mp4Url,f.server.url))).status).toBe(200);

  expect(f.revoke()).toBeTruthy();
  const withheld=await listed();
  expect(artifactLinks(withheld)).toEqual([]);
  // The clip rows stay -- the owner still sees which takes exist and what they
  // cost -- and carry none of their five links.
  const dark=withheld.takeClips as Record<string,unknown>[];
  expect(dark.map(clip=>clip.id)).toEqual(clips.map(clip=>clip.id));
  for(const clip of dark)for(const key of ["mp4Url","hlsUrl","posterUrl","captionsUrl","manifestUrl"])expect(clip[key]).toBeUndefined();
  expect(withheld.mediaUnavailable).toContain("Character Marla is not permitted in scene 1");

  expect(f.restore()).toBeTruthy();
  expect(artifactFiles(await listed(),f.owner.projectId,job!.id)).toEqual(links);
},60000);

test("an audition's voice permission is the same rule on the listing as on the media path",async()=>{
  // The composed rule adds the audio take's voice check to the stage rule.
  // `audioJobView` computed that check for its own `audioUnavailable` field;
  // the project listing does not go through `audioJobView`, so before this
  // increment it handed out the audition's `audioUrl` whatever the voice
  // policy said.
  const policies=[AUDIO_POLICY];
  const f=await fixture(SPOKEN,"1",()=>policies);
  // Read the saved state fresh: the fixture's own service predates the cast.
  const project=new ProjectService(f.paths.statePath).snapshot().projects[0]!,casting=currentCasting(project.id,project.castingHistory);
  expect(casting.characters.map(character=>character.id)).toContain(f.id);
  const original=lineSources(parseFountain(SPOKEN).scenes[0]!.dialogue)[0]!;
  const line=compileAudioLine(original,{schema:"hv-audio-voice/1",provider:"cartesia",language:"en",voice:{id:AUDIO_POLICY.voiceId,catalogueRevision:AUDIO_POLICY.catalogueRevision,permissionRevision:AUDIO_POLICY.permissionRevision},controls:{speed:1,volume:1,emotion:"calm"},pronunciations:[]},{sourceHash:original.hash,beforeMs:0,afterMs:0});
  const audio=f.store.enqueue({id:crypto.randomUUID(),projectId:project.id,idempotencyKey:"seeded-audition",stage:"audio-take",tier:"free",scriptVersion:1,scriptText:SPOKEN,casting,rightsAttestedAt:project.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null,
    totalFrames:0,costCapUsd:.25,budgetReservedUsd:.25,retryPolicy:{maxRetries:0,backoffMs:0},timeoutMs:60000,audioTake:audioTakePlan(0,f.id,line,AUDIO_POLICY,"local")});
  f.store.claimNext(Date.now(),{},{workerId:"seed"});
  const delivered=createAudioDelivery(line,crypto.randomUUID(),AUDIO_PCM.subarray(0,24000*2),[{text:"Hello",startSec:0,endSec:.5}],[{text:"h",startSec:0,endSec:.1}]);
  const scratch=mkdtempSync(join(f.paths.artifactRoot,".seed-audition-")),output=prepareAudioMedia(audio,scratch,delivered.report,delivered.wav),directory=join(f.paths.artifactRoot,dirname(output.wavPath));
  mkdirSync(dirname(directory),{recursive:true});renameSync(scratch,directory);
  f.store.checkpointAudio(audio.id,"seed",output);f.store.completeAudio(audio.id,"seed",output);

  const listed=async()=>(await f.projectView()).jobs.find(row=>row.id===audio.id)!;
  const before=await listed();
  expect(before.stage).toBe("audio-take");
  expect(before.mediaUnavailable).toBeNull();
  expect(artifactFiles(before,f.owner.projectId,audio.id).length).toBeGreaterThan(0);
  expect((before.audio as {audioUrl:string}).audioUrl).toContain("/artifacts/");

  // Withdraw the voice: the configured policy no longer names it.
  policies.length=0;
  const withheld=await listed();
  expect(artifactLinks(withheld)).toEqual([]);
  expect(withheld.output).toBeUndefined();
  expect((withheld.audio as {audioUrl?:string}|null)?.audioUrl).toBeUndefined();
  expect(withheld.mediaUnavailable).toContain("voice permission is unavailable");

  policies.push(AUDIO_POLICY);
  expect((await listed()).mediaUnavailable).toBeNull();
});

test("a graphic answers through its own view on the project listing, not only through the single-job route",async()=>{
  // `publicJob` mints from `job.output`/`job.audioOutput` and knows nothing of
  // `graphicOutput`, so for a graphic it would mint nothing -- and therefore
  // never ask -- while still serializing the whole `graphicRender` spec and the
  // retained `graphicOutput` through the rest spread. `graphicJobView` is where
  // that question is answered, and it used to be reached only from
  // `audioJobView`, which the project listing does not use.
  const f=await fixture(SILENT);
  const id=crypto.randomUUID();
  const {revision:_revision,...plan}=defaultMotionGraphic("lower-third",320,180);
  const saved=await(await f.call(f.base+"/graphics","PUT",{expectedVersion:0,change:{kind:"save",id,label:"Opening credit",plan:{...plan,text:"Marla",secondary:"A fictional character",frames:4,enterFrames:1,exitFrames:1}}},f.owner.token)).json() as {graphics:{spec:{revision:string}}[]};
  const queued=await f.call(f.base+"/graphics/"+id+"/renders","POST",{idempotencyKey:crypto.randomUUID().replace(/-/g,""),specRevision:saved.graphics[0]!.spec.revision,generationApproved:true},f.owner.token);
  expect(await queued.clone().text()).not.toContain('"error"');
  expect(queued.status).toBe(202);
  const jobId=(await queued.json() as {jobId:string}).jobId;

  const entry=(await f.projectView()).jobs.find(row=>row.id===jobId)!;
  // `graphicJobView`'s shape, not `publicJob`'s: its own `unavailable` field,
  // the spec, and none of the cut fields `publicJob` always emits.
  expect(entry.spec).toBeDefined();
  expect(entry).toHaveProperty("unavailable");
  expect(entry.output).toBeNull();
  expect(entry.castingVersion).toBeUndefined();
  expect(entry.graphicRender).toBeUndefined();
  expect(entry.artifactUrlsExpireAt).toBeUndefined();
  expect(artifactLinks(entry)).toEqual([]);
});

test("every display path asks the media path's question, by stage, through a parameter it cannot forget",async()=>{
  const strip=(text:string)=>text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,"");
  const flatten=(text:string)=>text.replace(/\s+/g," ");
  const server=strip(readFileSync(join(REPO_ROOT,"packages/api/src/server.ts"),"utf8"));
  const flat=flatten(server);

  // 1. The permission parameter is required. An optional one is the defect
  //    family this increment exists to remove: a check hung off something that
  //    can be absent, absent exactly where nobody looked.
  const signature=flat.slice(flat.indexOf("function publicJob("),flat.indexOf("function publicJob(")+220);
  expect(signature).toContain("permission: (job: Job) => void,");
  expect(signature).not.toContain("permission?:");
  expect(signature).not.toMatch(/permission\s*:\s*\(job: Job\) => void\s*=/);

  // 2. Nothing mints an artifact token for a view except through `publicJob`'s
  //    own `signedOutput`, and `signedOutput` is reached only after the gate.
  const body=flat.slice(flat.indexOf("function publicJob("));
  const publicJobBody=body.slice(0,body.indexOf("function projectUrl("));
  const gate=publicJobBody.indexOf("permission(job)");
  const mint=publicJobBody.indexOf("const minted = signedOutput(job, project, now)");
  expect(gate).toBeGreaterThan(-1);
  expect(mint).toBeLessThan(gate); // the mint is what decides there is something to withhold
  // One mint, so "is there media?" and "may it be shown?" cannot answer about
  // different jobs: the condition is the mint's own result.
  expect([...publicJobBody.matchAll(/signedOutput\(/g)]).toHaveLength(1);
  // The gate block is pinned whole rather than by banning one spelling of a
  // kill switch. `not.toMatch(/process.env/)` was the first draft of this and
  // a hoisted module-scope `const SKIP = process.env.X === "1"` read outside
  // `publicJob` walked straight past it; any added condition, hoisted or not,
  // changes these bytes.
  expect(publicJobBody.slice(mint,gate+"permission(job)".length)).toBe(
    "const minted = signedOutput(job, project, now); let mediaUnavailable: string | null = null; if (minted.output) { try { permission(job)");
  // The gate is chosen by nothing about the job's shape: it runs for every job
  // that retained something.
  const condition=publicJobBody.slice(mint,gate);
  // Narrow, for the gate's condition, which legitimately names `minted.output`.
  const SHAPED=/\b(?:lipSync|dialogueReplacement|soundMix|pictureEdit|assemblyEdit|shotRenders|speech|stage)\b/;
  // Wide, for the rule's body, where none of these belong: choosing by any of
  // them is choosing by shape again, one level in.
  const SHAPED_RULE=/\b(?:lipSync|dialogueReplacement|soundMix|pictureEdit|assemblyEdit|shotRenders|speech|shotTakes|characterSheet|takeClips|storyboard|casting|output|graphicOutput)\b/;
  expect({condition,shaped:SHAPED.test(condition)}).toEqual({condition,shaped:false});
  expect(SHAPED.test("if((job.dialogueReplacement||job.lipSync)&&job.output){")).toBe(true);
  expect(SHAPED.test("if (job.output || job.audioOutput) { try { ")).toBe(false);

  // 3. Every call site passes one, and they all pass the same one. `jobView` is
  //    the only caller, so a new display route reaches `publicJob` only through
  //    the rule -- and `mediaPermission` is `artifactPermission` by stage.
  const calls=[...server.matchAll(/publicJob\(/g)].length;
  expect(calls).toBe(2); // the declaration and `jobView`
  expect(flat).toContain("publicJob(job,project,seen=>mediaPermission(seen,project),now)");
  const rule=flat.slice(flat.indexOf("const mediaPermission="));
  const ruleBody=rule.slice(0,rule.indexOf("};")+2);
  // Pinned whole for the same reason as the gate: an early `return` for one
  // stage inside the rule is the defect written one level in, and a `toContain`
  // pair welcomes it.
  expect(ruleBody).toBe("const mediaPermission=(job:Job,project:Project):void=>{ artifactPermission(job.stage)(job,project); if(job.audioTake)audioTakePermission(job,project); };");
  expect({ruleBody,shaped:SHAPED_RULE.test(ruleBody)}).toEqual({ruleBody,shaped:false});
  expect(SHAPED.test('if(job.stage==="take-preview")return;')).toBe(true);
  expect(SHAPED_RULE.test("if(!job.shotTakes)return;")).toBe(true);
  expect(SHAPED_RULE.test("if(job.characterSheet)return;")).toBe(true);

  // 4. Every mint of an artifact token in this file is a decided site. A new
  //    one -- the way the direction route's storyboard sources were minted
  //    behind a casting-revision comparison rather than a permission -- moves
  //    these counts and has to be argued for rather than added quietly.
  //    `signedOutput`: its declaration, `publicJob`'s gated mint, the review
  //    view (gated by `assertSelectedOutput`) and the direction route's
  //    storyboard sources (gated by `mediaPermission`).
  //    `mintArtifactToken`: inside `signedOutput`, and the narration takes
  //    (gated by `assertRetainedAuditionPermission`, which nulls the url).
  expect([...server.matchAll(/signedOutput\(/g)]).toHaveLength(4);
  expect([...server.matchAll(/mintArtifactToken\s*\(/g)]).toHaveLength(2);
  expect(flat).toContain("try{mediaPermission(job,project);}catch{continue;} const signed=signedOutput(job,project).output!");

  // 5. A graphic never reaches `publicJob`, which mints nothing for a
  //    `graphicOutput` and so would never ask: it answers through its own view
  //    on every display path, not only through `audioJobView`.
  expect(flat).toContain("job.graphicRender?graphicJobView(job,project):publicJob(");
  expect([...server.matchAll(/graphicJobView\(/g)]).toHaveLength(1); // one call, in `jobView`
});
