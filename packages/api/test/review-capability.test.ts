/**
 * HV-029-01. Two questions that were each answered in more than one place.
 *
 * 1. "Which capabilities may a review link carry?" was spelled out in six
 *    places. Five agreed; the create route coerced everything it did not
 *    recognise to `approve`, so a caller asking for a capability that does not
 *    exist was handed the one that can approve a cut.
 * 2. "Which is the latest finished cut?" was spelled out in two places with two
 *    different comparators, so an unbound review link could resolve to a cut
 *    the owner's own "latest" never pointed at.
 *
 * These tests are written against the HTTP surface, because that is where both
 * defects were reachable, plus one source-level assertion that the closed set
 * is not re-declared — the copies are the defect, and a behavioural test cannot
 * see a copy that currently happens to agree.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DurableJobStore } from "../../queue/src/index";
import { latestFinishedCut } from "../../planner/src/render-stage";
import { REVIEW_PERMISSIONS, isReviewPermission, reviewPermission, ReviewCapabilityError } from "../src/review-capability";
import { createApiServer } from "../src/server";
import { verifyToken } from "../src/tokens";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const root = `/tmp/hv-review-capability-${Date.now()}`;
const queuePath = `${root}/jobs.json`;
const artifactRoot = `${root}/artifacts`;
const generous = { api: { limit: 1_000_000, windowMs: 60_000 }, projectCreate: { limit: 1_000_000, windowMs: 3600_000 }, artifacts: { limit: 1_000_000, windowMs: 60_000 } };

let server: ReturnType<typeof createApiServer>;
let base: string;

beforeAll(() => {
  process.env.HV_TOKEN_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
  server = createApiServer({
    port: 0, hostname: "127.0.0.1", queuePath, artifactRoot,
    statePath: `${root}/state/projects.json`, costLedgerPath: `${root}/state/cost-ledger.json`,
    frontendOrigin: "https://staging.example.test", rateLimit: generous,
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

async function project(): Promise<{ projectId: string; headers: Record<string, string> }> {
  const created = await (await fetch(`${base}/api/projects`, { method: "POST" })).json() as { projectId: string; token: string };
  const headers = { authorization: `Bearer ${created.token}`, "content-type": "application/json" };
  await fetch(`${base}/api/projects/${created.projectId}/script`, { method: "PUT", headers, body: JSON.stringify({ text: "INT. ROOM - DAY\n\nA lamp glows." }) });
  await fetch(`${base}/api/projects/${created.projectId}/rights`, { method: "POST", headers, body: JSON.stringify({ attested: true }) });
  return { projectId: created.projectId, headers };
}

const mintLink = (projectId: string, headers: Record<string, string>, body: unknown) =>
  fetch(`${base}/api/projects/${projectId}/reviews`, { method: "POST", headers, body: JSON.stringify(body) });

const enqueueCut = async (projectId: string, headers: Record<string, string>, key: string): Promise<string> =>
  (await (await fetch(`${base}/api/projects/${projectId}/jobs`, { method: "POST", headers, body: JSON.stringify({ idempotencyKey: key }) })).json() as { jobId: string }).jobId;

/**
 * Completes every queued animatic at the instant its identity is mapped to.
 * Claim order belongs to the queue's fair-share rule, not to the caller, so the
 * disagreement between identity order and completion order is carried by the
 * instants rather than by the order the jobs are finished in.
 */
function completeQueued(projectId: string, completedAtById: Record<string, number>): void {
  const store = new DurableJobStore(queuePath);
  for (let remaining = Object.keys(completedAtById).length; remaining > 0; remaining -= 1) {
    const workerId = `finisher-${remaining}`;
    const claimed = store.claimNext(Date.now(), {}, { workerId, leaseMs: 60_000 });
    if (!claimed) throw new Error("expected a claimable queued cut");
    const jobId = claimed.id, directory = `${artifactRoot}/${projectId}/${jobId}`;
    mkdirSync(`${directory}/hls`, { recursive: true });
    writeFileSync(`${directory}/export.mp4`, "mp4");
    writeFileSync(`${directory}/hls/index.m3u8`, "#EXTM3U\n#EXTINF:2.0,\nsegment-000.ts\n#EXT-X-ENDLIST\n");
    writeFileSync(`${directory}/hls/segment-000.ts`, "segment");
    writeFileSync(`${directory}/captions.vtt`, "WEBVTT\n");
    writeFileSync(`${directory}/provenance.json`, "{}");
    const completedAt = completedAtById[jobId];
    if (completedAt === undefined) throw new Error(`claimed an unexpected job ${jobId}`);
    store.complete(jobId, workerId, {
      mp4Path: `${projectId}/${jobId}/export.mp4`,
      hlsPlaylistPath: `${projectId}/${jobId}/hls/index.m3u8`,
      captionsPath: `${projectId}/${jobId}/captions.vtt`,
      manifestPath: `${projectId}/${jobId}/provenance.json`,
    }, completedAt);
  }
}

test("an unrecognised or missing capability is refused, not rounded up to approve", async () => {
  const { projectId, headers } = await project();
  // Every one of these produced a working *approve* link before this increment:
  // "reviewer" is the P13 role name a caller would most plausibly send, and the
  // rest are the ordinary shapes an untrusted body arrives in.
  const refused = ["reviewer", "READ", "Read", "read ", "", "approve\n", "owner", "director"];
  for (const permission of refused) {
    const response = await mintLink(projectId, headers, { permission });
    expect({ permission, status: response.status }).toEqual({ permission, status: 400 });
    expect(await response.json()).toEqual({ error: "Choose read or approve for this review link." });
  }
  for (const body of [{}, { permission: null }, { permission: 1 }, { permission: true }, { permission: ["read"] }, { permission: { permission: "read" } }]) {
    expect((await mintLink(projectId, headers, body)).status).toBe(400);
  }
  // A refused request mints nothing: no token exists to be presented later.
  expect(await (await fetch(`${base}/api/reviews/${encodeURIComponent("anything")}`)).json()).toHaveProperty("error");
});

