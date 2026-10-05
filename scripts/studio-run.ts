/**
 * Runs one film through the studio's front door, exactly as the page does (createStudioFlow),
 * against a running private studio. Every crew proposal is accepted, the creator attests the
 * crew's original cast, and the rough cut is approved. Used for the live proofs (HV-019-05) and
 * the Release 1 run. It prints a JSON report: ids, timings and the film's spend at each approval.
 * It never reads or prints a provider key.
 *
 *   bun scripts/studio-run.ts --base http://127.0.0.1:8081 --script film.fountain --format reel --tone "warm" --out report.json
 *
 * Release 2 (HV-030-22) adds three steps a creator takes at the front door:
 *   --keep-style-card <file>  keep this film's style card once the crew has planned it (mode 600)
 *   --style-card <file>       attach a kept card to this pitch, as "Read my style card" does
 *   --share N                 share the final with a reviewer, admitting N viewers; the link goes to
 *                             --review-out (default: beside --out as .review, mode 600), never the report
 *
 * HV-030-23: `--script` may be a Final Draft file (`.fdx`). It is read by the studio's own importer
 * (the one behind the desk's script import), and the Fountain it gives is what the creator pastes.
 * The report names the file by its SHA-256 and says which crew vendor answered each step.
 *
 * HV-030-31 (Release 3): `--format feature` drives the whole feature. The look is approved once, then
 * each sequence's rough cut and final in turn, as the creator presses "Approve sequence k and make
 * sequence k+1's rough cut"; after the last, the Editor joins the sequences into one film with its
 * title and credits, and `--share` shares that one film. The report lists each sequence's rough cut
 * and finished film, the Showrunner's split and the style bible's revision. Two desk steps can be
 * taken before the look is approved, because the first sequence renders the moment it is
 * (scripts/release-3-desk.ts, surface `desk-api`):
 *   --lock NAME[,NAME]       lock each named character's look (a turnaround sheet first if it has no image)
 *   --continuity-repair      review the Continuity Supervisor's repair and apply what it proposes
 *
 * HV-030-37: `--resume` carries on a feature an earlier run of this script stopped, in the same project. It reads
 * the earlier record (`--out`, which the resumed record replaces) and its token file, and the studio's own state:
 * the split, each sequence's jobs and approvals, the cast (createStudioFlow's `resumeFeature`). Nothing paid for
 * is asked for again: not the read-through or the plan, which the record keeps, not the look, an approved rough
 * cut or a finished sequence (finished again with the keys fixed by its film, so the studio answers with what it
 * made). A failed final is asked for again under a fresh key, with the shots it rendered reused at $0. The record
 * keeps every earlier step and adds `resumes`: what each resume kept, retried and made, and what it replaced.
 *
 *   bun scripts/studio-run.ts --base $BASE --script $S/feature.fountain --resume --share 5 --out "$R/f.json"
 *
 * HV-030-39: a finished sequence's finishing steps (the cast's takes and voices, the score, the titles and the join)
 * are kept when their job is done or running, and asked for again under `<key>-retry-<n>` when it ended failed or
 * cancelled: the voices on the final, then the score on the voiced cut. No picture is rendered for them. The resume
 * records each step (`resumes[].finishing`) and, for a sequence it redid, the earlier run's notes on why. A run
 * stopped by SIGTERM or SIGINT writes its record too, with where it was (`interrupted`).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { importFinalDraft } from "../packages/parser/src/final-draft";
// @ts-expect-error -- the studio is a plain browser module with no type declarations.
import { createStudioFlow } from "../packages/frontend/src/studio.js";
import { deskBeforeLook } from "./release-3-desk";
import { besideReport, keepStyleCardFile, readProjectKey, readStyleCardFile, sha256, sharedLink, writePrivate } from "./release-run-files";

const option = (name: string, fallback?: string) => {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error("missing " + name);
  return value;
};
const base = option("--base").replace(/\/$/, "");
const scriptPath = option("--script"), scriptFile = readFileSync(scriptPath, "utf8");
// A Final Draft script is read by the studio's own importer; anything else is pasted as it is.
const finalDraft = /\.fdx$/i.test(scriptPath), imported = finalDraft ? importFinalDraft(scriptFile) : undefined;
const script = imported ? imported.text : scriptFile;
const format = option("--format", "reel"), tone = option("--tone", "warm and hopeful"), out = option("--out", "");
const stopAfter = option("--stop-after", "final");
if (!["look", "rough-cut", "final"].includes(stopAfter)) throw new Error("--stop-after must be look, rough-cut or final");
const keepCard = option("--keep-style-card", ""), attachCard = option("--style-card", ""), shareViews = option("--share", "");
if (shareViews && (!/^[1-9][0-9]*$/.test(shareViews) || stopAfter !== "final")) throw new Error("--share takes a number of viewers, and needs the final");
const lockNames = option("--lock", "").split(",").map(name => name.trim()).filter(Boolean), repairBeforeLook = process.argv.includes("--continuity-repair");
const resuming = process.argv.includes("--resume"), pollMs = Number(option("--poll-ms", "3000"));
if (!Number.isSafeInteger(pollMs) || pollMs < 1) throw new Error("--poll-ms takes a whole number of milliseconds");
if (resuming && (attachCard || keepCard)) throw new Error("--resume carries on a planned feature; its style card was read or kept when it was planned");
// Read before anything is made, so a card that is not one stops the run before a project exists.
const attached = attachCard ? readStyleCardFile(attachCard) : undefined;

async function api(path: string, init: RequestInit = {}) {
  const response = await fetch(base + path, { ...init, headers: { origin: base, ...(init.headers as Record<string, string> | undefined) } });
  const text = await response.text();
  const body = text ? JSON.parse(text) : {};
  if (!response.ok) throw new Error(path.replace(/[0-9a-f-]{36}/g, ":id") + " -> " + response.status + " " + (body.error ?? text.slice(0, 200)));
  return body;
}

let project: { projectId: string; token: string } | undefined;
// HV-030-37: the earlier run a resume carries on, read before anything is asked of the studio.
type Earlier = Record<string, any>;
let earlier: Earlier | undefined;
if (resuming) {
  if (!out) throw new Error("--resume needs --out: the earlier run's record, which the resumed record replaces");
  try { earlier = JSON.parse(readFileSync(out, "utf8")) as Earlier; } catch { throw new Error("--resume needs the earlier run's record at --out"); }
  if (earlier.schema !== "hv-studio-run/1" || earlier.format !== "feature" || !earlier.plan?.sequences) throw new Error("--resume carries on a feature this script pitched and planned");
  if (earlier.script?.sha256 !== sha256(scriptFile)) throw new Error("--resume needs the script the earlier run pitched; this file's sha256 differs");
}
const started = Date.now(), marks: Record<string, number> = {};
const mark = (name: string) => { marks[name] = Math.round((Date.now() - started) / 1000); };
let lastProgress = "";
// The project token is the only key to the film (no accounts), so it is saved the moment the
// project exists: a share link is made from it after the run. Beside --out unless --token-out names a file.
const tokenOut = besideReport(out, ".token", option("--token-out", ""));
const reviewOut = besideReport(out, ".review", option("--review-out", ""));
if (earlier) {
  project = readProjectKey(tokenOut);
  if (project.projectId !== earlier.projectId) throw new Error("the token file names another project than the earlier record");
}
if (shareViews && !reviewOut) throw new Error("--share needs --out or --review-out: the review link is written to a file, never printed");
const flow = createStudioFlow({ api, getProject: () => project, setProject: (value: typeof project) => {
  project = value;
  if (tokenOut && value) writePrivate(tokenOut, JSON.stringify(value) + "\n");
},
  fetchImage: async (url: string) => { const response = await fetch(base + url); if (!response.ok) throw new Error("still " + response.status); return response.arrayBuffer(); },
  wait: (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(ms, pollMs))),
  onProgress: (message: string) => { if (message !== lastProgress) console.error(new Date().toISOString(), message); lastProgress = message; } });

// A resume starts from the earlier record whole, so every step it took stays in the record.
const report: Record<string, unknown> = earlier ? { ...earlier } : { schema: "hv-studio-run/1", base, format, tone, startedAt: new Date(started).toISOString(),
  script: { format: finalDraft ? "final-draft" : "fountain", sha256: sha256(scriptFile), ...(imported ? { importNotes: imported.notes.map(note => note.code) } : {}) } };

/** One sequence of a feature, as the report lists it. */
type Made = { number: number; roughCut: string; film: string | null; spend: unknown; finished: ReturnType<typeof finished> };
// HV-030-33: what each sequence's finishing did, and the notes of what it couldn't, as the studio kept them.
function finished(n: number) {
  const f = flow.state.finishes?.[n] ?? {};
  return { voiced: f.voiced === true, scored: Boolean(f.scored), ambience: f.ambience === true, notes: Array.isArray(f.notes) ? f.notes : [] };
}
/** The feature's sequences in the report, and the run stopped when they weren't joined. */
function reportFeature(made: Made[]) {
  // A sequence the Composer didn't score is named here and on stderr, not left for the joined film to hide.
  const unscored = made.filter(sequence => !sequence.finished.scored).map(sequence => sequence.number);
  report.feature = { sequences: made, joined: flow.state.joined === true, titled: flow.state.joinedTitled === true, unscored };
  if (unscored.length) process.stderr.write(`studio-run: ${unscored.length} of ${made.length} sequence(s) were not scored: ${unscored.join(", ")}\n`);
  if (!flow.state.joined) throw new Error("The sequences were not joined into one film: " + (flow.state.finishNotes ?? []).filter((note: string) => note.startsWith("Editor:")).join(" "));
}
/** Share the final with a reviewer; the link goes to its own file, and the report names it by its id. */
async function shareFinal() {
  const shared = await flow.share(Number(shareViews)); mark("shared");
  writePrivate(reviewOut, shared.reviewUrl + "\n");
  const owner = await api(`/api/projects/${project!.projectId}/reviews`, { headers: { authorization: `Bearer ${project!.token}` } });
  report.review = sharedLink(owner.links, flow.state.final.id);
}
/** The desk steps before the look (HV-030-31). */
async function deskSteps() {
  const desk = await deskBeforeLook({ projectId: project!.projectId, state: flow.state, locks: lockNames, continuity: repairBeforeLook,
    call: (path, init = {}) => api(path, { method: init.method ?? "GET", headers: { authorization: `Bearer ${project!.token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) }) });
  report.deskBeforeLook = desk;
  // The look approval's own permission step was taken above, so the studio doesn't send it again with the cast version it read before the locks.
  if (desk.castApproved) flow.state.pendingCast = [];
  mark("deskBeforeLook");
}

/**
 * HV-030-39: what the resume's finishing steps did, from the studio's `finishLog`: each step kept, waited on, made,
 * or retried under a fresh key with the job it replaces and why that job ended. A sequence any of whose steps was
 * redone says so, with the notes the earlier run kept for it (its voices given up on, its score that failed).
 */
let resumeEntry: { entry: Record<string, unknown>; before: Earlier } | undefined;
function recordFinishing() {
  if (!resumeEntry) return;
  const { entry, before } = resumeEntry, log = (flow.finishLog ?? []) as { sequence: number | null; how: string }[];
  entry.finishing = log;
  const redone = [...new Set(log.filter(step => step.how === "retried" && step.sequence !== null).map(step => step.sequence as number))];
  for (const sequence of (entry.steps as { sequences?: Record<string, unknown>[] }).sequences ?? [])
    sequence.finishing = log.some(step => step.sequence === sequence.number && step.how === "retried") ? "redone" : "kept";
  const earlierNotes = (n: number): string[] => before.interrupted?.finishes?.[n]?.notes ?? before.feature?.sequences?.find((value: { number: number }) => value.number === n)?.finished?.notes ?? [];
  entry.why = Object.fromEntries(redone.map(n => [n, earlierNotes(n).filter((note: string) => /^(Casting|Composer):/.test(note))]));
}

/**
 * HV-030-37: the resume. The record keeps every step of the earlier run; what the resume replaces (the feature,
 * the final, the review, the outcome) is kept under `resumes[].replaced`, and each sequence says whether its rough
 * cut and final were kept, made now, retried under a fresh key (with how many shots were reused) or waited on.
 */
async function resume(before: Earlier) {
  const steps: Record<string, unknown> = { pitch: "kept", readThrough: "kept", plan: "kept", deskBeforeLook: before.deskBeforeLook ? "kept" : "none" };
  const replaced = Object.fromEntries(["outcome", "error", "finishedAt", "feature", "final", "review", "finishNotes", "interrupted"].filter(key => key in before).map(key => [key, before[key]]));
  for (const key of Object.keys(replaced)) delete report[key];
  const entry = { startedAt: new Date(started).toISOString(), replaced, steps, secondsAt: marks };
  report.resumes = [...(Array.isArray(before.resumes) ? before.resumes : []), entry];
  resumeEntry = { entry, before };
  report.secondsAt = before.secondsAt ?? {};
  // The crew's words aren't kept by the studio (HV-016-09): the tone and the plan's facts come from the record. The
  // plan's notes aren't recorded; the Continuity Supervisor's always included one from its report when it compared anything.
  const compared = Number(before.plan?.continuityComparisons ?? 0);
  await flow.resumeFeature({ tone: typeof before.tone === "string" ? before.tone : tone, plan: { finalAnchors: before.roughCut?.stillsPinned === true, continuityComparisons: compared,
    notes: compared > 0 ? [{ persona: "continuity", source: "continuity-report", change: "Compared before the run stopped, as its record says." }] : [] } });
  mark("resumed");
  const total = (flow.state.sequences as unknown[]).length;
  const made: Made[] = (flow.state.resumedSequences as { number: number; roughCut: string; film: string | null; spend: unknown }[])
    .map(sequence => ({ number: sequence.number, roughCut: sequence.roughCut, film: sequence.film, spend: sequence.spend, finished: finished(sequence.number) }));
  const sequences: Record<string, unknown>[] = made.map(sequence => ({ number: sequence.number, roughCut: "kept", final: "kept" }));
  steps.sequences = sequences;
  const final = async (roughCutMade: boolean) => {
    const n = flow.state.sequence as number, roughCut = flow.state.animatic.id as string;
    const approved = await flow.approveRoughCut(); mark("final-" + n);
    made.push({ number: n, roughCut, film: flow.state.finals?.[n]?.id ?? null, spend: approved.spend, finished: finished(n) });
    const asked = flow.state.resumedFinal?.number === n ? flow.state.resumedFinal : null;
    if (!asked || asked.how === "made") { sequences.push({ number: n, roughCut: roughCutMade ? "made" : "kept", final: "made" }); return; }
    // The final as the studio holds it: each shot it reused names the render it came from.
    const job = await api(`/api/jobs/${asked.jobId}`, { headers: { authorization: `Bearer ${project!.token}` } });
    const shots = (job.shotRenders ?? []) as { reusedFrom: unknown }[];
    sequences.push({ number: n, roughCut: roughCutMade ? "made" : "kept", final: asked.how, finalJobId: asked.jobId, retryOf: asked.retryOf,
      reusedShots: shots.filter(shot => shot.reusedFrom).length, renderedShots: shots.filter(shot => !shot.reusedFrom).length });
  };
  if (flow.state.step === "look") {
    // The run stopped before sequence 1's rough cut: the desk steps it asks for, if the earlier run didn't finish them, then the look.
    if (!before.deskBeforeLook && (lockNames.length || repairBeforeLook)) { await deskSteps(); steps.deskBeforeLook = "made"; }
    const rough = await flow.approveLook(true); mark("roughCut");
    report.roughCut = { jobId: rough.animatic.id, status: rough.animatic.status, spend: rough.spend, stillsPinned: Boolean(flow.state.plan?.finalAnchors) };
    steps.look = "made";
    await final(true);
  } else {
    steps.look = "kept";
    if (flow.state.step === "rough-cut") await final(false);
  }
  while (flow.state.sequence < total) { await flow.nextSequence(); mark("roughCut-" + flow.state.sequence); await final(true); }
  reportFeature(made);
  report.final = { jobId: flow.state.final.id, status: flow.state.final.status, spend: flow.state.spend };
  // A link already shared for this same film is kept; a new one is made only for a film not shared yet.
  if (before.review?.jobId === flow.state.final.id) { report.review = before.review; steps.share = "kept"; }
  else if (shareViews) { await shareFinal(); steps.share = "made"; }
  else steps.share = "none";
}

/** The record, written once at the end, or when the run is stopped by a signal. */
function writeRecord() {
  recordFinishing();
  // A resumed record keeps the earlier run's times; the resume's own are in its `resumes` entry.
  if (!earlier) report.secondsAt = marks;
  report.finishedAt = new Date().toISOString();
  if (resumeEntry) Object.assign(resumeEntry.entry, { outcome: report.outcome, finishedAt: report.finishedAt });
  const text = JSON.stringify(report, null, 2) + "\n";
  if (out) writeFileSync(out, text, { mode: 0o600 }); else process.stdout.write(text);
}
// HV-030-39: an operator who stops the run (to cancel a hung job and deploy) still gets its record, with where it
// was and what each sequence's finishing had done, so `--resume` and the operator can see what was given up on.
for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => {
  report.projectId = project?.projectId; report.outcome = "stopped"; report.error = `stopped by ${signal}`;
  report.interrupted = { at: new Date().toISOString(), step: flow.state.step ?? null, sequence: flow.state.sequence ?? null,
    finishes: flow.state.finishes ?? {}, finishNotes: flow.state.finishNotes ?? [] };
  writeRecord();
  process.exit(1);
});

try {
  if (earlier) await resume(earlier);
  else {
    const pitched = await flow.pitch({ script, format, tone, rightsAttested: true, ...(attached ? { styleCard: attached.card } : {}) }); mark("readThrough");
    const facts = pitched.readThrough.facts;
    report.readThrough = { source: pitched.readThrough.source, questions: pitched.readThrough.questions.length, concerns: facts.concerns.map((c: { kind: string }) => c.kind),
      // HV-030-31: what the read-through quoted: the format, its scenes, shots and runtime against the format's limit, and the cost.
      facts: { format: facts.format ?? null, scenes: facts.scenes ?? null, shots: facts.shots ?? null, estimatedRuntimeSec: facts.estimatedRuntimeSec ?? null,
        formatLimitSec: facts.formatLimitSec ?? null, estimate: facts.estimate ?? null },
      crewSpendUsd: pitched.readThrough.crewSpend?.usd ?? 0, readStyleCard: pitched.readThrough.readStyleCard === true,
      ...(pitched.readThrough.fallbackReason ? { fallbackReason: pitched.readThrough.fallbackReason } : {}) };
    // The card is named by its digest; its words are the creator's and stay in their file.
    if (attached) report.styleCard = { attached: { sha256: attached.sha256 } };
    if (pitched.step !== "questions") throw new Error("The crew stopped at the pitch: " + JSON.stringify(pitched.blocked));
    const planned = await flow.plan(pitched.readThrough.questions.map((q: { id: string }) => ({ id: q.id, accepted: true }))); mark("plan");
    report.plan = { source: planned.plan.source, addedCharacters: planned.plan.addedCharacters, directedShots: planned.plan.directedShots,
      cast: planned.casting.characters.map((c: { name: string; kind: string }) => ({ name: c.name, kind: c.kind })), spend: planned.spend,
      voices: planned.plan.voices ?? [], continuityComparisons: planned.plan.continuityComparisons ?? 0, crewSpendUsd: planned.plan.crewSpend?.usd ?? 0,
      ...(planned.plan.fallbackReason ? { fallbackReason: planned.plan.fallbackReason } : {}),
      // HV-030-31: a feature's split and style bible, by their revisions; a reel or a short has neither.
      ...(planned.plan.sequences ? { sequences: { source: planned.plan.sequences.source, revision: planned.plan.sequences.revision, ...(planned.plan.sequences.fallbackReason ? { fallbackReason: planned.plan.sequences.fallbackReason } : {}),
        sequences: planned.plan.sequences.sequences.map((s: { number: number; firstScene: number; lastScene: number; shots: number; bibleRevision?: string }) =>
          ({ number: s.number, firstScene: s.firstScene, lastScene: s.lastScene, shots: s.shots, bibleRevision: s.bibleRevision ?? null })) } } : {}),
      ...(planned.plan.styleBible ? { styleBible: { kept: planned.plan.styleBible.kept, source: planned.plan.styleBible.source, revision: planned.plan.styleBible.bible?.revision ?? null,
        version: planned.plan.styleBible.bible?.version ?? null, dropped: planned.plan.styleBible.dropped?.length ?? 0 } } : {}) };
    // Kept the moment the crew has planned, as the creator's "Keep my style card" would: a later stop costs the film, not the card.
    if (keepCard) {
      let kept: { sha256: string } | { error: string };
      try { kept = keepStyleCardFile(keepCard, flow.styleCardFile()); } catch (error) { kept = { error: error instanceof Error ? error.message : String(error) }; }
      report.styleCard = { ...(report.styleCard as object | undefined), kept };
    }
    // HV-030-31: the desk steps a feature takes before its look is approved; the first sequence renders the moment it is.
    if (lockNames.length || repairBeforeLook) await deskSteps();
    if (stopAfter !== "look") {
      const rough = await flow.approveLook(true); mark("roughCut");
      report.roughCut = { jobId: rough.animatic.id, status: rough.animatic.status, spend: rough.spend, stillsPinned: Boolean(planned.plan.finalAnchors) };
      if (stopAfter === "final") {
        let final = await flow.approveRoughCut(); mark("final");
        // HV-030-31: a feature's sequences, one after another: each next rough cut, then its final. After
        // the last, the studio joins them; `final` is then the joined feature, the one film shared.
        const sequences = flow.state.sequences as { length: number } | undefined;
        if (sequences) {
          const made: Made[] = [{ number: 1, roughCut: rough.animatic.id, film: flow.state.finals?.[1]?.id ?? null, spend: final.spend, finished: finished(1) }];
          while (flow.state.sequence < sequences.length) {
            const next = await flow.nextSequence(); mark("roughCut-" + flow.state.sequence);
            final = await flow.approveRoughCut(); mark("final-" + flow.state.sequence);
            made.push({ number: flow.state.sequence, roughCut: next.animatic.id, film: flow.state.finals?.[flow.state.sequence]?.id ?? null, spend: final.spend, finished: finished(flow.state.sequence) });
          }
          reportFeature(made);
        }
        report.final = { jobId: final.final.id, status: final.final.status, spend: final.spend };
        if (shareViews) await shareFinal();
      }
    }
  }
  report.projectId = project?.projectId; report.outcome = "completed"; report.finishNotes = flow.state.finishNotes ?? [];
} catch (error) {
  report.projectId = project?.projectId; report.outcome = "stopped"; report.error = error instanceof Error ? error.message : String(error);
}
writeRecord();
if (report.outcome !== "completed") process.exit(1);
