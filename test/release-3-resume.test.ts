/**
 * HV-030-37: `scripts/studio-run.ts --resume` carries on a feature whose run stopped, without paying twice.
 *
 * Release 3's live run stopped on sequence 1's final: 8 of 21 shots rendered and paid for, then the
 * provider refused shot 9 and the job failed. Asking for that final again with the studio's default key
 * answers with the failed job, and nothing reused a failed render's shots.
 *
 * These tests run the operator's command, `bun scripts/studio-run.ts`, in its own process against the
 * real API, with the real worker taking jobs in this process, on the mock providers ($0). The feature
 * is two sequences. A stand-in for the provider's refusal fails sequence 1's final on its third shot.
 * The refusal is then lifted, as the prompt fix lifts it, and the same command with `--resume` finishes
 * the feature.
 */
import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApiServer } from "../packages/api/src/server";
import { ProjectService } from "../packages/api/src/index";
import { DurableJobStore, type Job } from "../packages/queue/src/index";
import { processNextJob } from "../packages/queue/src/worker";
import { CostLedger, OperatorReviewQueue } from "../packages/operator/src/index";
import { ReferenceBlobStore } from "../packages/storage/src/references";
import { DeterministicMockProvider } from "../packages/generator/src/index";
import { StudioLogger } from "../packages/observability/src/logs";
import { reusedSources, shotProviders, type FeatureStudioReport } from "../scripts/release-3-run";

const REPO = resolve(import.meta.dir, "..");
/** The marked beat: the provider refuses its prompt until the "fix" lifts the refusal. */
const MARK = "brass lantern";
/** Scene 1 is four beats, the third marked; scene 2 is 21 beats. 25 shots split into two sequences. */
const SCRIPT = ["Title: The Lantern Test", "", "EXT. QUAY - DUSK", "", "Mara coils a rope on the quay.", "", "Mara reads the tide board.", "",
  `Mara lights the ${MARK}.`, "", "Mara hangs it on the post.", "", "INT. SHED - NIGHT", "",
  ...Array.from({ length: 21 }, (_, i) => [`Mara stacks crate ${i + 1} by the door.`, ""]).flat()].join("\n");

