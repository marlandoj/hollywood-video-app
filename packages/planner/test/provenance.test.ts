/**
 * HV-031-02 — the provenance manifest must carry a real assembly time, and the
 * three strings that identify it must be written once.
 *
 * Every export this program has ever produced shipped
 * `"assembledAt": "1970-01-01T00:00:00.000Z"` — a string literal in the
 * manifest constructor, never a parameter and never overwritten. FR-018
 * requires the content credential to carry a timestamp and V-010's threshold
 * is "every frame carries model, prompt hash, timestamp, and seed", so the one
 * field of that requirement which is a timestamp was a constant: a rights
 * enquiry asking when a contested export was assembled got 1970, for every
 * project. Nothing caught it — `packages/assembler/test/assembler.test.ts`
 * asserted `credentials.type`, `projectId` and `shots.length`, and the
 * twelve-shot end-to-end asserted `shots.length` and that the claim contains
 * "AI-generated video".
 *
 * The same manifest's spec identifier and claim string were each written in
 * five places: once in the assembler and four times as equality targets in the
 * generator flows that verify a manifest before reusing footage, two by
 * concatenation and two as template literals. They agreed, and nothing made
 * them agree.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROVENANCE_SPEC, ProvenanceError,
  provenanceAssembledAt, provenanceCredentials, provenanceMatches, type ProvenanceManifest,
} from "../src/provenance";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const SHA = "a".repeat(64);
const manifest = (over: Partial<ProvenanceManifest> = {}): ProvenanceManifest => ({
  spec: PROVENANCE_SPEC, projectId: "project-1", scriptSha256: "b".repeat(64),
  shots: [{ id: "shot-1", provider: "mock", model: "m", seed: 1, fingerprint: "c".repeat(64) }],
  assembledAt: "2026-09-17T10:00:00.000Z",
  credentials: provenanceCredentials(SHA),
  ...over,
});

test("a placeholder epoch is refused by name, because that is what the defect looked like", () => {
  // The exact value every export carried. A validator that accepted it would
  // have passed the whole history of this program.
  expect(() => provenanceAssembledAt("1970-01-01T00:00:00.000Z")).toThrow(ProvenanceError);
  expect(() => provenanceAssembledAt("1970-01-01T00:00:00.000Z")).toThrow("not a placeholder epoch");
  // And a real instant is accepted, returned unchanged.
  expect(provenanceAssembledAt("2026-09-17T10:00:00.000Z")).toBe("2026-09-17T10:00:00.000Z");
  expect(provenanceAssembledAt("2026-09-17T10:00:00Z")).toBe("2026-09-17T10:00:00Z");
});

test("only a UTC ISO 8601 instant is an assembly time", () => {
  for (const bad of [
    undefined, null, 0, 1_758_106_800_000, "", "not a date",
    "2026-09-17", "2026-09-17T10:00:00", "2026-09-17T10:00:00+01:00",
    "2026-13-17T10:00:00.000Z", "2026-09-17 10:00:00Z", "1969-12-31T23:59:59.999Z",
  ]) {
    expect({ bad, threw: (() => { try { provenanceAssembledAt(bad); return false; } catch { return true; } })() })
      .toEqual({ bad, threw: true });
  }
  // A local-offset spelling is refused rather than silently reinterpreted: two
  // readers of a rights record must not be able to disagree about the hour.
  expect(() => provenanceAssembledAt("2026-09-17T10:00:00+01:00")).toThrow("UTC ISO 8601 instant");
});

test("the identity check accepts the right manifest and refuses each wrong one", () => {
  const expected = { projectId: "project-1", sha256: SHA };
  expect(provenanceMatches(manifest(), expected)).toBe(true);

  for (const [label, value] of [
    ["no manifest at all", null],
    ["a string where an object belongs", "provenance"],
    ["a different spec", manifest({ spec: "hv-provenance/2.0" as never })],
    ["another project's manifest", manifest({ projectId: "project-2" })],
    ["a claim bound to other media", manifest({ credentials: provenanceCredentials("d".repeat(64)) })],
    ["no credentials at all", manifest({ credentials: undefined as never })],
  ] as [string, unknown][]) {
    expect({ label, matches: provenanceMatches(value, expected) }).toEqual({ label, matches: false });
  }
});

test("a legacy manifest with the placeholder epoch is still reusable, on purpose", () => {
  // Every export assembled before this increment carries 1970, and those are
  // retained media people are still editing. The timestamp is enforced where
  // it is written and tolerated where it is read, so a defect the user did not
  // cause does not take their existing work away. This pins that decision.
  const legacy = manifest({ assembledAt: "1970-01-01T00:00:00.000Z" });
  expect(provenanceMatches(legacy, { projectId: "project-1", sha256: SHA })).toBe(true);
  // While the same value is refused at the write boundary.
  expect(() => provenanceAssembledAt(legacy.assembledAt)).toThrow(ProvenanceError);
});

test("the spec, the issuer and the claim are written once across every package", () => {
  const files = [...new Bun.Glob("packages/*/src/**/*.ts").scanSync(REPO_ROOT)]
    .map(file => file.split("\\").join("/")).sort();
  // The glob has to be finding the packages, or every scan below is vacuous.
  expect(files.length).toBeGreaterThan(100);
  expect(files).toContain("packages/planner/src/provenance.ts");
  const source = new Map(files.map(file => [file, readFileSync(join(REPO_ROOT, file), "utf8")]));

  // One declaration each, in the leaf module, and no other file spells any of
  // them out. The claim's distinctive prefix is enough to catch a re-typed
  // copy whether it is concatenation or a template literal, which is how the
  // four verifiers used to spell it.
  for (const literal of ["hv-provenance/1.0", "AI-generated video; content credentials", "c2pa-style"]) {
    expect({ literal, files: files.filter(file => source.get(file)!.includes(literal)) })
      .toEqual({ literal, files: ["packages/planner/src/provenance.ts"] });
  }

  // And the readers reach for them: the assembler that writes a manifest and
  // the three generator modules that verify one all import the module. Each
  // of those three keeps its own flow-specific refusal message and its own
  // extra render-record comparison; only the identity check moved.
  for (const file of ["packages/generator/src/dialogue-replacement.ts", "packages/generator/src/edit-source-media.ts", "packages/generator/src/sound-media.ts"]) {
    expect({ file, calls: /provenanceMatches\(/.test(source.get(file)!) }).toEqual({ file, calls: true });
  }
  const importers = files.filter(file => /from "\.\.\/\.\.\/planner\/src\/provenance"/.test(source.get(file)!));
  expect(importers).toEqual([
    "packages/assembler/src/index.ts",
    "packages/generator/src/dialogue-replacement.ts",
    "packages/generator/src/edit-source-media.ts",
    "packages/generator/src/sound-media.ts",
  ]);
});

