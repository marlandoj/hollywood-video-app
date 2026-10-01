import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RELEASE_2_LINES, RELEASE_2_PARTS, parseArguments, runRelease2, type FilmInput } from "../scripts/release-2-run";
import { sharedLink } from "../scripts/release-run-files";

/**
 * HV-030-22: the two drivers of Release 2's run, against a fake studio.
 *
 * `scripts/studio-run.ts` is run as the operator runs it, in its own process, against a fake HTTP
 * server that answers the front door's routes. `scripts/release-2-run.ts` is called directly against
 * the same kind of server for the desk's routes. Neither touches staging or spends anything. The fake
 * tokens are shaped like the real ones, so a token that leaks into a report is caught.
 */
const REPO = resolve(import.meta.dir, "..");
const UUID = (n: number) => "00000000-0000-4000-8000-" + n.toString(16).padStart(12, "0");
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Token-shaped secrets: payload, dot, 43-character MAC, like the studio's own (packages/api/src/tokens.ts). */
const secret = (name: string) => Buffer.from(JSON.stringify({ kind: name, nonce: name })).toString("base64url") + "." + sha(name).slice(0, 43);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const scratch = mkdtempSync(join(tmpdir(), "hv-release-2-"));
const mode = (path: string) => statSync(path).mode & 0o777;

// ---------------------------------------------------------------------------------------------
// The front door: scripts/studio-run.ts.
// ---------------------------------------------------------------------------------------------
const FRONT = { project: UUID(0xf1), token: secret("front-project"), review: secret("front-review"), animatic: UUID(0xf2), final: UUID(0xf3) };
const front = { readThroughBodies: [] as Record<string, unknown>[], projectsMade: 0, reviewsBody: null as Record<string, unknown> | null };
let frontServer: ReturnType<typeof Bun.serve>;
const CARD = { schema: "hv-crew-style-card/1", format: "reel", tone: "warm", look: "soft window light", choices: [{ persona: "director", question: "Pace?", proposal: "Slow", accepted: true, reply: "" }] };

beforeAll(() => {
  frontServer = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname, method = request.method, root = `/api/projects/${FRONT.project}`;
    const body = method === "GET" ? {} : await request.json().catch(() => ({}));
    if (method === "POST" && path === "/api/projects") { front.projectsMade++; return json({ projectId: FRONT.project, token: FRONT.token }, 201); }
    if (request.headers.get("authorization") !== `Bearer ${FRONT.token}` && !path.startsWith("/api/jobs/")) return json({ error: "unauthorized" }, 401);
    if (method === "PUT" && path === root + "/script") return json({ version: 1 });
    if (method === "POST" && path === root + "/rights") return json({ rightsAttestedAt: "2026-10-01T00:00:00.000Z" });
    if (method === "POST" && path === root + "/crew/read-through") {
      front.readThroughBodies.push(body);
      return json({ schema: "hv-crew-read-through/1", source: "stand-in", facts: { concerns: [] }, crewSpend: { usd: 0, alerts: [] },
        questions: [{ id: "q1", persona: "director", question: "Pace?", proposal: "Slow" }], expected: { scriptVersion: 1, castingVersion: 0, directionVersion: 0 },
        ...(body.styleCard ? { readStyleCard: true } : {}) });
    }
    if (method === "POST" && path === root + "/crew/plan")
      return json({ schema: "hv-crew-plan-result/1", source: "stand-in", notes: [], addedCharacters: 1, directedShots: 2, crewSpend: { usd: 0, alerts: [] },
        finalAnchors: false, voices: [{ name: "RUTH", voiceId: "EXAVITQu4vr4xnSDxMaL", policyRevision: "p1" }], continuityComparisons: 3, styleCard: CARD });
    if (method === "GET" && path === root + "/cast") return json({ casting: { version: 1, characters: [] } });
    if (method === "GET" && path === root + "/spend") return json({ spentUsd: 0, heldUsd: 0, capUsd: 40 });
    if (method === "POST" && path === root + "/jobs") return json({ jobId: body.stage === "final" ? FRONT.final : FRONT.animatic, admitted: true }, 202);
    if (method === "GET" && (path === "/api/jobs/" + FRONT.animatic || path === "/api/jobs/" + FRONT.final))
      return json({ id: path.split("/").at(-1), status: "done", stage: path.endsWith(FRONT.final) ? "final" : "animatic", outputRevision: "r1", output: {} });
    if (method === "POST" && path === root + "/animatic/decision") return json({ accepted: true });
    if (method === "POST" && path === root + "/reviews") { front.reviewsBody = body; return json({ token: FRONT.review, reviewUrl: "http://studio.test/#/review/" + FRONT.review, maxViews: body.maxViews, permission: "approve" }, 201); }
    if (method === "GET" && path === root + "/reviews") return json({ links: [{ id: sha(FRONT.review), jobId: FRONT.final, maxViews: 2, permission: "approve", views: 0 }], stages: [] });
    return json({ error: "not found" }, 404);
  } });
});

