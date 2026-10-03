import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BASIS, linesReading } from "../scripts/release-2-lines";
import { RELEASE_2_LINES, parseArguments, readLines, runRelease2, type FilmInput } from "../scripts/release-2-run";

/**
 * HV-030-23: what writing the run's runbook found missing in `scripts/release-2-run.ts`, against a
 * fake studio. Nothing here reaches staging or spends anything.
 *
 * - The front door retains no reference image, so `--lock-look` had nothing to lock: `--sheet` makes
 *   a character sheet and adopts its views first, as the desk's "Generate character sheets" does.
 * - The actor import sent no name, and the studio's import route needs one. It now sends the share's
 *   name and aliases, as the desk's form does, and a name film B already casts is caught before a
 *   share is minted (`--import-as`).
 * - Nothing set the record's declared spend or its lines' before and after: `--spend-declared`, and
 *   `--lines-before`/`--lines-after` with `scripts/release-2-lines.ts`'s readings.
 * - The signature was left to a host step: `--verify-c2pa` runs `scripts/verify-c2pa.ts`'s check over
 *   the files the studio serves, in a private directory that is removed afterwards.
 * - The operator's 15-minute credential lapses during a long run; an unreadable operator view no
 *   longer throws away the record.
 */
const UUID = (n: number) => "00000000-0000-4000-8000-" + n.toString(16).padStart(12, "0");
const sha = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const secret = (name: string) => Buffer.from(JSON.stringify({ kind: name, nonce: name })).toString("base64url") + "." + sha(name).slice(0, 43);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const scratch = mkdtempSync(join(tmpdir(), "hv-release-2-fixes-"));

const A = { projectId: UUID(0xa1), token: secret("fix-a") }, B = { projectId: UUID(0xb1), token: secret("fix-b") };
const NELL = UUID(0xa20), SHEET = UUID(0xa30), VIEW_REFS = [UUID(0xa31), UUID(0xa32)], SHARE_ID = UUID(0xa22), IMPORTED = UUID(0xb20);
const BED = UUID(0xe1), EDIT_A = UUID(0xa5), MIX_A = UUID(0xa6), VOICED_A = UUID(0xa7);
const FINAL_A = UUID(0xa2), FINAL_B = UUID(0xb2), ARTIFACT = secret("fix-artifact"), SHARE = secret("fix-share");
const MP4 = new TextEncoder().encode("mp4 bytes"), SIDECAR = new TextEncoder().encode("signed sidecar"), MANIFEST = JSON.stringify({ credentials: { type: "c2pa-sidecar", sidecar: { name: "provenance.c2pa", sha256: sha(SIDECAR) } } });
interface Fake { calls: { method: string; path: string; body: any }[]; sheetPolls: number; adopted: boolean; bCast: { name: string; aliases: string[] }[]; locked: string[] | null;
  /** Film A's jobs, as GET /api/projects/:id lists them. */
  aJobs: { id: string; stage: string; status: string; completedAt: string }[];
  /** Jobs whose export the studio did not sign (HV-031-15 signs films, sound mixes and takes, not picture edits). */
  unsigned: Set<string>; notes: number }
const fake: Fake = { calls: [], sheetPolls: 0, adopted: false, bCast: [], locked: null, aJobs: [], unsigned: new Set(), notes: 0 };
let server: ReturnType<typeof Bun.serve>;

