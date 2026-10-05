/**
 * HV-030-33 — every sequence of a feature is scored against the picture the worker made.
 *
 * Release 3's strict-$0 rehearsals 2 and 3 joined "The Tide Clock" with no music on 9 of its 10
 * sequences. Each sequence's `sound-mix` failed with "The selected picture length changed.", and the
 * run carried on. A final whose shots carry no recorded speech is assembled with a 15-frame dissolve
 * between shots, so its picture is shorter than its shot records add up to. The score was pinned to
 * the records' sum and measured against the picture, and the two never agreed.
 *
 * These tests drive the real studio flow against the real API and worker on the mock providers. The
 * feature has two sequences. Sequence 1 is three shots and one line, so its final cuts. Sequence 2 is
 * 22 shots and no line, so its final dissolves. Sequence 1's picture is made to measure one frame
 * longer than the one its score was pinned to, as a picture that really changed would.
 */
import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/server";
import { ProjectService } from "../src/index";
import { DurableJobStore, type Job } from "../../queue/src/index";
import { processNextJob } from "../../queue/src/worker";
import { CostLedger, OperatorReviewQueue } from "../../operator/src/index";
import { ReferenceBlobStore } from "../../storage/src/references";
import { StudioLogger } from "../../observability/src/logs";
import * as pictures from "../../generator/src/dialogue-replacement";
// @ts-expect-error -- the studio is a plain browser module with no type declarations.
import { createStudioFlow } from "../../frontend/src/studio.js";

const SCRIPT = ["INT. YARD 1 - DAY\n\nMara lifts a crate.\n\nMara sets it on the cart.\n\nMara wipes her hands.\n\nMARA\nOne more, then home.",
  "EXT. YARD 2 - DAY\n\n" + Array.from({length: 22}, (_, b) => `Mara carries crate ${b + 1} across the yard.`).join("\n\n")].join("\n\n");
const root = mkdtempSync(join(tmpdir(), "hv-sequence-score-"));
const config = {HV_TOKEN_SECRET: ["sequence", "score", "fixture", "only", "at-least-thirty-two"].join("-"), HV_ANIMATIC_PROVIDER_POOL: '["mock"]', HV_PROVIDER_POOL: '["mock"]',
  HV_NARRATION: "1", HV_ANIMATIC_CAPTIONS: "0"};
