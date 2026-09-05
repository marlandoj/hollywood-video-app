import { mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { createApiServer } from "../packages/api/src/server";
import { CostLedger, OperatorReviewQueue } from "../packages/operator/src/index";
import { DurableJobStore } from "../packages/queue/src/index";
import { processNextJob } from "../packages/queue/src/worker";
import { parseFountain } from "../packages/parser/src/index";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("bun scripts/evaluate-rich-animatic.ts --script <fountain> --output <private-evidence-directory> [--provider mock|image:fal] [--serve-port 8094]");
  process.exit(0);
}
function option(name: string, fallback?: string) { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; }
const scriptPath = option("--script"), output = option("--output");
if (!scriptPath || !output) throw new Error("--script and --output required");
const root = resolve(output);
mkdirSync(root, { recursive: true, mode: 0o700 });
process.env.HV_TOKEN_SECRET = crypto.randomUUID() + crypto.randomUUID();
process.env.HV_ANIMATIC_PROVIDER = option("--provider", "mock")!;
process.env.HV_ANIMATIC_COST_CAP_USD = "5";
process.env.HV_MONTHLY_BUDGET_USD = "150";
process.env.HV_NARRATION = "1";
process.env.HV_ANIMATIC_CAPTIONS = "0"; // Player's switchable, sequential WebVTT captions.
const paths = { queuePath: root + "/jobs.json", artifactRoot: root + "/artifacts", statePath: root + "/projects.json", costLedgerPath: root + "/cost-ledger.json" };
const api = createApiServer({ port: 0, hostname: "127.0.0.1", tls: null, ...paths });
const base = `http://127.0.0.1:${api.port}`;
const ledger = new CostLedger(paths.costLedgerPath), jobs = new DurableJobStore(paths.queuePath);
let responseCount = 0;
async function call(path: string, init?: RequestInit) {
  const response = await fetch(base + path, init);
  responseCount++;
  if (response.headers.has("set-cookie")) throw new Error("cookie-free access violated");
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response;
}
let serving = false;
try {
  const created = await (await call("/api/projects", { method: "POST" })).json() as { projectId: string; token: string };
  const headers = { authorization: `Bearer ${created.token}`, "content-type": "application/json" };
  const project = "/api/projects/" + created.projectId;
  const text = readFileSync(scriptPath, "utf8");
  await call(project + "/script", { method: "PUT", headers, body: JSON.stringify({ text }) });
  await call(project + "/rights", { method: "POST", headers, body: JSON.stringify({ attested: true }) });
  const admitted = await (await call(project + "/jobs", { method: "POST", headers, body: JSON.stringify({ idempotencyKey: "full-screenplay-evaluation" }) })).json() as { jobId: string };
  const started = Date.now();
  console.log(JSON.stringify({ event: "render-started", provider: process.env.HV_ANIMATIC_PROVIDER, scenes: parseFountain(text).scenes.length }));
  const result = await processNextJob(jobs, paths.artifactRoot, { ledger, reviewQueue: new OperatorReviewQueue(root + "/reviews.json"), providerTimeoutMs: 180000 });
  if (result?.status !== "done") throw new Error(`evaluation failed: ${result?.failureReason ?? result?.cancelReason ?? result?.status}`);
  const state = await (await call("/api/jobs/" + admitted.jobId, { headers })).json() as { storyboard: { url: string }[]; output: { mp4Url: string; hlsUrl: string; captionsUrl: string } };
  for (const frame of state.storyboard) {
    const image = await call(frame.url);
    if (image.headers.get("content-type") !== "image/png" || (await image.arrayBuffer()).byteLength < 100) throw new Error("invalid storyboard image");
  }
  const playlist = await (await call(state.output.hlsUrl)).text();
  const segment = playlist.split("\n").find(line => line && !line.startsWith("#"));
  if (!segment) throw new Error("HLS has no media segments");
  await call(state.output.hlsUrl.slice(0, state.output.hlsUrl.lastIndexOf("/") + 1) + segment);
  const mp4 = paths.artifactRoot + "/" + result.output!.mp4Path;
  const probe = Bun.spawnSync(["ffprobe", "-v", "error", "-show_streams", "-show_format", "-of", "json", mp4]);
  if (probe.exitCode) throw new Error("ffprobe failed");
  const media = JSON.parse(probe.stdout.toString());
  const clips = JSON.parse(readFileSync(mp4.replace("/export.mp4", "/clips/manifest.json"), "utf8"));
  const report = { at: new Date().toISOString(), provider: process.env.HV_ANIMATIC_PROVIDER, jobId: result.id, projectId: result.projectId,
    screenplayScenes: parseFountain(text).scenes.length, storyboardFrames: state.storyboard.length, clips: clips.length,
    durationSec: Number(media.format.duration), renderSeconds: (Date.now() - started) / 1000,
    codecs: media.streams.map((s: { codec_name: string }) => s.codec_name), narratedClips: clips.filter((c: { audioMode: string }) => c.audioMode === "provided").length,
    costUsd: ledger.monthSpend(), reservationRemainingUsd: ledger.reservedUsd(), costEvents: ledger.all().length, responseCount, cookies: 0,
    exportPath: mp4, limitations: ["Temporary synthetic table-read voice, not final performance", "Motion over still images, not generated live action", "No character identity conditioning in this provider"] };
  writeFileSync(root + "/report.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  const port = option("--serve-port");
  if (port) {
    const frontend = readFileSync(new URL("../packages/frontend/src/index.html", import.meta.url), "utf8");
    const server = Bun.serve({ port: Number(port), hostname: "127.0.0.1", async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname === "/") return new Response(frontend, { headers: { "content-type": "text/html; charset=utf-8" } });
      if (url.pathname === "/vendor/hls.min.js") return new Response(Bun.file(new URL("../node_modules/hls.js/dist/hls.min.js", import.meta.url)));
      return fetch(base + url.pathname + url.search, { method: request.method, headers: request.headers, body: request.body, redirect: "manual" });
    } });
    writeFileSync(root + "/preview-url.txt", `http://127.0.0.1:${server.port}/#/p/${created.token}\n`);
    chmodSync(root + "/preview-url.txt", 0o600);
    serving = true;
    console.log("Private browser preview ready; capability URL saved in the evaluation directory.");
  }
} finally { if (!serving) api.stop(true); }
