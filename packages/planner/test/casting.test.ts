import { expect, test } from "bun:test";
import { CAST_INPUT, CAST_SCRIPT } from "../../../test/fixtures/casting";
import { ProjectService } from "../../api/src/index";
import { parseFountain } from "../../parser/src/index";
import { planShots } from "../src/index";
import { assertCurrentCastPermission, castingSnapshot, characterRecord, currentCasting, directCast, validateCasting } from "../src/casting";
process.env.HV_TOKEN_SECRET = "casting-fixture-secret-at-least-thirty-two-characters";
const now = Date.now();
const actor = (input: unknown = CAST_INPUT) => characterRecord(input, crypto.randomUUID(), now);
const snapshot = (character = actor()) => castingSnapshot("project-1", 1, [character], now);
const parsed = parseFountain(CAST_SCRIPT), shots = planShots(parsed, 7000, 24);

test("cast snapshots bind project, revision and complete normalized character direction", () => {
  const cast = snapshot();
  expect(validateCasting(cast, "project-1")).toEqual(cast);
  expect(() => validateCasting(cast, "another-project")).toThrow();
  expect(() => validateCasting({...cast, characters: [{...cast.characters[0]!, appearance: "Changed"}]}, "project-1")).toThrow("changed");
  expect(() => actor({...CAST_INPUT, kind: "real-person"})).toThrow("consented real person");
  expect(() => actor({...CAST_INPUT, permission: {...CAST_INPUT.permission, attested: false}})).toThrow("Confirm permission");
  expect(() => actor({...CAST_INPUT, referenceUrl: "https://untrusted.invalid"})).toThrow();
});

test("scene casts match names and aliases, preserve source prompts and apply scene wardrobe", () => {
  const character = actor({...CAST_INPUT, wardrobe: [...CAST_INPUT.wardrobe, {sceneNumber: 2, description: "A yellow raincoat"}]});
  const directed = directCast(shots, parsed, snapshot(character), now);
  expect(directed[0]!.prompt).toContain("A navy scarf"); expect(directed[1]!.prompt).toContain("A yellow raincoat");
  expect(directed[1]!.prompt).not.toContain("A navy scarf");
  expect(directed.every(shot => shot.characterIds?.[0] === character.id)).toBe(true);
  expect(directed.map(shot => shot.sourcePrompt)).toEqual(shots.map(shot => shot.prompt));
  const unrelated = parseFountain("EXT. FIELD - DAY\n\nSpudding grass bends.");
  expect(directCast(planShots(unrelated), unrelated, snapshot(character), now)[0]!.characterIds).toEqual([]);
});

test("expired, pending, revoked and out-of-scope character permissions refuse generation", () => {
  for (const permission of [{...CAST_INPUT.permission, status: "pending"}, {...CAST_INPUT.permission, status: "revoked"},
    {...CAST_INPUT.permission, scope: "scenes", sceneNumbers: [1]}]) {
    expect(() => directCast(shots, parsed, snapshot(actor({...CAST_INPUT, permission})), now)).toThrow("not permitted");
  }
  const permitted = actor({...CAST_INPUT, permission: {...CAST_INPUT.permission, expiresAt: new Date(now + 1000).toISOString()}});
  expect(() => directCast(shots, parsed, snapshot(permitted), now + 1001)).toThrow("not permitted");
});

test("cast metadata reaches the existing policy filter before any generation request", () => {
  expect(() => directCast(shots, parsed, snapshot(actor({...CAST_INPUT, appearance: "The exact likeness of a famous actress"})), now)).toThrow();
  expect(() => directCast(shots, parsed, snapshot(actor({...CAST_INPUT, prohibitedChanges: "a minor in a sexual scene"})), now)).toThrow();
});

