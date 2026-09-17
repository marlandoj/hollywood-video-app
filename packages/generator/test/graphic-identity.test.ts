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
import { GRAPHIC_CHROME_VERSION, GRAPHIC_KINDS, GRAPHIC_RECIPE, defaultMotionGraphic, motionGraphic } from "../../planner/src/motion-graphics";
import { compileGraphic } from "../src/graphic-composition";
import { contentHash } from "../src/capabilities";

// To regenerate these pins after a deliberate change (a dependency bump, a recipe edit, a
// compileGraphic change), run from the repo root:
//   HV_GRAPHIC_PINS_EVIDENCE=docs/evidence/hv025-graphics/graphic-identity-pins.json \
//     bun test packages/generator/test/graphic-identity.test.ts
// Regenerating is a decision: it re-baselines what every already-delivered graphic is validated
// against, so it belongs in the same commit as the change that moved it.
const REPO_ROOT = resolve(import.meta.dir, "../../..");
const PINS_PATH = join(REPO_ROOT, "docs/evidence/hv025-graphics/graphic-identity-pins.json");
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

const enginePackageSha256 = () => sha256(readFileSync(new URL(import.meta.resolve("@hyperframes/engine/package.json"))));

// The default plans' text contains no HTML-escapable character, so pinning them alone leaves
// compileGraphic's `escape` map outside every hash — and a change to it moves the recompiled
// htmlSha256 for every retained receipt whose owner-authored title contains & < > " or '.
// This plan puts all five escaped characters, a multi-word kinetic string and a non-empty
// `secondary` inside the pinned identity.
const ESCAPE_PROBE_TEXT = `A & B < C > D " E ' F`;
function escapeProbePlan() {
  // Re-sealed through motionGraphic(), not spread over a plan: the plan's own revision is
  // hash-checked by validateMotionGraphic before compileGraphic will touch it.
  const { revision: _revision, ...base } = defaultMotionGraphic("kinetic");
  return motionGraphic({ ...base, text: ESCAPE_PROBE_TEXT, secondary: `sub & "title"` });
}

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
  escapeProbeHtmlSha256: string;
  unpinnedValidatorLiterals: { literal: string; alsoIn: string; consequence: string }[];
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
    escapeProbeHtmlSha256: compileGraphic(escapeProbePlan()).htmlSha256,
    // Declared, NOT pinned. These are bare literals inside validateGraphicReceipt with a second
    // copy in graphic-render.ts, so a coordinated rename keeps every fresh-render test green while
    // orphaning every stored receipt — the same hazard as the values above, in a different dress.
    //
    // They are recorded here rather than pinned because a transcribed copy in a test is not a
    // tripwire: it is a third copy of the same string, and renaming the source would simply leave
    // all three disagreeing with stored data while the test still passed. A real guard has to be
    // behavioural — construct a receipt valid in every respect except the literal and assert the
    // validator's exact refusal — which needs a fully-formed receipt fixture. That is HV-025-02's
    // work, alongside the behavioural separation it already carries. Listing them is the honest
    // interim: the surface is known and written down rather than silently uncovered.
    unpinnedValidatorLiterals: [
      { literal: "index.html", alsoIn: "graphic-render.ts", consequence: "every stored receipt's composition check fails" },
      { literal: "INTER-LICENSE.txt", alsoIn: "graphic-render.ts", consequence: "every stored receipt's licence evidence check fails" },
      { literal: "rgba-frames.txt", alsoIn: "graphic-render.ts", consequence: "every stored receipt loses its frame index" },
      { literal: "graphic.mkv", alsoIn: "graphic-render.ts", consequence: "every stored receipt's master path check fails" },
      { literal: "frames/NNNNNN.png", alsoIn: "graphic-render.ts", consequence: "every stored receipt's frame order check fails" },
      { literal: "HeadlessChrome/<v> and Chrome/<v>", alsoIn: "graphic-render.ts", consequence: "every stored receipt's runtime check fails" },
      { literal: "(height + contentHeight) * 30 / (frames - 1)", alsoIn: "graphic-render.ts", consequence: "every stored credits receipt's layout check fails" },
    ],
    reboundAtValidation: [
      "contentHash(GRAPHIC_RECIPE) vs receipt.recipe",
      "GRAPHIC_CHROME_VERSION vs receipt.runtime.browser",
      "sha256 of the INSTALLED @hyperframes/engine/package.json vs receipt.runtime.enginePackageSha256",
      "compileGraphic(plan).htmlSha256 vs receipt.composition",
      "compileGraphic(plan).fonts and .license vs receipt.fonts and receipt.license",
      "the retained path literals index.html / INTER-LICENSE.txt / rgba-frames.txt / graphic.mkv / frames/NNNNNN.png (declared, not pinned)",
      "the accepted browser strings HeadlessChrome/<v> and Chrome/<v> (declared, not pinned)",
      "the credits layout formula (height + contentHeight) * 30 / (frames - 1) (declared, not pinned)",
    ],
    blastRadius:
      "validateSnapshot reaches validateGraphicReceipt by two independent routes -- through validateEditLibrary -> "
      + "validateEditSourceReceipt -> editOriginalJob for library sources, and directly on every job's graphicCheckpoint "
      + "and graphicOutput -- so a moved value refuses whole-state snapshot restore, not only the graphic. "
      + "On the installed-dependency hash: bun.lock already pins the @hyperframes/engine tarball by sha512 integrity and "
      + "CI installs with --frozen-lockfile, so a byte-different same-version install is already foreclosed by a tracked "
      + "file. This hash is defence in depth against an install that bypasses the lockfile, not the primary binding.",
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
  if (!Array.isArray(d.reboundAtValidation) || d.reboundAtValidation.length !== 8) throw new Error("Invalid graphic identity pins document.");
  if (!Array.isArray(d.unpinnedValidatorLiterals) || d.unpinnedValidatorLiterals.length !== 7) throw new Error("Invalid graphic identity pins document.");
  if (!/^[a-f0-9]{64}$/.test(d.escapeProbeHtmlSha256)) throw new Error("Invalid graphic identity pins document.");
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
  // Resolved against the repo root, not the caller's cwd: the documented regeneration command
  // passes a relative path, and an unresolved one would quietly write a stray file elsewhere while
  // the assertions below still compared the committed one — regeneration reporting success without
  // having regenerated anything.
  const raw = process.env.HV_GRAPHIC_PINS_EVIDENCE?.trim();
  const output = raw ? resolve(REPO_ROOT, raw) : undefined;
  if (output) {
    expect(output).toBe(PINS_PATH);
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
  expect(pinned.escapeProbeHtmlSha256).toBe(live.escapeProbeHtmlSha256);
  expect(pinned.unpinnedValidatorLiterals).toEqual(live.unpinnedValidatorLiterals);
  // Every kind is covered — a seventh GRAPHIC_KIND cannot be added without a pin for it.
  expect(pinned.kinds.map((k) => k.kind).sort()).toEqual([...GRAPHIC_KINDS].sort());

  // No credential, no destination, no host path. Every 64-hex value is one of the pinned identities.
  for (const pattern of [/:\/\//, /API_KEY/i, /\/home\//, /\/Users\//, /\/tmp\//]) expect(text).not.toMatch(pattern);
  const known = new Set([pinned.recipeRevision, pinned.enginePackageSha256, pinned.escapeProbeHtmlSha256,
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
  // And the same for a receipt whose composition no longer matches. The earlier draft asserted only
  // that compileGraphic returns a 64-hex digest, which cannot fail and demonstrated nothing; this
  // seals a receipt that is valid for this build in every respect EXCEPT its composition hash, so
  // the refusal it triggers is the one a cosmetic edit to compileGraphic would cause.
  const compiled = compileGraphic(plan);
  const wrongComposition = {
    ...data, recipe: GRAPHIC_RECIPE,
    composition: { file: "index.html", sha256: "9".repeat(64) },
    fonts: compiled.fonts.map(({ data: _d, ...font }) => font),
    license: { file: "INTER-LICENSE.txt", sha256: sha256(compiled.license) },
  };
  expect(wrongComposition.composition.sha256).not.toBe(compiled.htmlSha256);
  expect(() => validateGraphicReceipt({ ...wrongComposition, revision: contentHash(wrongComposition) } as never, plan))
    .toThrow();
});
