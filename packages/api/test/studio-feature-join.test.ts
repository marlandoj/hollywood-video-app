/**
 * HV-030-30 — a feature's sequences join into one film with one review link (Release 3 step 7,
 * G20-202610031349).
 *
 * The real studio flow against the real API and worker, on the mock providers: a three-sequence
 * feature is made sequence by sequence (HV-030-29), and after the last sequence's film the Editor joins
 * the three films into one `feature-film` job. That job is the feature's film: its length is the three
 * films' less a 0.4 s dissolve at each join, its sound runs unbroken, it records each sequence's final
 * in its plan and its provenance, it is signed with a C2PA sidecar when the host holds a key (a
 * throwaway one here), and the creator shares it with one review link, which a reviewer opens and
 * approves as the final. The join is refused when a sequence's film is missing, stale, of another
 * sequence, not a final's, or another project's, and a reel can't be joined at all.
 *
 * The second test runs where the pinned graphics browser is installed (HV_GRAPHICS_CHROME_PATH) and
 * checks the joined film's one opening title and one end credits as rendered.
 */
import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApiServer } from "../src/server";
import { ProjectService } from "../src/index";
import { REVIEW_VIEWER_HEADER } from "../src/review-views";
import { DurableJobStore } from "../../queue/src/index";
import { processNextJob, type WorkerContext } from "../../queue/src/worker";
import { CostLedger, OperatorReviewQueue } from "../../operator/src/index";
import { ReferenceBlobStore } from "../../storage/src/references";
import { verifyC2paSidecar } from "../../assembler/src/c2pa";
import { vttCues } from "../../assembler/src/feature-film";
import { makeC2paTestIdentity, withC2paEnv } from "../../assembler/test/c2pa-fixture";
// @ts-expect-error -- the studio is a plain browser module with no type declarations.
import { createStudioFlow, featureJoinKey, stepTitle } from "../../frontend/src/studio.js";
// @ts-expect-error -- a plain browser module.
import { CREDITS_FRAMES, TITLE_FRAMES } from "../../frontend/src/titles.js";
import { evenFeature } from "../../../test/fixtures/feature-script";

const SCRIPT = "Title: The Long Yard\nAuthor: Ana Ruiz\n\n" + evenFeature(3, 13);
const TMP = mkdtempSync(join(realpathSync(tmpdir()), "hv-feature-join-"));
const identity = makeC2paTestIdentity(join(TMP, "identity"));
const config = {HV_TOKEN_SECRET: "feature-join-fixture-secret-at-least-thirty-two-characters", HV_ANIMATIC_PROVIDER_POOL: '["mock"]', HV_PROVIDER_POOL: '["mock"]',
  HV_NARRATION: "0", HV_ANIMATIC_CAPTIONS: "0"};
