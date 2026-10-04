import type {CastCharacter,CastingSnapshot} from "./casting";
import type {ReferenceAsset} from "./references";
import type {ShotReferenceBudget} from "./reference-budget";

/**
 * HV-017-17 (Release 3 step 4): identity across sequences.
 *
 * A character's locked look (HV-017-09) decides the images every render of that character is
 * conditioned on. A feature is many renders, one per sequence (HV-030-29), each of which snapshots the
 * cast when it is admitted and conditions its shots through `renderReferences`, exactly as a short's
 * render does. This module names, per shot, which locks that was: each locked character in the shot,
 * its lock's revision, name and ordered image digests. The assembler writes it into each shot of the
 * export's provenance, and the desk reads it per sequence and shot.
 *
 * The rule after a lock changes is the style bible's (HV-034-02): a render uses the locks current at
 * its admission. A sequence made before the change keeps the revision it used and is reported as
 * needing its rough cut again (`lockDrift`); sequences made after it use the new revision. A final
 * renders the cast of its approved rough cut (`castingMatches`), and the feature's join refuses a final
 * whose cast is not the current one, so a joined feature is made from one revision of every lock.
 */
export interface ShotIdentityLock {
  characterId:string;name:string;label:string;
  /** The lock's own revision hash (`hv-reference-lock/1`), which changes with its images, their order, name or note. */
  revision:string;lockedAt:string;
  /**
   * The lock's images, in its order: the numbered reference images the shot was conditioned on for this
   * character, unless `dropped` is present.
   */
  assets:{id:string;sha256:string}[];
  /**
   * HV-019-17: present only when the shot's reference budget cut this lock (reference-budget.ts). The lock
   * is unchanged and `assets` still names it; the shot was conditioned only on `sent`, the front of the
   * lock's order, and not on `dropped`, the rest. `sent` may be empty when the shot had more characters
   * than its budget.
   */
  sent?:{id:string;sha256:string}[];dropped?:{id:string;sha256:string}[];
}
/** What a character appearing in a render was rendered from: its lock's revision, or null when its look was not locked. */
export interface AppearingIdentity {characterId:string;name:string;revision:string|null}
export interface LockDrift {characterId:string;name:string;used:string|null;current:string|null}
export class IdentityLockError extends Error {override name="IdentityLockError";}

/** The locks of these characters, in the order the shot names them; an unlocked character has none. */
export function identityLocks(characters:Pick<CastCharacter,"id"|"name"|"referenceLock">[]):ShotIdentityLock[] {
  return characters.flatMap(character=>{const lock=character.referenceLock;if(!lock)return [];
    return [{characterId:character.id,name:character.name,label:lock.label,revision:lock.revision,lockedAt:lock.lockedAt,assets:lock.assets.map(asset=>({id:asset.id,sha256:asset.sha256}))}];});
}

/**
 * The locks a rendered shot used, from the cast the render read and the characters it named. The
 * record states only what the render was given: each lock's images must be in the shot's own reference
 * set, in the lock's order and with the lock's bytes, or this refuses rather than record a lock the
 * render was not conditioned on.
 */
export function shotIdentityLocks(shot:{id:string;characterIds?:string[];referenceAssets?:Pick<ReferenceAsset,"id"|"sha256">[];referenceBudget?:ShotReferenceBudget},casting:CastingSnapshot|undefined):ShotIdentityLock[] {
  if(!casting||!shot.characterIds?.length)return [];
  const characters=shot.characterIds.map(id=>{const character=casting.characters.find(value=>value.id===id);
    if(!character)throw new IdentityLockError("Shot "+shot.id+" names a character its cast does not hold.");return character;});
  const locks=identityLocks(characters),given=shot.referenceAssets??[];
  const same=(a:{id:string;sha256:string}[],b:{id:string;sha256:string}[])=>a.length===b.length&&a.every((asset,index)=>asset.id===b[index]!.id&&asset.sha256===b[index]!.sha256);
  return locks.map(lock=>{
    // HV-019-17: a budgeted shot sent the front of the lock's order. The record must split the lock exactly.
    const cut=shot.referenceBudget?.characters.find(entry=>entry.characterId===lock.characterId);
    if(cut&&!same([...cut.sent,...cut.dropped],lock.assets))throw new IdentityLockError("Shot "+shot.id+"'s reference budget does not split "+lock.name+"'s locked look, so its record cannot name it.");
    const sent=cut?cut.sent:lock.assets;
    const start=sent.length?given.findIndex(asset=>asset.id===sent[0]!.id):0;
    if(start<0||!same(given.slice(start,start+sent.length),sent))
      throw new IdentityLockError("Shot "+shot.id+" was not conditioned on "+lock.name+"'s locked look, so its record cannot name it.");
    return cut?.dropped.length?{...lock,sent:cut.sent,dropped:cut.dropped}:lock;
  });
}

/** Each character a render's shots show, once, with the lock revision it was rendered from (null when unlocked). */
export function appearingIdentities(shots:{characters:Pick<CastCharacter,"id"|"name"|"referenceLock">[]}[]):AppearingIdentity[] {
  const seen=new Map<string,AppearingIdentity>();
  for(const shot of shots)for(const character of shot.characters)if(!seen.has(character.id))
    seen.set(character.id,{characterId:character.id,name:character.name,revision:character.referenceLock?.revision??null});
  return [...seen.values()];
}

/**
 * Which characters a render showed from a lock revision that is no longer the cast's: a lock changed,
 * removed or added since, or the character left the cast. Empty when the render is of the current locks.
 */
export function lockDrift(appearing:AppearingIdentity[],current:CastingSnapshot):LockDrift[] {
  return appearing.flatMap(value=>{
    const now=current.characters.find(character=>character.id===value.characterId)?.referenceLock?.revision??null;
    return now===value.revision?[]:[{characterId:value.characterId,name:value.name,used:value.revision,current:now}];
  });
}
