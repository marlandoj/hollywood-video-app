import { contentHash } from "../../generator/src/capabilities";
import { gateOrThrow } from "../../safety/src/index";
import type { ParseResult } from "../../parser/src/index";
import type { Shot } from "./index";
import { validateReference, type ReferenceAsset } from "./references";

export interface CharacterPermission {
  status: "pending" | "permitted" | "revoked";
  scope: "project" | "scenes";
  sceneNumbers: number[];
  expiresAt: string | null;
  attestedAt: string | null;
}
export interface CastCharacter {
  id: string; name: string; aliases: string[]; kind: "original-fictional";
  appearance: string; ageRange: string; ethnicity: string; body: string; hairMakeup: string;
  expressions: string; movement: string; relationships: string; arcNotes: string; prohibitedChanges: string;
  wardrobe: {sceneNumber: number | null; description: string}[];
  permission: CharacterPermission;
  sceneBindings: {sceneNumber: number; heading: string}[];
  references?: ReferenceAsset[];
  libraryOrigin?: {projectId:string;characterId:string;shareId:string;revision:string;importedAt:string};
  costumePresets?: {name:string;description:string}[];
}
export interface CastingSnapshot {
  schema: "hv-casting/1"; projectId: string; version: number; revision: string; createdAt: string; characters: CastCharacter[];
}
export class CastingConflict extends Error {override name = "CastingConflict";}
export class CastingPermissionError extends Error {override name = "SafetyRefusal";}
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const TEXT_LIMITS = {name: 80, appearance: 1000, ageRange: 80, ethnicity: 120, body: 240, hairMakeup: 400,
  expressions: 400, movement: 400, relationships: 600, arcNotes: 600, prohibitedChanges: 600};
