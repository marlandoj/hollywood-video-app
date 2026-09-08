import {afterAll,beforeAll,expect,test} from "bun:test";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {EditAssemblyApi} from "../src/edit-assembly-api";
import {ProjectService,type PersistedState} from "../src/index";
import {inspectEditSource} from "../../generator/src/edit-source-media";
import {bindOriginalEditSource,type EditSourceBinding} from "../../planner/src/edit-jobs";
import {contentHash} from "../../generator/src/capabilities";
import type {Job} from "../../queue/src/index";

let fixture:Awaited<ReturnType<typeof dubStudio>>,snapshot:PersistedState,binding:EditSourceBinding,history:string;
beforeAll(async()=>{
  fixture=await dubStudio();const source=await inspectEditSource(fixture.film,"Retained performances",fixture.paths.artifactRoot,async()=>{});binding=bindOriginalEditSource(source);
  const editorial=fixture.projects.createEditSequence(fixture.owner.token,[source],"parent","Parent cut",source.facts.id,320,180,0,Date.now(),[binding])!;history=editorial.sequences[0]!.history.revision;
  fixture.projects.createAssemblyProposal(fixture.owner.token,"parent",{id:"proposal",label:"Reviewed alternate",purpose:"trailer",ranges:[{id:"opening",fromFrame:0,toFrame:Math.min(30,source.facts.frames),reason:"Retain the opening performance."}]},{libraryVersion:0,historyRevision:history},[{binding,current:fixture.film}]);snapshot=fixture.projects.snapshot();
},120000);
afterAll(async()=>{await fixture?.close();});
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};}
async function promptly<T>(task:Promise<T>):Promise<T>{let timer:ReturnType<typeof setTimeout>|undefined;try{return await Promise.race([task,new Promise<never>((_resolve,reject)=>{timer=setTimeout(()=>reject(new Error("Assembly lifecycle did not release promptly")),1500);})]);}finally{clearTimeout(timer);}}
function context(){const projects=ProjectService.fromState(snapshot),jobs=new Map([[fixture.film.id,structuredClone(fixture.film)]]),refresh=async()=>projects.peekProject(fixture.owner.projectId);return {projects,jobs,refresh};}
function create(c:ReturnType<typeof context>,overrides:Partial<ConstructorParameters<typeof EditAssemblyApi>[0]>={}){return new EditAssemblyApi({projects:c.projects,job:(_project,id)=>c.jobs.get(id),bindings:async()=>[structuredClone(binding)],...overrides});}
function request(parts:string[],method="GET",signal?:AbortSignal){return new Request("http://assembly-fixture/"+parts.join("/"),{method,signal});}
function handle(api:EditAssemblyApi,c:ReturnType<typeof context>,parts=["proposals","proposal"],method="GET",body?:Record<string,unknown>,signal?:AbortSignal){return api.handle(parts,request(parts,method,signal),fixture.owner.projectId,fixture.owner.token,c.refresh,body);}
function carrier(c:ReturnType<typeof context>){return [{binding:structuredClone(binding),current:c.jobs.get(fixture.film.id)}];}

for(const blocked of ["owner","bindings","job"] as const)test(`assembly cancellation and close release a blocked ${blocked} read and restore request capacity`,async()=>{
  const c=context(),entered=deferred<void>(),stall=()=>{entered.resolve();return new Promise<never>(()=>{});},api=create(c,blocked==="bindings"?{bindings:stall}:blocked==="job"?{job:stall}:{}),controller=new AbortController(),refresh=blocked==="owner"?stall:c.refresh;
  const first=api.handle(["proposals","proposal"],request(["proposals","proposal"],"GET",controller.signal),fixture.owner.projectId,fixture.owner.token,refresh);void first.catch(()=>{});
  try{
    await entered.promise;const second=api.handle(["proposals","proposal"],request(["proposals","proposal"]),fixture.owner.projectId,fixture.owner.token,refresh);void second.catch(()=>{});
    await expect(handle(api,c)).rejects.toThrow("Two assembly requests");controller.abort(new Error("Cancel this assembly read"));await expect(promptly(first)).rejects.toThrow("Cancel this assembly read");
    expect((await promptly(handle(api,c,[]))).status).toBe(200);await promptly(api.close());await expect(promptly(second)).rejects.toThrow("Assembly service stopped");await expect(handle(api,c,[])).rejects.toThrow("Assembly service stopped");
  }finally{controller.abort();await api.close();}
});

for(const changed of ["proposal","library"] as const)test(`assembly detail rejects a ${changed} change during its final carrier recheck`,async()=>{
  const c=context();let reads=0;const original=c.projects.peekProject(fixture.owner.projectId)!.assemblyLibrary.proposals[0]!,api=create(c,{job:(_project,id)=>{
    if(++reads===2){if(changed==="proposal")c.projects.reviseAssemblyProposal(fixture.owner.token,original.id,{label:"Changed while reading",purpose:"trailer",ranges:[{...original.plan.ranges[0]!,toFrame:1}]},{libraryVersion:1,historyRevision:history,proposalRevision:original.revision},carrier(c));
      else c.projects.createAssemblyProposal(fixture.owner.token,"parent",{id:"other",label:"Another proposal",purpose:"custom",ranges:original.plan.ranges},{libraryVersion:1,historyRevision:history},carrier(c));}
    return c.jobs.get(id);
  }});
  try{await expect(handle(api,c)).rejects.toThrow("changed while loading");expect(reads).toBe(2);expect(c.projects.peekProject(fixture.owner.projectId)!.assemblyLibrary.version).toBe(2);const fresh=await handle(api,c);expect(fresh.status).toBe(200);expect((fresh.body as any).libraryVersion).toBe(2);}finally{await api.close();}
});

