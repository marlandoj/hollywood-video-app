/**
 * HV-030-29 — the front door makes a feature one sequence at a time (Release 3 step 2, G20-202610031349).
 *
 * Kevin decided at G20: the look is approved once for the whole feature, then the rough cut and the
 * final per sequence. This drives the real studio flow against the real API and worker, on the mock
 * providers: the look approval permits the cast once and renders the first sequence's storyboard and
 * rough cut; each sequence's final follows its own approved rough cut; the next sequence's rough cut is
 * admitted only when the creator approves the last one's film. Each sequence's final is its own film:
 * no title, credits or joined feature is made.
 */
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/server";
import { ProjectService } from "../src/index";
import { DurableJobStore } from "../../queue/src/index";
import { processNextJob } from "../../queue/src/worker";
import { CostLedger, OperatorReviewQueue } from "../../operator/src/index";
import { ReferenceBlobStore } from "../../storage/src/references";
import { featureShots, inSequence } from "../../planner/src/sequences";
import { parseFountain } from "../../parser/src/index";
// @ts-expect-error -- the studio is a plain browser module with no type declarations.
import { createStudioFlow, stepTitle, spendText } from "../../frontend/src/studio.js";
import { evenFeature } from "../../../test/fixtures/feature-script";

const SCRIPT = evenFeature(2, 13);
const root = mkdtempSync(join(tmpdir(), "hv-feature-sequences-"));
const config = {HV_TOKEN_SECRET: "feature-sequences-fixture-secret-at-least-thirty-two", HV_ANIMATIC_PROVIDER_POOL: '["mock"]', HV_PROVIDER_POOL: '["mock"]',
  HV_NARRATION: "0", HV_ANIMATIC_CAPTIONS: "0"};
