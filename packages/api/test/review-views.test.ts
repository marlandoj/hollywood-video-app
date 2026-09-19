/**
 * HV-029-05 -- a review link a real reviewer can use.
 *
 * FR-047: review links expire after 7 days or 3 views (configurable). A "view" was
 * every GET of the link, counted before the route knew whether it could show anything.
 * So three early opens before the render finished, or three reloads, killed the link,
 * and whoever watched on the third view could not approve, because a decision was
 * refused once the views were used (and deciding spent a view of its own).
 *
 * A view is now one viewer who was shown the cut; the owner chooses how many (1-25,
 * default 3); a counted viewer may reload and decide, including on the last view.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DurableJobStore, DOWNLOAD_LINK_TTL_MS } from "../../queue/src/index";
import { ProjectService } from "../src/index";
import { REVIEW_VIEW_LIMIT_MAX, reviewViewer } from "../src/review-views";
import { createApiServer } from "../src/server";
import { REVIEW_MAX_VIEWS } from "../src/tokens";

const root = `/tmp/hv-review-views-${Date.now()}`;
const queuePath = `${root}/jobs.json`, artifactRoot = `${root}/artifacts`, statePath = `${root}/state/projects.json`;
const generous = { api: { limit: 1_000_000, windowMs: 60_000 }, projectCreate: { limit: 1_000_000, windowMs: 3600_000 }, artifacts: { limit: 1_000_000, windowMs: 60_000 } };
let server: ReturnType<typeof createApiServer>, base: string;

beforeAll(() => {
  process.env.HV_TOKEN_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
  server = createApiServer({ port: 0, hostname: "127.0.0.1", queuePath, artifactRoot, statePath, costLedgerPath: `${root}/state/cost-ledger.json`,
    frontendOrigin: "https://staging.example.test", rateLimit: generous });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

async function project() {
  const created = await (await fetch(`${base}/api/projects`, { method: "POST" })).json() as { projectId: string; token: string };
  const headers = { authorization: `Bearer ${created.token}`, "content-type": "application/json" };
  await fetch(`${base}/api/projects/${created.projectId}/script`, { method: "PUT", headers, body: JSON.stringify({ text: "INT. ROOM - DAY\n\nA lamp glows." }) });
  await fetch(`${base}/api/projects/${created.projectId}/rights`, { method: "POST", headers, body: JSON.stringify({ attested: true }) });
  return { projectId: created.projectId, headers };
}
const mint = async (projectId: string, headers: Record<string, string>, body: Record<string, unknown> = {}) =>
  fetch(`${base}/api/projects/${projectId}/reviews`, { method: "POST", headers, body: JSON.stringify({ permission: "approve", ...body }) });
const enqueue = (projectId: string, headers: Record<string, string>, key: string) =>
  fetch(`${base}/api/projects/${projectId}/jobs`, { method: "POST", headers, body: JSON.stringify({ idempotencyKey: key }) });
function completeOne(projectId: string, completedAt = Date.now()): string {
  const store = new DurableJobStore(queuePath), workerId = `finisher-${completedAt}-${Math.random()}`;
  const claimed = store.claimNext(Date.now(), {}, { workerId, leaseMs: 60_000 });
  if (!claimed) throw new Error("expected a claimable queued cut");
  const jobId = claimed.id, directory = `${artifactRoot}/${projectId}/${jobId}`;
  mkdirSync(`${directory}/hls`, { recursive: true });
  writeFileSync(`${directory}/export.mp4`, "mp4");
  writeFileSync(`${directory}/hls/index.m3u8`, "#EXTM3U\n#EXTINF:2.0,\nsegment-000.ts\n#EXT-X-ENDLIST\n");
  writeFileSync(`${directory}/hls/segment-000.ts`, "segment");
  writeFileSync(`${directory}/captions.vtt`, "WEBVTT\n");
  writeFileSync(`${directory}/provenance.json`, "{}");
  store.complete(jobId, workerId, { mp4Path: `${projectId}/${jobId}/export.mp4`, hlsPlaylistPath: `${projectId}/${jobId}/hls/index.m3u8`,
    captionsPath: `${projectId}/${jobId}/captions.vtt`, manifestPath: `${projectId}/${jobId}/provenance.json` }, completedAt);
  return jobId;
}
const viewer = (n: number) => `viewer-${String(n).padStart(3, "0")}-abcdefghijklmnop`;
const open = (token: string, who?: string) => fetch(`${base}/api/reviews/${encodeURIComponent(token)}`, { headers: who ? { "x-hv-review-viewer": who } : {} });
const decide = (token: string, who?: string, decision = "approved") => fetch(`${base}/api/reviews/${encodeURIComponent(token)}/decision`,
  { method: "POST", headers: { "content-type": "application/json", ...(who ? { "x-hv-review-viewer": who } : {}) }, body: JSON.stringify({ decision, note: "" }) });
const stored = (token: string) => (JSON.parse(readFileSync(statePath, "utf8")) as { reviewLinks: { token: string; views: number; maxViews?: number; viewers?: string[] }[] })
  .reviewLinks.find(link => link.token === token)!;

describe("a view is a viewer who was shown the cut", () => {
  test("opening before the render finishes costs nothing", async () => {
    const { projectId, headers } = await project();
    const { token } = await (await mint(projectId, headers, { maxViews: 3 })).json() as { token: string };
    for (let attempt = 0; attempt < 5; attempt++) expect((await open(token, viewer(1))).status).toBe(404);
    expect(stored(token).views).toBe(0);
    await enqueue(projectId, headers, "first");
    completeOne(projectId);
    const shown = await open(token, viewer(1));
    expect(shown.status).toBe(200);
    expect(((await shown.json()) as { viewsRemaining: number }).viewsRemaining).toBe(2);
  });

  test("a refused cut costs nothing", async () => {
    const { projectId, headers } = await project();
    const { token } = await (await mint(projectId, headers, { maxViews: 1 })).json() as { token: string };
    await enqueue(projectId, headers, "expired");
    completeOne(projectId, Date.now() - DOWNLOAD_LINK_TTL_MS - 60_000);
    expect((await open(token, viewer(1))).status).toBe(409);
    expect(stored(token).views).toBe(0);
  });

  test("reloading is not another viewer, and a counted viewer may return after the limit is reached", async () => {
    const { projectId, headers } = await project();
    await enqueue(projectId, headers, "cut");
    completeOne(projectId);
    const { token } = await (await mint(projectId, headers, { maxViews: 2 })).json() as { token: string };
    for (let reload = 0; reload < 4; reload++) expect((await open(token, viewer(1))).status).toBe(200);
    expect(stored(token).views).toBe(1);
    expect((await open(token, viewer(2))).status).toBe(200);
    expect(stored(token).views).toBe(2);
    expect((await open(token, viewer(3))).status).toBe(403);
    expect((await open(token)).status).toBe(403);
    const back = await open(token, viewer(1));
    expect(back.status).toBe(200);
    expect(((await back.json()) as { viewsRemaining: number }).viewsRemaining).toBe(0);
    expect(stored(token).views).toBe(2);
  });

  test("the link keeps only a hash of each viewer id", async () => {
    const { projectId, headers } = await project();
    await enqueue(projectId, headers, "cut");
    completeOne(projectId);
    const { token } = await (await mint(projectId, headers, { maxViews: 3 })).json() as { token: string };
    await open(token, viewer(7));
    const link = stored(token);
    expect(link.viewers).toEqual([reviewViewer(viewer(7))!.hash]);
    expect(readFileSync(statePath, "utf8")).not.toContain(viewer(7));
  });

  test("a malformed viewer id is treated as no id: every serve counts, as before", async () => {
    expect(reviewViewer("short")).toBeNull();
    expect(reviewViewer("has spaces in it but is long enough")).toBeNull();
    const { projectId, headers } = await project();
    await enqueue(projectId, headers, "cut");
    completeOne(projectId);
    const { token } = await (await mint(projectId, headers, { maxViews: 2 })).json() as { token: string };
    expect((await open(token, "short")).status).toBe(200);
    expect((await open(token, "short")).status).toBe(200);
    expect((await open(token, "short")).status).toBe(403);
  });
});

describe("the reviewer who watched can decide", () => {
  test("on the last view, and deciding does not spend a view", async () => {
    const { projectId, headers } = await project();
    await enqueue(projectId, headers, "cut");
    completeOne(projectId);
    const { token } = await (await mint(projectId, headers, { maxViews: 1 })).json() as { token: string };
    expect((await open(token, viewer(1))).status).toBe(200);
    const decided = await decide(token, viewer(1));
    expect(decided.status).toBe(200);
    expect(stored(token).views).toBe(1);
  });

  test("someone who was never shown the cut cannot decide on a counting link", async () => {
    const { projectId, headers } = await project();
    await enqueue(projectId, headers, "cut");
    completeOne(projectId);
    const { token } = await (await mint(projectId, headers, { maxViews: 3 })).json() as { token: string };
    expect((await open(token, viewer(1))).status).toBe(200);
    expect((await decide(token, viewer(2))).status).toBe(409);
    expect((await decide(token)).status).toBe(409);
  });

  test("a link without viewer ids decides on its last view too (the old rule refused it)", async () => {
    const { projectId, headers } = await project();
    await enqueue(projectId, headers, "cut");
    completeOne(projectId);
    const { token } = await (await mint(projectId, headers)).json() as { token: string };
    for (let view = 0; view < REVIEW_MAX_VIEWS; view++) expect((await open(token)).status).toBe(200);
    expect((await open(token)).status).toBe(403);
    expect((await decide(token)).status).toBe(200);
    expect(stored(token).views).toBe(REVIEW_MAX_VIEWS);
    expect(stored(token).viewers).toBeUndefined();
  });
});

describe("the owner chooses the limit", () => {
  test("FR-047's default of three is unchanged, and 1 to 25 may be chosen", async () => {
    expect(REVIEW_MAX_VIEWS).toBe(3);
    expect(REVIEW_VIEW_LIMIT_MAX).toBe(25);
    const { projectId, headers } = await project();
    const plain = await (await mint(projectId, headers)).json() as { maxViews?: number; token: string };
    expect(plain.maxViews).toBeUndefined();
    expect(new ProjectService(statePath).openReviewLink(plain.token, null)?.viewsRemaining).toBe(3);
    for (const maxViews of [1, 10, 25]) expect((await mint(projectId, headers, { maxViews })).status).toBe(201);
  });

  test("anything else is refused before a link exists", async () => {
    const { projectId, headers } = await project();
    for (const maxViews of [0, 26, -1, 1.5, "3", null, true]) {
      const response = await mint(projectId, headers, { maxViews });
      expect(response.status).toBe(400);
      expect(((await response.json()) as { error: string }).error).toContain("view limit");
    }
  });

  test("the limit and viewers survive a restart", async () => {
    const { projectId, headers } = await project();
    await enqueue(projectId, headers, "cut");
    completeOne(projectId);
    const { token } = await (await mint(projectId, headers, { maxViews: 4 })).json() as { token: string };
    await open(token, viewer(1));
    const restarted = new ProjectService(statePath);
    expect(restarted.openReviewLink(token, reviewViewer(viewer(1)))?.viewsRemaining).toBe(3);
  });

  test("a state snapshot carries them, and refuses a malformed limit or viewer list", async () => {
    const { readStateSnapshot, validateSnapshot } = await import("../../storage/src/snapshots");
    const { GOLDEN_SOURCE } = await import("../../storage/test/fixtures/archive-golden/matrix");
    const golden = readStateSnapshot(GOLDEN_SOURCE), projectId = golden.projects.projects[0]!.id;
    const hash = reviewViewer(viewer(1))!.hash;
    const withLink = (link: Record<string, unknown>) => ({...golden, projects: {...golden.projects, reviewLinks: [{
      token: "t".repeat(40), projectId, permission: "approve", views: 1, revoked: false, decision: null, decisionNote: null, ...link}]}});
    expect(validateSnapshot(withLink({}) as typeof golden)).toBeTruthy();
    expect(validateSnapshot(withLink({maxViews: 5, viewers: [hash]}) as typeof golden)).toBeTruthy();
    for (const bad of [{maxViews: 0}, {maxViews: 26}, {maxViews: 2.5}, {viewers: [hash, hash]}, {viewers: ["not-a-hash"]},
      {views: 0, viewers: [hash]}, {viewers: "x"}])
      expect(() => validateSnapshot(withLink(bad) as typeof golden)).toThrow("invalid review link");
  });
});

test("the state file exists for the suite", () => { expect(existsSync(statePath)).toBe(true); });