for(const changed of ["identity","withdrawn","permission"] as const)test(`assembly detail rejects ${changed} changes during the final carrier recheck`,async()=>{
  const c=context();let reads=0;const api=create(c,{job:(_project,id)=>{
    if(++reads===2){if(changed==="withdrawn")c.jobs.delete(id);else if(changed==="identity")c.jobs.set(id,{...c.jobs.get(id)!,linkExpiresAt:new Date(Date.parse(fixture.film.linkExpiresAt!)+1000).toISOString()});else c.projects.revokeCharacterPermission(fixture.owner.token,fixture.id,1);}
    return c.jobs.get(id);
  }});
  try{await expect(handle(api,c)).rejects.toThrow();expect(reads).toBe(2);expect(c.projects.peekProject(fixture.owner.projectId)!.assemblyLibrary.version).toBe(1);}finally{await api.close();}
});

test("malformed assembly request bodies never persist partial proposal or acceptance state",async()=>{
  const c=context(),api=create(c),original=c.projects.peekProject(fixture.owner.projectId)!.assemblyLibrary.proposals[0]!,before=contentHash(c.projects.snapshot()),input={id:"new",label:"Another",purpose:"custom",ranges:original.plan.ranges},expected={libraryVersion:1,historyRevision:history};
  try{
    for(const [parts,method,body]of [
      [["proposals"],"POST",{sequenceId:"parent",input:{...input,parent:original.plan.parent},expected}],
      [["proposals"],"POST",{sequenceId:"parent",input,expected:{...expected,extra:true}}],
      [["proposals"],"POST",{sequenceId:"parent",input:{...input,ranges:[{...original.plan.ranges[0],toFrame:-1}]},expected}],
      [["proposals","proposal"],"PATCH",{input:{label:"Invalid",purpose:"custom",ranges:original.plan.ranges,plan:original.plan},expected:{...expected,proposalRevision:original.revision}}],
      [["proposals","proposal","accept"],"POST",{proposalRevision:original.revision,assemblyId:"accepted",expected,accepted:false}],
      [["proposals","proposal","accept"],"POST",{proposalRevision:original.revision,assemblyId:"accepted",expected,accepted:true,reviewRevision:"short",boundariesRevision:contentHash("wrong"),sourceBindingsRevision:binding.revision}]
    ] as [string[],string,Record<string,unknown>][]){await expect(handle(api,c,parts,method,body)).rejects.toThrow();expect(contentHash(c.projects.snapshot())).toBe(before);}
    expect(c.projects.peekProject(fixture.owner.projectId)!.assemblyLibrary.assemblies).toEqual([]);
  }finally{await api.close();}
});

test("an exact acceptance retry after parent changes still rechecks current permissions and available originals",async()=>{
  const c=context(),api=create(c);try{
    const detail=(await handle(api,c)).body as any,body={proposalRevision:detail.item.revision,assemblyId:"accepted",expected:{libraryVersion:detail.libraryVersion,historyRevision:history},reviewRevision:detail.review.revision,boundariesRevision:detail.boundaries.revision,sourceBindingsRevision:detail.sourceBindingsRevision,accepted:true};
    const first=await handle(api,c,["proposals","proposal","accept"],"POST",body);expect(first.status).toBe(201);expect((first.body as any).replayed).toBe(false);
    const editorial=c.projects.peekProject(fixture.owner.projectId)!.editLibrary;c.projects.changeEditSequence(fixture.owner.token,"parent",{kind:"edit",label:"Later parent",operation:{kind:"marker",marker:{id:"later",frame:0,label:"Later marker"}}},editorial.version,history);
    const before=contentHash(c.projects.snapshot()),retry=await handle(api,c,["proposals","proposal","accept"],"POST",body);expect(retry.status).toBe(200);expect((retry.body as any).replayed).toBe(true);expect(contentHash(c.projects.snapshot())).toBe(before);
    const job=c.jobs.get(fixture.film.id)!;c.jobs.delete(job.id);await expect(handle(api,c,["proposals","proposal","accept"],"POST",body)).rejects.toThrow();expect(contentHash(c.projects.snapshot())).toBe(before);c.jobs.set(job.id,job as Job);
    c.projects.revokeCharacterPermission(fixture.owner.token,fixture.id,1);const revoked=contentHash(c.projects.snapshot());await expect(handle(api,c,["proposals","proposal","accept"],"POST",body)).rejects.toThrow();expect(contentHash(c.projects.snapshot())).toBe(revoked);expect(c.projects.peekProject(fixture.owner.projectId)!.assemblyLibrary.assemblies).toHaveLength(1);
  }finally{await api.close();}
});
