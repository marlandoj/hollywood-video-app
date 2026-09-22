/**
 * HV-030-07 — the request key the server derives when the caller names none.
 *
 * `POST /api/projects/:id/jobs` accepts an `idempotencyKey`, and when the caller sends none it
 * derives one from what the render is *of*:
 * `${stage}:${scriptVersion}:cast-${castingVersion}[:direction-${directionVersion}]`. A repeat of an
 * admitted key is answered with the job that was admitted, rather than admitting a second one.
 *
 * The studio front door overrode that with `crypto.randomUUID()` on all three of its picture
 * renders, so every retry was a new film. `studio-retry.test.js` asserts the studio names no key;
 * this file is what makes that assertion mean something — the rule it is relying on, exercised
 * through the real server.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createApiServer } from "../src/server";

const root = `/tmp/hv-job-key-${Date.now()}`;
const generous = { api: { limit: 1_000_000, windowMs: 60_000 }, projectCreate: { limit: 1_000_000, windowMs: 3600_000 }, artifacts: { limit: 1_000_000, windowMs: 60_000 } };
const SCRIPT = "INT. KITCHEN - DAY\n\nMaya pours tea.\n\nMAYA\nYou came back.";
let server: ReturnType<typeof createApiServer>, base: string;
beforeAll(() => {
  process.env.HV_TOKEN_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
  server = createApiServer({ port: 0, hostname: "127.0.0.1", queuePath: `${root}/jobs.json`, artifactRoot: `${root}/artifacts`,
    statePath: `${root}/projects.json`, costLedgerPath: `${root}/cost.json`, frontendOrigin: "https://staging.example.test", rateLimit: generous });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

async function project() {
  const created = await (await fetch(`${base}/api/projects`, { method: "POST" })).json() as { projectId: string; token: string };
  const headers = { authorization: `Bearer ${created.token}`, "content-type": "application/json" };
  await fetch(`${base}/api/projects/${created.projectId}/script`, { method: "PUT", headers, body: JSON.stringify({ text: SCRIPT }) });
  await fetch(`${base}/api/projects/${created.projectId}/rights`, { method: "POST", headers, body: JSON.stringify({ attested: true }) });
  return { ...created, headers };
}
const render = async (id: string, headers: Record<string, string>, body: Record<string, unknown> = {}) => {
  const response = await fetch(`${base}/api/projects/${id}/jobs`, { method: "POST", headers, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() as { jobId?: string; error?: string } };
};

test("a render asked for twice with no request key is one job, not two", async () => {
  const { projectId, headers } = await project();
  const first = await render(projectId, headers);
  expect(first.status).toBe(202);
  expect(first.body.jobId).toBeTruthy();
  // The same request again -- which is what a creator pressing the button a second time sends,
  // after a lost connection or a failure in a step that ran after the render.
  const second = await render(projectId, headers);
  expect(second.status).toBe(202);
  expect(second.body.jobId).toBe(first.body.jobId!);
  // And the final is its own render, because the stage is part of what the key is derived from.
  const final = await render(projectId, headers, { stage: "final", animaticJobId: first.body.jobId });
  expect(final.body.jobId).not.toBe(first.body.jobId!);
  expect((await render(projectId, headers, { stage: "final", animaticJobId: first.body.jobId })).body.jobId).toBe(final.body.jobId!);
});

test("and a fresh key for the same render is a second job, which is what the studio was sending", async () => {
  const { projectId, headers } = await project();
  const keyed = await Promise.all([1, 2, 3].map(() => render(projectId, headers, { idempotencyKey: crypto.randomUUID() })));
  const ids = new Set(keyed.map(result => result.body.jobId));
  expect({ presses: keyed.length, films: ids.size }).toEqual({ presses: 3, films: 3 });
  // The same three presses without a key are one film. That difference is the whole increment.
  const { projectId: other, headers: otherHeaders } = await project();
  const unkeyed = [];
  for (const _ of [1, 2, 3]) unkeyed.push((await render(other, otherHeaders)).body.jobId);
  expect({ presses: unkeyed.length, films: new Set(unkeyed).size }).toEqual({ presses: 3, films: 1 });
});

test("and a render of something else is a different key, so nothing is wrongly deduplicated", async () => {
  const { projectId, headers } = await project();
  const first = (await render(projectId, headers)).body.jobId!;
  // A new screenplay version is a different film to render, and the derived key says so.
  await fetch(`${base}/api/projects/${projectId}/script`, { method: "PUT", headers,
    body: JSON.stringify({ text: SCRIPT + "\n\nEXT. GARDEN - NIGHT\n\nLeo waits in the rain." }) });
  const second = (await render(projectId, headers)).body.jobId!;
  expect(second).not.toBe(first);
  expect((await render(projectId, headers)).body.jobId).toBe(second);
});
