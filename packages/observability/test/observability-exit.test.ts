import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { FAILURE_CODES, OPERATION_NAMES, PROVIDER_KINDS } from "../src/index";
import { costReadings, providerHealthReadings } from "../src/diagnostics";
import type { Reading, RecentMetrics, TraceList } from "../src/explorer";
import {
  AVAILABILITY_BLOCKED_BY, AVAILABILITY_SAMPLES_MAX, BLOCKS, CIRCUIT_STAGES, CIRCUIT_STATES, LOG_PROGRAMS, LOG_WINDOW, OBSERVABILITY_PROGRAMS,
  OFFHOST_DRILL_PATH, PANEL_HTTP_REASON, PANEL_VANTAGE, REASONS, SCHEMA, SECTIONS, SLI, TRACE_SERVICES, WAVE_A_PATH,
  availabilityBurst, availabilityProbe, backupBlock, classifyLogLines, collectObservabilityExit, deriveObservabilityExit, drillProbe,
  healthPredicate, isKnownReason, programLogs, readDrillRecord, readObservabilityBinaries, readObservabilityRuntime, readObservabilitySettings,
  NotConfigured, readWaveAReference, summarizeMetrics, summarizeReliabilityPanel, summarizeTraces, telemetryRuntimeProbe, validateExitDocument,
  type Block, type BlockData, type ObservabilityExit, type ObservabilityExitDocument, type PanelRows, type Probes,
} from "../../../scripts/observability-exit-evidence";
import type { Runner } from "../../../scripts/storage-wave-a-evidence";

// Guard for HV-038-04: the observability exit evidence is observed or pending, never typed in, and carries no identifier,
// no secret and no availability figure. Every case is offline: no host, no network, no database.
const repo = resolve(import.meta.dir, "../../..");
const evidencePath = join(repo, "docs/evidence/hv038-observability/observability-exit.json");
const docPath = join(repo, "docs/OBSERVABILITY.md");
const SHA = "0caa202" + "f".repeat(33), NOW = Date.parse("2026-09-14T18:00:00.000Z");
const TRACE = "a".repeat(32), SPAN = "b".repeat(16);
const RUNNING = Object.fromEntries(OBSERVABILITY_PROGRAMS.map(name => [name, "RUNNING"]));
const temporary: string[] = [];
const scratch = (): string => { const dir = mkdtempSync(join(tmpdir(), "hv-observability-exit-")); temporary.push(dir); return dir; };
afterAll(() => { for (const dir of temporary) rmSync(dir, {recursive: true, force: true}); });

const healthyLogCounts = () => ({lines: 12, parsed: 10, conforming: 10, events: {"api.request": 8, "op.finished": 2}, levels: {info: 10},
  traceCorrelated: 10, unknownKeyLines: 0, oversizeLines: 0, guardViolations: 0, droppedLines: 0, suppressedLines: 0,
  configurationInvalidLines: 0, knownNonLoggerLines: 2, partialLinesDiscarded: 1});
const healthy = (): Probes => ({
  release: () => ({sha: SHA, backend: "postgres", expectedWorkers: 3}),
  telemetryRuntime: () => ({enabled: true, root: "/home/workspace/.runtime/rough-cut-observability", sourceSha: SHA,
    binaries: {jaeger: "2.20.0", collector: "0.160.0", prometheus: "3.14.0"}, supervisor: {...RUNNING}, readiness: {collector: 200, traces: 200, metrics: 200}}),
  traces: () => ({state: "available", windowStart: "2026-09-13T18:00:00.000Z", windowEnd: "2026-09-14T18:00:00.000Z", traces: 3, withJobId: 3,
    outcomes: {success: 2, error: 1, unknown: 0}, newestStartedAt: "2026-09-14T17:55:00.000Z", spanCountMin: 4, spanCountMax: 9, services: [...TRACE_SERVICES]}),
  metrics: () => ({state: "available", series: {expected: 4, present: 4, withSamples: 3},
    reliability: {evaluatedAt: "2026-09-14T18:00:00.000Z", windowSeconds: 300, ceilingMs: 600_000, latencyOperations: ["http.request", "job.process"],
      latencyCapped: 0, failureOperations: ["job.process"], failureCodes: ["provider", "unknown"], providers: ["mock"]}}),
  logs: () => ({window: LOG_WINDOW, programs: Object.fromEntries(LOG_PROGRAMS.map(program => [program, {status: "recorded", ...healthyLogCounts()}]))}),
  reliabilityPanel: () => ({circuits: {workers: 3, entries: 3, dropped: 0, truncated: false, states: {closed: 3}, stages: {animatic: 2, final: 1}, providers: {mock: 3}},
    costs: {providers: 1, totals: {dayUsd: 0, weekUsd: 0, monthUsd: 0.144}, dailyAverageUsd: 0.0048, lastDayVsAverage: "below", truncated: false},
    queue: {queued: 0, running: 0}, workers: {ready: 3, busy: 0, draining: 0, latestProcesses: 3},
    freshWithinSeconds: 45, vantage: PANEL_VANTAGE, httpSurfaceRead: false, httpSurfaceReason: PANEL_HTTP_REASON}),
  recovery: () => ({backup: {status: "recorded", state: "healthy", lastSnapshotAt: "2026-09-14T17:58:00.000Z", lastCompletedAt: "2026-09-14T17:58:10.000Z",
      ageSeconds: 120, freshWithin300s: true, failureStage: null, localRepositoryOnly: true},
    offHostDrill: {status: "recorded", source: OFFHOST_DRILL_PATH, recordedAt: "2026-09-14T23:09:27.940Z", snapshotToCopyMs: 72, encryptionExercised: true,
      continuousReplication: false, provesOffHostRpo: false, provesHostLossRecovery: false, restoredIntoLiveDatabase: false,
      independentDestination: "none (same filesystem, temp directory)"},
    offHostDestinationConfigured: false, lastLiveRestoreAt: null}),
  availability: () => ({sli: SLI, sample: {attempts: 10, successes: 10, predicateFailures: 0, p50LatencyMs: 3, maxLatencyMs: 11,
      startedAt: "2026-09-14T17:59:50.000Z", endedAt: "2026-09-14T17:59:59.000Z", vantage: "loopback on the staging host"},
    establishesSlo: false, measuredExternally: false, windowDays: null, blockedBy: [...AVAILABILITY_BLOCKED_BY]}),
  waveA: () => ({recordedAt: "2026-09-14T19:25:34.370Z", releaseSha: SHA, satisfied: true}),
} as Probes);
const options = {runtimeRoot: "/home/workspace/.runtime/rough-cut-staging-6d439a3", bootId: "3f2504e0-4f89-11d3-9a0c-0305e82c3301", now: () => NOW, timeoutMs: 2000};
const EXIT_BOOLEAN: Partial<Record<Block, keyof ObservabilityExit>> = {traces: "tracesQueryable", metrics: "metricsQueryable",
  logs: "structuredLogsConforming", reliabilityPanel: "reliabilityPanelReadable", recovery: "backupFresh"};

const runner = (handle: (command: string[]) => {exitCode?: number; stdout?: string} | Error): Runner => async command => {
  const answer = handle(command);
  if (answer instanceof Error) throw answer;
  return {exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? "", stderr: ""};
};
const supervisorStatus = (states: Record<string, string> = RUNNING): string =>
  Object.entries(states).map(([name, state]) => `${name}${" ".repeat(Math.max(1, 38 - name.length))}${state}   pid 100, uptime 1:00:00`).join("\n") + "\n";
const ready = async () => new Response("{}", {status: 200});

