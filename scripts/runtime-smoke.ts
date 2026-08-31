import { DurableJobStore } from "../packages/queue/src/index";
import { processNextJob } from "../packages/queue/src/worker";
import { createApiServer } from "../packages/api/src/server";

process.env.HV_TOKEN_SECRET = process.env.HV_TOKEN_SECRET ?? "runtime-smoke-secret-that-is-at-least-thirty-two-chars";

const root = `/tmp/hv-runtime-smoke-${process.pid}`;
const queuePath = `${root}/jobs.json`;
const artifactRoot = `${root}/artifacts`;
const server = createApiServer({ port: 0, hostname: "127.0.0.1", queuePath, artifactRoot });
const base = `http://127.0.0.1:${server.port}`;

try {
  const health = await fetch(`${base}/health`);
  if (!health.ok) throw new Error(`health failed: ${health.status}`);

  const createdResponse = await fetch(`${base}/api/projects`, { method: "POST" });
  if (!createdResponse.ok) throw new Error(`project creation failed: ${createdResponse.status}`);
  const created = await createdResponse.json() as { projectId: string; token: string };
  const headers = { authorization: `Bearer ${created.token}`, "content-type": "application/json" };

  const script = await fetch(`${base}/api/projects/${created.projectId}/script`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ text: "INT. STUDIO - DAY\n\nA projector flickers to life." }),
  });
  if (!script.ok) throw new Error(`script save failed: ${script.status}`);

  const queuedResponse = await fetch(`${base}/api/projects/${created.projectId}/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ idempotencyKey: "runtime-smoke" }),
  });
  if (!queuedResponse.ok) throw new Error(`job enqueue failed: ${queuedResponse.status}`);
  const queued = await queuedResponse.json() as { jobId: string };

  const completed = await processNextJob(new DurableJobStore(queuePath), artifactRoot);
  if (!completed || completed.status !== "done") throw new Error(`worker failed: ${completed?.failureReason ?? "no job"}`);

  const statusResponse = await fetch(`${base}/api/jobs/${queued.jobId}`, { headers: { authorization: `Bearer ${created.token}` } });
  if (!statusResponse.ok) throw new Error(`job status failed: ${statusResponse.status}`);
  const status = await statusResponse.json() as { status: string; output?: { hlsUrl: string; mp4Url: string } };
  if (status.status !== "done" || !status.output?.hlsUrl || !status.output.mp4Url) throw new Error("completed job has no playback artifacts");

  const hls = await fetch(`${base}${status.output.hlsUrl}`);
  if (!hls.ok || !(await hls.text()).includes("#EXTM3U")) throw new Error("HLS playlist is unreachable");
  console.log(JSON.stringify({ status: "healthy", projectId: created.projectId, jobId: queued.jobId, artifacts: "reachable" }));
} finally {
  server.stop(true);
}
