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
  PROVENANCE_EARLIEST_MS, PROVENANCE_ISSUER, PROVENANCE_PLACEHOLDER_AT, PROVENANCE_SPEC, ProvenanceError,
  assertProvenanceSidecarsBeside, exportCredentialsProblem, exportSidecarProblem, provenanceAssembledAt, provenanceClaim, provenanceCredentials, provenanceMatches, provenanceSidecarAgrees, provenanceSidecarPath, type ProvenanceManifest,
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

test("the placeholder is refused, and so is a placeholder one millisecond later", () => {
  // The exact value every export carried.
  expect(PROVENANCE_PLACEHOLDER_AT).toBe("1970-01-01T00:00:00.000Z");
  expect(() => provenanceAssembledAt(PROVENANCE_PLACEHOLDER_AT)).toThrow(ProvenanceError);
  expect(() => provenanceAssembledAt(PROVENANCE_PLACEHOLDER_AT)).toThrow("not a placeholder epoch");
  // A first draft refused only that literal value, with `Date.parse(value) <= 0`.
  // The critic pass pointed out the refusal was a millisecond deep: these are
  // indistinguishable from a placeholder in any reader that truncates to
  // seconds, and all sailed through.
  for (const nearly of ["1970-01-01T00:00:00.001Z", "1970-01-02T00:00:00.000Z", "1999-12-31T23:59:59.999Z", "2019-12-31T23:59:59.999Z"]) {
    expect({ nearly, threw: (() => { try { provenanceAssembledAt(nearly); return false; } catch { return true; } })() })
      .toEqual({ nearly, threw: true });
  }
  // The bound is a stated instant, not a feeling, and it is the boundary.
  expect(PROVENANCE_EARLIEST_MS).toBe(Date.parse("2020-01-01T00:00:00.000Z"));
  expect(provenanceAssembledAt("2020-01-01T00:00:00.000Z")).toBe("2020-01-01T00:00:00.000Z");
  // And a real instant is accepted, returned unchanged, with or without millis.
  expect(provenanceAssembledAt("2026-09-17T10:00:00.000Z")).toBe("2026-09-17T10:00:00.000Z");
  expect(provenanceAssembledAt("2026-09-17T10:00:00Z")).toBe("2026-09-17T10:00:00Z");
});

test("only a UTC ISO 8601 instant is an assembly time", () => {
  for (const bad of [
    undefined, null, 0, 1_758_106_800_000, "", "not a date",
    "2026-09-17", "2026-09-17T10:00:00", "2026-09-17T10:00:00+01:00",
    "2026-13-17T10:00:00.000Z", "2026-09-17 10:00:00Z", "1969-12-31T23:59:59.999Z",
    // Dates that do not exist. A first draft matched the shape with a regular
    // expression and then trusted `Date.parse`, which rolls February 30th
    // forward two days and hour 24 to the next morning -- and stored the
    // impossible string verbatim, so the manifest said one thing and every
    // reader that re-parsed it said another.
    "2026-02-30T10:00:00Z", "2025-02-29T00:00:00Z", "2026-09-17T24:00:00Z",
    "2026-09-31T10:00:00Z", "2026-09-17T10:60:00Z", "2026-00-17T10:00:00Z", "2026-09-00T10:00:00Z",
  ]) {
    expect({ bad, threw: (() => { try { provenanceAssembledAt(bad); return false; } catch { return true; } })() })
      .toEqual({ bad, threw: true });
  }
  // A local-offset spelling is refused rather than silently reinterpreted: two
  // readers of a rights record must not be able to disagree about the hour.
  expect(() => provenanceAssembledAt("2026-09-17T10:00:00+01:00")).toThrow("UTC ISO 8601 instant");
});

