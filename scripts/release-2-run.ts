/**
 * HV-030-22: Release 2's run, after the front door.
 *
 * `scripts/studio-run.ts` takes each film from a pasted script to a shared film, as a creator would.
 * This drives everything Release 2 adds behind that door, through the Director's desk's own routes,
 * and writes the run's record in schema `hv-release-run/2`. Every step is optional. Each records the
 * surface it used, its outcome and the studio's own ids, and fills the slice parts it exercises; a
 * part nothing exercised stays `exercised: false` until it is deferred to a gate entry
 * (`--defer part=GATE-ID`). `test/release-2-run.test.ts` holds the finished record to
 * docs/ROADMAP.md's Release 2 exit criteria.
 *
 *   bun scripts/release-2-run.ts --base http://127.0.0.1:8081 --out run.json \
 *     --film-a a.token --studio-a a.json --script-a docs/evidence/release-2/scripts/a.fountain \
 *     --film-b b.token --studio-b b.json --script-b docs/evidence/release-2/scripts/b.fountain \
 *     --lock-look --share-actor --continuity --continuity-apply \
 *     --deliveries grade,open-captions,sdh,reframe-9:16,reframe-1:1,mezzanine \
 *     --ambience --music "a quiet piano under rain" --music-seconds 30 \
 *     --import-fdx script.fdx --import-pdf script.pdf --line-notes "tighten the dialogue" --accept-notes \
 *     --provenance --reviews --operator-token diagnostics.json \
 *     --defer HV-030.voice-meetings=G15-202609301223 --evidence HV-039.wcag=docs/ACCESSIBILITY-AUDIT.md
 *
 * HV-030-23 adds what the run itself needed: `--sheet` gives the character to be locked its reference
 * images from a character sheet when it has none; `--import-as` names the imported actor when film B
 * already casts that name; `--spend-declared` declares the run's spend; `--lines-before` and
 * `--lines-after` take the four lines' readings from `scripts/release-2-lines.ts`; and `--verify-c2pa`
 * checks each shared export's signature with `scripts/verify-c2pa.ts`, from the files the studio
 * serves, in a private directory that is removed afterwards. After the first run: `--ambience` asks
 * for film A's newest completed sound, dialogue or film version (`--ambience-cut` names another);
 * `--host-key-configured` is the operator's word that the C2PA key is set; and a step run again with
 * `--merge` replaces its entry, keeping one that had not succeeded under `supersededSteps`.
 *
 * It reads project tokens, an actor share token and the operator's diagnostics credential, because
 * those are the only keys to what it drives. It never writes or prints any of them, nor a signed
 * media URL. It never reads a provider key.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { readProjectKey, sha256 } from "./release-run-files";

export const RELEASE_RUN_SCHEMA = "hv-release-run/2";
export const SURFACES = ["front-door", "desk-api", "reviewer", "operator", "audit"] as const;
export type Surface = typeof SURFACES[number];
/** The parts of Release 2's slices and the surface each is exercised through: docs/ROADMAP.md's table, which the test holds this to. */
export const RELEASE_2_PARTS: Readonly<Record<string, Surface>> = Object.freeze({
  "HV-030.voice-meetings": "front-door", "HV-030.style-memory": "front-door",
  "HV-021.continuity-repair": "desk-api",
  "HV-017.identity-lock": "desk-api", "HV-017.cast-library": "desk-api",
  "HV-022.elevenlabs-voice": "front-door",
  "HV-024.music": "desk-api", "HV-024.ambience": "desk-api", "HV-024.sfx": "desk-api",
  "HV-026.grade-qc": "desk-api",
  "HV-027.reframes": "desk-api", "HV-027.captions": "desk-api", "HV-027.mezzanine": "desk-api",
  "HV-016.import": "desk-api", "HV-016.line-notes": "desk-api",
  "HV-029.timecoded-comments": "reviewer", "HV-029.stage-approvals": "reviewer",
  "HV-031.signed-c2pa": "desk-api", "HV-031.moderation": "desk-api", "HV-031.expiry-takedown": "operator",
  "HV-039.wcag": "audit",
});
/** The spend lines and their limits: docs/ROADMAP.md's table, which the test holds this to. */
export const RELEASE_2_LINES: Readonly<Record<string, number>> = Object.freeze({ generation: 450, voice: 25, music: 10, crew: 25 });
/** The versions the ambience route accepts as its cut, most preferred first. */
export const AMBIENCE_SOURCE_STAGES = ["sound-mix", "dialogue-replacement", "final"] as const as readonly string[];
/** The exports HV-031-15 signs: the film, the mixed film and takes. A signed one is evidence the host holds the key. */
export const SIGNED_EXPORT_STAGES = ["sound-mix", "final", "take-final", "take-preview"] as const as readonly string[];
export const DELIVERY_STEP_KINDS = ["grade", "open-captions", "sdh", "reframe-9:16", "reframe-1:1", "mezzanine"] as const;

export interface SliceEntry { exercised: boolean; surface: Surface; ids: string[]; deferredBy: string | null }
export interface Step { step: string; surface: Surface; film: "A" | "B" | null; outcome: "done" | "unavailable" | "stopped"; parts: string[]; ids: string[]; note?: string; at: string }
export interface StudioReport {
  schema?: string; projectId?: string; format?: string; tone?: string; outcome?: string; finishNotes?: string[];
  final?: { jobId: string }; review?: { linkId: string; jobId: string; maxViews: number; permission: string };
  styleCard?: { kept?: { sha256?: string; error?: string }; attached?: { sha256: string } };
  readThrough?: { readStyleCard?: boolean; crewSpendUsd?: number; source?: string; fallbackReason?: string }; plan?: { crewSpendUsd?: number; source?: string; fallbackReason?: string };
  script?: { format: string; sha256: string; importNotes?: string[] };
}
/** One reading of the four spend lines, as `scripts/release-2-lines.ts` writes it. */
export interface LinesReading { schema: "hv-release-lines/1"; at: string; lines: Record<string, { spentUsd: number; heldUsd: number }>; basis: Record<string, string> }
/** What `scripts/verify-c2pa.ts` answers for one export directory. */
export interface C2paCheck { ok: boolean; state: string; codes: string[]; problems: string[] }
export interface FilmInput { key: "A" | "B"; projectId: string; token: string; studio?: StudioReport; script?: string }
export interface Release2Options {
  base: string; films: FilmInput[];
  imports?: { format: "final-draft" | "pdf"; path: string }[];
  lineNotes?: { request: string; accept: boolean };
  lockLook?: boolean; lockCharacter?: string; sheet?: boolean; shareActor?: boolean; importAs?: string;
  continuity?: { apply: boolean };
  deliveries?: string[]; cut?: string;
  /** The cut ambience is made for; otherwise film A's newest completed sound, dialogue or film version (`ambienceSource`). */
  ambienceCut?: string;
  /** The operator states the host's C2PA key and certificate are set and the workers passed their startup check. */
  hostKeyConfigured?: boolean;
  ambience?: boolean; music?: { prompt: string; seconds: number };
  reviews?: boolean; provenance?: boolean;
  /** Verify each shared export's signature from the files the studio serves; `anchorPem` makes a trusted signer read `Trusted`. */
  verifyC2pa?: { anchorPem?: string; verify?: (directory: string, anchorPem?: string) => Promise<C2paCheck> };
  operatorToken?: string;
  spendDeclared?: number; lines?: { before?: LinesReading; after?: LinesReading };
  defer?: Record<string, string>; evidence?: Record<string, string[]>;
  merge?: Record<string, unknown>;
  poll?: { intervalMs: number; limitMs: number };
}
type Json = Record<string, any>;

