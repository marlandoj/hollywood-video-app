import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { StudioTelemetry } from "../src/index";
import { createApiServer } from "../../api/src/server";
import { DurableJobStore } from "../../queue/src/index";
import { processNextJob } from "../../queue/src/worker";
import { CostLedger, OperatorReviewQueue } from "../../operator/src/index";

test("API admission and the real preview/final pipeline keep one trace through persisted jobs",async()=>{
  const directory=mkdtempSync(join(tmpdir(),"hv-traced-pipeline-"));
  const previous={token:process.env.HV_TOKEN_SECRET,provider:process.env.HV_ANIMATIC_PROVIDER,narration:process.env.HV_NARRATION};
  process.env.HV_TOKEN_SECRET="telemetry-fixture-signing-secret-"+crypto.randomUUID();
  process.env.HV_ANIMATIC_PROVIDER="legacy-mock";process.env.HV_NARRATION="0";
  const exporter=new InMemorySpanExporter();
  const apiTelemetry=new StudioTelemetry({service:"api",spanExporter:exporter});
  const workerTelemetry=new StudioTelemetry({service:"worker",spanExporter:exporter});
  const queue=join(directory,"jobs.json"),ledger=join(directory,"costs.json");
  const server=createApiServer({port:0,hostname:"127.0.0.1",tls:null,telemetry:apiTelemetry,
    queuePath:queue,statePath:join(directory,"projects.json"),costLedgerPath:ledger,artifactRoot:join(directory,"media")});
  const store=new DurableJobStore(queue),context={telemetry:workerTelemetry,ledger:new CostLedger(ledger),reviewQueue:new OperatorReviewQueue(join(directory,"reviews.json"))};
  const request=async(path:string,method="GET",token?:string,body?:unknown)=>{
    const response=await fetch(new URL(path,server.url),{method,headers:{"content-type":"application/json",...(token?{authorization:"Bearer "+token}:{}),
      traceparent:"00-"+"a".repeat(32)+"-"+"b".repeat(16)+"-01"},...(body === undefined ? {} : {body:JSON.stringify(body)})});
    expect(response.ok).toBe(true);return await response.json() as any;
  };
  try {
    const owner=await request("/api/projects","POST");
    const screenplay="EXT. GARDEN - DAY\n\nA paper lantern carries the private-screenplay-sentinel across a quiet path.";
    await request(`/api/projects/${owner.projectId}/script`,"PUT",owner.token,{text:screenplay});
    await request(`/api/projects/${owner.projectId}/rights`,"POST",owner.token,{attested:true});
    const preview=await request(`/api/projects/${owner.projectId}/jobs`,"POST",owner.token,{idempotencyKey:"trace-preview"});
    const admitted=store.get(preview.jobId)!;
    expect(admitted.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
    expect(admitted.traceparent!.split("-")[1]).not.toBe("a".repeat(32));
    expect((await processNextJob(store,join(directory,"media"),context))?.status).toBe("done");
    await request(`/api/projects/${owner.projectId}/animatic/decision`,"POST",owner.token,{animaticJobId:preview.jobId,decision:"approved"});
    const final=await request(`/api/projects/${owner.projectId}/jobs`,"POST",owner.token,{idempotencyKey:"trace-final",stage:"final",animaticJobId:preview.jobId});
    expect((await processNextJob(store,join(directory,"media"),context))?.status).toBe("done");
    await apiTelemetry.flush();await workerTelemetry.flush();
    const spans=exporter.getFinishedSpans();
    for(const id of [preview.jobId,final.jobId]){
      const job=store.get(id)!,carrier=job.traceparent!.split("-");
      const related=spans.filter(span=>span.spanContext().traceId===carrier[1]);
      expect(related.find(span=>span.name==="http.request")?.spanContext().spanId).toBe(carrier[2]);
      const processing=related.find(span=>span.name==="job.process")!;
      expect(processing.parentSpanContext?.spanId).toBe(carrier[2]);
      expect(processing.attributes["hv.job.id"]).toBe(id);
      for(const operation of ["provider.generate","provider.attempt","accounting.record","media.checkpoint","media.assemble"])
        expect(related.some(span=>span.name===operation)).toBe(true);
    }
    const serialized=JSON.stringify(spans.map(span=>({name:span.name,attributes:span.attributes,status:span.status,events:span.events,resource:span.resource.attributes})));
    expect(serialized).not.toContain(owner.token);expect(serialized).not.toContain("private-screenplay-sentinel");
    expect(serialized).not.toContain(process.env.HV_TOKEN_SECRET!);
    expect(context.ledger.monthSpend()).toBe(0);
  } finally {
    await server.stop(true);await apiTelemetry.shutdown();await workerTelemetry.shutdown();
    for(const [key,value] of Object.entries({HV_TOKEN_SECRET:previous.token,HV_ANIMATIC_PROVIDER:previous.provider,HV_NARRATION:previous.narration})){
      if(value===undefined)delete process.env[key];else process.env[key]=value;
    }
    rmSync(directory,{recursive:true,force:true});
  }
},30000);
