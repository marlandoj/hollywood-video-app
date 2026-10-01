/**
 * HV-016-32 — the crew's line notes at the API.
 *
 * `POST /api/projects/:id/crew/line-notes` asks the crew for notes on the saved script and answers
 * with them and the script version (and SHA-256) they are bound to. `POST …/crew/line-notes/accept`
 * takes that version, the notes and the ids the writer accepts, and writes a new script version the
 * way `PUT /script` does. A stale version answers 409 and writes nothing. Same project-token auth as
 * the other crew routes; the crew model is a fake that spends $0.
 */
import {afterAll,beforeAll,expect,test} from "bun:test";
import {CrewLedger} from "../../operator/src/crew-ledger";
import {createApiServer} from "../src/server";

const SCRIPT="INT. KITCHEN - DAY\r\n\r\nMaya pours tea.\r\n\r\nMAYA\r\n  You came back.  \r\n\r\nLEO\r\nI never left.\r\n";
const root=`/tmp/hv-crew-line-notes-route-${Date.now()}`;
const generous={api:{limit:1_000_000,windowMs:60_000},projectCreate:{limit:1_000_000,windowMs:3600_000},artifacts:{limit:1_000_000,windowMs:60_000}};
let answer=JSON.stringify({notes:[]});
const sent:string[]=[];
const crewModel={name:"anthropic",model:"claude-sonnet-5",complete:async(request:{messages:{content:string}[]})=>{sent.push(request.messages[0]!.content);return {text:answer,model:"claude-sonnet-5",usage:{inputTokens:1,outputTokens:1},costUsd:0};}};
let live:ReturnType<typeof createApiServer>,standIn:ReturnType<typeof createApiServer>;
const serve=(model:unknown,name:string)=>createApiServer({port:0,hostname:"127.0.0.1",frontendOrigin:"https://staging.example.test",rateLimit:generous,queuePath:`${root}/${name}/jobs.json`,artifactRoot:`${root}/${name}/artifacts`,
  statePath:`${root}/${name}/projects.json`,costLedgerPath:`${root}/${name}/cost.json`,crewLedger:new CrewLedger(),crewModel:model as never});
beforeAll(()=>{process.env.HV_TOKEN_SECRET="test-secret-that-is-at-least-thirty-two-characters";live=serve(crewModel,"live");standIn=serve(null,"stand-in");});
afterAll(()=>{live.stop(true);standIn.stop(true);});

async function project(server:ReturnType<typeof createApiServer>){
  const base=`http://127.0.0.1:${server.port}`,created=await (await fetch(`${base}/api/projects`,{method:"POST"})).json() as {projectId:string;token:string};
  const headers={authorization:`Bearer ${created.token}`,"content-type":"application/json"};
  expect((await fetch(`${base}/api/projects/${created.projectId}/script`,{method:"PUT",headers,body:JSON.stringify({text:SCRIPT})})).status).toBe(200);
  const url=`${base}/api/projects/${created.projectId}`;
  const post=async(path:string,body:unknown,auth=headers)=>{const r=await fetch(url+path,{method:"POST",headers:auth,body:JSON.stringify(body)});return {status:r.status,body:await r.json() as Record<string,any>};};
  // What the project holds now: its latest script version and text.
  const current=async()=>await (await fetch(url,{headers})).json() as {scriptVersion:number;script:string};
  return {post,current,headers};
}
const NOTES=[{persona:"director",line:6,before:"You came back.",after:"You actually came back.",reason:"Lets it land."},{persona:"editor",line:9,before:"I never left.",after:"I stayed.",reason:"Plainer."}];

/** The crew's notes come back bound to the script version and hash; accepting some writes exactly those lines as a new version. */
test("the writer accepts one note and the next script version changes only that line",async()=>{
  answer=JSON.stringify({notes:NOTES});
  const {post,current}=await project(live);
  const proposed=await post("/crew/line-notes",{request:"tighten the dialogue"});
  expect(proposed.status).toBe(200);
  expect(proposed.body).toMatchObject({schema:"hv-crew-line-notes/1",source:"anthropic",script:{version:1},dropped:0,crewSpend:{usd:0}});
  expect(proposed.body.notes.map((n:{id:string})=>n.id)).toEqual(["n1","n2"]);
  expect(sent.at(-1)).toContain("tighten the dialogue");
  const accepted=await post("/crew/line-notes/accept",{version:1,sha256:proposed.body.script.sha256,notes:proposed.body.notes,acceptedIds:["n1"]});
  expect(accepted).toEqual({status:200,body:{version:2,applied:["n1"],replayed:false}});
  expect(await current()).toMatchObject({scriptVersion:2,script:SCRIPT.replace("  You came back.  ","  You actually came back.  ")});
  // A retry of the same accept (a lost response) answers with the version it made, and writes nothing new.
  const again=await post("/crew/line-notes/accept",{version:1,notes:proposed.body.notes,acceptedIds:["n1"]});
  expect(again).toEqual({status:200,body:{version:2,applied:["n1"],replayed:true}});
  expect((await current()).scriptVersion).toBe(2);
});

