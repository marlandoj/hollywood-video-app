import { contentHash } from "../../generator/src/capabilities";
import { COSTUME_PRESET_LIMIT, COSTUME_PRESET_NAME_LIMIT, assertCostumePresets, characterRecord, type CastCharacter, type CastingSnapshot } from "./casting";
import { validateReference, type ReferenceAsset } from "./references";

export const MAX_ACTOR_SHARES=48;
export const ACTOR_SHARE_TTL_MS=7*24*3600*1000;
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
export interface ActorShare {
  schema:"hv-actor-share/1";id:string;projectId:string;revision:string;castingRevision:string;
  character:CastCharacter;createdAt:string;expiresAt:string;attestedAt:string;revokedAt:string|null;
}
export class ActorShareUnavailable extends Error {override name="ActorShareUnavailable";constructor(){super("This actor share is unavailable, expired or revoked.");}}
export function validateActorShare(value:ActorShare,projectId:string):ActorShare {
  if(!value || Object.keys(value).sort().join(",")!=="attestedAt,castingRevision,character,createdAt,expiresAt,id,projectId,revision,revokedAt,schema"
    || value.schema!=="hv-actor-share/1" || value.projectId!==projectId || !UUID.test(value.id) || !UUID.test(projectId) || !value.character || typeof value.character!=="object"
    || !/^[a-f0-9]{64}$/.test(value.castingRevision) || ![value.createdAt,value.expiresAt,value.attestedAt].every(date=>typeof date==="string" && Number.isFinite(Date.parse(date)))
    || value.attestedAt!==value.createdAt || Date.parse(value.expiresAt)<=Date.parse(value.createdAt) || Date.parse(value.expiresAt)-Date.parse(value.createdAt)>ACTOR_SHARE_TTL_MS
    || (value.revokedAt!==null && (typeof value.revokedAt!=="string" || !Number.isFinite(Date.parse(value.revokedAt)))))throw new Error("Invalid saved actor share.");
  const character=characterRecord(value.character,value.character.id,Date.parse(value.createdAt),true);
  for(const reference of character.references??[])validateReference(reference,projectId);
  const {revision,revokedAt:_revokedAt,...definition}=value;
  if(contentHash(definition)!==revision || contentHash(character)!==contentHash(value.character))throw new Error("The saved actor share changed.");
  return structuredClone(value);
}
/**
 * The name an imported scene-bound costume gets, built so the validator that
 * reads it back can accept it.
 *
 * `importedActor` used to concatenate a screenplay scene heading straight into
 * this name: `"Scene " + n + " — " + heading`. Headings are validated on the way
 * in only for being a string of at most 1000 characters -- `characterRecord`
 * checks nothing about their content -- while the preset name is validated by
 * `text(..., "Costume preset", 1100, true)`, which refuses control characters
 * and requires the value to equal its own trim.
 *
 * So a forced Fountain heading carrying a control character produced a share
 * that **no one could ever import**: `createActorShare`
 * never runs the import-side construction, the share is revision-hashed and
 * immutable, and every import attempt by every recipient fails the same way for
 * its whole seven-day life. The message blamed length, which was never the
 * cause -- the longest reachable name is 6 + 4 + 3 + 1000 = 1013 characters,
 * comfortably inside the 1100 limit.
 */
export function costumePresetName(sceneNumber:number,heading?:string):string {
  // Tab, newline and carriage return are the three control characters the
  // validator *allows*, so they are replaced with a space rather than deleted:
  // a heading of "HALL<TAB>DAY" used to import fine and must not silently
  // become "HALLDAY". Everything else below 32, and DEL, is removed.
  const label=[...(heading??"")].map(character=>{const code=character.charCodeAt(0);
    return [9,10,13].includes(code)?" ":code===127||code<32?"":character;}).join("").trim()||"Shared costume";
  const name="Scene "+sceneNumber+" \u2014 "+label;
  // Unreachable today -- a heading is capped at 1000 and a scene number at
  // 1000, so the longest name is 1013 of 1100 -- and kept because the clamp is
  // what makes that arithmetic not need to be true. Sliced by code point, so a
  // clamp can never cut an astral character in half.
  return name.length>COSTUME_PRESET_NAME_LIMIT?[...name].slice(0,COSTUME_PRESET_NAME_LIMIT).join("").trim():name;
}
/**
 * The costume presets an import derives from a share.
 *
 * One rule in one place: `createActorShare` refuses a share whose presets could
 * not be imported, and `importedActor` builds them. A share that mints is
 * importable by construction, rather than by two pieces of code agreeing.
 */
