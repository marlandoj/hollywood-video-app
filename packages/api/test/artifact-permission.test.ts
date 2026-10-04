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
import {artifactPermission,createApiServer} from "../src/server";
import {ProjectService} from "../src/index";
import {DurableJobStore,type Job} from "../../queue/src/index";
import {processNextJob} from "../../queue/src/worker";
import {CostLedger,OperatorReviewQueue} from "../../operator/src/index";
import {CAST_INPUT} from "../../../test/fixtures/casting";
import {renderShots} from "../../planner/src/shot-reuse";
import {assertDialoguePermissions} from "../../planner/src/dialogue-jobs";

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
  const restore=()=>projects.saveCharacter(owner.token,id,character,2);
  const get=(url:string)=>fetch(new URL(url,server.url));
  return {root,paths,server,call,owner,base,projects,store,ledger,worker,render,urls,revoke,restore,get,id,character};
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
  // HEAD is a separate method on this route and gets the same answer.
  expect((await fetch(new URL(media.mp4Url,f.server.url),{method:"HEAD"})).status).toBe(404);
  // And playback, not just the playlist: a segment named by the playlist.
  const segment=media.hlsUrl!.replace(/index\.m3u8/,"segment-000.ts");
  expect(segment).not.toBe(media.hlsUrl);
  expect((await f.get(segment)).status).toBe(404);
  // The same token, the same signature, the same project: only the cast
  // permission changed, and the media is gone.
  expect((await(await f.get(media.mp4Url)).json() as {error:string}).error).toBe("not found");

  // The control that makes all of the above about *permission* rather than
  // about anything else that might have gone stale: restore it and the same
  // URL serves the same bytes again.
  f.restore();
  expect((await f.get(media.mp4Url)).status).toBe(200);
  expect(Buffer.from(await(await f.get(media.mp4Url)).arrayBuffer())).toEqual(Buffer.from(before));
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

test("a take group's clips are guarded too, by the take plan's own shots",async()=>{
  // Takes were the increment's first answer to "what guards this?" -- nothing,
  // declared. They are guarded now, because the only thing that differs from a
  // cut is how the shots are derived: `shotTakeShots` instead of `renderShots`,
  // which refuses a non-film stage outright. Without this case the take rule
  // could be replaced by `() => {}` with every other case green.
  const f=await fixture(SILENT);
  const view=await(await f.call(f.base+"/direction","GET",undefined,f.owner.token)).json() as {scriptVersion:number;plan:{source:{id:string};sourceHash:string}[];direction:{version:number}};
  const settings={shotId:view.plan[0]!.source.id,sourceHash:view.plan[0]!.sourceHash,
    takes:[35,50].map((lensMm,index)=>({label:"Take "+"AB"[index],seed:201+index,settings:{lensMm,durationFrames:30,previewMove:"static"}}))};
  const body={settings,expectedScriptVersion:view.scriptVersion,expectedCastingVersion:1,expectedDirectionVersion:view.direction.version,generationApproved:true};
  const created=await f.call(f.base+"/takes","POST",body,f.owner.token);
  expect(await created.clone().text()).not.toContain('"error"');
  expect(created.status).toBe(202);
  const job=await f.worker();
  expect(job?.status).toBe("done");
  expect(job?.stage).toBe("take-preview");

  const groups=await(await f.call(f.base+"/takes","GET",undefined,f.owner.token)).json() as {groups:{takeClips:{mp4Url:string}[]}[]};
  const clip=groups.groups[0]!.takeClips[0]!;
  expect((await f.get(clip.mp4Url)).status).toBe(200);
  f.revoke();
  expect((await f.get(clip.mp4Url)).status).toBe(404);
  f.restore();
  expect((await f.get(clip.mp4Url)).status).toBe(200);
},60000);

