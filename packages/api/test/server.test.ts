import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { CostLedger, OperatorReviewQueue } from "../../operator/src/index";
import { DOWNLOAD_LINK_TTL_MS, DurableJobStore } from "../../queue/src/index";
import { clientAddress } from "../src/rate-limit";
import { processNextJob } from "../../queue/src/worker";
import { createApiServer } from "../src/server";
import { mintOperatorGrant, verifyToken } from "../src/tokens";

const root = `/tmp/hv-api-${Date.now()}`;
const queuePath = `${root}/jobs.json`;
const artifactRoot = `${root}/artifacts`;
const statePath = `${root}/state/projects.json`;
const costLedgerPath = `${root}/state/cost-ledger.json`;
const frontendOrigin = "https://staging.example.test";
// This suite fires several hundred requests from one address inside a minute;
// the limiter itself is exercised against its own server below.
const generous = { api: { limit: 1_000_000, windowMs: 60_000 }, projectCreate: { limit: 1_000_000, windowMs: 3600_000 }, artifacts: { limit: 1_000_000, windowMs: 60_000 } };
let server: ReturnType<typeof createApiServer>;
let base: string;

beforeAll(() => {
  process.env.HV_TOKEN_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
  server = createApiServer({ port: 0, hostname: "127.0.0.1", queuePath, artifactRoot, statePath, costLedgerPath, frontendOrigin, rateLimit: generous });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

async function newProject(): Promise<{ projectId: string; token: string; projectUrl: string; headers: Record<string, string> }> {
  const created = await (await fetch(`${base}/api/projects`, { method: "POST" })).json() as { projectId: string; token: string; projectUrl: string };
  const headers = { authorization: `Bearer ${created.token}`, "content-type": "application/json" };
  await fetch(`${base}/api/projects/${created.projectId}/script`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ text: "INT. ROOM - DAY\n\nA lamp glows." }),
  });
  return { ...created, headers };
}

async function attest(projectId: string, headers: Record<string, string>): Promise<void> {
  await fetch(`${base}/api/projects/${projectId}/rights`, { method: "POST", headers, body: JSON.stringify({ attested: true }) });
}

