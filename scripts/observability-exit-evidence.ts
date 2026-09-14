/**
 * Read-only HV-038 observability exit evidence collector (HV-038-04). Runs on the private staging host against the
 * live runtime and records what it observes into `hv-observability-exit/1`; every section is `recorded`, `pending`
 * with a fixed reason, or `not_configured` when the host itself says the capability is off, and `observabilityExit`
 * is derived from the sections, never asserted. By construction it performs no write: database reads run inside the
 * imported read-only transaction, the only child processes are `supervisorctl status|tail`, and the only network
 * calls are loopback `GET`s to the observability readiness endpoints and to the edge `/health`. It opens no secret
 * file, prints no URL, key or password, and refuses to run when `HV_PG_ADMIN_URL` names a role other than hv_admin.
 * It re-measures nothing `scripts/storage-wave-a-evidence.ts` records and reuses that collector's helpers.
 */
import { lstatSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { SQL } from "bun";
import { FAILURE_CODES, OPERATION_NAMES, PROVIDER_KINDS } from "../packages/observability/src/index";
import { TelemetryExplorer, TRACE_ID, type Reading, type RecentMetrics, type TraceList } from "../packages/observability/src/explorer";
import { EVENTS, LOG_KEYS, LOG_LINE_MAX_BYTES, guardLine, type LogEvent } from "../packages/observability/src/logs";
import { costReadings, providerHealthReadings, readBackupStatus } from "../packages/observability/src/diagnostics";
import { FRESH_HEARTBEAT_SECONDS, ProbeFailure, SUPERVISOR_CONFIG, readBootId, readDeployment, readOnlyReads, spawnRunner,
  supervisorProbe, validateDocument, writeAtomically, type FetchLike, type Reason as WaveAReason, type Runner } from "./storage-wave-a-evidence";

export const SCHEMA = "hv-observability-exit/1";
export const SECTIONS = ["release", "telemetryRuntime", "traces", "metrics", "logs", "reliabilityPanel", "recovery", "availability"] as const;
export type Section = typeof SECTIONS[number];
/** The eight observed sections plus the wave A reference block, which carries the same three-state shape. */
export const BLOCKS = [...SECTIONS, "waveA"] as const;
export type Block = typeof BLOCKS[number];

export const OBSERVABILITY_PROGRAMS = ["rough-cut-observability-collector", "rough-cut-observability-metrics", "rough-cut-observability-traces"] as const;
export const LOG_PROGRAMS = ["rough-cut-staging-api", "rough-cut-staging-worker", "rough-cut-staging-sweeper"] as const;
export type LogProgram = typeof LOG_PROGRAMS[number];
/** The same three loopback readiness endpoints `scripts/observability-runtime.py` waits on; Prometheus redirects `/`, so `/-/ready` is probed. */
export const READINESS_ENDPOINTS = {collector: "http://127.0.0.1:15333/", traces: "http://127.0.0.1:15686/api/services", metrics: "http://127.0.0.1:15909/-/ready"} as const;
export const PINNED_BINARIES = {jaeger: {name: "jaeger", version: "2.20.0"}, collector: {name: "otelcol-contrib", version: "0.160.0"},
  prometheus: {name: "prometheus", version: "3.14.0"}} as const;
/** The only two service names a stored trace reading can contain; the search is restricted to them by the explorer. */
export const TRACE_SERVICES = ["rough-cut-api", "rough-cut-worker"] as const;
export const LOG_WINDOW = "last 65536 bytes of each stream";
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export const LOG_SERVICES = ["api", "worker", "retention"] as const;
export const CIRCUIT_STATES = ["unknown", "closed", "open", "half-open"] as const;
export const CIRCUIT_STAGES = ["animatic", "final", "character-sheet"] as const;
export const FAILURE_LABELS = [...FAILURE_CODES, "unknown"] as const;
export const HEALTH_ORIGIN = "http://127.0.0.1:8081";
export const AVAILABILITY_SAMPLES_DEFAULT = 10, AVAILABILITY_SAMPLES_MAX = 60, AVAILABILITY_TIMEOUT_MS = 2000, AVAILABILITY_INTERVAL_MS = 1000;
export const BACKUP_FRESH_SECONDS = 300;
export const OFFHOST_DRILL_PATH = "docs/evidence/hv038-observability/offhost-drill.json";
export const WAVE_A_PATH = "docs/evidence/hv040-storage/wave-a-exit.json";
export const HEALTH_SERVICE = "hollywood-video-private-staging";

/** The availability SLI, recorded verbatim. It is a definition, not a measurement: nothing here claims a target is met. */
export const SLI = {
  operation: "GET {edge}/health",
  successPredicate: 'HTTP 200 within 2000 ms, JSON body, service === "hollywood-video-private-staging", queueDepth/runningJobs/monthSpendUsd present and finite',
  excludedFromPredicate: 'the body\'s status field, which packages/api/src/server.ts hard-codes to "healthy" and therefore carries no information',
  vantage: "an external prober outside the staging host and its network path",
  window: "rolling 30 days, at least one sample per 60 s, announced maintenance windows excluded",
  errorBudget: "a three-nines control-plane target allows 43 m 12 s of failing samples in 30 days; at one sample per 60 s that budget resolves to about 43 samples",
} as const;
export const AVAILABILITY_BLOCKED_BY = [
  "G3: no external vantage point exists outside the staging host and its network path",
  "G3: the deep /api/operator/status signal needs an operator-minted 15-minute diagnostics token, and a long-lived credential is forbidden",
  "no operating window or maintenance calendar has been declared for the private staging host",
  "G7 and ADR-0020: no public endpoint may be published for an external prober to probe",
] as const;
export const PANEL_VANTAGE = "hv_admin read-only transaction on the host";
export const PANEL_HTTP_REASON = "the diagnostics token is minted by an operator; the collector opens no secret";

/** Every reason a block can carry. Probes never surface raw error text, a URL, a key or an identifier. */
export const REASONS = [
  "runtime manifest unavailable", "runtime manifest failed shape checks", "release marker disagrees with manifest",
  "observability settings unreadable", "observability settings absent", "observability disabled on the host", "observability root absent",
  "observability runtime manifest unreadable", "observability binaries manifest unreadable", "observability release unavailable",
  "observability service not running", "observability endpoint unavailable", "supervisor status unavailable",
  "telemetry backend not configured", "trace backend unavailable", "metric backend unavailable",
  "log stream unavailable", "log stream empty",
  "admin connection not configured", "admin connection is not hv_admin", "database unreachable", "database query failed",
  "diagnostics reading malformed", "backup status unreadable",
  "off-host drill record unreadable", "off-host drill record failed shape checks",
  "wave A evidence unreadable", "wave A evidence failed validation",
  "availability sample not taken",
] as const;
export type Reason = typeof REASONS[number] | `${Block} probe failed` | `${Block} probe timed out` | `${Block} data malformed`;
export const isKnownReason = (value: unknown): value is Reason => typeof value === "string" && ((REASONS as readonly string[]).includes(value)
  || BLOCKS.some(block => [`${block} probe failed`, `${block} probe timed out`, `${block} data malformed`].includes(value)));
/** A capability the host itself reports as off; distinct from a probe that could not read a capability that is on. */
export class NotConfigured extends Error {
  constructor(readonly reason: Reason) { super(reason); this.name = "NotConfigured"; }
}
const fail = (reason: Reason): never => { throw new ProbeFailure(reason as unknown as WaveAReason); };
const off = (reason: Reason): never => { throw new NotConfigured(reason); };

// ---- section data ----
export interface ReleaseData { sha: string; backend: string; expectedWorkers: number }
export interface TelemetryRuntimeData {
  enabled: true; root: string; sourceSha: string;
  binaries: {jaeger: string; collector: string; prometheus: string};
  supervisor: Record<string, string>;
  readiness: {collector: number; traces: number; metrics: number};
}
export interface TracesData {
  state: "available"; windowStart: string; windowEnd: string; traces: number; withJobId: number;
  outcomes: {success: number; error: number; unknown: number};
  newestStartedAt: string | null; spanCountMin: number | null; spanCountMax: number | null; services: string[];
}
export interface MetricsData {
  state: "available";
  series: {expected: 4; present: number; withSamples: number};
  reliability: {evaluatedAt: string; windowSeconds: number; ceilingMs: number; latencyOperations: string[]; latencyCapped: number;
    failureOperations: string[]; failureCodes: string[]; providers: string[]};
}
export interface LogCounts {
  lines: number; parsed: number; conforming: number; events: Record<string, number>; levels: Record<string, number>;
  traceCorrelated: number; unknownKeyLines: number; oversizeLines: number; guardViolations: number; droppedLines: number;
  suppressedLines: number; configurationInvalidLines: number; knownNonLoggerLines: number;
}
export type ProgramLogs = ({status: "recorded"} & LogCounts) | ({status: "pending"; reason: Reason} & Nulled<LogCounts>);
export interface LogsData { window: string; programs: Record<string, ProgramLogs> }
export interface ReliabilityPanelData {
  circuits: {workers: number; entries: number; dropped: number; truncated: boolean; states: Record<string, number>; stages: Record<string, number>; providers: Record<string, number>};
  costs: {providers: number; totals: {dayUsd: number; weekUsd: number; monthUsd: number}; dailyAverageUsd: number; lastDayVsAverage: "below" | "at" | "above" | null; truncated: boolean};
  queue: {queued: number; running: number};
  workers: {ready: number; busy: number; draining: number; latestProcesses: number};
  freshWithinSeconds: number; vantage: string; httpSurfaceRead: false; httpSurfaceReason: string;
}
export interface BackupCounts { state: string; lastSnapshotAt: string | null; lastCompletedAt: string | null; ageSeconds: number | null;
  freshWithin300s: boolean; failureStage: string | null; localRepositoryOnly: true }
export type BackupBlock = ({status: "recorded"} & BackupCounts) | ({status: "pending"; reason: Reason} & Nulled<BackupCounts>);
export interface DrillCounts { source: string; recordedAt: string; snapshotToCopyMs: number; encryptionExercised: boolean;
  provesOffHostRpo: false; provesHostLossRecovery: false; restoredIntoLiveDatabase: false; independentDestination: string }
export type DrillBlock = ({status: "recorded"} & DrillCounts) | ({status: "pending"; reason: Reason} & Nulled<DrillCounts>);
export interface RecoveryData { backup: BackupBlock; offHostDrill: DrillBlock; offHostDestinationConfigured: false; lastLiveRestoreAt: null }
export interface AvailabilitySample {
  attempts: number; successes: number; predicateFailures: number; p50LatencyMs: number | null; maxLatencyMs: number | null;
  startedAt: string; endedAt: string; vantage: string;
}
export interface AvailabilityData {
  sli: typeof SLI; sample: AvailabilitySample; establishesSlo: false; measuredExternally: false; windowDays: null; blockedBy: string[];
}
export interface WaveAData { recordedAt: string; releaseSha: string | null; satisfied: boolean }
export interface BlockData {
  release: ReleaseData; telemetryRuntime: TelemetryRuntimeData; traces: TracesData; metrics: MetricsData; logs: LogsData;
  reliabilityPanel: ReliabilityPanelData; recovery: RecoveryData; availability: AvailabilityData; waveA: WaveAData;
}
type Nulled<T> = {[K in keyof T]: null};
export type BlockResult<K extends Block> = ({status: "recorded"} & BlockData[K])
  | ({status: "pending" | "not_configured"; reason: Reason} & Nulled<BlockData[K]>);
export type Blocks = {[K in Block]: BlockResult<K>};
export interface ObservabilityExit {
  tracesQueryable: boolean; metricsQueryable: boolean; reliabilityPanelReadable: boolean; structuredLogsConforming: boolean;
  backupFresh: boolean; instrumented: boolean; sloClaimed: false; availabilityMeasuredExternally: false;
}
export interface ObservabilityExitDocument extends Blocks {
  schema: typeof SCHEMA; recordedAt: string; host: {runtimeRoot: string; bootId: string | null};
  observabilityExit: ObservabilityExit; newProviderSpendUsd: 0;
}

// ---- shape checks: a recorded block carries exactly these non-null fields, nothing a probe happened to return ----
const HEX40 = /^[a-f0-9]{40}$/, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_.:-]{1,80}$/, VERSION = /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/, STATE = /^[A-Z_]{1,32}$/;
const PATHNAME = /^\/[A-Za-z0-9_./-]{1,200}$/, PLAIN = /^[\x20-\x7e]{1,300}$/;
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const isMoney = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e12;
const isText = (value: unknown, pattern = PLAIN): value is string => typeof value === "string" && pattern.test(value);
const isTimestamp = (value: unknown): value is string => typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
/** A bounded count map: every key comes from the closed set, in its fixed order, and every value is a count. */
function countsOf(value: unknown, allowed: readonly string[]): Record<string, number> | null {
  if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) return null;
  const result: Record<string, number> = {};
  for (const key of allowed) { const seen = value[key]; if (seen === undefined) continue; if (!isCount(seen)) return null; result[key] = seen; }
  return result;
}
/** A bounded label list: every member comes from the closed set, without repetition, in its fixed order. */
function labelsOf(value: unknown, allowed: readonly string[]): string[] | null {
  if (!Array.isArray(value) || value.length > allowed.length) return null;
  const seen = new Set<string>();
  for (const item of value) { if (typeof item !== "string" || !allowed.includes(item) || seen.has(item)) return null; seen.add(item); }
  return allowed.filter(label => seen.has(label));
}
const LOG_NULLS: Nulled<LogCounts> = {lines: null, parsed: null, conforming: null, events: null, levels: null, traceCorrelated: null, unknownKeyLines: null,
  oversizeLines: null, guardViolations: null, droppedLines: null, suppressedLines: null, configurationInvalidLines: null, knownNonLoggerLines: null};
