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
const frontendOrigin = "https://staging.example.test";
const server = createApiServer({ port: 0, hostname: "127.0.0.1", queuePath, artifactRoot, statePath, costLedgerPath, frontendOrigin });
const base = `http://127.0.0.1:${server.port}`;

const workerContext = {
  ledger: new CostLedger(costLedgerPath),
  reviewQueue: new OperatorReviewQueue(`${root}/state/operator-review-queue.json`),
};

const seenResponses: Response[] = [];
async function call(path: string, init?: RequestInit): Promise<Response> {
  const response = await fetch(`${base}${path}`, init);
  seenResponses.push(response);
  if (response.headers.get("set-cookie")) throw new Error(`${path} set a cookie; anonymous access must be cookie-free (FR-053)`);
  return response;
}

async function drainWorker(): Promise<void> {
  const store = new DurableJobStore(queuePath);
  const completed = await processNextJob(store, artifactRoot, workerContext);
  if (!completed || completed.status !== "done") {
    throw new Error(`worker failed: ${completed?.failureReason ?? "no job"}`);
  }
}

const SCRIPT_V1 = "INT. STUDIO - DAY\n\nA projector flickers to life.";
const SCRIPT_V2 = "INT. STUDIO - NIGHT\n\nA projector flickers to life, then dies.";

