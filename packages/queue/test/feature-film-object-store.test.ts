/**
 * HV-030-34 — a feature's join reads its sources from the object store and never hangs (Release 3).
 *
 * On staging (`HV_ARTIFACT_STORAGE=s3`) the first feature-film job sat claimed for an hour with an empty
 * scratch directory: `Bun.write(path, response)` never settles for the object store's streamed
 * Response. Here the worker joins three sequence films from an S3-compatible store on loopback, through
 * the real `PostgresArtifactStore.response` and Bun's own S3 client: a final (checked against the
 * store's record), a dialogue replacement (checked against its own recorded files) and the title graphic.
 * A source that is changed, short or missing fails the join and says which; a stalled one fails at the
 * job's abort or its deadline.
 */
import {afterAll, expect, test} from "bun:test";
import {mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {contentHash} from "../../generator/src/capabilities";
import {createFeatureFilmPlan} from "../../planner/src/feature-film";
import {processFeatureFilmJob} from "../src/feature-film-worker";
import type {Job} from "../src/index";
import type {WorkerContext} from "../src/worker";
import {objectStore, sha256} from "./fixtures/object-store";

const TMP = mkdtempSync(join(realpathSync(tmpdir()), "hv-feature-object-store-"));
afterAll(() => rmSync(TMP, {recursive: true, force: true}));
const run = (args: string[]) => {const result = Bun.spawnSync(args); if (result.exitCode) throw new Error(result.stderr.toString()); return new Uint8Array(result.stdout);};
const W = 320, H = 180, PROJECT = "p1", HEX = "a".repeat(64);

/** Two seconds of colour and tone as MP4 bytes, and its captions. */
const filmBytes = (color: string) => {
  const path = join(TMP, color + ".mp4");
  run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", `color=c=${color}:s=${W}x${H}:r=30:d=2`, "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100:duration=2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path]);
  return {mp4: new Uint8Array(readFileSync(path)), vtt: new TextEncoder().encode(`WEBVTT\n\n00:00:00.200 --> 00:00:00.900\n${color}\n`)};
};
const MEDIA = {films: ["blue", "green", "yellow"].map(filmBytes), title: (() => {
  const path = join(TMP, "title.mkv");
  run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", `color=c=red:s=80x40:r=30,format=rgba,pad=${W}:${H}:0:0:color=black@0`, "-frames:v", "30", "-c:v", "ffv1", "-pix_fmt", "bgra", path]);
  return new Uint8Array(readFileSync(path));
})()};

/**
 * A joinable feature kept in the object store: sequence 1 and 3's films are their finals, sequence 2's a
 * dialogue replacement that records its files, and an opening title graphic.
 */
function feature(name: string) {
  const root = join(TMP, name), store = objectStore(join(root, "cache")), published: string[] = [];
  store.artifacts.publishExport = async (_job, _worker, paths) => { published.push(...paths); };
  const jobs = new Map<string, Job>(), expires = new Date(Date.now() + 86_400_000).toISOString();
  const exportOf = (jobId: string) => ({mp4Path: `${PROJECT}/${jobId}/export/export.mp4`, hlsPlaylistPath: `${PROJECT}/${jobId}/export/hls/index.m3u8`,
    captionsPath: `${PROJECT}/${jobId}/export/captions.vtt`, manifestPath: `${PROJECT}/${jobId}/export/provenance.json`});
  const final = (number: number) => ({id: "final-" + number, projectId: PROJECT, stage: "final", status: "done", linkExpiresAt: expires, output: exportOf("final-" + number)}) as unknown as Job;
  const films = [1, 2, 3].map(number => {
    const media = MEDIA.films[number - 1]!, base = final(number);
    if (number !== 2) {
      store.put(PROJECT, base.id, base.output!.mp4Path, media.mp4); store.put(PROJECT, base.id, base.output!.captionsPath, media.vtt);
      jobs.set(base.id, base); return base;
    }
    const output = exportOf("dialogue-2"), files = [store.put(PROJECT, "dialogue-2", output.mp4Path, media.mp4), store.put(PROJECT, "dialogue-2", output.captionsPath, media.vtt)];
    const film = {id: "dialogue-2", projectId: PROJECT, stage: "dialogue-replacement", status: "done", linkExpiresAt: expires, dialogueReplacement: {source: base},
      output: {...output, dialogue: {revision: HEX, report: {}, wavPath: `${PROJECT}/dialogue-2/export/dialogue.wav`, files}}} as unknown as Job;
    jobs.set(film.id, film); return film;
  });
  const masterPath = `${PROJECT}/title-1/graphic-x/master.mkv`, graphicOutput = {masterPath, files: [store.put(PROJECT, "title-1", masterPath, MEDIA.title)]};
  jobs.set("title-1", {id: "title-1", projectId: PROJECT, stage: "motion-graphic", status: "done", graphicOutput} as unknown as Job);
  const plan = createFeatureFilmPlan({planRevision: HEX, scriptVersion: 1, storage: "s3", requestHash: HEX, width: W, height: H,
    sequences: films.map((film, index) => ({number: index + 1, firstScene: index + 1, lastScene: index + 1, finalJobId: "final-" + (index + 1), filmJobId: film.id})),
    films: films.map((film, index) => ({number: index + 1, job: film, outputRevision: contentHash(film.output)})),
    title: {jobId: "title-1", outputRevision: contentHash(graphicOutput), masterPath, frames: 30, width: W, height: H}, credits: null});
  const job = {id: "feature-1", projectId: PROJECT, stage: "feature-film", status: "running", featureFilm: plan, costCapUsd: 0, budgetReservedUsd: 0, timeoutMs: 4 * 3_600_000} as unknown as Job;
  const queue = {heartbeat: async () => {}, get: async (id: string) => jobs.get(id) ?? null,
    complete: async (_id: string, _worker: string, output: NonNullable<Job["output"]>) => ({...job, status: "done", output}) as Job};
  const context = {artifacts: store.artifacts} as unknown as WorkerContext, artifactRoot = join(root, "artifacts");
  /** The worker's own call, with the worker's clock; `deadline` defaults to the job's 4 hours. */
  const join_ = (signal = new AbortController().signal, deadline = Date.now() + job.timeoutMs) =>
    processFeatureFilmJob(job, queue as never, artifactRoot, context, "worker-3", 30_000, signal, Date.now, deadline);
  const scratch = () => readdirSync(artifactRoot).filter(entry => entry.startsWith(".feature-film-"));
  return {store, job, films, published, join: join_, scratch};
}
/** Settles `work` or says it is still pending after `ms`: a hang shows as a failed assertion, not a stuck run. */
const within = async <T>(work: Promise<T>, ms: number) => Promise.race([work.then(value => ({value}), (error: Error) => ({error: error.message})), Bun.sleep(ms).then(() => ({pending: ms}))]);

