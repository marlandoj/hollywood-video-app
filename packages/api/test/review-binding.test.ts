/**
 * HV-029-02 — a review link that named no cut was a review link nothing checked.
 *
 * A link minted before the project had any finished cut carries no
 * `outputBinding`, and the read route resolved `latestFinishedCut` afresh on
 * every view. The permission gate was reached only through that binding:
 *
 *     if(use.outputBinding)assertSelectedOutput(latest,reviewed,use.outputBinding);
 *
 * `assertSelectedOutput` is what enforces the cut's own `linkExpiresAt`, the
 * project's `deleteAfter` and — through `assertDialoguePermissions` — current
 * cast permission. So for an unbound link it never ran: the reviewer was served
 * the cut and signed artifact URLs for it in cases where the owner's own view
 * of the same job is refused. The same conditional sat in
 * `submitReviewDecision`, so an approval could be recorded against a cut that
 * was never checked and never even named.
 *
 * The repair is one gate for both kinds of link, and a binding written on the
 * first successful view so that "what this link shows" stops being a question
 * answered again on every request.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DurableJobStore, DOWNLOAD_LINK_TTL_MS } from "../../queue/src/index";
import { ProjectService } from "../src/index";
import { createApiServer } from "../src/server";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const root = `/tmp/hv-review-binding-${Date.now()}`;
const queuePath = `${root}/jobs.json`;
const artifactRoot = `${root}/artifacts`;
const statePath = `${root}/state/projects.json`;
const generous = { api: { limit: 1_000_000, windowMs: 60_000 }, projectCreate: { limit: 1_000_000, windowMs: 3600_000 }, artifacts: { limit: 1_000_000, windowMs: 60_000 } };

let server: ReturnType<typeof createApiServer>;
let base: string;

beforeAll(() => {
  process.env.HV_TOKEN_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
  server = createApiServer({
    port: 0, hostname: "127.0.0.1", queuePath, artifactRoot,
    statePath, costLedgerPath: `${root}/state/cost-ledger.json`,
    frontendOrigin: "https://staging.example.test", rateLimit: generous,
  });
  base = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

async function project(): Promise<{ projectId: string; token: string; headers: Record<string, string> }> {
  const created = await (await fetch(`${base}/api/projects`, { method: "POST" })).json() as { projectId: string; token: string };
  const headers = { authorization: `Bearer ${created.token}`, "content-type": "application/json" };
  await fetch(`${base}/api/projects/${created.projectId}/script`, { method: "PUT", headers, body: JSON.stringify({ text: "INT. ROOM - DAY\n\nA lamp glows." }) });
  await fetch(`${base}/api/projects/${created.projectId}/rights`, { method: "POST", headers, body: JSON.stringify({ attested: true }) });
  return { projectId: created.projectId, token: created.token, headers };
}

const mintUnbound = async (projectId: string, headers: Record<string, string>, permission = "read"): Promise<string> => {
  const link = await (await fetch(`${base}/api/projects/${projectId}/reviews`, { method: "POST", headers, body: JSON.stringify({ permission }) })).json() as { token: string; outputBinding?: unknown };
  // The route mints an unbound link only while the project has no finished cut
  // and no dialogue selection. If that ever stops being true, every case below
  // would be testing a bound link and proving nothing.
  expect(link.outputBinding).toBeUndefined();
  return link.token;
};

const enqueueCut = async (projectId: string, headers: Record<string, string>, key: string): Promise<string> =>
  (await (await fetch(`${base}/api/projects/${projectId}/jobs`, { method: "POST", headers, body: JSON.stringify({ idempotencyKey: key }) })).json() as { jobId: string }).jobId;

/** Finishes one queued cut at a chosen instant, which is what sets its `linkExpiresAt`. */
function completeOne(projectId: string, completedAt: number): string {
  const store = new DurableJobStore(queuePath);
  const workerId = `finisher-${completedAt}`;
  const claimed = store.claimNext(Date.now(), {}, { workerId, leaseMs: 60_000 });
  if (!claimed) throw new Error("expected a claimable queued cut");
  const jobId = claimed.id, directory = `${artifactRoot}/${projectId}/${jobId}`;
  mkdirSync(`${directory}/hls`, { recursive: true });
  writeFileSync(`${directory}/export.mp4`, "mp4");
  writeFileSync(`${directory}/hls/index.m3u8`, "#EXTM3U\n#EXTINF:2.0,\nsegment-000.ts\n#EXT-X-ENDLIST\n");
  writeFileSync(`${directory}/hls/segment-000.ts`, "segment");
  writeFileSync(`${directory}/captions.vtt`, "WEBVTT\n");
  writeFileSync(`${directory}/provenance.json`, "{}");
  store.complete(jobId, workerId, {
    mp4Path: `${projectId}/${jobId}/export.mp4`,
    hlsPlaylistPath: `${projectId}/${jobId}/hls/index.m3u8`,
    captionsPath: `${projectId}/${jobId}/captions.vtt`,
    manifestPath: `${projectId}/${jobId}/provenance.json`,
  }, completedAt);
  return jobId;
}

