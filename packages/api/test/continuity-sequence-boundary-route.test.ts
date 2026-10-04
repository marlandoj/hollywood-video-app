/**
 * HV-021-11 — continuity across a feature's sequences, through the real routes.
 *
 * A six-scene feature is planned at the front door (the stand-in Showrunner splits it into three
 * sequences of two scenes) and its continuity is read at the Director's desk. The plan step's
 * Continuity Supervisor notes, `GET /direction`'s report, the repair review and its accept all read
 * the feature's own shots and cover each sequence boundary. Applying a repair names the sequences
 * already made under the direction it replaces, which need a new rough cut, and the next rough cut
 * of each is a new render. Mock and FLUX Schnell storyboard pools only; nothing is spent.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrewLedger } from "../../operator/src/crew-ledger";
import type { ContinuityReport } from "../../planner/src/continuity";
import type { ContinuityRemake, ContinuityRepairProposal } from "../../planner/src/continuity-repair";
import type { DirectionSnapshot } from "../../planner/src/direction";
import { createApiServer } from "../src/server";

const HEADINGS = ["INT. LIGHTHOUSE - NIGHT", "INT. LANTERN ROOM - NIGHT", "INT. STAIRWELL - CONTINUOUS", "INT. STAIRWELL - NIGHT", "INT. STAIRWELL - CONTINUOUS", "EXT. CLIFF - DAY"];
const SCRIPT = HEADINGS.map((heading, i) => heading + "\n\n" + Array.from({length: 9}, (_, b) => `Marguerite moves through scene ${i + 1}, step ${b + 1}.`).join("\n\n")).join("\n\n");
const CHARACTER = {name: "MARGUERITE", aliases: [], kind: "original-fictional", appearance: "A keeper of the light.", ageRange: "adult", ethnicity: "", body: "", hairMakeup: "", expressions: "",
  movement: "", relationships: "", arcNotes: "", prohibitedChanges: "", permission: {status: "permitted", scope: "project", sceneNumbers: [], expiresAt: null, attested: true},
  // The coat is on at the end of sequence 1 (scene 2) and off at the start of sequence 2 (scene 3), with no time cut.
  wardrobe: [{sceneNumber: null, description: "An oilskin coat"}, {sceneNumber: 3, description: "No coat, a wet jumper"}]};
const KEYS = ["HV_TOKEN_SECRET", "HV_ANIMATIC_PROVIDER_POOL", "HV_ANIMATIC_COST_CAP_USD", "HV_NARRATION", "HV_ANIMATIC_CAPTIONS"];
const saved = Object.fromEntries(KEYS.map(key => [key, process.env[key]]));
const roots: string[] = [], servers: ReturnType<typeof createApiServer>[] = [];
afterAll(async () => {
  for (const server of servers) await server.stop(true);
  for (const root of roots) rmSync(root, {recursive: true, force: true});
  for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

interface View { direction: DirectionSnapshot; scriptVersion: number; continuity: ContinuityReport }
interface Review { report: ContinuityReport; proposal: ContinuityRepairProposal; summary: string; scriptVersion: number; remake: ContinuityRemake[] }

async function feature() {
  for (const key of KEYS) delete process.env[key];
  Object.assign(process.env, {HV_TOKEN_SECRET: "sequence-boundary-route-fixture-secret-thirty-two", HV_ANIMATIC_PROVIDER_POOL: '["image:fal:flux-schnell"]',
    HV_ANIMATIC_COST_CAP_USD: "5", HV_NARRATION: "0", HV_ANIMATIC_CAPTIONS: "0"});
  const root = mkdtempSync(join(tmpdir(), "hv-sequence-boundary-"));
  roots.push(root);
  const server = createApiServer({port: 0, hostname: "127.0.0.1", queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json"), artifactRoot: join(root, "artifacts"),
    costLedgerPath: join(root, "ledger.json"), rateLimit: {api: {limit: 10000, windowMs: 60000}, projectCreate: {limit: 10000, windowMs: 3600000}}, crewLedger: new CrewLedger(), crewModel: null as never});
  servers.push(server);
  const call = (path: string, method = "GET", body?: unknown, token?: string) => fetch(new URL(path, server.url), {method,
    headers: {"content-type": "application/json", ...(token ? {authorization: "Bearer " + token} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const owner = await (await call("/api/projects", "POST")).json() as {projectId: string; token: string}, base = "/api/projects/" + owner.projectId;
  expect((await call(base + "/script", "PUT", {text: SCRIPT}, owner.token)).status).toBe(200);
  expect((await call(base + "/rights", "POST", {attested: true}, owner.token)).status).toBe(200);
  const as = <T>(response: Promise<Response>) => response.then(async value => ({status: value.status, body: await value.json() as T}));
  return {
    call, base, token: owner.token,
    plan: () => as<{notes: {persona: string; change: string; source?: string}[]; castingVersion: number; sequences: {sequences: {number: number; firstScene: number; lastScene: number}[]}}>(
      call(base + "/crew/plan", "POST", {format: "feature", tone: "", answers: [], expected: {scriptVersion: 1, castingVersion: 0, directionVersion: 0}}, owner.token)),
    view: async () => (await as<View>(call(base + "/direction", "GET", undefined, owner.token))).body,
    review: () => as<Review>(call(base + "/direction/continuity/repair", "POST", {}, owner.token)),
    accept: (body: unknown) => as<{direction: DirectionSnapshot; remake: ContinuityRemake[]; error?: string}>(call(base + "/direction/continuity/repair/accept", "POST", body, owner.token)),
    render: (sequence: number) => as<{jobId: string; admitted?: boolean; error?: string}>(call(base + "/jobs", "POST", {sequence}, owner.token)),
  };
}
const labelled = (report: ContinuityReport) => report.scenes.flatMap(scene => scene.findings.filter(finding => finding.sequenceBoundary)
  .map(finding => ({scene: scene.sceneNumber, code: finding.code, boundary: finding.sequenceBoundary})));

test("the plan step's Supervisor and the desk's report cover every sequence boundary, labelled, over the feature's own shots", async () => {
  const f = await feature(), planned = await f.plan();
  expect(planned.status).toBe(200);
  expect(planned.body.sequences.sequences.map(({firstScene, lastScene}) => [firstScene, lastScene])).toEqual([[1, 2], [3, 4], [5, 6]]);
  // The front door's look approval shows the Supervisor's notes, which name the scene opening each sequence.
  // The stand-in lights scene 5 (CONTINUOUS) for day after scene 4's NIGHT, in the same stairwell.
  const supervisor = planned.body.notes.filter(note => note.persona === "continuity").map(note => note.change);
  expect(supervisor).toContain("Found 1 light setting changing across a sequence boundary in scene 5 (opening sequence 3), where a sequence opens in the place and moment the one before it closes."
    + " Under Continuity at the Director's desk, \"Review continuity repair\" offers to hold it to the sequence before.");

  expect((await f.call(f.base + "/cast/" + crypto.randomUUID(), "PUT", {expectedVersion: planned.body.castingVersion, character: CHARACTER}, f.token)).status).toBe(200);
  const view = await f.view();
  // The desk reads the feature's 54 shots, not its 24-shot plan, so every scene and boundary is there.
  expect(view.continuity.scenes.map(scene => scene.sceneNumber)).toEqual([1, 2, 3, 4, 5, 6]);
  expect(view.continuity.scenes.reduce((total, scene) => total + scene.shotIds.length, 0)).toBe(54);
  expect(view.continuity.boundaries!.map(({from, to, lastScene, firstScene, continuous, sameLocation}) => ({from, to, lastScene, firstScene, continuous, sameLocation}))).toEqual([
    {from: 1, to: 2, lastScene: 2, firstScene: 3, continuous: true, sameLocation: false},
    {from: 2, to: 3, lastScene: 4, firstScene: 5, continuous: true, sameLocation: true}]);
  const found = labelled(view.continuity);
  expect(found).toContainEqual({scene: 3, code: "wardrobe-contradicts-previous", boundary: {from: 1, to: 2}});
  expect(found).toContainEqual({scene: 5, code: "boundary-look-changed", boundary: {from: 2, to: 3}});
  // Both boundaries have findings, and each is counted at its boundary.
  expect(view.continuity.boundaries!.every(boundary => boundary.findings >= 1 && boundary.comparisons >= 1)).toBe(true);
});

test("the boundary's repair is reviewed and applied through the desk's path, and the sequences made before it need a new rough cut", async () => {
  const f = await feature(), planned = await f.plan();
  expect((await f.call(f.base + "/cast/" + crypto.randomUUID(), "PUT", {expectedVersion: planned.body.castingVersion, character: CHARACTER}, f.token)).status).toBe(200);
  // Sequences 1 and 3 have rough cuts under the current direction; sequence 2 has none.
  const first = await f.render(1), third = await f.render(3);
  expect([first.status, third.status]).toEqual([202, 202]);

  const before = await f.view(), review = await f.review();
  expect(review.status).toBe(200);
  const boundary = review.body.proposal.edits.filter(edit => edit.sequenceBoundary);
  expect(boundary.length).toBeGreaterThan(0);
  expect(boundary.every(edit => edit.sceneIndex === 4 && edit.field === "keyLight" && edit.sequenceBoundary!.to === 3)).toBe(true);
  // Held to the shot in sequence 2 that the report names.
  const light = before.continuity.scenes[4]!.findings.find(finding => finding.code === "boundary-look-changed")!;
  const holdShot = before.direction.entries.find(entry => entry.source.id === light.shotIds[0])!;
  expect(boundary.every(edit => edit.to === holdShot.settings.keyLight)).toBe(true);
  expect(review.body.summary).toContain("Sequence 3 opens in the place and moment the sequence before it closes, so its light is held to that sequence's.");
  expect(review.body.proposal.notes).toContain("Scene 3 opens sequence 2 and is CONTINUOUS from Scene 2, the last scene of sequence 1, and a character's wardrobe changes between them. Wardrobe belongs to the cast record, not to a shot's direction, so it is not repaired from here.");
  // Reviewing changes nothing, and says which made sequences applying would send back.
  expect((await f.view()).direction.revision).toBe(before.direction.revision);
  const remake = [{sequence: 1, touched: false, stages: ["animatic"], jobIds: [first.body.jobId]}, {sequence: 3, touched: true, stages: ["animatic"], jobIds: [third.body.jobId]}];
  expect(review.body.remake).toEqual(remake);

  // Validated like any accept: edits other than the reviewed ones are refused, and nothing changes.
  const tampered = review.body.proposal.edits.map(edit => edit.sequenceBoundary ? {...edit, to: "Neon"} : edit);
  expect((await f.accept({edits: tampered, expectedVersion: before.direction.version, expectedScriptVersion: review.body.scriptVersion})).status).toBe(409);
  const accepted = await f.accept({edits: review.body.proposal.edits, expectedVersion: before.direction.version, expectedScriptVersion: review.body.scriptVersion});
  expect(accepted.status).toBe(200);
  expect(accepted.body.direction.version).toBe(before.direction.version + 1);
  expect(accepted.body.remake).toEqual(remake);

  const after = await f.view();
  expect(labelled(after.continuity).map(finding => finding.code)).not.toContain("boundary-look-changed");
  // The wardrobe is the creator's to settle: still reported, at its boundary.
  expect(labelled(after.continuity)).toContainEqual({scene: 3, code: "wardrobe-contradicts-previous", boundary: {from: 1, to: 2}});
  for (const edit of boundary) expect(after.direction.entries.find(entry => entry.source.id === edit.shotId)!.settings.keyLight).toBe(edit.to);
  // Each made sequence's next rough cut is a new render under the repaired direction, not the old one.
  for (const [sequence, old] of [[1, first], [3, third]] as const) {
    const again = await f.render(sequence);
    expect(again.status).toBe(202);
    expect(again.body.jobId).not.toBe(old.body.jobId);
  }
  // A second review has nothing more to hold across the boundary, and nothing it would send back.
  const second = await f.review();
  expect(second.body.proposal.edits.filter(edit => edit.sequenceBoundary)).toEqual([]);
});