/** Asynchronous on purpose: the fake studio answers from this process, so a blocking spawn would deadlock it. */
const studioRun = async (...args: string[]) => {
  const run = Bun.spawn(["bun", "scripts/studio-run.ts", "--base", `http://127.0.0.1:${frontServer.port}`, ...args], { cwd: REPO, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([run.exited, new Response(run.stdout).text(), new Response(run.stderr).text()]);
  return { code, stdout, stderr };
};
const script = join(scratch, "film.fountain");
writeFileSync(script, "INT. KITCHEN - DAY\n\nRUTH\nHello.\n");

describe("studio-run.ts at the front door", () => {
  /** --keep-style-card: the card the studio offers for download, kept once the crew has planned, mode 600, named by its digest. */
  test("film A's style card is kept to a private file once the crew has planned, and the report names it by its SHA-256", async () => {
    const card = join(scratch, "card.json"), out = join(scratch, "a.json");
    const run = await studioRun("--script", script, "--format", "reel", "--stop-after", "look", "--keep-style-card", card, "--out", out);
    expect(run.code).toBe(0);
    const report = JSON.parse(readFileSync(out, "utf8")), text = readFileSync(card, "utf8");
    expect(JSON.parse(text)).toEqual(CARD);
    expect(mode(card)).toBe(0o600);
    expect(report.styleCard).toEqual({ kept: { sha256: sha(text) } });
    // The card's words stay in its file; the token stays in its own.
    expect(readFileSync(out, "utf8")).not.toContain("soft window light");
    expect(mode(join(scratch, "a.token"))).toBe(0o600);
    expect(readFileSync(out, "utf8")).not.toContain(FRONT.token);
  });

  /** --style-card: the kept card goes to the crew with this pitch, and the read-through says it was read. */
  test("film B is pitched with film A's card attached, and the report says the crew read it", async () => {
    const card = join(scratch, "card.json"), out = join(scratch, "b.json");
    const before = front.readThroughBodies.length;
    const run = await studioRun("--script", script, "--format", "short", "--stop-after", "look", "--style-card", card, "--out", out);
    expect(run.code).toBe(0);
    expect(front.readThroughBodies[before]!.styleCard).toEqual(CARD);
    const report = JSON.parse(readFileSync(out, "utf8"));
    expect(report.styleCard.attached.sha256).toBe(sha(readFileSync(card, "utf8")));
    expect(report.readThrough.readStyleCard).toBe(true);
  });

  /** A file that is not a style card stops the run before any project exists. */
  test("a style card file the studio did not make stops the run before a project is made", async () => {
    const bogus = join(scratch, "bogus.json"), made = front.projectsMade;
    writeFileSync(bogus, JSON.stringify({ schema: "something-else" }));
    const run = await studioRun("--script", script, "--style-card", bogus, "--out", join(scratch, "c.json"));
    expect(run.code).not.toBe(0);
    expect(run.stderr).toContain("not a style card the studio made");
    expect(front.projectsMade).toBe(made);
  });

  /** --share N: the share route mints a link for N viewers on the final; the link goes to a private file, and the report holds its digest. */
  test("--share mints a review link for N viewers through the share route, writes it only to a private file, and reports its digest", async () => {
    const out = join(scratch, "shared.json");
    const run = await studioRun("--script", script, "--format", "reel", "--share", "2", "--out", out);
    expect(run.code).toBe(0);
    expect(front.reviewsBody).toEqual({ permission: "approve", jobId: FRONT.final, expectedOutputRevision: "r1", maxViews: 2 });
    const report = JSON.parse(readFileSync(out, "utf8")), link = join(scratch, "shared.review");
    expect(report.review).toEqual({ linkId: sha(FRONT.review), jobId: FRONT.final, maxViews: 2, permission: "approve" });
    expect(readFileSync(link, "utf8").trim()).toBe("http://studio.test/#/review/" + FRONT.review);
    expect(mode(link)).toBe(0o600);
    expect(readFileSync(out, "utf8")).not.toContain(FRONT.review);
    expect(run.stdout + run.stderr).not.toContain(FRONT.review);
  });

  /** A share needs the final, and a number. */
  test("--share is refused without the final or without a number of viewers", async () => {
    expect((await studioRun("--script", script, "--share", "2", "--stop-after", "look", "--out", join(scratch, "d.json"))).stderr).toContain("--share takes a number of viewers, and needs the final");
    expect((await studioRun("--script", script, "--share", "many", "--out", join(scratch, "e.json"))).stderr).toContain("--share takes a number of viewers, and needs the final");
    expect(() => sharedLink([{ id: "x", jobId: UUID(9), maxViews: 3, permission: "approve", views: 0 }], FRONT.final)).toThrow("does not show it bound");
  });
});

// ---------------------------------------------------------------------------------------------
// The desk: scripts/release-2-run.ts.
// ---------------------------------------------------------------------------------------------
const A = { projectId: UUID(0xa1), token: secret("project-a") }, B = { projectId: UUID(0xb1), token: secret("project-b") };
const OPERATOR = secret("operator"), SHARE = secret("actor-share"), ARTIFACT = secret("artifact");
const CUT = UUID(0xa3), FINAL_A = UUID(0xa2), FINAL_B = UUID(0xb2), SHARED_B = UUID(0xb3), RUTH = UUID(0xa20), REF = UUID(0xa21), SHARE_ID = UUID(0xa22), IMPORTED = UUID(0xb20);
const COMMENT = UUID(0xc1), LINK_A = sha("link-a"), SIDECAR = new TextEncoder().encode("signed sidecar bytes");
const KINDS = ["reframe-9:16", "reframe-1:1", "mezzanine", "open-captions", "open-captions-9:16", "open-captions-1:1", "grade", "sdh"];
interface Desk { routes: { ambience: boolean; music: boolean }; acceptStatus: number; calls: { method: string; path: string; body: any }[]; polls: number; jobs: Map<string, string> }
const desk: Desk = { routes: { ambience: false, music: false }, acceptStatus: 200, calls: [], polls: 0, jobs: new Map() };
const EDITS = [{ shotId: "s2", field: "keyLight", value: "soft" }];
let deskServer: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  deskServer = Bun.serve({ port: 0, async fetch(request) {
    const url = new URL(request.url), path = url.pathname, method = request.method;
    const body = ["GET", "HEAD"].includes(method) ? undefined : await request.json().catch(() => undefined);
    desk.calls.push({ method, path, body });
    if (path.startsWith(`/artifacts/${ARTIFACT}/`)) return path.endsWith(".c2pa") ? new Response(SIDECAR)
      : json({ credentials: { type: "c2pa-sidecar", claim: "x", sidecar: { name: "provenance.c2pa", sha256: sha(SIDECAR) } } });
    const auth = request.headers.get("authorization");
    if (path === "/api/operator/status") return auth === `Bearer ${OPERATOR}`
      ? json({ schema: "hv-operator-status/1", database: { value: { budget: { recordedMonthUsd: 17, reservedUsd: 4, monthlyCapUsd: 500 } } }, costs: { value: { byProvider: [{ provider: "fal", monthUsd: 17, dayUsd: 1 }] } } })
      : json({ error: "unauthorized" }, 401);
    const film = auth === `Bearer ${A.token}` ? A : auth === `Bearer ${B.token}` ? B : null;
    if (!film) return json({ error: "unauthorized" }, 401);
    if (path.startsWith("/api/jobs/")) {
      const id = path.split("/").at(-1)!;
      return json({ id, stage: "picture-edit", status: "done", output: { manifestUrl: `/artifacts/${ARTIFACT}/${film.projectId}/${id}/provenance.json`, c2paUrl: `/artifacts/${ARTIFACT}/${film.projectId}/${id}/provenance.c2pa` } });
    }
    const root = `/api/projects/${film.projectId}`;
    if (!path.startsWith(root)) return json({ error: "not found" }, 404);
    const rest = path.slice(root.length);
    if (method === "GET" && rest === "/spend") return json({ spentUsd: film === A ? 0.6 : 0.5, heldUsd: 0.1, capUsd: 40 });
    if (method === "GET" && rest === "") return json({ projectId: film.projectId, jobs: [{ id: UUID(0xa10), stage: "audio-take", status: "done" }, { id: FINAL_A, stage: "final", status: "done" }] });
    if (method === "GET" && rest === "/cast") return json({ casting: film === A
      ? { version: 5, characters: [{ id: RUTH, name: "RUTH", kind: "original-fictional", audioVoice: { provider: "elevenlabs" }, references: [{ id: REF }] }] }
      : { version: 2, characters: desk.calls.some(call => call.path.endsWith("/cast/import")) ? [{ id: IMPORTED, name: "RUTH", kind: "original-fictional" }] : [] } });
    if (method === "PUT" && rest === `/cast/${RUTH}/reference-lock`)
      return json({ casting: { version: 6, characters: [{ id: RUTH, name: "RUTH", references: [{ id: REF }], referenceLock: { revision: sha("lock"), assets: body.lock.assetIds.map((id: string) => ({ id })) } }] } });
    if (method === "POST" && rest === `/cast/${RUTH}/shares`) return json({ share: { id: SHARE_ID }, token: SHARE }, 201);
    if (method === "POST" && rest === "/cast/import")
      return body.shareToken === SHARE ? json({ casting: { version: 3, characters: [{ id: IMPORTED, name: "RUTH", kind: "original-fictional", referenceLock: { revision: "x" } }] } }) : json({ error: "bad share" }, 404);
    if (method === "GET" && rest === "/direction") return json({ direction: { version: 3 } });
    if (method === "POST" && rest === "/direction/continuity/repair") return json({ report: { scenes: [{ findings: [{ code: "drift" }, { code: "drift" }] }] }, proposal: { edits: EDITS, refused: [] }, summary: "Hold key light.", scriptVersion: 2 });
    if (method === "POST" && rest === "/direction/continuity/repair/accept")
      return JSON.stringify(body.edits) === JSON.stringify(EDITS) && body.expectedVersion === 3 && body.expectedScriptVersion === 2 && desk.acceptStatus === 200
        ? json({ direction: { version: 4 } }) : json({ error: "The direction changed. Reload." }, 409);
    if (method === "GET" && rest === "/deliveries") return json({ kinds: KINDS, sources: [{ id: UUID(0xaf), unavailable: "This cut is no longer retained." }, { id: CUT, unavailable: null }], jobs: [] });
    if (rest === `/deliveries/${CUT}`) {
      if (method === "POST") { const id = UUID(0xd00 + desk.jobs.size); desk.jobs.set(id, body.kind); return json({ jobId: id }, 202); }
      // Each job is queued at the first look and done at the next, so the driver has to wait for them.
      const done = desk.polls++ > 1;
      return json({ sourceJobId: CUT, offers: KINDS.map(kind => ({ kind, available: true, reason: null })), grade: { neutral: { look: "neutral" } },
        jobs: [...desk.jobs].map(([id, kind]) => ({ id, kind, status: done ? "done" : "queued", output: done ? { sha256: sha(id), bytes: 10, quality: { verdict: "pass" } } : null,
          ...(kind === "grade" ? { grade: { check: done ? { verdict: "pass" } : null } } : {}) })) });
    }
    if (method === "POST" && rest === `/ambience/${CUT}`) return desk.routes.ambience
      ? json({ scenes: [{ preset: "rain-window" }], cues: [{ assetId: UUID(0xe1) }, { assetId: UUID(0xe1) }], costUsd: 0 }, 201) : json({ error: "not found" }, 404);
    if (method === "POST" && rest === "/music-cues") return desk.routes.music
      ? json({ asset: { id: UUID(0xe3) }, cue: { id: "music-" + "a".repeat(32), provider: "elevenlabs", model: "music_v1", status: "settled", heldUsd: 0.075, actualUsd: 0.075 } }, 201)
      : json({ error: "not found" }, 404);
    if (method === "POST" && rest === "/script/import") return json({ text: "INT. X - DAY", notes: [], scenes: 3, warnings: [] });
    if (method === "POST" && rest === "/crew/line-notes") return json({ schema: "hv-crew-line-notes/1", script: { version: 2, sha256: "s" }, notes: [], dropped: 0, source: "stand-in", crewSpend: { usd: 0, alerts: [] } });
    if (method === "GET" && rest === "/reviews") return json({ links: film === A
      ? [{ id: LINK_A, permission: "approve", views: 1, maxViews: 3, revoked: false, jobId: CUT, decision: "approved", decisionNote: "", decisionStage: "picture-edit", decidedAt: "2026-10-02T00:00:00.000Z",
        comments: [{ id: COMMENT, frame: 69, timecode: "00:00:02:09", text: "Hold here.", viewer: 1, at: "2026-10-02T00:00:00.000Z", resolvedAt: null }] }]
      : [], stages: [] });
    return json({ error: "not found" }, 404);
  } });
});
afterAll(() => { frontServer.stop(true); deskServer.stop(true); });