export function programLogsShape(value: unknown): ProgramLogs | null {
  if (!record(value)) return null;
  if (value.status === "pending") {
    if (!isKnownReason(value.reason) || Object.keys(LOG_NULLS).some(key => value[key] !== null)) return null;
    return {status: "pending", reason: value.reason, ...LOG_NULLS};
  }
  if (value.status !== "recorded") return null;
  const events = countsOf(value.events, [...EVENTS]), levels = countsOf(value.levels, LOG_LEVELS);
  const counts = ["lines", "parsed", "conforming", "traceCorrelated", "unknownKeyLines", "oversizeLines", "guardViolations", "droppedLines",
    "suppressedLines", "configurationInvalidLines", "knownNonLoggerLines"] as const;
  if (!events || !levels || counts.some(key => !isCount(value[key]))) return null;
  const data = Object.fromEntries(counts.map(key => [key, value[key] as number])) as Omit<LogCounts, "events" | "levels">;
  if (data.parsed > data.lines || data.conforming > data.parsed || data.knownNonLoggerLines > data.lines) return null;
  return {status: "recorded", lines: data.lines, parsed: data.parsed, conforming: data.conforming, events, levels, traceCorrelated: data.traceCorrelated,
    unknownKeyLines: data.unknownKeyLines, oversizeLines: data.oversizeLines, guardViolations: data.guardViolations, droppedLines: data.droppedLines,
    suppressedLines: data.suppressedLines, configurationInvalidLines: data.configurationInvalidLines, knownNonLoggerLines: data.knownNonLoggerLines};
}
const BACKUP_NULLS: Nulled<BackupCounts> = {state: null, lastSnapshotAt: null, lastCompletedAt: null, ageSeconds: null, freshWithin300s: null, failureStage: null, localRepositoryOnly: null};
function backupShape(value: unknown): BackupBlock | null {
  if (!record(value)) return null;
  if (value.status === "pending") return isKnownReason(value.reason) && Object.keys(BACKUP_NULLS).every(key => value[key] === null)
    ? {status: "pending", reason: value.reason, ...BACKUP_NULLS} : null;
  if (value.status !== "recorded" || !["running", "healthy", "degraded", "failed"].includes(value.state as string)) return null;
  if (!(value.lastSnapshotAt === null || isTimestamp(value.lastSnapshotAt)) || !(value.lastCompletedAt === null || isTimestamp(value.lastCompletedAt))) return null;
  if (!(value.ageSeconds === null || isCount(value.ageSeconds)) || typeof value.freshWithin300s !== "boolean") return null;
  if (!(value.failureStage === null || ["backup", "retention"].includes(value.failureStage as string)) || value.localRepositoryOnly !== true) return null;
  return {status: "recorded", state: value.state as string, lastSnapshotAt: value.lastSnapshotAt as string | null, lastCompletedAt: value.lastCompletedAt as string | null,
    ageSeconds: value.ageSeconds as number | null, freshWithin300s: value.freshWithin300s, failureStage: value.failureStage as string | null, localRepositoryOnly: true};
}
const DRILL_NULLS: Nulled<DrillCounts> = {source: null, recordedAt: null, snapshotToCopyMs: null, encryptionExercised: null, provesOffHostRpo: null,
  provesHostLossRecovery: null, restoredIntoLiveDatabase: null, independentDestination: null};
