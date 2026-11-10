/**
 * HV-030-43 — a feature's placed lines through the real routes and store.
 *
 * The plan step stamps a new feature's sequence plan `dialoguePlacement: "speaker"`, and every route that
 * plans the project's shots reads the same shots its renders plan: the direction desk (GET and PUT
 * /direction), a take group's plan (POST /takes/quote) and the read-through's quote. A desk edit saved
 * against a placed shot then renders without a direction conflict and without moving a line.
 * Mock and FLUX Schnell storyboard renders only; no provider is called, and the quotes read registered prices.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrewLedger } from "../../operator/src/crew-ledger";
import { createProviderPlan } from "../../generator/src/catalog";
import { parseFountain } from "../../parser/src/index";
import { castingSnapshot } from "../../planner/src/casting";
import { readThroughFacts } from "../../planner/src/crew/read-through";
import type { DirectionEntry, DirectionSnapshot } from "../../planner/src/direction";
import { sourcePlan } from "../../planner/src/scene-cuts";
import { featureShots } from "../../planner/src/sequences";
import { renderShots } from "../../planner/src/shot-reuse";
import type { ShotTakePlan } from "../../planner/src/takes";
import { DurableJobStore, type Job } from "../../queue/src/index";
import { createApiServer } from "../src/server";
import type { PersistedState } from "../src/index";
import { stagingProfile } from "../../../test/fixtures/staging-profiles";

// Every variable a test here sets, the staging profile's included, is put back after the file.
const KEYS = [...new Set(["HV_TOKEN_SECRET", "HV_ANIMATIC_PROVIDER_POOL", "HV_FILM_SPEND_CAP_USD", "HV_FEATURE_FILM_SPEND_CAP_USD", "HV_ANIMATIC_COST_CAP_USD", "HV_NARRATION", "HV_ANIMATIC_CAPTIONS",
  "HV_MONTHLY_BUDGET_USD", "HV_PROVIDER_PRIMARY", "HV_PROVIDER_SECONDARY", "HV_PROVIDER_POOL", ...Object.keys(stagingProfile("live-film-referenced"))])];
const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
const roots: string[] = [], servers: Server[] = [];
type Server = ReturnType<typeof createApiServer>;

function start(env: Record<string, string> = {}): Server & {queuePath: string; statePath: string} {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, {HV_TOKEN_SECRET: "dialogue-placement-route-fixture-secret-thirty-two", HV_ANIMATIC_PROVIDER_POOL: '["image:fal:flux-schnell"]',
    HV_ANIMATIC_COST_CAP_USD: "5", HV_NARRATION: "0", HV_ANIMATIC_CAPTIONS: "0", ...env});
  const root = mkdtempSync(join(tmpdir(), "hv-dialogue-placement-"));
  roots.push(root);
  const paths = {queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json")};
  const server = createApiServer({port: 0, hostname: "127.0.0.1", ...paths, artifactRoot: join(root, "artifacts"), costLedgerPath: join(root, "ledger.json"),
    rateLimit: {api: {limit: 10000, windowMs: 60000}, projectCreate: {limit: 10000, windowMs: 3600000}}, crewLedger: new CrewLedger(), crewModel: null});
  servers.push(server);
  return Object.assign(server, paths);
}
afterAll(async () => {
  for (const server of servers) await server.stop(true);
  for (const root of roots) rmSync(root, {recursive: true, force: true});
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

const call = (server: Server, path: string, method = "GET", body?: unknown, token?: string) => fetch(new URL(path, server.url), {method,
  headers: {"content-type": "application/json", ...(token ? {authorization: "Bearer " + token} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});

/** Two scenes: the workshop's lines follow its second and third beats; the yard has more speeches than shots. */
const SCRIPT = "INT. WORKSHOP - DAY\n\nAda and Ben lean over a long bench covered in brass gears, springs and half-built clockwork birds while rain streams down the tall windows.\n\n"
  + "ADA\nHold it still.\n\nBen winds a tiny key and the bird twitches its tin wings.\n\nBEN\nIt's ticking.\n\nThe bird lifts off the bench and circles the lamp.\n\n"
  + "EXT. YARD - NIGHT\n\nThe gate swings.\n\nADA\nWho's there?\n\nBEN\nOnly the wind.\n\nADA\nThen why is it singing?\n";

