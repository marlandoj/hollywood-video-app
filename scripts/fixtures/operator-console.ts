/** Local visual fixture. All figures are synthetic; never connects to studio services. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../../packages/api/src/server";
import { mintDiagnosticsToken } from "../../packages/api/src/operator-token";
import { StudioTelemetry } from "../../packages/observability/src/index";
import { OperatorDiagnostics } from "../../packages/observability/src/diagnostics";
import { TelemetryExplorer } from "../../packages/observability/src/explorer";

const root = mkdtempSync(join(tmpdir(), "hv-operator-visual-"));
process.env.HV_TOKEN_SECRET = "local-visual-project-fixture-not-a-deployment-secret";
const secret = "local-visual-operator-fixture-not-a-deployment-secret";
const mode = process.argv[2] ?? "healthy";
const telemetry = new StudioTelemetry({service: "api", enabled: false});
const traceId = "1234567890abcdef1234567890abcdef", jobId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const sourceSpan = (index: number, start: number) => ({traceID: traceId, spanID: (index + 1).toString(16).padStart(16, "0"),
  processID: index ? "worker" : "api", operationName: index === 0 ? "http.request" : index === 1 ? "job.process" : ["provider.attempt", "media.checkpoint", "media.assemble", "media.publish"][index % 4],
  startTime: (start + index * 500) * 1000, duration: index === 1 ? 45_000_000 : 400_000,
  tags: [{key: "hv.job.id", value: jobId}, {key: "hv.stage", value: "animatic"}, {key: "hv.outcome", value: index === 4 ? "error" : "success"},
    ...(index === 4 ? [{key: "hv.failure_code", value: "provider"}] : [])],
  references: index ? [{refType: "CHILD_OF", traceID: traceId, spanID: index === 1 ? "0000000000000001" : "0000000000000002"}] : []});
const fixtureFetch = (async (input: any) => {
  const url = new URL(String(input));
  if (mode === "unavailable") return new Response("Synthetic backend failure", {status: 503});
  if (url.port === "15686") {
    const empty = mode === "empty" || (url.pathname !== "/api/traces" && !url.pathname.endsWith(traceId));
    return Response.json({data: empty ? [] : [{traceID: traceId, processes: {api: {serviceName: "rough-cut-api"}, worker: {serviceName: "rough-cut-worker"}},
      spans: Array.from({length: 65}, (_, index) => sourceSpan(index, Date.now() - 120_000))}]});
  }
  const start = Number(url.searchParams.get("start"));
  return Response.json({status: "success", data: {resultType: "matrix", result: mode === "empty" ? [] : ["rough-cut-api", "rough-cut-worker"].flatMap((job, index) => ["success", "error"].map(hv_outcome => ({
    metric: {job, hv_outcome}, values: Array.from({length: 31}, (_, point) => [start + point * 60,
      point >= 12 && point <= 15 ? "NaN" : String(hv_outcome === "error" ? (point === 19 ? .15 : 0) : Math.max(0, (Math.sin(point / 3) + 1.3) * (index ? .2 : 3)))])
  })))}});
}) as typeof fetch;
const server = createApiServer({port: 8187, hostname: "127.0.0.1", tls: null, storage: "json", artifactStorage: "local", telemetry,
  telemetryExplorer: () => new TelemetryExplorer({enabled: mode !== "disabled", fetch: fixtureFetch}),
  operatorDiagnosticsSecret: secret, queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json"),
  costLedgerPath: join(root, "costs.json"), artifactRoot: join(root, "media"),
  diagnostics: () => new OperatorDiagnostics({telemetry, backend: "postgres", expectedWorkers: 3,
    database: async () => ({queue: {queued: 2, running: 1}, workers: {ready: mode === "healthy" ? 2 : 0, busy: 1, draining: 0, latestProcesses: 3},
      budget: {recordedMonthUsd: .144, reservedUsd: 7, monthlyCapUsd: 500}}), objects: async () => mode === "healthy",
    backup: async () => ({state: mode === "healthy" ? "healthy" : "failed", lastSnapshotAt: new Date(Date.now() - (mode === "healthy" ? 30_000 : 720_000)).toISOString(),
      lastCompletedAt: new Date(Date.now() - 20_000).toISOString(), objects: 601, lastRecordedCostUsd: .144,
      failureStage: mode === "healthy" ? null : "backup", localRepositoryOnly: true}),
  }),
});
console.log(new URL("/api/operator/console#" + mintDiagnosticsToken(secret), server.url).href);
async function stop() {await server.stop(true); rmSync(root, {recursive: true, force: true}); process.exit(0);}
process.on("SIGTERM", stop); process.on("SIGINT", stop);
