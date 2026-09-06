import { safeAttributes, type Operation } from "./index";

export const TRACE_ID = /^(?!0{32}$)[0-9a-f]{32}$/;
export const JOB_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SPAN_ID = /^(?!0{16}$)[0-9a-f]{16}$/;
const SERVICES = ["rough-cut-api", "rough-cut-worker"] as const;
type Service = typeof SERVICES[number];
type Outcome = "success" | "error" | "unknown";
export interface StoredSpan {
  id: string; parentId: string | null; operation: Operation; service: Service;
  startMs: number; durationMs: number; outcome: Outcome; failureCode: string | null;
}
export interface StoredTrace {
  id: string; jobId: string | null; stage: string | null; startedAt: string; durationMs: number;
  outcome: Outcome; spanCount: number; limited: boolean; spans: StoredSpan[];
}
export interface TraceList {windowStart: string; windowEnd: string; limit: number; traces: Omit<StoredTrace, "spans">[]}
export interface MetricSeries {service: Service; outcome: Exclude<Outcome, "unknown">; points: [number, number | null][]}
export interface RecentMetrics {windowStart: string; windowEnd: string; stepSeconds: number; series: MetricSeries[]}
export interface Reading<T> {state: "available" | "unavailable" | "not_configured"; observedAt: string | null; value: T | null}
type QueryFetch = (url: URL, init: RequestInit) => Promise<Response>;
export interface ExplorerOptions {enabled?: boolean; fetch?: QueryFetch; now?: () => number; timeoutMs?: number}

// No caller-controlled host, PromQL, time range, service, tag name, or result limit.
const TRACES = "http://127.0.0.1:15686";
const METRICS = "http://127.0.0.1:15909";
export const OPERATIONS_QUERY = 'sum by (job, hv_outcome) (rate(hv_operations_total{job="rough-cut-api",hv_operation="http.request",http_route!~"/api/operator/.*"}[5m]) or rate(hv_operations_total{job="rough-cut-worker",hv_operation="job.process"}[5m])) * 60';
const invalid = (): never => {throw new Error("invalid telemetry response");};
const record = (value: unknown): Record<string, any> => value && typeof value === "object" && !Array.isArray(value) ? value : invalid();
function array(value: unknown, max: number): any[] {return Array.isArray(value) && value.length <= max ? value : invalid();}
function number(value: unknown, max: number): number {return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= max ? value : invalid();}
function tags(value: unknown): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = Object.create(null);
  for (const item of array(value ?? [], 128)) {
    const tag = record(item);
    if (typeof tag.key === "string" && tag.key.length <= 100 && ["string", "number", "boolean"].includes(typeof tag.value)) result[tag.key] = tag.value;
  }
  return safeAttributes(result) as typeof result;
}
function trace(value: unknown): StoredTrace | null {
  const source = record(value);
  if (typeof source.traceID !== "string" || !TRACE_ID.test(source.traceID)) return invalid();
  const processes = record(source.processes), spans: StoredSpan[] = [];
  let jobId: string | null = null, stage: string | null = null;
  for (const item of array(source.spans, 2048)) {
    const raw = record(item), process = record(processes[raw.processID]);
    if (!SERVICES.includes(process.serviceName)) continue;
    const operation = safeAttributes({"hv.operation": raw.operationName})["hv.operation"] as Operation | undefined;
    if (!operation) continue;
    if (raw.traceID !== source.traceID || typeof raw.spanID !== "string" || !SPAN_ID.test(raw.spanID)) return invalid();
    const attributes = tags(raw.tags);
    if (operation === "job.process" && typeof attributes["hv.job.id"] === "string") {
      const id = attributes["hv.job.id"] as string;
      if (jobId && jobId !== id) return invalid();
      jobId = id; stage = typeof attributes["hv.stage"] === "string" ? attributes["hv.stage"] as string : null;
    }
    const parent = array(raw.references ?? [], 16).find(ref => ref?.refType === "CHILD_OF" && ref.traceID === source.traceID && typeof ref.spanID === "string" && SPAN_ID.test(ref.spanID));
    spans.push({id: raw.spanID, parentId: parent?.spanID ?? null, operation, service: process.serviceName,
      startMs: number(raw.startTime, 8e15) / 1000, durationMs: number(raw.duration, 604_800_000_000) / 1000,
      outcome: attributes["hv.outcome"] === "error" ? "error" : attributes["hv.outcome"] === "success" ? "success" : "unknown",
      failureCode: typeof attributes["hv.failure_code"] === "string" ? attributes["hv.failure_code"] as string : null});
  }
  if (!spans.length) return null;
  if (new Set(spans.map(span => span.id)).size !== spans.length) return invalid();
  spans.sort((a, b) => a.startMs - b.startMs || a.id.localeCompare(b.id));
  const start = spans[0]!.startMs, end = Math.max(...spans.map(span => span.startMs + span.durationMs));
  return {id: source.traceID, jobId, stage, startedAt: new Date(start).toISOString(), durationMs: end - start,
    outcome: spans.some(span => span.outcome === "error") ? "error" : spans.every(span => span.outcome === "success") ? "success" : "unknown",
    spanCount: spans.length, limited: spans.length > 500, spans: spans.slice(0, 500)};
}
function traces(value: unknown, limit: number): StoredTrace[] {
  const source = record(value);
  if (source.errors !== undefined && source.errors !== null && array(source.errors, 100).length) return invalid();
  const result = array(source.data, limit).map(trace).filter((value): value is StoredTrace => value !== null);
  if (new Set(result.map(value => value.id)).size !== result.length) return invalid();
  return result;
}

