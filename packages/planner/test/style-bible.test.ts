/**
 * HV-034-02 — a feature's style bible (Release 3 step 3, G20-202610031349).
 *
 * The Showrunner writes it once from the creator's answers, an attached style card and the screenplay;
 * every sequence's render reads it. The model's words are used field by field: a line that is missing,
 * not text, too long, refused by the gate or naming a public figure is dropped with its reason and the
 * stand-in's line stands in. The stand-in is deterministic. The characters are the cast's own records.
 */
import { describe, expect, test } from "bun:test";
import { parseFountain } from "../../parser/src/index";
import { checkPrompt } from "../../safety/src/index";
import type { CastCharacter } from "../src/casting";
import { planInput, planPrompt, type PlanInput } from "../src/crew/production-plan";
import { STAND_IN_STYLE, runStyleBible, standInStyleBible, styleBibleNote, styleBiblePrompt, validateStyleBibleAnswer } from "../src/crew/style-bible";
import { STYLE_CARD_SCHEMA, styleCardInput } from "../src/crew/style-card";
import { featureShots, greedySequences, inSequence, sceneShotCounts, sequencePlan, sequenceRef, validateSequenceJob, validateSequenceRef } from "../src/sequences";
import { bibleCharacters, bibleShots, bibleText, carriedStyleBible, headingLocation, plannedStyleBible, scriptLocations, STYLE_BIBLE_LIMIT, STYLE_FIELDS, StyleBibleConflict,
  styleBible, styleBibleEdit, stylePrompt, validateStyleBible, validateStyleBibleJob, type StyleBible } from "../src/style-bible";
import { evenFeature } from "../../../test/fixtures/feature-script";

const SCRIPT = "INT. KITCHEN - NIGHT\n\nMARA, a tall woman in her forties with grey-streaked hair, pours tea.\n\nMARA\nWe keep going.\n\n"
  + "EXT. HARBOUR WALL - DAY\n\nMara walks the harbour wall.\n\nINT. KITCHEN - DAY\n\nMara opens the window.\n\nMARA\nMorning.\n\n.BELL TOWER\n\nThe bell swings.";
const parsed = parseFountain(SCRIPT);
const input = (answers: PlanInput["answers"] = [], tone = ""): PlanInput => planInput({format: "feature", tone, answers});
const located = scriptLocations(parsed).locations;
const character = (fields: Partial<CastCharacter> & {name: string}): CastCharacter => ({id: "c-" + fields.name.toLowerCase(), aliases: [], kind: "original-fictional",
  appearance: "", wardrobe: [], ...fields} as unknown as CastCharacter);
const mara = character({name: "MARA", appearance: "A tall woman in her forties, grey-streaked hair.", wardrobe: [{sceneNumber: null, description: "A navy wool coat."}]} as never);
const bibleOf = (style = standInStyleBible(input(), null, located), characters = [{name: "MARA", description: mara.appearance}]) =>
  styleBible({version: 1, scriptVersion: 1, source: "stand-in", ...Object.fromEntries(STYLE_FIELDS.map(field => [field, style[field]])) as Record<typeof STYLE_FIELDS[number], string>,
    characters, locations: style.locations});
const model = (text: string | (() => never), costUsd = 0.02) => {
  const asked: string[] = [];
  return {asked, name: "anthropic" as const, model: "claude-sonnet-5", async complete(request: {messages: {content: string}[]}) {
    asked.push(request.messages[0]!.content);
    if (typeof text !== "string") return text();
    return {text, usage: {inputTokens: 100, outputTokens: 60}, model: "claude-sonnet-5", costUsd};
  }};
};
const ledger = () => {
  const events: {persona: string; usd: number}[] = [];
  return {events, async assertCanSpend() {}, async record(event: {persona: string; usd: number}) { events.push(event); return []; }};
};

