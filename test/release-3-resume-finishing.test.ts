/**
 * HV-030-39: `studio-run.ts --resume` redoes a sequence's finishing step that died, without a picture render.
 *
 * Release 3's live run: after the resume (HV-030-37) finished sequence 1's final, its voices pass hung
 * in the worker's upload. The studio gave up waiting on it and asked for the score, which queued behind
 * the hung job. To deploy the upload fix the operator stops `studio-run`, cancels the hung job and
 * resumes. Asked again with its key, a cancelled job is answered with itself, so the sequence would
 * stay unvoiced or unscored for ever.
 *
 * Here the operator's command runs in its own process against the real API, with the real worker in
 * this process, on mock ($0). Sequence 1's score is held by a stand-in for the hung worker. The run is
 * stopped with SIGTERM, the hung job is cancelled, and `--resume` finishes the feature. (The cast's
 * voices need the operator's PostgreSQL audio service; `packages/frontend/test/studio-resume-finishing.test.js`
 * covers them against a fake of the routes.)
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApiServer } from "../packages/api/src/server";
import { ProjectService } from "../packages/api/src/index";
import { DurableJobStore, type Job } from "../packages/queue/src/index";
import { processNextJob } from "../packages/queue/src/worker";
import { CostLedger, OperatorReviewQueue } from "../packages/operator/src/index";
import { ReferenceBlobStore } from "../packages/storage/src/references";

const REPO = resolve(import.meta.dir, "..");
/** Scene 1 is four beats; scene 2 is 21. 25 shots split into two sequences. */
const SCRIPT = ["Title: The Hung Score", "", "EXT. QUAY - DUSK", "", "Mara coils a rope on the quay.", "", "Mara reads the tide board.", "",
  "Mara lights the lantern.", "", "Mara hangs it on the post.", "", "INT. SHED - NIGHT", "",
  ...Array.from({ length: 21 }, (_, i) => [`Mara stacks crate ${i + 1} by the door.`, ""]).flat()].join("\n");

