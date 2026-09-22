/**
 * HV-031-04 / G12-202609191900 -- real people appear only through consent.
 *
 * The operator asked to cast himself from his own photos. The policy that follows:
 * a cast member is an original fictional character or a real person who consented
 * (the creator, or someone who gave the creator permission); a public figure is
 * refused by name wherever it appears, because consent for one cannot be attested
 * from an anonymous studio.
 */
import {describe, expect, test} from "bun:test";
import {CAST_INPUT, CAST_SCRIPT} from "../../../test/fixtures/casting";
import {ProjectService} from "../../api/src/index";
import {parseFountain} from "../../parser/src/index";
import {PUBLIC_FIGURES, checkPrompt, namesPublicFigure} from "../../safety/src/index";
import {planShots} from "../src/index";
import {contentHash} from "../../generator/src/capabilities";
import {ActorShareUnavailable, assertShareable, createActorShare, importedActor, validateActorShare} from "../src/actor-library";
import {castingSnapshot, characterRecord, currentCasting, directCast, validateCasting} from "../src/casting";
import {characterSheetShots, createCharacterSheet} from "../src/sheets";

process.env.HV_TOKEN_SECRET = "consented-casting-secret-at-least-thirty-two-characters";
const now = Date.parse("2026-09-19T12:00:00.000Z");
const ID = "0f1e2d3c-4b5a-4968-8776-655443322110";
const parsed = parseFountain(CAST_SCRIPT), shots = planShots(parsed, 7000, 24);
const SELF = {...CAST_INPUT, kind: "consented-real-person", appearance: "Man in his forties, short dark hair, trimmed beard, brown eyes.",
  permission: {...CAST_INPUT.permission, consent: "self"}};
const record = (input: unknown) => characterRecord(input, ID, now);
const cast = (character = record(SELF)) => castingSnapshot("project-1", 1, [character], now);

describe("a consented real person can be cast", () => {
  test("yourself, or with permission: accepted, kept through save and reload, and rendered", () => {
    for (const consent of ["self", "permission"] as const) {
      const snapshot = cast(record({...SELF, permission: {...SELF.permission, consent}}));
      const character = snapshot.characters[0]!;
      expect(character.kind).toBe("consented-real-person");
      expect(character.permission.consent).toBe(consent);
      expect(validateCasting(snapshot, "project-1")).toEqual(snapshot);
      const directed = directCast(shots, parsed, snapshot, now);
      expect(directed.length).toBe(shots.length);
      for (const shot of directed) expect(checkPrompt(shot.prompt).allowed).toBe(true);
    }
  });

  test("the service saves it, and restoring an old version asks for consent again", () => {
    const service = new ProjectService(), owner = service.createAnonymousProject(now);
    service.editScript(owner.token, CAST_SCRIPT, now);
    const saved = service.saveCharacter(owner.token, ID, SELF, 0, now)!;
    expect(saved.characters[0]).toMatchObject({kind: "consented-real-person", permission: {status: "permitted", consent: "self"}});
    service.saveCharacter(owner.token, ID, {...SELF, appearance: "Clean-shaven now."}, 1, now);
    const restored = service.restoreCasting(owner.token, 1, 2, now)!;
    expect(restored.characters[0]!.permission.status).toBe("pending");
    expect(restored.characters[0]!.permission.consent).toBeUndefined();
    const reloaded = ProjectService.fromState(service.snapshot());
    expect(currentCasting(owner.projectId, reloaded.authorize(owner.token, now)!.castingHistory)).toEqual(restored);
  });

  test("revoking consent stops rendering and drops the consent from the record", () => {
    const service = new ProjectService(), owner = service.createAnonymousProject(now);
    service.editScript(owner.token, CAST_SCRIPT, now);
    service.saveCharacter(owner.token, ID, SELF, 0, now);
    const revoked = service.revokeCharacterPermission(owner.token, ID, 1, now)!;
    expect(revoked.characters[0]!.permission).toMatchObject({status: "revoked"});
    expect(revoked.characters[0]!.permission.consent).toBeUndefined();
    expect(() => directCast(shots, parsed, revoked, now)).toThrow("not permitted");
  });

  test("a character sheet of a real person reaches the gate without describing them as 'a real person'", () => {
    const snapshot = cast();
    const sheet = createCharacterSheet(snapshot, parsed, ID, {kind: "turnaround", seed: 1, sceneNumber: null});
    for (const shot of characterSheetShots(sheet, snapshot, parsed, now)) {
      expect(shot.prompt).toContain("One view of only the named cast member, as shown in the reference images.");
      expect(checkPrompt(shot.prompt).allowed).toBe(true);
    }
  });
});

