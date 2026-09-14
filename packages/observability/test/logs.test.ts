import { expect, test } from "bun:test";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { StudioTelemetry, SpanHandle } from "../src/index";
import { EVENTS, LOG_KEYS, StudioLogger, guardLine, loggerFromEnv, safeLogFields, type LogEvent, type LogLevel, type LogFields } from "../src/logs";
import { mintProjectToken } from "../../api/src/tokens";

type Line = Record<string, unknown>;
function capture(options: Partial<ConstructorParameters<typeof StudioLogger>[0]> = {}) {
  const writes: {level: LogLevel; line: string}[] = [];
  const logger = new StudioLogger({service: "worker", write: (level, line) => writes.push({level, line}), ...options});
  return {logger, writes, lines: () => writes.map(entry => JSON.parse(entry.line) as Line)};
}
function withEnv<T>(values: Record<string, string | undefined>, run: () => T): T {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) {if (value === undefined) delete process.env[key]; else process.env[key] = value;}
  try {return run();} finally {for (const [key, value] of Object.entries(previous)) {if (value === undefined) delete process.env[key]; else process.env[key] = value;}}
}
const UUID = "3f0c2f4e-9a3b-4c1d-8e7f-0123456789ab", REQUEST_ID = "9b8a7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";

test("(a) safeLogFields keeps every allow-listed valid value and drops unknown, invalid, oversized and object values with a count", () => {
  const valid = {projectId: UUID, jobId: UUID, attemptId: UUID, op: "provider.attempt", stage: "take-preview", outcome: "error", code: "provider", provider: "fal", worker: "zo-staging-worker-1",
    method: "POST", route: "/api/projects/:projectId/jobs", status: 202, jobStatus: "cancelled", leaseReason: "fence_changed", durationMs: 1234, costUsd: 0.25, shots: 3, files: 12,
    retryInSeconds: 60, port: 8080, tls: true, storage: "s3", release: "a".repeat(40), traceId: "1".repeat(32), spanId: "2".repeat(16)};
  const kept = safeLogFields(valid);
  expect(kept.dropped).toBe(0);
  expect(kept.fields).toEqual(valid as LogFields);
  for (const key of Object.keys(valid)) expect(LOG_KEYS.has(key)).toBe(true);
  const invalid = {message: "free text", jobStatus: "exploded", jobId: "job-1", worker: "w".repeat(41), durationMs: -1, route: "x".repeat(129), stage: new Error("secret"), tls: "yes", status: 99, shots: 1.5, port: 0};
  const rejected = safeLogFields({...invalid, projectId: UUID, undefinedIsAbsent: undefined});
  expect(rejected.fields).toEqual({projectId: UUID});
  expect(rejected.dropped).toBe(Object.keys(invalid).length);
  expect(safeLogFields({}).dropped).toBe(0);
});

test("(b) guardLine refuses URLs, bearer markers, signed tokens and opaque blobs and passes operational identifiers", () => {
  withEnv({HV_TOKEN_SECRET: "log-guard-fixture-secret-" + crypto.randomUUID()}, () => {
    const token = mintProjectToken(UUID);
    expect(guardLine(JSON.stringify({event: "api.request", route: "https://x"}))).toBe(false);
    expect(guardLine(JSON.stringify({authorization: "Bearer abc"}))).toBe(false);
    expect(guardLine(JSON.stringify({token}))).toBe(false);
    expect(guardLine(JSON.stringify({blob: Buffer.alloc(48, 7).toString("base64")}))).toBe(false);
    expect(Buffer.alloc(48, 7).toString("base64")).toHaveLength(64);
    expect(guardLine(JSON.stringify({jobId: UUID, traceId: "3d0568543322c70f3d0568543322c70f", release: "a1".repeat(20), worker: "zo-staging-worker-1", route: "/artifacts/:token/:projectId/:jobId/:file"}))).toBe(true);
    expect(guardLine("x".repeat(2049))).toBe(false);
  });
});