interface View {direction: DirectionSnapshot; plan: DirectionEntry[]; scriptVersion: number; staleShotIds: string[]}

async function film(server: ReturnType<typeof start>, script = SCRIPT) {
  const owner = await (await call(server, "/api/projects", "POST")).json() as {projectId: string; token: string};
  const base = "/api/projects/" + owner.projectId;
  expect((await call(server, base + "/script", "PUT", {text: script}, owner.token)).status).toBe(200);
  expect((await call(server, base + "/rights", "POST", {attested: true}, owner.token)).status).toBe(200);
  const versions = {scriptVersion: 1, castingVersion: 0, directionVersion: 0};
  const plan = async (format: string) => {
    const response = await call(server, base + "/crew/plan", "POST", {format, tone: "", answers: [], expected: versions}, owner.token);
    const body = await response.json() as {castingVersion: number; directionVersion: number; directedShots: number; notes: {persona: string; change: string}[]; error?: string};
    expect([response.status, body.error]).toEqual([200, undefined]);
    versions.castingVersion = body.castingVersion; versions.directionVersion = body.directionVersion;
    const approved = await call(server, base + "/crew/approve-cast", "POST", {attested: true, expectedVersion: versions.castingVersion}, owner.token);
    versions.castingVersion = (await approved.json() as {casting: {version: number}}).casting.version;
    return body;
  };
  // A script edit, and the versions the next plan step is asked against.
  const edit = async (text: string) => {
    const saved = await call(server, base + "/script", "PUT", {text}, owner.token);
    expect(saved.status).toBe(200);
    versions.scriptVersion = (await saved.json() as {version: number}).version;
    versions.directionVersion = (await view()).direction.version;
  };
  const view = async () => await (await call(server, base + "/direction", "GET", undefined, owner.token)).json() as View;
  const stored = () => (JSON.parse(readFileSync(server.statePath, "utf8")) as PersistedState).projects.find(project => project.id === owner.projectId)!;
  return {...owner, base, versions, plan, edit, view, stored};
}

const who = (shots: {dialogue: {character: string}[]}[]) => shots.map(shot => shot.dialogue.map(block => block.character));
const parsed = parseFountain(SCRIPT), placed = featureShots(parsed, undefined, false, "speaker");

