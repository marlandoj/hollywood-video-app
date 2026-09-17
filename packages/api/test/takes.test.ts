import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../src/server";
import {ProjectService} from "../src/index";
import {DurableJobStore,type Job} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {ReferenceBlobStore} from "../../storage/src/references";
import type {DirectionEntry,DirectionSnapshot} from "../../planner/src/direction";
import type {ShotTakePlan} from "../../planner/src/takes";
import {validateSnapshot,type StateSnapshot} from "../../storage/src/snapshots";
import {provenanceAssembledAt} from "../../planner/src/provenance";
const SCRIPT="EXT. GARDEN - DAY\n\nSpud opens the gate.\n\nMolly carries a basket.\n\nThe dog runs inside.";
const fixtures:{root:string;server:ReturnType<typeof createApiServer>}[]=[];
afterAll(async()=>{for(const f of fixtures){await f.server.stop(true);rmSync(f.root,{recursive:true,force:true});}});
interface View {direction:DirectionSnapshot;plan:DirectionEntry[];scriptVersion:number}
async function fixture(){
  process.env.HV_TOKEN_SECRET="shot-takes-api-fixture-secret-at-least-thirty-two-characters";
  const root=mkdtempSync(join(tmpdir(),"hv-takes-api-")),paths={queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json")};
  const server=createApiServer({port:0,hostname:"127.0.0.1",...paths,rateLimit:{api:{limit:10000,windowMs:60000}}});fixtures.push({root,server});
  const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const owner=await(await call("/api/projects","POST")).json() as {projectId:string;token:string},base="/api/projects/"+owner.projectId;
  await call(base+"/script","PUT",{text:SCRIPT},owner.token);
  const view=()=>call(base+"/direction","GET",undefined,owner.token).then(r=>r.json() as Promise<View>);
  const projects=new ProjectService(paths.statePath),store=new DurableJobStore(paths.queuePath),ledger=new CostLedger(paths.costLedgerPath),references=new ReferenceBlobStore(paths.artifactRoot);
  // HV-031-02: an injected monotonic clock, so a take manifest's assembly time
  // can be checked against an instant the test chose. The clock still advances
  // because this suite relies on retry backoff elapsing.
  const clockStart=Date.parse("2026-09-17T12:00:00.000Z");let tick=clockStart;
  const worker=()=>processNextJob(store,paths.artifactRoot,{projects,ledger,references,now:()=>(tick+=1000),reviewQueue:new OperatorReviewQueue(join(root,"reviews.json"))});
  const post=(suffix:string,body:unknown)=>call(base+suffix,"POST",body,owner.token);
  return {root,paths,server,call,owner,base,view,projects,store,ledger,worker,post,clockStart};
}
test("take quotes are read-only; separate previews/finals export playable private alternatives and adoption preserves other directions",async()=>{
  const f=await fixture(),config={HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_PROVIDER_POOL:'["mock"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0"},old=Object.fromEntries(Object.keys(config).map(key=>[key,process.env[key]]));
  try {Object.assign(process.env,config);
    const view=await f.view();expect(view.plan.length).toBeGreaterThan(1);
    const cameraPath={mode:"screen-space",keyframes:[{at:0,x:0,y:2500,size:5000,easing:"smooth"},{at:10000,x:5000,y:2500,size:5000,easing:"linear"}]};
    const settings={shotId:view.plan[0]!.source.id,sourceHash:view.plan[0]!.sourceHash,takes:[35,50,85].map((lensMm,i)=>({label:"Take "+"ABC"[i],seed:101+i,settings:{lensMm,durationFrames:30*(i+1),previewMove:"static",cameraPath}}))};
    const body={settings,expectedScriptVersion:view.scriptVersion,expectedCastingVersion:0,expectedDirectionVersion:0,generationApproved:true};
    const quote=await f.post("/takes/quote",body);expect(quote.status).toBe(200);const estimate=await quote.json() as {plan:ShotTakePlan;costCapUsd:number;perTakeCapUsd:number;providerPlanRevision:string};
    expect(estimate.plan.takes.map(t=>t.seed)).toEqual([101,102,103]);expect(estimate.perTakeCapUsd).toBeCloseTo(estimate.costCapUsd/3);expect(f.store.all()).toHaveLength(0);expect(f.ledger.reservedUsd()).toBe(0);
    expect((await f.post("/takes",body)).status).toBe(403);
    await f.post("/rights",{attested:true});
    expect((await f.post("/takes",{...body,generationApproved:false})).status).toBe(409);
    expect((await f.post("/takes",{...body,expectedDirectionVersion:1})).status).toBe(409);
    expect((await f.post("/takes",{...body,providerPlanRevision:"stale"})).status).toBe(409);
    const render=async(input:unknown)=>{const response=await f.post("/takes",input);expect(await response.clone().text()).not.toContain('"error"');expect(response.status).toBe(202);const job=await f.worker();expect(job?.failureReason).toBeUndefined();expect(job?.status).toBe("done");return job!;};
    const preview=await render({...body,providerPlanRevision:estimate.providerPlanRevision});expect(preview.stage).toBe("take-preview");expect(preview.checkpointShots).toBe(3);
    expect((await f.post("/animatic/decision",{animaticJobId:preview.id,decision:"approved"})).status).toBe(404);
    expect((await f.post("/jobs",{stage:"final",animaticJobId:preview.id})).status).toBe(404);
    expect((await f.post("/takes",{...body,stage:"take-final",animaticJobId:preview.id})).status).toBe(403);
    const approval=await f.post("/takes/"+preview.id+"/decision",{decision:"approved"});expect(approval.status).toBe(201);expect((await approval.json() as {takeRevision:string}).takeRevision).toBe(estimate.plan.revision);
    const modified=structuredClone(body);modified.settings.takes[0]!.seed=999;
    expect((await f.post("/takes",{...modified,stage:"take-final",animaticJobId:preview.id})).status).toBe(409);
    const final=await render({...body,stage:"take-final",animaticJobId:preview.id});expect(final.stage).toBe("take-final");
    const snapshot:StateSnapshot={schema:"hv-state/1",projects:f.projects.snapshot(),jobs:f.store.all(),ledger:{events:f.ledger.all(),reservations:[]},reviews:[]};
    expect(validateSnapshot(snapshot)).toEqual(snapshot);
    for(const corrupt of [(s:StateSnapshot)=>{s.jobs[1]!.output!.takeClips!.pop();},(s:StateSnapshot)=>{s.jobs[1]!.output!.takeClips![0]!.seed++;},(s:StateSnapshot)=>{s.jobs[1]!.stage="final";},(s:StateSnapshot)=>{s.jobs[1]!.output!.cameraPathRenders!.pop();},(s:StateSnapshot)=>{s.jobs[1]!.output!.cameraPathRenders![0]!.keyframes[0]!.x++;},(s:StateSnapshot)=>{s.jobs[1]!.output!.takeClips![0]!.captionsPath="another/job/captions.vtt";}]){const changed=structuredClone(snapshot);corrupt(changed);expect(()=>validateSnapshot(changed)).toThrow();}
    const groupResult=await f.call(f.base+"/takes?shotId="+settings.shotId,"GET",undefined,f.owner.token),groups=await groupResult.json() as {groups:(Job&{takeClips:{mp4Url:string}[]})[]};
    expect(groupResult.headers.get("cache-control")).toBe("private, no-store");expect(groups.groups).toHaveLength(2);
    for(const job of [preview,final]){
      const clips=job.output!.takeClips!;expect(clips).toHaveLength(3);expect(new Set(clips.map(c=>c.path)).size).toBe(3);expect(clips.map(c=>c.seed)).toEqual([101,102,103]);expect(clips.map(c=>c.durationSec)).toEqual([1,2,3]);
      for(const clip of clips){const path=join(f.paths.artifactRoot,clip.path),probe=Bun.spawnSync(["ffprobe","-v","error","-show_streams","-of","json",path]);expect(probe.exitCode).toBe(0);const streams=JSON.parse(probe.stdout.toString()).streams as {codec_name:string;codec_type:string}[];expect(streams.map(s=>s.codec_name)).toContain("h264");expect(streams.map(s=>s.codec_name)).toContain("aac");
        const manifest=JSON.parse(readFileSync(join(f.paths.artifactRoot,clip.manifestPath),"utf8"));
        // HV-031-02: every take manifest carries the worker's own instant. This
        // path used to ship "1970-01-01T00:00:00.000Z" like every other export,
        // and the source scans that guard the call site cannot see a parameter
        // assigned over inside exportShotTakes -- which is exactly the edit the
        // critic pass measured green before this assertion existed.
        expect(provenanceAssembledAt(manifest.assembledAt)).toBe(manifest.assembledAt);
        expect(Date.parse(manifest.assembledAt)).toBeGreaterThanOrEqual(f.clockStart);
        expect(Date.parse(manifest.assembledAt)).toBeLessThan(f.clockStart+3600_000);
        expect(manifest.shotTake).toMatchObject({sourceHash:settings.sourceHash,seed:clip.seed,costUsd:0,mp4Sha256:clip.sha256});expect(manifest.shots).toHaveLength(1);expect(manifest.shotTake.cameraPathControl).toEqual({mode:"screen-space",keyframes:cameraPath.keyframes,outputFrames:clip.durationSec*30});expect(manifest.shots[0].cameraPathControl).toEqual(manifest.shotTake.cameraPathControl);
      }
    }
    const published=groups.groups[0]!.takeClips[0]!;const media=await fetch(new URL(published.mp4Url,f.server.url));expect(media.status).toBe(200);expect(media.headers.get("cache-control")).toBe("private, no-store");
    const other=await(await f.call("/api/projects","POST")).json() as {projectId:string;token:string};expect((await f.call(f.base+"/takes","GET",undefined,other.token)).status).toBe(401);
    expect((await(await f.call("/api/projects/"+other.projectId+"/takes","GET",undefined,other.token)).json() as {groups:unknown[]}).groups).toEqual([]);
    expect((await f.call("/api/projects/"+other.projectId+"/takes/"+final.id+"/adopt","POST",{takeId:"take-b",expectedDirectionVersion:0,expectedScriptVersion:1},other.token)).status).toBe(404);
    expect((await f.post("/takes",{...body,idempotencyKey:final.idempotencyKey.slice(f.owner.projectId.length+1)})).status).toBe(409);
    const review=await(await f.post("/reviews",{permission:"read"})).json() as {token:string};expect((await f.call("/api/reviews/"+review.token)).status).toBe(404);
    const unrelated=view.plan[1]!;expect((await f.call(f.base+"/direction/"+unrelated.source.id,"PUT",{settings:{lensMm:200},sourceHash:unrelated.sourceHash,expectedVersion:0,expectedScriptVersion:1},f.owner.token)).status).toBe(200);
    expect((await f.post("/takes/"+final.id+"/adopt",{takeId:"take-b",expectedDirectionVersion:0,expectedScriptVersion:1})).status).toBe(409);
    expect((await f.post("/takes/"+final.id+"/adopt",{takeId:"take-b",expectedDirectionVersion:1,expectedScriptVersion:1})).status).toBe(200);
    const adopted=(await f.view()).direction;expect(adopted.version).toBe(2);expect(adopted.entries.find(e=>e.source.id===settings.shotId)!.settings).toMatchObject({seed:102,lensMm:50,durationFrames:60,cameraPath});expect(adopted.entries.find(e=>e.source.id===unrelated.source.id)!.settings.lensMm).toBe(200);
    expect((await f.post("/takes/"+preview.id+"/decision",{decision:"approved"})).status).toBe(409);
    expect((await f.post("/takes/"+final.id+"/adopt",{takeId:"take-c",expectedDirectionVersion:2,expectedScriptVersion:1})).status).toBe(200);
    expect((await f.view()).direction.entries.find(e=>e.source.id===settings.shotId)!.settings.seed).toBe(103);expect(f.ledger.monthSpend()).toBe(0);expect(f.ledger.reservedUsd()).toBe(0);
  } finally {for(const [key,value]of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
},60000);

test("an interrupted take group resumes from its first checkpoint without dispatching that take again",async()=>{
  const f=await fixture(),config={HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_NARRATION:"0",HV_ANIMATIC_CAPTIONS:"0"},old=Object.fromEntries(Object.keys(config).map(key=>[key,process.env[key]]));
  const checkpoint=f.store.checkpoint.bind(f.store);let interrupt=true;
  try{Object.assign(process.env,config);await f.post("/rights",{attested:true});const view=await f.view();
    const submitted=await f.post("/takes",{expectedScriptVersion:1,expectedCastingVersion:0,expectedDirectionVersion:0,generationApproved:true,settings:{shotId:view.plan[0]!.source.id,sourceHash:view.plan[0]!.sourceHash,takes:[100,200,300].map((seed,i)=>({label:"Take "+"ABC"[i],seed,settings:{durationFrames:30}}))}});expect(submitted.status).toBe(202);
    f.store.checkpoint=(...args:Parameters<typeof checkpoint>)=>{checkpoint(...args);if(interrupt&&args[2]===1){interrupt=false;throw new Error("Fixture worker stopped after durable take A.");}};
    const stopped=await f.worker();expect(stopped?.status).toBe("queued");expect(stopped?.checkpointShots).toBe(1);expect(stopped?.output).toBeUndefined();
    await Bun.sleep(1100);const completed=await f.worker();expect(completed?.status).toBe("done");expect(completed?.checkpointShots).toBe(3);expect(completed!.routeDecisions!.filter(r=>r.shotId==="take-a")).toHaveLength(1);expect(completed!.output!.takeClips!.map(c=>c.seed)).toEqual([100,200,300]);expect(f.ledger.reservedUsd()).toBe(0);
  }finally{f.store.checkpoint=checkpoint;for(const [key,value]of Object.entries(old)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
},15000);
