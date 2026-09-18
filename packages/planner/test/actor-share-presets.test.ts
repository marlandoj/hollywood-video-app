/**
 * HV-034-01 — a share that no one could ever import.
 *
 * `importedActor` built each imported costume preset's name by concatenating a
 * screenplay scene heading straight in:
 *
 *     name: "Scene " + value.sceneNumber + " — " + (…sceneBindings.find(…)?.heading ?? "Shared costume")
 *
 * Headings are validated on the way in only for being a string of at most 1000
 * characters — `characterRecord` checks nothing about their content. The preset
 * name is validated on the way back out by `text(…, "Costume preset", 1100,
 * true)`, which refuses control characters and requires the value to equal its
 * own trim. A forced Fountain heading (`.BELL<BEL> RINGS`) carries a control
 * character through the parser into `sceneBindings`, into the share, and into
 * the name.
 *
 * The result is permanent and collective. `createActorShare` never runs the
 * import-side construction, so the share mints cleanly; it is revision-hashed
 * and immutable, so it cannot be repaired; and every import attempt by every
 * recipient fails identically for its whole seven-day life. The refusal says
 * "must be text up to 1100 characters", which names the one thing that was
 * never wrong: the longest reachable name is 6 + 4 + 3 + 1000 = 1013.
 */
import {expect, test} from "bun:test";
import {readFileSync} from "node:fs";
import {join, resolve} from "node:path";
import {CAST_INPUT} from "../../../test/fixtures/casting";
import {ProjectService} from "../../api/src/index";
import {costumePresetName, createActorShare, importedActor, sharedCostumePresets} from "../src/actor-library";
import {COSTUME_PRESET_DESCRIPTION_LIMIT, COSTUME_PRESET_LIMIT, COSTUME_PRESET_NAME_LIMIT, assertCostumePresets, castingSnapshot, characterRecord, currentCasting} from "../src/casting";

const REPO_ROOT = resolve(import.meta.dir, "../../..");
const now = Date.now();
const BELL = String.fromCharCode(7);

/** A project whose scene 2 heading carries whatever the caller wants it to. */
function shared(heading: string, wardrobe = [{sceneNumber: 2, description: "A blue jacket"}]) {
  process.env.HV_TOKEN_SECRET = "actor-share-presets-fixture-secret-with-thirty-two-chars";
  const service = new ProjectService(), source = service.createAnonymousProject(now), id = crypto.randomUUID();
  // A forced Fountain heading ("." prefix) is the route a heading takes when it
  // is not one of the recognised INT./EXT. forms, and it is not sanitised.
  service.editScript(source.token, "INT. ROOM - DAY\n\nSpud waves.\n\n." + heading + "\n\nSpud listens.", now);
  expect(service.saveCharacter(source.token, id, {...CAST_INPUT, wardrobe: [...CAST_INPUT.wardrobe, ...wardrobe]}, 0, now)).not.toBeNull();
  const project = service.snapshot().projects[0]!;
  return {service, source, id, casting: currentCasting(source.projectId, project.castingHistory), deleteAfter: project.deleteAfter};
}

const importShare = (f: ReturnType<typeof shared>) => {
  const share = createActorShare(f.casting, f.id, f.deleteAfter, now);
  return {share, copy: importedActor(share, crypto.randomUUID(), crypto.randomUUID(), "Imported Spud", [], [], now)};
};

test("a scene heading carrying a control character no longer mints a share nobody can import", () => {
  const f = shared("BELL" + BELL + " RINGS");
  // The fixture is the defect's own input: the control character survives the
  // parser and reaches the binding the name is built from.
  expect(f.casting.characters[0]!.sceneBindings).toEqual([{sceneNumber: 2, heading: "BELL" + BELL + " RINGS"}]);

  const {copy} = importShare(f);
  const preset = copy.costumePresets!.find(value => value.description === "A blue jacket")!;
  expect(preset.name).toBe("Scene 2 — BELL RINGS");
  expect(preset.name).not.toContain(BELL);
  // And the import's own validator accepts what the import produced, which is
  // the property that failed: the character round-trips.
  expect(() => characterRecord(copy, copy.id, now, true)).not.toThrow();
});