/** A runtime root plus an observability root shaped like the staging host. */
function observabilityFixture(overrides: {settings?: Record<string, unknown>; runtime?: Record<string, unknown>; binaries?: Record<string, unknown>; noRoot?: boolean; noSettings?: boolean} = {}):
  {runtime: string; root: string} {
  const base = scratch(), runtime = join(base, "runtime"), root = join(base, "observability");
  mkdirSync(runtime, {recursive: true});
  if (!overrides.noRoot) mkdirSync(root, {recursive: true});
  if (!overrides.noSettings) writeFileSync(join(runtime, "observability.json"),
    JSON.stringify({schema: "hv-observability-settings/1", enabled: true, root, ...overrides.settings}), {mode: 0o600});
  if (!overrides.noRoot) {
    writeFileSync(join(root, "runtime.json"), JSON.stringify({schema: "hv-observability-runtime/1", sourceSha: SHA,
      configSha256: {jaeger: "0".repeat(64), collector: "0".repeat(64), prometheus: "0".repeat(64)}, launcherSha256: "0".repeat(64), ...overrides.runtime}));
    writeFileSync(join(root, "binaries.json"), JSON.stringify({schema: "hv-observability-binaries/1", root,
      releases: [{name: "jaeger", version: "2.20.0", binaries: {}}, {name: "otelcol-contrib", version: "0.160.0", binaries: {}},
        {name: "prometheus", version: "3.14.0", binaries: {}}], ...overrides.binaries}));
  }
  return {runtime, root};
}
/** The collector's fixed prose -- the SLI, the blocked-by list and the panel's vantage -- legitimately names a diagnostics
 * token and a secret file it does not open. It is a compile-time constant, not probe output, so it is stripped before the
 * leak patterns run over everything a probe actually contributed. */
const FIXED_PROSE: string[] = [...Object.values(SLI), ...AVAILABILITY_BLOCKED_BY, PANEL_VANTAGE, PANEL_HTTP_REASON];
const withoutFixedProse = (text: string): string => FIXED_PROSE.reduce((accumulated, phrase) => accumulated.replaceAll(phrase, ""), text);
const reasonOf = async (fn: () => unknown): Promise<string> => {
  try { await fn(); return "no error"; } catch (error) { return (error as {reason?: string}).reason ?? "not a probe failure"; }
};

test("(a) every probe healthy: eight recorded sections plus the wave A block, instrumented, and no claim", async () => {
  const document = await collectObservabilityExit(healthy(), options);
  expect(document.schema).toBe(SCHEMA);
  expect(document.recordedAt).toBe("2026-09-14T18:00:00.000Z");
  expect(document.host).toEqual({runtimeRoot: options.runtimeRoot, bootId: options.bootId});
  expect(document.newProviderSpendUsd).toBe(0);
  for (const block of BLOCKS) expect({block, status: document[block].status}).toEqual({block, status: "recorded"});
  expect(document.observabilityExit).toEqual({tracesQueryable: true, metricsQueryable: true, reliabilityPanelReadable: true,
    structuredLogsConforming: true, backupFresh: true, instrumented: true, sloClaimed: false, availabilityMeasuredExternally: false});
  expect(Object.keys(document)).toEqual(["schema", "recordedAt", "host", ...BLOCKS, "observabilityExit", "newProviderSpendUsd"]);
  expect(validateExitDocument(JSON.parse(JSON.stringify(document)))).toEqual(document);
  const text = JSON.stringify(document);
  expect(text).not.toMatch(/\d+(\.\d+)?\s*%/);
  expect(text).not.toMatch(/99\.9/);
});

test("(b) each probe failing in turn pends only its block with a fixed reason and clears only its derived boolean", async () => {
  const failures: {name: string; probe: () => unknown; reason: (block: Block) => string}[] = [
    {name: "throws", probe: () => { throw new Error("postgres://hv_admin:pw@127.0.0.1:55432/db AKIAIOSFODNN7EXAMPLE"); }, reason: block => `${block} probe failed`},
    {name: "rejects", probe: () => Promise.reject(new Error("boom")), reason: block => `${block} probe failed`},
    {name: "never resolves", probe: () => new Promise(() => {}), reason: block => `${block} probe timed out`},
    {name: "malformed", probe: () => ({unexpected: true, sha: "postgres://x", traces: -1}), reason: block => `${block} data malformed`},
    {name: "null", probe: () => null, reason: block => `${block} data malformed`},
  ];
  for (const block of BLOCKS) for (const failure of failures) {
    const probes = healthy();
    let seen: AbortSignal | undefined;
    (probes as Record<Block, unknown>)[block] = (context: {signal: AbortSignal}) => { seen = context.signal; return failure.probe(); };
    const document = await collectObservabilityExit(probes, {...options, timeoutMs: 25});
    const result = document[block] as Record<string, unknown>;
    expect({block, failure: failure.name, status: result.status, reason: result.reason}).toEqual({block, failure: failure.name, status: "pending", reason: failure.reason(block)});
    for (const [key, value] of Object.entries(result)) if (key !== "status" && key !== "reason") expect({block, key, value}).toEqual({block, key, value: null});
    for (const other of BLOCKS) if (other !== block) expect({other, status: document[other].status}).toEqual({other, status: "recorded"});
    const boolean = EXIT_BOOLEAN[block];
    if (boolean) { expect({block, boolean, value: document.observabilityExit[boolean]}).toEqual({block, boolean, value: false}); expect(document.observabilityExit.instrumented).toBe(false); }
    else expect(document.observabilityExit.instrumented).toBe(true); // release, telemetryRuntime, availability and waveA are context, not the instrumented conjunction
    expect(document.observabilityExit.sloClaimed).toBe(false);
    expect(document.observabilityExit.availabilityMeasuredExternally).toBe(false);
    if (failure.name === "never resolves") expect(seen?.aborted).toBe(true);
  }
});

test("(b) an out-of-set operation, failure code or provider makes the metrics bundle unusable, and a partial log program clears only its boolean", async () => {
  const reading = (value: unknown): Reading<RecentMetrics> => ({state: "available", observedAt: "2026-09-14T18:00:00.000Z", value: value as RecentMetrics});
  const base = () => ({windowStart: "2026-09-14T17:30:00.000Z", windowEnd: "2026-09-14T18:00:00.000Z", stepSeconds: 60, series: [],
    reliability: {evaluatedAt: "2026-09-14T18:00:00.000Z", windowSeconds: 300, ceilingMs: 600_000,
      latency: [{operation: "job.process", p50Ms: 1, p95Ms: 2, p99Ms: 3, capped: false}], failures: [{operation: "job.process", successPerMinute: 1, errorPerMinute: 0, errorRatio: null, codes: {}}],
      providers: [{provider: "mock", successPerMinute: 1, errorPerMinute: 0, errorRatio: null}]}});
  expect(summarizeMetrics(reading(base())).reliability.latencyOperations).toEqual(["job.process"]);
  for (const mutate of [
    (value: ReturnType<typeof base>) => { value.reliability.latency[0]!.operation = "job.render" as never; },
    (value: ReturnType<typeof base>) => { value.reliability.failures[0]!.codes = {"disk.full": 1}; },
    (value: ReturnType<typeof base>) => { value.reliability.providers[0]!.provider = "openai" as never; },
  ]) {
    const value = base(); mutate(value);
    const document = await collectObservabilityExit({...healthy(), metrics: () => summarizeMetrics(reading(value))}, options);
    expect(document.metrics).toMatchObject({status: "pending", reason: "metrics data malformed"});
    expect(document.observabilityExit.metricsQueryable).toBe(false);
    expect(document.observabilityExit.instrumented).toBe(false);
    expect(document.traces.status).toBe("recorded");
  }
  const oneProgramPending = healthy();
  oneProgramPending.logs = () => ({window: LOG_WINDOW, programs: {...(healthy().logs({signal: new AbortController().signal}) as BlockData["logs"]).programs,
    [LOG_PROGRAMS[2]]: {status: "pending", reason: "log stream unavailable", lines: null, parsed: null, conforming: null, events: null, levels: null,
      traceCorrelated: null, unknownKeyLines: null, oversizeLines: null, guardViolations: null, droppedLines: null, suppressedLines: null,
      configurationInvalidLines: null, knownNonLoggerLines: null, partialLinesDiscarded: null}}});
  const partial = await collectObservabilityExit(oneProgramPending, options);
  expect(partial.logs.status).toBe("recorded");
  expect(partial.observabilityExit.structuredLogsConforming).toBe(false);
  expect(partial.observabilityExit.instrumented).toBe(false);
  const violating = healthy();
  violating.logs = () => ({window: LOG_WINDOW, programs: Object.fromEntries(LOG_PROGRAMS.map(program => [program, {status: "recorded", ...healthyLogCounts(), guardViolations: 1}]))});
  expect((await collectObservabilityExit(violating, options)).observabilityExit.structuredLogsConforming).toBe(false);
});

