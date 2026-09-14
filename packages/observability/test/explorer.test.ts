import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { TelemetryExplorer, OPERATIONS_QUERY, LATENCY_QUERY, FAILURES_QUERY, PROVIDER_ATTEMPTS_QUERY, CEILING_MS } from "../src/explorer";
import { routeTemplate, DURATION_BOUNDARIES_MS } from "../src/index";

const NOW = Date.parse("2026-09-06T03:00:00Z");
const ID = "1234567890abcdef1234567890abcdef", JOB = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const PRIVATE = "screenplay-and-capability-must-not-escape";
const tag = (key: string, value: unknown) => ({key, value, type: typeof value});
function fixture(count = 2): any {
  return {traceID: ID, processes: {api: {serviceName: "rough-cut-api", tags: [tag("secret", PRIVATE)]}, worker: {serviceName: "rough-cut-worker"}},
    spans: Array.from({length: count}, (_, i) => ({traceID: ID, spanID: (i + 1).toString(16).padStart(16, "0"), processID: i ? "worker" : "api",
      operationName: i ? "job.process" : "http.request", startTime: (NOW - 10_000 + i * 100) * 1000, duration: 50_000,
      tags: [tag("hv.job.id", JOB), tag("hv.stage", "animatic"), tag("hv.outcome", "success"), tag("prompt", PRIVATE), tag("http.url", PRIVATE)],
      references: i ? [{refType: "CHILD_OF", traceID: ID, spanID: "0000000000000001"}] : [], logs: [{fields: [tag("error", PRIVATE)]}], warnings: [PRIVATE]}))};
}
const fetcher = (operation: (url: URL, init?: RequestInit) => Response | Promise<Response>) => ((url: any, init: any) => operation(new URL(String(url)), init)) as typeof fetch;

// The four fixed queries of one metrics bundle, and the synthetic replies each of them gets.
const vector = (result: any[]) => ({status: "success", data: {resultType: "vector", result}});
const point = (metric: any, value: string) => ({metric, value: [NOW / 1000, value]});
const matrix = (result: any[] = []) => ({status: "success", data: {resultType: "matrix", result}});
const LATENCY = vector([point({hv_operation: "job.process", quantile: "p50"}, "1200"), point({hv_operation: "job.process", quantile: "p95"}, "600000"),
  point({hv_operation: "job.process", quantile: "p99"}, "NaN"), point({hv_operation: "http.request", quantile: "p50", private_label: PRIVATE}, "12.5")]);
const FAILURES = vector([point({hv_operation: "job.process", hv_outcome: "success"}, "3"), point({hv_operation: "job.process", hv_outcome: "error", hv_failure_code: "provider"}, "0.5"),
  point({hv_operation: "job.process", hv_outcome: "error", hv_failure_code: ""}, "0.5"), point({hv_operation: "media.publish", hv_outcome: "success"}, "0")]);
const PROVIDERS = vector([point({hv_provider: "mock", hv_outcome: "success"}, "2"), point({hv_provider: "fal", hv_outcome: "error"}, "1")]);
const QUANTILE_CYCLE = ["p50", "p95", "p99"] as const;
const evidence: {states: Record<string, string>; caps: Record<string, number>} = {states: {}, caps: {}};
const record = (name: string, state: string) => {evidence.states[name] = state; return state;};
function bundle(overrides: {range?: any; latency?: any; failures?: any; providers?: any} = {}, seen?: URL[]) {
  return fetcher(url => {
    seen?.push(url);
    if (url.pathname === "/api/v1/query_range") return Response.json(overrides.range ?? matrix());
    const query = url.searchParams.get("query");
    if (query === LATENCY_QUERY) return Response.json(overrides.latency ?? LATENCY);
    if (query === FAILURES_QUERY) return Response.json(overrides.failures ?? FAILURES);
    if (query === PROVIDER_ATTEMPTS_QUERY) return Response.json(overrides.providers ?? PROVIDERS);
    throw new Error("unexpected query");
  });
}

