/**
 * HV-030-31: Release 3's exit criteria as a check over a run record (schema `hv-release-run/3`).
 *
 * The criteria live in docs/ROADMAP.md ("Release 3 exit criteria", agreed at G20-202610031349), with
 * two tables: the parts of each slice and the surface each is exercised through, and the spend lines
 * with their limits. This reads both tables, and the run's declared spend ("about $120"), from the
 * Release 3 section of the roadmap itself, and never from Release 2's: the two sections share their
 * table shapes, so the parse is bounded by the Release 3 and Release 4 headings. The gate entries
 * come from docs/loop/HUMAN-GATES.md.
 *
 * `release3Problems` answers every way a record falls short, in words. An empty list is a record that
 * meets the criteria. `test/release-3-run.test.ts` runs it over a synthetic fixture (to prove the
 * contract, never as evidence) and, once it exists, over docs/evidence/release-3/release-run.json.
 *
 * A rehearsal (build step 15, the whole feature on the mock profile at $0) is held to the same
 * contract with `rehearsal: true`. That waives only what mock can't show: live picture, the film's
 * 15-20 minute runtime (mock paces shots shorter), the review on a phone and the operator's G6. It
 * tightens spend: a rehearsal declares $0 and no line may move.
 *
 *   bun test/release-3-contract.ts <record.json> [--rehearsal]
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REVIEW_FPS, REVIEW_STAGES, reviewTimecode } from "../packages/api/src/review-comments";
import { DEFAULT_FEATURE_FILM_SPEND_CAP_USD } from "../packages/operator/src/film-budget";
import { CAST_KINDS } from "../packages/planner/src/casting";
import { SEQUENCE_SHOT_LIMIT } from "../packages/planner/src/sequences";

export const REPO = resolve(import.meta.dir, "..");
export const RECORD_PATH = "docs/evidence/release-3/release-run.json";
export const SCHEMA = "hv-release-run/3";
/** Criterion 1: "about 200-240 shots" and "15-20 minutes (900-1,200 s)". */
export const FEATURE_SHOTS = Object.freeze({ min: 200, max: 240 });
export const FEATURE_RUNTIME_SEC = Object.freeze({ min: 900, max: 1200 });
/** Criterion 3: timecoded comments in at least this many different sequences. */
export const REVIEWED_SEQUENCES = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** A studio id: a UUID, a SHA-256 or review-link digest, or a prefixed digest such as a music cue's. */
const STUDIO_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64}|[a-z]+-[0-9a-f]{32})$/;
const SURFACES = ["front-door", "desk-api", "reviewer", "operator", "audit"];
const OUTCOMES = ["done", "unavailable", "stopped"];
/** The read-through's concerns that stop or bend a pitch: none may stand against the feature (criterion 6). */
const CREW_RULE_CONCERNS = ["public_figure", "content_policy", "empty_script", "over_format"];
const ISO = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const money = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
/** A provider spec that is the studio's own stand-in, never live picture. */
const synthetic = (spec: string) => /^mock\b|(^|[:/])mock[-:/]|^unknown$/.test(spec);

export interface Criteria {
  /** Epic ids of the Release 3 table, in order of first mention. */
  epics: string[];
  parts: { part: string; epic: string; surface: string }[];
  lines: Record<string, number>;
  /** "The exit run declares about $120." */
  declaredUsd: number;
}

/** The Release 3 section alone: from its heading to Release 4's. Release 2's tables are never read. */
export function release3Section(roadmap: string): string {
  const start = roadmap.indexOf("## Release 3"), end = roadmap.indexOf("## Release 4");
  if (start < 0 || end < start) throw new Error("docs/ROADMAP.md has no Release 3 section before Release 4");
  return roadmap.slice(start, end);
}

