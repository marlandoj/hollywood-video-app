/**
 * HV-029-14 -- timecoded review comments and per-stage approvals.
 *
 * A review link let a reviewer approve a cut or request changes, with one free-text note. There was
 * no way to say *where*: "the cut at the kitchen door is early" had to be written out and found by
 * scrubbing. And the owner never saw a reviewer's decision at all -- there was no route that listed
 * one -- let alone which stage of the film it approved.
 *
 * Now a reviewer who may decide may also pin comments to frames (30 fps) of the one cut the link is
 * bound to. The owner lists every link's comments and decisions, sees them per stage (rough cut,
 * final, picture edit, sound mix, deliverable), and resolves comments. A comment is bounded, passes
 * the same content-policy gate as a prompt, and names no one: at most the link's viewer hash.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { DurableJobStore } from "../../queue/src/index";
import { PROHIBITED_PROMPT_BATTERY } from "../../safety/src/index";
import { REVIEW_COMMENTS_MAX, REVIEW_COMMENT_FRAME_LIMIT, REVIEW_COMMENT_MAX_CHARS, REVIEW_STAGES, reviewStage, reviewTimecode } from "../src/review-comments";
import { reviewViewer } from "../src/review-views";
import { createApiServer } from "../src/server";

const root = `/tmp/hv-review-comments-${Date.now()}`;
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

type Headers = Record<string, string>;
async function project() {
  const created = await (await fetch(`${base}/api/projects`, { method: "POST" })).json() as { projectId: string; token: string };
  const headers = { authorization: `Bearer ${created.token}`, "content-type": "application/json" };
  await fetch(`${base}/api/projects/${created.projectId}/script`, { method: "PUT", headers, body: JSON.stringify({ text: "INT. ROOM - DAY\n\nA lamp glows." }) });
  await fetch(`${base}/api/projects/${created.projectId}/rights`, { method: "POST", headers, body: JSON.stringify({ attested: true }) });
  return { projectId: created.projectId, headers };
}
function completeOne(projectId: string): string {
  const store = new DurableJobStore(queuePath), workerId = `finisher-${Math.random()}`;
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
    captionsPath: `${projectId}/${jobId}/captions.vtt`, manifestPath: `${projectId}/${jobId}/provenance.json` });
  return jobId;
}
async function cut(projectId: string, headers: Headers, body: Record<string, unknown> = {}) {
  const queued = await fetch(`${base}/api/projects/${projectId}/jobs`, { method: "POST", headers, body: JSON.stringify(body) });
  expect(queued.status).toBe(202);
  return completeOne(projectId);
}
const mint = async (projectId: string, headers: Headers, body: Record<string, unknown> = {}) =>
  (await (await fetch(`${base}/api/projects/${projectId}/reviews`, { method: "POST", headers, body: JSON.stringify({ permission: "approve", maxViews: 3, ...body }) })).json()) as { token: string };
const viewer = (n: number) => `viewer-${String(n).padStart(3, "0")}-abcdefghijklmnop`;
const as = (who?: string): Headers => ({ "content-type": "application/json", ...(who ? { "x-hv-review-viewer": who } : {}) });
const open = (token: string, who?: string) => fetch(`${base}/api/reviews/${encodeURIComponent(token)}`, { headers: as(who) });
const comment = (token: string, body: unknown, who?: string) =>
  fetch(`${base}/api/reviews/${encodeURIComponent(token)}/comments`, { method: "POST", headers: as(who), body: JSON.stringify(body) });
const decide = (token: string, decision: string, who?: string) =>
  fetch(`${base}/api/reviews/${encodeURIComponent(token)}/decision`, { method: "POST", headers: as(who), body: JSON.stringify({ decision, note: "" }) });
type OwnerView = { links: { id: string; jobId: string | null; decision: string | null; decisionStage: string | null; decidedAt: string | null;
  comments: { id: string; frame: number; timecode: string; text: string; viewer: number | null; at: string; resolvedAt: string | null }[] }[];
  stages: { stage: string; label: string; approved: number; changesRequested: number; latest: { decision: string; at: string; jobId: string } | null }[] };
const owner = async (projectId: string, headers: Headers) => {
  const response = await fetch(`${base}/api/projects/${projectId}/reviews`, { headers });
  expect(response.status).toBe(200);
  return response.json() as Promise<OwnerView>;
};
const resolve = (projectId: string, headers: Headers, id: string, resolved: unknown) =>
  fetch(`${base}/api/projects/${projectId}/review-comments/${encodeURIComponent(id)}`, { method: "POST", headers, body: JSON.stringify({ resolved }) });
const storedLink = (token: string) => (JSON.parse(readFileSync(statePath, "utf8")) as { reviewLinks: { token: string; viewers?: string[]; comments?: Record<string, unknown>[]; decisionStage?: string }[] })
  .reviewLinks.find(link => link.token === token)!;

describe("a reviewer pins comments to frames of the bound cut", () => {
  /** The comment names a frame at 30 fps; the owner sees it with its timecode, the cut it is on, and which viewer of the link wrote it. */
  test("a comment made on an opened approve link reaches the owner with its timecode and cut", async () => {
    const { projectId, headers } = await project();
    const jobId = await cut(projectId, headers);
    const { token } = await mint(projectId, headers);
    expect((await open(token, viewer(1))).status).toBe(200);
    expect((await open(token, viewer(2))).status).toBe(200);
    const made = await comment(token, { frame: 45, text: "  The door opens a beat early.  " }, viewer(2));
    expect(made.status).toBe(201);
    expect(made.headers.get("set-cookie")).toBeNull();
    const { comment: saved } = await made.json() as { comment: { id: string; frame: number; text: string } };
    expect(saved).toMatchObject({ frame: 45, text: "The door opens a beat early." });
    const view = await owner(projectId, headers);
    expect(view.links).toHaveLength(1);
    expect(view.links[0]!.jobId).toBe(jobId);
    expect(view.links[0]!.comments).toEqual([{ id: saved.id, frame: 45, timecode: "00:00:01:15", text: "The door opens a beat early.", viewer: 2, at: expect.any(String), resolvedAt: null }]);
    // The owner's list names the link by digest, never by its bearer token.
    expect(JSON.stringify(view)).not.toContain(token);
  });

  /** A comment is about the cut the link was fixed to on first view, even after a newer cut finishes. */
  test("a comment stays on the link's bound cut when a newer cut finishes", async () => {
    const { projectId, headers } = await project();
    const first = await cut(projectId, headers, { idempotencyKey: "first" });
    const { token } = await mint(projectId, headers);
    expect((await open(token, viewer(1))).status).toBe(200);
    const second = await cut(projectId, headers, { idempotencyKey: "second" });
    expect(second).not.toBe(first);
    expect((await comment(token, { frame: 0, text: "Opening frame is soft." }, viewer(1))).status).toBe(201);
    expect((await owner(projectId, headers)).links[0]!.jobId).toBe(first);
  });

  /** A read link only watches; a link not yet opened names no cut; on a counting link, only a counted viewer comments; a revoked link takes nothing. */
  test("only someone who may decide on this cut may comment on it", async () => {
    const { projectId, headers } = await project();
    await cut(projectId, headers);
    const read = await mint(projectId, headers, { permission: "read" });
    expect((await open(read.token, viewer(1))).status).toBe(200);
    expect((await comment(read.token, { frame: 1, text: "Nice." }, viewer(1))).status).toBe(403);

    const unopened = await mint(projectId, headers);
    expect((await comment(unopened.token, { frame: 1, text: "Nice." }, viewer(1))).status).toBe(409);

    const counting = await mint(projectId, headers);
    expect((await open(counting.token, viewer(1))).status).toBe(200);
    expect((await comment(counting.token, { frame: 1, text: "Nice." }, viewer(9))).status).toBe(409);
    expect((await comment(counting.token, { frame: 1, text: "Nice." })).status).toBe(409);

    const revoked = await mint(projectId, headers);
    expect((await open(revoked.token, viewer(1))).status).toBe(200);
    expect((await fetch(`${base}/api/projects/${projectId}/reviews/${encodeURIComponent(revoked.token)}`, { method: "DELETE", headers })).status).toBe(200);
    expect((await comment(revoked.token, { frame: 1, text: "Nice." }, viewer(1))).status).toBe(403);

    expect((await owner(projectId, headers)).links.flatMap(link => link.comments)).toEqual([]);
  });

  /** Frame and text are bounded, and a link holds a bounded number of comments. */
  test("comments are bounded in frame, length and number", async () => {
    const { projectId, headers } = await project();
    await cut(projectId, headers);
    const { token } = await mint(projectId, headers);
    expect((await open(token, viewer(1))).status).toBe(200);
    for (const frame of [-1, 1.5, REVIEW_COMMENT_FRAME_LIMIT, "12", null])
      expect((await comment(token, { frame, text: "Too early." }, viewer(1))).status).toBe(400);
    for (const text of ["", "   ", 42, "x".repeat(REVIEW_COMMENT_MAX_CHARS + 1)])
      expect((await comment(token, { frame: 3, text }, viewer(1))).status).toBe(400);
    expect((await comment(token, { frame: REVIEW_COMMENT_FRAME_LIMIT - 1, text: "é".repeat(REVIEW_COMMENT_MAX_CHARS) }, viewer(1))).status).toBe(201);
    for (let index = 1; index < REVIEW_COMMENTS_MAX; index++) expect((await comment(token, { frame: index, text: "note " + index }, viewer(1))).status).toBe(201);
    const over = await comment(token, { frame: 7, text: "one more" }, viewer(1));
    expect(over.status).toBe(409);
    expect(storedLink(token).comments).toHaveLength(REVIEW_COMMENTS_MAX);
  });

  /** Every prompt the content-policy battery refuses is refused as a comment, and nothing is kept. */
  test("a comment passes the same content-policy gate as a prompt", async () => {
    const { projectId, headers } = await project();
    await cut(projectId, headers);
    const { token } = await mint(projectId, headers);
    expect((await open(token, viewer(1))).status).toBe(200);
    for (const { prompt, category } of PROHIBITED_PROMPT_BATTERY) {
      const refused = await comment(token, { frame: 10, text: prompt }, viewer(1));
      expect(refused.status).toBe(422);
      expect(await refused.json()).toMatchObject({ reason: "content_policy", category });
    }
    expect(storedLink(token).comments).toBeUndefined();
  });

  /** The stored comment has six fields, the only reviewer-derived one being the link's own viewer hash; the raw viewer id is never kept. */
  test("a comment carries no identity beyond the link's viewer hash", async () => {
    const { projectId, headers } = await project();
    await cut(projectId, headers);
    const counting = await mint(projectId, headers);
    expect((await open(counting.token, viewer(4))).status).toBe(200);
    expect((await comment(counting.token, { frame: 5, text: "Hold the wide longer." }, viewer(4))).status).toBe(201);
    const kept = storedLink(counting.token).comments![0]!;
    expect(Object.keys(kept).sort()).toEqual(["at", "frame", "id", "resolvedAt", "text", "viewer"]);
    expect(kept.viewer).toBe(reviewViewer(viewer(4))!.hash);
    expect(readFileSync(statePath, "utf8")).not.toContain(viewer(4));

    // A link minted without a viewer limit keeps no viewer hashes, so its comments name no one.
    const plain = await mint(projectId, headers, { maxViews: undefined });
    expect((await open(plain.token)).status).toBe(200);
    expect((await comment(plain.token, { frame: 6, text: "Cut on the look." }, viewer(5))).status).toBe(201);
    expect(storedLink(plain.token).comments![0]!.viewer).toBeNull();
  });
});