/** Bound the decoded response, including chunked/decompressed bodies, before JSON parsing. */
async function readJson(fetcher: QueryFetch, url: URL, signal: AbortSignal, missingTrace: boolean): Promise<unknown> {
  const response = await fetcher(url, {signal, redirect: "error", credentials: "omit", headers: {accept: "application/json"}});
  if (missingTrace && response.status === 404) {await response.body?.cancel(); return {data: []};}
  if (!response.ok || !response.body || Number(response.headers.get("content-length") ?? 0) > 4 * 1024 * 1024) {
    await response.body?.cancel(); return invalid();
  }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4 * 1024 * 1024) return invalid();
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {void reader.cancel().catch(() => {}); reader.releaseLock();}
}

/** One pending fetch per backend, even if a broken transport ignores cancellation. */
class Backend {
  private pending?: {key: string; result: Promise<Reading<any>>; controller: AbortController};
  private cache = new Map<string, {at: number; reading: Reading<any>}>();
  private closed = false;
  constructor(private readonly enabled: boolean, private readonly fetcher: QueryFetch, private readonly now: () => number, private readonly timeout: number) {}
  async read<T>(key: string, url: URL, parse: (value: unknown) => T): Promise<Reading<T>> {
    const unavailable: Reading<T> = {state: "unavailable", observedAt: null, value: null};
    if (!this.enabled) return {state: "not_configured", observedAt: null, value: null};
    if (this.closed) return unavailable;
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < 5000) return cached.reading;
    if (this.pending && this.pending.key !== key) return unavailable;
    if (!this.pending) {
      const controller = new AbortController();
      const result = readJson(this.fetcher, url, controller.signal, key.startsWith("trace:")).then(value => {
        if (controller.signal.aborted || this.closed) return unavailable;
        const reading: Reading<T> = {state: "available", observedAt: new Date(this.now()).toISOString(), value: parse(value)};
        if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, {at: this.now(), reading}); return reading;
      }).catch(() => unavailable).finally(() => {this.pending = undefined;});
      this.pending = {key, result, controller};
    }
    const pending = this.pending;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([pending.result, new Promise<Reading<T>>(resolve => {
        timer = setTimeout(() => {pending.controller.abort(); resolve(unavailable);}, this.timeout);
      })]);
    } finally {clearTimeout(timer);}
  }
  close() {this.closed = true; this.pending?.controller.abort(); this.cache.clear();}
}