async function enqueue(projectId: string, headers: Record<string, string>, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/projects/${projectId}/jobs`, { method: "POST", headers, body: JSON.stringify(body) });
}

function finishJob(projectId: string, jobId: string): void {
  const directory = `${artifactRoot}/${projectId}/${jobId}`;
  mkdirSync(`${directory}/hls`, { recursive: true });
  writeFileSync(`${directory}/export.mp4`, "mp4");
  writeFileSync(`${directory}/hls/index.m3u8`, "#EXTM3U\n#EXTINF:2.0,\nsegment-000.ts\n#EXT-X-ENDLIST\n");
  writeFileSync(`${directory}/hls/segment-000.ts`, "segment");
  writeFileSync(`${directory}/captions.vtt`, "WEBVTT\n");
  writeFileSync(`${directory}/provenance.json`, "{}");
  const store = new DurableJobStore(queuePath);
  const workerId = `finisher-${jobId}`;
  let claimed = store.claimNext(Date.now(), {}, { workerId, leaseMs: 60_000 });
  while (claimed && claimed.id !== jobId) claimed = store.claimNext(Date.now(), {}, { workerId, leaseMs: 60_000 });
  if (!claimed) throw new Error(`job ${jobId} was not claimable`);
  store.complete(jobId, workerId, {
    mp4Path: `${projectId}/${jobId}/export.mp4`,
    hlsPlaylistPath: `${projectId}/${jobId}/hls/index.m3u8`,
    captionsPath: `${projectId}/${jobId}/captions.vtt`,
    manifestPath: `${projectId}/${jobId}/provenance.json`,
  });
}

async function finishedAnimatic(projectId: string, headers: Record<string, string>, key: string): Promise<string> {
  const animatic = await (await enqueue(projectId, headers, { idempotencyKey: key })).json() as { jobId: string };
  finishJob(projectId, animatic.jobId);
  return animatic.jobId;
}

describe("private staging API reachability", () => {
  test("health endpoint reports queue state and month spend", async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "healthy", queueDepth: 0, monthSpendUsd: 0 });
  });

  test("anonymous project, script, and durable job journey is reachable", async () => {
    const { projectId, token, headers } = await newProject();
    await attest(projectId, headers);

    const jobResponse = await enqueue(projectId, headers, { idempotencyKey: "journey-1" });
    expect(jobResponse.status).toBe(202);
    const job = await jobResponse.json() as { jobId: string; status: string; stage: string; scriptVersion: number };
    expect(job.status).toBe("queued");
    expect(job.stage).toBe("animatic");
    expect(job.scriptVersion).toBe(1);

    const statusResponse = await fetch(`${base}/api/jobs/${job.jobId}`, { headers: { authorization: `Bearer ${token}` } });
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({ id: job.jobId, status: "queued", stage: "animatic" });
  });
});

describe("a content-policy refusal surfaces as a terminal job outcome (FR-054, AC-009)", () => {
  test("GET /api/jobs/:id reports status failed with failureKind policy_refusal and the refusal message, never a retry", async () => {
    const { projectId, token, headers } = await newProject();
    await fetch(`${base}/api/projects/${projectId}/script`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ text: "INT. ROOM - DAY\n\nA lamp glows.\n\nNARRATOR\nI am the sitting president and this is my address." }),
    });
    await attest(projectId, headers);
    const job = await (await enqueue(projectId, headers, { idempotencyKey: "refusal-1" })).json() as { jobId: string };

    const store = new DurableJobStore(queuePath);
    const context = { ledger: new CostLedger(costLedgerPath), reviewQueue: new OperatorReviewQueue(`${root}/state/operator-review-queue.json`) };
    for (let drained = 0; drained < 10 && store.get(job.jobId)?.status === "queued"; drained += 1) {
      await processNextJob(store, artifactRoot, context);
    }

    const status = await (await fetch(`${base}/api/jobs/${job.jobId}`, { headers: { authorization: `Bearer ${token}` } })).json() as Record<string, unknown>;
    expect(status).toMatchObject({ id: job.jobId, status: "failed", failureKind: "policy_refusal", retriesUsed: 0, nextEligibleAt: null });
    expect(String(status.failureReason)).toContain("content policy");
    expect(status.scriptText).toBeUndefined();
  });
});

describe("anonymous access is a signed URL, not a cookie (FR-007, FR-053)", () => {
  test("project creation returns a URL that embeds the signed token in its fragment", async () => {
    const { token, projectUrl } = await newProject();
    expect(projectUrl).toBe(`${frontendOrigin}/#/p/${token}`);
    expect(projectUrl).not.toContain("?");
    expect(verifyToken(token)?.kind).toBe("project");
  });

  test("the signed link resumes the project: screenplay, attestation, and jobs", async () => {
    const { projectId, token, headers } = await newProject();
    await attest(projectId, headers);
    const job = await (await enqueue(projectId, headers, { idempotencyKey: "resume-1" })).json() as { jobId: string };

    const resumed = await fetch(`${base}/api/projects/${projectId}`, { headers: { authorization: `Bearer ${token}` } });
    expect(resumed.status).toBe(200);
    const state = await resumed.json() as { projectId: string; script: string; scriptVersion: number; rightsAttestedAt: string | null; expiresAt: string; jobs: { id: string }[] };
    expect(state.projectId).toBe(projectId);
    expect(state.script).toContain("A lamp glows");
    expect(state.scriptVersion).toBe(1);
    expect(state.rightsAttestedAt).toBeTruthy();
    expect(new Date(state.expiresAt).getTime() - Date.now()).toBeGreaterThan(71 * 3600 * 1000);
    expect(state.jobs.map((entry) => entry.id)).toContain(job.jobId);
  });

  test("resuming without the signed token, or with another project's token, is refused", async () => {
    const first = await newProject();
    const second = await newProject();
    expect((await fetch(`${base}/api/projects/${first.projectId}`)).status).toBe(401);
    expect((await fetch(`${base}/api/projects/${first.projectId}`, { headers: second.headers })).status).toBe(401);
  });

  test("no response in the creator journey sets a cookie", async () => {
    const { projectId, token, headers } = await newProject();
    const responses = [
      await fetch(`${base}/api/projects`, { method: "POST" }),
      await fetch(`${base}/api/projects/${projectId}/rights`, { method: "POST", headers, body: JSON.stringify({ attested: true }) }),
      await enqueue(projectId, headers, { idempotencyKey: "no-cookie" }),
      await fetch(`${base}/api/projects/${projectId}`, { headers: { authorization: `Bearer ${token}` } }),
    ];
    for (const response of responses) expect(response.headers.get("set-cookie")).toBeNull();
  });
});

