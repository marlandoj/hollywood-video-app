/**
 * HV-019-19 — on the live-film-referenced profile, a final's prompt is fitted to Kling's 2,500-character
 * limit before it is sent, and a final that can't be fitted is refused at admission, at $0.
 *
 * Release 3's live run (G23) stopped on `fal GET /fal-ai/kling-video/requests/<id> failed (422):
 * string_too_long ... "String should have at most 2500 characters"`: fal accepted the submit and refused it at
 * result time. Real API and worker; every fal model the profile names is a closed HTTP fixture (no network,
 * no key, no spend), which records each request's body so the prompt actually sent can be measured.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/server";
import { ProjectService } from "../src/index";
import { DurableJobStore } from "../../queue/src/index";
import { processNextJob } from "../../queue/src/worker";
import { CostLedger, OperatorReviewQueue } from "../../operator/src/index";
import { CrewLedger } from "../../operator/src/crew-ledger";
import { ReferenceBlobStore } from "../../storage/src/references";
import { DeterministicMockImageProvider } from "../../generator/src/image";
import { DeterministicMockProvider } from "../../generator/src/index";
import { FAL_IMAGE_MODELS } from "../../generator/src/fal-image";
import { FAL_KLING_MAX_PROMPT_CHARS, FAL_MODELS, falReferenceNote } from "../../generator/src/fal";
import type { CastingSnapshot } from "../../planner/src/casting";
import type { ShotPromptFit } from "../../planner/src/prompt-fit";
import { CAST_INPUT } from "../../../test/fixtures/casting";
import { stagingProfile } from "../../../test/fixtures/staging-profiles";

const PROFILE = stagingProfile("live-film-referenced");
const EDIT = FAL_IMAGE_MODELS["flux-2-edit"]!.endpoint, SCHNELL = FAL_IMAGE_MODELS["flux-schnell"]!.endpoint;
const O3 = FAL_MODELS["kling-o3-standard-reference"]!.endpoint, KLING = FAL_MODELS["kling-v2.5-turbo-pro"]!.endpoint;
const IMAGE_MODELS = [EDIT, SCHNELL], VIDEO_MODELS = [O3, KLING];

/** A closed fake of fal's queue for the four models the profile names (as referenced-profile.test.ts has it). */
function profileFal(png: Buffer, mp4: Buffer, localOrigin: string, realFetch: typeof fetch) {
  const submissions: {model: string; body: Record<string, unknown>}[] = [], requests = new Map<string, string>();
  const prefix = "prompt-limit-fixture-" + crypto.randomUUID() + "-";
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20);
  const fetchImpl = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    init.signal?.throwIfAborted();
    if (url.origin === localOrigin) return realFetch(input, init);
    if (url.origin === "https://queue.fal.run") {
      const model = url.pathname.slice(1), method = init.method ?? "GET";
      if (method === "POST" && [...IMAGE_MODELS, ...VIDEO_MODELS].includes(model)) {
        submissions.push({model, body: JSON.parse(String(init.body))});
        const base = "https://queue.fal.run/" + model + "/requests/" + prefix + submissions.length;
        requests.set(base, model);
        return Response.json({request_id: prefix + submissions.length, status_url: base + "/status", response_url: base, cancel_url: base + "/cancel"});
      }
      if (method === "GET" && url.href.endsWith("/status") && requests.has(url.href.slice(0, -7))) return Response.json({status: "COMPLETED"});
      const requested = requests.get(url.href);
      if (method === "GET" && requested) return IMAGE_MODELS.includes(requested)
        ? Response.json({images: [{url: "https://v3.fal.media/files/prompt-limit-fixture.png", width, height}], has_nsfw_concepts: [false]})
        : Response.json({video: {url: "https://v3.fal.media/files/prompt-limit-fixture.mp4"}});
    }
    if (url.href === "https://v3.fal.media/files/prompt-limit-fixture.png") return new Response(new Uint8Array(png));
    if (url.href === "https://v3.fal.media/files/prompt-limit-fixture.mp4") return new Response(new Uint8Array(mp4));
    throw new Error("The prompt-limit fixture refused an unexpected network destination or operation.");
  }) as typeof fetch;
  return {fetchImpl, submissions};
}

