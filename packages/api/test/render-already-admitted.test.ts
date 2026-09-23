/**
 * HV-030-10 — the studio knew the render was free and did not say so.
 *
 * `POST /projects/:id/jobs` returns the job it has already admitted for a repeated idempotency key
 * rather than admitting a second one. That is what HV-030-07 took the studio's random
 * `crypto.randomUUID()` keys away for, and what HV-016-10 and HV-017-12 stopped a no-op save from
 * defeating — a save that changed nothing used to move the derived key and buy a second film.
 *
 * The route already *knew*: the repeat has its own branch and its own early return. It answered with
 * the same shape as a new admission, so nothing downstream could tell a film that had just been paid
 * for from one that had been paid for ten minutes ago. Both of those increments' own gap lists say
 * the same sentence — *"Nothing tells the creator the render was free"* — and this is it.
 *
 * `admitted` is the whole change: `true` for a job this request admitted, `false` for one it found.
 */
import {afterAll, expect, test} from "bun:test";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createApiServer} from "../src/server";

const root = mkdtempSync(join(tmpdir(), "hv-admitted-"));
process.env.HV_TOKEN_SECRET = "already-admitted-fixture-secret-thirty-two-chars";
const server = createApiServer({port: 0, hostname: "127.0.0.1", queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json"),
  artifactRoot: join(root, "artifacts"), costLedgerPath: join(root, "ledger.json"), rateLimit: {api: {limit: 1000, windowMs: 60000}}});
afterAll(async () => {await server.stop(true); rmSync(root, {recursive: true, force: true});});
const call = (path: string, method = "GET", body?: unknown, token?: string) => fetch(new URL(path, server.url), {method,
  headers: {"content-type": "application/json", ...(token ? {authorization: "Bearer " + token} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});

const studio = async () => {
  const owner = await (await call("/api/projects", "POST")).json() as {projectId: string; token: string};
  const base = "/api/projects/" + owner.projectId;
  await call(base + "/script", "PUT", {text: "INT. BAR - DAY\n\nShe waits."}, owner.token);
  await call(base + "/rights", "POST", {attested: true}, owner.token);
  const render = async (body: Record<string, unknown> = {}) =>
    (await (await call(base + "/jobs", "POST", body, owner.token)).json()) as {jobId: string; admitted?: boolean};
  return {owner, base, render};
};

test("a render this request admitted says so, and one it found says so too", async () => {
  const {render} = await studio();
  const first = await render();
  expect({admitted: first.admitted}).toEqual({admitted: true});
  // The same film, asked for again: the job the studio already has, and the truth about it.
  const second = await render();
  expect({jobId: second.jobId, admitted: second.admitted}).toEqual({jobId: first.jobId, admitted: false});
  // And again, because a creator who reloads twice is told the same thing twice.
  expect(await render()).toMatchObject({jobId: first.jobId, admitted: false});
});

test("and a render the studio has not made before is admitted, whatever came before it", async () => {
  // The flag is about *this* key, not about whether the project has any jobs: a second render the
  // studio has not made is a new film and says so, with the project already holding one.
  const {render} = await studio();
  const first = await render();
  expect(first.admitted).toBe(true);
  const second = await render({idempotencyKey: "a-second-film"});
  expect({different: second.jobId !== first.jobId, admitted: second.admitted}).toEqual({different: true, admitted: true});
  // And each of the two keeps its own answer, because the flag follows the key.
  expect(await render()).toMatchObject({jobId: first.jobId, admitted: false});
  expect(await render({idempotencyKey: "a-second-film"})).toMatchObject({jobId: second.jobId, admitted: false});
});

test("and a caller's own key is answered the same way", async () => {
  // A client that sends its own idempotency key gets the same answer, because the branch that finds
  // an existing job does not care where the key came from.
  const {render} = await studio();
  const first = await render({idempotencyKey: "a-key-of-my-own"});
  expect(first.admitted).toBe(true);
  expect(await render({idempotencyKey: "a-key-of-my-own"})).toMatchObject({jobId: first.jobId, admitted: false});
});
