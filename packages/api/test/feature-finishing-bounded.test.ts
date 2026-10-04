/**
 * HV-030-32 — a sequence's finishing requests do bounded work, however long the feature is.
 *
 * Release 3's $0 rehearsal stopped at sequence 10: the score's quote took 17–45 s and the score
 * itself 48–105 s, inside the API's one event loop, so a render request behind them hit the server's
 * 20 s idle timeout. Each request planned the whole feature again (and ran the safety gate over every
 * shot of it) once for each shot of the sequence and once for each check that read the film, and read
 * every job body of the project to find one request key and count the running jobs.
 *
 * These tests drive the real studio flow against the real API and worker on the mock providers. The
 * feature's first sequence is three shots; the rest of the screenplay is long scenes that each make a
 * sequence of their own. Sequence 1 is rendered, voiced with temporary speech and scored, in a feature
 * of 2 sequences and in one of 7. What each request does is counted, not timed: how many times the
 * feature is planned (`filmPlan`), how many of its shots those plans hold (each one is gated), and
 * how many times every job of the project is read (`all()`).
 */
import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/server";
import { ProjectService } from "../src/index";
import { DurableJobStore } from "../../queue/src/index";
import { processNextJob } from "../../queue/src/worker";
import { CostLedger, OperatorReviewQueue } from "../../operator/src/index";
import { ReferenceBlobStore } from "../../storage/src/references";
import { StudioLogger } from "../../observability/src/logs";
import * as sequences from "../../planner/src/sequences";
import { dialogueSource } from "../../planner/src/dialogue-replacement";
// @ts-expect-error -- the studio is a plain browser module with no type declarations.
import { createStudioFlow } from "../../frontend/src/studio.js";

/** Scene 1 is sequence 1, three shots and one line; each later scene is 22 shots, a sequence of its own. */
function feature(sequenceCount: number): string {
  const opening = "INT. YARD 1 - DAY\n\nMara lifts a crate.\n\nMara sets it on the cart.\n\nMara wipes her hands.\n\nMARA\nOne more, then home.";
  const long = Array.from({length: sequenceCount - 1}, (_, i) => `${i % 2 ? "INT" : "EXT"}. YARD ${i + 2} - DAY\n\n`
    + Array.from({length: 22}, (_, b) => `Mara carries crate ${b + 1} across yard ${i + 2}.`).join("\n\n"));
  return [opening, ...long].join("\n\n");
}

const root = mkdtempSync(join(tmpdir(), "hv-finishing-bounded-"));
const config = {HV_TOKEN_SECRET: ["finishing", "bounded", "fixture", "only", "at-least-thirty-two"].join("-"), HV_ANIMATIC_PROVIDER_POOL: '["mock"]', HV_PROVIDER_POOL: '["mock"]',
  HV_NARRATION: "1", HV_ANIMATIC_CAPTIONS: "0"};