function drillShape(value: unknown): DrillBlock | null {
  if (!record(value)) return null;
  if (value.status === "pending") return isKnownReason(value.reason) && Object.keys(DRILL_NULLS).every(key => value[key] === null)
    ? {status: "pending", reason: value.reason, ...DRILL_NULLS} : null;
  if (value.status !== "recorded" || value.source !== OFFHOST_DRILL_PATH || !isTimestamp(value.recordedAt) || !isCount(value.snapshotToCopyMs)) return null;
  if (typeof value.encryptionExercised !== "boolean" || value.provesOffHostRpo !== false || value.provesHostLossRecovery !== false || value.restoredIntoLiveDatabase !== false) return null;
  if (!isText(value.independentDestination) || value.independentDestination.includes("://")) return null;
  return {status: "recorded", source: OFFHOST_DRILL_PATH, recordedAt: value.recordedAt, snapshotToCopyMs: value.snapshotToCopyMs,
    encryptionExercised: value.encryptionExercised, provesOffHostRpo: false, provesHostLossRecovery: false, restoredIntoLiveDatabase: false,
    independentDestination: value.independentDestination};
}
const SHAPES: {[K in Block]: (value: unknown) => BlockData[K] | null} = {
  release: v => record(v) && isText(v.sha, HEX40) && isText(v.backend, TOKEN) && isCount(v.expectedWorkers)
    ? {sha: v.sha, backend: v.backend, expectedWorkers: v.expectedWorkers} : null,
  telemetryRuntime: v => {
    if (!record(v) || v.enabled !== true || !isText(v.root, PATHNAME) || !isText(v.sourceSha, HEX40) || !record(v.binaries) || !record(v.supervisor) || !record(v.readiness)) return null;
    const binaries = v.binaries as Record<string, unknown>, supervisor = v.supervisor as Record<string, unknown>, readiness = v.readiness as Record<string, unknown>;
    if (!(["jaeger", "collector", "prometheus"] as const).every(name => isText(binaries[name], VERSION))) return null;
    if (Object.keys(supervisor).length !== OBSERVABILITY_PROGRAMS.length || !OBSERVABILITY_PROGRAMS.every(name => isText(supervisor[name], STATE))) return null;
    if (Object.keys(readiness).length !== 3 || !(["collector", "traces", "metrics"] as const).every(name => isCount(readiness[name]) && (readiness[name] as number) <= 599)) return null;
    return {enabled: true, root: v.root, sourceSha: v.sourceSha,
      binaries: {jaeger: binaries.jaeger as string, collector: binaries.collector as string, prometheus: binaries.prometheus as string},
      supervisor: Object.fromEntries(OBSERVABILITY_PROGRAMS.map(name => [name, supervisor[name] as string])),
      readiness: {collector: readiness.collector as number, traces: readiness.traces as number, metrics: readiness.metrics as number}};
  },
  traces: v => {
    if (!record(v) || v.state !== "available" || !isTimestamp(v.windowStart) || !isTimestamp(v.windowEnd) || !isCount(v.traces) || !isCount(v.withJobId)) return null;
    const outcomes = countsOf(v.outcomes, ["success", "error", "unknown"]), services = labelsOf(v.services, TRACE_SERVICES);
    if (!outcomes || !services || v.withJobId > v.traces) return null;
    if (!(v.newestStartedAt === null || isTimestamp(v.newestStartedAt))) return null;
    if (!(v.spanCountMin === null || isCount(v.spanCountMin)) || !(v.spanCountMax === null || isCount(v.spanCountMax))) return null;
    if ((v.traces === 0) !== (v.spanCountMin === null) || (v.spanCountMin === null) !== (v.spanCountMax === null)) return null;
    return {state: "available", windowStart: v.windowStart, windowEnd: v.windowEnd, traces: v.traces, withJobId: v.withJobId, outcomes: outcomes as TracesData["outcomes"],
      newestStartedAt: v.newestStartedAt as string | null, spanCountMin: v.spanCountMin as number | null, spanCountMax: v.spanCountMax as number | null, services};
  },
  metrics: v => {
    if (!record(v) || v.state !== "available" || !record(v.series) || !record(v.reliability)) return null;
    const series = v.series as Record<string, unknown>, reliability = v.reliability as Record<string, unknown>;
    if (series.expected !== 4 || !isCount(series.present) || !isCount(series.withSamples) || series.present > 4 || series.withSamples > (series.present as number)) return null;
    const latencyOperations = labelsOf(reliability.latencyOperations, OPERATION_NAMES), failureOperations = labelsOf(reliability.failureOperations, OPERATION_NAMES);
    const failureCodes = labelsOf(reliability.failureCodes, FAILURE_LABELS), providers = labelsOf(reliability.providers, PROVIDER_KINDS);
    if (!latencyOperations || !failureOperations || !failureCodes || !providers) return null;
    if (!isTimestamp(reliability.evaluatedAt) || !isCount(reliability.windowSeconds) || !isCount(reliability.ceilingMs) || !isCount(reliability.latencyCapped)) return null;
    if ((reliability.latencyCapped as number) > latencyOperations.length) return null;
    return {state: "available", series: {expected: 4, present: series.present, withSamples: series.withSamples},
      reliability: {evaluatedAt: reliability.evaluatedAt, windowSeconds: reliability.windowSeconds, ceilingMs: reliability.ceilingMs,
        latencyOperations, latencyCapped: reliability.latencyCapped, failureOperations, failureCodes, providers}};
  },
  logs: v => {
    if (!record(v) || v.window !== LOG_WINDOW || !record(v.programs)) return null;
    const programs = v.programs as Record<string, unknown>;
    if (Object.keys(programs).length !== LOG_PROGRAMS.length) return null;
    const result: Record<string, ProgramLogs> = {};
    for (const program of LOG_PROGRAMS) { const shape = programLogsShape(programs[program]); if (!shape) return null; result[program] = shape; }
    return {window: LOG_WINDOW, programs: result};
  },
  reliabilityPanel: v => {
    if (!record(v) || !record(v.circuits) || !record(v.costs) || !record(v.queue) || !record(v.workers)) return null;
    const circuits = v.circuits as Record<string, unknown>, costs = v.costs as Record<string, unknown>;
    const queue = v.queue as Record<string, unknown>, workers = v.workers as Record<string, unknown>;
    const states = countsOf(circuits.states, CIRCUIT_STATES), stages = countsOf(circuits.stages, CIRCUIT_STAGES), providers = countsOf(circuits.providers, PROVIDER_KINDS);
    if (!states || !stages || !providers || !isCount(circuits.workers) || !isCount(circuits.entries) || !isCount(circuits.dropped) || typeof circuits.truncated !== "boolean") return null;
    if (!record(costs.totals) || !isCount(costs.providers) || !isMoney(costs.dailyAverageUsd) || typeof costs.truncated !== "boolean") return null;
    const totals = costs.totals as Record<string, unknown>;
    if (!(["dayUsd", "weekUsd", "monthUsd"] as const).every(key => isMoney(totals[key]))) return null;
    if (!(costs.lastDayVsAverage === null || ["below", "at", "above"].includes(costs.lastDayVsAverage as string))) return null;
    if (!isCount(queue.queued) || !isCount(queue.running)) return null;
    if (!(["ready", "busy", "draining", "latestProcesses"] as const).every(key => isCount(workers[key]))) return null;
    if (v.freshWithinSeconds !== FRESH_HEARTBEAT_SECONDS || v.vantage !== PANEL_VANTAGE || v.httpSurfaceRead !== false || v.httpSurfaceReason !== PANEL_HTTP_REASON) return null;
    return {circuits: {workers: circuits.workers, entries: circuits.entries, dropped: circuits.dropped, truncated: circuits.truncated, states, stages, providers},
      costs: {providers: costs.providers, totals: {dayUsd: totals.dayUsd as number, weekUsd: totals.weekUsd as number, monthUsd: totals.monthUsd as number},
        dailyAverageUsd: costs.dailyAverageUsd, lastDayVsAverage: costs.lastDayVsAverage as ReliabilityPanelData["costs"]["lastDayVsAverage"], truncated: costs.truncated},
      queue: {queued: queue.queued, running: queue.running},
      workers: {ready: workers.ready as number, busy: workers.busy as number, draining: workers.draining as number, latestProcesses: workers.latestProcesses as number},
      freshWithinSeconds: FRESH_HEARTBEAT_SECONDS, vantage: PANEL_VANTAGE, httpSurfaceRead: false, httpSurfaceReason: PANEL_HTTP_REASON};
  },
  recovery: v => {
    if (!record(v) || v.offHostDestinationConfigured !== false || v.lastLiveRestoreAt !== null) return null;
    const backup = backupShape(v.backup), drill = drillShape(v.offHostDrill);
    return backup && drill ? {backup, offHostDrill: drill, offHostDestinationConfigured: false, lastLiveRestoreAt: null} : null;
  },
  availability: v => {
    if (!record(v) || !record(v.sample) || v.establishesSlo !== false || v.measuredExternally !== false || v.windowDays !== null) return null;
    if (JSON.stringify(v.sli) !== JSON.stringify(SLI) || JSON.stringify(v.blockedBy) !== JSON.stringify(AVAILABILITY_BLOCKED_BY)) return null;
    const sample = v.sample as Record<string, unknown>;
    if (!isCount(sample.attempts) || sample.attempts < 1 || sample.attempts > AVAILABILITY_SAMPLES_MAX) return null;
    if (!isCount(sample.successes) || !isCount(sample.predicateFailures) || sample.successes + sample.predicateFailures !== sample.attempts) return null;
    if (!(sample.p50LatencyMs === null || isCount(sample.p50LatencyMs)) || !(sample.maxLatencyMs === null || isCount(sample.maxLatencyMs))) return null;
    if (!isTimestamp(sample.startedAt) || !isTimestamp(sample.endedAt) || sample.vantage !== "loopback on the staging host") return null;
    return {sli: SLI, sample: {attempts: sample.attempts, successes: sample.successes, predicateFailures: sample.predicateFailures,
      p50LatencyMs: sample.p50LatencyMs as number | null, maxLatencyMs: sample.maxLatencyMs as number | null,
      startedAt: sample.startedAt, endedAt: sample.endedAt, vantage: "loopback on the staging host"},
      establishesSlo: false, measuredExternally: false, windowDays: null, blockedBy: [...AVAILABILITY_BLOCKED_BY]};
  },
  waveA: v => record(v) && isTimestamp(v.recordedAt) && (v.releaseSha === null || isText(v.releaseSha, HEX40)) && typeof v.satisfied === "boolean"
    ? {recordedAt: v.recordedAt, releaseSha: v.releaseSha as string | null, satisfied: v.satisfied} : null,
};
const NULL_FIELDS: {[K in Block]: Nulled<BlockData[K]>} = {
  release: {sha: null, backend: null, expectedWorkers: null},
  telemetryRuntime: {enabled: null, root: null, sourceSha: null, binaries: null, supervisor: null, readiness: null},
  traces: {state: null, windowStart: null, windowEnd: null, traces: null, withJobId: null, outcomes: null, newestStartedAt: null, spanCountMin: null, spanCountMax: null, services: null},
  metrics: {state: null, series: null, reliability: null},
  logs: {window: null, programs: null},
  reliabilityPanel: {circuits: null, costs: null, queue: null, workers: null, freshWithinSeconds: null, vantage: null, httpSurfaceRead: null, httpSurfaceReason: null},
  recovery: {backup: null, offHostDrill: null, offHostDestinationConfigured: null, lastLiveRestoreAt: null},
  availability: {sli: null, sample: null, establishesSlo: null, measuredExternally: null, windowDays: null, blockedBy: null},
  waveA: {recordedAt: null, releaseSha: null, satisfied: null},
};
export const emptyBlock = <K extends Block>(block: K, status: "pending" | "not_configured", reason: Reason): BlockResult<K> =>
  ({status, reason, ...NULL_FIELDS[block]}) as BlockResult<K>;
