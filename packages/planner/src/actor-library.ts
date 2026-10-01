import { contentHash } from "../../generator/src/capabilities";
import { COSTUME_PRESET_LIMIT, COSTUME_PRESET_NAME_LIMIT, assertCostumePresets, assertNoPublicFigure, castRecordText, characterRecord, type CastCharacter, type CastingSnapshot } from "./casting";
import { validateReference, type ReferenceAsset } from "./references";
import { lockTextRefusal, referenceLockRecord, type ReferenceLock } from "./reference-lock";

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
  if(character.kind!=="original-fictional")throw new ActorShareUnavailable();
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
/**
 * A consented real person's consent is for one project (G12-202609191900). An actor
 * share hands their photos and description to whoever holds the link, so it is refused
 * at mint and at every read, not only hidden in the interface.
 */
export function assertShareable(character:CastCharacter,now=Date.now()):void {
  if(character.kind!=="original-fictional" || character.permission.status!=="permitted" || character.permission.scope!=="project" || !character.permission.attestedAt
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
  /**
   * HV-031-06: and the *name*, which this module builds from a screenplay scene heading.
   *
   * HV-031-05 made `importedActor` read every free-text field of the record it is about to save,
   * costume preset names included (`castRecordText`). It did not teach the mint the same question,
   * so this module stopped honouring its own rule four lines above: a share could mint with a
   * preset named after a scene heading that the import will refuse, and a share is immutable and
   * lives seven days. Every recipient, every time, for its whole life, got
   * "This cast record names a public figure" -- about a cast record that is clean, because the
   * owner's own save never reads `sceneBindings` and the screenplay is not gated on headings.
   *
   * The owner is the only person who can do anything about it and was told nothing. So the mint
   * asks now, over everything the *mint* contributes -- the record's own text, the wardrobe it
   * carries and the presets it derives. Only the importer's chosen `name` and `aliases` cannot be
   * checked here, and `importedActor` still reads the whole record at the border.
   */
  try{assertNoPublicFigure(castRecordText({...character,costumePresets:presets,
    wardrobe:character.wardrobe.filter(value=>value.sceneNumber===null)}));}
  catch{throw new Error("This actor cannot be shared as written: one of its scene headings or costume descriptions names a public figure. Rename the scene or remove that scene's wardrobe, then share again.");}
  // HV-017-16: and the locked look's name and note, which the import now reads at the border. A
  // look locked before its text was checked would otherwise mint a share whose look never arrives.
  const lockRefusal=character.referenceLock?lockTextRefusal(character.referenceLock):null;
  if(lockRefusal)throw new Error("This actor cannot be shared as written: its locked look's "+lockRefusal.field+" falls outside the content policy. Unlock the look and lock it again with another "+lockRefusal.field+", then share again.");
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
/**
 * HV-017-15. The look a shared actor's creator locked, rebuilt over the copies an import made.
 *
 * A share has carried the lock since HV-017-09, because it carries the whole stored character
 * record -- ordered asset ids and the sha256 of each, covered by the share's revision hash. What
 * could not travel was the ids: every copy gets a new one (`copiedActorReferences`). But every copy
 * also records the source asset it came from, and keeps that asset's bytes and hash. So each locked
 * image is found again by its source asset id, its bytes are checked against the hash the lock
 * named, and the lock is built afresh -- by the same builder a creator's own "Lock look" uses, in
 * the same order, with the same name and note -- over this project's copies.
 *
 * All or nothing. If one locked image has no copy, or its copy's bytes differ from the ones the
 * creator locked, the actor comes in unlocked and `note` says so, plainly. A lock over some of the
 * images would render a look nobody chose, which is worse than the upload order the creator can see.
 * With today's import this cannot happen -- `importedActor` refuses copies that differ from the
 * share, and the byte copy verifies every image -- and the check is here so that it stays true.
 */
export function carriedReferenceLock(lock:ReferenceLock|undefined,copies:ReferenceAsset[],now=Date.now()):{referenceLock?:ReferenceLock;note?:string} {
  if(!lock)return {};
  // HV-017-16: the name and note were written in another project, perhaps before the lock route read
  // them at all, so the import reads them here under today's policy (HV-031-05's rule for every field
  // an import carries). A refused one is not quoted back.
  const refusal=lockTextRefusal(lock);
  if(refusal)return {note:"The locked look was not carried over: its "+refusal.field+" falls outside the content policy. The actor was imported unlocked; lock its look again from its images here."};
  const assetIds:string[]=[];
  for(const [index,asset]of lock.assets.entries()) {
    const found=copies.filter(copy=>copy.source?.kind==="actor-share" && copy.source.assetId===asset.id);
    if(found.length!==1)return {note:"The locked look \u201c"+lock.label+"\u201d was not carried over: locked image "+(index+1)+" was not copied into this project. The actor was imported unlocked; lock its look again from its images here."};
    if(found[0]!.sha256!==asset.sha256)return {note:"The locked look \u201c"+lock.label+"\u201d was not carried over: the copy of locked image "+(index+1)+" is not the picture that was locked. The actor was imported unlocked; lock its look again from its images here."};
    assetIds.push(found[0]!.id);
  }
  return {referenceLock:referenceLockRecord({assetIds,label:lock.label,note:lock.note},copies,now)};
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
  // Voice assignments and scene-bound intent must be reviewed in the destination project. The locked
  // look is not copied as it stands (HV-017-10): it names the source project's ids, which no copy
  // has, so it would make every import of this share fail for as long as the share lived. It is
  // rebuilt over the copies instead (HV-017-15), or left off whole when it cannot be.
  const {audioVoice:_audioVoice,scenePerformances:_scenePerformances,referenceLock:sourceLock,...definition}=share.character;
  const {referenceLock}=carriedReferenceLock(sourceLock,references,now);
  const record=characterRecord({...definition,...(referenceLock?{referenceLock}:{}),id,name,aliases,wardrobe:share.character.wardrobe.filter(value=>value.sceneNumber===null),sceneBindings:[],references,
    costumePresets:unique,libraryOrigin:{projectId:share.projectId,characterId:share.character.id,shareId:share.id,revision:share.revision,importedAt:new Date(now).toISOString()},
    permission:{status:"pending",scope:"project",sceneNumbers:[],expiresAt:null,attestedAt:null}},id,now,true);
  // HV-031-05. An import has to be saved as a stored record -- it carries costume presets and a
  // library origin, which only a stored record may hold -- and `characterRecord` does not judge a
  // stored record against the public-figure list, so that a list which grows never makes a saved
  // cast unreadable. But this text was written in another project, under whatever list stood then,
  // and this call is a *save* into this one. So it is read here, once, at the border: the twelve
  // fields, the aliases the importer chose, the wardrobe, and the costume preset descriptions,
  // which were copied from a share and had never been read by anything.
  assertNoPublicFigure(castRecordText(record));
  return record;
}