/** The join completes on the object store: every film, caption file and the title copied, checked and joined into one film. */
test("a feature joins from the object store, every source streamed and checked", async () => {
  const f = feature("joins");
  try {
    const result = await within(f.join(), 50_000);
    expect(result).toHaveProperty("value");
    const done = (result as {value: Job}).value;
    expect(done.status).toBe("done");
    // Three two-second films less two 0.4 s dissolves.
    expect(Math.abs(done.output!.featureFilm!.durationSec - 5.2)).toBeLessThan(0.15);
    expect(f.published.some(path => path.endsWith("/export.mp4"))).toBe(true);
    // Each of the seven sources was read from the store once, through Bun's S3 client, and the scratch copies are gone.
    expect(f.store.requests.filter(request => request.startsWith("GET ")).length).toBe(7);
    expect(f.scratch()).toEqual([]);
  } finally { f.store.close(); }
}, 60_000);

/** A changed, short or missing source fails the join with a message naming it; nothing is joined and the scratch is removed. */
test("a source that differs from its record, ends short or is missing fails the join and says which", async () => {
  const cases: [string, (f: ReturnType<typeof feature>) => void, string][] = [
    ["tampered", f => { const object = f.store.object(PROJECT, "dialogue-2", f.films[1]!.output!.mp4Path); object.served = object.served.map((byte, index) => index === 100 ? byte ^ 1 : byte); },
      "Sequence 2's film failed its checksum: the object store's bytes differ from its record."],
    ["re-recorded", f => { const row = f.store.rows.get(`${PROJECT}/dialogue-2|${f.films[1]!.output!.captionsPath}`)!; row.sha256 = sha256(new Uint8Array([1])); row.object_key = String(row.object_key).replace(/[0-9a-f]{64}/, String(row.sha256)); },
      "Sequence 2's caption file in the object store differs from its record."],
    ["short", f => { const object = f.store.object(PROJECT, "final-1", f.films[0]!.output!.mp4Path); object.served = object.served.slice(0, 1000); },
      `Sequence 1's film ended after 1000 of its ${MEDIA.films[0]!.mp4.byteLength} bytes.`],
    ["missing", f => { f.store.rows.delete(`${PROJECT}/final-3|${f.films[2]!.output!.captionsPath}`); }, "Sequence 3's caption file is missing from the object store."],
  ];
  for (const [name, change, message] of cases) {
    const f = feature(name);
    try {
      change(f);
      expect([name, await within(f.join(), 20_000)]).toEqual([name, {error: message}]);
      expect([name, f.published, f.scratch()]).toEqual([name, [], []]);
    } finally { f.store.close(); }
  }
}, 60_000);

/** A source whose stream stops part-way fails when the job is aborted, or at its deadline, instead of holding the lease for the job's 4 hours. */
test("a stalled source fails the join at the job's abort or deadline", async () => {
  const f = feature("stalled");
  try {
    f.store.object(PROJECT, "final-1", f.films[0]!.output!.mp4Path).stall = true;
    const lease = new AbortController(), lost = new Error("The worker lost the job's lease.");
    setTimeout(() => lease.abort(lost), 500);
    expect(await within(f.join(lease.signal), 10_000)).toEqual({error: lost.message});
    expect(f.scratch()).toEqual([]);
    const started = Date.now();
    expect(await within(f.join(undefined, Date.now() + 1_000), 10_000)).toEqual({error: "Sequence 1's film was still downloading from the object store when the job ran out of time."});
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(f.scratch()).toEqual([]);
  } finally { f.store.close(); }
}, 30_000);
