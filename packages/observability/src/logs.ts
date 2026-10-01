import { safeAttributes, type FailureCode, type Operation, type OperationReport, type SpanHandle, type StudioTelemetry } from "./index";
import type { ProviderKind } from "./provider-kinds";

/** Sanitized, trace-correlated JSON lines. One object per line, fixed keys, allow-listed context, no free text. */
export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogService = "api" | "worker" | "retention";
export type LogEvent = "api.started" | "api.request" | "worker.started" | "worker.stopped" | "worker.heartbeat_failed" | "worker.job_started" | "worker.job_finished" | "worker.lease_lost"
  | "retention.failed" | "retention.cache_cleanup_failed" | "retention.incomplete_uploads_failed" | "op.finished" | "log.dropped" | "log.suppressed" | "log.configuration_invalid"
  | "crew.budget_alert" | "crew.budget_stopped" | "voice.budget_alert" | "music.budget_alert";
export const EVENTS: ReadonlySet<LogEvent> = new Set<LogEvent>(["api.started","api.request","worker.started","worker.stopped","worker.heartbeat_failed","worker.job_started","worker.job_finished","worker.lease_lost",
  "retention.failed","retention.cache_cleanup_failed","retention.incomplete_uploads_failed","op.finished","log.dropped","log.suppressed","log.configuration_invalid",
  "crew.budget_alert","crew.budget_stopped","voice.budget_alert","music.budget_alert"]);
export type JobLogStage = "animatic" | "final" | "character-sheet" | "take-preview" | "take-final" | "dialogue-replacement" | "audio-take" | "lip-sync" | "sound-mix" | "picture-edit" | "assembly-edit" | "motion-graphic" | "delivery";
export interface LogFields {
  projectId?: string; jobId?: string; attemptId?: string; op?: Operation; stage?: JobLogStage; outcome?: "success" | "error"; code?: FailureCode;
  provider?: ProviderKind; worker?: string; method?: string; route?: string; status?: number;
  jobStatus?: "queued" | "running" | "done" | "failed" | "cancelled"; leaseReason?: "not_running" | "wrong_worker" | "lease_expired" | "fence_changed";
  durationMs?: number; costUsd?: number; shots?: number; files?: number; retryInSeconds?: number; port?: number; tls?: boolean;
  storage?: "json" | "postgres" | "local" | "s3"; release?: string; traceId?: string; spanId?: string;
}
/** Fixed record shape: the four header keys, then only allow-listed context, then `dropped` when something was withheld. */
export const LOG_KEYS: ReadonlySet<string> = new Set(["ts","level","service","event","op","stage","outcome","code","traceId","spanId","durationMs","projectId","jobId","attemptId","provider","worker",
  "method","route","status","jobStatus","leaseReason","costUsd","shots","files","retryInSeconds","port","tls","storage","release","dropped"]);
export const LOG_LINE_MAX_BYTES = 2048;
const LEVELS: Record<LogLevel, number> = {debug:0,info:1,warn:2,error:3};
const TRACE_KEYS: Record<string, string> = {projectId:"hv.project.id",jobId:"hv.job.id",attemptId:"hv.attempt.id",op:"hv.operation",outcome:"hv.outcome",code:"hv.failure_code",provider:"hv.provider",
  method:"http.request.method",route:"http.route",status:"http.response.status_code",costUsd:"hv.cost_usd",shots:"hv.checkpoint.shots",files:"hv.media.files"};