export function sharedCostumePresets(character:CastCharacter):{name:string;description:string}[] {
  const presets=[...(character.costumePresets??[]),...character.wardrobe.filter(value=>value.sceneNumber!==null).map(value=>({
    name:costumePresetName(value.sceneNumber!,character.sceneBindings.find(binding=>binding.sceneNumber===value.sceneNumber)?.heading),
    description:value.description}))];
  return presets.filter((preset,index)=>presets.findIndex(value=>value.name===preset.name&&value.description===preset.description)===index);
}
export function assertShareable(character:CastCharacter,now=Date.now()):void {
  if(character.permission.status!=="permitted" || character.permission.scope!=="project" || !character.permission.attestedAt
    || (character.permission.expiresAt!==null && Date.parse(character.permission.expiresAt)<=now))throw new ActorShareUnavailable();
}
export function createActorShare(casting:CastingSnapshot,characterId:string,deleteAfter:string,now=Date.now()):ActorShare {
  const character=casting.characters.find(value=>value.id===characterId);if(!character)throw new ActorShareUnavailable();assertShareable(character,now);
  // Refuse at the mint what the import would refuse. A share is immutable and
  // lives seven days; one that cannot be imported is not a share, and the owner
  // is the only person who can do anything about it.
  const presets=sharedCostumePresets(character);
  if(presets.length>COSTUME_PRESET_LIMIT)throw new Error("This actor has "+presets.length+" costume presets, more than the "+COSTUME_PRESET_LIMIT+" a share carries. Remove unused presets before sharing.");
  // Counting is not validating. The name is safe because this module builds it;
  // the *description* is copied straight from the wardrobe entry and was
  // checked by nobody until the import -- the same permanent, collective
  // failure one field over. Ask the validator that will read them back.
  try{assertCostumePresets(presets);}
  catch{throw new Error("This actor's costume presets cannot be shared as written. Review the scene wardrobe descriptions and try again.");}
  const expiresAt=Math.min(now+ACTOR_SHARE_TTL_MS,Date.parse(deleteAfter),character.permission.expiresAt===null?Infinity:Date.parse(character.permission.expiresAt));
  const timestamp=new Date(now).toISOString(),definition={schema:"hv-actor-share/1" as const,id:crypto.randomUUID(),projectId:casting.projectId,
    castingRevision:casting.revision,character:structuredClone(character),createdAt:timestamp,expiresAt:new Date(expiresAt).toISOString(),attestedAt:timestamp};
  return validateActorShare({...definition,revision:contentHash(definition),revokedAt:null},casting.projectId);
}
export function copiedActorReferences(share:ActorShare,projectId:string,now=Date.now()):ReferenceAsset[] {
  validateActorShare(share,share.projectId);
  return (share.character.references??[]).map(asset=>validateReference({...asset,id:crypto.randomUUID(),projectId,createdAt:new Date(now).toISOString(),
    source:{kind:"actor-share",projectId:share.projectId,characterId:share.character.id,shareId:share.id,revision:share.revision,assetId:asset.id}},projectId));
}
export function importedActor(share:ActorShare,id:string,projectId:string,name:string,aliases:string[],references:ReferenceAsset[],now=Date.now()):CastCharacter {
  validateActorShare(share,share.projectId);
  const originals=share.character.references??[];
  if(references.length!==originals.length || references.some((asset,index)=>{
    validateReference(asset,projectId);const original=originals[index]!;
    return asset.sha256!==original.sha256 || asset.originalSha256!==original.originalSha256 || asset.bytes!==original.bytes || asset.width!==original.width || asset.height!==original.height
      || contentHash(asset.source)!==contentHash({kind:"actor-share",projectId:share.projectId,characterId:share.character.id,shareId:share.id,revision:share.revision,assetId:original.id});
  }))throw new Error("The copied actor references do not match the shared revision.");
  const unique=sharedCostumePresets(share.character);
  if(unique.length>COSTUME_PRESET_LIMIT)throw new Error("This actor exceeds "+COSTUME_PRESET_LIMIT+" shared costume presets. Ask the source owner to remove unused presets and create a new share.");
  // Voice assignments and scene-bound intent must be reviewed in the destination project.
  const {audioVoice:_audioVoice,scenePerformances:_scenePerformances,...definition}=share.character;
  return characterRecord({...definition,id,name,aliases,wardrobe:share.character.wardrobe.filter(value=>value.sceneNumber===null),sceneBindings:[],references,
    costumePresets:unique,libraryOrigin:{projectId:share.projectId,characterId:share.character.id,shareId:share.id,revision:share.revision,importedAt:new Date(now).toISOString()},
    permission:{status:"pending",scope:"project",sceneNumbers:[],expiresAt:null,attestedAt:null}},id,now,true);
}
