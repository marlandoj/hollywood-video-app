/**
 * HV-017-12 — re-saving a shot's own direction rendered the film again, and charged for it.
 *
 * The second of the three version fields in the key the server derives for a render when the caller
 * sends none:
 *
 *     `${stage}:${scriptVersion}:cast-${castingVersion}:direction-${directionVersion}`
 *
 * HV-030-07 took the studio's `crypto.randomUUID()` idempotency keys away so that derived key would
 * stand. HV-016-10 closed the same hole on `scriptVersion`, where a save of identical text advanced
 * the version. `saveDirectionSnapshot` had it too: it wrote `current.version + 1` for every save,
 * whatever the settings.
 *
 * Measured end to end on this repo's own API, before:
 *
 *     PUT /direction/:shot  (the shot's own settings, unchanged)  ->  versions 1, 2, 3
 *
 *     POST /jobs {}                                   ->  edfb91b7-…
 *     PUT /direction (unchanged), POST /jobs {}       ->  0b594c34-…   a second animatic, charged
 *
 * The Director's desk saves a shot's direction on every change to any control in its panel, and it
 * sends the panel's whole settings object — so a control touched and put back, or a save from a
 * panel nobody edited, was a new version and a new film. A `DirectionSnapshot`'s `revision` is a
 * content hash *including* its version, so the comparison is against a candidate built at the
 * current version: same entries, same scene cuts, same revision, nothing happened.
 */
import {afterAll, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../src/server";

const root = mkdtempSync(join(tmpdir(), "hv-direction-noop-"));
process.env.HV_TOKEN_SECRET = "direction-noop-fixture-secret-thirty-two-characters";
const server = createApiServer({port: 0, hostname: "127.0.0.1", queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json"),
  artifactRoot: join(root, "artifacts"), costLedgerPath: join(root, "ledger.json"), rateLimit: {api: {limit: 1000, windowMs: 60000}}});
afterAll(async () => {await server.stop(true); rmSync(root, {recursive: true, force: true});});
const call = (path: string, method = "GET", body?: unknown, token?: string) => fetch(new URL(path, server.url), {method,
  headers: {"content-type": "application/json", ...(token ? {authorization: "Bearer " + token} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});

interface View {
  direction: {version: number; entries: {source: {id: string}; settings: Record<string, unknown>}[]};
  plan: {source: {id: string}; sourceHash: string}[];
  scriptVersion: number;
}

const studio = async () => {
  const owner = await (await call("/api/projects", "POST")).json() as {projectId: string; token: string};
  const base = "/api/projects/" + owner.projectId;
  await call(base + "/script", "PUT", {text: "INT. BAR - DAY\n\nShe waits."}, owner.token);
  await call(base + "/rights", "POST", {attested: true}, owner.token);
  const view = () => call(base + "/direction", "GET", undefined, owner.token).then(response => response.json() as Promise<View>);
  const direct = async (settings?: Record<string, unknown>) => {
    const current = await view();
    const shot = current.plan[0]!;
    const entry = current.direction.entries.find(value => value.source.id === shot.source.id);
    const response = await call(base + "/direction/" + encodeURIComponent(shot.source.id), "PUT",
      {settings: settings ?? entry?.settings ?? {}, sourceHash: shot.sourceHash,
        expectedVersion: current.direction.version, expectedScriptVersion: current.scriptVersion}, owner.token);
    return {status: response.status, body: await response.json() as {direction?: {version: number; revision: string}; error?: string}};
  };
  const render = async () => (await (await call(base + "/jobs", "POST", {}, owner.token)).json() as {jobId: string}).jobId;
  return {owner, base, view, direct, render};
};

test("re-saving a shot's own direction does not make a new version", async () => {
  const {direct} = await studio();
  const first = await direct();
  expect({status: first.status, version: first.body.direction!.version}).toEqual({status: 200, version: 1});
  // The same settings, three more times: the same version and the same revision, every time.
  for (const attempt of [2, 3, 4]) {
    const again = await direct();
    expect({attempt, status: again.status, version: again.body.direction!.version, revision: again.body.direction!.revision})
      .toEqual({attempt, status: 200, version: 1, revision: first.body.direction!.revision});
  }
});

test("and re-saving it does not render the film again", async () => {
  const {direct, render} = await studio();
  await direct();
  const first = await render();
  await direct();
  expect({second: await render()}).toEqual({second: first});
});

test("and a direction that actually changed still makes a version, and a different film", async () => {
  const {direct, render, view} = await studio();
  await direct();
  const first = await render();
  const changed = await direct({coverage: {role: "single", subjects: [], axis: "", cameraSide: "unspecified",
    gazeSubject: "", gazeTarget: "", gazeDirection: "unspecified", reestablish: false, continuityNote: ""}});
  expect({status: changed.status, version: changed.body.direction!.version}).toEqual({status: 200, version: 2});
  expect({different: (await render()) !== first}).toEqual({different: true});
  // And saving that same changed direction again is a no-op in its turn.
  const again = await direct();
  expect(again.body.direction!.version).toBe(2);
  expect((await view()).direction.version).toBe(2);
});

test("and the first save of a shot nobody had directed is still a version", async () => {
  // Version 0 means "never directed" to `directionMatches`, so the first save must leave it -- an
  // entry with default settings is not the same thing as no entry at all.
  const {view, direct} = await studio();
  expect((await view()).direction.version).toBe(0);
  expect((await direct()).body.direction!.version).toBe(1);
});
