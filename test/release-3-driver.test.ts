import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { reviewTimecode } from "../packages/api/src/review-comments";
import { parseFountain } from "../packages/parser/src/index";
import { editCmx3600, editOtio, type EditInterchangeCut } from "../packages/planner/src/edit-interchange";
import { greedySequences, sceneShotCounts } from "../packages/planner/src/sequences";
import type { LinesReading } from "../scripts/release-2-run";
import { RELEASE_3_PARTS, parseArguments, runRelease3, shotProviders, type FeatureStudioReport, type Release3Options } from "../scripts/release-3-run";
import { gateEntries, realContext, release3Problems, type Context } from "./release-3-contract";

/**
 * HV-030-31: the two drivers of Release 3's run, against a fake studio. No network beyond this
 * process, no staging and no spend.
 *
 * `scripts/studio-run.ts --format feature` is run as the operator runs it, in its own process, against
 * a fake HTTP server that answers the front door's routes for a three-sequence feature.
 * `scripts/release-3-run.ts` is called directly against a fake of the desk's routes holding the real
 * screenplay's ten sequences, and its record is held to the contract. The fake tokens are shaped like
 * the real ones, so a token that leaks into a report is caught.
 */
const REPO = resolve(import.meta.dir, "..");
const UUID = (n: number) => "00000000-0000-4000-8000-" + n.toString(16).padStart(12, "0");
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const secret = (name: string) => Buffer.from(JSON.stringify({ kind: name, nonce: name })).toString("base64url") + "." + sha(name).slice(0, 43);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const scratch = mkdtempSync(join(tmpdir(), "hv-release-3-"));
const mode = (path: string) => statSync(path).mode & 0o777;