test("(c) an unknown event yields exactly one log.dropped line and never throws", () => {
  const {logger, writes, lines} = capture();
  expect(() => logger.info("api.exploded" as LogEvent, {jobId: UUID})).not.toThrow();
  expect(writes).toHaveLength(1);
  expect(writes[0]!.level).toBe("warn");
  expect(lines()[0]).toMatchObject({level: "warn", service: "worker", event: "log.dropped", dropped: 1});
  expect(Object.keys(lines()[0]!).sort()).toEqual(["dropped", "event", "level", "service", "ts"]);
  expect(EVENTS.has("api.exploded" as LogEvent)).toBe(false);
});

test("(d) below-level calls produce no line and no serialization; error lines always appear", () => {
  const {logger, writes, lines} = capture({level: "warn"});
  const poisoned = {get jobId(): string {throw new Error("serialized a below-level line");}} as LogFields;
  logger.info("worker.started", poisoned);
  logger.debug("op.finished", poisoned);
  expect(writes).toHaveLength(0);
  logger.error("worker.job_finished", {jobId: UUID, jobStatus: "failed"});
  logger.warn("worker.lease_lost", {leaseReason: "lease_expired"});
  expect(lines().map(line => line.event)).toEqual(["worker.job_finished", "worker.lease_lost"]);
  const quiet = capture({level: "error"});
  quiet.logger.warn("worker.lease_lost", poisoned);
  expect(quiet.writes).toHaveLength(0);
});

test("(e) HV_LOG_SAMPLE=0 suppresses only debug and sub-400 api.request lines; a fixed traceId decides deterministically", () => {
  const {logger, lines} = capture({sample: 0});
  logger.debug("op.finished", {op: "media.assemble"});
  logger.info("api.request", {method: "GET", route: "/health", status: 200});
  logger.info("api.request", {method: "GET", route: "/health", status: 503});
  logger.info("worker.job_finished", {jobStatus: "done"});
  logger.info("op.finished", {op: "provider.attempt", provider: "mock"});
  logger.warn("worker.heartbeat_failed");
  logger.error("retention.failed", {retryInSeconds: 60});
  expect(lines().map(line => [line.event, line.status ?? line.op ?? null])).toEqual([["api.request", 503], ["worker.job_finished", null], ["op.finished", "provider.attempt"], ["worker.heartbeat_failed", null], ["retention.failed", null]]);
  const low = "00-" + "a".repeat(24) + "00000001" + "-" + "b".repeat(16) + "-01", high = "00-" + "a".repeat(24) + "ffffffff" + "-" + "b".repeat(16) + "-01";
  for (const carrier of [low, high]) {
    const results = new Set<number>();
    for (let round = 0; round < 5; round++) {
      const trial = capture({sample: 0.5, carrier: () => carrier});
      trial.logger.info("api.request", {method: "GET", route: "/health", status: 200});
      results.add(trial.writes.length);
    }
    expect(results.size).toBe(1);
    expect([...results][0]).toBe(carrier === low ? 1 : 0);
  }
});

test("(f) env parsing falls back to safe defaults and reports invalid values once", () => {
  const observed = () => {
    const writes: string[] = [];
    const original = console.error;
    console.error = (line: string) => {writes.push(line);};
    try {return {logger: loggerFromEnv("api"), writes};} finally {console.error = original;}
  };
  const verbose = withEnv({HV_LOG_LEVEL: "verbose", HV_LOG_SAMPLE: undefined, HV_RELEASE_SHA: undefined}, observed);
  expect(verbose.logger.level).toBe("info");
  expect(verbose.writes.map(line => (JSON.parse(line) as Line).event)).toEqual(["log.configuration_invalid"]);
  for (const [raw, expected] of [["abc", 1], ["2", 1], ["-1", 0]] as const) {
    const parsed = withEnv({HV_LOG_LEVEL: undefined, HV_LOG_SAMPLE: raw, HV_RELEASE_SHA: undefined}, observed);
    expect(parsed.logger.sample).toBe(expected);
    expect(parsed.writes).toHaveLength(1);
  }
  const clean = withEnv({HV_LOG_LEVEL: "debug", HV_LOG_SAMPLE: "0.25", HV_RELEASE_SHA: "f".repeat(40)}, observed);
  expect(clean.logger.level).toBe("debug");
  expect(clean.logger.sample).toBe(0.25);
  expect(clean.writes).toHaveLength(0);
});

