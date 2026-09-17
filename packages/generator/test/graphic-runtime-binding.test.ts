/**
 * HV-025-02 — a retained graphic receipt is evidence, not a claim about this host.
 *
 * `validateGraphicReceipt` used to require `receipt.runtime.browser` to equal
 * `"HeadlessChrome/" + GRAPHIC_CHROME_VERSION` and
 * `receipt.runtime.enginePackageSha256` to equal
 * `graphicHash(readFileSync(import.meta.resolve("@hyperframes/engine/package.json")))`
 * — recomputed, from the installed package, every time a receipt was validated.
 * So a retained receipt was re-bound at each validation to whatever host was
 * doing the validating.
 *
 * The blast radius was not graphics. `validateSnapshot` reaches
 * `validateEditLibrary` → `validateEditSourceReceipt` → `editOriginalJob` →
 * `validateGraphicOutput` → `validateGraphicReceipt`, so bumping
 * `@hyperframes/engine`, or letting bun re-resolve the lockfile so that one
 * package.json's bytes differ at all, or moving the pinned Chrome build, made
 * **every state snapshot refuse to restore** for every project whose editorial
 * library held a single graphic source. A restore is a cold process, so the
 * in-process receipt cache could not soften it.
 *
 * Nothing in the repository failed at the moment of such a bump, and that is
 * the part worth naming: every test built its receipt with
 * `enginePackageSha256: graphicHash(readFileSync(import.meta.resolve(…)))` and
 * `browser: "HeadlessChrome/" + GRAPHIC_CHROME_VERSION`, in the same process
 * that then validated it, so the two sides always agreed. The expectation was
 * derived from the same live source it was meant to pin.
 *
 * The fixture this file reads is the missing half: a receipt recorded on a
 * different host, checked in as bytes, whose runtime values no test computes.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { contentHash } from "../src/capabilities";
import { graphicHash } from "../src/graphic-fonts";
import {
  GRAPHIC_BROWSER_SHAPE, assertQualifiedGraphicRuntime, installedGraphicEngineVersion,
  validateGraphicReceipt, type GraphicRenderReceipt,
} from "../src/graphic-receipt";
import { GRAPHIC_CHROME_VERSION, GRAPHIC_RECIPE } from "../../planner/src/motion-graphics";
import { graphicInventory, graphicJobPlan, validateGraphicOutput } from "../../planner/src/graphic-jobs";

const REPO_ROOT = join(import.meta.dir, "..", "..", "..");
const FIXTURE = join(import.meta.dir, "fixtures", "graphic-receipt-foreign-runtime.json");
const foreign = (): GraphicRenderReceipt => JSON.parse(readFileSync(FIXTURE, "utf8")) as GraphicRenderReceipt;

test("the fixture really is foreign, or every case below is vacuous", () => {
  const receipt = foreign();
  // If any of these ever coincides with this host, the fixture has stopped
  // being a receipt from somewhere else and the suite proves nothing.
  expect(receipt.runtime.browser).not.toBe("HeadlessChrome/" + GRAPHIC_CHROME_VERSION);
  expect(receipt.runtime.browser).not.toBe("Chrome/" + GRAPHIC_CHROME_VERSION);
  expect(receipt.runtime.enginePackageSha256)
    .not.toBe(graphicHash(readFileSync(new URL(import.meta.resolve("@hyperframes/engine/package.json")))));
  expect(receipt.runtime.platform).not.toBe(`${process.platform}/${process.arch}`);
  // And it is a receipt, not a blob: the revision is the hash of its own body,
  // read from the checked-in bytes rather than recomputed from live constants.
  const { revision, ...data } = receipt;
  expect(revision).toBe(contentHash(data));
  expect(receipt.schema).toBe("hv-graphic-render/1");
});

test("a receipt recorded on another qualified host still validates", () => {
  const receipt = foreign();
  expect(validateGraphicReceipt(receipt, receipt.plan)).toBe(receipt);
});

test("the receipt still has to name a runtime, in the right shape", () => {
  // Dropping the live comparison is not dropping the field. A receipt that
  // cannot say what rendered it is still refused.
  for (const [label, browser] of [
    ["empty", ""],
    ["a bare version", "131.0.6778.85"],
    ["another browser", "Firefox/131.0"],
    ["a partial version", "HeadlessChrome/131.0"],
    ["a name with no version", "HeadlessChrome/"],
    ["trailing text", "HeadlessChrome/131.0.6778.85 (foo)"],
  ] as const) {
    const receipt = foreign();
    receipt.runtime.browser = browser;
    const { revision: _drop, ...data } = receipt;
    const resealed = { ...data, revision: contentHash(data) } as GraphicRenderReceipt;
    expect({ label, threw: (() => { try { validateGraphicReceipt(resealed, resealed.plan); return false; } catch { return true; } })() })
      .toEqual({ label, threw: true });
  }
  // The accepted shape is any Chrome build string, which is what the fixture
  // carries and what this host would produce.
  expect(GRAPHIC_BROWSER_SHAPE.test("HeadlessChrome/131.0.6778.85")).toBe(true);
  expect(GRAPHIC_BROWSER_SHAPE.test("Chrome/" + GRAPHIC_CHROME_VERSION)).toBe(true);
  expect(GRAPHIC_BROWSER_SHAPE.test("HeadlessChrome/131.0.6778")).toBe(false);

  // Platform and the three hashes are still required.
  for (const mutate of [
    (r: GraphicRenderReceipt) => { r.runtime.platform = "sunos/x64"; },
    (r: GraphicRenderReceipt) => { r.runtime.platform = "linux"; },
    (r: GraphicRenderReceipt) => { r.runtime.enginePackageSha256 = "not-a-hash"; },
    (r: GraphicRenderReceipt) => { r.runtime.browserSha256 = ""; },
    (r: GraphicRenderReceipt) => { r.runtime.ffmpegSha256 = "abc"; },
  ]) {
    const receipt = foreign();
    mutate(receipt);
    const { revision: _drop, ...data } = receipt;
    const resealed = { ...data, revision: contentHash(data) } as GraphicRenderReceipt;
    expect(() => validateGraphicReceipt(resealed, resealed.plan)).toThrow();
  }
});

test("render admission still refuses an unqualified host", () => {
  // The check the validator was doing by accident, moved to where it belongs.
  // A foreign browser or a foreign engine version stops a *new* render.
  expect(() => assertQualifiedGraphicRuntime("HeadlessChrome/131.0.6778.85", GRAPHIC_RECIPE.version))
    .toThrow("Install the pinned graphics Chrome version");
  expect(() => assertQualifiedGraphicRuntime("HeadlessChrome/" + GRAPHIC_CHROME_VERSION, "0.0.1"))
    .toThrow("Install the qualified graphics engine");
  expect(() => assertQualifiedGraphicRuntime("HeadlessChrome/" + GRAPHIC_CHROME_VERSION, GRAPHIC_RECIPE.version))
    .not.toThrow();
  expect(() => assertQualifiedGraphicRuntime("Chrome/" + GRAPHIC_CHROME_VERSION, GRAPHIC_RECIPE.version))
    .not.toThrow();
  // The error names the version the host has, so an operator does not have to
  // guess what is installed.
  expect(() => assertQualifiedGraphicRuntime("HeadlessChrome/" + GRAPHIC_CHROME_VERSION, "0.9.99")).toThrow("this host has 0.9.99");
});

test("the engine version is declared in two places and they are held equal", () => {
  // `GRAPHIC_RECIPE.version` is what admission compares against;
  // the root package.json is what bun installs. Two records of one fact.
  const root = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  expect(root.dependencies?.["@hyperframes/engine"]).toBe(GRAPHIC_RECIPE.version);
  // And the version actually installed is that one, so this host is qualified
  // and the admission check above is not passing by accident.
  expect(installedGraphicEngineVersion()).toBe(GRAPHIC_RECIPE.version);
});

test("the validator no longer reads the installed engine or the pinned browser version", () => {
  const source = readFileSync(join(REPO_ROOT, "packages/generator/src/graphic-receipt.ts"), "utf8");
  const validator = source.slice(source.indexOf("export function validateGraphicReceipt"));
  const body = validator.slice(0, validator.indexOf("\n}\n"));
  // The two live reads that re-bound a retained receipt to the validating
  // host. Neither may appear inside the validator again.
  expect(body).not.toContain("GRAPHIC_CHROME_VERSION");
  expect(body).not.toContain("import.meta.resolve");
  // The slice has to have found the function, or the two assertions above are
  // satisfied by an empty string.
  expect(body).toContain("editRecord(receipt");
  expect(body.length).toBeGreaterThan(1000);
  // Both live reads still exist in the file -- in the admission helper, which
  // is where they belong.
  expect(source).toContain("GRAPHIC_CHROME_VERSION");
  expect(source).toContain("import.meta.resolve");
});

test("the restore path reaches this receipt, and a foreign one no longer stops it", () => {
  // The blast radius, exercised where the chain actually joins. `validateSnapshot`
  // reaches `validateEditLibrary` -> `validateEditSourceReceipt` ->
  // `editOriginalJob` -> `validateGraphicOutput` -> `validateGraphicReceipt`,
  // and this is `validateGraphicOutput`: one hop below `editOriginalJob` and
  // three below `validateSnapshot`. Building a whole snapshot here would add a
  // project, an editorial library and a file inventory without exercising any
  // further link in *this* chain, so the hop count is stated rather than
  // implied.
  const report = foreign();
  const projectId = "11111111-1111-4111-8111-111111111111";
  const id = "22222222-2222-4222-8222-222222222222";
  const specData = {
    schema: "hv-owned-graphic/1" as const, projectId, id: "33333333-3333-4333-8333-333333333333",
    label: "A graphic recorded elsewhere", plan: report.plan, createdAt: "2026-03-04T05:06:07.000Z",
  };
  const spec = {...specData, revision: contentHash(specData)};
  const graphicRender = graphicJobPlan(spec, "local", graphicHash(Buffer.from("request")), Date.parse("2026-03-04T05:06:08.000Z"));
  const prefix = projectId + "/" + id + "/graphic-test/";
  const outputData = {
    schema: "hv-graphic-output/1" as const, planRevision: graphicRender.revision, report,
    masterPath: prefix + "graphic.mkv", manifestPath: prefix + "graphic.json",
    files: graphicInventory(report).map(entry => ({path: prefix + entry.file, sha256: entry.sha256 ?? graphicHash(Buffer.from(entry.file)), bytes: entry.bytes ?? 100})),
  };
  const output = {...outputData, revision: contentHash(outputData)};
  // The fields `validateGraphicJob` requires of a motion-graphic job: isolated
  // media, no screenplay, no animatic, no provider budget.
  const job = {
    projectId, id, stage: "motion-graphic", graphicRender, graphicOutput: output,
    rightsAttestedAt: "2026-03-04T05:06:06.000Z", scriptText: "", scriptVersion: 0,
    animaticJobId: null, animaticApprovedAt: null, totalFrames: report.plan.frames,
    costCapUsd: 0, budgetReservedUsd: 0, retryPolicy: {maxRetries: 2, backoffMs: 1000},
    timeoutMs: 120_000, tier: "free", status: "done", idempotencyKey: id,
  } as unknown as Parameters<typeof validateGraphicOutput>[0];

  // With the receipt treated as evidence, the chain passes.
  expect(() => validateGraphicOutput(job, output)).not.toThrow();
  // And the receipt really is the foreign one, so this is the case that used
  // to take a whole state snapshot down.
  expect(output.report.runtime.enginePackageSha256)
    .not.toBe(graphicHash(readFileSync(new URL(import.meta.resolve("@hyperframes/engine/package.json")))));
});

test("the render path admits through the shared check, and nowhere else", () => {
  // This link's guard is a source scan, and that is a limitation rather than a
  // choice: `renderMotionGraphic` launches a real Chrome and is gated behind
  // `HV_GRAPHICS_CHROME_PATH`, which neither this container nor CI provides,
  // so `packages/generator/test/motion-graphics.test.ts` and
  // `packages/generator/test/edit-graphic-sources.test.ts` are the only suites
  // that could cover it behaviourally and they skip here. Removing the
  // admission call from the render path was measured green against every
  // runnable suite, so the scan exists because nothing else can see it.
  //
  // Comments are stripped first: a comment quoting the expected call defeated
  // exactly this shape of guard twice earlier in this program.
  const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  expect(strip("// assertQualifiedGraphicRuntime(browser)")).toBe("");
  const render = strip(readFileSync(join(REPO_ROOT, "packages/generator/src/graphic-render.ts"), "utf8"));

  // The admission check is called with the browser this session reported.
  expect(render).toMatch(/const browser\s*=\s*await session\.browser\.version\(\);\s*assertQualifiedGraphicRuntime\(browser\);/);
  // And the render path does not re-implement either half of it: the old
  // inline `endsWith("/"+GRAPHIC_CHROME_VERSION)` is gone, and the pinned
  // version is not named there at all except in the re-export.
  expect(render).not.toContain('endsWith("/"+GRAPHIC_CHROME_VERSION)');
  expect(render.match(/GRAPHIC_CHROME_VERSION/g)).toEqual(["GRAPHIC_CHROME_VERSION"]);
  expect(render).toMatch(/export \{GRAPHIC_CHROME_VERSION\}/);
});