try {
  const health = await call("/health");
  if (!health.ok) throw new Error(`health failed: ${health.status}`);

  const createdResponse = await call("/api/projects", { method: "POST" });
  if (!createdResponse.ok) throw new Error(`project creation failed: ${createdResponse.status}`);
  const created = await createdResponse.json() as { projectId: string; token: string; projectUrl: string };
  if (!created.projectUrl.startsWith(`${frontendOrigin}/#/p/`) || !created.projectUrl.endsWith(created.token)) {
    throw new Error(`project URL must embed the signed token in its fragment, got ${created.projectUrl}`);
  }
  if (created.projectUrl.includes("?")) throw new Error("project URL must not carry the token in a query string");
  const headers = { authorization: `Bearer ${created.token}`, "content-type": "application/json" };

  const script = await call(`/api/projects/${created.projectId}/script`, { method: "PUT", headers, body: JSON.stringify({ text: SCRIPT_V1 }) });
  if (!script.ok) throw new Error(`script save failed: ${script.status}`);

  const ungated = await call(`/api/projects/${created.projectId}/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ idempotencyKey: "runtime-smoke-ungated" }),
  });
  if (ungated.status !== 403) throw new Error(`generation without rights attestation must be refused, got ${ungated.status}`);

  const rights = await call(`/api/projects/${created.projectId}/rights`, { method: "POST", headers, body: JSON.stringify({ attested: true }) });
  if (!rights.ok) throw new Error(`rights attestation failed: ${rights.status}`);

  const staleAnimaticResponse = await call(`/api/projects/${created.projectId}/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ idempotencyKey: "runtime-smoke-stale-animatic" }),
  });
  if (!staleAnimaticResponse.ok) throw new Error(`animatic enqueue failed: ${staleAnimaticResponse.status}`);
  const staleAnimatic = await staleAnimaticResponse.json() as { jobId: string; stage: string };
  if (staleAnimatic.stage !== "animatic") throw new Error(`first job must be an animatic, got ${staleAnimatic.stage}`);
  await drainWorker();

  const edited = await call(`/api/projects/${created.projectId}/script`, { method: "PUT", headers, body: JSON.stringify({ text: SCRIPT_V2 }) });
  if (!edited.ok) throw new Error(`script edit failed: ${edited.status}`);
  const staleApproval = await call(`/api/projects/${created.projectId}/animatic/decision`, {
    method: "POST",
    headers,
    body: JSON.stringify({ animaticJobId: staleAnimatic.jobId, decision: "approved" }),
  });
  if (staleApproval.status !== 409) throw new Error(`approving an animatic rendered from an older screenplay must be refused, got ${staleApproval.status}`);
  const staleFinal = await call(`/api/projects/${created.projectId}/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ idempotencyKey: "runtime-smoke-stale-final", stage: "final", animaticJobId: staleAnimatic.jobId }),
  });
  if (staleFinal.status !== 403 && staleFinal.status !== 409) throw new Error(`final generation from a stale animatic must be refused, got ${staleFinal.status}`);

  const animaticResponse = await call(`/api/projects/${created.projectId}/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ idempotencyKey: "runtime-smoke-animatic" }),
  });
  if (!animaticResponse.ok) throw new Error(`animatic enqueue failed: ${animaticResponse.status}`);
  const animatic = await animaticResponse.json() as { jobId: string; stage: string; scriptVersion: number };
  if (animatic.scriptVersion !== 2) throw new Error(`animatic must bind to screenplay version 2, got ${animatic.scriptVersion}`);
  await drainWorker();

  const unapproved = await call(`/api/projects/${created.projectId}/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ idempotencyKey: "runtime-smoke-unapproved", stage: "final", animaticJobId: animatic.jobId }),
  });
  if (unapproved.status !== 403) throw new Error(`final generation before approval must be refused, got ${unapproved.status}`);

  const approval = await call(`/api/projects/${created.projectId}/animatic/decision`, {
    method: "POST",
    headers,
    body: JSON.stringify({ animaticJobId: animatic.jobId, decision: "approved" }),
  });
  if (!approval.ok) throw new Error(`animatic approval failed: ${approval.status}`);
  const approvalBody = await approval.json() as { scriptVersion: number };
  if (approvalBody.scriptVersion !== 2) throw new Error(`approval must bind to the animatic's screenplay version, got ${approvalBody.scriptVersion}`);

  const queuedResponse = await call(`/api/projects/${created.projectId}/jobs`, {
    method: "POST",
    headers,
    body: JSON.stringify({ idempotencyKey: "runtime-smoke-final", stage: "final", animaticJobId: animatic.jobId }),
  });
  if (!queuedResponse.ok) throw new Error(`final job enqueue failed: ${queuedResponse.status}`);
  const queued = await queuedResponse.json() as { jobId: string };
  await drainWorker();

  const statusResponse = await call(`/api/jobs/${queued.jobId}`, { headers: { authorization: `Bearer ${created.token}` } });
  if (!statusResponse.ok) throw new Error(`job status failed: ${statusResponse.status}`);
  const status = await statusResponse.json() as { status: string; costUsd: number; output?: { hlsUrl: string; mp4Url: string } };
  if (status.status !== "done" || !status.output?.hlsUrl || !status.output.mp4Url) throw new Error("completed job has no playback artifacts");
  if (status.output.hlsUrl.includes("?")) throw new Error("artifact URLs must not carry a query string");

  const unsigned = await call(`/artifacts/${created.projectId}/${queued.jobId}/hls/index.m3u8`);
  if (unsigned.status !== 401) throw new Error(`unsigned artifact paths must be refused, got ${unsigned.status}`);
  const tampered = await call(status.output.hlsUrl.replace(/^\/artifacts\/([^/]+)/, (_, token: string) => `/artifacts/${token.slice(0, -2)}AA`));
  if (tampered.status !== 401) throw new Error(`a tampered artifact signature must be refused, got ${tampered.status}`);

  const hls = await call(status.output.hlsUrl);
  const playlist = await hls.text();
  if (!hls.ok || !playlist.includes("#EXTM3U")) throw new Error("HLS playlist is unreachable through its signed URL");

  const segment = playlist.split("\n").map((line) => line.trim()).find((line) => line && !line.startsWith("#"));
  if (!segment) throw new Error("HLS playlist contains no media segment");
  const segmentUrl = `${status.output.hlsUrl.slice(0, status.output.hlsUrl.lastIndexOf("/"))}/${segment}`;
  const segmentResponse = await call(segmentUrl);
  if (!segmentResponse.ok) throw new Error(`HLS media segment is unreachable: ${segmentResponse.status}`);
  if ((await segmentResponse.arrayBuffer()).byteLength === 0) throw new Error("HLS media segment is empty");

  const resumeResponse = await call(`/api/projects/${created.projectId}`, { headers: { authorization: `Bearer ${created.token}` } });
  if (!resumeResponse.ok) throw new Error(`project resume failed: ${resumeResponse.status}`);
  const resume = await resumeResponse.json() as { script: string; scriptVersion: number; jobs: { id: string; status: string }[] };
  if (resume.script !== SCRIPT_V2 || resume.scriptVersion !== 2) throw new Error("project resume did not return the current screenplay");
  if (!resume.jobs.some((job) => job.id === queued.jobId && job.status === "done")) throw new Error("project resume did not list the finished cut");

  const reviewResponse = await call(`/api/projects/${created.projectId}/reviews`, { method: "POST", headers, body: JSON.stringify({ permission: "approve" }) });
  if (!reviewResponse.ok) throw new Error(`review link creation failed: ${reviewResponse.status}`);
  const review = await reviewResponse.json() as { token: string; reviewUrl: string };
  if (!review.reviewUrl.startsWith(`${frontendOrigin}/#/review/`) || review.reviewUrl.includes("?")) {
    throw new Error(`review URL must carry its token in the fragment, got ${review.reviewUrl}`);
  }

  const reviewViewResponse = await call(`/api/reviews/${encodeURIComponent(review.token)}`);
  if (!reviewViewResponse.ok) throw new Error(`review link cannot display the cut: ${reviewViewResponse.status}`);
  const reviewView = await reviewViewResponse.json() as { output?: { hlsUrl: string } };
  if (!reviewView.output?.hlsUrl) throw new Error("review view returned no playable cut");
  const reviewSegment = await call(reviewView.output.hlsUrl);
  if (!reviewSegment.ok) throw new Error(`reviewer cannot load the cut: ${reviewSegment.status}`);

  const restarted = createApiServer({ port: 0, hostname: "127.0.0.1", queuePath, artifactRoot, statePath, costLedgerPath, frontendOrigin });
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
    responsesChecked: seenResponses.length,
    cookiesSet: 0,
    artifacts: "signed-url",
    hlsSegments: "reachable",
    staleAnimaticApproval: "refused",
    projectResume: "reachable",
    reviewLink: "playable",
    restartSurvives: true,
  }));
} finally {
  server.stop(true);
}