/** Re-validates any block object (a probe result or a committed file) into the exact three-state shape, or null. */
export function validateBlock<K extends Block>(block: K, value: unknown): BlockResult<K> | null {
  if (!record(value)) return null;
  if (value.status === "pending" || value.status === "not_configured") {
    if (!isKnownReason(value.reason)) return null;
    for (const key of Object.keys(NULL_FIELDS[block])) if (value[key] !== null) return null;
    return emptyBlock(block, value.status, value.reason);
  }
  if (value.status !== "recorded") return null;
  const data = SHAPES[block](value);
  return data ? {status: "recorded", ...data} as BlockResult<K> : null;
}

// ---- derivation: every boolean is read off the sections, never asserted ----
export function deriveObservabilityExit(blocks: Blocks): ObservabilityExit {
  const {traces, metrics, logs, reliabilityPanel, recovery} = blocks;
  const tracesQueryable = traces.status === "recorded" && traces.state === "available";
  // The metrics bundle fails closed: a recorded section is proof that Prometheus accepted all four expressions and every label passed its closed set.
  const metricsQueryable = metrics.status === "recorded" && metrics.state === "available";
  const reliabilityPanelReadable = reliabilityPanel.status === "recorded";
  const structuredLogsConforming = logs.status === "recorded" && LOG_PROGRAMS.every(program => {
    const entry = logs.programs[program];
    return entry !== undefined && entry.status === "recorded" && entry.parsed >= 1 && entry.conforming === entry.parsed && entry.guardViolations === 0;
  });
  const backupFresh = recovery.status === "recorded" && recovery.backup.status === "recorded"
    && ["running", "healthy"].includes(recovery.backup.state) && recovery.backup.freshWithin300s === true;
  const instrumented = tracesQueryable && metricsQueryable && reliabilityPanelReadable && structuredLogsConforming && backupFresh;
  return {tracesQueryable, metricsQueryable, reliabilityPanelReadable, structuredLogsConforming, backupFresh, instrumented,
    sloClaimed: false, availabilityMeasuredExternally: false};
}

