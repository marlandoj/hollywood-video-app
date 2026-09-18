/**
 * HV-029-03 — the media path checked permission only for jobs shaped a certain way.
 *
 * `/artifacts/` verified the token signature, the project's existence, its
 * `deleteAfter` and its takedown state, and then ran a permission gate only
 * when the job carried one of six optional fields:
 *
 *     if(mediaJob?.output?.shotRenders?.some(r=>r.clip.speech)){…assertSelectedOutput…}
 *     if(mediaJob?.lipSync){…}  if(mediaJob?.dialogueReplacement){…}
 *     if(mediaJob?.soundMix){…} if(mediaJob?.pictureEdit){…}  if(mediaJob?.assemblyEdit){…}
 *
 * A plain `animatic` or `final` cut carries none of them unless one of its
 * shots happens to have dialogue, so **the cut of a silent scene was served
 * with no permission check at all** — including after the cast permission for
 * the character in it had been revoked.
 *
 * The speech condition was wrong on its own terms, not merely incomplete.
 * `assertDialoguePermissions` reaches `assertCurrentCastPermission` for every
 * shot's `characterIds`, and `charactersForScene` matches a character named in
 * a scene's *action* as readily as one with a line. A revoked character
 * standing silently in frame is that character's likeness, and permission is
 * about the likeness.
 *
 * The existing coverage in `performances.test.ts` only caught this for a
 * speaking shot, which is exactly the shape the condition let through.
 */
import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join,resolve} from "node:path";
import {ARTIFACT_PERMISSION_OWN_PATH,ARTIFACT_PERMISSION_UNGUARDED,artifactPermission,createApiServer} from "../src/server";
import {ProjectService} from "../src/index";
import {DurableJobStore,type Job} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {CAST_INPUT} from "../../../test/fixtures/casting";
import {renderShots} from "../../planner/src/shot-reuse";

const REPO_ROOT=resolve(import.meta.dir,"../../..");
/** No dialogue anywhere: every shot is silent, and the character is named in the action. */
const SILENT="INT. ROOM - DAY\n\nMarla stares at the lamp.\n\nEXT. GARDEN - DAY\n\nMarla walks away.";
/** The shape the old condition did catch, kept here as the regression half. */
const SPOKEN="INT. ROOM - DAY\n\nMarla greets the room.\n\nMARLA\nHello.\n\nEXT. GARDEN - DAY\n\nMarla walks away.";

const envKeys=["HV_TOKEN_SECRET","HV_ANIMATIC_PROVIDER_POOL","HV_PROVIDER_POOL","HV_NARRATION","HV_ANIMATIC_CAPTIONS"];
const originalEnv=Object.fromEntries(envKeys.map(key=>[key,process.env[key]]));
const fixtures:{root:string;server:ReturnType<typeof createApiServer>}[]=[];
afterAll(async()=>{
  for(const f of fixtures){await f.server.stop(true);rmSync(f.root,{recursive:true,force:true});}
  for(const [key,value] of Object.entries(originalEnv)){if(value===undefined)delete process.env[key];else process.env[key]=value;}
});

async function fixture(script:string,narration="0"){
  Object.assign(process.env,{HV_TOKEN_SECRET:"artifact-permission-fixture-secret-at-least-thirty-two",HV_ANIMATIC_PROVIDER_POOL:'["mock"]',HV_PROVIDER_POOL:'["image:mock"]',HV_NARRATION:narration,HV_ANIMATIC_CAPTIONS:"0"});
  const root=mkdtempSync(join(tmpdir(),"hv-artifact-permission-"));
  const paths={queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json")};
  const server=createApiServer({port:0,hostname:"127.0.0.1",...paths,rateLimit:{api:{limit:10000,windowMs:60000}}});
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
    const response=await call(base+"/jobs","POST",{idempotencyKey:crypto.randomUUID()},owner.token);
    expect(response.status).toBe(202);
    const job=await worker();
    expect(job?.failureReason??job?.cancelReason).toBeUndefined();
    expect(job?.status).toBe("done");
    return job!;
  };
  const urls=async(job:Job)=>{
    const status=await(await call("/api/jobs/"+job.id,"GET",undefined,owner.token)).json() as {output:{mp4Url:string;hlsUrl?:string;captionsUrl?:string}};
    return status.output;
  };
  const revoke=()=>projects.saveCharacter(owner.token,id,{...character,permission:{...character.permission,status:"revoked"}},1);
  const get=(url:string)=>fetch(new URL(url,server.url));
  return {root,paths,server,call,owner,base,projects,store,ledger,worker,render,urls,revoke,get,id,character};
}

