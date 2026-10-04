/**
 * HV-019-17 (G22-202610041528) — the live-film-referenced staging profile, end to end at $0.
 *
 * The profile's provider settings are read from scripts/staging-providers.py. Real API and worker; every
 * fal model the profile names is a closed HTTP fixture below (no network, no key, no spend). It shows:
 * - routing: in the router's configured order, a shot with reference images goes to FLUX.2 edit (stills)
 *   and Kling O3 reference (finals), and a shot with none to FLUX Schnell and Kling 2.5 Turbo Pro;
 * - the budget: a shot of two locked characters, four views each, carries two of each (the front of each
 *   lock), and its provenance and lock record say which were sent and which dropped; a shot of one locked
 *   character carries all four and records no cut.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiServer } from "../src/server";
import { ProjectService } from "../src/index";
import { DurableJobStore, type Job } from "../../queue/src/index";
import { processNextJob } from "../../queue/src/worker";
import { CostLedger, OperatorReviewQueue } from "../../operator/src/index";
import { CrewLedger } from "../../operator/src/crew-ledger";
import { ReferenceBlobStore } from "../../storage/src/references";
import { DeterministicMockImageProvider } from "../../generator/src/image";
import { DeterministicMockProvider } from "../../generator/src/index";
import { FAL_IMAGE_MODELS } from "../../generator/src/fal-image";
import { FAL_MODELS } from "../../generator/src/fal";
import { configuredPool } from "../../generator/src/catalog";
import { matchCapability, videoRequirements } from "../../generator/src/capabilities";
import type { RenderRoute } from "../../generator/src/router";
import type { CastingSnapshot } from "../../planner/src/casting";
import type { ReferenceAsset } from "../../planner/src/references";
import type { ShotIdentityLock } from "../../planner/src/identity-locks";
import type { ShotReferenceBudget } from "../../planner/src/reference-budget";
import { CAST_INPUT } from "../../../test/fixtures/casting";
import { stagingProfile } from "../../../test/fixtures/staging-profiles";

const PROFILE = stagingProfile("live-film-referenced");
const EDIT = FAL_IMAGE_MODELS["flux-2-edit"]!.endpoint, SCHNELL = FAL_IMAGE_MODELS["flux-schnell"]!.endpoint;
const O3 = FAL_MODELS["kling-o3-standard-reference"]!.endpoint, KLING = FAL_MODELS["kling-v2.5-turbo-pro"]!.endpoint;
const IMAGE_MODELS = [EDIT, SCHNELL], VIDEO_MODELS = [O3, KLING];

/** A closed fake of fal's queue for the four models the profile names. */
function profileFal(png: Buffer, mp4: Buffer, localOrigin: string, realFetch: typeof fetch) {
  const submissions: {model: string; body: Record<string, unknown>}[] = [], requests = new Map<string, string>();
  const prefix = "referenced-fixture-" + crypto.randomUUID() + "-";
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
        ? Response.json({images: [{url: "https://v3.fal.media/files/referenced-fixture.png", width, height}], has_nsfw_concepts: [false]})
        : Response.json({video: {url: "https://v3.fal.media/files/referenced-fixture.mp4"}});
    }
    if (url.href === "https://v3.fal.media/files/referenced-fixture.png") return new Response(new Uint8Array(png));
    if (url.href === "https://v3.fal.media/files/referenced-fixture.mp4") return new Response(new Uint8Array(mp4));
    throw new Error("The referenced-profile fixture refused an unexpected network destination or operation.");
  }) as typeof fetch;
  return {fetchImpl, submissions};
}

/** Two locked characters share scene 1; scene 2 shows nobody; scene 3 shows Mara alone. One shot a scene. */
const SCRIPT = "INT. WORKSHOP - DAY\n\nMara and Juno sort crates on the bench.\n\nEXT. YARD - DAY\n\nThe gate swings in the wind.\n\nINT. LOFT - NIGHT\n\nMara reads by lamplight.";
const root = mkdtempSync(join(tmpdir(), "hv-referenced-profile-"));
const config: Record<string, string> = {...PROFILE, HV_TOKEN_SECRET: "referenced-profile-fixture-secret-at-least-thirty-two",
  HV_ANIMATIC_COST_CAP_USD: "5", HV_NARRATION: "0", HV_ANIMATIC_CAPTIONS: "0", FAL_KEY: "referenced-profile-contract-fixture-only"};