describe("idempotency keys are scoped per project", () => {
  test("the same client key in two projects yields two jobs, and neither project can read the other's", async () => {
    const first = await newProject();
    const second = await newProject();
    await attest(first.projectId, first.headers);
    await attest(second.projectId, second.headers);
    const a = await (await enqueue(first.projectId, first.headers, { idempotencyKey: "shared-key" })).json() as { jobId: string };
    const b = await (await enqueue(second.projectId, second.headers, { idempotencyKey: "shared-key" })).json() as { jobId: string };
    expect(a.jobId).toBeTruthy();
    expect(b.jobId).toBeTruthy();
    expect(b.jobId).not.toBe(a.jobId);
    expect((await fetch(`${base}/api/jobs/${a.jobId}`, { headers: second.headers })).status).toBe(404);
    expect((await fetch(`${base}/api/jobs/${b.jobId}`, { headers: first.headers })).status).toBe(404);
    expect((await fetch(`${base}/api/jobs/${a.jobId}`, { headers: first.headers })).status).toBe(200);
  });

  test("a repeated key within one project returns the same job", async () => {
    const { projectId, headers } = await newProject();
    await attest(projectId, headers);
    const a = await (await enqueue(projectId, headers, { idempotencyKey: "repeat-key" })).json() as { jobId: string };
    const b = await (await enqueue(projectId, headers, { idempotencyKey: "repeat-key" })).json() as { jobId: string };
    expect(b.jobId).toBe(a.jobId);
  });

  test("a malformed client key is rejected", async () => {
    const { projectId, headers } = await newProject();
    await attest(projectId, headers);
    expect((await enqueue(projectId, headers, { idempotencyKey: "" })).status).toBe(400);
    expect((await enqueue(projectId, headers, { idempotencyKey: "x".repeat(129) })).status).toBe(400);
    expect((await enqueue(projectId, headers, { idempotencyKey: 42 })).status).toBe(400);
    expect((await enqueue(projectId, headers, { idempotencyKey: "has space" })).status).toBe(400);
  });
});

describe("human-in-the-loop gates (FR-017, FR-023)", () => {
  test("generation is refused until the rights attestation is recorded", async () => {
    const { projectId, headers } = await newProject();
    const refused = await enqueue(projectId, headers, { idempotencyKey: "gate-rights" });
    expect(refused.status).toBe(403);
    expect((await refused.json() as { error: string }).error).toContain("rights attestation");
  });

  test("an attestation request that does not explicitly accept is rejected", async () => {
    const { projectId, headers } = await newProject();
    const rejected = await fetch(`${base}/api/projects/${projectId}/rights`, { method: "POST", headers, body: JSON.stringify({ attested: "yes" }) });
    expect(rejected.status).toBe(400);
  });

  test("final generation is refused without an approved animatic", async () => {
    const { projectId, headers } = await newProject();
    await attest(projectId, headers);
    const animaticJobId = await finishedAnimatic(projectId, headers, "gate-animatic");

    const refused = await enqueue(projectId, headers, { idempotencyKey: "gate-final", stage: "final", animaticJobId });
    expect(refused.status).toBe(403);
    expect((await refused.json() as { error: string }).error).toContain("animatic must be approved");
  });

  test("an animatic that has not finished cannot be approved", async () => {
    const { projectId, headers } = await newProject();
    await attest(projectId, headers);
    const animatic = await (await enqueue(projectId, headers, { idempotencyKey: "gate-premature" })).json() as { jobId: string };

    const premature = await fetch(`${base}/api/projects/${projectId}/animatic/decision`, {
      method: "POST",
      headers,
      body: JSON.stringify({ animaticJobId: animatic.jobId, decision: "approved" }),
    });
    expect(premature.status).toBe(409);
  });

  test("approval binds to the animatic's screenplay version and unlocks final generation", async () => {
    const { projectId, headers } = await newProject();
    await attest(projectId, headers);
    const animaticJobId = await finishedAnimatic(projectId, headers, "bind-animatic");

    const approval = await fetch(`${base}/api/projects/${projectId}/animatic/decision`, {
      method: "POST",
      headers,
      body: JSON.stringify({ animaticJobId, decision: "approved" }),
    });
    expect(approval.status).toBe(201);
    expect(await approval.json()).toMatchObject({ animaticJobId, scriptVersion: 1, decision: "approved" });

    const accepted = await enqueue(projectId, headers, { idempotencyKey: "bind-final", stage: "final", animaticJobId });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({ stage: "final", scriptVersion: 1 });
  });

  test("an animatic rendered from an older screenplay cannot be approved after an edit", async () => {
    const { projectId, headers } = await newProject();
    await attest(projectId, headers);
    const animaticJobId = await finishedAnimatic(projectId, headers, "stale-animatic");
    await fetch(`${base}/api/projects/${projectId}/script`, { method: "PUT", headers, body: JSON.stringify({ text: "INT. ROOM - NIGHT\n\nThe lamp dies." }) });

    const stale = await fetch(`${base}/api/projects/${projectId}/animatic/decision`, {
      method: "POST",
      headers,
      body: JSON.stringify({ animaticJobId, decision: "approved" }),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ animaticScriptVersion: 1, currentScriptVersion: 2 });

    const refused = await enqueue(projectId, headers, { idempotencyKey: "stale-final", stage: "final", animaticJobId });
    expect(refused.status).toBe(403);
  });

  test("an approval recorded before an edit does not carry over to the edited screenplay", async () => {
    const { projectId, headers } = await newProject();
    await attest(projectId, headers);
    const animaticJobId = await finishedAnimatic(projectId, headers, "carry-animatic");
    await fetch(`${base}/api/projects/${projectId}/animatic/decision`, {
      method: "POST",
      headers,
      body: JSON.stringify({ animaticJobId, decision: "approved" }),
    });
    await fetch(`${base}/api/projects/${projectId}/script`, { method: "PUT", headers, body: JSON.stringify({ text: "INT. ROOM - NIGHT\n\nThe lamp dies." }) });

    const refused = await enqueue(projectId, headers, { idempotencyKey: "carry-final", stage: "final", animaticJobId });
    expect(refused.status).toBe(409);
    expect((await refused.json() as { error: string }).error).toContain("screenplay changed");
  });

  test("a final job cannot name an animatic from another project", async () => {
    const first = await newProject();
    const second = await newProject();
    await attest(first.projectId, first.headers);
    await attest(second.projectId, second.headers);
    const foreign = await finishedAnimatic(second.projectId, second.headers, "foreign-animatic");
    const refused = await enqueue(first.projectId, first.headers, { idempotencyKey: "foreign-final", stage: "final", animaticJobId: foreign });
    expect(refused.status).toBe(404);
  });
});

