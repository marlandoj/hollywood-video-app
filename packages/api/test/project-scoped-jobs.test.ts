/**
 * HV-029-06 — `all()` is every job in the studio, and one listing forgot.
 *
 * `scopedJobs(projectId)` narrows the *store* on PostgreSQL and hands back the shared store on the
 * JSON backend, where `all()` is every job in the studio. `server.ts` said so in a comment and
 * re-filtered by hand at thirteen call sites. The character-sheet listing was the fourteenth.
 *
 * The character id is not a secret from anyone the owner shares an actor with — that is what an
 * actor share is for, and the share carries the id. So a stranger with their own free project
 * could read another project's character-sheet jobs: the job id, the project id, the character's
 * name in the captions, the sheet plan and its seed, the provider plan, the cost cap and the
 * timings. The media itself is still refused by `/artifacts/`, which asks a different question and
 * asks it properly; what went out is the job body.
 *
 * The repair is not another hand-written filter. `projectJobs(projectId)` is the only place in
 * this file that calls `all()`, and the last test here asserts that over the source, because the
 * defect is one missing conjunct that reads exactly like the thirteen correct ones.
 */
import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,readFileSync,readdirSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {fileURLToPath} from "node:url";
import {createApiServer} from "../src/server";
import {DurableJobStore} from "../../queue/src/index";
import {CAST_INPUT,CAST_SCRIPT} from "../../../test/fixtures/casting";

const fixtures:{root:string;server:ReturnType<typeof createApiServer>}[]=[];
afterAll(async()=>{for(const f of fixtures){await f.server.stop(true);rmSync(f.root,{recursive:true,force:true});}});

/** One server, one job store, two projects — which is the situation the filter exists for. */
async function studio(){
  process.env.HV_TOKEN_SECRET="project-scoped-jobs-secret-at-least-thirty-two-characters";
  const root=mkdtempSync(join(tmpdir(),"hv-project-scoped-jobs-"));
  const paths={queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json")};
  const server=createApiServer({port:0,hostname:"127.0.0.1",...paths,rateLimit:{api:{limit:10000,windowMs:60000}}});
  fixtures.push({root,server});
  const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,
    headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const project=async(name:string)=>{
    const owner=await(await call("/api/projects","POST")).json() as {projectId:string;token:string},base="/api/projects/"+owner.projectId;
    await call(base+"/script","PUT",{text:CAST_SCRIPT},owner.token);
    await call(base+"/rights","POST",{attested:true},owner.token);
    const characterId=crypto.randomUUID();
    expect((await call(base+"/cast/"+characterId,"PUT",{expectedVersion:0,character:{...CAST_INPUT,name}},owner.token)).status).toBe(200);
    const sheets=async()=>await(await call(base+"/cast/"+characterId+"/sheets","GET",undefined,owner.token)).json() as {jobs:{id:string}[]};
    const orderSheet=async()=>expect((await call(base+"/cast/"+characterId+"/sheets","POST",
      {generationApproved:true,expectedVersion:1,settings:{kind:"turnaround",seed:123,sceneNumber:null}},owner.token)).status).toBe(202);
    const foreignSheets=async(otherCharacterId:string)=>await(await call(base+"/cast/"+otherCharacterId+"/sheets","GET",undefined,owner.token)).json() as {jobs:{id:string}[]};
    return {owner,base,characterId,sheets,orderSheet,foreignSheets};
  };
  return {root,paths,call,project,store:new DurableJobStore(paths.queuePath)};
}

test("a character-sheet listing answers for one project, even though the store's list is the studio's",async()=>{
  const s=await studio(),victim=await s.project("Marguerite"),stranger=await s.project("Tomas");
  await victim.orderSheet();
  // The one store holds the one job, and it is the victim's.
  expect(s.store.all().map(job=>job.projectId)).toEqual([victim.owner.projectId]);

  // The owner still sees it. A scoping fix that answered nothing would pass the test below.
  const mine=await victim.sheets();
  expect(mine.jobs).toHaveLength(1);
  expect(mine.jobs[0]!.id).toBe(s.store.all()[0]!.id);

  // The stranger holds the character id -- an actor share hands it out -- and their own project.
  const stolen=await stranger.foreignSheets(victim.characterId);
  expect(stolen.jobs).toEqual([]);
  // And nothing of the victim's job is anywhere in the body, at any depth.
  const body=JSON.stringify(stolen);
  for(const secret of [victim.owner.projectId,s.store.all()[0]!.id,"Marguerite"]) expect(body).not.toContain(secret);
  // The stranger's own listing is empty because they ordered nothing, not because the route broke.
  expect((await stranger.sheets()).jobs).toEqual([]);
  await stranger.orderSheet();
  expect((await stranger.sheets()).jobs).toHaveLength(1);
  expect((await stranger.sheets()).jobs[0]!.id).not.toBe(mine.jobs[0]!.id);
  // The victim's listing did not grow when a stranger ordered one.
  expect((await victim.sheets()).jobs).toHaveLength(1);
});

test("a stranger's project cannot be probed for which of its characters exist",async()=>{
  const s=await studio(),victim=await s.project("Marguerite"),stranger=await s.project("Tomas");
  await victim.orderSheet();
  // A character that exists and has a sheet, one that exists in another project, and one that
  // exists nowhere: the same answer, so the listing says nothing about another project's cast.
  const answers=await Promise.all([victim.characterId,stranger.characterId,crypto.randomUUID()].map(id=>stranger.foreignSheets(id)));
  expect(answers.map(answer=>answer.jobs.length)).toEqual([0,0,0]);
  expect(new Set(answers.map(answer=>JSON.stringify(answer))).size).toBe(1);
});

test("the filter is in one place, so the next listing cannot forget it",()=>{
  // HV-029-06 put the filter in one place in `server.ts`; HV-029-07 made that place the only one in
  // the package. `all()` over a per-project store is safe only when the caller narrows to the
  // project, and twenty more call sites across six modules wrote that conjunct by hand -- every one
  // of them correct, which is exactly what the thirteen correct ones here were.
  const directory=fileURLToPath(new URL("../src/",import.meta.url));
  const files=readdirSync(directory).filter((name:string)=>name.endsWith(".ts")).sort();
  expect(files.length).toBeGreaterThanOrEqual(8);
  // Every `X.all()` in the package, with the thing it is called on.
  const receivers=(source:string)=>[...source.matchAll(/([A-Za-z_$][\w$]*(?:\([^()]*\))?)\.all\(\)/g)].map(match=>match[1]!);
  const elsewhere:Record<string,string[]>={};
  for(const name of files){
    const found=receivers(readFileSync(join(directory,name),"utf8"));
    if(found.length)elsewhere[name]=found;
  }
  // `project-jobs.ts` narrows; `server.ts` reads the *unscoped* store twice, for the health route's
  // queue depth and the operator's own diagnostics, both of which are about the studio and not a
  // project. Nothing else calls `all()` at all.
  expect(elsewhere).toEqual({"project-jobs.ts":["store(projectId)"],"server.ts":["jobs","jobs"]});
  const helper=readFileSync(join(directory,"project-jobs.ts"),"utf8");
  expect(helper).toContain("store(projectId).all()");
  expect(helper).toContain("job.projectId === projectId");
  // And every listing goes through it, here and in the modules the server mounts.
  const uses=files.reduce((total:number,name:string)=>total+(readFileSync(join(directory,name),"utf8").match(/projectJobs\(|jobsForProject\(/g) ?? []).length,0);
  expect(uses).toBeGreaterThanOrEqual(34);
});
