/**
 * HV-037-03. The corpus's committed character references: invented, drawn at $0 by
 * `packages/benchmarks/src/references.ts`, and exactly what that script draws.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { inflateSync } from "node:zlib";
import { FalVideoProvider } from "../../generator/src/index";
import { privatePngReferences } from "../../generator/src/image";
import { checkPrompt } from "../../safety/src/index";
import { identitySimilarity, shotCharacters } from "../src/identity";
import { corpusShots, loadReferences, planMeasuredPass, plannedCostUsd } from "../src/measured";
import { referencePaths } from "../src/paid";
import { CORPUS_CHARACTERS, CORPUS_REFERENCES_DIR, REFERENCE_DESCRIPTIONS, REFERENCE_SIZE, REFERENCES_MANIFEST_SCHEMA, referencePixels, type ReferencesManifest } from "../src/references";

const manifest = JSON.parse(readFileSync(join(CORPUS_REFERENCES_DIR, "references.json"), "utf8")) as ReferencesManifest;
const committed = () => loadReferences(Object.fromEntries(CORPUS_CHARACTERS.map(name => [name, join(CORPUS_REFERENCES_DIR, name.toLowerCase() + ".png")])));

/** An 8-bit RGB PNG with unfiltered rows -- the only kind the generator writes -- back to its pixels. */
function decodeRgbPng(png: Buffer): { width: number; height: number; rgb: Buffer } {
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  let offset = 8, width = 0, height = 0;
  const idat: Buffer[] = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset), type = png.toString("ascii", offset + 4, offset + 8), data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") { width = data.readUInt32BE(0); height = data.readUInt32BE(4); expect([data[8], data[9], data[12]]).toEqual([8, 2, 0]); }
    if (type === "IDAT") idat.push(data);
    expect(["IHDR", "IDAT", "IEND"]).toContain(type);
    offset += 12 + length;
  }
  const rows = inflateSync(Buffer.concat(idat)), rgb = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y++) {
    expect(rows[y * (width * 3 + 1)]).toBe(0);
    rows.copy(rgb, y * width * 3, y * (width * 3 + 1) + 1, (y + 1) * (width * 3 + 1));
  }
  return { width, height, rgb };
}

describe("the corpus's locked references", () => {
  test("are the committed files the manifest pins, and exactly what the generator draws", () => {
    expect(manifest).toMatchObject({ schema: REFERENCES_MANIFEST_SCHEMA, generator: "packages/benchmarks/src/references.ts", costUsd: 0, size: "512x512" });
    expect(manifest.references.map(reference => reference.character)).toEqual(["KEEPER", "SAILOR"]);
    for (const reference of manifest.references) {
      const png = readFileSync(join(CORPUS_REFERENCES_DIR, reference.file));
      expect(createHash("sha256").update(png).digest("hex")).toBe(reference.sha256);
      const decoded = decodeRgbPng(png), drawn = referencePixels(reference.character);
      expect([decoded.width, decoded.height]).toEqual([REFERENCE_SIZE, REFERENCE_SIZE]);
      expect(decoded.rgb.equals(drawn)).toBe(true);
      expect(createHash("sha256").update(drawn).digest("hex")).toBe(reference.pixelsSha256);
      expect(reference.description).toBe(REFERENCE_DESCRIPTIONS[reference.character]);
    }
  });

  test("are invented characters the safety gate admits, sendable as private PNG references", () => {
    for (const character of CORPUS_CHARACTERS) {
      expect(REFERENCE_DESCRIPTIONS[character]).toStartWith("Invented cartoon ");
      expect(checkPrompt(REFERENCE_DESCRIPTIONS[character]).allowed).toBe(true);
    }
    const references = committed();
    expect(() => privatePngReferences(references.map(reference => reference.dataUri), 2, 4)).not.toThrow();
  });

  test("carry structure the identity measure can compare, and are told apart from each other", () => {
    const references = committed();
    expect(references.map(reference => [reference.character, reference.flat])).toEqual([["KEEPER", false], ["SAILOR", false]]);
    // Two unrelated pictures score near 0.5; these two must not look like one character.
    expect(identitySimilarity(references[0]!.fingerprint, references[1]!.fingerprint)).toBeLessThan(0.75);
    // The harness reads them by file name, as `--references packages/benchmarks/fixtures/references`.
    expect(Object.keys(referencePaths(CORPUS_REFERENCES_DIR)).sort()).toEqual(["KEEPER", "SAILOR"]);
  });

  test("lock the corpus's ten character shots, and price the approved pass at $10.92 offline", () => {
    const references = committed();
    const shown = corpusShots().shots.map(shot => shotCharacters(shot, ["KEEPER", "SAILOR"])).filter(names => names.length);
    expect(shown).toHaveLength(10);
    expect(shown.flat().filter(name => name === "KEEPER")).toHaveLength(6);
    expect(shown.flat().filter(name => name === "SAILOR")).toHaveLength(4);
    let calls = 0;
    const never = (() => { calls += 1; throw new Error("no network in this test"); }) as unknown as typeof fetch;
    const price = (model: string) => {
      const plan = planMeasuredPass(new FalVideoProvider({ model, apiKey: "offline-test-key", fetchImpl: never }), references, 5);
      return [plan.filter(entry => entry.match.eligible).length, plannedCostUsd(plan)];
    };
    expect(price("kling-v2.5-turbo-pro")).toEqual([24, 8.4]);
    expect(price("kling-o3-standard-reference")).toEqual([10, 2.52]);
    expect(calls).toBe(0);
  });
});