describe("a feature planned with its lines placed", () => {
  test("the plan stamps the placement, and the desk lists the shots the render plans", async () => {
    const server = start(), one = await film(server);
    const body = await one.plan("feature");
    expect(body.directedShots).toBe(placed.length);
    expect(one.stored().sequences!.dialoguePlacement).toBe("speaker");
    const state = await one.view();
    expect(state.staleShotIds).toEqual([]);
    expect(who(state.plan.map(entry => entry.source))).toEqual(who(placed));
    expect(state.plan.find(entry => entry.source.id === "shot-1-2")!.source.prompt).toContain("ADA speaks on camera");
    // Every crew direction was saved against the placed shot it lists.
    expect(state.direction.entries.map(entry => entry.sourceHash)).toEqual(state.plan.map(entry => entry.sourceHash));
  });

  test("the review's case: one desk edit after the crew directs the feature, and the sequence renders with the same placement", async () => {
    const server = start(), one = await film(server);
    await one.plan("feature");
    const state = await one.view(), shot = state.plan.find(entry => entry.source.id === "shot-1-2")!;
    const saved = await call(server, one.base + "/direction/shot-1-2", "PUT", {settings: {lensMm: 85}, sourceHash: shot.sourceHash, expectedVersion: state.direction.version,
      expectedScriptVersion: state.scriptVersion}, one.token);
    expect(saved.status).toBe(200);
    expect((await one.view()).staleShotIds).toEqual([]);
    const render = await call(server, one.base + "/jobs", "POST", {sequence: 1}, one.token);
    const answer = await render.json() as {jobId?: string; error?: string};
    expect([render.status, answer.error]).toEqual([202, undefined]);
    const job = (await new DurableJobStore(server.queuePath).get(answer.jobId!)) as Job;
    expect(job.sequence!.dialoguePlacement).toBe("speaker");
    // The render plans the job's own sequence: the same lines on the same shots, with the desk's lens on shot-1-2.
    const shots = renderShots(job, Date.now());
    expect(who(shots)).toEqual(who(placed.filter(value => shots.some(shot => shot.id === value.id))));
    const desk = shots.find(value => value.id === "shot-1-2")!;
    expect(desk.prompt).toContain("ADA speaks on camera");
    expect(job.direction!.entries.find(entry => entry.source.id === "shot-1-2")!.settings).toMatchObject({lensMm: 85});
  });

  test("a take group for a placed shot is planned from the shot the render plans, and keeps which plan it read", async () => {
    const server = start(), one = await film(server);
    await one.plan("feature");
    const state = await one.view(), shot = state.plan.find(entry => entry.source.id === "shot-1-3")!;
    const settings = {shotId: shot.source.id, sourceHash: shot.sourceHash, takes: [11, 12].map(seed => ({label: "Take " + seed, seed, settings: {}}))};
    const quote = await call(server, one.base + "/takes/quote", "POST", {settings, expectedScriptVersion: state.scriptVersion, expectedCastingVersion: one.versions.castingVersion,
      expectedDirectionVersion: state.direction.version, generationApproved: true}, one.token);
    const body = await quote.json() as {plan?: ShotTakePlan; error?: string};
    expect([quote.status, body.error]).toEqual([200, undefined]);
    expect(body.plan!.shotPlan).toBe("feature-speaker");
    expect(body.plan!.source.dialogue.map(block => block.character)).toEqual(["BEN"]);
    expect(body.plan!.source.prompt).toContain("BEN speaks on camera");
  });

  test("the review's re-plan: a placed feature planned again after a script edit stays placed, and only the changed shot is stale", async () => {
    const before = "INT. ROOM - DAY\n\nThe door opens.\n\nADA\nOne.\n\nA lamp flickers.\n\nA dog sleeps.\n\nThe rain stops.\n";
    const after = "INT. ROOM - DAY\n\nThe door opens.\n\nADA\nOne.\n\nA lamp flickers.\n\nA dog sleeps.\n\nBEN\nTwo.\n\nThe rain stops.\n";
    const server = start(), one = await film(server, before);
    expect((await one.plan("feature")).directedShots).toBe(4);
    expect(one.stored().sequences!.dialoguePlacement).toBe("speaker");
    expect(who((await one.view()).plan.map(entry => entry.source))).toEqual([[], ["ADA"], [], []]);
    await one.edit(after);
    const again = await one.plan("feature");
    // Still placed: BEN's speech takes the shot after its action, and the crew's other directions still hold.
    expect(one.stored().sequences!.dialoguePlacement).toBe("speaker");
    expect(again.notes.some(note => note.change.includes("Kept each scene's lines on its first shot"))).toBe(false);
    const state = await one.view();
    expect(who(state.plan.map(entry => entry.source))).toEqual([[], ["ADA"], ["BEN"], []]);
    expect(state.staleShotIds).toEqual(["shot-1-3"]);
    // The read-through quotes the same placed shots.
    const read = await call(server, one.base + "/crew/read-through", "POST", {format: "feature", tone: ""}, one.token);
    expect((await read.json() as {facts: {shots: number}}).facts.shots).toBe(4);
  });

  test("a desk edit before the first plan keeps the old placement, the Director names what holds it, and clearing those places the lines", async () => {
    const server = start(), one = await film(server);
    // Before any plan the desk lists one render's shots: every line on the scene's first shot.
    const first = await one.view(), shot = first.plan.find(entry => entry.source.id === "shot-1-1")!;
    expect(shot.source.dialogue.map(block => block.character)).toEqual(["ADA", "BEN"]);
    const saved = await call(server, one.base + "/direction/shot-1-1", "PUT", {settings: {lensMm: 35}, sourceHash: shot.sourceHash, expectedVersion: first.direction.version,
      expectedScriptVersion: first.scriptVersion}, one.token);
    expect(saved.status).toBe(200);
    one.versions.directionVersion = (await one.view()).direction.version;
    const planned = await one.plan("feature");
    expect(one.stored().sequences).not.toHaveProperty("dialoguePlacement");
    const note = planned.notes.find(value => value.persona === "director" && value.change.includes("Kept each scene's lines on its first shot"))!;
    // The crew then directs every shot to match, so the note lists every direction that now holds the placement back
    // (the yard's one shot too: placed, its prompt says who speaks).
    expect(note.change).toBe("Kept each scene's lines on its first shot, because the direction saved for shot-1-1 was made for that placement, and directed the other shots to match. "
      + "To put each line on its own shot near its action, framed for its speaker, clear the directions of shot-1-1, shot-1-2, shot-1-3 and shot-2-1 and plan again.");
    let state = await one.view();
    expect(state.staleShotIds).toEqual([]);
    expect(state.plan.some(entry => entry.source.prompt.includes("on camera"))).toBe(false);
    // Clear them, as the note says, and plan again: placed, and nothing to say.
    for (const id of ["shot-1-1", "shot-1-2", "shot-1-3", "shot-2-1"]) {
      expect((await call(server, one.base + "/direction/" + id + "/remove", "POST", {expectedVersion: state.direction.version}, one.token)).status).toBe(200);
      state = await one.view();
    }
    one.versions.directionVersion = state.direction.version;
    const again = await one.plan("feature");
    expect(one.stored().sequences!.dialoguePlacement).toBe("speaker");
    expect(again.notes.some(value => value.change.includes("Kept each scene's lines"))).toBe(false);
    state = await one.view();
    expect(who(state.plan.map(entry => entry.source))).toEqual(who(placed));
  });

  test("a short is planned, directed and quoted as before, with no stamp and no speaking sentence", async () => {
    const server = start(), one = await film(server);
    await one.plan("short");
    expect(one.stored()).not.toHaveProperty("sequences");
    const state = await one.view();
    expect(who(state.plan.map(entry => entry.source))).toEqual(who(sourcePlan(parsed, undefined, 7000, 24)));
    expect(state.plan.some(entry => entry.source.prompt.includes("on camera"))).toBe(false);
  });
});

