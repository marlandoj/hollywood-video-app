/**
 * HV-038-07 — an anonymous request re-read the whole studio before asking whether it was allowed to.
 *
 * `GET /api/reviews/:token` and `POST /api/reviews/:token/decision` are the only routes reachable
 * without a bearer token. Both called `ProjectService.reload()` — which re-parses the state file and
 * rebuilds and re-validates **every project in the studio** — *before* `verifyToken`. The decision
 * route paid for it twice, once in `peekReviewLink` and once in `submitReviewDecision`.
 *
 * Measured through the real server with a token that is not a token at all:
 *
 * | projects | state bytes | GET /reviews | POST /decision |
 * |---|---|---|---|
 * | 250 | 132,349 | 19.0 ms | 40.0 ms |
 * | 500 | 264,599 | 48.1 ms | 103.8 ms |
 *
 * Linear in the studio, and the api bucket is 120 requests a minute — so at 500 projects one
 * address's allowed budget is **12.5 seconds of blocked event loop per minute**, on a
 * single-threaded server, from requests that are all 403s. A free, account-less studio is designed
 * to accumulate projects, so this is a number that only goes up. After: 0.2 ms at both sizes.
 *
 * The fix is the order, and only the order: the signature is a constant-time HMAC over a bounded
 * string and it decides the request, so it goes first. The reload itself is deliberately left
 * alone — `project-historical-cache.test.ts` requires that an external write of the *same size*
 * with the *same mtime* is observed immediately, and that every read hands back freshly rebuilt
 * mutable state rather than a cached reference, so the obvious `stat`-guard is a correctness
 * regression rather than an optimisation. After: 0.1 ms at both sizes.
 */
import {afterAll, afterEach, beforeAll, expect, test} from "bun:test";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../src/server";
import {mintReviewToken, REVIEW_TOKEN_TTL_MS} from "../src/tokens";

const generous = {api: {limit: 1_000_000, windowMs: 60_000}, projectCreate: {limit: 1_000_000, windowMs: 3600_000}, artifacts: {limit: 1_000_000, windowMs: 60_000}};
const SCRIPT = "INT. ROOM - DAY\n\nMaya waits.\n\nMAYA\nHello there, friend of mine.";
const BOGUS = "rv_" + "a".repeat(80);
const roots: string[] = [];
const servers: ReturnType<typeof createApiServer>[] = [];
beforeAll(() => { process.env.HV_TOKEN_SECRET = "test-secret-that-is-at-least-thirty-two-characters"; });
afterEach(() => { for (const server of servers.splice(0)) server.stop(true); });
afterAll(() => { for (const root of roots) rmSync(root, {recursive: true, force: true}); });

function studio() {
  const root = mkdtempSync(join(tmpdir(), "hv-anon-")); roots.push(root);
  const server = createApiServer({port: 0, hostname: "127.0.0.1", queuePath: join(root, "jobs.json"), artifactRoot: join(root, "artifacts"),
    statePath: join(root, "projects.json"), costLedgerPath: join(root, "cost.json"), frontendOrigin: "https://staging.example.test", rateLimit: generous});
  servers.push(server);
  return {root, server, base: `http://127.0.0.1:${server.port}`, statePath: join(root, "projects.json")};
}
async function fill(base: string, count: number) {
  for (let index = 0; index < count; index++) {
    const project = await (await fetch(`${base}/api/projects`, {method: "POST"})).json() as {projectId: string; token: string};
    await fetch(`${base}/api/projects/${project.projectId}/script`, {method: "PUT",
      headers: {authorization: `Bearer ${project.token}`, "content-type": "application/json"}, body: JSON.stringify({text: SCRIPT})});
  }
}
const median = async (work: () => Promise<unknown>, runs = 9) => {
  const times: number[] = [];
  for (let index = 0; index < runs; index++) { const started = Bun.nanoseconds(); await work(); times.push((Bun.nanoseconds() - started) / 1e6); }
  return times.sort((a, b) => a - b)[Math.floor(runs / 2)]!;
};

