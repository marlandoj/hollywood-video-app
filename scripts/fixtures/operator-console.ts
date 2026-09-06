/** Local visual fixture. All figures are synthetic; never connects to studio services. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../../packages/api/src/server";
import { mintDiagnosticsToken } from "../../packages/api/src/operator-token";
import { StudioTelemetry } from "../../packages/observability/src/index";
import { OperatorDiagnostics } from "../../packages/observability/src/diagnostics";

const root = mkdtempSync(join(tmpdir(), "hv-operator-visual-"));
process.env.HV_TOKEN_SECRET = "local-visual-project-fixture-not-a-deployment-secret";
const secret = "local-visual-operator-fixture-not-a-deployment-secret";
const mode = process.argv[2] ?? "healthy";
const telemetry = new StudioTelemetry({service: "api", enabled: false});
const server = createApiServer({port: 8187, hostname: "127.0.0.1", tls: null, storage: "json", artifactStorage: "local", telemetry,
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
