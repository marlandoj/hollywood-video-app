/**
 * HV-030-28 — a feature is held to its own film limit (G20-202610031349).
 *
 * The program has one per-film limit, `HV_FILM_SPEND_CAP_USD` ($40), checked on what a film has spent
 * plus what it holds (HV-019-04, HV-019-06). A 15-20 minute feature is one project of 200-240 shots:
 * about $84-101 of video on the anchored profile, plus about $30 held while its last 24-shot sequence
 * renders. Kevin decided at G20 that a feature gets its own limit of $150 while reels and shorts stay
 * at $40, and that the $500 program cap and the $450 alert don't change.
 *
 * The film's format is the one the creator planned it as at the crew's plan step. It is kept on the
 * project, and every admission asks the limit for that project. These tests drive the real routes:
 * the plan step stores the format, `GET /spend` reports the limit, and a paid render is admitted or
 * refused against it. A storyboard render on FLUX Schnell holds $0.02 (two stills, three attempts),
 * so with the limits scaled down to cents the arithmetic is the same as at $40 and $150.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrewLedger } from "../../operator/src/crew-ledger";
import { createApiServer } from "../src/server";
import { ProjectService } from "../src/index";
import { CAST_INPUT } from "../../../test/fixtures/casting";

const SCRIPT = "INT. ROOM - DAY\n\nMarla stares at the lamp.\n\nEXT. GARDEN - DAY\n\nMarla walks away.";
const KEYS = ["HV_TOKEN_SECRET", "HV_ANIMATIC_PROVIDER_POOL", "HV_FILM_SPEND_CAP_USD", "HV_FEATURE_FILM_SPEND_CAP_USD", "HV_ANIMATIC_COST_CAP_USD", "HV_NARRATION", "HV_ANIMATIC_CAPTIONS", "HV_MONTHLY_BUDGET_USD"];
const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
const roots: string[] = [];
type Server = ReturnType<typeof createApiServer>;

function start(env: Record<string, string>): Server {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, {HV_TOKEN_SECRET: "feature-limit-fixture-secret-at-least-thirty-two", HV_ANIMATIC_PROVIDER_POOL: '["image:fal:flux-schnell"]',
    HV_ANIMATIC_COST_CAP_USD: "5", HV_NARRATION: "0", HV_ANIMATIC_CAPTIONS: "0", ...env});
  const root = mkdtempSync(join(tmpdir(), "hv-feature-limit-"));
  roots.push(root);
  return createApiServer({port: 0, hostname: "127.0.0.1", queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json"), artifactRoot: join(root, "artifacts"),
    costLedgerPath: join(root, "ledger.json"), rateLimit: {api: {limit: 10000, windowMs: 60000}, projectCreate: {limit: 10000, windowMs: 3600000}},
    crewLedger: new CrewLedger(), crewModel: null});
}

let defaults: Server, scaled: Server;
beforeAll(() => {
  // The limits as shipped: $40 for a film, $150 for a feature, under the staging host's $500 month.
  defaults = start({HV_MONTHLY_BUDGET_USD: "500"});
  // The same rule in cents: a film may hold one $0.02 render, a feature two.
  scaled = start({HV_FILM_SPEND_CAP_USD: "0.03", HV_FEATURE_FILM_SPEND_CAP_USD: "0.05"});
});
afterAll(async () => {
  await defaults.stop(true); await scaled.stop(true);
  for (const root of roots) rmSync(root, {recursive: true, force: true});
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

const call = (server: Server, path: string, method = "GET", body?: unknown, token?: string) => fetch(new URL(path, server.url), {method,
  headers: {"content-type": "application/json", ...(token ? {authorization: "Bearer " + token} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});

async function film(server: Server) {
  const owner = await (await call(server, "/api/projects", "POST")).json() as {projectId: string; token: string};
  const base = "/api/projects/" + owner.projectId;
  await call(server, base + "/script", "PUT", {text: SCRIPT}, owner.token);
  await call(server, base + "/rights", "POST", {attested: true}, owner.token);
  expect((await call(server, base + "/cast/" + crypto.randomUUID(), "PUT", {character: {...CAST_INPUT, name: "Marla", aliases: []}, expectedVersion: 0}, owner.token)).status).toBe(200);
  let versions = {scriptVersion: 1, castingVersion: 1, directionVersion: 0};
  /** The crew's plan step, which names the film's format. */
  const plan = async (format: string) => {
    const response = await call(server, base + "/crew/plan", "POST", {format, tone: "", answers: [], expected: versions}, owner.token);
    const body = await response.json() as {castingVersion: number; directionVersion: number; error?: string};
    if (response.status === 200) versions = {scriptVersion: 1, castingVersion: body.castingVersion, directionVersion: body.directionVersion};
    return {status: response.status, body};
  };
  const spend = async () => await (await call(server, base + "/spend", "GET", undefined, owner.token)).json() as {spentUsd: number; heldUsd: number; capUsd: number};
  // HV-030-29: a feature the Showrunner split renders one sequence at a time, named by its number.
  const render = async (extra: Record<string, unknown> = {}) => (await call(server, base + "/jobs", "POST", {idempotencyKey: crypto.randomUUID(), ...extra}, owner.token)).status;
  return {...owner, base, plan, spend, render};
}

