import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { InMemorySpanExporter, type SpanExporter } from "@opentelemetry/sdk-trace-base";
import { AggregationTemporality, InMemoryMetricExporter } from "@opentelemetry/sdk-metrics";
import { SpanStatusCode } from "@opentelemetry/api";
import { StudioTelemetry, safeAttributes, traceContext, routeTemplate, telemetryEndpoint, DURATION_BOUNDARIES_MS } from "../src/index";

test("only bounded operational fields survive; capability paths and error text cannot enter traces",async()=>{
  const exporter=new InMemorySpanExporter(),metrics=new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const telemetry=new StudioTelemetry({service:"api",spanExporter:exporter,metricExporter:metrics});
  const secret="private-screenplay-and-capability-secret";
  await expect(telemetry.run("job.process",{"hv.job.id":crypto.randomUUID(),"http.url":"https://host/artifacts/"+secret,"hv.project.id":secret,"prompt":secret},async span=>{
    span.attributes({"hv.provider":secret,"hv.stage":"animatic"});throw new Error(secret);
  })).rejects.toThrow(secret);
  await telemetry.flush();
  const spans=exporter.getFinishedSpans();expect(spans).toHaveLength(1);
  const span=spans[0]!;expect(span.status.code).toBe(SpanStatusCode.ERROR);expect(span.events).toHaveLength(0);
  const serialized=JSON.stringify({attributes:span.attributes,status:span.status,events:span.events,resource:span.resource.attributes});
  expect(serialized).not.toContain(secret);expect(span.attributes["hv.failure_code"]).toBe("internal");
  expect(span.attributes["hv.stage"]).toBe("animatic");
  const points=metrics.getMetrics().flatMap(metric=>metric.scopeMetrics.flatMap(scope=>scope.metrics.flatMap(metric=>metric.dataPoints.map(point=>point.attributes))));
  expect(points.length).toBeGreaterThan(0);
  for(const attributes of points){expect(attributes).not.toHaveProperty("hv.job.id");expect(JSON.stringify(attributes)).not.toContain(secret);}
  await telemetry.shutdown();
});

test("short metric intervals still initialize and deliver operations within the reader timeout contract",async()=>{
  const metrics = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const telemetry = new StudioTelemetry({service:"worker", metricExporter:metrics, metricIntervalMs:1, exportTimeoutMs:50});
  try {
    await telemetry.run("job.process", {"hv.stage":"animatic"}, async()=>{});
    await telemetry.flush();
    expect(metrics.getMetrics().flatMap(value=>value.scopeMetrics.flatMap(scope=>scope.metrics)).some(value=>value.descriptor.name==="hv.operations")).toBe(true);
    expect(telemetry.status.lastMetricExportAt).not.toBeNull();
  } finally {await telemetry.shutdown();}
});

test("concurrent asynchronous operations retain distinct parents without global SDK registration",async()=>{
  const exporter=new InMemorySpanExporter(),telemetry=new StudioTelemetry({service:"api",spanExporter:exporter});
  const carriers=await Promise.all([1,2].map(async delay=>telemetry.run("http.request",{},async()=>{
    const parent=telemetry.carrier()!;await Bun.sleep(delay);
    await telemetry.run("job.process",{},async()=>{await Bun.sleep(delay);});
    expect(telemetry.carrier()).toBe(parent);return parent;
  },null)));
  await telemetry.flush();
  expect(carriers[0]!.split("-")[1]).not.toBe(carriers[1]!.split("-")[1]);
  const spans=exporter.getFinishedSpans();
  for(const carrier of carriers){
    const related=spans.filter(span=>span.spanContext().traceId===carrier!.split("-")[1]);
    expect(related).toHaveLength(2);
    expect(related.find(span=>span.name==="job.process")?.parentSpanContext?.spanId).toBe(carrier!.split("-")[2]);
  }
  expect(telemetry.carrier()).toBeUndefined();await telemetry.shutdown();
});

test("a serialized trace carrier joins a separate Bun worker process to its API action",async()=>{
  const exporter=new InMemorySpanExporter(),telemetry=new StudioTelemetry({service:"api",spanExporter:exporter});
  let carrier="";
  let rows:{name:string;traceId:string;spanId:string;parent:string}[]=[];
  await telemetry.run("http.request",{},async()=>{
    carrier=telemetry.carrier()!;
    const child=Bun.spawn([process.execPath,fileURLToPath(new URL("../../../scripts/fixtures/telemetry-worker.ts",import.meta.url)),carrier],
      {env:{PATH:process.env.PATH},stdout:"pipe",stderr:"pipe"});
    const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect(stderr).toBe("");expect(code).toBe(0);rows=JSON.parse(stdout);
  });
  expect(rows).toHaveLength(2);
  expect(rows.every(row=>row.traceId===carrier.split("-")[1])).toBe(true);
  const job=rows.find(row=>row.name==="job.process")!;
  expect(job.parent).toBe(carrier.split("-")[2]);expect(rows.find(row=>row.name==="provider.generate")?.parent).toBe(job.spanId);
  await telemetry.shutdown();
});

