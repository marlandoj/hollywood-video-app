/**
 * HV-030-22: Release 2's exit criteria as a check over a run record (schema `hv-release-run/2`).
 *
 * The criteria live in docs/ROADMAP.md ("Release 2 exit criteria"), with two tables: the parts of each
 * slice and the surface each is exercised through, and the spend lines with their limits. This reads
 * both tables from the roadmap itself, and the gate entries from docs/loop/HUMAN-GATES.md, so the
 * record is held to the words the operator agrees at G6 rather than to a copy of them.
 *
 * `release2Problems` answers every way a record falls short, in words. An empty list is a record
 * that meets the criteria. `test/release-2-run.test.ts` runs it over a synthetic fixture (to prove the
 * contract, never as evidence) and, once it exists, over docs/evidence/release-2/release-run.json.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REVIEW_STAGES, reviewTimecode } from "../packages/api/src/review-comments";

export const REPO = resolve(import.meta.dir, "..");
export const RECORD_PATH = "docs/evidence/release-2/release-run.json";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
/** A studio id: a UUID, a SHA-256 or review-link digest, or a prefixed digest such as a music cue's. */
const STUDIO_ID = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{64}|[a-z]+-[0-9a-f]{32})$/;
const SURFACES = ["front-door", "desk-api", "reviewer", "operator", "audit"];
const OUTCOMES = ["done", "unavailable", "stopped"];
const ISO = (value: unknown) => typeof value === "string" && Number.isFinite(Date.parse(value));
const money = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

export interface Criteria {
  /** Epic ids of the Release 2 table. */
  epics: string[];
  parts: { part: string; epic: string; surface: string }[];
  lines: Record<string, number>;
}

/** The Release 2 table, the parts table and the spend lines, read from the roadmap's own text. */
export function readCriteria(roadmap: string): Criteria {
  const release = roadmap.slice(roadmap.indexOf("## Release 2"), roadmap.indexOf("## Release 3"));
  const criteria = release.slice(release.indexOf("### Release 2 exit criteria"));
  if (!release || release.indexOf("### Release 2 exit criteria") < 0) throw new Error("docs/ROADMAP.md has no Release 2 exit criteria");
  const table = release.slice(0, release.indexOf("### Release 2 exit criteria"));
  const epics = [...table.matchAll(/^\| (HV-\d{3}) [^|]+\| [^|]+\|$/gm)].map(match => match[1]!);
  const parts = [...criteria.matchAll(/^\| (HV-\d{3}\.[a-z0-9-]+) \| (HV-\d{3}) \| ([a-z-]+) \| [^|]+\|$/gm)].map(match => ({ part: match[1]!, epic: match[2]!, surface: match[3]! }));
  const lines = Object.fromEntries([...criteria.slice(criteria.indexOf("**The spend lines.**")).matchAll(/^\| ([a-z]+) \| (\d+(?:\.\d+)?) \| [^|]+\|$/gm)].map(match => [match[1]!, Number(match[2])]));
  return { epics, parts, lines };
}

