import {contentHash} from "../../generator/src/capabilities";

/** Plain JSON and explicit optional object fields can reuse a validation result.
 * Inspect descriptors first; the canonical digest preserves own undefined keys. */
export function editValidationKey(value:unknown,maxBytes:number):string|null {
  let nodes=0,bytes=0;const active=new Set<object>();
  const visit=(item:unknown,depth:number):boolean=>{
    if(++nodes>2500000||depth>200)return false;
    if(typeof item==="string"){bytes+=Buffer.byteLength(item);return bytes<=maxBytes;}
    if(item===null||typeof item==="boolean")return true;
    if(typeof item==="number")return Number.isFinite(item)&&!Object.is(item,-0);
    if(typeof item!=="object"||active.has(item))return false;
    const array=Array.isArray(item),prototype=Object.getPrototypeOf(item),keys=Reflect.ownKeys(item);
    if(array?prototype!==Array.prototype||keys.length!==item.length+1:prototype!==Object.prototype&&prototype!==null)return false;
    active.add(item);
    for(const key of keys){
      if(array&&key==="length")continue;
      if(typeof key!=="string"||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=item.length))return false;
      const field=Object.getOwnPropertyDescriptor(item,key)!;
      bytes+=Buffer.byteLength(key);
      if(bytes>maxBytes||!field.enumerable||!Object.hasOwn(field,"value"))return false;
      if(!array&&field.value===undefined){if(++nodes>2500000)return false;continue;}
      if(!visit(field.value,depth+1))return false;
    }
    active.delete(item);return true;
  };
  if(!visit(value,0))return null;
  const serialized=JSON.stringify(value);if(Buffer.byteLength(serialized)>maxBytes)return null;
  return contentHash(value);
}
