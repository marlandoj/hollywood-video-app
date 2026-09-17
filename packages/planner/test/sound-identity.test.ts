// The sound lane's recipe identity, pinned — and its two closed sets tied together.
//
// Five constants are content-hashed into delivered sound records and re-derived by the validator
// that reads them back:
//   SOUND_MIX_RECIPE         -> report.recipeRevision, checked in validateSoundOutput
//   SOUND_FINISH_RECIPE      -> the finishing report's recipe revision
//   RESTORATION_RECIPE       -> the restoration report's recipe revision
//   NARRATION_MIX_RECIPE     -> hv-narration-mix/1 report.recipeRevision, re-validated inside
//                               delivered dialogue-replacement records
//   SOUND_CONVERSION_RECIPE  -> the recipe half of soundRuntimeRevision(), stored as engineVersion
// Nothing in this repository guarded any of them. Adding one field to any leaves all 24 tests in
// the nine sound suites green (22 pass, 2 skip) while making already-delivered sound records
// unreadable — the same defect family HV-019-01 found once, HV-019-03 found five times in the
// performance lane, and HV-025-01 closed for graphics.
//
// A recipe hash is not the whole identity. validateRestorationReport re-derives the entire FFmpeg
// filter string per track, and most of it is bare literals outside RESTORATION_RECIPE, so the
// rendered string is pinned too. The finishing lane has the same shape in a module-private
// function; it is declared in the evidence rather than pinned, because exporting it would be a
// source change this increment does not make.
//
// The second half of this file closes a related one. RESTORATION_TRACKS and RESTORATION_STEMS are
// declared in sound-restoration.ts; SOUND_ROLES and SOUND_STEMS are declared in sound-session.ts.
// They agree today by coincidence of maintenance, not by construction, and a third file indexes
// the restoration outputs positionally. Widening the cue roles — which every remaining P9 clause
// (score, foley, ambience beds, auto-spotting) must do — leaves every unit test green, writes the
// new stem file while silently omitting it from the `me` and `mix` sums (sound-mixer.ts hardcodes
// the three role names), and fails a restoration session with a raw ENOENT. Tying the sets makes
// the DIVERGENCE fail loudly; it does not by itself make widening safe — see the increment doc.
//
// To regenerate these pins after a deliberate change, run from the repo root:
//   HV_SOUND_PINS_EVIDENCE=docs/evidence/hv024-sound/recipe-revision-pins.json \
//     bun test packages/planner/test/sound-identity.test.ts
// Regenerating re-baselines what every already-delivered sound version is validated against, so it
// belongs in the same commit as the change that moved it.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { SOUND_MIX_RECIPE, SOUND_ROLES, SOUND_STEMS } from "../src/sound-session";
import { SOUND_FINISH_RECIPE } from "../src/sound-finishing";
import { RESTORATION_RECIPE, RESTORATION_STEMS, RESTORATION_TRACKS, restorationFilter } from "../src/sound-restoration";
import { NARRATION_MIX_RECIPE, NARRATION_MIX_RECIPE_REVISION } from "../src/narration-mix";
import { SOUND_CONVERSION_RECIPE } from "../../generator/src/sound-audio";
import { contentHash } from "../../generator/src/capabilities";

// A fixed representative restoration track. restorationFilter renders the FFmpeg string that
// validateRestorationReport re-derives and compares per track, and most of that string is bare
// literals that do NOT live in RESTORATION_RECIPE (`nt=w`, `tr=0`, `ad=0.5`, `nl=average`,
// `bm=1.25`, `om=o`, the pad and window lengths). Pinning the recipe alone leaves them uncovered:
// editing `bm=1.25` makes every delivered restoration record unreadable without moving the
// recipe hash at all. Pinning the rendered string closes that.
const FILTER_PROBE = { track: "dialogue" as const, amountDb: 12, noiseFloorDb: -40, tracking: true, smoothing: 3, reference: null } as never;
const FILTER_PROBE_FRAMES = 96000;

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const PINS_PATH = join(REPO_ROOT, "docs/evidence/hv024-sound/recipe-revision-pins.json");