const studioA = { schema: "hv-studio-run/1", projectId: A.projectId, format: "reel", outcome: "completed", final: { jobId: FINAL_A }, finishNotes: [],
  review: { linkId: LINK_A, jobId: CUT, maxViews: 3, permission: "approve" }, styleCard: { kept: { sha256: sha("card") } }, readThrough: { crewSpendUsd: 0 }, plan: { crewSpendUsd: 0.25 } };
const studioB = { schema: "hv-studio-run/1", projectId: B.projectId, format: "short", outcome: "completed", final: { jobId: FINAL_B }, finishNotes: [],
  review: { linkId: sha("link-b"), jobId: SHARED_B, maxViews: 3, permission: "approve" }, styleCard: { attached: { sha256: sha("card") } }, readThrough: { readStyleCard: true, crewSpendUsd: 0.1 } };
const films = (): FilmInput[] => [{ key: "A", ...A, studio: studioA, script: "docs/evidence/release-1/scripts/reel-last-bus.fountain" }, { key: "B", ...B, studio: studioB }];
const importFile = join(scratch, "film.fdx");
writeFileSync(importFile, "<FinalDraft/>");
const everything = () => runRelease2({ base: `http://127.0.0.1:${deskServer.port}`, films: films(), operatorToken: OPERATOR, poll: { intervalMs: 1, limitMs: 5000 },
  lockLook: true, shareActor: true, continuity: { apply: true }, deliveries: ["grade", "open-captions", "sdh", "reframe-9:16", "reframe-1:1", "mezzanine"],
  ambience: true, music: { prompt: "quiet piano", seconds: 30 }, imports: [{ format: "final-draft", path: importFile }], lineNotes: { request: "tighten", accept: true },
  provenance: true, reviews: true, defer: { "HV-030.voice-meetings": "G15-202609301223", "HV-024.ambience": "G15-202609301223" },
  evidence: { "HV-039.wcag": ["docs/ACCESSIBILITY-AUDIT.md"] } });