test("a job that binds no cast is still gated by the project, not by its shot plan", () => {
  // The first draft of this increment made the media path refuse any job whose
  // shot plan could not be derived. `renderShots` refuses a job with no
  // admitted provider plan outright -- and one exists: the S3 artifact suite
  // enqueues directly into the store, as CI found. Such a job also carries no
  // casting snapshot, so the loop `renderShots` feeds would run over an empty
  // cast and decide nothing; refusing there refused for a reason that was not
  // about permission.
  //
  // What must not go with it is the project-level precondition, which is the
  // half of `assertDialoguePermissions` that still applies to a job naming
  // nobody.
  const store = new DurableJobStore(null);
  const id = crypto.randomUUID(), projectId = crypto.randomUUID();
  const job = store.enqueue({id, idempotencyKey: id, projectId, stage: "animatic", tier: "free", scriptVersion: 1,
    totalFrames: 60, retryPolicy: {maxRetries: 1, backoffMs: 0}, timeoutMs: 60_000, costCapUsd: 1, budgetReservedUsd: 0,
    scriptText: "INT. ROOM - DAY\n\nA lamp glows.", rightsAttestedAt: new Date().toISOString(),
    animaticJobId: null, animaticApprovedAt: null} as never);
  expect(job.providerPlan).toBeUndefined();
  expect(job.casting).toBeUndefined();
  const project = {id: projectId, deleteAfter: new Date(Date.now() + 86_400_000).toISOString(),
    rightsAttestedAt: new Date().toISOString(), castingHistory: [], referenceAssets: []};

  expect(() => assertDialoguePermissions(job, project as never)).not.toThrow();
  // The precondition still refuses: rights withdrawn, and the project past its
  // deletion date.
  expect(() => assertDialoguePermissions(job, {...project, rightsAttestedAt: null} as never))
    .toThrow("Current project permission is unavailable.");
  expect(() => assertDialoguePermissions(job, {...project, deleteAfter: new Date(Date.now() - 1000).toISOString()} as never))
    .toThrow("Current project permission is unavailable.");
  // And the carve-out is scoped: a job that *does* bind a cast still has its
  // shots derived, so it still refuses when they cannot be.
  expect(() => assertDialoguePermissions({...job, casting: {schema: "hv-casting/1", projectId, version: 0, characters: [], createdAt: new Date().toISOString(), revision: "0".repeat(64)}} as never, project as never))
    .toThrow("admitted provider plan");
});

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
  const call=route.indexOf("artifactPermission(mediaJob.stage)(mediaJob,project)");
  expect(call).toBeGreaterThan(-1);
  const statement=route.slice(0,call).slice(route.slice(0,call).lastIndexOf(";")+1);
  const SHAPED=/\b(?:lipSync|dialogueReplacement|soundMix|pictureEdit|assemblyEdit|shotRenders|speech)\b/;
  expect({statement,shaped:SHAPED.test(statement)}).toEqual({statement,shaped:false});
  expect(route).not.toContain("clip.speech");
  expect(route.match(/assertSelectedOutput/g)).toBeNull();
  // The two stages answered on their own path are still answered there. The
  // audio rule is reached by name rather than spelled out here, so this
  // follows the reference to its one definition instead of pinning the text --
  // pinning the text is what made HV-029-04 fail this assertion by moving the
  // rule into a function, and would have passed had it made a second copy.
  expect(route).toContain("assertGraphicPermission");
  // Not `toContain`: "assertAudioTakePermission(mediaJob,project)" contains
  // "audioTakePermission(mediaJob,project)" as a substring, so a partial
  // reversion would satisfy a plain contains.
  expect(route).toMatch(/(?<![A-Za-z])audioTakePermission\(mediaJob,project\)/);
  // Bounded by the next declaration rather than by a brace-and-space pin,
  // which a reformat of the arrow body silently moves.
  const audioRule=flatten(server.slice(server.indexOf("const audioTakePermission=")));
  const audioBody=audioRule.slice(0,audioRule.indexOf("const mediaPermission="));
  expect(audioBody).toContain("assertAudioTakePermission(job,");
  expect(audioBody).toContain("permissionRevision");
  expect(audioBody).toContain("throw new Error("); // it refuses, rather than reporting
  // One definition, not one per path: the display paths and the media path
  // reach the same function. `\s*` so a reformatted call is still counted.
  expect(server.match(/assertAudioTakePermission\s*\(/g)).toHaveLength(1);
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
  // HV-030-30 added `feature-film`: a feature's joined film, guarded by every sequence film's cast.
  expect(all).toEqual(["animatic","assembly-edit","audio-take","character-sheet","delivery","dialogue-replacement","feature-film","final","lip-sync","motion-graphic","picture-edit","sound-mix","take-final","take-preview"]);
  const body=flatten(server.slice(server.indexOf("export function artifactPermission")));
  const rule=body.slice(0,body.indexOf("function envInt"));
  for(const stage of all)expect({stage,handled:rule.includes('case "'+stage+'":')}).toEqual({stage,handled:true});
  // A `default:` would make the switch total without deciding anything, which
  // is the omission this guard exists to catch.
  expect(rule).not.toContain("default:");

  // Every stage returns a rule -- none returns "nothing to check" -- and a
  // stage this build does not know still gets one, because `stage` arrives
  // from persisted JSON and is cast rather than validated. Reading "no rule
  // matched" as "no check needed" is the original defect one level up.
  for(const stage of all)expect({stage,rule:typeof artifactPermission(stage as never)}).toEqual({stage,rule:"function"});
  expect(()=>artifactPermission("a-stage-from-a-newer-build" as never)({} as never,{} as never)).toThrow("no media permission rule");
  // The fall-through is a deny, not a `default:` that decides nothing, and the
  // `never` binding is what makes a new union member a compile error.
  expect(rule).toContain("const unknown: never = stage;");

  // The route's whole statement chain, not just the `if` head: the first draft
  // sliced from the previous `;`, which left the `const mediaPermission = …;`
  // assignment outside the window, so putting the shape test *there* was green.
  const gate=route.slice(Math.max(0,call-400),call);
  expect({gate,shaped:SHAPED.test(gate)}).toEqual({gate,shaped:false});
  expect(gate).not.toContain("process.env");
  // And the rule itself cannot un-make the decision inside the function whose
  // existence this case checks.
  expect({rule,shaped:SHAPED.test(rule)}).toEqual({rule,shaped:false});
  // Nothing serves bytes before the gate: the route refuses an unknown job and
  // then checks, with no earlier response carrying a body.
  const before=route.slice(0,call);
  expect(before).toContain('if(!mediaJob)return response({error:"not found"},404);');
  expect(before).not.toMatch(/new Response\(Bun\.file|artifacts\.response/);
});
