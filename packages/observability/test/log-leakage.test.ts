import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { InMemorySpanExporter } from "@opentelemetry/sdk-trace-base";
import { StudioTelemetry } from "../src/index";
import { LOG_KEYS, StudioLogger, type LogLevel } from "../src/logs";
import { createApiServer } from "../../api/src/server";
import { DurableJobStore } from "../../queue/src/index";
import { processNextJob } from "../../queue/src/worker";
import { CostLedger, OperatorReviewQueue } from "../../operator/src/index";
import type { ProviderAdapter, VideoClip } from "../../generator/src/index";

type Line = Record<string, unknown>;
const EVIDENCE_COMMAND = "HV_STRUCTURED_LOGS_EVIDENCE=docs/evidence/hv038-observability/structured-logs.json bun test packages/observability/test/log-leakage.test.ts";

test("a real request and a real job with canaries leave only schema keys, trace ids and bounded values on every log line", async () => {
  const directory = mkdtempSync(join(tmpdir(), "hv-log-leakage-"));
  const previous = {token: process.env.HV_TOKEN_SECRET, provider: process.env.HV_ANIMATIC_PROVIDER, narration: process.env.HV_NARRATION};
  const tokenSecret = "leakage-fixture-signing-secret-" + crypto.randomUUID();
  process.env.HV_TOKEN_SECRET = tokenSecret; process.env.HV_ANIMATIC_PROVIDER = "legacy-mock"; process.env.HV_NARRATION = "0";
  const exporter = new InMemorySpanExporter();
  const apiTelemetry = new StudioTelemetry({service: "api", spanExporter: exporter});
  const workerTelemetry = new StudioTelemetry({service: "worker", spanExporter: exporter});
  const captured: {service: string; level: LogLevel; line: string}[] = [];
  const sink = (service: string) => (level: LogLevel, line: string) => {captured.push({service, level, line});};
  const apiLogger = new StudioLogger({service: "api", level: "debug", write: sink("api")}).attach(apiTelemetry);
  const workerLogger = new StudioLogger({service: "worker", level: "debug", write: sink("worker")}).attach(workerTelemetry);
  const queue = join(directory, "jobs.json"), ledger = join(directory, "costs.json"), media = join(directory, "media");
  const server = createApiServer({port: 0, hostname: "127.0.0.1", tls: null, telemetry: apiTelemetry, logger: apiLogger,
    queuePath: queue, statePath: join(directory, "projects.json"), costLedgerPath: ledger, artifactRoot: media});
  const screenplaySentinel = "private-screenplay-sentinel-" + crypto.randomUUID().slice(0, 8);
  const bodySentinel = "malformed_body_sentinel_" + crypto.randomUUID().slice(0, 8).replaceAll("-", "");
  const adapterSentinel = "adapter-error-sentinel-" + crypto.randomUUID().slice(0, 8);
  const providerUrl = "https://provider.example/?key=SECRET";
  const workerIncarnation = "zo-staging-worker-1-" + crypto.randomUUID();
  const throwing: ProviderAdapter = {name: "broken", model: "b", generate: (): Promise<VideoClip> => Promise.reject(new Error(`${adapterSentinel} while calling ${providerUrl}`))};
  const store = new DurableJobStore(queue);
  const context = {telemetry: workerTelemetry, logger: workerLogger, workerName: "zo-staging-worker-1", workerId: workerIncarnation, animaticProvider: throwing,
    ledger: new CostLedger(ledger), reviewQueue: new OperatorReviewQueue(join(directory, "reviews.json"))};
  const call = async (path: string, method = "GET", token?: string, body?: string) => await fetch(new URL(path, server.url), {method,
    headers: {"content-type": "application/json", ...(token ? {authorization: "Bearer " + token} : {})}, ...(body === undefined ? {} : {body})});
  const request = async (path: string, method = "GET", token?: string, body?: unknown) => {
    const response = await call(path, method, token, body === undefined ? undefined : JSON.stringify(body));
    expect(response.ok).toBe(true); return await response.json() as any;
  };
  try {
    const owner = await request("/api/projects", "POST");
    const screenplay = `EXT. GARDEN - DAY\n\nA paper lantern carries the ${screenplaySentinel} across a quiet path.`;
    await request(`/api/projects/${owner.projectId}/script`, "PUT", owner.token, {text: screenplay});
    const malformed = await call(`/api/projects/${owner.projectId}/script`, "PUT", owner.token, `{"text": ${bodySentinel}}`);
    expect(malformed.status).toBe(400);
    expect(await malformed.text()).toContain(bodySentinel);
    await request(`/api/projects/${owner.projectId}/rights`, "POST", owner.token, {attested: true});
    const preview = await request(`/api/projects/${owner.projectId}/jobs`, "POST", owner.token, {idempotencyKey: "leakage-preview"});
    const missing = await call(`/api/jobs/${crypto.randomUUID()}`, "GET", owner.token);
    expect(missing.status).toBe(404);
    expect((await processNextJob(store, media, context))?.status).toBe("done");
    const view = await request(`/api/jobs/${preview.jobId}`, "GET", owner.token);
    const artifactPath: string = view.output.mp4Url;
    const artifactToken = artifactPath.split("/")[2]!;
    expect(artifactPath).toBe(`/artifacts/${artifactToken}/${owner.projectId}/${preview.jobId}/export.mp4`);
    const artifact = await call(artifactPath);
    expect(artifact.status).toBe(200);
    const link = await request(`/api/projects/${owner.projectId}/reviews`, "POST", owner.token, {permission: "read"});
    const review = await request(`/api/reviews/${encodeURIComponent(link.token)}`);
    expect(review.jobId).toBe(preview.jobId);
    const failingId = crypto.randomUUID();
    store.enqueue({id: failingId, idempotencyKey: failingId, projectId: owner.projectId, tier: "free", stage: "animatic", scriptVersion: 1, totalFrames: 30,
      retryPolicy: {maxRetries: 0, backoffMs: 10}, timeoutMs: 120000, costCapUsd: 0, scriptText: screenplay, rightsAttestedAt: new Date().toISOString(),
      animaticJobId: null, animaticApprovedAt: null} as Parameters<DurableJobStore["enqueue"]>[0]);
    const failed = await processNextJob(store, media, context);
    expect(failed?.id).toBe(failingId);
    expect(failed?.status).toBe("failed");
    expect(failed?.failureReason).toContain(adapterSentinel);
    expect(failed?.failureReason).toContain(providerUrl);
    await apiTelemetry.flush(); await workerTelemetry.flush();
    const spans = exporter.getFinishedSpans();
    const spanIds = new Set(spans.map(span => span.spanContext().traceId + "/" + span.spanContext().spanId));
    const byName = (name: string) => new Set(spans.filter(span => span.name === name).map(span => span.spanContext().traceId + "/" + span.spanContext().spanId));

    const canaries: Record<string, string> = {projectToken: owner.token, tokenSecret, screenplaySentinel, bodySentinel, adapterSentinel, providerUrl, reviewToken: link.token,
      reviewUrl: link.reviewUrl, artifactToken, failureReason: failed!.failureReason!, workerIncarnation, loopback: "127.0.0.1", urlMarker: "://", bearer: "Bearer"};
    expect(captured.length).toBeGreaterThan(10);
    const lines = captured.map(entry => {
      const parsed = JSON.parse(entry.line) as Line;
      for (const [name, value] of Object.entries(canaries)) expect(entry.line, `${name} leaked into a ${entry.service} line`).not.toContain(value);
      expect(Object.keys(parsed).slice(0, 4)).toEqual(["ts", "level", "service", "event"]);
      for (const key of Object.keys(parsed)) expect(LOG_KEYS.has(key), `${key} is outside the log schema`).toBe(true);
      expect(parsed).not.toHaveProperty("dropped");
      expect(parsed.service).toBe(entry.service);
      expect(parsed.level).toBe(entry.level);
      expect(Buffer.byteLength(entry.line)).toBeLessThanOrEqual(2048);
      return parsed;
    });
    const events = lines.map(line => String(line.event));
    expect(events).not.toContain("log.dropped"); expect(events).not.toContain("log.suppressed"); expect(events).not.toContain("log.configuration_invalid");
    expect(lines.filter(line => line.event === "api.started")).toHaveLength(1);
    expect(lines.find(line => line.event === "api.started")).toMatchObject({service: "api", level: "info", tls: false, storage: "json", port: server.port});
    const requests = lines.filter(line => line.event === "api.request");
    expect(requests.length).toBeGreaterThanOrEqual(10);
    for (const line of requests) expect(byName("http.request").has(line.traceId + "/" + line.spanId), "api.request outside its exported span").toBe(true);
    expect(requests.map(line => [line.method, line.route, line.status])).toContainEqual(["PUT", "/api/projects/:projectId/script", 400]);
    expect(requests.map(line => [line.method, line.route, line.status])).toContainEqual(["GET", "/api/jobs/:jobId", 404]);
    expect(requests.map(line => [line.method, line.route, line.status])).toContainEqual(["GET", "/api/reviews/:token", 200]);
    expect(requests.map(line => [line.method, line.route, line.status])).toContainEqual(["GET", "/artifacts/:token/:projectId/:jobId/:file", 200]);
    expect(requests.every(line => Number.isInteger(line.durationMs) && ["success", "error"].includes(String(line.outcome)))).toBe(true);
    const started = lines.filter(line => line.event === "worker.job_started"), finished = lines.filter(line => line.event === "worker.job_finished");
    expect(started.map(line => line.jobId)).toEqual([preview.jobId, failingId]);
    expect(finished.map(line => line.jobId)).toEqual([preview.jobId, failingId]);
    for (const line of [...started, ...finished]) {
      expect(byName("job.process").has(line.traceId + "/" + line.spanId), "worker.job_* outside its exported span").toBe(true);
      expect(line).toMatchObject({projectId: owner.projectId, stage: "animatic", worker: "zo-staging-worker-1"});
    }
    expect(started[0]!.traceId).toBe(store.get(preview.jobId)!.traceparent!.split("-")[1]);
    expect(finished[0]).toMatchObject({level: "info", jobStatus: "done", outcome: "success", costUsd: 0});
    expect(finished[0]).not.toHaveProperty("code");
    expect(finished[1]).toMatchObject({level: "error", jobStatus: "failed", outcome: "error", code: "internal"});
    const attempts = lines.filter(line => line.event === "op.finished" && line.op === "provider.attempt");
    expect(attempts.length).toBeGreaterThanOrEqual(2);
    for (const line of attempts) {
      expect(line.level).toBe("info");
      expect(spanIds.has(line.traceId + "/" + line.spanId)).toBe(true);
    }
    expect(attempts.filter(line => line.jobId === failingId).map(line => [line.outcome, line.code, line.provider])).toEqual([["error", "provider", "other"], ["error", "provider", "other"]]);
    expect(attempts.filter(line => line.jobId === preview.jobId).every(line => line.outcome === "success" && line.provider === "mock")).toBe(true);
    const others = lines.filter(line => line.event === "op.finished" && line.op !== "provider.attempt");
    expect(others.every(line => line.level === "debug")).toBe(true);
    expect(new Set(others.map(line => line.op))).toEqual(new Set(["provider.generate", "accounting.record", "media.checkpoint", "media.assemble"]));
    expect(context.ledger.monthSpend()).toBe(0);

    const evidence = process.env.HV_STRUCTURED_LOGS_EVIDENCE;
    if (evidence) {
      const histogram: Record<string, number> = {};
      for (const event of events) histogram[event] = (histogram[event] ?? 0) + 1;
      const record = {schema: "hv-structured-logs/1", recordedAt: new Date().toISOString(), command: EVIDENCE_COMMAND, lines: lines.length, events: Object.fromEntries(Object.entries(histogram).sort()),
        keysObserved: [...new Set(lines.flatMap(line => Object.keys(line)))].sort(), canaries: Object.keys(canaries).sort(), leaks: 0,
        traceCorrelated: {apiRequests: requests.length, jobStarted: started.length, jobFinished: finished.length, attempts: attempts.length}, droppedTotal: 0, newProviderSpendUsd: 0};
      const serialized = JSON.stringify(record, null, 2) + "\n";
      for (const value of Object.values(canaries)) if (value !== "://" && value !== "Bearer" && value !== "127.0.0.1") expect(serialized).not.toContain(value);
      const path = resolve(evidence);
      mkdirSync(dirname(path), {recursive: true});
      writeFileSync(path, serialized);
    }
  } finally {
    await server.stop(true); await apiTelemetry.shutdown(); await workerTelemetry.shutdown();
    for (const [key, value] of Object.entries({HV_TOKEN_SECRET: previous.token, HV_ANIMATIC_PROVIDER: previous.provider, HV_NARRATION: previous.narration})) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(directory, {recursive: true, force: true});
  }
}, 30000);
