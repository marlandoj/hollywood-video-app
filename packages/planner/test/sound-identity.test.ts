// The sound lane's recipe identity, pinned — and its two closed sets tied together.
//
// Three recipe constants are content-hashed into every delivered sound record and re-derived by
// the validator that reads it back:
//   SOUND_MIX_RECIPE      -> report.recipeRevision, checked in validateSoundOutput
//   SOUND_FINISH_RECIPE   -> the finishing report's recipe revision
//   RESTORATION_RECIPE    -> the restoration report's recipe revision
// Nothing in this repository guarded any of them. Adding one field to any of the three leaves all
// eighteen sound tests green while making every already-delivered sound version permanently
// unreadable — the same defect family HV-019-01 and HV-019-03 each closed once, and HV-025-01
// closed for the graphics lane.
//
// The second half of this file closes a related one. RESTORATION_TRACKS and RESTORATION_STEMS are
// declared in sound-restoration.ts; SOUND_ROLES and SOUND_STEMS are declared in sound-session.ts.
// They agree today by coincidence of maintenance, not by construction, and a third file indexes
// the restoration outputs positionally. Widening the cue roles — which every remaining P9 clause
// (score, foley, ambience beds, auto-spotting) must do — leaves every unit test green, renders a
// non-restoration mix correctly, and fails a restoration session with a raw ENOENT.
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
import { RESTORATION_RECIPE, RESTORATION_STEMS, RESTORATION_TRACKS } from "../src/sound-restoration";
import { contentHash } from "../../generator/src/capabilities";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const PINS_PATH = join(REPO_ROOT, "docs/evidence/hv024-sound/recipe-revision-pins.json");

interface PinsDocument {
  schema: "hv-sound-recipe-pins/1";
  recordedAt: string;
  recipes: { name: string; schema: string; revision: string; pinnedInto: string }[];
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
  if (!Array.isArray(d.recipes) || d.recipes.length !== 3) throw new Error("Invalid sound recipe pins document.");
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
  expect(pinned.recipes.map((r) => r.name).sort()).toEqual(["RESTORATION_RECIPE", "SOUND_FINISH_RECIPE", "SOUND_MIX_RECIPE"]);

  // No credential, no destination, no host path; every 32+ hex run is one of the pinned revisions.
  for (const pattern of [/:\/\//, /API_KEY/i, /\/home\//, /\/Users\//, /\/tmp\//]) expect(text).not.toMatch(pattern);
  const known = new Set(pinned.recipes.map((r) => r.revision));
  for (const hex of text.match(/[a-f0-9]{32,}/g) ?? []) expect({ hex, known: known.has(hex) }).toEqual({ hex, known: true });
});

test("sound identity: a moved recipe is refused, which is what a delivered version would hit", async () => {
  // Demonstrate the failure direction rather than assert it. validateSoundOutput compares
  // report.recipeRevision against contentHash(SOUND_MIX_RECIPE), so a record sealed under any other
  // recipe is unreadable by this build — which is precisely what happens to every already-delivered
  // sound version once the recipe moves.
  const moved = { ...SOUND_MIX_RECIPE, gainScale: 1048577 };
  expect(contentHash(moved)).not.toBe(contentHash(SOUND_MIX_RECIPE));
  // The same one-field-addition shape the audit describes, on each of the three.
  for (const [name, recipe] of [["mix", SOUND_MIX_RECIPE], ["finish", SOUND_FINISH_RECIPE], ["restore", RESTORATION_RECIPE]] as const) {
    const extended = { ...recipe, addedLater: "any-new-field" };
    expect({ name, same: contentHash(extended) === contentHash(recipe) }).toEqual({ name, same: false });
  }
});