test("latest permission applies to an old saved description without changing its visual plan", () => {
  const saved = snapshot(), original = saved.characters[0]!;
  const changed = castingSnapshot("project-1", 2, [{...original, appearance: "A green coat"}], now);
  expect(() => assertCurrentCastPermission(saved, changed, [original.id], 1, now)).not.toThrow();
  const revoked = castingSnapshot("project-1", 3, [{...original, permission: {...original.permission, status: "revoked"}}], now);
  expect(() => assertCurrentCastPermission(saved, revoked, [original.id], 1, now)).toThrow("not permitted");
  expect(() => assertCurrentCastPermission(saved, castingSnapshot("project-1", 4, [], now), [original.id], 1, now)).toThrow("removed");
});

test("project cast versions reject stale saves and restoring direction cannot restore permission", () => {
  const service = new ProjectService(), owner = service.createAnonymousProject(now);
  service.editScript(owner.token, CAST_SCRIPT, now);
  const id = crypto.randomUUID();
  const first = service.saveCharacter(owner.token, id, CAST_INPUT, 0, now)!;
  expect(first.version).toBe(1);
  expect(() => service.saveCharacter(owner.token, id, CAST_INPUT, 0, now)).toThrow("another session");
  service.saveCharacter(owner.token, id, {...CAST_INPUT, appearance: "A blue potato"}, 1, now);
  const restored = service.restoreCasting(owner.token, 1, 2, now)!;
  expect(restored.characters[0]!.appearance).toBe(CAST_INPUT.appearance);
  expect(restored.characters[0]!.permission.status).toBe("pending");
  expect(service.authorize(owner.token, now)!.castingHistory[0]).toEqual(first);
  const reloaded = ProjectService.fromState(service.snapshot());
  expect(currentCasting(owner.projectId, reloaded.authorize(owner.token, now)!.castingHistory)).toEqual(restored);
});

test("scene-bound direction must be reviewed after headings move or change", () => {
  const service = new ProjectService(), owner = service.createAnonymousProject(now);
  service.editScript(owner.token, CAST_SCRIPT, now);
  const cast = service.saveCharacter(owner.token, crypto.randomUUID(), {...CAST_INPUT, wardrobe: [{sceneNumber: 2, description: "A yellow coat"}]}, 0, now)!;
  expect(cast.characters[0]!.sceneBindings).toEqual([{sceneNumber: 2, heading: "INT. KITCHEN - NIGHT"}]);
  const changed = parseFountain(CAST_SCRIPT.replace("INT. KITCHEN - NIGHT", "EXT. PARK - DAY"));
  expect(() => directCast(planShots(changed), changed, cast, now)).toThrow("Scene 2 changed");
});

test("bounded recent history does not prevent later permission revocation", () => {
  const service = new ProjectService(), owner = service.createAnonymousProject(now), id = crypto.randomUUID();
  for (let version = 0; version < 101; version++) service.saveCharacter(owner.token, id, CAST_INPUT, version, now);
  const revoked = service.saveCharacter(owner.token, id, {...CAST_INPUT, permission: {...CAST_INPUT.permission, status: "revoked"}}, 101, now)!;
  expect(revoked.version).toBe(102); expect(revoked.characters[0]!.permission.status).toBe("revoked");
  expect(service.authorize(owner.token, now)!.castingHistory).toHaveLength(100);
});

test("a renewed scene-specific permission cannot authorize an older different scene with the same number", () => {
  const service = new ProjectService(), owner = service.createAnonymousProject(now), id = crypto.randomUUID();
  service.editScript(owner.token, CAST_SCRIPT, now);
  const saved = service.saveCharacter(owner.token, id, CAST_INPUT, 0, now)!;
  service.editScript(owner.token, CAST_SCRIPT.replace("EXT. GARDEN - DAY", "EXT. PARK - DAY"), now);
  const renewed = service.saveCharacter(owner.token, id, {...CAST_INPUT, permission: {...CAST_INPUT.permission, scope: "scenes", sceneNumbers: [1]}}, 1, now)!;
  expect(() => assertCurrentCastPermission(saved, renewed, [id], 1, now, "EXT. GARDEN - DAY")).toThrow("different version");
  expect(() => assertCurrentCastPermission(saved, renewed, [id], 1, now, "EXT. PARK - DAY")).not.toThrow();
});
