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
import {ActorShareUnavailable, assertShareable, createActorShare, validateActorShare} from "../src/actor-library";
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