test("(b) the telemetry runtime pends on a wrong runtime schema, a missing release, a stopped service or a non-200 readiness endpoint", async () => {
  const fixture = observabilityFixture();
  const run = runner(() => ({stdout: supervisorStatus()}));
  const data = await telemetryRuntimeProbe({runtime: fixture.runtime, run, fetchImpl: ready});
  expect(data).toEqual({enabled: true, root: fixture.root, sourceSha: SHA, binaries: {jaeger: "2.20.0", collector: "0.160.0", prometheus: "3.14.0"},
    supervisor: {...RUNNING}, readiness: {collector: 200, traces: 200, metrics: 200}});
  const wrongSchema = observabilityFixture({runtime: {schema: "hv-observability-runtime/2"}});
  expect(await reasonOf(() => telemetryRuntimeProbe({runtime: wrongSchema.runtime, run, fetchImpl: ready}))).toBe("observability runtime manifest unreadable");
  expect(await reasonOf(() => readObservabilityRuntime(scratch()))).toBe("observability runtime manifest unreadable");
  const missingRelease = observabilityFixture({binaries: {releases: [{name: "jaeger", version: "2.20.0", binaries: {}}]}});
  expect(await reasonOf(() => telemetryRuntimeProbe({runtime: missingRelease.runtime, run, fetchImpl: ready}))).toBe("observability release unavailable");
  const otherVersion = observabilityFixture({binaries: {releases: [{name: "jaeger", version: "2.19.0", binaries: {}}, {name: "otelcol-contrib", version: "0.160.0", binaries: {}}, {name: "prometheus", version: "3.14.0", binaries: {}}]}});
  expect(await reasonOf(() => readObservabilityBinaries(otherVersion.root))).toBe("observability release unavailable");
  expect(await reasonOf(() => readObservabilityBinaries(scratch()))).toBe("observability binaries manifest unreadable");
  const stopped = runner(() => ({stdout: supervisorStatus({...RUNNING, [OBSERVABILITY_PROGRAMS[1]]: "STOPPED"})}));
  expect(await reasonOf(() => telemetryRuntimeProbe({runtime: fixture.runtime, run: stopped, fetchImpl: ready}))).toBe("observability service not running");
  const absent = runner(() => ({stdout: supervisorStatus({"rough-cut-staging-api": "RUNNING"})}));
  expect(await reasonOf(() => telemetryRuntimeProbe({runtime: fixture.runtime, run: absent, fetchImpl: ready}))).toBe("observability service not running");
  expect(await reasonOf(() => telemetryRuntimeProbe({runtime: fixture.runtime, run: runner(() => ({stdout: ""})), fetchImpl: ready}))).toBe("supervisor status unavailable");
  for (const answer of [async () => new Response("", {status: 302}), async () => new Response("", {status: 503}), async () => { throw new Error("ECONNREFUSED 127.0.0.1:15909"); }])
    expect(await reasonOf(() => telemetryRuntimeProbe({runtime: fixture.runtime, run, fetchImpl: answer}))).toBe("observability endpoint unavailable");
  const document = await collectObservabilityExit({...healthy(), telemetryRuntime: () => telemetryRuntimeProbe({runtime: fixture.runtime, run: stopped, fetchImpl: ready})}, options);
  expect(document.telemetryRuntime).toMatchObject({status: "pending", reason: "observability service not running"});
  expect(document.observabilityExit.instrumented).toBe(true); // the runtime section is context; the five capability booleans are unchanged
});

test("(c) an absent root, an absent settings file and enabled: false are not_configured on telemetryRuntime, traces and metrics -- never pending, never a value", async () => {
  const cases: {name: string; fixture: {runtime: string}; reason: string}[] = [
    {name: "no observability root", fixture: observabilityFixture({noRoot: true}), reason: "observability root absent"},
    {name: "observability.json absent", fixture: observabilityFixture({noSettings: true}), reason: "observability settings absent"},
    {name: "enabled: false", fixture: observabilityFixture({settings: {enabled: false}}), reason: "observability disabled on the host"},
  ];
  const run = runner(() => ({stdout: supervisorStatus()}));
  for (const {name, fixture, reason} of cases) {
    const probes = healthy();
    probes.telemetryRuntime = () => telemetryRuntimeProbe({runtime: fixture.runtime, run, fetchImpl: ready});
    probes.traces = () => { readObservabilitySettings(fixture.runtime); return healthy().traces({signal: new AbortController().signal}) as BlockData["traces"]; };
    probes.metrics = () => { readObservabilitySettings(fixture.runtime); return healthy().metrics({signal: new AbortController().signal}) as BlockData["metrics"]; };
    const document = await collectObservabilityExit(probes, options);
    for (const block of ["telemetryRuntime", "traces", "metrics"] as const) {
      const result = document[block] as Record<string, unknown>;
      expect({name, block, status: result.status, reason: result.reason}).toEqual({name, block, status: "not_configured", reason});
      for (const [key, value] of Object.entries(result)) if (key !== "status" && key !== "reason") expect({name, block, key, value}).toEqual({name, block, key, value: null});
    }
    expect({name, queryable: document.observabilityExit.tracesQueryable, instrumented: document.observabilityExit.instrumented}).toEqual({name, queryable: false, instrumented: false});
    expect(document.reliabilityPanel.status).toBe("recorded"); // a capability being off does not disturb another section
  }
  // A settings file that exists but is unreadable is a failure to read, not a statement that the capability is off.
  const broken = observabilityFixture();
  writeFileSync(join(broken.runtime, "observability.json"), "{not json", {mode: 0o600});
  expect(await reasonOf(() => readObservabilitySettings(broken.runtime))).toBe("observability settings unreadable");
  const wrongSchema = observabilityFixture({settings: {schema: "hv-observability-settings/2"}});
  expect(await reasonOf(() => readObservabilitySettings(wrongSchema.runtime))).toBe("observability settings unreadable");
  const explorerOff = summarizeTracesOff();
  expect(explorerOff).toBe("telemetry backend not configured");
});
function summarizeTracesOff(): string {
  try { summarizeTraces({state: "not_configured", observedAt: null, value: null}); return "no error"; }
  catch (error) { return (error as {reason?: string}).reason ?? "not a NotConfigured"; }
}