/** The Release 3 table, the parts table, the spend lines and the declared spend, read from the roadmap's own text. */
export function readCriteria(roadmap: string): Criteria {
  const release = release3Section(roadmap), at = release.indexOf("### Release 3 exit criteria");
  if (at < 0) throw new Error("docs/ROADMAP.md has no Release 3 exit criteria");
  const table = release.slice(0, at), criteria = release.slice(at, release.indexOf("### Build order") > at ? release.indexOf("### Build order") : undefined);
  const epics = [...new Set([...table.matchAll(/^\| ((?:HV-\d{3}(?:, )?)+)[^|]*\| [^|]+\|$/gm)].flatMap(match => match[1]!.match(/HV-\d{3}/g)!))];
  const parts = [...criteria.matchAll(/^\| (HV-\d{3}\.[a-z0-9-]+) \| (HV-\d{3}) \| ([a-z-]+) \| [^|]+\|$/gm)].map(match => ({ part: match[1]!, epic: match[2]!, surface: match[3]! }));
  const lines = Object.fromEntries([...criteria.slice(criteria.indexOf("**The spend lines.**")).matchAll(/^\| ([a-z]+) \| (\d+(?:\.\d+)?) \| [^|]+\|$/gm)].map(match => [match[1]!, Number(match[2])]));
  const declared = release.match(/exit run\s+declares\s+about\s+\$(\d+(?:\.\d+)?)/);
  if (!declared) throw new Error("docs/ROADMAP.md's Release 3 section does not say what the exit run declares");
  return { epics, parts, lines, declaredUsd: Number(declared[1]) };
}

