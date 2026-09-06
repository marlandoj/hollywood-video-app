import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperatorDiagnostics, readBackupStatus, type DatabaseStatus, type BackupStatus } from "../src/diagnostics";
import { StudioTelemetry } from "../src/index";

const quiet = () => new StudioTelemetry({service: "api", enabled: false});
const sample = (): DatabaseStatus => ({queue: {queued: 2, running: 1}, workers: {ready: 2, busy: 1, draining: 0, latestProcesses: 3},
  budget: {recordedMonthUsd: .144, reservedUsd: 7, monthlyCapUsd: 500}});
const backup = (now: number): BackupStatus => ({state: "healthy", lastSnapshotAt: new Date(now - 30_000).toISOString(),
  lastCompletedAt: new Date(now - 20_000).toISOString(), lastRecordedCostUsd: .144, objects: 601, failureStage: null, localRepositoryOnly: true});

test("dependency failure preserves prior spending and reservations without presenting them as current", async () => {
  let now = Date.now(), fail = false;
  const monitor = new OperatorDiagnostics({telemetry: quiet(), backend: "postgres", expectedWorkers: 3, cacheMs: 0, now: () => now,
    database: async () => {if (fail) throw new Error("secret-database-url"); return sample();}, objects: async () => !fail,
    backup: async () => {if (fail) throw new Error("private-backup-path"); return backup(now);}});
  const good = await monitor.snapshot();
  expect(good.status).toBe("healthy"); expect(good.budget.availableUsd).toBeCloseTo(492.856, 6); expect(good.budget.invoiceReconciled).toBe(false);
  fail = true; now += 60_000;
  const bad = await monitor.snapshot();
  expect(bad.status).toBe("degraded"); expect(bad.database.state).toBe("unavailable"); expect(bad.budget.current).toBe(false);
  expect(bad.database.observedAt).toBe(good.database.observedAt); expect(bad.database.value?.budget).toEqual(sample().budget);
  expect(bad.backup.value?.lastRecordedCostUsd).toBe(.144); expect(bad.backup.fresh).toBe(false);
  expect(JSON.stringify(bad)).not.toContain("secret-database"); expect(JSON.stringify(bad)).not.toContain("private-backup");
  fail = false;
  expect((await monitor.snapshot()).status).toBe("healthy");
});

test("stale, future, failed and missing backups cannot produce a healthy status", async () => {
  const now = Date.now(); let value = backup(now);
  const monitor = new OperatorDiagnostics({telemetry: quiet(), backend: "postgres", expectedWorkers: 3, cacheMs: 0, now: () => now,
    database: async () => sample(), objects: async () => true, backup: async () => value});
  for (const change of [{lastSnapshotAt: new Date(now - 301_000).toISOString()}, {lastSnapshotAt: new Date(now + 1000).toISOString()},
    {lastCompletedAt: null}, {state: "failed" as const}, {state: "degraded" as const}]) {
    value = {...backup(now), ...change}; expect((await monitor.snapshot()).status).toBe("degraded");
  }
  value = {...backup(now), state: "running"}; expect((await monitor.snapshot()).status).toBe("healthy");
  const unknown = await new OperatorDiagnostics({telemetry: quiet(), backend: "json", expectedWorkers: 1, database: async () => {throw new Error("offline");}}).snapshot();
  expect(unknown.database.value).toBeNull(); expect(unknown.budget.availableUsd).toBeNull(); expect(unknown.status).toBe("degraded");
  expect(unknown.backup.state).toBe("not_configured");
});

test("draining workers and exhausted capacity are actionable even when dependencies respond", async () => {
  const now = Date.now(); let value = sample();
  const monitor = new OperatorDiagnostics({telemetry: quiet(), backend: "postgres", expectedWorkers: 3, cacheMs: 0,
    database: async () => value, objects: async () => true, backup: async () => backup(now)});
  value.workers = {ready: 1, busy: 1, draining: 1, latestProcesses: 3};
  expect((await monitor.snapshot()).workers.healthy).toBe(false);
  value = sample(); value.budget.reservedUsd = 500;
  const result = await monitor.snapshot(); expect(result.status).toBe("degraded"); expect(result.budget.availableUsd).toBe(0);
});

test("hung probes have bounded concurrency and do not prevent other probes or later recovery", async () => {
  let databaseCalls = 0, objectCalls = 0, finish!: (value: DatabaseStatus) => void;
  const pending = new Promise<DatabaseStatus>(resolve => {finish = resolve;});
  const monitor = new OperatorDiagnostics({telemetry: quiet(), backend: "postgres", expectedWorkers: 3, cacheMs: 0, timeoutMs: 20,
    database: () => {databaseCalls++; return pending;}, objects: async () => {objectCalls++; return true;}});
  const started = performance.now();
  const values = await Promise.all(Array.from({length: 40}, () => monitor.snapshot()));
  expect(values.every(value => value.database.state === "unavailable")).toBe(true); expect(databaseCalls).toBe(1); expect(objectCalls).toBe(1);
  expect(performance.now() - started).toBeLessThan(500);
  await monitor.snapshot(); expect(databaseCalls).toBe(1); expect(objectCalls).toBe(2);
  finish(sample()); await Bun.sleep(1);
  const recovered = await monitor.snapshot(); expect(recovered.database.state).toBe("available"); expect(recovered.database.value?.budget.recordedMonthUsd).toBe(.144);
});

test("backup status reading excludes raw fields and refuses oversized files, directories and symlinks", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hv-backup-observation-")), file = join(directory, "status.json");
  try {
    const value = {...backup(Date.now()), schema: "hv-backup-service/1", privatePath: "secret-root", error: "secret-provider-key"};
    writeFileSync(file, JSON.stringify(value));
    const read = await readBackupStatus(file); expect(read.objects).toBe(601); expect(JSON.stringify(read)).not.toContain("secret-");
    writeFileSync(file, JSON.stringify({...value, objects: -1, lastRecordedCostUsd: "0.144", lastSnapshotAt: "not-a-time"}));
    const invalid = await readBackupStatus(file); expect(invalid.objects).toBeNull(); expect(invalid.lastRecordedCostUsd).toBeNull(); expect(invalid.lastSnapshotAt).toBeNull();
    writeFileSync(file, "x".repeat(8193)); await expect(readBackupStatus(file)).rejects.toThrow("invalid backup status");
    mkdirSync(join(directory, "folder")); await expect(readBackupStatus(join(directory, "folder"))).rejects.toThrow("invalid backup status");
    if (process.platform !== "win32") {
      symlinkSync(file, join(directory, "link")); await expect(readBackupStatus(join(directory, "link"))).rejects.toThrow("invalid backup status");
    }
  } finally {rmSync(directory, {recursive: true, force: true});}
});