const LOG_KEYS_BY_TRACE: Record<string, string> = Object.fromEntries([...Object.entries(TRACE_KEYS).map(([key,value])=>[value,key]),["hv.stage","stage"]]);
const STAGES = new Set<string>(["animatic","final","character-sheet","take-preview","take-final","dialogue-replacement","audio-take","lip-sync","sound-mix","picture-edit","assembly-edit","motion-graphic","delivery"]);
const JOB_STATUSES = new Set<string>(["queued","running","done","failed","cancelled"]);
const LEASE_REASONS = new Set<string>(["not_running","wrong_worker","lease_expired","fence_changed"]);
const STORAGES = new Set<string>(["json","postgres","local","s3"]);
const METHODS = new Set<string>(["GET","POST","PUT","HEAD","OPTIONS","DELETE","PATCH","OTHER"]);
const WORKER = /^[A-Za-z0-9_.:-]{1,40}$/, RELEASE = /^[a-f0-9]{40}$/, TRACE_ID = /^[0-9a-f]{32}$/, SPAN_ID = /^[0-9a-f]{16}$/, ZERO = /^0+$/;
const CARRIER = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/;
const URL_MARK = /:\/\//, BEARER = /\bBearer\b/, SIGNED_TOKEN = /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/, OPAQUE_BLOB = /[A-Za-z0-9+/=]{64,}/;
const counted = (value: unknown, max: number): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= max;
/** Log-only validators; every other allow-listed key goes through the trace validators in `safeAttributes`. */
const LOG_ONLY: Record<string, (value: unknown) => boolean> = {
  stage: value => STAGES.has(String(value)), jobStatus: value => JOB_STATUSES.has(String(value)), leaseReason: value => LEASE_REASONS.has(String(value)),
  worker: value => typeof value === "string" && WORKER.test(value), durationMs: value => counted(value, 1e9), retryInSeconds: value => counted(value, 1e9),
  port: value => Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 65535, tls: value => typeof value === "boolean", storage: value => STORAGES.has(String(value)),
  release: value => typeof value === "string" && RELEASE.test(value), traceId: value => typeof value === "string" && TRACE_ID.test(value) && !ZERO.test(value),
  spanId: value => typeof value === "string" && SPAN_ID.test(value) && !ZERO.test(value),
};
/** Keeps allow-listed keys whose values pass their validator; everything else is omitted and counted. `undefined` means "not provided" and is not counted. */
export function safeLogFields(input: Record<string, unknown>): {fields: LogFields; dropped: number} {
  const fields: Record<string, unknown> = {};
  let dropped = 0;
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (typeof value === "string" && value.length > 128) {dropped++; continue;}
    const traceKey = TRACE_KEYS[key];
    let keep: boolean;
    if (traceKey) {
      keep = safeAttributes({[traceKey]: value as string | number})[traceKey] !== undefined && (key !== "shots" && key !== "files" || Number.isInteger(value));
    } else {
      const validator = LOG_ONLY[key];
      keep = validator !== undefined && validator(value);
    }
    if (keep) fields[key] = value; else dropped++;
  }
  return {fields: fields as LogFields, dropped};
}
/** Reject a serialized line that could carry a URL, a bearer marker, a signed token or an opaque blob, or that exceeds the size cap. */
export function guardLine(line: string): boolean {
  return Buffer.byteLength(line) <= LOG_LINE_MAX_BYTES && !URL_MARK.test(line) && !BEARER.test(line) && !SIGNED_TOKEN.test(line) && !OPAQUE_BLOB.test(line);
}
/** Maps an HTTP method onto the closed set traces use; anything else is "OTHER". */
export function requestMethod(method: string): string {return METHODS.has(method) ? method : "OTHER";}
function spanIds(carrier: string | undefined): {traceId: string; spanId: string} | undefined {
  const match = carrier ? CARRIER.exec(carrier) : null;
  if (!match || ZERO.test(match[1]!) || ZERO.test(match[2]!)) return;
  return {traceId: match[1]!, spanId: match[2]!};
}
export interface LoggerOptions {
  service: LogService; level?: LogLevel; sample?: number; release?: string;
  /** Sink; defaults to stdout for info/debug and stderr for warn/error. */
  write?: (level: LogLevel, line: string) => void;
  /** Ambient span carrier (usually `telemetry.carrier`); an explicit `SpanHandle` argument wins over it. */
  carrier?: () => string | undefined;
}
export class StudioLogger {
  readonly service: LogService;
  readonly level: LogLevel;
  readonly sample: number;
  private readonly release?: string;
  private readonly write: (level: LogLevel, line: string) => void;
  private ambient?: () => string | undefined;
  constructor(options: LoggerOptions) {
    this.service = options.service; this.level = options.level ?? "info";
    this.sample = Number.isFinite(options.sample) ? Math.max(0, Math.min(1, options.sample!)) : 1;
    if (options.release && RELEASE.test(options.release)) this.release = options.release;
    this.write = options.write ?? ((level, line) => {if (LEVELS[level] >= LEVELS.warn) console.error(line); else console.log(line);});
    this.ambient = options.carrier;
  }
  debug(event: LogEvent, fields: LogFields = {}, span?: SpanHandle): void {this.emit("debug", event, fields, span);}
  info(event: LogEvent, fields: LogFields = {}, span?: SpanHandle): void {this.emit("info", event, fields, span);}
  warn(event: LogEvent, fields: LogFields = {}, span?: SpanHandle): void {this.emit("warn", event, fields, span);}
  error(event: LogEvent, fields: LogFields = {}, span?: SpanHandle): void {this.emit("error", event, fields, span);}
  /** Emits one `op.finished` line per completed operation from the telemetry hook; `provider.attempt` at info, others at debug, never `http.request`/`job.process`.
   * The first logger attached to a `StudioTelemetry` keeps its hook, so a telemetry shared between processes keeps one service name on its lines. */
  attach(telemetry: StudioTelemetry): this {
    this.ambient ??= () => telemetry.carrier();
    telemetry.onOperation ??= report => this.operation(report);
    return this;
  }
  private operation(report: OperationReport): void {
    if (report.operation === "http.request" || report.operation === "job.process") return;
    const fields: Record<string, unknown> = {op: report.operation, durationMs: Math.max(0, Math.round(report.durationMs))};
    for (const [key, value] of Object.entries(report.attributes)) {const name = LOG_KEYS_BY_TRACE[key]; if (name && name !== "op") fields[name] = value;}
    if (report.failed && fields.outcome === undefined) fields.outcome = "error";
    this.emit(report.operation === "provider.attempt" ? "info" : "debug", "op.finished", fields as LogFields, undefined, spanIds(report.carrier));
  }
  private emit(level: LogLevel, event: LogEvent, fields: LogFields, span?: SpanHandle, ids?: {traceId: string; spanId: string}): void {
    // The logger's own health signals (log.dropped for an unknown event, log.configuration_invalid) bypass the level gate.
    if (LEVELS[level] < LEVELS[this.level] && EVENTS.has(event) && event !== "log.configuration_invalid") return;
    try {
      if (!EVENTS.has(event)) {this.write("warn", JSON.stringify({ts: new Date().toISOString(), level: "warn", service: this.service, event: "log.dropped", dropped: 1})); return;}
      ids ??= spanIds(span ? span.carrier() : this.ambient?.());
      if (this.sample < 1 && (level === "debug" || event === "api.request" && Number(fields.status) < 400)) {
        const draw = ids ? Number.parseInt(ids.traceId.slice(-8), 16) / 0x100000000 : Math.random();
        if (draw >= this.sample) return;
      }
      const {fields: safe, dropped} = safeLogFields(fields as Record<string, unknown>);
      const record = {ts: new Date().toISOString(), level, service: this.service, event, ...(this.release ? {release: this.release} : {}), ...safe, ...ids, ...(dropped ? {dropped} : {})};
      const line = JSON.stringify(record);
      if (guardLine(line)) this.write(level, line);
      else this.write("error", JSON.stringify({ts: record.ts, level: "error", service: this.service, event: "log.suppressed", dropped: Object.keys(record).length - 4}));
    } catch {
      // A logger must never take the request or the job down with it.
    }
  }
}
/** A sink-less logger for callers that inject nothing; mirrors `quietTelemetry` in the worker. */
export function quietLogger(service: LogService): StudioLogger {return new StudioLogger({service, level: "error", write: () => {}});}
/** `HV_LOG_LEVEL` (default info), `HV_LOG_SAMPLE` in [0, 1] (default 1) and `HV_RELEASE_SHA`; invalid values fall back and produce one `log.configuration_invalid` line. */
export function loggerFromEnv(service: LogService, telemetry?: StudioTelemetry): StudioLogger {
  let invalid = 0;
  const rawLevel = process.env.HV_LOG_LEVEL, level: LogLevel = rawLevel === undefined ? "info" : Object.hasOwn(LEVELS, rawLevel) ? rawLevel as LogLevel : (invalid++, "info");
  const rawSample = process.env.HV_LOG_SAMPLE, parsed = rawSample === undefined || rawSample.trim() === "" ? Number.NaN : Number(rawSample);
  const sample = rawSample === undefined ? 1 : Number.isFinite(parsed) ? (parsed < 0 || parsed > 1 ? (invalid++, Math.max(0, Math.min(1, parsed))) : parsed) : (invalid++, 1);
  const release = process.env.HV_RELEASE_SHA;
  if (release !== undefined && !RELEASE.test(release)) invalid++;
  const logger = new StudioLogger({service, level, sample, release});
  if (telemetry) logger.attach(telemetry);
  if (invalid) logger.warn("log.configuration_invalid");
  return logger;
}