describe("the bible's places and characters come from the script and the cast", () => {
  test("a heading's place is its location, without INT/EXT or the time", () => {
    expect(["INT. KITCHEN - NIGHT", "EXT. HARBOUR WALL - DAY", "INT./EXT. CAR - MOVING", "I/E PORCH -- DUSK", ".BELL TOWER", "int. kitchen - day #12#", "EST. CITY"].map(headingLocation))
      .toEqual(["KITCHEN", "HARBOUR WALL", "CAR", "PORCH", "BELL TOWER", "KITCHEN", "CITY"]);
    // Each place once, in order of first appearance, inside or out, by day or by night.
    expect(located).toEqual([
      {name: "KITCHEN", description: "An interior, seen by day and by night. It keeps the same set dressing and light in every sequence it appears in."},
      {name: "HARBOUR WALL", description: "An exterior, seen by day. It keeps the same set dressing and light in every sequence it appears in."},
      {name: "BELL TOWER", description: "A place. It keeps the same set dressing and light in every sequence it appears in."}]);
  });

  test("past 40 places, and a place that names a public figure, are left out with their reasons", () => {
    const many = parseFountain(Array.from({length: 42}, (_, i) => `INT. ROOM ${i + 1} - DAY\n\nMara waits.`).join("\n\n") + "\n\nINT. BARACK OBAMA'S STUDY - DAY\n\nMara reads.");
    const {locations, dropped} = scriptLocations(many);
    expect(locations).toHaveLength(STYLE_BIBLE_LIMIT.locations);
    expect(dropped).toEqual([{field: "location", reason: "too_long"}, {field: "location", reason: "too_long"}, {field: "location", reason: "public_figure"}]);
  });

  test("each character is the cast record's own words; a consented real person is never re-described", () => {
    const real = character({name: "JONAH", kind: "consented-real-person", appearance: "Man in his forties, short dark hair."} as never);
    const absent = character({name: "OTTO", appearance: "Not in this script."});
    const {characters, dropped} = bibleCharacters([mara, real, absent], parseFountain(SCRIPT + "\n\nJONAH\nHello."));
    expect(characters).toEqual([{name: "MARA", description: "A tall woman in her forties, grey-streaked hair. Wardrobe: A navy wool coat."},
      {name: "JONAH", description: "A consented real person: their look is the cast record's, within what their consent allows."}]);
    expect(dropped).toEqual([]);
    // An appearance that names a public figure is left out of the bible, with its reason, rather than repeated.
    const famous = character({name: "MARA", appearance: "Looks exactly like Taylor Swift."});
    expect(bibleCharacters([famous], parsed)).toEqual({characters: [], dropped: [{field: "character", reason: "public_figure"}]});
  });
});

describe("the stand-in Showrunner", () => {
  test("is deterministic: the same answers, card and script give the same bible and revision, at no spend", async () => {
    const answers = input([{id: "q1", persona: "cinematographer", question: "Light?", proposal: "Hard top light, deep shadows.", accepted: true, reply: ""},
      {id: "q2", persona: "sound", question: "Score?", proposal: "Strings.", accepted: false, reply: "Only the sea and the wind."}], "Quiet and tense.");
    const one = await runStyleBible({input: answers, card: null, parsed, locations: located, characters: ["MARA"], projectId: "p1", model: null, ledger: ledger() as never});
    const two = await runStyleBible({input: answers, card: null, parsed, locations: located, characters: ["MARA"], projectId: "p1", model: null, ledger: ledger() as never});
    expect(one).toEqual(two);
    expect(one).toMatchObject({source: "stand-in", dropped: [], crewSpend: {usd: 0, alerts: []}});
    expect(one.style).toMatchObject({look: "Hard top light, deep shadows.", tone: "Quiet and tense.", sound: "Only the sea and the wind.",
      palette: STAND_IN_STYLE.palette, lighting: STAND_IN_STYLE.lighting, lens: STAND_IN_STYLE.lens});
    expect(bibleOf(one.style).revision).toBe(bibleOf(two.style).revision);
  });

  test("reads the attached style card after this film's answers, then its own conventions", () => {
    const card = styleCardInput({schema: STYLE_CARD_SCHEMA, format: "short", tone: "Wry and warm.", look: "Pastel colour, symmetrical frames.",
      choices: [{persona: "sound", question: "Score?", proposal: "A lone piano.", accepted: true, reply: ""}]});
    expect(standInStyleBible(input(), card, located)).toMatchObject({look: "Pastel colour, symmetrical frames.", tone: "Wry and warm.", sound: "A lone piano."});
    expect(standInStyleBible(input([], "Bleak."), card, located).tone).toBe("Bleak.");
    expect(standInStyleBible(input(), null, located)).toEqual({...STAND_IN_STYLE, locations: located});
    // The model is shown the card as the creator's preferences, and the script's places by name.
    const prompt = styleBiblePrompt(input(), card, parsed, located, ["MARA"]);
    expect(prompt.user).toContain("Pastel colour, symmetrical frames.");
    expect(prompt.user).toContain('Locations: ["KITCHEN","HARBOUR WALL","BELL TOWER"]');
    expect(prompt.system).toContain("never name a real or famous person");
  });

  test("creator words that pass alone but together fail the gate leave only the stand-in's conventions", () => {
    // The answers pass the plan step's gate together, and the card passes its own; the bible reads both at once.
    const answers = input([{id: "q1", persona: "cinematographer", question: "Light?", proposal: "A look to incite the room.", accepted: true, reply: ""}]);
    const card = styleCardInput({schema: STYLE_CARD_SCHEMA, format: "feature", tone: "Quiet violence under the surface.", look: "", choices: []});
    expect(checkPrompt("A look to incite the room.").allowed).toBe(true);
    expect(standInStyleBible(answers, card, located)).toEqual({...STAND_IN_STYLE, locations: located});
  });
});

