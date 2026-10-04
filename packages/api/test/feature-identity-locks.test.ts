/**
 * HV-017-17 — identity across sequences (Release 3 step 4, G20-202610031349).
 *
 * A feature is made one sequence at a time (HV-030-29). Every sequence's render is conditioned on each
 * locked character's lock exactly as a short's render is, records per shot which locks it used, and
 * follows one rule when a lock changes mid-feature (the style bible's, HV-034-02): later sequences use
 * the new lock; a sequence already made is flagged until its rough cut is made again; its final can't
 * follow the old rough cut, and the join refuses its old final.
 *
 * Real API and worker. The reference-capable vendors are closed HTTP fixtures (test/fixtures/reference-fal.ts:
 * no network, no key, no spend); a shot with no reference images renders on the mock provider. The
 * Showrunner's split comes from a stand-in model answer so each sequence is a few shots.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/server";
import { ProjectService } from "../src/index";
import { DurableJobStore, type Job } from "../../queue/src/index";
import { processNextJob } from "../../queue/src/worker";
import { CostLedger, OperatorReviewQueue } from "../../operator/src/index";
import { CrewLedger } from "../../operator/src/crew-ledger";
import { ReferenceBlobStore } from "../../storage/src/references";
import { DeterministicMockImageProvider } from "../../generator/src/image";
import { DeterministicMockProvider } from "../../generator/src/index";
import type { CastingSnapshot } from "../../planner/src/casting";
import type { ReferenceAsset } from "../../planner/src/references";
import type { LockDrift, ShotIdentityLock } from "../../planner/src/identity-locks";
import type { IdentityLockSequence } from "../src/identity-locks-api";
import { CAST_INPUT } from "../../../test/fixtures/casting";
import { referenceFal, REFERENCE_IMAGE_MODEL, REFERENCE_VIDEO_MODEL } from "../../../test/fixtures/reference-fal";

/**
 * Six scenes, 25 shots (one past a single render, so the Showrunner splits), three sequences of two
 * scenes each. MARA and JUNO are locked; TOM holds a reference image but no lock. Every sequence has
 * shots of a locked character and shots of TOM alone.
 */
const BEATS = [5, 4, 4, 4, 4, 4];
const scene = (number: number, heading: string, line: (n: number) => string) => heading + "\n\n" + Array.from({length: BEATS[number - 1]!}, (_, i) => line(i + 1)).join("\n\n");
const SCRIPT = [
  scene(1, "INT. WORKSHOP - DAY", n => `Mara and Juno sort crate ${n} on the bench.`),
  scene(2, "EXT. YARD - DAY", n => `Tom sweeps the yard, pass ${n}.`),
  scene(3, "INT. WORKSHOP - NIGHT", n => `Mara mends crate ${n} by lamplight.`),
  scene(4, "EXT. YARD - NIGHT", n => `Tom chains gate ${n}.`),
  scene(5, "INT. LOFT - DAY", n => `Juno and Tom stack crate ${n} under the eaves.`),
  scene(6, "EXT. ROAD - DAY", n => `Mara waves from the road, wave ${n}.`),
].join("\n\n");
/** The scene number of each shot a sequence renders, in order. */
const scenesOf = (first: number) => [first, first + 1].flatMap(number => Array.from({length: BEATS[number - 1]!}, () => number));
const SPLIT = {sequences: [{firstScene: 1, lastScene: 2}, {firstScene: 3, lastScene: 4}, {firstScene: 5, lastScene: 6}]};
/** Which characters each scene shows. */
const SHOWS: Record<number, ("mara" | "juno" | "tom")[]> = {1: ["mara", "juno"], 2: ["tom"], 3: ["mara"], 4: ["tom"], 5: ["juno", "tom"], 6: ["mara"]};

const root = mkdtempSync(join(tmpdir(), "hv-feature-identity-"));
const config: Record<string, string> = {HV_TOKEN_SECRET: "feature-identity-fixture-secret-at-least-thirty-two",
  HV_ANIMATIC_PROVIDER_POOL: '["mock","image:fal:flux-2-edit"]', HV_PROVIDER_POOL: '["mock","fal:kling-o3-standard-reference"]',
  HV_ANIMATIC_COST_CAP_USD: "5", HV_NARRATION: "0", HV_ANIMATIC_CAPTIONS: "0", FAL_KEY: "identity-contract-fixture-only"};
