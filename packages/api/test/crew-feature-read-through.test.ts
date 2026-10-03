/**
 * HV-030-28 — the read-through route for a feature, and its quote on the operator's profile.
 *
 * `POST /crew/read-through` accepts `feature` beside `reel` and `short`, reads a feature whole (up to
 * 240 shots, where a reel or a short is one render's 24), and quotes the active final profile's lead
 * lane: Kling O3 keyframes at $0.42 a 5 s shot on `live-film-anchored`, Kling 2.5 at $0.35 on
 * `live-film`, and the reference lane on mock, as before. No provider is called: the quote reads the
 * registered price, and the stand-in crew answers.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrewLedger } from "../../operator/src/crew-ledger";
import { createApiServer } from "../src/server";

const KEYS = ["HV_TOKEN_SECRET", "HV_PROVIDER_PRIMARY", "HV_PROVIDER_SECONDARY", "HV_PROVIDER_POOL"];
const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
const root = mkdtempSync(join(tmpdir(), "hv-feature-read-"));
let server: ReturnType<typeof createApiServer>;
beforeAll(() => {
  for (const key of KEYS) delete process.env[key];
  process.env.HV_TOKEN_SECRET = "feature-read-fixture-secret-at-least-thirty-two";
  server = createApiServer({port: 0, hostname: "127.0.0.1", queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json"), artifactRoot: join(root, "artifacts"),
    costLedgerPath: join(root, "ledger.json"), rateLimit: {api: {limit: 10000, windowMs: 60000}, projectCreate: {limit: 10000, windowMs: 3600000}},
    crewLedger: new CrewLedger(), crewModel: null});
});
afterAll(async () => {
  await server.stop(true);
  rmSync(root, {recursive: true, force: true});
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

/** Three scenes of forty action beats each: 120 beats, more than one render plans. */
const LONG = Array.from({length: 3}, (_, scene) => `INT. ROOM ${scene + 1} - DAY\n\n` + Array.from({length: 40}, (_, i) => `Beat ${i + 1}: Marla crosses to the window.`).join("\n\n")).join("\n\n");
type Facts = {format: string; formatLimitSec: number; shots: number; estimate: {videoSpec: string; basis: string; finalVideoUsd: number}};

async function read(format: string, script = LONG): Promise<{status: number; facts?: Facts}> {
  const owner = await (await fetch(new URL("/api/projects", server.url), {method: "POST"})).json() as {projectId: string; token: string};
  const headers = {authorization: "Bearer " + owner.token, "content-type": "application/json"};
  await fetch(new URL(`/api/projects/${owner.projectId}/script`, server.url), {method: "PUT", headers, body: JSON.stringify({text: script})});
  const response = await fetch(new URL(`/api/projects/${owner.projectId}/crew/read-through`, server.url), {method: "POST", headers, body: JSON.stringify({format, tone: ""})});
  return {status: response.status, ...(response.status === 200 ? {facts: (await response.json() as {facts: Facts}).facts} : {})};
}
function profile(primary: string, secondary: string) { process.env.HV_PROVIDER_PRIMARY = primary; process.env.HV_PROVIDER_SECONDARY = secondary; }

test("a feature is read whole against 1,200 s; a reel as one 24-shot render against 90 s", async () => {
  profile("mock", "mock");
  const feature = await read("feature"), reel = await read("reel");
  expect(feature.status).toBe(200);
  expect(feature.facts).toMatchObject({format: "feature", formatLimitSec: 1200, shots: 120});
  expect(reel.facts).toMatchObject({format: "reel", formatLimitSec: 90, shots: 24});
  // On mock the quote is the reference lane's, as it always was.
  expect(feature.facts!.estimate).toEqual({videoSpec: "fal:kling-v2.5-turbo-pro", basis: "reference", finalVideoUsd: 42});
});

test("any other format is still refused", async () => {
  for (const format of ["film", "Feature", "features", ""]) expect((await read(format)).status).toBe(400);
});

test("on the anchored profile a feature's shots are quoted at $0.42 each", async () => {
  profile("fal:kling-o3-standard-keyframes", "fal:kling-v2.5-turbo-pro");
  const {facts} = await read("feature");
  expect(facts!.estimate).toEqual({videoSpec: "fal:kling-o3-standard-keyframes", basis: "profile", finalVideoUsd: 50.4});
});

test("on the live-film profile at $0.35 each", async () => {
  profile("fal:kling-v2.5-turbo-pro", "fal:kling-v2.5-turbo-pro");
  const {facts} = await read("short");
  expect(facts!.shots).toBe(24);
  expect(facts!.estimate).toEqual({videoSpec: "fal:kling-v2.5-turbo-pro", basis: "profile", finalVideoUsd: 8.4});
});
