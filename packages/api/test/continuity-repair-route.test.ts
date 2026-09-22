import {afterAll,expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../src/server";
import type {DirectionEntry,DirectionSnapshot} from "../../planner/src/direction";
import type {ContinuityReport} from "../../planner/src/continuity";
import type {ContinuityRepairProposal} from "../../planner/src/continuity-repair";

const SCRIPT="INT. LIGHTHOUSE - DAY\n\nMarguerite winds the lamp.\n\nTomas climbs the stair.\n\nMarguerite watches the sea.\n\nEXT. CLIFF - NIGHT\n\nTomas walks the path.";
interface View {direction:DirectionSnapshot;plan:DirectionEntry[];scriptVersion:number;continuity:ContinuityReport;staleShotIds?:string[]}
interface Review {report:ContinuityReport;proposal:ContinuityRepairProposal;summary:string;scriptVersion:number}
const fixtures:{root:string;server:ReturnType<typeof createApiServer>}[]=[];
afterAll(async()=>{for(const f of fixtures){await f.server.stop(true);rmSync(f.root,{recursive:true,force:true});}});

async function fixture(){
  process.env.HV_TOKEN_SECRET="continuity-repair-fixture-secret-at-least-thirty-two-characters";
  const root=mkdtempSync(join(tmpdir(),"hv-continuity-repair-"));
  const server=createApiServer({port:0,hostname:"127.0.0.1",queuePath:join(root,"jobs.json"),statePath:join(root,"projects.json"),
    artifactRoot:join(root,"artifacts"),costLedgerPath:join(root,"ledger.json"),rateLimit:{api:{limit:10000,windowMs:60000}}});
  fixtures.push({root,server});
  const call=(path:string,method="GET",body?:unknown,token?:string)=>fetch(new URL(path,server.url),{method,
    headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});
  const owner=await(await call("/api/projects","POST")).json() as {projectId:string;token:string},base="/api/projects/"+owner.projectId;
  await call(base+"/script","PUT",{text:SCRIPT},owner.token);await call(base+"/rights","POST",{attested:true},owner.token);
  const view=()=>call(base+"/direction","GET",undefined,owner.token).then(response=>response.json() as Promise<View>);
  const direct=async(shotId:string,settings:Record<string,unknown>)=>{
    const state=await view(),plan=state.plan.find(entry=>entry.source.id===shotId)!;
    const saved=await call(base+"/direction/"+shotId,"PUT",{settings:{...plan.settings,...settings},sourceHash:plan.sourceHash,
      expectedVersion:state.direction.version,expectedScriptVersion:state.scriptVersion},owner.token);
    expect(saved.status).toBe(200);
  };
  const repair=(body:unknown={},token:string|null=owner.token)=>call(base+"/direction/continuity/repair","POST",body,token??undefined);
  const accept=(body:unknown,token=owner.token)=>call(base+"/direction/continuity/repair/accept","POST",body,token);
  return {owner,base,call,view,direct,repair,accept};
}

test("the Supervisor offers the one repair it can make, and applying it holds the scene's first look",async()=>{
  const f=await fixture();
  await f.direct("shot-1-1",{keyLight:"The lamp above"});
  await f.direct("shot-1-2",{keyLight:"Moon through glass"});
  const reviewed=await f.repair();
  expect(reviewed.status).toBe(200);
  const review=await reviewed.json() as Review;
  expect(review.proposal.edits).toEqual([{shotId:"shot-1-2",sceneIndex:0,field:"keyLight",from:"Moon through glass",to:"The lamp above"}]);
  expect(review.summary).toContain("Hold key light");
  expect(review.report.scenes[0]!.findings.some(finding=>finding.code==="look-changed")).toBe(true);

  // Reviewing changes nothing.
  const before=await f.view();
  expect(before.direction.version).toBe(2);

  const applied=await f.accept({edits:review.proposal.edits,expectedVersion:before.direction.version,expectedScriptVersion:before.scriptVersion});
  expect(applied.status).toBe(200);
  const after=await f.view();
  expect(after.direction.version).toBe(3);
  const saved=(state:View,shotId:string)=>state.direction.entries.find(entry=>entry.source.id===shotId)!;
  expect(saved(after,"shot-1-2").settings.keyLight).toBe("The lamp above");
  // The shot that stated it first is untouched, and the drift is gone from the desk's own report.
  expect(saved(after,"shot-1-1").settings.keyLight).toBe("The lamp above");
  // The repair moved the settings and left the source binding exactly as the creator saved it.
  expect(saved(after,"shot-1-2").sourceHash).toBe(saved(before,"shot-1-2").sourceHash);
  expect(after.staleShotIds ?? []).toEqual([]);
  expect(after.continuity.scenes[0]!.findings.some(finding=>finding.code==="look-changed")).toBe(false);
  // And there is nothing left to repair.
  const again=await f.repair();
  expect(((await again.json()) as Review).proposal.edits).toEqual([]);
});

test("a repair applies only what the creator was shown, and only for the owner",async()=>{
  const f=await fixture();
  await f.direct("shot-1-1",{keyLight:"The lamp above"});
  await f.direct("shot-1-2",{keyLight:"Moon through glass"});
  const state=await f.view(),review=await(await f.repair()).json() as Review;

  expect((await f.repair({},null)).status).toBe(401);
  const other=await(await f.call("/api/projects","POST")).json() as {token:string};
  expect((await f.repair({},other.token)).status).toBe(401);
  expect((await f.accept({edits:review.proposal.edits,expectedVersion:state.direction.version,expectedScriptVersion:state.scriptVersion},other.token)).status).toBe(401);

  // An edit the creator invented, or one recomputed differently, is refused rather than applied.
  const invented=await f.accept({edits:[{...review.proposal.edits[0]!,to:"A different lamp"}],expectedVersion:state.direction.version,expectedScriptVersion:state.scriptVersion});
  expect(invented.status).toBe(409);
  expect((await invented.json() as {error:string}).error).toContain("Review a new one");
  expect((await f.accept({edits:[],expectedVersion:state.direction.version,expectedScriptVersion:state.scriptVersion})).status).toBe(409);
  expect((await f.accept({edits:review.proposal.edits,expectedVersion:state.direction.version+5,expectedScriptVersion:state.scriptVersion})).status).toBe(409);
  expect((await f.accept({edits:review.proposal.edits,expectedVersion:state.direction.version,expectedScriptVersion:state.scriptVersion+5})).status).toBe(409);
  // Nothing was applied by any of those.
  expect((await f.view()).direction.version).toBe(state.direction.version);
  // And a film with no drift has nothing to accept.
  const clean=await fixture();
  await clean.direct("shot-1-1",{keyLight:"The lamp above"});
  const cleanState=await clean.view();
  const nothing=await clean.accept({edits:[],expectedVersion:cleanState.direction.version,expectedScriptVersion:cleanState.scriptVersion});
  expect(nothing.status).toBe(400);
  expect((await nothing.json() as {error:string}).error).toContain("contradicts itself");
});
