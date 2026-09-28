/**
 * HV-030-17 — the read-through sent a tone the plan step refuses to the paid crew model.
 *
 * The creator's tone goes into two crew prompts. The plan route reads it with `planInput`, which
 * puts it through the prompt gate (`checkPrompt`) and refuses control characters, like every other
 * string the crew is given. The read-through route, the first one the creator reaches, read it with
 * `readThroughInput`, which checked only that it was a string of 200 characters or fewer. So "Like
 * a Taylor Swift music video" went to the Anthropic model -- and was paid for -- in the
 * read-through, and the stand-in crew echoed it back in its summary ("Played for …"), although the
 * file's own header says every string passes the same prompt gate as any prompt. The creator found
 * out only at the next step, when the same tone was refused.
 *
 * The read-through now refuses it up front, with nothing sent. Safety refusals may only grow; this
 * one adds a place, not a rule.
 */
import {afterAll,beforeAll,expect,test} from "bun:test";
import {CrewLedger} from "../../operator/src/crew-ledger";
import {planInput} from "../../planner/src/crew/production-plan";
import {readThroughInput} from "../../planner/src/crew/read-through";
import {createApiServer} from "../src/server";

const REFUSED=["Like a Taylor Swift music video","Warm\u0007 and quiet"];
const root=`/tmp/hv-crew-read-through-tone-${Date.now()}`;
const generous={api:{limit:1_000_000,windowMs:60_000},projectCreate:{limit:1_000_000,windowMs:3600_000},artifacts:{limit:1_000_000,windowMs:60_000}};
let server:ReturnType<typeof createApiServer>,base:string;
const sent:string[]=[];
beforeAll(()=>{
  process.env.HV_TOKEN_SECRET="test-secret-that-is-at-least-thirty-two-characters";
  // A crew model that records what it is asked and answers with something unusable, so the stand-in writes the voice.
  const crewModel={complete:async(request:{messages:{content:string}[]})=>{sent.push(request.messages.map(message=>message.content).join("\n"));
    return {text:"{}",model:"recorded",usage:{inputTokens:1,outputTokens:1},costUsd:0};}};
  server=createApiServer({port:0,hostname:"127.0.0.1",frontendOrigin:"https://staging.example.test",rateLimit:generous,queuePath:`${root}/jobs.json`,artifactRoot:`${root}/artifacts`,
    statePath:`${root}/projects.json`,costLedgerPath:`${root}/cost.json`,crewLedger:new CrewLedger(),crewModel:crewModel as never});
  base=`http://127.0.0.1:${server.port}`;
});
afterAll(()=>server.stop(true));

async function readThrough(tone:string){
  const created=await (await fetch(`${base}/api/projects`,{method:"POST"})).json() as {projectId:string;token:string};
  const headers={authorization:`Bearer ${created.token}`,"content-type":"application/json"};
  await fetch(`${base}/api/projects/${created.projectId}/script`,{method:"PUT",headers,body:JSON.stringify({text:"INT. KITCHEN - DAY\n\nMaya pours tea.\n\nMAYA\nYou came back.\n"})});
  const r=await fetch(`${base}/api/projects/${created.projectId}/crew/read-through`,{method:"POST",headers,body:JSON.stringify({format:"reel",tone})});
  return {status:r.status,body:await r.json() as {error?:string;summary?:string}};
}

test("the read-through refuses every tone the plan step refuses",()=>{
  for(const tone of REFUSED){
    expect(()=>planInput({format:"reel",tone,answers:[]})).toThrow();
    expect(()=>readThroughInput({format:"reel",tone})).toThrow("nothing was sent to the crew");
  }
  // An ordinary tone, and none at all, are read as before.
  expect(readThroughInput({format:"reel",tone:"  Hopeful, quiet, a little funny. "})).toEqual({format:"reel",tone:"Hopeful, quiet, a little funny."});
  expect(readThroughInput({format:"short",tone:""})).toEqual({format:"short",tone:""});
});

test("a refused tone is answered 400 before the crew model is asked anything",async()=>{
  sent.length=0;
  for(const tone of REFUSED){
    const answer=await readThrough(tone);
    expect({tone,status:answer.status}).toEqual({tone,status:400});
    expect(answer.body.error).toContain("nothing was sent to the crew");
  }
  expect(sent).toEqual([]);
});

test("and an ordinary tone still reaches the crew",async()=>{
  sent.length=0;
  const answer=await readThrough("Hopeful and quiet");
  expect(answer.status).toBe(200);
  expect(sent.length).toBeGreaterThan(0);
  expect(sent.join("\n")).toContain("Hopeful and quiet");
});