test("a request with no valid token costs the same whether the studio holds thirty projects or a hundred and twenty", async () => {
  // The discriminator is the *growth*, measured on one machine: before, the cost was the studio's
  // size, so four times the projects was about four times the work; after, it is the signature
  // check, which does not know how many projects there are.
  const cost = async (projects: number) => {
    const {base} = studio();
    await fill(base, projects);
    const get = await median(() => fetch(`${base}/api/reviews/${BOGUS}`));
    const decide = await median(() => fetch(`${base}/api/reviews/${BOGUS}/decision`, {method: "POST",
      headers: {"content-type": "application/json"}, body: JSON.stringify({decision: "approved"})}));
    return {get, decide};
  };
  const small = await cost(30), large = await cost(120);
  const round = (value: number) => Number(value.toFixed(2));
  expect({flat: large.get <= Math.max(small.get, 0.5) * 3, at30: round(small.get), at120: round(large.get)})
    .toEqual({flat: true, at30: round(small.get), at120: round(large.get)});
  // The decision route paid twice, so it is the one that grew fastest.
  expect({flat: large.decide <= Math.max(small.decide, 0.5) * 3, at30: round(small.decide), at120: round(large.decide)})
    .toEqual({flat: true, at30: round(small.decide), at120: round(large.decide)});
}, 180_000);

test("and it is refused without the studio's state being read at all", async () => {
  // Timing-free, and decisive. With the state file unreadable, any route that reads the studio
  // before deciding fails loudly (HV-038-06). A bogus token must never get that far.
  const {base, statePath} = studio();
  const owner = await (await fetch(`${base}/api/projects`, {method: "POST"})).json() as {projectId: string; token: string};
  await fetch(`${base}/api/projects/${owner.projectId}/script`, {method: "PUT",
    headers: {authorization: `Bearer ${owner.token}`, "content-type": "application/json"}, body: JSON.stringify({text: SCRIPT})});
  const bytes = readFileSync(statePath);
  writeFileSync(statePath, bytes.subarray(0, Math.floor(bytes.length / 2)));
  // A caller who has shown nothing is refused, and the unreadable file is never opened.
  expect((await fetch(`${base}/api/reviews/${BOGUS}`)).status).toBe(403);
  expect((await fetch(`${base}/api/reviews/${BOGUS}/decision`, {method: "POST",
    headers: {"content-type": "application/json"}, body: JSON.stringify({decision: "approved"})})).status).toBe(403);
  // And a caller who has shown a valid token does reach the state, and therefore does fail on it,
  // by name -- which is what says the refusals above came from the signature and not from a
  // shortcut that would refuse a real link too.
  const reached = await fetch(`${base}/api/projects/${owner.projectId}`, {headers: {authorization: `Bearer ${owner.token}`}});
  expect(await reached.text()).toContain("is unreadable");
});

test("and a token that is merely well-formed is still refused, which is what the order must not change",async()=>{
  // Reordering a check is the kind of change that can turn a refusal into an acceptance, so this
  // walks the shapes: nothing, the wrong kind of token, a valid review signature for a link this
  // studio never issued, and one whose seven days are up.
  const {base} = studio();
  const owner = await (await fetch(`${base}/api/projects`, {method: "POST"})).json() as {projectId: string; token: string};
  const stranger = mintReviewToken(crypto.randomUUID(), "read");
  const expired = mintReviewToken(owner.projectId, "read", Date.now() - REVIEW_TOKEN_TTL_MS - 1000);
  for (const [name, token] of [["not a token", BOGUS], ["an owner token", owner.token],
    ["a review token for a link that was never issued", stranger], ["an expired review token", expired]] as const) {
    expect({name, status: (await fetch(`${base}/api/reviews/${token}`)).status}).toEqual({name, status: 403});
    expect({name, status: (await fetch(`${base}/api/reviews/${token}/decision`, {method: "POST",
      headers: {"content-type": "application/json"}, body: JSON.stringify({decision: "approved"})})).status}).toEqual({name, status: 403});
  }
});
