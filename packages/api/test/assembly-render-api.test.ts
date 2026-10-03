import {afterAll,beforeAll,expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {join} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {EditApi} from "../src/edit-api";
import {ProjectService,type Project,type PersistedState} from "../src/index";
import {CapacityController,DurableJobStore} from "../../queue/src/index";
import {CostLedger} from "../../operator/src/index";
import {DEFAULT_FEATURE_FILM_SPEND_CAP_USD,DEFAULT_FILM_SPEND_CAP_USD} from "../../operator/src/film-budget";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {bindOriginalEditSource} from "../../planner/src/edit-jobs";
import {emptyEditAssemblyLibrary} from "../../planner/src/edit-assembly-proposals";
import {contentHash} from "../../generator/src/capabilities";

let fixture:Awaited<ReturnType<typeof dubStudio>>,snapshot:PersistedState;
beforeAll(async()=>{
  fixture=await dubStudio();const source=await inspectEditSource(fixture.film,"Original performances",fixture.paths.artifactRoot,async()=>{}),binding=bindOriginalEditSource(source),editorial=fixture.projects.createEditSequence(fixture.owner.token,[source],"parent","Saved parent",source.facts.id,64,48,0,Date.now(),[binding])!,history=editorial.sequences[0]!.history.revision,carriers=[{binding,current:fixture.film}];
  const library=fixture.projects.createAssemblyProposal(fixture.owner.token,"parent",{id:"proposal",label:"Owner-reviewed ranges",purpose:"custom",ranges:[{id:"opening",fromFrame:0,toFrame:2,reason:"Retain the opening."}]},{libraryVersion:0,historyRevision:history},carriers)!,proposal=library.proposals[0]!;
  fixture.projects.acceptAssemblyProposal(fixture.owner.token,proposal.id,proposal.revision,"accepted",{libraryVersion:1,historyRevision:history},carriers);
  const other=fixture.projects.createAssemblyProposal(fixture.owner.token,"parent",{id:"other-proposal",label:"Another reviewed assembly",purpose:"custom",ranges:[{id:"other-opening",fromFrame:0,toFrame:1,reason:"Retain a different opening."}]},{libraryVersion:2,historyRevision:history},carriers)!.proposals.find(item=>item.id==="other-proposal")!;
  fixture.projects.acceptAssemblyProposal(fixture.owner.token,other.id,other.revision,"different-accepted",{libraryVersion:3,historyRevision:history},carriers);snapshot=fixture.projects.snapshot();
},120000);
afterAll(async()=>{await fixture?.close();});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
async function promptly<T>(task:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([task,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Lifecycle timed out")),1500);})]);}finally{clearTimeout(timer);}}
function context(){
  const projects=ProjectService.fromState(snapshot),queue=DurableJobStore.fromJobs([structuredClone(fixture.film)]),ledgerPath=join(fixture.root,crypto.randomUUID()+"-assembly-ledger.json"),ledger=new CostLedger(ledgerPath),refresh=async()=>ProjectService.fromState(projects.snapshot()).peekProject(fixture.owner.projectId);
  const api=new EditApi({root:fixture.paths.artifactRoot,projects,store:()=>queue,ledger,monthlyBudgetUsd:500,filmCapUsd:DEFAULT_FILM_SPEND_CAP_USD,featureCapUsd:DEFAULT_FEATURE_FILM_SPEND_CAP_USD,capacity:new CapacityController(500),view:async job=>({id:job.id,status:job.status})});return {projects,queue,ledger,ledgerPath,refresh,api};
}
type Context=ReturnType<typeof context>;
const route=["assemblies","accepted","accepted","renders"],lookup=(key:string)=>["assemblies","accepted","accepted","render-requests",key];
async function call(c:Context,parts=route,method="GET",body?:Record<string,unknown>,signal?:AbortSignal,refresh=c.refresh){return c.api.handle(parts,new Request("http://assembly-render/"+parts.join("/"),{method,signal}),c.projects.peekProject(fixture.owner.projectId)!,fixture.owner.token,refresh,body);}
async function quote(c:Context){const response=await call(c);if(response instanceof Response)throw new Error("Unexpected render response");expect(response.status).toBe(200);return response.body as any;}
function payload(quote:any,key=crypto.randomUUID()):Record<string,unknown>{return {idempotencyKey:key,generationApproved:true,assemblyRevision:quote.assembly.revision,sourceBindingsRevision:quote.sourceBindingsRevision,engineVersion:quote.engineVersion,review:{...quote.review,accepted:true}};}
function reservations(c:Context):{jobId:string}[]{return JSON.parse(readFileSync(c.ledgerPath,"utf8")).reservations;}

test("concurrent exact assembly requests retain only the winning job reservation and support lost-response lookup",async()=>{
  const c=context(),ready=deferred<void>();let reserves=0;const reserve=c.ledger.reserve.bind(c.ledger);
  try{
    const body=payload(await quote(c));c.ledger.reserve=(...args)=>{reserve(...args);if(++reserves===2)ready.resolve();return ready.promise;};
    const [first,second]=await Promise.all([call(c,route,"POST",body),call(c,route,"POST",body)]);if(first instanceof Response||second instanceof Response)throw new Error("Unexpected render response");expect(first.status).toBe(202);expect(second.body).toEqual(first.body);
    const jobId=(first.body as any).jobId;expect(c.queue.all().filter(job=>job.stage==="assembly-edit")).toHaveLength(1);expect(reservations(c).map(hold=>hold.jobId)).toEqual([jobId]);
    const found=await call(c,lookup(body.idempotencyKey as string));if(found instanceof Response)throw new Error("Unexpected lookup response");expect(found.body).toEqual({admitted:true,job:{id:jobId,status:"queued"},requestHash:contentHash(body)});
    await expect(call(c,route,"POST",{...body,review:{...(body.review as object),accepted:false}})).rejects.toThrow();expect(c.queue.all().filter(job=>job.stage==="assembly-edit")).toHaveLength(1);
    c.ledger.release(jobId);expect(reservations(c)).toEqual([]);
  }finally{ready.resolve();c.ledger.reserve=reserve;await c.api.close();}
});

for(const change of ["permission","accepted library"] as const)test(`assembly admission rechecks ${change} after the final carrier read and rolls back its reservation`,async()=>{
  const c=context(),reserve=c.ledger.reserve.bind(c.ledger),get=c.queue.get.bind(c.queue);let reserved=false,changed=false;
  try{
    const body=payload(await quote(c));c.ledger.reserve=(...args)=>{reserve(...args);reserved=true;};c.queue.get=id=>{const job=get(id);if(reserved&&!changed&&id===fixture.film.id){changed=true;if(change==="permission")c.projects.revokeCharacterPermission(fixture.owner.token,fixture.id,1);else c.projects.peekProject(fixture.owner.projectId)!.assemblyLibrary=emptyEditAssemblyLibrary();}return job;};
    await expect(call(c,route,"POST",body)).rejects.toThrow();expect(changed).toBe(true);expect(c.queue.all().filter(job=>job.stage==="assembly-edit")).toEqual([]);expect(reservations(c)).toEqual([]);
  }finally{c.queue.get=get;c.ledger.reserve=reserve;await c.api.close();}
});

for(const endpoint of ["quote","lookup"] as const)for(const stop of ["cancel","close"] as const)test(`assembly ${endpoint} releases a stalled owner read on ${stop}`,async()=>{
  const c=context(),entered=deferred<void>(),read=deferred<Project|null>(),controller=new AbortController(),refresh=()=>{entered.resolve();return read.promise;},parts=endpoint==="quote"?route:lookup("unreturned-request"),pending=call(c,parts,"GET",undefined,controller.signal,refresh);void pending.catch(()=>{});
  try{await entered.promise;if(stop==="cancel")controller.abort(new Error("Cancelled render read"));else await promptly(c.api.close());await expect(promptly(pending)).rejects.toThrow(stop==="cancel"?"Cancelled render read":/stopped|closed/i);}
  finally{controller.abort();read.resolve(await c.refresh());await c.api.close();}
});

test("assembly reads share a two-request cap and cancelled reads immediately release their slot",async()=>{
  const c=context(),entered=deferred<void>(),read=deferred<Project|null>(),controllers=[new AbortController(),new AbortController()];let reads=0;const refresh=()=>{if(++reads===2)entered.resolve();return read.promise;},pending=controllers.map((controller,index)=>call(c,index===0?route:lookup("pending-request"),"GET",undefined,controller.signal,refresh));for(const task of pending)void task.catch(()=>{});
  try{
    await entered.promise;await expect(promptly(call(c))).rejects.toThrow("Two assembly render requests");controllers[0]!.abort(new Error("Free this request slot"));await expect(promptly(pending[0]!)).rejects.toThrow("Free this request slot");expect((await quote(c)).assembly.id).toBe("accepted");
  }finally{for(const controller of controllers)controller.abort();read.resolve(await c.refresh());await Promise.allSettled(pending);await c.api.close();}
});

test("assembly request lookup rejects foreign or incompatible keys and rechecks current permissions",async()=>{
  const c=context();try{
    const absent=await call(c,lookup("not-yet-admitted"));if(absent instanceof Response)throw new Error("Unexpected lookup response");expect(absent.body).toEqual({admitted:false});
    const body=payload(await quote(c)),submitted=await call(c,route,"POST",body);if(submitted instanceof Response)throw new Error("Unexpected render response");expect(submitted.status).toBe(202);const jobsBefore=c.queue.all().length;
    for(const key of ["short","bad.key","x".repeat(129)])await expect(call(c,lookup(key))).rejects.toThrow();
    await expect(call(c,["assemblies","accepted","different-accepted","render-requests",body.idempotencyKey as string])).rejects.toThrow("another render");
    c.projects.revokeCharacterPermission(fixture.owner.token,fixture.id,1);await expect(call(c,lookup(body.idempotencyKey as string))).rejects.toThrow("permission");await expect(call(c,route,"POST",body)).rejects.toThrow("permission");expect(c.queue.all()).toHaveLength(jobsBefore);
  }finally{await c.api.close();}
});