describe("each film's limit, as shipped", () => {
  test("a reel and a short are held to $40, a feature to $150, and a film never planned to $40", async () => {
    const never = await film(defaults), reel = await film(defaults), short = await film(defaults), feature = await film(defaults);
    expect((await reel.plan("reel")).status).toBe(200);
    expect((await short.plan("short")).status).toBe(200);
    expect((await feature.plan("feature")).status).toBe(200);
    expect((await never.spend()).capUsd).toBe(40);
    expect((await reel.spend()).capUsd).toBe(40);
    expect((await short.spend()).capUsd).toBe(40);
    expect((await feature.spend()).capUsd).toBe(150);
  });

  test("the plan step still refuses a format the studio does not make, and the limit is unchanged", async () => {
    const one = await film(defaults);
    for (const format of ["film", "Feature", "", "feature "]) expect((await one.plan(format)).status).toBe(400);
    expect((await one.spend()).capUsd).toBe(40);
  });
});

describe("admissions ask each film's own limit", () => {
  test("a reel is refused its second render; a feature is admitted it and refused its third", async () => {
    const reel = await film(scaled), feature = await film(scaled);
    expect((await reel.plan("reel")).status).toBe(200);
    expect((await feature.plan("feature")).status).toBe(200);
    expect(await reel.render()).toBe(202);
    expect(await reel.render()).toBe(429);
    expect(await reel.spend()).toEqual({spentUsd: 0, heldUsd: 0.02, capUsd: 0.03});
    expect(await feature.render({sequence: 1})).toBe(202);
    expect(await feature.render({sequence: 1})).toBe(202);
    expect(await feature.render({sequence: 1})).toBe(429);
    expect(await feature.spend()).toMatchObject({spentUsd: 0, heldUsd: 0.04, capUsd: 0.05});
  });

  test("a feature planned again as a short drops back to the film's limit, and is refused there", async () => {
    const one = await film(scaled);
    expect((await one.plan("feature")).status).toBe(200);
    expect(await one.render({sequence: 1})).toBe(202);
    expect(await one.render({sequence: 1})).toBe(202);
    expect((await one.plan("short")).status).toBe(200);
    expect(await one.spend()).toEqual({spentUsd: 0, heldUsd: 0.04, capUsd: 0.03});
    expect(await one.render()).toBe(429);
  });
});

describe("the format is kept on the project", () => {
  test("a project's snapshot carries its format only once a plan named one, and reads it back", () => {
    const service = new ProjectService(), {token, projectId} = service.createAnonymousProject();
    service.editScript(token, "INT. ROOM - DAY\n\nA lamp.");
    expect(service.snapshot().projects[0]).not.toHaveProperty("format");
    service.applyCrewChanges(token, {characters: [], directions: [], format: "feature"}, {scriptVersion: 1, castingVersion: 0, directionVersion: 0});
    const state = service.snapshot();
    expect(state.projects[0]!.format).toBe("feature");
    expect(ProjectService.fromState(state).peekProject(projectId)!.format).toBe("feature");
  });

  test("a stored format the studio has no limit for is refused, not read as a reel", () => {
    const service = new ProjectService(), {token} = service.createAnonymousProject();
    service.editScript(token, "INT. ROOM - DAY\n\nA lamp.");
    const state = service.snapshot();
    for (const format of ["film", "FEATURE", 1200, null]) {
      const bad = structuredClone(state); (bad.projects[0] as {format?: unknown}).format = format;
      expect(() => ProjectService.fromState(bad)).toThrow("not a reel, a short or a feature");
    }
    expect(() => service.applyCrewChanges(token, {characters: [], directions: [], format: "film" as never}, {scriptVersion: 1, castingVersion: 0, directionVersion: 0})).toThrow("not a reel, a short or a feature");
    expect(service.snapshot().projects[0]).not.toHaveProperty("format");
  });
});
