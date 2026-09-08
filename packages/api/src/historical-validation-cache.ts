/** A bounded memo for pure historical validation, never authorization or current availability.
 * Exact serialized inputs include every validation dependency. Values never escape by reference.
 * The byte budget describes retained serialized metadata, not a process RSS guarantee. */
export class HistoricalValidationCache<Input,Output> {
  private entries=new Map<string,{value:Output;bytes:number}>();
  private bytes=0;
  constructor(private validate:(input:Input)=>Output,private limits={entries:16,bytes:16*1024**2,entryBytes:2*1024**2}){}

  get(input:Input):Output {
    const key=portableKey(input,this.limits.entryBytes);
    if(key===null)return this.validate(input);
    const cached=this.entries.get(key);
    if(cached){this.entries.delete(key);this.entries.set(key,cached);return structuredClone(cached.value);}
    const value=this.validate(input),encoded=JSON.stringify(value),bytes=Buffer.byteLength(key)+Buffer.byteLength(encoded);
    if(bytes>this.limits.entryBytes||bytes>this.limits.bytes||this.limits.entries<1)return value;
    const entry={value:structuredClone(value),bytes};
    while(this.entries.size>=this.limits.entries||this.bytes+bytes>this.limits.bytes){
      const oldest=this.entries.keys().next().value!;this.bytes-=this.entries.get(oldest)!.bytes;this.entries.delete(oldest);
    }
    this.entries.set(key,entry);this.bytes+=bytes;return structuredClone(entry.value);
  }
}

/** JSON.stringify alone would erase invalid fields and could hit an unrelated valid entry.
 * Nonportable or oversized inputs still run the ordinary validator without memoization. */
function portableKey(input:unknown,maxBytes:number):string|null {
  let nodes=0,stringBytes=0;const active=new Set<object>();
  const visit=(value:unknown,depth:number):boolean=>{
    if(++nodes>100000||depth>128)return false;
    if(value===null||typeof value==="boolean")return true;
    if(typeof value==="string"){stringBytes+=Buffer.byteLength(value);return stringBytes<=maxBytes;}
    if(typeof value==="number")return Number.isFinite(value)&&!Object.is(value,-0);
    if(typeof value!=="object"||active.has(value))return false;
    const array=Array.isArray(value),prototype=Object.getPrototypeOf(value),keys=Reflect.ownKeys(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)return false;
    if(array&&keys.length!==value.length+1)return false;
    active.add(value);
    for(const key of keys){
      if(array&&key==="length")continue;
      const descriptor=Object.getOwnPropertyDescriptor(value,key)!;
      if(typeof key!=="string"||!descriptor.enumerable||!Object.hasOwn(descriptor,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))return false;
      stringBytes+=Buffer.byteLength(key);if(stringBytes>maxBytes||!visit(descriptor.value,depth+1))return false;
    }
    active.delete(value);return true;
  };
  // Inherited serializers must not run after descriptor validation.
  if(Object.hasOwn(Object.prototype,"toJSON")||Object.hasOwn(Array.prototype,"toJSON")||!visit(input,0))return null;
  const serialized=JSON.stringify(input);return Buffer.byteLength(serialized)<=maxBytes?serialized:null;
}