test("the name survives every shape a heading can arrive in", () => {
  // Each of these is a heading the parser will pass through unchanged. The
  // property is the same one in every row: what `sharedCostumePresets` builds,
  // `characterRecord` accepts.
  for (const [label, heading] of [
    ["a control character", "BELL" + BELL + " RINGS"],
    ["several control characters", BELL + "A" + String.fromCharCode(1) + "B" + String.fromCharCode(31)],
    ["a delete character", "SHOP" + String.fromCharCode(127) + " FLOOR"],
    ["nothing but control characters", BELL + String.fromCharCode(1)],
    ["a thousand characters", "X".repeat(1000)],
    ["non-latin text", "МОСТ НОЧЬЮ"],
    ["an ordinary heading", "BACK ALLEY - NIGHT"],
  ] as const) {
    const f = shared(heading);
    const {copy} = importShare(f);
    const preset = copy.costumePresets!.find(value => value.description === "A blue jacket")!;
    expect({label, thrown: (() => { try { characterRecord(copy, copy.id, now, true); return null; } catch (error) { return (error as Error).message; } })()})
      .toEqual({label, thrown: null});
    expect({label, tooLong: preset.name.length > COSTUME_PRESET_NAME_LIMIT}).toEqual({label, tooLong: false});
    expect({label, trimmed: preset.name === preset.name.trim()}).toEqual({label, trimmed: true});
    expect({label, control: [...preset.name].some(character => {const code = character.charCodeAt(0); return code === 127 || code < 32;})}).toEqual({label, control: false});
  }
  // A heading with no readable text left still names the scene rather than
  // producing "Scene 2 — ".
  expect(costumePresetName(2, BELL + String.fromCharCode(1))).toBe("Scene 2 — Shared costume");
  expect(costumePresetName(2, undefined)).toBe("Scene 2 — Shared costume");
  expect(costumePresetName(7, "  padded  ")).toBe("Scene 7 — padded");
  expect(costumePresetName(1, "X".repeat(1200)).length).toBe(COSTUME_PRESET_NAME_LIMIT);
});

test("a share is refused at the mint when its presets could not be imported", () => {
  // The count cap used to be checked only on the way in, so a share carrying
  // more presets than an import accepts was minted, handed out, and refused for
  // everyone -- with a message addressed to the one person who could not act on
  // it, since the owner is not the importer. A character reaches that many only
  // by carrying imported presets of its own (wardrobe alone caps at 24), which
  // is exactly what a re-share of an imported actor does.
  const f = shared("BACK ALLEY - NIGHT");
  const character = f.casting.characters[0]!;
  const crowded = {...character, costumePresets: Array.from({length: COSTUME_PRESET_LIMIT}, (_, index) => ({name: "Imported costume " + index, description: "Costume " + index}))};
  const snapshot = castingSnapshot(f.casting.projectId, f.casting.version, [crowded], now);
  expect(sharedCostumePresets(crowded).length).toBeGreaterThan(COSTUME_PRESET_LIMIT);
  expect(() => createActorShare(snapshot, f.id, f.deleteAfter, now))
    .toThrow("more than the " + COSTUME_PRESET_LIMIT + " a share carries");

  // One fewer and it mints, imports, and lands inside the cap: the refusal is
  // about this character's presets, not about sharing an imported actor.
  const fits = {...crowded, costumePresets: crowded.costumePresets.slice(0, COSTUME_PRESET_LIMIT - 1)};
  const share = createActorShare(castingSnapshot(f.casting.projectId, f.casting.version, [fits], now), f.id, f.deleteAfter, now);
  const copy = importedActor(share, crypto.randomUUID(), crypto.randomUUID(), "Imported Spud", [], [], now);
  expect(copy.costumePresets!.length).toBe(COSTUME_PRESET_LIMIT);
  expect(() => characterRecord(copy, copy.id, now, true)).not.toThrow();
});

