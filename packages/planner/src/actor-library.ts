import { contentHash } from "../../generator/src/capabilities";
import { characterRecord, type CastCharacter, type CastingSnapshot } from "./casting";
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
export function assertShareable(character:CastCharacter,now=Date.now()):void {
  if(character.permission.status!=="permitted" || character.permission.scope!=="project" || !character.permission.attestedAt
    || (character.permission.expiresAt!==null && Date.parse(character.permission.expiresAt)<=now))throw new ActorShareUnavailable();
}
export function createActorShare(casting:CastingSnapshot,characterId:string,deleteAfter:string,now=Date.now()):ActorShare {
  const character=casting.characters.find(value=>value.id===characterId);if(!character)throw new ActorShareUnavailable();assertShareable(character,now);
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
  const presets=[...(share.character.costumePresets??[]),...share.character.wardrobe.filter(value=>value.sceneNumber!==null).map(value=>({name:"Scene "+value.sceneNumber+" — "+(share.character.sceneBindings.find(binding=>binding.sceneNumber===value.sceneNumber)?.heading??"Shared costume"),description:value.description}))];
  const unique=presets.filter((preset,index)=>presets.findIndex(value=>value.name===preset.name&&value.description===preset.description)===index);
  if(unique.length>48)throw new Error("This actor exceeds 48 shared costume presets. Ask the source owner to remove unused presets and create a new share.");
  // A source project's catalogue permission is not a destination voice assignment.
  const {audioVoice:_audioVoice,...definition}=share.character;
  return characterRecord({...definition,id,name,aliases,wardrobe:share.character.wardrobe.filter(value=>value.sceneNumber===null),sceneBindings:[],references,
    costumePresets:unique,libraryOrigin:{projectId:share.projectId,characterId:share.character.id,shareId:share.id,revision:share.revision,importedAt:new Date(now).toISOString()},
    permission:{status:"pending",scope:"project",sceneNumbers:[],expiresAt:null,attestedAt:null}},id,now,true);
}