/** The ids of the entries in a HUMAN-GATES file: `## G15-202609301223 ...`. */
export function gateIds(text: string): string[] {
  return [...text.matchAll(/^## (G\d+-\d{12})\b/gm)].map(match => match[1]!);
}

export interface Context {
  criteria: Criteria;
  gates: string[];
  /** Where an `operator` part's committed output must live. */
  evidenceRoot: string;
  /** True only for the synthetic fixture: a real record never carries the fixture marker. */
  fixture?: boolean;
}

export function release2Problems(record: any, context: Context): string[] {
  const problems: string[] = [], say = (problem: string) => problems.push(problem);
  const { criteria } = context;
  if (record?.schema !== "hv-release-run/2") say("the record is not schema hv-release-run/2");
  if (!context.fixture && "fixture" in (record ?? {})) say("a synthetic fixture cannot stand as the release's evidence");
  if (!money(record?.spendUsdDeclared)) say("the record does not declare its spend");
  if (!Array.isArray(record?.knownGaps) || record.knownGaps.some((gap: unknown) => typeof gap !== "string")) say("the known gaps are not a list of sentences");
  if (!Array.isArray(record?.stoppedAttempts) || record.stoppedAttempts.some((attempt: any) => !money(attempt?.spend?.spentUsd) || typeof attempt?.stoppedBy !== "string"))
    say("every stopped attempt must say what stopped it and what it spent");

  // No credential travels in a record: no token, no signed media link, no review link.
  const text = JSON.stringify(record ?? {});
  if (/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{43}/.test(text) || /\/artifacts\/|#\/review\/|Bearer /.test(text)) say("the record carries a credential or a signed link");

  // 1. Two films by the same creator, the second pitched with the first's style card.
  const films: any[] = Array.isArray(record?.films) ? record.films : [];
  const a = films.find(film => film?.key === "A"), b = films.find(film => film?.key === "B");
  if (films.length !== 2 || !a || !b) say("the record does not hold exactly two films, A and B");
  if (typeof record?.creator !== "string" || !record.creator) say("the record does not say who the one creator is");
  for (const film of [a, b].filter(Boolean)) {
    const name = "film " + film.key;
    if (!UUID.test(film.projectId ?? "")) say(name + " has no project id");
    if (typeof film.script !== "string" || !existsSync(resolve(REPO, film.script))) say(name + "'s script is not in the repository");
    if (film.outcome !== "completed" || !UUID.test(film.shared ?? "") || !UUID.test(film.final ?? "")) say(name + " did not go from a pasted script to a shared film");
    if (!money(film.spend?.spentUsd) || !money(film.spend?.heldUsd) || !money(film.spend?.capUsd) || film.spend.spentUsd + film.spend.heldUsd > film.spend.capUsd)
      say(name + " is not within its own film cap");
  }
  if (a && b && a.projectId === b.projectId) say("films A and B are the same project");
  const kept = a?.styleCard?.kept?.sha256, attached = b?.styleCard?.attached?.sha256;
  if (!HEX64.test(kept ?? "") || kept !== attached || b?.readStyleCard !== true) say("film B was not pitched with the style card film A kept, read by the crew");
  const memory = record?.memory?.styleCard;
  if (!memory || memory.sha256 !== kept || memory.keptFrom !== a?.projectId || memory.attachedTo !== b?.projectId) say("the crew's memory of the creator's style is not recorded from A to B");

  // 2. Reviewed on a second device: a timecoded comment and a decision naming its stage, on each film.
  for (const film of [a, b].filter(Boolean)) {
    const review = film.review, name = "film " + film.key;
    if (!HEX64.test(review?.linkId ?? "") || review.permission !== "approve" || review.boundJobId !== film.shared || !(review.views > 0))
      { say(name + "'s review link was not opened on the shared film"); continue; }
    if (!["approved", "changes_requested"].includes(review.decision) || !(REVIEW_STAGES as readonly string[]).includes(review.decisionStage) || !ISO(review.decidedAt))
      say(name + "'s reviewer did not decide a stage");
    const comments: any[] = Array.isArray(review.comments) ? review.comments : [];
    if (!comments.length) say(name + " has no timecoded comment");
    for (const comment of comments)
      if (!UUID.test(comment?.id ?? "") || !Number.isSafeInteger(comment.frame) || comment.frame < 0 || comment.timecode !== reviewTimecode(comment.frame))
        say(name + " has a comment that is not pinned to a frame");
  }

  // 6. Each step names its surface; the record makes no claim that the desk was never opened.
  const steps: any[] = Array.isArray(record?.steps) ? record.steps : [];
  for (const step of steps) if (!SURFACES.includes(step?.surface) || !OUTCOMES.includes(step?.outcome) || !Array.isArray(step?.parts) || !Array.isArray(step?.ids))
    say("a step does not name its surface, outcome, parts and ids: " + JSON.stringify(step?.step));
  for (const film of [a, b].filter(Boolean))
    if (!steps.some(step => step.step === "pitch-to-shared-film" && step.film === film.key && step.surface === "front-door" && step.outcome === "done"))
      say("film " + film.key + " has no front-door step");
  if (steps.some(step => step.surface === "desk-api") && films.some(film => film?.directorsDesk === false)) say("the record says the Director's desk was never opened, but a step used it");

  // 3. Every Release 2 slice is accounted for: each part exercised with real ids, or deferred to a gate entry that exists.
  const slices = record?.slices ?? {};
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
    } else if (typeof slice.deferredBy !== "string" || !context.gates.includes(slice.deferredBy)) say(part + " is neither exercised nor deferred to a gate entry that exists");
  }
  const epics = new Set(criteria.parts.map(part => part.epic));
  for (const epic of criteria.epics) if (!epics.has(epic)) say(epic + "'s slice has no part in the criteria");

  // 4. Within declared spend on every line.
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
    run += after.spentUsd - before.spentUsd;
  }
  for (const name of Object.keys(lines)) if (!(name in criteria.lines)) say("the record names a line the criteria do not: " + name);
  if (money(record?.spendUsdDeclared) && run > record.spendUsdDeclared + 0.005) say("the run spent more than it declared");

  // 5. Signed C2PA sidecars verify when the host holds the key; otherwise the part is deferred.
  const provenance = record?.provenance, signedPart = slices["HV-031.signed-c2pa"];
  if (typeof provenance?.hostHoldsKey !== "boolean") say("the record does not say whether the host holds a signing key");
  else if (provenance.hostHoldsKey) {
    if (signedPart?.exercised !== true) say("the host holds a signing key, but signed C2PA is not exercised");
    for (const film of [a, b].filter(Boolean)) {
      const signed = (provenance.exports ?? []).find((value: any) => value?.jobId === film.shared);
      if (!signed || signed.credentialType !== "c2pa-sidecar" || signed.sidecar?.present !== true || !HEX64.test(signed.sidecar?.sha256 ?? "") || signed.sidecar?.matchesRecord !== true)
        say("film " + film.key + "'s shared export has no signed sidecar matching its record");
      else if (signed.verification?.ok !== true || !["Valid", "Trusted"].includes(signed.verification?.state)) say("film " + film.key + "'s signed sidecar was not verified");
    }
  } else if (signedPart?.exercised === true) say("signed C2PA is exercised, but the host holds no key");
  return problems;
}

/** The roadmap, the gates and the record root, as the real record is held to them. */
export function realContext(): Context {
  return { criteria: readCriteria(readFileSync(resolve(REPO, "docs/ROADMAP.md"), "utf8")),
    gates: gateIds(readFileSync(resolve(REPO, "docs/loop/HUMAN-GATES.md"), "utf8")), evidenceRoot: "docs/evidence/release-2/" };
}