test("the sanitiser is the validator's charset, not four samples of it", () => {
  // Case 2 supplies four control characters. A sanitiser that named exactly
  // those -- `![1,7,31,127].includes(code)` -- passed it, and a heading with
  // U+0008 reintroduced the defect byte for byte. So the class is exercised
  // rather than sampled.
  for (let code = 0; code < 32; code++) {
    const name = costumePresetName(2, "A" + String.fromCharCode(code) + "B");
    const allowed = [9, 10, 13].includes(code);
    // Tab, newline and carriage return are what the validator *allows*, so they
    // become a space rather than vanishing: "HALL<TAB>DAY" imported fine before
    // this increment and must not silently become "HALLDAY".
    expect({code, name}).toEqual({code, name: allowed ? "Scene 2 — A B" : "Scene 2 — AB"});
  }
  expect(costumePresetName(2, "A" + String.fromCharCode(127) + "B")).toBe("Scene 2 — AB");
  // And the property the class is for: whatever comes out satisfies the clause
  // that reads it back.
  for (let code = 0; code < 128; code++) {
    const preset = {name: costumePresetName(3, "H" + String.fromCharCode(code) + "L"), description: "A blue jacket"};
    expect({code, thrown: (() => { try { assertCostumePresets([preset]); return null; } catch (error) { return (error as Error).message; } })()})
      .toEqual({code, thrown: null});
  }
});

test("a preset the import would refuse does not mint either", () => {
  // The same defect one field over, and the one the first draft left open. A
  // preset is {name, description}: the name is safe because this module builds
  // it, while the description is copied straight from the wardrobe entry and
  // was checked by nobody until the import. Counting is not validating.
  //
  // Today it is not reachable through the service, because the two limits
  // happen to agree -- `text(entry.description,"Wardrobe",600,true)` on the way
  // in and the preset clause's own 600 on the way out -- so a wardrobe entry
  // that would break a preset is refused earlier, by `castingSnapshot`. The
  // state below is therefore *constructed*, by mutating a validated snapshot
  // the way a disagreement between those two numbers would: widen either one
  // and this is what arrives at the mint.
  const f = shared("BACK ALLEY - NIGHT");
  const valid = castingSnapshot(f.casting.projectId, f.casting.version, [f.casting.characters[0]!], now);
  const bent = structuredClone(valid);
  bent.characters[0]!.wardrobe = bent.characters[0]!.wardrobe.map(entry =>
    entry.sceneNumber === null ? entry : {...entry, description: "x".repeat(COSTUME_PRESET_DESCRIPTION_LIMIT + 1)});
  // The mint refuses, and says something the owner can act on rather than
  // handing out a share that fails on arrival for everyone, forever.
  expect(() => createActorShare(bent, f.id, f.deleteAfter, now)).toThrow("cannot be shared as written");
  // The same construction with a carried preset, which is the other way a bad
  // description reaches the list: `sharedCostumePresets` spreads those through.
  const carried = structuredClone(valid);
  carried.characters[0]!.costumePresets = [{name: "Carried", description: "y".repeat(COSTUME_PRESET_DESCRIPTION_LIMIT + 1)}];
  expect(() => createActorShare(carried, f.id, f.deleteAfter, now)).toThrow("cannot be shared as written");
  // And a description exactly at the limit still shares and imports, so the
  // refusal is the validator's rule and not a margin invented here.
  const atLimit = structuredClone(valid);
  atLimit.characters[0]!.wardrobe = atLimit.characters[0]!.wardrobe.map(entry =>
    entry.sceneNumber === null ? entry : {...entry, description: "x".repeat(COSTUME_PRESET_DESCRIPTION_LIMIT)});
  const share = createActorShare(atLimit, f.id, f.deleteAfter, now);
  const copy = importedActor(share, crypto.randomUUID(), crypto.randomUUID(), "Imported Spud", [], [], now);
  expect(copy.costumePresets!.some(preset => preset.description.length === COSTUME_PRESET_DESCRIPTION_LIMIT)).toBe(true);
});