export interface GateEntry { id: string; title: string; body: string }
/** The entries of a HUMAN-GATES file: `## G20-202610031349 title`, with the lines under it. */
export function gateEntries(text: string): GateEntry[] {
  return [...text.matchAll(/^## (G\d+-\d{12})\b([^\n]*)\n([\s\S]*?)(?=^## |(?![\s\S]))/gm)].map(match => ({ id: match[1]!, title: match[2]!.trim(), body: match[3]! }));
}
export const gateIds = (text: string) => gateEntries(text).map(entry => entry.id);

/**
 * An entry that approves the second video vendor (criterion 4): its title names the second video
 * vendor, its `gate:` line names G3, and its `resolved:` line says approved. G19 and G20, which only
 * say the vendor still needs that approval, are not one.
 */
export function approvesSecondVendor(entry: GateEntry | undefined): boolean {
  if (!entry || !/second video vendor/i.test(entry.title)) return false;
  const gate = entry.body.match(/^- gate:(.*)$/m)?.[1] ?? "", resolved = entry.body.match(/^- resolved:(.*)$/m)?.[1] ?? "";
  return /\bG3\b/.test(gate) && /\bapproved\b/i.test(resolved);
}
/** The operator's acknowledgement of Release 3: a G6 entry whose title says so. */
export function acknowledgesRelease3(entry: GateEntry | undefined): boolean {
  return Boolean(entry && entry.id.startsWith("G6-") && /Release 3 acknowledged/.test(entry.title));
}

export interface Context {
  criteria: Criteria;
  gates: GateEntry[];
  /** Where an `operator` part's committed output must live. */
  evidenceRoot: string;
  /** True only for the synthetic fixture: a real record never carries the fixture marker. */
  fixture?: boolean;
  /** Build step 15, on the mock profile at $0 (see the header). */
  rehearsal?: boolean;
  /** True once the gates hold the operator's acknowledgement: the record must then cite it. */
  requireAcknowledgement?: boolean;
}

/** Which sequence of the joined film a frame falls in: the last whose start it has reached, inside the films (not the credits). */
export function sequenceAtFrame(starts: { number: number; startSec: number; durationSec: number }[], frame: number): number | null {
  const at = frame / REVIEW_FPS, last = starts.at(-1);
  if (!last || at < 0 || at >= last.startSec + last.durationSec) return null;
  return [...starts].reverse().find(start => at >= start.startSec)?.number ?? null;
}

export function release3Problems(record: any, context: Context): string[] {
  const problems: string[] = [], say = (problem: string) => problems.push(problem);
  const { criteria } = context, rehearsal = context.rehearsal === true;
  const gate = (id: unknown) => context.gates.find(entry => entry.id === id);
  if (record?.schema !== SCHEMA) say("the record is not schema " + SCHEMA);
  if (!context.fixture && "fixture" in (record ?? {})) say("a synthetic fixture cannot stand as the release's evidence");
  if (!money(record?.spendUsdDeclared)) say("the record does not declare its spend");
  else if (rehearsal ? record.spendUsdDeclared !== 0 : record.spendUsdDeclared > criteria.declaredUsd)
    say(rehearsal ? "a rehearsal declares $0" : "the record declares more than the roadmap's $" + criteria.declaredUsd + " for the feature");
  if (!Array.isArray(record?.knownGaps) || record.knownGaps.some((gap: unknown) => typeof gap !== "string")) say("the known gaps are not a list of sentences");
  if (!Array.isArray(record?.stoppedAttempts) || record.stoppedAttempts.some((attempt: any) => !money(attempt?.spend?.spentUsd) || typeof attempt?.stoppedBy !== "string"))
    say("every stopped attempt must say what stopped it and what it spent");
  if (typeof record?.creator !== "string" || !record.creator) say("the record does not say who the one creator is");

  // No credential travels in a record: no token, no signed media link, no review link.
  const text = JSON.stringify(record ?? {});
  if (/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{43}/.test(text) || /\/artifacts\/|#\/review\/|Bearer /.test(text)) say("the record carries a credential or a signed link");

  // 1. One feature, from pasted script to one shared film, with live picture.
  const feature = record?.feature ?? null;
  if (!feature || typeof feature !== "object") { say("the record holds no feature"); return problems; }
  if (feature.format !== "feature" || feature.readThrough?.format !== "feature") say("the film was not pitched as a feature");
  if (!UUID.test(feature.projectId ?? "")) say("the feature has no project id");
  if (typeof feature.script !== "string" || !existsSync(resolve(REPO, feature.script))) say("the feature's script is not in the repository");
  if (feature.outcome !== "completed") say("the feature did not go from a pasted script to a shared film");
  const shotsRead = feature.readThrough?.shots;
  if (!Number.isSafeInteger(shotsRead) || shotsRead < FEATURE_SHOTS.min || shotsRead > FEATURE_SHOTS.max)
    say("the read-through did not read a feature of " + FEATURE_SHOTS.min + "-" + FEATURE_SHOTS.max + " shots");
  const sequences: any[] = Array.isArray(feature.sequences) ? feature.sequences : [];
  if (!sequences.length) say("the feature has no sequences");
  let scene = 1;
  const total = sequences.reduce((sum, sequence) => sum + (Number.isSafeInteger(sequence?.shots) ? sequence.shots : 0), 0);
  sequences.forEach((sequence, index) => {
    const name = "sequence " + (index + 1);
    if (sequence?.number !== index + 1) say(name + " is out of order");
    if (!Number.isSafeInteger(sequence?.shots) || sequence.shots < 1 || sequence.shots > SEQUENCE_SHOT_LIMIT) say(name + " is not 1-" + SEQUENCE_SHOT_LIMIT + " shots");
    if (sequence?.firstScene !== scene || !Number.isSafeInteger(sequence?.lastScene) || sequence.lastScene < sequence.firstScene) say(name + " does not start where the sequence before it ends");
    else scene = sequence.lastScene + 1;
    if (![sequence?.roughCut, sequence?.final, sequence?.film].every(id => UUID.test(id ?? ""))) say(name + " has no rough cut, final and finished film");
    // HV-030-33: a finished film is the Composer's sound mix of the final, as the studio holds it. A
    // sequence whose score failed is joined as its bare final, and that is not a finished film.
    else if (sequence?.filmStage !== "sound-mix") say(name + "'s film was not scored (the studio holds it as " + (sequence?.filmStage ?? "an unrecorded stage") + ")");
  });
  if (sequences.length && scene - 1 !== feature.readThrough?.scenes) say("the sequences do not cover every scene of the feature");
  if (sequences.length && (total < FEATURE_SHOTS.min || total > FEATURE_SHOTS.max)) say("the sequences do not hold " + FEATURE_SHOTS.min + "-" + FEATURE_SHOTS.max + " shots");
  if (new Set(sequences.map(sequence => sequence?.final)).size !== sequences.length) say("two sequences name the same final");
  const film = feature.film ?? {};
  if (!UUID.test(film.jobId ?? "") || film.stage !== "feature-film" || feature.shared !== film.jobId) say("the sequences were not joined into the one film that was shared");
  if (!rehearsal) {
    const picture = money(film.durationSec) && money(film.creditsSec) ? film.durationSec - film.creditsSec : NaN;
    if (!(picture >= FEATURE_RUNTIME_SEC.min && picture <= FEATURE_RUNTIME_SEC.max)) say("the joined film does not run " + FEATURE_RUNTIME_SEC.min + "-" + FEATURE_RUNTIME_SEC.max + " s before its credits");
  }
  const approvedVendor = approvesSecondVendor(gate(record?.secondVendor?.approvedBy));
  for (const sequence of sequences) {
    const byProvider: Record<string, number> = sequence?.picture?.byProvider ?? {}, counted = Object.values(byProvider).reduce((sum: number, n) => sum + (Number.isSafeInteger(n) ? n : 0), 0);
    if (counted !== sequence?.shots) { say("sequence " + sequence?.number + "'s final does not account for every shot's provider"); continue; }
    if (rehearsal) continue;
    if (Object.keys(byProvider).some(synthetic)) say("sequence " + sequence.number + " carries a mock slate in the shared film");
    const other = Object.keys(byProvider).filter(spec => !synthetic(spec) && !spec.startsWith("fal:"));
    if (other.length && !approvedVendor) say("sequence " + sequence.number + " was rendered by a second vendor without its G3 approval");
  }

  // 2. One cast and one look across every sequence.
  const bible = feature.plan?.styleBibleRevision;
  if (!HEX64.test(bible ?? "")) say("the feature has no style bible");
  else {
    for (const sequence of sequences) if (sequence?.bibleRevision !== bible) say("sequence " + sequence?.number + " was not rendered from the feature's style bible");
    if (film.bibleRevision !== undefined && film.bibleRevision !== bible) say("the joined film does not record the feature's style bible");
  }
  const slices = record?.slices ?? {};
  if (slices["HV-017.feature-identity"]?.exercised === true) {
    const identity = record?.identity ?? {}, locks: any[] = Array.isArray(identity.locks) ? identity.locks : [];
    const current = new Map(locks.map(lock => [lock?.characterId, lock?.revision]));
    if (!locks.length || locks.some(lock => !UUID.test(lock?.characterId ?? "") || !HEX64.test(lock?.revision ?? ""))) say("no character's look is locked");
    let lockedShots = 0;
    for (const sequence of sequences) {
      const read = (identity.sequences ?? []).find((value: any) => value?.number === sequence.number);
      if (!read || read.final !== sequence.final || read.current !== true) { say("sequence " + sequence.number + "'s final was not rendered from the current locks"); continue; }
      lockedShots += Number.isSafeInteger(read.lockedShots) ? read.lockedShots : 0;
      for (const used of read.revisions ?? []) if (current.get(used?.characterId) !== used?.revision) say("sequence " + sequence.number + " used a lock revision the cast no longer holds");
    }
    if (!lockedShots) say("no shot of the feature was rendered from a lock");
  }
  if (slices["HV-021.cross-sequence-continuity"]?.exercised === true) {
    const continuity = record?.continuity ?? {}, boundaries: any[] = Array.isArray(continuity.boundaries) ? continuity.boundaries : [];
    if (boundaries.length !== Math.max(0, sequences.length - 1) || boundaries.some((boundary, index) => boundary?.from !== index + 1 || boundary?.to !== index + 2))
      say("the Continuity Supervisor's report does not cover every sequence boundary");
    if (Number(continuity.edits) > 0 && continuity.applied !== true) say("the Continuity Supervisor's repair was proposed but not applied");
    if (!Array.isArray(continuity.kept) || continuity.kept.some((code: unknown) => typeof code !== "string")) say("the findings the repair kept are not listed");
    if (Array.isArray(continuity.remake) && continuity.remake.length) say("a continuity repair applied after the finals leaves sequences to make again");
  }

  // 3. Reviewed on a second device: comments in at least three sequences, and a decision naming its stage.
  const review = feature.review;
  if (!rehearsal) {
    if (!HEX64.test(review?.linkId ?? "") || review.permission !== "approve" || review.boundJobId !== film.jobId || !(review.views > 0))
      say("the feature's review link was not opened on the joined film");
    else {
      if (!["approved", "changes_requested"].includes(review.decision) || !(REVIEW_STAGES as readonly string[]).includes(review.decisionStage) || !ISO(review.decidedAt))
        say("the feature's reviewer did not decide a stage");
      const comments: any[] = Array.isArray(review.comments) ? review.comments : [], starts: any[] = Array.isArray(film.starts) ? film.starts : [];
      for (const comment of comments) {
        if (!UUID.test(comment?.id ?? "") || !Number.isSafeInteger(comment.frame) || comment.frame < 0 || comment.timecode !== reviewTimecode(comment.frame))
          say("the feature has a comment that is not pinned to a frame");
        else if (comment.sequence !== sequenceAtFrame(starts, comment.frame)) say("a comment names a sequence its frame is not in");
      }
      const reviewed = new Set(comments.map(comment => comment?.sequence).filter(value => Number.isSafeInteger(value)));
      if (reviewed.size < REVIEWED_SEQUENCES) say("the feature has timecoded comments in fewer than " + REVIEWED_SEQUENCES + " sequences");
    }
  }

  // 8. Each step names its surface.
  const steps: any[] = Array.isArray(record?.steps) ? record.steps : [];
  for (const step of steps) if (!SURFACES.includes(step?.surface) || !OUTCOMES.includes(step?.outcome) || !Array.isArray(step?.parts) || !Array.isArray(step?.ids))
    say("a step does not name its surface, outcome, parts and ids: " + JSON.stringify(step?.step));
  if (!steps.some(step => step?.step === "pitch-to-shared-feature" && step.surface === "front-door" && step.outcome === "done")) say("the feature has no front-door step");
  if (steps.some(step => step?.surface === "desk-api") && feature.directorsDesk === false) say("the record says the Director's desk was never opened, but a step used it");

  // 4. Every Release 3 slice is accounted for: each part exercised with real ids, or deferred to a gate entry that exists.
  const named = new Set(criteria.parts.map(part => part.part));
  for (const key of Object.keys(slices)) if (!named.has(key)) say("the record names a part the criteria do not: " + key);
  for (const { part, surface } of criteria.parts) {
    const slice = slices[part];
    if (!slice) { say(part + " is not accounted for"); continue; }
    if (slice.surface !== surface) say(part + " names the wrong surface");
    if (slice.exercised === true && slice.deferredBy) say(part + " is both exercised and deferred");
    if (slice.exercised === true) {
      const ids: unknown[] = Array.isArray(slice.ids) ? slice.ids : [];
      if (!ids.length) say(part + " is exercised with no ids");
      const paths = surface === "operator" || surface === "audit";
      for (const id of ids) {
        if (typeof id !== "string") { say(part + " has an id that is not text"); continue; }
        if (paths ? !existsSync(resolve(REPO, id)) || (surface === "operator" && !id.startsWith(context.evidenceRoot)) : !STUDIO_ID.test(id))
          say(part + " has an id that is not a real " + (paths ? "repository path" : "studio id") + ": " + id);
      }
      const by = steps.filter(step => step.outcome === "done" && step.surface === surface && step.parts?.includes(part));
      if (!by.length) say(part + " has no step that exercised it");
      else if (ids.some(id => !by.some(step => step.ids.includes(id)))) say(part + " has ids no step reported");
    } else if (typeof slice.deferredBy !== "string" || !gate(slice.deferredBy)) say(part + " is neither exercised nor deferred to a gate entry that exists");
  }
  if (slices["HV-019.second-vendor"]?.exercised === true && !approvedVendor) say("HV-019.second-vendor is exercised without a G3 entry approving the vendor");
  const epics = new Set(criteria.parts.map(part => part.epic));
  for (const epic of criteria.epics) if (!epics.has(epic)) say(epic + "'s slice has no part in the criteria");

  // 5. Within declared spend on every line, and the feature within its own film limit.
  const lines = record?.ledgers?.lines ?? {};
  let run = 0;
  for (const [name, limit] of Object.entries(criteria.lines)) {
    const line = lines[name];
    if (!line) { say("the " + name + " line is not recorded"); continue; }
    if (line.limitUsd !== limit) say("the " + name + " line names the wrong limit");
    const { before, after } = line;
    if (![before?.spentUsd, before?.heldUsd, after?.spentUsd, after?.heldUsd].every(money)) { say("the " + name + " line has no before and after"); continue; }
    if (after.spentUsd < before.spentUsd) say("the " + name + " line went backwards");
    if (after.spentUsd + after.heldUsd > limit) say("the " + name + " line is over its $" + limit + " limit");
    if (rehearsal && after.spentUsd !== before.spentUsd) say("the " + name + " line moved in a rehearsal");
    run += after.spentUsd - before.spentUsd;
  }
  for (const name of Object.keys(lines)) if (!(name in criteria.lines)) say("the record names a line the criteria do not: " + name);
  if (money(record?.spendUsdDeclared) && run > record.spendUsdDeclared + 0.005) say("the run spent more than it declared");
  const spend = feature.spend;
  if (!money(spend?.spentUsd) || !money(spend?.heldUsd) || spend.capUsd !== DEFAULT_FEATURE_FILM_SPEND_CAP_USD || spend.spentUsd + spend.heldUsd > spend.capUsd)
    say("the feature is not within its own $" + DEFAULT_FEATURE_FILM_SPEND_CAP_USD + " film limit");

  // 6. The crew's rules hold at feature length: consented casting, no public figure, English only.
  const concerns: unknown[] = Array.isArray(feature.readThrough?.concerns) ? feature.readThrough.concerns : [null];
  if (concerns.some(kind => typeof kind !== "string" || CREW_RULE_CONCERNS.includes(kind))) say("the read-through raised a concern against the feature");
  const cast: any[] = Array.isArray(feature.cast) ? feature.cast : [];
  if (!cast.length || cast.some(character => !(CAST_KINDS as readonly string[]).includes(character?.kind) || character?.permission !== "permitted"))
    say("the feature's cast is not every character original or consented, and permitted");
  if (film.captionLanguage !== "en") say("the feature is not in English");

  // 7. The shared feature carries its provenance.
  const signed = (record?.provenance?.exports ?? []).find((value: any) => value?.jobId === film.jobId);
  if (!signed || signed.credentialType !== "c2pa-sidecar" || signed.sidecar?.present !== true || !HEX64.test(signed.sidecar?.sha256 ?? "") || signed.sidecar?.matchesRecord !== true)
    say("the shared feature has no signed sidecar matching its record");
  else if (signed.verification?.ok !== true || !["Valid", "Trusted"].includes(signed.verification?.state)) say("the shared feature's signed sidecar was not verified");

  // 9. The operator acknowledges the release (G6), once the gates hold it.
  const acknowledgement = record?.acknowledgement;
  if (acknowledgement !== null && acknowledgement !== undefined && !acknowledgesRelease3(gate(acknowledgement?.gate))) say("the acknowledgement does not cite the operator's G6 for Release 3");
  if (context.requireAcknowledgement && !rehearsal && !acknowledgesRelease3(gate(acknowledgement?.gate))) say("the operator's acknowledgement (G6) is not cited");
  return problems;
}

/** The roadmap, the gates and the record root, as the real record is held to them. */
export function realContext(): Context {
  const gates = gateEntries(readFileSync(resolve(REPO, "docs/loop/HUMAN-GATES.md"), "utf8"));
  return { criteria: readCriteria(readFileSync(resolve(REPO, "docs/ROADMAP.md"), "utf8")), gates, evidenceRoot: "docs/evidence/release-3/",
    requireAcknowledgement: gates.some(acknowledgesRelease3) };
}

if (import.meta.main) {
  const path = process.argv[2];
  if (!path) throw new Error("usage: bun test/release-3-contract.ts <record.json> [--rehearsal]");
  const found = release3Problems(JSON.parse(readFileSync(path, "utf8")), { ...realContext(), rehearsal: process.argv.includes("--rehearsal") });
  for (const problem of found) console.log("- " + problem);
  console.log(found.length ? found.length + " problem(s)" : "meets the criteria");
  if (found.length) process.exit(1);
}