const root = mkdtempSync(join(tmpdir(), "hv-release-3-resume-finishing-"));
const paths = { queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json"), artifactRoot: join(root, "artifacts"), costLedgerPath: join(root, "ledger.json") };
const config = { HV_TOKEN_SECRET: ["resume", "finishing", "fixture", "at-least-thirty-two-characters"].join("-"), HV_ANIMATIC_PROVIDER_POOL: '["mock"]', HV_PROVIDER_POOL: '["mock"]',
  HV_NARRATION: "1", HV_ANIMATIC_CAPTIONS: "0" };
const original = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
const out = join(root, "f.json"), scriptPath = join(root, "feature.fountain");
const HUNG = "hung-worker", CANCELLED = "Cancelled by the operator: its upload hung (HV-030-38).";
let server: ReturnType<typeof createApiServer>, store: DurableJobStore;
/** While set, the first score asked for is claimed by a worker that never finishes it, and nothing else is worked. */
let hanging = true, hung: Job | undefined;
let pumping = false, pump: Promise<void> | undefined;

beforeAll(() => {
  Object.assign(process.env, config);
  writeFileSync(scriptPath, SCRIPT);
  server = createApiServer({ port: 0, hostname: "127.0.0.1", ...paths, operatorDiagnosticsSecret: null, rateLimit: { api: { limit: 100000, windowMs: 60000 } }, crewModel: null });
  store = new DurableJobStore(paths.queuePath);
  const context = { projects: new ProjectService(paths.statePath), ledger: new CostLedger(paths.costLedgerPath), references: new ReferenceBlobStore(paths.artifactRoot),
    reviewQueue: new OperatorReviewQueue(join(root, "reviews.json")) };
  pumping = true;
  pump = (async () => {
    while (pumping) {
      if (hanging && store.all().some(job => job.stage === "sound-mix" && job.status === "queued")) { hung ??= store.claimNext(Date.now(), {}, { workerId: HUNG }) ?? undefined; }
      if (hung && hanging) { await Bun.sleep(20); continue; }
      const job = await processNextJob(store, paths.artifactRoot, context);
      if (!job) await Bun.sleep(20);
    }
  })();
});
afterAll(async () => {
  pumping = false; await pump;
  await server.stop(true);
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

const spawn = (...args: string[]) => Bun.spawn(["bun", "scripts/studio-run.ts", "--base", server.url.origin, "--script", scriptPath, "--share", "2", "--out", out, "--poll-ms", "50", ...args],
  { cwd: REPO, stdout: "pipe", stderr: "pipe" });
const finished = async (run: ReturnType<typeof spawn>) => {
  const [code, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()]);
  return { code, stderr, report: JSON.parse(readFileSync(out, "utf8")) };
};
const pictures = (number: number) => store.all().filter(job => (job.stage === "animatic" || job.stage === "final") && job.sequence?.number === number);

let stopped: Awaited<ReturnType<typeof finished>>, resumed: Awaited<ReturnType<typeof finished>>, final1: Job;

/**
 * Criterion 2: the operator stops the run while sequence 1's score hangs. The run still writes its
 * record: stopped, by which signal, and where it was. Then the hung job is cancelled.
 */
test("a run stopped by the operator while a sequence's score hangs writes a record that says where it stopped", async () => {
  const run = spawn("--format", "feature");
  while (!hung || store.get(hung.id)?.status !== "running") await Bun.sleep(50);
  await Bun.sleep(500);
  run.kill("SIGTERM");
  stopped = await finished(run);
  expect([stopped.code, stopped.report.outcome, stopped.report.error]).toEqual([1, "stopped", "stopped by SIGTERM"]);
  expect(stopped.report.interrupted).toMatchObject({ step: "final", sequence: 1 });
  expect(stopped.report.plan.sequences.sequences).toHaveLength(2);
  [final1] = pictures(1).filter(job => job.stage === "final");
  expect(final1!.status).toBe("done");
  expect(hung!.soundMix?.source.jobId).toBe(final1!.id);
  store.cancel(hung!.id, HUNG, CANCELLED);
  hanging = false;
}, 240000);

/**
 * Criteria 1, 3 and 4: `--resume` asks for sequence 1's score again under `<its key>-retry-1`, on the
 * same final, and renders no picture for sequence 1. Sequence 1's film is then the score, as the
 * contract needs (HV-030-33), and the joined, shared feature holds it. The record says the score was
 * retried, which job it replaces and why that job ended.
 */
test("--resume asks again for the score the operator cancelled, under a retry key, and renders no picture for that sequence", async () => {
  const before = pictures(1).map(job => job.id);
  resumed = await finished(spawn("--resume"));
  expect([resumed.code, resumed.report.outcome, resumed.report.error]).toEqual([0, "completed", undefined]);
  expect(pictures(1).map(job => job.id)).toEqual(before);
  const key = hung!.idempotencyKey + "-retry-1", retried = store.all().find(job => job.idempotencyKey === key)!;
  expect([retried.stage, retried.status, retried.soundMix?.source.jobId]).toEqual(["sound-mix", "done", final1.id]);
  const report = resumed.report;
  expect(report.feature.unscored).toEqual([]);
  expect(report.feature.sequences[0]).toMatchObject({ number: 1, film: retried.id, finished: { scored: true } });
  const joined = store.get(report.final.jobId)!;
  expect(joined.featureFilm!.sequences.map(sequence => store.get(sequence.filmJobId)?.stage)).toEqual(["sound-mix", "sound-mix"]);
  expect(report.review.jobId).toBe(joined.id);
  const [entry] = report.resumes;
  expect(entry.replaced).toMatchObject({ outcome: "stopped", error: "stopped by SIGTERM", interrupted: { sequence: 1 } });
  expect(entry.steps.sequences[0]).toEqual({ number: 1, roughCut: "kept", final: "kept", finishing: "redone" });
  expect(entry.finishing).toContainEqual({ sequence: 1, step: "score", how: "retried", key: key.slice(key.indexOf(":") + 1), jobId: retried.id,
    retryOf: { jobId: hung!.id, status: "cancelled", reason: CANCELLED } });
  expect(Object.keys(entry.why)).toEqual(["1"]);
}, 240000);

/** Criterion 1: run again, every finishing step is kept and nothing is admitted. */
test("a second --resume keeps every finishing step and admits no job", async () => {
  const count = store.all().length;
  const again = await finished(spawn("--resume"));
  expect([again.code, again.report.outcome, store.all().length]).toEqual([0, "completed", count]);
  const entry = again.report.resumes.at(-1);
  expect(entry.finishing.map((step: { how: string }) => step.how).every((how: string) => how === "kept")).toBe(true);
  expect(entry.steps.sequences.map((sequence: { finishing: string }) => sequence.finishing)).toEqual(["kept", "kept"]);
  expect(entry.steps.share).toBe("kept");
}, 240000);