const storedLink = (token: string): {outputBinding?: {jobId: string; outputRevision: string}; views: number} | undefined => {
  if (!existsSync(statePath)) return undefined;
  const state = JSON.parse(readFileSync(statePath, "utf8")) as { reviewLinks?: {token: string; views: number; outputBinding?: {jobId: string; outputRevision: string}}[] };
  return state.reviewLinks?.find(link => link.token === token);
};

const review = (token: string) => fetch(`${base}/api/reviews/${encodeURIComponent(token)}`);
const decide = (token: string, decision: string) =>
  fetch(`${base}/api/reviews/${encodeURIComponent(token)}/decision`, { method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({ decision, note: "" }) });

test("an unbound link no longer serves a cut the gate refuses", async () => {
  const { projectId, headers } = await project();
  const token = await mintUnbound(projectId, headers);
  await enqueueCut(projectId, headers, "expired-cut");
  // Finished long enough ago that its own download link has expired. This is
  // the cheapest of the several conditions `assertSelectedOutput` enforces --
  // the others are the project's deletion date and current cast permission --
  // and it is the same single call, so it stands for all of them.
  const jobId = completeOne(projectId, Date.now() - DOWNLOAD_LINK_TTL_MS - 60_000);

  const response = await review(token);
  const body = await response.text();
  expect(response.status).toBe(409);
  expect(JSON.parse(body)).toEqual({ error: "This selected cut is unavailable, expired or changed. Choose another retained version." });

  // And the refusal is a refusal: no signed artifact URL and no job identity
  // leave with it. Before this increment the same request answered 200 with
  // playable media and signed URLs for a cut whose own download link had
  // expired.
  expect(body).not.toContain("/artifacts/");
  expect(body).not.toContain(jobId);

  // And nothing was bound to a cut that was refused.
  expect(storedLink(token)?.outputBinding).toBeUndefined();
});

test("the first view fixes the link to the cut it showed, and a later cut does not move it", async () => {
  const { projectId, headers } = await project();
  const token = await mintUnbound(projectId, headers);
  await enqueueCut(projectId, headers, "first-cut");
  const first = completeOne(projectId, Date.now() - 120_000);

  const shown = await (await review(token)).json() as { jobId: string };
  expect(shown.jobId).toBe(first);
  const bound = storedLink(token)?.outputBinding;
  expect(bound?.jobId).toBe(first);
  expect(bound?.outputRevision).toMatch(/^[a-f0-9]{64}$/);

  // A newer finished cut arrives. Before this increment the reviewer's next
  // view silently became a different film; the link now names one cut.
  await enqueueCut(projectId, headers, "second-cut");
  const second = completeOne(projectId, Date.now());
  expect(second).not.toBe(first);
  const again = await (await review(token)).json() as { jobId: string };
  expect(again.jobId).toBe(first);
  expect(storedLink(token)?.outputBinding?.jobId).toBe(first);
});

test("a decision needs a cut to be a decision about", async () => {
  const { projectId, headers } = await project();
  const token = await mintUnbound(projectId, headers, "approve");

  // Never read, so never bound: an approval here would have been recorded
  // against nothing at all, and `assertSelectedOutput` would not have run.
  const refused = await decide(token, "approved");
  // 409 with its own message, not the 403 that means invalid/expired/revoked/
  // read-only: this link is none of those, and the reviewer can fix it.
  expect(refused.status).toBe(409);
  expect(await refused.json()).toEqual({ error: "Open the cut in this review link before deciding on it." });
  expect(storedLink(token)?.views).toBe(0);

  await enqueueCut(projectId, headers, "approvable-cut");
  const jobId = completeOne(projectId, Date.now() - 60_000);
  expect((await (await review(token)).json() as { jobId: string }).jobId).toBe(jobId);

  const accepted = await decide(token, "approved");
  expect(accepted.status).toBe(200);
  expect(await accepted.json()).toEqual({ accepted: true, decision: "approved" });
  expect(storedLink(token)?.outputBinding?.jobId).toBe(jobId);

  // AC-015's other half, which used to be demonstrated in api.test.ts against a
  // link that named no cut. The project now has a finished cut, so the route
  // mints a *bound* link -- the ordinary case, and the one the UI uses.
  const bound = await (await fetch(`${base}/api/projects/${projectId}/reviews`, { method: "POST", headers, body: JSON.stringify({ permission: "approve" }) })).json() as { token: string; outputBinding: { jobId: string } };
  expect(bound.outputBinding.jobId).toBe(jobId);
  const changed = await decide(bound.token, "changes_requested");
  expect(changed.status).toBe(200);
  expect(await changed.json()).toEqual({ accepted: true, decision: "changes_requested" });
});