test("(c) an unavailable trace or metric backend pends rather than reporting the capability off", async () => {
  expect(await reasonOf(() => summarizeTraces({state: "unavailable", observedAt: null, value: null}))).toBe("trace backend unavailable");
  expect(await reasonOf(() => summarizeMetrics({state: "unavailable", observedAt: null, value: null}))).toBe("metric backend unavailable");
  expect(await reasonOf(() => summarizeMetrics({state: "not_configured", observedAt: null, value: null}))).toBe("telemetry backend not configured");
  const list: Reading<TraceList> = {state: "available", observedAt: "2026-09-14T18:00:00.000Z", value: {windowStart: "2026-09-13T18:00:00.000Z",
    windowEnd: "2026-09-14T18:00:00.000Z", limit: 20, traces: [
      {id: TRACE, jobId: "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b", stage: "animatic", startedAt: "2026-09-14T17:50:00.000Z", durationMs: 900, outcome: "success", spanCount: 7, limited: false},
      {id: "c".repeat(32), jobId: "1f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b", stage: "final", startedAt: "2026-09-14T17:55:00.000Z", durationMs: 40, outcome: "error", spanCount: 4, limited: false}]}};
  const data = summarizeTraces(list);
  expect(data).toEqual({state: "available", windowStart: "2026-09-13T18:00:00.000Z", windowEnd: "2026-09-14T18:00:00.000Z", traces: 2, withJobId: 2,
    outcomes: {success: 1, error: 1, unknown: 0}, newestStartedAt: "2026-09-14T17:55:00.000Z", spanCountMin: 4, spanCountMax: 7, services: [...TRACE_SERVICES]});
  const text = JSON.stringify(data);
  for (const identifier of [TRACE, "c".repeat(32), "0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b", "animatic", "final"])
    expect({identifier, leaked: text.includes(identifier)}).toEqual({identifier, leaked: false});
  // `withJobId` is an invariant of the reading, not a measurement: recentTraces() keeps only job-correlated traces.
  expect(data.withJobId).toBe(data.traces);
  const inconsistent = await collectObservabilityExit({...healthy(), traces: () => ({...data, withJobId: data.traces - 1})}, options);
  expect(inconsistent.traces).toMatchObject({status: "pending", reason: "traces data malformed"});
  const empty = summarizeTraces({state: "available", observedAt: null, value: {windowStart: "2026-09-13T18:00:00.000Z", windowEnd: "2026-09-14T18:00:00.000Z", limit: 20, traces: []}});
  expect(empty).toMatchObject({traces: 0, withJobId: 0, newestStartedAt: null, spanCountMin: null, spanCountMax: null});
  const document = await collectObservabilityExit({...healthy(), traces: () => empty}, options);
  expect(document.traces.status).toBe("recorded");
  expect(document.observabilityExit.tracesQueryable).toBe(true); // an empty window is a successful reading, not a failure
});

// ---- (d) the log classification table ----
const CONFORMING = JSON.stringify({ts: "2026-09-14T18:00:00.000Z", level: "info", service: "api", event: "api.request",
  method: "GET", route: "/health", status: 200, durationMs: 3, traceId: TRACE, spanId: SPAN});
const FRAGMENT = "{\"ts\":\"2026-09-14T17:59:59.9";
/** A tail that filled its byte budget: it begins with the tail end of a line written before the window. */
const filled = (...lines: string[]): string => [FRAGMENT, ...lines].join("\n") + "\n";
const TINY = 1, HUGE = 1_000_000;

test("(d) log lines are classified against the logger's own schema and counted, never copied", () => {
  const unknownKey = JSON.stringify({ts: "2026-09-14T18:00:00.000Z", level: "info", service: "api", event: "api.request", message: "a free text field"});
  const oversize = JSON.stringify({ts: "2026-09-14T18:00:00.000Z", level: "info", service: "api", event: "api.request", route: "/" + "a".repeat(2100)});
  const guarded = JSON.stringify({ts: "2026-09-14T18:00:00.000Z", level: "warn", service: "worker", event: "worker.lease_lost", route: "https://example.invalid/leak"});
  const sweeper = JSON.stringify({sweptAt: "2026-09-14T17:59:00.000Z", removedProjects: [], localCacheDirectories: 0, storage: {}, orphanObjects: 0, incompleteUploads: {aborted: 0, retained: 0, failed: 0, supported: true}});
  const telemetry = JSON.stringify({event: "telemetry.configuration_invalid", service: "api"});
  const dropped = JSON.stringify({ts: "2026-09-14T18:00:00.000Z", level: "warn", service: "worker", event: "log.dropped", dropped: 1});
  const suppressed = JSON.stringify({ts: "2026-09-14T18:00:00.000Z", level: "error", service: "worker", event: "log.suppressed", dropped: 3});
  const invalidConfig = JSON.stringify({ts: "2026-09-14T18:00:00.000Z", level: "warn", service: "retention", event: "log.configuration_invalid"});
  const zeroTrace = JSON.stringify({ts: "2026-09-14T18:00:00.000Z", level: "info", service: "api", event: "api.request", traceId: "0".repeat(32)});
  const shortTrace = JSON.stringify({ts: "2026-09-14T18:00:00.000Z", level: "info", service: "api", event: "api.request", traceId: "abc"});
  const unknownEvent = JSON.stringify({ts: "2026-09-14T18:00:00.000Z", level: "info", service: "api", event: "api.exploded"});
  const counts = classifyLogLines([filled(CONFORMING, unknownKey, oversize, guarded, sweeper, telemetry, dropped, suppressed, invalidConfig, zeroTrace, shortTrace, unknownEvent, "not json at all")], TINY);
  expect(counts.lines).toBe(13);
  expect(counts.knownNonLoggerLines).toBe(2);
  expect(counts.parsed).toBe(10); // the two non-logger lines and the unparsable line are not counted as logger lines
  expect(counts.conforming).toBe(6); // CONFORMING, dropped, suppressed, invalidConfig, zeroTrace, shortTrace
  expect(counts.unknownKeyLines).toBe(1);
  expect(counts.oversizeLines).toBe(1);
  expect(counts.guardViolations).toBe(2); // the oversize line and the line carrying a URL
  expect(counts.traceCorrelated).toBe(1); // only a 32-character non-zero hexadecimal trace id counts
  expect(counts.droppedLines).toBe(1);
  expect(counts.suppressedLines).toBe(1);
  expect(counts.configurationInvalidLines).toBe(1);
  expect(counts.events).toEqual({"api.request": 5, "worker.lease_lost": 1, "log.dropped": 1, "log.suppressed": 1, "log.configuration_invalid": 1});
  expect(counts.levels).toEqual({info: 6, warn: 3, error: 1}); // a line whose event is outside EVENTS still has a level
  const text = JSON.stringify(counts);
  for (const value of ["free text", "example.invalid", "/health", TRACE, "api.exploded"]) expect({value, leaked: text.includes(value)}).toEqual({value, leaked: false});
  expect(counts.partialLinesDiscarded).toBe(1);
  expect(classifyLogLines([""])).toEqual(classifyLogLines([]));
  expect(classifyLogLines([""]).partialLinesDiscarded).toBe(0); // an empty stream has no partial line to discard
  expect(classifyLogLines([filled()], TINY).lines).toBe(0); // only the fragment: nothing to classify
  const both = classifyLogLines([filled(CONFORMING), filled(dropped)], TINY);
  expect({lines: both.lines, parsed: both.parsed, conforming: both.conforming, discarded: both.partialLinesDiscarded})
    .toEqual({lines: 2, parsed: 2, conforming: 2, discarded: 2});
});

test("(d) the first line is dropped only when the tail filled its byte budget, and every discard is counted", () => {
  const complete = JSON.stringify({ts: "2026-09-14T18:00:00.000Z", level: "info", service: "worker", event: "worker.started", worker: "zo-staging-worker-1", storage: "postgres"});
  const short = complete + "\n" + CONFORMING + "\n";
  // A short tail reached the start of the retained bytes: its first line is complete and is kept.
  const kept = classifyLogLines([short], HUGE);
  expect({lines: kept.lines, parsed: kept.parsed, conforming: kept.conforming, discarded: kept.partialLinesDiscarded})
    .toEqual({lines: 2, parsed: 2, conforming: 2, discarded: 0});
  // The same bytes seen as a filled tail: the first line may have begun before the window, so it is dropped and counted.
  const trimmed = classifyLogLines([short], TINY);
  expect({lines: trimmed.lines, parsed: trimmed.parsed, discarded: trimmed.partialLinesDiscarded}).toEqual({lines: 1, parsed: 1, discarded: 1});
  // A trailing partial line is dropped and counted whatever the budget; a stream ending on a newline has none.
  expect(classifyLogLines([complete + "\n" + CONFORMING.slice(0, 30)], HUGE)).toMatchObject({lines: 1, parsed: 1, partialLinesDiscarded: 1});
  expect(classifyLogLines([complete + "\n"], HUGE).partialLinesDiscarded).toBe(0);
  // A guard violation sitting on a discarded line is invisible to guardViolations, which is exactly why the discard is recorded.
  const violating = JSON.stringify({ts: "2026-09-14T18:00:00.000Z", level: "warn", service: "api", event: "api.request", route: "https://leak.invalid"});
  expect(classifyLogLines([violating + "\n" + CONFORMING + "\n"], HUGE)).toMatchObject({guardViolations: 1, partialLinesDiscarded: 0});
  expect(classifyLogLines([violating + "\n" + CONFORMING + "\n"], TINY)).toMatchObject({guardViolations: 0, partialLinesDiscarded: 1});
});

