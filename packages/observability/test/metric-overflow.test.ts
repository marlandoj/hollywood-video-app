/**
 * HV-038-09 — the one series that took the whole operator console down.
 *
 * `explorer.ts` reasons carefully about a *Prometheus-side* row limit overflowing, and says exactly
 * what it costs: "metrics() fails closed as a bundle, taking the latency and failure readings down
 * with it until the next redeploy." The same thing happens one layer upstream and was not
 * considered.
 *
 * The metric views carried `aggregationCardinalityLimit: 256` over eight label keys whose declared
 * sets multiply far past it — 8 methods × 18 routes × 5 status classes is 720 for the http
 * operations alone. Past the 256th series the SDK collapses everything into one carrying
 * `otel.metric.overflow` and **no other attributes at all**. Driving only values the allow list
 * itself admits: **364 operations emitted, 256 data points kept, 109 counted in the overflow
 * bucket** — 30% of them losing `hv_operation`, `hv_provider`, `hv_outcome` and `hv_failure_code`,
 * so every per-operation error ratio was understated by whatever fell in.
 *
 * And then that one series took the console with it. `http_route!~"/api/operator/.*"` matches an
 * absent label, so every query returns the overflow row; `operationOf(undefined)` calls `invalid()`;
 * the whole reliability bundle reads `unavailable`, on a console whose job is to say what is wrong.
 */
import { expect, test } from "bun:test";
import { TelemetryExplorer, FAILURES_QUERY, LATENCY_QUERY, OPERATIONS_QUERY, PROVIDER_ATTEMPTS_QUERY } from "../src/explorer";
import { METRIC_CARDINALITY_LIMIT, OPERATION_NAMES, FAILURE_CODES, PROVIDER_KINDS, ROUTE_TEMPLATES, METRIC_STAGES } from "../src/index";

const NOW = Date.parse("2026-09-23T00:00:00Z");
const vector = (result: unknown[]) => ({status: "success", data: {resultType: "vector", result}});
const point = (metric: Record<string, string>, value: string) => ({metric, value: [NOW / 1000, value]});
const matrix = () => ({status: "success", data: {resultType: "matrix", result: []}});
/** What Prometheus renders the SDK's overflow series as: the marker, and nothing else. */
const OVERFLOW = {otel_metric_overflow: "true"};

const LATENCY = (extra: Record<string, string>[] = []) => vector([
  point({hv_operation: "job.process", quantile: "p50"}, "1200"),
  point({hv_operation: "job.process", quantile: "p95"}, "4000"),
  ...extra.map(metric => point({...metric, quantile: "p50"}, "7")),
]);
const FAILURES = (extra: Record<string, string>[] = []) => vector([
  point({hv_operation: "job.process", hv_outcome: "success"}, "3"),
  point({hv_operation: "job.process", hv_outcome: "error", hv_failure_code: "provider"}, "0.5"),
  ...extra.map(metric => point(metric, "109")),
]);
const PROVIDERS = (extra: Record<string, string>[] = []) => vector([
  point({hv_provider: "mock", hv_outcome: "success"}, "2"),
  ...extra.map(metric => point(metric, "5")),
]);
function explorer(extra: Record<string, string>[] = []) {
  return new TelemetryExplorer({enabled: true, now: () => NOW, fetch: ((url: unknown) => {
    const target = new URL(String(url));
    if (target.pathname === "/api/v1/query_range") return Response.json(matrix());
    const query = target.searchParams.get("query");
    if (query === LATENCY_QUERY) return Response.json(LATENCY(extra));
    if (query === FAILURES_QUERY) return Response.json(FAILURES(extra));
    if (query === PROVIDER_ATTEMPTS_QUERY) return Response.json(PROVIDERS(extra));
    return Response.json(vector([]));
  }) as unknown as typeof fetch});
}

test("a cardinality overflow costs the console the series it collapsed, not the console", async () => {
  // Without it: the reading every operator page is built from.
  const clean = await explorer().metrics();
  expect(clean.state).toBe("available");
  expect(clean.value!.reliability.failures).toHaveLength(1);
  expect(clean.value!.reliability.droppedSeries).toBe(0);
  // With it: before this increment, `state: "unavailable"`, `value: null`, and every row gone --
  // latency, failures, providers and the thirty-minute series with them.
  const overflowed = await explorer([OVERFLOW]).metrics();
  expect(overflowed.state).toBe("available");
  expect(overflowed.value!.reliability.failures).toEqual(clean.value!.reliability.failures);
  expect(overflowed.value!.reliability.latency).toEqual(clean.value!.reliability.latency);
  expect(overflowed.value!.reliability.providers).toEqual(clean.value!.reliability.providers);
  // And it says what it could not attribute: one collapsed series in each of the three queries.
  expect(overflowed.value!.reliability.droppedSeries).toBe(3);
});

