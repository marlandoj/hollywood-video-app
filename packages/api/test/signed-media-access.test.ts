import { afterAll, afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { createHmac } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { resolve } from "node:path";
import { DurableJobStore } from "../../queue/src/index";
import { ProjectService } from "../src/index";
import { createApiServer } from "../src/server";
import { ARTIFACT_TOKEN_TTL_MS, PROJECT_TOKEN_TTL_MS, REVIEW_TOKEN_TTL_MS, mintArtifactToken, mintProjectToken, mintReviewToken } from "../src/tokens";

// Same fixture shape as server.test.ts: a per-run temp root, local artifacts,
// generous limits so the table never trips the limiter it is not testing.
const SECRET = "test-secret-that-is-at-least-thirty-two-characters";
const root = `/tmp/hv-signed-media-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const queuePath = `${root}/jobs.json`;
const artifactRoot = `${root}/artifacts`;
const statePath = `${root}/state/projects.json`;
const costLedgerPath = `${root}/state/cost-ledger.json`;
const frontendOrigin = "https://staging.example.test";
const generous = { api: { limit: 1_000_000, windowMs: 60_000 }, projectCreate: { limit: 1_000_000, windowMs: 3600_000 }, artifacts: { limit: 1_000_000, windowMs: 60_000 } };
const SIGNED_URL = /^\/artifacts\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}\/([^/]+)\/([^/]+)\//;
const NOT_FOUND = '{"error":"not found"}';
let server: ReturnType<typeof createApiServer>;
let base: string;
interface Row { case: string; method: string; expected: number; observed: number }
const rows: Row[] = [];
const verifierRejections: string[] = [];
const boundary: { servedAtExpMinus1: boolean | null; refusedAtExp: number | null; refusedAfterDeleteAfter: number | null } = { servedAtExpMinus1: null, refusedAtExp: null, refusedAfterDeleteAfter: null };

beforeAll(() => {
  process.env.HV_TOKEN_SECRET = SECRET;
  server = createApiServer({ port: 0, hostname: "127.0.0.1", queuePath, artifactRoot, statePath, costLedgerPath, frontendOrigin, rateLimit: generous });
  base = `http://127.0.0.1:${server.port}`;
});
afterEach(() => setSystemTime());
afterAll(async () => {
  await server.stop(true);
  const evidence = process.env.HV_SIGNED_MEDIA_EVIDENCE;
  if (!evidence) return;
  const lanePath = process.env.HV_SIGNED_MEDIA_S3_LANE;
  const lane = lanePath && existsSync(lanePath) ? JSON.parse(readFileSync(lanePath, "utf8")) as Record<string, unknown> : null;
  const s3Lane = lane ? { status: "recorded", traversal: lane.traversal, head: lane.head, recordedAt: lane.recordedAt, source: "packages/storage/test/artifacts.test.ts" }
    : { status: "pending", traversal: null, head: null, command: "HV_PG_ADMIN_URL=… HV_API_DATABASE_URL=… HV_WORKER_DATABASE_URL=… HV_S3_ENDPOINT=… HV_S3_BUCKET=… HV_S3_REGION=… HV_S3_ACCESS_KEY_ID=… HV_S3_SECRET_ACCESS_KEY=… HV_SIGNED_MEDIA_S3_LANE=<lane-result.json> bun test packages/storage/test/artifacts.test.ts, then re-run this suite with HV_SIGNED_MEDIA_EVIDENCE and the same HV_SIGNED_MEDIA_S3_LANE" };
  const file = resolve(process.cwd(), evidence);
  mkdirSync(resolve(file, ".."), { recursive: true });
  writeFileSync(file, JSON.stringify({ schema: "hv-signed-media-access/1", status: "recorded", storage: "local", suite: "packages/api/test/signed-media-access.test.ts", rows,
    tokenLifetimesMs: { artifact: ARTIFACT_TOKEN_TTL_MS, project: PROJECT_TOKEN_TTL_MS, review: REVIEW_TOKEN_TTL_MS }, verifierRejections, boundary, s3Lane,
    newProviderSpendUsd: 0, recordedAt: new Date().toISOString() }, null, 2) + "\n");
});