describe("consent must be declared, and only where it means something", () => {
  test("permitting a real person needs the attestation and whose consent it is", () => {
    expect(() => record({...SELF, permission: {...SELF.permission, attested: false}})).toThrow("this is you");
    const {consent: _consent, ...withoutConsent} = SELF.permission;
    expect(() => record({...SELF, permission: withoutConsent})).toThrow("whose consent");
    expect(() => record({...SELF, permission: {...SELF.permission, consent: "implied"}})).toThrow("whose consent");
    // A pending record may be drafted before consent is declared.
    expect(record({...SELF, permission: {...withoutConsent, status: "pending", attested: false}}).permission.consent).toBeUndefined();
  });

  test("a fictional character cannot carry a consent, and unknown kinds are refused", () => {
    expect(() => record({...CAST_INPUT, permission: {...CAST_INPUT.permission, consent: "self"}})).toThrow();
    for (const kind of ["real-person", "public-figure", "", undefined]) expect(() => record({...CAST_INPUT, kind})).toThrow("consented real person");
  });

  test("an existing fictional cast keeps its exact revision", () => {
    // Pinned from origin/main before this change: adding a kind must not re-hash saved casts.
    expect(cast(record(CAST_INPUT)).revision).toBe("3eded0d7e0527eeb61afa58de1e923890966722ad3ff00c094b43cf361afdc88");
    expect(cast(record(CAST_INPUT)).characters[0]!.permission).not.toHaveProperty("consent");
  });
});