beforeAll(() => {
  server = Bun.serve({ port: 0, async fetch(request) {
    const path = new URL(request.url).pathname, method = request.method;
    const body = ["GET", "HEAD"].includes(method) ? undefined : await request.json().catch(() => undefined);
    fake.calls.push({ method, path, body });
    if (path.startsWith(`/artifacts/${ARTIFACT}/unsigned/`)) return path.endsWith(".mp4") ? new Response(MP4) : json({ credentials: { type: "unsigned" } });
    if (path.startsWith(`/artifacts/${ARTIFACT}/`)) return new Response(path.endsWith(".c2pa") ? SIDECAR : path.endsWith(".mp4") ? MP4 : MANIFEST);
    const auth = request.headers.get("authorization"), film = auth === `Bearer ${A.token}` ? A : auth === `Bearer ${B.token}` ? B : null;
    if (!film) return json({ error: "unauthorized" }, 401);
    if (path.startsWith("/api/jobs/")) {
      const id = path.split("/").at(-1)!, stage = fake.aJobs.find(job => job.id === id)?.stage ?? "final";
      if (fake.unsigned.has(id)) { const prefix = `/artifacts/${ARTIFACT}/unsigned/${id}`; return json({ id, stage, status: "done", output: { mp4Url: prefix + "/export.mp4", manifestUrl: prefix + "/provenance.json" } }); }
      const prefix = `/artifacts/${ARTIFACT}/${film.projectId}/${id}`;
      return json({ id, stage, status: "done", output: { mp4Url: prefix + "/export.mp4", manifestUrl: prefix + "/provenance.json", c2paUrl: prefix + "/provenance.c2pa" } });
    }
    const rest = path.slice(`/api/projects/${film.projectId}`.length);
    if (method === "GET" && rest === "/spend") return json({ spentUsd: 0, heldUsd: 0, capUsd: 40 });
    if (method === "GET" && rest === "") return json({ projectId: film.projectId, jobs: film === A ? fake.aJobs : [] });
    // The route's own rule (packages/api/src/sound-ambience.ts): a completed film, dialogue, lip-sync or sound version.
    if (method === "POST" && rest.startsWith("/ambience/")) {
      const cut = fake.aJobs.find(job => job.id === rest.slice("/ambience/".length));
      return cut && ["final", "dialogue-replacement", "lip-sync", "sound-mix"].includes(cut.stage) ? json({ scenes: [{ preset: "canal-night" }], cues: [{ assetId: BED }], costUsd: 0 }, 201)
        : json({ error: "Choose a completed film, dialogue, lip-sync or sound version." }, 400);
    }
    if (method === "POST" && rest === "/crew/line-notes") return json({ script: { version: 2, sha256: "s" }, source: "openrouter", dropped: 0, crewSpend: { usd: 0.01, alerts: [] },
      notes: Array.from({ length: fake.notes }, (_, i) => ({ id: "n" + i, sceneNumber: 4, before: "Go on, then.", after: "Go on." })) });
    if (method === "POST" && rest === "/crew/line-notes/accept") return json({ version: 3, applied: body.acceptedIds });
    const nell = { id: NELL, name: "NELL", aliases: ["NELLIE"], kind: "original-fictional", references: fake.adopted ? VIEW_REFS.map(id => ({ id })) : [] };
    if (method === "GET" && rest === "/cast") return json({ casting: film === A ? { version: fake.adopted ? 4 : 3, characters: [{ id: UUID(0xa40), name: "AUGUST", kind: "original-fictional" }, nell] }
      : { version: 2, characters: fake.bCast.map((c, i) => ({ id: UUID(0xb40 + i), kind: "original-fictional", ...c })) } });
    if (method === "POST" && rest === `/cast/${NELL}/sheets`) return json({ jobId: SHEET, stage: "character-sheet", status: "queued", admitted: true }, 202);
    if (method === "GET" && rest === `/cast/${NELL}/sheets`)
      return json({ jobs: [{ id: SHEET, status: fake.sheetPolls++ > 0 ? "done" : "running", storyboard: [{ shotId: "front" }, { shotId: "side" }] }] });
    if (method === "POST" && rest === `/cast/${NELL}/sheets/${SHEET}/adopt`) { fake.adopted = true; return json({ casting: { version: 4, characters: [{ ...nell, references: VIEW_REFS.map(id => ({ id })) }] } }); }
    if (method === "PUT" && rest === `/cast/${NELL}/reference-lock`) {
      fake.locked = body.lock.assetIds;
      return json({ casting: { version: 5, characters: [{ ...nell, referenceLock: { revision: sha("lock"), assets: body.lock.assetIds.map((id: string) => ({ id })) } }] } });
    }
    if (method === "POST" && rest === `/cast/${NELL}/shares`) return json({ share: { id: SHARE_ID }, token: SHARE }, 201);
    if (method === "POST" && rest === "/cast/import") {
      // The studio's own rule: a name, aliases, and no label another record holds.
      if (typeof body.name !== "string" || !Array.isArray(body.aliases)) return json({ error: "Use an original fictional character or a consented real person, with a valid ID." }, 400);
      fake.bCast.push({ name: body.name, aliases: body.aliases });
      return json({ casting: { version: 3, characters: fake.bCast.map((c, i) => ({ id: i === fake.bCast.length - 1 ? IMPORTED : UUID(0xb40 + i), kind: "original-fictional", ...c })) } });
    }
    return json({ error: "not found" }, 404);
  } });
});
afterAll(() => server.stop(true));