// ---------------------------------------------------------------------------------------------
// The front door: scripts/studio-run.ts --format feature, three sequences.
// ---------------------------------------------------------------------------------------------
const F = { project: UUID(0xf1), token: secret("feature-project"), review: secret("feature-review"), join: UUID(0xf9), wren: UUID(0xc1), sheet: UUID(0xc9) };
const BIBLE = sha("bible"), SPLIT = sha("split");
const front = { calls: [] as { method: string; path: string; body: any }[], joinFails: false };
const SEQS = [{ number: 1, firstScene: 1, lastScene: 2, shots: 20 }, { number: 2, firstScene: 3, lastScene: 4, shots: 22 }, { number: 3, firstScene: 5, lastScene: 6, shots: 18 }];
const roughOf = (n: number) => UUID(0xa00 + n), finalOf = (n: number) => UUID(0xb00 + n);
const sequenceRef = (n: number) => ({ number: n, of: 3, firstScene: SEQS[n - 1]!.firstScene, lastScene: SEQS[n - 1]!.lastScene, planRevision: SPLIT, bibleRevision: BIBLE });
let frontServer: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  frontServer = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname, method = request.method, root = `/api/projects/${F.project}`;
    const body = method === "GET" ? undefined : await request.json().catch(() => undefined);
    front.calls.push({ method, path, body });
    if (method === "POST" && path === "/api/projects") return json({ projectId: F.project, token: F.token }, 201);
    if (request.headers.get("authorization") !== `Bearer ${F.token}`) return json({ error: "unauthorized" }, 401);
    const locked = front.calls.some(call => call.path.endsWith("/reference-lock")), adopted = front.calls.some(call => call.path.endsWith("/adopt"));
    const casting = () => ({ version: locked ? 4 : adopted ? 3 : front.calls.some(call => call.path.endsWith("/approve-cast")) ? 2 : 1,
      characters: [{ id: F.wren, name: "WREN", kind: "original-fictional", permission: { status: front.calls.some(call => call.path.endsWith("/approve-cast")) ? "permitted" : "pending" },
        references: adopted ? [{ id: UUID(0xe1) }, { id: UUID(0xe2) }] : [], ...(locked ? { referenceLock: { revision: sha("lock"), assets: [{ id: UUID(0xe1) }, { id: UUID(0xe2) }] } } : {}) }] });
    if (method === "PUT" && path === root + "/script") return json({ version: 1 });
    if (method === "POST" && path === root + "/rights") return json({ rightsAttestedAt: "2026-10-04T00:00:00.000Z" });
    if (method === "POST" && path === root + "/crew/read-through")
      return json({ schema: "hv-crew-read-through/1", source: "stand-in", crewSpend: { usd: 0, alerts: [] }, expected: { scriptVersion: 1, castingVersion: 0, directionVersion: 0 },
        facts: { format: "feature", scenes: 6, shots: 60, estimatedRuntimeSec: 120, formatLimitSec: 1200, characters: ["WREN"], estimate: { videoSpec: "fal:kling-v2.5-turbo-pro", basis: "reference", finalVideoUsd: 21 }, concerns: [] },
        questions: [{ id: "q1", persona: "director", question: "Pace?", proposal: "Slow" }] });
    if (method === "POST" && path === root + "/crew/plan")
      return json({ schema: "hv-crew-plan-result/1", source: "stand-in", notes: [], addedCharacters: 1, directedShots: 60, crewSpend: { usd: 0, alerts: [] }, finalAnchors: false, voices: [],
        sequences: { source: "stand-in", revision: SPLIT, sequences: SEQS.map(s => ({ ...s, bibleRevision: BIBLE })) },
        styleBible: { kept: false, source: "stand-in", dropped: [], bible: { revision: BIBLE, version: 1 } } });
    if (method === "GET" && path === root + "/cast") return json({ casting: casting() });
    if (method === "GET" && path === root + "/spend") return json({ spentUsd: 0, heldUsd: 0, capUsd: 150, sequences: [] });
    if (method === "POST" && path === root + "/crew/approve-cast") return body.expectedVersion === 1 ? json({ casting: casting() }) : json({ error: "The cast changed." }, 409);
    if (method === "POST" && path === `${root}/cast/${F.wren}/sheets`) return json({ jobId: F.sheet }, 202);
    if (method === "GET" && path === `${root}/cast/${F.wren}/sheets`) return json({ jobs: [{ id: F.sheet, status: "done", storyboard: [{ shotId: "front" }, { shotId: "side" }] }] });
    if (method === "POST" && path === `${root}/cast/${F.wren}/sheets/${F.sheet}/adopt`) return json({ casting: casting() });
    if (method === "PUT" && path === `${root}/cast/${F.wren}/reference-lock`) return json({ casting: { ...casting(), version: 4,
      characters: [{ ...casting().characters[0], referenceLock: { revision: sha("lock"), assets: body.lock.assetIds.map((id: string) => ({ id })) } }] } });
    if (method === "GET" && path === root + "/direction") return json({ direction: { version: 3 } });
    if (method === "POST" && path === root + "/direction/continuity/repair")
      return json({ report: { scenes: [{ findings: [{ code: "look-changed" }] }], boundaries: [{ from: 1, to: 2 }, { from: 2, to: 3 }] }, proposal: { edits: [{ shotId: "s3", field: "keyLight", value: "lamp" }], refused: [] }, scriptVersion: 1, summary: "Held." });
    if (method === "POST" && path === root + "/direction/continuity/repair/accept") return json({ direction: { version: 4 } });
    if (method === "POST" && path === root + "/jobs") return json({ jobId: body.stage === "final" ? finalOf(body.sequence) : roughOf(body.sequence), admitted: true }, 202);
    if (method === "GET" && path.startsWith("/api/jobs/")) {
      const id = path.split("/").at(-1)!;
      if (id === F.join) return json({ id, status: "done", stage: "feature-film", outputRevision: "j1", output: {} });
      const n = [1, 2, 3].find(k => id === roughOf(k) || id === finalOf(k))!;
      return json({ id, status: "done", stage: id === roughOf(n) ? "animatic" : "final", sequence: sequenceRef(n), outputRevision: "r" + n, output: {} });
    }
    if (method === "POST" && path === root + "/animatic/decision") return json({ accepted: true });
    if (method === "GET" && path === root + "/feature-film") return json({ size: { width: 1280, height: 720 }, sequences: SEQS.map(s => ({ ...s, final: { jobId: finalOf(s.number), frames: 600 } })), jobs: [] });
    if (method === "GET" && path === root + "/graphics") return json({ rendering: { available: false }, library: { version: 1 }, graphics: [] });
    if (method === "POST" && path === root + "/feature-film") return front.joinFails ? json({ error: "A sequence's final is stale." }, 409) : json({ jobId: F.join, admitted: true }, 202);
    if (method === "POST" && path === root + "/reviews") return json({ token: F.review, reviewUrl: "http://studio.test/#/review/" + F.review, maxViews: body.maxViews, permission: "approve" }, 201);
    if (method === "GET" && path === root + "/reviews") return json({ links: [{ id: sha(F.review), jobId: F.join, maxViews: 3, permission: "approve", views: 0 }], stages: [] });
    return json({ error: "not found" }, 404);
  } });
});