describe("the owner resolves comments", () => {
  /** Resolving records when; reopening clears it; another project's owner cannot touch it. */
  test("the owner marks a comment resolved and open again; nobody else can", async () => {
    const { projectId, headers } = await project();
    await cut(projectId, headers);
    const { token } = await mint(projectId, headers);
    expect((await open(token, viewer(1))).status).toBe(200);
    const { comment: made } = await (await comment(token, { frame: 90, text: "Music swells too soon." }, viewer(1))).json() as { comment: { id: string } };

    const stranger = await project();
    expect((await resolve(stranger.projectId, stranger.headers, made.id, true)).status).toBe(404);
    expect((await resolve(projectId, { "content-type": "application/json" }, made.id, true)).status).toBe(401);
    expect((await resolve(projectId, headers, made.id, "yes")).status).toBe(400);

    const resolved = await resolve(projectId, headers, made.id, true);
    expect(resolved.status).toBe(200);
    const at = ((await resolved.json()) as { comment: { resolvedAt: string } }).comment.resolvedAt;
    expect(Number.isFinite(Date.parse(at))).toBe(true);
    expect((await owner(projectId, headers)).links[0]!.comments[0]!.resolvedAt).toBe(at);
    expect(storedLink(token).comments![0]!.resolvedAt).toBe(at);

    expect((await resolve(projectId, headers, made.id, false)).status).toBe(200);
    expect((await owner(projectId, headers)).links[0]!.comments[0]!.resolvedAt).toBeNull();
  });
});