test("and a row that is merely malformed is still refused", async () => {
  // The tolerance is for the series the SDK writes on purpose, identified by the label it writes.
  // A row with no `hv_operation` and no marker is a telemetry backend saying something this console
  // cannot read, and failing closed on that is the existing rule, unchanged.
  for (const [name, row] of [["no operation at all", {}], ["an operation outside the closed set", {hv_operation: "something.else"}],
    ["an outcome outside the closed set", {hv_operation: "job.process", hv_outcome: "maybe"}]] as const) {
    const reading = await explorer([row as Record<string, string>]).metrics();
    expect({name, state: reading.state}).toEqual({name, state: "unavailable"});
  }
});

/**
 * Every label the metrics carry, and why. A key is here because the operator console groups by it or
 * matches on it, or because it is the slice an operator asks Prometheus for directly and is worth
 * what it multiplies the series count by. `http.request.method` and `http.response.status_class`
 * were neither: together they multiplied it by forty, nothing grouped by them or matched on them,
 * and both are on the span and in the log, where one request is looked at — the log carries
 * `http.response.status_code` exactly, not the class.
 */
const METRIC_LABELS: Record<string, string> = {
  "hv.operation": "grouped by in the latency and failure queries, matched on in two more",
  "hv.outcome": "grouped by in three of the four queries",
  "hv.failure_code": "grouped by in the failure query",
  "hv.provider": "grouped by in the provider query",
  "http.route": "matched on in three queries, to keep the console's own requests out of its SLIs",
  "hv.stage": "read by no query; carried for the slice an operator asks Prometheus for by hand, at 9x",
};
test("the metric carries only the labels something reads, or names why it carries them anyway", async () => {
  const source = await Bun.file(new URL("../src/index.ts", import.meta.url)).text();
  const keys = source.match(/const METRIC_KEYS = \[([^\]]*)\]/)![1]!.split(",").map(value => value.trim().replaceAll('"', ""));
  expect(keys.sort()).toEqual(Object.keys(METRIC_LABELS).sort());
  // The five that say they are read are read, checked against the queries themselves.
  const queries = [FAILURES_QUERY, LATENCY_QUERY, PROVIDER_ATTEMPTS_QUERY, OPERATIONS_QUERY].join(" ");
  for (const [key, why] of Object.entries(METRIC_LABELS)) {
    const read = queries.includes(key.replaceAll(".", "_"));
    expect({key, read, claimed: !why.startsWith("read by no query")}).toEqual({key, read, claimed: read});
  }
  // And the two that were dropped stay where a reader can still ask about one request.
  expect(keys).not.toContain("http.request.method");
  expect(keys).not.toContain("http.response.status_class");
  expect(source).toContain('"http.response.status_class"');
  expect(await Bun.file(new URL("../src/logs.ts", import.meta.url)).text()).toContain('"http.request.method"');
});

test("and the limit is a number with its arithmetic beside it", () => {
  // 256 bounded nothing: the http family alone is 18 routes x 2 outcomes x (8 failure codes + none)
  // = 324 before any other operation exists. The limit must at least clear each family it declares.
  const outcomes = 2, codes = FAILURE_CODES.length + 1;
  const http = ROUTE_TEMPLATES.length * outcomes * codes;
  const providers = 2 * (PROVIDER_KINDS.length + 1) * (METRIC_STAGES.length + 1) * outcomes * codes;
  const others = (OPERATION_NAMES.length - 3) * (METRIC_STAGES.length + 1) * outcomes * codes;
  expect(http).toBeGreaterThan(256);
  expect({limit: METRIC_CARDINALITY_LIMIT, clears: METRIC_CARDINALITY_LIMIT > http + providers + others})
    .toEqual({limit: METRIC_CARDINALITY_LIMIT, clears: true});
  // And it is bounded: a limit is not a limit if it is large enough to be a memory hazard.
  expect(METRIC_CARDINALITY_LIMIT).toBeLessThanOrEqual(8192);
});