const studioRun = async (...args: string[]) => {
  const run = Bun.spawn(["bun", "scripts/studio-run.ts", "--base", `http://127.0.0.1:${frontServer.port}`, ...args], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
  return { code, stdout, stderr };
};
const SCRIPT = "docs/evidence/release-3/scripts/feature.fountain";

describe("studio-run.ts --format feature at the front door", () => {
  /** The look once, each sequence's rough cut and final in turn, the join, and one shared film; the desk steps before the look. */
  test("a feature is locked and repaired before its look, made sequence by sequence, joined, and the one joined film shared", async () => {
    front.calls.length = 0; front.joinFails = false;
    const out = join(scratch, "feature.json");
    const run = await studioRun("--script", SCRIPT, "--format", "feature", "--lock", "WREN", "--continuity-repair", "--share", "3", "--out", out);
    expect(run.code).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8"));
    const index = (match: (call: { method: string; path: string; body: any }) => boolean) => front.calls.findIndex(match);
    const firstRender = index(call => call.method === "POST" && call.path.endsWith("/jobs"));
    // The desk steps come before the first render, the cast is approved once, with the version the plan read, and the repair is applied as shown.
    expect(index(call => call.path.endsWith("/reference-lock"))).toBeLessThan(firstRender);
    expect(index(call => call.path.endsWith("/repair/accept"))).toBeLessThan(firstRender);
    expect(front.calls.filter(call => call.path.endsWith("/approve-cast"))).toHaveLength(1);
    expect(front.calls.find(call => call.path.endsWith("/repair/accept"))!.body).toEqual({ edits: [{ shotId: "s3", field: "keyLight", value: "lamp" }], expectedVersion: 3, expectedScriptVersion: 1 });
    expect(report.deskBeforeLook).toMatchObject({ surface: "desk-api", castApproved: true, locks: [{ characterId: F.wren, name: "WREN", revision: sha("lock"), assets: 2, sheetJobId: F.sheet }],
      continuity: { findings: 1, edits: 1, applied: true, boundaries: 2 } });
    // Each sequence's rough cut, then its final, in order, each naming its sequence.
    const renders = front.calls.filter(call => call.method === "POST" && call.path.endsWith("/jobs")).map(call => [call.body.stage ?? "animatic", call.body.sequence]);
    expect(renders).toEqual([["animatic", 1], ["final", 1], ["animatic", 2], ["final", 2], ["animatic", 3], ["final", 3]]);
    expect(report.feature).toEqual({ joined: true, titled: false, unscored: [1, 2, 3],
      sequences: [1, 2, 3].map(n => ({ number: n, roughCut: roughOf(n), film: finalOf(n), spend: expect.anything(), finished: expect.objectContaining({ scored: false }) })) });
    expect(front.calls.find(call => call.method === "POST" && call.path.endsWith("/feature-film"))!.body.sequences).toEqual([1, 2, 3].map(n => ({ number: n, jobId: finalOf(n) })));
    // The one film shared is the joined feature.
    expect(report.final.jobId).toBe(F.join);
    expect(front.calls.find(call => call.method === "POST" && call.path.endsWith("/reviews"))!.body).toEqual({ permission: "approve", jobId: F.join, expectedOutputRevision: "j1", maxViews: 3 });
    expect(report.review).toEqual({ linkId: sha(F.review), jobId: F.join, maxViews: 3, permission: "approve" });
    // The read-through's quote, the Showrunner's split and the style bible, by revision.
    expect(report.readThrough.facts).toEqual({ format: "feature", scenes: 6, shots: 60, estimatedRuntimeSec: 120, formatLimitSec: 1200, estimate: { videoSpec: "fal:kling-v2.5-turbo-pro", basis: "reference", finalVideoUsd: 21 } });
    expect(report.plan.sequences).toEqual({ source: "stand-in", revision: SPLIT, sequences: SEQS.map(s => ({ ...s, bibleRevision: BIBLE })) });
    expect(report.plan.styleBible).toEqual({ kept: false, source: "stand-in", revision: BIBLE, version: 1, dropped: 0 });
    // The link and the token stay in their own private files.
    const text = readFileSync(out, "utf8");
    for (const key of [F.token, F.review]) { expect(text).not.toContain(key); expect(run.stdout + run.stderr).not.toContain(key); }
    expect(mode(join(scratch, "feature.review"))).toBe(0o600);
    expect(mode(join(scratch, "feature.token"))).toBe(0o600);
  });

  /**
   * HV-030-33: this studio has no sound route, so no sequence's score can be mixed. Each sequence's
   * report says what its finishing did and why the score failed, the run names the unscored sequences
   * in its report and on stderr, and the joined film's notes name each earlier sequence left without
   * music. Before, the report kept only the last sequence's notes, and nothing said sequences 1 and 2
   * had no score.
   */
  test("a sequence the Composer couldn't score is named in the run's report, on stderr and in the joined film's notes", async () => {
    front.calls.length = 0; front.joinFails = false;
    const run = await studioRun("--script", SCRIPT, "--format", "feature", "--out", join(scratch, "unscored.json"));
    expect(run.code).toBe(0);
    const report = JSON.parse(readFileSync(join(scratch, "unscored.json"), "utf8"));
    const failed = "Composer: the score could not be mixed (/api/projects/:id/sound-mixes/:id -> 404 not found); the film is shared without music.";
    expect(report.feature.unscored).toEqual([1, 2, 3]);
    for (const sequence of report.feature.sequences) {
      expect(sequence.finished).toEqual({ voiced: false, scored: false, ambience: false, notes: expect.arrayContaining([failed]) });
      expect(sequence.finished.notes.some((note: string) => note.startsWith("Editor:"))).toBe(false);
    }
    expect(run.stderr).toContain("studio-run: 3 of 3 sequence(s) were not scored: 1, 2, 3");
    expect(report.finishNotes).toEqual(expect.arrayContaining(["Sequence 1 of 3: " + failed, "Sequence 2 of 3: " + failed, failed]));
    expect(report.finishNotes.some((note: string) => note.startsWith("Sequence 3 of 3"))).toBe(false);
  });

  /** A join that stops is a stopped run, never the last sequence shared as the feature. */
  test("a feature whose sequences are not joined stops before anything is shared", async () => {
    front.calls.length = 0; front.joinFails = true;
    const run = await studioRun("--script", SCRIPT, "--format", "feature", "--share", "3", "--out", join(scratch, "unjoined.json"));
    expect(run.code).toBe(1);
    const report = JSON.parse(readFileSync(join(scratch, "unjoined.json"), "utf8"));
    expect(report.outcome).toBe("stopped");
    expect(report.error).toContain("The sequences were not joined into one film");
    expect(front.calls.some(call => call.method === "POST" && call.path.endsWith("/reviews"))).toBe(false);
    front.joinFails = false;
  });
});

// ---------------------------------------------------------------------------------------------
// The desk: scripts/release-3-run.ts, over the real screenplay's ten sequences.
// ---------------------------------------------------------------------------------------------
const parsed = parseFountain(readFileSync(resolve(REPO, SCRIPT), "utf8"));
const SPLIT10 = greedySequences(sceneShotCounts(parsed));
const D = { project: UUID(0xd1), token: secret("desk-project"), operator: secret("operator"), artifact: secret("artifact"), film: UUID(0xd9), title: UUID(0xda), credits: UUID(0xdb),
  hero: UUID(0xdc), link: sha("desk-link"), results: sha("results"), wren: UUID(0xc1), oswin: UUID(0xc2) };
const final10 = (n: number) => UUID(0x1000 + n), film10 = (n: number) => UUID(0x2000 + n), rough10 = (n: number) => UUID(0x3000 + n);
const FAL = "fal:kling-o3-standard-keyframes";
const X = 0.4;
let offset = 0;
const STARTS = SPLIT10.map((s, i) => { const start = { number: i + 1, startSec: Number(offset.toFixed(3)), durationSec: s.shots * 5 }; offset += s.shots * 5 - X; return start; });
const FILM_SEC = SPLIT10.reduce((t, s) => t + s.shots * 5, 0) - X * (SPLIT10.length - 1);
const SIDECAR = new TextEncoder().encode("signed feature sidecar");
const MANIFEST = { spec: "hv-feature-film-result/1", films: STARTS.map(s => ({ durationSec: s.durationSec, startSec: s.startSec, sha256: sha("film" + s.number), audio: true })), crossfadeSec: X,
  creditsSec: 6, durationSec: FILM_SEC + 6, bibleRevision: BIBLE, credentials: { type: "c2pa-sidecar", sidecar: { name: "provenance.c2pa", sha256: sha(SIDECAR) } } };
const frameIn = (n: number, seconds: number) => Math.round((STARTS[n - 1]!.startSec + seconds) * 30);
const COMMENTS = [[1, 3], [4, 10], [9, 20]].map(([n, s], i) => ({ id: UUID(0xe00 + i), frame: frameIn(n!, s!), timecode: reviewTimecode(frameIn(n!, s!)), text: "Note " + i, viewer: 1, at: "2026-10-04T00:00:00.000Z", resolvedAt: null }));
const CUT: EditInterchangeCut = { schema: "hv-edit-interchange/1", sequenceId: "feature-cut", label: "The Tide Clock", historyRevision: sha("history"), timelineRevision: sha("timeline"), fps: 30, frames: 300, width: 1280, height: 720,
  layers: [{ layer: 0, clips: [1, 2].map(n => ({ clipId: "clip-" + n, sourceId: "source-" + n, jobId: film10(n), stage: "sound-mix", sourceRevision: sha("source" + n), label: "Sequence " + n,
    sourceFrames: 300, recordIn: (n - 1) * 150, recordOut: n * 150, sourceIn: 0, sourceOut: 150, dissolveIn: null })) }], markers: [], notCarried: [] };
interface DeskState { identity: boolean; hero: boolean; boundaries: boolean; comments: boolean; vendor: boolean; unscored: number | null; calls: { method: string; path: string }[] }
const desk: DeskState = { identity: true, hero: true, boundaries: true, comments: true, vendor: false, unscored: null, calls: [] };
/** A sequence's film: the Composer's mix of its final, or, for the sequence whose score failed, the final itself. */
const filmOf = (n: number) => desk.unscored === n ? final10(n) : film10(n);
const finalJob = (n: number) => {
  const shots = SPLIT10[n - 1]!.shots, ids = Array.from({ length: shots }, (_, i) => `shot-${n}-${i + 1}`);
  return { id: final10(n), projectId: D.project, stage: "final", status: "done", animaticJobId: rough10(n), sequence: { number: n, of: SPLIT10.length, bibleRevision: BIBLE },
    providerPlan: { strategy: "quality", quality: { resultsSha256: D.results, fallback: null } },
    // A shot tried on one lane and failed over to the next: the last decision that selected one is the one rendered.
    routeDecisions: ids.flatMap((shotId, i) => [...(i === 0 ? [{ shotId, selectedId: "fal:kling-v2.5-turbo-pro" }] : []), { shotId, selectedId: desk.vendor && n === 3 && i < 2 ? "othervendor:video-1" : FAL }]),
    shotRenders: ids.map(shotId => ({ shotId })), cameraPathRenders: n === 2 ? [{ shotId: ids[0], applied: "local-crop", reason: "provider-has-no-native-camera" }] : [] };
};
let deskServer: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  deskServer = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url), path = url.pathname, method = request.method;
    desk.calls.push({ method, path });
    if (path.startsWith(`/artifacts/${D.artifact}/`)) return path.endsWith(".c2pa") ? new Response(SIDECAR) : path.endsWith(".mp4") ? new Response("mp4 bytes") : json(MANIFEST);
    const auth = request.headers.get("authorization");
    if (path === "/api/operator/status") return auth === `Bearer ${D.operator}` ? json({ database: { value: { budget: { recordedMonthUsd: 120 } } }, costs: { value: { byProvider: [{ provider: "fal", monthUsd: 95 }] } } }) : json({ error: "unauthorized" }, 401);
    if (auth !== `Bearer ${D.token}`) return json({ error: "unauthorized" }, 401);
    if (path === `/api/jobs/${D.film}`) return json({ id: D.film, stage: "feature-film", status: "done", captionLanguage: "en",
      featureFilm: { sequences: SPLIT10.map((s, i) => ({ number: i + 1, firstScene: s.firstScene, lastScene: s.lastScene, finalJobId: final10(i + 1), filmJobId: filmOf(i + 1) })), title: D.title, credits: D.credits },
      output: { manifestUrl: `/artifacts/${D.artifact}/${D.film}/provenance.json`, c2paUrl: `/artifacts/${D.artifact}/${D.film}/provenance.c2pa`, mp4Url: `/artifacts/${D.artifact}/${D.film}/export.mp4` } });
    const n = SPLIT10.findIndex((_, i) => path === `/api/jobs/${final10(i + 1)}`) + 1;
    if (n) return json(finalJob(n));
    const scored = SPLIT10.findIndex((_, i) => path === `/api/jobs/${film10(i + 1)}`) + 1;
    if (scored) return json({ id: film10(scored), projectId: D.project, stage: "sound-mix", status: "done" });
    const root = `/api/projects/${D.project}`;
    if (!path.startsWith(root)) return json({ error: "not found" }, 404);
    const rest = path.slice(root.length);
    if (method === "GET" && rest === "/spend") return json({ spentUsd: 95.12, heldUsd: 0, capUsd: 150 });
    if (method === "GET" && rest === "/cast") return json({ casting: { version: 9, characters: ["WREN", "OSWIN", "DEV", "MARISOL", "HOLLIS"].map((name, i) => ({ id: UUID(0xc1 + i), name, kind: "original-fictional",
      permission: { status: "permitted" }, ...(i < 2 ? { referenceLock: { revision: sha("lock" + i) } } : {}) })) } });
    if (method === "GET" && rest === "/feature-film") return json({ sequences: [], jobs: [{ jobId: D.film, status: "done", planRevision: sha("join") }] });
    if (method === "GET" && rest === "/style-bible") return json({ styleBible: { revision: BIBLE, version: 1, source: "stand-in" }, sequences: SPLIT10.map((_, i) => ({ number: i + 1, madeWith: [BIBLE], needsRoughCut: false })) });
    if (method === "GET" && rest === "/identity-locks") return !desk.identity ? json({ error: "not found" }, 404) : json({ schema: "hv-identity-locks/1",
      locks: [{ characterId: D.wren, name: "WREN", revision: sha("lock0") }, { characterId: D.oswin, name: "OSWIN", revision: sha("lock1") }],
      sequences: SPLIT10.map((s, i) => ({ number: i + 1, needsRoughCut: false, renders: [{ jobId: final10(i + 1), stage: "final", current: true,
        shots: Array.from({ length: s.shots }, (_, k) => ({ shotId: `shot-${i + 1}-${k + 1}`, locks: k % 2 ? [] : [{ characterId: D.wren, revision: sha("lock0") }] })) }] })) });
    if (method === "GET" && rest === "/direction") return json({ direction: { version: 5 } });
    if (method === "POST" && rest === "/direction/continuity/repair") return json({ report: { scenes: [{ findings: [{ code: "wardrobe-contradicts-previous" }] }],
      ...(desk.boundaries ? { boundaries: SPLIT10.slice(1).map((_, i) => ({ from: i + 1, to: i + 2, continuous: i === 3, sameLocation: false, comparisons: i === 3 ? 2 : 0, findings: [] })) } : {}) },
      proposal: { edits: [], refused: ["wardrobe-contradicts-previous"] }, scriptVersion: 2, summary: "Nothing more to hold.", remake: [] });
    if (method === "GET" && rest === "/editorial") return json({ sequences: [{ id: "feature-cut", historyRevision: CUT.historyRevision }] });
    if (method === "GET" && rest.startsWith("/editorial/sequences/feature-cut/interchange/")) {
      if (url.searchParams.get("historyRevision") !== CUT.historyRevision) return json({ error: "The saved cut changed." }, 409);
      const text = rest.endsWith("/otio") ? editOtio(CUT) : editCmx3600(CUT);
      return new Response(text, { headers: { "x-hv-interchange-sha256": sha(text) } });
    }
    if (rest === `/deliveries/hero/${final10(1)}`) {
      if (!desk.hero) return json({ error: "Unknown delivery route." }, 404);
      if (method === "POST") return json({ jobId: D.hero }, 202);
      const stages = ["denoise", "frame-rate", "upscale"].map((stage, i) => ({ index: i, stage, engine: "ffmpeg", provider: "local", spendUsd: 0, inputSha256: i ? sha("stage" + (i - 1)) : sha("clip"),
        sha256: sha("stage" + i), width: 1280, height: 720, fps: 30, frames: 30, url: `/artifacts/${D.artifact}/hero/${stage}.mp4` }));
      return json({ shots: [{ shotId: "shot-1-1", available: true, provider: "fal" }], jobs: desk.calls.some(call => call.method === "POST" && call.path.includes("/deliveries/hero/"))
        ? [{ id: D.hero, status: "done", output: { hero: { source: { sha256: sha("clip"), width: 1280, height: 720, fps: 24 }, stages, credentials: "c2pa-sidecar", chainRevision: sha("chain"),
          recordUrl: `/artifacts/${D.artifact}/hero/provenance.json` } } }] : [] });
    }
    if (method === "GET" && rest === "/reviews") return json({ links: [{ id: D.link, jobId: D.film, permission: "approve", views: 2, maxViews: 5,
      ...(desk.comments ? { decision: "approved", decisionStage: "final", decidedAt: "2026-10-04T00:00:00.000Z", decisionNote: "", comments: COMMENTS } : { decision: null, decisionStage: null, decidedAt: null, decisionNote: null, comments: [] }) }], stages: [] });
    return json({ error: "not found" }, 404);
  } });
});
afterAll(() => { frontServer.stop(true); deskServer.stop(true); });