describe("public figures are refused by name", () => {
  test("in a prompt, in any case, with or without accents, and in possessive form", () => {
    for (const prompt of ["A portrait of Taylor Swift", "a portrait of TAYLOR SWIFT", "taylor swift's guitar on a stool",
      "Beyonce sings", "Beyoncé sings", "Timothee Chalamet runs", "kim jong-un waves", "Jay Z raps", "Samuel L Jackson shouts",
      "Robert Downey Jr. smirks", "ELON MUSK", "A mural of Donald Trump"]) {
      expect(checkPrompt(prompt)).toMatchObject({allowed: false, category: "named_public_figure", providerCallsMade: 0});
      expect(checkPrompt(prompt).refusal).toContain("consented cast member");
    }
  });

  test("ordinary words that share a figure's name still pass", () => {
    for (const prompt of ["Taylor walks swiftly to the car.", "A swift river runs past the gate.", "Paris at night, rain on the cobbles.",
      "Jordan's mother waits at the station.", "A Madonna and child painting hangs in the hall.", "Tim, cook the eggs.",
      "Leonardo sketches a flying machine.", "Pope Leonard III blesses the fictional crowd.", "Will, smith the blade.",
      "A drake paddles across the pond.", "Prince, the old dog, sleeps by the fire.",
      // Whole words only, on both sides (synthetic names).
      "Mastaylor Swift founded the guild.", "Taylor Swiftwater crosses the bridge."])
      expect(checkPrompt(prompt).allowed).toBe(true);
  });

  test("every listed name is refused on its own, and is listed once", () => {
    for (const name of PUBLIC_FIGURES) expect(namesPublicFigure(name)).toBe(true);
    expect(new Set(PUBLIC_FIGURES).size).toBe(PUBLIC_FIGURES.length);
    expect(PUBLIC_FIGURES.length).toBeGreaterThanOrEqual(150);
  });

  test("a cast record naming one is refused when saved, whatever its kind", () => {
    for (const input of [{...SELF, name: "TAYLOR SWIFT"}, {...CAST_INPUT, name: "Elon Musk"}, {...SELF, aliases: ["Beyonce"]},
      {...SELF, appearance: "Looks exactly like Tom Cruise."}])
      expect(() => record(input)).toThrow("public figure");
  });

  /**
   * HV-031-05. The check read three of the record's twelve free-text fields -- name, aliases and
   * appearance -- while `describeCharacter` puts all twelve plus the wardrobe into every shot
   * prompt. A listed figure in `hairMakeup` saved clean and was refused at generation, where the
   * creator has already committed to the film and the refusal names no field.
   */
  test("every free-text field the prompt carries is read at the save, not the three that were", () => {
    const base = record(CAST_INPUT);
    const fields = Object.entries(base).filter(([key, value]) => typeof value === "string" && !["id", "kind"].includes(key)).map(([key]) => key);
    expect(fields.length).toBeGreaterThanOrEqual(11);
    expect(fields).toContain("hairMakeup");
    const refusal = (input: unknown) => {try {record(input); return "accepted";} catch (error) {return (error as Error).message;}};
    for (const field of fields)
      expect({field, message: refusal({...CAST_INPUT, [field]: "Looks exactly like Taylor Swift."})})
        .toEqual({field, message: expect.stringContaining("public figure")});
    // The wardrobe is not a field of the record and is in every prompt the record reaches.
    expect(() => record({...CAST_INPUT, wardrobe: [{sceneNumber: null, description: "The coat Elon Musk wore."}]})).toThrow("public figure");
    // A record with none of it still saves, so the widening refused nothing it should not have.
    expect(record({...CAST_INPUT, hairMakeup: "Close-cropped, no makeup."}).hairMakeup).toBe("Close-cropped, no makeup.");
  });

  test("an actor import reads the text it carries, which was written in another project under another list", () => {
    const source = "11111111-2222-4333-8444-555555555555", destination = "22222222-3333-4444-8555-666666666666";
    // Exactly the state a list that grew leaves behind: saved before the name was listed, and not
    // re-judged on read. It is the only way this text can exist, and it is not hypothetical.
    const character = characterRecord({...record(CAST_INPUT), wardrobe: [{sceneNumber: 1, description: "The coat Taylor Swift wore."}],
      sceneBindings: [{sceneNumber: 1, heading: "INT. ROOM - DAY"}]}, ID, now, true);
    // A share minted before the name was listed. HV-031-06 made `createActorShare` refuse this at
    // the mint, which is where an owner can do something about it; a share already in the world
    // cannot be re-minted, so the import's own check is what stands between it and this project.
    // Built here exactly as `createActorShare` builds one, minus the checks it did not yet have.
    const timestamp = new Date(now).toISOString();
    const definition = {schema: "hv-actor-share/1" as const, id: crypto.randomUUID(), projectId: source,
      castingRevision: castingSnapshot(source, 1, [character], now).revision, character: structuredClone(character),
      createdAt: timestamp, expiresAt: new Date(now + 86_400_000).toISOString(), attestedAt: timestamp};
    const share = validateActorShare({...definition, revision: contentHash(definition), revokedAt: null}, source);
    // The scene wardrobe becomes a costume preset, which is the field nothing had ever read.
    expect(share.character.wardrobe.some(entry => entry.description.includes("Taylor Swift"))).toBe(true);
    // An import must be saved as a stored record -- it carries presets and a library origin, which
    // only a stored record may hold -- so `characterRecord` alone would never have looked at it.
    expect(() => importedActor(share, "33333333-4444-4555-8666-777777777777", destination, "Marguerite", [], [], now)).toThrow("public figure");
    // A clean share still mints and still imports, with its presets.
    const clean = createActorShare(castingSnapshot(source, 1, [characterRecord({...record(CAST_INPUT),
      wardrobe: [{sceneNumber: 1, description: "A salt-stained oilskin coat."}], sceneBindings: [{sceneNumber: 1, heading: "INT. ROOM - DAY"}]}, ID, now, true)], now),
      ID, new Date(now + 86_400_000).toISOString(), now);
    const imported = importedActor(clean, "33333333-4444-4555-8666-777777777777", destination, "Marguerite", [], [], now);
    expect(imported.costumePresets?.map(preset => preset.description)).toEqual(["A salt-stained oilskin coat."]);
  });

  test("a saved record is not re-judged on read, so a longer list never makes a cast unreadable", () => {
    const stored = {...cast().characters[0]!, name: "Taylor Swift"};
    expect(characterRecord(stored, ID, now, true).name).toBe("Taylor Swift");
    // It still cannot render: the prompt gate sees the name.
    expect(() => directCast(planShots(parseFountain("INT. ROOM - DAY\n\nTaylor Swift waves.\n\nTAYLOR SWIFT\nHello."), 7000, 24),
      parseFountain("INT. ROOM - DAY\n\nTaylor Swift waves.\n\nTAYLOR SWIFT\nHello."), castingSnapshot("project-1", 1, [stored], now), now)).toThrow();
  });
});

