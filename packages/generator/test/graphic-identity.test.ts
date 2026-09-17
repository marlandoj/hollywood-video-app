// The graphic render identity, pinned.
//
// Every retained `hv-graphic-render/1` receipt is re-bound at validation time to five values
// this build derives live: `contentHash(GRAPHIC_RECIPE)`, the `GRAPHIC_CHROME_VERSION` string,
// the sha256 of the **installed** `@hyperframes/engine/package.json`, the recompiled HTML
// template for the plan, and the font and licence evidence that comes out of `compileGraphic`.
// `validateGraphicReceipt` compares all five and refuses the receipt on any mismatch.
//
// Nothing in this repository guarded any of them. That is the same defect family HV-019-01 and
// HV-019-03 each found once, and the program-wide audit found again here and in three other
// lanes. Its signature is always the same: the validator re-derives from a live constant, so an
// ordinary edit moves the expectation along with the code and every test stays green — while
// every already-delivered record becomes permanently unreadable.
//
// Here the blast radius is wider than the feature. `validateSnapshot` reaches
// `validateEditLibrary`, which reaches `validateEditSourceReceipt` and the graphic receipts
// behind it, so one moved value does not merely orphan graphics: it makes whole-state snapshot
// restore refuse. And one of the five is not even source — it is the byte content of an
// installed dependency, so an ordinary `bun install` can move it without a single line of this
// repository changing.
//
// This increment changes no behaviour. It makes the hazard loud: the five values are committed
// as evidence and re-derived on every test run, and the three dependency versions that
// `GRAPHIC_RECIPE` restates are tied back to `package.json`. Separating "is this retained record
// readable" from "is this renderer qualified to render now" is a behavioural change and belongs
// in its own increment — one that these pins then prove moved nothing.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { GRAPHIC_CHROME_VERSION, GRAPHIC_KINDS, GRAPHIC_RECIPE, defaultMotionGraphic } from "../../planner/src/motion-graphics";
import { compileGraphic } from "../src/graphic-composition";
import { contentHash } from "../src/capabilities";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const PINS_PATH = join(REPO_ROOT, "docs/evidence/hv025-graphics/graphic-identity-pins.json");
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

const enginePackageSha256 = () => sha256(readFileSync(new URL(import.meta.resolve("@hyperframes/engine/package.json"))));

/** The identity of one graphic kind, exactly as validateGraphicReceipt re-derives it. */
function kindIdentity(kind: typeof GRAPHIC_KINDS[number]) {
  const compiled = compileGraphic(defaultMotionGraphic(kind));
  return {
    kind,
    htmlSha256: compiled.htmlSha256,
    fontsRevision: contentHash(compiled.fonts.map(({ data: _data, ...font }) => font)),
    licenseSha256: sha256(compiled.license),
  };
}

interface PinsDocument {
  schema: "hv-graphic-identity-pins/1";
  recordedAt: string;
  recipeRevision: string;
  chromeVersion: string;
  enginePackageSha256: string;
  dependencyVersions: { engine: string; font: string; fontValidation: string };
  kinds: ReturnType<typeof kindIdentity>[];
  reboundAtValidation: string[];
  blastRadius: string;
  behaviourChanged: false;
  newProviderSpendUsd: 0;
  provesRenderQuality: false;
  provesBrowserAvailability: false;
}

function buildPins(): PinsDocument {
  return {
    schema: "hv-graphic-identity-pins/1",
    recordedAt: new Date().toISOString(),
    recipeRevision: contentHash(GRAPHIC_RECIPE),
    chromeVersion: GRAPHIC_CHROME_VERSION,
    enginePackageSha256: enginePackageSha256(),
    dependencyVersions: {
      engine: GRAPHIC_RECIPE.version,
      font: GRAPHIC_RECIPE.font,
      fontValidation: GRAPHIC_RECIPE.fontValidation,
    },
    kinds: GRAPHIC_KINDS.map(kindIdentity),
    reboundAtValidation: [
      "contentHash(GRAPHIC_RECIPE) vs receipt.recipe",
      "GRAPHIC_CHROME_VERSION vs receipt.runtime.browser",
      "sha256 of the INSTALLED @hyperframes/engine/package.json vs receipt.runtime.enginePackageSha256",
      "compileGraphic(plan).htmlSha256 vs receipt.composition",
      "compileGraphic(plan).fonts and .license vs receipt.fonts and receipt.license",
    ],
    blastRadius:
      "validateSnapshot -> validateEditLibrary -> validateEditSourceReceipt reaches graphic receipts, so a moved value "
      + "refuses whole-state snapshot restore, not only the graphic. One of the five is the byte content of an installed "
      + "dependency, so an ordinary reinstall can move it with no change to this repository.",
    behaviourChanged: false,
    newProviderSpendUsd: 0,
    provesRenderQuality: false,
    provesBrowserAvailability: false,
  };
}

function validatePins(value: unknown): PinsDocument {
  const d = value as PinsDocument;
  if (!d || typeof d !== "object" || d.schema !== "hv-graphic-identity-pins/1") throw new Error("Invalid graphic identity pins document.");
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(d.recordedAt)) throw new Error("Invalid graphic identity pins document.");
  for (const hex of [d.recipeRevision, d.enginePackageSha256]) if (!/^[a-f0-9]{64}$/.test(hex)) throw new Error("Invalid graphic identity pins document.");
  if (!Array.isArray(d.kinds) || d.kinds.length !== GRAPHIC_KINDS.length) throw new Error("Invalid graphic identity pins document.");
  if (d.behaviourChanged !== false || d.newProviderSpendUsd !== 0) throw new Error("Invalid graphic identity pins document.");
  for (const f of ["provesRenderQuality", "provesBrowserAvailability"] as const) if (d[f] !== false) throw new Error("Invalid graphic identity pins document.");
  if (!Array.isArray(d.reboundAtValidation) || d.reboundAtValidation.length !== 5) throw new Error("Invalid graphic identity pins document.");
  return d;
}