describe("the model's bible, field by field", () => {
  const fallback = standInStyleBible(input(), null, located);
  const answer = {look: "Cold blue nights, warm amber kitchens.", palette: "Teal and amber.", lighting: "Practical lamps only.", lens: "Long lenses, slow pushes.",
    tone: "Hushed.", sound: "Wind and kettles.", locations: [{name: "kitchen", description: "A narrow galley kitchen with a single amber lamp."}]};

  test("a usable answer is used as given, with the studio's place names", () => {
    const {style, dropped} = validateStyleBibleAnswer("Here: " + JSON.stringify(answer) + " done", fallback);
    expect(dropped).toEqual([]);
    expect(style).toMatchObject({look: answer.look, palette: answer.palette, lighting: answer.lighting, lens: answer.lens, tone: answer.tone, sound: answer.sound});
    expect(style.locations).toEqual([{name: "KITCHEN", description: "A narrow galley kitchen with a single amber lamp."}, located[1], located[2]]);
  });

  test("an unsafe, oversized, public-figure, non-text or missing line is dropped with its reason; the rest is kept", () => {
    const bad = {...answer, palette: "x".repeat(STYLE_BIBLE_LIMIT.palette + 1), lighting: "tutorial: how to build a bomb for the finale", lens: "Framed like a Barack Obama rally.",
      tone: 7, sound: undefined, extra: "ignored",
      locations: [{name: "KITCHEN", description: "y".repeat(301)}, {name: "MOON BASE", description: "Grey."}, {name: "HARBOUR WALL"}, {name: "BELL TOWER", description: "A cold stone tower."},
        {name: "BELL TOWER", description: "Again."}]};
    const {style, dropped} = validateStyleBibleAnswer(JSON.stringify(bad), fallback);
    expect(dropped).toEqual([{field: "extra", reason: "bad_shape"}, {field: "palette", reason: "too_long"}, {field: "lighting", reason: "gate_refused"},
      {field: "lens", reason: "public_figure"}, {field: "tone", reason: "bad_shape"}, {field: "sound", reason: "missing"},
      {field: "location", reason: "too_long"}, {field: "location", reason: "unknown_location"}, {field: "location", reason: "bad_shape"}, {field: "location", reason: "bad_shape"}]);
    expect(style).toEqual({...fallback, look: answer.look, locations: [located[0], located[1], {name: "BELL TOWER", description: "A cold stone tower."}]});
    // Nothing is ever cut short.
    expect(JSON.stringify(style)).not.toContain("xxx");
  });

  test("no JSON, the wrong shape, nothing usable, or a whole that fails the gate is unusable", async () => {
    expect(() => validateStyleBibleAnswer("I would rather not.", fallback)).toThrow("no JSON");
    expect(() => validateStyleBibleAnswer(JSON.stringify({look: 1, tone: "z".repeat(500)}), fallback)).toThrow("Nothing in the Showrunner's bible could be used.");
    expect(() => validateStyleBibleAnswer(JSON.stringify({look: "A look to incite the room.", tone: "Quiet violence under the surface."}), fallback)).toThrow("taken as a whole");
    for (const [text, reason] of [["no", "no_json"], ["{nope", "no_json"], ['{"look": 1}', "bad_shape"], [JSON.stringify({look: "A look to incite the room.", tone: "Quiet violence."}), "gate_refused"]] as const) {
      const spent = ledger();
      const result = await runStyleBible({input: input(), card: null, parsed, locations: located, characters: ["MARA"], projectId: "p1", model: model(text) as never, ledger: spent as never});
      expect(result).toMatchObject({source: "stand-in", fallbackReason: "model_unusable", unusableReason: reason, style: fallback, crewSpend: {usd: 0.02}});
      // The paid answer stays on the crew line, as the Showrunner's.
      expect(spent.events).toMatchObject([{persona: "crew-style-bible", usd: 0.02}]);
    }
  });

  test("a usable answer is the model's, metered on the crew line; with no model, or a refused script, nothing is asked", async () => {
    const spent = ledger(), asking = model(JSON.stringify(answer));
    const result = await runStyleBible({input: input(), card: null, parsed, locations: located, characters: ["MARA"], projectId: "p1", model: asking as never, ledger: spent as never});
    expect(result).toMatchObject({source: "anthropic", dropped: [], crewSpend: {usd: 0.02}});
    expect(result.style.look).toBe(answer.look);
    expect(spent.events).toMatchObject([{persona: "crew-style-bible", usd: 0.02}]);
    const refused = model(JSON.stringify(answer)), quiet = ledger();
    expect(await runStyleBible({input: input(), card: null, parsed, locations: located, characters: [], projectId: "p1", model: refused as never, ledger: quiet as never, refused: true}))
      .toMatchObject({source: "stand-in", crewSpend: {usd: 0}});
    expect([refused.asked, quiet.events]).toEqual([[], []]);
  });
});