test("a silent shot's media stops being served when its character's permission is revoked",async()=>{
  const f=await fixture(SILENT);
  const job=await f.render();
  // The fixture has to be the shape the old condition let through, or this
  // case is just re-testing `performances.test.ts`.
  const renders=job.output!.shotRenders!;
  expect(renders.length).toBeGreaterThan(0);
  expect(renders.some(render=>render.clip.speech)).toBe(false);
  // Silent, and the character is in every shot -- which is what makes the
  // revocation below mean something. `characterIds` lives on the plan's shots,
  // and `charactersForScene` matches a name in a scene's action.
  const shots=renderShots(job,Date.parse(job.startedAt??job.completedAt!));
  expect(shots.length).toBeGreaterThan(0);
  expect(shots.every(shot=>(shot.characterIds??[]).includes(f.id))).toBe(true);
  expect(job.lipSync).toBeUndefined();
  expect(job.soundMix).toBeUndefined();
  expect(job.pictureEdit).toBeUndefined();
  expect(job.assemblyEdit).toBeUndefined();
  expect(job.dialogueReplacement).toBeUndefined();

  const media=await f.urls(job);
  // Served before the revocation, so the 404 below is the revocation and not a
  // broken URL.
  expect((await f.get(media.mp4Url)).status).toBe(200);
  const before=await(await f.get(media.mp4Url)).arrayBuffer();
  expect(Buffer.from(before)).toEqual(readFileSync(join(f.paths.artifactRoot,job.output!.mp4Path!)));

  f.revoke();

  expect((await f.get(media.mp4Url)).status).toBe(404);
  expect((await fetch(new URL(media.mp4Url,f.server.url),{headers:{range:"bytes=0-15"}})).status).toBe(404);
  for(const url of [media.hlsUrl,media.captionsUrl].filter(Boolean) as string[]) {
    expect({url,status:(await f.get(url)).status}).toEqual({url,status:404});
  }
  // The same token, the same signature, the same project: only the cast
  // permission changed, and the media is gone.
  expect((await(await f.get(media.mp4Url)).json() as {error:string}).error).toBe("not found");
},60000);

test("the speaking case still refuses, so the narrower condition was not carrying it",async()=>{
  const f=await fixture(SPOKEN,"1");
  const job=await f.render();
  expect(job.output!.shotRenders!.some(render=>render.clip.speech)).toBe(true);
  const media=await f.urls(job);
  expect((await f.get(media.mp4Url)).status).toBe(200);
  f.revoke();
  expect((await f.get(media.mp4Url)).status).toBe(404);
},60000);