describe("a real person's consent stays in its project", () => {
  test("an actor share of a real person is refused at mint", () => {
    expect(() => assertShareable(cast().characters[0]!, now)).toThrow(ActorShareUnavailable);
    expect(() => createActorShare(cast(), ID, new Date(now + 86_400_000).toISOString(), now)).toThrow(ActorShareUnavailable);
  });

  test("and at every read, if a shared fictional actor later becomes a real person", () => {
    const fictional = castingSnapshot("11111111-2222-4333-8444-555555555555", 1, [record(CAST_INPUT)], now);
    const share = createActorShare(fictional, ID, new Date(now + 86_400_000).toISOString(), now);
    expect(validateActorShare(share, fictional.projectId).character.kind).toBe("original-fictional");
    // A share whose hashes are intact but whose actor is a real person: refused for its kind, not its hash.
    const {revision: _revision, revokedAt: _revoked, ...definition} = share;
    const realDefinition = {...definition, character: record(SELF)};
    const real = {...realDefinition, revision: contentHash(realDefinition), revokedAt: null};
    expect(() => validateActorShare(real, fictional.projectId)).toThrow(ActorShareUnavailable);
    expect(() => assertShareable(record(SELF), now)).toThrow(ActorShareUnavailable);
  });
});

/**
 * HV-031-06 — the mint has to ask what the import will ask.
 *
 * HV-031-05 taught `importedActor` to read every free-text field of the record it saves, costume
 * preset names included. It did not teach `createActorShare` the same question, so this module
 * stopped honouring the rule written four lines above its own preset check: a share could mint
 * carrying a preset named after a screenplay scene heading that the import refuses. A share is
 * immutable and lives seven days, so that is every recipient, every time, for its whole life — and
 * the refusal names the *cast record*, which is clean, because a record's own save never reads
 * `sceneBindings` and `PUT /script` does not gate scene headings.
 */
describe("a share that cannot be imported is not a share", () => {
  const project = "11111111-2222-4333-8444-555555555555";
  /** A saved actor whose scene-bound wardrobe will become a preset named after its heading. */
  const bound = (heading: string, description = "A salt-stained oilskin coat.") =>
    characterRecord({...record(CAST_INPUT), wardrobe: [{sceneNumber: 1, description}],
      sceneBindings: [{sceneNumber: 1, heading}]}, ID, now, true);

  test("a scene heading that names a public figure is refused at the mint, not at every import", () => {
    const character = bound("INT. TAYLOR SWIFT'S DRESSING ROOM - NIGHT");
    // The record itself is clean: its own save reads its twelve fields, aliases and wardrobe, and a
    // scene binding is none of those.
    expect(() => characterRecord({...character, permission: {...character.permission}}, ID, now, true)).not.toThrow();
    expect(() => createActorShare(castingSnapshot(project, 1, [character], now), ID, new Date(now + 86_400_000).toISOString(), now))
      .toThrow("cannot be shared as written");
    // The message says what to do about it, because the owner is the only person who can.
    try {createActorShare(castingSnapshot(project, 1, [character], now), ID, new Date(now + 86_400_000).toISOString(), now);}
    catch (error) {expect((error as Error).message).toContain("Rename the scene");}
  });

  test("and so is a wardrobe description, which is the same question one field over", () => {
    const character = bound("INT. LIGHTHOUSE - NIGHT", "The coat Elon Musk wore.");
    expect(() => createActorShare(castingSnapshot(project, 1, [character], now), ID, new Date(now + 86_400_000).toISOString(), now))
      .toThrow("cannot be shared as written");
  });

  test("a clean actor still shares, and what it shares still imports", () => {
    const character = bound("INT. LIGHTHOUSE - NIGHT");
    const share = createActorShare(castingSnapshot(project, 1, [character], now), ID, new Date(now + 86_400_000).toISOString(), now);
    const imported = importedActor(share, "33333333-4444-4555-8666-777777777777",
      "22222222-3333-4444-8555-666666666666", "Marguerite", [], [], now);
    expect(imported.costumePresets?.map(preset => preset.description)).toEqual(["A salt-stained oilskin coat."]);
    expect(imported.costumePresets![0]!.name).toContain("INT. LIGHTHOUSE - NIGHT");
  });

  test("every share that mints can be imported, which is the rule this file is about", () => {
    // Asserted over the pair rather than over one example: whatever the mint accepts, the import
    // takes. The two questions are the same function now, so a future field that one reads and the
    // other does not fails here.
    for (const heading of ["INT. LIGHTHOUSE - NIGHT", "EXT. A ROAD - DAY", "INT. TAYLOR SWIFT'S DRESSING ROOM - NIGHT"]) {
      const character = bound(heading);
      let share;
      try {share = createActorShare(castingSnapshot(project, 1, [character], now), ID, new Date(now + 86_400_000).toISOString(), now);}
      catch {continue;}
      expect({heading, imported: Boolean(importedActor(share, "33333333-4444-4555-8666-777777777777",
        "22222222-3333-4444-8555-666666666666", "Marguerite", [], [], now))}).toEqual({heading, imported: true});
    }
  });
});
