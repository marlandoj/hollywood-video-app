import { AsyncLocalStorage } from "node:async_hooks";
import { ROOT_CONTEXT, SpanKind, SpanStatusCode, trace, type Attributes, type Span, type Context } from "@opentelemetry/api";
import { ExportResultCode, type ExportResult } from "@opentelemetry/core";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { BasicTracerProvider, BatchSpanProcessor, ParentBasedSampler, TraceIdRatioBasedSampler, type SpanExporter, type ReadableSpan } from "@opentelemetry/sdk-trace-base";
import { AggregationType, MeterProvider, PeriodicExportingMetricReader, createAllowListAttributesProcessor, type PushMetricExporter } from "@opentelemetry/sdk-metrics";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PROVIDER_KINDS } from "./provider-kinds";

export type Operation = "http.request" | "job.process" | "provider.generate" | "provider.attempt" | "accounting.record" | "media.restore" | "media.checkpoint" | "media.assemble" | "media.publish" | "project.archive";
export type FailureCode = "internal" | "budget" | "lease" | "safety" | "timeout" | "cancelled" | "provider" | "dependency";
export interface TelemetryOptions {
  service: "api" | "worker" | "backup" | "retention" | "canary";
  enabled?: boolean; endpoint?: string; release?: string; sampleRate?: number;
  spanExporter?: SpanExporter; metricExporter?: PushMetricExporter;
  batchDelayMs?: number; exportTimeoutMs?: number; maxQueueSize?: number; metricIntervalMs?: number;
}
/** Delivered to `StudioTelemetry.onOperation` once per completed operation, after its counter and histogram were recorded. */
export interface OperationReport {operation: Operation; failed: boolean; attributes: Attributes; durationMs: number; carrier?: string}
/** The closed label sets. Their sizes bound the operator metric queries' row limits; see explorer.ts. */
export const OPERATION_NAMES = ["http.request","job.process","provider.generate","provider.attempt","accounting.record","media.restore","media.checkpoint","media.assemble","media.publish","project.archive"] as const satisfies readonly Operation[];
export const FAILURE_CODES = ["internal","budget","lease","safety","timeout","cancelled","provider","dependency"] as const satisfies readonly FailureCode[];
export { PROVIDER_KINDS, providerKind, type ProviderKind } from "./provider-kinds";
const OPERATIONS = new Set<Operation>(OPERATION_NAMES);
const FAILURES = new Set<FailureCode>(FAILURE_CODES);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const METHODS = new Set(["GET","POST","PUT","HEAD","OPTIONS","DELETE","PATCH","OTHER"]);
const ROUTES = new Set(["/health","/api/projects","/api/projects/:projectId","/api/projects/:projectId/script","/api/projects/:projectId/rights",
  "/api/projects/:projectId/jobs","/api/projects/:projectId/animatic/decision","/api/projects/:projectId/archive","/api/projects/:projectId/review-links",
  "/api/jobs/:jobId","/api/reviews/:token","/api/reviews/:token/decision","/api/operator/status","/api/operator/traces","/api/operator/traces/:traceId","/api/operator/metrics","/artifacts/:token/:projectId/:jobId/:file","unmatched"]);
