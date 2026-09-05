import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const args = process.argv.slice(2);
if (args.includes("--help")) { process.stdout.write("bun scripts/staging-screenplay.ts --base <private-edge-url> --script <fountain-file> --output <private-evidence-directory>\n"); process.exit(0); }
function option(name: string) { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; }
const base = option("--base"), script = option("--script"), output = option("--output");
if (!base || !script || !output) throw new Error("--base, --script and --output are required");
const root = resolve(output); mkdirSync(root, { recursive: true, mode: 0o700 });
let responses = 0;
async function call(path: string, init?: RequestInit) {
  const response = await fetch(new URL(path, base), init);
  responses++;
  if (response.headers.has("set-cookie")) throw new Error("cookie-free access violated");
  if (!response.ok) throw new Error(`${path}: ${response.status} ${await response.text()}`);
  return response;
}
const created = await (await call("/api/projects", { method: "POST" })).json() as { projectId: string; token: string; projectUrl: string };
const headers = { authorization: "Bearer " + created.token, "content-type": "application/json" };
const project = "/api/projects/" + created.projectId;
writeFileSync(root + "/project-url.txt", created.projectUrl + "\n"); chmodSync(root + "/project-url.txt", 0o600);
await call(project + "/script", { method: "PUT", headers, body: JSON.stringify({ text: readFileSync(script, "utf8") }) });
await call(project + "/rights", { method: "POST", headers, body: JSON.stringify({ attested: true }) });
const queued = await (await call(project + "/jobs", { method: "POST", headers, body: JSON.stringify({ idempotencyKey: "managed-staging-evaluation" }) })).json() as { jobId: string };
writeFileSync(root + "/job-id.txt", queued.jobId + "\n");
const started = Date.now();
let previous = "";
interface State { id: string; status: string; checkpointShots: number; costUsd: number; failureReason?: string; cancelReason?: string;
  storyboard: { url: string }[]; output?: { mp4Url: string; hlsUrl: string; captionsUrl: string } }
while (Date.now() - started < 1800000) {
  const job = await (await call("/api/jobs/" + queued.jobId, { headers })).json() as State;
  const progress = job.status + ":" + job.checkpointShots;
  if (progress !== previous) { process.stdout.write(JSON.stringify({ status: job.status, shots: job.checkpointShots, costUsd: job.costUsd }) + "\n"); previous = progress; }
  if (job.status === "failed" || job.status === "cancelled") throw new Error(job.failureReason ?? job.cancelReason ?? job.status);
  if (job.status === "done") {
    if (!job.output) throw new Error("finished job has no output");
    for (const frame of job.storyboard) {
      const image = await call(frame.url);
      if (image.headers.get("content-type") !== "image/png" || (await image.arrayBuffer()).byteLength < 100) throw new Error("invalid storyboard image");
    }
    const playlist = await (await call(job.output.hlsUrl)).text();
    const segment = playlist.split("\n").find(line => line && !line.startsWith("#"));
    if (!segment) throw new Error("playlist has no media");
    await call(job.output.hlsUrl.slice(0, job.output.hlsUrl.lastIndexOf("/") + 1) + segment);
    const report = { at: new Date().toISOString(), projectId: created.projectId, jobId: queued.jobId, status: job.status,
      shots: job.checkpointShots, storyboardFrames: job.storyboard.length, costUsd: job.costUsd,
      seconds: (Date.now() - started) / 1000, responses, cookies: 0 };
    writeFileSync(root + "/report.json", JSON.stringify(report, null, 2) + "\n");
    process.stdout.write(JSON.stringify(report) + "\n");
    process.exit(0);
  }
  await Bun.sleep(2000);
}
throw new Error("managed staging evaluation exceeded 30 minutes; inspect the saved job id");
