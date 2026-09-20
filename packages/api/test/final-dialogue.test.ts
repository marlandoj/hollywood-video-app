import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/server";
import { ProjectService } from "../src/index";
import { DurableJobStore } from "../../queue/src/index";
import { processNextJob } from "../../queue/src/worker";
import { CostLedger, OperatorReviewQueue } from "../../operator/src/index";
import { ReferenceBlobStore } from "../../storage/src/references";
import { referenceFal } from "../../../test/fixtures/reference-fal";
// @ts-expect-error -- the studio is a plain browser module with no type declarations.
import { createStudioFlow } from "../../frontend/src/studio.js";
import { roughCutDialogue } from "../../queue/src/final-dialogue";
import type { Shot } from "../../planner/src/index";

// HV-022-01: the live finals were silent -- Kling renders picture only -- although the creator
// approved a rough cut that speaks. A silent final shot now keeps the approved rough cut's
// verified dialogue; a shot without lines stays silent.
const SCRIPT = "INT. KITCHEN - DAY\n\nMAYA, an old woman, pours tea.\n\nMAYA\nYou came back.\n\nEXT. GARDEN - DAY\n\nMAYA walks to the gate.";
const root = mkdtempSync(join(tmpdir(), "hv-final-dialogue-"));
const config = { HV_TOKEN_SECRET: "studio-anchor-fixture-secret-at-least-thirty-two-characters", HV_ANIMATIC_PROVIDER_POOL: '["mock"]',
  HV_PROVIDER_POOL: '["mock","fal:kling-o3-standard-keyframes"]', HV_NARRATION: "1", HV_ANIMATIC_CAPTIONS: "0", FAL_KEY: "studio-anchor-fixture-only" };
const original = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
let server: ReturnType<typeof createApiServer> | undefined;
const realFetch = globalThis.fetch;
afterAll(async () => {
  globalThis.fetch = realFetch; await server?.stop(true); rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
const run = (args: string[]) => { const result = Bun.spawnSync(args); if (result.exitCode) throw new Error(result.stderr.toString()); return result.stdout; };

test("the final speaks with the rough cut's approved dialogue, and silent shots stay silent", async () => {
  Object.assign(process.env, config);
  const paths = { queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json"), artifactRoot: join(root, "artifacts"), costLedgerPath: join(root, "ledger.json") };
  server = createApiServer({ port: 0, hostname: "127.0.0.1", ...paths, rateLimit: { api: { limit: 10000, windowMs: 60000 } } });
  const clip = join(root, "clip.mp4");
  run(["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", "color=red:s=320x180:r=30:d=5", "-c:v", "libx264", "-pix_fmt", "yuv420p", clip]);
  const still = run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=red:s=320x180", "-frames:v", "1", "-f", "image2pipe", "-vcodec", "png", "-"]);
  const fal = referenceFal(still, readFileSync(clip), server.url.origin, realFetch);
  globalThis.fetch = fal.fetchImpl;
  const projects = new ProjectService(paths.statePath), store = new DurableJobStore(paths.queuePath), ledger = new CostLedger(paths.costLedgerPath);
  const references = new ReferenceBlobStore(paths.artifactRoot);
  const worker = () => processNextJob(store, paths.artifactRoot, { projects, ledger, references, reviewQueue: new OperatorReviewQueue(join(root, "reviews.json")) });
  const base = server.url.origin;
  const api = async (path: string, init: RequestInit = {}) => {
    const response = await fetch(base + path, init), body = await response.json();
    if (!response.ok) throw new Error(path + " " + response.status + " " + body.error);
    return body;
  };
  let project: { projectId: string; token: string } | undefined;
  const flow = createStudioFlow({ api, getProject: () => project, setProject: (value: typeof project) => { project = value; },
    wait: async () => { await worker(); }, fetchImage: async (url: string) => (await fetch(base + url)).arrayBuffer() });

  await flow.pitch({ script: SCRIPT, format: "reel", tone: "quiet", rightsAttested: true });
  await flow.plan([]);
  const rough = await flow.approveLook(true);
  const final = await flow.approveRoughCut();
  expect(fal.submissions).toHaveLength(2);
  const animatic = (await store.get(rough.animatic.id))!, film = (await store.get(final.final.id))!;
  const spoken = (job: typeof film) => job.output!.shotRenders!.find(record => record.shotId === "shot-1-1")!;
  const silent = (job: typeof film) => job.output!.shotRenders!.find(record => record.shotId === "shot-2-1")!;
  // The spoken shot carries the approved voice, byte for byte, under the Kling picture.
  expect(spoken(film).clip.audioMode).toBe("provided");
  expect(spoken(film).clip.speech).toEqual(spoken(animatic).clip.speech!);
  expect(spoken(film).files.audio!.sha256).toBe(spoken(animatic).files.audio!.sha256);
  expect(spoken(film).clip.provider).toBe("fal");
  // The shot without lines gets a silent track and says so.
  expect(silent(film).clip.speech).toBeUndefined();
  expect(silent(film).files.audio).toBeUndefined();
  expect(silent(film).clip.audioMode).toBe("silent-captioned");
  // The exported film has a sound track with the voice in it.
  const exported = join(paths.artifactRoot, film.output!.mp4Path);
  const probe = run(["ffprobe", "-v", "error", "-select_streams", "a", "-show_entries", "stream=codec_name", "-of", "csv=p=0", exported]).toString().trim();
  expect(probe).toBe("aac");
  const loudness = Bun.spawnSync(["ffmpeg", "-v", "info", "-i", exported, "-t", "3", "-af", "volumedetect", "-f", "null", "-"]).stderr.toString();
  expect(Number(/max_volume: (-?[0-9.]+) dB/.exec(loudness)![1])).toBeGreaterThan(-40);
  // The voiced final is a valid source for dialogue replacement (HV-022-03 lays production voices over it).
  const dialogue = await api(`/api/projects/${project!.projectId}/dialogue/${film.id}`, { headers: { authorization: "Bearer " + project!.token } }) as { lines: { shotId: string; character: string }[] };
  expect(dialogue.lines.map(line => [line.shotId, line.character])).toEqual([["shot-1-1", "MAYA"]]);
  // Only an exact match is carried: a shot of another length, or one that already has sound, keeps its own.
  const picture = { ...spoken(film).clip, path: "unused.mp4", speech: undefined, audioMode: undefined, cost: { provider: "fal", model: "m", prompt_tokens: 0, output_frames: 0, gpu_seconds: 0, total_cost_usd: 0 } };
  expect(roughCutDialogue(animatic, {} as Shot, { ...picture, durationSec: picture.durationSec + 1 })).toBeUndefined();
  expect(roughCutDialogue(animatic, {} as Shot, { ...picture, audioPath: "own.wav" })).toBeUndefined();
  expect(roughCutDialogue(undefined, {} as Shot, picture)).toBeUndefined();
}, 90000);
