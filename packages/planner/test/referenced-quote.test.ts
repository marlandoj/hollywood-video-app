/**
 * HV-019-17 — the read-through's quote (HV-030-28) on the live-film-referenced profile (G22-202610041528).
 *
 * The router sends a shot with reference images (a locked or imaged character) to Kling O3 reference and
 * a shot with none to Kling 2.5, so the quote prices each shot on that lane: $0.42 a 5 s shot and $0.35.
 * The rough cut's stills are quoted on the stills pool the same way: FLUX.2 edit, which counts each
 * reference image as a megapixel, and FLUX Schnell. Prices are read from the adapters and the profile
 * from scripts/staging-providers.py, so a price or profile change moves these expectations.
 */
import { describe, expect, test } from "bun:test";
import { CAST_INPUT } from "../../../test/fixtures/casting";
import { stagingProfile } from "../../../test/fixtures/staging-profiles";
import { configuredPool } from "../../generator/src/catalog";
import { FAL_MODELS } from "../../generator/src/fal";
import { FAL_IMAGE_MODELS } from "../../generator/src/fal-image";
import { parseFountain } from "../../parser/src/index";
import { castingSnapshot, characterRecord, directCast } from "../src/casting";
import { referenceLockRecord } from "../src/reference-lock";
import { planShots } from "../src/index";
import { quotedLaneFor, readThroughFacts } from "../src/crew/read-through";

const now = Date.UTC(2026, 9, 4);
const image = (seed: string) => ({schema: "hv-reference/1" as const, id: "11111111-2222-4333-8444-" + seed.repeat(12).slice(0, 12), projectId: "project-1",
  sha256: seed.repeat(64).slice(0, 64), originalSha256: "b".repeat(64), bytes: 4096, width: 512, height: 512, contentType: "image/png" as const,
  createdAt: new Date(now).toISOString(), attestedAt: new Date(now).toISOString()});
const permitted = {status: "permitted", scope: "project", sceneNumbers: [], expiresAt: null, attestedAt: new Date(now).toISOString()};
const locked = (id: string, name: string, prefix: string) => {
  const references = ["1", "2", "3", "4"].map(n => image(prefix + n));
  return characterRecord({...CAST_INPUT, name, aliases: [], permission: permitted, sceneBindings: [], references,
    referenceLock: referenceLockRecord({assetIds: references.map(asset => asset.id), label: name + " turnaround", note: ""}, references, now)}, id, now, true);
};
const MARA = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa", JUNO = "bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb";
const cast = castingSnapshot("project-1", 1, [locked(MARA, "MARA", "c"), locked(JUNO, "JUNO", "d")], now);
const noCast = castingSnapshot("project-1", 0, [], 0);

/** Scene 1 shows Mara and Juno, scene 2 Mara alone, scene 3 nobody: `n` action beats each, one shot a beat. */
const script = (n: number) => [["INT. WORKSHOP - DAY", "Mara and Juno sort crate"], ["INT. LOFT - NIGHT", "Mara reads page"], ["EXT. YARD - DAY", "The gate swings, gust"]]
  .map(([heading, beat]) => heading + "\n\n" + Array.from({length: n}, (_, i) => `${beat} ${i + 1}.`).join("\n\n")).join("\n\n");
const read = (text: string, profile: Record<string, string>, casting = cast, maxShots = 240) => {
  const parsed = parseFountain(text), shots = planShots(parsed, 7000, maxShots);
  const finalPool = configuredPool("final", {HV_PROVIDER_PRIMARY: profile.HV_PROVIDER_PRIMARY, HV_PROVIDER_SECONDARY: profile.HV_PROVIDER_SECONDARY});
  const animaticPool = configuredPool("animatic", {HV_ANIMATIC_PROVIDER: profile.HV_ANIMATIC_PROVIDER, ...(profile.HV_ANIMATIC_PROVIDER_POOL ? {HV_ANIMATIC_PROVIDER_POOL: profile.HV_ANIMATIC_PROVIDER_POOL} : {})});
  return {parsed, shots, finalPool, animaticPool, facts: readThroughFacts(text, parsed, {format: "feature", tone: ""}, shots, finalPool, {animaticPool, casting})};
};
const referenced = stagingProfile("live-film-referenced");
const O3_REFERENCE_SHOT = FAL_MODELS["kling-o3-standard-reference"]!.usdPerBilledSecond * 5, KLING_SHOT = FAL_MODELS["kling-v2.5-turbo-pro"]!.usdPerBilledSecond * 5;
/** FLUX.2 edit at the rough cut's 640x360 (raised to 512 on the short side): one megapixel, plus one for each reference image. */
const EDIT_STILL = (references: number) => (references + 1) * FAL_IMAGE_MODELS["flux-2-edit"]!.usdPerMegapixel;
const SCHNELL_STILL = FAL_IMAGE_MODELS["flux-schnell"]!.usdPerMegapixel;
const usd = (value: number) => Number(value.toFixed(2));