test("fixed trace searches preserve safe job correlation while dropping all raw tags, events and warnings", async () => {
  const requests: URL[] = [], example = fixture();
  example.spans.push({...example.spans[0], operationName: PRIVATE});
  const explorer = new TelemetryExplorer({enabled: true, now: () => NOW, fetch: fetcher((url, init) => {
    requests.push(url); expect(url.origin).toBe("http://127.0.0.1:15686"); expect(init?.redirect).toBe("error");
    expect(init?.credentials).toBe("omit"); expect(new Headers(init?.headers).get("authorization")).toBeNull();
    return Response.json({data: [example]});
  })});
  const list = await explorer.recentTraces(JOB.toUpperCase());
  expect(list.state).toBe("available"); expect(list.value?.traces).toHaveLength(1);
  expect(list.value?.traces[0]?.jobId).toBe(JOB); expect(list.value?.traces[0]).not.toHaveProperty("spans");
  expect(requests[0]!.searchParams.get("service")).toBe("rough-cut-worker"); expect(requests[0]!.searchParams.get("operation")).toBe("job.process");
  expect(requests[0]!.searchParams.get("tags")).toBe(JSON.stringify({"hv.job.id": JOB}));
  expect(requests[0]!.searchParams.get("limit")).toBe("20"); expect(requests[0]!.searchParams.get("start")).toBe(String((NOW - 86_400_000) * 1000));
  const detail = await explorer.trace(ID);
  expect(detail.value?.spans[1]?.parentId).toBe(detail.value?.spans[0]?.id ?? "wrong");
  expect(detail.value?.durationMs).toBe(150); expect(detail.value?.outcome).toBe("success");
  expect(JSON.stringify([list, detail])).not.toContain(PRIVATE);
  expect(routeTemplate("/api/operator/traces/" + ID)).toBe("/api/operator/traces/:traceId");
  expect(routeTemplate("/api/operator/metrics")).toBe("/api/operator/metrics"); explorer.close();
});

test("missing traces, filtered jobs and a disabled explorer report their distinct honest states", async () => {
  let calls = 0;
  const disabled = new TelemetryExplorer({enabled: false, fetch: fetcher(() => {calls++; throw new Error("unexpected");})});
  expect((await disabled.metrics()).state).toBe("not_configured"); expect((await disabled.trace(ID)).state).toBe("not_configured"); expect(calls).toBe(0);
  const missing = new TelemetryExplorer({enabled: true, fetch: fetcher(() => new Response(PRIVATE, {status: 404}))});
  expect(await missing.trace(ID)).toMatchObject({state: "available", value: null});
  expect((await missing.recentTraces()).state).toBe("unavailable");
  const filtered = new TelemetryExplorer({enabled: true, fetch: fetcher(() => Response.json({data: [fixture()]}))});
  expect((await filtered.recentTraces("bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee")).value?.traces).toEqual([]);
  for (const id of ["", "0".repeat(32), "../api/services", "a".repeat(33), PRIVATE]) expect(() => filtered.trace(id)).toThrow("invalid trace ID");
  expect(() => filtered.recentTraces("anything\"}" )).toThrow("invalid job ID");
  disabled.close(); missing.close(); filtered.close();
});

test("large valid traces have an explicit display limit and malformed or mismatched backend records fail closed", async () => {
  let value: any = {data: [fixture(501)]}, clock = NOW;
  const explorer = new TelemetryExplorer({enabled: true, now: () => clock, fetch: fetcher(() => Response.json(value))});
  const result = await explorer.trace(ID);
  expect(result.value?.limited).toBe(true); expect(result.value?.spanCount).toBe(501); expect(result.value?.spans).toHaveLength(500);
  const duplicate = fixture(); duplicate.spans[1].spanID = duplicate.spans[0].spanID;
  for (const bad of [{data: [duplicate]}, {data: [fixture()], errors: [{msg: PRIVATE}]}, {data: [fixture(), fixture()]},
    {data: [{...fixture(), traceID: "f".repeat(32)}]}, {data: [{...fixture(), spans: [{}]}]}, {data: [{...fixture(), spans: Array(2049).fill({})}]}]) {
    clock += 6000; value = bad; expect(await explorer.trace(ID)).toEqual({state: "unavailable", observedAt: null, value: null});
  }
  explorer.close();
});

