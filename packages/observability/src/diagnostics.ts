import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import type { StudioTelemetry } from "./index";
import { PROVIDER_KINDS, type ProviderKind } from "./provider-kinds";

export interface ProviderHealthEntry {
  worker: string; stage: "animatic" | "final" | "character-sheet"; provider: ProviderKind; id: string | null;
  state: "unknown" | "closed" | "open" | "half-open"; consecutiveFailures: number; samples: number;
  latencyMs: number | null; lastOutcome: "success" | "error" | null; observedAt: string | null;
}
/** `dropped` counts entries that failed validation; `truncated` says the fleet was larger than this reading can show. */
export interface ProviderHealthStatus {workers: number; entries: ProviderHealthEntry[]; dropped: number; truncated: boolean}
export interface CostEntry {provider: string; dayUsd: number; weekUsd: number; monthUsd: number; events: number | null}
export interface CostStatus {byProvider: CostEntry[]; totals: {dayUsd: number; weekUsd: number; monthUsd: number}; dailyAverageUsd: number; lastDayVsAverage: number | null; truncated: boolean}
export interface DatabaseStatus {
  queue: {queued: number; running: number};
  workers: {ready: number; busy: number; draining: number; latestProcesses: number} | null;
  budget: {recordedMonthUsd: number; reservedUsd: number; monthlyCapUsd: number};
  /** Per-process circuit state republished by each fresh worker heartbeat; absent on backends without a worker registry. */
  providers?: ProviderHealthStatus | null;
  costs?: CostStatus | null;
}
export interface BackupStatus {
  state: "running" | "healthy" | "degraded" | "failed";
  lastSnapshotAt: string | null; lastCompletedAt: string | null; lastRecordedCostUsd: number | null;
  objects: number | null; failureStage: "backup" | "retention" | null; localRepositoryOnly: true;
}
interface Observation<T> {state: "available" | "unavailable" | "not_configured"; observedAt: string | null; value: T | null}
export interface DiagnosticsOptions {
  database: () => Promise<DatabaseStatus>;
  objects?: () => Promise<boolean>;
  backup?: () => Promise<BackupStatus>;
  telemetry: StudioTelemetry;
  backend: "json" | "postgres";
  expectedWorkers: number;
  now?: () => number;
  timeoutMs?: number;
  cacheMs?: number;
  close?: () => Promise<void>;
}

/** One pending request per dependency, even when it hangs beyond the response deadline. */
class Probe<T> {
  private pending?: Promise<boolean>;
  private last: {observedAt: string; value: T} | null = null;
  constructor(private readonly operation: (() => Promise<T>) | undefined, private readonly now: () => number) {}
  async read(timeoutMs: number): Promise<Observation<T>> {
    if (!this.operation) return {state: "not_configured", observedAt: null, value: null};
    if (!this.pending) this.pending = Promise.resolve().then(this.operation).then(value => {
      this.last = {value, observedAt: new Date(this.now()).toISOString()}; return true;
    }, () => false).finally(() => { this.pending = undefined; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const available = await Promise.race([this.pending, new Promise<false>(resolve => {timer = setTimeout(() => resolve(false), timeoutMs);})]);
      return {state: available ? "available" : "unavailable", observedAt: this.last?.observedAt ?? null, value: this.last?.value ?? null};
    } finally {clearTimeout(timer);}
  }
}

function finite(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e12 ? value : null;
}
function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) || !Number.isFinite(Date.parse(value))) return null;
  return new Date(value).toISOString() === value ? value : null;
}

