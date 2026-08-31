import { CostLedger, OperatorReviewQueue } from "../packages/operator/src/index";
import { DurableJobStore } from "../packages/queue/src/index";
import { processNextJob } from "../packages/queue/src/worker";
import { createApiServer } from "../packages/api/src/server";

process.env.HV_TOKEN_SECRET = process.env.HV_TOKEN_SECRET ?? "runtime-smoke-secret-that-is-at-least-thirty-two-chars";

const root = `/tmp/hv-runtime-smoke-${process.pid}`;
const queuePath = `${root}/jobs.json`;
const artifactRoot = `${root}/artifacts`;
const statePath = `${root}/state/projects.json`;
const costLedgerPath = `${root}/state/cost-ledger.json`;
const server = createApiServer({ port: 0, hostname: "127.0.0.1", queuePath, artifactRoot, statePath, costLedgerPath });
const base = `http://127.0.0.1:${server.port}`;

const workerContext = {
  ledger: new CostLedger(costLedgerPath),
  reviewQueue: new OperatorReviewQueue(`${root}/state/operator-review-queue.json`),
};

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("expected an artifact session cookie");
  return header.split(";")[0]!;
}

async function drainWorker(): Promise<void> {
  const store = new DurableJobStore(queuePath);
  const completed = await processNextJob(store, artifactRoot, workerContext);
  if (!completed || completed.status !== "done") {
    throw new Error(`worker failed: ${completed?.failureReason ?? "no job"}`);
  }
}

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

  const ungated = await fetch(`${base}/api/projects/${created.projectId}/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ idempotencyKey: "runtime-smoke-ungated" }),
  });
  if (ungated.status !== 403) throw new Error(`generation without rights attestation must be refused, got ${ungated.status}`);

  const rights = await fetch(`${base}/api/projects/${created.projectId}/rights`, {
    method: "POST",
    headers,
    body: JSON.stringify({ attested: true }),
  });
  if (!rights.ok) throw new Error(`rights attestation failed: ${rights.status}`);

  const animaticResponse = await fetch(`${base}/api/projects/${created.projectId}/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ idempotencyKey: "runtime-smoke-animatic" }),
  });
  if (!animaticResponse.ok) throw new Error(`animatic enqueue failed: ${animaticResponse.status}`);
  const animatic = await animaticResponse.json() as { jobId: string; stage: string };
  if (animatic.stage !== "animatic") throw new Error(`first job must be an animatic, got ${animatic.stage}`);
  await drainWorker();

  const unapproved = await fetch(`${base}/api/projects/${created.projectId}/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ idempotencyKey: "runtime-smoke-unapproved", stage: "final", animaticJobId: animatic.jobId }),
  });
  if (unapproved.status !== 403) throw new Error(`final generation before approval must be refused, got ${unapproved.status}`);

  const approval = await fetch(`${base}/api/projects/${created.projectId}/animatic/decision`, {
    method: "POST",
    headers,
    body: JSON.stringify({ animaticJobId: animatic.jobId, decision: "approved" }),
  });
  if (!approval.ok) throw new Error(`animatic approval failed: ${approval.status}`);

  const queuedResponse = await fetch(`${base}/api/projects/${created.projectId}/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ idempotencyKey: "runtime-smoke-final", stage: "final", animaticJobId: animatic.jobId }),
  });
  if (!queuedResponse.ok) throw new Error(`final job enqueue failed: ${queuedResponse.status}`);
  const queued = await queuedResponse.json() as { jobId: string };
  await drainWorker();

  const statusResponse = await fetch(`${base}/api/jobs/${queued.jobId}`, { headers: { authorization: `Bearer ${created.token}` } });
  if (!statusResponse.ok) throw new Error(`job status failed: ${statusResponse.status}`);
  const status = await statusResponse.json() as { status: string; costUsd: number; output?: { hlsUrl: string; mp4Url: string } };
  if (status.status !== "done" || !status.output?.hlsUrl || !status.output.mp4Url) throw new Error("completed job has no playback artifacts");

  const anonymousHls = await fetch(`${base}${status.output.hlsUrl}`);
  if (anonymousHls.status !== 401) throw new Error(`artifacts must require authentication, got ${anonymousHls.status}`);

  const sessionResponse = await fetch(`${base}/api/projects/${created.projectId}/artifact-session`, { method: "POST", headers });
  if (!sessionResponse.ok) throw new Error(`artifact session failed: ${sessionResponse.status}`);
  const artifactCookie = cookieFrom(sessionResponse);

  const hls = await fetch(`${base}${status.output.hlsUrl}`, { headers: { cookie: artifactCookie } });
  const playlist = await hls.text();
  if (!hls.ok || !playlist.includes("#EXTM3U")) throw new Error("HLS playlist is unreachable");

  const segment = playlist.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
  if (!segment) throw new Error("HLS playlist contains no media segment");
  const segmentUrl = `${base}${status.output.hlsUrl.slice(0, status.output.hlsUrl.lastIndexOf("/"))}/${segment}`;
  const segmentResponse = await fetch(segmentUrl, { headers: { cookie: artifactCookie } });
  if (!segmentResponse.ok) throw new Error(`HLS media segment is unreachable: ${segmentResponse.status}`);
  if ((await segmentResponse.arrayBuffer()).byteLength === 0) throw new Error("HLS media segment is empty");

  const reviewResponse = await fetch(`${base}/api/projects/${created.projectId}/reviews`, {
    method: "POST",
    headers,
    body: JSON.stringify({ permission: "approve" }),
  });
  if (!reviewResponse.ok) throw new Error(`review link creation failed: ${reviewResponse.status}`);
  const review = await reviewResponse.json() as { token: string };

  const reviewViewResponse = await fetch(`${base}/api/reviews/${encodeURIComponent(review.token)}`);
  if (!reviewViewResponse.ok) throw new Error(`review link cannot display the cut: ${reviewViewResponse.status}`);
  const reviewView = await reviewViewResponse.json() as { output?: { hlsUrl: string } };
  if (!reviewView.output?.hlsUrl) throw new Error("review view returned no playable cut");
  const reviewSegment = await fetch(`${base}${reviewView.output.hlsUrl}`, { headers: { cookie: cookieFrom(reviewViewResponse) } });
  if (!reviewSegment.ok) throw new Error(`reviewer cannot load the cut: ${reviewSegment.status}`);

  const restarted = createApiServer({ port: 0, hostname: "127.0.0.1", queuePath, artifactRoot, statePath, costLedgerPath });
  try {
    const afterRestart = await fetch(`http://127.0.0.1:${restarted.port}/api/jobs/${queued.jobId}`, {
      headers: { authorization: `Bearer ${created.token}` },
    });
    if (!afterRestart.ok) throw new Error(`project token stopped working after an API restart: ${afterRestart.status}`);
  } finally {
    restarted.stop(true);
  }

  console.log(JSON.stringify({
    status: "healthy",
    projectId: created.projectId,
    animaticJobId: animatic.jobId,
    jobId: queued.jobId,
    costUsd: status.costUsd,
    monthSpendUsd: workerContext.ledger.monthSpend(),
    artifacts: "reachable",
    hlsSegments: "reachable",
    reviewLink: "playable",
    restartSurvives: true,
  }));
} finally {
  server.stop(true);
}