function object(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Enter a valid character record.");
  return input as Record<string, unknown>;
}
function text(input: unknown, name: string, limit: number, required = false): string {
  if (typeof input !== "string" || input.length > limit || Array.from(input).some(character => {const code = character.charCodeAt(0); return code === 127 || (code < 32 && ![9,10,13].includes(code));})) throw new Error(name + " must be text up to " + limit + " characters.");
  const value = input.trim();
  if (required && !value) throw new Error(name + " is required.");
  return value;
}
function permission(input: unknown, now: number, stored = false): CharacterPermission {
  const value = object(input);
  const allowed = stored ? ["status", "scope", "sceneNumbers", "expiresAt", "attestedAt"] : ["status", "scope", "sceneNumbers", "expiresAt", "attested"];
  if (Object.keys(value).some(key => !allowed.includes(key)) || !["pending", "permitted", "revoked"].includes(String(value.status))
    || !["project", "scenes"].includes(String(value.scope)) || !Array.isArray(value.sceneNumbers) || value.sceneNumbers.length > 200
    || value.sceneNumbers.some(number => !Number.isInteger(number) || number < 1 || number > 1000)
    || (value.scope === "scenes" && !value.sceneNumbers.length) || (value.scope === "project" && value.sceneNumbers.length)) throw new Error("Choose valid character permissions and scene numbers.");
  const expiry = value.expiresAt === null ? null : text(value.expiresAt, "Permission expiry", 40);
  if (expiry !== null && !Number.isFinite(Date.parse(expiry))) throw new Error("Choose a valid permission expiry.");
  if (!stored && value.status === "permitted" && (value.attested !== true || (expiry !== null && Date.parse(expiry) <= now)))
    throw new Error("Confirm permission for this original fictional character and choose a future expiry.");
  const attestedAt = stored ? value.attestedAt as string | null : value.status === "permitted" ? new Date(now).toISOString() : null;
  if (attestedAt !== null && (typeof attestedAt !== "string" || !Number.isFinite(Date.parse(attestedAt)))) throw new Error("Invalid character attestation.");
  if (value.status === "permitted" && !attestedAt) throw new Error("Character permission has no attestation.");
  return {status: value.status as CharacterPermission["status"], scope: value.scope as CharacterPermission["scope"],
    sceneNumbers: [...new Set(value.sceneNumbers as number[])].sort((a,b) => a-b), expiresAt: expiry === null ? null : new Date(expiry).toISOString(), attestedAt};
}
export function characterRecord(input: unknown, id: string, now = Date.now(), stored = false): CastCharacter {
  const value = object(input);
  const allowed = ["id", "kind", "aliases", "wardrobe", "permission", ...(stored ? ["sceneBindings", "references", "libraryOrigin", "costumePresets"] : []), ...Object.keys(TEXT_LIMITS)];
  if (!UUID.test(id) || Object.keys(value).some(key => !allowed.includes(key)) || (value.id !== undefined && value.id !== id)
    || value.kind !== "original-fictional") throw new Error("Use an original fictional character record with a valid ID.");
  const fields = Object.fromEntries(Object.entries(TEXT_LIMITS).map(([key, limit]) => [key, text(value[key] ?? "", key, limit, key === "name")])) as Pick<CastCharacter, keyof typeof TEXT_LIMITS>;
  if (!Array.isArray(value.aliases) || value.aliases.length > 8 || !Array.isArray(value.wardrobe) || value.wardrobe.length > 24) throw new Error("A character supports up to 8 aliases and 24 wardrobe entries.");
  const aliases = [...new Set(value.aliases.map(alias => text(alias, "Alias", 80, true)))];
  const wardrobe = value.wardrobe.map(item => {
    const entry = object(item);
    if (Object.keys(entry).sort().join(",") !== "description,sceneNumber" || (entry.sceneNumber !== null && (!Number.isInteger(entry.sceneNumber) || Number(entry.sceneNumber) < 1 || Number(entry.sceneNumber) > 1000))) throw new Error("Choose a valid wardrobe scene.");
    return {sceneNumber: entry.sceneNumber as number | null, description: text(entry.description, "Wardrobe", 600, true)};
  });
  if (new Set(wardrobe.map(entry => entry.sceneNumber)).size !== wardrobe.length) throw new Error("Use one wardrobe entry per scene and one project default.");
  const sceneBindings = stored ? value.sceneBindings : [];
  if (!Array.isArray(sceneBindings) || sceneBindings.length > 224 || sceneBindings.some(value => !value || Object.keys(value).sort().join(",") !== "heading,sceneNumber" || !Number.isInteger(value.sceneNumber) || value.sceneNumber < 1 || value.sceneNumber > 1000 || typeof value.heading !== "string" || value.heading.length > 1000)
    || new Set(sceneBindings.map(value => value.sceneNumber)).size !== sceneBindings.length) throw new Error("Invalid saved cast scene bindings.");
  let references: ReferenceAsset[] | undefined;
  if (stored && value.references !== undefined) {
    if (!Array.isArray(value.references) || value.references.length > 4) throw new Error("A character supports up to four reference images.");
    references = value.references.map(asset => validateReference(asset,asset.projectId));
    if (new Set(references.map(asset => asset.id)).size !== references.length) throw new Error("Duplicate character reference.");
  }
  const origin=value.libraryOrigin as CastCharacter["libraryOrigin"],presets=value.costumePresets as CastCharacter["costumePresets"];
  if(origin!==undefined && (!origin || Object.keys(origin).sort().join(",")!=="characterId,importedAt,projectId,revision,shareId" || ![origin.projectId,origin.characterId,origin.shareId].every(id=>UUID.test(id))
    || !/^[a-f0-9]{64}$/.test(origin.revision) || typeof origin.importedAt!=="string" || !Number.isFinite(Date.parse(origin.importedAt))))throw new Error("Invalid imported actor origin.");
  if(presets!==undefined && (!Array.isArray(presets) || presets.length>48 || presets.some(preset=>!preset || Object.keys(preset).sort().join(",")!=="description,name"
    || text(preset.name,"Costume preset",1100,true)!==preset.name || text(preset.description,"Costume preset",600,true)!==preset.description)))throw new Error("Invalid imported costume presets.");
  return {id, kind: "original-fictional", ...fields, aliases, wardrobe, permission: permission(value.permission, now, stored), sceneBindings: structuredClone(sceneBindings),
    ...(references === undefined ? {} : {references}),...(origin===undefined?{}:{libraryOrigin:structuredClone(origin)}),...(presets===undefined?{}:{costumePresets:structuredClone(presets)})};
}
export function castingSnapshot(projectId: string, version: number, characters: CastCharacter[], now = Date.now()): CastingSnapshot {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(projectId) || !Number.isSafeInteger(version) || version < 0) throw new Error("Invalid cast version.");
  if (!Array.isArray(characters) || characters.length > 24) throw new Error("A project supports up to 24 cast records.");
  const records = characters.map(value => characterRecord(value, value.id, now, true));
  for (const character of records) for (const reference of character.references ?? []) validateReference(reference,projectId);
  const labels = records.flatMap(character => [character.name, ...character.aliases].map(name => name.toLocaleUpperCase("en-US")));
  if (new Set(records.map(value => value.id)).size !== records.length || new Set(labels).size !== labels.length) throw new Error("Character names and aliases must identify only one cast record.");
  const data = {projectId, version, characters: records};
  return {schema: "hv-casting/1", ...data, createdAt: new Date(now).toISOString(), revision: contentHash(data)};
}
export function validateCasting(snapshot: CastingSnapshot, projectId: string): CastingSnapshot {
  if (!snapshot || snapshot.schema !== "hv-casting/1" || snapshot.projectId !== projectId || !Number.isFinite(Date.parse(snapshot.createdAt))) throw new Error("Invalid saved cast.");
  const validated = castingSnapshot(projectId, snapshot.version, snapshot.characters, Date.parse(snapshot.createdAt));
  if (validated.revision !== snapshot.revision) throw new Error("The saved cast changed.");
  return validated;
}
export function currentCasting(projectId: string, history: CastingSnapshot[] = []): CastingSnapshot {
  return history.length ? validateCasting(history.at(-1)!, projectId) : castingSnapshot(projectId, 0, [], 0);
}
export function castingMatches(saved: CastingSnapshot | undefined, current: CastingSnapshot): boolean {
  return saved ? saved.projectId === current.projectId && saved.version === current.version && saved.revision === current.revision : current.version === 0;
}
export function assertCharacterPermission(character: CastCharacter, sceneNumber: number, now = Date.now()): void {
  const grant = character.permission;
  if (grant.status !== "permitted" || !grant.attestedAt || (grant.expiresAt !== null && Date.parse(grant.expiresAt) <= now)
    || (grant.scope === "scenes" && !grant.sceneNumbers.includes(sceneNumber))) {
    throw new CastingPermissionError("Character " + character.name + " is not permitted in scene " + sceneNumber + ". Update casting permission before rendering.");
  }
}
function mentioned(name: string, text: string): boolean {
  const source = text.toLocaleUpperCase("en-US"), needle = name.toLocaleUpperCase("en-US");
  let from = 0;
  while ((from = source.indexOf(needle, from)) >= 0) {
    const before = source.slice(Math.max(0, from - 1), from), after = source.slice(from + needle.length, from + needle.length + 1);
    if ((!before || !/[\p{L}\p{N}_]/u.test(before)) && (!after || !/[\p{L}\p{N}_]/u.test(after))) return true;
    from += needle.length;
  }
  return false;
}
export function charactersForScene(snapshot: CastingSnapshot, sceneIndex: number, parsed: ParseResult): CastCharacter[] {
  const scene = parsed.scenes.find(value => value.index === sceneIndex);
  if (!scene) throw new Error("The cast refers to a missing screenplay scene.");
  const source = [scene.heading, ...scene.action, ...scene.dialogue.flatMap(dialogue => [dialogue.character, ...dialogue.lines])].join("\n");
  return snapshot.characters.filter(character => [character.name, ...character.aliases].some(name => mentioned(name, source)));
}
export function describeCharacter(character: CastCharacter, sceneNumber: number, wardrobeDescription?: string): string {
  const wardrobe = character.wardrobe.find(entry => entry.sceneNumber === sceneNumber) ?? character.wardrobe.find(entry => entry.sceneNumber === null);
  const directions = [["Appearance", character.appearance], ["Age range", character.ageRange], ["Ethnicity", character.ethnicity], ["Body", character.body],
    ["Hair and makeup", character.hairMakeup], ["Wardrobe", wardrobeDescription ?? wardrobe?.description], ["Expressions", character.expressions], ["Movement", character.movement],
    ["Relationships", character.relationships], ["Character arc", character.arcNotes], ["Preserve", character.prohibitedChanges]]
    .filter(([, value]) => value).map(([label, value]) => label + ": " + value + ".");
  return character.name + ". " + directions.join(" ");
}
export function directCast(shots: Shot[], parsed: ParseResult, saved: CastingSnapshot, now = Date.now()): Shot[] {
  const snapshot = validateCasting(saved, saved.projectId);
  for (const character of snapshot.characters) for (const binding of character.sceneBindings) {
    if (parsed.scenes.find(scene => scene.index + 1 === binding.sceneNumber)?.heading !== binding.heading)
      throw new CastingConflict("Scene " + binding.sceneNumber + " changed after the cast directions were saved. Review and save " + character.name + " again.");
  }
  return shots.map(shot => {
    const characters = charactersForScene(snapshot, shot.sceneIndex, parsed);
    const referenceAssets = characters.flatMap(character => character.references ?? []);
    const referenceMap = characters.flatMap(character => (character.references ?? []).map(asset =>
      "Reference image " + (referenceAssets.findIndex(value => value.id === asset.id) + 1) + " depicts " + character.name + "."));
    const descriptions = characters.map(character => {
      assertCharacterPermission(character, shot.sceneIndex + 1, now);
      return describeCharacter(character,shot.sceneIndex + 1);
    });
    const prompt = shot.prompt + (descriptions.length ? "\nCast direction for characters present in this scene; do not add appearances beyond the screenplay:\n" + descriptions.join("\n") : "")
      + (referenceMap.length ? "\nUse these visual references while following the screenplay and cast directions:\n" + referenceMap.join("\n") : "");
    if (prompt.length > 30_000) throw new Error("This scene has too much cast direction. Shorten the character notes.");
    if (descriptions.length) gateOrThrow(prompt);
    return {...shot, sourcePrompt: shot.prompt, prompt, characterIds: characters.map(character => character.id), castingRevision: snapshot.revision,
      ...(referenceAssets.length ? {referenceAssets} : {})};
  });
}
/** A saved visual description stays pinned, while revocation/expiry/scope narrowing takes effect before later dispatches. */
export function assertCurrentCastPermission(saved: CastingSnapshot, current: CastingSnapshot, characterIds: string[], sceneNumber: number, now = Date.now(), sceneHeading?: string): void {
  validateCasting(saved, current.projectId); validateCasting(current, saved.projectId);
  for (const id of characterIds) {
    const original = saved.characters.find(character => character.id === id), latest = current.characters.find(character => character.id === id);
    if (!original || !latest) throw new CastingPermissionError("A character was removed from this project's cast. Start a new preview before rendering.");
    assertCharacterPermission(original, sceneNumber, now); assertCharacterPermission(latest, sceneNumber, now);
    if (latest.permission.scope === "scenes" && (!sceneHeading || latest.sceneBindings.find(binding => binding.sceneNumber === sceneNumber)?.heading !== sceneHeading))
      throw new CastingPermissionError("Character " + latest.name + " is permitted for a different version of scene " + sceneNumber + ". Review the cast and create a new preview.");
  }
}
