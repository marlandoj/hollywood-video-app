/**
 * HV-030-31: Release 3's run, after the front door.
 *
 * `scripts/studio-run.ts --format feature` takes the feature from a pasted script to one shared film,
 * as a creator would: the pitch, the read-through, the look approved once, each sequence's rough cut
 * and final, the join with its title and credits, and the share. This reads that work back from the
 * studio, drives the parts of Release 3 that live behind the Director's desk through the desk's own
 * routes, and writes the run's record in schema `hv-release-run/3`. `test/release-3-run.test.ts`
 * holds the finished record to docs/ROADMAP.md's Release 3 exit criteria (agreed at G20).
 *
 *   bun scripts/release-3-run.ts --base http://127.0.0.1:8081 --out run.json \
 *     --feature f.token --studio f.json --script docs/evidence/release-3/scripts/feature.fountain \
 *     --spend-declared 135 --lines-before lines-before.json \
 *     --continuity --interchange --hero --camera --vfx --provenance --verify-c2pa \
 *     --defer HV-019.second-vendor=G20-202610031349 --evidence HV-037.paid-benchmark=docs/evidence/release-3/benchmark.json
 *
 * Every step records the surface it used, its outcome and the studio's own ids, and fills the slice
 * parts it exercises. A part nothing exercised stays `exercised: false` until it is deferred to a gate
 * entry (`--defer part=GATE-ID`). A route that isn't on the host yet (an increment still open when this
 * was written) is recorded as `unavailable` with the increment that adds it, never as a failure:
 *   - the identity-locks read (HV-017-17), the sequence-boundary report (HV-021-11), the hero chain
 *     (HV-019-15) and native camera control (HV-020-01) are open PRs at HV-030-31;
 *   - `--interchange` exports the joined feature's cut (HV-023-05, HV-030-35); `--interchange <sequence id>`
 *     exports that saved editorial sequence instead (HV-023-04);
 *   - `--vfx [sequence]` has the Editor composite one masked element over a shot of that sequence's
 *     film (1 by default) through the editorial desk's own routes, rendered on the studio's machine at
 *     $0 (HV-025-13, HV-030-35); `--vfx-job <id>` reads a composite made some other way.
 * `--merge` re-reads an earlier record and reruns only the steps asked for, keeping a replaced step
 * that had not succeeded under `supersededSteps`, as `scripts/release-2-run.ts` does.
 *
 * It reads the project token and the operator's diagnostics credential, because they are the only
 * keys to what it drives. It never writes or prints either, nor a signed media link or review link.
 * It never reads a provider key and asks for nothing that spends: the hero chain is $0 on ffmpeg,
 * the composite is rendered only when the desk quotes it at $0, the reads are reads, and the
 * continuity repair is applied only with `--continuity-apply`.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vfxCompositeLabel, vfxCompositeOperation } from "../packages/planner/src/crew/vfx-composite";
import type { EditTimeline } from "../packages/planner/src/edit-timeline";
import { otioAsEvents, readEdl, readOtio } from "../test/fixtures/interchange-readers";
import { readLines, SURFACES, type C2paCheck, type LinesReading, type SliceEntry, type Step, type Surface } from "./release-2-run";
import { readProjectKey, sha256 } from "./release-run-files";

export const RELEASE_RUN_SCHEMA = "hv-release-run/3";
export { SURFACES };
/** The parts of Release 3's slices and the surface each is exercised through: docs/ROADMAP.md's table, which the test holds this to. */
export const RELEASE_3_PARTS: Readonly<Record<string, Surface>> = Object.freeze({
  "HV-030.feature-format": "front-door", "HV-030.showrunner": "front-door", "HV-030.feature-assembly": "front-door", "HV-030.feature-review": "reviewer",
  "HV-017.feature-identity": "front-door",
  "HV-021.cross-sequence-continuity": "desk-api",
  "HV-019.second-vendor": "front-door", "HV-019.hero-chain": "desk-api", "HV-019.quality-routing": "front-door",
  "HV-020.native-camera": "desk-api",
  "HV-023.interchange": "desk-api",
  "HV-034.style-bible": "front-door",
  "HV-025.titles-credits": "front-door", "HV-025.vfx-composite": "desk-api",
  "HV-037.paid-benchmark": "operator",
});
/** The spend lines and their limits: Release 2's four, unchanged (the roadmap's Release 3 table), read by `scripts/release-2-lines.ts`. */
export const RELEASE_3_LINES: Readonly<Record<string, number>> = Object.freeze({ generation: 450, voice: 25, music: 10, crew: 25 });
/** The comments a reviewer pinned, per sequence of the joined film, are read at the review step at this rate (REVIEW_FPS). */
const REVIEW_FPS = 30;

/** What `scripts/studio-run.ts --format feature` reports. */
export interface FeatureStudioReport {
  schema?: string; projectId?: string; format?: string; tone?: string; outcome?: string; finishNotes?: string[];
  script?: { format: string; sha256: string };
  readThrough?: { source?: string; concerns?: string[]; crewSpendUsd?: number; fallbackReason?: string;
    facts?: { format: string | null; scenes: number | null; shots: number | null; estimatedRuntimeSec: number | null; formatLimitSec: number | null; estimate: Record<string, unknown> | null } };
  plan?: { source?: string; crewSpendUsd?: number; fallbackReason?: string;
    sequences?: { source: string; revision: string; fallbackReason?: string; sequences: { number: number; firstScene: number; lastScene: number; shots: number; bibleRevision: string | null }[] };
    styleBible?: { kept: boolean; source: string; revision: string | null; version: number | null } };
  deskBeforeLook?: { castApproved: boolean; locks: { characterId: string; name: string; revision: string | null }[]; continuity: Record<string, unknown> | null };
  roughCut?: { jobId: string }; final?: { jobId: string };
  feature?: { sequences: { number: number; roughCut: string; film: string | null; finished?: { voiced: boolean; scored: boolean; ambience: boolean; notes: string[] } }[]; joined: boolean; titled: boolean; unscored?: number[] };
  review?: { linkId: string; jobId: string; maxViews: number; permission: string };
}
export interface FeatureInput { projectId: string; token: string; studio?: FeatureStudioReport; script?: string }
export interface Release3Options {
  base: string; feature: FeatureInput;
  continuity?: { apply: boolean };
  /**
   * `true` exports the joined feature's cut (HV-023-05); a saved editorial sequence's id exports that
   * sequence (HV-023-04). Without a joined film, `true` finds the project's only saved sequence.
   */
  interchange?: string | true;
  /** A hero render of one shot of a sequence's final: the shot (or the first available) and the sequence (1 by default). */
  hero?: { shotId?: string; sequence?: number };
  camera?: boolean;
  /** HV-030-35: a masked composite made at the desk over a shot of this sequence's film (1 by default). */
  vfx?: { sequence?: number };
  vfxJob?: string;
  provenance?: boolean;
  verifyC2pa?: { anchorPem?: string; verify?: (directory: string, anchorPem?: string) => Promise<C2paCheck> };
  reviews?: boolean;
  /** A gate entry approving the second video vendor (G3); without it, shots by one are a stop, never the part. */
  secondVendorGate?: string;
  operatorToken?: string;
  spendDeclared?: number; lines?: { before?: LinesReading; after?: LinesReading };
  defer?: Record<string, string>; evidence?: Record<string, string[]>;
  /** The operator's G6 entry for Release 3, once it exists. */
  acknowledged?: string;
  merge?: Record<string, unknown>;
  poll?: { intervalMs: number; limitMs: number };
}
type Json = Record<string, any>;

const masked = (path: string) => path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, ":id");
const now = () => new Date().toISOString();
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const HEX64 = /^[0-9a-f]{64}$/;
const notDeployed = (status: number, body: Json, unknown = "not found") => status === 404 && body.error === unknown;

