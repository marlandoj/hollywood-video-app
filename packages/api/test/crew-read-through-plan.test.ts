/**
 * HV-030-15 — the read-through described a film the studio would not make.
 *
 * The Producer's read-through computes the "studio facts" the creator sees first and the crew is told
 * not to restate: shots, runtime, the final-video quote, and whether the script runs past its format.
 * It computed them from `planShots(parsed)`: no shot limit, and no accepted scene cuts. The plan step
 * and a free-tier render use `sourcePlan(parsed, direction, 7000, 24)`. So a four-scene script of forty
 * action paragraphs was read as 40 shots, 80 s and a $14 quote -- and "over_format" for a reel -- while
 * the plan and the render made 24 shots and 48 s; and the plan prompt told the model "shots: 40
 * (computed, do not restate differently)" beside a list of 24 shot ids.
 *
 * The facts are now computed from the same plan the plan step and the render use.
 */
import {afterAll,beforeAll,expect,test} from "bun:test";
import {CrewLedger} from "../../operator/src/crew-ledger";
import {parseFountain} from "../../parser/src/index";
import {readThroughFacts} from "../../planner/src/crew/read-through";
import {sourcePlan} from "../../planner/src/scene-cuts";
import {createApiServer} from "../src/server";

const root=`/tmp/hv-crew-read-through-plan-${Date.now()}`;
const generous={api:{limit:1_000_000,windowMs:60_000},projectCreate:{limit:1_000_000,windowMs:3600_000},artifacts:{limit:1_000_000,windowMs:60_000}};
let script="";for(let scene=1;scene<=4;scene++){script+=`INT. ROOM ${scene} - DAY\n\n`;for(let beat=1;beat<=10;beat++)script+=`Beat ${beat} of scene ${scene}: she crosses to the window and looks out.\n\n`;}
let server:ReturnType<typeof createApiServer>,base:string;
beforeAll(()=>{
  process.env.HV_TOKEN_SECRET="test-secret-that-is-at-least-thirty-two-characters";
  server=createApiServer({port:0,hostname:"127.0.0.1",frontendOrigin:"https://staging.example.test",rateLimit:generous,queuePath:`${root}/jobs.json`,artifactRoot:`${root}/artifacts`,
    statePath:`${root}/projects.json`,costLedgerPath:`${root}/cost.json`,crewLedger:new CrewLedger(),crewModel:null});
  base=`http://127.0.0.1:${server.port}`;
});
afterAll(()=>server.stop(true));

test("what the defect did, measured: the script alone reads as more film than the plan makes",()=>{
  const parsed=parseFountain(script),planned=sourcePlan(parsed,undefined,7000,24);
  expect({alone:readThroughFacts(script,parsed,{format:"short",tone:""}).shots,planned:planned.length}).toEqual({alone:40,planned:24});
});

test("the read-through's facts are the plan's: 24 shots and the runtime they add up to",async()=>{
  const created=await (await fetch(`${base}/api/projects`,{method:"POST"})).json() as {projectId:string;token:string};
  const headers={authorization:`Bearer ${created.token}`,"content-type":"application/json"};
  await fetch(`${base}/api/projects/${created.projectId}/script`,{method:"PUT",headers,body:JSON.stringify({text:script})});
  const answer=await (await fetch(`${base}/api/projects/${created.projectId}/crew/read-through`,{method:"POST",headers,body:JSON.stringify({format:"short",tone:""})})).json() as {facts:{shots:number;estimatedRuntimeSec:number}};
  const planned=sourcePlan(parseFountain(script),undefined,7000,24);
  expect({shots:answer.facts.shots,runtime:answer.facts.estimatedRuntimeSec}).toEqual({shots:24,runtime:Math.round(planned.reduce((total,shot)=>total+shot.durationSec,0))});
});