describe("capacity tier is server-controlled (FR-030)", () => {
  test("a client cannot self-select the elevated tier", async () => {
    const { projectId, headers } = await newProject();
    await attest(projectId, headers);
    const job = await (await enqueue(projectId, headers, { idempotencyKey: "tier-escalation", tier: "elevated" })).json() as { tierLimits: { maxResolution: string } };
    expect(job.tierLimits.maxResolution).toBe("1280x720");
  });

  test("a signed operator grant issued by the operator CLI raises the tier", async () => {
    process.env.HV_OPERATOR_GRANT_SECRET = "operator-grant-secret-at-least-thirty-two-chars";
    try {
      const { projectId, headers } = await newProject();
      await attest(projectId, headers);
      const grant = mintOperatorGrant(projectId);
      const job = await (await enqueue(projectId, headers, { idempotencyKey: "tier-granted", operatorGrant: grant })).json() as { tierLimits: { maxResolution: string; maxShots: number } };
      expect(job.tierLimits.maxResolution).toBe("1920x1080");
      expect(job.tierLimits.maxShots).toBe(60);
    } finally {
      delete process.env.HV_OPERATOR_GRANT_SECRET;
    }
  });

  test("a long screenplay is condensed to the tier's shot budget instead of being rejected", async () => {
    const { projectId, headers } = await newProject();
    const longScript = Array.from({ length: 16 }, (_, si) =>
      `INT. ROOM ${si + 1} - DAY\n\n${Array.from({ length: 9 }, (_, bi) => `Beat ${si + 1}-${bi + 1} happens.`).join("\n\n")}\n`,
    ).join("\n");
    await fetch(`${base}/api/projects/${projectId}/script`, { method: "PUT", headers, body: JSON.stringify({ text: longScript }) });
    await attest(projectId, headers);
    const res = await enqueue(projectId, headers, { idempotencyKey: "long-script" });
    expect(res.status).toBe(202);
    const job = await res.json() as { totalFrames: number; tierLimits: { maxShots: number } };
    expect(job.tierLimits.maxShots).toBe(24);
  });

  test("a screenplay with more scenes than the shot cap is rejected with a scene-count message", async () => {
    const { projectId, headers } = await newProject();
    const manyScenes = Array.from({ length: 25 }, (_, si) => `INT. ROOM ${si + 1} - DAY\n\nSomething happens.\n`).join("\n");
    await fetch(`${base}/api/projects/${projectId}/script`, { method: "PUT", headers, body: JSON.stringify({ text: manyScenes }) });
    await attest(projectId, headers);
    const res = await enqueue(projectId, headers, { idempotencyKey: "too-many-scenes" });
    expect(res.status).toBe(429);
    const body = await res.json() as { reason: string; error: string };
    expect(body.reason).toBe("shot_limit");
    expect(body.error).toContain("up to 24 scenes");
    expect(body.error).toContain("this one has 25");
  });

  test("a grant minted for another project is ignored", async () => {
    process.env.HV_OPERATOR_GRANT_SECRET = "operator-grant-secret-at-least-thirty-two-chars";
    try {
      const { projectId, headers } = await newProject();
      await attest(projectId, headers);
      const job = await (await enqueue(projectId, headers, { idempotencyKey: "tier-wrong-project", operatorGrant: mintOperatorGrant("some-other-project") })).json() as { tierLimits: { maxResolution: string } };
      expect(job.tierLimits.maxResolution).toBe("1280x720");
    } finally {
      delete process.env.HV_OPERATOR_GRANT_SECRET;
    }
  });

  test("an unsigned operator grant is ignored", async () => {
    const { projectId, headers } = await newProject();
    await attest(projectId, headers);
    const job = await (await enqueue(projectId, headers, { idempotencyKey: "tier-forged", operatorGrant: "not-a-real-grant" })).json() as { tierLimits: { maxResolution: string } };
    expect(job.tierLimits.maxResolution).toBe("1280x720");
  });
});