test("the gate keeps running after the link is bound, on every condition it carries", async () => {
  // Case 1 refuses at resolution, before anything is bound. This is the other
  // side: a link already fixed to a cut that has since become unservable. Both
  // the read and the decision have to refuse it, and the decision's own call to
  // `assertSelectedOutput` is the only thing standing between a revoked cast
  // and a recorded approval -- deleting that one line left every other case in
  // this file green.
  const { projectId, headers } = await project();
  const token = await mintUnbound(projectId, headers, "approve");
  await enqueueCut(projectId, headers, "aging-cut");
  const jobId = completeOne(projectId, Date.now() - 60_000);
  expect((await (await review(token)).json() as { jobId: string }).jobId).toBe(jobId);
  expect(storedLink(token)?.outputBinding?.jobId).toBe(jobId);

  // The cut ages past its own download link, in place, with the binding intact.
  const queued = JSON.parse(readFileSync(queuePath, "utf8")) as {id: string; linkExpiresAt: string}[];
  const aging = queued.find(job => job.id === jobId)!;
  expect(Date.parse(aging.linkExpiresAt)).toBeGreaterThan(Date.now());
  aging.linkExpiresAt = new Date(Date.now() - 60_000).toISOString();
  writeFileSync(queuePath, JSON.stringify(queued));

  const read = await review(token);
  expect(read.status).toBe(409);
  expect(await read.json()).toEqual({ error: "This selected cut is unavailable, expired or changed. Choose another retained version." });

  const decided = await decide(token, "approved");
  expect(decided.status).toBe(409);
  expect(await decided.json()).toEqual({ error: "This selected cut is unavailable, expired or changed. Choose another retained version." });
  expect(storedLink(token)?.outputBinding?.jobId).toBe(jobId);
});

test("the project's own deletion date is one of the conditions, and it is not the same condition", async () => {
  // `assertSelectedOutput` is one call carrying five conditions. A case that
  // only ever trips `linkExpiresAt` leaves the other four deletable with the
  // suite green, so this one trips a different term through a healthy cut.
  const { projectId, headers } = await project();
  const token = await mintUnbound(projectId, headers);
  await enqueueCut(projectId, headers, "retained-cut");
  const jobId = completeOne(projectId, Date.now() - 60_000);

  const state = JSON.parse(readFileSync(statePath, "utf8")) as { projects: {id: string; deleteAfter: string}[] };
  const stored = state.projects.find(entry => entry.id === projectId)!;
  expect(Date.parse(stored.deleteAfter)).toBeGreaterThan(Date.now());
  stored.deleteAfter = new Date(Date.now() - 1000).toISOString();
  writeFileSync(statePath, JSON.stringify(state));

  const response = await review(token);
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({ error: "This selected cut is unavailable, expired or changed. Choose another retained version." });
  expect(jobId).toBeTruthy();
  expect(storedLink(token)?.outputBinding).toBeUndefined();
});

test("binding is a one-way door", () => {
  process.env.HV_TOKEN_SECRET = "test-secret-that-is-at-least-thirty-two-characters";
  const service = new ProjectService(`${root}/state/binding-unit.json`);
  const created = service.createAnonymousProject();
  const link = service.createReviewLink(created.token, "read");
  expect(link?.outputBinding).toBeUndefined();

  const first = { jobId: crypto.randomUUID(), outputRevision: "a".repeat(64) };
  expect(service.bindReviewLink(link!.token, first)).toEqual(first);
  // A second view must not be able to re-point the link, or the drift this
  // increment removes would come back one request later.
  const second = { jobId: crypto.randomUUID(), outputRevision: "b".repeat(64) };
  expect(service.bindReviewLink(link!.token, second)).toEqual(first);
  expect(service.peekReviewLink(link!.token)?.outputBinding).toEqual(first);

  // And it is not a way in: a token that is not a review token, and a revoked
  // link, both bind nothing.
  expect(service.bindReviewLink(created.token, first)).toBeNull();
  expect(service.bindReviewLink("not-a-token", first)).toBeNull();
  const other = service.createReviewLink(created.token, "read")!;
  expect(service.revokeReviewLink(created.token, other.token)).toBe(true);
  expect(service.bindReviewLink(other.token, first)).toBeNull();
});