// ---- collector ----
export interface ProbeContext { signal: AbortSignal }
export type Probe<T> = (context: ProbeContext) => Promise<T> | T;
export type Probes = {[K in Block]: Probe<BlockData[K]>};
export interface CollectOptions { runtimeRoot: string; bootId?: string | null; timeoutMs?: number; now?: () => number }
async function observe<K extends Block>(block: K, probe: Probe<BlockData[K]>, timeoutMs: number): Promise<BlockResult<K>> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const attempt = Promise.resolve().then(() => probe({signal: controller.signal}));
    attempt.catch(() => {});
    const value = await Promise.race([attempt, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new ProbeFailure(`${block} probe timed out` as WaveAReason)); }, timeoutMs);
    })]);
    const data = SHAPES[block](value);
    return data ? {status: "recorded", ...data} as BlockResult<K> : emptyBlock(block, "pending", `${block} data malformed`);
  } catch (error) {
    if (error instanceof NotConfigured) return emptyBlock(block, "not_configured", isKnownReason(error.reason) ? error.reason : `${block} probe failed`);
    const reason = error instanceof ProbeFailure && isKnownReason(error.reason) ? error.reason : `${block} probe failed` as Reason;
    return emptyBlock(block, "pending", reason);
  } finally { clearTimeout(timer); }
}
export async function collectObservabilityExit(probes: Probes, options: CollectOptions): Promise<ObservabilityExitDocument> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new Error("invalid probe timeout");
  const blocks = {} as Blocks;
  for (const block of BLOCKS) (blocks as Record<Block, unknown>)[block] = await observe(block, probes[block] as Probe<BlockData[Block]>, timeoutMs);
  const bootId = options.bootId ?? null;
  return {schema: SCHEMA, recordedAt: new Date((options.now ?? Date.now)()).toISOString(),
    host: {runtimeRoot: options.runtimeRoot, bootId: bootId !== null && UUID.test(bootId) ? bootId : null},
    ...blocks, observabilityExit: deriveObservabilityExit(blocks), newProviderSpendUsd: 0};
}
/** Validates a whole document (e.g. the committed evidence) and returns it in canonical shape, or throws. */
export function validateExitDocument(value: unknown): ObservabilityExitDocument {
  if (!record(value) || value.schema !== SCHEMA || !isTimestamp(value.recordedAt) || value.newProviderSpendUsd !== 0 || !record(value.host)
    || !isText((value.host as Record<string, unknown>).runtimeRoot, PATHNAME)
    || !((value.host as Record<string, unknown>).bootId === null || isText((value.host as Record<string, unknown>).bootId, UUID))) throw new Error("invalid observability exit document");
  const host = value.host as {runtimeRoot: string; bootId: string | null};
  const blocks = {} as Blocks;
  for (const block of BLOCKS) {
    const result = validateBlock(block, value[block]);
    if (!result) throw new Error("invalid observability exit block: " + block);
    (blocks as Record<Block, unknown>)[block] = result;
  }
  const observabilityExit = deriveObservabilityExit(blocks);
  if (JSON.stringify(value.observabilityExit) !== JSON.stringify(observabilityExit)) throw new Error("observability exit derivation does not match its sections");
  return {schema: SCHEMA, recordedAt: value.recordedAt, host: {runtimeRoot: host.runtimeRoot, bootId: host.bootId}, ...blocks, observabilityExit, newProviderSpendUsd: 0};
}