const original = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
const paths = {queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json"), artifactRoot: join(root, "artifacts"), costLedgerPath: join(root, "ledger.json")};
let server: ReturnType<typeof createApiServer> | undefined;
afterAll(async () => {
  await server?.stop(true);
  rmSync(root, {recursive: true, force: true});
  for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

/** The picture's frames as ffprobe decodes them. */
function measured(path: string): number {
  const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", path]);
  return Number(probe.stdout.toString().trim());
}

let made: {state: any; store: DurableJobStore; finals: Job[]} | undefined;
/** Both sequences made, finished and joined through the studio flow. */
async function makeFeature() {
  Object.assign(process.env, config);
  server = createApiServer({port: 0, hostname: "127.0.0.1", ...paths, operatorDiagnosticsSecret: null, rateLimit: {api: {limit: 100000, windowMs: 60000}}, crewModel: null,
    logger: new StudioLogger({service: "api", write: () => {}})});
  const store = new DurableJobStore(paths.queuePath), base = server.url.origin;
  const context = {projects: new ProjectService(paths.statePath), ledger: new CostLedger(paths.costLedgerPath), references: new ReferenceBlobStore(paths.artifactRoot),
    reviewQueue: new OperatorReviewQueue(join(root, "reviews.json"))};
  const api = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(base + path, init), body = await response.json() as any;
    if (!response.ok) throw new Error(path + " " + response.status + " " + body.error);
    return body;
  };
  // While sequence 1 is scored, the picture the mix reads measures one frame longer than the one it was pinned to.
  const identity = pictures.videoIdentity;
  let changed = true;
  const spy = spyOn(pictures, "videoIdentity").mockImplementation(async (path, cwd, signal) => {
    const picture = await identity(path, cwd, signal);
    return changed && path.includes("/.sound-source-") ? {...picture, frames: picture.frames + 1} : picture;
  });
  let project: {projectId: string; token: string} | undefined;
  const flow = createStudioFlow({api, getProject: () => project, setProject: (value: typeof project) => { project = value; },
    wait: async () => { await processNextJob(store, paths.artifactRoot, context); }});
  try {
    await flow.pitch({script: SCRIPT, format: "feature", tone: "warm", rightsAttested: true});
    const look = await flow.plan([]);
    expect(look.sequences.map((sequence: {shots: number}) => sequence.shots)).toEqual([3, 22]);
    await flow.approveLook(true);
    await flow.approveRoughCut();
    changed = false;
    await flow.nextSequence();
    const state = await flow.approveRoughCut();
    const finals = (await store.all()).filter(job => job.stage === "final").sort((a, b) => a.sequence!.number - b.sequence!.number);
    return {state, store, finals};
  } finally { spy.mockRestore(); }
}

/**
 * Criterion 1: sequence 2's final dissolves its 22 shots, so its picture runs 21 dissolves of 15
 * frames shorter than its records. Its score is pinned to that picture, measured against it, and
 * finishes. Before, the score was pinned to the records' 1,320 frames and failed on the picture's 1,005.
 */
test("a sequence whose final dissolves its shots is scored against the picture the worker made", async () => {
  made = await makeFeature();
  const {state, store, finals} = made, [, final] = finals;
  const records = final!.output!.shotRenders!;
  expect(records.some(record => record.clip.speech)).toBe(false);
  const picture = measured(join(paths.artifactRoot, final!.output!.mp4Path));
  expect([final!.totalFrames, picture]).toEqual([1320, 1320 - 21 * 15]);
  // Sequence 2's film is the Composer's mix of its final, of the picture's length, and the studio noted nothing.
  const film = state.finals[2];
  expect([film.stage, film.status]).toEqual(["sound-mix", "done"]);
  const score = (await store.get(film.id))!;
  expect([score.soundMix!.source.jobId, score.totalFrames, score.output!.sound!.report.totalVideoFrames]).toEqual([final!.id, picture, picture]);
  expect(measured(join(paths.artifactRoot, score.output!.mp4Path))).toBe(picture);
  expect(state.finishes[2]).toMatchObject({scored: true, notes: []});
  // The joined feature is made from it.
  const joined = (await store.get(state.final.id))!;
  expect(joined.featureFilm!.sequences.map(sequence => sequence.filmJobId)).toEqual([finals[0]!.id, film.id]);
}, 300000);

/**
 * Criteria 2 and 3: the check is not loosened. Sequence 1's final cuts, so its records and its picture
 * agree, and its score is pinned to 180 frames. Its picture is made to measure 181, as one that really
 * changed would, and the score fails with the same reason as before. The
 * flow keeps the final, and the joined feature says which sequence has no music and why. Before, the
 * joined film's notes named only the last sequence's finishing.
 */
test("a score whose picture measures another length still fails, and the joined feature names the sequence left without music", async () => {
  const {state, store, finals} = made!, [final] = finals;
  const scores = (await store.all()).filter(job => job.stage === "sound-mix" && job.soundMix!.source.jobId === final!.id);
  expect(scores.map(job => [job.status, job.totalFrames, job.failureReason])).toEqual([["failed", 180, "The selected picture length changed."]]);
  expect(state.finals[1].id).toBe(final!.id);
  const failed = "Composer: the score could not be mixed (The selected picture length changed.); the film is shared without music.";
  expect(state.finishes[1]).toMatchObject({scored: false, notes: [failed]});
  expect(state.joined).toBe(true);
  expect(state.finishNotes[0]).toBe("Sequence 1 of 2: " + failed);
  expect(state.finishNotes.filter((note: string) => note.startsWith("Sequence 2"))).toEqual([]);
}, 60000);
