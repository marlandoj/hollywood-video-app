import {createHash} from "node:crypto";
import {types} from "node:util";
import {contentHash} from "../../generator/src/capabilities";
import {editValidationKey} from "./edit-validation-key";

// Changes to the canonical serializer's array hooks retain the legacy path.
// Module initialization occurs with the application's trusted builtins.
const arrayHooks=["map","sort","join"] as const;
const originalArrayHooks=[Object.getOwnPropertyDescriptor(Array.prototype,"map")?.value,Object.getOwnPropertyDescriptor(Array.prototype,"sort")?.value,Object.getOwnPropertyDescriptor(Array.prototype,"join")?.value];
function inheritedHooks():boolean {
  if(Object.getPrototypeOf(Object.prototype)!==null
    ||Object.getPrototypeOf(Array.prototype)!==Object.prototype
    ||Boolean(Object.getOwnPropertyDescriptor(Object.prototype,"toJSON"))
    ||Boolean(Object.getOwnPropertyDescriptor(Array.prototype,"toJSON")))return true;
  for(let index=0;index<arrayHooks.length;index++){
    const field=Object.getOwnPropertyDescriptor(Array.prototype,arrayHooks[index]!);
    if(!field||!Object.hasOwn(field,"value")||field.value!==originalArrayHooks[index])return true;
  }
  return false;
}

/** Opaque process-local cache/guard key ONLY. Never a persisted revision or
 * canonical hash substitute. Ordering differences intentionally cause misses.
 * The descriptor traversal and original JSON wire-size gate stay unchanged.
 * A proxy or inherited serialization/canonical-array hook uses the same legacy
 * JSON.stringify -> contentHash order, without rerunning the descriptor walk. */
export function editPortableCacheKey(value:unknown,maxBytes:number):string|null {
  // Runtime callers can violate the TypeScript signature. A coercible budget
  // may execute arbitrary hooks during a comparison; preserve its exact legacy
  // walk/coercion ordering before inspecting prototypes or serializing anything.
  if(typeof maxBytes!=="number")return editValidationKey(value,maxBytes);
  let nodes=0,bytes=0,objects=0,undefinedCount=0;
  let canonicalFallback=typeof types.isProxy!=="function"||inheritedHooks();
  const active=new Set<object>(),undefinedHash=createHash("sha256");
  undefinedHash.update("hv-edit-cache-undefined/1\0");
  const visit=(item:unknown,depth:number):boolean=>{
    if(++nodes>2500000||depth>200)return false;
    if(typeof item==="string"){bytes+=Buffer.byteLength(item);return bytes<=maxBytes;}
    if(item===null||typeof item==="boolean")return true;
    if(typeof item==="number")return Number.isFinite(item)&&!Object.is(item,-0);
    if(typeof item!=="object"||active.has(item))return false;
    // Native isProxy detects proxies without invoking their traps.
    if(typeof types.isProxy!=="function"||types.isProxy(item))canonicalFallback=true;
    const array=Array.isArray(item),prototype=Object.getPrototypeOf(item),keys=Reflect.ownKeys(item);
    if(array?prototype!==Array.prototype||keys.length!==item.length+1:prototype!==Object.prototype&&prototype!==null)return false;
    const objectIndex=objects++;
    active.add(item);
    for(const key of keys){
      if(array&&key==="length")continue;
      if(typeof key!=="string"||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=item.length))return false;
      const field=Object.getOwnPropertyDescriptor(item,key)!;
      bytes+=Buffer.byteLength(key);
      if(bytes>maxBytes||!field.enumerable||!Object.hasOwn(field,"value"))return false;
      if(key==="toJSON")canonicalFallback=true;
      if(!array&&field.value===undefined){
        if(++nodes>2500000)return false;
        if(!canonicalFallback){
          // Preorder includes every object/array occurrence, including shared
          // subtrees. UTF-16 length framing distinguishes even lone surrogates;
          // no extra JSON.stringify call or inherited toJSON lookup is needed.
          undefinedHash.update(String(objectIndex)+"\0"+String(key.length)+"\0");
          undefinedHash.update(Buffer.from(key,"utf16le"));undefinedCount++;
        }
        continue;
      }
      if(!visit(field.value,depth+1))return false;
    }
    active.delete(item);return true;
  };
  if(!visit(value,0))return null;
  const serialized=JSON.stringify(value),wireBytes=Buffer.byteLength(serialized);
  if(wireBytes>maxBytes)return null;
  if(canonicalFallback)return contentHash(value);
  return createHash("sha256").update("hv-edit-portable-cache-key/1\0")
    .update(String(wireBytes)+"\0").update(serialized)
    .update("\0"+String(undefinedCount)+"\0").update(undefinedHash.digest()).digest("hex");
}
