import {contentHash} from "../../generator/src/capabilities";
import {checkPrompt,SafetyRefusalError} from "../../safety/src/index";
import type {ReferenceAsset} from "./references";

/**
 * FULL-SCOPE P2 describes an identity lock as a reference set, an embedding and an optional
 * per-project fine-tune. This is the first of the three and only the first: the reference set a
 * character is rendered with, chosen once and recorded, instead of whatever the cast happens to hold
 * in upload order. It conditions every downstream render, and it establishes nothing about how the
 * pictures come back — see docs/CASTING.md, which still says so.
 */
export const REFERENCE_LOCK_LIMITS={assets:4,label:120,note:400} as const;
export interface ReferenceLock {
  schema:"hv-reference-lock/1";
  /** Ordered: this is the order the render's numbered reference map uses. */
  assets:{id:string;sha256:string}[];
  label:string;note:string;lockedAt:string;revision:string;
}
const text=(value:unknown,limit:number,label:string,required=false):string=>{
  if(typeof value!=="string"||value.length>limit||[...value].some(character=>{const code=character.charCodeAt(0);return code===127||code<32&&![9,10,13].includes(code);}))
    throw new Error(label+" must be text of at most "+limit+" characters.");
  const result=value.trim();if(required&&!result)throw new Error(label+" is required.");return result;
};
/** The bytes are named as well as the asset, so a re-upload under a reused id cannot pass as the locked look. */
function lockAssets(ids:unknown,references:ReferenceAsset[]):ReferenceLock["assets"]{
  if(!Array.isArray(ids)||!ids.length||ids.length>REFERENCE_LOCK_LIMITS.assets||new Set(ids).size!==ids.length)
    throw new Error("Choose one to four distinct images for this character's locked look.");
  return ids.map(id=>{
    const asset=references.find(reference=>reference.id===id);
    if(!asset)throw new Error("Lock this character's look to images the character already retains.");
    return {id:asset.id,sha256:asset.sha256};
  });
}
export function referenceLockRecord(input:unknown,references:ReferenceAsset[],now=Date.now()):ReferenceLock{
  if(!input||typeof input!=="object"||Array.isArray(input)||Object.keys(input).some(key=>!["assetIds","label","note"].includes(key)))
    throw new Error("Use supported locked-look fields.");
  const value=input as {assetIds:unknown;label:unknown;note:unknown};
  const data={schema:"hv-reference-lock/1" as const,assets:lockAssets(value.assetIds,references),
    label:text(value.label??"",REFERENCE_LOCK_LIMITS.label,"Locked look name",true),note:text(value.note??"",REFERENCE_LOCK_LIMITS.note,"Locked look note"),
    lockedAt:new Date(now).toISOString()};
  return {...data,revision:contentHash(data)};
}
/**
 * HV-017-16. A look's name and note are creator text, and creator text passes the content policy
 * before it is kept: the lock route stored both unread until now. They reach no shot prompt, but they
 * are shown on the cast desk, travel inside an actor share and are read by whoever imports it.
 *
 * Asked only when a creator locks a look, never when a stored lock is read back, so a policy that
 * grows never makes a saved cast unreadable -- the same rule `characterRecord` keeps for its fields.
 */
export function assertLockTextAllowed(lock:Pick<ReferenceLock,"label"|"note">):void{
  const verdict=checkPrompt(lock.label+"\n"+lock.note);
  if(verdict.allowed)return;
  const person=["named_public_figure","identifiable_real_person","nonconsensual_real_person"].includes(verdict.category??"");
  throw new SafetyRefusalError({...verdict,refusal:(person?"This look's name or note names a real person or a public figure, who can't be cast."
    :"This look's name or note falls outside the content policy.")+" Rename the look or change its note, then lock it again. Nothing was saved."});
}
/** A stored lock is re-judged against the character's current images every time the cast is read. */
export function validateReferenceLock(value:ReferenceLock,references:ReferenceAsset[]):ReferenceLock{
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!=="assets,label,lockedAt,note,revision,schema"
    ||value.schema!=="hv-reference-lock/1"||!Number.isFinite(Date.parse(value.lockedAt)))throw new Error("Invalid locked look.");
  const rebuilt=referenceLockRecord({assetIds:Array.isArray(value.assets)?value.assets.map(asset=>asset?.id):value.assets,label:value.label,note:value.note},references,Date.parse(value.lockedAt));
  if(contentHash(rebuilt)!==contentHash(value))throw new Error("This character's locked look no longer matches the images it was locked to. Lock the look again.");
  return rebuilt;
}
/** What a render must be conditioned on, in order, or undefined when the character's look is not locked. */
export function lockedReferences(character:{references?:ReferenceAsset[];referenceLock?:ReferenceLock}):ReferenceAsset[]|undefined{
  if(!character.referenceLock)return undefined;
  return character.referenceLock.assets.map(asset=>character.references!.find(reference=>reference.id===asset.id)!);
}
/** A render's own reference set, locked or not: the one place that decides what conditions a shot. */
export function renderReferences(character:{references?:ReferenceAsset[];referenceLock?:ReferenceLock}):ReferenceAsset[]{
  return lockedReferences(character)??character.references??[];
}