const WORKER_NAME = /^[A-Za-z0-9_.:-]{1,80}$/, POOL_ID = /^[A-Za-z0-9_.:/-]{1,80}$/, PROVIDER_NAME = /^[a-z0-9][a-z0-9._:-]{0,39}$/;
const STAGES = ["animatic", "final", "character-sheet"], KINDS: readonly string[] = PROVIDER_KINDS, CIRCUITS = ["unknown", "closed", "open", "half-open"];
/** The array this module actually validates against, so a test can assert it is the one definition and not a copy. */
export function diagnosticsProviderKinds(): readonly string[] {return KINDS;}
function healthEntry(worker: string, value: unknown): ProviderHealthEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const count = (input: unknown) => Number.isSafeInteger(input) && (input as number) >= 0 ? input as number : null;
  const failures = count(row.consecutiveFailures), samples = count(row.samples);
  if (!STAGES.includes(row.stage as string) || !KINDS.includes(row.provider as string) || !CIRCUITS.includes(row.state as string)
    || failures === null || samples === null) return null;
  if (row.id !== null && (typeof row.id !== "string" || !POOL_ID.test(row.id) || row.id.includes("://"))) return null;
  if (row.lastOutcome !== null && !["success", "error"].includes(row.lastOutcome as string)) return null;
  if (row.latencyMs !== null && finite(row.latencyMs) === null) return null;
  if (row.observedAt !== null && timestamp(row.observedAt) === null) return null;
  return {worker, stage: row.stage as ProviderHealthEntry["stage"], provider: row.provider as ProviderHealthEntry["provider"],
    id: row.id as string | null, state: row.state as ProviderHealthEntry["state"], consecutiveFailures: failures, samples,
    latencyMs: row.latencyMs === null ? null : finite(row.latencyMs), lastOutcome: row.lastOutcome as ProviderHealthEntry["lastOutcome"],
    observedAt: row.observedAt === null ? null : timestamp(row.observedAt)};
}
/** Worker-authored JSON: every entry is checked against the closed sets, and a malformed one is counted, not blanked. */
export function providerHealthReadings(value: unknown): ProviderHealthStatus {
  const source = Array.isArray(value) ? value : [];
  const entries: ProviderHealthEntry[] = [];
  let workers = 0, dropped = 0;
  for (const item of source.slice(0, 64)) {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    if (typeof row.name !== "string" || !WORKER_NAME.test(row.name) || !Array.isArray(row.providers)) {dropped++; continue;}
    workers++; dropped += Math.max(0, row.providers.length - 24);
    for (const entry of row.providers.slice(0, 24)) {
      const reading = healthEntry(row.name, entry);
      if (reading) entries.push(reading); else dropped++;
    }
  }
  return {workers, entries, dropped, truncated: source.length > 64};
}
/** Rows arrive sorted by 30-day spend: the first 16 usable provider names stay named, the rest fold into `other`. */
export function costReadings(value: unknown): CostStatus {
  const rows = new Map<string, CostEntry>();
  const source = Array.isArray(value) ? value : [];
  let named = 0;
  for (const item of source.slice(0, 64)) {
    const row = item && typeof item === "object" && !Array.isArray(item) ? item as Record<string, unknown> : {};
    const money = (input: unknown) => input === null || input === undefined ? null : finite(typeof input === "string" ? Number(input) : input);
    const day = money(row.dayUsd), week = money(row.weekUsd), month = money(row.monthUsd);
    const events = Number.isSafeInteger(row.events) && (row.events as number) >= 0 ? row.events as number : null;
    if (day === null || week === null || month === null) continue;
    const name = typeof row.provider === "string" && PROVIDER_NAME.test(row.provider) ? row.provider : null;
    const key = name && (rows.has(name) || named < 16) ? name : "other";
    if (name && key === name && !rows.has(name)) named++;
    const bucket = rows.get(key) ?? {provider: key, dayUsd: 0, weekUsd: 0, monthUsd: 0, events: null};
    bucket.dayUsd += day; bucket.weekUsd += week; bucket.monthUsd += month;
    if (events !== null) bucket.events = (bucket.events ?? 0) + events;
    rows.set(key, bucket);
  }
  const byProvider = [...rows.values()].sort((a, b) => b.monthUsd - a.monthUsd || a.provider.localeCompare(b.provider));
  const totals = {dayUsd: 0, weekUsd: 0, monthUsd: 0};
  for (const row of byProvider) {totals.dayUsd += row.dayUsd; totals.weekUsd += row.weekUsd; totals.monthUsd += row.monthUsd;}
  const dailyAverageUsd = totals.monthUsd / 30;
  return {byProvider, totals, dailyAverageUsd, lastDayVsAverage: dailyAverageUsd > 0 ? totals.dayUsd / dailyAverageUsd : null, truncated: source.length > 64};
}

/** Read only the bounded public fields of the private scheduler status file. */
export async function readBackupStatus(path: string): Promise<BackupStatus> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 8192) throw new Error("invalid backup status");
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > 8192) throw new Error("invalid backup status");
    const bytes = Buffer.alloc(8193), result = await file.read(bytes, 0, bytes.length, 0);
    if (result.bytesRead > 8192) throw new Error("invalid backup status");
    const value = JSON.parse(bytes.subarray(0, result.bytesRead).toString());
    if (value.schema !== "hv-backup-service/1" || !["running", "healthy", "degraded", "failed"].includes(value.state)
      || value.localRepositoryOnly !== true) throw new Error("invalid backup status");
    return {state: value.state, lastSnapshotAt: timestamp(value.lastSnapshotAt), lastCompletedAt: timestamp(value.lastCompletedAt),
      lastRecordedCostUsd: finite(value.lastRecordedCostUsd), objects: Number.isSafeInteger(value.objects) ? finite(value.objects) : null,
      failureStage: ["backup", "retention"].includes(value.failureStage) ? value.failureStage : null, localRepositoryOnly: true};
  } finally {await file.close();}
}

