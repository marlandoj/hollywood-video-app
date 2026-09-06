import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/server";
import { ProjectService } from "../src/index";
import { DurableJobStore } from "../../queue/src/index";
import { CostLedger, OperatorReviewQueue } from "../../operator/src/index";
import { processNextJob } from "../../queue/src/worker";
import { CAST_INPUT, CAST_SCRIPT } from "../../../test/fixtures/casting";

const fixtures: {root: string; server: ReturnType<typeof createApiServer>}[] = [];
afterAll(async () => {for (const value of fixtures) {await value.server.stop(true); rmSync(value.root, {recursive: true, force: true});}});
async function fixture() {
  process.env.HV_TOKEN_SECRET = "casting-api-fixture-secret-at-least-thirty-two-characters";
  const root = mkdtempSync(join(tmpdir(), "hv-casting-api-")), paths = {queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json"),
    artifactRoot: join(root, "artifacts"), costLedgerPath: join(root, "ledger.json")};
  const server = createApiServer({port: 0, hostname: "127.0.0.1", ...paths, rateLimit: {api: {limit: 10000, windowMs: 60000}}});
  fixtures.push({root, server});
  const call = (path: string, method = "GET", body?: unknown, token?: string) => fetch(new URL(path, server.url), {method,
    headers: {...(token ? {authorization: "Bearer " + token} : {}), "content-type": "application/json"}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const owner = await (await call("/api/projects", "POST")).json() as {projectId: string; token: string};
  const base = "/api/projects/" + owner.projectId;
  await call(base + "/script", "PUT", {text: CAST_SCRIPT}, owner.token);
  await call(base + "/rights", "POST", {attested: true}, owner.token);
  const store = new DurableJobStore(paths.queuePath), projects = new ProjectService(paths.statePath);
  const worker = () => processNextJob(store, paths.artifactRoot, {ledger: new CostLedger(paths.costLedgerPath), reviewQueue: new OperatorReviewQueue(join(root, "reviews.json")), projects});
  return {root, paths, call, owner, base, store, projects, worker};
}

test("cast routes require the project's owner link and optimistic revision; review links cannot edit", async () => {
  const f = await fixture(), id = crypto.randomUUID();
  const saved = await f.call(f.base + "/cast/" + id, "PUT", {expectedVersion: 0, character: CAST_INPUT}, f.owner.token);
  expect(saved.status).toBe(200);
  const view = await f.call(f.base + "/cast", "GET", undefined, f.owner.token);
  expect(view.headers.get("cache-control")).toBe("private, no-store");
  const body = await view.json() as {casting: {version: number; characters: {name: string}[]}; sceneHeadings: unknown[]};
  expect(body.casting.version).toBe(1); expect(body.casting.characters[0]!.name).toBe("SPUD"); expect(body.sceneHeadings).toHaveLength(2);
  expect((await f.call(f.base + "/cast/" + id, "PUT", {expectedVersion: 0, character: CAST_INPUT}, f.owner.token)).status).toBe(409);
  const other = await (await f.call("/api/projects", "POST")).json() as {token: string};
  expect((await f.call(f.base + "/cast", "GET", undefined, other.token)).status).toBe(401);
  expect((await f.call(f.base + "/cast/" + id, "PUT", {expectedVersion: 1, character: CAST_INPUT}, other.token)).status).toBe(401);
  const review = await (await f.call(f.base + "/reviews", "POST", {permission: "approve"}, f.owner.token)).json() as {token: string};
  expect((await f.call(f.base + "/cast", "GET", undefined, review.token)).status).toBe(401);
  expect((await f.call(f.base + "/cast", "GET")).status).toBe(401);
  expect((await f.call(f.base + "/cast/" + id, "PUT", {expectedVersion: 1, character: {...CAST_INPUT, kind: "real-person"}}, f.owner.token)).status).toBe(400);
});

test("a real local preview preserves its cast and provenance; editing the cast invalidates approval and final admission", async () => {
  const f = await fixture(), id = crypto.randomUUID();
  await f.call(f.base + "/cast/" + id, "PUT", {expectedVersion: 0, character: CAST_INPUT}, f.owner.token);
  const admitted = await (await f.call(f.base + "/jobs", "POST", {idempotencyKey: "cast-preview"}, f.owner.token)).json() as {jobId: string};
  expect(f.store.get(admitted.jobId)!.casting?.version).toBe(1);
  const preview = await f.worker();
  expect(preview?.id).toBe(admitted.jobId); expect(preview?.status).toBe("done");
  const manifest = JSON.parse(readFileSync(join(f.paths.artifactRoot, preview!.output!.manifestPath), "utf8"));
  expect(manifest.casting.characters[0]).toMatchObject({id, appearance: CAST_INPUT.appearance});
  expect(preview?.output?.storyboard?.[0]?.caption).not.toContain("Cast direction");
  expect((await f.call(f.base + "/animatic/decision", "POST", {animaticJobId: admitted.jobId, decision: "approved"}, f.owner.token)).status).toBe(201);
  await f.call(f.base + "/cast/" + id, "PUT", {expectedVersion: 1, character: {...CAST_INPUT, appearance: "A russet potato wearing a blue cap."}}, f.owner.token);
  expect((await f.call(f.base + "/animatic/decision", "POST", {animaticJobId: admitted.jobId, decision: "approved"}, f.owner.token)).status).toBe(409);
  expect((await f.call(f.base + "/jobs", "POST", {stage: "final", animaticJobId: admitted.jobId}, f.owner.token)).status).toBe(409);
  const reopened = await (await f.call(f.base + "/cast", "GET", undefined, f.owner.token)).json() as {casting: {version: number}};
  expect(reopened.casting.version).toBe(2); expect(f.store.get(admitted.jobId)!.casting?.version).toBe(1);
  const revised = await (await f.call(f.base + "/jobs", "POST", {idempotencyKey: "revised-preview"}, f.owner.token)).json() as {jobId: string};
  expect((await f.worker())?.status).toBe("done");
  expect((await f.call(f.base + "/animatic/decision", "POST", {animaticJobId: revised.jobId, decision: "approved"}, f.owner.token)).status).toBe(201);
  const final = await (await f.call(f.base + "/jobs", "POST", {stage: "final", animaticJobId: revised.jobId}, f.owner.token)).json() as {jobId: string};
  const exported = await f.worker();
  expect(exported?.id).toBe(final.jobId); expect(exported?.status).toBe("done");
  const finalManifest = JSON.parse(readFileSync(join(f.paths.artifactRoot, exported!.output!.manifestPath), "utf8"));
  expect(finalManifest.casting.version).toBe(2);
  expect(finalManifest.casting.revision).toBe(f.store.get(revised.jobId)!.casting!.revision);
  expect(finalManifest.casting.characters[0].appearance).toBe("A russet potato wearing a blue cap.");
}, 30000);

test("the JSON worker rechecks permission between completed shots", async () => {
  const f = await fixture(), id = crypto.randomUUID();
  await f.call(f.base + "/cast/" + id, "PUT", {expectedVersion: 0, character: CAST_INPUT}, f.owner.token);
  await f.call(f.base + "/jobs", "POST", {idempotencyKey: "revoke-between-shots"}, f.owner.token);
  let reads = 0;
  const stopped = await processNextJob(f.store, f.paths.artifactRoot, {
    ledger: new CostLedger(f.paths.costLedgerPath), reviewQueue: new OperatorReviewQueue(join(f.root, "reviews.json")),
    projects: {peekProject(projectId) {
      if (++reads === 2) f.projects.saveCharacter(f.owner.token, id, {...CAST_INPUT, permission: {...CAST_INPUT.permission, status: "revoked"}}, 1);
      return f.projects.peekProject(projectId);
    }},
  });
  expect(reads).toBe(2); expect(stopped?.status).toBe("failed"); expect(stopped?.failureKind).toBe("policy_refusal");
  expect(stopped?.checkpointShots).toBe(1); expect(stopped?.costUsd).toBe(0);
}, 30000);

test("permission revocation after queueing blocks the worker before inference and a pending restored cast cannot be admitted", async () => {
  const f = await fixture(), id = crypto.randomUUID();
  await f.call(f.base + "/cast/" + id, "PUT", {expectedVersion: 0, character: CAST_INPUT}, f.owner.token);
  const admitted = await (await f.call(f.base + "/jobs", "POST", {idempotencyKey: "revoked"}, f.owner.token)).json() as {jobId: string};
  await f.call(f.base + "/cast/" + id, "PUT", {expectedVersion: 1, character: {...CAST_INPUT, permission: {...CAST_INPUT.permission, status: "revoked"}}}, f.owner.token);
  const stopped = await f.worker();
  expect(stopped?.id).toBe(admitted.jobId); expect(stopped?.status).toBe("failed"); expect(stopped?.failureKind).toBe("policy_refusal");
  expect(stopped?.checkpointShots).toBe(0); expect(stopped?.costUsd).toBe(0);
  expect((await f.call(f.base + "/cast/restore", "POST", {expectedVersion: 2, version: 1}, f.owner.token)).status).toBe(200);
  const denied = await f.call(f.base + "/jobs", "POST", {idempotencyKey: "pending-restored"}, f.owner.token);
  expect(denied.status).toBe(400);
  expect((await denied.json() as {error: string}).error).toContain("not permitted");
  expect(f.store.all()).toHaveLength(1);
});

test("scene-specific cast instructions refuse silent reassignment when the screenplay changes", async () => {
  const f = await fixture(), id = crypto.randomUUID();
  await f.call(f.base + "/cast/" + id, "PUT", {expectedVersion: 0, character: {...CAST_INPUT, wardrobe: [{sceneNumber: 2, description: "A red jacket"}]}}, f.owner.token);
  await f.call(f.base + "/script", "PUT", {text: CAST_SCRIPT.replace("INT. KITCHEN - NIGHT", "EXT. PARK - DAY")}, f.owner.token);
  const denied = await f.call(f.base + "/jobs", "POST", {}, f.owner.token);
  expect(denied.status).toBe(409); expect((await denied.json() as {error: string}).error).toContain("Scene 2 changed");
  expect(f.store.all()).toHaveLength(0);
});

test("permission can be revoked without repairing wardrobe after a bound scene is removed", async () => {
  const f = await fixture(), id = crypto.randomUUID();
  await f.call(f.base + "/cast/" + id, "PUT", {expectedVersion: 0, character: {...CAST_INPUT, wardrobe: [{sceneNumber: 2, description: "A red jacket"}]}}, f.owner.token);
  await f.call(f.base + "/jobs", "POST", {idempotencyKey: "before-scene-removal"}, f.owner.token);
  await f.call(f.base + "/script", "PUT", {text: "EXT. GARDEN - DAY\nSpud waves."}, f.owner.token);
  expect((await f.call(f.base + "/cast/" + id + "/revoke", "POST", {expectedVersion: 1})).status).toBe(401);
  const revoked = await f.call(f.base + "/cast/" + id + "/revoke", "POST", {expectedVersion: 1}, f.owner.token);
  expect(revoked.status).toBe(200);
  expect((await revoked.json() as {casting: {characters: {permission: {status: string}}[]}}).casting.characters[0]!.permission.status).toBe("revoked");
  expect((await f.worker())?.failureKind).toBe("policy_refusal");
  expect((await f.call(f.base + "/cast/" + id + "/revoke", "POST", {expectedVersion: 1}, f.owner.token)).status).toBe(409);
});