/** Which provider rendered each shot of a final: the last route decision per shot that selected one. Shots with none are `unknown`. */
export function shotProviders(job: Json, sources: ReadonlyMap<string, Json> = new Map()): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const decision of routes(job, sources).values()) { const spec = decision?.selectedId ?? "unknown"; counts[spec] = (counts[spec] ?? 0) + 1; }
  return counts;
}

/**
 * Each shot of a final with the last decision that selected its provider. HV-030-37: a shot the final reused
 * (a resumed run's retry reuses the shots its failed final rendered) has no decision of its own; its route is the
 * one that rendered it, in the source job it names (`sources`, by id). Without that job it is unknown.
 */
function routes(job: Json, sources: ReadonlyMap<string, Json>): Map<string, Json | undefined> {
  const chosen = (of: Json | undefined) => {
    const map = new Map<string, Json>();
    for (const decision of (of?.routeDecisions ?? []) as Json[]) if (decision.selectedId) map.set(decision.shotId, decision);
    return map;
  };
  const own = chosen(job), renders = (job.shotRenders ?? []) as Json[];
  if (!renders.length) return own;
  return new Map(renders.map(render => [render.shotId as string, render.reusedFrom ? chosen(sources.get(render.reusedFrom.jobId)).get(render.reusedFrom.shotId) : own.get(render.shotId)]));
}
/** The jobs a final's reused shots were rendered in, by id, as the studio holds them. */
export async function reusedSources(final: Json, call: (path: string) => Promise<Json>): Promise<Map<string, Json>> {
  const sources = new Map<string, Json>();
  for (const render of (final.shotRenders ?? []) as Json[]) {
    const id = render.reusedFrom?.jobId;
    if (typeof id === "string" && !sources.has(id)) sources.set(id, await call(`/api/jobs/${id}`));
  }
  return sources;
}

/**
 * HV-030-35: how many of a final's rendered shots were routed to a provider with a measured score.
 * A shot's route is the last decision that selected a provider, as `shotProviders` reads it; it is
 * measured when HV-019-14's record of that decision carries a `selectedScore`. `unmeasured` is the
 * router's own reason for the first shot that wasn't (a mock pool: "not measured: the results file has
 * no record for mock").
 */
export function shotQuality(job: Json, sources: ReadonlyMap<string, Json> = new Map()): { shots: number; measured: number; unmeasured: string | null } {
  const chosen = routes(job, sources);
  let measured = 0, unmeasured: string | null = null;
  for (const [shot, decision] of chosen) {
    const score = decision?.quality?.selectedScore;
    if (typeof score === "number" && Number.isFinite(score)) { measured++; continue; }
    unmeasured ??= !decision ? "no route decision selected a provider for " + shot
      : ((decision.quality?.candidates ?? []) as Json[]).find(candidate => candidate.id === decision.selectedId)?.reason ?? "its route recorded no quality score";
  }
  return { shots: chosen.size, measured, unmeasured };
}