const METRIC_KEYS = ["hv.operation","hv.stage","hv.provider","hv.outcome","hv.failure_code","http.request.method","http.route","http.response.status_class"];
/** Explicit millisecond boundaries for `hv.operation.duration`; a quantile at the top value is a floor, not a measurement. */
export const DURATION_BOUNDARIES_MS = [5,10,25,50,100,250,500,1000,2500,5000,10000,30000,60000,120000,300000,600000] as const;
/** Values, keys and cardinality are constrained before anything reaches an SDK/exporter. */
export function safeAttributes(input: Attributes): Attributes {
  const result: Attributes = {};
  for (const [key,value] of Object.entries(input)) {
    if (["hv.project.id","hv.job.id","hv.attempt.id","hv.provider.request_id"].includes(key) && typeof value==="string" && UUID.test(value)) result[key]=value;
    // HV-025-09: the editorial stages, so an edit's own phases can be read back beside the others.
    else if (key==="hv.stage" && ["animatic","final","character-sheet","take-preview","take-final","dialogue-replacement","picture-edit","assembly-edit"].includes(String(value))) result[key]=value;
    // HV-025-12: "store" is the object-store half of a checkpoint, whose verification reproduces the render.
    else if (key==="hv.edit.phase" && ["render","seal","verify","store"].includes(String(value))) result[key]=value;
    else if (key==="hv.provider" && (PROVIDER_KINDS as readonly string[]).includes(String(value))) result[key]=value;
    else if (key==="hv.operation" && OPERATIONS.has(value as Operation)) result[key]=value;
    else if (key==="hv.outcome" && ["success","error"].includes(String(value))) result[key]=value;
    else if (key==="hv.failure_code" && FAILURES.has(value as FailureCode)) result[key]=value;
    else if (key==="http.request.method" && METHODS.has(String(value))) result[key]=value;
    else if (key==="http.route" && ROUTES.has(String(value))) result[key]=value;
    else if (key==="http.response.status_class" && /^[1-5]xx$/.test(String(value))) result[key]=value;
    else if (key==="http.response.status_code" && Number.isInteger(value) && Number(value)>=100 && Number(value)<=599) result[key]=value;
    else if (["hv.cost_usd","hv.checkpoint.shots","hv.media.files","hv.edit.frames"].includes(key) && typeof value==="number" && Number.isFinite(value) && value>=0 && value<=1e9) result[key]=value;
  }
  return result;
}
export function routeTemplate(path: string): string {
  const parts=path.split("/").filter(Boolean);
  if (parts[0]==="artifacts") return "/artifacts/:token/:projectId/:jobId/:file";
  if (parts[0]==="api" && parts[1]==="projects" && parts[2]) {
    const candidate="/api/projects/:projectId"+(parts.length>3?"/"+parts.slice(3).join("/"):"");
    return ROUTES.has(candidate)?candidate:"unmatched";
  }
  if (parts[0]==="api" && parts[1]==="jobs" && parts.length===3) return "/api/jobs/:jobId";
  if (parts[0]==="api" && parts[1]==="operator" && parts[2]==="traces" && parts.length===4) return "/api/operator/traces/:traceId";
  if (parts[0]==="api" && parts[1]==="reviews" && parts[2]) return parts.length===3?"/api/reviews/:token":parts.length===4&&parts[3]==="decision"?"/api/reviews/:token/decision":"unmatched";
  return ROUTES.has(path)?path:"unmatched";
}
export function traceContext(carrier: unknown): Context | undefined {
  if (typeof carrier!=="string" || !/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/.test(carrier)) return;
  const [,traceId,spanId,flags]=carrier.split("-");
  if (/^0+$/.test(traceId!) || /^0+$/.test(spanId!)) return;
  return trace.setSpanContext(ROOT_CONTEXT,{traceId:traceId!,spanId:spanId!,traceFlags:Number.parseInt(flags!,16),isRemote:true});
}
export function telemetryEndpoint(value: string): string {
  const url=new URL(value);
  if (url.username || url.password || url.search || url.hash || value.length>1024) throw new Error("invalid telemetry endpoint");
  if (url.protocol!=="https:" && !(url.protocol==="http:" && ["127.0.0.1","localhost","[::1]"].includes(url.hostname))) throw new Error("telemetry endpoint requires verified HTTPS or loopback HTTP");
  return url.href.replace(/\/?$/,"/");
}

