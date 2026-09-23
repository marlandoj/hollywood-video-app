/**
 * HV-029-08 — a review link that could not be withdrawn, handing out URLs that outlived it.
 *
 * A review link is this studio's whole answer to "show someone my film without making them an
 * account". It lives seven days and admits a named number of viewers. Three things were wrong with
 * what that promise actually bought:
 *
 * 1. **It could not be revoked.** `ProjectService.revokeReviewLink` and
 *    `PostgresProjectService.revokeReviewLink` have both existed, and been unit-tested, since review
 *    links did. Neither had a route. `server.ts` had exactly three — create, open, decide — and the
 *    frontend only creates. Every refusal in the path says "invalid, expired, revoked, or fully
 *    used" about a state no caller could reach.
 * 2. **The media URLs outlived the link by twenty-three days.** `signedOutput` minted them with
 *    `artifactLinkExpiry`, which clamps to the job's own thirty days and the project's deletion
 *    date and knew nothing about the review token's seven. So the one admitted viewer of a
 *    `maxViews: 1` link kept working `mp4Url`, `hlsUrl` and `captionsUrl` for three more weeks — no
 *    review token needed, no viewer header needed — after the link itself answered 403.
 * 3. **The one anonymous route was the one route with no cache directive.** About thirty owner
 *    routes send `private, no-store`; the review GET sent none, so a shared cache applies heuristic
 *    freshness to a body carrying signed media URLs and the project id — and replays it *without
 *    reaching the origin*, so without counting a view, which is the bound the link is built on.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { DurableJobStore } from "../../queue/src/index";
import { REVIEW_TOKEN_TTL_MS } from "../src/tokens";
import { createApiServer } from "../src/server";

const root = `/tmp/hv-review-life-${Date.now()}`;
const queuePath = `${root}/jobs.json`, artifactRoot = `${root}/artifacts`, statePath = `${root}/state/projects.json`;
const generous = { api: { limit: 1_000_000, windowMs: 60_000 }, projectCreate: { limit: 1_000_000, windowMs: 3600_000 }, artifacts: { limit: 1_000_000, windowMs: 60_000 } };
let server: ReturnType<typeof createApiServer>, base: string;
beforeAll(() => {
  process.env.HV_TOKEN_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
  server = createApiServer({ port: 0, hostname: "127.0.0.1", queuePath, artifactRoot, statePath,
    costLedgerPath: `${root}/state/cost-ledger.json`, frontendOrigin: "https://staging.example.test", rateLimit: generous });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

async function filmed() {
  const created = await (await fetch(`${base}/api/projects`, { method: "POST" })).json() as { projectId: string; token: string };
  const headers = { authorization: `Bearer ${created.token}`, "content-type": "application/json" };
  await fetch(`${base}/api/projects/${created.projectId}/script`, { method: "PUT", headers, body: JSON.stringify({ text: "INT. ROOM - DAY\n\nA lamp glows." }) });
  await fetch(`${base}/api/projects/${created.projectId}/rights`, { method: "POST", headers, body: JSON.stringify({ attested: true }) });
  await fetch(`${base}/api/projects/${created.projectId}/jobs`, { method: "POST", headers, body: JSON.stringify({}) });
  // Finish it on disk, which is what gives the cut a `completedAt` and therefore a thirty-day link.
  const store = new DurableJobStore(queuePath), workerId = `finisher-${crypto.randomUUID()}`;
  const claimed = store.claimNext(Date.now(), {}, { workerId, leaseMs: 60_000 });
  if (!claimed) throw new Error("expected a claimable queued cut");
  const directory = `${artifactRoot}/${created.projectId}/${claimed.id}`;
  mkdirSync(`${directory}/hls`, { recursive: true });
  writeFileSync(`${directory}/export.mp4`, "mp4");
  writeFileSync(`${directory}/hls/index.m3u8`, "#EXTM3U\n#EXTINF:2.0,\nsegment-000.ts\n#EXT-X-ENDLIST\n");
  writeFileSync(`${directory}/hls/segment-000.ts`, "segment");
  writeFileSync(`${directory}/captions.vtt`, "WEBVTT\n");
  writeFileSync(`${directory}/provenance.json`, "{}");
  store.complete(claimed.id, workerId, { mp4Path: `${created.projectId}/${claimed.id}/export.mp4`,
    hlsPlaylistPath: `${created.projectId}/${claimed.id}/hls/index.m3u8`,
    captionsPath: `${created.projectId}/${claimed.id}/captions.vtt`,
    manifestPath: `${created.projectId}/${claimed.id}/provenance.json` }, Date.now());
  return { ...created, headers, jobId: claimed.id };
}
const mint = async (projectId: string, headers: Record<string, string>, body: Record<string, unknown> = {}) =>
  await (await fetch(`${base}/api/projects/${projectId}/reviews`, { method: "POST", headers, body: JSON.stringify({ permission: "read", ...body }) })).json() as { token: string };
const open = (token: string, viewer?: string) => fetch(`${base}/api/reviews/${encodeURIComponent(token)}`,
  viewer ? { headers: { "x-hv-review-viewer": viewer } } : undefined);

test("an owner can withdraw a link they have shared, and only their own", async () => {
  const film = await filmed(), link = await mint(film.projectId, film.headers, { maxViews: 5 });
  expect((await open(link.token)).status).toBe(200);
  // Before this increment there was no route at all: DELETE was a 404 and POST .../revoke a 400.
  const revoked = await fetch(`${base}/api/projects/${film.projectId}/reviews/${encodeURIComponent(link.token)}`,
    { method: "DELETE", headers: film.headers });
  expect(revoked.status).toBe(200);
  expect(await revoked.json()).toEqual({ revoked: true });
  expect((await open(link.token)).status).toBe(403);
  // Revoking is the owner's, and it is theirs alone.
  const other = await filmed(), theirs = await mint(other.projectId, other.headers);
  const stranger = await fetch(`${base}/api/projects/${other.projectId}/reviews/${encodeURIComponent(theirs.token)}`,
    { method: "DELETE", headers: film.headers });
  expect(stranger.status).toBe(401);
  expect((await open(theirs.token)).status).toBe(200);
  // And a link this project never issued is a 404 rather than a silent success.
  expect((await fetch(`${base}/api/projects/${film.projectId}/reviews/${encodeURIComponent("rv_" + "a".repeat(80))}`,
    { method: "DELETE", headers: film.headers })).status).toBe(404);
  // Revoking again is still refused, and the link stays refused.
  expect((await fetch(`${base}/api/projects/${film.projectId}/reviews/${encodeURIComponent(link.token)}`,
    { method: "DELETE", headers: film.headers })).status).toBe(200);
  expect((await open(link.token)).status).toBe(403);
});

test("and the media URLs a viewer is given last as long as the link, not as long as the film", async () => {
  const film = await filmed(), link = await mint(film.projectId, film.headers, { maxViews: 1 });
  const served = await open(link.token, crypto.randomUUID());
  expect(served.status).toBe(200);
  const body = await served.json() as { output: Record<string, string>; artifactUrlsExpireAt: string };
  const days = (Date.parse(body.artifactUrlsExpireAt) - Date.now()) / 86_400_000;
  // Seven, not thirty: the link's own life. Before this increment this figure was 30.00.
  expect({ days: Math.round(days), link: Math.round(REVIEW_TOKEN_TTL_MS / 86_400_000) })
    .toEqual({ days: Math.round(REVIEW_TOKEN_TTL_MS / 86_400_000), link: Math.round(REVIEW_TOKEN_TTL_MS / 86_400_000) });
  expect(days).toBeLessThan(29);
  // The URLs still work, which is the point of giving them out at all.
  for (const key of ["mp4Url", "captionsUrl"]) {
    const asset = await fetch(new URL(body.output[key]!, base));
    expect({ key, status: asset.status }).toEqual({ key, status: 200 });
  }
  // And the owner's own view of the same cut is unchanged: their links are the job's thirty days.
  const owned = await (await fetch(`${base}/api/jobs/${film.jobId}`, { headers: film.headers })).json() as { artifactUrlsExpireAt: string };
  expect(Math.round((Date.parse(owned.artifactUrlsExpireAt) - Date.now()) / 86_400_000)).toBe(30);
});

test("and no response that carries a token or a signed URL invites a shared cache to keep it", async () => {
  const film = await filmed();
  const created = await fetch(`${base}/api/projects`, { method: "POST" });
  expect(created.headers.get("cache-control")).toBe("private, no-store");
  const minted = await fetch(`${base}/api/projects/${film.projectId}/reviews`, { method: "POST", headers: film.headers, body: JSON.stringify({ permission: "read" }) });
  expect(minted.headers.get("cache-control")).toBe("private, no-store");
  const link = await minted.json() as { token: string };
  // The one route reachable without a bearer token, and the one that had no directive at all. A
  // cached copy replays the signed URLs *and* skips the view count, which is the link's own bound.
  const served = await open(link.token, crypto.randomUUID());
  expect(served.status).toBe(200);
  expect(served.headers.get("cache-control")).toBe("private, no-store");
});
