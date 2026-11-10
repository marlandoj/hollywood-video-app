import {expect,test} from "bun:test";
import {InMemorySpanExporter} from "@opentelemetry/sdk-trace-base";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspected as inspectedSource} from "../../../test/fixtures/editorial-inspection";
import {processNextJob} from "../../queue/src/worker";
import {StudioTelemetry} from "../../observability/src/index";

/**
 * HV-025-14: G24's picture edit ran past three hours and filled the staging VM. Nothing bounded the
 * worker's memory, and a job that used its whole deadline was queued again from nothing, twice. An
 * editorial job that runs out of time or memory now ends at once with the reason, and every phase
 * records the memory it left behind so the next slow job can be read.
 */
async function admit(timeoutMs?:string){
  const f=await dubStudio(),previous=process.env.HV_JOB_TIMEOUT_MS;if(timeoutMs===undefined)delete process.env.HV_JOB_TIMEOUT_MS;else process.env.HV_JOB_TIMEOUT_MS=timeoutMs;
  try{
    const base=f.base+"/editorial",call=(path:string,method="GET",body?:unknown)=>f.call(base+path,method,body,f.owner.token);
    const source=(await inspectedSource(async path=>await(await call(path)).json() as any,"/sources/"+f.film.id)).sources[0];
    const id=crypto.randomUUID(),route="/sequences/"+id;
    const created=await call("/sequences","POST",{id,label:"Bounded cut",sources:[{jobId:f.film.id,sourceRevision:source.sourceRevision}],firstSourceId:f.film.id,width:320,height:180,expectedVersion:0});
    expect(created.status).toBe(201);
    const quote=await(await call(route+"/renders")).json() as any;
    const submitted=await call(route+"/renders","POST",{idempotencyKey:crypto.randomUUID(),generationApproved:true,historyRevision:quote.sequence.historyRevision,sourceBindingsRevision:quote.sourceBindingsRevision,engineVersion:quote.engineVersion,review:{...quote.review,accepted:true}});
    expect(submitted.status).toBe(202);
    return {f,jobId:(await submitted.json() as any).jobId as string};
  }catch(error){await f.close();throw error;}
  finally{if(previous===undefined)delete process.env.HV_JOB_TIMEOUT_MS;else process.env.HV_JOB_TIMEOUT_MS=previous;}
}

test("each editorial phase records the worker's peak memory, the host's page cache and the attempt",async()=>{
  const {f,jobId}=await admit();
  try{
    const exporter=new InMemorySpanExporter(),telemetry=new StudioTelemetry({service:"worker",spanExporter:exporter});let done;
    try{done=await processNextJob(f.store,f.paths.artifactRoot,{projects:f.projects,ledger:f.ledger,reviewQueue:f.reviews,telemetry});}finally{await telemetry.flush();}
    expect(done?.id).toBe(jobId);expect(done?.status).toBe("done");
    const phases=exporter.getFinishedSpans().filter(span=>span.name==="media.assemble");
    expect(phases.map(span=>span.attributes["hv.edit.phase"])).toEqual(["render","seal","verify"]);
    for(const span of phases){
      expect(span.attributes["hv.job.retries_used"]).toBe(0);
      expect(span.attributes["hv.worker.rss_peak_bytes"] as number).toBeGreaterThan(0);
      if(process.platform==="linux")expect(span.attributes["hv.host.mem_cached_bytes"] as number).toBeGreaterThanOrEqual(0);
    }
    await telemetry.shutdown();
  }finally{await f.close();}
},180000);

test("an editorial job over its memory cap is cancelled with the reason, not queued again",async()=>{
  const {f,jobId}=await admit();
  try{
    const done=await processNextJob(f.store,f.paths.artifactRoot,{projects:f.projects,ledger:f.ledger,reviewQueue:f.reviews,editRss:()=>5*2**30});
    expect(done?.id).toBe(jobId);
    expect(done?.status).toBe("cancelled");
    expect(done?.cancelReason).toBe("The editorial render used 5120 MiB, over its 4096 MiB limit (HV_EDIT_MAX_RSS_MB).");
    expect(done?.retriesUsed).toBe(0);
    expect(f.store.all().find(job=>job.id===jobId)?.status).toBe("cancelled");
  }finally{await f.close();}
},180000);

test("sealing is held to the same cap: memory that only grows while sealing still cancels the job",async()=>{
  // The workshop's review found that sealing hashed every retained file without calling access(), so
  // neither the deadline nor the memory cap was checked during it. Here memory is over the cap only
  // while the seal phase runs, and back under it afterwards.
  const {f,jobId}=await admit();
  try{
    class PhaseTelemetry extends StudioTelemetry{phase:unknown;override run<T>(...args:Parameters<StudioTelemetry["run"]>):Promise<T>{this.phase=args[1]["hv.edit.phase"];return super.run(...args) as Promise<T>;}}
    const exporter=new InMemorySpanExporter(),telemetry=new PhaseTelemetry({service:"worker",spanExporter:exporter});let done;
    try{done=await processNextJob(f.store,f.paths.artifactRoot,{projects:f.projects,ledger:f.ledger,reviewQueue:f.reviews,telemetry,editRss:()=>telemetry.phase==="seal"?5*2**30:100*2**20});}finally{await telemetry.flush();}
    expect(done?.id).toBe(jobId);
    expect(done?.status).toBe("cancelled");
    expect(done?.cancelReason).toBe("The editorial render used 5120 MiB, over its 4096 MiB limit (HV_EDIT_MAX_RSS_MB).");
    expect(done?.retriesUsed).toBe(0);
    const seal=exporter.getFinishedSpans().find(span=>span.name==="media.assemble"&&span.attributes["hv.edit.phase"]==="seal");
    expect(seal?.attributes["hv.worker.rss_peak_bytes"]).toBe(5*2**30);
    await telemetry.shutdown();
  }finally{await f.close();}
},180000);

test("an editorial job past its deadline is cancelled with the reason, not queued again",async()=>{
  const {f,jobId}=await admit("1");
  try{
    await Bun.sleep(5);
    const done=await processNextJob(f.store,f.paths.artifactRoot,{projects:f.projects,ledger:f.ledger,reviewQueue:f.reviews});
    expect(done?.id).toBe(jobId);
    expect(done?.status).toBe("cancelled");
    expect(done?.cancelReason).toBe("The editorial render exceeded its processing timeout.");
    expect(done?.retriesUsed).toBe(0);
  }finally{await f.close();}
},180000);