const studio: FeatureStudioReport = { schema: "hv-studio-run/1", projectId: D.project, format: "feature", tone: "warm and hopeful", outcome: "completed", finishNotes: [],
  script: { format: "fountain", sha256: sha("script") },
  readThrough: { source: "stand-in", concerns: [], crewSpendUsd: 0.05, facts: { format: "feature", scenes: parsed.scenes.length, shots: 202, estimatedRuntimeSec: 404, formatLimitSec: 1200,
    estimate: { videoSpec: FAL, basis: "profile", finalVideoUsd: 84.84 } } },
  plan: { source: "stand-in", crewSpendUsd: 0.1, sequences: { source: "stand-in", revision: sha("split10"), sequences: SPLIT10.map((s, i) => ({ number: i + 1, ...s, bibleRevision: BIBLE })) },
    styleBible: { kept: false, source: "stand-in", revision: BIBLE, version: 1 } },
  final: { jobId: D.film }, review: { linkId: D.link, jobId: D.film, maxViews: 5, permission: "approve" },
  feature: { sequences: SPLIT10.map((_, i) => ({ number: i + 1, roughCut: rough10(i + 1), film: film10(i + 1) })), joined: true, titled: true } };
const reading = (at: string, generation: number): LinesReading => ({ schema: "hv-release-lines/1", at, basis: { generation: "g", voice: "v", music: "m", crew: "c" },
  lines: { generation: { spentUsd: generation, heldUsd: 0 }, voice: { spentUsd: 0, heldUsd: 14.44 }, music: { spentUsd: 0.44, heldUsd: 0 }, crew: { spentUsd: 0.2, heldUsd: 0 } } });