async function newProject(): Promise<{ projectId: string; token: string; headers: Record<string, string> }> {
  const created = await (await fetch(`${base}/api/projects`, { method: "POST" })).json() as { projectId: string; token: string };
  const headers = { authorization: `Bearer ${created.token}`, "content-type": "application/json" };
  await fetch(`${base}/api/projects/${created.projectId}/script`, { method: "PUT", headers, body: JSON.stringify({ text: "INT. ROOM - DAY\n\nA lamp glows." }) });
  await fetch(`${base}/api/projects/${created.projectId}/rights`, { method: "POST", headers, body: JSON.stringify({ attested: true }) });
  return { ...created, headers };
}
function finishJob(projectId: string, jobId: string): void {
  const directory = `${artifactRoot}/${projectId}/${jobId}`;
  mkdirSync(`${directory}/hls`, { recursive: true });
  writeFileSync(`${directory}/export.mp4`, "mp4");
  writeFileSync(`${directory}/hls/index.m3u8`, "#EXTM3U\n#EXTINF:2.0,\nsegment-000.ts\n#EXT-X-ENDLIST\n");
  writeFileSync(`${directory}/hls/segment-000.ts`, "segment");
  writeFileSync(`${directory}/captions.vtt`, "WEBVTT\n");
  writeFileSync(`${directory}/provenance.json`, "{}");
  const store = new DurableJobStore(queuePath), workerId = `finisher-${jobId}`;
  let claimed = store.claimNext(Date.now(), {}, { workerId, leaseMs: 60_000 });
  while (claimed && claimed.id !== jobId) claimed = store.claimNext(Date.now(), {}, { workerId, leaseMs: 60_000 });
  if (!claimed) throw new Error(`job ${jobId} was not claimable`);
  store.complete(jobId, workerId, { mp4Path: `${projectId}/${jobId}/export.mp4`, hlsPlaylistPath: `${projectId}/${jobId}/hls/index.m3u8`, captionsPath: `${projectId}/${jobId}/captions.vtt`, manifestPath: `${projectId}/${jobId}/provenance.json` });
}
interface Cut { projectId: string; jobId: string; token: string; headers: Record<string, string>; output: Record<string, string>; signature: string; prefix: string }
async function finishedCut(): Promise<Cut> {
  const { projectId, token, headers } = await newProject();
  const { jobId } = await (await fetch(`${base}/api/projects/${projectId}/jobs`, { method: "POST", headers, body: JSON.stringify({ idempotencyKey: `cut-${crypto.randomUUID()}` }) })).json() as { jobId: string };
  finishJob(projectId, jobId);
  const { output } = await (await fetch(`${base}/api/jobs/${jobId}`, { headers })).json() as { output: Record<string, string> };
  const signature = output.mp4Url!.split("/")[2]!;
  return { projectId, jobId, token, headers, output, signature, prefix: `/artifacts/${signature}/${projectId}/${jobId}` };
}
async function record(name: string, method: string, expected: number, response: Response): Promise<Response> {
  rows.push({ case: name, method, expected, observed: response.status });
  expect(response.status, name).toBe(expected);
  return response;
}
/** A raw request line: the client does not normalise the path, so the server's own handling is what is observed. */
function raw(path: string, method = "GET"): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  return new Promise((done, fail) => {
    const socket = connect(server.port, "127.0.0.1", () => socket.write(`${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`));
    let data = ""; socket.setEncoding("utf8"); socket.on("data", (chunk: string) => { data += chunk; }); socket.on("error", fail);
    socket.on("close", () => {
      const split = data.indexOf("\r\n\r\n"), [status, ...lines] = data.slice(0, split).split("\r\n");
      done({ status: Number(status!.split(" ")[1]), headers: Object.fromEntries(lines.map((line) => [line.slice(0, line.indexOf(":")).toLowerCase(), line.slice(line.indexOf(":") + 1).trim()])), body: data.slice(split + 4) });
    });
  });
}
function urls(value: unknown, path = "", found: [string, string][] = []): [string, string][] {
  if (Array.isArray(value)) value.forEach((item, index) => urls(item, `${path}[${index}]`, found));
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) {
    if (key.endsWith("Url") && typeof item === "string") found.push([`${path}.${key}`, item]); else urls(item, `${path}.${key}`, found);
  }
  return found;
}