/** Notes made against an older version are refused with 409, and the script is not written. */
test("a stale version answers 409 and writes nothing",async()=>{
  answer=JSON.stringify({notes:NOTES});
  const {post,current}=await project(live);
  const proposed=await post("/crew/line-notes",{});
  const first=await post("/crew/line-notes/accept",{version:1,notes:proposed.body.notes,acceptedIds:["n1"]});
  expect(first.body.version).toBe(2);
  // The other note, from the same (now old) proposal: stale.
  const stale=await post("/crew/line-notes/accept",{version:1,notes:proposed.body.notes,acceptedIds:["n2"]});
  expect(stale.status).toBe(409);
  expect(stale.body.error).toContain("nothing was changed");
  // A hash that isn't the named version's: stale too.
  const wrongHash=await post("/crew/line-notes/accept",{version:2,sha256:"0".repeat(64),notes:proposed.body.notes,acceptedIds:["n2"]});
  expect(wrongHash.status).toBe(409);
  const now=await current();
  expect(now.scriptVersion).toBe(2);
  expect(now.script).toContain("I never left.");
});

/** A refused note (a newline, a changed element type, a mismatched before) is a 400 and nothing is written. */
test("a note that would restructure the script is refused and nothing is written",async()=>{
  const {post,current}=await project(live);
  for(const bad of [{...NOTES[0],after:"You came back.\nLEO"},{...NOTES[0],after:"INT. HALL - NIGHT"},{...NOTES[0],before:"Something else."}]){
    const refused=await post("/crew/line-notes/accept",{version:1,notes:[{id:"n1",...bad}],acceptedIds:["n1"]});
    expect(refused.status).toBe(400);
  }
  expect(await current()).toMatchObject({scriptVersion:1,script:SCRIPT});
});

/** An unsafe note from the model never reaches the writer; a refused request is a 400 with nothing sent. */
test("an unsafe note is dropped, and an unsafe request is refused before the crew is asked",async()=>{
  answer=JSON.stringify({notes:[{...NOTES[0],after:"You sound like Taylor Swift."},NOTES[1]]});
  const {post}=await project(live);
  const proposed=await post("/crew/line-notes",{request:""});
  expect(proposed.body.notes.map((n:{after:string})=>n.after)).toEqual(["I stayed."]);
  expect(proposed.body.dropped).toBe(1);
  expect(JSON.stringify(proposed.body)).not.toContain("Taylor");
  const before=sent.length;
  const refused=await post("/crew/line-notes",{request:"like a Taylor Swift video"});
  expect(refused.status).toBe(400);
  expect(refused.body.error).toContain("nothing was sent to the crew");
  expect(sent.length).toBe(before);
});

/** Without a crew model the route answers with no notes and an honest message; the other routes' token rule holds. */
test("without a model key the stand-in answers with no notes, and a stranger is refused",async()=>{
  const {post,headers}=await project(standIn);
  const proposed=await post("/crew/line-notes",{request:"tighten"});
  expect(proposed.status).toBe(200);
  expect(proposed.body).toMatchObject({source:"stand-in",notes:[],crewSpend:{usd:0}});
  expect(proposed.body.message).toContain("No crew model is connected");
  const other=await project(standIn);
  const stranger=await post("/crew/line-notes",{},{...headers,authorization:other.headers.authorization});
  expect(stranger.status).toBe(401);
  const strangerAccept=await post("/crew/line-notes/accept",{version:1,notes:NOTES.map((n,i)=>({id:"n"+(i+1),...n})),acceptedIds:["n1"]},{...headers,authorization:other.headers.authorization});
  expect(strangerAccept.status).toBe(401);
});

/**
 * HV-016-35: the route answers with `dropped` and its reasons, and with why an answer couldn't be read,
 * so a live answer that gives no notes says why. Never the refused notes' text.
 */
test("the route reports dropped notes by reason, and an unreadable answer with its reason",async()=>{
  answer=JSON.stringify({notes:[{persona:"director",line:5,after:"LEO",reason:"Swap."},{persona:"editor",line:9,after:"I sound like Taylor Swift.",reason:"Star."}]});
  const {post}=await project(live);
  const allDropped=await post("/crew/line-notes",{request:"tighten the dialogue"});
  expect(allDropped.status).toBe(200);
  expect(allDropped.body).toMatchObject({source:"anthropic",notes:[],dropped:2,droppedReasons:{locked_line:1,gate_refused:1}});
  expect(allDropped.body.message).toStartWith("The crew suggested 2 line notes, but none could be used.");
  expect(JSON.stringify(allDropped.body)).not.toContain("Taylor");
  answer="```json\n"+JSON.stringify([{persona:"editor",line:9,before:"LEO: “I never left.”",after:"I stayed.",reason:"Plainer."}])+"\n```";
  const fenced=await post("/crew/line-notes",{});
  expect(fenced.body).toMatchObject({notes:[{id:"n1",line:9,before:"I never left.",after:"I stayed."}],dropped:0,droppedReasons:{}});
  answer="Line 9 is fine as it is.";
  const prose=await post("/crew/line-notes",{});
  expect(prose.body).toMatchObject({source:"stand-in",fallbackReason:"model_unusable",unusableReason:"no_json",notes:[],droppedReasons:{}});
  expect(prose.body.message).not.toContain("Line 9");
});
