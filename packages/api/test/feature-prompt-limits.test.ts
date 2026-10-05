/**
 * HV-019-19 — every shot of the Release 3 feature fits its provider's prompt limit before anything is paid.
 *
 * Release 3's live run (G23, `live-film-referenced`) rendered sequence 1's storyboard and 8 of 21 finals of
 * "The Tide Clock", then fal refused a final at result time: `422 string_too_long ... "String should have at
 * most 2500 characters"`. Four $0 rehearsals on the mock never saw it: the mock took any length.
 *
 * This is the rehearsal's own setup in one process (as mock-profile-locks.test.ts runs it): the feature,
 * `studio-run.ts --format feature --lock WREN,OSWIN --continuity-repair`'s desk steps, the look approved.
 * Then all 202 shots are planned as the worker plans each sequence, against the live profile's pools and the
 * mock's, and every final's prompt goes through the real fal adapter with a recording transport.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApiServer } from "../src/server";
import { ProjectService } from "../src/index";
import { DurableJobStore, TIERS, type Job } from "../../queue/src/index";
import { processNextJob } from "../../queue/src/worker";
import { CostLedger, OperatorReviewQueue } from "../../operator/src/index";
import { CrewLedger } from "../../operator/src/crew-ledger";
import { ReferenceBlobStore } from "../../storage/src/references";
import { createProviderPlan } from "../../generator/src/catalog";
import { FAL_KLING_MAX_PROMPT_CHARS, FalVideoProvider, falReferenceNote } from "../../generator/src/fal";
import { parseFountain } from "../../parser/src/index";
import { directCast } from "../../planner/src/casting";
import { directShots } from "../../planner/src/direction";
import { filmPlan, type SequenceRef } from "../../planner/src/sequences";
import { bibleShots } from "../../planner/src/style-bible";
import { poolReferenceBudget } from "../../planner/src/reference-budget";
import { poolPromptLimits } from "../../planner/src/prompt-fit";
import { renderShots } from "../../planner/src/shot-reuse";
import type { Shot } from "../../planner/src/index";
// @ts-expect-error -- the studio is a plain browser module with no type declarations.
import { createStudioFlow } from "../../frontend/src/studio.js";
import { deskBeforeLook } from "../../../scripts/release-3-desk";
import { stagingProfile } from "../../../test/fixtures/staging-profiles";

const SCRIPT = readFileSync(resolve(import.meta.dir, "../../../docs/evidence/release-3/scripts/feature.fountain"), "utf8");
const LIVE = stagingProfile("live-film-referenced"), MOCK = stagingProfile("mock");
const root = mkdtempSync(join(tmpdir(), "hv-feature-prompt-limits-"));
const config: Record<string, string | undefined> = {...MOCK, HV_PROVIDER_POOL: undefined, HV_ANIMATIC_PROVIDER_POOL: undefined, HV_CHARACTER_SHEET_PROVIDER_POOL: undefined,
  HV_ROUTING_STRATEGY: undefined, HV_TOKEN_SECRET: "feature-prompt-limits-fixture-secret-at-least-thirty-two", HV_NARRATION: "0", HV_ANIMATIC_CAPTIONS: "0"};
const original = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
const paths = {queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json"), artifactRoot: join(root, "artifacts"), costLedgerPath: join(root, "ledger.json")};
let server: ReturnType<typeof createApiServer> | undefined, running = true, loop: Promise<void> | undefined;
const workerErrors: unknown[] = [];

beforeAll(() => {
  for (const [key, value] of Object.entries(config)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  server = createApiServer({port: 0, hostname: "127.0.0.1", ...paths, rateLimit: {api: {limit: 100000, windowMs: 60000}, projectCreate: {limit: 10000, windowMs: 3600000}},
    crewLedger: new CrewLedger(), crewModel: null});
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

async function api(path: string, init: RequestInit = {}) {
  const base = server!.url.origin, response = await fetch(base + path, {...init, headers: {origin: base, ...(init.headers as Record<string, string> | undefined)}});
  const text = await response.text(), body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(path.replace(/[0-9a-f-]{36}/g, ":id") + " -> " + response.status + " " + (body.error ?? text.slice(0, 200)));
  return body;
}
/** The header bytes the fal adapter checks a reference image for: a PNG signature and a 64x64 IHDR. */
const png = "data:image/png;base64," + Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13]), Buffer.from("IHDR"),
  Buffer.from([0, 0, 0, 64, 0, 0, 0, 64, 8, 6, 0, 0, 0, 0, 0, 0, 0])]).toString("base64");

