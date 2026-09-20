import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApiServer } from "../packages/api/src/server";

// HV-032-05: the live anchored reel (HV-017-07) stopped with "upstream unavailable" when the studio
// uploaded a storyboard still. The edge streamed request bodies to the API over a pooled mTLS
// connection. The API refuses a stale upload from its headers alone and leaves the body unread,
// and the next request on that connection failed with "The socket connection was closed
// unexpectedly". The edge now reads a bounded body first and uses a fresh connection per request.
const REPO = resolve(import.meta.dir, "..");
const root = mkdtempSync(join(tmpdir(), "hv-edge-"));
const certs = join(root, "certs");
const cleanup: (() => unknown)[] = [];
afterAll(async () => { for (const stop of cleanup.reverse()) await stop(); rmSync(root, { recursive: true, force: true }); });

function api() {
  const generated = Bun.spawnSync([join(REPO, "infra/mtls/gen-certs.sh"), certs]);
  if (generated.exitCode) throw new Error(generated.stderr.toString());
  process.env.HV_TOKEN_SECRET = "staging-edge-fixture-secret-at-least-thirty-two-characters";
  const server = createApiServer({ port: 0, hostname: "127.0.0.1", queuePath: join(root, "jobs.json"), artifactRoot: join(root, "artifacts"),
    statePath: join(root, "projects.json"), costLedgerPath: join(root, "ledger.json"), rateLimit: { api: { limit: 1_000_000, windowMs: 60_000 } },
    tls: { cert: readFileSync(join(certs, "api/api.crt"), "utf8"), key: readFileSync(join(certs, "api/api.key"), "utf8"), clientCa: readFileSync(join(certs, "api/ca.crt"), "utf8") } });
  cleanup.push(() => server.stop(true));
  return `https://127.0.0.1:${server.port}`;
}

async function edge(upstream: string, extra: Record<string, string> = {}) {
  const child = Bun.spawn([process.execPath, join(REPO, "infra/staging/edge.ts")], {
    env: { ...process.env, PORT: "0", HV_EDGE_HOSTNAME: "127.0.0.1", HV_APP_ROOT: REPO, HV_EDGE_MTLS_ROOT: join(certs, "frontend"), HV_EDGE_UPSTREAM: upstream, ...extra },
    stdout: "pipe", stderr: "inherit" });
  cleanup.push(() => child.kill());
  const reader = child.stdout.getReader(); let text = "";
  const pattern = /listening on (http:\/\/\S+)/;
  while (!pattern.test(text)) { const { value, done } = await reader.read(); if (done) throw new Error("edge exited"); text += new TextDecoder().decode(value); }
  return pattern.exec(text)![1]!;
}

const upstream = api();

test("uploads keep working after the API refuses one without reading it", async () => {
  const base = await edge(upstream);
  const owner = await (await fetch(base + "/api/projects", { method: "POST" })).json() as { projectId: string; token: string };
  const body = new Uint8Array(600_000).fill(7);
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 10; attempt++) {
    // No direction version: refused from the headers, the image never read.
    const refused = await fetch(`${base}/api/projects/${owner.projectId}/direction/shot-1-1/anchors`, { method: "POST", body,
      headers: { authorization: "Bearer " + owner.token, "content-type": "image/png", "x-hv-reference-attested": "true" } });
    statuses.push(refused.status); await refused.arrayBuffer();
    const read = await fetch(`${base}/api/projects/${owner.projectId}`, { headers: { authorization: "Bearer " + owner.token } });
    statuses.push(read.status); await read.arrayBuffer();
  }
  expect(statuses).toEqual(Array.from({ length: 20 }, (_, index) => index % 2 ? 200 : 409));
}, 60000);

test("a body over the edge's limit is refused before it reaches the API", async () => {
  const base = await edge(upstream, { HV_EDGE_MAX_BODY_BYTES: "1000" });
  const response = await fetch(base + "/api/projects", { method: "POST", body: new Uint8Array(5000) });
  expect(response.status).toBe(413);
  expect((await fetch(base + "/api/projects", { method: "POST" })).status).toBe(201);
}, 60000);