test("the claim is the whole hash, written out here independently of the code that builds it", () => {
  // The critic pass changed `provenanceClaim` to interpolate one hex character
  // of the hash and measured both suites green: every assertion on the claim
  // compared it to the same function that wrote it, and the only fixed part
  // anything pinned was the prefix. So the claim is spelled out here by hand.
  expect(provenanceClaim(SHA)).toBe("AI-generated video; content credentials sha256:" + "a".repeat(64));
  expect(provenanceClaim("0".repeat(63) + "f")).toBe("AI-generated video; content credentials sha256:" + "0".repeat(63) + "f");
  // And two hashes differing only in the LAST character are distinguished, so
  // a truncating or prefix-only claim cannot pass.
  const near = "a".repeat(63) + "b";
  expect(provenanceClaim(near)).not.toBe(provenanceClaim(SHA));
  expect(provenanceMatches(manifest({ credentials: provenanceCredentials(near) }), { projectId: "project-1", sha256: SHA })).toBe(false);
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
    ["a claim bound to media differing in one last character", manifest({ credentials: provenanceCredentials("a".repeat(63) + "b") })],
    ["no credentials at all", manifest({ credentials: undefined as never })],
    // Declared type and issuer, which a first draft left unchecked while
    // single-declaring both constants.
    ["a manifest claiming to be signed", manifest({ credentials: { ...provenanceCredentials(SHA), type: "signed-c2pa" as never } })],
    ["a manifest issued by someone else", manifest({ credentials: { ...provenanceCredentials(SHA), issuer: "someone-else" as never } })],
  ] as [string, unknown][]) {
    expect({ label, matches: provenanceMatches(value, expected) }).toEqual({ label, matches: false });
  }
});

test("exactly one legacy value is tolerated on read, and nothing else is", () => {
  const expected = { projectId: "project-1", sha256: SHA };
  // Every export assembled before this increment carries the placeholder, and
  // those are retained media. The timestamp is enforced where it is written
  // and that one literal is tolerated where it is read, so a defect the user
  // did not cause does not take their existing work away.
  expect(provenanceMatches(manifest({ assembledAt: PROVENANCE_PLACEHOLDER_AT }), expected)).toBe(true);
  // While the same value is refused at the write boundary.
  expect(() => provenanceAssembledAt(PROVENANCE_PLACEHOLDER_AT)).toThrow(ProvenanceError);

  // And the tolerance is that one value. A first draft did not look at the
  // field on the read path at all, which tolerated every one of these while
  // the doc claimed a test pinned the decision.
  for (const [label, at] of [
    ["a missing assembly time", undefined],
    ["a null assembly time", null],
    ["an empty assembly time", ""],
    ["a number", 0],
    ["arbitrary text", "whenever"],
    ["a near-placeholder", "1970-01-01T00:00:00.001Z"],
    ["a date that does not exist", "2026-02-30T10:00:00Z"],
    ["a local-offset spelling", "2026-09-17T10:00:00+01:00"],
  ] as [string, unknown][]) {
    expect({ label, matches: provenanceMatches(manifest({ assembledAt: at as never }), expected) })
      .toEqual({ label, matches: false });
  }
});