/** An id or path never travels with a credential; the masked path is what an error may say. */
const masked = (path: string) => path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ":id");
const now = () => new Date().toISOString();
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function runRelease2(options: Release2Options): Promise<Json> {
  const base = options.base.replace(/\/$/, ""), poll = options.poll ?? { intervalMs: 5000, limitMs: 30 * 60 * 1000 };
  const film = (key: "A" | "B") => options.films.find(value => value.key === key);
  async function request(path: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<{ status: number; body: Json }> {
    const response = await fetch(base + path, { method: init.method ?? "GET", headers: { origin: base, ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    const text = await response.text();
    let body: Json = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 200) }; }
    return { status: response.status, body };
  }
  async function call(path: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<Json> {
    const { status, body } = await request(path, init);
    if (status < 200 || status > 299) throw new Error(masked(path) + " -> " + status + " " + (body.error ?? ""));
    return body;
  }
  const project = (input: FilmInput, rest = "") => `/api/projects/${input.projectId}${rest}`;

  const merged = (options.merge ?? {}) as Json;
  const record: Json = {
    schema: RELEASE_RUN_SCHEMA, release: "2 \"Voice and crew depth\"", recordedAt: now(), driver: "scripts/release-2-run.ts (the desk's own routes) after scripts/studio-run.ts (createStudioFlow)",
    spendUsdDeclared: options.spendDeclared ?? merged.spendUsdDeclared ?? null, creator: merged.creator ?? "one anonymous creator, holding both films' project tokens",
    films: merged.films ?? [], steps: merged.steps ?? [],
    slices: Object.fromEntries(Object.entries(RELEASE_2_PARTS).map(([part, surface]) => [part, merged.slices?.[part] ?? { exercised: false, surface, ids: [], deferredBy: null }])),
    ledgers: merged.ledgers ?? null, memory: merged.memory ?? null, continuity: merged.continuity ?? null, identity: merged.identity ?? null,
    deliveries: merged.deliveries ?? [], sound: merged.sound ?? null, writersRoom: merged.writersRoom ?? null,
    provenance: merged.provenance ?? null, review: merged.review ?? null,
    stoppedAttempts: merged.stoppedAttempts ?? [], knownGaps: merged.knownGaps ?? [],
    // A step run again replaces its entry; one that had not succeeded, and was replaced by a different answer, is kept here.
    supersededSteps: merged.supersededSteps ?? [],
  };
  const steps: Step[] = record.steps;
  const exercise = (part: string, ids: string[]) => {
    const slice = record.slices[part] as SliceEntry;
    slice.exercised = true; slice.deferredBy = null; slice.ids = [...new Set([...slice.ids, ...ids])];
  };
  /** One step: its surface, its film, what it exercised. A failure is recorded as the step stopping, and the run goes on. */
  /** `parts` share the step's ids; `byPart` gives each part only its own, when one step proves several. */
  type Outcome = { outcome?: Step["outcome"]; parts?: string[]; byPart?: Record<string, string[]>; ids?: string[]; note?: string };
  async function step(name: string, surface: Surface, key: "A" | "B" | null, body: () => Promise<Outcome>) {
    const entry: Step = { step: name, surface, film: key, outcome: "done", parts: [], ids: [], at: now() };
    try {
      const result = await body();
      const byPart = { ...Object.fromEntries((result.parts ?? []).map(part => [part, result.ids ?? []])), ...result.byPart };
      entry.outcome = result.outcome ?? "done"; entry.ids = [...new Set([...(result.ids ?? []), ...Object.values(byPart).flat()])]; entry.note = result.note;
      if (entry.outcome === "done") for (const [part, ids] of Object.entries(byPart)) { exercise(part, ids); entry.parts.push(part); }
    } catch (error) { entry.outcome = "stopped"; entry.note = error instanceof Error ? error.message : String(error); }
    if (entry.note === undefined) delete entry.note;
    // A step run again (a --merge of an earlier record) replaces its earlier entry rather than repeating it.
    const earlier = steps.findIndex(value => value.step === name && value.film === key && (name !== "evidence" || value.parts.join() === entry.parts.join()));
    // One that had not succeeded, and now answers differently, is kept under supersededSteps; the same answer again is not news.
    if (earlier >= 0) {
      const [gone] = steps.splice(earlier, 1);
      if (gone!.outcome !== "done" && (gone!.outcome !== entry.outcome || gone!.note !== entry.note)) record.supersededSteps.push({ ...gone, supersededAt: entry.at });
    }
    steps.push(entry);
  }
  /** A signed media link: fetched, used and dropped. An error names the kind of link, never the link, which is a key to the film. */
  async function artifact(url: string): Promise<Response> {
    const response = await fetch(base + url, { headers: { origin: base } });
    if (!response.ok) throw new Error("a signed artifact link -> " + response.status);
    return response;
  }

  // The ledgers, before anything here spends: each film's own line, and the operator's whole-studio view when given a credential.
  async function snapshot(): Promise<Json> {
    const films: Json = {};
    for (const input of options.films) films[input.key] = await call(project(input, "/spend"), { token: input.token });
    let operator: Json | null = null;
    // HV-030-23: the diagnostics credential lives 15 minutes and a run with deliveries takes longer, so
    // an operator view that can no longer be read is recorded as such, and never costs the record.
    if (options.operatorToken) try {
      const status = await call("/api/operator/status", { token: options.operatorToken });
      operator = { budget: status.database?.value?.budget ?? null,
        byProvider: (status.costs?.value?.byProvider ?? []).map((row: Json) => ({ provider: row.provider, monthUsd: row.monthUsd })) };
    } catch (error) { operator = { unavailable: error instanceof Error ? error.message : String(error) }; }
    return { at: now(), films, operator };
  }
  const before = await snapshot();

  // The front door, read back: what studio-run.ts made, and the cast and jobs the studio holds for it.
  const crewUsd: number[] = [];
  for (const input of options.films) {
    const studio = input.studio ?? {}, shown = await call(project(input), { token: input.token }), cast = await call(project(input, "/cast"), { token: input.token });
    const jobs = (shown.jobs ?? []).map((job: Json) => ({ id: job.id, stage: job.stage, status: job.status }));
    const characters = (cast.casting?.characters ?? []).map((c: Json) => ({ id: c.id, name: c.name, kind: c.kind, voiceProvider: c.audioVoice?.provider ?? null }));
    const shared = studio.review?.jobId ?? studio.final?.jobId ?? null;
    crewUsd.push(studio.readThrough?.crewSpendUsd ?? 0, studio.plan?.crewSpendUsd ?? 0);
    const entry: Json = { key: input.key, projectId: input.projectId, format: studio.format ?? null, tone: studio.tone ?? null, script: input.script ?? null,
      driver: "scripts/studio-run.ts (createStudioFlow)", outcome: studio.outcome ?? null, final: studio.final?.jobId ?? null, shared,
      finishNotes: studio.finishNotes ?? [], styleCard: studio.styleCard ?? null, readStyleCard: studio.readThrough?.readStyleCard === true, cast: characters, jobs,
      scriptFile: studio.script ?? null,
      // Which vendor answered each crew step: "openrouter", "synthetic", "anthropic", or the stand-in and why.
      crew: { readThrough: studio.readThrough?.source ?? null, plan: studio.plan?.source ?? null,
        fallbacks: [studio.readThrough?.fallbackReason, studio.plan?.fallbackReason].filter(Boolean) },
      review: studio.review ? { linkId: studio.review.linkId, boundJobId: studio.review.jobId, maxViews: studio.review.maxViews, permission: studio.review.permission } : null };
    record.films = [...record.films.filter((value: Json) => value.key !== input.key), entry];
    await step("pitch-to-shared-film", "front-door", input.key, async () => studio.outcome === "completed" && shared
      ? { ids: [input.projectId, shared] } : { outcome: "stopped", note: "studio-run.ts did not report this film completed and shared" });
    const takes = jobs.filter((job: Json) => job.stage === "audio-take" && job.status === "done").map((job: Json) => job.id);
    await step("production-voices", "front-door", input.key, async () => characters.some((c: Json) => c.voiceProvider === "elevenlabs") && takes.length
      ? { parts: ["HV-022.elevenlabs-voice"], ids: takes }
      : { outcome: "unavailable", note: "no character in this film is voiced by ElevenLabs with a finished take" });
  }
  const filmA = film("A"), filmB = film("B");
  const keptCard = filmA?.studio?.styleCard?.kept?.sha256, attachedCard = filmB?.studio?.styleCard?.attached?.sha256;
  if (filmA && filmB) await step("style-card-memory", "front-door", "B", async () => {
    if (!keptCard || keptCard !== attachedCard || filmB.studio?.readThrough?.readStyleCard !== true)
      return { outcome: "stopped", note: "film B was not pitched with the style card film A kept, or its read-through did not read it" };
    record.memory = { styleCard: { schema: "hv-crew-style-card/1", sha256: keptCard, keptFrom: filmA.projectId, attachedTo: filmB.projectId, readByCrew: true } };
    return { parts: ["HV-030.style-memory"], ids: [filmA.projectId, filmB.projectId, keptCard] };
  });

  // Identity: lock a look in film A, then share that actor and import it into film B.
  /**
   * HV-030-23: the front door retains no reference image, so a character has nothing to lock its look
   * to. `--sheet` does what the desk's "Generate character sheets" does: a turnaround sheet on the
   * studio's own picture profile, waited for, and up to four of its views adopted as references.
   */
  async function sheetReferences(input: FilmInput, character: Json, version: number): Promise<{ casting: Json; jobId: string; views: number }> {
    const route = project(input, `/cast/${character.id}/sheets`);
    const queued = await call(route, { method: "POST", token: input.token,
      body: { generationApproved: true, expectedVersion: version, idempotencyKey: `release-2-sheet-${character.id.slice(0, 8)}`, settings: { kind: "turnaround", seed: 2026, sceneNumber: null } } });
    const started = Date.now();
    let job: Json | undefined;
    for (;;) {
      job = ((await call(route, { token: input.token })).jobs as Json[]).find(value => value.id === queued.jobId);
      if (job && ["done", "failed", "cancelled"].includes(job.status)) break;
      if (Date.now() - started > poll.limitMs) throw new Error("The character sheet did not finish within " + Math.round(poll.limitMs / 60000) + " minutes.");
      await wait(poll.intervalMs);
    }
    if (job.status !== "done") throw new Error("The character sheet did not finish: " + (job.failureReason ?? job.cancelReason ?? job.status));
    const viewIds = ((job.storyboard ?? []) as Json[]).slice(0, 4).map(frame => frame.shotId as string);
    if (!viewIds.length) throw new Error("The character sheet finished with no view to adopt.");
    const adopted = await call(project(input, `/cast/${character.id}/sheets/${job.id}/adopt`), { method: "POST", token: input.token,
      body: { viewIds, replaceExisting: false, expectedVersion: version, attested: true } });
    return { casting: adopted.casting, jobId: job.id, views: viewIds.length };
  }
  let lockedId: string | undefined;
  if (options.lockLook && filmA) await step("lock-look", "desk-api", "A", async () => {
    let { casting } = await call(project(filmA, "/cast"), { token: filmA.token });
    const pick = (characters: Json[]) => options.lockCharacter ? characters.find(c => c.name === options.lockCharacter)
      : characters.find(c => (c.references?.length ?? 0) > 0) ?? (options.sheet ? characters.find(c => c.kind === "original-fictional") : undefined);
    let character = pick(casting.characters as Json[]), sheet: { jobId: string; views: number } | null = null;
    if (options.sheet && character && !(character.references?.length)) {
      const made = await sheetReferences(filmA, character, casting.version);
      casting = made.casting; sheet = { jobId: made.jobId, views: made.views };
      character = (casting.characters as Json[]).find(c => c.id === character!.id);
    }
    if (!character || !(character.references?.length)) return { outcome: "unavailable", note: "no character in film A retains a reference image to lock its look to" };
    const saved = await call(project(filmA, `/cast/${character.id}/reference-lock`), { method: "PUT", token: filmA.token,
      body: { expectedVersion: casting.version, lock: { assetIds: character.references.slice(0, 4).map((r: Json) => r.id), label: "Release 2 locked look", note: "" } } });
    const locked = (saved.casting.characters as Json[]).find(c => c.id === character!.id)?.referenceLock;
    lockedId = character.id;
    record.identity = { ...record.identity, lock: { film: "A", characterId: character.id, name: character.name, revision: locked?.revision ?? null, assets: locked?.assets?.length ?? 0,
      castingVersion: saved.casting.version, sheet } };
    return { byPart: { "HV-017.identity-lock": [character.id] }, ids: [character.id, ...(sheet ? [sheet.jobId] : [])] };
  });
  if (options.shareActor && filmA && filmB) await step("share-and-import-actor", "desk-api", "B", async () => {
    const { casting } = await call(project(filmA, "/cast"), { token: filmA.token });
    const character = (casting.characters as Json[]).find(c => lockedId ? c.id === lockedId : options.lockCharacter ? c.name === options.lockCharacter : c.kind === "original-fictional");
    if (!character) return { outcome: "unavailable", note: "film A has no original character to share" };
    // HV-030-23: the import names the actor, as the desk's import form does (the share's own name and
    // aliases by default). A name film B already casts is refused by the studio, so it is caught here,
    // before a share is minted, and `--import-as` gives the actor a name of its own in film B.
    const target = (await call(project(filmB, "/cast"), { token: filmB.token })).casting, known = new Set((target.characters as Json[]).map(c => c.id));
    const name: string = options.importAs ?? character.name, aliases: string[] = options.importAs ? [] : character.aliases ?? [];
    const taken = new Set((target.characters as Json[]).flatMap(c => [c.name, ...(c.aliases ?? [])]).map((label: string) => label.toLocaleUpperCase("en-US")));
    if ([name, ...aliases].some(label => taken.has(label.toLocaleUpperCase("en-US"))))
      return { outcome: "stopped", note: "film B already casts " + name + "; import the actor under a name of its own with --import-as" };
    // The share token is the only key to the shared actor: it goes from one call to the next and nowhere else.
    const shared = await call(project(filmA, `/cast/${character.id}/shares`), { method: "POST", token: filmA.token, body: { expectedVersion: casting.version, attested: true } });
    const imported = await call(project(filmB, "/cast/import"), { method: "POST", token: filmB.token, body: { shareToken: shared.token, attested: true, expectedVersion: target.version, name, aliases } });
    const arrived = (imported.casting.characters as Json[]).find(c => !known.has(c.id));
    if (!arrived) throw new Error("The import answered, but no new character is in film B's cast.");
    record.identity = { ...record.identity, share: { from: "A", to: "B", shareId: shared.share.id, characterId: character.id, importedId: arrived.id, importedAs: name,
      lockCarried: Boolean(arrived.referenceLock), lookNote: imported.lookNote ?? null } };
    return { parts: ["HV-017.cast-library"], ids: [shared.share.id, arrived.id] };
  });

  // Continuity: the Supervisor's report and repair on film A, applied only when asked and only what was shown.
  if (options.continuity && filmA) await step("continuity-repair", "desk-api", "A", async () => {
    const desk = await call(project(filmA, "/direction"), { token: filmA.token });
    const review = await call(project(filmA, "/direction/continuity/repair"), { method: "POST", token: filmA.token, body: {} });
    const edits = review.proposal?.edits ?? [], findings = (review.report?.scenes ?? []).reduce((sum: number, scene: Json) => sum + (scene.findings?.length ?? 0), 0);
    let applied: Json | null = null;
    if (options.continuity!.apply && edits.length)
      applied = (await call(project(filmA, "/direction/continuity/repair/accept"), { method: "POST", token: filmA.token,
        body: { edits, expectedVersion: desk.direction.version, expectedScriptVersion: review.scriptVersion } })).direction;
    record.continuity = { film: "A", findings, edits: edits.length, refused: review.proposal?.refused?.length ?? 0, summary: review.summary ?? null,
      applied: Boolean(applied), directionVersion: { before: desk.direction.version, after: applied?.version ?? desk.direction.version } };
    // Exercised when the repair was reviewed and, if it proposed edits, applied.
    return edits.length && !applied ? { outcome: "unavailable", note: "the repair was reviewed but not applied (--continuity-apply)", ids: [filmA.projectId] }
      : { parts: ["HV-021.continuity-repair"], ids: [filmA.projectId] };
  });

  // The cut deliveries are made from: --cut, else film A's newest deliverable source.
  let cut = options.cut;
  if (!cut && filmA && options.deliveries?.length) {
    try { cut = ((await call(project(filmA, "/deliveries"), { token: filmA.token })).sources as Json[]).find(source => !source.unavailable)?.id; } catch { cut = undefined; }
  }
  if (options.deliveries?.length && filmA) {
    const asked = options.deliveries;
    const made: Json[] = [];
    await step("deliveries", "desk-api", "A", async () => {
      if (!cut) return { outcome: "unavailable", note: "film A has no finished cut a deliverable can be made from" };
      const offer = await call(project(filmA, `/deliveries/${cut}`), { token: filmA.token });
      for (const kind of asked) {
        const offered = (offer.offers as Json[]).find(value => value.kind === kind);
        if (!offered?.available) { made.push({ kind, jobId: null, status: "not-offered", reason: offered?.reason ?? "not a deliverable this studio makes" }); continue; }
        const queued = await call(project(filmA, `/deliveries/${cut}`), { method: "POST", token: filmA.token,
          body: { idempotencyKey: `release-2-${kind.replace(":", "x")}-${cut.slice(0, 8)}`, kind, ...(kind === "grade" ? { grade: offer.grade.neutral } : {}) } });
        made.push({ kind, jobId: queued.jobId, status: "queued" });
      }
      const started = Date.now();
      for (;;) {
        const jobs = (await call(project(filmA, `/deliveries/${cut}`), { token: filmA.token })).jobs as Json[];
        for (const entry of made.filter(value => value.jobId)) {
          const job = jobs.find(value => value.id === entry.jobId);
          if (!job) continue;
          Object.assign(entry, { status: job.status, failureReason: job.failureReason ?? null, unavailable: job.unavailable ?? null,
            sha256: job.output?.sha256 ?? null, bytes: job.output?.bytes ?? null, quality: job.output?.quality?.verdict ?? null,
            ...(job.grade ? { gradeCheck: job.grade.check?.verdict ?? null } : {}) });
        }
        if (made.every(value => !value.jobId || ["done", "failed", "cancelled"].includes(value.status))) break;
        if (Date.now() - started > poll.limitMs) throw new Error("The deliverables did not finish within " + Math.round(poll.limitMs / 60000) + " minutes.");
        await wait(poll.intervalMs);
      }
      record.deliveries = made.map(value => ({ film: "A", cutId: cut, ...value }));
      const done = (kind: string) => made.find(value => value.kind === kind && value.status === "done" && value.sha256);
      const byPart: Record<string, string[]> = {}, ids: string[] = made.filter(value => value.status === "done").map(value => value.jobId);
      if (done("grade")?.gradeCheck) byPart["HV-026.grade-qc"] = [done("grade")!.jobId];
      if (done("reframe-9:16") && done("reframe-1:1")) byPart["HV-027.reframes"] = [done("reframe-9:16")!.jobId, done("reframe-1:1")!.jobId];
      if (done("open-captions") && done("sdh")) byPart["HV-027.captions"] = [done("open-captions")!.jobId, done("sdh")!.jobId];
      if (done("mezzanine")) byPart["HV-027.mezzanine"] = [done("mezzanine")!.jobId];
      return { byPart, ids, ...(made.some(value => value.status !== "done") ? { note: "not every deliverable asked for was made; see deliveries" } : {}) };
    });
  }

  /**
   * HV-030-23: the version the ambience route accepts (packages/api/src/sound-ambience.ts): a completed
   * film, dialogue or sound version, never a picture edit or a deliverable. A sound mix stands for the
   * version it mixed, which is the one the front door's Composer laid its own ambience under, so the
   * route answers the same cues and reuses the same beds. Lip-sync is left out: the route needs its
   * review accepted, and the front door makes none. Newest first, by when it finished.
   */
  async function ambienceSource(input: FilmInput): Promise<string | undefined> {
    const rank = (job: Json) => AMBIENCE_SOURCE_STAGES.indexOf(job.stage), finished = (job: Json) => Date.parse(job.completedAt ?? "") || 0;
    const jobs = ((await call(project(input), { token: input.token })).jobs ?? []) as Json[];
    return jobs.map((job, order) => ({ job, order })).filter(({ job }) => job.status === "done" && rank(job) >= 0)
      .sort((a, b) => rank(a.job) - rank(b.job) || finished(b.job) - finished(a.job) || b.order - a.order)[0]?.job.id;
  }

  // Sound: the studio's ambience beds and a generated cue. Either route may not be deployed yet (PR #340, PR #335).
  const sound: Json = record.sound ?? {};
  if (options.ambience && filmA) await step("ambience", "desk-api", "A", async () => {
    // HV-030-23: not the deliverable source. That is the titled cut, a picture edit, which the ambience
    // route refuses ("Choose a completed film, dialogue, lip-sync or sound version").
    const cut = options.ambienceCut ?? await ambienceSource(filmA);
    if (!cut) return { outcome: "unavailable", note: "film A has no completed film, dialogue or sound version to make ambience for" };
    const { status, body } = await request(project(filmA, `/ambience/${cut}`), { method: "POST", token: filmA.token, body: {} });
    if (status === 404 && body.error === "not found") { sound.ambience = { status: "unavailable" }; return { outcome: "unavailable", note: "the ambience route is not deployed on this host (HV-024-12, PR #340)" }; }
    if (status < 200 || status > 299) throw new Error("/api/projects/:id/ambience/:id -> " + status + " " + (body.error ?? ""));
    const assets = [...new Set((body.cues ?? []).map((cue: Json) => cue.assetId as string))] as string[];
    sound.ambience = { status: "made", cutId: cut, presets: [...new Set((body.scenes ?? []).map((scene: Json) => scene.preset).filter(Boolean))], cues: body.cues?.length ?? 0, assets, costUsd: body.costUsd ?? 0 };
    return assets.length ? { parts: ["HV-024.ambience"], ids: assets } : { outcome: "unavailable", note: "no scene of this cut was given a bed" };
  });
  const musicUsd: number[] = [];
  if (options.music && filmA) await step("music-cue", "desk-api", "A", async () => {
    const { status, body } = await request(project(filmA, "/music-cues"), { method: "POST", token: filmA.token,
      body: { idempotencyKey: `release-2-music-${filmA.projectId.slice(0, 8)}`, prompt: options.music!.prompt, durationSec: options.music!.seconds } });
    if (status === 404 && body.error === "not found") { sound.music = { status: "unavailable" }; return { outcome: "unavailable", note: "the music cue route is not deployed on this host (HV-024-11, PR #335)" }; }
    if (status === 409 && body.music?.generated === false) { sound.music = { status: "no-provider" }; return { outcome: "unavailable", note: "this studio has no music provider configured" }; }
    if (status < 200 || status > 299) throw new Error("/api/projects/:id/music-cues -> " + status + " " + (body.error ?? ""));
    musicUsd.push(body.cue?.actualUsd ?? body.cue?.heldUsd ?? 0);
    sound.music = { status: "made", cueId: body.cue?.id ?? null, assetId: body.asset?.id ?? null, provider: body.cue?.provider ?? null, model: body.cue?.model ?? null,
      heldUsd: body.cue?.heldUsd ?? null, actualUsd: body.cue?.actualUsd ?? null, replay: body.replay === true };
    return { parts: ["HV-024.music"], ids: [body.asset.id, body.cue.id] };
  });
  if (options.ambience || options.music) record.sound = sound;

  // The writers' room: an imported screenplay is read back, never saved; line notes are taken one at a time.
  const room: Json = record.writersRoom ?? {};
  if (options.imports?.length && filmA) await step("script-import", "desk-api", "A", async () => {
    const read: Json[] = [];
    for (const file of options.imports!) {
      const bytes = readFileSync(file.path);
      const { status, body } = await request(project(filmA, "/script/import"), { method: "POST", token: filmA.token,
        body: { format: file.format, document: file.format === "pdf" ? bytes.toString("base64") : bytes.toString("utf8") } });
      read.push({ format: file.format, file: basename(file.path), sha256: sha256(bytes), status, scenes: body.scenes ?? 0, notes: body.notes?.length ?? 0, warnings: body.warnings?.length ?? 0,
        ...(status === 200 ? {} : { error: body.error ?? null }) });
    }
    room.imports = read;
    const ok = read.filter(value => value.status === 200 && value.scenes > 0);
    return ok.length ? { parts: ["HV-016.import"], ids: ok.map(value => value.sha256) } : { outcome: "stopped", note: "no imported screenplay was read back with scenes" };
  });
  if (options.lineNotes && filmA) await step("line-notes", "desk-api", "A", async () => {
    const asked = await call(project(filmA, "/crew/line-notes"), { method: "POST", token: filmA.token, body: { request: options.lineNotes!.request } });
    crewUsd.push(asked.crewSpend?.usd ?? 0);
    room.lineNotes = { source: asked.source, notes: asked.notes?.length ?? 0, dropped: asked.dropped ?? 0, accepted: 0, crewSpendUsd: asked.crewSpend?.usd ?? 0 };
    if (!asked.notes?.length) return { outcome: "unavailable", note: asked.source === "stand-in" ? "the stand-in crew writes no line notes; the crew needs its model key" : "the crew had no notes for this script" };
    if (!options.lineNotes!.accept) return { outcome: "unavailable", note: "the notes were read but none was accepted (--accept-notes)", ids: [filmA.projectId] };
    const taken = await call(project(filmA, "/crew/line-notes/accept"), { method: "POST", token: filmA.token,
      body: { version: asked.script.version, sha256: asked.script.sha256, notes: asked.notes, acceptedIds: [asked.notes[0].id] } });
    room.lineNotes = { ...room.lineNotes, accepted: taken.applied?.length ?? 0, scriptVersion: { before: asked.script.version, after: taken.version } };
    return taken.applied?.length ? { parts: ["HV-016.line-notes"], ids: [filmA.projectId] } : { outcome: "stopped", note: "the accepted note was not applied" };
  });
  if (options.imports?.length || options.lineNotes) record.writersRoom = room;

  // Provenance: each shared film's export, its record, and its signed sidecar's bytes against the digest the record names.
  /** One export: its record, its signed sidecar's bytes against the digest the record names, and, with --verify-c2pa, the signature checked. */
  async function inspectExport(input: FilmInput, jobId: string): Promise<Json> {
    const job = await call(`/api/jobs/${jobId}`, { token: input.token }), output = job.output ?? {};
    // Signed media URLs are fetched and dropped: they are keys to the film for 30 days.
    const manifestBytes = output.manifestUrl ? new Uint8Array(await (await artifact(output.manifestUrl)).arrayBuffer()) : null;
    const manifest = manifestBytes ? JSON.parse(new TextDecoder().decode(manifestBytes)) as Json : null;
    let sidecar: Json = { present: false, sha256: null, matchesRecord: false }, signature: Uint8Array | null = null;
    if (output.c2paUrl) {
      signature = new Uint8Array(await (await artifact(output.c2paUrl)).arrayBuffer());
      const digest = sha256(signature);
      sidecar = { present: true, sha256: digest, matchesRecord: manifest?.credentials?.sidecar?.sha256 === digest };
    }
    let verification: Json | null = null;
    if (options.verifyC2pa && manifestBytes && signature && output.mp4Url)
      verification = await verifyExport(new Uint8Array(await (await artifact(output.mp4Url)).arrayBuffer()), manifestBytes, signature);
    return { film: input.key, jobId, stage: job.stage ?? null, credentialType: manifest?.credentials?.type ?? null, sidecar, verification };
  }
  const signedSidecar = (value: Json) => value.credentialType === "c2pa-sidecar" && value.sidecar.present && value.sidecar.matchesRecord;
  if (options.provenance) await step("provenance", "desk-api", null, async () => {
    const exports: Json[] = [];
    for (const input of options.films) {
      const entry = (record.films as Json[]).find(value => value.key === input.key);
      for (const jobId of [...new Set([entry?.final, entry?.shared].filter(Boolean))] as string[]) exports.push(await inspectExport(input, jobId));
    }
    /**
     * HV-030-23: whether the host holds the key. It was read off the shared exports alone, and those are
     * picture edits, which HV-031-15 does not sign, so a host with its key set read `false`. Now it is
     * true on either of two bases, and the record names which:
     *   - a signed export: the newest film, sound mix or take of either film whose sidecar is a C2PA
     *     sidecar matching its record, looked for only when no shared export is signed;
     *   - the operator's word (`--host-key-configured`): the key and certificate are set and the
     *     workers passed their startup check.
     * Neither makes the part exercised. That still needs each shared export signed and verified.
     */
    let signedExport: Json | null = exports.find(signedSidecar) ?? null;
    for (const input of signedExport ? [] : options.films) {
      const jobs = (((await call(project(input), { token: input.token })).jobs ?? []) as Json[])
        .filter(job => job.status === "done" && SIGNED_EXPORT_STAGES.includes(job.stage))
        .sort((a, b) => (Date.parse(b.completedAt ?? "") || 0) - (Date.parse(a.completedAt ?? "") || 0));
      for (const job of jobs.slice(0, 6)) { const seen = await inspectExport(input, job.id); if (signedSidecar(seen)) { signedExport = seen; break; } }
      if (signedExport) break;
    }
    const basis = [...(signedExport ? ["signed-export"] : []), ...(options.hostKeyConfigured ? ["operator"] : [])];
    record.provenance = { hostHoldsKey: basis.length > 0, hostKey: { basis,
      signedExport: signedExport ? { film: signedExport.film, jobId: signedExport.jobId, stage: signedExport.stage, sidecarSha256: signedExport.sidecar.sha256, verification: signedExport.verification } : null,
      operatorDeclared: options.hostKeyConfigured === true }, exports,
      verifier: options.verifyC2pa ? "scripts/verify-c2pa.ts (verifyExportC2pa) over the files the studio serves, " + (options.verifyC2pa.anchorPem ? "with the host's root as anchor" : "without an anchor")
        : "not run; scripts/verify-c2pa.ts <export dir> on the host, its one-line report in each export's verification" };
    const signed = exports.length > 0 && exports.every(value => value.sidecar.present && value.sidecar.matchesRecord);
    const verified = !options.verifyC2pa || exports.every(value => value.verification?.ok === true);
    if (!signed) return { outcome: "unavailable", note: "not every shared export carries a signed sidecar that matches its record", ids: exports.map(value => value.jobId) };
    return verified ? { parts: ["HV-031.signed-c2pa"], ids: exports.map(value => value.jobId) }
      : { outcome: "unavailable", note: "a shared export's signed sidecar did not verify; see provenance.exports", ids: exports.map(value => value.jobId) };
  });

  /**
   * HV-030-23: one export's signature, checked the way a person checking a contested film would, from
   * the three files the studio serves. They go to a directory only this user can read, named as
   * `scripts/verify-c2pa.ts` expects, and the directory is removed whatever the answer.
   */
  async function verifyExport(mp4: Uint8Array, manifest: Uint8Array, sidecar: Uint8Array): Promise<C2paCheck> {
    const directory = mkdtempSync(join(tmpdir(), "hv-release-2-c2pa-"));
    try {
      writeFileSync(join(directory, "export.mp4"), mp4, { mode: 0o600 });
      writeFileSync(join(directory, "provenance.json"), manifest, { mode: 0o600 });
      writeFileSync(join(directory, "provenance.c2pa"), sidecar, { mode: 0o600 });
      const verify = options.verifyC2pa!.verify ?? (await import("./verify-c2pa")).verifyExportC2pa;
      const report = await verify(directory, options.verifyC2pa!.anchorPem);
      return { ok: report.ok, state: report.state, codes: report.codes, problems: report.problems };
    } catch (error) {
      return { ok: false, state: "Unchecked", codes: [], problems: [error instanceof Error ? error.message : String(error)] };
    } finally { rmSync(directory, { recursive: true, force: true }); }
  }

  // The reviewer's side, read back by the owner: timecoded comments and decisions by stage.
  if (options.reviews) {
    const review: Json = { comments: [], links: [], stages: {} };
    for (const input of options.films) {
      await step("review-read-back", "reviewer", input.key, async () => {
        const owner = await call(project(input, "/reviews"), { token: input.token });
        const entry = (record.films as Json[]).find(value => value.key === input.key);
        const links = (owner.links as Json[]).map(link => ({ film: input.key, linkId: link.id, boundJobId: link.jobId, permission: link.permission, views: link.views, maxViews: link.maxViews,
          decision: link.decision, decisionStage: link.decisionStage, decidedAt: link.decidedAt, decisionNote: link.decisionNote,
          comments: (link.comments as Json[]).map(c => ({ id: c.id, frame: c.frame, timecode: c.timecode, text: c.text, viewer: c.viewer, at: c.at, resolvedAt: c.resolvedAt })) }));
        const mine = links.find(link => link.linkId === entry?.review?.linkId) ?? links.filter(link => link.boundJobId === entry?.shared).at(-1);
        if (entry && mine) entry.review = mine;
        review.links.push(...links); review.comments.push(...links.flatMap(link => link.comments.map((c: Json) => ({ film: input.key, linkId: link.linkId, ...c }))));
        review.stages[input.key] = owner.stages;
        const byPart: Record<string, string[]> = {};
        if (mine?.comments.length) byPart["HV-029.timecoded-comments"] = mine.comments.map((c: Json) => c.id);
        if (mine?.decision && mine.decisionStage) byPart["HV-029.stage-approvals"] = [mine.linkId];
        return Object.keys(byPart).length ? { byPart } : { outcome: "unavailable", note: "the shared film's review link has no comment or decision yet" };
      });
    }
    record.review = review;
  }

  // Operator and audit parts are exercised by repository files; deferred parts name their gate entry.
  for (const [part, paths] of Object.entries(options.evidence ?? {})) {
    const surface = RELEASE_2_PARTS[part];
    if (surface !== "operator" && surface !== "audit") throw new Error("--evidence is for operator and audit parts, not " + part);
    await step("evidence", surface, null, async () => ({ parts: [part], ids: paths }));
  }
  for (const [part, gate] of Object.entries(options.defer ?? {})) {
    const slice = record.slices[part] as SliceEntry | undefined;
    if (!slice) throw new Error("--defer names an unknown part: " + part);
    if (!slice.exercised) slice.deferredBy = gate;
  }

  const after = await snapshot();
  const line = (limitUsd: number, source: string, runUsd: number | null) => ({ limitUsd, before: null, after: null, runUsd, source });
  const prior = merged.ledgers?.lines ?? {};
  record.ledgers = {
    snapshots: [...(merged.ledgers?.snapshots ?? []), { before, after }],
    lines: {
      generation: prior.generation ?? line(RELEASE_2_LINES.generation!, "the staging database's cost ledger at record time", null),
      voice: prior.voice ?? line(RELEASE_2_LINES.voice!, "the staging database's voice line at record time", null),
      music: prior.music ?? line(RELEASE_2_LINES.music!, "the staging database's music line at record time", musicUsd.length ? musicUsd.reduce((a, b) => a + b, 0) : null),
      crew: prior.crew ?? line(RELEASE_2_LINES.crew!, "the crew's own replies in this run; cumulative from the crew ledger at record time", crewUsd.reduce((a, b) => a + b, 0)),
    },
  };
  // HV-030-23: each line's before and after, as scripts/release-2-lines.ts read them from the studio's own ledgers.
  for (const [name, line] of Object.entries(record.ledgers.lines as Record<string, Json>)) for (const when of ["before", "after"] as const) {
    const reading = options.lines?.[when];
    if (!reading) continue;
    line[when] = { ...reading.lines[name]!, at: reading.at };
    line.source = reading.basis[name] ?? line.source;
  }
  for (const entry of record.films as Json[]) entry.spend = after.films[entry.key] ?? entry.spend ?? null;
  record.recordedAt = now();
  return record;
}

/** A reading `scripts/release-2-lines.ts` wrote: every line the criteria name, each with its spend and holds. */
export function readLines(path: string): LinesReading {
  const reading = JSON.parse(readFileSync(path, "utf8")) as LinesReading;
  const money = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0;
  if (reading?.schema !== "hv-release-lines/1" || !Number.isFinite(Date.parse(reading.at))
    || Object.keys(RELEASE_2_LINES).some(name => !money(reading.lines?.[name]?.spentUsd) || !money(reading.lines?.[name]?.heldUsd)))
    throw new Error(basename(path) + " is not a reading of the four spend lines (hv-release-lines/1)");
  return reading;
}

/** `--name value` pairs, where a name may repeat (`--defer`, `--evidence`). */
export function parseArguments(argv: string[]): Release2Options & { out: string } {
  const values = new Map<string, string[]>(), flags = new Set<string>();
  const FLAGS = new Set(["--lock-look", "--sheet", "--share-actor", "--continuity", "--continuity-apply", "--ambience", "--reviews", "--provenance", "--accept-notes", "--verify-c2pa", "--host-key-configured"]);
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]!;
    if (!name.startsWith("--")) throw new Error("unexpected argument " + name);
    if (FLAGS.has(name)) { flags.add(name); continue; }
    const value = argv[++index];
    if (value === undefined) throw new Error("missing a value for " + name);
    values.set(name, [...(values.get(name) ?? []), value]);
  }
  const one = (name: string) => values.get(name)?.at(-1);
  const pairs = (name: string) => Object.fromEntries((values.get(name) ?? []).map(pair => {
    const at = pair.indexOf("=");
    if (at < 1) throw new Error(name + " takes part=value");
    return [pair.slice(0, at), pair.slice(at + 1)];
  }));
  const base = one("--base");
  if (!base) throw new Error("missing --base");
  const films: FilmInput[] = [];
  for (const key of ["A", "B"] as const) {
    const tokenFile = one("--film-" + key.toLowerCase());
    if (!tokenFile) continue;
    const studioFile = one("--studio-" + key.toLowerCase());
    films.push({ key, ...readProjectKey(tokenFile), ...(studioFile ? { studio: JSON.parse(readFileSync(studioFile, "utf8")) } : {}), script: one("--script-" + key.toLowerCase()) });
  }
  if (!films.some(value => value.key === "A")) throw new Error("missing --film-a (the project token file studio-run.ts saved)");
  const deliveries = one("--deliveries")?.split(",").map(value => value.trim()).filter(Boolean);
  for (const kind of deliveries ?? []) if (!(DELIVERY_STEP_KINDS as readonly string[]).includes(kind)) throw new Error("--deliveries takes " + DELIVERY_STEP_KINDS.join(","));
  const operatorFile = one("--operator-token"), mergeFile = one("--merge");
  let operatorToken: string | undefined;
  if (operatorFile) {
    // The file operator-diagnostics.ts wrote: a 15-minute read-only credential, read and never repeated.
    try { operatorToken = JSON.parse(readFileSync(operatorFile, "utf8")).token; } catch { operatorToken = undefined; }
    if (typeof operatorToken !== "string" || !operatorToken) throw new Error("--operator-token is not a diagnostics credential file");
  }
  const seconds = Number(one("--music-seconds") ?? 30);
  const declared = one("--spend-declared");
  if (declared !== undefined && !(Number.isFinite(Number(declared)) && Number(declared) >= 0)) throw new Error("--spend-declared takes a number of US dollars");
  const before = one("--lines-before"), after = one("--lines-after"), anchor = one("--c2pa-anchor");
  if (anchor && !flags.has("--verify-c2pa")) throw new Error("--c2pa-anchor needs --verify-c2pa");
  return {
    base, films, out: one("--out") ?? "",
    imports: [...(values.get("--import-fdx") ?? []).map(path => ({ format: "final-draft" as const, path })), ...(values.get("--import-pdf") ?? []).map(path => ({ format: "pdf" as const, path }))],
    ...(one("--line-notes") !== undefined ? { lineNotes: { request: one("--line-notes")!, accept: flags.has("--accept-notes") } } : {}),
    lockLook: flags.has("--lock-look"), lockCharacter: one("--lock-character"), sheet: flags.has("--sheet"), shareActor: flags.has("--share-actor"), importAs: one("--import-as"),
    ...(flags.has("--continuity") || flags.has("--continuity-apply") ? { continuity: { apply: flags.has("--continuity-apply") } } : {}),
    deliveries, cut: one("--cut"), ambience: flags.has("--ambience"), ambienceCut: one("--ambience-cut"), hostKeyConfigured: flags.has("--host-key-configured"),
    ...(one("--music") ? { music: { prompt: one("--music")!, seconds } } : {}),
    reviews: flags.has("--reviews"), provenance: flags.has("--provenance"), operatorToken,
    ...(flags.has("--verify-c2pa") ? { verifyC2pa: anchor ? { anchorPem: readFileSync(anchor, "utf8") } : {} } : {}),
    ...(declared !== undefined ? { spendDeclared: Number(declared) } : {}),
    ...(before || after ? { lines: { ...(before ? { before: readLines(before) } : {}), ...(after ? { after: readLines(after) } : {}) } } : {}),
    defer: pairs("--defer"), evidence: Object.fromEntries(Object.entries(pairs("--evidence")).map(([part, paths]) => [part, paths.split(",")])),
    ...(mergeFile ? { merge: JSON.parse(readFileSync(mergeFile, "utf8")) } : {}),
  };
}

if (import.meta.main) {
  const options = parseArguments(process.argv.slice(2));
  const record = await runRelease2(options);
  const text = JSON.stringify(record, null, 2) + "\n";
  if (options.out) writeFileSync(options.out, text, { mode: 0o600 }); else process.stdout.write(text);
  const stopped = (record.steps as Step[]).filter(value => value.outcome === "stopped");
  for (const value of stopped) console.error("stopped:", value.step, value.film ?? "", value.note ?? "");
  if (stopped.length) process.exit(1);
}