const CLEARED = ["HV_PROVIDER_POOL", "HV_ROUTING_STRATEGY", "HV_FAL_IMAGE_USD_PER_IMAGE", "HV_FAL_USD_PER_BILLED_SECOND"];
const original = Object.fromEntries([...Object.keys(config), ...CLEARED].map(key => [key, process.env[key]]));
const realFetch = globalThis.fetch;
const paths = {queuePath: join(root, "jobs.json"), statePath: join(root, "projects.json"), artifactRoot: join(root, "artifacts"), costLedgerPath: join(root, "ledger.json")};
let server: ReturnType<typeof createApiServer>, http: ReturnType<typeof profileFal>, images: Buffer[] = [];

beforeAll(async () => {
  for (const key of CLEARED) delete process.env[key];
  Object.assign(process.env, config);
  const imager = new DeterministicMockImageProvider();
  images = await Promise.all(Array.from({length: 8}, async (_, index) =>
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
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
/** The bytes a vendor request carried, by digest, in the order it numbered them. */
const sent = (submission: {body: Record<string, unknown>}) => ((submission.body.image_urls as string[] | undefined) ?? []).map(url => sha(Buffer.from(url.slice("data:image/png;base64,".length), "base64")));
const worker = () => processNextJob(new DurableJobStore(paths.queuePath), paths.artifactRoot, {ledger: new CostLedger(paths.costLedgerPath),
  references: new ReferenceBlobStore(paths.artifactRoot), projects: new ProjectService(paths.statePath), reviewQueue: new OperatorReviewQueue(join(root, "reviews.json"))});
type ManifestShot = {id: string; routing?: RenderRoute; identityLocks?: ShotIdentityLock[]; referenceBudget?: ShotReferenceBudget};

test("the profile is the one G22 decided: stills FLUX.2 edit then FLUX Schnell, finals Kling O3 reference then Kling 2.5", () => {
  expect(JSON.parse(PROFILE.HV_ANIMATIC_PROVIDER_POOL!)).toEqual(["image:fal:flux-2-edit", "image:fal:flux-schnell"]);
  expect([PROFILE.HV_PROVIDER_PRIMARY, PROFILE.HV_PROVIDER_SECONDARY]).toEqual(["fal:kling-o3-standard-reference", "fal:kling-v2.5-turbo-pro"]);
  expect(configuredPool("animatic").map(entry => entry.spec)).toEqual(["image:fal:flux-2-edit", "image:fal:flux-schnell"]);
  expect(configuredPool("final").map(entry => entry.spec)).toEqual(["fal:kling-o3-standard-reference", "fal:kling-v2.5-turbo-pro"]);
  // Each pool's eligibility, as the router reads it: images go to the reference model, none to the other, and eight are refused by both.
  for (const [stage, size] of [["animatic", "640x360"], ["final", "1280x720"]] as const) {
    const eligible = (count: number) => configuredPool(stage).map(entry => matchCapability(entry.snapshot, videoRequirements({widthxheight: size, durationSec: 2,
      referenceFrames: Array.from({length: count}, (_, index) => "reference-" + index)}), 5).eligible);
    expect([eligible(0), eligible(1), eligible(4), eligible(8)]).toEqual([[false, true], [true, false], [true, false], [false, false]]);
  }
});

test("a rough cut and final on the profile: reference shots go to the reference models with at most four images, the others to FLUX Schnell and Kling 2.5", async () => {
  const owner = await (await call("/api/projects", "POST")).json() as {projectId: string; token: string};
  const base = "/api/projects/" + owner.projectId, ids = {mara: crypto.randomUUID(), juno: crypto.randomUUID()};
  expect((await call(base + "/script", "PUT", {text: SCRIPT}, owner.token)).status).toBe(200);
  expect((await call(base + "/rights", "POST", {attested: true}, owner.token)).status).toBe(200);
  const cast = async () => (await (await call(base + "/cast", "GET", undefined, owner.token)).json() as {casting: CastingSnapshot}).casting;
  for (const key of ["mara", "juno"] as const) {
    expect((await call(base + "/cast/" + ids[key], "PUT", {expectedVersion: (await cast()).version, character: {...CAST_INPUT, name: key.toUpperCase(), aliases: [],
      appearance: "A fictional crate hauler.", prohibitedChanges: "", wardrobe: [{sceneNumber: null, description: "Work clothes"}]}}, owner.token)).status).toBe(200);
  }
  const upload = async (key: "mara" | "juno", image: Buffer) => {
    const response = await fetch(new URL(base + "/cast/" + ids[key] + "/references", server.url), {method: "POST", headers: {authorization: "Bearer " + owner.token,
      "content-type": "image/png", "x-hv-cast-version": String((await cast()).version), "x-hv-reference-attested": "true"}, body: new Uint8Array(image)});
    expect(response.status).toBe(201);
    return (await response.json() as {asset: ReferenceAsset}).asset;
  };
  const looks: Record<"mara" | "juno", ShotIdentityLock["assets"]> = {mara: [], juno: []};
  for (const [offset, key] of [[0, "mara"], [4, "juno"]] as const) {
    const assets: ReferenceAsset[] = [];
    for (const image of images.slice(offset, offset + 4)) assets.push(await upload(key, image));
    const locked = await call(base + "/cast/" + ids[key] + "/reference-lock", "PUT", {expectedVersion: (await cast()).version,
      lock: {assetIds: assets.map(asset => asset.id), label: key + " turnaround"}}, owner.token);
    expect(locked.status).toBe(200);
    looks[key] = (await cast()).characters.find(character => character.id === ids[key])!.referenceLock!.assets;
  }
  const render = async (body: Record<string, unknown>) => {
    const before = http.submissions.length, admitted = await call(base + "/jobs", "POST", body, owner.token), data = await admitted.json() as {jobId?: string; error?: string};
    expect([admitted.status, data.error]).toEqual([202, undefined]);
    const job = await worker();
    expect([job?.id, job?.status, job?.failureReason]).toEqual([data.jobId, "done", undefined]);
    const manifest = JSON.parse(readFileSync(join(paths.artifactRoot, job!.output!.manifestPath), "utf8")) as {shots: ManifestShot[]};
    return {job: job! as Job, submissions: http.submissions.slice(before), manifest};
  };
  const digest = (assets: ShotIdentityLock["assets"]) => assets.map(asset => asset.sha256);
  const both = [...digest(looks.mara.slice(0, 2)), ...digest(looks.juno.slice(0, 2))];
  let previous: {job: Job} | undefined;

  for (const [stage, withImages, without, spec, plain] of [["animatic", EDIT, SCHNELL, "image:fal:flux-2-edit", "image:fal:flux-schnell"],
    ["final", O3, KLING, "fal:kling-o3-standard-reference", "fal:kling-v2.5-turbo-pro"]] as const) {
    const rendered: Awaited<ReturnType<typeof render>> = stage === "animatic" ? await render({}) : await render({stage: "final", animaticJobId: previous!.job.id});
    // One request a shot, in shot order, to the model the router chose for it.
    expect(rendered.submissions.map(submission => [submission.model, sent(submission)])).toEqual([[withImages, both], [without, []], [withImages, digest(looks.mara)]]);
    expect(rendered.submissions.every(submission => sent(submission).length <= 4)).toBe(true);
    const shots = rendered.manifest.shots;
    expect(shots.map(shot => shot.id)).toEqual(["shot-1-1", "shot-2-1", "shot-3-1"]);
    expect(shots.map(shot => shot.routing!.selectedCapability.model)).toEqual([withImages, without, withImages].map(model => model === withImages
      ? configuredPool(stage).find(entry => entry.spec === spec)!.snapshot.model : configuredPool(stage).find(entry => entry.spec === plain)!.snapshot.model));
    // Shot 1: two characters at four views each; the record says which two of each were sent and which dropped.
    expect(shots[0]!.referenceBudget).toEqual({schema: "hv-reference-budget/1", max: 4, carried: 8, characters: (["mara", "juno"] as const).map(key => ({
      characterId: ids[key], name: key.toUpperCase(), locked: true, sent: looks[key].slice(0, 2), dropped: looks[key].slice(2)}))});
    // HV-017-17's lock record keeps each lock and shows the subset.
    expect(shots[0]!.identityLocks!.map(lock => [lock.characterId, lock.assets, lock.sent, lock.dropped])).toEqual((["mara", "juno"] as const).map(key =>
      [ids[key], looks[key], looks[key].slice(0, 2), looks[key].slice(2)]));
    // Shot 2 has no character and no record; shot 3 is Mara alone, within budget: all four, no cut.
    expect([shots[1]!.identityLocks, shots[1]!.referenceBudget]).toEqual([undefined, undefined]);
    expect(shots[2]!.referenceBudget).toBeUndefined();
    expect(shots[2]!.identityLocks!.map(lock => [lock.characterId, lock.assets, "sent" in lock, "dropped" in lock])).toEqual([[ids.mara, looks.mara, false, false]]);
    if (stage === "animatic") expect((await call(base + "/animatic/decision", "POST", {animaticJobId: rendered.job.id, decision: "approved"}, owner.token)).status).toBe(201);
    previous = rendered;
  }
}, 240000);