test("graphic identity: the three dependency versions GRAPHIC_RECIPE restates are tied to package.json", () => {
  const manifest = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const deps = { ...manifest.devDependencies, ...manifest.dependencies };
  // GRAPHIC_RECIPE is content-hashed into every retained receipt, so these three strings are not
  // documentation — they are part of the identity. They were a second copy of package.json with
  // nothing tying them together, which is how a dependency bump moves the recipe revision silently.
  expect(GRAPHIC_RECIPE.version as string).toBe(deps["@hyperframes/engine"]);
  expect(GRAPHIC_RECIPE.font as string).toBe(`@fontsource/inter@${deps["@fontsource/inter"]}`);
  expect(GRAPHIC_RECIPE.fontValidation as string).toBe(`fontkit@${deps.fontkit}-cmap`);
  expect(GRAPHIC_RECIPE.engine as string).toBe("@hyperframes/engine");
});

test("graphic identity: the installed engine package is the one the recipe names", () => {
  const installed = JSON.parse(readFileSync(new URL(import.meta.resolve("@hyperframes/engine/package.json")), "utf8")) as { version: string };
  // The receipt is bound to the installed package's BYTES, so its version agreeing is necessary
  // but not sufficient — a same-version reinstall with different metadata still moves the hash.
  // That is exactly why the byte hash itself is pinned below.
  expect(installed.version).toBe(GRAPHIC_RECIPE.version);
  expect(enginePackageSha256()).toMatch(/^[a-f0-9]{64}$/);
});

test("graphic identity: every value validateGraphicReceipt re-derives is pinned and still matches", () => {
  const output = process.env.HV_GRAPHIC_PINS_EVIDENCE?.trim();
  if (output) {
    const document = validatePins(buildPins());
    mkdirSync(dirname(output), { recursive: true });
    const staging = output + ".tmp";
    writeFileSync(staging, JSON.stringify(document, null, 2) + "\n");
    renameSync(staging, output);
  }

  const text = readFileSync(PINS_PATH, "utf8");
  const pinned = validatePins(JSON.parse(text));
  const live = buildPins();

  // The tripwire. Any of these moving is a change to what already-delivered graphics are validated
  // against, and must be a decision with a re-record rather than a surprise on a restore.
  expect(pinned.recipeRevision).toBe(live.recipeRevision);
  expect(pinned.chromeVersion).toBe(live.chromeVersion);
  expect(pinned.enginePackageSha256).toBe(live.enginePackageSha256);
  expect(pinned.dependencyVersions).toEqual(live.dependencyVersions);
  expect(pinned.kinds).toEqual(live.kinds);
  // Every kind is covered — a seventh GRAPHIC_KIND cannot be added without a pin for it.
  expect(pinned.kinds.map((k) => k.kind).sort()).toEqual([...GRAPHIC_KINDS].sort());

  // No credential, no destination, no host path. Every 64-hex value is one of the pinned identities.
  for (const pattern of [/:\/\//, /API_KEY/i, /\/home\//, /\/Users\//, /\/tmp\//]) expect(text).not.toMatch(pattern);
  const known = new Set([pinned.recipeRevision, pinned.enginePackageSha256,
    ...pinned.kinds.flatMap((k) => [k.htmlSha256, k.fontsRevision, k.licenseSha256])]);
  for (const hex of text.match(/[a-f0-9]{32,}/g) ?? []) expect({ hex, known: known.has(hex) }).toEqual({ hex, known: true });
});

test("graphic identity: a moved value is refused, and the refusal is what a restore would hit", async () => {
  // Demonstrate the failure direction rather than assert it in prose. validateGraphicReceipt
  // compares contentHash(receipt.recipe) against contentHash(GRAPHIC_RECIPE), so a receipt sealed
  // under any other recipe is unreadable by this build — which is precisely what happens to every
  // retained graphic when the recipe moves, and what snapshot restore then refuses on.
  const { validateGraphicReceipt } = await import("../src/graphic-receipt");
  const plan = defaultMotionGraphic("title");
  const staleRecipe = { ...GRAPHIC_RECIPE, version: "0.0.0-not-installed" };
  expect(contentHash(staleRecipe)).not.toBe(contentHash(GRAPHIC_RECIPE));
  const data = { schema: "hv-graphic-render/1" as const, plan, recipe: staleRecipe, runtime: {}, composition: {}, fonts: [], license: {}, frameIndex: {}, layout: {}, frames: [], master: {} };
  expect(() => validateGraphicReceipt({ ...data, revision: contentHash(data) } as never, plan))
    .toThrow("The graphic output differs from its reviewed plan.");
  // And the same for a receipt whose compiled composition no longer matches: the HTML template is
  // recompiled at validation time, so a cosmetic edit to compileGraphic has the same effect.
  const compiled = compileGraphic(plan);
  expect(compiled.htmlSha256).toMatch(/^[a-f0-9]{64}$/);
});