// ---- pure rules shared by the real probes and the offline tests ----
/** The observability settings the host stages; `enabled: false`, an absent file or an absent root is `not_configured`, not a failure. */
export interface ObservabilitySettings { enabled: true; root: string }
export function readObservabilitySettings(runtime: string): ObservabilitySettings {
  const path = join(runtime, "observability.json");
  let text: string;
  try { if (!lstatSync(path).isFile()) off("observability settings absent"); text = readFileSync(path, "utf8"); }
  catch (error) { throw error instanceof NotConfigured ? error : new NotConfigured("observability settings absent"); }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return fail("observability settings unreadable"); }
  if (!record(value) || value.schema !== "hv-observability-settings/1" || typeof value.enabled !== "boolean" || !isText(value.root, PATHNAME))
    return fail("observability settings unreadable");
  if (!value.enabled) off("observability disabled on the host");
  try { if (!statSync(value.root).isDirectory()) off("observability root absent"); }
  catch (error) { throw error instanceof NotConfigured ? error : new NotConfigured("observability root absent"); }
  return {enabled: true, root: value.root};
}
export function readObservabilityRuntime(root: string): {sourceSha: string} {
  let value: unknown;
  try { value = JSON.parse(readFileSync(join(root, "runtime.json"), "utf8")); } catch { return fail("observability runtime manifest unreadable"); }
  if (!record(value) || value.schema !== "hv-observability-runtime/1" || !isText(value.sourceSha, HEX40)) return fail("observability runtime manifest unreadable");
  return {sourceSha: value.sourceSha};
}
/** The pinned release of each service, exactly as `observability-runtime.py:binaries()` requires it to be present. */
export function readObservabilityBinaries(root: string): TelemetryRuntimeData["binaries"] {
  let value: unknown;
  try { value = JSON.parse(readFileSync(join(root, "binaries.json"), "utf8")); } catch { return fail("observability binaries manifest unreadable"); }
  if (!record(value) || value.schema !== "hv-observability-binaries/1" || !Array.isArray(value.releases)) return fail("observability binaries manifest unreadable");
  const versions = {} as Record<keyof typeof PINNED_BINARIES, string>;
  for (const [service, pinned] of Object.entries(PINNED_BINARIES)) {
    const matches = value.releases.filter(item => record(item) && item.name === pinned.name && item.version === pinned.version);
    if (matches.length !== 1 || !isText((matches[0] as Record<string, unknown>).version, VERSION)) return fail("observability release unavailable");
    versions[service as keyof typeof PINNED_BINARIES] = pinned.version;
  }
  return versions;
}
/** Counts only: no line, no key outside `LOG_KEYS` and no field value is ever copied out of a stream. */
export function emptyCounts(): LogCounts {
  return {lines: 0, parsed: 0, conforming: 0, events: {}, levels: {}, traceCorrelated: 0, unknownKeyLines: 0, oversizeLines: 0,
    guardViolations: 0, droppedLines: 0, suppressedLines: 0, configurationInvalidLines: 0, knownNonLoggerLines: 0};
}
/** A byte-bounded tail can begin mid-line, so the first line is always dropped; a trailing partial line is dropped too. */
export function tailLines(text: string): string[] {
  const lines = text.split("\n");
  if (!text.endsWith("\n")) lines.pop();
  lines.shift();
  return lines.filter(line => line.trim() !== "");
}
/** The two documented non-logger lines: the sweeper's per-minute status line and `telemetryFromEnv`'s fixed stderr line. */
export function isKnownNonLoggerLine(value: Record<string, unknown>): boolean {
  if (value.event === "telemetry.configuration_invalid" && Object.keys(value).every(key => key === "event" || key === "service")) return true;
  return value.event === undefined && typeof value.sweptAt === "string" && "incompleteUploads" in value;
}
export function classifyLogLines(streams: string[]): LogCounts {
  const counts = emptyCounts();
  for (const stream of streams) for (const line of tailLines(stream)) {
    counts.lines++;
    let value: unknown;
    try { value = JSON.parse(line); } catch { continue; }
    if (!record(value)) continue;
    if (isKnownNonLoggerLine(value)) { counts.knownNonLoggerLines++; continue; }
    counts.parsed++;
    const unknownKey = Object.keys(value).some(key => !LOG_KEYS.has(key));
    const oversize = Buffer.byteLength(line) > LOG_LINE_MAX_BYTES, guarded = guardLine(line);
    if (unknownKey) counts.unknownKeyLines++;
    if (oversize) counts.oversizeLines++;
    if (!guarded) counts.guardViolations++;
    const event = typeof value.event === "string" && EVENTS.has(value.event as LogEvent) ? value.event : null;
    const level = typeof value.level === "string" && (LOG_LEVELS as readonly string[]).includes(value.level) ? value.level : null;
    if (event) counts.events[event] = (counts.events[event] ?? 0) + 1;
    if (level) counts.levels[level] = (counts.levels[level] ?? 0) + 1;
    if (typeof value.traceId === "string" && TRACE_ID.test(value.traceId)) counts.traceCorrelated++;
    if (event === "log.dropped") counts.droppedLines++;
    if (event === "log.suppressed") counts.suppressedLines++;
    if (event === "log.configuration_invalid") counts.configurationInvalidLines++;
    const header = isTimestamp(value.ts) && level !== null && typeof value.service === "string" && (LOG_SERVICES as readonly string[]).includes(value.service) && event !== null;
    if (header && !unknownKey && !oversize && guarded) counts.conforming++;
  }
  return counts;
}
export function summarizeTraces(reading: Reading<TraceList>): TracesData {
  if (reading.state === "not_configured") off("telemetry backend not configured");
  if (reading.state !== "available" || reading.value === null) return fail("trace backend unavailable");
  const list = reading.value, outcomes = {success: 0, error: 0, unknown: 0};
  for (const trace of list.traces) outcomes[trace.outcome]++;
  const spanCounts = list.traces.map(trace => trace.spanCount);
  return {state: "available", windowStart: list.windowStart, windowEnd: list.windowEnd, traces: list.traces.length,
    withJobId: list.traces.filter(trace => trace.jobId !== null).length, outcomes,
    newestStartedAt: list.traces.map(trace => trace.startedAt).sort().at(-1) ?? null,
    spanCountMin: spanCounts.length ? Math.min(...spanCounts) : null, spanCountMax: spanCounts.length ? Math.max(...spanCounts) : null,
    services: [...TRACE_SERVICES]};
}
export function summarizeMetrics(reading: Reading<RecentMetrics>): MetricsData {
  if (reading.state === "not_configured") off("telemetry backend not configured");
  if (reading.state !== "available" || reading.value === null) return fail("metric backend unavailable");
  const value = reading.value, reliability = value.reliability;
  const codes = new Set<string>();
  for (const row of reliability.failures) for (const code of Object.keys(row.codes)) codes.add(code);
  return {state: "available",
    series: {expected: 4, present: value.series.length, withSamples: value.series.filter(series => series.points.some(point => point[1] !== null)).length},
    reliability: {evaluatedAt: reliability.evaluatedAt, windowSeconds: reliability.windowSeconds, ceilingMs: reliability.ceilingMs,
      latencyOperations: reliability.latency.map(row => row.operation), latencyCapped: reliability.latency.filter(row => row.capped).length,
      failureOperations: reliability.failures.map(row => row.operation), failureCodes: FAILURE_LABELS.filter(code => codes.has(code)),
      providers: reliability.providers.map(row => row.provider)}};
}
export interface PanelRows { workerProviders: unknown; providerCosts: unknown; queued: number; running: number; ready: number; busy: number; draining: number; latestProcesses: number }
/** The panel's own validators decide what is a reading; this records their counts and nothing they could not produce. */
export function summarizeReliabilityPanel(rows: PanelRows): ReliabilityPanelData {
  const circuits = providerHealthReadings(rows.workerProviders), costs = costReadings(rows.providerCosts);
  const states: Record<string, number> = {}, stages: Record<string, number> = {}, providers: Record<string, number> = {};
  for (const entry of circuits.entries) {
    states[entry.state] = (states[entry.state] ?? 0) + 1;
    stages[entry.stage] = (stages[entry.stage] ?? 0) + 1;
    providers[entry.provider] = (providers[entry.provider] ?? 0) + 1;
  }
  // A ratio is never written: the day total and the daily average are both recorded, and their order is stated as a label.
  const comparison = costs.lastDayVsAverage === null ? null
    : costs.totals.dayUsd < costs.dailyAverageUsd ? "below" : costs.totals.dayUsd > costs.dailyAverageUsd ? "above" : "at";
  return {
    circuits: {workers: circuits.workers, entries: circuits.entries.length, dropped: circuits.dropped, truncated: circuits.truncated, states, stages, providers},
    costs: {providers: costs.byProvider.length, totals: {...costs.totals}, dailyAverageUsd: costs.dailyAverageUsd, lastDayVsAverage: comparison, truncated: costs.truncated},
    queue: {queued: rows.queued, running: rows.running},
    workers: {ready: rows.ready, busy: rows.busy, draining: rows.draining, latestProcesses: rows.latestProcesses},
    freshWithinSeconds: FRESH_HEARTBEAT_SECONDS, vantage: PANEL_VANTAGE, httpSurfaceRead: false, httpSurfaceReason: PANEL_HTTP_REASON};
}
/** The 5-minute freshness rule `OperatorDiagnostics` applies, restated over the same two stamps. */
export function backupBlock(status: {state: string; lastSnapshotAt: string | null; lastCompletedAt: string | null; failureStage: string | null}, nowMs: number): BackupCounts {
  const snapshot = status.lastSnapshotAt === null ? NaN : Date.parse(status.lastSnapshotAt);
  const completed = status.lastCompletedAt === null ? NaN : Date.parse(status.lastCompletedAt);
  const fresh = Number.isFinite(snapshot) && Number.isFinite(completed) && completed >= snapshot && completed <= nowMs && snapshot <= nowMs
    && nowMs - snapshot <= BACKUP_FRESH_SECONDS * 1000;
  return {state: status.state, lastSnapshotAt: status.lastSnapshotAt, lastCompletedAt: status.lastCompletedAt,
    ageSeconds: Number.isFinite(snapshot) ? Math.max(0, Math.floor((nowMs - snapshot) / 1000)) : null,
    freshWithin300s: fresh, failureStage: status.failureStage, localRepositoryOnly: true};
}
/** The committed drill record, re-validated; its negatives are carried forward, never restated more strongly. */
export function readDrillRecord(path: string): DrillCounts {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { return fail("off-host drill record unreadable"); }
  if (!record(value) || value.schema !== "hv-offhost-drill/1" || !isTimestamp(value.recordedAt) || !record(value.rpo) || !record(value.encryption))
    return fail("off-host drill record failed shape checks");
  const rpo = value.rpo as Record<string, unknown>, encryption = value.encryption as Record<string, unknown>;
  const data = drillShape({status: "recorded", source: OFFHOST_DRILL_PATH, recordedAt: value.recordedAt, snapshotToCopyMs: rpo.snapshotToCopyMs,
    encryptionExercised: encryption.exercised, provesOffHostRpo: value.provesOffHostRpo, provesHostLossRecovery: value.provesHostLossRecovery,
    restoredIntoLiveDatabase: value.restoredIntoLiveDatabase, independentDestination: value.independentDestination});
  if (!data || data.status !== "recorded") return fail("off-host drill record failed shape checks");
  return {source: data.source, recordedAt: data.recordedAt, snapshotToCopyMs: data.snapshotToCopyMs, encryptionExercised: data.encryptionExercised,
    provesOffHostRpo: false, provesHostLossRecovery: false, restoredIntoLiveDatabase: false, independentDestination: data.independentDestination};
}
/** The committed wave A exit, through that collector's own validator; only three fields are carried over. */
export function readWaveAReference(path: string): WaveAData {
  let value: unknown;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { return fail("wave A evidence unreadable"); }
  let document: ReturnType<typeof validateDocument>;
  try { document = validateDocument(value); } catch { return fail("wave A evidence failed validation"); }
  return {recordedAt: document.recordedAt, releaseSha: document.release.status === "recorded" ? document.release.sha : null, satisfied: document.waveAExit.satisfied};
}
/** The SLI's success predicate, applied to one response. The body's `status` field is deliberately not consulted. */
export function healthPredicate(status: number, elapsedMs: number, body: unknown): boolean {
  const finite = (value: unknown): boolean => typeof value === "number" && Number.isFinite(value);
  return status === 200 && elapsedMs <= AVAILABILITY_TIMEOUT_MS && record(body) && body.service === HEALTH_SERVICE
    && finite(body.queueDepth) && finite(body.runningJobs) && finite(body.monthSpendUsd);
}
export interface BurstInput {
  samples: number; fetchImpl?: FetchLike; origin?: string; now?: () => number;
  sleep?: (ms: number) => Promise<void>; signal?: AbortSignal;
}
/** One request at a time, one per second, each with its own 2 s deadline; counts only, never a ratio. */
export async function availabilityBurst(input: BurstInput): Promise<AvailabilitySample> {
  const samples = input.samples;
  if (!Number.isInteger(samples) || samples < 1 || samples > AVAILABILITY_SAMPLES_MAX) throw new Error("invalid availability sample count");
  const fetchImpl = input.fetchImpl ?? ((url, init) => fetch(url, init)), origin = input.origin ?? HEALTH_ORIGIN;
  const now = input.now ?? Date.now, sleep = input.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const startedAt = now();
  let successes = 0;
  const latencies: number[] = [];
  for (let index = 0; index < samples; index++) {
    if (index > 0) await sleep(AVAILABILITY_INTERVAL_MS);
    if (input.signal?.aborted) break;
    const began = now();
    let status = 0, body: unknown = null;
    try {
      const response = await fetchImpl(origin + "/health", {method: "GET", signal: AbortSignal.timeout(AVAILABILITY_TIMEOUT_MS)});
      status = response.status;
      const text = await response.text();
      try { body = JSON.parse(text); } catch { body = null; }
    } catch { status = 0; }
    const elapsed = Math.max(0, Math.round(now() - began));
    latencies.push(elapsed);
    if (healthPredicate(status, elapsed, body)) successes++;
  }
  const endedAt = now();
  if (latencies.length === 0) return fail("availability sample not taken");
  const sorted = [...latencies].sort((a, b) => a - b);
  return {attempts: latencies.length, successes, predicateFailures: latencies.length - successes,
    p50LatencyMs: sorted[Math.floor((sorted.length - 1) / 2)] ?? null, maxLatencyMs: sorted.at(-1) ?? null,
    startedAt: new Date(startedAt).toISOString(), endedAt: new Date(endedAt).toISOString(), vantage: "loopback on the staging host"};
}