test("metrics use the fixed rate query and retain missing samples without leaking backend labels", async () => {
  const end = NOW / 1000, start = end - 1800, requests: URL[] = [];
  const range = matrix([{metric: {job: "rough-cut-worker", hv_outcome: "success", private_label: PRIVATE}, values: [[start, "0"], [start + 60, "0.5"], [end, "NaN"]]}]);
  const explorer = new TelemetryExplorer({enabled: true, now: () => NOW, fetch: bundle({range}, requests)});
  const result = await explorer.metrics();
  expect(result.state).toBe("available"); expect(result.value?.series[0]?.points).toEqual([[start * 1000, 0], [(start + 60) * 1000, .5], [end * 1000, null]]);
  expect(requests.map(url => url.origin + url.pathname)).toEqual(["http://127.0.0.1:15909/api/v1/query_range",
    ...Array(3).fill("http://127.0.0.1:15909/api/v1/query")]);
  expect(requests[0]!.searchParams.get("query")).toBe(OPERATIONS_QUERY); expect(requests[0]!.searchParams.get("step")).toBe("60");
  expect(requests[0]!.searchParams.get("limit")).toBe("4"); expect(requests[0]!.searchParams.get("end")).toBe(String(end));
  for (const [index, [query, limit]] of ([[LATENCY_QUERY, "30"], [FAILURES_QUERY, "128"], [PROVIDER_ATTEMPTS_QUERY, "8"]] as const).entries()) {
    const url = requests[index + 1]!;
    expect(url.searchParams.get("query")).toBe(query); expect(url.searchParams.get("limit")).toBe(limit);
    expect(url.searchParams.get("time")).toBe(String(end)); expect(url.searchParams.get("start")).toBeNull();
  }
  for (const url of requests) expect(url.searchParams.get("timeout")).toBe("1s");
  evidence.caps = {latency: 30, failures: 128, providers: 8, series: 4};
  expect(JSON.stringify(result)).not.toContain(PRIVATE); expect(record("available", result.state)).toBe("available"); explorer.close();
});

test("the reliability bundle reports percentiles, ceilings, failure codes and provider attempt rates", async () => {
  const explorer = new TelemetryExplorer({enabled: true, now: () => NOW, fetch: bundle()});
  const value = (await explorer.metrics()).value!.reliability;
  expect(value.windowSeconds).toBe(300); expect(value.ceilingMs).toBe(CEILING_MS); expect(CEILING_MS).toBe(DURATION_BOUNDARIES_MS.at(-1)!);
  expect(value.evaluatedAt).toBe(new Date(NOW).toISOString());
  expect(value.latency).toEqual([{operation: "http.request", p50Ms: 12.5, p95Ms: null, p99Ms: null, capped: false},
    {operation: "job.process", p50Ms: 1200, p95Ms: 600_000, p99Ms: null, capped: true}]);
  expect(value.failures).toEqual([{operation: "job.process", successPerMinute: 3, errorPerMinute: 1, errorRatio: .25, codes: {provider: .5, unknown: .5}},
    {operation: "media.publish", successPerMinute: 0, errorPerMinute: 0, errorRatio: null, codes: {}}]);
  expect(value.providers).toEqual([{provider: "fal", successPerMinute: 0, errorPerMinute: 1, errorRatio: 1},
    {provider: "mock", successPerMinute: 2, errorPerMinute: 0, errorRatio: 0}]);
  expect(JSON.stringify(value)).not.toContain(PRIVATE); explorer.close();
});

test("empty metric windows remain empty; invalid matrices and partial-result warnings never become zero", async () => {
  let clock = NOW, body: any = matrix();
  const explorer = new TelemetryExplorer({enabled: true, now: () => clock,
    fetch: fetcher(url => Response.json(url.pathname === "/api/v1/query_range" ? body : url.searchParams.get("query") === LATENCY_QUERY ? LATENCY
      : url.searchParams.get("query") === FAILURES_QUERY ? FAILURES : PROVIDERS))});
  expect((await explorer.metrics()).value?.series).toEqual([]);
  const row = {metric: {job: "rough-cut-api", hv_outcome: "error"}, values: [[NOW / 1000, "1"]]};
  for (const change of [{warnings: [PRIVATE]}, {status: "error"}, {data: {resultType: "vector", result: []}},
    ...[[row, row], [{...row, metric: {job: PRIVATE, hv_outcome: "error"}}], [{...row, values: [[NOW / 1000, "-1"]]}],
      [{...row, values: [[NOW / 1000, ""]]}], [{...row, values: [[NOW / 1000, "1"], [NOW / 1000, "2"]]}]].map(result => ({data: {resultType: "matrix", result}}))]) {
    clock += 6000; body = {...matrix(), ...change};
    expect(await explorer.metrics()).toEqual({state: "unavailable", observedAt: null, value: null});
  }
  explorer.close();
});