test("(g) trace correlation comes from the ambient span, an explicit SpanHandle wins, and a disabled telemetry emits without ids", async () => {
  const exporter = new InMemorySpanExporter();
  const telemetry = new StudioTelemetry({service: "api", spanExporter: exporter});
  const {logger, lines} = capture({level: "debug", carrier: () => telemetry.carrier()});
  try {
    logger.info("api.started", {port: 8080, tls: false, storage: "json"});
    expect(lines()[0]).not.toHaveProperty("traceId");
    expect(lines()[0]).not.toHaveProperty("spanId");
    let expected: string[] = [];
    await telemetry.run("http.request", {"http.request.method": "GET", "http.route": "/health"}, async () => {
      expected = telemetry.carrier()!.split("-");
      logger.info("api.request", {method: "GET", route: "/health", status: 200});
      const explicit = telemetry.start("media.assemble", {});
      logger.debug("op.finished", {op: "media.assemble"}, explicit);
      const other = explicit.carrier()!.split("-");
      explicit.end();
      expect(lines()[2]).toMatchObject({traceId: other[1], spanId: other[2]});
      expect(other[2]).not.toBe(expected[2]);
    });
    expect(lines()[1]).toMatchObject({traceId: expected[1], spanId: expected[2]});
    logger.info("api.request", {method: "GET", route: "/health", status: 200});
    expect(lines()[3]).not.toHaveProperty("traceId");
  } finally {await telemetry.shutdown();}
  const disabled = new StudioTelemetry({service: "worker", enabled: false});
  const off = capture({carrier: () => disabled.carrier()});
  await disabled.run("job.process", {}, async span => {off.logger.info("worker.job_started", {jobId: UUID}, span);});
  expect(off.lines()).toHaveLength(1);
  expect(off.lines()[0]).toMatchObject({event: "worker.job_started", jobId: UUID});
  expect(off.lines()[0]).not.toHaveProperty("traceId");
  const detached = new SpanHandle();
  off.logger.info("worker.stopped", {}, detached);
  expect(off.lines()[1]).not.toHaveProperty("spanId");
});

test("(h) the telemetry hook logs completed provider attempts at info and skips http.request and job.process", async () => {
  const exporter = new InMemorySpanExporter();
  const telemetry = new StudioTelemetry({service: "worker", spanExporter: exporter});
  const {logger, writes, lines} = capture({level: "debug"});
  logger.attach(telemetry);
  try {
    await telemetry.run("job.process", {"hv.job.id": UUID, "hv.project.id": UUID, "hv.stage": "animatic"}, async () => {
      await telemetry.run("provider.attempt", {"hv.attempt.id": UUID, "hv.provider": "mock", "hv.provider.request_id": REQUEST_ID, "hv.job.id": UUID}, async span => {span.fail("provider");});
      await telemetry.run("media.checkpoint", {"hv.job.id": UUID, "hv.checkpoint.shots": 2}, async () => {});
    });
    await telemetry.http(new Request("http://127.0.0.1/health"), async () => new Response("ok"));
    await telemetry.flush();
    const spans = exporter.getFinishedSpans();
    const attempt = spans.find(span => span.name === "provider.attempt")!;
    expect(spans.map(span => span.name).sort()).toEqual(["http.request", "job.process", "media.checkpoint", "provider.attempt"]);
    expect(lines().map(line => line.event)).toEqual(["op.finished", "op.finished"]);
    expect(writes[0]!.level).toBe("info");
    expect(lines()[0]).toMatchObject({level: "info", service: "worker", op: "provider.attempt", provider: "mock", attemptId: UUID, jobId: UUID, outcome: "error", code: "provider", traceId: attempt.spanContext().traceId, spanId: attempt.spanContext().spanId});
    expect(Number.isInteger(lines()[0]!.durationMs) && Number(lines()[0]!.durationMs) >= 0).toBe(true);
    expect(lines()[0]).not.toHaveProperty("dropped");
    expect(lines()[1]).toMatchObject({level: "debug", op: "media.checkpoint", shots: 2, outcome: "success"});
    expect(JSON.stringify(lines())).not.toContain("hv.");
    expect(JSON.stringify(lines())).not.toContain(REQUEST_ID);
  } finally {await telemetry.shutdown();}
});

