/**
 * HV-019-16 — a feature with locked looks renders on the mock profile (Release 3 step 15, the rehearsal G21 runs).
 *
 * The $0 rehearsal ran `scripts/studio-run.ts --format feature --lock WREN,OSWIN --continuity-repair` on
 * the `mock` staging profile, and the front door's request for sequence 1's rough cut was refused:
 * `POST /api/projects/:id/jobs -> 400 No configured provider supports these render requirements:
 * references.` This is that run, in one process: the rehearsal's own screenplay, the mock profile's three
 * provider settings and no pool, the studio flow the script drives (createStudioFlow) and the desk steps it
 * takes before the look (scripts/release-3-desk.ts: two turnaround sheets, each character locked to its
 * four views, the Continuity Supervisor's repair). The real API and worker; the crew is the stand-in.
 *
 * Sequence 1's rough cut and final then render on the mock at $0. Every shot of WREN or OSWIN carries its
 * lock to the mock, which records each image by digest beside HV-017-17's lock record and says the picture
 * is not rendered from them; the desk's identity read and its drift check work on those renders.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApiServer } from "../src/server";
import { ProjectService } from "../src/index";
import { DurableJobStore, type Job } from "../../queue/src/index";
import { processNextJob } from "../../queue/src/worker";
import { CostLedger, OperatorReviewQueue } from "../../operator/src/index";
import { CrewLedger } from "../../operator/src/crew-ledger";
import { ReferenceBlobStore } from "../../storage/src/references";
import { REFERENCES_RECORDED_ADAPTATION, REFERENCES_RECORDED_NOT_RENDERED } from "../../generator/src/capabilities";
import type { ReferenceRecord } from "../../generator/src/image";
import type { RenderRoute } from "../../generator/src/router";
import type { ShotIdentityLock } from "../../planner/src/identity-locks";
import type { IdentityLockSequence } from "../src/identity-locks-api";
// @ts-expect-error -- the studio is a plain browser module with no type declarations.
import { createStudioFlow } from "../../frontend/src/studio.js";
import { deskBeforeLook, type BeforeLookReport } from "../../../scripts/release-3-desk";

const SCRIPT = readFileSync(resolve(import.meta.dir, "../../../docs/evidence/release-3/scripts/feature.fountain"), "utf8");
const root = mkdtempSync(join(tmpdir(), "hv-mock-profile-locks-"));
/** The `mock` profile exactly as scripts/staging-providers.py writes it: three provider lines and no pool. */
const MOCK_PROFILE = {HV_ANIMATIC_PROVIDER: "mock", HV_PROVIDER_PRIMARY: "mock", HV_PROVIDER_SECONDARY: "mock"};
const config: Record<string, string | undefined> = {...MOCK_PROFILE, HV_PROVIDER_POOL: undefined, HV_ANIMATIC_PROVIDER_POOL: undefined, HV_CHARACTER_SHEET_PROVIDER_POOL: undefined,
  HV_TOKEN_SECRET: "mock-profile-locks-fixture-secret-at-least-thirty-two", HV_NARRATION: "0", HV_ANIMATIC_CAPTIONS: "0"};
