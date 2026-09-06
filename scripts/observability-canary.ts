/** Synthetic telemetry only. No project, provider, storage-role or operator credential is needed. */
import { StudioTelemetry } from "../packages/observability/src/index";

const telemetry = new StudioTelemetry({service: "canary", endpoint: "http://127.0.0.1:15418/", batchDelayMs: 10});
let traceId = "";
async function json(url: string): Promise<any> {
  const response = await fetch(url, {signal: AbortSignal.timeout(2000), redirect: "error"});
  if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 1_048_576) throw new Error("canary query failed");
  const chunks: Uint8Array[] = []; let bytes = 0;
  if (!response.body) throw new Error("canary query returned no body");
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > 1_048_576) throw new Error("canary query exceeded its response limit");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}
async function until<T>(check: () => Promise<T | null>): Promise<T> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    try {const result = await check(); if (result !== null) return result;} catch { /* Bounded startup and scrape delay. */ }
    await Bun.sleep(500);
  }
  throw new Error("observability canary did not reach its storage/query boundary");
}
try {
  await telemetry.run("project.archive", {"request.url": "should-not-leave-canary"}, async () => {
    traceId = telemetry.carrier()!.split("-")[1]!;
    await telemetry.run("media.publish", {"hv.media.files": 0}, async () => {});
  });
  await telemetry.flush();
  const stored = await until(async () => {
    const result = await json("http://127.0.0.1:15686/api/traces/" + traceId), trace = result.data?.[0];
    if (trace?.traceID !== traceId || trace.spans?.length !== 2) return null;
    if (JSON.stringify(result).includes("should-not-leave-canary")) throw new Error("canary privacy boundary failed");
    return trace;
  });
  const query = `sum(hv_operations_total{job="rough-cut-canary",instance="${telemetry.instanceId}"})`;
  const operations = await until(async () => {
    const result = await json("http://127.0.0.1:15909/api/v1/query?query=" + encodeURIComponent(query));
    const value = Number(result.data?.result?.[0]?.value?.[1]);
    return result.status === "success" && Number.isFinite(value) && value >= 2 ? value : null;
  });
  console.log(JSON.stringify({schema: "hv-observability-canary/1", checkedAt: new Date().toISOString(), traceId, instanceId: telemetry.instanceId,
    storedSpans: stored.spans.length, metricOperations: operations, privacySentinelAbsent: true, newProviderCostUsd: 0}));
} catch {
  console.error("Observability canary failed; no project data or paid provider was used."); process.exitCode = 1;
} finally {await telemetry.shutdown();}
