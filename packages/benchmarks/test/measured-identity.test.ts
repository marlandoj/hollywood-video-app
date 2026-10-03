/**
 * HV-037-02. The benchmark's first measured score -- identity similarity -- computed from rendered
 * frames with the studio's own picture comparison, and a record whose scores must follow from the
 * fingerprints it carries.
 *
 * Every pass here runs on a local provider. No paid provider is called and nothing is spent.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DeterministicMockProvider, continuityScore, frameFingerprint } from "../../generator/src/index";
import { IDENTITY_METRIC, identitySimilarity, isFlatFingerprint, renderedFrameFingerprint, scoreShotIdentity, shotCharacters, stillFingerprint } from "../src/identity";
import { corpusShots, loadReferences, readMeasuredRecord, runMeasuredBenchmark, type MeasuredRecord, type ReferenceImage } from "../src/measured";
import { ReferenceLoopProvider, writeReferences } from "./stand-ins";

let root = "";
let references: ReferenceImage[] = [];
let conditioned: MeasuredRecord;
let textOnly: MeasuredRecord;
let mock: MeasuredRecord;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "hv-measured-"));
  references = loadReferences(writeReferences(join(root, "refs")));
  conditioned = await runMeasuredBenchmark({ provider: new ReferenceLoopProvider({ conditioned: true }), providerSpec: "stand-in:conditioned", references, outDir: join(root, "conditioned"), shotCapUsd: 5 });
  textOnly = await runMeasuredBenchmark({ provider: new ReferenceLoopProvider({ conditioned: false }), providerSpec: "stand-in:text-only", references, outDir: join(root, "text"), shotCapUsd: 5 });
  mock = await runMeasuredBenchmark({ provider: new DeterministicMockProvider(), providerSpec: "mock", references, outDir: join(root, "mock"), shotCapUsd: 5 });
}, 240_000);
afterAll(() => { if (root) rmSync(root, { recursive: true, force: true }); });

describe("the identity measure is the studio's own comparison, read from pixels", () => {
  test("a reference's hash is frameFingerprint at its only frame, and similarity is continuityScore", () => {
    const keeper = references.find(reference => reference.character === "KEEPER")!, sailor = references.find(reference => reference.character === "SAILOR")!;
    expect(stillFingerprint(keeper.path)).toBe(frameFingerprint(keeper.path, 0));
    expect(identitySimilarity(keeper.fingerprint, keeper.fingerprint)).toBe(1);
    expect(identitySimilarity(keeper.fingerprint, sailor.fingerprint)).toBe(continuityScore({ fingerprint: keeper.fingerprint }, { fingerprint: sailor.fingerprint }));
    expect(identitySimilarity(keeper.fingerprint, sailor.fingerprint)).toBeLessThan(0.75);
    expect(IDENTITY_METRIC.method).toContain("not a face-identity embedding");
  });

  test("the frame is measured from the file, not taken from the clip's own fingerprint", () => {
    // The stand-in reports an all-zero fingerprint for every clip. Had the runner trusted it, every
    // frame would be flat and nothing would be scored.
    const shot = conditioned.shots.find(value => value.shotId === "shot-1-1")!;
    expect(shot.flatFrame).toBe(false);
    expect(shot.frameFingerprint).not.toBe("0".repeat(64));
    expect(shot.frameFingerprint).toBe(renderedFrameFingerprint(join(root, "conditioned", "shot-1-1.mp4"), 2).fingerprint);
    // The mock provider's fingerprint is a SHA-256 of its prompt; its frame is a solid colour.
    const mockShot = mock.shots[0]!;
    expect(mockShot.frameFingerprint).toBe("0".repeat(64));
    expect(mockShot.flatFrame).toBe(true);
  });

  test("a flat frame is reported and not scored", () => {
    expect(isFlatFingerprint("0".repeat(64))).toBe(true);
    expect(isFlatFingerprint("f".repeat(64))).toBe(true);
    expect(isFlatFingerprint("0".repeat(63) + "1")).toBe(false);
    expect(scoreShotIdentity("0".repeat(64), ["KEEPER"], { KEEPER: references[0]!.fingerprint })).toEqual({ identity: [], identityScore: null, flatFrame: true });
    expect(() => isFlatFingerprint("xyz")).toThrow();
  });
});

describe("which characters a corpus shot shows", () => {
  test("speakers and named characters with a reference, and no one else", () => {
    const shown = corpusShots().shots.map(shot => [shot.id, shotCharacters(shot, ["KEEPER", "SAILOR"])] as const).filter(([, names]) => names.length);
    expect(shown).toEqual([
      ["shot-1-1", ["KEEPER"]], ["shot-3-1", ["KEEPER"]], ["shot-5-1", ["SAILOR"]], ["shot-7-1", ["KEEPER"]], ["shot-8-1", ["SAILOR"]],
      ["shot-9-1", ["KEEPER"]], ["shot-13-1", ["KEEPER"]], ["shot-16-1", ["SAILOR"]], ["shot-17-1", ["SAILOR"]], ["shot-23-1", ["KEEPER"]],
    ]);
    // VOICE has no reference, and a word inside another word is not a name.
    expect(shotCharacters({ prompt: "INT. ROOM. The gatekeeper waits.", dialogue: [{ character: "VOICE", lines: ["Thank you, keeper."] }] }, ["KEEPER"])).toEqual([]);
  });
});

describe("a measured pass", () => {
  test("separates a model that holds the reference from one that cannot see it", () => {
    for (const record of [conditioned, textOnly]) {
      expect(record.aggregate).toMatchObject({ shots: 24, rendered: 24, skipped: 0, failed: 0, flatFrames: 0, scoredShots: 10, totalCostUsd: 0 });
      expect(record.shots.filter(shot => shot.identityScore === null).every(shot => shot.characters.length === 0)).toBe(true);
    }
    expect(conditioned.shots.filter(shot => shot.characters.length).every(shot => shot.referencesSent === 1)).toBe(true);
    expect(textOnly.shots.every(shot => shot.referencesSent === 0)).toBe(true);
    expect(conditioned.aggregate.identityMin!).toBeGreaterThanOrEqual(0.9);
    expect(textOnly.aggregate.identityMax!).toBeLessThan(0.8);
    expect(conditioned.aggregate.identityMean! - textOnly.aggregate.identityMean!).toBeGreaterThan(0.2);
  });

  test("on the mock provider every frame is flat, so the pass measures nothing and says so", () => {
    expect(mock).toMatchObject({ provider: "mock", model: "mock-deterministic-v1", synthetic: true, providerSpec: "mock", declaredUsd: 0, increment: null });
    expect(mock.aggregate).toMatchObject({ shots: 24, rendered: 24, flatFrames: 24, scoredShots: 0, identityMean: null, identityMin: null, identityMax: null, totalCostUsd: 0 });
  });

  test("the record carries per-shot scores with the provider and model ids, and the fixture it measured", () => {
    expect(conditioned).toMatchObject({ schema: "hv-benchmark-measured/1", fixtureVersion: "1.0.0", frameSize: "1280x720", provider: "stand-in", model: "reference-loop-v1" });
    expect(conditioned.fixtureSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(conditioned.capabilityRevision).toMatch(/^[0-9a-f]{64}$/);
    expect(conditioned.references.map(reference => reference.character)).toEqual(["KEEPER", "SAILOR"]);
    const shot = conditioned.shots.find(value => value.shotId === "shot-5-1")!;
    expect(shot).toMatchObject({ status: "rendered", characters: ["SAILOR"], frameAtSec: 1 });
    expect(shot.identity).toHaveLength(1);
    expect(shot.clipSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a priced provider is refused without a ledger, before any shot", async () => {
    const provider = new ReferenceLoopProvider({ conditioned: true, usdPerShot: 0.25 });
    await expect(runMeasuredBenchmark({ provider, providerSpec: "stand-in", references, outDir: join(root, "priced"), shotCapUsd: 5 })).rejects.toThrow(/priced; it runs only under a ledger/);
    expect(provider.calls).toHaveLength(0);
  });
});

describe("a measured record reaches routing only when its scores follow from its fingerprints", () => {
  const copy = (record: MeasuredRecord): MeasuredRecord => structuredClone(record);
  test("the real record reads back, and a synthetic one only when asked for", () => {
    expect(readMeasuredRecord(copy(conditioned), { allowSynthetic: true }).aggregate.scoredShots).toBe(10);
    expect(() => readMeasuredRecord(copy(conditioned))).toThrow(/synthetic stand-in/);
    expect(() => readMeasuredRecord(copy(mock))).toThrow(/synthetic stand-in/);
  });

  test("an invented score, an invented aggregate, or a score on an unrendered shot is refused", () => {
    const shotEdited = copy(conditioned);
    const scored = shotEdited.shots.find(shot => shot.identityScore !== null)!;
    scored.identity[0]!.score = 0.99; scored.identityScore = 0.99;
    expect(() => readMeasuredRecord(shotEdited, { allowSynthetic: true })).toThrow(/does not follow from its fingerprints/);

    const aggregateEdited = copy(textOnly);
    aggregateEdited.aggregate.identityMean = 0.97;
    expect(() => readMeasuredRecord(aggregateEdited, { allowSynthetic: true })).toThrow(/aggregate identityMean/);

    const unrendered = copy(conditioned);
    unrendered.shots[0]!.status = "skipped";
    expect(() => readMeasuredRecord(unrendered, { allowSynthetic: true })).toThrow(/not rendered but carries a score/);

    const flatScored = copy(mock);
    flatScored.shots[0]!.characters = ["KEEPER"];
    flatScored.shots[0]!.identity = [{ character: "KEEPER", score: 0.6 }]; flatScored.shots[0]!.identityScore = 0.6;
    expect(() => readMeasuredRecord(flatScored, { allowSynthetic: true })).toThrow(/does not follow/);

    expect(() => readMeasuredRecord({ ...copy(conditioned), schema: "hv-benchmark/0" }, { allowSynthetic: true })).toThrow(/schema/);
  });
});
