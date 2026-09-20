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
import type { ReferenceAsset } from "../../planner/src/references";

// HV-017-06: the live reel's final ignored the approved storyboard (NORA changed between them).
// Through the studio's own flow, the crew pins each storyboard still as its shot's first frame,
// the rough cut is re-cut from them, and the final starts every clip from that exact picture.
const SCRIPT = "INT. KITCHEN - DAY\n\nMAYA, an old woman, pours tea.\n\nMAYA\nYou came back.";
const root = mkdtempSync(join(tmpdir(), "hv-studio-anchors-"));
const config = { HV_TOKEN_SECRET: "studio-anchor-fixture-secret-at-least-thirty-two-characters", HV_ANIMATIC_PROVIDER_POOL: '["mock"]',
  HV_PROVIDER_POOL: '["mock","fal:kling-o3-standard-keyframes"]', HV_NARRATION: "0", HV_ANIMATIC_CAPTIONS: "0", FAL_KEY: "studio-anchor-fixture-only" };
const original = Object.fromEntries(Object.keys(config).map(key => [key, process.env[key]]));
let server: ReturnType<typeof createApiServer> | undefined;
const realFetch = globalThis.fetch;
afterAll(async () => {
  globalThis.fetch = realFetch; await server?.stop(true); rmSync(root, { recursive: true, force: true });
  for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});
const run = (args: string[]) => { const result = Bun.spawnSync(args); if (result.exitCode) throw new Error(result.stderr.toString()); return result.stdout; };

test("the studio pins the storyboard stills and the final starts from them", async () => {
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
  const planned = await flow.plan([]);
  expect(planned.plan.finalAnchors).toBe(true);
  const rough = await flow.approveLook(true);
  const auth = { authorization: "Bearer " + project!.token };
  const view = await api(`/api/projects/${project!.projectId}/direction`, { headers: auth }) as { direction: { version: number; entries: { settings: { frameAnchors?: { frames: { at: number; asset: ReferenceAsset }[]; fallback: string }; durationFrames: number | null } }[] } };
  const anchors = view.direction.entries[0]!.settings.frameAnchors!;
  expect(anchors).toMatchObject({ fallback: "stop", frames: [{ at: 0 }] });
  expect(anchors.frames[0]!.asset.source).toMatchObject({ kind: "shot-anchor", shotId: "shot-1-1", label: "Storyboard still" });
  // The creator approves the rough cut cut from the pinned stills: it is the second animatic, made without new pictures.
  const jobs = (await store.all()).filter(job => job.stage === "animatic");
  expect(jobs).toHaveLength(2);
  expect(rough.animatic.id).toBe(jobs[1]!.id);
  expect(jobs[1]!.providerPlan!.pool.some(entry => entry.spec === "anchor-storyboard")).toBe(true);
  expect(fal.submissions).toHaveLength(0);

  const final = await flow.approveRoughCut();
  expect(final.final.status).toBe("done");
  expect(fal.submissions).toHaveLength(1);
  expect(fal.submissions[0]!.body.start_image_url).toBe("data:image/png;base64," + (await references.read(anchors.frames[0]!.asset)).toString("base64"));
  // Paced to the keyframes model's shortest billed clip (3 s), never shorter than the line.
  expect(view.direction.entries[0]!.settings.durationFrames).toBe(90);
}, 60000);
