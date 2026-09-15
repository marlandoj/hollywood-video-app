import { safeAttributes, PROVIDER_KINDS, type Operation } from "./index";

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
export type ProviderKind = typeof PROVIDER_KINDS[number];
export interface LatencyRow {operation: Operation; p50Ms: number | null; p95Ms: number | null; p99Ms: number | null; capped: boolean}
export interface FailureRow {operation: Operation; successPerMinute: number; errorPerMinute: number; errorRatio: number | null; codes: Record<string, number>}
export interface ProviderRow {provider: ProviderKind; successPerMinute: number; errorPerMinute: number; errorRatio: number | null}
export interface ReliabilityReading {evaluatedAt: string; windowSeconds: 300; ceilingMs: number; latency: LatencyRow[]; failures: FailureRow[]; providers: ProviderRow[]}
export interface RecentMetrics {windowStart: string; windowEnd: string; stepSeconds: number; series: MetricSeries[]; reliability: ReliabilityReading}
export interface Reading<T> {state: "available" | "unavailable" | "not_configured"; observedAt: string | null; value: T | null}
type QueryFetch = (url: URL, init: RequestInit) => Promise<Response>;
export interface ExplorerOptions {enabled?: boolean; fetch?: QueryFetch; now?: () => number; timeoutMs?: number}

// No caller-controlled host, PromQL, time range, service, tag name, or result limit.
const TRACES = "http://127.0.0.1:15686";
const METRICS = "http://127.0.0.1:15909";
export const OPERATIONS_QUERY = 'sum by (job, hv_outcome) (rate(hv_operations_total{job="rough-cut-api",hv_operation="http.request",http_route!~"/api/operator/.*"}[5m]) or rate(hv_operations_total{job="rough-cut-worker",hv_operation="job.process"}[5m])) * 60';
const QUANTILES = ["p50", "p95", "p99"] as const;
const quantile = (fraction: string, name: string) =>
  'label_replace(histogram_quantile(' + fraction + ', sum by (le, hv_operation) (rate(hv_operation_duration_milliseconds_bucket{http_route!~"/api/operator/.*"}[5m]))), "quantile", "' + name + '", "", "")';
/** One instant expression whose three arms carry a distinct static `quantile` label, so the union cannot collapse. */
export const LATENCY_QUERY = [quantile("0.5", "p50"), quantile("0.95", "p95"), quantile("0.99", "p99")].join(" or ");
export const FAILURES_QUERY = 'sum by (hv_operation, hv_outcome, hv_failure_code) (rate(hv_operations_total{http_route!~"/api/operator/.*"}[5m])) * 60';
export const PROVIDER_ATTEMPTS_QUERY = 'sum by (hv_provider, hv_outcome) (rate(hv_operations_total{hv_operation="provider.attempt"}[5m])) * 60';
/** Top finite histogram boundary: a quantile reported here is a floor, not a measurement. */
export const CEILING_MS = 600_000;
// Row limits, sized from the closed label sets so Prometheus never truncates a full result. Widening a set means widening these:
// latency is one series per operation per quantile, failures one per operation per outcome per code (success, eight codes, `unknown`),
// provider attempts one per provider kind per outcome. `packages/observability/test/explorer.test.ts` fails if a set outgrows its limit.
// PROVIDER_LIMIT is six kinds x two outcomes = 12 series, with four rows of headroom. The headroom is not decoration: a
// rate(...[5m]) window spanning a deploy sees the union of the old and new label values, so every member of a retired set
// must remain a member of the current one or a complete result overflows its limit — and metrics() fails closed as a
// bundle, taking the latency and failure readings down with it until the next redeploy.
export const LATENCY_LIMIT = 30, FAILURES_LIMIT = 128, PROVIDER_LIMIT = 16;
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

