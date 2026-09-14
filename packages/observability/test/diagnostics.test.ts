import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperatorDiagnostics, readBackupStatus, providerHealthReadings, costReadings, type DatabaseStatus, type BackupStatus } from "../src/diagnostics";
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

const entry = (change: Record<string, unknown> = {}) => ({stage: "final", provider: "mock", id: "mock", state: "closed",
  consecutiveFailures: 0, samples: 4, latencyMs: 120, lastOutcome: "success", observedAt: new Date(0).toISOString(), ...change});

test("worker-authored circuit rows are validated entry by entry, dropping and counting what cannot be trusted", () => {
  const good = providerHealthReadings([{name: "worker-one", providers: [entry(), entry({stage: "animatic", provider: "other", id: null, state: "open", consecutiveFailures: 3, lastOutcome: "error"})]}]);
  expect(good).toMatchObject({workers: 1, dropped: 0});
  expect(good.entries).toHaveLength(2); expect(good.entries[0]!.worker).toBe("worker-one");
  const malformed = providerHealthReadings([{name: "worker-two", providers: [entry({state: "melted"}), entry({consecutiveFailures: -1}),
    entry({id: "https://vendor.invalid/model"}), entry({id: "x".repeat(81)}), entry({provider: "vendor"}), entry({observedAt: "yesterday"}),
    entry({latencyMs: -5}), entry({lastOutcome: "maybe"}), entry()]}]);
  expect(malformed).toMatchObject({workers: 1, dropped: 8}); expect(malformed.entries).toHaveLength(1);
  const capped = providerHealthReadings([{name: "worker-three", providers: Array.from({length: 25}, () => entry())}]);
  expect(capped.entries).toHaveLength(24); expect(capped.dropped).toBe(1);
  const many = providerHealthReadings(Array.from({length: 65}, (_, index) => ({name: "worker-" + index, providers: [entry()]})));
  expect(many.workers).toBe(64); expect(many.entries).toHaveLength(64); expect(many.dropped).toBe(1);
  for (const bad of [null, undefined, "rows", [null], [{name: "worker-four"}], [{name: "a".repeat(81), providers: [entry()]}], [{providers: [entry()]}]])
    expect(() => providerHealthReadings(bad)).not.toThrow();
  expect(providerHealthReadings([{name: "a".repeat(81), providers: [entry()]}])).toEqual({workers: 0, entries: [], dropped: 1});
  expect(providerHealthReadings("rows")).toEqual({workers: 0, entries: [], dropped: 0});
});

test("cost windows fold unnamed and surplus providers, reject unusable money, and state the trend honestly", () => {
  const rows = Array.from({length: 17}, (_, index) => ({provider: "p" + String(17 - index).padStart(2, "0"), dayUsd: 1, weekUsd: 2, monthUsd: 30 - index, events: 1}));
  const folded = costReadings([...rows, {provider: "SHOUTING", dayUsd: 1, weekUsd: 1, monthUsd: 1, events: 2}]);
  expect(folded.byProvider.filter(row => row.provider !== "other")).toHaveLength(16);
  expect(folded.byProvider.find(row => row.provider === "other")).toEqual({provider: "other", dayUsd: 2, weekUsd: 3, monthUsd: 15, events: 3});
  expect(folded.totals.monthUsd).toBe(rows.reduce((sum, row) => sum + row.monthUsd, 0) + 1);
  expect(folded.dailyAverageUsd).toBeCloseTo(folded.totals.monthUsd / 30, 9);
  expect(folded.lastDayVsAverage).toBeCloseTo(folded.totals.dayUsd / folded.dailyAverageUsd, 9);
  const dropped = costReadings([{provider: "mock", dayUsd: -1, weekUsd: 1, monthUsd: 1, events: 1}, {provider: "mock", dayUsd: 1, weekUsd: Number.NaN, monthUsd: 1, events: 1},
    {provider: "mock", dayUsd: 1, weekUsd: 1, monthUsd: "many", events: 1}, {provider: "mock", dayUsd: 0, weekUsd: 0, monthUsd: 0, events: "lots"}]);
  expect(dropped.byProvider).toEqual([{provider: "mock", dayUsd: 0, weekUsd: 0, monthUsd: 0, events: null}]);
  expect(dropped.lastDayVsAverage).toBeNull(); expect(dropped.dailyAverageUsd).toBe(0);
  expect(costReadings([])).toEqual({byProvider: [], totals: {dayUsd: 0, weekUsd: 0, monthUsd: 0}, dailyAverageUsd: 0, lastDayVsAverage: null});
});

test("provider health and cost observations follow the database probe without adding a probe of their own", async () => {
  let now = Date.now(), fail = false, calls = 0;
  const providers = {workers: 1, entries: [{...entry(), worker: "worker-one"}], dropped: 0} as any;
  const costs = costReadings([{provider: "mock", dayUsd: 1, weekUsd: 2, monthUsd: 3, events: 4}]);
  const monitor = new OperatorDiagnostics({telemetry: quiet(), backend: "postgres", expectedWorkers: 3, cacheMs: 0, now: () => now,
    database: async () => {calls++; if (fail) throw new Error("secret-database-url"); return {...sample(), providers, costs};},
    objects: async () => true, backup: async () => backup(now)});
  const good = await monitor.snapshot();
  expect(good.providerHealth).toEqual({state: "available", observedAt: good.database.observedAt, value: providers});
  expect(good.costs).toEqual({state: "available", observedAt: good.database.observedAt, value: costs});
  expect(calls).toBe(1);
  fail = true; now += 60_000;
  const stale = await monitor.snapshot();
  expect(stale.providerHealth).toEqual({state: "unavailable", observedAt: good.database.observedAt, value: providers});
  expect(stale.costs.state).toBe("unavailable"); expect(stale.costs.observedAt).toBe(good.database.observedAt);
  expect(stale.status).toBe("degraded"); expect(calls).toBe(2);
  const json = await new OperatorDiagnostics({telemetry: quiet(), backend: "json", expectedWorkers: 1, now: () => now,
    database: async () => ({...sample(), providers: null, costs})}).snapshot();
  expect(json.providerHealth).toEqual({state: "not_configured", observedAt: null, value: null});
  expect(json.costs).toEqual({state: "available", observedAt: json.database.observedAt, value: costs});
});