describe("release-2-run.ts behind the front door", () => {
  /** Every step names its surface, and the parts each exercised are filled with the studio's own ids. */
  test("each step names its surface, and the parts it exercised carry the studio's own ids", async () => {
    desk.routes = { ambience: false, music: false }; desk.jobs.clear(); desk.polls = 0;
    const record = await everything();
    expect(record.schema).toBe("hv-release-run/2");
    expect(Object.keys(record.slices)).toEqual(Object.keys(RELEASE_2_PARTS));
    for (const step of record.steps) expect(["front-door", "desk-api", "reviewer", "operator", "audit"]).toContain(step.surface);
    const surfaceOf = (name: string, film?: string) => record.steps.find((s: any) => s.step === name && (film === undefined || s.film === film))?.surface;
    expect([surfaceOf("pitch-to-shared-film", "A"), surfaceOf("lock-look"), surfaceOf("review-read-back", "A"), surfaceOf("evidence")]).toEqual(["front-door", "desk-api", "reviewer", "audit"]);
    const ids = (part: string) => record.slices[part].exercised ? record.slices[part].ids : null;
    expect(ids("HV-030.style-memory")).toEqual([A.projectId, B.projectId, sha("card")]);
    expect(ids("HV-022.elevenlabs-voice")).toEqual([UUID(0xa10)]);
    expect(ids("HV-017.identity-lock")).toEqual([RUTH]);
    expect(ids("HV-017.cast-library")).toEqual([SHARE_ID, IMPORTED]);
    expect(ids("HV-021.continuity-repair")).toEqual([A.projectId]);
    expect(record.continuity).toMatchObject({ findings: 2, edits: 1, applied: true, directionVersion: { before: 3, after: 4 } });
    expect(ids("HV-016.import")).toEqual([sha("<FinalDraft/>")]);
    expect(ids("HV-031.signed-c2pa")).toEqual([FINAL_A, CUT, FINAL_B, SHARED_B]);
    expect(record.provenance.exports.every((e: any) => e.sidecar.present && e.sidecar.matchesRecord && e.sidecar.sha256 === sha(SIDECAR))).toBe(true);
    expect(ids("HV-029.timecoded-comments")).toEqual([COMMENT]);
    expect(ids("HV-029.stage-approvals")).toEqual([LINK_A]);
    expect(record.films.find((f: any) => f.key === "A").review).toMatchObject({ linkId: LINK_A, decisionStage: "picture-edit", comments: [{ id: COMMENT, timecode: "00:00:02:09" }] });
    expect(ids("HV-039.wcag")).toEqual(["docs/ACCESSIBILITY-AUDIT.md"]);
  });

  /** The continuity repair applies exactly the edits it was shown, against the versions it read. */
  test("the continuity repair is applied with exactly the edits the review showed, and a refusal stops only that step", async () => {
    desk.calls.length = 0; desk.acceptStatus = 409;
    const record = await runRelease2({ base: `http://127.0.0.1:${deskServer.port}`, films: films(), continuity: { apply: true }, lockLook: true });
    const accept = desk.calls.find(call => call.path.endsWith("/continuity/repair/accept"));
    expect(accept?.body).toEqual({ edits: EDITS, expectedVersion: 3, expectedScriptVersion: 2 });
    const step = record.steps.find((s: any) => s.step === "continuity-repair");
    expect(step).toMatchObject({ outcome: "stopped", note: "/api/projects/:id/direction/continuity/repair/accept -> 409 The direction changed. Reload." });
    expect(record.slices["HV-021.continuity-repair"].exercised).toBe(false);
    // The run went on past it.
    expect(record.slices["HV-017.identity-lock"].exercised).toBe(true);
    desk.acceptStatus = 200;
  });

  /** The deliveries are asked for from the first retained cut, waited for, and sorted into the parts they prove. */
  test("the deliverables are made from the first retained cut, waited for, and fill the grade, reframe, caption and mezzanine parts", async () => {
    desk.jobs.clear(); desk.polls = 0;
    const record = await everything();
    expect(record.deliveries.map((d: any) => [d.kind, d.cutId, d.status])).toEqual(["grade", "open-captions", "sdh", "reframe-9:16", "reframe-1:1", "mezzanine"].map(kind => [kind, CUT, "done"]));
    const grade = desk.calls.find(call => call.method === "POST" && call.body?.kind === "grade");
    expect(grade?.body.grade).toEqual({ look: "neutral" });
    for (const part of ["HV-026.grade-qc", "HV-027.reframes", "HV-027.captions", "HV-027.mezzanine"]) expect(record.slices[part].exercised).toBe(true);
    expect(record.slices["HV-027.reframes"].ids).toHaveLength(2);
  });

  /** A route not yet deployed (PR #340, PR #335) is recorded as unavailable, not as a failure, and its part waits for a deferral. */
  test("ambience and music record 'unavailable' when their routes are not deployed, and are exercised when they are", async () => {
    desk.routes = { ambience: false, music: false };
    const missing = await everything();
    for (const name of ["ambience", "music-cue"]) expect(missing.steps.find((s: any) => s.step === name)).toMatchObject({ surface: "desk-api", outcome: "unavailable" });
    expect(missing.sound).toEqual({ ambience: { status: "unavailable" }, music: { status: "unavailable" } });
    // Deferred only because it was not exercised; a deferral never overwrites a part the run exercised.
    expect(missing.slices["HV-024.ambience"]).toEqual({ exercised: false, surface: "desk-api", ids: [], deferredBy: "G15-202609301223" });
    desk.routes = { ambience: true, music: true };
    const made = await everything();
    expect(made.slices["HV-024.ambience"]).toEqual({ exercised: true, surface: "desk-api", ids: [UUID(0xe1)], deferredBy: null });
    expect(made.slices["HV-024.music"].ids).toEqual([UUID(0xe3), "music-" + "a".repeat(32)]);
    expect(made.ledgers.lines.music.runUsd).toBe(0.075);
  });

  /** The stand-in crew writes no line notes; the step says so rather than claiming the part. */
  test("line notes from the stand-in crew are recorded as unavailable, and the part is left for a deferral", async () => {
    const record = await everything();
    expect(record.steps.find((s: any) => s.step === "line-notes")).toMatchObject({ outcome: "unavailable", note: "the stand-in crew writes no line notes; the crew needs its model key" });
    expect(record.slices["HV-016.line-notes"]).toEqual({ exercised: false, surface: "desk-api", ids: [], deferredBy: null });
  });

  /** The ledgers before and after, per film and from the operator's view; the lines the criteria name, the crew's from its replies. */
  test("the ledgers are snapshotted before and after, per film and from the operator's view, with each line the criteria name", async () => {
    const record = await everything();
    const [{ before, after }] = record.ledgers.snapshots;
    for (const snapshot of [before, after]) {
      expect(snapshot.films.A).toEqual({ spentUsd: 0.6, heldUsd: 0.1, capUsd: 40 });
      expect(snapshot.operator).toEqual({ budget: { recordedMonthUsd: 17, reservedUsd: 4, monthlyCapUsd: 500 }, byProvider: [{ provider: "fal", monthUsd: 17 }] });
    }
    expect(Object.keys(record.ledgers.lines)).toEqual(Object.keys(RELEASE_2_LINES));
    for (const [name, limit] of Object.entries(RELEASE_2_LINES)) expect(record.ledgers.lines[name].limitUsd).toBe(limit);
    expect(record.ledgers.lines.crew.runUsd).toBeCloseTo(0.35, 6);
  });

  /** No token, share token, operator credential or signed link reaches the record. */
  test("no project token, actor share token, operator credential or signed media link reaches the record", async () => {
    const text = JSON.stringify(await everything());
    for (const key of [A.token, B.token, SHARE, OPERATOR, ARTIFACT]) expect(text).not.toContain(key);
    expect(text).not.toContain("/artifacts/");
  });

  /** The command line: repeated pairs, closed delivery kinds, and a token file read by shape. */
  test("the command line reads token files, repeated --defer pairs and the delivery kinds, and refuses an unknown kind", () => {
    const token = join(scratch, "a.token.json");
    writeFileSync(token, JSON.stringify(A));
    const options = parseArguments(["--base", "http://x", "--film-a", token, "--deliveries", "grade,sdh", "--defer", "HV-024.sfx=G15-202609301223", "--defer", "HV-031.moderation=G15-202609301223", "--reviews"]);
    expect(options.films).toEqual([{ key: "A", ...A, script: undefined }]);
    expect(options.deliveries).toEqual(["grade", "sdh"]);
    expect(options.defer).toEqual({ "HV-024.sfx": "G15-202609301223", "HV-031.moderation": "G15-202609301223" });
    expect(options.reviews).toBe(true);
    expect(() => parseArguments(["--base", "http://x", "--film-a", token, "--deliveries", "dcp"])).toThrow("--deliveries takes");
    writeFileSync(token, "{\"projectId\":\"nope\"}");
    expect(() => parseArguments(["--base", "http://x", "--film-a", token])).toThrow("does not hold a project id and token");
  });
});
