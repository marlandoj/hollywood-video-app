import {afterAll,beforeAll,expect,test} from "bun:test";
import {join} from "node:path";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {ProjectService,type PersistedState} from "../src/index";
import type {PostgresProjectService} from "../../storage/src/projects";
import type {PostgresJobStore} from "../../storage/src/jobs";
import {PostgresCostLedger} from "../../storage/src/ledger";
import {LivingScriptApi} from "../src/living-script-api";
import {LivingScriptGenerationApi,type LivingScriptGenerationQuote} from "../src/living-script-generation-api";
import {CostLedger} from "../../operator/src/index";
import {CapacityController,DurableJobStore,type JobInput} from "../../queue/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {bindOriginalEditSource,type EditSourceBinding} from "../../planner/src/edit-jobs";
import {deriveEditAssemblyParent} from "../../planner/src/edit-assembly-parent";
import {compileEditScriptSource} from "../../planner/src/edit-script-source";
import {projectEditScriptNavigation} from "../../planner/src/edit-script-projection";
import {compileLivingScriptPatch} from "../../planner/src/living-script-patch";
import {compileLivingScriptGenerationImpact} from "../../planner/src/living-script-generation";
import {createLivingScriptProposal,type LivingScriptProposal} from "../../planner/src/living-script-proposals";
import {currentCasting} from "../../planner/src/casting";
import {currentDirection} from "../../planner/src/direction";

let studio:Awaited<ReturnType<typeof dubStudio>>,snapshot:PersistedState,binding:EditSourceBinding,proposal:LivingScriptProposal;
beforeAll(async()=>{
  studio=await dubStudio();const source=await inspectEditSource(studio.film,"Original performances",studio.paths.artifactRoot,async()=>{});binding=bindOriginalEditSource(source);
  const project=studio.projects.peekProject(studio.owner.projectId)!,editorial=studio.projects.createEditSequence(studio.owner.token,[source],"parent","Saved cut",source.facts.id,320,180,0,Date.now(),[binding])!,parent=deriveEditAssemblyParent(project.id,editorial,"parent"),index=compileEditScriptSource(source),line=index.entries.find(entry=>entry.kind==="dialogue")!,navigation=projectEditScriptNavigation(parent.sequenceId,parent.historyRevision,parent.timeline,[index]);
  const patch=compileLivingScriptPatch(source,{entryId:line.id,indexRevision:index.revision,currentScript:{version:studio.film.scriptVersion,text:studio.film.scriptText},replacement:"Welcome back to the garden."}),impact=compileLivingScriptGenerationImpact(source,patch,{...studio.film,scriptVersion:patch.after.version,scriptText:patch.after.text});
  proposal=studio.projects.createLivingScriptProposal(studio.owner.token,{id:"lifecycle",label:"Review the greeting",sequenceId:parent.sequenceId,historyRevision:parent.historyRevision,editorialRevision:editorial.revision,navigationRevision:navigation.revision,patch,candidate:impact.candidateInputs,baseline:{casting:currentCasting(project.id,project.castingHistory),direction:currentDirection(project.id,project.directionHistory)}},0,[{binding,current:studio.film}])!.proposal;snapshot=studio.projects.snapshot();
},120000);
afterAll(async()=>{await studio?.close();});
function deferred<T>(){let resolve!:(value:T)=>void,reject!:(error:unknown)=>void;const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};}
async function promptly<T>(task:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([task,new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error("Lifecycle timed out")),1500);})]);}finally{clearTimeout(timer);}}
function context(){
  const projects=ProjectService.fromState(snapshot),queue=DurableJobStore.fromJobs([structuredClone(studio.film)]),ledger=new CostLedger(join(studio.root,"lifecycle-"+crypto.randomUUID()+".json"));
  const io={refresh:async()=>projects.authorize(studio.owner.token),job:async(id:string)=>queue.get(id),all:async()=>queue.all(),enqueue:async(input:JobInput)=>queue.enqueue(input),binding:async()=>binding,bindings:async()=>[binding],inspect:async()=>binding,view:async(job:{id:string})=>({id:job.id})};
  // The asynchronous adapter exercises the same domain store through the service's I/O
  // boundary. It is deliberately not presented as a PostgreSQL contract test.
  const store={get:(id:string)=>io.job(id),all:()=>io.all(),enqueue:(input:JobInput)=>io.enqueue(input)} as unknown as PostgresJobStore;
  const reviewContext={projects,job:(_projectId:string,id:string)=>io.job(id),bindings:()=>io.bindings(),inspect:()=>io.inspect()},generationContext={projects,ledger,capacity:new CapacityController(),monthlyBudgetUsd:500,store:()=>store,binding:()=>io.binding(),view:(job:{id:string})=>io.view(job)};
  const review=new LivingScriptApi(reviewContext),generation=new LivingScriptGenerationApi(generationContext);
  const request=(method:string,signal?:AbortSignal)=>new Request("http://localhost/screenplay",{method,signal});
  const reviewCall=(parts:string[]=[],method="GET",body?:Record<string,unknown>,signal?:AbortSignal)=>review.handle(parts,request(method,signal),studio.owner.projectId,studio.owner.token,()=>io.refresh(),body);
  const generationCall=(parts:string[]=["jobs"],method="GET",body?:Record<string,unknown>,signal?:AbortSignal)=>generation.handle(parts,request(method,signal),studio.owner.projectId,proposal.request.id,studio.owner.token,()=>io.refresh(),body);
  const quote=async()=>((await generationCall(["quote"],"POST",{role:"render"})).body as {quote:LivingScriptGenerationQuote}).quote;
  return {projects,queue,ledger,io,review,generation,reviewContext,generationContext,request,reviewCall,generationCall,quote,close:()=>Promise.all([review.close(),generation.close()])};
}
function jobInput(q:LivingScriptGenerationQuote):JobInput{return {id:crypto.randomUUID(),idempotencyKey:studio.owner.projectId+":"+crypto.randomUUID(),...q.plan.inputs,livingScript:q.plan,shotReuse:q.plan.shotReuse,totalFrames:q.totalFrames,costCapUsd:q.costCapUsd,budgetReservedUsd:q.budgetReservedUsd,timeoutMs:q.timeoutMs,retryPolicy:{maxRetries:2,backoffMs:1000},providerSpec:q.plan.inputs.providerPlan!.pool[0]!.spec,rightsAttestedAt:studio.film.rightsAttestedAt,animaticJobId:null,animaticApprovedAt:null};}