const base = () => `http://127.0.0.1:${server.port}`;
const films = (): FilmInput[] => [{ key: "A", ...A, studio: { outcome: "completed", final: { jobId: FINAL_A } } }, { key: "B", ...B, studio: { outcome: "completed", final: { jobId: FINAL_B } } }];
const poll = { intervalMs: 1, limitMs: 5000 };

describe("identity, as the run needs it", () => {
  /** --sheet: a turnaround sheet on the studio's own picture profile, waited for, its views adopted, and the look locked to them. */
  test("--sheet gives a character with no reference image a character sheet's views, and the look is locked to them", async () => {
    fake.adopted = false; fake.sheetPolls = 0; fake.calls.length = 0;
    const record = await runRelease2({ base: base(), films: films(), poll, lockLook: true, lockCharacter: "NELL", sheet: true });
    const sheet = fake.calls.find(call => call.method === "POST" && call.path.endsWith("/sheets"));
    expect(sheet?.body).toEqual({ generationApproved: true, expectedVersion: 3, idempotencyKey: "release-2-sheet-00000000", settings: { kind: "turnaround", seed: 2026, sceneNumber: null } });
    expect(fake.calls.find(call => call.path.endsWith("/adopt"))?.body).toEqual({ viewIds: ["front", "side"], replaceExisting: false, expectedVersion: 3, attested: true });
    expect(fake.locked).toEqual(VIEW_REFS);
    expect(record.slices["HV-017.identity-lock"]).toEqual({ exercised: true, surface: "desk-api", ids: [NELL], deferredBy: null });
    expect(record.steps.find((s: any) => s.step === "lock-look").ids).toEqual([NELL, SHEET]);
    expect(record.identity.lock).toMatchObject({ characterId: NELL, name: "NELL", assets: 2, sheet: { jobId: SHEET, views: 2 } });
  });

  /** Without --sheet nothing is generated, and a character with nothing to lock is said to be so. */
  test("without --sheet a character with no reference image is recorded as unavailable, and no sheet is made", async () => {
    fake.adopted = false; fake.calls.length = 0;
    const record = await runRelease2({ base: base(), films: films(), poll, lockLook: true, lockCharacter: "NELL" });
    expect(fake.calls.some(call => call.path.includes("/sheets"))).toBe(false);
    expect(record.steps.find((s: any) => s.step === "lock-look")).toMatchObject({ outcome: "unavailable", note: "no character in film A retains a reference image to lock its look to" });
  });

  /** The import names the actor as the desk's form does: the share's own name and aliases. */
  test("the actor is imported under the share's own name and aliases, as the desk's import form sends them", async () => {
    fake.bCast = []; fake.calls.length = 0;
    const record = await runRelease2({ base: base(), films: films(), poll, shareActor: true, lockCharacter: "NELL" });
    expect(fake.calls.find(call => call.path.endsWith("/cast/import"))?.body).toEqual({ shareToken: SHARE, attested: true, expectedVersion: 2, name: "NELL", aliases: ["NELLIE"] });
    expect(record.slices["HV-017.cast-library"]).toMatchObject({ exercised: true, ids: [SHARE_ID, IMPORTED] });
    expect(record.identity.share).toMatchObject({ importedAs: "NELL" });
  });

  /** Film B casts NELL already, so the import would be refused; the step stops before a share is minted, and --import-as names the actor. */
  test("a name film B already casts stops the step before a share is minted, and --import-as imports the actor under its own name", async () => {
    fake.bCast = [{ name: "NELL", aliases: [] }]; fake.calls.length = 0;
    const stopped = await runRelease2({ base: base(), films: films(), poll, shareActor: true, lockCharacter: "NELL" });
    expect(stopped.steps.find((s: any) => s.step === "share-and-import-actor")).toMatchObject({ outcome: "stopped", note: "film B already casts NELL; import the actor under a name of its own with --import-as" });
    expect(fake.calls.some(call => call.path.endsWith("/shares"))).toBe(false);
    const renamed = await runRelease2({ base: base(), films: films(), poll, shareActor: true, lockCharacter: "NELL", importAs: "NELL FROM THE CANAL" });
    expect(fake.calls.find(call => call.path.endsWith("/cast/import"))?.body).toMatchObject({ name: "NELL FROM THE CANAL", aliases: [] });
    expect(renamed.slices["HV-017.cast-library"].exercised).toBe(true);
    expect(JSON.stringify(renamed)).not.toContain(SHARE);
  });
});