test("every member of the closed set round-trips the route, the token and the stored link", async () => {
  // The set itself is pinned: growing it is a deliberate edit that lands here,
  // and a member that the mint or the verifier disagreed about would fail below.
  expect([...REVIEW_PERMISSIONS]).toEqual(["read", "approve"]);
  const { projectId, headers } = await project();
  for (const permission of REVIEW_PERMISSIONS) {
    const response = await mintLink(projectId, headers, { permission });
    expect({ permission, status: response.status }).toEqual({ permission, status: 201 });
    const link = await response.json() as { token: string; permission: string };
    expect(link.permission).toBe(permission);
    const payload = verifyToken(link.token);
    expect(payload).toMatchObject({ kind: "review", projectId, permission });
  }
  expect(isReviewPermission("read")).toBe(true);
  expect(isReviewPermission("reviewer")).toBe(false);
  expect(() => reviewPermission("reviewer")).toThrow(ReviewCapabilityError);
  expect(() => reviewPermission("reviewer")).toThrow("Choose read or approve for this review link.");
  for (const permission of REVIEW_PERMISSIONS) expect(reviewPermission(permission)).toBe(permission);
});

test("the closed set is declared once; no source file outside it names a member", () => {
  // The copies are the defect, and the copy that mattered was a comparison
  // chain, not an array or a union — so this scans for a member named anywhere
  // near the word "permission" rather than for one declaration syntax. An
  // earlier draft of this test matched only `"read" | "approve"` and `["read",
  // "approve"]`; restoring the verifier's `!== "read" && !== "approve"` chain
  // passed it, which is the whole failure this increment is about.
  const sources = [...new Bun.Glob("packages/*/src/**/*.ts").scanSync(REPO_ROOT)].sort();
  expect(sources.length).toBeGreaterThan(100);
  const near = /permission[\s\S]{0,120}?"(read|approve)"|"(read|approve)"[\s\S]{0,120}?permission/i;
  const offenders = sources.filter(file => file !== join("packages", "api", "src", "review-capability.ts")
    && near.test(readFileSync(join(REPO_ROOT, file), "utf8")));
  expect(offenders).toEqual([]);

  // Every reader reaches the set through the module rather than restating it.
  const readers = [
    "packages/api/src/tokens.ts",
    "packages/api/src/index.ts",
    "packages/api/src/server.ts",
    "packages/storage/src/snapshots.ts",
    "packages/storage/src/projects.ts",
  ];
  const importers = sources.filter(file => /from "[^"]*review-capability"/.test(readFileSync(join(REPO_ROOT, file), "utf8")));
  expect(importers.map(file => file.split("\\").join("/")).sort()).toEqual([...readers].sort());
});

test("an unbound review link resolves to the same cut the owner's own latest points at", async () => {
  const { projectId, headers } = await project();
  // Minted while the project has no finished cut, which is the only way the
  // route produces an unbound link.
  const unbound = await (await mintLink(projectId, headers, { permission: "read" })).json() as { token: string; outputBinding?: unknown };
  expect(unbound.outputBinding).toBeUndefined();

  // Two finished cuts whose identity order and completion order are made to
  // disagree: the lexicographically smaller identity is completed last. Job
  // identities are random UUIDs, so this is the only way to test the property
  // rather than a coin flip. Claim order is fixed by the queue, so the
  // completion *instants* carry the disagreement.
  const queued = [await enqueueCut(projectId, headers, "cut-a"), await enqueueCut(projectId, headers, "cut-b")];
  const [lowerId, higherId] = [...queued].sort();
  // Both instants are recent: a completion far in the past expires the cut's
  // download link, and an expired cut is refused before the comparator matters.
  const later = Date.now(), earlier = later - 60_000;
  completeQueued(projectId, Object.fromEntries(queued.map(jobId => [jobId, jobId === lowerId ? later : earlier])));

  const store = new DurableJobStore(queuePath);
  const jobs = store.all();
  expect(jobs.filter(job => job.status === "done")).toHaveLength(2);
  // The two comparators genuinely disagree on this pair, which is what makes
  // the assertion below a test of the fix rather than of a coincidence.
  expect(latestFinishedCut(jobs, projectId)?.id).toBe(lowerId);
  expect([...jobs].sort((a, b) => a.id.localeCompare(b.id)).at(-1)!.id).toBe(higherId);

  // The reviewer's unbound resolution and the owner's binding resolution are
  // now the same rule, so they agree on the same job set.
  const ownerResponse = await mintLink(projectId, headers, { permission: "read" });
  expect(ownerResponse.status).toBe(201);
  const ownerBinding = (await ownerResponse.json() as { outputBinding: { jobId: string } }).outputBinding;
  const reviewed = await (await fetch(`${base}/api/reviews/${encodeURIComponent(unbound.token)}`)).json() as { jobId: string };
  expect(reviewed.jobId).toBe(ownerBinding.jobId);
  expect(latestFinishedCut(jobs, projectId)!.id).toBe(ownerBinding.jobId);
});
