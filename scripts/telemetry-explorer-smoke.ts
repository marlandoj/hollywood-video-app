/** Disposable Linux CI contract check against the pinned Jaeger, collector and Prometheus. */
import { mkdtempSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { StudioTelemetry } from "../packages/observability/src/index";
import { TelemetryExplorer } from "../packages/observability/src/explorer";

if (process.platform !== "linux" || process.env.HV_TELEMETRY_CONTRACT_CI !== "1") throw new Error("This smoke requires an explicitly disposable Linux CI environment.");
const installed = resolve(process.argv[2] ?? "missing-runtime");
const manifest = JSON.parse(readFileSync(join(installed, "binaries.json"), "utf8"));
if (manifest.schema !== "hv-observability-binaries/1" || manifest.root !== installed) throw new Error("Pinned runtime manifest required.");
const root = mkdtempSync(join(tmpdir(), "hv-telemetry-contract-"));
const children: ReturnType<typeof Bun.spawn>[] = [];
const api = new StudioTelemetry({service: "api", endpoint: "http://127.0.0.1:15418/", batchDelayMs: 10, metricIntervalMs: 1000});
const worker = new StudioTelemetry({service: "worker", endpoint: "http://127.0.0.1:15418/", batchDelayMs: 10, metricIntervalMs: 1000});
const explorer = new TelemetryExplorer({enabled: true});
const jobId = crypto.randomUUID();
let traceId = "", emitted = 0;
function binary(name: string, version: string) {
  const release = manifest.releases.find((item: any) => item.name === name && item.version === version), entry = release?.binaries[name];
  const path = join(installed, "bin", name + "-" + version);
  if (!entry || entry.path !== path || new Bun.CryptoHasher("sha256").update(readFileSync(path)).digest("hex") !== entry.sha256) throw new Error("Pinned binary verification failed.");
  return path;
}
async function until(check: () => Promise<boolean>, limitMs: number) {
  const deadline = Date.now() + limitMs;
  while (Date.now() < deadline) {
    if (children.some(child => child.exitCode !== null)) throw new Error("A telemetry backend exited.");
    if (await check()) return;
    await Bun.sleep(1000);
  }
  throw new Error("Stored telemetry contract did not become available before its deadline.");
}
try {
  // Fail before starting anything if a listener could belong to another environment.
  for (const port of [15333, 15418, 15419, 15464, 15685, 15686, 15888, 15889, 15909]) {
    const listener = Bun.listen({hostname: "127.0.0.1", port, socket: {data() {}}}); listener.stop(true);
  }
  for (const directory of ["data/jaeger/keys", "data/jaeger/values", "data/prometheus"]) mkdirSync(join(root, directory), {recursive: true});
  const env = {PATH: process.env.PATH ?? "/usr/bin:/bin", HV_OBSERVABILITY_ROOT: root, GOMEMLIMIT: "768MiB"};
  const commands = [
    [binary("jaeger", "2.20.0"), "--config", resolve("infra/observability/jaeger.yaml")],
    [binary("otelcol-contrib", "0.160.0"), "--config", resolve("infra/observability/collector.yaml")],
    [binary("prometheus", "3.14.0"), "--config.file=" + resolve("infra/observability/prometheus.yaml"), "--storage.tsdb.path=" + join(root, "data/prometheus"),
      "--storage.tsdb.retention.time=1h", "--storage.tsdb.retention.size=128MB", "--web.listen-address=127.0.0.1:15909", "--query.timeout=5s", "--query.max-concurrency=4", "--query.max-samples=1000000"],
  ];
  for (const command of commands) children.push(Bun.spawn(command, {env, stdin: "ignore", stdout: "ignore", stderr: "inherit"}));
  await until(async () => {
    const checks = await Promise.all(["http://127.0.0.1:15333/", "http://127.0.0.1:15686/api/services", "http://127.0.0.1:15909/-/ready"].map(async url => {
      try {return (await fetch(url, {signal: AbortSignal.timeout(1000)})).ok;} catch {return false;}
    })); return checks.every(Boolean);
  }, 30_000);
  await until(async () => {
    for (const failed of [false, true]) {
      let parent: string | undefined;
      await api.run("http.request", {"http.request.method": "POST", "http.route": "/api/projects", "prompt": "private-contract-sentinel"}, async span => {
        parent = api.carrier(); if (failed) span.fail("internal");
      });
      await worker.run("job.process", {"hv.job.id": jobId, "hv.stage": "animatic"}, async span => {
        if (!traceId) traceId = worker.carrier()!.split("-")[1]!;
        if (failed) span.fail("provider");
        await worker.run("media.publish", {"hv.media.files": 0}, async () => {});
      }, parent);
      emitted++;
    }
    await Promise.all([api.flush(), worker.flush()]);
    const reading = await explorer.metrics();
    return reading.state === "available" && reading.value?.series.length === 4 && reading.value.series.every(series => series.points.some(([, rate]) => rate !== null && rate > 0));
  }, 100_000);
  const recent = await explorer.recentTraces(jobId);
  if (recent.state !== "available" || !recent.value?.traces.some(trace => trace.jobId === jobId)) throw new Error("Jaeger job search contract failed.");
  const detail = await explorer.trace(traceId);
  const spans = detail.value?.spans, http = spans?.find(span => span.operation === "http.request"), job = spans?.find(span => span.operation === "job.process");
  if (detail.state !== "available" || spans?.length !== 3 || !http || job?.parentId !== http.id || detail.value?.jobId !== jobId) throw new Error("Stored trace detail correlation failed.");
  if (JSON.stringify([recent, detail]).includes("private-contract-sentinel")) throw new Error("Stored trace privacy boundary failed.");
  console.log(JSON.stringify({schema: "hv-telemetry-explorer-contract/1", checkedAt: new Date().toISOString(), storedSpans: spans.length, rateSeries: 4,
    syntheticJobs: emitted, jobSearch: true, apiWorkerParent: true, privacySentinelAbsent: true, newProviderCostUsd: 0}));
} finally {
  explorer.close(); await Promise.all([api.shutdown(), worker.shutdown()]);
  for (const child of children.reverse()) {
    child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {await Promise.race([child.exited, new Promise<void>(resolve => {timer = setTimeout(() => {child.kill("SIGKILL"); resolve();}, 5000);})]);}
    finally {clearTimeout(timer);}
    await child.exited;
  }
  rmSync(root, {recursive: true, force: true});
}