const FIXTURE_DIR = "test/fixtures/release-3-run/";
const fixtureGates = gateEntries(readFileSync(resolve(REPO, FIXTURE_DIR, "gates.fixture.md"), "utf8"));
const context: Context = { ...realContext(), evidenceRoot: FIXTURE_DIR, gates: [...realContext().gates, ...fixtureGates], requireAcknowledgement: true };
const options = (extra: Partial<Release3Options> = {}): Release3Options => ({ base: `http://127.0.0.1:${deskServer.port}`, poll: { intervalMs: 1, limitMs: 5000 },
  feature: { projectId: D.project, token: D.token, studio, script: SCRIPT }, operatorToken: D.operator,
  continuity: { apply: false }, interchange: true, hero: {}, camera: true, provenance: true, reviews: true,
  verifyC2pa: { verify: async () => ({ ok: true, state: "Valid", codes: ["signingCredential.untrusted"], problems: [] }) },
  spendDeclared: 120, lines: { before: reading("2026-10-04T00:00:00.000Z", 20), after: reading("2026-10-04T06:00:00.000Z", 115.12) },
  defer: { "HV-019.second-vendor": "G20-202610031349", "HV-020.native-camera": "G21-209901010000", "HV-025.vfx-composite": "G21-209901010000" },
  evidence: { "HV-037.paid-benchmark": [FIXTURE_DIR + "paid-benchmark.fixture.json"] }, acknowledged: "G6-209901010001", ...extra });
