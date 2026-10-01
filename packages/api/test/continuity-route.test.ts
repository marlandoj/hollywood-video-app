import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../src/server";
import type {DirectionEntry,DirectionSnapshot} from "../../planner/src/direction";
import type {ContinuityReport} from "../../planner/src/continuity";

const SCRIPT="INT. LIGHTHOUSE - DAY\n\nMarguerite winds the lamp.\n\nTomas climbs the stair.\n\nMARGUERITE\nThe light has to hold.\n\nEXT. CLIFF - NIGHT\n\nTomas walks the path.";
const CHARACTER={name:"MARGUERITE",aliases:[],kind:"original-fictional",appearance:"A keeper of the light in an oilskin coat.",
  ageRange:"adult",ethnicity:"",body:"",hairMakeup:"",expressions:"",movement:"",relationships:"",arcNotes:"",prohibitedChanges:"The coat stays",
  wardrobe:[{sceneNumber:null,description:"An oilskin coat"}],permission:{status:"permitted",scope:"project",sceneNumbers:[],expiresAt:null,attested:true}};
interface View {direction:DirectionSnapshot;plan:DirectionEntry[];scriptVersion:number;castingRevision:string;continuity:ContinuityReport}
const fixtures:{root:string;server:ReturnType<typeof createApiServer>}[]=[];
afterAll(async()=>{for(const f of fixtures){await f.server.stop(true);rmSync(f.root,{recursive:true,force:true});}});

async function fixture(script=SCRIPT){
  process.env.HV_TOKEN_SECRET="continuity-api-fixture-secret-at-least-thirty-two-characters";
  const root=mkdtempSync(join(tmpdir(),"hv-continuity-api-"));
  const server=createApiServer({port:0,hostname:"127.0.0.1",queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),
    artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json"),rateLimit:{api:{limit:10000,windowMs:60000}}});
  fixtures.push({root,server});
  const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,
    headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const owner=await(await call("/api/projects","POST")).json() as {projectId:string;token:string},base="/api/projects/"+owner.projectId;
  await call(base+"/script","PUT",{text:script},owner.token);await call(base+"/rights","POST",{attested:true},owner.token);
  const view=()=>call(base+"/direction","GET",undefined,owner.token).then(response=>response.json() as Promise<View>);
  return {root,server,call,owner,base,view};
}

test("the Director's desk serves the continuity report, bound to the cast and direction it was computed from",async()=>{
  const f=await fixture();
  const cast=await f.call(f.base+"/cast/"+crypto.randomUUID(),"PUT",{expectedVersion:0,character:CHARACTER},f.owner.token);
  expect(cast.status).toBe(200);
  const before=await f.view();
  expect(before.continuity.schema).toBe("hv-continuity/1");
  expect(before.continuity.castingRevision).toBe(before.castingRevision);
  expect(before.continuity.directionRevision).toBe(before.direction.revision);
  const scene=before.continuity.scenes[0]!;
  expect(scene.heading).toBe("INT. LIGHTHOUSE - DAY");expect(scene.characters[0]!.name).toBe("MARGUERITE");
  expect(scene.characters[0]!.wardrobe).toBe("An oilskin coat");
  // Nothing is declared yet, so the report says what it could not check rather than passing the film.
  expect(before.continuity.totals.warnings).toBe(0);
  expect(scene.findings.find(finding=>finding.code==="identity-unanchored")).toMatchObject({severity:"unknown"});
  expect(scene.findings.find(finding=>finding.code==="identity-unanchored")!.message).toContain("MARGUERITE");

  const saved=await f.call(f.base+"/direction/shot-1-1","PUT",{settings:{...before.plan[0]!.settings,timeOfDay:"night"},
    sourceHash:before.plan[0]!.sourceHash,expectedVersion:before.direction.version,expectedScriptVersion:before.scriptVersion},f.owner.token);
  expect(saved.status).toBe(200);
  const after=await f.view(),warning=after.continuity.scenes[0]!.findings.find(finding=>finding.code==="time-contradicts-heading")!;
  expect(warning).toMatchObject({severity:"warning",shotIds:["shot-1-1"]});
  expect(warning.message).toContain("heading reads day");
  expect(after.continuity.directionRevision).toBe(after.direction.revision);
  expect(after.continuity.revision).not.toBe(before.continuity.revision);

  expect((await f.call(f.base+"/direction","GET")).status).toBe(401);
  const other=await(await f.call("/api/projects","POST")).json() as {token:string};
  expect((await f.call(f.base+"/direction","GET",undefined,other.token)).status).toBe(401);
});

/**
 * HV-021-08: a CONTINUOUS scene is checked against the scene it continues, through the desk's real
 * route. The cast's own per-scene wardrobe changes across the heading, and then a shot is directed to
 * the opposite time of day; each is a warning on the CONTINUOUS scene, counted in the totals, and the
 * review names both as contradictions the repair leaves alone.
 */
test("the desk reports a CONTINUOUS scene that contradicts the scene before it, and the repair review names it",async()=>{
  const f=await fixture("INT. LIGHTHOUSE - DAY\n\nMarguerite winds the lamp.\n\nINT. STAIRWELL - CONTINUOUS\n\nMarguerite follows the stair down.");
  const cast=await f.call(f.base+"/cast/"+crypto.randomUUID(),"PUT",{expectedVersion:0,character:{...CHARACTER,
    wardrobe:[{sceneNumber:1,description:"An oilskin coat"},{sceneNumber:2,description:"A wet jumper"}]}},f.owner.token);
  expect(cast.status).toBe(200);
  const before=await f.view(),scene=before.continuity.scenes[1]!;
  expect(scene.heading).toBe("INT. STAIRWELL - CONTINUOUS");
  const wardrobe=scene.findings.find(finding=>finding.code==="wardrobe-contradicts-previous")!;
  expect(wardrobe).toMatchObject({severity:"warning",shotIds:scene.shotIds});
  expect(wardrobe.message).toContain("MARGUERITE wears “An oilskin coat” in scene 1 and “A wet jumper” in scene 2");
  expect(before.continuity.totals.warnings).toBe(1);expect(before.continuity.totals.continuousComparisons).toBe(1);

  const shotId=scene.shotIds[0]!,plan=before.plan.find(entry=>entry.source.id===shotId)!;
  const saved=await f.call(f.base+"/direction/"+shotId,"PUT",{settings:{...plan.settings,timeOfDay:"night"},
    sourceHash:plan.sourceHash,expectedVersion:before.direction.version,expectedScriptVersion:before.scriptVersion},f.owner.token);
  expect(saved.status).toBe(200);
  const after=await f.view(),time=after.continuity.scenes[1]!.findings.find(finding=>finding.code==="time-contradicts-previous")!;
  expect(time).toMatchObject({severity:"warning",shotIds:[shotId]});
  expect(time.message).toContain("headed “INT. LIGHTHOUSE - DAY”");
  expect(after.continuity.totals.warnings).toBe(2);expect(after.continuity.totals.continuousComparisons).toBe(2);
  expect(after.continuity.revision).not.toBe(before.continuity.revision);

  const review=await(await f.call(f.base+"/direction/continuity/repair","POST",{},f.owner.token)).json() as {proposal:{edits:unknown[];notes:string[]};summary:string};
  expect(review.proposal.edits).toEqual([]);
  expect(review.summary).toContain("a CONTINUOUS scene's time of day contradicts the scene before it");expect(review.summary).toContain("a character's wardrobe changes across a CONTINUOUS heading");
  expect(review.proposal.notes.filter(note=>note.startsWith("Scene 2 is CONTINUOUS from Scene 1"))).toHaveLength(2);
});