describe("spend and signatures, as the record needs them", () => {
  const reading = (spent: number) => linesReading(new Date("2026-10-02T10:00:00.000Z"), { generation: { spentUsd: 17 + spent, heldUsd: 0.5 }, voice: { spentUsd: 2 + spent, heldUsd: 0 },
    music: { spentUsd: spent, heldUsd: 0 }, crewSpentUsd: spent });

  /** The four lines, each read once, every dollar on one line; a figure that is not money is refused. */
  test("scripts/release-2-lines.ts reads every line the criteria name, with its basis, and nothing on the crew line is held", () => {
    const read = reading(0.25);
    expect(Object.keys(read.lines)).toEqual(Object.keys(RELEASE_2_LINES));
    expect(read.lines).toEqual({ generation: { spentUsd: 17.25, heldUsd: 0.5 }, voice: { spentUsd: 2.25, heldUsd: 0 }, music: { spentUsd: 0.25, heldUsd: 0 }, crew: { spentUsd: 0.25, heldUsd: 0 } });
    expect(Object.keys(read.basis)).toEqual(Object.keys(RELEASE_2_LINES));
    expect(read.basis).toEqual({ ...BASIS });
    expect(() => linesReading(new Date(), { generation: { spentUsd: -1, heldUsd: 0 }, voice: { spentUsd: 0, heldUsd: 0 }, music: { spentUsd: 0, heldUsd: 0 }, crewSpentUsd: 0 }))
      .toThrow("the generation line read a figure that is not money");
  });

  /** --spend-declared and the two readings fill exactly what the contract asks of criterion 4. */
  test("--spend-declared and the before and after readings fill the record's declared spend and each line's before and after", async () => {
    const before = join(scratch, "before.json"), after = join(scratch, "after.json"), token = join(scratch, "a.token");
    writeFileSync(before, JSON.stringify(reading(0))); writeFileSync(after, JSON.stringify(reading(0.25))); writeFileSync(token, JSON.stringify(A));
    const options = parseArguments(["--base", base(), "--film-a", token, "--spend-declared", "2", "--lines-before", before, "--lines-after", after]);
    expect(options.spendDeclared).toBe(2);
    const record = await runRelease2({ ...options, poll });
    expect(record.spendUsdDeclared).toBe(2);
    expect(record.ledgers.lines.music).toMatchObject({ limitUsd: 10, before: { spentUsd: 0, heldUsd: 0, at: "2026-10-02T10:00:00.000Z" }, after: { spentUsd: 0.25, heldUsd: 0 }, source: BASIS.music });
    const run = Object.values(record.ledgers.lines as Record<string, any>).reduce((sum, line) => sum + line.after.spentUsd - line.before.spentUsd, 0);
    expect(run).toBeCloseTo(1, 6);
    writeFileSync(after, JSON.stringify({ ...reading(0), lines: { voice: { spentUsd: 1, heldUsd: 0 } } }));
    expect(() => readLines(after)).toThrow("after.json is not a reading of the four spend lines (hv-release-lines/1)");
    expect(() => parseArguments(["--base", base(), "--film-a", token, "--spend-declared", "two"])).toThrow("--spend-declared takes a number of US dollars");
  });

  /** The operator's credential lives 15 minutes; one that has lapsed by the run's end is recorded as unreadable, and the record is still written. */
  test("an operator credential that can no longer be read is recorded as unavailable, and the run's record is still made", async () => {
    const record = await runRelease2({ base: base(), films: films(), poll, operatorToken: secret("lapsed-operator") });
    const [{ before, after }] = record.ledgers.snapshots;
    for (const snapshot of [before, after]) expect(snapshot.operator).toEqual({ unavailable: "/api/operator/status -> 401 unauthorized" });
    expect(JSON.stringify(record)).not.toContain(secret("lapsed-operator"));
  });

  /** --verify-c2pa: the three files the verifier reads, named as it expects, in a private directory that is gone afterwards. */
  test("--verify-c2pa checks each shared export from the files the studio serves, records the answer, and removes the files", async () => {
    const seen: { files: string[]; mp4: string; mode: number; anchor?: string; directory: string }[] = [];
    const verify = async (directory: string, anchorPem?: string) => {
      seen.push({ files: readdirSync(directory).sort(), mp4: readFileSync(join(directory, "export.mp4"), "utf8"), mode: statSync(directory).mode & 0o777, anchor: anchorPem, directory });
      return { ok: true, state: "Valid", codes: ["signingCredential.untrusted"], problems: [] };
    };
    const record = await runRelease2({ base: base(), films: films(), poll, provenance: true, verifyC2pa: { verify, anchorPem: "ROOT" } });
    expect(seen.map(value => value.files)).toEqual([0, 1].map(() => ["export.mp4", "provenance.c2pa", "provenance.json"]));
    expect(seen.every(value => value.mp4 === "mp4 bytes" && value.mode === 0o700 && value.anchor === "ROOT" && !existsSync(value.directory))).toBe(true);
    expect(record.provenance.exports.map((value: any) => value.verification)).toEqual([0, 1].map(() => ({ ok: true, state: "Valid", codes: ["signingCredential.untrusted"], problems: [] })));
    expect(record.slices["HV-031.signed-c2pa"]).toMatchObject({ exercised: true, ids: [FINAL_A, FINAL_B] });
    expect(JSON.stringify(record)).not.toContain(ARTIFACT);
    // A sidecar that does not verify leaves the part for the record to say so, and the files are still removed.
    const failed = await runRelease2({ base: base(), films: films(), poll, provenance: true,
      verifyC2pa: { verify: async () => ({ ok: false, state: "Invalid", codes: [], problems: ["The C2PA manifest is not intact or not bound to this MP4."] }) } });
    expect(failed.steps.find((s: any) => s.step === "provenance")).toMatchObject({ outcome: "unavailable", note: "a shared export's signed sidecar did not verify; see provenance.exports" });
    expect(failed.slices["HV-031.signed-c2pa"].exercised).toBe(false);
  });
});

