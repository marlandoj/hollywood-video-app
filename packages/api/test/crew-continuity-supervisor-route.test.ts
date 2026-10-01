/**
 * HV-021-09 — the Continuity Supervisor speaks in the crew's plan.
 *
 * `POST /crew/plan` answers with the crew's notes. After the plan is applied, the Supervisor adds its
 * own: the continuity report the Director's desk serves at `GET /direction`, over the cast and
 * direction the plan just made, said one sentence per kind of finding. They are marked
 * `source: "continuity-report"` so nobody mistakes them for a model's words, and they cost nothing: the
 * only request a crew model sees is the plan's own.
 */
import {afterAll,beforeAll,expect,test} from "bun:test";
import {CrewLedger} from "../../operator/src/crew-ledger";
import {continuitySupervisorNotes} from "../../planner/src/crew/continuity-supervisor";
import type {ContinuityReport} from "../../planner/src/continuity";
import {createApiServer} from "../src/server";

const SCRIPT="INT. KITCHEN - DAY\n\nMaya pours tea.\n\nThe kettle sings.\n\nMAYA\nYou came back.\n\nEXT. GARDEN - NIGHT\n\nLeo waits in the rain.\n\nLEO\nI never left.";
const PLAN_SYSTEM="turning a creator's answers into a production plan";
const root=`/tmp/hv-crew-continuity-supervisor-${Date.now()}`;
const generous={api:{limit:1_000_000,windowMs:60_000},projectCreate:{limit:1_000_000,windowMs:3600_000},artifacts:{limit:1_000_000,windowMs:60_000}};
let server:ReturnType<typeof createApiServer>,base:string;
/** Every request the crew model was sent, and any that was not the plan's own. */
const asked:string[]=[],unexpected:string[]=[];
beforeAll(()=>{
  process.env.HV_TOKEN_SECRET="test-secret-that-is-at-least-thirty-two-characters";
  // A crew model that fails the test if it is asked anything but the plan, and answers unusably so the stand-in plans.
  const crewModel={name:"anthropic",model:"recorded",complete:async(request:{system:string})=>{asked.push(request.system);if(!request.system.includes(PLAN_SYSTEM))unexpected.push(request.system);
    return {text:"{}",model:"claude-sonnet-5",usage:{inputTokens:1,outputTokens:1},costUsd:0.01};}};
  server=createApiServer({port:0,hostname:"127.0.0.1",frontendOrigin:"https://staging.example.test",rateLimit:generous,queuePath:`${root}/jobs.json`,artifactRoot:`${root}/artifacts`,
    statePath:`${root}/projects.json`,costLedgerPath:`${root}/cost.json`,crewLedger:new CrewLedger(`${root}/crew-ledger.json`),crewModel:crewModel as never});
  base=`http://127.0.0.1:${server.port}`;
});
afterAll(()=>server.stop(true));

async function project(){
  const created=await (await fetch(`${base}/api/projects`,{method:"POST"})).json() as {projectId:string;token:string};
  const headers={authorization:`Bearer ${created.token}`,"content-type":"application/json"};
  await fetch(`${base}/api/projects/${created.projectId}/script`,{method:"PUT",headers,body:JSON.stringify({text:SCRIPT})});
  return {...created,headers};
}
type Note={persona:string;change:string;source?:string};
const plan=async(id:string,headers:Record<string,string>,expected:Record<string,number>)=>{
  const response=await fetch(`${base}/api/projects/${id}/crew/plan`,{method:"POST",headers,body:JSON.stringify({format:"reel",tone:"quiet",answers:[],expected})});
  return {status:response.status,body:await response.json() as {notes:Note[];source:string;crewSpend:{usd:number};continuityComparisons:number}};
};
const desk=async(id:string,headers:Record<string,string>)=>(await (await fetch(`${base}/api/projects/${id}/direction`,{headers})).json() as {continuity:ContinuityReport}).continuity;

test("the plan's notes end with the Supervisor's, which are exactly the desk's continuity report said in words",async()=>{
  const {projectId,headers}=await project();
  const {status,body}=await plan(projectId,headers,{scriptVersion:1,castingVersion:0,directionVersion:0});
  expect(status).toBe(200);
  const supervisor=body.notes.filter(note=>note.persona==="continuity");
  // The report the desk serves for the film the plan just made, read by the same function.
  const report=await desk(projectId,headers);
  expect(report.scenes.some(scene=>scene.findings.length)).toBe(true);
  expect(supervisor).toEqual(continuitySupervisorNotes(report));
  // And how many checks that report could make, which is what the studio's credit is decided by.
  expect(body.continuityComparisons).toBe(report.totals.lookComparisons+report.totals.wardrobeComparisons+report.totals.handoffComparisons);
  expect(body.continuityComparisons).toBeGreaterThan(0);
  expect(supervisor.every(note=>note.source==="continuity-report")).toBe(true);
  // They come after the crew's own notes, which carry no source and are unchanged.
  expect(body.notes.slice(-supervisor.length)).toEqual(supervisor);
  expect(body.notes.filter(note=>note.persona!=="continuity").every(note=>!("source" in note))).toBe(true);
  expect(body.notes.map(note=>note.persona)).toContain("cinematographer");
  // A second pass changes nothing, and the Supervisor says the same of the same report.
  const again=await plan(projectId,headers,{scriptVersion:1,castingVersion:1,directionVersion:1});
  expect(again.body.notes.filter(note=>note.persona==="continuity")).toEqual(supervisor);
});

test("the Supervisor costs nothing: the crew model is asked only for the plan",async()=>{
  asked.length=0;unexpected.length=0;
  const {projectId,headers}=await project();
  const {status,body}=await plan(projectId,headers,{scriptVersion:1,castingVersion:0,directionVersion:0});
  expect(status).toBe(200);
  expect(body.notes.some(note=>note.persona==="continuity")).toBe(true);
  expect(unexpected).toEqual([]);
  expect(asked).toHaveLength(1);
  // The spend is the plan's one request, and nothing more.
  expect(body.crewSpend.usd).toBe(0.01);
  expect(body.source).toBe("stand-in");
});