const original = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
const realFetch = globalThis.fetch;
const paths = {queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json"), artifactRoot: join(root, "artifacts"), costLedgerPath: join(root, "ledger.json")};
const splitModel = {name: "anthropic" as const, model: "claude-sonnet-5",
  async complete() { return {text: JSON.stringify(SPLIT), usage: {inputTokens: 1, outputTokens: 1}, model: "claude-sonnet-5", costUsd: 0}; }};
let server: ReturnType<typeof createApiServer>, http: ReturnType<typeof referenceFal>, images: Buffer[] = [];

beforeAll(async () => {
  Object.assign(process.env, config);
  const imager = new DeterministicMockImageProvider();
  images = await Promise.all(["a red scarf", "a blue coat", "a green cap", "a yellow apron"].map(async (look, index) =>
    readFileSync((await imager.generateFrame("A fictional crate hauler in " + look, 11 + index, {}, join(root, "look-" + index + ".png"))).path)));
  const still = readFileSync((await imager.generateFrame("A fictional crate hauler", 7, {widthxheight: "640x512"}, join(root, "still.png"))).path);
  const clip = readFileSync((await new DeterministicMockProvider().generate("A fictional crate hauler", 7, {seed: 7, durationSec: 3, widthxheight: "1280x720"}, join(root, "clip.mp4"))).path);
  server = createApiServer({port: 0, hostname: "127.0.0.1", ...paths, rateLimit: {api: {limit: 100000, windowMs: 60000}, projectCreate: {limit: 10000, windowMs: 3600000}},
    crewLedger: new CrewLedger(), crewModel: splitModel as never});
  http = referenceFal(still, clip, server.url.origin, realFetch);
  globalThis.fetch = http.fetchImpl;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await server?.stop(true); rmSync(root, {recursive: true, force: true});
  for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

const call = (path: string, method = "GET", body?: unknown, token?: string) => fetch(new URL(path, server.url), {method,
  headers: {"content-type": "application/json", ...(token ? {authorization: "Bearer " + token} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** The bytes a vendor request carried, by digest, in the order it numbered them. */
const sent = (submission: {body: Record<string, unknown>}) => ((submission.body.image_urls as string[] | undefined) ?? []).map(url => sha(Buffer.from(url.slice("data:image/png;base64,".length), "base64")));

type Key = "mara" | "juno" | "tom";
async function film(format: "feature" | "short", script = SCRIPT) {
  const owner = await (await call("/api/projects", "POST")).json() as {projectId: string; token: string};
  const base = "/api/projects/" + owner.projectId, ids: Record<Key, string> = {mara: crypto.randomUUID(), juno: crypto.randomUUID(), tom: crypto.randomUUID()};
  expect((await call(base + "/script", "PUT", {text: script}, owner.token)).status).toBe(200);
  expect((await call(base + "/rights", "POST", {attested: true}, owner.token)).status).toBe(200);
  const cast = async () => (await (await call(base + "/cast", "GET", undefined, owner.token)).json() as {casting: CastingSnapshot}).casting;
  for (const key of ["mara", "juno", "tom"] as const) {
    const saved = await call(base + "/cast/" + ids[key], "PUT", {expectedVersion: (await cast()).version, character: {...CAST_INPUT, name: key.toUpperCase(), aliases: [],
      appearance: "A fictional crate hauler.", prohibitedChanges: "", wardrobe: [{sceneNumber: null, description: "Work clothes"}]}}, owner.token);
    expect(saved.status).toBe(200);
  }
  const upload = async (key: Key, image: Buffer) => {
    const response = await fetch(new URL(base + "/cast/" + ids[key] + "/references", server.url), {method: "POST",
      headers: {authorization: "Bearer " + owner.token, "content-type": "image/png", "x-hv-cast-version": String((await cast()).version), "x-hv-reference-attested": "true"}, body: new Uint8Array(image)});
    expect(response.status).toBe(201);
    return (await response.json() as {asset: ReferenceAsset}).asset;
  };
  const lock = async (key: Key, assets: ReferenceAsset[] | null, label = "Locked look") => {
    const response = await call(base + "/cast/" + ids[key] + "/reference-lock", "PUT", {expectedVersion: (await cast()).version, lock: assets && {assetIds: assets.map(asset => asset.id), label}}, owner.token);
    expect(response.status).toBe(200);
    return (await cast()).characters.find(character => character.id === ids[key])!.referenceLock;
  };
  const plan = async () => {
    const response = await call(base + "/crew/plan", "POST", {format, tone: "", answers: [], expected: {scriptVersion: 1, castingVersion: (await cast()).version, directionVersion: 0}}, owner.token);
    const body = await response.json() as {error?: string; sequences?: {source: string; sequences: {number: number; firstScene: number; lastScene: number}[]}};
    expect([response.status, body.error]).toEqual([200, undefined]);
    return body.sequences;
  };
  const admit = async (body: Record<string, unknown>) => {
    const response = await call(base + "/jobs", "POST", body, owner.token), data = await response.json() as {jobId?: string; error?: string};
    return {code: response.status, jobId: data.jobId, error: data.error};
  };
  const approve = async (job: Job) => expect((await call(base + "/animatic/decision", "POST", {animaticJobId: job.id, decision: "approved"}, owner.token)).status).toBe(201);
  const read = async (token: string | undefined = owner.token, method = "GET") => call(base + "/identity-locks", method, undefined, token);
  const desk = async () => {
    const response = await read();
    expect([response.status, response.headers.get("cache-control")]).toEqual([200, "private, no-store"]);
    return await response.json() as {schema: string; format: string | null; locks: ShotIdentityLock[]; sequences: IdentityLockSequence[]};
  };
  return {...owner, base, ids, cast, upload, lock, plan, admit, approve, read, desk};
}
type Film = Awaited<ReturnType<typeof film>>;

const worker = () => processNextJob(new DurableJobStore(paths.queuePath), paths.artifactRoot, {ledger: new CostLedger(paths.costLedgerPath),
  references: new ReferenceBlobStore(paths.artifactRoot), projects: new ProjectService(paths.statePath), reviewQueue: new OperatorReviewQueue(join(root, "reviews.json"))});
async function render(f: Film, body: Record<string, unknown>) {
  const before = http.submissions.length, admitted = await f.admit(body);
  expect([admitted.code, admitted.error]).toEqual([202, undefined]);
  const job = await worker();
  expect([job?.id, job?.status, job?.failureReason]).toEqual([admitted.jobId, "done", undefined]);
  const manifest = JSON.parse(readFileSync(join(paths.artifactRoot, job!.output!.manifestPath), "utf8")) as {shots: {id: string; identityLocks?: ShotIdentityLock[]}[]};
  return {job: job!, submissions: http.submissions.slice(before), manifest};
}
const sceneOf = (shotId: string) => Number(/^shot-(\d+)-/.exec(shotId)![1]);

/**
 * Every shot of a render, in order: the vendor request's images are, character by character, the
 * locked look's images in the lock's order (and an unlocked character's own image); the shot's
 * provenance names exactly the locks of the locked characters in it, and nothing for a shot of TOM alone.
 */
function expectRenderedFrom(f: Film, rendered: Awaited<ReturnType<typeof render>>, looks: {mara: ShotIdentityLock["references"]; juno: ShotIdentityLock["references"]; tom: ReferenceAsset},
  revisions: {mara: string; juno: string}, model: string) {
  const shots = rendered.manifest.shots;
  expect(shots.length).toBeGreaterThan(0);
  expect(rendered.submissions).toHaveLength(shots.length);
  for (const [index, shot] of shots.entries()) {
    const shows = SHOWS[sceneOf(shot.id)]!;
    const expected = shows.flatMap(key => key === "tom" ? [looks.tom.sha256] : looks[key].map(asset => asset.sha256));
    expect(rendered.submissions[index]!.model).toBe(model);
    expect(sent(rendered.submissions[index]!)).toEqual(expected);
    const locked = shows.filter((key): key is "mara" | "juno" => key !== "tom");
    if (!locked.length) expect(shot).not.toHaveProperty("identityLocks");
    else expect(shot.identityLocks!.map(lock => ({characterId: lock.characterId, revision: lock.revision, references: lock.references})))
      .toEqual(locked.map(key => ({characterId: f.ids[key], revision: revisions[key], references: looks[key]})));
  }
}

describe("identity across a feature's sequences", () => {
  test("every sequence renders each locked character from its lock, records it per shot, and a lock changed after sequence 1 is used from then on while sequence 1 is flagged", async () => {
    const f = await film("feature");
    const m1 = await f.upload("mara", images[0]!), m2 = await f.upload("mara", images[1]!), j1 = await f.upload("juno", images[2]!), t1 = await f.upload("tom", images[3]!);
    const maraA = (await f.lock("mara", [m2, m1], "Mara, act one"))!, juno = (await f.lock("juno", [j1], "Juno"))!;
    const split = await f.plan();
    expect(split?.sequences.map(sequence => [sequence.number, sequence.firstScene, sequence.lastScene])).toEqual([[1, 1, 2], [2, 3, 4], [3, 5, 6]]);
    const lookA = {mara: maraA.assets, juno: juno.assets, tom: t1}, revisionsA = {mara: maraA.revision, juno: juno.revision};
    expect(lookA.mara.map(asset => asset.id)).toEqual([m2.id, m1.id]);

    // Sequence 1, rough cut and final, from lock A.
    const rough1 = await render(f, {sequence: 1});
    expect(rough1.manifest.shots.map(shot => sceneOf(shot.id))).toEqual(scenesOf(1));
    expectRenderedFrom(f, rough1, lookA, revisionsA, REFERENCE_IMAGE_MODEL);
    await f.approve(rough1.job);
    const final1 = await render(f, {stage: "final", animaticJobId: rough1.job.id, sequence: 1});
    expectRenderedFrom(f, final1, lookA, revisionsA, REFERENCE_VIDEO_MODEL);

    // The creator changes Mara's lock after sequence 1: one image, a new revision.
    const maraB = (await f.lock("mara", [m1], "Mara, act two"))!;
    expect(maraB.revision).not.toBe(maraA.revision);
    const lookB = {...lookA, mara: maraB.assets}, revisionsB = {mara: maraB.revision, juno: juno.revision};

    // Sequences 2 and 3 render from the new lock, rough cut and final.
    for (const number of [2, 3]) {
      const rough = await render(f, {sequence: number});
      expect(rough.manifest.shots.map(shot => sceneOf(shot.id))).toEqual(scenesOf(2 * number - 1));
      expectRenderedFrom(f, rough, lookB, revisionsB, REFERENCE_IMAGE_MODEL);
      await f.approve(rough.job);
      expectRenderedFrom(f, await render(f, {stage: "final", animaticJobId: rough.job.id, sequence: number}), lookB, revisionsB, REFERENCE_VIDEO_MODEL);
    }

    // The desk reads, per sequence and shot, the locks each render used, and flags sequence 1.
    const desk = await f.desk();
    expect([desk.schema, desk.format]).toEqual(["hv-identity-locks/1", "feature"]);
    expect(desk.locks.map(lock => [lock.characterId, lock.revision])).toEqual([[f.ids.mara, maraB.revision], [f.ids.juno, juno.revision]]);
    const drift: LockDrift = {characterId: f.ids.mara, name: "MARA", used: maraA.revision, current: maraB.revision};
    expect(desk.sequences.map(sequence => [sequence.number, sequence.needsRoughCut, sequence.drift])).toEqual([[1, true, [drift]], [2, false, []], [3, false, []]]);
    for (const sequence of desk.sequences) {
      expect(sequence.renders.map(value => value.stage)).toEqual(["animatic", "final"]);
      for (const value of sequence.renders) {
        expect([value.current, value.drift]).toEqual(sequence.number === 1 ? [false, [drift]] : [true, []]);
        const recorded = JSON.parse(readFileSync(join(paths.artifactRoot, (await new DurableJobStore(paths.queuePath).get(value.jobId))!.output!.manifestPath), "utf8")) as {shots: {id: string; identityLocks?: ShotIdentityLock[]}[]};
        // The desk lists what the render's own provenance records, shot by shot.
        expect(value.shots.map(shot => [shot.shotId, shot.locks])).toEqual(recorded.shots.map(shot => [shot.id, shot.identityLocks ?? []]));
        expect(value.shots.map(shot => shot.sceneNumber)).toEqual(recorded.shots.map(shot => sceneOf(shot.id)));
      }
    }
    expect(desk.sequences[0]!.renders[0]!.shots[0]!.locks.map(lock => [lock.name, lock.label, lock.revision])).toEqual([["MARA", "Mara, act one", maraA.revision], ["JUNO", "Juno", juno.revision]]);
    expect(desk.sequences[1]!.renders[0]!.shots[0]!.locks.map(lock => [lock.name, lock.label, lock.revision])).toEqual([["MARA", "Mara, act two", maraB.revision]]);

    // Sequence 1's final can't follow its old rough cut, and the feature can't be joined from its old final.
    const again = await f.admit({stage: "final", animaticJobId: rough1.job.id, sequence: 1});
    expect(again.code).toBe(409);
    const finals = (await new DurableJobStore(paths.queuePath).all()).filter(job => job.projectId === f.projectId && job.stage === "final");
    const joinFeature = async () => call(f.base + "/feature-film", "POST", {idempotencyKey: crypto.randomUUID(), generationApproved: true, title: null, credits: null,
      sequences: [1, 2, 3].map(number => ({number, jobId: finals.filter(job => job.sequence!.number === number).at(-1)!.id}))}, f.token);
    const refused = await joinFeature();
    expect([refused.status, (await refused.json() as {error: string}).error]).toEqual([409,
      "Sequence 1's final is stale: the screenplay, the cast, the shot directions or its rough cut's approval changed after it was made. Make its rough cut and final again."]);

    // Sequence 1 made again from the new lock clears the flag, and the feature joins: one revision of every lock.
    const remade = await render(f, {sequence: 1});
    expectRenderedFrom(f, remade, lookB, revisionsB, REFERENCE_IMAGE_MODEL);
    expect((await f.desk()).sequences.map(sequence => sequence.needsRoughCut)).toEqual([false, false, false]);
    await f.approve(remade.job);
    const final = await render(f, {stage: "final", animaticJobId: remade.job.id, sequence: 1});
    expectRenderedFrom(f, final, lookB, revisionsB, REFERENCE_VIDEO_MODEL);
    finals.push(final.job);
    expect((await joinFeature()).status).toBe(202);
    // The record still holds what sequence 1 was first made from: its earlier renders keep lock A.
    const first = (await f.desk()).sequences[0]!;
    expect(first.renders.map(value => [value.stage, value.current])).toEqual([["animatic", false], ["final", false], ["animatic", true], ["final", true]]);
  }, 300000);

  test("the desk read is the owner's alone and only answers GET", async () => {
    const f = await film("feature"), other = await film("feature");
    expect((await f.read("")).status).toBe(401);
    expect((await f.read(other.token)).status).toBe(401);
    const review = await (await call(f.base + "/reviews", "POST", {permission: "approve"}, f.token)).json() as {token: string};
    expect((await f.read(review.token)).status).toBe(401);
    expect((await f.read(f.token, "POST")).status).toBe(405);
    // Before anything is planned or rendered: the cast's locks, and nothing rendered.
    const t1 = await f.upload("tom", images[3]!);
    const desk = await f.desk();
    expect([desk.locks, desk.sequences.map(sequence => [sequence.number, sequence.needsRoughCut, sequence.renders])]).toEqual([[], [[null, false, []]]]);
    void t1;
  }, 60000);
});

describe("a short is rendered and recorded as before", () => {
  test("a short's render carries the lock in its request and names it per shot; an unlocked short's record is unchanged", async () => {
    const short = "INT. WORKSHOP - DAY\n\nMara sorts crate 1 on the bench.\n\nEXT. YARD - DAY\n\nTom sweeps the yard.";
    const f = await film("short", short);
    const m1 = await f.upload("mara", images[0]!), m2 = await f.upload("mara", images[1]!);
    const mara = (await f.lock("mara", [m2, m1], "Mara"))!;
    expect(await f.plan()).toBeUndefined();
    const rough = await render(f, {});
    expect(rough.job.sequence).toBeUndefined();
    // The locked shot goes to the reference vendor with the lock's images in order; Tom's shot has none and renders on the mock.
    expect(rough.submissions.map(sent)).toEqual([mara.assets.map(asset => asset.sha256)]);
    expect(rough.manifest.shots.map(shot => [shot.id, shot.identityLocks?.map(lock => [lock.characterId, lock.revision])])).toEqual([["shot-1-1", [[f.ids.mara, mara.revision]]], ["shot-2-1", undefined]]);
    const desk = await f.desk();
    expect([desk.format, desk.sequences.map(sequence => [sequence.number, sequence.firstScene, sequence.lastScene, sequence.needsRoughCut])]).toEqual(["short", [[null, 1, 2, false]]]);
    expect(desk.sequences[0]!.renders[0]!.shots.map(shot => [shot.shotId, shot.locks.map(lock => lock.revision)])).toEqual([["shot-1-1", [mara.revision]], ["shot-2-1", []]]);

    // Nothing locked: the record has no identity locks at all, as before this increment.
    const plain = await film("short", "EXT. YARD - DAY\n\nTom sweeps the yard.");
    expect(await plain.plan()).toBeUndefined();
    const unlocked = await render(plain, {});
    expect(unlocked.submissions).toEqual([]);
    expect(unlocked.manifest.shots.every(shot => !("identityLocks" in shot))).toBe(true);
  }, 120000);
});