test("the preset name is built in one place", () => {
  // The defect was a rule stated where it was used. `importedActor` built the
  // name, `characterRecord` validated it, and nothing held them together.
  const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, "");
  const source = strip(readFileSync(join(REPO_ROOT, "packages/planner/src/actor-library.ts"), "utf8"));
  const builder = source.slice(source.indexOf("export function costumePresetName"));
  const body = builder.slice(0, builder.indexOf("\n}\n"));
  expect(body).toContain('"Scene "');
  // Nowhere else may assemble one. Neither half identifies it alone -- "Scene "
  // prefixes five other messages in this package and the em dash joins a sheet's
  // own label -- so the shape is the pair, in any spelling: the first draft of
  // this scan matched a literal em dash only, and broke the moment the builder
  // was written with an escape.
  const BUILDS = /Scene[^\n;]{0,40}(?:\u2014|\\u2014)/;
  expect(BUILDS.test(body)).toBe(true);
  const others = [...new Bun.Glob("packages/planner/src/**/*.ts").scanSync(REPO_ROOT)]
    .filter(file => BUILDS.test(strip(readFileSync(join(REPO_ROOT, file), "utf8")).replace(body, "")));
  expect(others).toEqual([]);
  // Self-exercise: every spelling bites, and neither half alone does.
  for (const spelling of ['name:"Scene "+n+" \u2014 "+heading', "`Scene ${n} \u2014 ${heading}`", "'Scene '+n+' \u2014 '+h", '["Scene ",n," \u2014 ",h].join("")'])
    expect({spelling, caught: BUILDS.test(spelling)}).toEqual({spelling, caught: true});
  expect(BUILDS.test('"Scene "+key+" must be from "')).toBe(false);
  expect(BUILDS.test('character.name+" \u2014 "+view.label')).toBe(false);

  // Both sides go through the one builder. Case 1 and case 2 exercise the
  // import; nothing exercised the mint, so the mint could stop calling it and
  // count a list of its own with the whole suite green.
  const mint = source.slice(source.indexOf("export function createActorShare"));
  const minting = mint.slice(0, mint.indexOf("\n}\n"));
  expect(minting).toContain("sharedCostumePresets(character)");
  expect(minting).toContain("assertCostumePresets(");
  expect(BUILDS.test(minting)).toBe(false);
  // And `importedActor` no longer builds a name at all.
  const importer = source.slice(source.indexOf("export function importedActor"));
  expect(importer.slice(0, importer.indexOf("\n}\n"))).not.toContain('"Scene "');
  // And the three limits are the validator's own, not restated anywhere: the
  // builder clamps to the name limit, the mint counts to the preset limit, and
  // the description limit is what both sides mean by a description. A literal
  // in `casting.ts` beside any of them would be a second statement of the rule.
  const casting = strip(readFileSync(join(REPO_ROOT, "packages/planner/src/casting.ts"), "utf8"));
  const clause = casting.slice(casting.indexOf("export function assertCostumePresets"));
  const rule = clause.slice(0, clause.indexOf("\n}\n"));
  for (const [name, constant] of [["COSTUME_PRESET_LIMIT", COSTUME_PRESET_LIMIT], ["COSTUME_PRESET_NAME_LIMIT", COSTUME_PRESET_NAME_LIMIT], ["COSTUME_PRESET_DESCRIPTION_LIMIT", COSTUME_PRESET_DESCRIPTION_LIMIT]] as const) {
    expect({name, used: rule.includes(name)}).toEqual({name, used: true});
    expect({name, numeric: typeof constant}).toEqual({name, numeric: "number"});
  }
  expect(rule).not.toMatch(/,\s*\d{2,4}\s*,\s*true\)/);
  // `characterRecord` asks the same function rather than repeating its clause.
  const record = casting.slice(casting.indexOf("export function characterRecord"));
  expect(record.slice(0, record.indexOf("\n}\n"))).toContain("assertCostumePresets(presets)");
});