// ---- subprocesses and loopback reads ----
const inherited = (...keys: string[]): Record<string, string> => Object.fromEntries(keys.flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]!]]));
/** `supervisorctl tail -65536 <program> stdout|stderr` for one program; nothing is started, stopped or changed. */
export async function programLogs(run: Runner, program: LogProgram, signal?: AbortSignal): Promise<ProgramLogs> {
  const streams: string[] = [];
  for (const stream of ["stdout", "stderr"] as const) {
    try {
      const result = await run(["supervisorctl", "-c", SUPERVISOR_CONFIG, "tail", "-65536", program, stream], {env: inherited("PATH", "HOME"), signal});
      if (result.exitCode !== 0) return {status: "pending", reason: "log stream unavailable", ...LOG_NULLS};
      streams.push(result.stdout);
    } catch { return {status: "pending", reason: "log stream unavailable", ...LOG_NULLS}; }
  }
  const counts = classifyLogLines(streams);
  if (counts.lines === 0) return {status: "pending", reason: "log stream empty", ...LOG_NULLS};
  return {status: "recorded", ...counts};
}
export async function logsProbe(run: Runner, signal?: AbortSignal): Promise<LogsData> {
  const programs: Record<string, ProgramLogs> = {};
  for (const program of LOG_PROGRAMS) programs[program] = await programLogs(run, program, signal);
  return {window: LOG_WINDOW, programs};
}
/** Three loopback readiness `GET`s; anything other than 200 pends the section rather than being recorded as health. */
export async function readinessProbe(fetchImpl: FetchLike = (url, init) => fetch(url, init), signal?: AbortSignal): Promise<TelemetryRuntimeData["readiness"]> {
  const statuses = {} as TelemetryRuntimeData["readiness"];
  for (const [name, url] of Object.entries(READINESS_ENDPOINTS) as [keyof typeof READINESS_ENDPOINTS, string][]) {
    let status: number;
    try { status = (await fetchImpl(url, {method: "GET", signal: signal ?? AbortSignal.timeout(5000)})).status; }
    catch { return fail("observability endpoint unavailable"); }
    if (status !== 200) return fail("observability endpoint unavailable");
    statuses[name] = status;
  }
  return statuses;
}
export interface TelemetryRuntimeInput { runtime: string; run: Runner; fetchImpl?: FetchLike; signal?: AbortSignal }
export async function telemetryRuntimeProbe(input: TelemetryRuntimeInput): Promise<TelemetryRuntimeData> {
  const settings = readObservabilitySettings(input.runtime);
  const {sourceSha} = readObservabilityRuntime(settings.root);
  const binaries = readObservabilityBinaries(settings.root);
  const states = await supervisorProbe(input.run, input.signal);
  const supervisor = Object.fromEntries(OBSERVABILITY_PROGRAMS.map(name => [name, states[name] ?? "MISSING"]));
  if (OBSERVABILITY_PROGRAMS.some(name => supervisor[name] !== "RUNNING")) return fail("observability service not running");
  return {enabled: true, root: settings.root, sourceSha, binaries, supervisor, readiness: await readinessProbe(input.fetchImpl, input.signal)};
}
/** The same CTE shape `storageDiagnostics` uses, inside the imported read-only transaction; no budget row is read. */
export async function panelRows(tx: SQL): Promise<PanelRows> {
  const [row] = await tx`with latest_workers as (
      select distinct on (body->>'name') heartbeat_at, body->>'state' as state, body->>'name' as name, body->'providers' as providers
      from hv_workers where body->>'name' is not null
      order by body->>'name', heartbeat_at desc, id desc
    ), fresh_providers as (
      select name, providers from latest_workers
      where state in ('idle','busy','draining') and heartbeat_at between now()-interval '45 seconds' and now()
        and providers is not null
      order by heartbeat_at desc, name limit 65
    ), provider_costs as (
      select provider,
        coalesce(sum(total_usd) filter (where created_at >= now()-interval '1 day'),0) as "dayUsd",
        coalesce(sum(total_usd) filter (where created_at >= now()-interval '7 days'),0) as "weekUsd",
        coalesce(sum(total_usd),0) as "monthUsd", count(*)::int as events
      from hv_cost_events where created_at >= now()-interval '30 days'
      group by provider order by 4 desc, provider limit 65
    ) select q.queued, q.running,
      (select coalesce(jsonb_agg(jsonb_build_object('name',name,'providers',providers)),'[]'::jsonb) from fresh_providers) as worker_providers,
      (select coalesce(jsonb_agg(to_jsonb(provider_costs)),'[]'::jsonb) from provider_costs) as provider_costs,
      (select count(*) from latest_workers) as latest,
      (select count(*) from latest_workers where state = 'idle' and heartbeat_at between now()-interval '45 seconds' and now()) as ready,
      (select count(*) from latest_workers where state = 'busy' and heartbeat_at between now()-interval '45 seconds' and now()) as busy,
      (select count(*) from latest_workers where state = 'draining' and heartbeat_at between now()-interval '45 seconds' and now()) as draining
      from public.hv_queue_counts() q`;
  if (!row) return fail("database query failed");
  const count = (value: unknown): number => { const result = Number(value); if (!Number.isSafeInteger(result) || result < 0) return fail("diagnostics reading malformed"); return result; };
  return {workerProviders: row.worker_providers, providerCosts: row.provider_costs, queued: count(row.queued), running: count(row.running),
    ready: count(row.ready), busy: count(row.busy), draining: count(row.draining), latestProcesses: count(row.latest)};
}
export async function backupProbe(path: string, nowMs: number): Promise<BackupBlock> {
  try { return {status: "recorded", ...backupBlock(await readBackupStatus(path), nowMs)}; }
  catch { return {status: "pending", reason: "backup status unreadable", ...BACKUP_NULLS}; }
}
/** The SLI definition plus one bounded loopback burst. The definition is fixed; only the sample block is observed. */
export async function availabilityProbe(input: BurstInput): Promise<AvailabilityData> {
  return {sli: SLI, sample: await availabilityBurst(input), establishesSlo: false, measuredExternally: false, windowDays: null, blockedBy: [...AVAILABILITY_BLOCKED_BY]};
}
export function drillProbe(path: string): DrillBlock {
  try { return {status: "recorded", ...readDrillRecord(path)}; }
  catch (error) { return {status: "pending", reason: error instanceof ProbeFailure && isKnownReason(error.reason) ? error.reason : "off-host drill record unreadable", ...DRILL_NULLS}; }
}