describe("the referenced profile's quote", () => {
  test("G22's prices: Kling O3 reference $0.42 a 5 s shot, Kling 2.5 $0.35", () => {
    expect(O3_REFERENCE_SHOT).toBeCloseTo(0.42, 10);
    expect(KLING_SHOT).toBeCloseTo(0.35, 10);
  });

  test("the lane is the router's: a shot with one to four images on O3 reference, a shot with none on Kling 2.5", () => {
    const {finalPool} = read(script(1), referenced);
    expect([0, 1, 2, 4, 5].map(count => quotedLaneFor(finalPool, count)?.spec ?? null))
      .toEqual(["fal:kling-v2.5-turbo-pro", "fal:kling-o3-standard-reference", "fal:kling-o3-standard-reference", "fal:kling-o3-standard-reference", null]);
  });

  test("shots with a locked character are quoted at $0.42, the others at $0.35, with each lane's share; stills on FLUX.2 edit and FLUX Schnell", () => {
    const {facts, shots} = read(script(4), referenced);
    expect(shots.map(shot => shot.sceneIndex)).toEqual([0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2]);
    expect(facts.estimate).toEqual({videoSpec: "fal:kling-o3-standard-reference", basis: "profile", finalVideoUsd: usd(8 * O3_REFERENCE_SHOT + 4 * KLING_SHOT),
      lanes: [{videoSpec: "fal:kling-o3-standard-reference", shots: 8, finalVideoUsd: usd(8 * O3_REFERENCE_SHOT)}, {videoSpec: "fal:kling-v2.5-turbo-pro", shots: 4, finalVideoUsd: usd(4 * KLING_SHOT)}],
      // Scene 1 carries eight images, cut to four; scene 2 Mara's four; scene 3 none.
      roughCutStillsUsd: usd(4 * EDIT_STILL(4) + 4 * EDIT_STILL(4) + 4 * SCHNELL_STILL)});
    expect(facts.estimate.finalVideoUsd).toBe(4.76);
  });

  test("a 240-shot feature, two thirds of it with a locked character: $95.20 in finals, inside G22's $85-100", () => {
    // Scenes of 80 beats: Mara and Juno, Mara alone, then the yard; the planner keeps 240.
    const {facts, shots} = read(script(80), referenced);
    expect(shots).toHaveLength(240);
    const lockedShots = shots.filter(shot => shot.sceneIndex < 2).length;
    expect(facts.estimate.lanes!.map(lane => [lane.videoSpec, lane.shots])).toEqual([["fal:kling-o3-standard-reference", lockedShots], ["fal:kling-v2.5-turbo-pro", 240 - lockedShots]]);
    expect(facts.estimate.finalVideoUsd).toBe(usd(lockedShots * O3_REFERENCE_SHOT + (240 - lockedShots) * KLING_SHOT));
    expect(lockedShots).toBe(160);
    expect(facts.estimate.finalVideoUsd).toBe(95.2);
    expect(facts.estimate.roughCutStillsUsd).toBe(usd(lockedShots * EDIT_STILL(4) + (240 - lockedShots) * SCHNELL_STILL));
  });

  test("a shot already cast is quoted from the images it carries, cut to the pool's budget", () => {
    const {parsed, shots, finalPool, animaticPool} = read(script(2), referenced);
    const castShots = directCast(shots, parsed, cast, now, undefined, 4);
    expect(castShots.map(shot => shot.referenceAssets?.length ?? 0)).toEqual([4, 4, 4, 4, 0, 0]);
    const facts = readThroughFacts(script(2), parsed, {format: "feature", tone: ""}, castShots, finalPool, {animaticPool});
    expect(facts.estimate.finalVideoUsd).toBe(usd(4 * O3_REFERENCE_SHOT + 2 * KLING_SHOT));
    expect(facts.estimate.roughCutStillsUsd).toBe(usd(4 * EDIT_STILL(4) + 2 * SCHNELL_STILL));
  });

  test("before any character has images every shot is quoted on the plain lanes", () => {
    const {facts} = read(script(4), referenced, noCast);
    expect(facts.estimate).toEqual({videoSpec: "fal:kling-o3-standard-reference", basis: "profile", finalVideoUsd: usd(12 * KLING_SHOT), roughCutStillsUsd: usd(12 * SCHNELL_STILL)});
  });
});

describe("the other profiles are quoted as before", () => {
  test("anchored: every shot on O3 keyframes, locked or not, with no lanes", () => {
    const {facts} = read(script(4), stagingProfile("live-film-anchored"));
    expect([facts.estimate.videoSpec, facts.estimate.finalVideoUsd, "lanes" in facts.estimate]).toEqual(["fal:kling-o3-standard-keyframes", usd(12 * FAL_MODELS["kling-o3-standard-keyframes"]!.usdPerBilledSecond * 5), false]);
    // FLUX Schnell takes no image, so a locked character's still has no provider there: no stills figure.
    expect(facts.estimate.roughCutStillsUsd).toBeNull();
    expect(read(script(4), stagingProfile("live-film-anchored"), noCast).facts.estimate.roughCutStillsUsd).toBe(usd(12 * SCHNELL_STILL));
  });
  test("live-film: Kling 2.5 for every shot; mock: the reference lane and no stills figure", () => {
    expect(read(script(4), stagingProfile("live-film")).facts.estimate).toMatchObject({videoSpec: "fal:kling-v2.5-turbo-pro", basis: "profile", finalVideoUsd: usd(12 * KLING_SHOT)});
    expect("lanes" in read(script(4), stagingProfile("live-film")).facts.estimate).toBe(false);
    const mock = read(script(4), stagingProfile("mock")).facts.estimate;
    expect(mock).toEqual({videoSpec: "fal:kling-v2.5-turbo-pro", basis: "reference", finalVideoUsd: mock.finalVideoUsd});
  });
});