describe("signed media URLs: method, placement and kind contract (criterion 1)", () => {
  test("a valid token serves every file of the cut with the media headers, and HEAD answers 200", async () => {
    const cut = await finishedCut();
    const expected: [string, string, string][] = [["export.mp4", "video/mp4", "mp4"], ["hls/index.m3u8", "application/vnd.apple.mpegurl", "#EXTM3U"], ["hls/segment-000.ts", "video/mp2t", "segment"], ["captions.vtt", "text/vtt; charset=utf-8", "WEBVTT"], ["provenance.json", "application/json; charset=utf-8", "{}"]];
    for (const [file, contentType, content] of expected) {
      const response = await record(`GET ${file} with a valid token`, "GET", 200, await fetch(`${base}${cut.prefix}/${file}`));
      expect(response.headers.get("content-type")).toBe(contentType);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(await response.text()).toContain(content);
    }
    const playlist = await (await fetch(`${base}${cut.output.hlsUrl}`)).text(), segment = playlist.split("\n").find((line) => line && !line.startsWith("#"))!;
    expect(await (await record("GET playlist-relative segment", "GET", 200, await fetch(`${base}${cut.output.hlsUrl!.slice(0, cut.output.hlsUrl!.lastIndexOf("/"))}/${segment}`))).text()).toBe("segment");
    const head = await record("HEAD export.mp4 with a valid token", "HEAD", 200, await fetch(`${base}${cut.prefix}/export.mp4`, { method: "HEAD" }));
    expect(head.headers.get("cache-control")).toBe("private, no-store");
    expect(await head.text()).toBe("");
  });

  test("POST, PUT and DELETE on a signed URL are never served and never mutate", async () => {
    const cut = await finishedCut(), file = `${artifactRoot}/${cut.projectId}/${cut.jobId}/export.mp4`;
    for (const method of ["POST", "PUT", "DELETE"]) {
      const response = await record(`${method} export.mp4 with a valid token`, method, 404, await fetch(`${base}${cut.prefix}/export.mp4`, { method, body: method === "DELETE" ? undefined : "overwrite" }));
      expect(await response.json()).toEqual({ error: "not found" });
      expect(readFileSync(file, "utf8")).toBe("mp4");
    }
  });

  test("the token is only honoured as the path segment: query string and Authorization header are 401", async () => {
    const cut = await finishedCut(), unsigned = `/artifacts/${cut.projectId}/${cut.jobId}/export.mp4`;
    expect(await (await record("token as ?token= on an unsigned path", "GET", 401, await fetch(`${base}${unsigned}?token=${cut.signature}`))).json()).toEqual({ error: "unauthorized" });
    await record("token as Authorization: Bearer on an unsigned path", "GET", 401, await fetch(`${base}${unsigned}`, { headers: { authorization: `Bearer ${cut.signature}` } }));
    await record("unsigned path, no token at all", "GET", 401, await fetch(`${base}${unsigned}`));
  });

  test("kind confusion: an artifact token opens no API route, and project or review tokens open no media", async () => {
    const cut = await finishedCut();
    await record("artifact token as Bearer on /api/projects/:id", "GET", 401, await fetch(`${base}/api/projects/${cut.projectId}`, { headers: { authorization: `Bearer ${cut.signature}` } }));
    // /api/jobs/:id answers 404 to every unauthorised caller (picture-performance.test.ts pins this),
    // so it does not confirm the job exists; the artifact token is refused, not served.
    await record("artifact token as Bearer on /api/jobs/:id", "GET", 404, await fetch(`${base}/api/jobs/${cut.jobId}`, { headers: { authorization: `Bearer ${cut.signature}` } }));
    await record("artifact token as /api/reviews/:token", "GET", 403, await fetch(`${base}/api/reviews/${encodeURIComponent(cut.signature)}`));
    const review = await (await fetch(`${base}/api/projects/${cut.projectId}/reviews`, { method: "POST", headers: cut.headers, body: JSON.stringify({ permission: "read" }) })).json() as { token: string };
    for (const [name, token] of [["project token", cut.token], ["review token", review.token], ["freshly minted project token", mintProjectToken(cut.projectId)], ["freshly minted review token", mintReviewToken(cut.projectId, "approve")]] as const)
      await record(`${name} in the artifact path`, "GET", 401, await fetch(`${base}/artifacts/${token}/${cut.projectId}/${cut.jobId}/export.mp4`));
    await record("artifact token for the same project but another job", "GET", 401, await fetch(`${base}/artifacts/${mintArtifactToken(cut.projectId, crypto.randomUUID(), Date.now() + 60_000)}/${cut.projectId}/${cut.jobId}/export.mp4`));
  });

  test("every *Url in a job view, a project listing and a review view is a signed path bound to that cut, never a presigned object URL", async () => {
    const cut = await finishedCut();
    const job = await (await fetch(`${base}/api/jobs/${cut.jobId}`, { headers: cut.headers })).json();
    const listing = await (await fetch(`${base}/api/projects/${cut.projectId}`, { headers: cut.headers })).json() as { jobs: unknown[] };
    const link = await (await fetch(`${base}/api/projects/${cut.projectId}/reviews`, { method: "POST", headers: cut.headers, body: JSON.stringify({ permission: "read" }) })).json() as { token: string };
    const review = await (await fetch(`${base}/api/reviews/${encodeURIComponent(link.token)}`)).json();
    const views: [string, unknown][] = [["job view", job], ["project listing", listing.jobs], ["review view", review]];
    for (const [name, view] of views) {
      const found = urls(view);
      expect(found.length, name).toBeGreaterThanOrEqual(4);
      for (const [field, url] of found) {
        const match = SIGNED_URL.exec(url);
        expect(match, `${name} ${field}`).not.toBeNull();
        expect([match![1], match![2]], `${name} ${field}`).toEqual([cut.projectId, cut.jobId]);
        expect(url).not.toContain("X-Amz-"); expect(url).not.toContain("?"); expect(url).not.toContain("Signature=");
      }
      rows.push({ case: `${name}: ${found.length} *Url fields are signed paths`, method: "GET", expected: 200, observed: 200 });
    }
  });
});