export class TelemetryExplorer {
  private readonly now: () => number;
  private readonly tracesBackend: Backend;
  private readonly metricsBackend: Backend;
  constructor(options: ExplorerOptions = {}) {
    this.now = options.now ?? Date.now;
    const timeout = Number.isFinite(options.timeoutMs) ? Math.max(25, Math.min(2000, options.timeoutMs!)) : 2000;
    const args = [options.enabled ?? process.env.HV_TELEMETRY_ENABLED === "1", options.fetch ?? fetch, this.now, timeout] as const;
    this.tracesBackend = new Backend(...args); this.metricsBackend = new Backend(...args);
  }
  recentTraces(jobId?: string): Promise<Reading<TraceList>> {
    if (jobId !== undefined && !JOB_ID.test(jobId)) throw new Error("invalid job ID");
    const end = this.now(), start = end - 86_400_000, url = new URL("/api/traces", TRACES);
    url.search = new URLSearchParams({service: "rough-cut-worker", operation: "job.process", start: String(start * 1000), end: String(end * 1000), limit: "20",
      ...(jobId ? {tags: JSON.stringify({"hv.job.id": jobId.toLowerCase()})} : {})}).toString();
    return this.tracesBackend.read("list:" + (jobId?.toLowerCase() ?? ""), url, value => ({windowStart: new Date(start).toISOString(), windowEnd: new Date(end).toISOString(), limit: 20,
      traces: traces(value, 20).filter(item => item.jobId && (!jobId || item.jobId.toLowerCase() === jobId.toLowerCase()))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(({spans: _spans, ...summary}) => summary)}));
  }
  trace(id: string): Promise<Reading<StoredTrace | null>> {
    if (!TRACE_ID.test(id)) throw new Error("invalid trace ID");
    return this.tracesBackend.read("trace:" + id, new URL("/api/traces/" + id, TRACES), value => {
      const result = traces(value, 1);
      if (result[0] && result[0].id !== id) return invalid();
      return result[0] ?? null;
    });
  }
  metrics(): Promise<Reading<RecentMetrics>> {
    const end = Math.floor(this.now() / 60_000) * 60, start = end - 1800;
    const url = new URL("/api/v1/query_range", METRICS);
    url.search = new URLSearchParams({query: OPERATIONS_QUERY, start: String(start), end: String(end), step: "60", timeout: "1s", limit: "4"}).toString();
    return this.metricsBackend.read("metrics", url, value => {
      const source = record(value), data = record(source.data);
      if (source.status !== "success" || data.resultType !== "matrix" || (source.warnings && array(source.warnings, 100).length)) return invalid();
      const series: MetricSeries[] = array(data.result, 4).map(item => {
        const row = record(item), labels = record(row.metric);
        if (!SERVICES.includes(labels.job) || !["success", "error"].includes(labels.hv_outcome)) return invalid();
        let previous = start - 1;
        const points: [number, number | null][] = array(row.values, 31).map(point => {
          if (!Array.isArray(point) || point.length !== 2 || typeof point[1] !== "string") return invalid();
          const at = number(point[0], end);
          if (at < start || at <= previous || (at - start) % 60 !== 0) return invalid();
          previous = at;
          const rate = ["NaN", "+Inf", "-Inf"].includes(point[1]) ? null : number(Number(point[1]), 1e12);
          if (point[1].trim() === "") return invalid();
          return [at * 1000, rate];
        });
        return {service: labels.job, outcome: labels.hv_outcome, points};
      });
      if (new Set(series.map(item => item.service + item.outcome)).size !== series.length) return invalid();
      return {windowStart: new Date(start * 1000).toISOString(), windowEnd: new Date(end * 1000).toISOString(), stepSeconds: 60, series};
    });
  }
  close() {this.tracesBackend.close(); this.metricsBackend.close();}
}