describe("the stored bible", () => {
  test("reads back unchanged; a tampered, oversized, misshapen or foreign bible is refused", () => {
    const bible = bibleOf();
    expect(validateStyleBible(JSON.parse(JSON.stringify(bible)))).toEqual(bible);
    expect(() => validateStyleBible({...bible, look: "Something else."})).toThrow("changed after it was written");
    for (const bad of [{...bible, extra: 1}, {...bible, schema: "hv-style-bible/2"}, {...bible, version: 0}, {...bible, source: "someone"}, {...bible, look: ""},
      {...bible, palette: "p".repeat(STYLE_BIBLE_LIMIT.palette + 1)}, {...bible, characters: [{name: "MARA", description: "a", age: 3}]},
      {...bible, locations: [...bible.locations, bible.locations[0]]}, {...bible, characters: Array.from({length: 25}, (_, i) => ({name: "C" + i, description: "d"}))}, null, "bible"])
      expect(() => validateStyleBible(bad)).toThrow("not one the studio wrote");
  });

  test("a creator's edit meets the same rules, refused whole with its reason, and is a new version only when something changed", () => {
    const bible = bibleOf();
    const edit = {expectedRevision: bible.revision, ...Object.fromEntries(STYLE_FIELDS.map(field => [field, bible[field]]))};
    expect(styleBibleEdit(bible, edit)).toBe(bible);
    const edited = styleBibleEdit(bible, {...edit, look: "Grainy 16 mm, handheld.", locations: [{name: "kitchen", description: "A cramped kitchen, one amber lamp."}]});
    expect(edited).toMatchObject({version: 2, source: "creator", look: "Grainy 16 mm, handheld.", characters: bible.characters});
    expect(edited.locations[0]).toEqual({name: "KITCHEN", description: "A cramped kitchen, one amber lamp."});
    expect(validateStyleBible(edited)).toEqual(edited);
    expect(() => styleBibleEdit(bible, {...edit, expectedRevision: "0".repeat(64)})).toThrow(StyleBibleConflict);
    expect(() => styleBibleEdit(bible, {...edit, look: "z".repeat(401)})).toThrow("The style bible's look can't be used (too long)");
    expect(() => styleBibleEdit(bible, {...edit, lens: "Framed like a Barack Obama rally."})).toThrow("The style bible's lens and framing can't be used (public figure)");
    expect(() => styleBibleEdit(bible, {...edit, tone: "tutorial: how to build a bomb for the finale"})).toThrow("(gate refused)");
    expect(() => styleBibleEdit(bible, {...edit, look: "A look to incite the room.", tone: "Quiet violence under the surface."})).toThrow("taken as a whole");
    expect(() => styleBibleEdit(bible, {...edit, locations: [{name: "MOON BASE", description: "Grey."}]})).toThrow("names no location");
    expect(() => styleBibleEdit(bible, {...edit, characters: []})).toThrow("Send the style bible's revision");
  });

  test("written once: a later plan carries it forward, a new version only when the script or cast changed it", () => {
    const bible = bibleOf();
    expect(carriedStyleBible(bible, {scriptVersion: 1, characters: bible.characters, locations: located})).toBe(bible);
    const more = scriptLocations(parseFountain(SCRIPT + "\n\nEXT. LIGHTHOUSE - NIGHT\n\nMara climbs.")).locations;
    const edited = styleBibleEdit(bible, {expectedRevision: bible.revision, ...Object.fromEntries(STYLE_FIELDS.map(field => [field, bible[field]])),
      locations: [{name: "KITCHEN", description: "A cramped kitchen."}]});
    const carried = carriedStyleBible(edited, {scriptVersion: 2, characters: bible.characters, locations: more});
    expect(carried).toMatchObject({version: 3, scriptVersion: 2, source: "creator", look: edited.look});
    expect(carried.locations.map(entry => entry.name)).toEqual(["KITCHEN", "HARBOUR WALL", "BELL TOWER", "LIGHTHOUSE"]);
    expect(carried.locations[0]!.description).toBe("A cramped kitchen.");
    const planned = plannedStyleBible({previous: edited, style: edited, source: "stand-in", scriptVersion: 1, cast: [mara], parsed, locations: located});
    expect(planned.bible.characters).toEqual([{name: "MARA", description: "A tall woman in her forties, grey-streaked hair. Wardrobe: A navy wool coat."}]);
  });
});