test("the spec, the issuer and the claim are written once across every package", () => {
  const files = [...new Bun.Glob("packages/*/src/**/*.ts").scanSync(REPO_ROOT)]
    .map(file => file.split("\\").join("/")).sort();
  // The glob has to be finding the packages, or every scan below is vacuous.
  expect(files.length).toBeGreaterThan(100);
  expect(files).toContain("packages/planner/src/provenance.ts");
  const source = new Map(files.map(file => [file, readFileSync(join(REPO_ROOT, file), "utf8")]));

  // One declaration each, in the leaf module, and no other file spells any of
  // them out -- including the issuer, which a first draft named in its own
  // title and its acceptance criterion and then never scanned for.
  //
  // The scan is over source with string concatenation collapsed, because a
  // plain `includes` is defeated by `"hv-provenance" + "/1.0"`: the critic
  // pass re-typed all three that way in a verifier and measured the suite
  // green, so the drift this module exists to prevent walked straight back in.
  const collapsed = new Map([...source].map(([file, text]) => [file, text.replace(/["'`]\s*\+\s*["'`]/g, "")]));
  for (const literal of [PROVENANCE_SPEC, "AI-generated video; content credentials sha256:", PROVENANCE_ISSUER, "c2pa-style", "c2pa-sidecar", "provenance.c2pa"]) {
    expect({ literal, files: files.filter(file => collapsed.get(file)!.includes(literal)) })
      .toEqual({ literal, files: ["packages/planner/src/provenance.ts"] });
  }
  // The collapsing itself is exercised, so a regex that stops collapsing is a
  // failure here rather than a silently weaker scan above.
  expect('const a="hv-provenance"+"/1.0";'.replace(/["'`]\s*\+\s*["'`]/g, "")).toContain(PROVENANCE_SPEC);
  expect("const a='c2pa' + '-style';".replace(/["'`]\s*\+\s*["'`]/g, "")).toContain("c2pa-style");

  // And the readers reach for them: the assembler that writes a manifest and
  // the three generator modules that verify one all import the module. Each
  // of those three keeps its own flow-specific refusal message and its own
  // extra render-record comparison; only the identity check moved. The mixed
  // film's copied originals are verified the same way (HV-016-25).
  for (const file of ["packages/generator/src/current-film-origins-media.ts", "packages/generator/src/dialogue-replacement.ts", "packages/generator/src/edit-source-media.ts", "packages/generator/src/sound-media.ts"]) {
    expect({ file, calls: /provenanceMatches\(/.test(source.get(file)!) }).toEqual({ file, calls: true });
  }
  // Matched on the module's file name rather than one relative spelling: an
  // importer at another depth, or the intra-package `./provenance`, was
  // invisible to a first draft that pinned the exact `../../planner/src/`
  // prefix, so its exact-array assertion read as a census and was not one.
  const importers = files.filter(file => file !== "packages/planner/src/provenance.ts"
    && /from "[^"]*\/provenance"/.test(source.get(file)!));
  expect(importers).toEqual([
    "packages/assembler/src/current-film-mixed.ts",
    // HV-031-17: the credentials of the exports other stages write.
    "packages/assembler/src/export-credentials.ts",
    // HV-030-30: the feature's joined film, written by the assembler and validated with its sidecar.
    "packages/assembler/src/feature-film.ts",
    "packages/assembler/src/index.ts",
    "packages/generator/src/current-film-origins-media.ts",
    "packages/generator/src/current-film-proof-media.ts",
    "packages/generator/src/dialogue-replacement.ts",
    // HV-031-17: the picture edit, assembly and lip-sync writers that place a sidecar beside their record.
    "packages/generator/src/edit-assembly-media.ts",
    "packages/generator/src/edit-media.ts",
    "packages/generator/src/edit-source-media.ts",
    "packages/generator/src/lipsync-media.ts",
    "packages/generator/src/sound-media.ts",
    // HV-031-15: the three output validators that place a signed sidecar beside its record.
    "packages/planner/src/current-film-job-context.ts",
    "packages/planner/src/current-film-mixed-job-context.ts",
    "packages/planner/src/current-film-proof-copies.ts",
    // HV-031-17: the five stage output validators that check a record's credentials against its sidecar.
    "packages/planner/src/dialogue-jobs.ts",
    "packages/planner/src/dialogue-replacement.ts",
    "packages/planner/src/edit-assembly-jobs.ts",
    "packages/planner/src/edit-jobs.ts",
    "packages/planner/src/feature-film.ts",
    // HV-019-15: the hero-render chain's record, whose result's credentials are checked against its sidecar.
    "packages/planner/src/hero-chain.ts",
    "packages/planner/src/lipsync.ts",
    "packages/planner/src/living-script-job-context.ts",
    "packages/planner/src/sound-jobs.ts",
    // HV-031-15 review: the proof closure and media verifier, and storage import, restore and
    // snapshots, which place a sidecar beside its record and compare its bytes to it.
    "packages/storage/src/artifacts.ts",
    "packages/storage/src/snapshots.ts",
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
  expect(assembler).toMatch(/const assembledAt = provenanceAssembledAt\(opts\.assembledAt\);/);
  expect(assembler).toMatch(/^\s*assembledAt,$/m);
  // No clock of any shape: `new Date()` and `Date.now()`, and also
  // `new Date(<number>)`, which produces a frozen instant with no date-shaped
  // text and therefore evades the literal scan above.
  expect(assembler.match(/new Date\([^)]*\)|Date\.now\(\)/g)).toBeNull();

  // `assembledAt` is a required option with no default, so a caller that
  // forgets it is a type error rather than a 1970 manifest.
  expect(assembler).toMatch(/^\s*assembledAt: string;$/m);
  expect(assembler).not.toMatch(/assembledAt\?: string/);
  expect(assembler).not.toMatch(/opts: AssembleOptions = \{\}/);
});

test("the two production call sites pass a clock, not a constant", () => {
  // These are source scans and are the weaker half of criterion 5. The
  // behavioural half lives in packages/queue/test/worker.test.ts, which reads
  // a worker-written manifest with an injected clock -- because the critic
  // pass defeated the scans below twice: once with a comment containing the
  // expected text, and once by assigning over the parameter inside
  // exportShotTakes, which no regex over a call site can see.
  const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const worker = strip(readFileSync(join(REPO_ROOT, "packages/queue/src/worker.ts"), "utf8"));
  const takes = strip(readFileSync(join(REPO_ROOT, "packages/queue/src/take-exports.ts"), "utf8"));
  // Comments are removed first, so a comment quoting the expected call no
  // longer satisfies either pattern.
  expect(strip("// assembledAt: new Date(now()).toISOString()")).toBe("");
  // And neither production file freezes an instant of its own.
  for (const [file, text] of [["worker.ts", worker], ["take-exports.ts", takes]] as const) {
    expect({ file, dates: text.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g) }).toEqual({ file, dates: null });
    expect({ file, clocks: text.match(/new Date\(\d/g) }).toEqual({ file, clocks: null });
  }
  expect({ reassigned: /\bassembledAt\s*=/.test(takes) }).toEqual({ reassigned: false });
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

/**
 * HV-031-15: a record is signed or unsigned, and nothing in between. Signed, it names its sidecar by
 * the fixed name and the sha256 of its bytes; unsigned, it carries no sidecar at all. Both forms pass
 * the identity check, so exports from a host with a key and from one without are equally reusable.
 */
test("a signed record and an unsigned record both match, and nothing in between does", () => {
  const expected = { projectId: "project-1", sha256: SHA }, sidecar = { name: "provenance.c2pa" as const, sha256: "e".repeat(64) };
  expect(provenanceCredentials(SHA, sidecar)).toEqual({ type: "c2pa-sidecar", issuer: PROVENANCE_ISSUER, claim: provenanceClaim(SHA), sidecar });
  expect(provenanceMatches(manifest({ credentials: provenanceCredentials(SHA, sidecar) }), expected)).toBe(true);
  expect(provenanceMatches(manifest(), expected)).toBe(true);
  const signed = provenanceCredentials(SHA, sidecar);
  for (const [label, credentials] of [
    ["signed with no sidecar", { ...signed, sidecar: undefined }],
    ["signed naming a storage path", { ...signed, sidecar: { path: "p/j/provenance.c2pa", sha256: sidecar.sha256 } }],
    ["signed naming another file", { ...signed, sidecar: { name: "provenance.json", sha256: sidecar.sha256 } }],
    ["signed with a short digest", { ...signed, sidecar: { name: "provenance.c2pa", sha256: "e".repeat(63) } }],
    ["signed with an uppercase digest", { ...signed, sidecar: { name: "provenance.c2pa", sha256: "E".repeat(64) } }],
    ["signed with an extra field", { ...signed, sidecar: { ...sidecar, trusted: true } }],
    ["unsigned carrying a sidecar", { ...provenanceCredentials(SHA), sidecar }],
    ["signed and bound to other media", provenanceCredentials("d".repeat(64), sidecar)],
  ] as [string, unknown][]) {
    expect({ label, matches: provenanceMatches(manifest({ credentials: credentials as never }), expected) }).toEqual({ label, matches: false });
  }
  expect(() => provenanceCredentials(SHA, { name: "provenance.c2pa" })).toThrow(ProvenanceError);
  // The sidecar's artifact path is beside its record, and only a record named provenance.json has one.
  expect(provenanceSidecarPath("p/j/exports/x/provenance.json")).toBe("p/j/exports/x/provenance.c2pa");
  expect(() => provenanceSidecarPath("p/j/manifest.json")).toThrow(ProvenanceError);
});

/**
 * HV-031-15 review: outside the mixed path nothing compared a sidecar's bytes to its record, and any
 * path inside the job was accepted as one. A record and the sidecar beside it must agree, and a
 * sidecar is only ever the `provenance.c2pa` beside its own record, for the export and each take.
 */
test("a record and its sidecar's bytes agree, and a sidecar sits only beside its own record", () => {
  const digest = "e".repeat(64), signed = manifest({ credentials: provenanceCredentials(SHA, { name: "provenance.c2pa", sha256: digest }) });
  expect(provenanceSidecarAgrees(signed, digest)).toBe(true);
  expect(provenanceSidecarAgrees(manifest(), null)).toBe(true);
  expect(provenanceSidecarAgrees(signed, "f".repeat(64))).toBe(false);
  expect(provenanceSidecarAgrees(signed, null)).toBe(false);
  expect(provenanceSidecarAgrees(manifest(), digest)).toBe(false);
  expect(provenanceSidecarAgrees(null, digest)).toBe(false);
  const output = { manifestPath: "p/j/provenance.json", c2paPath: "p/j/provenance.c2pa", takeClips: [{ manifestPath: "p/j/takes/t/provenance.json", c2paPath: "p/j/takes/t/provenance.c2pa" }] };
  expect(() => assertProvenanceSidecarsBeside(output)).not.toThrow();
  expect(() => assertProvenanceSidecarsBeside({ manifestPath: "p/j/provenance.json" })).not.toThrow();
  for (const changed of [{ ...output, c2paPath: "p/j/export.mp4" }, { ...output, c2paPath: "p/j/takes/t/provenance.c2pa" },
    { ...output, takeClips: [{ manifestPath: "p/j/takes/t/provenance.json", c2paPath: "p/j/provenance.c2pa" }] }]) {
    expect(() => assertProvenanceSidecarsBeside(changed)).toThrow(ProvenanceError);
  }
});

/**
 * HV-031-17: the picture edit, the assembly, a sound mix and a dialogue or lip-sync version each carry
 * the same credential block in their own record. A stage's sealed output and that block agree in
 * exactly two ways, signed with the sidecar beside the record or unsigned with none, and a record
 * made before this increment carries no block and agrees only with an output that claims no sidecar.
 */
test("a stage's record and its sealed output agree about the sidecar exactly when signed or unsigned", () => {
  const mp4 = "a".repeat(64), sidecar = "b".repeat(64), other = "c".repeat(64), manifestPath = "p/j/edit-1/provenance.json", c2paPath = "p/j/edit-1/provenance.c2pa";
  const files = [{ path: "p/j/edit-1/conform/export.mp4", sha256: mp4 }, { path: c2paPath, sha256: sidecar }];
  const unsigned = provenanceCredentials(mp4), signed = provenanceCredentials(mp4, { name: "provenance.c2pa", sha256: sidecar });
  // The two honest forms.
  expect(exportSidecarProblem({ manifestPath }, unsigned, mp4, files.slice(0, 1))).toBeNull();
  expect(exportSidecarProblem({ manifestPath, c2paPath }, signed, mp4, files)).toBeNull();
  // A record made before HV-031-17 has no block, and agrees only with no sidecar.
  expect(exportSidecarProblem({ manifestPath }, undefined, mp4, files.slice(0, 1))).toBeNull();
  expect(exportSidecarProblem({ manifestPath, c2paPath }, undefined, mp4, files)).toContain("names it in its record");
  // Everything in between.
  expect(exportSidecarProblem({ manifestPath }, signed, mp4, files)).toContain("does not hold");
  expect(exportSidecarProblem({ manifestPath, c2paPath }, unsigned, mp4, files)).toContain("unsigned record");
  expect(exportSidecarProblem({ manifestPath, c2paPath }, provenanceCredentials(mp4, { name: "provenance.c2pa", sha256: other }), mp4, files)).toContain("differs from the bytes");
  expect(exportSidecarProblem({ manifestPath, c2paPath: "p/j/edit-1/conform/provenance.c2pa" }, signed, mp4, [...files, { path: "p/j/edit-1/conform/provenance.c2pa", sha256: sidecar }])).toContain("beside its own provenance record");
  expect(exportSidecarProblem({ manifestPath, c2paPath }, signed, mp4, files.slice(0, 1))).toContain("missing from its media");
  expect(exportSidecarProblem({ manifestPath, c2paPath }, signed, other, files)).toContain("name another export");
  // The block itself: exact keys (in any order, as jsonb returns them), the right issuer, nothing extra.
  expect(exportCredentialsProblem({ claim: signed.claim, sidecar: { sha256: sidecar, name: "provenance.c2pa" }, issuer: PROVENANCE_ISSUER, type: "c2pa-sidecar" }, mp4)).toBeNull();
  expect(exportCredentialsProblem({ ...unsigned, sidecar: { name: "provenance.c2pa", sha256: sidecar } }, mp4)).not.toBeNull();
  expect(exportCredentialsProblem({ ...unsigned, issuer: "someone-else" }, mp4)).not.toBeNull();
  expect(exportCredentialsProblem({ ...signed, sidecar: { name: "elsewhere.c2pa", sha256: sidecar } }, mp4)).not.toBeNull();
  expect(exportCredentialsProblem(null, mp4)).not.toBeNull();
});