describe("path scope is validated the same way on both backends (criterion 5)", () => {
  test("traversal, encoded dots, an empty segment and an over-long path answer the generic 404 and serve nothing", async () => {
    const cut = await finishedCut();
    // Bun's URL parser collapses `.`, `..` and `%2e%2e` segments before dispatch,
    // so a dot segment directly under the job resolves out of the job and the
    // binding check refuses it; deeper dot segments stay inside the job and reach
    // the path rule. Either way the generic body and no file.
    const table: [string, string, number][] = [
      ["encoded separators ..%2F..%2Fjobs.json", `${cut.prefix}/..%2F..%2Fjobs.json`, 404],
      ["encoded dot-dot %2e%2e/x inside the job", `${cut.prefix}/hls/%2e%2e/x`, 404],
      ["encoded dot-dot %2e%2e/x at the job root leaves the job (binding refuses)", `${cut.prefix}/%2e%2e/x`, 401],
      ["literal . segment", `${cut.prefix}/./x`, 404],
      ["literal .. segment inside the job", `${cut.prefix}/hls/../x`, 404],
      ["empty segment", `${cut.prefix}//export.mp4`, 404],
      ["trailing empty segment", `${cut.prefix}/hls/`, 404],
      ["encoded backslash segments hls%5C..%5C..%5Cjobs.json", `${cut.prefix}/hls%5C..%5C..%5Cjobs.json`, 404],
      ["literal backslash traversal (the parser reads \\ as /) leaves the job (binding refuses)", `${cut.prefix}/hls\\..\\..\\..\\jobs.json`, 401],
      ["path over 1024 characters", `${cut.prefix}/${"a".repeat(1100)}`, 404],
    ];
    for (const [name, path, expected] of table) {
      const response = await raw(path);
      rows.push({ case: name, method: "GET", expected, observed: response.status });
      expect(response.status, name).toBe(expected);
      expect(response.body.trim(), name).toBe(expected === 404 ? NOT_FOUND : '{"error":"unauthorized"}');
      expect(response.headers["content-type"], name).toContain("application/json");
    }
    expect((await raw(`${cut.prefix}/export.mp4`)).body).toBe("mp4");
  });
});