for(const kind of ["review","generation"] as const)for(const stop of ["cancel","close"] as const)test(`${kind} releases a stalled owner read on ${stop}`,async()=>{
  const c=context(),entered=deferred<void>(),read=deferred<never>(),controller=new AbortController();c.io.refresh=()=>{entered.resolve();return read.promise;};const api=c[kind],call=kind==="review"?c.reviewCall:c.generationCall,pending=call(undefined,undefined,undefined,controller.signal);void pending.catch(()=>{});
  try{await promptly(entered.promise);if(stop==="cancel")controller.abort(new Error("Cancelled owner read"));else await promptly(api.close());await expect(promptly(pending)).rejects.toThrow(stop==="cancel"?"Cancelled owner read":/stopped/i);}
  finally{controller.abort();read.reject(new Error("Late owner failure"));await Promise.allSettled([pending,c.close()]);}
});
for(const kind of ["review","generation"] as const)test(`${kind} immediately recovers its two-request capacity after cancellation`,async()=>{
  const c=context(),read=deferred<never>(),entered=deferred<void>(),controllers=[new AbortController(),new AbortController()],refresh=c.io.refresh;let reads=0;c.io.refresh=()=>{if(++reads===2)entered.resolve();return read.promise;};
  const call=kind==="review"?c.reviewCall:c.generationCall,pending=controllers.map(controller=>call(undefined,undefined,undefined,controller.signal));for(const task of pending)void task.catch(()=>{});
  try{await promptly(entered.promise);await expect(promptly(call())).rejects.toThrow(/Two screenplay/);controllers[0]!.abort(new Error("Release one slot"));await expect(promptly(pending[0]!)).rejects.toThrow("Release one slot");c.io.refresh=refresh;expect((await promptly(call())).status).toBe(200);}
  finally{for(const controller of controllers)controller.abort();read.reject(new Error("Late capacity read"));await Promise.allSettled([...pending,c.close()]);}
});
for(const point of ["bindings","carrier","inspection"] as const)for(const stop of ["cancel","close"] as const)test(`proposal ${point} read releases on ${stop}`,async()=>{
  const c=context(),q=await c.quote(),queued=c.queue.enqueue(jobInput(q)),entered=deferred<void>(),read=deferred<never>(),controller=new AbortController(),stalled=()=>{entered.resolve();return read.promise;};
  if(point==="bindings")c.io.bindings=stalled;else if(point==="carrier")c.io.job=stalled;else c.io.inspect=stalled;
  const parts=point==="inspection"?["proposals",proposal.request.id,"sources",queued.id]:["proposals",proposal.request.id],pending=c.reviewCall(parts,"GET",undefined,controller.signal);void pending.catch(()=>{});
  try{await promptly(entered.promise);if(stop==="cancel")controller.abort(new Error("Cancelled proposal I/O"));else await promptly(c.review.close());await expect(promptly(pending)).rejects.toThrow(stop==="cancel"?"Cancelled proposal I/O":/stopped/i);expect(c.projects.snapshot()).toEqual(snapshot);}
  finally{controller.abort();read.reject(new Error("Late proposal read failure"));await Promise.allSettled([pending,c.close()]);}
});
for(const point of ["binding","carrier","jobs","view","spend","reserved"] as const)for(const stop of ["cancel","close"] as const)test(`generation ${point} read releases on ${stop} before admission`,async()=>{
  const c=context(),q=await c.quote(),entered=deferred<void>(),read=deferred<never>(),controller=new AbortController(),stalled=()=>{entered.resolve();return read.promise;};let parts=["jobs"],method="GET",body:Record<string,unknown>|undefined,api=c.generation;
  if(point==="binding"||point==="carrier"){parts=["quote"];method="POST";body={role:"render"};if(point==="binding")c.io.binding=stalled;else c.io.job=stalled;}
  else if(point==="jobs")c.io.all=stalled;
  else if(point==="view"){c.queue.enqueue(jobInput(q));c.io.view=stalled;}
  else{method="POST";body={quote:q,idempotencyKey:crypto.randomUUID(),generationApproved:true,animaticJobId:null};
    // Use the asynchronous PostgreSQL ledger contract for a blocked database read;
    // no database method may execute, and admission would fail this test immediately.
    const ledger=Object.assign(Object.create(PostgresCostLedger.prototype) as PostgresCostLedger,{monthSpend:async()=>0,reservedUsd:async()=>0,admit:async()=>{throw new Error("Unexpected admission after a blocked budget read");}});
    if(point==="spend")ledger.monthSpend=stalled;else ledger.reservedUsd=stalled;api=new LivingScriptGenerationApi({...c.generationContext,ledger});
  }
  const before=c.queue.all(),pending=api.handle(parts,c.request(method,controller.signal),studio.owner.projectId,proposal.request.id,studio.owner.token,()=>c.io.refresh(),body);void pending.catch(()=>{});
  try{await promptly(entered.promise);if(stop==="cancel")controller.abort(new Error("Cancelled generation I/O"));else await promptly(api.close());await expect(promptly(pending)).rejects.toThrow(stop==="cancel"?"Cancelled generation I/O":/stopped/i);expect(c.queue.all()).toEqual(before);expect(c.projects.snapshot()).toEqual(snapshot);expect(c.ledger.all()).toEqual([]);}
  finally{controller.abort();read.reject(new Error("Late generation read failure"));await Promise.allSettled([pending,api.close(),c.close()]);}
});

