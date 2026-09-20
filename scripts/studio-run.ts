/**
 * Runs one film through the studio's front door, exactly as the page does (createStudioFlow),
 * against a running private studio. Every crew proposal is accepted, the creator attests the
 * crew's original cast, and the rough cut is approved. Used for the live proofs (HV-019-05) and
 * the Release 1 run. It prints a JSON report: ids, timings and the film's spend at each approval.
 * It never reads or prints a provider key.
 *
 *   bun scripts/studio-run.ts --base http://127.0.0.1:8081 --script film.fountain --format reel --tone "warm" --out report.json
 */
import { readFileSync, writeFileSync } from "node:fs";
// @ts-expect-error -- the studio is a plain browser module with no type declarations.
import { createStudioFlow } from "../packages/frontend/src/studio.js";

const option = (name: string, fallback?: string) => {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : fallback;
  if (value === undefined) throw new Error("missing " + name);
  return value;
};
const base = option("--base").replace(/\/$/, "");
const script = readFileSync(option("--script"), "utf8");
const format = option("--format", "reel"), tone = option("--tone", "warm and hopeful"), out = option("--out", "");
const stopAfter = option("--stop-after", "final");
if (!["look", "rough-cut", "final"].includes(stopAfter)) throw new Error("--stop-after must be look, rough-cut or final");

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
const flow = createStudioFlow({ api, getProject: () => project, setProject: (value: typeof project) => { project = value; },
  fetchImage: async (url: string) => { const response = await fetch(base + url); if (!response.ok) throw new Error("still " + response.status); return response.arrayBuffer(); },
  wait: (ms: number) => new Promise(resolve => setTimeout(resolve, Math.max(ms, 3000))),
  onProgress: (message: string) => { if (message !== lastProgress) console.error(new Date().toISOString(), message); lastProgress = message; } });

const report: Record<string, unknown> = { schema: "hv-studio-run/1", base, format, tone, startedAt: new Date(started).toISOString() };
try {
  const pitched = await flow.pitch({ script, format, tone, rightsAttested: true }); mark("readThrough");
  report.readThrough = { source: pitched.readThrough.source, questions: pitched.readThrough.questions.length, concerns: pitched.readThrough.facts.concerns.map((c: { kind: string }) => c.kind),
    crewSpendUsd: pitched.readThrough.crewSpend?.usd ?? 0 };
  if (pitched.step !== "questions") throw new Error("The crew stopped at the pitch: " + JSON.stringify(pitched.blocked));
  const planned = await flow.plan(pitched.readThrough.questions.map((q: { id: string }) => ({ id: q.id, accepted: true }))); mark("plan");
  report.plan = { source: planned.plan.source, addedCharacters: planned.plan.addedCharacters, directedShots: planned.plan.directedShots,
    cast: planned.casting.characters.map((c: { name: string; kind: string }) => ({ name: c.name, kind: c.kind })), spend: planned.spend };
  if (stopAfter !== "look") {
    const rough = await flow.approveLook(true); mark("roughCut");
    report.roughCut = { jobId: rough.animatic.id, status: rough.animatic.status, spend: rough.spend, stillsPinned: Boolean(planned.plan.finalAnchors) };
    if (stopAfter === "final") {
      const final = await flow.approveRoughCut(); mark("final");
      report.final = { jobId: final.final.id, status: final.final.status, spend: final.spend };
    }
  }
  report.projectId = project?.projectId; report.outcome = "completed";
} catch (error) {
  report.projectId = project?.projectId; report.outcome = "stopped"; report.error = error instanceof Error ? error.message : String(error);
}
const tokenOut = option("--token-out", "");
if (tokenOut && project) writeFileSync(tokenOut, JSON.stringify(project) + "\n", { mode: 0o600 });
report.secondsAt = marks; report.finishedAt = new Date().toISOString();
const text = JSON.stringify(report, null, 2) + "\n";
if (out) writeFileSync(out, text, { mode: 0o600 }); else process.stdout.write(text);
if (report.outcome !== "completed") process.exit(1);