test("(d) programLogs reads both streams of each program with tail -65536 and pends an empty or unreadable stream", async () => {
  const calls: string[][] = [];
  const run = runner(command => { calls.push(command); return {stdout: CONFORMING + "\n" + CONFORMING + "\n"}; });
  const result = await programLogs(run, LOG_PROGRAMS[0]);
  expect(result).toMatchObject({status: "recorded", lines: 4, parsed: 4, conforming: 4, traceCorrelated: 4, partialLinesDiscarded: 0});
  expect(calls.map(call => call.slice(3))).toEqual([["tail", "-65536", LOG_PROGRAMS[0], "stdout"], ["tail", "-65536", LOG_PROGRAMS[0], "stderr"]]);
  expect(calls.every(call => call[0] === "supervisorctl" && !call.some(part => ["start", "stop", "restart", "update", "reread"].includes(part)))).toBe(true);
  expect(await programLogs(runner(() => ({stdout: ""})), LOG_PROGRAMS[0])).toMatchObject({status: "pending", reason: "log stream empty", lines: null});
  expect(await programLogs(runner(() => ({exitCode: 1, stdout: "no log file"})), LOG_PROGRAMS[1])).toMatchObject({status: "pending", reason: "log stream unavailable"});
  expect(await programLogs(runner(() => Object.assign(new Error("not found"), {code: "ENOENT"})), LOG_PROGRAMS[2])).toMatchObject({status: "pending", reason: "log stream unavailable"});
});

test("(d) structured-log conformance judges the lines that exist, not whether every program happened to log", async () => {
  const quiet = {...healthyLogCounts(), lines: 45, parsed: 0, conforming: 0, events: {}, levels: {}, traceCorrelated: 0, knownNonLoggerLines: 45};
  const programs = (overrides: Record<string, unknown> = {}) => ({window: LOG_WINDOW, programs: {
    [LOG_PROGRAMS[0]]: {status: "recorded", ...healthyLogCounts()}, [LOG_PROGRAMS[1]]: {status: "recorded", ...healthyLogCounts()},
    [LOG_PROGRAMS[2]]: {status: "recorded", ...quiet}, ...overrides}} as BlockData["logs"]);
  // The retention sweeper writes only its `sweptAt` status line in normal operation and reaches the logger on failure alone.
  const silentSweeper = await collectObservabilityExit({...healthy(), logs: () => programs()}, options);
  expect(silentSweeper.logs.status).toBe("recorded");
  expect(silentSweeper.observabilityExit.structuredLogsConforming).toBe(true);
  expect(silentSweeper.observabilityExit.instrumented).toBe(true);
  // No program produced a logger line at all: the reading establishes nothing about conformance.
  const allQuiet = await collectObservabilityExit({...healthy(), logs: () => ({window: LOG_WINDOW,
    programs: Object.fromEntries(LOG_PROGRAMS.map(program => [program, {status: "recorded", ...quiet}]))} as BlockData["logs"])}, options);
  expect(allQuiet.observabilityExit.structuredLogsConforming).toBe(false);
  // A non-conforming line or a guard violation anywhere still clears the boolean, quiet program or not.
  const nonConforming = await collectObservabilityExit({...healthy(),
    logs: () => programs({[LOG_PROGRAMS[2]]: {status: "recorded", ...quiet, parsed: 3, conforming: 2}})}, options);
  expect(nonConforming.observabilityExit.structuredLogsConforming).toBe(false);
  const violating = await collectObservabilityExit({...healthy(),
    logs: () => programs({[LOG_PROGRAMS[2]]: {status: "recorded", ...quiet, guardViolations: 1}})}, options);
  expect(violating.observabilityExit.structuredLogsConforming).toBe(false);
  // An unreadable program is not a quiet one: a stream nobody could read proves nothing either way.
  const unreadable = await collectObservabilityExit({...healthy(), logs: () => programs({[LOG_PROGRAMS[2]]:
    {status: "pending", reason: "log stream unavailable", ...Object.fromEntries(Object.keys(quiet).map(key => [key, null]))}})}, options);
  expect(unreadable.observabilityExit.structuredLogsConforming).toBe(false);
});

test("(c) only an absent file says the capability is off: every other errno is a failed read", async () => {
  const enabled = observabilityFixture();
  expect(readObservabilitySettings(enabled.runtime)).toEqual({enabled: true, root: enabled.root});
  const notConfiguredOf = (fn: () => unknown): string => {
    try { fn(); return "no error"; } catch (error) { return error instanceof NotConfigured ? "not_configured:" + error.reason : "pending:" + ((error as {reason?: string}).reason ?? "unknown"); }
  };
  // ENOENT, and only ENOENT, is the operator's "off".
  expect(notConfiguredOf(() => readObservabilitySettings(join(scratch(), "missing")))).toBe("not_configured:observability settings absent");
  expect(notConfiguredOf(() => readObservabilitySettings(observabilityFixture({settings: {enabled: false}}).runtime))).toBe("not_configured:observability disabled on the host");
  expect(notConfiguredOf(() => readObservabilitySettings(observabilityFixture({noRoot: true}).runtime))).toBe("not_configured:observability root absent");
  // ENOTDIR: --runtime points at a regular file.
  const file = join(scratch(), "not-a-directory");
  writeFileSync(file, "x");
  expect(notConfiguredOf(() => readObservabilitySettings(file))).toBe("pending:observability settings unreadable");
  // ELOOP: observability.json is a symlink loop.
  const loop = scratch();
  symlinkSync(join(loop, "observability.json"), join(loop, "ring.json"));
  symlinkSync(join(loop, "ring.json"), join(loop, "observability.json"));
  expect(notConfiguredOf(() => readObservabilitySettings(loop))).toBe("pending:observability settings unreadable");
  // A directory, a dangling symlink or anything else that is not a regular file in its place is not "off" either.
  const directory = scratch();
  mkdirSync(join(directory, "observability.json"));
  expect(notConfiguredOf(() => readObservabilitySettings(directory))).toBe("pending:observability settings unreadable");
  const dangling = scratch();
  symlinkSync(join(dangling, "nowhere.json"), join(dangling, "observability.json"));
  expect(notConfiguredOf(() => readObservabilitySettings(dangling))).toBe("pending:observability settings unreadable");
  // The root exists but is not a usable directory: a failed read, not a capability the operator turned off.
  const rootIsFile = observabilityFixture();
  rmSync(rootIsFile.root, {recursive: true, force: true});
  writeFileSync(rootIsFile.root, "x");
  expect(notConfiguredOf(() => readObservabilitySettings(rootIsFile.runtime))).toBe("pending:observability root unreadable");
  const rootLoop = observabilityFixture({noRoot: true});
  symlinkSync(rootLoop.root, rootLoop.root + "-ring");
  symlinkSync(rootLoop.root + "-ring", rootLoop.root);
  expect(notConfiguredOf(() => readObservabilitySettings(rootLoop.runtime))).toBe("pending:observability root unreadable");
  // EACCES, where the test user is not root.
  if (process.getuid?.() !== 0) {
    const unreadable = observabilityFixture();
    chmodSync(join(unreadable.runtime, "observability.json"), 0o000);
    expect(notConfiguredOf(() => readObservabilitySettings(unreadable.runtime))).toBe("pending:observability settings unreadable");
    chmodSync(join(unreadable.runtime, "observability.json"), 0o600);
  }
  // Each of those failed reads lands on the sections as `pending`, never as `not_configured`.
  const document = await collectObservabilityExit({...healthy(),
    telemetryRuntime: () => telemetryRuntimeProbe({runtime: file, run: runner(() => ({stdout: supervisorStatus()})), fetchImpl: ready}),
    traces: () => { readObservabilitySettings(file); return healthy().traces({signal: new AbortController().signal}) as BlockData["traces"]; }}, options);
  for (const block of ["telemetryRuntime", "traces"] as const)
    expect({block, ...(document[block] as {status: string; reason?: string})}).toMatchObject({block, status: "pending", reason: "observability settings unreadable"});
});

