import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApiServer } from "../src/server";
import { mintOperatorGrant } from "../src/tokens";

const root = `/tmp/hv-api-${Date.now()}`;
const queuePath = `${root}/jobs.json`;
const artifactRoot = `${root}/artifacts`;
const statePath = `${root}/state/projects.json`;
const costLedgerPath = `${root}/state/cost-ledger.json`;
let server: ReturnType<typeof createApiServer>;
let base: string;

beforeAll(() => {
  process.env.HV_TOKEN_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
  server = createApiServer({ port: 0, hostname: "127.0.0.1", queuePath, artifactRoot, statePath, costLedgerPath });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

async function newProject(): Promise<{ projectId: string; token: string; headers: Record<string, string> }> {
  const created = await (await fetch(`${base}/api/projects`, { method: "POST" })).json() as { projectId: string; token: string };
  const headers = { authorization: `Bearer ${created.token}`, "content-type": "application/json" };
  await fetch(`${base}/api/projects/${created.projectId}/script`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ text: "INT. ROOM - DAY\n\nA lamp glows." }),
  });
  return { ...created, headers };
}

describe("private staging API reachability", () => {
  test("health endpoint reports queue state and month spend", async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "healthy", queueDepth: 0, monthSpendUsd: 0 });
  });

  test("anonymous project, script, and durable job journey is reachable", async () => {
    const { projectId, token, headers } = await newProject();
    await fetch(`${base}/api/projects/${projectId}/rights`, { method: "POST", headers, body: JSON.stringify({ attested: true }) });

    const jobResponse = await fetch(`${base}/api/projects/${projectId}/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ idempotencyKey: "journey-1" }),
    });
    expect(jobResponse.status).toBe(202);
    const job = await jobResponse.json() as { jobId: string; status: string; stage: string };
    expect(job.status).toBe("queued");
    expect(job.stage).toBe("animatic");

    const statusResponse = await fetch(`${base}/api/jobs/${job.jobId}`, { headers: { authorization: `Bearer ${token}` } });
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({ id: job.jobId, status: "queued", stage: "animatic" });
  });
});

describe("human-in-the-loop gates (FR-017, FR-023)", () => {
  test("generation is refused until the rights attestation is recorded", async () => {
    const { projectId, headers } = await newProject();
    const refused = await fetch(`${base}/api/projects/${projectId}/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ idempotencyKey: "gate-rights" }),
    });
    expect(refused.status).toBe(403);
    expect((await refused.json() as { error: string }).error).toContain("rights attestation");
  });

  test("an attestation request that does not explicitly accept is rejected", async () => {
    const { projectId, headers } = await newProject();
    const rejected = await fetch(`${base}/api/projects/${projectId}/rights`, {
      method: "POST",
      headers,
      body: JSON.stringify({ attested: "yes" }),
    });
    expect(rejected.status).toBe(400);
  });

  test("final generation is refused without an approved animatic", async () => {
    const { projectId, headers } = await newProject();
    await fetch(`${base}/api/projects/${projectId}/rights`, { method: "POST", headers, body: JSON.stringify({ attested: true }) });
    const animatic = await (await fetch(`${base}/api/projects/${projectId}/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ idempotencyKey: "gate-animatic" }),
    })).json() as { jobId: string };

    const refused = await fetch(`${base}/api/projects/${projectId}/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ idempotencyKey: "gate-final", stage: "final", animaticJobId: animatic.jobId }),
    });
    expect(refused.status).toBe(403);
    expect((await refused.json() as { error: string }).error).toContain("animatic must be approved");
  });

  test("an animatic that has not finished cannot be approved", async () => {
    const { projectId, headers } = await newProject();
    await fetch(`${base}/api/projects/${projectId}/rights`, { method: "POST", headers, body: JSON.stringify({ attested: true }) });
    const animatic = await (await fetch(`${base}/api/projects/${projectId}/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ idempotencyKey: "gate-premature" }),
    })).json() as { jobId: string };

    const premature = await fetch(`${base}/api/projects/${projectId}/animatic/decision`, {
      method: "POST",
      headers,
      body: JSON.stringify({ animaticJobId: animatic.jobId, decision: "approved" }),
    });
    expect(premature.status).toBe(409);
  });
});

describe("capacity tier is server-controlled (FR-030)", () => {
  test("a client cannot self-select the elevated tier", async () => {
    const { projectId, headers } = await newProject();
    await fetch(`${base}/api/projects/${projectId}/rights`, { method: "POST", headers, body: JSON.stringify({ attested: true }) });
    const job = await (await fetch(`${base}/api/projects/${projectId}/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ idempotencyKey: "tier-escalation", tier: "elevated" }),
    })).json() as { tierLimits: { maxResolution: string } };
    expect(job.tierLimits.maxResolution).toBe("1280x720");
  });

  test("a signed operator grant issued by the operator CLI raises the tier", async () => {
    process.env.HV_OPERATOR_GRANT_SECRET = "operator-grant-secret-at-least-thirty-two-chars";
    try {
      const { projectId, headers } = await newProject();
      await fetch(`${base}/api/projects/${projectId}/rights`, { method: "POST", headers, body: JSON.stringify({ attested: true }) });
      const grant = mintOperatorGrant(projectId);
      const job = await (await fetch(`${base}/api/projects/${projectId}/jobs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ idempotencyKey: "tier-granted", operatorGrant: grant }),
      })).json() as { tierLimits: { maxResolution: string; maxShots: number } };
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
      await fetch(`${base}/api/projects/${projectId}/rights`, { method: "POST", headers, body: JSON.stringify({ attested: true }) });
      const job = await (await fetch(`${base}/api/projects/${projectId}/jobs`, {
        method: "POST",
        headers,
        body: JSON.stringify({ idempotencyKey: "tier-wrong-project", operatorGrant: mintOperatorGrant("some-other-project") }),
      })).json() as { tierLimits: { maxResolution: string } };
      expect(job.tierLimits.maxResolution).toBe("1280x720");
    } finally {
      delete process.env.HV_OPERATOR_GRANT_SECRET;
    }
  });

  test("an unsigned operator grant is ignored", async () => {
    const { projectId, headers } = await newProject();
    await fetch(`${base}/api/projects/${projectId}/rights`, { method: "POST", headers, body: JSON.stringify({ attested: true }) });
    const job = await (await fetch(`${base}/api/projects/${projectId}/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ idempotencyKey: "tier-forged", operatorGrant: "not-a-real-grant" }),
    })).json() as { tierLimits: { maxResolution: string } };
    expect(job.tierLimits.maxResolution).toBe("1280x720");
  });
});