test("OTLP HTTP exports real trace and metric payloads with sanitized HTTP route fields",async()=>{
  const received:{path:string;body:unknown}[]=[];
  const collector=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){
    received.push({path:new URL(request.url).pathname,body:await request.json()});return Response.json({});
  }});
  const telemetry=new StudioTelemetry({service:"api",endpoint:collector.url.href,batchDelayMs:10,exportTimeoutMs:500,metricIntervalMs:10000});
  try{
    const result=await telemetry.http(new Request("https://studio/artifacts/capability-secret/project/job/private-filename"),async()=>new Response("fixture",{status:206}));
    expect(result.status).toBe(206);await telemetry.flush();
    expect(received.some(item=>item.path==="/v1/traces")).toBe(true);expect(received.some(item=>item.path==="/v1/metrics")).toBe(true);
    const wire=JSON.stringify(received);
    expect(wire).toContain("/artifacts/:token/:projectId/:jobId/:file");
    expect(wire).toContain("hv.operations");expect(wire).toContain("2xx");
    expect(wire).not.toContain("capability-secret");expect(wire).not.toContain("private-filename");
  }finally{await telemetry.shutdown();await collector.stop(true);}
});

test("an unavailable exporter cannot make application operations wait for network delivery",async()=>{
  const exporter:SpanExporter={export(){},async shutdown(){}};
  const telemetry=new StudioTelemetry({service:"worker",spanExporter:exporter,exportTimeoutMs:50,batchDelayMs:10,maxQueueSize:16});
  const started=performance.now();
  let completed=0;
  for(let index=0;index<200;index++)await telemetry.run("provider.generate",{"hv.provider":"mock"},()=>{completed++;});
  expect(completed).toBe(200);expect(performance.now()-started).toBeLessThan(2000);
  await telemetry.flush();await telemetry.shutdown();
  expect(telemetry.status.spanExportFailures).toBeGreaterThan(0);
  expect(telemetry.status.lastSpanFailureAt).not.toBeNull();
  expect(telemetry.status.lastSpanExportAt).toBeNull();
  expect(performance.now()-started).toBeLessThan(3000);
});

test("trace carriers and endpoints reject injected credentials and unsupported propagation fields",()=>{
  expect(traceContext("00-"+"0".repeat(32)+"-"+"1".repeat(16)+"-01")).toBeUndefined();
  expect(traceContext("Bearer secret")).toBeUndefined();
  expect(traceContext("00-"+"a".repeat(32)+"-"+"b".repeat(16)+"-01")).toBeDefined();
  expect(()=>telemetryEndpoint("http://example.com")).toThrow();
  expect(()=>telemetryEndpoint("https://user:password@example.com")).toThrow();
  expect(()=>telemetryEndpoint("https://example.com?token=secret")).toThrow();
  expect(telemetryEndpoint("https://example.com/otel")).toBe("https://example.com/otel/");
  expect(routeTemplate("/api/reviews/secret/decision")).toBe("/api/reviews/:token/decision");
  expect(routeTemplate("/attacker/secret")).toBe("unmatched");
  expect(safeAttributes({"arbitrary":"secret","hv.cost_usd":Infinity})).toEqual({});
  // HV-025-12: the object-store half of a checkpoint is a phase of its own; an invented one is not.
  for(const phase of ["render","seal","verify","store"])expect(safeAttributes({"hv.edit.phase":phase})).toEqual({"hv.edit.phase":phase});
  expect(safeAttributes({"hv.edit.phase":"upload","hv.media.files":405})).toEqual({"hv.media.files":405});
});

test("failed operations label the counter with a bounded failure code and the duration histogram keeps the widened boundaries",async()=>{
  const metrics=new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const telemetry=new StudioTelemetry({service:"worker",metricExporter:metrics,metricIntervalMs:10000});
  try{
    await telemetry.run("job.process",{"hv.stage":"animatic","hv.job.id":crypto.randomUUID()},async()=>{});
    await expect(telemetry.run("job.process",{"hv.stage":"final","hv.job.id":crypto.randomUUID()},async()=>{throw Object.assign(new Error("x"),{name:"TimeoutError"});})).rejects.toThrow();
    await telemetry.flush();
    const exported=metrics.getMetrics().flatMap(value=>value.scopeMetrics.flatMap(scope=>scope.metrics));
    const counter=exported.find(value=>value.descriptor.name==="hv.operations")!;
    const histogram=exported.find(value=>value.descriptor.name==="hv.operation.duration")!;
    expect(counter).toBeDefined();expect(histogram).toBeDefined();
    const failed=counter.dataPoints.filter(point=>point.attributes["hv.outcome"]==="error");
    const succeeded=counter.dataPoints.filter(point=>point.attributes["hv.outcome"]==="success");
    expect(failed).toHaveLength(1);expect(failed[0]!.attributes["hv.failure_code"]).toBe("timeout");
    expect(succeeded).toHaveLength(1);expect(succeeded[0]!.attributes).not.toHaveProperty("hv.failure_code");
    for(const point of [...counter.dataPoints,...histogram.dataPoints])expect(point.attributes).not.toHaveProperty("hv.job.id");
    expect((histogram.dataPoints[0]!.value as {buckets:{boundaries:number[]}}).buckets.boundaries)
      .toEqual([5,10,25,50,100,250,500,1000,2500,5000,10000,30000,60000,120000,300000,600000]);
    expect(DURATION_BOUNDARIES_MS.at(-1)).toBe(600_000);
  }finally{await telemetry.shutdown();}
});
