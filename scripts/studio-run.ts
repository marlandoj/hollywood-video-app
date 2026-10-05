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
 */
import { readFileSync, writeFileSync } from "node:fs";
import { importFinalDraft } from "../packages/parser/src/final-draft";
// @ts-expect-error -- the studio is a plain browser module with no type declarations.
import { createStudioFlow } from "../packages/frontend/src/studio.js";
import { deskBeforeLook } from "./release-3-desk";
import { besideReport, keepStyleCardFile, readStyleCardFile, sha256, sharedLink, writePrivate } from "./release-run-files";

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
const started = Date.now(), marks: Record<string, number> = {};
const mark = (name: string) => { marks[name] = Math.round((Date.now() - started) / 1000); };
let lastProgress = "";
// The project token is the only key to the film (no accounts), so it is saved the moment the
// project exists: a share link is made from it after the run. Beside --out unless --token-out names a file.
const tokenOut = besideReport(out, ".token", option("--token-out", ""));
const reviewOut = besideReport(out, ".review", option("--review-out", ""));
if (shareViews && !reviewOut) throw new Error("--share needs --out or --review-out: the review link is written to a file, never printed");
const flow = createStudioFlow({ api, getProject: () => project, setProject: (value: typeof project) => {
  project = value;
  if (tokenOut && value) writePrivate(tokenOut, JSON.stringify(value) + "\n");
},
  fetchImage: async (url: string) => { const response = await fetch(base + url); if (!response.ok) throw new Error("still " + response.status); return response.arrayBuffer(); },
  wait: (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(ms, 3000))),
  onProgress: (message: string) => { if (message !== lastProgress) console.error(new Date().toISOString(), message); lastProgress = message; } });

const report: Record<string, unknown> = { schema: "hv-studio-run/1", base, format, tone, startedAt: new Date(started).toISOString(),
  script: { format: finalDraft ? "final-draft" : "fountain", sha256: sha256(scriptFile), ...(imported ? { importNotes: imported.notes.map(note => note.code) } : {}) } };
try {
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
  if (lockNames.length || repairBeforeLook) {
    const desk = await deskBeforeLook({ projectId: project!.projectId, state: flow.state, locks: lockNames, continuity: repairBeforeLook,
      call: (path, init = {}) => api(path, { method: init.method ?? "GET", headers: { authorization: `Bearer ${project!.token}`, ...(init.body === undefined ? {} : { "content-type": "application/json" }) },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) }) });
    report.deskBeforeLook = desk;
    // The look approval's own permission step was taken above, so the studio doesn't send it again with the cast version it read before the locks.
    if (desk.castApproved) flow.state.pendingCast = [];
    mark("deskBeforeLook");
  }
  if (stopAfter !== "look") {
    const rough = await flow.approveLook(true); mark("roughCut");
    report.roughCut = { jobId: rough.animatic.id, status: rough.animatic.status, spend: rough.spend, stillsPinned: Boolean(planned.plan.finalAnchors) };
    if (stopAfter === "final") {
      let final = await flow.approveRoughCut(); mark("final");
      // HV-030-31: a feature's sequences, one after another: each next rough cut, then its final. After
      // the last, the studio joins them; `final` is then the joined feature, the one film shared.
      const sequences = flow.state.sequences as { length: number } | undefined;
      if (sequences) {
        // HV-030-33: what each sequence's finishing did, and the notes of what it couldn't, as the studio kept them.
        const finished = (n: number) => { const f = flow.state.finishes?.[n] ?? {};
          return { voiced: f.voiced === true, scored: Boolean(f.scored), ambience: f.ambience === true, notes: Array.isArray(f.notes) ? f.notes : [] }; };
        const made = [{ number: 1, roughCut: rough.animatic.id, film: flow.state.finals?.[1]?.id ?? null, spend: final.spend, finished: finished(1) }];
        while (flow.state.sequence < sequences.length) {
          const next = await flow.nextSequence(); mark("roughCut-" + flow.state.sequence);
          final = await flow.approveRoughCut(); mark("final-" + flow.state.sequence);
          made.push({ number: flow.state.sequence, roughCut: next.animatic.id, film: flow.state.finals?.[flow.state.sequence]?.id ?? null, spend: final.spend, finished: finished(flow.state.sequence) });
        }
        // A sequence the Composer didn't score is named here and on stderr, not left for the joined film to hide.
        const unscored = made.filter(sequence => !sequence.finished.scored).map(sequence => sequence.number);
        report.feature = { sequences: made, joined: flow.state.joined === true, titled: flow.state.joinedTitled === true, unscored };
        if (unscored.length) process.stderr.write(`studio-run: ${unscored.length} of ${made.length} sequence(s) were not scored: ${unscored.join(", ")}\n`);
        if (!flow.state.joined) throw new Error("The sequences were not joined into one film: " + (flow.state.finishNotes ?? []).filter((note: string) => note.startsWith("Editor:")).join(" "));
      }
      report.final = { jobId: final.final.id, status: final.final.status, spend: final.spend };
      if (shareViews) {
        const shared = await flow.share(Number(shareViews)); mark("shared");
        writePrivate(reviewOut, shared.reviewUrl + "\n");
        const owner = await api(`/api/projects/${project!.projectId}/reviews`, { headers: { authorization: `Bearer ${project!.token}` } });
        report.review = sharedLink(owner.links, flow.state.final.id);
      }
    }
  }
  report.projectId = project?.projectId; report.outcome = "completed"; report.finishNotes = flow.state.finishNotes ?? [];
} catch (error) {
  report.projectId = project?.projectId; report.outcome = "stopped"; report.error = error instanceof Error ? error.message : String(error);
}
report.secondsAt = marks; report.finishedAt = new Date().toISOString();
const text = JSON.stringify(report, null, 2) + "\n";
if (out) writeFileSync(out, text, { mode: 0o600 }); else process.stdout.write(text);
if (report.outcome !== "completed") process.exit(1);