test("every job stage has a named media permission rule, and the route does not choose by shape",()=>{
  // The family guard. Six blocks, each conditioned on a field the job might not
  // have, is how the silent cut ended up unguarded — and the fix is not "add a
  // seventh block" but a total function over the stage, so that adding a stage
  // without deciding what guards its media is a test failure rather than a
  // silent hole.
  const strip=(text:string)=>text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,"");
  const flatten=(text:string)=>text.replace(/\s+/g," ");
  const server=strip(readFileSync(join(REPO_ROOT,"packages/api/src/server.ts"),"utf8"));
  const route=flatten(server.slice(server.indexOf('if (parts[0] === "artifacts"')));
  expect(route.length).toBeGreaterThan(500);

  // The route asks by stage and nothing else: the call is not inside a
  // statement that tests a job-shaped optional field, and the old speech
  // condition is gone.
  const call=route.indexOf("mediaPermission(mediaJob,project)");
  expect(call).toBeGreaterThan(-1);
  const statement=route.slice(0,call).slice(route.slice(0,call).lastIndexOf(";")+1);
  const SHAPED=/\b(?:lipSync|dialogueReplacement|soundMix|pictureEdit|assemblyEdit|shotRenders|speech)\b/;
  expect({statement,shaped:SHAPED.test(statement)}).toEqual({statement,shaped:false});
  expect(route).not.toContain("clip.speech");
  expect(route.match(/assertSelectedOutput/g)).toBeNull();
  // The two stages answered on their own path are still answered there.
  expect(route).toContain("assertGraphicPermission");
  expect(route).toContain("assertAudioTakePermission");
  // Self-exercise: the statement test bites on the shape it refuses.
  expect(SHAPED.test("if(mediaJob?.soundMix){try{ ")).toBe(true);
  expect(SHAPED.test(" if(mediaJob?.output&&mediaJob.stage!==\"motion-graphic\"){try{ ")).toBe(false);

  // And the rule is total over `JobStage`. The union is read from where it is
  // declared, so a new stage appears here without anyone remembering to add it.
  const queue=strip(readFileSync(join(REPO_ROOT,"packages/planner/src/render-stage.ts"),"utf8"));
  const union=queue.slice(queue.indexOf("export type JobStage="));
  const stages=[...union.slice(0,union.indexOf(";")).matchAll(/"([a-z-]+)"/g)].map(match=>match[1]!);
  const generation=queue.slice(queue.indexOf("export type GenerationStage="));
  const generationStages=[...generation.slice(0,generation.indexOf(";")).matchAll(/"([a-z-]+)"/g)].map(match=>match[1]!);
  const all=[...new Set([...stages,...generationStages])].sort();
  expect(all).toEqual(["animatic","assembly-edit","audio-take","character-sheet","dialogue-replacement","final","lip-sync","motion-graphic","picture-edit","sound-mix","take-final","take-preview"]);
  const body=flatten(server.slice(server.indexOf("export function artifactPermission")));
  const rule=body.slice(0,body.indexOf("function envInt"));
  for(const stage of all)expect({stage,handled:rule.includes('case "'+stage+'":')}).toEqual({stage,handled:true});
  // A `default:` would make the switch total without deciding anything, which
  // is the omission this guard exists to catch.
  expect(rule).not.toContain("default:");

  // And the stages answered with `null` are declared in one of the two lists,
  // so "no gate here" is a statement someone wrote down rather than a gap.
  // Every stage is in exactly one group.
  const gated=all.filter(stage=>![...ARTIFACT_PERMISSION_OWN_PATH,...ARTIFACT_PERMISSION_UNGUARDED].includes(stage as never));
  expect(gated.sort()).toEqual(["animatic","assembly-edit","dialogue-replacement","final","lip-sync","picture-edit","sound-mix"]);
  expect([...ARTIFACT_PERMISSION_OWN_PATH].sort()).toEqual(["audio-take","motion-graphic"]);
  expect([...ARTIFACT_PERMISSION_UNGUARDED].sort()).toEqual(["character-sheet","take-final","take-preview"]);
  expect(gated.every(stage=>typeof artifactPermission(stage as never)==="function")).toBe(true);
  expect([...ARTIFACT_PERMISSION_OWN_PATH,...ARTIFACT_PERMISSION_UNGUARDED].every(stage=>artifactPermission(stage)===null)).toBe(true);
  // The unguarded list is the increment's declared gap, and it is named in the
  // increment doc rather than only here.
  const doc=readFileSync(join(REPO_ROOT,"docs/loop/increments/HV-029-03.md"),"utf8");
  for(const stage of ARTIFACT_PERMISSION_UNGUARDED)expect({stage,declared:doc.includes(stage)}).toEqual({stage,declared:true});
});
