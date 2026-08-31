import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createApiServer } from "../src/server";

const root = `/tmp/hv-api-${Date.now()}`;
let server: ReturnType<typeof createApiServer>;
let base: string;

beforeAll(() => {
  process.env.HV_TOKEN_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
  server = createApiServer({ port: 0, hostname: "127.0.0.1", queuePath: `${root}/jobs.json`, artifactRoot: `${root}/artifacts` });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(() => server.stop(true));

describe("private staging API reachability", () => {
  test("health endpoint reports queue state", async () => {
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "healthy", queueDepth: 0 });
  });

  test("anonymous project, script, and durable job journey is reachable", async () => {
    const createdResponse = await fetch(`${base}/api/projects`, { method: "POST" });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json() as { projectId: string; token: string };
    const headers = { authorization: `Bearer ${created.token}`, "content-type": "application/json" };

    const scriptResponse = await fetch(`${base}/api/projects/${created.projectId}/script`, {
      method: "PUT",
      headers,
      body: JSON.stringify({ text: "INT. ROOM - DAY\n\nA lamp glows." }),
    });
    expect(scriptResponse.status).toBe(200);

    const jobResponse = await fetch(`${base}/api/projects/${created.projectId}/jobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ idempotencyKey: "journey-1" }),
    });
    expect(jobResponse.status).toBe(202);
    const job = await jobResponse.json() as { jobId: string; status: string };
    expect(job.status).toBe("queued");

    const statusResponse = await fetch(`${base}/api/jobs/${job.jobId}`, { headers: { authorization: `Bearer ${created.token}` } });
    expect(statusResponse.status).toBe(200);
    expect(await statusResponse.json()).toMatchObject({ id: job.jobId, status: "queued" });
  });
});