const original = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
const servers: ReturnType<typeof createApiServer>[] = [];
afterAll(async () => {
  for (const server of servers) await server.stop(true);
  rmSync(root, {recursive: true, force: true});
  for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

interface Counted {method: string; route: string; plans: number; plannedShots: number; wholeProjectReads: number}

/** Make sequence 1 of a feature of `sequenceCount` sequences through to its scored film, counting each request's work. */
async function finishSequenceOne(name: string, sequenceCount: number) {
  Object.assign(process.env, config);
  const dir = join(root, name), paths = {queuePath: join(dir, "jobs.json"), statePath: join(dir, "projects.json"), artifactRoot: join(dir, "artifacts"), costLedgerPath: join(dir, "ledger.json")};
  const lines: string[] = [];
  const server = createApiServer({port: 0, hostname: "127.0.0.1", ...paths, operatorDiagnosticsSecret: null, rateLimit: {api: {limit: 100000, windowMs: 60000}}, crewModel: null,
    logger: new StudioLogger({service: "api", write: (_level, line) => { lines.push(line); }})});
  servers.push(server);
  const store = new DurableJobStore(paths.queuePath);
  const context = {projects: new ProjectService(paths.statePath), ledger: new CostLedger(paths.costLedgerPath), references: new ReferenceBlobStore(paths.artifactRoot),
    reviewQueue: new OperatorReviewQueue(join(dir, "reviews.json"))};
  const plans = spyOn(sequences, "filmPlan"), reads = spyOn(DurableJobStore.prototype, "all");
  const counted: Counted[] = [], base = server.url.origin;
  const api = async (path: string, init: RequestInit = {}) => {
    const plansBefore = plans.mock.calls.length, readsBefore = reads.mock.calls.length;
    const response = await fetch(base + path, init), body = await response.json() as any;
    counted.push({method: init.method ?? "GET", route: path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ":id"),
      plans: plans.mock.calls.length - plansBefore, plannedShots: plans.mock.results.slice(plansBefore).reduce((sum, result) => sum + (result.type === "return" ? (result.value as unknown[]).length : 0), 0),
      wholeProjectReads: reads.mock.calls.length - readsBefore});
    if (!response.ok) throw new Error(path + " " + response.status + " " + body.error);
    return body;
  };
  let project: {projectId: string; token: string} | undefined;
  const flow = createStudioFlow({api, getProject: () => project, setProject: (value: typeof project) => { project = value; },
    wait: async () => { await processNextJob(store, paths.artifactRoot, context); }});
  try {
    await flow.pitch({script: feature(sequenceCount), format: "feature", tone: "warm", rightsAttested: true});
    const look = await flow.plan([]);
    expect(look.sequences.map((sequence: {shots: number}) => sequence.shots)).toEqual([3, ...Array(sequenceCount - 1).fill(22)]);
    await flow.approveLook(true);
    const finished = await flow.approveRoughCut();
    const film = (await store.all()).find(job => job.stage === "final")!;
    // The Composer scored sequence 1: its film is the sound mix of its final.
    expect([finished.final.stage, (await store.get(finished.final.id))!.soundMix?.source.jobId]).toEqual(["sound-mix", film.id]);
    // The crew's voices, laid in with the studio's temporary speech: the dialogue quote and its render.
    const owner = {authorization: "Bearer " + project!.token};
    const quote = await api(`/api/projects/${project!.projectId}/dialogue/${film.id}`, {headers: owner});
    expect(quote.lines.length).toBe(1);
    const [line] = quote.lines;
    await api(`/api/projects/${project!.projectId}/dialogue/${film.id}`, {method: "POST", headers: {...owner, "content-type": "application/json"},
      body: JSON.stringify({idempotencyKey: "voices-" + film.id, generationApproved: true, sourceRevision: quote.sourceRevision, sourceFilesRevision: quote.sourceFilesRevision,
        engineVersion: quote.engineVersion, edits: [{shotId: line.shotId, index: line.index, sourceHash: line.sourceHash, text: line.text, voice: line.voice, notes: line.notes}]})});
    return {counted, lines, film, store};
  } finally { plans.mockRestore(); reads.mockRestore(); }
}

/** The finishing requests, in the order the studio makes them, each with what it did. */
const finishing = (counted: Counted[]) => counted.filter(call => /\/(dialogue|sound-mixes|sounds|ambience)\b/.test(call.route) || call.method === "POST" && call.route.endsWith("/jobs"));
const label = (call: Counted) => call.method + " " + call.route.replace(/^\/api\/projects\/:id/, "");

let small: Awaited<ReturnType<typeof finishSequenceOne>>, large: Awaited<ReturnType<typeof finishSequenceOne>>;

/**
 * Criterion 1 and 2: every finishing request -- the render request, the score's quote, the sound
 * library, the ambience, the score, the dialogue quote and the voices -- plans the feature at most once
 * and reads no project's whole job list. The voices and score routes used to plan it once per shot and
 * per check, and read every job body twice.
 */
test("a sequence's finishing requests plan the feature at most once and never read every job of the project", async () => {
  small = await finishSequenceOne("two", 2);
  const routes = finishing(small.counted);
  expect(routes.map(label)).toEqual([
    "POST /jobs", "POST /jobs", "GET /sound-mixes/:id", "GET /sounds", "POST /sounds", "POST /ambience/:id", "POST /sound-mixes/:id", "GET /dialogue/:id", "POST /dialogue/:id"]);
  expect(routes.map(call => [label(call), Math.min(call.plans, 2), call.wholeProjectReads])).toEqual(routes.map(call => [label(call), Math.min(call.plans, 1), 0]));
  // Each poll of a finished job's view, the studio's heartbeat while it waits, plans nothing new either.
  for (const call of small.counted.filter(value => value.route.startsWith("/api/jobs/"))) expect(call.plans).toBeLessThanOrEqual(1);
}, 240000);

/**
 * Criterion 2: in a feature of seven sequences, the same sequence-1 requests plan it as often as in a
 * feature of two, and none gates more than the feature's 135 shots once. Before, the score's quote
 * planned the whole feature once per shot of sequence 1 and once per check, so its work grew with
 * the length of the rest of the feature.
 */
test("the same finishing requests do the same work in a feature of two sequences and of seven", async () => {
  large = await finishSequenceOne("seven", 7);
  const work = (value: typeof small) => finishing(value.counted).map(call => [label(call), call.plans, call.wholeProjectReads]);
  expect(work(large)).toEqual(work(small));
  const shots = 3 + 6 * 22;
  expect(finishing(large.counted).map(call => [label(call), Math.min(call.plannedShots, shots + 1)])).toEqual(finishing(large.counted).map(call => [label(call), Math.min(call.plannedShots, shots)]));
}, 240000);

/**
 * Criterion 1: what is remembered changes nothing that is refused. A retained film is verified once
 * for the same film, records and time; a record changed in any byte is verified afresh and refused,
 * wherever in the film it is, and a refusal is never remembered.
 */
test("a remembered verification still refuses a film whose shot record changed, and keeps refusing it", async () => {
  const film = small.film, at = Date.parse(film.completedAt!), plans = spyOn(sequences, "filmPlan");
  try {
    expect(dialogueSource(film, at).shots.length).toBe(3);
    expect(dialogueSource(film, at).shots.length).toBe(3);
    expect(plans.mock.calls.length).toBe(0);
    for (const index of [0, 2]) {
      const changed = structuredClone(film);
      changed.output!.shotRenders![index]!.inputHash = "0".repeat(64);
      for (let attempt = 0; attempt < 2; attempt++) expect(() => dialogueSource(changed, at)).toThrow();
    }
    // A film read past its retention is refused although the same film was verified a moment before.
    expect(() => dialogueSource(film, Date.parse(film.linkExpiresAt!) + 1)).toThrow("Choose a completed, unexpired film with retained shot media.");
  } finally { plans.mockRestore(); }
});

/** Criterion 3: the request log names each finishing route by its pattern, never "unmatched", and never an id. */
test("the request log labels the finishing routes by their pattern", () => {
  const logged = small.lines.map(line => JSON.parse(line)).filter(line => line.event === "api.request");
  const routes = new Set(logged.map(line => line.method + " " + line.route));
  for (const route of ["POST /api/projects/:projectId/jobs", "GET /api/projects/:projectId/sound-mixes/:id", "GET /api/projects/:projectId/sounds",
    "POST /api/projects/:projectId/sounds", "POST /api/projects/:projectId/ambience/:id", "POST /api/projects/:projectId/sound-mixes/:id",
    "GET /api/projects/:projectId/dialogue/:id", "POST /api/projects/:projectId/dialogue/:id", "GET /api/jobs/:jobId", "POST /api/projects/:projectId/crew/read-through",
    "POST /api/projects/:projectId/crew/plan"]) expect([...routes]).toContain(route);
  expect(logged.filter(line => line.route === "unmatched")).toEqual([]);
  expect(JSON.stringify(logged)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
});