test("no date literal can be frozen into the assembler's manifest again", () => {
  const assembler = readFileSync(join(REPO_ROOT, "packages/assembler/src/index.ts"), "utf8");
  // The defect was a date literal inside the manifest constructor. Any
  // date-shaped literal anywhere in the file is refused, so the next person
  // who wants a constant assembly time has to defeat this deliberately rather
  // than by writing the obvious thing.
  expect(assembler.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g)).toBeNull();
  // The field is supplied by the caller and validated, not computed here: the
  // assembler must not read a clock of its own either, or a caller that
  // forgot to pass one would get a plausible-looking manifest anyway.
  expect(assembler).toMatch(/assembledAt: provenanceAssembledAt\(opts\.assembledAt\)/);
  expect(assembler.match(/new Date\(\)|Date\.now\(\)/g)).toBeNull();

  // `assembledAt` is a required option with no default, so a caller that
  // forgets it is a type error rather than a 1970 manifest.
  expect(assembler).toMatch(/^\s*assembledAt: string;$/m);
  expect(assembler).not.toMatch(/assembledAt\?: string/);
  expect(assembler).not.toMatch(/opts: AssembleOptions = \{\}/);
});

test("the two production call sites pass a clock, not a constant", () => {
  const worker = readFileSync(join(REPO_ROOT, "packages/queue/src/worker.ts"), "utf8");
  const takes = readFileSync(join(REPO_ROOT, "packages/queue/src/take-exports.ts"), "utf8");
  // The worker's own `now()` -- the same clock that stamps the lease and the
  // completion -- reaches both export paths.
  expect(worker).toMatch(/assembledAt: new Date\(now\(\)\)\.toISOString\(\)/);
  expect(worker).toMatch(/exportShotTakes\([\s\S]{0,240}?new Date\(now\(\)\)\.toISOString\(\)/);
  // And the take path takes the instant as a parameter rather than reading a
  // clock, so it cannot invent one of its own.
  expect(takes).toMatch(/assembledAt:string/);
  expect(takes).toMatch(/\{assembledAt,fps:30,/);
  expect(takes.match(/new Date\(\)|Date\.now\(\)/g)).toBeNull();
});
