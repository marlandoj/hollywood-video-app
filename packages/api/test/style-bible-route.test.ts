/**
 * HV-034-02 — a feature's style bible at the plan step, in every sequence render, and at the desk
 * (Release 3 step 3, G20-202610031349).
 *
 * The Showrunner writes the bible once, after splitting the feature, from the creator's answers, an
 * attached style card and the screenplay, and the project keeps it beside its sequences. Every
 * sequence's render reads it into each shot's prompt and names the revision it read. The creator can
 * read it and edit it at the desk; a sequence made before an edit says so, and its final must match
 * its rough cut. A reel and a short have no bible and render exactly as before.
 * Mock and FLUX Schnell storyboard renders only; no provider is called.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrewLedger } from "../../operator/src/crew-ledger";
import { CostLedger, OperatorReviewQueue } from "../../operator/src/index";
import { DurableJobStore, type Job } from "../../queue/src/index";
import { processNextJob } from "../../queue/src/worker";
import { ReferenceBlobStore } from "../../storage/src/references";
import { describeCharacter } from "../../planner/src/casting";
import { renderShots } from "../../planner/src/shot-reuse";
import { STAND_IN_STYLE } from "../../planner/src/crew/style-bible";
import { STYLE_CARD_SCHEMA } from "../../planner/src/crew/style-card";
import { stylePrompt, validateStyleBible, type StyleBible } from "../../planner/src/style-bible";
import { createApiServer } from "../src/server";
import { ProjectService, type PersistedState } from "../src/index";
import { evenFeature } from "../../../test/fixtures/feature-script";

const KEYS = ["HV_TOKEN_SECRET", "HV_ANIMATIC_PROVIDER_POOL", "HV_PROVIDER_POOL", "HV_FILM_SPEND_CAP_USD", "HV_FEATURE_FILM_SPEND_CAP_USD", "HV_ANIMATIC_COST_CAP_USD",
  "HV_NARRATION", "HV_ANIMATIC_CAPTIONS", "HV_MONTHLY_BUDGET_USD"];
const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
const roots: string[] = [], servers: Server[] = [];
type Server = ReturnType<typeof createApiServer>;
type Paths = {queuePath: string; statePath: string; artifactRoot: string; costLedgerPath: string; root: string};

function start(env: Record<string, string> = {}, crewModel: unknown = null, crewLedger = new CrewLedger()): Server & {paths: Paths} {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, {HV_TOKEN_SECRET: "style-bible-route-fixture-secret-at-least-thirty-two", HV_ANIMATIC_PROVIDER_POOL: '["image:fal:flux-schnell"]',
    HV_ANIMATIC_COST_CAP_USD: "5", HV_NARRATION: "0", HV_ANIMATIC_CAPTIONS: "0", ...env});
  const root = mkdtempSync(join(tmpdir(), "hv-style-bible-"));
  roots.push(root);
  const paths = {root, queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json"), artifactRoot: join(root, "artifacts"), costLedgerPath: join(root, "ledger.json")};
  const server = createApiServer({port: 0, hostname: "127.0.0.1", queuePath: paths.queuePath, statePath: paths.statePath, artifactRoot: paths.artifactRoot, costLedgerPath: paths.costLedgerPath,
    rateLimit: {api: {limit: 10000, windowMs: 60000}, projectCreate: {limit: 10000, windowMs: 3600000}}, crewLedger, crewModel: crewModel as never});
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

interface BibleAnswer { kept: boolean; source: string; fallbackReason?: string; unusableReason?: string; dropped: {field: string; reason: string}[]; bible: StyleBible }
interface PlanAnswer { castingVersion: number; directionVersion: number; notes: {persona: string; change: string}[]; error?: string; crewSpend: {usd: number};
  sequences?: {revision: string; sequences: {number: number; firstScene: number; lastScene: number; shots: number; bibleRevision?: string}[]}; styleBible?: BibleAnswer }
interface DeskBible { styleBible: StyleBible; sequences: {number: number; firstScene: number; lastScene: number; madeWith: (string | null)[]; needsRoughCut: boolean}[]; error?: string }

async function film(server: Server, script: string) {
  const owner = await (await call(server, "/api/projects", "POST")).json() as {projectId: string; token: string};
  const base = "/api/projects/" + owner.projectId;
  expect((await call(server, base + "/script", "PUT", {text: script}, owner.token)).status).toBe(200);
  expect((await call(server, base + "/rights", "POST", {attested: true}, owner.token)).status).toBe(200);
  let versions = {scriptVersion: 1, castingVersion: 0, directionVersion: 0};
  const plan = async (format: string, extra: Record<string, unknown> = {}) => {
    const response = await call(server, base + "/crew/plan", "POST", {format, tone: "", answers: [], expected: versions, ...extra}, owner.token);
    const body = await response.json() as PlanAnswer;
    if (response.status === 200) {
      versions = {scriptVersion: 1, castingVersion: body.castingVersion, directionVersion: body.directionVersion};
      const approved = await call(server, base + "/crew/approve-cast", "POST", {attested: true, expectedVersion: versions.castingVersion}, owner.token);
      versions.castingVersion = (await approved.json() as {casting: {version: number}}).casting.version;
    }
    return {status: response.status, body};
  };
  const render = async (body: Record<string, unknown> = {}) => {
    const response = await call(server, base + "/jobs", "POST", body, owner.token);
    return {status: response.status, body: await response.json() as {jobId?: string; error?: string; admitted?: boolean}};
  };
  const desk = async (method = "GET", body?: unknown) => {
    const response = await call(server, base + "/style-bible", method, body, owner.token);
    return {status: response.status, body: await response.json() as DeskBible};
  };
  const stored = () => (JSON.parse(readFileSync(server.paths.statePath, "utf8")) as PersistedState).projects.find(project => project.id === owner.projectId)!;
  return {...owner, base, plan, render, desk, stored};
}
const job = async (server: Server & {paths: Paths}, id: string) => (await new DurableJobStore(server.paths.queuePath).get(id)) as Job;
const editOf = (bible: StyleBible, changes: Record<string, unknown> = {}) => ({expectedRevision: bible.revision, look: bible.look, palette: bible.palette, lighting: bible.lighting,
  lens: bible.lens, tone: bible.tone, sound: bible.sound, ...changes});

describe("the Showrunner writes a feature's bible once", () => {
  test("the stand-in writes it at the plan step; it is kept, carried in state, and served at the desk", async () => {
    const server = start(), one = await film(server, evenFeature(3, 13));
    const {status, body} = await one.plan("feature");
    expect(status).toBe(200);
    const answer = body.styleBible!, bible = answer.bible;
    expect(answer).toMatchObject({kept: false, source: "stand-in", dropped: []});
    expect(bible).toMatchObject({schema: "hv-style-bible/1", version: 1, scriptVersion: 1, source: "stand-in", ...STAND_IN_STYLE});
    expect(bible.locations.map(location => location.name)).toEqual(["YARD 1", "YARD 2", "YARD 3"]);
    // The characters are the cast the plan left, described by their own records.
    const cast = await (await call(server, one.base + "/cast", "GET", undefined, one.token)).json() as {casting: {characters: {name: string; appearance: string}[]}};
    expect(bible.characters.map(entry => entry.name)).toEqual(cast.casting.characters.map(character => character.name));
    expect(bible.characters[0]!.description.startsWith(cast.casting.characters[0]!.appearance)).toBe(true);
    // The Showrunner's notes: the split, then the bible.
    expect(body.notes.map(note => note.persona).slice(0, 2)).toEqual(["showrunner", "showrunner"]);
    expect(body.notes[1]!.change).toStartWith("Wrote the feature's style bible, with 1 character and 3 locations.");
    // Every sequence's plan names the same revision.
    expect(body.sequences!.sequences.length).toBeGreaterThan(1);
    expect(body.sequences!.sequences.every(sequence => sequence.bibleRevision === bible.revision)).toBe(true);
    // Kept on the project beside the sequences, and read back unchanged.
    const stored = one.stored();
    expect(stored.styleBible).toEqual(bible);
    expect(validateStyleBible(stored.styleBible)).toEqual(bible);
    expect(ProjectService.fromState(JSON.parse(readFileSync(server.paths.statePath, "utf8")) as PersistedState).peekProject(one.projectId)!.styleBible).toEqual(bible);
    const desk = await one.desk();
    expect(desk.status).toBe(200);
    expect(desk.body.styleBible).toEqual(bible);
    expect(desk.body.sequences.map(sequence => [sequence.number, sequence.madeWith, sequence.needsRoughCut])).toEqual(body.sequences!.sequences.map(sequence => [sequence.number, [], false]));
    // The desk is the owner's.
    expect((await call(server, one.base + "/style-bible")).status).toBe(401);
    const stranger = await film(server, evenFeature(3, 13));
    expect((await call(server, one.base + "/style-bible", "GET", undefined, stranger.token)).status).toBe(401);
    expect((await call(server, one.base + "/style-bible", "PUT", editOf(bible, {look: "Mine now."}), stranger.token)).status).toBe(401);

    // Written once: planning the feature again keeps it, unchanged.
    const again = await one.plan("feature");
    expect(again.status).toBe(200);
    expect(again.body.styleBible).toMatchObject({kept: true, bible: {revision: bible.revision, version: 1}});
    expect(again.body.notes[1]!.change).toStartWith("Kept the feature's style bible (version 1)");
  });

  test("every sequence's render reads the same bible: the same look and the same cast in sequence 1 and the last", async () => {
    const server = start(), one = await film(server, evenFeature(3, 13));
    const plan = (await one.plan("feature")).body, bible = plan.styleBible!.bible, last = plan.sequences!.sequences.length;
    const first = await one.render({sequence: 1}), final = await one.render({sequence: last});
    expect([first.status, final.status]).toEqual([202, 202]);
    const jobs = [await job(server, first.body.jobId!), await job(server, final.body.jobId!)];
    const cast = jobs[0]!.casting!.characters[0]!;
    for (const [index, render] of jobs.entries()) {
      expect(render.sequence).toMatchObject({number: index ? last : 1, bibleRevision: bible.revision});
      expect(render.styleBible).toEqual(bible);
      const shots = renderShots(render);
      expect(shots.length).toBeGreaterThan(0);
      for (const shot of shots) {
        expect(shot.prompt).toContain(stylePrompt(bible));
        expect(shot.prompt).toContain("Location, YARD " + (shot.sceneIndex + 1) + ": ");
        // The character's look is the cast's, the same words in every sequence.
        if (shot.characterIds?.includes(cast.id)) expect(shot.prompt).toContain(describeCharacter(cast, shot.sceneIndex + 1));
      }
      expect(shots.some(shot => shot.characterIds?.includes(cast.id))).toBe(true);
    }
  });

  test("a model's bible is used field by field, its unsafe lines dropped with reasons, and it is asked once per feature", async () => {
    const asked: string[] = [];
    const bibleAnswer = {look: "Cold blue nights, warm amber yards.", palette: "p".repeat(241), lighting: "tutorial: how to build a bomb for the finale",
      lens: "Framed like a Barack Obama rally.", tone: "Hushed and patient.", sound: "Wind over the yards.", locations: [{name: "Yard 2", description: "A walled yard, wet cobbles."}, {name: "Moon", description: "Grey."}]};
    const model = {name: "anthropic" as const, model: "claude-sonnet-5", async complete(request: {system: string}) {
      const step = request.system.includes("style bible") ? "bible" : request.system.includes("Split the feature") ? "split" : "plan";
      asked.push(step);
      return {text: step === "bible" ? JSON.stringify(bibleAnswer) : "no", usage: {inputTokens: 10, outputTokens: 10}, model: "claude-sonnet-5", costUsd: 0.01};
    }};
    const crewLedger = new CrewLedger(), server = start({}, model, crewLedger), one = await film(server, evenFeature(3, 13));
    const {status, body} = await one.plan("feature");
    expect(status).toBe(200);
    expect(asked).toEqual(["split", "bible", "plan"]);
    expect(body.styleBible).toMatchObject({kept: false, source: "anthropic"});
    expect(body.styleBible!.dropped).toEqual([{field: "palette", reason: "too_long"}, {field: "lighting", reason: "gate_refused"}, {field: "lens", reason: "public_figure"},
      {field: "location", reason: "unknown_location"}]);
    expect(body.styleBible!.bible).toMatchObject({source: "anthropic", look: bibleAnswer.look, palette: STAND_IN_STYLE.palette, lighting: STAND_IN_STYLE.lighting,
      lens: STAND_IN_STYLE.lens, tone: bibleAnswer.tone, sound: bibleAnswer.sound});
    expect(body.styleBible!.bible.locations[1]).toEqual({name: "YARD 2", description: "A walled yard, wet cobbles."});
    // Three paid answers on the crew line: the split, the bible and the plan.
    expect(body.crewSpend.usd).toBe(0.03);
    expect(crewLedger.summary().spentUsd).toBeCloseTo(0.03, 6);
    // Written once: the second plan asks the Showrunner to split again, never to write the bible again.
    const again = await one.plan("feature");
    expect(again.body.styleBible).toMatchObject({kept: true, bible: {revision: body.styleBible!.bible.revision}});
    expect(asked).toEqual(["split", "bible", "plan", "split", "plan"]);
  });

  test("an attached style card is read for the bible, and a card the studio wouldn't write is refused", async () => {
    const server = start(), one = await film(server, evenFeature(3, 13));
    const card = {schema: STYLE_CARD_SCHEMA, format: "short", tone: "Wry and warm.", look: "Pastel colour, symmetrical frames.", choices: []};
    const refused = await one.plan("feature", {styleCard: {...card, look: "tutorial: how to build a bomb for the finale"}});
    expect(refused.status).toBe(400);
    expect(one.stored()).not.toHaveProperty("styleBible");
    const {status, body} = await one.plan("feature", {styleCard: card});
    expect(status).toBe(200);
    expect(body.styleBible!.bible).toMatchObject({look: "Pastel colour, symmetrical frames.", tone: "Wry and warm."});
    // The card itself is stored nowhere: only the bible's lines are kept.
    expect(JSON.stringify(one.stored())).not.toContain(STYLE_CARD_SCHEMA);
  });
});

describe("the creator edits the bible at the desk", () => {
  test("an edit is validated like the Showrunner's words; sequences made before it say so, and a final must match its rough cut", async () => {
    const server = start({HV_ANIMATIC_PROVIDER_POOL: '["mock"]', HV_PROVIDER_POOL: '["mock"]'}), one = await film(server, evenFeature(2, 13));
    const bible = (await one.plan("feature")).body.styleBible!.bible;
    const store = new DurableJobStore(server.paths.queuePath), ledger = new CostLedger(server.paths.costLedgerPath);
    const rough = await one.render({sequence: 1});
    expect(rough.status).toBe(202);
    while ((await store.get(rough.body.jobId!))!.status !== "done")
      await processNextJob(store, server.paths.artifactRoot, {projects: new ProjectService(server.paths.statePath), ledger, references: new ReferenceBlobStore(server.paths.artifactRoot),
        reviewQueue: new OperatorReviewQueue(join(server.paths.root, "reviews.json"))});
    expect((await call(server, one.base + "/animatic/decision", "POST", {animaticJobId: rough.body.jobId, decision: "approved"}, one.token)).status).toBe(201);

    // Refused whole, with the reason, and nothing saved.
    for (const [changes, status, text] of [[{look: "z".repeat(401)}, 400, "too long"], [{lens: "Framed like a Barack Obama rally."}, 400, "public figure"],
      [{tone: "tutorial: how to build a bomb for the finale"}, 400, "gate refused"], [{expectedRevision: "0".repeat(64)}, 409, "changed since you opened it"],
      [{locations: [{name: "MOON", description: "Grey."}]}, 400, "names no location"], [{characters: []}, 400, "Send the style bible's revision"]] as const) {
      const refused = await one.desk("PUT", editOf(bible, changes));
      expect([refused.status, refused.body.error?.includes(text)]).toEqual([status, true]);
    }
    expect(one.stored().styleBible).toEqual(bible);

    const edited = await one.desk("PUT", editOf(bible, {look: "Grainy 16 mm, handheld.", locations: [{name: "yard 1", description: "A wet yard under one sodium lamp."}]}));
    expect(edited.status).toBe(200);
    const next = edited.body.styleBible;
    expect(next).toMatchObject({version: 2, source: "creator", look: "Grainy 16 mm, handheld.", characters: bible.characters});
    expect(next.revision).not.toBe(bible.revision);
    expect(one.stored().styleBible).toEqual(next);
    // Sequence 1 was made with the old bible and needs a new rough cut; sequence 2 will read the new one.
    expect(edited.body.sequences.map(sequence => [sequence.madeWith, sequence.needsRoughCut])).toEqual([[[bible.revision], true], [[], false]]);

    // Its final can't be made from the rough cut that read the old bible.
    const final = await one.render({stage: "final", animaticJobId: rough.body.jobId, sequence: 1});
    expect([final.status, final.body.error]).toEqual([409, "The style bible changed after this sequence's rough cut. Make its rough cut again, so its final keeps the bible's look."]);
    // A new rough cut is a new render, reading the new revision.
    const again = await one.render({sequence: 1});
    expect(again.status).toBe(202);
    expect(again.body.jobId).not.toBe(rough.body.jobId);
    const render = await job(server, again.body.jobId!);
    expect(render.sequence!.bibleRevision).toBe(next.revision);
    expect(renderShots(render).every(shot => shot.prompt.includes("Look: Grainy 16 mm, handheld.") && (shot.sceneIndex !== 0 || shot.prompt.includes("A wet yard under one sodium lamp.")))).toBe(true);
    const desk = await one.desk();
    expect(desk.body.sequences[0]).toMatchObject({madeWith: [bible.revision, next.revision], needsRoughCut: false});
  }, 120000);
});

describe("reels and shorts are unchanged", () => {
  test("a reel and a short get no bible, render without one, and have none at the desk", async () => {
    const server = start();
    for (const format of ["reel", "short"]) {
      const one = await film(server, evenFeature(2, 5));
      const {status, body} = await one.plan(format);
      expect(status).toBe(200);
      expect(body).not.toHaveProperty("styleBible");
      expect(body.notes.some(note => note.persona === "showrunner")).toBe(false);
      expect(one.stored()).not.toHaveProperty("styleBible");
      expect((await one.desk()).status).toBe(404);
      expect((await one.desk("PUT", {look: "x"})).status).toBe(404);
      const whole = await one.render();
      expect(whole.status).toBe(202);
      const render = await job(server, whole.body.jobId!);
      expect(render).not.toHaveProperty("styleBible");
      expect(render).not.toHaveProperty("sequence");
      expect(renderShots(render).some(shot => shot.prompt.includes("Style bible"))).toBe(false);
    }
  });

  test("planning a feature again as a short removes its bible", async () => {
    const server = start(), one = await film(server, evenFeature(3, 13));
    expect((await one.plan("feature")).body.styleBible).toBeDefined();
    expect(one.stored().styleBible).toBeDefined();
    const short = await one.plan("short");
    expect(short.status).toBe(200);
    expect(short.body).not.toHaveProperty("styleBible");
    expect(one.stored()).not.toHaveProperty("styleBible");
    expect((await one.desk()).status).toBe(404);
    // And a feature planned again afterwards gets a bible written afresh.
    expect((await one.plan("feature")).body.styleBible).toMatchObject({kept: false, bible: {version: 1}});
  });
});