// ---- (e) the availability predicate and the bounded burst ----
test("(e) the SLI predicate accepts only a fast, complete 200 and never becomes a ratio", async () => {
  const body = {status: "healthy", service: "hollywood-video-private-staging", queueDepth: 0, runningJobs: 0, monthSpendUsd: 0.144};
  expect(healthPredicate(200, 12, body)).toBe(true);
  expect(healthPredicate(200, 12, {...body, queueDepth: undefined})).toBe(false);
  expect(healthPredicate(200, 12, {...body, monthSpendUsd: Number.NaN})).toBe(false);
  expect(healthPredicate(200, 12, {...body, service: "something-else"})).toBe(false);
  expect(healthPredicate(500, 12, body)).toBe(false);
  expect(healthPredicate(200, 2500, body)).toBe(false);
  expect(healthPredicate(200, 12, null)).toBe(false);
  expect(healthPredicate(200, 12, "<html>")).toBe(false);
  // The body's `status` field is excluded from the predicate: the server hard-codes it, so it carries no information.
  expect(healthPredicate(200, 12, {...body, status: "degraded"})).toBe(true);
});

test("(e) the burst runs one request at a time, one per second, and records counts with a stated vantage", async () => {
  let clock = NOW, inflight = 0, peak = 0, calls = 0;
  const now = () => clock;
  const sleep = async (ms: number) => { clock += ms; };
  const answers = [200, 200, 500];
  const fetchImpl = async () => {
    inflight++; peak = Math.max(peak, inflight);
    await Promise.resolve();
    clock += 12;
    inflight--;
    const status = answers[calls++] ?? 200;
    return new Response(JSON.stringify({status: "healthy", service: "hollywood-video-private-staging", queueDepth: 1, runningJobs: 0, monthSpendUsd: 0}), {status});
  };
  const sample = await availabilityBurst({samples: 3, fetchImpl, now, sleep, origin: "http://127.0.0.1:8081"});
  expect(sample).toEqual({attempts: 3, successes: 2, predicateFailures: 1, p50LatencyMs: 12, maxLatencyMs: 12,
    startedAt: new Date(NOW).toISOString(), endedAt: new Date(clock).toISOString(), vantage: "loopback on the staging host"});
  expect(peak).toBe(1);
  expect(Date.parse(sample.endedAt) - Date.parse(sample.startedAt)).toBeGreaterThanOrEqual((sample.attempts - 1) * 1000);
  expect(JSON.stringify(sample)).not.toMatch(/\d+(\.\d+)?\s*%/);
  await expect(availabilityBurst({samples: 0, fetchImpl, now, sleep})).rejects.toThrow("invalid availability sample count");
  await expect(availabilityBurst({samples: AVAILABILITY_SAMPLES_MAX + 1, fetchImpl, now, sleep})).rejects.toThrow("invalid availability sample count");
  await expect(availabilityBurst({samples: 2.5, fetchImpl, now, sleep})).rejects.toThrow("invalid availability sample count");
  const unreachable = await availabilityBurst({samples: 2, now, sleep, fetchImpl: async () => { throw new Error("ECONNREFUSED http://127.0.0.1:8081/health"); }});
  expect(unreachable).toMatchObject({attempts: 2, successes: 0, predicateFailures: 2});
  const data = await availabilityProbe({samples: 1, fetchImpl, now, sleep});
  expect(data.sli).toEqual(SLI);
  expect(data).toMatchObject({establishesSlo: false, measuredExternally: false, windowDays: null});
  expect(data.blockedBy).toEqual([...AVAILABILITY_BLOCKED_BY]);
  expect(data.blockedBy.join(" ")).toMatch(/G3/);
  expect(data.blockedBy.join(" ")).toMatch(/G7 and ADR-0020/);
  expect(JSON.stringify(data)).not.toMatch(/\d+(\.\d+)?\s*%/);
  expect(JSON.stringify(data)).not.toMatch(/99\.9/);
});

// ---- (f) the reliability panel through the panel's own validators ----
test("(f) circuit and cost readings are summarized through the panel's validators, with no id and no ratio", async () => {
  const entry = (overrides: Record<string, unknown> = {}) => ({stage: "animatic", provider: "mock", id: "pool-0f1e2d3c", state: "closed",
    consecutiveFailures: 0, samples: 5, latencyMs: 120, lastOutcome: "success", observedAt: "2026-09-14T17:59:55.000Z", ...overrides});
  const rows: PanelRows = {
    workerProviders: [{name: "zo-staging-worker-1", providers: [entry(), entry({stage: "final", state: "open"})]},
      {name: "zo-staging-worker-2", providers: "not an array"}, {name: "zo-staging-worker-3", providers: [entry({stage: "unknown-stage"})]}],
    providerCosts: [{provider: "mock", dayUsd: 0, weekUsd: 0.01, monthUsd: 0.144, events: 254}],
    queued: 0, running: 0, ready: 3, busy: 0, draining: 0, latestProcesses: 3};
  const data = summarizeReliabilityPanel(rows);
  expect(data.circuits).toEqual({workers: 2, entries: 2, dropped: 2, truncated: false, states: {closed: 1, open: 1}, stages: {animatic: 1, final: 1}, providers: {mock: 2}});
  expect(data.costs).toEqual({providers: 1, totals: {dayUsd: 0, weekUsd: 0.01, monthUsd: 0.144}, dailyAverageUsd: 0.144 / 30, lastDayVsAverage: "below", truncated: false});
  expect(data).toMatchObject({freshWithinSeconds: 45, vantage: PANEL_VANTAGE, httpSurfaceRead: false, httpSurfaceReason: PANEL_HTTP_REASON});
  const text = JSON.stringify(data);
  for (const identifier of ["pool-0f1e2d3c", "zo-staging-worker-1"]) expect({identifier, leaked: text.includes(identifier)}).toEqual({identifier, leaked: false});
  expect(text).not.toMatch(/\d+(\.\d+)?\s*%/);
  const many = summarizeReliabilityPanel({...rows, workerProviders: Array.from({length: 65}, (_value, index) => ({name: "worker-" + index, providers: [entry()]}))});
  expect(many.circuits.truncated).toBe(true);
  expect(many.circuits.workers).toBe(64);
  const folded = summarizeReliabilityPanel({...rows, providerCosts: Array.from({length: 17}, (_value, index) => ({provider: "p" + index, dayUsd: 1, weekUsd: 1, monthUsd: 17 - index, events: 1}))});
  expect(folded.costs.providers).toBe(17);
  expect(costReadings(Array.from({length: 17}, (_value, index) => ({provider: "p" + index, dayUsd: 1, weekUsd: 1, monthUsd: 17 - index, events: 1}))).byProvider.map(row => row.provider)).toContain("other");
  const silent = summarizeReliabilityPanel({...rows, providerCosts: []});
  expect(silent.costs).toMatchObject({providers: 0, dailyAverageUsd: 0, lastDayVsAverage: null});
  const above = summarizeReliabilityPanel({...rows, providerCosts: [{provider: "mock", dayUsd: 1, weekUsd: 1, monthUsd: 1, events: 1}]});
  expect(above.costs.lastDayVsAverage).toBe("above");
  expect(providerHealthReadings(rows.workerProviders).dropped).toBe(2); // the non-array body and the out-of-set stage, counted and never blanked
  const document = await collectObservabilityExit({...healthy(), reliabilityPanel: () => data}, options);
  expect(document.reliabilityPanel.status).toBe("recorded");
  expect(document.observabilityExit.reliabilityPanelReadable).toBe(true);
  for (const label of [...CIRCUIT_STATES, ...CIRCUIT_STAGES, ...PROVIDER_KINDS]) expect(typeof label).toBe("string");
});

