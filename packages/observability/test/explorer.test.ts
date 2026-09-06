import { expect, test } from "bun:test";
import { TelemetryExplorer, OPERATIONS_QUERY } from "../src/explorer";
import { routeTemplate } from "../src/index";

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
  const end = NOW / 1000, start = end - 1800;
  const explorer = new TelemetryExplorer({enabled: true, now: () => NOW, fetch: fetcher(url => {
    expect(url.origin).toBe("http://127.0.0.1:15909"); expect(url.pathname).toBe("/api/v1/query_range");
    expect(url.searchParams.get("query")).toBe(OPERATIONS_QUERY); expect(url.searchParams.get("step")).toBe("60");
    expect(url.searchParams.get("timeout")).toBe("1s"); expect(url.searchParams.get("limit")).toBe("4");
    return Response.json({status: "success", data: {resultType: "matrix", result: [{metric: {job: "rough-cut-worker", hv_outcome: "success", private: PRIVATE},
      values: [[start, "0"], [start + 60, "0.5"], [end, "NaN"]]}]}});
  })});
  const result = await explorer.metrics();
  expect(result.state).toBe("available"); expect(result.value?.series[0]?.points).toEqual([[start * 1000, 0], [(start + 60) * 1000, .5], [end * 1000, null]]);
  expect(JSON.stringify(result)).not.toContain(PRIVATE); explorer.close();
});

test("empty metric windows remain empty; invalid matrices and partial-result warnings never become zero", async () => {
  let clock = NOW, body: any = {status: "success", data: {resultType: "matrix", result: []}};
  const explorer = new TelemetryExplorer({enabled: true, now: () => clock, fetch: fetcher(() => Response.json(body))});
  expect((await explorer.metrics()).value?.series).toEqual([]);
  const row = {metric: {job: "rough-cut-api", hv_outcome: "error"}, values: [[NOW / 1000, "1"]]};
  for (const change of [{warnings: [PRIVATE]}, {status: "error"}, {data: {resultType: "vector", result: []}},
    ...[[row, row], [{...row, metric: {job: PRIVATE, hv_outcome: "error"}}], [{...row, values: [[NOW / 1000, "-1"]]}],
      [{...row, values: [[NOW / 1000, ""]]}], [{...row, values: [[NOW / 1000, "1"], [NOW / 1000, "2"]]}]].map(result => ({data: {resultType: "matrix", result}}))]) {
    clock += 6000; body = {status: "success", data: {resultType: "matrix", result: []}, ...change};
    expect(await explorer.metrics()).toEqual({state: "unavailable", observedAt: null, value: null});
  }
  explorer.close();
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
    if (url.port === "15909") return Response.json({status: "success", data: {resultType: "matrix", result: []}});
    signal = init?.signal ?? undefined; return hung;
  })});
  const before = Date.now();
  expect((await Promise.all(Array.from({length: 12}, () => explorer.recentTraces()))).every(result => result.state === "unavailable")).toBe(true);
  expect(Date.now() - before).toBeLessThan(500); expect(calls).toBe(1); expect(signal?.aborted).toBe(true);
  expect((await explorer.trace(ID)).state).toBe("unavailable"); expect(calls).toBe(1);
  expect((await explorer.metrics()).state).toBe("available"); expect(calls).toBe(2);
  finish(Response.json({data: [fixture()]})); await new Promise(resolve => setTimeout(resolve, 5));
  // A late reply from an aborted request must not populate the successful cache.
  await explorer.recentTraces(); expect(calls).toBe(3); explorer.close();
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