describe("the exit run's first desk pass, and running steps again", () => {
  /** Film A's jobs as the front door leaves them: the film, its voiced version, the Composer's mix, and the Editor's titled cut. */
  const frontDoorJobs = () => [
    { id: FINAL_A, stage: "final", status: "done", completedAt: "2026-10-01T22:00:00.000Z" },
    { id: VOICED_A, stage: "dialogue-replacement", status: "done", completedAt: "2026-10-01T22:10:00.000Z" },
    { id: MIX_A, stage: "sound-mix", status: "done", completedAt: "2026-10-01T22:20:00.000Z" },
    { id: EDIT_A, stage: "picture-edit", status: "done", completedAt: "2026-10-01T22:30:00.000Z" }];

  /** The run stopped asking for ambience on the titled picture edit. The route takes a film, dialogue or sound version; the Composer's mix is preferred. */
  test("ambience is asked for film A's newest sound, dialogue or film version, never the titled picture edit, and --ambience-cut names another", async () => {
    fake.aJobs = frontDoorJobs(); fake.calls.length = 0;
    const record = await runRelease2({ base: base(), films: films(), poll, ambience: true });
    const asked = fake.calls.filter(call => call.method === "POST" && call.path.includes("/ambience/")).map(call => call.path.split("/").at(-1));
    expect(asked).toEqual([MIX_A]);
    expect(record.sound.ambience).toMatchObject({ status: "made", cutId: MIX_A, assets: [BED] });
    expect(record.slices["HV-024.ambience"]).toMatchObject({ exercised: true, ids: [BED] });
    // Without a mix, the voiced version; without that, the film.
    fake.aJobs = frontDoorJobs().filter(job => job.stage !== "sound-mix");
    expect((await runRelease2({ base: base(), films: films(), poll, ambience: true })).sound.ambience.cutId).toBe(VOICED_A);
    fake.aJobs = frontDoorJobs();
    expect((await runRelease2({ base: base(), films: films(), poll, ambience: true, ambienceCut: FINAL_A })).sound.ambience.cutId).toBe(FINAL_A);
    expect(parseArguments(["--base", base(), "--film-a", join(scratch, "a.token"), "--ambience", "--ambience-cut", FINAL_A]).ambienceCut).toBe(FINAL_A);
  });

  /** Picture edits are not signed (HV-031-15), so the shared exports said nothing about the key. A signed film, mix or take of either film does; so does the operator's word. */
  test("the host holds the key when a film, mix or take is signed, or the operator says so, and the record names which; neither alone exercises the part", async () => {
    fake.aJobs = frontDoorJobs(); fake.unsigned = new Set([FINAL_A, FINAL_B, EDIT_A]);
    const films = (): FilmInput[] => [{ key: "A", ...A, studio: { outcome: "completed", final: { jobId: EDIT_A } } }, { key: "B", ...B, studio: { outcome: "completed", final: { jobId: FINAL_B } } }];
    const signedMix = await runRelease2({ base: base(), films: films(), poll, provenance: true });
    expect(signedMix.provenance.hostHoldsKey).toBe(true);
    expect(signedMix.provenance.hostKey).toMatchObject({ basis: ["signed-export"], signedExport: { film: "A", jobId: MIX_A, stage: "sound-mix", sidecarSha256: sha(SIDECAR) }, operatorDeclared: false });
    expect(signedMix.slices["HV-031.signed-c2pa"].exercised).toBe(false);
    fake.unsigned = new Set([FINAL_A, FINAL_B, EDIT_A, MIX_A, VOICED_A]);
    const declared = await runRelease2({ base: base(), films: films(), poll, provenance: true, hostKeyConfigured: true });
    expect(declared.provenance).toMatchObject({ hostHoldsKey: true, hostKey: { basis: ["operator"], signedExport: null, operatorDeclared: true } });
    const neither = await runRelease2({ base: base(), films: films(), poll, provenance: true });
    expect(neither.provenance).toMatchObject({ hostHoldsKey: false, hostKey: { basis: [], signedExport: null } });
    fake.unsigned = new Set();
  });

  /** After the product fixes deploy, the stopped steps run again on the first pass's record, alone: nothing else is redone, and the stop is kept. */
  test("--merge with only --ambience, --line-notes or --provenance reruns that step alone, and keeps a stop it replaced under supersededSteps", async () => {
    fake.aJobs = frontDoorJobs(); fake.adopted = false; fake.sheetPolls = 0; fake.notes = 0;
    const first = await runRelease2({ base: base(), films: films(), poll, lockLook: true, lockCharacter: "NELL", sheet: true, ambience: true, ambienceCut: EDIT_A,
      lineNotes: { request: "Tighten the last scene", accept: true } });
    expect(first.steps.find((s: any) => s.step === "ambience")).toMatchObject({ outcome: "stopped", note: "/api/projects/:id/ambience/:id -> 400 Choose a completed film, dialogue, lip-sync or sound version." });
    expect(first.steps.find((s: any) => s.step === "line-notes")).toMatchObject({ outcome: "unavailable" });
    const saved = JSON.parse(JSON.stringify(first));
    fake.calls.length = 0; fake.notes = 1;
    const again = await runRelease2({ base: base(), films: films(), poll, merge: saved, ambience: true });
    const again2 = await runRelease2({ base: base(), films: films(), poll, merge: JSON.parse(JSON.stringify(again)), lineNotes: { request: "Tighten the last scene", accept: true } });
    const again3 = await runRelease2({ base: base(), films: films(), poll, merge: JSON.parse(JSON.stringify(again2)), provenance: true, hostKeyConfigured: true });
    // Nothing the first pass did is done again.
    expect(fake.calls.some(call => call.path.includes("/sheets") || call.path.endsWith("/reference-lock"))).toBe(false);
    for (const step of ["lock-look", "ambience", "line-notes", "provenance"]) expect(again3.steps.filter((s: any) => s.step === step)).toHaveLength(1);
    expect(again3.steps.find((s: any) => s.step === "lock-look")).toEqual(first.steps.find((s: any) => s.step === "lock-look"));
    expect(again3.slices["HV-017.identity-lock"]).toEqual(first.slices["HV-017.identity-lock"]);
    expect(again3.steps.find((s: any) => s.step === "ambience")).toMatchObject({ outcome: "done", parts: ["HV-024.ambience"] });
    expect(again3.sound.ambience).toMatchObject({ cutId: MIX_A, assets: [BED] });
    expect(again3.steps.find((s: any) => s.step === "line-notes")).toMatchObject({ outcome: "done", parts: ["HV-016.line-notes"] });
    expect(again3.writersRoom.lineNotes).toMatchObject({ source: "openrouter", notes: 1, accepted: 1 });
    expect(again3.provenance.hostKey.basis).toContain("operator");
    // The stops it replaced are still in the record, with what stopped them.
    expect(again3.supersededSteps.map((s: any) => [s.step, s.outcome])).toEqual([["ambience", "stopped"], ["line-notes", "unavailable"]]);
    expect(again3.supersededSteps[0].note).toContain("Choose a completed film, dialogue, lip-sync or sound version.");
  });
});