describe("artifact access control", () => {
  test("artifact URLs carry no token in the query string", async () => {
    const { projectId, headers } = await newProject();
    await fetch(`${base}/api/projects/${projectId}/rights`, { method: "POST", headers, body: JSON.stringify({ attested: true }) });
    const job = await (await fetch(`${base}/api/projects/${projectId}/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ idempotencyKey: "artifact-urls" }),
    })).json() as { jobId: string };
    const status = await (await fetch(`${base}/api/jobs/${job.jobId}`, { headers })).json() as { output?: Record<string, string> };
    for (const url of Object.values(status.output ?? {})) expect(url).not.toContain("token=");
  });

  test("an anonymous artifact request is rejected", async () => {
    const response = await fetch(`${base}/artifacts/some-project/some-job/hls/index.m3u8`);
    expect(response.status).toBe(401);
  });

  test("an artifact session issues a path-scoped HttpOnly cookie", async () => {
    const { projectId, headers } = await newProject();
    const session = await fetch(`${base}/api/projects/${projectId}/artifact-session`, { method: "POST", headers });
    expect(session.status).toBe(201);
    const cookie = session.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("hv_artifact=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Path=/artifacts/");
  });

  test("an artifact cookie for one project cannot read another project", async () => {
    const first = await newProject();
    const second = await newProject();
    const session = await fetch(`${base}/api/projects/${first.projectId}/artifact-session`, { method: "POST", headers: first.headers });
    const cookie = (session.headers.get("set-cookie") ?? "").split(";")[0]!;
    const response = await fetch(`${base}/artifacts/${second.projectId}/job/hls/index.m3u8`, { headers: { cookie } });
    expect(response.status).toBe(401);
  });
});

describe("review links surface the cut (AC-015)", () => {
  test("a review link with no finished cut reports that plainly", async () => {
    const { projectId, headers } = await newProject();
    const link = await (await fetch(`${base}/api/projects/${projectId}/reviews`, {
      method: "POST",
      headers,
      body: JSON.stringify({ permission: "approve" }),
    })).json() as { token: string };

    const view = await fetch(`${base}/api/reviews/${encodeURIComponent(link.token)}`);
    expect(view.status).toBe(404);
    expect((await view.json() as { error: string }).error).toContain("no finished cut");
  });

  test("an unknown review token is refused rather than 404-ing silently", async () => {
    const view = await fetch(`${base}/api/reviews/${encodeURIComponent("not-a-token")}`);
    expect(view.status).toBe(403);
  });
});