test("(f) backup freshness follows the operator console's five-minute rule and the drill's negatives are carried forward", async () => {
  const fresh = backupBlock({state: "healthy", lastSnapshotAt: "2026-09-14T17:58:00.000Z", lastCompletedAt: "2026-09-14T17:58:10.000Z", failureStage: null}, NOW);
  expect(fresh).toEqual({state: "healthy", lastSnapshotAt: "2026-09-14T17:58:00.000Z", lastCompletedAt: "2026-09-14T17:58:10.000Z", ageSeconds: 120,
    freshWithin300s: true, failureStage: null, localRepositoryOnly: true});
  expect(backupBlock({state: "healthy", lastSnapshotAt: "2026-09-14T17:50:00.000Z", lastCompletedAt: "2026-09-14T17:50:10.000Z", failureStage: null}, NOW).freshWithin300s).toBe(false);
  expect(backupBlock({state: "degraded", lastSnapshotAt: "2026-09-14T17:58:00.000Z", lastCompletedAt: null, failureStage: "retention"}, NOW).freshWithin300s).toBe(false);
  expect(backupBlock({state: "running", lastSnapshotAt: null, lastCompletedAt: null, failureStage: null}, NOW)).toMatchObject({ageSeconds: null, freshWithin300s: false});
  const degraded = healthy();
  degraded.recovery = () => ({...(healthy().recovery({signal: new AbortController().signal}) as BlockData["recovery"]),
    backup: {status: "recorded", ...backupBlock({state: "degraded", lastSnapshotAt: "2026-09-14T17:58:00.000Z", lastCompletedAt: "2026-09-14T17:58:10.000Z", failureStage: "retention"}, NOW)}});
  const document = await collectObservabilityExit(degraded, options);
  expect(document.recovery.status).toBe("recorded");
  expect(document.observabilityExit.backupFresh).toBe(false); // a fresh snapshot with a failed retention cycle is not a healthy backup
  const drill = readDrillRecord(join(repo, OFFHOST_DRILL_PATH));
  // Every negative HV-038-03 recorded is carried forward, including the one that says nothing ships between snapshots.
  expect(drill).toMatchObject({source: OFFHOST_DRILL_PATH, continuousReplication: false, provesOffHostRpo: false,
    provesHostLossRecovery: false, restoredIntoLiveDatabase: false});
  expect(JSON.parse(readFileSync(join(repo, OFFHOST_DRILL_PATH), "utf8")).continuousReplication).toBe(false);
  expect(drill.independentDestination).not.toContain("://");
  expect(Number.isSafeInteger(drill.snapshotToCopyMs)).toBe(true);
  const dir = scratch();
  writeFileSync(join(dir, "broken.json"), "{");
  expect(drillProbe(join(dir, "broken.json"))).toMatchObject({status: "pending", reason: "off-host drill record unreadable", recordedAt: null});
  const claim = (overrides: Record<string, unknown>) => JSON.stringify({schema: "hv-offhost-drill/1", recordedAt: "2026-09-14T23:09:27.940Z",
    rpo: {snapshotToCopyMs: 72}, encryption: {exercised: true}, continuousReplication: false, provesOffHostRpo: false, provesHostLossRecovery: false,
    restoredIntoLiveDatabase: false, independentDestination: "none", ...overrides});
  writeFileSync(join(dir, "claiming.json"), claim({provesOffHostRpo: true}));
  expect(drillProbe(join(dir, "claiming.json"))).toMatchObject({status: "pending", reason: "off-host drill record failed shape checks"});
  writeFileSync(join(dir, "replicating.json"), claim({continuousReplication: true}));
  expect(drillProbe(join(dir, "replicating.json"))).toMatchObject({status: "pending", reason: "off-host drill record failed shape checks"});
  writeFileSync(join(dir, "silent.json"), claim({continuousReplication: undefined}));
  expect(drillProbe(join(dir, "silent.json"))).toMatchObject({status: "pending", reason: "off-host drill record failed shape checks"});
  writeFileSync(join(dir, "honest.json"), claim({}));
  expect(drillProbe(join(dir, "honest.json"))).toMatchObject({status: "recorded", continuousReplication: false});
});

// ---- (g) the wave A reference block ----
test("(g) the committed wave A exit is referenced through its own validator and only three fields are carried over", async () => {
  const waveAPath = join(repo, WAVE_A_PATH);
  const reference = readWaveAReference(waveAPath);
  const source = JSON.parse(readFileSync(waveAPath, "utf8"));
  expect(Object.keys(reference).sort()).toEqual(["recordedAt", "releaseSha", "satisfied"]);
  expect(reference.recordedAt).toBe(source.recordedAt);
  expect(reference.releaseSha).toBe(source.release.status === "recorded" ? source.release.sha : null);
  expect(reference.satisfied).toBe(source.waveAExit.satisfied);
  const dir = scratch();
  writeFileSync(join(dir, "corrupt.json"), JSON.stringify({...source, waveAExit: {...source.waveAExit, satisfied: !source.waveAExit.satisfied}}));
  expect(await reasonOf(() => readWaveAReference(join(dir, "corrupt.json")))).toBe("wave A evidence failed validation");
  expect(await reasonOf(() => readWaveAReference(join(dir, "missing.json")))).toBe("wave A evidence unreadable");
  const document = await collectObservabilityExit({...healthy(), waveA: () => readWaveAReference(join(dir, "corrupt.json"))}, options);
  expect(document.waveA).toMatchObject({status: "pending", reason: "wave A evidence failed validation", recordedAt: null, releaseSha: null, satisfied: null});
  for (const block of SECTIONS) expect({block, status: document[block].status}).toEqual({block, status: "recorded"});
  expect(document.observabilityExit.instrumented).toBe(true); // the reference block is not part of the instrumented conjunction
  const real = await collectObservabilityExit({...healthy(), waveA: () => readWaveAReference(waveAPath)}, options);
  expect(real.waveA).toEqual({status: "recorded", ...reference});
});

