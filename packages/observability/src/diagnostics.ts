import { constants } from "node:fs";
import { open, lstat } from "node:fs/promises";
import type { StudioTelemetry } from "./index";

export interface DatabaseStatus {
  queue: {queued: number; running: number};
  workers: {ready: number; busy: number; draining: number; latestProcesses: number} | null;
  budget: {recordedMonthUsd: number; reservedUsd: number; monthlyCapUsd: number};
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
    return {schema: "hv-operator-status/1" as const, status, checkedAt: new Date(now).toISOString(), backend: this.options.backend,
      database, objects, workers: {healthy: workersHealthy, expected: this.options.expectedWorkers},
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