const original = Object.fromEntries([...Object.keys(config), "HV_GRAPHICS_CHROME_PATH"].map(key => [key, process.env[key]]));
const CHROME = process.env.HV_GRAPHICS_CHROME_PATH;
afterAll(() => {
  rmSync(TMP, {recursive: true, force: true});
  for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const seconds = (path: string) => {
  const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-show_entries", "stream=codec_type,duration", "-show_entries", "format=duration", "-of", "json", path]);
  if (probe.exitCode) throw new Error(probe.stderr.toString());
  const info = JSON.parse(probe.stdout.toString()) as {format: {duration: string}; streams: {codec_type: string; duration?: string}[]};
  return {format: Number(info.format.duration), audio: Number(info.streams.find(stream => stream.codec_type === "audio")?.duration ?? NaN)};
};

/** A studio on its own data, a worker over it, and the creator's flow through the front door. */
async function studio(name: string, chromePath?: string) {
  const root = join(TMP, name), paths = {queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json"), artifactRoot: join(root, "artifacts"), costLedgerPath: join(root, "ledger.json")};
  Object.assign(process.env, config);
  if (chromePath) process.env.HV_GRAPHICS_CHROME_PATH = chromePath; else delete process.env.HV_GRAPHICS_CHROME_PATH;
  const server = createApiServer({port: 0, hostname: "127.0.0.1", ...paths, operatorDiagnosticsSecret: null, rateLimit: {api: {limit: 100000, windowMs: 60000}}, crewModel: null});
  const store = new DurableJobStore(paths.queuePath);
  const context: WorkerContext = {projects: new ProjectService(paths.statePath), ledger: new CostLedger(paths.costLedgerPath), references: new ReferenceBlobStore(paths.artifactRoot),
    reviewQueue: new OperatorReviewQueue(join(root, "reviews.json")), ...(chromePath ? {graphics: {chromePath}} : {})};
  const work = () => processNextJob(store, paths.artifactRoot, context);
  const base = server.url.origin, calls: {method: string; path: string; body: Record<string, unknown> | null}[] = [];
  const api = async (path: string, init: RequestInit = {}) => {
    calls.push({method: init.method ?? "GET", path, body: typeof init.body === "string" ? JSON.parse(init.body) : null});
    const response = await fetch(base + path, init), body = await response.json() as any;
    if (!response.ok) throw new Error(path + " " + response.status + " " + body.error);
    return body;
  };
  let project: {projectId: string; token: string} | undefined;
  const flow = createStudioFlow({api, getProject: () => project, setProject: (value: typeof project) => { project = value; }, wait: async () => { await work(); }});
  const owner = (path: string, method = "GET", body?: unknown) => fetch(base + path, {method, headers: {authorization: "Bearer " + project!.token, ...(body === undefined ? {} : {"content-type": "application/json"})},
    ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  return {server, store, paths, flow, calls, owner, project: () => project!, close: () => server.stop(true)};
}

/** Pitch a three-sequence feature with no music and make every sequence through to its film. */
async function makeFeature(flow: any) {
  await flow.pitch({script: SCRIPT, format: "feature", tone: "", rightsAttested: true});
  const sound = flow.state.readThrough.questions.find((question: {persona: string}) => question.persona === "sound");
  const look = await flow.plan([{id: sound.id, accepted: false, reply: "No music."}]);
  expect(look.sequences.map((sequence: {number: number; shots: number}) => [sequence.number, sequence.shots])).toEqual([[1, 13], [2, 13], [3, 13]]);
  let state = await flow.approveLook(true);
  for (const number of [1, 2, 3]) {
    state = await flow.approveRoughCut();
    if (number < 3) { expect(state.joined).toBeUndefined(); state = await flow.nextSequence(); }
  }
  return state;
}

test("three sequences join into one signed film the length of their films, recording each final, refused when a sequence is missing or stale, and shared with one review link", async () => {
  await withC2paEnv({key: identity.keyPath, cert: identity.chainPath}, async () => {
    const f = await studio("untitled");
    try {
      const state = await makeFeature(f.flow);
      const project = f.project(), jobs = await f.store.all(), finals = jobs.filter(job => job.stage === "final");
      expect(finals.map(job => job.sequence?.number)).toEqual([1, 2, 3]);
      // With "no music", no voice catalogue and no narration, each sequence's film is its final.
      const films = [1, 2, 3].map(number => state.finals[number].id);
      expect(films).toEqual(finals.map(job => job.id));

      // The Editor joined them into one film, untitled because this host has no graphics renderer.
      expect([state.step, state.joined, state.joinedTitled, state.final.stage, state.final.status]).toEqual(["final", true, false, "feature-film", "done"]);
      expect(stepTitle(state)).toBe("Approval 7 of 7: the whole feature, its 3 sequences joined into one film");
      expect(state.finishNotes).toContain("Editor: titles and credits were skipped because this studio has no graphics renderer installed; the feature is joined untitled.");
      const joined = (await f.store.get(state.final.id))!, plan = joined.featureFilm!;
      expect([joined.costUsd, joined.idempotencyKey]).toEqual([0, project.projectId + ":" + featureJoinKey([...films, "untitled", "untitled"])]);
      expect(jobs.some(job => job.stage === "picture-edit")).toBe(false);

      // The plan, the record and the job view each say which final and film each sequence is, under the current split.
      const saved = JSON.parse(readFileSync(f.paths.statePath, "utf8")).projects.find((value: {id: string}) => value.id === project.projectId);
      const sequences = [1, 2, 3].map(number => ({number, firstScene: number, lastScene: number, finalJobId: finals[number - 1]!.id, filmJobId: films[number - 1]}));
      expect([plan.planRevision, plan.sequences, plan.title, plan.credits, plan.width, plan.height]).toEqual([saved.sequences.revision, sequences, null, null, 1280, 720]);
      // HV-034-02: every joined sequence's final read the feature's style bible, and the join records which.
      expect(plan.bibleRevision).toBe(saved.styleBible.revision);
      expect(finals.map(value => value.sequence!.bibleRevision)).toEqual([1, 2, 3].map(() => saved.styleBible.revision));
      const record = JSON.parse(readFileSync(join(f.paths.artifactRoot, joined.output!.manifestPath), "utf8"));
      expect(record).toMatchObject({spec: "hv-feature-film-result/1", projectId: project.projectId, planRevision: plan.revision,
        join: {schema: "hv-feature-join/1", planRevision: saved.sequences.revision, scriptVersion: joined.scriptVersion, sequences}, title: null, credits: null, crossfadeSec: 0.4});
      const view = await (await f.owner("/api/jobs/" + joined.id)).json() as any;
      expect(view.featureFilm).toMatchObject({planRevision: saved.sequences.revision, sequences, title: null, credits: null});
      expect(JSON.stringify(view)).not.toContain("Mara carries crate");

      // One film, the length of the three less a 0.4 s dissolve at each of the two joins, its sound unbroken,
      // each film's captions at its place.
      const lengths = finals.map(job => seconds(join(f.paths.artifactRoot, job.output!.mp4Path)).format), whole = seconds(join(f.paths.artifactRoot, joined.output!.mp4Path));
      const expected = lengths.reduce((sum, value) => sum + value, 0) - 0.8;
      expect(Math.abs(whole.format - expected)).toBeLessThan(0.15);
      expect(Math.abs(whole.audio - whole.format)).toBeLessThan(0.1);
      expect(Math.abs(joined.output!.featureFilm!.durationSec - expected)).toBeLessThan(0.01);
      expect(record.films.map((film: {startSec: number}) => film.startSec)).toEqual([0, Number((lengths[0]! - 0.4).toFixed(3)), Number((lengths[0]! + lengths[1]! - 0.8).toFixed(3))]);
      const ownCues = finals.map(job => vttCues(readFileSync(join(f.paths.artifactRoot, job.output!.captionsPath), "utf8")).length);
      expect(vttCues(readFileSync(join(f.paths.artifactRoot, joined.output!.captionsPath), "utf8")).length).toBeLessThanOrEqual(ownCues.reduce((sum, value) => sum + value, 0));

      // Signed like every other export, bound to the very film the reviewer is served.
      const directory = join(f.paths.artifactRoot, dirname(joined.output!.manifestPath)), mp4 = join(f.paths.artifactRoot, joined.output!.mp4Path);
      expect(joined.output!.c2paPath).toBe(dirname(joined.output!.manifestPath) + "/provenance.c2pa");
      const sidecar = readFileSync(join(directory, "provenance.c2pa"));
      expect(record.credentials).toMatchObject({type: "c2pa-sidecar", sidecar: {name: "provenance.c2pa", sha256: sha(sidecar)}});
      const verified = await verifyC2paSidecar(mp4, sidecar, identity.anchorPem);
      expect({state: verified.state, codes: verified.codes}).toEqual({state: "Trusted", codes: []});
      expect(verified.provenance).toMatchObject({spec: "hv-feature-film-result/1", projectId: project.projectId, mp4Sha256: sha(readFileSync(mp4))});

      // The join is refused, before anything is admitted, when a sequence is missing, stale or not what it claims.
      const route = `/api/projects/${project.projectId}/feature-film`, before = (await f.store.all()).length;
      const join_ = async (ids: string[], extra: Record<string, unknown> = {}) => {
        const answer = await f.owner(route, "POST", {idempotencyKey: crypto.randomUUID(), generationApproved: true, sequences: ids.map((jobId, index) => ({number: index + 1, jobId})), title: null, credits: null, ...extra});
        return [answer.status, (await answer.json() as {error?: string}).error ?? null];
      };
      expect(await join_(films.slice(0, 2))).toEqual([409, "Sequence 3 has no film to join. Make its final before joining the feature."]);
      expect(await join_([films[1]!, films[0]!, films[2]!])).toEqual([409, "The film named as sequence 1 is sequence 2's."]);
      const roughCut = jobs.find(job => job.stage === "animatic" && job.sequence?.number === 1)!;
      expect(await join_([roughCut.id, films[1]!, films[2]!])).toEqual([409, "Sequence 1's film isn't made from one of this feature's sequence finals."]);
      expect(await join_(["not-a-job", films[1]!, films[2]!])).toEqual([409, "Sequence 1's film isn't one of this project's films."]);
      expect(await join_(films, {title: films[0]})).toEqual([409, "The feature's opening title must be a finished title graphic of this project."]);
      // A film from another project, and a reel, which can't be joined at all.
      const other = await studio("other");
      try {
        await other.flow.pitch({script: "INT. ROOM - DAY\n\nMara waits.", format: "reel", tone: "", rightsAttested: true});
        await other.flow.plan([]);
        const elsewhere = (await other.flow.approveLook(true)).animatic.id;
        expect(await join_([elsewhere, films[1]!, films[2]!])).toEqual([409, "Sequence 1's film isn't one of this project's films."]);
        const reel = await other.owner(`/api/projects/${other.project().projectId}/feature-film`, "POST", {idempotencyKey: crypto.randomUUID(), generationApproved: true, sequences: [{number: 1, jobId: elsewhere}], title: null, credits: null});
        expect([reel.status, (await reel.json() as {error: string}).error]).toEqual([409, "Only a feature the Showrunner split into sequences is joined into one film."]);
      } finally { await other.close(); }
      // A stale final: sequence 2's rough cut is sent back after its film was made.
      const roughCut2 = jobs.find(job => job.id === finals[1]!.animaticJobId)!;
      expect((await f.owner(`/api/projects/${project.projectId}/animatic/decision`, "POST", {animaticJobId: roughCut2.id, decision: "changes_requested"})).status).toBe(201);
      expect(await join_(films)).toEqual([409, "Sequence 2's final is stale: the screenplay, the cast, the shot directions or its rough cut's approval changed after it was made. Make its rough cut and final again."]);
      expect((await f.owner(`/api/projects/${project.projectId}/animatic/decision`, "POST", {animaticJobId: roughCut2.id, decision: "approved"})).status).toBe(201);
      // Nothing was admitted by a refused join, and the studio's own key is the same join.
      expect((await f.store.all()).length).toBe(before);
      const again = await f.owner(route, "POST", f.calls.find(call => call.method === "POST" && call.path === route)!.body);
      expect([again.status, await again.json()]).toEqual([202, {jobId: joined.id, admitted: false}]);
      const quote = await (await f.owner(route)).json() as any;
      expect(quote).toMatchObject({planRevision: saved.sequences.revision, size: {width: 1280, height: 720}, crossfadeFrames: 12, costUsd: 0,
        sequences: finals.map((final, index) => ({number: index + 1, final: {jobId: final.id}})), jobs: [{jobId: joined.id, status: "done"}]});

      // One review link, bound to the joined film; the reviewer opens it and approves it as the final.
      const shared = await f.flow.share(2);
      const links = (await (await f.owner(`/api/projects/${project.projectId}/reviews`)).json() as {links: {jobId: string; permission: string}[]}).links;
      expect(links.map(link => [link.jobId, link.permission])).toEqual([[joined.id, "approve"]]);
      const token = shared.reviewUrl.split("/review/")[1], viewer = {[REVIEW_VIEWER_HEADER]: "feature-join-reviewer-device-01"};
      const opened = await (await fetch(new URL("/api/reviews/" + token, f.server.url), {headers: viewer})).json() as any;
      expect([opened.jobId, opened.stage]).toEqual([joined.id, "feature-film"]);
      expect(opened.output.c2paUrl).toContain("/artifacts/");
      expect((await fetch(new URL(opened.output.mp4Url, f.server.url))).status).toBe(200);
      const decided = await fetch(new URL("/api/reviews/" + token + "/decision", f.server.url), {method: "POST", headers: {"content-type": "application/json", ...viewer}, body: JSON.stringify({decision: "approved"})});
      expect(decided.status).toBe(200);
      const stages = (await (await f.owner(`/api/projects/${project.projectId}/reviews`)).json() as {links: {decisionStage: string | null}[]}).links;
      expect(stages.map(link => link.decisionStage)).toEqual(["final"]);
    } finally { await f.close(); }
  });
}, 600000);

const chromeTest = CHROME ? test : test.skip;
chromeTest("with the graphics renderer, the joined feature carries one opening title and one end credits", async () => {
  const f = await studio("titled", CHROME);
  try {
    const state = await makeFeature(f.flow);
    expect([state.joined, state.joinedTitled]).toEqual([true, true]);
    const joined = (await f.store.get(state.final.id))!, plan = joined.featureFilm!, all = await f.store.all();
    const title = all.find(job => job.id === plan.title?.jobId)!, credits = all.find(job => job.id === plan.credits?.jobId)!;
    expect([title.graphicRender!.spec.id, (title.graphicRender!.spec.plan as {kind: string}).kind, plan.title!.frames]).toEqual(["crew-title", "title", TITLE_FRAMES]);
    expect([credits.graphicRender!.spec.id, (credits.graphicRender!.spec.plan as {kind: string}).kind, plan.credits!.frames]).toEqual(["crew-credits", "credits", CREDITS_FRAMES]);
    expect(all.filter(job => job.graphicRender)).toHaveLength(2);
    const rows = (credits.graphicRender!.spec.plan as {credits: {role: string; name: string}[]}).credits;
    expect(rows[0]).toEqual({role: "Written by", name: "Ana Ruiz"});
    expect(rows).toContainEqual({role: "Sequences by", name: "Showrunner (AI crew)"});
    expect((title.graphicRender!.spec.plan as {text: string}).text).toBe("The Long Yard");
    // The films less the dissolves, plus the credits' six seconds.
    const finals = all.filter(job => job.stage === "final"), lengths = finals.map(job => seconds(join(f.paths.artifactRoot, job.output!.mp4Path)).format);
    const whole = seconds(join(f.paths.artifactRoot, joined.output!.mp4Path));
    expect(Math.abs(whole.format - (lengths.reduce((sum, value) => sum + value, 0) - 0.8 + CREDITS_FRAMES / 30))).toBeLessThan(0.15);
    expect(JSON.parse(readFileSync(join(f.paths.artifactRoot, joined.output!.manifestPath), "utf8"))).toMatchObject({title: {jobId: title.id}, credits: {jobId: credits.id}, creditsSec: CREDITS_FRAMES / 30});
    await f.flow.share(1);
    expect(f.calls.filter(call => call.path.endsWith("/reviews") && call.method === "POST").map(call => call.body!.jobId)).toEqual([joined.id]);
  } finally { await f.close(); }
}, 900000);