export class OperatorDiagnostics {
  private readonly database: Probe<DatabaseStatus>;
  private readonly objects: Probe<boolean>;
  private readonly backup: Probe<BackupStatus>;
  private readonly now: () => number;
  private cached?: {at: number; value: Awaited<ReturnType<OperatorDiagnostics["collect"]>>};
  private pending?: Promise<Awaited<ReturnType<OperatorDiagnostics["collect"]>>>;
  constructor(private readonly options: DiagnosticsOptions) {
    this.now = options.now ?? Date.now;
    if (!Number.isInteger(options.expectedWorkers) || options.expectedWorkers < 1 || options.expectedWorkers > 64) throw new Error("invalid expected worker count");
    this.database = new Probe(options.database, this.now);
    this.objects = new Probe(options.objects, this.now);
    this.backup = new Probe(options.backup, this.now);
  }
  private async collect() {
    const timeout = Math.max(10, Math.min(2000, this.options.timeoutMs ?? 1500));
    const [database, objects, backup] = await Promise.all([this.database.read(timeout), this.objects.read(timeout), this.backup.read(timeout)]);
    const now = this.now(), data = database.value;
    const snapshotTime = backup.value?.lastSnapshotAt ? Date.parse(backup.value.lastSnapshotAt) : NaN;
    const completedTime = backup.value?.lastCompletedAt ? Date.parse(backup.value.lastCompletedAt) : NaN;
    const backupFresh = backup.state === "available" && Number.isFinite(snapshotTime) && Number.isFinite(completedTime)
      && completedTime >= snapshotTime && completedTime <= now && snapshotTime <= now && now - snapshotTime <= 300_000;
    const workersHealthy = database.state === "available" && data?.workers !== null && data?.workers !== undefined
      && data.workers.ready + data.workers.busy >= this.options.expectedWorkers;
    const budgetAvailableUsd = data ? Math.max(0, data.budget.monthlyCapUsd - data.budget.recordedMonthUsd - data.budget.reservedUsd) : null;
    const status = database.state === "available" && objects.state === "available" && objects.value === true && workersHealthy
      && backupFresh && ["running", "healthy"].includes(backup.value!.state) && budgetAvailableUsd !== null && budgetAvailableUsd > 0 ? "healthy" : "degraded";
    // Both are views of the one database probe: no extra probe, no extra pending slot, and the same retained observedAt.
    // A backend with no worker registry reports no circuits at all: `not_configured` never carries a value.
    const registry = this.options.backend !== "json";
    const providerHealth: Observation<ProviderHealthStatus> = {state: registry ? database.state : "not_configured",
      observedAt: registry ? database.observedAt : null, value: registry ? data?.providers ?? null : null};
    const costs: Observation<CostStatus> = {state: database.state, observedAt: database.observedAt, value: data?.costs ?? null};
    return {schema: "hv-operator-status/1" as const, status, checkedAt: new Date(now).toISOString(), backend: this.options.backend,
      database, objects, providerHealth, costs, workers: {healthy: workersHealthy, expected: this.options.expectedWorkers},
      budget: {availableUsd: budgetAvailableUsd, current: database.state === "available", invoiceReconciled: false},
      backup: {...backup, fresh: backupFresh, ageSeconds: Number.isFinite(snapshotTime) ? Math.max(0, Math.floor((now - snapshotTime) / 1000)) : null},
      telemetry: {enabled: this.options.telemetry.enabled, ...this.options.telemetry.status}};
  }
  async snapshot() {
    const cacheMs = Math.max(0, Math.min(5000, this.options.cacheMs ?? 2000));
    if (this.cached && this.now() - this.cached.at < cacheMs) return this.cached.value;
    if (!this.pending) this.pending = this.collect().then(value => {this.cached = {at: this.now(), value}; return value;}).finally(() => {this.pending = undefined;});
    return this.pending;
  }
  async close(): Promise<void> {await this.options.close?.();}
}