interface PinsDocument {
  schema: "hv-sound-recipe-pins/1";
  recordedAt: string;
  recipes: { name: string; schema: string; revision: string; pinnedInto: string }[];
  renderedFilters: { name: string; probe: string; rendered: string; reDerivedBy: string }[];
  unpinnedReDerivedValues: { name: string; where: string; reason: string; consequence: string }[];
  closedSets: { soundRoles: string[]; soundStems: string[]; restorationTracks: string[]; restorationStems: string[] };
  setInvariants: string[];
  behaviourChanged: false;
  newProviderSpendUsd: 0;
  provesLoudnessQualification: false;
  provesRestorationQuality: false;
}

function buildPins(): PinsDocument {
  return {
    schema: "hv-sound-recipe-pins/1",
    recordedAt: new Date().toISOString(),
    recipes: [
      { name: "SOUND_MIX_RECIPE", schema: SOUND_MIX_RECIPE.schema, revision: contentHash(SOUND_MIX_RECIPE), pinnedInto: "hv-sound-result/1|2|3 report.recipeRevision, re-derived by validateSoundOutput" },
      { name: "SOUND_FINISH_RECIPE", schema: SOUND_FINISH_RECIPE.schema, revision: contentHash(SOUND_FINISH_RECIPE), pinnedInto: "the finishing report, re-derived by validateSoundFinishingReport" },
      { name: "RESTORATION_RECIPE", schema: RESTORATION_RECIPE.schema, revision: contentHash(RESTORATION_RECIPE), pinnedInto: "the restoration report, re-derived by validateRestorationReport" },
      { name: "NARRATION_MIX_RECIPE", schema: NARRATION_MIX_RECIPE.schema, revision: NARRATION_MIX_RECIPE_REVISION, pinnedInto: "hv-narration-mix/1 report.recipeRevision, re-derived by validateNarrationMix and re-validated inside delivered dialogue-replacement records" },
      { name: "SOUND_CONVERSION_RECIPE", schema: SOUND_CONVERSION_RECIPE.schema, revision: contentHash(SOUND_CONVERSION_RECIPE), pinnedInto: "the recipe half of soundRuntimeRevision(), stored as engineVersion on every sound asset, plan and report" },
    ],
    renderedFilters: [
      { name: "restorationFilter", probe: `dialogue amountDb=12 noiseFloorDb=-40 tracking smoothing=3 no-reference frames=${FILTER_PROBE_FRAMES}`, rendered: restorationFilter(FILTER_PROBE, FILTER_PROBE_FRAMES), reDerivedBy: "validateRestorationReport, per track, compared against the retained t.filter" },
    ],
    // Declared, not pinned — the same honest-disclosure shape HV-025-01 used.
    unpinnedReDerivedValues: [
      { name: "processingFilter / filterTarget", where: "packages/generator/src/sound-finishing.ts", reason: "module-private, so pinning its rendered output would need an export — a source change this no-behaviour-change increment does not make", consequence: "editing linear=true, the resampler string, the apad form or the measure-mode fallback target I=-23:TP=-2:LRA=7 makes every delivered finishing record's processing.json unreadable while contentHash(SOUND_FINISH_RECIPE) is unchanged" },
    ],
    closedSets: {
      soundRoles: [...SOUND_ROLES],
      soundStems: [...SOUND_STEMS],
      restorationTracks: [...RESTORATION_TRACKS],
      restorationStems: [...RESTORATION_STEMS],
    },
    setInvariants: [
      "RESTORATION_STEMS === SOUND_STEMS",
      'RESTORATION_TRACKS === ["dialogue", "narration", ...SOUND_ROLES]',
    ],
    behaviourChanged: false,
    newProviderSpendUsd: 0,
    provesLoudnessQualification: false,
    provesRestorationQuality: false,
  };
}

function validatePins(value: unknown): PinsDocument {
  const d = value as PinsDocument;
  if (!d || typeof d !== "object" || d.schema !== "hv-sound-recipe-pins/1") throw new Error("Invalid sound recipe pins document.");
  if (!/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(d.recordedAt)) throw new Error("Invalid sound recipe pins document.");
  if (!Array.isArray(d.recipes) || d.recipes.length !== 5) throw new Error("Invalid sound recipe pins document.");
  if (!Array.isArray(d.renderedFilters) || d.renderedFilters.length !== 1) throw new Error("Invalid sound recipe pins document.");
  if (!Array.isArray(d.unpinnedReDerivedValues) || !d.unpinnedReDerivedValues.length) throw new Error("Invalid sound recipe pins document.");
  for (const r of d.recipes) if (!/^[a-f0-9]{64}$/.test(r.revision)) throw new Error("Invalid sound recipe pins document.");
  if (!d.closedSets || !Array.isArray(d.setInvariants) || d.setInvariants.length !== 2) throw new Error("Invalid sound recipe pins document.");
  if (d.behaviourChanged !== false || d.newProviderSpendUsd !== 0) throw new Error("Invalid sound recipe pins document.");
  for (const f of ["provesLoudnessQualification", "provesRestorationQuality"] as const) if (d[f] !== false) throw new Error("Invalid sound recipe pins document.");
  return d;
}

