import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/server";
import { CAST_INPUT } from "../../../test/fixtures/casting";

// HV-019-04: one film may not spend past its limit, and the creator can see what it has spent.
const SCRIPT = "INT. ROOM - DAY\n\nMarla stares at the lamp.\n\nEXT. GARDEN - DAY\n\nMarla walks away.";
const envKeys = ["HV_TOKEN_SECRET", "HV_ANIMATIC_PROVIDER_POOL", "HV_FILM_SPEND_CAP_USD", "HV_ANIMATIC_COST_CAP_USD", "HV_NARRATION", "HV_ANIMATIC_CAPTIONS"];
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
const root = mkdtempSync(join(tmpdir(), "hv-film-budget-"));
let server: ReturnType<typeof createApiServer>;

beforeAll(() => {
  // A paid storyboard provider (never called: no worker runs), a $5 cap per animatic and a 3-cent film limit.
  // HV-019-06: a render holds what it can actually spend (2 stills at $0.003, 3 attempts each: $0.02), not its cap.
  Object.assign(process.env, { HV_TOKEN_SECRET: "film-budget-fixture-secret-at-least-thirty-two", HV_ANIMATIC_PROVIDER_POOL: '["image:fal:flux-schnell"]',
    HV_FILM_SPEND_CAP_USD: "0.03", HV_ANIMATIC_COST_CAP_USD: "5", HV_NARRATION: "0", HV_ANIMATIC_CAPTIONS: "0" });
  server = createApiServer({ port: 0, hostname: "127.0.0.1", queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json"),
    artifactRoot: join(root, "artifacts"), costLedgerPath: join(root, "ledger.json"), rateLimit: { api: { limit: 10000, windowMs: 60000 } } });
});
afterAll(async () => {
  await server.stop(true);
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

const call = (path: string, method = "GET", body?: unknown, token?: string) => fetch(new URL(path, server.url), { method,
  headers: { "content-type": "application/json", ...(token ? { authorization: "Bearer " + token } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

async function film() {
  const owner = await (await call("/api/projects", "POST")).json() as { projectId: string; token: string };
  const base = "/api/projects/" + owner.projectId;
  await call(base + "/script", "PUT", { text: SCRIPT }, owner.token);
  await call(base + "/rights", "POST", { attested: true }, owner.token);
  expect((await call(base + "/cast/" + crypto.randomUUID(), "PUT", { character: { ...CAST_INPUT, name: "Marla", aliases: [] }, expectedVersion: 0 }, owner.token)).status).toBe(200);
  return { ...owner, base };
}
const spend = async (base: string, token: string) => await (await call(base + "/spend", "GET", undefined, token)).json() as { spentUsd: number; heldUsd: number; capUsd: number };

test("a film's paid renders stop at its limit, and other films are unaffected", async () => {
  const one = await film();
  expect(await spend(one.base, one.token)).toEqual({ spentUsd: 0, heldUsd: 0, capUsd: 0.03 });
  expect((await call(one.base + "/jobs", "POST", { idempotencyKey: crypto.randomUUID() }, one.token)).status).toBe(202);
  expect(await spend(one.base, one.token)).toEqual({ spentUsd: 0, heldUsd: 0.02, capUsd: 0.03 });
  const refused = await call(one.base + "/jobs", "POST", { idempotencyKey: crypto.randomUUID() }, one.token);
  expect(refused.status).toBe(429);
  const body = await refused.json() as { error: string; reason: string };
  expect(body.reason).toBe("budget_exhausted");
  expect(body.error).toContain("spending limit of $0.03");
  // Nothing was held for the refused render.
  expect((await spend(one.base, one.token)).heldUsd).toBe(0.02);
  // The limit is per film: a second film starts with its own.
  const two = await film();
  const second = await call(two.base + "/jobs", "POST", { idempotencyKey: crypto.randomUUID() }, two.token);
  expect(second.status).toBe(202);
});

test("only the film's owner sees its spend", async () => {
  const one = await film(), two = await film();
  expect((await call(one.base + "/spend", "GET", undefined, two.token)).status).toBe(401);
  expect((await call(one.base + "/spend")).status).toBe(401);
});