describe("artifact access is by signed URL only", () => {
  async function finishedCut(): Promise<{ projectId: string; headers: Record<string, string>; output: Record<string, string>; jobId: string }> {
    const { projectId, headers } = await newProject();
    await attest(projectId, headers);
    const jobId = await finishedAnimatic(projectId, headers, `cut-${crypto.randomUUID()}`);
    const status = await (await fetch(`${base}/api/jobs/${jobId}`, { headers })).json() as { output: Record<string, string> };
    return { projectId, headers, output: status.output, jobId };
  }

  test("artifact URLs are signed paths with no query string, and the response sets no cookie", async () => {
    const { output, headers, jobId } = await finishedCut();
    for (const url of Object.values(output)) {
      expect(url).toMatch(/^\/artifacts\/[A-Za-z0-9_.-]+\/[0-9a-f-]+\/[0-9a-f-]+\//);
      expect(url).not.toContain("?");
    }
    const status = await fetch(`${base}/api/jobs/${jobId}`, { headers });
    expect(status.headers.get("set-cookie")).toBeNull();
    const playlist = await fetch(`${base}${output.hlsUrl}`);
    expect(playlist.status).toBe(200);
    expect(playlist.headers.get("set-cookie")).toBeNull();
    expect(await playlist.text()).toContain("#EXTM3U");
  });

  test("relative HLS media segments resolve under the same signed prefix", async () => {
    const { output } = await finishedCut();
    const playlist = await (await fetch(`${base}${output.hlsUrl}`)).text();
    const segment = playlist.split("\n").find((line) => line && !line.startsWith("#"))!;
    const segmentUrl = `${output.hlsUrl.slice(0, output.hlsUrl.lastIndexOf("/"))}/${segment}`;
    const response = await fetch(`${base}${segmentUrl}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("segment");
  });

  test("an unsigned artifact path is rejected", async () => {
    const { projectId, jobId } = await finishedCut();
    expect((await fetch(`${base}/artifacts/${projectId}/${jobId}/hls/index.m3u8`)).status).toBe(401);
  });

  test("a tampered signature, a project token, or another project's signature is rejected", async () => {
    const first = await finishedCut();
    const second = await finishedCut();
    const [, signature, ...rest] = first.output.hlsUrl.split("/").slice(1);
    expect((await fetch(`${base}/artifacts/${signature!.slice(0, -3)}AAA/${rest.join("/")}`)).status).toBe(401);
    const projectToken = first.headers.authorization.slice("Bearer ".length);
    expect((await fetch(`${base}/artifacts/${projectToken}/${rest.join("/")}`)).status).toBe(401);
    const [, otherSignature] = second.output.hlsUrl.split("/").slice(1);
    expect((await fetch(`${base}/artifacts/${otherSignature}/${rest.join("/")}`)).status).toBe(401);
  });

  test("a signed URL cannot escape its cut's directory", async () => {
    const { output, projectId, jobId } = await finishedCut();
    const [, signature] = output.hlsUrl.split("/").slice(1);
    expect((await fetch(`${base}/artifacts/${signature}/${projectId}/${jobId}/..%2F..%2F..%2Fjobs.json`)).status).toBe(404);
    expect((await fetch(`${base}/artifacts/${signature}/${projectId}/..%2F..%2Fjobs.json`)).status).toBe(401);
  });
});

describe("review links surface the cut (AC-015)", () => {
  test("review URLs carry the token in the fragment and the view returns signed playback URLs", async () => {
    const { projectId, headers } = await newProject();
    await attest(projectId, headers);
    await finishedAnimatic(projectId, headers, "review-cut");
    const link = await (await fetch(`${base}/api/projects/${projectId}/reviews`, { method: "POST", headers, body: JSON.stringify({ permission: "approve" }) })).json() as { token: string; reviewUrl: string };
    expect(link.reviewUrl).toBe(`${frontendOrigin}/#/review/${encodeURIComponent(link.token)}`);

    const view = await fetch(`${base}/api/reviews/${encodeURIComponent(link.token)}`);
    expect(view.status).toBe(200);
    expect(view.headers.get("set-cookie")).toBeNull();
    const body = await view.json() as { output: { hlsUrl: string } };
    expect((await fetch(`${base}${body.output.hlsUrl}`)).status).toBe(200);
  });

  test("a review link with no finished cut reports that plainly", async () => {
    const { projectId, headers } = await newProject();
    const link = await (await fetch(`${base}/api/projects/${projectId}/reviews`, { method: "POST", headers, body: JSON.stringify({ permission: "approve" }) })).json() as { token: string };
    const view = await fetch(`${base}/api/reviews/${encodeURIComponent(link.token)}`);
    expect(view.status).toBe(404);
    expect((await view.json() as { error: string }).error).toContain("no finished cut");
  });

  test("an unknown review token is refused rather than 404-ing silently", async () => {
    const view = await fetch(`${base}/api/reviews/${encodeURIComponent("not-a-token")}`);
    expect(view.status).toBe(403);
  });
});

describe("download links are valid for 30 days and bound to one cut (FR-040, AC-013)", () => {
  async function finishedCut(): Promise<{ projectId: string; headers: Record<string, string>; jobId: string }> {
    const { projectId, headers } = await newProject();
    await attest(projectId, headers);
    const jobId = await finishedAnimatic(projectId, headers, `link-${crypto.randomUUID()}`);
    return { projectId, headers, jobId };
  }

  test("a finished job's links expire 30 days after completion, not in an hour", async () => {
    const { projectId, headers, jobId } = await finishedCut();
    const project = await (await fetch(`${base}/api/projects/${projectId}`, { headers })).json() as { deleteAfter: string };
    const job = await (await fetch(`${base}/api/jobs/${jobId}`, { headers })).json() as { completedAt: string; linkExpiresAt: string; artifactUrlsExpireAt: string; artifactUrlsExpireInSeconds: number; output: Record<string, string> };
    expect(new Date(job.linkExpiresAt).getTime() - new Date(job.completedAt).getTime()).toBe(DOWNLOAD_LINK_TTL_MS);
    const expected = Math.min(new Date(job.linkExpiresAt).getTime(), new Date(project.deleteAfter).getTime());
    expect(new Date(job.artifactUrlsExpireAt).getTime()).toBe(expected);
    expect(job.artifactUrlsExpireInSeconds).toBeGreaterThan(29 * 24 * 3600);
    expect(job.artifactUrlsExpireInSeconds).toBeLessThanOrEqual(30 * 24 * 3600);
    const [, signature] = job.output.mp4Url.split("/").slice(1);
    const payload = verifyToken(signature!)!;
    expect(payload.kind).toBe("artifact");
    expect(payload.jobId).toBe(jobId);
    expect(payload.exp).toBe(expected);
  });

  test("a signature for one cut does not open another cut in the same project", async () => {
    const { projectId, headers, jobId } = await finishedCut();
    const secondJobId = await finishedAnimatic(projectId, headers, `link-second-${crypto.randomUUID()}`);
    const first = await (await fetch(`${base}/api/jobs/${jobId}`, { headers })).json() as { output: Record<string, string> };
    const [, signature] = first.output.hlsUrl.split("/").slice(1);
    expect((await fetch(`${base}/artifacts/${signature}/${projectId}/${secondJobId}/hls/index.m3u8`)).status).toBe(401);
    expect((await fetch(`${base}/artifacts/${signature}/${projectId}/${jobId}/hls/index.m3u8`)).status).toBe(200);
  });

  test("a link never outlives the project's retention date", async () => {
    const { projectId, headers, jobId } = await finishedCut();
    const project = await (await fetch(`${base}/api/projects/${projectId}`, { headers })).json() as { deleteAfter: string; jobs: { id: string; artifactUrlsExpireAt: string }[] };
    const listed = project.jobs.find((job) => job.id === jobId)!;
    expect(new Date(listed.artifactUrlsExpireAt).getTime()).toBeLessThanOrEqual(new Date(project.deleteAfter).getTime());
  });

  test("a job that has not finished carries no link and no expiry", async () => {
    const { projectId, headers } = await newProject();
    await attest(projectId, headers);
    const queued = await (await enqueue(projectId, headers, { idempotencyKey: `pending-${crypto.randomUUID()}` })).json() as { jobId: string };
    const job = await (await fetch(`${base}/api/jobs/${queued.jobId}`, { headers })).json() as { output?: unknown; artifactUrlsExpireAt: string | null };
    expect(job.output).toBeUndefined();
    expect(job.artifactUrlsExpireAt).toBeNull();
  });
});

describe("queue-behind is reported to the client and honoured by the worker (AC-011)", () => {
  test("a second job for a free-tier project queues behind its running job", async () => {
    const { projectId, headers } = await newProject();
    await attest(projectId, headers);
    const first = await (await enqueue(projectId, headers, { idempotencyKey: `qb-first-${crypto.randomUUID()}` })).json() as { jobId: string; queueAction: string };
    expect(first.queueAction).toBe("run");
    const store = new DurableJobStore(queuePath);
    let claimed = store.claimNext(Date.now(), {}, { workerId: "qb-worker", leaseMs: 60_000 });
    while (claimed && claimed.id !== first.jobId) claimed = store.claimNext(Date.now(), {}, { workerId: "qb-worker", leaseMs: 60_000 });
    expect(claimed?.id).toBe(first.jobId);
    const second = await (await enqueue(projectId, headers, { idempotencyKey: `qb-second-${crypto.randomUUID()}` })).json() as { jobId: string; queueAction: string; queueReason: string; queuedBehind: number; message: string };
    expect(second.queueAction).toBe("queue_behind");
    expect(second.queueReason).toBe("project_concurrency");
    expect(second.queuedBehind).toBe(1);
    expect(second.message).toContain("Queued behind");
    const listed = store.get(second.jobId)!;
    expect(listed.queuedBehind).toEqual([first.jobId]);
    for (;;) {
      const next = store.claimNext(Date.now(), {}, { leaseMs: 60_000 });
      if (!next) break;
      expect(next.id).not.toBe(second.jobId);
    }
    store.complete(first.jobId, "qb-worker", { mp4Path: "a", hlsPlaylistPath: "b", captionsPath: "c", manifestPath: "d" });
    for (;;) {
      const next = store.claimNext(Date.now(), {}, { leaseMs: 60_000 });
      if (!next) break;
      if (next.id === second.jobId) return;
    }
    throw new Error("the queued-behind job never became claimable");
  });
});

describe("rate limiting protects the API and artifact paths (FR-053, FR-059)", () => {
  const limitedRoot = `/tmp/hv-api-limited-${Date.now()}`;
  let limited: ReturnType<typeof createApiServer>;
  let limitedBase: string;

  beforeAll(() => {
    limited = createApiServer({
      port: 0,
      hostname: "127.0.0.1",
      queuePath: `${limitedRoot}/jobs.json`,
      artifactRoot: `${limitedRoot}/artifacts`,
      statePath: `${limitedRoot}/state/projects.json`,
      costLedgerPath: `${limitedRoot}/state/cost-ledger.json`,
      frontendOrigin,
      rateLimit: { api: { limit: 5, windowMs: 60_000 }, projectCreate: { limit: 2, windowMs: 3600_000 }, artifacts: { limit: 3, windowMs: 60_000 } },
    });
    limitedBase = `http://127.0.0.1:${limited.port}`;
  });

  afterAll(() => limited.stop(true));

  test("project creation has its own tighter budget and answers 429 with Retry-After", async () => {
    expect((await fetch(`${limitedBase}/api/projects`, { method: "POST" })).status).toBe(201);
    expect((await fetch(`${limitedBase}/api/projects`, { method: "POST" })).status).toBe(201);
    const third = await fetch(`${limitedBase}/api/projects`, { method: "POST" });
    expect(third.status).toBe(429);
    expect(Number(third.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await third.json() as { error: string }).error).toContain("Too many requests");
  });

  test("the general API budget throttles after its limit inside the window", async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) statuses.push((await fetch(`${limitedBase}/health`)).status);
    expect(statuses).toEqual([200, 200, 429, 429]);
  });

  test("artifact requests are budgeted separately and unauthenticated probes are throttled too", async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 4; index += 1) statuses.push((await fetch(`${limitedBase}/artifacts/x/y/z/w`)).status);
    expect(statuses).toEqual([401, 401, 401, 429]);
  });

  test("X-Forwarded-For is ignored unless the deployment trusts its proxy", async () => {
    const spoofed = await fetch(`${limitedBase}/health`, { headers: { "x-forwarded-for": "203.0.113.9" } });
    expect(spoofed.status).toBe(429);
  });
});