/** One scene of four beats and four long speeches: placed one a shot, each shot is paced to its own line. */
const LINE = "The tide turns at midnight and the clock has to be wound before the water reaches the bottom step of the tower.";
const TALK = "INT. TOWER - NIGHT\n\nAda climbs the stairs.\n\nBen holds the lantern.\n\nAda opens the clock case.\n\nBen looks out at the sea.\n\n"
  + ["ADA", "BEN", "ADA", "BEN"].map(name => name + "\n" + LINE).join("\n\n") + "\n";

describe("the read-through's quote", () => {
  test("is the plan step's: the feature's shots, placed as the plan will place them", async () => {
    const profile = stagingProfile("live-film-referenced"), server = start(profile), one = await film(server, TALK), talk = parseFountain(TALK);
    const response = await call(server, one.base + "/crew/read-through", "POST", {format: "feature", tone: ""}, one.token);
    expect(response.status).toBe(200);
    const facts = (await response.json() as {facts: {shots: number; estimate: {finalVideoUsd: number; videoSpec: string}}}).facts;
    // What the plan step quotes (server.ts): readThroughFacts over featureShots with the placement it then stamps.
    const pool = createProviderPlan("final", 5, undefined, profile).pool, casting = castingSnapshot(one.projectId, 0, [], 0);
    const quoted = (shots: typeof placed) => readThroughFacts(TALK, talk, {format: "feature", tone: ""}, shots, pool, {casting}).estimate.finalVideoUsd;
    const shots = featureShots(talk, undefined, false, "speaker");
    expect(facts.shots).toBe(shots.length);
    expect(facts.estimate.finalVideoUsd).toBe(quoted(shots)!);
    await one.plan("feature");
    expect(one.stored().sequences!.dialoguePlacement).toBe("speaker");
    // The placement moves the quote. Every line on the first shot was quoted as four 5 s clips ($1.40: that
    // shot's lines run past the longest clip, so it was priced as planned); one line a shot paces each to its line.
    expect([quoted(featureShots(talk)), facts.estimate.finalVideoUsd]).toEqual([1.4, 2.8]);
  });
});
