import {expect,test} from "bun:test";
import {readFileSync} from "node:fs";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {contentHash} from "../../generator/src/capabilities";

test("owner assembly HTTP workflow reviews saved ranges and preserves independent acceptance through retries, parent changes and revoked originals",async()=>{
  const f=await dubStudio();try{
    const base=f.base+"/editorial",call=(path:string,method="GET",body?:unknown)=>f.call(base+path,method,body,f.owner.token);
    const read=async(path:string)=>{const response=await call(path);expect(response.status).toBe(200);return response.json() as Promise<any>;};
    const inspected=(await read("/sources/"+f.film.id)).sources[0],sequenceId=crypto.randomUUID();
    const created=await call("/sequences","POST",{id:sequenceId,label:"Parent composition",sources:[{jobId:f.film.id,sourceRevision:inspected.sourceRevision}],firstSourceId:f.film.id,width:320,height:180,expectedVersion:0});expect(created.status).toBe(201);
    const sequence=await created.json() as any,historyRevision=sequence.sequence.history.revision,original=structuredClone(f.projects.peekProject(f.owner.projectId)!.editLibrary);
    const initial=await read("/assemblies");expect(initial).toEqual({libraryVersion:0,proposals:[],assemblies:[]});
    const queueBefore=readFileSync(f.paths.queuePath,"utf8"),proposalId=crypto.randomUUID(),route="/assemblies/proposals/"+proposalId;
    const input={id:proposalId,label:"Reviewed trailer",purpose:"trailer",ranges:[{id:"later",fromFrame:20,toFrame:30,reason:"Open on later coverage."},{id:"opening",fromFrame:0,toFrame:10,reason:"Return to the opening."}]};
    const proposed=await call("/assemblies/proposals","POST",{sequenceId,input,expected:{libraryVersion:0,historyRevision}});expect(proposed.status).toBe(201);let detail=await proposed.json() as any;
    expect(detail.item).toMatchObject({id:proposalId,frames:20,parent:{sequenceId,historyRevision,frames:sequence.timeline.frames}});expect(detail.item.ranges).toEqual(input.ranges);expect(detail.review.joins[0].continuous).toBe(false);expect(detail.boundaries.schema).toBe("hv-edit-assembly-boundaries/1");expect(detail.costUsd).toBe(0);expect(detail.resources.childFrames).toBe(20);
    const serialized=JSON.stringify(detail);for(const privateField of ['"job":','"owner":','"files":[','"scriptText":','"plan":'])expect(serialized).not.toContain(privateField);
    expect(f.projects.peekProject(f.owner.projectId)!.editLibrary).toEqual(original);
    expect((await f.call(base+route)).status).toBe(401);const other=await(await f.call("/api/projects","POST")).json() as any;expect([401,403,404]).toContain((await f.call(base+route,"GET",undefined,other.token)).status);
    const unchanged=f.projects.peekProject(f.owner.projectId)!.assemblyLibrary;
    for(const body of [{sequenceId,input:{...input,id:"foreign-parent",parent:sequence.timeline},expected:{libraryVersion:1,historyRevision}},{sequenceId,input:{...input,id:"stale"},expected:{libraryVersion:0,historyRevision}},{sequenceId,input:{...input,id:"changed-history"},expected:{libraryVersion:1,historyRevision:contentHash("stale")}}])expect((await call("/assemblies/proposals","POST",body)).status).toBe(400);
    expect(f.projects.peekProject(f.owner.projectId)!.assemblyLibrary).toEqual(unchanged);
    const next={label:"Sixty-second target",purpose:"sixty-second",ranges:[{id:"one",fromFrame:20,toFrame:30,reason:"Owner-selected ten frames."}]};
    const revised=await call(route,"PATCH",{input:next,expected:{libraryVersion:detail.libraryVersion,proposalRevision:detail.item.revision,historyRevision}});expect(revised.status).toBe(200);detail=await revised.json();
    expect(detail.review.target).toEqual({frames:1800,status:"short",deltaFrames:-1790});
    const acceptance={proposalRevision:detail.item.revision,assemblyId:crypto.randomUUID(),expected:{libraryVersion:detail.libraryVersion,historyRevision},reviewRevision:detail.review.revision,boundariesRevision:detail.boundaries.revision,sourceBindingsRevision:detail.sourceBindingsRevision,accepted:true};
    const beforeAccept=f.projects.peekProject(f.owner.projectId)!.assemblyLibrary;
    for(const body of [{...acceptance,accepted:false},{...acceptance,reviewRevision:contentHash("stale review")},{...acceptance,boundariesRevision:contentHash("stale boundaries")},{...acceptance,sourceBindingsRevision:contentHash("changed carrier")},{...acceptance,extra:true}])expect((await call(route+"/accept","POST",body)).status).toBe(400);
    expect(f.projects.peekProject(f.owner.projectId)!.assemblyLibrary).toEqual(beforeAccept);
    const acceptedResponse=await call(route+"/accept","POST",acceptance);expect(acceptedResponse.status).toBe(201);const accepted=await acceptedResponse.json() as any;
    expect(accepted.replayed).toBe(false);expect(accepted.item.target).toEqual(detail.review.target);expect(accepted.item.frames).toBe(10);
    const newer=await call(route,"PATCH",{input:{...next,label:"A later proposal",ranges:input.ranges},expected:{libraryVersion:accepted.libraryVersion,proposalRevision:detail.item.revision,historyRevision}});expect(newer.status).toBe(200);
    const changed=await call("/sequences/"+sequenceId,"PATCH",{expectedVersion:sequence.libraryVersion,expectedHistoryRevision:historyRevision,change:{kind:"edit",label:"Later parent",operation:{kind:"marker",marker:{id:"later-parent",frame:1,label:"Later parent composition"}}}});expect(changed.status).toBe(200);
    const beforeRetry=readFileSync(f.paths.statePath,"utf8"),retryResponse=await call(route+"/accept","POST",acceptance);expect(retryResponse.status).toBe(200);const replay=await retryResponse.json() as any;
    expect(replay.replayed).toBe(true);expect(replay.item).toEqual(accepted.item);expect(readFileSync(f.paths.statePath,"utf8")).toBe(beforeRetry);
    expect((await read("/assemblies/accepted/"+acceptance.assemblyId)).item).toEqual(accepted.item);
    const screenplay=await read("/assemblies/accepted/"+acceptance.assemblyId+"/script");expect(screenplay).toMatchObject({schema:"hv-edit-assembly-script/1",assemblyId:acceptance.assemblyId,assemblyRevision:accepted.item.revision,planRevision:accepted.item.planRevision});expect(screenplay.sources).toHaveLength(1);expect(screenplay.occurrences.length).toBeGreaterThan(0);expect(screenplay.occurrences.every((occurrence:any)=>occurrence.startSample>=0&&occurrence.endSample<=accepted.item.frames*1600&&occurrence.rangeId==="one")).toBe(true);
    expect((await call(route+"/accept","POST",{...acceptance,assemblyId:"different-copy"})).status).toBe(400);
    expect((await read("/assemblies")).assemblies).toHaveLength(1);
    const beforeRevocation=f.projects.peekProject(f.owner.projectId)!.assemblyLibrary;expect(f.projects.revokeCharacterPermission(f.owner.token,f.id,1)).not.toBeNull();
    expect((await call(route+"/accept","POST",acceptance)).status).toBe(400);expect((await call("/assemblies/accepted/"+acceptance.assemblyId)).status).toBe(400);expect((await call("/assemblies/accepted/"+acceptance.assemblyId+"/script")).status).toBe(400);expect(f.projects.peekProject(f.owner.projectId)!.assemblyLibrary).toEqual(beforeRevocation);
    expect(readFileSync(f.paths.queuePath,"utf8")).toBe(queueBefore);expect(f.ledger.monthSpend()).toBe(0);
  }finally{await f.close();}
},180000);