const root = mkdtempSync(join(tmpdir(), "hv-release-3-resume-"));
const paths = { queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json"), artifactRoot: join(root, "artifacts"), costLedgerPath: join(root, "ledger.json") };
const config = { HV_TOKEN_SECRET: ["resume", "fixture", "only", "at-least-thirty-two-characters"].join("-"), HV_ANIMATIC_PROVIDER_POOL: '["mock"]', HV_PROVIDER_POOL: '["mock"]',
  HV_NARRATION: "1", HV_ANIMATIC_CAPTIONS: "0" };
const original = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
const out = join(root, "f.json"), scriptPath = join(root, "feature.fountain");
const requests: { method: string; route: string }[] = [];
let server: ReturnType<typeof createApiServer>, store: DurableJobStore, ledger: CostLedger;
let refusing = true;
const calls: string[] = [];
const real = DeterministicMockProvider.prototype.generate, generate = spyOn(DeterministicMockProvider.prototype, "generate");
let pumping = false, pump: Promise<void> | undefined;

beforeAll(() => {
  Object.assign(process.env, config);
  writeFileSync(scriptPath, SCRIPT);
  server = createApiServer({ port: 0, hostname: "127.0.0.1", ...paths, operatorDiagnosticsSecret: null, rateLimit: { api: { limit: 100000, windowMs: 60000 } }, crewModel: null,
    logger: new StudioLogger({ service: "api", write: (_level, line) => { const entry = JSON.parse(line); if (entry.event === "api.request") requests.push({ method: entry.method, route: entry.route }); } }) });
  store = new DurableJobStore(paths.queuePath); ledger = new CostLedger(paths.costLedgerPath);
  const context = { projects: new ProjectService(paths.statePath), ledger, references: new ReferenceBlobStore(paths.artifactRoot), reviewQueue: new OperatorReviewQueue(join(root, "reviews.json")) };
  // A stand-in for fal's 422: the marked shot's final is refused, every attempt, until the refusal is lifted.
  generate.mockImplementation(async function (this: DeterministicMockProvider, prompt, seed, params, outPath) {
    if (refusing && prompt.includes(MARK)) throw new Error("fal 422: String should have at most 2500 characters (test stand-in)");
    const clip = await real.call(this, prompt, seed, params, outPath);
    calls.push(prompt);
    return clip;
  });
  pumping = true;
  pump = (async () => { while (pumping) { const job = await processNextJob(store, paths.artifactRoot, context); if (!job) await Bun.sleep(20); } })();
});
afterAll(async () => {
  pumping = false; await pump; generate.mockRestore();
  await server.stop(true);
  rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

const studioRun = async (...args: string[]) => {
  const run = Bun.spawn(["bun", "scripts/studio-run.ts", "--base", server.url.origin, "--script", scriptPath, "--share", "2", "--out", out, "--poll-ms", "50", ...args],
    { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
  return { code, stdout, stderr, report: JSON.parse(readFileSync(out, "utf8")) };
};
const finals = (number: number) => store.all().filter(job => job.stage === "final" && job.sequence?.number === number);
const animatics = (number: number) => store.all().filter(job => job.stage === "animatic" && job.sequence?.number === number);

let stopped: Awaited<ReturnType<typeof studioRun>>, resumed: Awaited<ReturnType<typeof studioRun>>, failed: Job, retried: Job;

/**
 * Criterion 1: the live run's stop, reproduced. Sequence 1's final renders two shots, is refused on the
 * marked third every attempt and fails. The run stops, and its record says why.
 */
test("a feature's run stops when one shot of sequence 1's final is refused, with the shots before it rendered", async () => {
  stopped = await studioRun("--format", "feature");
  expect([stopped.code, stopped.report.outcome]).toEqual([1, "stopped"]);
  expect(stopped.report.error).toContain("fal 422");
  [failed] = finals(1);
  expect(finals(1)).toHaveLength(1);
  expect([failed!.status, failed!.checkpointShots]).toEqual(["failed", 2]);
  expect(calls).toHaveLength(2);
}, 240000);

/**
 * Criteria 1 to 4: `--resume` finishes the same project. Nothing before the stop is asked for again: no
 * project, pitch, read-through, plan, look, rough cut or approval for sequence 1. Sequence 1's final is
 * asked for under a fresh key fixed by its rough cut and the attempt, with reuse on, and its two rendered
 * shots come back from the failed render, byte for byte, without a provider call. The record keeps the
 * earlier steps, says which were kept, retried and made, and still reads as a feature's record.
 */
test("--resume finishes the same feature, reusing every shot the failed final rendered, and asks for nothing else again", async () => {
  refusing = false;
  const before = { requests: requests.length, calls: calls.length, rendered: [...calls] };
  resumed = await studioRun("--resume");
  expect([resumed.code, resumed.report.outcome, resumed.report.error]).toEqual([0, "completed", undefined]);
  const report = resumed.report as FeatureStudioReport & Record<string, any>;
  // The same project, and nothing before the stop asked for again.
  expect(report.projectId).toBe(stopped.report.projectId);
  const asked = requests.slice(before.requests).map(request => request.method + " " + request.route);
  for (const route of ["POST /api/projects", "PUT /api/projects/:projectId/script", "POST /api/projects/:projectId/rights", "POST /api/projects/:projectId/crew/read-through",
    "POST /api/projects/:projectId/crew/plan", "POST /api/projects/:projectId/crew/approve-cast"]) expect(asked).not.toContain(route);
  expect(asked.filter(route => route === "POST /api/projects/:projectId/animatic/decision")).toHaveLength(1);
  expect(animatics(1)).toHaveLength(1);
  // Sequence 1's final, asked for again under a fresh key, with the two rendered shots reused.
  expect(finals(1)).toHaveLength(2);
  retried = finals(1)[1]!;
  expect(retried.idempotencyKey).toBe(`${report.projectId}:crew-final-${animatics(1)[0]!.id}-retry-1`);
  expect([retried.status, retried.shotReuse?.shots.length]).toEqual(["done", 2]);
  const records = retried.output!.shotRenders!;
  const kept = JSON.parse(readFileSync(join(paths.artifactRoot, failed.projectId, failed.id, "clips", "manifest.json"), "utf8")) as { renderRecord: { shotId: string; files: { video: { sha256: string } } } }[];
  expect(records.slice(0, 2).map(record => [record.shotId, record.reusedFrom?.jobId, record.files.video.sha256]))
    .toEqual(kept.slice(0, 2).map(clip => [clip.renderRecord.shotId, failed.id, clip.renderRecord.files.video.sha256]));
  expect(records.slice(2).every(record => !record.reusedFrom)).toBe(true);
  // No provider call for a reused shot: the resume rendered sequence 1's other two shots and sequence 2's.
  const fresh = calls.slice(before.calls);
  expect(fresh.filter(prompt => before.rendered.includes(prompt))).toEqual([]);
  expect(fresh).toHaveLength(records.length - 2 + finals(2)[0]!.output!.shotRenders!.length);
  expect(ledger.monthSpend()).toBe(0);
  // Behind the front door, each reused shot is counted under the provider that rendered it, in the failed final.
  const { token } = JSON.parse(readFileSync(join(root, "f.token"), "utf8"));
  const view = async (path: string) => (await fetch(server.url.origin + path, { headers: { origin: server.url.origin, authorization: `Bearer ${token}` } })).json() as Promise<Record<string, any>>;
  const final = await view(`/api/jobs/${retried.id}`), sources = await reusedSources(final, view);
  expect([...sources.keys()]).toEqual([failed.id]);
  expect([shotProviders(final).unknown, shotProviders(final, sources)]).toEqual([2, { mock: records.length }]);
  // The record: the earlier steps kept, the resume's own entry, and the feature it finished.
  for (const key of ["readThrough", "plan", "roughCut", "secondsAt", "startedAt", "script", "tone"]) expect(report[key]).toEqual(stopped.report[key]);
  expect(report.resumes).toHaveLength(1);
  expect(report.resumes[0]).toMatchObject({ outcome: "completed", replaced: { outcome: "stopped", error: stopped.report.error },
    steps: { pitch: "kept", readThrough: "kept", plan: "kept", deskBeforeLook: "none", look: "kept", share: "made",
      sequences: [{ number: 1, roughCut: "kept", final: "retried", finalJobId: retried.id, retryOf: failed.id, reusedShots: 2, renderedShots: records.length - 2 },
        { number: 2, roughCut: "made", final: "made" }] } });
  expect(report.feature).toMatchObject({ joined: true, sequences: [{ number: 1, roughCut: animatics(1)[0]!.id }, { number: 2, roughCut: animatics(2)[0]!.id }] });
  expect(report.feature!.sequences.every(sequence => typeof sequence.film === "string" && sequence.finished)).toBe(true);
  const joined = store.all().find(job => job.stage === "feature-film")!;
  expect([report.final!.jobId, report.review!.jobId, joined.status]).toEqual([joined.id, joined.id, "done"]);
  expect(joined.featureFilm!.sequences.map(sequence => sequence.finalJobId)).toEqual([retried.id, finals(2)[0]!.id]);
  // No token or link in the record or on the terminal.
  for (const text of [readFileSync(out, "utf8"), resumed.stdout, resumed.stderr]) { expect(text).not.toContain(token); expect(text).not.toContain("#/review/"); }
}, 240000);

/**
 * Criterion 3: run again on the finished feature, `--resume` admits nothing. Each sequence is finished
 * again with the keys fixed by its film, the join is the same join, and the link already shared for it is
 * kept. A sequence's final still can't choose shots to render fresh.
 */
test("a second --resume of the finished feature admits no job and keeps the shared link", async () => {
  const jobs = store.all().length, before = calls.length;
  const again = await studioRun("--resume");
  expect([again.code, again.report.outcome]).toEqual([0, "completed"]);
  expect([store.all().length, calls.length]).toEqual([jobs, before]);
  expect(again.report.review).toEqual(resumed.report.review);
  expect(again.report.resumes).toHaveLength(2);
  expect(again.report.resumes[0]).toEqual(resumed.report.resumes[0]);
  expect(again.report.resumes[1].steps).toMatchObject({ look: "kept", share: "kept", sequences: [{ number: 1, roughCut: "kept", final: "kept" }, { number: 2, roughCut: "kept", final: "kept" }] });
  const { token, projectId } = JSON.parse(readFileSync(join(root, "f.token"), "utf8"));
  const forced = await fetch(`${server.url.origin}/api/projects/${projectId}/jobs`, { method: "POST", headers: { origin: server.url.origin, authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ stage: "final", animaticJobId: animatics(1)[0]!.id, sequence: 1, idempotencyKey: "forced", reuseUnchanged: true, forceShotIds: [retried.output!.shotRenders![0]!.shotId] }) });
  expect([forced.status, (await forced.json() as { error: string }).error]).toEqual([400, "Selective reuse applies to a whole film, not to a feature's sequence."]);
}, 240000);

/** Criterion 5: `--resume` refuses a record it can't carry on before it asks the studio anything. */
test("--resume refuses another script than the one the run pitched, before any request", async () => {
  const other = join(root, "other.fountain"), count = requests.length;
  writeFileSync(other, SCRIPT + "\nMara shuts the door.\n");
  const run = Bun.spawn(["bun", "scripts/studio-run.ts", "--base", server.url.origin, "--script", other, "--resume", "--out", out], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  const [code, stderr] = await Promise.all([run.exited, new Response(run.stderr).text()]);
  expect(code).not.toBe(0);
  expect(stderr).toContain("--resume needs the script the earlier run pitched");
  expect(requests.length).toBe(count);
}, 60000);