test("(i) warn and error lines go to stderr, info and debug to stdout", () => {
  const out: string[] = [], err: string[] = [];
  const originalLog = console.log, originalError = console.error;
  console.log = (line: string) => {out.push(line);}; console.error = (line: string) => {err.push(line);};
  try {
    const logger = new StudioLogger({service: "retention", level: "debug"});
    logger.debug("op.finished", {op: "project.archive"}); logger.info("api.started", {port: 1, tls: true, storage: "postgres"});
    logger.warn("worker.heartbeat_failed"); logger.error("retention.failed", {retryInSeconds: 60});
  } finally {console.log = originalLog; console.error = originalError;}
  expect(out.map(line => (JSON.parse(line) as Line).level)).toEqual(["debug", "info"]);
  expect(err.map(line => (JSON.parse(line) as Line).level)).toEqual(["warn", "error"]);
  for (const line of [...out, ...err]) {
    const parsed = JSON.parse(line) as Line;
    expect(Object.keys(parsed).slice(0, 4)).toEqual(["ts", "level", "service", "event"]);
    expect(parsed.service).toBe("retention");
    expect(Number.isNaN(Date.parse(String(parsed.ts)))).toBe(false);
    expect(Object.keys(parsed).every(key => LOG_KEYS.has(key))).toBe(true);
  }
});

test("(j) a line over the 2048-byte cap becomes log.suppressed carrying the withheld field count", () => {
  const {logger, writes, lines} = capture({service: "api", release: "c".repeat(40), carrier: () => "00-" + "d".repeat(32) + "-" + "e".repeat(16) + "-01"});
  const padded = {method: "GET", route: "/health", status: 200, durationMs: 1, worker: "w".repeat(40), projectId: UUID, jobId: UUID, attemptId: UUID, stage: "animatic", op: "media.assemble", outcome: "success", code: "internal", provider: "mock", jobStatus: "done", leaseReason: "not_running", costUsd: 1, shots: 1, files: 1, retryInSeconds: 1, port: 1, tls: true, storage: "s3"} satisfies LogFields;
  logger.info("api.request", padded);
  expect(Buffer.byteLength(writes[0]!.line)).toBeLessThanOrEqual(2048);
  expect(lines()[0]).toMatchObject({event: "api.request", release: "c".repeat(40), traceId: "d".repeat(32)});
  expect(Object.keys(lines()[0]!)).toHaveLength(Object.keys(padded).length + 7);
  // Every allow-listed value is bounded, so a full line stays under the cap; widen the serializer for one call to reach it.
  const original = JSON.stringify;
  JSON.stringify = ((value: unknown) => {const line = original(value); return (value as Line).event === "api.request" ? line.slice(0, -1) + ",\"worker\":\"" + "x".repeat(2100) + "\"}" : line;}) as typeof JSON.stringify;
  try {logger.info("api.request", padded);} finally {JSON.stringify = original;}
  const last = lines().at(-1)!;
  expect(writes).toHaveLength(2);
  expect(writes[1]!.level).toBe("error");
  expect(last).toMatchObject({level: "error", service: "api", event: "log.suppressed"});
  expect(Object.keys(last).sort()).toEqual(["dropped", "event", "level", "service", "ts"]);
  expect(last.dropped).toBe(Object.keys(padded).length + 3);
});
