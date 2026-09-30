/**
 * HV-030-19 — the crew remembers a creator's style across projects, and the server keeps none of it.
 *
 * ADR-0018: free anonymous access, no accounts, no cookies, no tracking. So the plan route hands the
 * creator a style card made from their own answers, and a new project's read-through reads a card
 * only when the creator attaches it to the pitch. The card is read for that one answer: it is not
 * written to the project, the crew's budget line or anywhere else on the server, and it carries
 * nothing that names the project it came from. A card the prompt gate refuses is answered 400 before
 * the crew model is asked anything.
 */
import {afterAll,beforeAll,expect,test} from "bun:test";
import {readdirSync,readFileSync,statSync} from "node:fs";
import {join} from "node:path";
import {CrewLedger} from "../../operator/src/crew-ledger";
import {createApiServer} from "../src/server";

const SCRIPT="INT. KITCHEN - DAY\n\nMaya pours tea.\n\nMAYA\nYou came back.\n\nEXT. GARDEN - NIGHT\n\nLeo waits in the rain.\n\nLEO\nI never left.";
const MARKER="Hold every ending on the kettle's last wisp of steam";
const root=`/tmp/hv-crew-style-card-${Date.now()}`;
const generous={api:{limit:1_000_000,windowMs:60_000},projectCreate:{limit:1_000_000,windowMs:3600_000},artifacts:{limit:1_000_000,windowMs:60_000}};
let server:ReturnType<typeof createApiServer>,base:string;
const sent:string[]=[];
beforeAll(()=>{
  process.env.HV_TOKEN_SECRET="test-secret-that-is-at-least-thirty-two-characters";
  // A crew model that records what it is asked and answers with something unusable, so the stand-in writes the voice.
  const crewModel={complete:async(request:{messages:{content:string}[]})=>{sent.push(request.messages.map(message=>message.content).join("\n"));
    return {text:"{}",model:"recorded",usage:{inputTokens:1,outputTokens:1},costUsd:0};}};
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
const readThrough=async(id:string,headers:Record<string,string>,body:unknown)=>{
  const r=await fetch(`${base}/api/projects/${id}/crew/read-through`,{method:"POST",headers,body:JSON.stringify(body)});
  return {status:r.status,body:await r.json() as {error?:string;readStyleCard?:boolean;summary?:string;questions?:{persona:string;proposal:string}[];expected?:Record<string,number>}};
};
/** Every file the server wrote under its roots, as text. */
const written=(dir:string):string=>readdirSync(dir).map(name=>{const path=join(dir,name);return statSync(path).isDirectory()?written(path):readFileSync(path,"latin1");}).join("\n");
type Card={schema:string;format:string;tone:string;look:string;choices:{persona:string;question:string;proposal:string;accepted:boolean;reply:string}[]};

async function finishedCard(){
  const first=await project();
  const read=await readThrough(first.projectId,first.headers,{format:"short",tone:"Dry and melancholy"});
  const plan=await fetch(`${base}/api/projects/${first.projectId}/crew/plan`,{method:"POST",headers:first.headers,body:JSON.stringify({format:"short",tone:"Dry and melancholy",expected:read.body.expected,
    answers:[{id:"q1",persona:"director",question:"What should the audience feel?",proposal:"Hope.",accepted:false,reply:MARKER},
      {id:"q2",persona:"sound",question:"Music?",proposal:"A light score under the dialogue.",accepted:true}]})});
  return {first,status:plan.status,body:await plan.json() as {styleCard?:Card;lookNote:string}};
}

test("the plan hands the creator a style card of their own answers, naming neither the project nor its token",async()=>{
  const {first,status,body}=await finishedCard();
  expect(status).toBe(200);
  expect(body.styleCard).toEqual({schema:"hv-crew-style-card/1",format:"short",tone:"Dry and melancholy",look:body.lookNote,choices:[
    {persona:"director",question:"What should the audience feel?",proposal:"Hope.",accepted:false,reply:MARKER},
    {persona:"sound",question:"Music?",proposal:"A light score under the dialogue.",accepted:true,reply:""}]});
  const text=JSON.stringify(body.styleCard);
  expect(text).not.toContain(first.projectId);
  expect(text).not.toContain(first.token);
});

test("a new project's crew reads the card the creator attached, and proposes what they chose before",async()=>{
  const {styleCard}=(await finishedCard()).body;
  const second=await project();
  sent.length=0;
  const answer=await readThrough(second.projectId,second.headers,{format:"short",tone:"",styleCard});
  expect(answer.status).toBe(200);
  expect(answer.body.readStyleCard).toBe(true);
  expect(sent.join("\n")).toContain(MARKER);
  const proposal=(persona:string)=>answer.body.questions!.find(question=>question.persona===persona)!.proposal;
  expect([proposal("director"),proposal("sound"),proposal("cinematographer")]).toEqual([MARKER,"A light score under the dialogue.",styleCard!.look]);
  // Without the card, the same pitch is read as before.
  const plain=await readThrough(second.projectId,second.headers,{format:"short",tone:""});
  expect(plain.body.readStyleCard).toBeUndefined();
  expect(plain.body.questions!.map(question=>question.proposal)).not.toContain(MARKER);
});

test("a card the prompt gate refuses is answered 400 before the crew model is asked anything",async()=>{
  const {styleCard}=(await finishedCard()).body;
  const second=await project();
  sent.length=0;
  for(const bad of [{...styleCard,tone:"Like a Taylor Swift music video"},{...styleCard,look:"Warm\u0007 light"},{...styleCard,projectId:"p1"}]){
    const answer=await readThrough(second.projectId,second.headers,{format:"reel",tone:"",styleCard:bad});
    expect(answer.status).toBe(400);
    expect(answer.body.error).toContain("Nothing was sent to the crew");
  }
  expect(sent).toEqual([]);
});

test("the server keeps nothing of an attached card: not in the project, the crew's line or any file",async()=>{
  const {styleCard}=(await finishedCard()).body;
  const card={...styleCard!,choices:styleCard!.choices.map(choice=>choice.persona==="director"?{...choice,reply:MARKER+" in the attic"}:choice)};
  const second=await project();
  expect((await readThrough(second.projectId,second.headers,{format:"short",tone:"",styleCard:card})).status).toBe(200);
  const view=await (await fetch(`${base}/api/projects/${second.projectId}`,{headers:second.headers})).text();
  expect(view).not.toContain("in the attic");
  // The files are read: the project's own script is in them.
  expect(written(root)).toContain("Leo waits in the rain");
  expect(written(root)).not.toContain("in the attic");
});

test("a card that passes alone but not beside the script keeps the creator at the pitch, and nothing is sent",async()=>{
  // The gate's paired rules (FR-054) read the whole request: teenagers in the script, explicit words on the card.
  const created=await (await fetch(`${base}/api/projects`,{method:"POST"})).json() as {projectId:string;token:string};
  const headers={authorization:`Bearer ${created.token}`,"content-type":"application/json"};
  await fetch(`${base}/api/projects/${created.projectId}/script`,{method:"PUT",headers,body:JSON.stringify({text:"INT. SCHOOL HALLWAY - DAY\n\nTwo teenagers wait by the lockers.\n\nMAYA\nYou came back."})});
  const {styleCard}=(await finishedCard()).body;
  sent.length=0;
  const answer=await readThrough(created.projectId,headers,{format:"reel",tone:"",styleCard:{...styleCard,look:"explicit nude close-ups",choices:[]}});
  expect(answer.status).toBe(200);
  expect((answer.body as unknown as {facts:{concerns:{kind:string}[]}}).facts.concerns.map(concern=>concern.kind)).toEqual(["content_policy"]);
  expect(sent).toEqual([]);
});