/**
 * The rehearsal's feature with WREN and OSWIN locked and the continuity repair applied, planned whole: every
 * final prompt is over 2,500 somewhere before this change, and after it every final the fal adapter is handed
 * is within Kling's limit, its reference note counted; the stills are unchanged; every shot already within its
 * limit is planned exactly as before; and the mock rehearsal's plan is fitted too.
 */
test("all 202 shots of The Tide Clock fit their providers' prompt limits on the live profile, and on the mock rehearsal", async () => {
  let project: {projectId: string; token: string} | undefined;
  const flow = createStudioFlow({api, getProject: () => project, setProject: (value: typeof project) => { project = value; }, wait: () => Bun.sleep(25)});
  const pitched = await flow.pitch({script: SCRIPT, format: "feature", tone: "warm and hopeful", rightsAttested: true});
  const planned = await flow.plan(pitched.readThrough.questions.map((question: {id: string}) => ({id: question.id, accepted: true})));
  const owner = {authorization: "Bearer " + project!.token};
  const desk = await deskBeforeLook({projectId: project!.projectId, state: flow.state, locks: ["WREN", "OSWIN"], continuity: true, poll: {intervalMs: 20, limitMs: 10 * 60 * 1000},
    call: (path, init = {}) => api(path, {method: init.method ?? "GET", headers: {...owner, ...(init.body === undefined ? {} : {"content-type": "application/json"})},
      ...(init.body === undefined ? {} : {body: JSON.stringify(init.body)})})});
  if (desk.castApproved) flow.state.pendingCast = [];
  expect(desk.locks.map(lock => [lock.name, lock.assets])).toEqual([["WREN", 4], ["OSWIN", 4]]);
  const rough = await flow.approveLook(true);
  const roughJob = (await new DurableJobStore(paths.queuePath).get(rough.animatic.id))! as Job;
  expect([roughJob.status, roughJob.costUsd]).toEqual(["done", 0]);

  // Every sequence of the plan, as the job for it would carry it.
  const sequences = (planned.plan.sequences.sequences as {firstScene: number; lastScene: number}[]).map((sequence, index, all): SequenceRef =>
    ({...roughJob.sequence!, number: index + 1, of: all.length, firstScene: sequence.firstScene, lastScene: sequence.lastScene}));
  const plan = (stage: "animatic" | "final", env: Record<string, string | undefined>) => {
    const providerPlan = createProviderPlan(stage, 5, undefined, env);
    return sequences.flatMap(sequence => renderShots({...roughJob, stage, sequence, providerPlan}));
  };
  const live = {final: plan("final", LIVE), stills: plan("animatic", LIVE)}, mock = plan("final", MOCK);
  expect([live.final.length, live.stills.length, mock.length]).toEqual([202, 202, 202]);

  // Before this change: the same chain with no fit. Some prompts are over 2,500 on their own, more once the
  // reference note O3 appends is counted.
  const parsed = parseFountain(roughJob.scriptText);
  const unfitted = (budget: number | null): Shot[] => bibleShots(directShots(directCast(filmPlan(parsed, roughJob.direction, TIERS[roughJob.tier].maxShots, roughJob.sequence),
    parsed, roughJob.casting!, Date.now(), roughJob.direction, budget), roughJob.direction!), parsed, roughJob.styleBible);
  const finalPool = createProviderPlan("final", 5, undefined, LIVE).pool, raw = unfitted(poolReferenceBudget(finalPool));
  expect(raw.map(shot => shot.id)).toEqual(live.final.map(shot => shot.id));
  const sent = (shot: Shot) => shot.prompt.length + falReferenceNote(shot.referenceAssets?.length ?? 0).length;
  expect(raw.filter(shot => shot.prompt.length > FAL_KLING_MAX_PROMPT_CHARS).length).toBeGreaterThanOrEqual(1);
  expect(raw.filter(shot => sent(shot) > FAL_KLING_MAX_PROMPT_CHARS).length).toBeGreaterThan(raw.filter(shot => shot.prompt.length > FAL_KLING_MAX_PROMPT_CHARS).length);

  // After: every final is within its limit, and a shot already within it is exactly as it was, with no record.
  const limits = poolPromptLimits("final", finalPool)!;
  let fitted = 0;
  for (const [index, shot] of live.final.entries()) {
    const before = raw[index]!, limit = limits[shot.referenceAssets?.length ?? 0]!;
    expect(shot.referenceAssets?.length ?? 0).toBe(before.referenceAssets?.length ?? 0);
    expect(shot.prompt.length).toBeLessThanOrEqual(limit);
    if (before.prompt.length <= limit) { expect([shot.prompt, "promptFit" in shot]).toEqual([before.prompt, false]); continue; }
    fitted += 1;
    expect(shot.promptFit).toMatchObject({schema: "hv-prompt-fit/1", limit, originalChars: before.prompt.length, fittedChars: shot.prompt.length});
    // The locked characters' cast direction is never what was cut.
    for (const name of ["WREN", "OSWIN"]) {
      const at = before.prompt.indexOf("\n" + name + ". ");
      if (at >= 0) expect(shot.prompt).toContain(before.prompt.slice(at, before.prompt.indexOf("\n", at + 1)));
    }
  }
  expect(fitted).toBeGreaterThanOrEqual(1);

  // The real fal adapter, each final on the model the router gives it (images: O3 reference; none: Kling 2.5),
  // with a transport that records each submit and answers nothing: no shot is refused, every prompt fal receives is within 2,500.
  const bodies: {model: string; prompt: string}[] = [];
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    bodies.push({model: new URL(String(input)).pathname.slice(1), prompt: String(JSON.parse(String(init.body)).prompt)});
    return new Response("recorded by the test", {status: 500});
  }) as unknown as typeof fetch;
  const adapters = {o3: new FalVideoProvider({apiKey: "feature-prompt-limit-fixture", model: "kling-o3-standard-reference", fetchImpl}),
    kling: new FalVideoProvider({apiKey: "feature-prompt-limit-fixture", model: "kling-v2.5-turbo-pro", fetchImpl})};
  for (const shot of live.final) {
    const references = Array.from({length: shot.referenceAssets?.length ?? 0}, () => png);
    await expect((references.length ? adapters.o3 : adapters.kling).generate(shot.prompt, shot.seed, {seed: shot.seed, durationSec: 5, widthxheight: "1280x720", referenceFrames: references},
      join(root, "clip.mp4"))).rejects.toThrow("(500)");
  }
  expect(bodies.length).toBe(202);
  expect(Math.max(...bodies.map(body => body.prompt.length))).toBeLessThanOrEqual(FAL_KLING_MAX_PROMPT_CHARS);

  // The stills (FLUX, no declared limit) are planned exactly as before, whatever their length.
  const rawStills = unfitted(poolReferenceBudget(createProviderPlan("animatic", 5, undefined, LIVE).pool));
  expect(live.stills.map(shot => shot.prompt)).toEqual(rawStills.map(shot => shot.prompt));
  expect(live.stills.some(shot => "promptFit" in shot)).toBe(false);

  // The mock rehearsal's finals are fitted to what the live models take, so a $0 rehearsal plans the same cuts or stricter.
  const mockLimits = poolPromptLimits("final", createProviderPlan("final", 5, undefined, MOCK).pool)!;
  expect(mock.every(shot => shot.prompt.length <= mockLimits[shot.referenceAssets?.length ?? 0]!)).toBe(true);
  expect(mock.filter(shot => shot.promptFit).length).toBeGreaterThanOrEqual(fitted);
  expect(workerErrors).toEqual([]);
}, 600000);