describe("client address resolution honours only the trusted proxy's hop", () => {
  const withHeader = (value: string | null) =>
    new Request("http://api.test/health", value === null ? {} : { headers: { "x-forwarded-for": value } });

  test("trusted mode takes the last element, never the client-supplied first one", () => {
    expect(clientAddress(withHeader("1.1.1.1, 2.2.2.2"), "127.0.0.1", true)).toBe("2.2.2.2");
    expect(clientAddress(withHeader("1.1.1.1,2.2.2.2 , 3.3.3.3"), "127.0.0.1", true)).toBe("3.3.3.3");
  });

  test("trusted mode accepts a single value and tolerates blank trailing elements", () => {
    expect(clientAddress(withHeader("9.9.9.9"), "127.0.0.1", true)).toBe("9.9.9.9");
    expect(clientAddress(withHeader("9.9.9.9, "), "127.0.0.1", true)).toBe("9.9.9.9");
  });

  test("trusted mode falls back to the socket peer when the header is absent or empty", () => {
    expect(clientAddress(withHeader(null), "10.0.0.7", true)).toBe("10.0.0.7");
    expect(clientAddress(withHeader(""), "10.0.0.7", true)).toBe("10.0.0.7");
    expect(clientAddress(withHeader(" , "), null, true)).toBe("unknown");
  });

  test("untrusted mode keys on the socket peer whatever the header says", () => {
    expect(clientAddress(withHeader("1.1.1.1, 2.2.2.2"), "10.0.0.7", false)).toBe("10.0.0.7");
    expect(clientAddress(withHeader("9.9.9.9"), "10.0.0.7", false)).toBe("10.0.0.7");
    expect(clientAddress(withHeader(null), null, false)).toBe("unknown");
  });
});