test("no review gate is reached only through the link's optional binding", () => {
  // The family guard. The defect was not the missing check; it was that the
  // check hung off `if (link.outputBinding)`, so the case with no binding --
  // the case least likely to have been thought about -- was the unguarded one.
  //
  // The first draft of this scan looked for one spelling: an `if` with no
  // nested parentheses, within eighty characters, on the same statement. Braces
  // defeated it. So did `&&`, a ternary, `Boolean(...)`, an `else`, and hoisting
  // the field into a local. All eight evasions are exercised below, because a
  // guard that catches only the spelling that was deleted catches nothing.
  const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const flatten = (text: string) => text.replace(/\s+/g, " ");
  // Rather than matching one syntax, look at the statement chain the call sits
  // in -- everything back to the previous `;` -- and refuse it if the binding is
  // mentioned there at all alongside anything that can make the call
  // conditional. An `if`, an `else`, a `&&`, a `||`, a ternary: all of them put
  // the binding between the reader and the gate.
  const guarded = (text: string) => {
    const flat = flatten(strip(text));
    return [...flat.matchAll(/assertSelectedOutput\s*\(/g)].filter(match => {
      const window = flat.slice(Math.max(0, match.index - 200), match.index);
      const statement = window.slice(window.lastIndexOf(";") + 1);
      return /\bout(?:put)?Binding\b/.test(statement) && /\b(?:if|else)\b|&&|\|\||\?/.test(statement);
    });
  };

  const files = [...new Bun.Glob("packages/{api,storage}/src/**/*.ts").scanSync(REPO_ROOT)];
  expect(files.length).toBeGreaterThan(5);
  const offenders = files.filter(file => guarded(readFileSync(join(REPO_ROOT, file), "utf8")).length > 0);
  expect(offenders).toEqual([]);

  // The scan has to be finding the calls, or an empty offender list says only
  // that it matched nothing. Seventeen calls across five files -- the count is
  // stated as a lower bound so that adding a call site is not a test failure in
  // a file its author has never read.
  const calls = files.flatMap(file => [...strip(readFileSync(join(REPO_ROOT, file), "utf8")).matchAll(/assertSelectedOutput\s*\(/g)].map(() => file));
  expect(calls.length).toBeGreaterThanOrEqual(17);
  expect([...new Set(calls)].sort()).toEqual([
    "packages/api/src/edit-api.ts", "packages/api/src/edit-preview-api.ts", "packages/api/src/index.ts",
    "packages/api/src/lipsync-api.ts", "packages/api/src/server.ts",
  ]);

  // And it bites on both spellings of the deleted line and on six ways of
  // writing the same thing, while leaving the shapes that must pass alone.
  for (const evasion of [
    "if(use.outputBinding)assertSelectedOutput(latest,reviewed,use.outputBinding);",
    "if (link.outputBinding) assertSelectedOutput(job, project, link.outputBinding, now);",
    "if (use.outputBinding) { assertSelectedOutput(latest, reviewed, use.outputBinding); }",
    "use.outputBinding&&assertSelectedOutput(latest,reviewed,use.outputBinding);",
    "use.outputBinding?assertSelectedOutput(latest,reviewed,use.outputBinding):undefined;",
    "if (Boolean(use.outputBinding)) assertSelectedOutput(latest, reviewed, use.outputBinding);",
    "if (use.outputBinding)\n    assertSelectedOutput(latest, reviewed, use.outputBinding);",
    "if(!use.outputBinding){} else assertSelectedOutput(latest,reviewed,use.outputBinding);",
  ]) expect({ evasion, caught: guarded(evasion).length }).toEqual({ evasion, caught: 1 });
  for (const allowed of [
    "assertSelectedOutput(latest,reviewed,binding);",
    "if(!link.outputBinding)return false;\n    assertSelectedOutput(job,project,link.outputBinding,now);",
    "const binding=use.outputBinding??{jobId:latest.id,outputRevision:outputRevision(latest)};\n  assertSelectedOutput(latest,reviewed,binding);",
  ]) expect({ allowed, caught: guarded(allowed).length }).toEqual({ allowed, caught: 0 });
});