type Reply = { status: number; body: Json; headers: Headers; text: string };
/** The desk's routes, with the project token. An error names the route with its ids masked, never the token. */
export interface DeskClient {
  request(path: string, init?: { method?: string; token?: string; body?: unknown }): Promise<Reply>;
  call(path: string, init?: { method?: string; body?: unknown; token?: string | null }): Promise<Json>;
}
export function deskClient(baseUrl: string, token: string): DeskClient {
  const base = baseUrl.replace(/\/$/, "");
  async function request(path: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<Reply> {
    const response = await fetch(base + path, { method: init.method ?? "GET", headers: { origin: base, ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
      ...(init.body === undefined ? {} : { "content-type": "application/json" }) }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
    const text = await response.text();
    let body: Json = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text.slice(0, 200) }; }
    return { status: response.status, body, headers: response.headers, text };
  }
  async function call(path: string, init: { method?: string; body?: unknown; token?: string | null } = {}): Promise<Json> {
    const { status, body } = await request(path, { ...init, token: init.token === null ? undefined : init.token ?? token });
    if (status < 200 || status > 299) throw new Error(masked(path.split("?")[0]!) + " -> " + status + " " + (body.error ?? ""));
    return body;
  }
  return { request: (path, init = {}) => request(path, { ...init, token: init.token ?? token }), call };
}

type StepResult = { outcome?: Step["outcome"]; parts?: string[]; ids?: string[]; note?: string };
type Exported = { text: string; sha256: string; header: string | null };
/** The OTIO and the EDL read back by HV-023-04's independent readers, and whether they give the same shots and frames. */
function readBack(files: Record<"otio" | "edl", Exported>) {
  const otio = readOtio(files.otio.text), edl = readEdl(files.edl.text), events = otioAsEvents(otio.tracks[0]!);
  const same = events.length > 0 && events.length === edl.events.length && events.every((event, index) => JSON.stringify(event) === JSON.stringify(edl.events[index]));
  return { otio, edl, same, summary: {
    otio: { sha256: files.otio.sha256, matchesHeader: files.otio.header === files.otio.sha256, tracks: otio.tracks.length, clips: otio.tracks.reduce((sum, track) => sum + track.clips.length, 0) },
    edl: { sha256: files.edl.sha256, matchesHeader: files.edl.header === files.edl.sha256, events: edl.events.length },
    readsBackTheSame: same, jobs: [...new Set(edl.events.map(event => event.jobId))] } };
}

/**
 * HV-030-35: the joined feature's cut (HV-023-05), `GET /api/projects/:id/feature-film/:jobId/interchange/{otio,edl}`,
 * read back as the saved-sequence export is: each file against the studio's sha256 header, both by
 * HV-023-04's readers to the same shots and frames. The OTIO must name the joined film, and the EDL's
 * media must be the sequences' films in the order they were joined, then the end credits. A join the
 * studio refuses (stale, unfinished, a newer one) is `unavailable` with the studio's reason.
 */
export async function exportFeatureCut(desk: DeskClient, projectId: string, film: { jobId: string; films: string[]; credits: string | null }): Promise<StepResult & { interchange: Json | null }> {
  const files = {} as Record<"otio" | "edl", Exported>;
  for (const format of ["otio", "edl"] as const) {
    const { status, body, headers, text } = await desk.request(`/api/projects/${projectId}/feature-film/${film.jobId}/interchange/${format}`);
    if (notDeployed(status, body)) return { outcome: "unavailable", note: "the joined feature's interchange export is not on this host (HV-023-05)", interchange: null };
    if (status === 409) return { outcome: "unavailable", note: "the studio refused the joined feature's cut: " + (body.error ?? ""), ids: [film.jobId], interchange: null };
    if (status !== 200) throw new Error("/api/projects/:id/feature-film/:id/interchange/" + format + " -> " + status + " " + (body.error ?? ""));
    files[format] = { text, sha256: sha256(text), header: headers.get("x-hv-interchange-sha256") };
  }
  const read = readBack(files), expected = [...film.films, ...(film.credits ? [film.credits] : [])];
  const named = (read.otio.metadata?.hv as Json | undefined)?.featureFilmJobId ?? null;
  const inOrder = named === film.jobId && JSON.stringify(read.summary.jobs) === JSON.stringify(expected);
  const interchange = { cut: "joined-feature", featureFilmJobId: film.jobId, ...read.summary, titleLayer: read.otio.tracks.length > 1, filmsInOrder: inOrder };
  const ids = [files.otio.sha256, files.edl.sha256];
  if (!interchange.otio.matchesHeader || !interchange.edl.matchesHeader) return { outcome: "unavailable", note: "an exported file does not match the studio's sha256 header", ids, interchange };
  if (!read.same) return { outcome: "unavailable", note: "the OTIO and the EDL did not read back to the same shots and frames", ids, interchange };
  if (!inOrder) return { outcome: "unavailable", note: "the cut does not name the joined film and its sequences' films in the order they were joined", ids, interchange };
  return { parts: ["HV-023.interchange"], ids, interchange };
}

/** The Editor's composite: its clip, the window over the shot, the matte and how strongly the element shows. */
export const VFX_COMPOSITE = { clipId: "release-3-vfx", frames: 30, at: 15, opacity: 0.75, box: { xQ16: 16384, yQ16: 16384, widthQ16: 32768, heightQ16: 32768 } } as const;

/**
 * HV-030-35: a masked composite rendered into a shot of the feature (HV-025-13), through the editorial
 * desk's own routes, as the Editor would make it:
 *
 * 1. the film is inspected (`GET /editorial/sources/:jobId`, waited for while it answers 202) and saved
 *    as an editorial sequence of its own (`POST /editorial/sequences`);
 * 2. `vfxCompositeOperation` lays the film's own middle frames over its first shot, through a held
 *    rectangle in the middle of the frame at 75%, saved as one edit (`PATCH`), validated by the desk;
 * 3. it is rendered only if the desk quotes it at $0 (`GET` then `POST /renders`, the editorial conform
 *    on the studio's machine), and waited for;
 * 4. the job view's own record of the composite (`pictureEdit.vfx`) must name this film as both plate
 *    and element, one matte, and a $0 render.
 *
 * Run again, it reuses the saved sequence, its edit and (by its request key) its render.
 */
export async function makeVfxComposite(desk: DeskClient, projectId: string, source: { jobId: string; sequence?: number | null; shotId?: string | null },
  poll: { intervalMs: number; limitMs: number }): Promise<StepResult & { vfx: Json | null }> {
  const root = `/api/projects/${projectId}/editorial`, id = "release-3-vfx-" + source.jobId.slice(0, 8), started = Date.now();
  const library = await desk.request(root);
  if (notDeployed(library.status, library.body)) return { outcome: "unavailable", note: "the editorial desk is not on this host", vfx: null };
  if (library.status !== 200) throw new Error("/api/projects/:id/editorial -> " + library.status + " " + (library.body.error ?? ""));
  let state: Json;
  if (((library.body.sequences ?? []) as Json[]).some(sequence => sequence.id === id)) state = await desk.call(`${root}/sequences/${id}`);
  else {
    let inspected: Json;
    for (;;) {
      const answer = await desk.request(`${root}/sources/${source.jobId}`);
      if (answer.status === 200 && Array.isArray(answer.body.sources)) { inspected = answer.body.sources[0]; break; }
      if (answer.status !== 202) throw new Error("/api/projects/:id/editorial/sources/:id -> " + answer.status + " " + (answer.body.error ?? ""));
      if (Date.now() - started > poll.limitMs) throw new Error("The film was still being inspected after " + Math.round(poll.limitMs / 60000) + " minutes.");
      await wait(poll.intervalMs);
    }
    state = await desk.call(`${root}/sequences`, { method: "POST", body: { id, label: "Editor: VFX composite", sources: [{ jobId: source.jobId, sourceRevision: inspected.sourceRevision }],
      firstSourceId: source.jobId, width: Math.min(1920, inspected.facts?.width ?? 1280), height: Math.min(1080, inspected.facts?.height ?? 720), expectedVersion: library.body.libraryVersion } });
  }
  const timeline = state.timeline as Json;
  if (!((timeline.clips ?? []) as Json[]).some(clip => clip.id === VFX_COMPOSITE.clipId)) {
    const plate = ((timeline.clips ?? []) as Json[]).find(clip => clip.lane === "picture" && clip.layer === 0 && clip.sourceId === source.jobId);
    const element = ((timeline.sources ?? []) as Json[]).find(value => value.id === source.jobId);
    const from = Math.floor((element?.frames ?? 0) / 2);
    if (!plate || !element || plate.frames < VFX_COMPOSITE.at + VFX_COMPOSITE.frames || from + VFX_COMPOSITE.frames > element.frames || from < VFX_COMPOSITE.at + VFX_COMPOSITE.frames)
      return { outcome: "unavailable", note: "the film is too short to composite into", vfx: null };
    const { operation } = vfxCompositeOperation(timeline as unknown as EditTimeline, { clipId: VFX_COMPOSITE.clipId, plateClipId: plate.id, elementSourceId: source.jobId, at: plate.at + VFX_COMPOSITE.at,
      frames: VFX_COMPOSITE.frames, from, mask: { kind: "rectangle", box: { ...VFX_COMPOSITE.box } }, opacity: VFX_COMPOSITE.opacity });
    const film = source.sequence ? "Sequence " + source.sequence + "'s film" : "The film";
    state = await desk.call(`${root}/sequences/${id}`, { method: "PATCH", body: { expectedVersion: state.libraryVersion, expectedHistoryRevision: state.sequence.history.revision,
      change: { kind: "edit", label: vfxCompositeLabel(film + ", frame " + from, source.shotId ? film + ", " + source.shotId : film + ", frame " + (plate.at + VFX_COMPOSITE.at)), operation } } });
  }
  const historyRevision = state.sequence.history.revision as string, renders = `${root}/sequences/${id}/renders`;
  const quote = await desk.call(renders);
  if (quote.costUsd !== 0) return { outcome: "unavailable", note: "the composite's render was not quoted at $0, and the run asks for nothing that spends", vfx: null };
  if (quote.unavailable) return { outcome: "unavailable", note: "the desk can't render the composite: " + quote.unavailable, vfx: null };
  const queued = await desk.call(renders, { method: "POST", body: { idempotencyKey: "release-3-vfx-" + historyRevision.slice(0, 16), generationApproved: true, historyRevision,
    sourceBindingsRevision: quote.sourceBindingsRevision, engineVersion: quote.engineVersion, review: { ...quote.review, accepted: true } } });
  let job: Json;
  for (;;) {
    job = await desk.call(`/api/jobs/${queued.jobId}`);
    if (["done", "failed", "cancelled"].includes(job.status)) break;
    if (Date.now() - started > poll.limitMs) throw new Error("The composite did not render within " + Math.round(poll.limitMs / 60000) + " minutes.");
    await wait(poll.intervalMs);
  }
  const composites = (job.pictureEdit?.vfx?.composites ?? []) as Json[], [composite] = composites;
  const input = (value: Json | undefined) => value ? { jobId: value.jobId, stage: value.stage, layer: value.layer, at: value.at, from: value.from, frames: value.frames, sourceRevision: value.sourceRevision } : null;
  const vfx = { jobId: job.id, stage: job.stage ?? null, status: job.status ?? null, costUsd: job.costUsd ?? 0, sourceJobId: source.jobId, sequence: source.sequence ?? null,
    sequenceId: id, historyRevision, failureReason: job.failureReason ?? null,
    composite: composite ? { window: composite.window, plate: input(composite.plates?.[0]), element: input(composite.element), matte: composite.matte?.masks ?? [],
      opacity: composite.opacity, operation: composite.operation?.label ?? null } : null };
  if (job.status !== "done" || job.stage !== "picture-edit" || vfx.costUsd !== 0) return { outcome: "unavailable", note: "the composite's render did not finish at $0" + (job.failureReason ? ": " + job.failureReason : ""), ids: [job.id], vfx };
  if (composites.length !== 1 || vfx.composite?.plate?.jobId !== source.jobId || vfx.composite.element?.jobId !== source.jobId || vfx.composite.matte.length !== 1)
    return { outcome: "unavailable", note: "the render's record does not hold one masked composite over this film", ids: [job.id], vfx };
  return { parts: ["HV-025.vfx-composite"], ids: [job.id], vfx };
}

export async function runRelease3(options: Release3Options): Promise<Json> {
  const base = options.base.replace(/\/$/, ""), poll = options.poll ?? { intervalMs: 5000, limitMs: 30 * 60 * 1000 }, input = options.feature;
  const studio = input.studio ?? {}, token = input.token, root = `/api/projects/${input.projectId}`;
  const desk = deskClient(base, token), request = desk.request, call = desk.call;
  /** A signed media link: fetched, used and dropped. An error names the kind of link, never the link. */
  async function artifact(url: string): Promise<Uint8Array> {
    const response = await fetch(base + url, { headers: { origin: base } });
    if (!response.ok) throw new Error("a signed artifact link -> " + response.status);
    return new Uint8Array(await response.arrayBuffer());
  }

  const merged = (options.merge ?? {}) as Json;
  const record: Json = {
    schema: RELEASE_RUN_SCHEMA, release: "3 \"Features\"", recordedAt: now(),
    driver: "scripts/release-3-run.ts (the desk's own routes, and the front door read back) after scripts/studio-run.ts --format feature (createStudioFlow)",
    spendUsdDeclared: options.spendDeclared ?? merged.spendUsdDeclared ?? null, creator: merged.creator ?? "one anonymous creator, holding the feature's project token",
    feature: merged.feature ?? null, steps: merged.steps ?? [],
    slices: Object.fromEntries(Object.entries(RELEASE_3_PARTS).map(([part, surface]) => [part, merged.slices?.[part] ?? { exercised: false, surface, ids: [], deferredBy: null }])),
    identity: merged.identity ?? null, continuity: merged.continuity ?? null, interchange: merged.interchange ?? null, hero: merged.hero ?? null,
    camera: merged.camera ?? null, vfx: merged.vfx ?? null, secondVendor: { approvedBy: options.secondVendorGate ?? merged.secondVendor?.approvedBy ?? null },
    provenance: merged.provenance ?? null, ledgers: merged.ledgers ?? null, acknowledgement: options.acknowledged ? { gate: options.acknowledged } : merged.acknowledgement ?? null,
    stoppedAttempts: merged.stoppedAttempts ?? [], knownGaps: merged.knownGaps ?? [], supersededSteps: merged.supersededSteps ?? [],
  };
  const steps: Step[] = record.steps;
  const exercise = (part: string, ids: string[]) => {
    const slice = record.slices[part] as SliceEntry;
    slice.exercised = true; slice.deferredBy = null; slice.ids = [...new Set([...slice.ids, ...ids])];
  };
  type Outcome = { outcome?: Step["outcome"]; parts?: string[]; byPart?: Record<string, string[]>; ids?: string[]; note?: string };
  /** One step: its surface, what it exercised. A failure is recorded as the step stopping, and the run goes on. */
  async function step(name: string, surface: Surface, body: () => Promise<Outcome>) {
    const entry: Step = { step: name, surface, film: null, outcome: "done", parts: [], ids: [], at: now() };
    try {
      const result = await body();
      const byPart = { ...Object.fromEntries((result.parts ?? []).map(part => [part, result.ids ?? []])), ...result.byPart };
      entry.outcome = result.outcome ?? "done"; entry.ids = [...new Set([...(result.ids ?? []), ...Object.values(byPart).flat()])]; entry.note = result.note;
      if (entry.outcome === "done") for (const [part, ids] of Object.entries(byPart)) { exercise(part, ids); entry.parts.push(part); }
    } catch (error) { entry.outcome = "stopped"; entry.note = error instanceof Error ? error.message : String(error); }
    if (entry.note === undefined) delete entry.note;
    const earlier = steps.findIndex(value => value.step === name && (name !== "evidence" || value.parts.join() === entry.parts.join()));
    if (earlier >= 0) {
      const [gone] = steps.splice(earlier, 1);
      if (gone!.outcome !== "done" && (gone!.outcome !== entry.outcome || gone!.note !== entry.note)) record.supersededSteps.push({ ...gone, supersededAt: entry.at });
    }
    steps.push(entry);
  }

  async function snapshot(): Promise<Json> {
    const spend = await call(root + "/spend");
    let operator: Json | null = null;
    if (options.operatorToken) try {
      const status = await call("/api/operator/status", { token: options.operatorToken });
      operator = { budget: status.database?.value?.budget ?? null,
        byProvider: (status.costs?.value?.byProvider ?? []).map((row: Json) => ({ provider: row.provider, monthUsd: row.monthUsd })) };
    } catch (error) { operator = { unavailable: error instanceof Error ? error.message : String(error) }; }
    return { at: now(), feature: spend, operator };
  }
  const before = await snapshot();

  // ---------------------------------------------------------------------------------------------
  // The front door, read back: what studio-run.ts made, and what the studio holds for it.
  // ---------------------------------------------------------------------------------------------
  const crewUsd: number[] = [studio.readThrough?.crewSpendUsd ?? 0, studio.plan?.crewSpendUsd ?? 0];
  const cast = ((await call(root + "/cast")).casting?.characters ?? []) as Json[];
  const joinView = await request(root + "/feature-film", { token });
  const shared = studio.review?.jobId ?? studio.final?.jobId ?? null;
  const filmJob: Json | null = shared ? await call(`/api/jobs/${shared}`) : null;
  const joined: Json[] = filmJob?.featureFilm?.sequences ?? [];
  const planned = studio.plan?.sequences?.sequences ?? [];
  const finals = new Map<string, Json>();
  for (const sequence of joined) finals.set(sequence.finalJobId, await call(`/api/jobs/${sequence.finalJobId}`));
  // HV-030-37: the jobs a final's reused shots were rendered in, so each shot is counted under the provider that rendered it.
  const reused = new Map<string, Map<string, Json>>();
  for (const [id, final] of finals) reused.set(id, await reusedSources(final, call));
  // HV-030-33: each sequence's film as the studio holds it. A film that is its bare final was never scored.
  const films = new Map<string, Json>();
  for (const sequence of joined) films.set(sequence.filmJobId, finals.get(sequence.filmJobId) ?? await call(`/api/jobs/${sequence.filmJobId}`));
  // The joined film's own record: where each sequence's film starts in it, and how long its credits run.
  let manifest: Json | null = null;
  if (filmJob?.output?.manifestUrl) try { manifest = JSON.parse(new TextDecoder().decode(await artifact(filmJob.output.manifestUrl))); } catch { manifest = null; }
  const starts = joined.map((sequence, index) => ({ number: sequence.number, startSec: manifest?.films?.[index]?.startSec ?? null, durationSec: manifest?.films?.[index]?.durationSec ?? null }));
  const sequences = joined.map(sequence => {
    const final = finals.get(sequence.finalJobId) ?? {}, plan = planned.find(value => value.number === sequence.number);
    return { number: sequence.number, firstScene: sequence.firstScene, lastScene: sequence.lastScene, shots: plan?.shots ?? (final.shotRenders?.length ?? null),
      roughCut: final.animaticJobId ?? studio.feature?.sequences.find(value => value.number === sequence.number)?.roughCut ?? null,
      final: sequence.finalJobId, film: sequence.filmJobId, filmStage: films.get(sequence.filmJobId)?.stage ?? null,
      finishNotes: studio.feature?.sequences.find(value => value.number === sequence.number)?.finished?.notes ?? [], bibleRevision: final.sequence?.bibleRevision ?? null,
      picture: { byProvider: shotProviders(final, reused.get(sequence.finalJobId)), strategy: final.providerPlan?.strategy ?? null,
        quality: final.providerPlan?.quality ? { resultsSha256: final.providerPlan.quality.resultsSha256 ?? null, fallback: final.providerPlan.quality.fallback ?? null } : null,
        // HV-030-35: the plan pins the results file whatever its pool; this says how many shots a measured provider rendered.
        routedOnScore: shotQuality(final, reused.get(sequence.finalJobId)) } };
  });
  const facts = studio.readThrough?.facts;
  record.feature = { ...record.feature, projectId: input.projectId, format: studio.format ?? null, tone: studio.tone ?? null, script: input.script ?? record.feature?.script ?? null,
    scriptFile: studio.script ?? null, driver: "scripts/studio-run.ts --format feature (createStudioFlow)", outcome: studio.outcome ?? null,
    readThrough: { source: studio.readThrough?.source ?? null, format: facts?.format ?? null, scenes: facts?.scenes ?? null, shots: facts?.shots ?? null,
      estimatedRuntimeSec: facts?.estimatedRuntimeSec ?? null, formatLimitSec: facts?.formatLimitSec ?? null, estimate: facts?.estimate ?? null, concerns: studio.readThrough?.concerns ?? null },
    plan: { source: studio.plan?.source ?? null, sequencesSource: studio.plan?.sequences?.source ?? null, sequencesRevision: studio.plan?.sequences?.revision ?? null,
      styleBibleRevision: studio.plan?.styleBible?.revision ?? null, styleBibleSource: studio.plan?.styleBible?.source ?? null },
    crew: { readThrough: studio.readThrough?.source ?? null, plan: studio.plan?.source ?? null, showrunner: studio.plan?.sequences?.source ?? null, styleBible: studio.plan?.styleBible?.source ?? null,
      fallbacks: [studio.readThrough?.fallbackReason, studio.plan?.fallbackReason, studio.plan?.sequences?.fallbackReason].filter(Boolean) },
    deskBeforeLook: studio.deskBeforeLook ?? null,
    cast: cast.map(character => ({ id: character.id, name: character.name, kind: character.kind, permission: character.permission?.status ?? null, locked: Boolean(character.referenceLock) })),
    sequences, shared,
    film: filmJob ? { jobId: filmJob.id, stage: filmJob.stage, status: filmJob.status, durationSec: manifest?.durationSec ?? null, creditsSec: manifest?.creditsSec ?? null,
      title: filmJob.featureFilm?.title ?? null, credits: filmJob.featureFilm?.credits ?? null, captionLanguage: filmJob.captionLanguage ?? null,
      ...(manifest?.bibleRevision ? { bibleRevision: manifest.bibleRevision } : {}), starts } : null,
    joins: joinView.status === 200 ? (joinView.body.jobs ?? []) : [], finishNotes: studio.finishNotes ?? [],
    review: record.feature?.review ?? (studio.review ? { linkId: studio.review.linkId, boundJobId: studio.review.jobId, maxViews: studio.review.maxViews, permission: studio.review.permission } : null) };
  const feature = record.feature, finalIds = sequences.map(sequence => sequence.final);

  await step("pitch-to-shared-feature", "front-door", async () => studio.outcome === "completed" && shared && filmJob?.stage === "feature-film"
    ? { ids: [input.projectId, shared] } : { outcome: "stopped", note: "studio-run.ts did not report this feature completed, joined and shared" });
  await step("feature-format", "front-door", async () => facts?.format === "feature" && Number(facts.shots) > 0 && facts.estimate && Number(facts.estimatedRuntimeSec) <= Number(facts.formatLimitSec)
    ? { parts: ["HV-030.feature-format"], ids: [input.projectId] } : { outcome: "unavailable", note: "the read-through did not quote a feature's runtime, shots and cost within its limit" });
  await step("showrunner-sequences", "front-door", async () => {
    if (!sequences.length || sequences.length !== planned.length) return { outcome: "unavailable", note: "the joined film does not name every sequence the Showrunner planned" };
    const made = sequences.flatMap(sequence => [sequence.roughCut, sequence.final]);
    return made.every(Boolean) ? { parts: ["HV-030.showrunner"], ids: made as string[] } : { outcome: "unavailable", note: "a sequence has no rough cut or final" };
  });
  await step("feature-assembly", "front-door", async () => filmJob?.status === "done" && filmJob.stage === "feature-film" && studio.review?.jobId === filmJob.id && joined.length === planned.length
    ? { parts: ["HV-030.feature-assembly"], ids: [filmJob.id, studio.review!.linkId] } : { outcome: "unavailable", note: "the sequences were not joined into one film shared with one review link" });
  await step("titles-credits", "front-door", async () => feature.film?.title && feature.film?.credits
    ? { parts: ["HV-025.titles-credits"], ids: [feature.film.title, feature.film.credits] } : { outcome: "unavailable", note: "the joined film carries no opening title or end credits" });
  await step("style-bible", "front-door", async () => {
    const { status, body } = await request(root + "/style-bible", { token });
    if (status !== 200) return { outcome: "unavailable", note: "the feature has no style bible at the desk (" + status + ")" };
    const revision = body.styleBible?.revision as string;
    const stale = ((body.sequences ?? []) as Json[]).filter(sequence => sequence.needsRoughCut || !(sequence.madeWith ?? []).includes(revision)).map(sequence => sequence.number);
    feature.styleBible = { revision, version: body.styleBible?.version ?? null, source: body.styleBible?.source ?? null, stale };
    if (stale.length || sequences.some(sequence => sequence.bibleRevision !== revision)) return { outcome: "unavailable", note: "sequences " + stale.join(", ") + " were not all rendered from the current style bible" };
    return { parts: ["HV-034.style-bible"], ids: [revision] };
  });
  // Identity across sequences (HV-017-17): each sequence's final, per shot, with the locks it used.
  await step("feature-identity", "front-door", async () => {
    const { status, body } = await request(root + "/identity-locks", { token });
    if (notDeployed(status, body)) return { outcome: "unavailable", note: "the identity-locks read is not on this host (HV-017-17)" };
    if (status !== 200) throw new Error("/api/projects/:id/identity-locks -> " + status + " " + (body.error ?? ""));
    const locks = ((body.locks ?? []) as Json[]).map(lock => ({ characterId: lock.characterId, name: lock.name, revision: lock.revision }));
    const read = sequences.map(sequence => {
      const own = ((body.sequences ?? []) as Json[]).find(value => value.number === sequence.number);
      const render = ((own?.renders ?? []) as Json[]).find(value => value.jobId === sequence.final);
      const used = ((render?.shots ?? []) as Json[]).flatMap(shot => (shot.locks ?? []) as Json[]);
      return { number: sequence.number, final: sequence.final, current: render?.current === true, needsRoughCut: own?.needsRoughCut === true, shots: render?.shots?.length ?? 0,
        lockedShots: ((render?.shots ?? []) as Json[]).filter(shot => shot.locks?.length).length,
        revisions: [...new Map(used.map(lock => [lock.characterId + lock.revision, { characterId: lock.characterId, revision: lock.revision }])).values()] };
    });
    record.identity = { locks, sequences: read };
    if (!locks.length) return { outcome: "unavailable", note: "no character's look is locked" };
    if (read.some(value => !value.current) || !read.some(value => value.lockedShots)) return { outcome: "unavailable", note: "not every sequence's final was rendered from the current locks" };
    return { byPart: { "HV-017.feature-identity": [...finalIds, ...locks.map(lock => lock.characterId)] } };
  });
  // Routing on measured quality (HV-019-14): every final's plan pins the benchmark's scores, not a fallback.
  await step("quality-routing", "front-door", async () => {
    const off = sequences.filter(sequence => sequence.picture.strategy !== "quality" || !HEX64.test(sequence.picture.quality?.resultsSha256 ?? "") || sequence.picture.quality?.fallback);
    if (!sequences.length || off.length) {
      const reason = off[0]?.picture.quality?.fallback ?? (off[0] ? "its strategy is " + off[0].picture.strategy : "no final");
      return { outcome: "unavailable", note: "sequence " + (off[0]?.number ?? "-") + "'s final was not routed on a measured score: " + reason };
    }
    // HV-030-35: the part is the plan's (HV-030-31). The note says how many shots a measured provider
    // actually rendered, since a mock pool, or the anchored keyframes lane, ranks as unmeasured.
    const shots = sequences.reduce((sum, sequence) => sum + sequence.picture.routedOnScore.shots, 0), measured = sequences.reduce((sum, sequence) => sum + sequence.picture.routedOnScore.measured, 0);
    const first = sequences.find(sequence => sequence.picture.routedOnScore.unmeasured)?.picture.routedOnScore.unmeasured;
    return { parts: ["HV-019.quality-routing"], ids: finalIds, note: measured + " of " + shots + " shots were rendered by a provider with a measured score" + (first ? "; the first that wasn't: " + first : "") };
  });
  // A second video vendor (HV-019): only ever after a G3 entry approves it.
  await step("second-vendor", "front-door", async () => {
    const vendors = [...new Set(sequences.flatMap(sequence => Object.keys(sequence.picture.byProvider)).filter(spec => !spec.startsWith("fal:") && !/^mock\b|^unknown$/.test(spec)))];
    record.secondVendor = { ...record.secondVendor, providers: vendors };
    if (!vendors.length) return { outcome: "unavailable", note: "every live shot of the feature was rendered on fal" };
    if (!options.secondVendorGate) return { outcome: "stopped", note: "shots were rendered by " + vendors.join(", ") + " without a G3 entry approving the vendor (--second-vendor-gate)" };
    return { parts: ["HV-019.second-vendor"], ids: sequences.filter(sequence => Object.keys(sequence.picture.byProvider).some(spec => vendors.includes(spec))).map(sequence => sequence.final) };
  });

  // ---------------------------------------------------------------------------------------------
  // The desk.
  // ---------------------------------------------------------------------------------------------
  // Continuity across sequences (HV-021-11): the Supervisor's report over every boundary, and its repair.
  if (options.continuity) await step("continuity-boundaries", "desk-api", async () => {
    const desk = await call(root + "/direction");
    const review = await call(root + "/direction/continuity/repair", { method: "POST", body: {} });
    const edits: unknown[] = review.proposal?.edits ?? [];
    let applied: Json | null = null;
    if (options.continuity!.apply && edits.length)
      applied = await call(root + "/direction/continuity/repair/accept", { method: "POST", body: { edits, expectedVersion: desk.direction.version, expectedScriptVersion: review.scriptVersion } });
    const boundaries = Array.isArray(review.report?.boundaries) ? (review.report.boundaries as Json[]).map(boundary => ({ from: boundary.from, to: boundary.to, continuous: boundary.continuous,
      sameLocation: boundary.sameLocation, comparisons: boundary.comparisons, findings: Array.isArray(boundary.findings) ? boundary.findings.length : boundary.findings })) : null;
    record.continuity = { findings: ((review.report?.scenes ?? []) as Json[]).reduce((sum, scene) => sum + (scene.findings?.length ?? 0), 0), edits: edits.length, applied: Boolean(applied),
      kept: ((review.proposal?.refused ?? []) as unknown[]).map(value => typeof value === "string" ? value : String((value as Json)?.code ?? "refused")),
      boundaries, remake: ((applied?.remake ?? review.remake ?? []) as Json[]).filter(entry => applied || entry.touched).map(entry => ({ sequence: entry.sequence, stages: entry.stages ?? [] })),
      beforeLook: studio.deskBeforeLook?.continuity ?? null, summary: review.summary ?? null,
      directionVersion: { before: desk.direction.version, after: applied?.direction?.version ?? desk.direction.version } };
    if (!boundaries) return { outcome: "unavailable", note: "the Supervisor's report has no sequence boundaries on this host (HV-021-11)", ids: [input.projectId] };
    if (edits.length && !applied) return { outcome: "unavailable", note: "the repair proposes edits that were not applied (--continuity-apply)", ids: [input.projectId] };
    return { parts: ["HV-021.cross-sequence-continuity"], ids: [input.projectId] };
  });

  // Interchange: the joined feature's cut (HV-023-05), or a named saved cut (HV-023-04), as OTIO and CMX 3600, each read back to the same shots and frames.
  if (options.interchange) await step("interchange", "desk-api", async () => {
    if (options.interchange === true && filmJob?.stage === "feature-film" && filmJob.status === "done") {
      const exported = await exportFeatureCut(desk, input.projectId, { jobId: filmJob.id, films: joined.map(sequence => sequence.filmJobId), credits: filmJob.featureFilm?.credits ?? null });
      if (exported.interchange) record.interchange = exported.interchange;
      const { interchange: _interchange, ...outcome } = exported;
      return outcome;
    }
    const library = await call(root + "/editorial");
    const saved = (library.sequences ?? []) as Json[];
    const chosen = options.interchange === true ? (saved.length === 1 ? saved[0] : undefined) : saved.find(value => value.id === options.interchange);
    if (!chosen) return { outcome: "unavailable", note: saved.length ? "name the saved cut to export (--interchange <sequence id>)"
      : options.interchange === true ? "the feature has no finished joined film and no saved editorial sequence to export" : "the feature has no saved editorial sequence " + options.interchange };
    const files = {} as Record<"otio" | "edl", Exported>;
    for (const format of ["otio", "edl"] as const) {
      const { status, body, headers, text } = await request(`${root}/editorial/sequences/${chosen.id}/interchange/${format}?historyRevision=${chosen.historyRevision}`, { token });
      if (status === 404 && body.error === "not found") return { outcome: "unavailable", note: "the interchange export is not on this host (HV-023-04)" };
      if (status !== 200) throw new Error("/api/projects/:id/editorial/sequences/:id/interchange/" + format + " -> " + status + " " + (body.error ?? ""));
      files[format] = { text, sha256: sha256(text), header: headers.get("x-hv-interchange-sha256") };
    }
    const read = readBack(files);
    record.interchange = { cut: "saved-sequence", sequenceId: chosen.id, historyRevision: chosen.historyRevision, ...read.summary };
    if (!read.same) return { outcome: "unavailable", note: "the OTIO and the EDL did not read back to the same shots and frames", ids: [files.otio.sha256, files.edl.sha256] };
    return { parts: ["HV-023.interchange"], ids: [files.otio.sha256, files.edl.sha256] };
  });

  // The hero-render chain (HV-019-15): one shot of a sequence's final through denoise, frame rate and upscale, each stage with its own record.
  if (options.hero) await step("hero-chain", "desk-api", async () => {
    const sequence = sequences.find(value => value.number === (options.hero!.sequence ?? 1));
    if (!sequence) return { outcome: "unavailable", note: "the feature has no sequence " + (options.hero!.sequence ?? 1) };
    const route = `${root}/deliveries/hero/${sequence.final}`;
    const offered = await request(route, { token });
    if (notDeployed(offered.status, offered.body, "Unknown delivery route.")) return { outcome: "unavailable", note: "the hero-render chain is not on this host (HV-019-15)" };
    if (offered.status !== 200) throw new Error("/api/projects/:id/deliveries/hero/:id -> " + offered.status + " " + (offered.body.error ?? ""));
    const shot = ((offered.body.shots ?? []) as Json[]).find(value => value.available && (!options.hero!.shotId || value.shotId === options.hero!.shotId));
    if (!shot) return { outcome: "unavailable", note: "no shot of sequence " + sequence.number + "'s final can be made a hero render" };
    const queued = await call(route, { method: "POST", body: { idempotencyKey: `release-3-hero-${sequence.final.slice(0, 8)}-${shot.shotId}`.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 128), shotId: shot.shotId } });
    const started = Date.now();
    let job: Json | undefined;
    for (;;) {
      job = ((await call(route)).jobs as Json[]).find(value => value.id === queued.jobId);
      if (job && ["done", "failed", "cancelled"].includes(job.status)) break;
      if (Date.now() - started > poll.limitMs) throw new Error("The hero render did not finish within " + Math.round(poll.limitMs / 60000) + " minutes.");
      await wait(poll.intervalMs);
    }
    const hero = job.output?.hero;
    // Each stage's record, in the creator's terms; never a file link.
    const stages = ((hero?.stages ?? []) as Json[]).map(stage => ({ index: stage.index, stage: stage.stage, engine: stage.engine, provider: stage.provider, spendUsd: stage.spendUsd,
      inputSha256: stage.inputSha256, sha256: stage.sha256, width: stage.width, height: stage.height, fps: stage.fps, frames: stage.frames }));
    record.hero = { jobId: job.id, status: job.status, sequence: sequence.number, sourceJobId: sequence.final, shotId: shot.shotId, provider: shot.provider ?? null,
      source: hero?.source ? { sha256: hero.source.sha256, width: hero.source.width, height: hero.source.height, fps: hero.source.fps } : null,
      stages, credentials: hero?.credentials ?? null, chainRevision: hero?.chainRevision ?? null, failureReason: job.failureReason ?? null };
    const chained = stages.length === 3 && stages.every((stage, index) => HEX64.test(stage.sha256 ?? "") && stage.inputSha256 === (index ? stages[index - 1]!.sha256 : hero?.source?.sha256));
    if (job.status !== "done" || !chained) return { outcome: "unavailable", note: "the hero render did not finish with three chained stage records", ids: [job.id] };
    return { parts: ["HV-019.hero-chain"], ids: [job.id] };
  });

  // Native camera control (HV-020-01): a camera move that reached the provider as its own control, not as a local crop.
  if (options.camera) await step("native-camera", "desk-api", async () => {
    const paths = sequences.flatMap(sequence => ((finals.get(sequence.final)?.cameraPathRenders ?? []) as Json[]).map((path): Json => ({ sequence: sequence.number, final: sequence.final, ...path })));
    const native = paths.filter(path => path.applied === "native"), reasons: Record<string, number> = {};
    for (const path of paths.filter(value => value.applied !== "native")) { const reason = path.reason ?? (path.applied ? "local-crop" : "local-crop (recorded before HV-020-01)"); reasons[reason] = (reasons[reason] ?? 0) + 1; }
    record.camera = { paths: paths.length, native: native.map(path => ({ sequence: path.sequence, shotId: path.shotId, moves: path.moves ?? [] })), crops: reasons };
    if (!paths.length) return { outcome: "unavailable", note: "no shot of the feature has a camera path" };
    if (!native.length) return { outcome: "unavailable", note: "every camera path was a local crop: " + Object.entries(reasons).map(([reason, count]) => reason + " x" + count).join(", ") };
    return { parts: ["HV-020.native-camera"], ids: [...new Set(native.map(path => path.final as string))] };
  });

  // A VFX composite (HV-025-13): made at the desk over a shot of a sequence's film, as joined, rendered at $0.
  if (options.vfx) await step("vfx-composite", "desk-api", async () => {
    const number = options.vfx!.sequence ?? 1, sequence = sequences.find(value => value.number === number);
    if (!sequence) return { outcome: "unavailable", note: "the feature has no sequence " + number };
    const made = await makeVfxComposite(desk, input.projectId, { jobId: sequence.film, sequence: number, shotId: finals.get(sequence.final)?.shotRenders?.[0]?.shotId ?? null }, poll);
    if (made.vfx) record.vfx = made.vfx;
    const { vfx: _vfx, ...outcome } = made;
    return outcome;
  });
  // Or one made some other way, named by its job.
  else if (options.vfxJob) await step("vfx-composite", "desk-api", async () => {
    const job = await call(`/api/jobs/${options.vfxJob}`);
    record.vfx = { jobId: job.id, stage: job.stage ?? null, status: job.status ?? null };
    if (job.projectId !== input.projectId || job.status !== "done") return { outcome: "unavailable", note: "the named composite is not a finished job of this feature", ids: [] };
    return { parts: ["HV-025.vfx-composite"], ids: [job.id] };
  });

  // Provenance: the shared feature's export, its record, its signed sidecar, and with --verify-c2pa the signature checked.
  if (options.provenance && filmJob) await step("provenance", "desk-api", async () => {
    const output = filmJob.output ?? {};
    const manifestBytes = output.manifestUrl ? await artifact(output.manifestUrl) : null;
    const record_ = manifestBytes ? JSON.parse(new TextDecoder().decode(manifestBytes)) as Json : null;
    let sidecar: Json = { present: false, sha256: null, matchesRecord: false }, signature: Uint8Array | null = null;
    if (output.c2paUrl) { signature = await artifact(output.c2paUrl); const digest = sha256(signature); sidecar = { present: true, sha256: digest, matchesRecord: record_?.credentials?.sidecar?.sha256 === digest }; }
    let verification: C2paCheck | null = null;
    if (options.verifyC2pa && manifestBytes && signature && output.mp4Url) verification = await verifyExport(await artifact(output.mp4Url), manifestBytes, signature);
    const entry = { jobId: filmJob.id, stage: filmJob.stage, credentialType: record_?.credentials?.type ?? null, sidecar, verification };
    record.provenance = { hostHoldsKey: sidecar.present === true, exports: [entry],
      verifier: options.verifyC2pa ? "scripts/verify-c2pa.ts (verifyExportC2pa) over the files the studio serves, " + (options.verifyC2pa.anchorPem ? "with the host's root as anchor" : "without an anchor")
        : "not run; scripts/verify-c2pa.ts <export dir> on the host" };
    if (!(entry.credentialType === "c2pa-sidecar" && sidecar.present && sidecar.matchesRecord)) return { outcome: "unavailable", note: "the shared feature carries no signed sidecar matching its record", ids: [filmJob.id] };
    if (options.verifyC2pa && verification?.ok !== true) return { outcome: "unavailable", note: "the shared feature's signed sidecar did not verify", ids: [filmJob.id] };
    return { ids: [filmJob.id] };
  });
  async function verifyExport(mp4: Uint8Array, manifest: Uint8Array, sidecar: Uint8Array): Promise<C2paCheck> {
    const directory = mkdtempSync(join(tmpdir(), "hv-release-3-c2pa-"));
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

  // The reviewer's side, read back by the owner: each comment placed in the sequence its frame falls in.
  if (options.reviews) await step("review-read-back", "reviewer", async () => {
    const owner = await call(root + "/reviews");
    const sequenceAt = (frame: number) => {
      const at = frame / REVIEW_FPS, last = starts.at(-1);
      if (!last || last.startSec === null || at >= last.startSec + (last.durationSec ?? 0)) return null;
      return [...starts].reverse().find(start => start.startSec !== null && at >= start.startSec)?.number ?? null;
    };
    const links = (owner.links as Json[]).map(link => ({ linkId: link.id, boundJobId: link.jobId, permission: link.permission, views: link.views, maxViews: link.maxViews,
      decision: link.decision, decisionStage: link.decisionStage, decidedAt: link.decidedAt, decisionNote: link.decisionNote,
      comments: (link.comments as Json[]).map(c => ({ id: c.id, frame: c.frame, timecode: c.timecode, sequence: Number.isSafeInteger(c.frame) ? sequenceAt(c.frame) : null, text: c.text, viewer: c.viewer, at: c.at, resolvedAt: c.resolvedAt })) }));
    const mine = links.find(link => link.linkId === studio.review?.linkId) ?? links.filter(link => link.boundJobId === shared).at(-1);
    if (mine) feature.review = mine;
    const reviewed = new Set((mine?.comments ?? []).map(comment => comment.sequence).filter(value => value !== null));
    if (!mine || !mine.comments.length || !mine.decision || !mine.decisionStage) return { outcome: "unavailable", note: "the feature's review link has no comment or decision yet" };
    if (reviewed.size < 3) return { outcome: "unavailable", note: "the feature's comments are in " + reviewed.size + " sequence(s); the criterion asks for three" };
    return { byPart: { "HV-030.feature-review": [mine.linkId, ...mine.comments.map(comment => comment.id as string)] } };
  });

  // Operator and audit parts are exercised by repository files; deferred parts name their gate entry.
  for (const [part, paths] of Object.entries(options.evidence ?? {})) {
    const surface = RELEASE_3_PARTS[part];
    if (surface !== "operator" && surface !== "audit") throw new Error("--evidence is for operator and audit parts, not " + part);
    await step("evidence", surface, async () => ({ parts: [part], ids: paths }));
  }
  for (const [part, gate] of Object.entries(options.defer ?? {})) {
    const slice = record.slices[part] as SliceEntry | undefined;
    if (!slice) throw new Error("--defer names an unknown part: " + part);
    if (!slice.exercised) slice.deferredBy = gate;
  }

  const after = await snapshot();
  const prior = merged.ledgers?.lines ?? {};
  const line = (limitUsd: number, source: string, runUsd: number | null) => ({ limitUsd, before: null, after: null, runUsd, source });
  record.ledgers = { snapshots: [...(merged.ledgers?.snapshots ?? []), { before, after }],
    lines: {
      generation: prior.generation ?? line(RELEASE_3_LINES.generation!, "the staging database's cost ledger at record time", null),
      voice: prior.voice ?? line(RELEASE_3_LINES.voice!, "the staging database's voice line at record time", null),
      music: prior.music ?? line(RELEASE_3_LINES.music!, "the staging database's music line at record time", null),
      crew: prior.crew ?? line(RELEASE_3_LINES.crew!, "the crew's own replies in this run; cumulative from the crew ledger at record time", crewUsd.reduce((a, b) => a + b, 0)),
    } };
  for (const [name, entry] of Object.entries(record.ledgers.lines as Record<string, Json>)) for (const when of ["before", "after"] as const) {
    const reading = options.lines?.[when];
    if (!reading) continue;
    entry[when] = { ...reading.lines[name]!, at: reading.at };
    entry.source = reading.basis[name] ?? entry.source;
  }
  feature.spend = after.feature ?? feature.spend ?? null;
  record.recordedAt = now();
  return record;
}

/** `--name value` pairs, where a name may repeat (`--defer`, `--evidence`). */
export function parseArguments(argv: string[]): Release3Options & { out: string } {
  const values = new Map<string, string[]>(), flags = new Set<string>();
  const FLAGS = new Set(["--continuity", "--continuity-apply", "--camera", "--provenance", "--verify-c2pa", "--reviews"]);
  // Flags that may take a value, or stand alone.
  const OPTIONAL = new Set(["--interchange", "--hero", "--vfx"]);
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]!;
    if (!name.startsWith("--")) throw new Error("unexpected argument " + name);
    if (FLAGS.has(name)) { flags.add(name); continue; }
    if (OPTIONAL.has(name) && (argv[index + 1] === undefined || argv[index + 1]!.startsWith("--"))) { flags.add(name); continue; }
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
  const tokenFile = one("--feature");
  if (!tokenFile) throw new Error("missing --feature (the project token file studio-run.ts saved)");
  const studioFile = one("--studio");
  const feature: FeatureInput = { ...readProjectKey(tokenFile), ...(studioFile ? { studio: JSON.parse(readFileSync(studioFile, "utf8")) } : {}), script: one("--script") };
  const operatorFile = one("--operator-token"), mergeFile = one("--merge");
  let operatorToken: string | undefined;
  if (operatorFile) {
    try { operatorToken = JSON.parse(readFileSync(operatorFile, "utf8")).token; } catch { operatorToken = undefined; }
    if (typeof operatorToken !== "string" || !operatorToken) throw new Error("--operator-token is not a diagnostics credential file");
  }
  const declared = one("--spend-declared");
  if (declared !== undefined && !(Number.isFinite(Number(declared)) && Number(declared) >= 0)) throw new Error("--spend-declared takes a number of US dollars");
  const heroSequence = one("--hero-sequence");
  if (heroSequence !== undefined && !/^[1-9][0-9]*$/.test(heroSequence)) throw new Error("--hero-sequence takes a sequence number");
  const vfxSequence = one("--vfx");
  if (vfxSequence !== undefined && !/^[1-9][0-9]*$/.test(vfxSequence)) throw new Error("--vfx takes a sequence number");
  if ((flags.has("--vfx") || vfxSequence) && one("--vfx-job")) throw new Error("--vfx makes a composite and --vfx-job reads one; use one of them");
  const gate = /^G\d+-\d{12}$/;
  for (const name of ["--second-vendor-gate", "--acknowledged"]) if (one(name) !== undefined && !gate.test(one(name)!)) throw new Error(name + " takes a gate entry id, such as G20-202610031349");
  for (const [part, id] of Object.entries(pairs("--defer"))) if (!(part in RELEASE_3_PARTS) || !gate.test(id)) throw new Error("--defer takes a Release 3 part and a gate entry id: " + part);
  const before = one("--lines-before"), after = one("--lines-after"), anchor = one("--c2pa-anchor");
  if (anchor && !flags.has("--verify-c2pa")) throw new Error("--c2pa-anchor needs --verify-c2pa");
  return {
    base, feature, out: one("--out") ?? "",
    ...(flags.has("--continuity") || flags.has("--continuity-apply") ? { continuity: { apply: flags.has("--continuity-apply") } } : {}),
    ...(flags.has("--interchange") ? { interchange: true as const } : one("--interchange") ? { interchange: one("--interchange")! } : {}),
    ...(flags.has("--hero") || one("--hero") || heroSequence ? { hero: { ...(one("--hero") ? { shotId: one("--hero")! } : {}), ...(heroSequence ? { sequence: Number(heroSequence) } : {}) } } : {}),
    camera: flags.has("--camera"), ...(flags.has("--vfx") || vfxSequence ? { vfx: vfxSequence ? { sequence: Number(vfxSequence) } : {} } : {}), vfxJob: one("--vfx-job"), provenance: flags.has("--provenance"), reviews: flags.has("--reviews"), operatorToken,
    ...(flags.has("--verify-c2pa") ? { verifyC2pa: anchor ? { anchorPem: readFileSync(anchor, "utf8") } : {} } : {}),
    ...(one("--second-vendor-gate") ? { secondVendorGate: one("--second-vendor-gate")! } : {}),
    ...(one("--acknowledged") ? { acknowledged: one("--acknowledged")! } : {}),
    ...(declared !== undefined ? { spendDeclared: Number(declared) } : {}),
    ...(before || after ? { lines: { ...(before ? { before: readLines(before) } : {}), ...(after ? { after: readLines(after) } : {}) } } : {}),
    defer: pairs("--defer"), evidence: Object.fromEntries(Object.entries(pairs("--evidence")).map(([part, paths]) => [part, paths.split(",")])),
    ...(mergeFile ? { merge: JSON.parse(readFileSync(mergeFile, "utf8")) } : {}),
  };
}

if (import.meta.main) {
  const options = parseArguments(process.argv.slice(2));
  const record = await runRelease3(options);
  const text = JSON.stringify(record, null, 2) + "\n";
  if (options.out) writeFileSync(options.out, text, { mode: 0o600 }); else process.stdout.write(text);
  const stopped = (record.steps as Step[]).filter(value => value.outcome === "stopped");
  for (const value of stopped) console.error("stopped:", value.step, value.note ?? "");
  if (stopped.length) process.exit(1);
}