describe("a review decision approves a stage", () => {
  /** The stage comes from the bound cut's job, and the owner sees decisions grouped per stage. */
  test("decisions on a rough cut and on the final are recorded and shown per stage", async () => {
    const { projectId, headers } = await project();
    const animatic = await cut(projectId, headers);
    const early = await mint(projectId, headers);
    expect((await open(early.token, viewer(1))).status).toBe(200);
    expect((await decide(early.token, "changes_requested", viewer(1))).status).toBe(200);
    expect(storedLink(early.token).decisionStage).toBe("rough-cut");

    const approved = await fetch(`${base}/api/projects/${projectId}/animatic/decision`, { method: "POST", headers, body: JSON.stringify({ animaticJobId: animatic, decision: "approved" }) });
    expect(approved.status).toBe(201);
    const final = await cut(projectId, headers, { stage: "final", animaticJobId: animatic });
    const late = await mint(projectId, headers, { jobId: final });
    expect((await open(late.token, viewer(2))).status).toBe(200);
    expect((await decide(late.token, "approved", viewer(2))).status).toBe(200);

    const view = await owner(projectId, headers);
    expect(view.stages.map(stage => stage.stage)).toEqual([...REVIEW_STAGES]);
    const by = Object.fromEntries(view.stages.map(stage => [stage.stage, stage]));
    expect(by["rough-cut"]).toMatchObject({ label: "Rough cut (animatic)", approved: 0, changesRequested: 1, latest: { decision: "changes_requested", jobId: animatic } });
    expect(by.final).toMatchObject({ label: "Final", approved: 1, changesRequested: 0, latest: { decision: "approved", jobId: final } });
    for (const stage of ["picture-edit", "sound-mix", "deliverable"]) expect(by[stage]).toMatchObject({ approved: 0, changesRequested: 0, latest: null });
    expect(view.links.find(link => link.jobId === final)).toMatchObject({ decision: "approved", decisionStage: "final", decidedAt: expect.any(String) });
  });

  /** Every job stage a review link can be bound to maps to one of the five stages; anything else maps to none. */
  test("each reviewable job stage approves one production stage", () => {
    expect([...REVIEW_STAGES]).toEqual(["rough-cut", "final", "picture-edit", "sound-mix", "deliverable"]);
    expect(reviewStage("animatic")).toBe("rough-cut");
    expect(reviewStage("final")).toBe("final");
    expect(reviewStage("picture-edit")).toBe("picture-edit");
    expect(reviewStage("assembly-edit")).toBe("picture-edit");
    expect(reviewStage("sound-mix")).toBe("sound-mix");
    expect(reviewStage("dialogue-replacement")).toBe("sound-mix");
    expect(reviewStage("lip-sync")).toBe("sound-mix");
    expect(reviewStage("delivery")).toBe("deliverable");
    for (const stage of ["character-sheet", "audio-take", "motion-graphic", "", "Final"]) expect(reviewStage(stage)).toBeNull();
  });

  /** HH:MM:SS:FF at 30 fps, frame-exact. */
  test("a frame reads as a 30 fps timecode", () => {
    expect(reviewTimecode(0)).toBe("00:00:00:00");
    expect(reviewTimecode(29)).toBe("00:00:00:29");
    expect(reviewTimecode(30)).toBe("00:00:01:00");
    expect(reviewTimecode(30 * 61 + 7)).toBe("00:01:01:07");
    expect(reviewTimecode(REVIEW_COMMENT_FRAME_LIMIT - 1)).toBe("03:59:59:29");
  });
});