test("every malformed reliability row fails the whole bundle closed rather than reporting part of it", async () => {
  let clock = NOW;
  const rows = (count: number, build: (index: number) => any) => vector(Array.from({length: count}, (_, index) => build(index)));
  const cases: [string, {latency?: any; failures?: any; providers?: any}][] = [
    ["unknownOperation", {latency: vector([point({hv_operation: "attacker.operation", quantile: "p50"}, "1")])}],
    ["unknownQuantile", {latency: vector([point({hv_operation: "job.process", quantile: "p999"}, "1")])}],
    ["duplicateLatencyRow", {latency: vector([point({hv_operation: "job.process", quantile: "p50"}, "1"), point({hv_operation: "job.process", quantile: "p50"}, "2")])}],
    ["unknownFailureCode", {failures: vector([point({hv_operation: "job.process", hv_outcome: "error", hv_failure_code: PRIVATE}, "1")])}],
    ["failureCodeOnSuccess", {failures: vector([point({hv_operation: "job.process", hv_outcome: "success", hv_failure_code: "provider"}, "1")])}],
    ["unknownProvider", {providers: vector([point({hv_provider: "attacker", hv_outcome: "success"}, "1")])}],
    ["matrixWhereVectorExpected", {latency: matrix()}],
    ["truncationWarning", {failures: {...FAILURES, warnings: ["results truncated"]}}],
    ["rowCapExceeded", {latency: rows(31, index => point({hv_operation: "job.process", quantile: QUANTILE_CYCLE[index % 3]}, String(index)))}],
    ["failureRowCapExceeded", {failures: rows(129, index => point({hv_operation: "job.process", hv_outcome: "error", hv_failure_code: "provider", extra: String(index)}, "1"))}],
    ["providerRowCapExceeded", {providers: rows(9, index => point({hv_provider: "mock", hv_outcome: "success", extra: String(index)}, "1"))}],
    ["fourthQueryOnly", {providers: {status: "error", data: {resultType: "vector", result: []}}}],
  ];
  for (const [name, override] of cases) {
    clock += 6000;
    const explorer = new TelemetryExplorer({enabled: true, now: () => clock, fetch: bundle(override)});
    const reading = await explorer.metrics();
    expect(record(name, reading.state)).toBe("unavailable");
    expect(reading).toEqual({state: "unavailable", observedAt: null, value: null});
    expect(JSON.stringify(reading)).not.toContain(PRIVATE); explorer.close();
  }
  const disabled = new TelemetryExplorer({enabled: false, fetch: bundle()});
  expect(record("notConfigured", (await disabled.metrics()).state)).toBe("not_configured"); disabled.close();
});

test("the four queries share one pending slot, one deadline and one five-second cache entry", async () => {
  let calls = 0, signal: AbortSignal | undefined, clock = NOW;
  const hung = new Promise<Response>(() => {});
  const explorer = new TelemetryExplorer({enabled: true, timeoutMs: 40, now: () => clock, fetch: fetcher((url, init) => {
    calls++;
    if (url.searchParams.get("query") === FAILURES_QUERY) {signal = init?.signal ?? undefined; return hung;}
    if (url.port === "15686") return Response.json({data: []});
    return Response.json(url.pathname === "/api/v1/query_range" ? matrix() : LATENCY);
  })});
  const started = Date.now();
  const readings = await Promise.all(Array.from({length: 12}, () => explorer.metrics()));
  expect(readings.every(reading => reading.state === "unavailable")).toBe(true);
  expect(Date.now() - started).toBeLessThan(1000); expect(calls).toBe(3); expect(signal?.aborted).toBe(true);
  expect((await explorer.recentTraces()).state).toBe("available"); expect(calls).toBe(4);
  explorer.close();
  let bundles = 0;
  const inner = bundle();
  const cached = new TelemetryExplorer({enabled: true, now: () => clock, fetch: ((url: any, init: any) => {
    if (String(url).includes("query_range")) bundles++;
    return inner(url, init);
  }) as typeof fetch});
  await Promise.all(Array.from({length: 6}, () => cached.metrics()));
  await cached.metrics(); expect(bundles).toBe(1);
  clock += 6000; await cached.metrics(); expect(bundles).toBe(2); cached.close();
});

