/**
 * HV-016-10 — pitching the same screenplay again rendered the film again, and charged for it.
 *
 * The server derives a render's idempotency key from what the render is *of* when the caller sends
 * none — `${stage}:${scriptVersion}:cast-${castingVersion}:direction-${directionVersion}` — and
 * HV-030-07 took the studio's `crypto.randomUUID()` keys away precisely so that derived key would
 * stand. But `VersionStore.commit` pushed a new version for every save, whatever the text, so a
 * save that changed nothing moved the key.
 *
 * That is not a theoretical path. It was the only path the studio offered a creator who closed the
 * tab and came back, until HV-016-09; it is what "pitch it again" does; and the studio's own
 * `pitch()` saves the script before anything else. Measured end to end here, before:
 *
 *     PUT /script (one string, three times)  ->  versions 1, 2, 3
 *     POST /jobs {} ; PUT /script (same) ; POST /jobs {}  ->  two different job ids
 *
 * This is the route-level half; `packages/parser/test/version-noop-save.test.ts` is the rule.
 */
import {afterAll, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../src/server";

const root = mkdtempSync(join(tmpdir(), "hv-repitch-"));
process.env.HV_TOKEN_SECRET = "repitch-route-fixture-secret-with-thirty-two-characters";
const server = createApiServer({port: 0, hostname: "127.0.0.1", queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json"),
  artifactRoot: join(root, "artifacts"), costLedgerPath: join(root, "ledger.json"), rateLimit: {api: {limit: 1000, windowMs: 60000}}});
afterAll(async () => {await server.stop(true); rmSync(root, {recursive: true, force: true});});
const call = (path: string, method = "GET", body?: unknown, token?: string) => fetch(new URL(path, server.url), {method,
  headers: {"content-type": "application/json", ...(token ? {authorization: "Bearer " + token} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
const SCRIPT = "INT. BAR - DAY\n\nShe waits.";

const project = async () => {
  const owner = await (await call("/api/projects", "POST")).json() as {projectId: string; token: string};
  return {owner, base: "/api/projects/" + owner.projectId};
};

test("pitching the same screenplay again does not render the film again", async () => {
  const {owner, base} = await project();
  const save = async (text: string) => (await (await call(base + "/script", "PUT", {text}, owner.token)).json() as {version: number}).version;
  expect([await save(SCRIPT), await save(SCRIPT), await save(SCRIPT)]).toEqual([1, 1, 1]);
  await call(base + "/rights", "POST", {attested: true}, owner.token);

  const render = async () => (await (await call(base + "/jobs", "POST", {}, owner.token)).json() as {jobId: string}).jobId;
  const first = await render();
  // The whole pitch again -- save, attest, render -- which is what "start over" does.
  await save(SCRIPT);
  await call(base + "/rights", "POST", {attested: true}, owner.token);
  expect({second: await render()}).toEqual({second: first});

  // One job, and the project's own view of itself agrees.
  const state = await (await call(base, "GET", undefined, owner.token)).json() as {scriptVersion: number; jobs: {id: string; stage: string}[]};
  expect({scriptVersion: state.scriptVersion, jobs: state.jobs.map(job => job.id)}).toEqual({scriptVersion: 1, jobs: [first]});
});

test("and a screenplay that actually changed still renders again, because it is a different film", async () => {
  const {owner, base} = await project();
  await call(base + "/script", "PUT", {text: SCRIPT}, owner.token);
  await call(base + "/rights", "POST", {attested: true}, owner.token);
  const first = (await (await call(base + "/jobs", "POST", {}, owner.token)).json() as {jobId: string}).jobId;
  const changed = await (await call(base + "/script", "PUT", {text: SCRIPT + "\n\nShe leaves."}, owner.token)).json() as {version: number};
  expect(changed.version).toBe(2);
  const second = (await (await call(base + "/jobs", "POST", {}, owner.token)).json() as {jobId: string}).jobId;
  expect({different: second !== first}).toEqual({different: true});
  // And the writer's own history still holds both screenplays, which is what a version is for.
  const state = await (await call(base, "GET", undefined, owner.token)).json() as {scriptVersion: number; script: string};
  expect({version: state.scriptVersion, script: state.script}).toEqual({version: 2, script: SCRIPT + "\n\nShe leaves."});
});

test("and a save that changes nothing is still refused when the screenplay itself is refused", async () => {
  // The no-op is decided after the parse, not before it, so a script with no scenes is still a 422
  // however many times it is sent -- the refusal does not become a silent success on the second try.
  const {owner, base} = await project();
  for (const attempt of [1, 2]) {
    const refused = await call(base + "/script", "PUT", {text: "She waits."}, owner.token);
    expect({attempt, status: refused.status}).toEqual({attempt, status: 422});
  }
  expect((await (await call(base, "GET", undefined, owner.token)).json() as {scriptVersion: number}).scriptVersion).toBe(0);
});
