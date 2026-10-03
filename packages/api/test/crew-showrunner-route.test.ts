/**
 * HV-030-29 — the Showrunner at the plan step, and a feature rendered one sequence at a time
 * (Release 3 step 2, G20-202610031349).
 *
 * The plan step splits a feature into sequences of at most 24 shots and keeps the plan on the project,
 * beside its format. Each sequence is its own render, named by its number, admitted against the
 * feature's one film limit. A reel and a short are planned and rendered exactly as before.
 * Mock and FLUX Schnell storyboard renders only; no provider is called.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrewLedger } from "../../operator/src/crew-ledger";
import { parseFountain } from "../../parser/src/index";
import { DurableJobStore, type Job } from "../../queue/src/index";
import { featureShots, sceneShotCounts } from "../../planner/src/sequences";
import { createApiServer } from "../src/server";
import { ProjectService, type PersistedState } from "../src/index";
import { evenFeature, featureScript } from "../../../test/fixtures/feature-script";

const KEYS = ["HV_TOKEN_SECRET", "HV_ANIMATIC_PROVIDER_POOL", "HV_FILM_SPEND_CAP_USD", "HV_FEATURE_FILM_SPEND_CAP_USD", "HV_ANIMATIC_COST_CAP_USD", "HV_NARRATION", "HV_ANIMATIC_CAPTIONS", "HV_MONTHLY_BUDGET_USD"];
const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
const roots: string[] = [], servers: Server[] = [];
type Server = ReturnType<typeof createApiServer>;
type Paths = {queuePath: string; statePath: string};

function start(env: Record<string, string> = {}, crewModel: unknown = null): Server & {paths: Paths} {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, {HV_TOKEN_SECRET: "showrunner-route-fixture-secret-at-least-thirty-two", HV_ANIMATIC_PROVIDER_POOL: '["image:fal:flux-schnell"]',
    HV_ANIMATIC_COST_CAP_USD: "5", HV_NARRATION: "0", HV_ANIMATIC_CAPTIONS: "0", ...env});
  const root = mkdtempSync(join(tmpdir(), "hv-showrunner-"));
  roots.push(root);
  const paths = {queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json")};
  const server = createApiServer({port: 0, hostname: "127.0.0.1", ...paths, artifactRoot: join(root, "artifacts"), costLedgerPath: join(root, "ledger.json"),
    rateLimit: {api: {limit: 10000, windowMs: 60000}, projectCreate: {limit: 10000, windowMs: 3600000}}, crewLedger: new CrewLedger(), crewModel: crewModel as never});
  servers.push(server);
  return Object.assign(server, {paths});
}
afterAll(async () => {
  for (const server of servers) await server.stop(true);
  for (const root of roots) rmSync(root, {recursive: true, force: true});
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

const call = (server: Server, path: string, method = "GET", body?: unknown, token?: string) => fetch(new URL(path, server.url), {method,
  headers: {"content-type": "application/json", ...(token ? {authorization: "Bearer " + token} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});

interface PlanAnswer { castingVersion: number; directionVersion: number; directedShots: number; notes: {persona: string; change: string}[]; error?: string;
  sequences?: {source: string; fallbackReason?: string; unusableReason?: string; revision: string; sequences: {number: number; firstScene: number; lastScene: number; shots: number}[]} }

async function film(server: Server, script: string) {
  const owner = await (await call(server, "/api/projects", "POST")).json() as {projectId: string; token: string};
  const base = "/api/projects/" + owner.projectId;
  expect((await call(server, base + "/script", "PUT", {text: script}, owner.token)).status).toBe(200);
  expect((await call(server, base + "/rights", "POST", {attested: true}, owner.token)).status).toBe(200);
  let versions = {scriptVersion: 1, castingVersion: 0, directionVersion: 0};
  const plan = async (format: string) => {
    const response = await call(server, base + "/crew/plan", "POST", {format, tone: "", answers: [], expected: versions}, owner.token);
    const body = await response.json() as PlanAnswer;
    if (response.status === 200) versions = {scriptVersion: 1, castingVersion: body.castingVersion, directionVersion: body.directionVersion};
    // The look approval: the creator permits the crew's original cast, once.
    if (response.status === 200) {
      const approved = await call(server, base + "/crew/approve-cast", "POST", {attested: true, expectedVersion: versions.castingVersion}, owner.token);
      versions.castingVersion = (await approved.json() as {casting: {version: number}}).casting.version;
    }
    return {status: response.status, body};
  };
  const spend = async () => await (await call(server, base + "/spend", "GET", undefined, owner.token)).json() as {spentUsd: number; heldUsd: number; capUsd: number;
    sequences?: {number: number; firstScene: number; lastScene: number; shots: number; spentUsd: number; heldUsd: number}[]};
  const render = async (body: Record<string, unknown> = {}) => {
    const response = await call(server, base + "/jobs", "POST", body, owner.token);
    return {status: response.status, body: await response.json() as {jobId?: string; error?: string; admitted?: boolean}};
  };
  return {...owner, base, plan, spend, render};
}

describe("the plan step splits a feature", () => {
  test("a 34-scene feature is split into sequences of at most 24 shots, in order, and the crew directs every shot", async () => {
    const server = start(), one = await film(server, featureScript());
    const {status, body} = await one.plan("feature");
    expect(status).toBe(200);
    const parsed = parseFountain(featureScript()), counts = sceneShotCounts(parsed), shots = featureShots(parsed);
    const sequences = body.sequences!.sequences;
    expect(body.sequences!.source).toBe("stand-in");
    expect(sequences.length).toBeGreaterThan(1);
    expect(sequences.map(sequence => sequence.number)).toEqual(sequences.map((_, index) => index + 1));
    expect(sequences[0]!.firstScene).toBe(1);
    expect(sequences.at(-1)!.lastScene).toBe(34);
    for (const [index, sequence] of sequences.entries()) {
      expect(sequence.shots).toBeLessThanOrEqual(24);
      expect(sequence.shots).toBe(counts.slice(sequence.firstScene - 1, sequence.lastScene).reduce((a, b) => a + b, 0));
      if (index) expect(sequence.firstScene).toBe(sequences[index - 1]!.lastScene + 1);
    }
    // The crew directs the feature's own shots, every sequence's, in one direction version.
    expect(body.directedShots).toBe(shots.length);
    expect(shots.length).toBeGreaterThan(24);
    expect(body.notes[0]!.persona).toBe("showrunner");
    expect(body.notes[0]!.change).toStartWith("Split the feature into " + sequences.length + " sequences");
    // The plan is kept on the project, beside the format, and survives a reload.
    const state = JSON.parse(readFileSync(server.paths.statePath, "utf8")) as PersistedState;
    const stored = state.projects.find(project => project.id === one.projectId)!;
    expect(stored.format).toBe("feature");
    expect(stored.sequences!.revision).toBe(body.sequences!.revision);
    expect(stored.sequences!.sequences).toEqual(sequences.map(({firstScene, lastScene, shots}) => ({firstScene, lastScene, shots})));
    expect(ProjectService.fromState(state).peekProject(one.projectId)!.sequences).toEqual(stored.sequences);
    const spend = await one.spend();
    expect(spend.capUsd).toBe(150);
    expect(spend.sequences!.map(sequence => [sequence.number, sequence.spentUsd, sequence.heldUsd])).toEqual(sequences.map(sequence => [sequence.number, 0, 0]));
  });

  test("the model's split is used when it is a split, and refused for the greedy one when it isn't", async () => {
    const parsed = parseFountain(featureScript()), counts = sceneShotCounts(parsed);
    const answering = (text: string) => ({name: "anthropic" as const, model: "claude-sonnet-5", async complete() { return {text, usage: {inputTokens: 10, outputTokens: 10}, model: "claude-sonnet-5", costUsd: 0.01}; }});
    const each = counts.map((_, index) => ({firstScene: index + 1, lastScene: index + 1}));
    // Every answer the model gives: one scene a sequence for the Showrunner, and no usable plan for the rest of the crew.
    const usable = await (await film(start({}, answering(JSON.stringify({sequences: each}))), featureScript())).plan("feature");
    expect(usable.status).toBe(200);
    expect(usable.body.sequences!.source).toBe("anthropic");
    expect(usable.body.sequences!.sequences).toHaveLength(34);
    const gap = await (await film(start({}, answering(JSON.stringify({sequences: [{firstScene: 1, lastScene: 3}, {firstScene: 5, lastScene: 34}]}))), featureScript())).plan("feature");
    expect(gap.status).toBe(200);
    expect(gap.body.sequences).toMatchObject({source: "stand-in", fallbackReason: "model_unusable", unusableReason: "bad_shape"});
    expect(gap.body.sequences!.sequences.every(sequence => sequence.shots <= 24)).toBe(true);
  });

  test("a reel and a short are planned as before: no sequences, and one render's shots", async () => {
    const server = start();
    for (const format of ["reel", "short"]) {
      const one = await film(server, featureScript(6));
      const {status, body} = await one.plan(format);
      expect(status).toBe(200);
      expect(body).not.toHaveProperty("sequences");
      expect(body.notes.some(note => note.persona === "showrunner")).toBe(false);
      expect(await one.spend()).toEqual({spentUsd: 0, heldUsd: 0, capUsd: 40});
      expect((await one.render({sequence: 1})).status).toBe(400);
      const whole = await one.render(); expect([whole.status, whole.body.error]).toEqual([202, undefined]);
    }
  });

  test("planning a feature again as a short removes its sequences", async () => {
    const server = start(), one = await film(server, featureScript());
    expect((await one.plan("feature")).body.sequences).toBeDefined();
    expect((await one.plan("short")).status).toBe(200);
    const stored = (JSON.parse(readFileSync(server.paths.statePath, "utf8")) as PersistedState).projects.find(project => project.id === one.projectId)!;
    expect(stored.format).toBe("short");
    expect(stored).not.toHaveProperty("sequences");
    expect(await one.spend()).not.toHaveProperty("sequences");
  });
});

describe("a feature renders one sequence at a time", () => {
  test("each render names its sequence and renders only that sequence's shots", async () => {
    const server = start(), one = await film(server, featureScript());
    const sequences = (await one.plan("feature")).body.sequences!.sequences;
    expect((await one.render()).status).toBe(400);
    expect((await one.render()).body.error).toContain("one sequence at a time");
    for (const bad of [0, sequences.length + 1, "1", 1.5]) expect((await one.render({sequence: bad})).status).toBe(400);
    expect((await one.render({sequence: 2, reuseUnchanged: true})).status).toBe(400);
    const second = await one.render({sequence: 2});
    expect(second.status).toBe(202);
    // Asking again for the same sequence is the same job; another sequence is another job.
    expect((await one.render({sequence: 2})).body).toMatchObject({jobId: second.body.jobId, admitted: false});
    const first = await one.render({sequence: 1});
    expect(first.status).toBe(202);
    expect(first.body.jobId).not.toBe(second.body.jobId);
    const store = new DurableJobStore(server.paths.queuePath);
    const job = (await store.get(second.body.jobId!)) as Job;
    expect(job.sequence).toMatchObject({number: 2, of: sequences.length, firstScene: sequences[1]!.firstScene, lastScene: sequences[1]!.lastScene});
    const shots = featureShots(parseFountain(featureScript())).filter(shot => shot.sceneIndex + 1 >= sequences[1]!.firstScene && shot.sceneIndex + 1 <= sequences[1]!.lastScene);
    expect(job.totalFrames).toBe(shots.reduce((total, shot) => total + Math.round(shot.durationSec * 30), 0));
    expect(shots).toHaveLength(sequences[1]!.shots);
  });

  test("a final follows its own sequence's rough cut", async () => {
    const server = start(), one = await film(server, featureScript());
    await one.plan("feature");
    const rough = await one.render({sequence: 1});
    // Not yet rendered or approved: refused as any final is.
    expect((await one.render({stage: "final", animaticJobId: rough.body.jobId, sequence: 1})).status).toBe(403);
  });

  test("a sequence plan made for an older screenplay is refused, not rendered", async () => {
    const server = start(), one = await film(server, featureScript());
    await one.plan("feature");
    expect((await call(server, one.base + "/script", "PUT", {text: featureScript() + "\n\nINT. LAST ROOM - NIGHT\n\nMara rests."}, one.token)).status).toBe(200);
    const stale = await one.render({sequence: 1});
    expect(stale.status).toBe(409);
    expect(stale.body.error).toContain("Plan the film again");
  });

  test("every sequence's admission is held to the feature's one film limit", async () => {
    // Three sequences of 13 shots, so each storyboard render holds the same. Measure that hold once at
    // the shipped limits, then hold a feature to two and a half of them: two sequences fit, the third doesn't.
    const script = evenFeature(3, 13);
    const measuring = await film(start(), script);
    expect((await measuring.plan("feature")).body.sequences!.sequences.map(sequence => sequence.shots)).toEqual([13, 13, 13]);
    expect((await measuring.render({sequence: 1})).status).toBe(202);
    const hold = (await measuring.spend()).heldUsd;
    expect(hold).toBeGreaterThan(0);
    const limit = Number((hold * 2.5).toFixed(2));
    const server = start({HV_FILM_SPEND_CAP_USD: String(Number((hold * 1.5).toFixed(2))), HV_FEATURE_FILM_SPEND_CAP_USD: String(limit)});
    const one = await film(server, script);
    await one.plan("feature");
    expect((await one.render({sequence: 1})).status).toBe(202);
    expect((await one.render({sequence: 2})).status).toBe(202);
    const refused = await one.render({sequence: 3});
    expect(refused.status).toBe(429);
    const spend = await one.spend();
    expect(spend).toMatchObject({heldUsd: Number((hold * 2).toFixed(6)), capUsd: limit});
    expect(spend.sequences!.map(sequence => sequence.heldUsd)).toEqual([hold, hold, 0]);
  });
});