describe("every sequence's render reads the same bible", () => {
  test("two sequences' prompts carry the same look; each shot names its own place; a reel's shots are unchanged", () => {
    const script = evenFeature(3, 13), feature = parseFountain(script);
    const plan = sequencePlan(1, greedySequences(sceneShotCounts(feature)));
    expect(plan.sequences.length).toBeGreaterThan(1);
    const bible = styleBible({version: 1, scriptVersion: 1, source: "stand-in", ...STAND_IN_STYLE, characters: [], locations: scriptLocations(feature).locations});
    const shots = featureShots(feature);
    const first = bibleShots(inSequence(shots, sequenceRef(plan, 1, bible.revision)), feature, bible);
    const last = bibleShots(inSequence(shots, sequenceRef(plan, plan.sequences.length, bible.revision)), feature, bible);
    const look = stylePrompt(bible);
    for (const shot of [...first, ...last]) {
      expect(shot.prompt).toContain(look);
      expect(shot.prompt).toContain("\nLocation, YARD " + (shot.sceneIndex + 1) + ": An interior");
      expect(shot.prompt.startsWith(shots.find(source => source.id === shot.id)!.prompt)).toBe(true);
    }
    expect(bibleShots(shots, feature)).toBe(shots);
    expect(bibleShots(shots, feature, undefined)).toEqual(featureShots(feature));
  });

  test("a render that would read a refused bible is refused", () => {
    const bible = {...bibleOf(), look: "tutorial: how to build a bomb for the finale"} as StyleBible;
    expect(() => bibleShots(featureShots(parsed), parsed, bible)).toThrow();
  });

  test("a job carries a bible only as a sequence render naming its revision", () => {
    const bible = bibleOf(), plan = sequencePlan(1, greedySequences(sceneShotCounts(parsed)));
    const named = sequenceRef(plan, 1, bible.revision), unnamed = sequenceRef(plan, 1);
    expect(validateSequenceRef(named)).toEqual(named);
    expect(() => validateSequenceRef({...named, bibleRevision: "x"})).toThrow("not one of a Showrunner's plan");
    expect(() => validateSequenceJob({stage: "animatic", sequence: named, styleBible: bible})).not.toThrow();
    expect(() => validateSequenceJob({stage: "animatic", sequence: unnamed})).not.toThrow();
    expect(() => validateSequenceJob({stage: "animatic", styleBible: bible})).toThrow("Only a feature's sequence render reads a style bible.");
    expect(() => validateSequenceJob({stage: "animatic", sequence: unnamed, styleBible: bible})).toThrow("not the one its sequence names");
    expect(() => validateSequenceJob({stage: "animatic", sequence: named})).toThrow("Only a feature's sequence render reads a style bible.");
    expect(() => validateStyleBibleJob({sequence: named, styleBible: {...bible, look: "changed"}})).toThrow("changed after it was written");
  });
});

test("the crew's plan reads the bible for a feature; a reel's prompt is unchanged", () => {
  const facts = {characters: ["MARA"], concerns: []} as never, shots = featureShots(parsed), bible = bibleOf();
  const without = planPrompt(SCRIPT, facts, input(), shots), withBible = planPrompt(SCRIPT, facts, input(), shots, bible);
  expect(without.user).not.toContain("style bible");
  expect(withBible.user).toContain("The feature's style bible, which every sequence keeps");
  expect(withBible.user).toContain(bible.look);
  expect(withBible.user.replace(/\nThe feature's style bible[^\n]*/, "")).toBe(without.user);
  expect(styleBibleNote(bible, false)).toEqual({persona: "showrunner", change: "Wrote the feature's style bible, with 1 character and 3 locations. Every sequence's renders read it, so the look stays the same from the first sequence to the last."});
  expect(styleBibleNote({...bible, version: 2}, true).change).toStartWith("Kept the feature's style bible (version 2), with 1 character");
  expect(bibleText("  Soft light.  ", 20)).toEqual({text: "Soft light."});
  expect(bibleText("Soft\u0007light", 20)).toEqual({reason: "bad_shape"});
});