test("decoded response bounds cover declared and chunked bodies; redirects and backend errors are contained", async () => {
  for (const response of [new Response(PRIVATE, {status: 500}), new Response(null, {status: 302, headers: {location: "https://example.invalid/"}}),
    new Response("{}", {headers: {"content-length": String(5 * 1024 * 1024)}}),
    new Response(new ReadableStream({start(controller) {for (let i = 0; i < 5; i++) controller.enqueue(new Uint8Array(1024 * 1024)); controller.close();}})),
    new Response("{invalid")]) {
    const explorer = new TelemetryExplorer({enabled: true, fetch: fetcher(() => response)});
    expect(await explorer.recentTraces()).toEqual({state: "unavailable", observedAt: null, value: null}); explorer.close();
  }
});

test("a hung fetch has bounded replies and one backend slot, while metrics can still respond", async () => {
  let calls = 0, finish!: (value: Response) => void, signal: AbortSignal | undefined;
  const hung = new Promise<Response>(resolve => {finish = resolve;});
  const explorer = new TelemetryExplorer({enabled: true, timeoutMs: 25, fetch: fetcher((url, init) => {
    calls++;
    if (url.port === "15909") return Response.json(url.pathname === "/api/v1/query_range" ? {status: "success", data: {resultType: "matrix", result: []}}
      : url.searchParams.get("query") === LATENCY_QUERY ? LATENCY : url.searchParams.get("query") === FAILURES_QUERY ? FAILURES : PROVIDERS);
    signal = init?.signal ?? undefined; return hung;
  })});
  const before = Date.now();
  expect((await Promise.all(Array.from({length: 12}, () => explorer.recentTraces()))).every(result => result.state === "unavailable")).toBe(true);
  expect(Date.now() - before).toBeLessThan(500); expect(calls).toBe(1); expect(signal?.aborted).toBe(true);
  expect((await explorer.trace(ID)).state).toBe("unavailable"); expect(calls).toBe(1);
  expect((await explorer.metrics()).state).toBe("available"); expect(calls).toBe(5);
  finish(Response.json({data: [fixture()]})); await new Promise(resolve => setTimeout(resolve, 5));
  // A late reply from an aborted request must not populate the successful cache.
  await explorer.recentTraces(); expect(calls).toBe(6); explorer.close();
  expect((await explorer.metrics()).state).toBe("unavailable");
});

test("short caches coalesce refreshes, expire, and never retain a prior value as a fresh failed reading", async () => {
  let clock = NOW, calls = 0, fail = false;
  const explorer = new TelemetryExplorer({enabled: true, now: () => clock, fetch: fetcher(() => {
    calls++; if (fail) throw new Error(PRIVATE); return Response.json({data: [fixture()]});
  })});
  await Promise.all(Array.from({length: 10}, () => explorer.recentTraces())); expect(calls).toBe(1);
  await explorer.recentTraces(); expect(calls).toBe(1);
  clock += 6000; fail = true;
  expect(await explorer.recentTraces()).toEqual({state: "unavailable", observedAt: null, value: null}); expect(calls).toBe(2); explorer.close();
});

// Records only what this run observed; the backend contract and browser blocks stay honestly pending.
test("the observed reliability state matrix is written when an evidence path is named", () => {
  const path = process.env.HV_RELIABILITY_EVIDENCE;
  expect(Object.values(evidence.states).filter(state => state === "unavailable")).toHaveLength(12);
  expect(evidence.states.available).toBe("available"); expect(evidence.states.notConfigured).toBe("not_configured");
  if (!path) return;
  const value = {schema: "hv-reliability-panel/1", recordedAt: new Date().toISOString(),
    command: "HV_RELIABILITY_EVIDENCE=" + path + " bun test packages/observability/test/explorer.test.ts",
    syntheticDataOnly: true, newProviderSpendUsd: 0,
    queries: {latency: LATENCY_QUERY, failures: FAILURES_QUERY, providerAttempts: PROVIDER_ATTEMPTS_QUERY, operations: OPERATIONS_QUERY},
    rowCaps: evidence.caps, instantQueryTimeout: "1s", windowSeconds: 300, ceilingMs: CEILING_MS,
    durationBoundariesMs: [...DURATION_BOUNDARIES_MS], stateMatrix: evidence.states,
    backendContract: {state: "pending", job: "telemetry-contract", note: "Filled from the PR head's telemetry-contract run after CI."},
    browserChecks: {state: "pending", note: "No browser is installed in this build environment; see the increment's build notes for the served-route checks that were run instead."}};
  mkdirSync(dirname(path), {recursive: true}); writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
});