// ---- entry point ----
if (import.meta.main) {
  const {values} = parseArgs({args: process.argv.slice(2), options: {help: {type: "boolean"}, runtime: {type: "string"}, repo: {type: "string"},
    output: {type: "string"}, "availability-samples": {type: "string"}, "require-instrumented": {type: "boolean"}, "timeout-ms": {type: "string"}}, strict: true});
  if (values.help || !values.runtime || !values.repo) {
    console.log("Read-only HV-038 observability exit evidence: --runtime RUNTIME_ROOT --repo CHECKOUT [--output FILE] [--availability-samples 10] [--require-instrumented] [--timeout-ms 120000]\n"
      + "Sources the hv_admin connection only from the environment (set -a; source RUNTIME/storage-backup.env). Opens no secret file and never writes to staging.");
    process.exit(values.help ? 0 : 2);
  }
  const timeoutMs = Number(values["timeout-ms"] ?? "120000"), url = process.env.HV_PG_ADMIN_URL;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000) { console.error("invalid --timeout-ms"); process.exit(2); }
  const samples = Number(values["availability-samples"] ?? String(AVAILABILITY_SAMPLES_DEFAULT));
  if (!Number.isInteger(samples) || samples < 1 || samples > AVAILABILITY_SAMPLES_MAX) { console.error("invalid --availability-samples"); process.exit(2); }
  if (url !== undefined) { let user = ""; try { user = new URL(url).username; } catch {} if (user !== "hv_admin") { console.error("refusing to run: HV_PG_ADMIN_URL must name the hv_admin role"); process.exit(2); } }
  const runtime = resolve(values.runtime), repo = resolve(values.repo);
  let deployment: {value?: ReturnType<typeof readDeployment>; error?: ProbeFailure};
  try { deployment = {value: readDeployment(runtime)}; } catch (error) { deployment = {error: error instanceof ProbeFailure ? error : new ProbeFailure("runtime manifest unavailable" as WaveAReason)}; }
  const need = () => { if (deployment.error) throw deployment.error; return deployment.value!; };
  const reads = await readOnlyReads(url, {panel: panelRows});
  const explorer = new TelemetryExplorer({enabled: true});
  const nowMs = Date.now();
  const probes: Probes = {
    release: () => { const {manifest} = need(); return {sha: manifest.releaseSha, backend: manifest.backend, expectedWorkers: manifest.workers}; },
    telemetryRuntime: ({signal}) => telemetryRuntimeProbe({runtime, run: spawnRunner, signal}),
    traces: async () => { readObservabilitySettings(runtime); return summarizeTraces(await explorer.recentTraces()); },
    metrics: async () => { readObservabilitySettings(runtime); return summarizeMetrics(await explorer.metrics()); },
    logs: ({signal}) => logsProbe(spawnRunner, signal),
    reliabilityPanel: async () => summarizeReliabilityPanel(await reads.panel()),
    recovery: async () => ({backup: await backupProbe(join(need().manifest.backupRepository, "service-status.json"), nowMs),
      offHostDrill: drillProbe(join(repo, OFFHOST_DRILL_PATH)), offHostDestinationConfigured: false, lastLiveRestoreAt: null}),
    availability: ({signal}) => availabilityProbe({samples, signal}),
    waveA: () => readWaveAReference(join(repo, WAVE_A_PATH)),
  };
  let document: ObservabilityExitDocument;
  try { document = await collectObservabilityExit(probes, {runtimeRoot: runtime, bootId: readBootId(runtime), timeoutMs}); }
  finally { explorer.close(); }
  const text = JSON.stringify(document, null, 2) + "\n";
  if (values.output) writeAtomically(resolve(values.output), text);
  process.stdout.write(text);
  if (values["require-instrumented"] && !document.observabilityExit.instrumented) process.exitCode = 1;
}