describe("expiry is enforced twice and at the exact instant (criterion 2)", () => {
  test("served at exp - 1 ms, 401 at exp", async () => {
    const cut = await finishedCut(), now = Date.now(), T = now + 3600_000;
    const token = mintArtifactToken(cut.projectId, cut.jobId, T, now), url = `${base}/artifacts/${token}/${cut.projectId}/${cut.jobId}/export.mp4`;
    setSystemTime(new Date(T - 1));
    const served = await record("artifact token at exp - 1 ms", "GET", 200, await fetch(url));
    expect(await served.text()).toBe("mp4");
    setSystemTime(new Date(T));
    const refused = await record("artifact token at exp", "GET", 401, await fetch(url));
    boundary.servedAtExpMinus1 = served.status === 200; boundary.refusedAtExp = refused.status;
    expect(await refused.json()).toEqual({ error: "unauthorized" });
  });

  test("a token inside its own exp is 404 once project.deleteAfter has passed", async () => {
    const cut = await finishedCut();
    const { deleteAfter } = await (await fetch(`${base}/api/projects/${cut.projectId}`, { headers: cut.headers })).json() as { deleteAfter: string };
    const D = Date.parse(deleteAfter), token = mintArtifactToken(cut.projectId, cut.jobId, D + 60_000, D - 1000), url = `${base}/artifacts/${token}/${cut.projectId}/${cut.jobId}/export.mp4`;
    setSystemTime(new Date(D - 1));
    await record("token beyond deleteAfter, 1 ms before deleteAfter", "GET", 200, await fetch(url));
    setSystemTime(new Date(D));
    const refused = await record("token still inside exp, at deleteAfter", "GET", 404, await fetch(url));
    boundary.refusedAfterDeleteAfter = refused.status;
    expect(await refused.json()).toEqual({ error: "not found" });
  });
});

describe("revocation levers (criterion 6)", () => {
  test("project takedown through a second service on the same state path is seen on the next request", async () => {
    const cut = await finishedCut(), url = `${base}${cut.prefix}/export.mp4`;
    await record("signed URL before takedown", "GET", 200, await fetch(url));
    expect(new ProjectService(statePath).takedown(cut.projectId, "verified request")).toBe(true);
    const refused = await record("signed URL after takedown", "GET", 404, await fetch(url));
    expect(await refused.json()).toEqual({ error: "not found" });
    await record("HEAD after takedown", "HEAD", 404, await fetch(url, { method: "HEAD" }));
  });
});

describe("verifier rejections recorded for the evidence file (criterion 3, detailed in tokens.test.ts)", () => {
  test("each malformed payload signed with the test secret verifies to null", async () => {
    const now = Date.now(), signed = (payload: unknown) => { const body = Buffer.from(JSON.stringify(payload)).toString("base64url"); return body + "." + createHmac("sha256", SECRET).update(body).digest("base64url"); };
    const good = { kind: "artifact", projectId: "p", jobId: "j", exp: now + 60_000, nonce: "n" };
    const malformed: [string, string][] = [
      ["token over 1024 chars", signed({ ...good, nonce: "x".repeat(1100) })], ["token without a dot", signed(good).replace(".", "")], ["MAC of the wrong length", signed(good).slice(0, -1)],
      ["body null", signed(null)], ["body array", signed([])], ["body string", signed("x")], ["exp missing", signed({ kind: "artifact", projectId: "p", jobId: "j", nonce: "n" })],
      ["exp tomorrow", signed({ ...good, exp: "tomorrow" })], ["exp 1.5", signed({ ...good, exp: 1.5 })], ["exp null", signed({ ...good, exp: null })], ["exp 2**53", signed({ ...good, exp: 2 ** 53 })],
      ["extra key", signed({ ...good, extra: 1 })], ["missing nonce", signed({ kind: "artifact", projectId: "p", jobId: "j", exp: now + 60_000 })], ["kind grant", signed({ kind: "grant", projectId: "p", tier: "elevated", exp: now + 60_000, nonce: "n" })],
      ["review permission write", signed({ kind: "review", projectId: "p", permission: "write", exp: now + 60_000, nonce: "n" })], ["artifact without jobId", signed({ kind: "artifact", projectId: "p", exp: now + 60_000, nonce: "n" })],
      ["projectId empty", signed({ ...good, projectId: "" })], ["projectId 200 chars", signed({ ...good, projectId: "p".repeat(200) })], ["nonce 65 chars", signed({ ...good, nonce: "n".repeat(65) })],
    ];
    const cut = await finishedCut();
    for (const [name, token] of malformed) {
      const response = await fetch(`${base}/artifacts/${token}/${cut.projectId}/${cut.jobId}/export.mp4`);
      expect(response.status, name).toBe(401); verifierRejections.push(name);
    }
    expect((await fetch(`${base}/artifacts/${signed({ ...good, projectId: cut.projectId, jobId: cut.jobId })}/${cut.projectId}/${cut.jobId}/export.mp4`)).status).toBe(200);
  });
});
