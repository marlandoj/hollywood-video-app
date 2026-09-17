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
  GRAPHIC_BROWSER_SHAPE, admitGraphicSession, assertQualifiedGraphicRuntime, installedGraphicEngineVersion,
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
  // being a receipt from somewhere else and the suite proves nothing. These
  // are live reads, so a coincidence fails here loudly instead of quietly
  // hollowing out the four cases below.
  //
  // The platform is the fragile one: the validator admits only six values, so
  // the fixture cannot carry a synthetic platform, and `darwin/arm64` fails
  // this case on an Apple-Silicon developer machine. CI and this container are
  // `linux/x64`. If that changes, move the fixture's platform rather than
  // deleting the assertion.
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
  // Passing `receipt.plan` as the expected plan makes the plan comparison
  // self-satisfied, so the binding to the plan is asserted separately: a
  // receipt offered against a different plan is still refused.
  const other = { ...receipt.plan, margin: receipt.plan.margin + 1 };
  expect(() => validateGraphicReceipt(receipt, other)).toThrow();
});

test("the receipt still has to name a runtime, in the right shape", () => {
  // Dropping the live comparison is not dropping the field. A receipt that
  // cannot say what rendered it is still refused.
  for (const [label, browser] of [
    ["empty", ""],
    ["a bare version", "131.0.6778.85"],
    ["another browser", "Firefox/131.0"],
    // A four-part version on a browser that is not Chrome. Without this row
    // every rejection above is explained by the version arity alone, and the
    // name half of the shape is unpinned: widening the alternation to
    // `[A-Za-z]+` would still reject all of them.
    ["another browser, four-part version", "Firefox/131.0.6778.85"],
    ["a Chrome-ish name", "NotChrome/131.0.6778.85"],
    ["a partial version", "HeadlessChrome/131.0"],
    ["a name with no version", "HeadlessChrome/"],
    ["trailing text", "HeadlessChrome/131.0.6778.85 (foo)"],
  ] as const) {
    const receipt = foreign();
    receipt.runtime.browser = browser;
    const { revision: _drop, ...data } = receipt;
    const resealed = { ...data, revision: contentHash(data) } as GraphicRenderReceipt;
    // The message matters as much as the throw: under the shipped defect the
    // whole fixture is foreign, so every one of these would throw for the
    // wrong reason and the case would pass while proving nothing.
    const refusal = (() => {
      try { validateGraphicReceipt(resealed, resealed.plan); return "accepted"; }
      catch (error) { return (error as Error).message; }
    })();
    expect({ label, refusal })
      .toEqual({ label, refusal: "The retained graphic receipt does not name the runtime that produced it." });
  }
  // The accepted shape is any Chrome build string, which is what the fixture
  // carries and what this host would produce.
  expect(GRAPHIC_BROWSER_SHAPE.test("HeadlessChrome/131.0.6778.85")).toBe(true);
  expect(GRAPHIC_BROWSER_SHAPE.test("Chrome/" + GRAPHIC_CHROME_VERSION)).toBe(true);
  expect(GRAPHIC_BROWSER_SHAPE.test("HeadlessChrome/131.0.6778")).toBe(false);
  expect(GRAPHIC_BROWSER_SHAPE.test("Firefox/131.0.6778.85")).toBe(false);

  // Platform and the three hashes are still required, each refused by name.
  const RUNTIME = "The retained graphic receipt does not name the runtime that produced it.";
  const HASH = "Retain a valid graphic revision.";
  for (const [label, mutate, message] of [
    ["an unknown platform", (r: GraphicRenderReceipt) => { r.runtime.platform = "sunos/x64"; }, RUNTIME],
    ["a platform with no architecture", (r: GraphicRenderReceipt) => { r.runtime.platform = "linux"; }, RUNTIME],
    ["an engine hash that is not one", (r: GraphicRenderReceipt) => { r.runtime.enginePackageSha256 = "not-a-hash"; }, HASH],
    ["an empty browser hash", (r: GraphicRenderReceipt) => { r.runtime.browserSha256 = ""; }, HASH],
    ["a truncated ffmpeg hash", (r: GraphicRenderReceipt) => { r.runtime.ffmpegSha256 = "abc"; }, HASH],
  ] as const) {
    const receipt = foreign();
    mutate(receipt);
    const { revision: _drop, ...data } = receipt;
    const resealed = { ...data, revision: contentHash(data) } as GraphicRenderReceipt;
    const refusal = (() => {
      try { validateGraphicReceipt(resealed, resealed.plan); return "accepted"; }
      catch (error) { return (error as Error).message; }
    })();
    expect({ label, refusal }).toEqual({ label, refusal: message });
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

test("admission is wired to the installed engine, and the render path gets its browser only through it", async () => {
  // Every assertion above supplies `engineVersion` itself. That leaves the
  // wiring -- which version the production path actually compares -- untested,
  // and it used to be a default parameter, so re-pointing it at
  // `GRAPHIC_RECIPE.version` would have made the check `x !== x` with the whole
  // suite green. `admitGraphicSession` is that wiring, and it takes a
  // duck-typed session so it runs without Chrome.
  const session = (browser: string) => ({ browser: { version: async () => browser } });
  // The admitted string is returned, so the receipt records what was checked
  // rather than a second read of it.
  await expect(admitGraphicSession(session("HeadlessChrome/" + GRAPHIC_CHROME_VERSION)))
    .resolves.toBe("HeadlessChrome/" + GRAPHIC_CHROME_VERSION);
  await expect(admitGraphicSession(session("Chrome/" + GRAPHIC_CHROME_VERSION)))
    .resolves.toBe("Chrome/" + GRAPHIC_CHROME_VERSION);
  await expect(admitGraphicSession(session("HeadlessChrome/131.0.6778.85")))
    .rejects.toThrow("Install the pinned graphics Chrome version");
  // The engine half of the wiring cannot be shown by value -- the installed
  // version and the recipe version are equal on a qualified host, which is the
  // point of case 5 -- so it is shown by source: this is the one call, and it
  // names the installed read.
  const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const receiptSource = strip(readFileSync(join(REPO_ROOT, "packages/generator/src/graphic-receipt.ts"), "utf8"));
  const admit = receiptSource.slice(receiptSource.indexOf("export async function admitGraphicSession"));
  expect(admit).toContain("assertQualifiedGraphicRuntime(browser,installedGraphicEngineVersion())");
  // Two occurrences in the file and no others anywhere: the declaration and
  // that one call. A second caller could supply a different engine version.
  expect(receiptSource.match(/assertQualifiedGraphicRuntime\(/g)?.length).toBe(2);
  const others = new Bun.Glob("packages/*/src/**/*.ts").scanSync(REPO_ROOT);
  expect([...others].filter(file => file !== "packages/generator/src/graphic-receipt.ts"
    && strip(readFileSync(join(REPO_ROOT, file), "utf8")).includes("assertQualifiedGraphicRuntime("))).toEqual([]);
  // And it has no default to slip back in.
  expect(receiptSource).toContain("assertQualifiedGraphicRuntime(browser:string,engineVersion:string)");
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
  // Comments are stripped before anything is asserted. The first draft of this
  // case did not strip, and this file's own header comment quotes both live
  // reads -- so the "they still exist" half was satisfied by prose and would
  // have held even if the admission helper had stopped reading the package.
  const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  expect(strip("/* import.meta.resolve */ code // GRAPHIC_CHROME_VERSION")).toBe(" code ");
  const source = strip(readFileSync(join(REPO_ROOT, "packages/generator/src/graphic-receipt.ts"), "utf8"));
  const between = (from: string, to: string) => {
    const start = source.indexOf(from);
    expect(start).toBeGreaterThan(-1);
    const end = source.indexOf(to, start);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  };
  // The two live reads that re-bound a retained receipt to the validating
  // host. Neither may appear inside the validator again.
  const body = between("export function validateGraphicReceipt", "\n}\n");
  expect(body).not.toContain("GRAPHIC_CHROME_VERSION");
  expect(body).not.toContain("import.meta.resolve");
  // The slice has to have found the function, or the two assertions above are
  // satisfied by an empty string.
  expect(body).toContain("editRecord(receipt");
  expect(body.length).toBeGreaterThan(1000);
  // Both live reads still exist -- each inside the admission helper that owns
  // it, not merely somewhere in the file.
  expect(between("export function installedGraphicEngineVersion", "\n}\n"))
    .toContain('import.meta.resolve("@hyperframes/engine/package.json")');
  expect(between("export function assertQualifiedGraphicRuntime", "\n}\n"))
    .toContain("GRAPHIC_CHROME_VERSION");
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
  // `renderMotionGraphic` launches a real Chrome and is gated behind
  // `HV_GRAPHICS_CHROME_PATH`, which neither this container nor CI provides,
  // so `packages/generator/test/motion-graphics.test.ts` and
  // `packages/generator/test/edit-graphic-sources.test.ts` skip here and this
  // link's guard is a source scan. Removing the admission call was measured
  // green against every runnable suite, so the scan exists because nothing
  // else can see it -- but it is written so that the call cannot be present
  // and unreached.
  //
  // Comments are stripped first: a comment quoting the expected call defeated
  // exactly this shape of guard twice earlier in this program.
  const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  expect(strip("// admitGraphicSession(session)")).toBe("");
  const render = strip(readFileSync(join(REPO_ROOT, "packages/generator/src/graphic-render.ts"), "utf8"));

  // The browser string is obtained *from* admission, and this file has no
  // other way to obtain one: `session.browser.version` is not read here at
  // all. So the call cannot be parked in dead code beside a second, unchecked
  // read -- there is nothing to park it beside, and `browser` is what the
  // receipt records, which typecheck requires to be defined.
  expect(render).toMatch(/const browser\s*=\s*await admitGraphicSession\(session\);/);
  expect(render).not.toContain("session.browser.version");
  expect(render.match(/admitGraphicSession/g)).toEqual(["admitGraphicSession", "admitGraphicSession"]);
  expect(render).toContain("runtime:{browser,browserSha256");
  // And the render path does not re-implement either half of it: the old
  // inline `endsWith("/"+GRAPHIC_CHROME_VERSION)` is gone, the pinned version
  // is not named there at all except in the re-export, and the admission
  // helper itself is not called here.
  expect(render).not.toContain('endsWith("/"+GRAPHIC_CHROME_VERSION)');
  expect(render).not.toContain("assertQualifiedGraphicRuntime");
  expect(render.match(/GRAPHIC_CHROME_VERSION/g)).toEqual(["GRAPHIC_CHROME_VERSION"]);
  expect(render).toMatch(/export \{GRAPHIC_CHROME_VERSION\}/);
});