const original = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
let server: ReturnType<typeof createApiServer> | undefined;
afterAll(async () => {
  await server?.stop(true); rmSync(root, {recursive: true, force: true});
  for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

test("a feature's look is approved once, then each sequence gets its own rough cut and final, one after another", async () => {
  Object.assign(process.env, config);
  const paths = {queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json"), artifactRoot: join(root, "artifacts"), costLedgerPath: join(root, "ledger.json")};
  server = createApiServer({port: 0, hostname: "127.0.0.1", ...paths, rateLimit: {api: {limit: 100000, windowMs: 60000}}, crewModel: null});
  const projects = new ProjectService(paths.statePath), store = new DurableJobStore(paths.queuePath), ledger = new CostLedger(paths.costLedgerPath);
  const worker = () => processNextJob(store, paths.artifactRoot, {projects, ledger, references: new ReferenceBlobStore(paths.artifactRoot), reviewQueue: new OperatorReviewQueue(join(root, "reviews.json"))});
  const base = server.url.origin, calls: {method: string; path: string; body: Record<string, unknown> | null}[] = [];
  const api = async (path: string, init: RequestInit = {}) => {
    calls.push({method: init.method ?? "GET", path, body: typeof init.body === "string" ? JSON.parse(init.body) : null});
    const response = await fetch(base + path, init), body = await response.json();
    if (!response.ok) throw new Error(path + " " + response.status + " " + body.error);
    return body;
  };
  let project: {projectId: string; token: string} | undefined;
  const flow = createStudioFlow({api, getProject: () => project, setProject: (value: typeof project) => { project = value; }, wait: async () => { await worker(); }});
  const renders = () => calls.filter(call => call.method === "POST" && call.path.endsWith("/jobs")).map(call => call.body);

  await flow.pitch({script: SCRIPT, format: "feature", tone: "", rightsAttested: true});
  // "No music" keeps the Composer's score out of this test's time; each sequence is still voiced and finished like a short.
  const sound = flow.state.readThrough.questions.find((question: {persona: string}) => question.persona === "sound");
  expect(sound).toBeDefined();
  const look = await flow.plan([{id: sound.id, accepted: false, reply: "No music."}]);
  expect(look.sequences.map((sequence: {number: number; shots: number}) => [sequence.number, sequence.shots])).toEqual([[1, 13], [2, 13]]);
  expect(look.sequence).toBe(1);
  expect(stepTitle(look)).toBe("Approval 1 of 5: the plan and the look, once for the whole feature");
  expect(look.plan.notes[0].persona).toBe("showrunner");

  // Approval 1, once: the cast is permitted and sequence 1's storyboard and rough cut are rendered.
  const rough1 = await flow.approveLook(true);
  expect(rough1.step).toBe("rough-cut");
  expect(rough1.animatic.sequence).toMatchObject({number: 1, of: 2, firstScene: 1, lastScene: 1});
  expect(stepTitle(rough1)).toBe("Approval 2 of 5: sequence 1 of 2, its storyboard and rough cut");
  expect(renders()).toEqual([{sequence: 1}]);
  const shots = featureShots(parseFountain(SCRIPT));
  const rendered = async (id: string) => (await store.get(id))!.output!.shotRenders!.map(record => record.shotId);
  expect(await rendered(rough1.animatic.id)).toEqual(inSequence(shots, rough1.animatic.sequence).map(shot => shot.id));
  expect(spendText(rough1)).toBe("Sequence 1 of 2 so far: $0.00. The whole feature so far: $0.00 of its $150.00 limit.");

  // A final can't be made of another sequence than the rough cut approved (asked directly, not through the studio).
  const direct = (path: string, body: unknown) => fetch(base + `/api/projects/${project!.projectId}` + path, {method: "POST",
    headers: {authorization: "Bearer " + project!.token, "content-type": "application/json"}, body: JSON.stringify(body)});
  expect((await direct("/animatic/decision", {animaticJobId: rough1.animatic.id, decision: "approved"})).status).toBe(201);
  const crossed = await direct("/jobs", {stage: "final", animaticJobId: rough1.animatic.id, sequence: 2});
  expect([crossed.status, (await crossed.json() as {error: string}).error]).toEqual([409, "That rough cut is of another sequence. Approve this sequence's rough cut first."]);

  // Approval 3: sequence 1's final, from its own rough cut.
  const final1 = await flow.approveRoughCut();
  expect(final1.step).toBe("final");
  expect(stepTitle(final1)).toBe("Approval 3 of 5: sequence 1 of 2, its film");
  const finals = async () => (await store.all()).filter(job => job.stage === "final");
  expect((await finals()).map(job => job.sequence?.number)).toEqual([1]);
  expect(await rendered((await finals())[0]!.id)).toEqual(inSequence(shots, rough1.animatic.sequence).map(shot => shot.id));
  // A sequence carries no title or credits, and nothing calls it the feature.
  expect(final1.finishNotes.some((note: string) => note.startsWith("Editor: a sequence carries no title or credits"))).toBe(true);
  expect(calls.some(call => call.path.includes("/graphics") || call.path.includes("/editorial"))).toBe(false);
  // Sequence 2 has not been asked for: it waits for the creator's approval of sequence 1's film.
  expect(renders()).toEqual([{sequence: 1}, {stage: "final", animaticJobId: rough1.animatic.id, sequence: 1}]);

  // Approval 4 and 5: the next sequence, with no second look approval.
  const rough2 = await flow.nextSequence();
  expect(rough2.step).toBe("rough-cut");
  expect(rough2.animatic.sequence).toMatchObject({number: 2, firstScene: 2, lastScene: 2});
  expect(stepTitle(rough2)).toBe("Approval 4 of 5: sequence 2 of 2, its storyboard and rough cut");
  const final2 = await flow.approveRoughCut();
  expect(stepTitle(final2)).toBe("Approval 5 of 5: sequence 2 of 2, its film");
  expect((await finals()).map(job => job.sequence?.number)).toEqual([1, 2]);
  expect(await rendered((await finals())[1]!.id)).toEqual(inSequence(shots, rough2.animatic.sequence).map(shot => shot.id));
  expect(calls.filter(call => call.path.endsWith("/crew/approve-cast"))).toHaveLength(1);
  expect(renders()).toEqual([{sequence: 1}, {stage: "final", animaticJobId: rough1.animatic.id, sequence: 1}, {sequence: 2}, {stage: "final", animaticJobId: rough2.animatic.id, sequence: 2}]);
  // The last sequence is the end of what this step makes; there is no joined film to approve or share.
  await expect(flow.nextSequence()).rejects.toThrow("Every sequence of this feature is made.");
  expect((await store.all()).some(job => job.stage === "picture-edit" || job.stage === "assembly-edit")).toBe(false);
  expect(final2.spend.sequences.map((sequence: {number: number}) => sequence.number)).toEqual([1, 2]);
}, 180000);