export function failureCode(error: unknown): FailureCode {
  const name=error instanceof Error?error.name:"";
  return name==="BudgetError"?"budget":name==="LeaseError"?"lease":name==="SafetyRefusal"?"safety":name==="AbortError"?"cancelled":name==="TimeoutError"?"timeout":"internal";
}
function bounded(value: number | undefined,fallback: number,min: number,max: number): number {
  return value!==undefined && Number.isFinite(value)?Math.max(min,Math.min(max,Math.floor(value))):fallback;
}
function observedExport(invoke: (done: (result: ExportResult) => void) => void, callback: (result: ExportResult) => void,
  timeout: number, record: (success: boolean) => void): void {
  let finished = false;
  const done = (result: ExportResult) => {
    if (finished) return;
    finished = true; clearTimeout(timer); record(result.code === ExportResultCode.SUCCESS); callback({code: result.code});
  };
  const timer = setTimeout(() => done({code: ExportResultCode.FAILED}), timeout);
  timer.unref();
  try {invoke(done);} catch {done({code: ExportResultCode.FAILED});}
}
export class SpanHandle {
  private ended=false;
  failed=false;
  constructor(private readonly span?: Span, private readonly finished?: (failed:boolean,attributes:Attributes)=>void, private readonly values: Attributes={}) {}
  attributes(values: Attributes): void {const safe=safeAttributes(values);Object.assign(this.values,safe);this.span?.setAttributes(safe);}
  fail(code: FailureCode): void {
    this.failed=true;this.span?.setStatus({code:SpanStatusCode.ERROR});
    this.attributes({"hv.failure_code":FAILURES.has(code)?code:"internal"});
  }
  carrier(): string | undefined {
    const value=this.span?.spanContext();
    if (!value || !/^[0-9a-f]{32}$/.test(value.traceId) || /^0+$/.test(value.traceId)) return;
    return "00-"+value.traceId+"-"+value.spanId+"-"+((value.traceFlags&1)?"01":"00");
  }
  context(): Context {return this.span?trace.setSpan(ROOT_CONTEXT,this.span):ROOT_CONTEXT;}
  end(): void {
    if (this.ended) return;this.ended=true;
    this.attributes({"hv.outcome":this.failed?"error":"success"});this.span?.end();this.finished?.(this.failed,this.values);
  }
}
export class StudioTelemetry {
  readonly enabled: boolean;
  readonly instanceId = crypto.randomUUID();
  readonly status = {spanExportFailures:0,lastSpanExportAt:null as string|null,lastSpanFailureAt:null as string|null,
    metricExportFailures:0,lastMetricExportAt:null as string|null,lastMetricFailureAt:null as string|null,completedOperations:0,failedOperations:0};
  /** Optional completion hook (structured logs); it never runs when telemetry is disabled and cannot fail an operation. */
  onOperation?: (report: OperationReport) => void;
  private readonly active=new AsyncLocalStorage<SpanHandle>();
  private provider?: BasicTracerProvider;
  private meters?: MeterProvider;
  private counter?: ReturnType<ReturnType<MeterProvider["getMeter"]>["createCounter"]>;
  private duration?: ReturnType<ReturnType<MeterProvider["getMeter"]>["createHistogram"]>;
  constructor(options: TelemetryOptions) {
    this.enabled=options.enabled ?? Boolean(options.spanExporter || options.metricExporter || options.endpoint);
    if (!this.enabled) return;
    const endpoint=options.endpoint?telemetryEndpoint(options.endpoint):undefined;
    const timeout=bounded(options.exportTimeoutMs,1000,50,5000);
    const resource=resourceFromAttributes({"service.name":"rough-cut-"+options.service,"service.instance.id":this.instanceId,
      ...(/^[a-f0-9]{40}$/.test(options.release??"")?{"service.version":options.release!}:{})});
    const target=options.spanExporter ?? (endpoint?new OTLPTraceExporter({url:endpoint+"v1/traces",timeoutMillis:timeout,concurrencyLimit:1}):undefined);
    if (target) {
      const status=this.status;
      const exporter: SpanExporter={
        export(spans: ReadableSpan[],callback:(result:ExportResult)=>void) {
          observedExport(done => target.export(spans, done), callback, timeout, success => {
            if (success) status.lastSpanExportAt = new Date().toISOString();
            else {status.spanExportFailures++; status.lastSpanFailureAt = new Date().toISOString();}
          });
        },
        shutdown:()=>target.shutdown(),
      };
      this.provider=new BasicTracerProvider({resource,forceFlushTimeoutMillis:timeout+100,
        sampler:new ParentBasedSampler({root:new TraceIdRatioBasedSampler(Math.max(0,Math.min(1,options.sampleRate??1)))}),
        spanLimits:{attributeCountLimit:16,attributeValueLengthLimit:128,eventCountLimit:0,linkCountLimit:0},
        spanProcessors:[new BatchSpanProcessor(exporter,{maxQueueSize:bounded(options.maxQueueSize,1024,16,4096),maxExportBatchSize:16,
          scheduledDelayMillis:bounded(options.batchDelayMs,1000,10,5000),exportTimeoutMillis:timeout})]});
    }
    const metricExporter=options.metricExporter ?? (endpoint?new OTLPMetricExporter({url:endpoint+"v1/metrics",timeoutMillis:timeout,concurrencyLimit:1}):undefined);
    if (metricExporter) {
      const status = this.status;
      const monitored: PushMetricExporter = {
        export: (metrics, callback) => observedExport(done => metricExporter.export(metrics, done), callback, timeout, success => {
          if (success) status.lastMetricExportAt = new Date().toISOString();
          else {status.metricExportFailures++; status.lastMetricFailureAt = new Date().toISOString();}
        }),
        forceFlush: () => metricExporter.forceFlush(), shutdown: () => metricExporter.shutdown(),
        selectAggregation: metricExporter.selectAggregation?.bind(metricExporter),
        selectAggregationTemporality: metricExporter.selectAggregationTemporality?.bind(metricExporter),
      };
      const bounded256={aggregationCardinalityLimit:256,attributesProcessors:[createAllowListAttributesProcessor(METRIC_KEYS)]};
      this.meters=new MeterProvider({resource,views:[{instrumentName:"hv.operations",...bounded256},
        {instrumentName:"hv.operation.duration",...bounded256,
          aggregation:{type:AggregationType.EXPLICIT_BUCKET_HISTOGRAM,options:{boundaries:[...DURATION_BOUNDARIES_MS]}}}],
        readers:[new PeriodicExportingMetricReader({exporter:monitored,exportIntervalMillis:bounded(options.metricIntervalMs,10000,timeout+10,60000),exportTimeoutMillis:timeout+10})]});
      const meter=this.meters.getMeter("hollywood-video","0.1.0");
      this.counter=meter.createCounter("hv.operations",{description:"Completed application operations"});
      this.duration=meter.createHistogram("hv.operation.duration",{unit:"ms",description:"Application operation duration"});
    }
  }
  carrier(): string | undefined {return this.active.getStore()?.carrier();}
  start(operation: Operation,attributes: Attributes={},parent?: string|null,kind=SpanKind.INTERNAL): SpanHandle {
    if (!this.enabled) return new SpanHandle();
    if (!OPERATIONS.has(operation)) throw new Error("unknown telemetry operation");
    const safe=safeAttributes({...attributes,"hv.operation":operation});
    const context=parent===null?ROOT_CONTEXT:traceContext(parent) ?? this.active.getStore()?.context() ?? ROOT_CONTEXT;
    const span=this.provider?.getTracer("hollywood-video","0.1.0").startSpan(operation,{attributes:safe,kind},context);
    const started=performance.now();
    const handle=new SpanHandle(span,(failed,latest)=>{
      this.status.completedOperations++;if(failed)this.status.failedOperations++;
      const labels=safeAttributes({...latest,"hv.outcome":failed?"error":"success"});
      this.counter?.add(1,labels);this.duration?.record(performance.now()-started,labels);
      if(this.onOperation)try{this.onOperation({operation,failed,attributes:labels,durationMs:performance.now()-started,carrier:handle.carrier()});}catch{}
    });
    handle.attributes(safe);return handle;
  }
  async run<T>(operation: Operation,attributes: Attributes,fn:(span:SpanHandle)=>T|Promise<T>,parent?: string|null,kind=SpanKind.INTERNAL): Promise<T> {
    const span=this.start(operation,attributes,parent,kind);
    const execute=async()=>{try{return await fn(span);}catch(error){if(!span.failed)span.fail(failureCode(error));throw error;}finally{span.end();}};
    return this.enabled?await this.active.run(span,execute):await execute();
  }
  async http(request: Request,fn:()=>Promise<Response>): Promise<Response> {
    if (!this.enabled) return await fn();
    const method=METHODS.has(request.method)?request.method:"OTHER";
    return this.run("http.request",{"http.request.method":method,"http.route":routeTemplate(new URL(request.url).pathname)},async span=>{
      const response=await fn();span.attributes({"http.response.status_code":response.status,"http.response.status_class":Math.floor(response.status/100)+"xx"});
      if(response.status>=500)span.fail("internal");
      return response;
    },null,SpanKind.SERVER);
  }
  async flush(): Promise<void> {await Promise.allSettled([this.provider?.forceFlush(),this.meters?.forceFlush({timeoutMillis:1500})]);}
  async shutdown(): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {await Promise.race([Promise.allSettled([this.provider?.shutdown(),this.meters?.shutdown({timeoutMillis:1500})]),
      new Promise<void>(resolve=>{timer=setTimeout(resolve,2000);timer.unref();})]);}
    finally {clearTimeout(timer);this.active.disable();}
  }
}
export function telemetryFromEnv(service: TelemetryOptions["service"]): StudioTelemetry {
  if(process.env.HV_TELEMETRY_ENABLED!=="1")return new StudioTelemetry({service,enabled:false});
  try {
    if(!process.env.HV_OTLP_ENDPOINT)throw new Error("missing telemetry endpoint");
    return new StudioTelemetry({service,endpoint:process.env.HV_OTLP_ENDPOINT,release:process.env.HV_RELEASE_SHA,
      sampleRate:Number(process.env.HV_TRACE_SAMPLE_RATE??1)});
  } catch {
    console.error(JSON.stringify({event:"telemetry.configuration_invalid",service}));
    return new StudioTelemetry({service,enabled:false});
  }
}