test("sound identity: the two closed sets are the same set, not two sets that happen to agree", () => {
  // RESTORATION_STEMS and SOUND_STEMS are declared in different files. They agree today, which is
  // exactly why nothing notices — this asserts the agreement rather than trusting it, so widening
  // the cue roles fails here instead of at the first restoration session.
  expect([...RESTORATION_STEMS]).toEqual([...SOUND_STEMS]);
  expect([...RESTORATION_TRACKS]).toEqual(["dialogue", "narration", ...SOUND_ROLES]);
  // The stem set is the track set plus the two summed outputs, in that order. The restoration
  // filter indexes its outputs positionally, so the ORDER is load-bearing, not just the membership.
  expect([...SOUND_STEMS]).toEqual([...RESTORATION_TRACKS, "me", "mix"]);
  expect(new Set(SOUND_STEMS).size).toBe(SOUND_STEMS.length);
});

test("sound identity: every recipe revision a delivered record pins is committed and still matches", () => {
  // Resolved against the repo root, not the caller's cwd: the regeneration command above passes a
  // relative path, and an unresolved one would write a stray file while the assertions below still
  // compared the committed one — reporting success without having regenerated anything.
  const raw = process.env.HV_SOUND_PINS_EVIDENCE?.trim();
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

  // The tripwire.
  expect(pinned.recipes).toEqual(live.recipes);
  expect(pinned.closedSets).toEqual(live.closedSets);
  expect(pinned.renderedFilters).toEqual(live.renderedFilters);
  expect(pinned.unpinnedReDerivedValues).toEqual(live.unpinnedReDerivedValues);
  expect(pinned.recipes.map((r) => r.name).sort()).toEqual(
    ["NARRATION_MIX_RECIPE", "RESTORATION_RECIPE", "SOUND_CONVERSION_RECIPE", "SOUND_FINISH_RECIPE", "SOUND_MIX_RECIPE"]);

  // No credential, no destination, no host path; every 32+ hex run is one of the pinned revisions.
  for (const pattern of [/:\/\//, /API_KEY/i, /\/home\//, /\/Users\//, /\/tmp\//]) expect(text).not.toMatch(pattern);
  const known = new Set(pinned.recipes.map((r) => r.revision));
  for (const hex of text.match(/[a-f0-9]{32,}/g) ?? []) expect({ hex, known: known.has(hex) }).toEqual({ hex, known: true });
});

test("sound identity: the rendered restoration filter is the string the validator re-derives", () => {
  // Not a tautology about contentHash. This calls the same exported function validateRestorationReport
  // calls, so the pinned string is the literal FFmpeg invocation a delivered record is compared against
  // — and an edit to any bare literal inside it moves this pin even though the recipe hash does not.
  const rendered = restorationFilter(FILTER_PROBE, FILTER_PROBE_FRAMES);
  expect(rendered).toContain("afftdn=");
  expect(rendered).toContain("atrim=");
  // The recipe-derived values appear in it, which is why pinning the recipe felt sufficient and was not.
  expect(rendered).toContain(`asetnsamples=n=${RESTORATION_RECIPE.hopFrames}`);
  expect(rendered).toContain(`apad=pad_len=${RESTORATION_RECIPE.tailPaddingFrames}`);
  // And values that appear in it but live nowhere in the recipe — the gap this pin closes.
  for (const literal of ["nt=w", "tr=0", "ad=0.5", "nl=average", "bm=1.25", "om=o"]) {
    expect({ literal, present: rendered.includes(literal) }).toEqual({ literal, present: true });
    expect({ literal, inRecipe: JSON.stringify(RESTORATION_RECIPE).includes(literal) }).toEqual({ literal, inRecipe: false });
  }
});
