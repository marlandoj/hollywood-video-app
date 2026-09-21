import {expect,test} from "bun:test";
import {InMemorySpanExporter} from "@opentelemetry/sdk-trace-base";
import {dubStudio} from "../../../test/fixtures/dub-studio";
import {inspected as inspectedSource} from "../../../test/fixtures/editorial-inspection";
import {processNextJob} from "../../queue/src/worker";
import {StudioTelemetry} from "../../observability/src/index";
import {editRenderTimeoutMs} from "../../planner/src/edit-resources";

/**
 * HV-025-09: every editorial job carried a flat thirty minutes and said nothing about where its
 * time went. On staging the Release 1 short's titled picture edit reached that deadline twice and
 * re-queued itself, so the film could not be titled at all, and the trace held one span for the
 * whole job. The deadline now comes from the cut's own frames, and the render, the seal and the
 * verification that reproduces the render are recorded separately.
 */
test("an editorial render carries a deadline from its cut and records each phase",async()=>{
  const f=await dubStudio();
  const previous=process.env.HV_JOB_TIMEOUT_MS;delete process.env.HV_JOB_TIMEOUT_MS;
  try{
    const base=f.base+"/editorial",call=(path:string,method="GET",body?:unknown)=>f.call(base+path,method,body,f.owner.token);
    const json=async(path:string)=>{const response=await call(path);expect(response.status).toBe(200);return response.json() as Promise<any>;};
    const source=(await inspectedSource(async path=>await(await call(path)).json() as any,"/sources/"+f.film.id)).sources[0];
    const id=crypto.randomUUID(),route="/sequences/"+id;
    const created=await call("/sequences","POST",{id,label:"Deadline cut",sources:[{jobId:f.film.id,sourceRevision:source.sourceRevision}],firstSourceId:f.film.id,width:320,height:180,expectedVersion:0});
    expect(created.status).toBe(201);
    const state=await created.json() as any,quote=await json(route+"/renders");
    const render={idempotencyKey:crypto.randomUUID(),generationApproved:true,historyRevision:quote.sequence.historyRevision,
      sourceBindingsRevision:quote.sourceBindingsRevision,engineVersion:quote.engineVersion,review:{...quote.review,accepted:true}};
    const submitted=await call(route+"/renders","POST",render);
    expect(await submitted.clone().text()).not.toContain('"error"');
    expect(submitted.status).toBe(202);
    const jobId=(await submitted.json() as any).jobId,admitted=f.store.all().find(job=>job.id===jobId)!;

    // The deadline is the cut's, not a constant.
    expect(admitted.totalFrames).toBe(state.timeline.frames);
    expect(admitted.timeoutMs).toBe(editRenderTimeoutMs(state.timeline.frames));
    expect(editRenderTimeoutMs(state.timeline.frames + 1800)).toBeGreaterThan(admitted.timeoutMs!);

    // Each phase is its own span, under the job, with the cut it was rendering.
    const exporter=new InMemorySpanExporter(),telemetry=new StudioTelemetry({service:"worker",spanExporter:exporter});
    let done;
    try{done=await processNextJob(f.store,f.paths.artifactRoot,{projects:f.projects,ledger:f.ledger,reviewQueue:f.reviews,telemetry});}
    finally{await telemetry.flush();}
    expect(done?.id).toBe(jobId);
    expect(done?.failureReason??done?.cancelReason).toBeUndefined();
    expect(done?.status).toBe("done");
    const phases=exporter.getFinishedSpans().filter(span=>span.name==="media.assemble");
    expect(phases.map(span=>span.attributes["hv.edit.phase"])).toEqual(["render","seal","verify"]);
    for(const span of phases){
      expect(span.attributes["hv.stage"]).toBe("picture-edit");
      expect(span.attributes["hv.job.id"]).toBe(jobId);
      expect(span.attributes["hv.edit.frames"]).toBe(state.timeline.frames);
    }
    // The exporter is shut down only after its spans have been read; shutting it down clears them.
    await telemetry.shutdown();
    // An operator override still wins, for a host that needs a shorter or longer bound.
    process.env.HV_JOB_TIMEOUT_MS="60000";
    const second=await call(route+"/renders","POST",{...render,idempotencyKey:crypto.randomUUID()});
    expect(second.status).toBe(202);
    const overridden=(await second.json() as any).jobId;
    expect(f.store.all().find(job=>job.id===overridden)?.timeoutMs).toBe(60000);
  }finally{
    if(previous===undefined)delete process.env.HV_JOB_TIMEOUT_MS;else process.env.HV_JOB_TIMEOUT_MS=previous;
    await f.close();
  }
},180000);
