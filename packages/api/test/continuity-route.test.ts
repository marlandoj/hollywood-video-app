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

async function fixture(){
  process.env.HV_TOKEN_SECRET="continuity-api-fixture-secret-at-least-thirty-two-characters";
  const root=mkdtempSync(join(tmpdir(),"hv-continuity-api-"));
  const server=createApiServer({port:0,hostname:"127.0.0.1",queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),
    artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json"),rateLimit:{api:{limit:10000,windowMs:60000}}});
  fixtures.push({root,server});
  const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,
    headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const owner=await(await call("/api/projects","POST")).json() as {projectId:string;token:string},base="/api/projects/"+owner.projectId;
  await call(base+"/script","PUT",{text:SCRIPT},owner.token);await call(base+"/rights","POST",{attested:true},owner.token);
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
  expect(scene.heading).toBe("INT. LIGHTHOUSE - DAY");expect(scene.packets[0]!.characters[0]!.name).toBe("MARGUERITE");
  expect(scene.packets[0]!.characters[0]!.wardrobe).toBe("An oilskin coat");
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