/** Every instant reply is bounded, warning-free and label-checked before a single row is kept. */
function vector(value: unknown, max: number): {labels: Record<string, any>; sample: number | null}[] {
  const source = record(value), data = record(source.data);
  if (source.status !== "success" || data.resultType !== "vector" || (source.warnings && array(source.warnings, 100).length)) return invalid();
  return array(data.result, max).map(item => {
    const row = record(item);
    if (!Array.isArray(row.value) || row.value.length !== 2 || typeof row.value[1] !== "string" || row.value[1].trim() === "") return invalid();
    number(row.value[0], 8e15);
    return {labels: record(row.metric), sample: ["NaN", "+Inf", "-Inf"].includes(row.value[1]) ? null : number(Number(row.value[1]), 1e12)};
  });
}
const operationOf = (value: any): Operation => (safeAttributes({"hv.operation": value})["hv.operation"] ?? invalid()) as Operation;
const outcomeOf = (value: any): "success" | "error" => (safeAttributes({"hv.outcome": value})["hv.outcome"] ?? invalid()) as "success" | "error";
const ratio = (success: number, error: number): number | null => success + error > 0 ? error / (success + error) : null;
function unique(seen: Set<string>, key: string): void {if (seen.has(key)) invalid(); seen.add(key);}
function latencyRows(value: unknown): LatencyRow[] {
  const rows = new Map<Operation, LatencyRow>(), seen = new Set<string>();
  for (const {labels, sample} of vector(value, LATENCY_LIMIT)) {
    const operation = operationOf(labels.hv_operation);
    if (!QUANTILES.includes(labels.quantile)) return invalid();
    unique(seen, operation + "/" + labels.quantile);
    const row = rows.get(operation) ?? {operation, p50Ms: null, p95Ms: null, p99Ms: null, capped: false};
    row[(labels.quantile + "Ms") as "p50Ms" | "p95Ms" | "p99Ms"] = sample;
    row.capped = row.capped || (sample !== null && sample >= CEILING_MS);
    rows.set(operation, row);
  }
  return [...rows.values()].sort((a, b) => a.operation.localeCompare(b.operation));
}
function failureRows(value: unknown): FailureRow[] {
  const rows = new Map<Operation, FailureRow>(), seen = new Set<string>();
  for (const {labels, sample} of vector(value, FAILURES_LIMIT)) {
    const operation = operationOf(labels.hv_operation), outcome = outcomeOf(labels.hv_outcome), rate = sample ?? invalid();
    const raw = labels.hv_failure_code === undefined || labels.hv_failure_code === "" ? "unknown" : labels.hv_failure_code;
    const code = raw === "unknown" ? "unknown" : (safeAttributes({"hv.failure_code": raw})["hv.failure_code"] ?? invalid()) as string;
    if (outcome === "success" && code !== "unknown") return invalid();
    unique(seen, operation + "/" + outcome + "/" + code);
    const row = rows.get(operation) ?? {operation, successPerMinute: 0, errorPerMinute: 0, errorRatio: null, codes: Object.create(null) as Record<string, number>};
    if (outcome === "success") row.successPerMinute += rate;
    else {row.errorPerMinute += rate; row.codes[code] = (row.codes[code] ?? 0) + rate;}
    rows.set(operation, row);
  }
  for (const row of rows.values()) row.errorRatio = ratio(row.successPerMinute, row.errorPerMinute);
  return [...rows.values()].sort((a, b) => a.operation.localeCompare(b.operation));
}
function providerRows(value: unknown): ProviderRow[] {
  const rows = new Map<ProviderKind, ProviderRow>(), seen = new Set<string>();
  for (const {labels, sample} of vector(value, PROVIDER_LIMIT)) {
    const provider = (safeAttributes({"hv.provider": labels.hv_provider})["hv.provider"] ?? invalid()) as ProviderKind;
    const outcome = outcomeOf(labels.hv_outcome), rate = sample ?? invalid();
    unique(seen, provider + "/" + outcome);
    const row = rows.get(provider) ?? {provider, successPerMinute: 0, errorPerMinute: 0, errorRatio: null};
    if (outcome === "success") row.successPerMinute += rate; else row.errorPerMinute += rate;
    rows.set(provider, row);
  }
  for (const row of rows.values()) row.errorRatio = ratio(row.successPerMinute, row.errorPerMinute);
  return [...rows.values()].sort((a, b) => a.provider.localeCompare(b.provider));
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
  /** A bundle is one slot, one deadline and one cache entry: its URLs are fetched in order and fail together. */
  async read<T>(key: string, urls: URL[], parse: (values: unknown[]) => T): Promise<Reading<T>> {
    const unavailable: Reading<T> = {state: "unavailable", observedAt: null, value: null};
    if (!this.enabled) return {state: "not_configured", observedAt: null, value: null};
    if (this.closed) return unavailable;
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < 5000) return cached.reading;
    if (this.pending && this.pending.key !== key) return unavailable;
    if (!this.pending) {
      const controller = new AbortController();
      const bundle = async () => {
        const values: unknown[] = [];
        for (const url of urls) values.push(await readJson(this.fetcher, url, controller.signal, key.startsWith("trace:")));
        return values;
      };
      const result = bundle().then(value => {
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
    return this.tracesBackend.read("list:" + (jobId?.toLowerCase() ?? ""), [url], ([value]) => ({windowStart: new Date(start).toISOString(), windowEnd: new Date(end).toISOString(), limit: 20,
      traces: traces(value, 20).filter(item => item.jobId && (!jobId || item.jobId.toLowerCase() === jobId.toLowerCase()))
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt)).map(({spans: _spans, ...summary}) => summary)}));
  }
  trace(id: string): Promise<Reading<StoredTrace | null>> {
    if (!TRACE_ID.test(id)) throw new Error("invalid trace ID");
    return this.tracesBackend.read("trace:" + id, [new URL("/api/traces/" + id, TRACES)], ([value]) => {
      const result = traces(value, 1);
      if (result[0] && result[0].id !== id) return invalid();
      return result[0] ?? null;
    });
  }
  metrics(): Promise<Reading<RecentMetrics>> {
    const end = Math.floor(this.now() / 60_000) * 60, start = end - 1800;
    const url = new URL("/api/v1/query_range", METRICS);
    url.search = new URLSearchParams({query: OPERATIONS_QUERY, start: String(start), end: String(end), step: "60", timeout: "1s", limit: "4"}).toString();
    const instant = (query: string, limit: number) => {
      const target = new URL("/api/v1/query", METRICS);
      target.search = new URLSearchParams({query, time: String(end), timeout: "1s", limit: String(limit)}).toString();
      return target;
    };
    const queries = [url, instant(LATENCY_QUERY, LATENCY_LIMIT), instant(FAILURES_QUERY, FAILURES_LIMIT), instant(PROVIDER_ATTEMPTS_QUERY, PROVIDER_LIMIT)];
    return this.metricsBackend.read("metrics", queries, ([value, latency, failures, providers]) => {
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
      return {windowStart: new Date(start * 1000).toISOString(), windowEnd: new Date(end * 1000).toISOString(), stepSeconds: 60, series,
        reliability: {evaluatedAt: new Date(end * 1000).toISOString(), windowSeconds: 300 as const, ceilingMs: CEILING_MS,
          latency: latencyRows(latency), failures: failureRows(failures), providers: providerRows(providers)}};
    });
  }
  close() {this.tracesBackend.close(); this.metricsBackend.close();}
}
