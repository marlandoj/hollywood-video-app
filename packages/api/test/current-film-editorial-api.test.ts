import {afterAll,beforeAll,expect,test} from "bun:test";
import {currentFilmSourceFixture} from "../../planner/test/current-film-source.fixture";
import {CapacityController} from "../../queue/src/index";
import {EditApi} from "../src/edit-api";
import type {Project} from "../src/index";
import {DEFAULT_FILM_SPEND_CAP_USD} from "../../operator/src/film-budget";

let fixture:Awaited<ReturnType<typeof currentFilmSourceFixture>>,api:EditApi;
beforeAll(async()=>{
  fixture=await currentFilmSourceFixture();api=new EditApi({root:fixture.studio.paths.artifactRoot,projects:fixture.projects,ledger:fixture.context.ledger,monthlyBudgetUsd:5000,filmCapUsd:DEFAULT_FILM_SPEND_CAP_USD,capacity:new CapacityController(),store:()=>fixture.store,view:async job=>({id:job.id,status:job.status})});
},180000);
afterAll(async()=>{await api?.close();await fixture?.close();});
const refresh=async()=>fixture.projects.authorize(fixture.studio.owner.token);
function request(method="GET",query=""){return new Request("http://localhost/editorial"+query,{method});}
function finite(value:unknown):void {const text=JSON.stringify(value);for(const privateMarker of ["hv-current-screenplay-library/1","hv-current-film-job/2","hv-shot-execution-capture/1","currentFilmCheckpoint","routeDecisions","tokenHash"])expect(text).not.toContain(privateMarker);}
test("owner editorial service inspects a V2 film, saves a sequence and returns exact screenplay navigation without private worker context",async()=>{
  // HV-025-07: the check runs beside the request; 202 while it runs, the receipt when it is done.
  let answer=await api.handle(["sources",fixture.job.id],request(),(await refresh())!,fixture.studio.owner.token,refresh);
  expect((answer as {status:number}).status).toBe(202);
  for(let attempt=0;attempt<1200&&(answer as {status:number}).status===202;attempt++){await Bun.sleep(100);answer=await api.handle(["sources",fixture.job.id],request(),(await refresh())!,fixture.studio.owner.token,refresh);}
  const first=answer;
  expect(first).not.toBeInstanceOf(Response);const inspected=first as {status:number;body:{sources:{jobId:string;sourceRevision:string;facts:{frames:number}}[]}};
  expect(inspected.status).toBe(200);expect(inspected.body.sources[0]!.facts.frames).toBe(fixture.job.output!.currentFilm!.assembly.frames);finite(inspected.body);
  const create=await api.handle(["sequences"],request("POST"),(await refresh())!,fixture.studio.owner.token,refresh,{id:"current-film-owner-cut",label:"Current film cut",sources:[{jobId:fixture.job.id,sourceRevision:inspected.body.sources[0]!.sourceRevision}],firstSourceId:fixture.job.id,width:640,height:360,expectedVersion:0});
  expect(create.status).toBe(201);finite((create as {body:unknown}).body);
  const project=(await refresh())!,sequence=project.editLibrary.sequences.find(value=>value.id==="current-film-owner-cut")!;
  expect(project.editLibrary.sources[0]!.schema).toBe("hv-edit-source/3");expect(project.currentScreenplay!.headRevision).toBe(fixture.project.currentScreenplay!.headRevision);
  const navigation=await api.handle(["sequences",sequence.id,"script"],request("GET","?historyRevision="+sequence.history.revision),project,fixture.studio.owner.token,refresh);
  expect(navigation.status).toBe(200);expect(JSON.stringify((navigation as {body:unknown}).body)).toContain("Welcome home.");finite((navigation as {body:unknown}).body);
},180000);
test("source inspection rechecks owner availability before exposing the V2 source",async()=>{
  const project=(await refresh())!;
  await expect(api.handle(["sources",fixture.job.id],request(),project,fixture.studio.owner.token,async()=>null)).rejects.toThrow();
  const withdrawn={...project,rightsAttestedAt:null} as Project;
  await expect(api.handle(["sources",fixture.job.id],request(),project,fixture.studio.owner.token,async()=>withdrawn)).rejects.toThrow();
},30000);