test("shutdown tracks an already-dispatched proposal save until its committed result settles",async()=>{
  const c=context(),entered=deferred<void>(),settled=deferred<ReturnType<ProjectService["createLivingScriptProposal"]>>(),request={...proposal.request,id:"committing-proposal",label:"A second reviewed proposal"},current=c.projects.peekProject(studio.owner.projectId)!,reviewed=createLivingScriptProposal(current.livingScriptProposals,current.id,current.editLibrary,request,current.livingScriptProposals.version),controller=new AbortController();
  let committed:ReturnType<ProjectService["createLivingScriptProposal"]>,closed=false;
  const projects={createLivingScriptProposal:(...args:Parameters<ProjectService["createLivingScriptProposal"]>)=>{committed=c.projects.createLivingScriptProposal(...args);entered.resolve();return settled.promise;}} as unknown as PostgresProjectService;
  const api=new LivingScriptApi({...c.reviewContext,projects}),pending=api.handle(["proposals"],c.request("POST",controller.signal),current.id,studio.owner.token,()=>c.io.refresh(),{request,expectedVersion:current.livingScriptProposals.version,reviewRevision:contentHash({request,impact:reviewed.proposal.impact}),accepted:true});void pending.catch(()=>{});
  try{await promptly(entered.promise);controller.abort(new Error("Owner stopped waiting after save"));const closing=api.close().then(()=>{closed=true;});await new Promise(resolve=>setTimeout(resolve,25));expect(closed).toBe(false);expect(c.projects.peekProject(current.id)!.livingScriptProposals.proposals).toHaveLength(2);settled.resolve(committed!);expect((await promptly(pending)).status).toBe(201);await promptly(closing);expect(closed).toBe(true);}
  finally{settled.resolve(committed!);await Promise.allSettled([pending,api.close(),c.close()]);}
});
test("shutdown tracks admission settlement and exact retries do not create another job or hold",async()=>{
  const c=context(),q=await c.quote(),entered=deferred<void>(),settled=deferred<Awaited<ReturnType<typeof c.io.enqueue>>>(),controller=new AbortController(),body={quote:q,idempotencyKey:crypto.randomUUID(),generationApproved:true,animaticJobId:null};let committed:Awaited<ReturnType<typeof c.io.enqueue>>,closed=false,admissions=0;
  const ledger=Object.assign(Object.create(PostgresCostLedger.prototype) as PostgresCostLedger,{monthSpend:async()=>c.ledger.monthSpend(),reservedUsd:async()=>c.ledger.reservedUsd(),admit:async(_projectId:string,input:JobInput,budget:number)=>{admissions++;c.ledger.reserve(input.id,input.stage,input.budgetReservedUsd??0,budget);committed=c.queue.enqueue(input);entered.resolve();return settled.promise;}}),generationContext={...c.generationContext,ledger},api=new LivingScriptGenerationApi(generationContext);
  const pending=api.handle(["jobs"],c.request("POST",controller.signal),studio.owner.projectId,proposal.request.id,studio.owner.token,()=>c.io.refresh(),body);void pending.catch(()=>{});
  try{await promptly(entered.promise);controller.abort(new Error("Owner stopped waiting after admission"));const closing=api.close().then(()=>{closed=true;});await new Promise(resolve=>setTimeout(resolve,25));expect(closed).toBe(false);settled.resolve(committed!);const admitted=await promptly(pending);expect(admitted.status).toBe(202);await promptly(closing);expect(closed).toBe(true);
    const before=c.queue.all(),reserved=c.ledger.reservedUsd(),reopened=new LivingScriptGenerationApi(generationContext);try{const result=await reopened.handle(["jobs"],c.request("POST"),studio.owner.projectId,proposal.request.id,studio.owner.token,()=>c.io.refresh(),body);expect(result.body).toEqual({jobId:committed!.id,stage:committed!.stage,status:committed!.status,replayed:true});expect(c.queue.all()).toEqual(before);expect(c.ledger.reservedUsd()).toBe(reserved);expect(admissions).toBe(1);}finally{await reopened.close();}
  }finally{settled.resolve(committed!);await Promise.allSettled([pending,api.close(),c.close()]);}
});
test("cancelled reservation settlement is tracked through rollback before shutdown completes",async()=>{
  const c=context(),q=await c.quote(),entered=deferred<void>(),settled=deferred<void>(),reserve=c.ledger.reserve.bind(c.ledger),controller=new AbortController(),api=new LivingScriptGenerationApi({...c.generationContext,store:()=>c.queue});let closed=false;c.ledger.reserve=(...args)=>{reserve(...args);entered.resolve();return settled.promise;};
  const before=c.queue.all(),pending=api.handle(["jobs"],c.request("POST",controller.signal),studio.owner.projectId,proposal.request.id,studio.owner.token,()=>c.io.refresh(),{quote:q,idempotencyKey:crypto.randomUUID(),generationApproved:true,animaticJobId:null});void pending.catch(()=>{});
  try{await promptly(entered.promise);controller.abort(new Error("Cancel before enqueue"));const closing=api.close().then(()=>{closed=true;});await new Promise(resolve=>setTimeout(resolve,25));expect(closed).toBe(false);settled.resolve();await expect(promptly(pending)).rejects.toThrow("Cancel before enqueue");await promptly(closing);expect(c.queue.all()).toEqual(before);expect(c.ledger.reservedUsd()).toBe(0);expect(c.projects.snapshot()).toEqual(snapshot);}
  finally{settled.resolve();await Promise.allSettled([pending,api.close(),c.close()]);}
});
test("local admission rechecks current authority synchronously after reservation and rolls back a withdrawn original",async()=>{
  const c=context(),q=await c.quote(),reserve=c.ledger.reserve.bind(c.ledger),api=new LivingScriptGenerationApi({...c.generationContext,store:()=>c.queue}),before=c.queue.all();let reserved=false;
  c.ledger.reserve=async(...args)=>{reserve(...args);reserved=true;await Promise.resolve();c.projects.revokeCharacterPermission(studio.owner.token,studio.id,1);};
  try{await expect(api.handle(["jobs"],c.request("POST"),studio.owner.projectId,proposal.request.id,studio.owner.token,()=>c.io.refresh(),{quote:q,idempotencyKey:crypto.randomUUID(),generationApproved:true,animaticJobId:null})).rejects.toThrow(/baseline|permission/i);expect(reserved).toBe(true);expect(c.queue.all()).toEqual(before);expect(c.ledger.reservedUsd()).toBe(0);}
  finally{await Promise.all([api.close(),c.close()]);}
});
test("local admission requires matching synchronous stores before creating a reservation",async()=>{
  const c=context(),q=await c.quote(),before=c.queue.all();let reserved=false;c.ledger.reserve=()=>{reserved=true;};
  try{await expect(c.generationCall(["jobs"],"POST",{quote:q,idempotencyKey:crypto.randomUUID(),generationApproved:true,animaticJobId:null})).rejects.toThrow("matching local");expect(reserved).toBe(false);expect(c.queue.all()).toEqual(before);}
  finally{await c.close();}
});