const original = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
const paths = {queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json"), artifactRoot: join(root, "artifacts"), costLedgerPath: join(root, "ledger.json")};
let server: ReturnType<typeof createApiServer> | undefined, running = true, loop: Promise<void> | undefined;
const workerErrors: unknown[] = [];

beforeAll(() => {
  for (const [key, value] of Object.entries(config)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  server = createApiServer({port: 0, hostname: "127.0.0.1", ...paths, rateLimit: {api: {limit: 100000, windowMs: 60000}, projectCreate: {limit: 10000, windowMs: 3600000}},
    crewLedger: new CrewLedger(), crewModel: null});
  // The staging worker, beside the API: it takes whatever the front door and the desk queue.
  const store = new DurableJobStore(paths.queuePath), context = {ledger: new CostLedger(paths.costLedgerPath), references: new ReferenceBlobStore(paths.artifactRoot),
    projects: new ProjectService(paths.statePath), reviewQueue: new OperatorReviewQueue(join(root, "reviews.json"))};
  loop = (async () => {
    while (running) {
      const job = await processNextJob(store, paths.artifactRoot, context).catch(error => { workerErrors.push(error); return null; });
      if (!job) await Bun.sleep(20);
    }
  })();
});
afterAll(async () => {
  running = false; await loop; await server?.stop(true); rmSync(root, {recursive: true, force: true});
  for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

/** The front door's request helper, as scripts/studio-run.ts writes it (the error is the rehearsal's). */
async function api(path: string, init: RequestInit = {}) {
  const base = server!.url.origin, response = await fetch(base + path, {...init, headers: {origin: base, ...(init.headers as Record<string, string> | undefined)}});
  const text = await response.text(), body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(path.replace(/[0-9a-f-]{36}/g, ":id") + " -> " + response.status + " " + (body.error ?? text.slice(0, 200)));
  return body;
}
type Shot = {id: string; provider: string; identityLocks?: ShotIdentityLock[]; referenceRecord?: ReferenceRecord; routing?: RenderRoute};
const manifestOf = (job: Job) => JSON.parse(readFileSync(join(paths.artifactRoot, job.output!.manifestPath), "utf8")) as {shots: Shot[]};

/** Each shot carries exactly the locks of the locked characters in it, and the mock recorded exactly their images, in the lock's order. */
function expectLocksRecorded(job: Job, locked: Map<string, string>) {
  expect([job.status, job.failureReason, job.costUsd, job.sequence?.number]).toEqual(["done", undefined, 0, 1]);
  const shots = manifestOf(job).shots;
  expect(shots.length).toBeGreaterThan(0);
  for (const shot of shots) {
    const locks = shot.identityLocks ?? [];
    expect(locks.every(lock => locked.get(lock.characterId) === lock.revision)).toBe(true);
    if (!locks.length) { expect(shot).not.toHaveProperty("referenceRecord"); continue; }
    expect(shot.referenceRecord).toEqual({use: REFERENCES_RECORDED_NOT_RENDERED, images: locks.flatMap(lock => lock.assets.map(asset => ({sha256: asset.sha256, bytes: expect.any(Number)})))});
    expect(shot.routing?.selectedCapability.referenceUse).toBe(REFERENCES_RECORDED_NOT_RENDERED);
    expect(shot.routing?.adaptations).toContain(REFERENCES_RECORDED_ADAPTATION);
  }
  return shots;
}

test("the rehearsal's feature, with WREN and OSWIN locked, renders sequence 1's rough cut and final on the mock profile at $0", async () => {
  let project: {projectId: string; token: string} | undefined;
  const flow = createStudioFlow({api, getProject: () => project, setProject: (value: typeof project) => { project = value; }, wait: () => Bun.sleep(25)});
  const pitched = await flow.pitch({script: SCRIPT, format: "feature", tone: "warm and hopeful", rightsAttested: true});
  expect(pitched.step).toBe("questions");
  const planned = await flow.plan(pitched.readThrough.questions.map((question: {id: string}) => ({id: question.id, accepted: true})));
  expect(planned.plan.sequences.sequences.length).toBeGreaterThan(1);

  // The desk steps the rehearsal takes before the look: each character gets a turnaround sheet and is locked to its four views.
  const owner = {authorization: "Bearer " + project!.token};
  const desk: BeforeLookReport = await deskBeforeLook({projectId: project!.projectId, state: flow.state, locks: ["WREN", "OSWIN"], continuity: true, poll: {intervalMs: 20, limitMs: 10 * 60 * 1000},
    call: (path, init = {}) => api(path, {method: init.method ?? "GET", headers: {...owner, ...(init.body === undefined ? {} : {"content-type": "application/json"})},
      ...(init.body === undefined ? {} : {body: JSON.stringify(init.body)})})});
  if (desk.castApproved) flow.state.pendingCast = [];
  expect(desk.locks.map(lock => [lock.name, lock.assets, lock.sheetJobId !== null])).toEqual([["WREN", 4, true], ["OSWIN", 4, true]]);
  const locked = new Map(desk.locks.map(lock => [lock.characterId, lock.revision!]));

  // The step the rehearsal stopped at: the look approved, sequence 1's rough cut asked for and made.
  const rough = await flow.approveLook(true);
  const store = new DurableJobStore(paths.queuePath), roughJob = (await store.get(rough.animatic.id))!;
  const roughShots = expectLocksRecorded(roughJob, locked);
  // Shots of both characters carry both locks, eight images, which the mock takes and records.
  expect(roughShots.some(shot => shot.identityLocks?.length === 2 && shot.referenceRecord?.images.length === 8)).toBe(true);
  // WREN is in every scene of sequence 1, so every shot of it is locked.
  expect(roughShots.every(shot => shot.identityLocks?.length)).toBe(true);

  // Sequence 1's final follows its approved rough cut, on the mock too: the two requests the front door's
  // "Approve and make sequence 1's final" sends (its finishing steps after the film are not this increment's).
  const post = (path: string, body: unknown) => api(`/api/projects/${project!.projectId}` + path, {method: "POST", headers: {...owner, "content-type": "application/json"}, body: JSON.stringify(body)});
  await post("/animatic/decision", {animaticJobId: rough.animatic.id, decision: "approved"});
  const queued = await post("/jobs", {stage: "final", animaticJobId: rough.animatic.id, sequence: 1}) as {jobId: string};
  let finalJob = (await store.get(queued.jobId))!;
  while (!["done", "failed", "cancelled"].includes(finalJob.status)) { await Bun.sleep(50); finalJob = (await store.get(queued.jobId))!; }
  expect(finalJob.stage).toBe("final");
  const finalShots = expectLocksRecorded(finalJob, locked);
  expect(finalShots.map(shot => [shot.id, shot.identityLocks?.map(lock => lock.revision), shot.referenceRecord]))
    .toEqual(roughShots.map(shot => [shot.id, shot.identityLocks?.map(lock => lock.revision), shot.referenceRecord]));
  expect(finalShots.every(shot => shot.provider === "mock")).toBe(true);
  expect(new CostLedger(paths.costLedgerPath).monthSpend()).toBe(0);

  // HV-017-17's desk read on the mock's renders: the locks each shot used, as its provenance records them, and no drift.
  const read = async () => (await api(`/api/projects/${project!.projectId}/identity-locks`, {headers: owner})) as {sequences: IdentityLockSequence[]};
  const first = (await read()).sequences[0]!;
  expect([first.number, first.needsRoughCut, first.drift]).toEqual([1, false, []]);
  for (const render of first.renders) {
    const recorded = manifestOf((await store.get(render.jobId))!).shots;
    expect(render.shots.map(shot => [shot.shotId, shot.locks])).toEqual(recorded.map(shot => [shot.id, shot.identityLocks ?? []]));
  }
  // OSWIN's look changes after sequence 1: the drift check names it, from the revision the mock's renders recorded.
  const casting = (await api(`/api/projects/${project!.projectId}/cast`, {headers: owner})).casting;
  const oswin = casting.characters.find((character: {name: string}) => character.name === "OSWIN");
  await api(`/api/projects/${project!.projectId}/cast/${oswin.id}/reference-lock`, {method: "PUT", headers: {...owner, "content-type": "application/json"},
    body: JSON.stringify({expectedVersion: casting.version, lock: {assetIds: [oswin.references[0].id], label: "OSWIN, one view", note: ""}})});
  const changed = (await read()).sequences[0]!;
  expect([changed.needsRoughCut, changed.drift.map(drift => [drift.name, drift.used, drift.current === drift.used])]).toEqual([true, [["OSWIN", locked.get(oswin.id)!, false]]]);
  expect(workerErrors).toEqual([]);
}, 600000);