/** Scene 1: locked Mara and unlocked Juno, with a long action. Scene 2: nobody, a short action. One shot a scene. */
const ACTION = "Mara and Juno sort crates on the long bench while rain drums on the tin roof, lanterns sway from the rafters, and a radio on the shelf "
  + "crackles through an old dance tune. Juno stacks the empty crates by the door, counts them twice, and frowns at the ledger. Mara pries the lid off the last crate "
  + "and lifts out a brass ship's clock wrapped in newspaper, its glass cracked, its hands stopped at a quarter past four. She holds it up to the lantern light.";
const SCRIPT = "INT. WORKSHOP - DAY\n\n" + ACTION + "\n\nEXT. YARD - DAY\n\nThe gate swings in the wind.";
const root = mkdtempSync(join(tmpdir(), "hv-referenced-prompt-limit-"));
const config: Record<string, string> = {...PROFILE, HV_TOKEN_SECRET: "referenced-prompt-limit-fixture-secret-at-least-thirty-two",
  HV_ANIMATIC_COST_CAP_USD: "5", HV_NARRATION: "0", HV_ANIMATIC_CAPTIONS: "0", FAL_KEY: "referenced-prompt-limit-contract-fixture-only"};
const CLEARED = ["HV_PROVIDER_POOL", "HV_ROUTING_STRATEGY", "HV_FAL_IMAGE_USD_PER_IMAGE", "HV_FAL_USD_PER_BILLED_SECOND"];
const original = Object.fromEntries([...Object.keys(config), ...CLEARED].map(key => [key, process.env[key]]));
const realFetch = globalThis.fetch;
const paths = {queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json"), artifactRoot: join(root, "artifacts"), costLedgerPath: join(root, "ledger.json")};
let server: ReturnType<typeof createApiServer>, http: ReturnType<typeof profileFal>, images: Buffer[] = [];

beforeAll(async () => {
  for (const key of CLEARED) delete process.env[key];
  Object.assign(process.env, config);
  const imager = new DeterministicMockImageProvider();
  images = await Promise.all(Array.from({length: 4}, async (_, index) =>
    readFileSync((await imager.generateFrame("A fictional crate hauler, view " + (index + 1), 21 + index, {}, join(root, "view-" + index + ".png"))).path)));
  const still = readFileSync((await imager.generateFrame("A fictional crate hauler", 7, {widthxheight: "640x512"}, join(root, "still.png"))).path);
  const clip = readFileSync((await new DeterministicMockProvider().generate("A fictional crate hauler", 7, {seed: 7, durationSec: 3, widthxheight: "1280x720"}, join(root, "clip.mp4"))).path);
  server = createApiServer({port: 0, hostname: "127.0.0.1", ...paths, rateLimit: {api: {limit: 100000, windowMs: 60000}, projectCreate: {limit: 10000, windowMs: 3600000}},
    crewLedger: new CrewLedger(), crewModel: null});
  http = profileFal(still, clip, server.url.origin, realFetch);
  globalThis.fetch = http.fetchImpl;
});
afterAll(async () => {
  globalThis.fetch = realFetch;
  await server?.stop(true); rmSync(root, {recursive: true, force: true});
  for (const [key, value] of Object.entries(original)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
});

const call = (path: string, method = "GET", body?: unknown, token?: string) => fetch(new URL(path, server.url), {method,
  headers: {"content-type": "application/json", ...(token ? {authorization: "Bearer " + token} : {})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
const worker = () => processNextJob(new DurableJobStore(paths.queuePath), paths.artifactRoot, {ledger: new CostLedger(paths.costLedgerPath),
  references: new ReferenceBlobStore(paths.artifactRoot), projects: new ProjectService(paths.statePath), reviewQueue: new OperatorReviewQueue(join(root, "reviews.json"))});
const words = (text: string, length: number) => text.repeat(Math.ceil(length / text.length)).slice(0, length - 1).trimEnd() + ".";

/** A project with Mara locked to four views and Juno unlocked, each with the notes given; its rough cut rendered and approved. */
async function approvedRoughCut(mara: Partial<typeof CAST_INPUT>, juno: Partial<typeof CAST_INPUT>) {
  const owner = await (await call("/api/projects", "POST")).json() as {projectId: string; token: string};
  const base = "/api/projects/" + owner.projectId, ids = {mara: crypto.randomUUID(), juno: crypto.randomUUID()};
  expect((await call(base + "/script", "PUT", {text: SCRIPT}, owner.token)).status).toBe(200);
  expect((await call(base + "/rights", "POST", {attested: true}, owner.token)).status).toBe(200);
  const cast = async () => (await (await call(base + "/cast", "GET", undefined, owner.token)).json() as {casting: CastingSnapshot}).casting;
  for (const [key, notes] of [["mara", mara], ["juno", juno]] as const) {
    expect((await call(base + "/cast/" + ids[key], "PUT", {expectedVersion: (await cast()).version, character: {...CAST_INPUT, name: key.toUpperCase(), aliases: [],
      appearance: "A fictional crate hauler.", prohibitedChanges: "", wardrobe: [{sceneNumber: null, description: "Work clothes"}], ...notes}}, owner.token)).status).toBe(200);
  }
  const assets: string[] = [];
  for (const image of images) {
    const response = await fetch(new URL(base + "/cast/" + ids.mara + "/references", server.url), {method: "POST", headers: {authorization: "Bearer " + owner.token,
      "content-type": "image/png", "x-hv-cast-version": String((await cast()).version), "x-hv-reference-attested": "true"}, body: new Uint8Array(image)});
    expect(response.status).toBe(201);
    assets.push((await response.json() as {asset: {id: string}}).asset.id);
  }
  expect((await call(base + "/cast/" + ids.mara + "/reference-lock", "PUT", {expectedVersion: (await cast()).version, lock: {assetIds: assets, label: "Mara turnaround"}}, owner.token)).status).toBe(200);
  const before = http.submissions.length, admitted = await call(base + "/jobs", "POST", {}, owner.token), data = await admitted.json() as {jobId?: string; error?: string};
  expect([admitted.status, data.error]).toEqual([202, undefined]);
  const job = await worker();
  expect([job?.id, job?.status, job?.failureReason]).toEqual([data.jobId, "done", undefined]);
  expect((await call(base + "/animatic/decision", "POST", {animaticJobId: job!.id, decision: "approved"}, owner.token)).status).toBe(201);
  return {owner, base, rough: job!, stills: http.submissions.slice(before)};
}

/**
 * The stills (FLUX, no declared limit) are sent whole. The final's shot of locked Mara and long-noted Juno is
 * over Kling O3 reference's limit, so it is fitted: Juno's direction is cut first, never Mara's, and the prompt
 * fal receives, its numbered image note included, is within 2,500. The other shot was already within its limit
 * and is sent exactly as it was planned, with no record. Each fitted shot's provenance says what was cut.
 */
test("a final over Kling's limit is fitted before it is sent, and the short shot is sent unchanged", async () => {
  const {owner, base, rough, stills} = await approvedRoughCut({relationships: "Juno's partner at the yard."},
    {appearance: words("A broad-shouldered hauler with a weathered face and a patched canvas apron. ", 1000), relationships: words("Mara's partner at the yard for twenty years. ", 600)});
  // The stills: the rough cut's prompts are the planner's whole prompts, the first one over 2,500.
  expect(stills.map(s => s.model)).toEqual([EDIT, SCHNELL]);
  const stillPrompts = stills.map(s => String(s.body.prompt));
  expect(stillPrompts[0]!.length).toBeGreaterThan(FAL_KLING_MAX_PROMPT_CHARS);
  expect(stillPrompts[0]).toContain("\nJUNO. Appearance: A broad-shouldered hauler");

  const before = http.submissions.length;
  const admitted = await call(base + "/jobs", "POST", {stage: "final", animaticJobId: rough.id}, owner.token), data = await admitted.json() as {jobId?: string; error?: string};
  expect([admitted.status, data.error]).toEqual([202, undefined]);
  const job = await worker();
  expect([job?.id, job?.status, job?.failureReason]).toEqual([data.jobId, "done", undefined]);
  const finals = http.submissions.slice(before);
  expect(finals.map(s => [s.model, (s.body.image_urls as unknown[] | undefined)?.length ?? 0])).toEqual([[O3, 4], [KLING, 0]]);
  // What fal received is within its limit, the reference note counted.
  for (const submission of finals) expect(Buffer.byteLength(String(submission.body.prompt))).toBeLessThanOrEqual(FAL_KLING_MAX_PROMPT_CHARS);
  const sentFirst = String(finals[0]!.body.prompt), planned = sentFirst.slice(0, sentFirst.length - falReferenceNote(4).length);
  expect(sentFirst.endsWith(falReferenceNote(4))).toBe(true);
  // Mara's direction and the reference map are whole; Juno's was cut to fit, at a word boundary.
  const maraDirection = stillPrompts[0]!.slice(stillPrompts[0]!.indexOf("\nMARA. "), stillPrompts[0]!.indexOf("\nJUNO. "));
  expect(planned).toContain(maraDirection);
  expect(planned).toContain([1, 2, 3, 4].map(n => "Reference image " + n + " depicts MARA.").join("\n"));
  expect(planned).toContain("\nJUNO. Appearance:");
  expect(planned.length).toBeLessThan(stillPrompts[0]!.length);
  // The short shot: exactly the prompt the rough cut was sent, nothing cut.
  expect(String(finals[1]!.body.prompt)).toBe(stillPrompts[1]!);

  const manifest = JSON.parse(readFileSync(join(paths.artifactRoot, job!.output!.manifestPath), "utf8")) as {shots: {id: string; promptFit?: ShotPromptFit}[]};
  expect(manifest.shots.map(shot => shot.id)).toEqual(["shot-1-1", "shot-2-1"]);
  const fit = manifest.shots[0]!.promptFit!;
  expect(fit).toMatchObject({schema: "hv-prompt-fit/2", limit: FAL_KLING_MAX_PROMPT_CHARS - falReferenceNote(4).length, originalBytes: Buffer.byteLength(stillPrompts[0]!), fittedBytes: Buffer.byteLength(planned)});
  expect(fit.trimmed.map(cut => [cut.part, cut.label])).toEqual([["cast-unlocked", "JUNO"]]);
  expect(fit.trimmed[0]!.fromBytes - fit.trimmed[0]!.toBytes).toBe(Buffer.byteLength(stillPrompts[0]!) - Buffer.byteLength(planned));
  expect(manifest.shots[1]).not.toHaveProperty("promptFit");
  // The rough cut's own provenance records no fit: its stills were sent whole.
  const roughManifest = JSON.parse(readFileSync(join(paths.artifactRoot, rough.output!.manifestPath), "utf8")) as {shots: {promptFit?: unknown}[]};
  expect(roughManifest.shots.some(shot => "promptFit" in shot)).toBe(false);
}, 240000);

/**
 * Locked Mara's look (her appearance, body, hair, expressions and movement) is longer than Kling O3 reference
 * takes, and a locked character's look is never cut. The
 * final is refused at admission with a message that names her and what to shorten. No final job is queued
 * and no Kling request is made: nothing is paid to find out.
 */
test("a final that can't fit without cutting a locked character's direction is refused at admission, and nothing is sent", async () => {
  const {owner, base, rough} = await approvedRoughCut({appearance: words("A wiry hauler with a scar across one eyebrow and quick, careful hands. ", 1000),
    hairMakeup: words("Short dark hair tied back with twine. ", 400), body: words("Lean and strong from years of lifting. ", 240),
    expressions: words("A quick, crooked smile that rarely reaches her eyes. ", 400), movement: words("Moves fast and lightly, never wasting a step. ", 400)}, {});
  const before = http.submissions.length, jobs = new DurableJobStore(paths.queuePath).all().length, spent = new CostLedger(paths.costLedgerPath).monthSpend();
  const refused = await call(base + "/jobs", "POST", {stage: "final", animaticJobId: rough.id}, owner.token), data = await refused.json() as {error?: string; jobId?: string};
  expect(refused.status).toBe(400);
  expect(data.jobId).toBeUndefined();
  expect(data.error).toMatch(/^Shot shot-1-1's prompt is \d+ bytes after every cut the planner may make, and its provider takes at most 2380\. .*the cast direction of the locked characters \(MARA\) and the reference map\. Shorten the locked characters' notes or the shot's action, then render again\. Nothing was sent\.$/);
  expect(http.submissions.length).toBe(before);
  expect(new DurableJobStore(paths.queuePath).all().length).toBe(jobs);
  expect(new CostLedger(paths.costLedgerPath).monthSpend()).toBe(spent);
}, 240000);