// ---- (h) redaction ----
test("(h) a leaking probe never puts a URL, key, trace id or UUID into the document, and every reason is whitelisted", async () => {
  const leak = "postgres://hv_admin:s3cr3t@127.0.0.1:55432/hollywood_video_staging AKIAIOSFODNN7EXAMPLE secret_access_key=wJalrX "
    + "trace " + TRACE + " job 0f1e2d3c-4b5a-6978-8a9b-0c1d2e3f4a5b token=abc";
  const leaking = {} as Probes;
  for (const block of BLOCKS) (leaking as Record<Block, unknown>)[block] = () => { throw Object.assign(new Error(leak), {reason: leak, detail: leak, code: "28P01"}); };
  const document = await collectObservabilityExit(leaking, {...options, bootId: null});
  const text = JSON.stringify(document);
  for (const pattern of [/postgres(?:ql)?:\/\//i, /https?:\/\//i, /AKIA[0-9A-Z]{16}/, /secret/i, /token/i, /password/i,
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, /\b[0-9a-f]{32}\b/i, /28P01/, /s3cr3t/])
    expect({pattern: String(pattern), leaked: pattern.test(text)}).toEqual({pattern: String(pattern), leaked: false});
  for (const block of BLOCKS) {
    expect({block, status: document[block].status}).toEqual({block, status: "pending"});
    expect({block, known: isKnownReason((document[block] as {reason?: string}).reason)}).toEqual({block, known: true});
  }
  expect(document.observabilityExit.instrumented).toBe(false);
  for (const reason of REASONS) expect(reason).toMatch(/^[a-zA-Z_0-9 -]+$/);
  const recorded = JSON.stringify(await collectObservabilityExit(healthy(), options));
  expect(withoutFixedProse(recorded)).not.toMatch(/postgres(?:ql)?:\/\/|AKIA[0-9A-Z]{16}|secret|token|password/i);
  for (const phrase of FIXED_PROSE) expect(phrase).not.toMatch(/:\/\/|AKIA[0-9A-Z]{16}|\b(secret|token|password|key)\s*=/i); // the fixed prose names no value
  expect(recorded.replace(options.bootId, "")).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  // The closed label sets are the only vocabulary a recorded section may use.
  const document2 = await collectObservabilityExit(healthy(), options);
  const metrics = document2.metrics;
  if (metrics.status === "recorded") {
    for (const operation of [...metrics.reliability.latencyOperations, ...metrics.reliability.failureOperations]) expect(OPERATION_NAMES as readonly string[]).toContain(operation);
    for (const code of metrics.reliability.failureCodes) expect([...FAILURE_CODES, "unknown"] as string[]).toContain(code);
    for (const provider of metrics.reliability.providers) expect(PROVIDER_KINDS as readonly string[]).toContain(provider);
  }
});

test("(h) validateExitDocument refuses a hand-edited derivation, an unknown reason or a value on a pending block", async () => {
  const document = await collectObservabilityExit(healthy(), options);
  const raw = JSON.parse(JSON.stringify(document));
  expect(validateExitDocument(raw)).toEqual(document);
  expect(() => validateExitDocument({...raw, observabilityExit: {...raw.observabilityExit, sloClaimed: true}})).toThrow();
  expect(() => validateExitDocument({...raw, observabilityExit: {...raw.observabilityExit, instrumented: false}})).toThrow();
  expect(() => validateExitDocument({...raw, schema: "hv-observability-exit/2"})).toThrow();
  expect(() => validateExitDocument({...raw, newProviderSpendUsd: 1})).toThrow();
  expect(() => validateExitDocument({...raw, traces: {...raw.traces, status: "pending", reason: "because it broke"}})).toThrow();
  expect(() => validateExitDocument({...raw, traces: {...raw.traces, status: "pending", reason: "trace backend unavailable"}})).toThrow();
  expect(() => validateExitDocument({...raw, availability: {...raw.availability, sli: {...raw.availability.sli, errorBudget: "99.9 % met"}}})).toThrow();
  const derived = deriveObservabilityExit(raw as ObservabilityExitDocument);
  expect(derived).toEqual(document.observabilityExit);
});

// ---- (i) the committed evidence and the deferred register ----
const committed = "(i) the committed observability-exit.json validates, recomputes from its sections and claims nothing";
test.skipIf(!existsSync(evidencePath))(existsSync(evidencePath) ? committed : committed + " (observability-exit.json is recorded on the staging host; not present in this tree)", () => {
  const text = readFileSync(evidencePath, "utf8"), raw = JSON.parse(text);
  const document: ObservabilityExitDocument = validateExitDocument(raw);
  expect(JSON.stringify(document, null, 2) + "\n").toBe(text);
  expect(document.recordedAt).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  expect(new Date(document.recordedAt).toISOString()).toBe(document.recordedAt);
  expect(document.release.status === "recorded" ? document.release.sha : "").toMatch(/^[0-9a-f]{40}$/);
  expect(document.observabilityExit).toEqual(deriveObservabilityExit(document));
  expect(document.observabilityExit.sloClaimed).toBe(false);
  expect(document.observabilityExit.availabilityMeasuredExternally).toBe(false);
  expect(document.observabilityExit.instrumented).toBe(document.observabilityExit.tracesQueryable && document.observabilityExit.metricsQueryable
    && document.observabilityExit.reliabilityPanelReadable && document.observabilityExit.structuredLogsConforming && document.observabilityExit.backupFresh);
  expect(document.newProviderSpendUsd).toBe(0);
  if (document.waveA.status === "recorded") {
    const waveA = JSON.parse(readFileSync(join(repo, WAVE_A_PATH), "utf8"));
    expect(document.waveA.releaseSha).toBe(waveA.release.status === "recorded" ? waveA.release.sha : null);
  }
  expect(text).not.toMatch(/\d+(\.\d+)?\s*%/);
  expect(text).not.toMatch(/99\.9/);
  expect(withoutFixedProse(text.replace(document.host.bootId ?? "", ""))).not.toMatch(/postgres(?:ql)?:\/\/|AKIA[0-9A-Z]{16}|secret|token|password|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
  for (const block of BLOCKS) if (document[block].status !== "recorded") expect(isKnownReason((document[block] as {reason?: string}).reason)).toBe(true);
});

test("(i) docs/OBSERVABILITY.md carries the deferred register, names an owner or gate per item, and claims nothing", () => {
  const doc = readFileSync(docPath, "utf8");
  expect(doc).toContain("## Deferred from HV-038 (with reason)");
  expect(doc).toContain("## Availability SLI and the 99.9 % target");
  expect(doc).toContain("## Exit evidence (loop)");
  expect(doc).toContain("scripts/observability-exit-evidence.ts");
  expect(doc).toContain("docs/evidence/hv038-observability/observability-exit.json");
  const register = doc.split("## Deferred from HV-038 (with reason)")[1] ?? "";
  const bullets = register.split("\n").filter(line => line.startsWith("- "));
  expect(bullets.length).toBeGreaterThanOrEqual(15);
  for (const bullet of bullets) expect({bullet: bullet.slice(0, 60), owned: /\b(G1|G3|G7|G8|HV-032|HV-033|ADR-0020)\b/.test(bullet)}).toEqual({bullet: bullet.slice(0, 60), owned: true});
  for (const subject of ["99.9 % control-plane availability", "multi-region", "off-host destination", "continuous replication", "WAL shipping",
    "point-in-time recovery", "host-loss", "alerting", "log shipping", "kill switch", "status page", "oldest-queued-job", "unmatched",
    "enablement", "retention", "invoice", "operator console's HTTP surface", "syntheticDataOnly", "httpSurfaceRead"])
    expect({subject, present: register.toLowerCase().includes(subject.toLowerCase())}).toEqual({subject, present: true});
  for (const claim of [/\b99\.9\s*%[^.]{0,80}\b(is|was|has been)\s+(met|achieved|measured)/i, /availability (is|was) \d/i, /measured availability/i,
    /an off-host (copy|destination) (exists|is configured)/i, /host-loss recovery (has been|was) (demonstrated|proven|shown)/i,
    /off-host RPO (is|of) (five|5)/i, /\bSLO is (met|satisfied)\b/i])
    expect({claim: String(claim), matched: claim.test(doc)}).toEqual({claim: String(claim), matched: false});
  expect(doc).toMatch(/no availability figure/i);
  expect(doc).toMatch(/not_configured/);
  expect(register).toMatch(/fourteen project sub-route families/);
  // The document must never be ahead of the run: it says what the collector records, not what it has already observed.
  for (const claim of [/the exit evidence (records|recorded) what the stack actually reported/i, /\bToday: one bounded loopback burst/i,
    /the recorded run observed/i, /observability-exit\.json` records what/i])
    expect({claim: String(claim), matched: claim.test(doc)}).toEqual({claim: String(claim), matched: false});
});
