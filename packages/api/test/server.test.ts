import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { DurableJobStore } from "../../queue/src/index";
import { createApiServer } from "../src/server";
import { mintOperatorGrant, verifyToken } from "../src/tokens";

const root = `/tmp/hv-api-${Date.now()}`;
const queuePath = `${root}/jobs.json`;
const artifactRoot = `${root}/artifacts`;
const statePath = `${root}/state/projects.json`;
const costLedgerPath = `${root}/state/cost-ledger.json`;
const frontendOrigin = "https://staging.example.test";
let server: ReturnType<typeof createApiServer>;
let base: string;

beforeAll(() => {
  process.env.HV_TOKEN_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
  server = createApiServer({ port: 0, hostname: "127.0.0.1", queuePath, artifactRoot, statePath, costLedgerPath, frontendOrigin });
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
  new DurableJobStore(queuePath).complete(jobId, {
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

  test("a signed URL cannot escape its project directory", async () => {
    const { output, projectId } = await finishedCut();
    const [, signature] = output.hlsUrl.split("/").slice(1);
    expect((await fetch(`${base}/artifacts/${signature}/${projectId}/..%2F..%2Fjobs.json`)).status).toBe(404);
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