describe("a trusted proxy deployment cannot be bypassed with forged X-Forwarded-For prefixes", () => {
  const trustedRoot = `/tmp/hv-api-trusted-${Date.now()}`;
  let trusted: ReturnType<typeof createApiServer>;
  let trustedBase: string;
  let counter = 0;
  const forged = () => `198.51.100.${(counter += 1) % 250}`;

  beforeAll(() => {
    trusted = createApiServer({
      port: 0,
      hostname: "127.0.0.1",
      queuePath: `${trustedRoot}/jobs.json`,
      artifactRoot: `${trustedRoot}/artifacts`,
      statePath: `${trustedRoot}/state/projects.json`,
      costLedgerPath: `${trustedRoot}/state/cost-ledger.json`,
      frontendOrigin,
      rateLimit: { api: { limit: 2, windowMs: 60_000 }, projectCreate: { limit: 2, windowMs: 3600_000 }, artifacts: { limit: 2, windowMs: 60_000 }, trustProxy: true },
    });
    trustedBase = `http://127.0.0.1:${trusted.port}`;
  });

  afterAll(() => trusted.stop(true));

  test("a fresh forged first element per request still shares the bucket of the proxy-appended last hop", async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      statuses.push((await fetch(`${trustedBase}/health`, { headers: { "x-forwarded-for": `${forged()}, 10.0.0.5` } })).status);
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  test("a bare single-value header is keyed on that value, so repeating it exhausts the bucket", async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 3; index += 1) {
      statuses.push((await fetch(`${trustedBase}/health`, { headers: { "x-forwarded-for": "10.0.0.6" } })).status);
    }
    expect(statuses).toEqual([200, 200, 429]);
  });

  test("without any header the trusted server keys on the socket peer", async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 3; index += 1) statuses.push((await fetch(`${trustedBase}/artifacts/x/y/z/w`)).status);
    expect(statuses).toEqual([401, 401, 429]);
  });
});