const stepOf = (record: any, name: string) => record.steps.find((step: any) => step.step === name);

describe("release-3-run.ts behind the front door", () => {
  /** The driver's own record, from the studio's answers, meets the contract the release will be held to. */
  test("a run over ten sequences fills every part from the studio's own ids, and its record meets the Release 3 contract", async () => {
    desk.identity = true; desk.hero = true; desk.boundaries = true; desk.comments = true; desk.vendor = false;
    const record = await runRelease3(options());
    expect(record.schema).toBe("hv-release-run/3");
    expect(Object.keys(record.slices)).toEqual(Object.keys(RELEASE_3_PARTS));
    expect(release3Problems(record, context)).toEqual([]);
    const surfaces = Object.fromEntries(record.steps.map((step: any) => [step.step, step.surface]));
    expect(surfaces).toMatchObject({ "pitch-to-shared-feature": "front-door", "feature-identity": "front-door", "continuity-boundaries": "desk-api", "interchange": "desk-api",
      "hero-chain": "desk-api", "native-camera": "desk-api", "review-read-back": "reviewer", "evidence": "operator" });
    const ids = (part: string) => record.slices[part].exercised ? record.slices[part].ids : null;
    expect(ids("HV-025.titles-credits")).toEqual([D.title, D.credits]);
    expect(ids("HV-034.style-bible")).toEqual([BIBLE]);
    expect(ids("HV-019.hero-chain")).toEqual([D.hero]);
    expect(ids("HV-030.feature-review")).toEqual([D.link, ...COMMENTS.map(comment => comment.id)]);
    expect(ids("HV-023.interchange")).toEqual([sha(editOtio(CUT)), sha(editCmx3600(CUT))]);
    expect(record.interchange).toMatchObject({ readsBackTheSame: true, otio: { matchesHeader: true, clips: 2 }, edl: { matchesHeader: true, events: 2 }, jobs: [film10(1), film10(2)] });
    // Each comment is placed in the sequence its frame falls in; each final's providers counted from its last decision per shot.
    expect(record.feature.review.comments.map((comment: any) => comment.sequence)).toEqual([1, 4, 9]);
    expect(record.feature.sequences[0].picture.byProvider).toEqual({ [FAL]: SPLIT10[0]!.shots });
    expect(record.feature.film).toMatchObject({ durationSec: FILM_SEC + 6, creditsSec: 6, captionLanguage: "en", bibleRevision: BIBLE });
    // Native camera control: every path was a local crop, so the part waits for its deferral, and says why.
    expect(stepOf(record, "native-camera")).toMatchObject({ outcome: "unavailable", note: "every camera path was a local crop: provider-has-no-native-camera x1" });
    expect(record.slices["HV-020.native-camera"]).toEqual({ exercised: false, surface: "desk-api", ids: [], deferredBy: "G21-209901010000" });
    expect(record.ledgers.snapshots[0].before.operator).toEqual({ budget: { recordedMonthUsd: 120 }, byProvider: [{ provider: "fal", monthUsd: 95 }] });
  });

  /**
   * HV-030-33: each sequence's film is read back from the studio, and a sequence joined as its bare
   * final, because its score failed, fails the contract by name, with the notes the run kept for it.
   * Before, the record named only the film's id, and a final passed as a finished film.
   */
  test("a sequence joined without its score is read back from the studio and fails the contract by name", async () => {
    desk.identity = true; desk.hero = true; desk.boundaries = true; desk.comments = true; desk.vendor = false; desk.unscored = 4;
    const failed = "Composer: the score could not be mixed (The selected picture length changed.); the film is shared without music.";
    const told = { ...studio, feature: { ...studio.feature!, unscored: [4], sequences: studio.feature!.sequences.map(sequence => sequence.number === 4
      ? { ...sequence, film: final10(4), finished: { voiced: false, scored: false, ambience: false, notes: [failed] } } : sequence) } };
    try {
      const record = await runRelease3(options({ feature: { projectId: D.project, token: D.token, studio: told, script: SCRIPT } }));
      expect(record.feature.sequences.map((sequence: any) => sequence.filmStage)).toEqual(SPLIT10.map((_, i) => i === 3 ? "final" : "sound-mix"));
      expect(record.feature.sequences[3]).toMatchObject({ film: final10(4), final: final10(4), finishNotes: [failed] });
      expect(release3Problems(record, context)).toEqual(["sequence 4's film was not scored (the studio holds it as final)"]);
    } finally { desk.unscored = null; }
  });

  /** The parts whose increments are still open PRs are recorded as unavailable, naming the increment, and never stop the run. */
  test("the identity read, the boundary report and the hero chain record 'unavailable' when their routes aren't on the host", async () => {
    desk.identity = false; desk.hero = false; desk.boundaries = false;
    const record = await runRelease3(options());
    expect(stepOf(record, "feature-identity")).toMatchObject({ surface: "front-door", outcome: "unavailable", note: "the identity-locks read is not on this host (HV-017-17)" });
    expect(stepOf(record, "hero-chain")).toMatchObject({ surface: "desk-api", outcome: "unavailable", note: "the hero-render chain is not on this host (HV-019-15)" });
    expect(stepOf(record, "continuity-boundaries")).toMatchObject({ surface: "desk-api", outcome: "unavailable", note: "the Supervisor's report has no sequence boundaries on this host (HV-021-11)" });
    for (const part of ["HV-017.feature-identity", "HV-019.hero-chain", "HV-021.cross-sequence-continuity"]) expect(record.slices[part]).toMatchObject({ exercised: false, deferredBy: null });
    expect(record.steps.some((step: any) => step.outcome === "stopped")).toBe(false);
    // The contract names each one as unaccounted for until it is exercised or deferred to an entry.
    expect(release3Problems(record, context)).toEqual(["HV-017.feature-identity is neither exercised nor deferred to a gate entry that exists",
      "HV-021.cross-sequence-continuity is neither exercised nor deferred to a gate entry that exists", "HV-019.hero-chain is neither exercised nor deferred to a gate entry that exists"]);
    desk.identity = true; desk.hero = true; desk.boundaries = true;
  });

  /** A second vendor's shots are a stop without its G3 entry, and the part with it. */
  test("shots by a second vendor stop the step without a G3 gate, and exercise the part with one", async () => {
    desk.vendor = true;
    const without = await runRelease3(options({ defer: {} }));
    expect(stepOf(without, "second-vendor")).toMatchObject({ outcome: "stopped", note: "shots were rendered by othervendor:video-1 without a G3 entry approving the vendor (--second-vendor-gate)" });
    expect(release3Problems(without, context)).toContain("sequence 3 was rendered by a second vendor without its G3 approval");
    const approved = await runRelease3(options({ defer: { "HV-020.native-camera": "G21-209901010000", "HV-025.vfx-composite": "G21-209901010000" }, secondVendorGate: "G22-209901010000" }));
    expect(approved.slices["HV-019.second-vendor"]).toEqual({ exercised: true, surface: "front-door", ids: [final10(3)], deferredBy: null });
    expect(release3Problems(approved, context)).toEqual([]);
    desk.vendor = false;
  });

  /** --merge reruns the review read-back after Kevin has reviewed, keeping the first answer under supersededSteps. */
  test("--merge reruns only the steps asked for, and keeps a replaced step that had not succeeded", async () => {
    desk.comments = false;
    const first = await runRelease3(options());
    expect(stepOf(first, "review-read-back")).toMatchObject({ outcome: "unavailable", note: "the feature's review link has no comment or decision yet" });
    desk.comments = true;
    const second = await runRelease3({ base: `http://127.0.0.1:${deskServer.port}`, feature: { projectId: D.project, token: D.token, studio, script: SCRIPT }, reviews: true, merge: first, poll: { intervalMs: 1, limitMs: 5000 } });
    expect(second.steps.filter((step: any) => step.step === "review-read-back")).toHaveLength(1);
    expect(stepOf(second, "review-read-back").outcome).toBe("done");
    expect(second.supersededSteps).toEqual([expect.objectContaining({ step: "review-read-back", outcome: "unavailable" })]);
    // Everything else is kept as it was: the hero render, the declared spend, the lines and the acknowledgement.
    expect(second.slices["HV-019.hero-chain"].ids).toEqual([D.hero]);
    expect(second.spendUsdDeclared).toBe(120);
    expect(second.ledgers.lines.generation.after.spentUsd).toBe(115.12);
    expect(release3Problems(second, context)).toEqual([]);
  });

  /** No token, operator credential, review link or signed media link reaches the record. */
  test("no project token, operator credential or signed link reaches the record", async () => {
    const text = JSON.stringify(await runRelease3(options()));
    for (const key of [D.token, D.operator, D.artifact]) expect(text).not.toContain(key);
    expect(text).not.toContain("/artifacts/");
  });

  test("the providers of a final are its last selecting decision per rendered shot, and an undecided shot is unknown", () => {
    expect(shotProviders({ routeDecisions: [{ shotId: "a", selectedId: "fal:x" }, { shotId: "a", selectedId: null }, { shotId: "b", selectedId: "mock" }], shotRenders: [{ shotId: "a" }, { shotId: "b" }, { shotId: "c" }] }))
      .toEqual({ "fal:x": 1, mock: 1, unknown: 1 });
  });

  /** The command line: a token file read by shape, flags that may stand alone, and gates and parts checked before anything runs. */
  test("the command line reads the token file, the optional --hero and --interchange, and refuses an unknown part or a malformed gate", () => {
    const token = join(scratch, "f.token");
    writeFileSync(token, JSON.stringify({ projectId: D.project, token: D.token }));
    const parsed = parseArguments(["--base", "http://x", "--feature", token, "--hero", "--hero-sequence", "2", "--interchange", "--camera", "--continuity-apply",
      "--defer", "HV-025.vfx-composite=G20-202610031349", "--evidence", "HV-037.paid-benchmark=docs/a.json,docs/b.json", "--spend-declared", "120"]);
    expect(parsed.feature).toEqual({ projectId: D.project, token: D.token, script: undefined });
    expect(parsed.hero).toEqual({ sequence: 2 });
    expect(parsed.interchange).toBe(true);
    expect(parsed.continuity).toEqual({ apply: true });
    expect(parsed.evidence).toEqual({ "HV-037.paid-benchmark": ["docs/a.json", "docs/b.json"] });
    expect(parseArguments(["--base", "http://x", "--feature", token, "--interchange", "feature-cut", "--hero", "shot-2-3"])).toMatchObject({ interchange: "feature-cut", hero: { shotId: "shot-2-3" } });
    expect(() => parseArguments(["--base", "http://x", "--feature", token, "--defer", "HV-024.sfx=G20-202610031349"])).toThrow("--defer takes a Release 3 part");
    expect(() => parseArguments(["--base", "http://x", "--feature", token, "--second-vendor-gate", "yes"])).toThrow("--second-vendor-gate takes a gate entry id");
    expect(() => parseArguments(["--base", "http://x"])).toThrow("missing --feature");
  });
});
