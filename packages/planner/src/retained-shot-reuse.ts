import {contentHash} from "../../generator/src/capabilities";
import {validateEditBinding,type EditSourceBinding} from "./edit-jobs";
import {renderShots,sourceRenderRecord,ShotReuseError,type ShotRenderRecord} from "./shot-reuse";

export interface RetainedShotReuse {
  schema:"hv-retained-shot-reuse/1";record:ShotRenderRecord;binding:EditSourceBinding;revision:string;
}
export const RETAINED_SHOT_REUSE_LIMITS={bytes:64*1024**2} as const;

function portable<T>(input:T):T {
  const active=new Set<object>();const visit=(value:unknown,depth:number):void=>{
    if(value===null||typeof value==="string"||typeof value==="boolean")return;
    if(typeof value==="number"){if(!Number.isFinite(value)||Object.is(value,-0))throw new ShotReuseError("Retain finite shot reuse metadata.");return;}
    if(typeof value!=="object"||depth>128||active.has(value))throw new ShotReuseError("Retain portable shot reuse metadata.");
    const array=Array.isArray(value),prototype=Object.getPrototypeOf(value),keys=Reflect.ownKeys(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)throw new ShotReuseError("Retain plain shot reuse records.");
    if(array&&keys.length!==value.length+1)throw new ShotReuseError("Retain dense shot reuse arrays.");active.add(value);
    for(const key of keys){if(array&&key==="length")continue;const property=Object.getOwnPropertyDescriptor(value,key)!;
      if(typeof key!=="string"||!property.enumerable||!Object.hasOwn(property,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))throw new ShotReuseError("Retain enumerable shot reuse fields without accessors.");visit(property.value,depth+1);
    }active.delete(value);
  };visit(input,0);if(Buffer.byteLength(JSON.stringify(input),"utf8")>RETAINED_SHOT_REUSE_LIMITS.bytes)throw new ShotReuseError("Retained shot reuse exceeds its 64 MiB metadata capacity.");return structuredClone(input);
}
function mapped(record:ShotRenderRecord,binding:EditSourceBinding):ShotRenderRecord["files"] {
  const files:ShotRenderRecord["files"]={} as ShotRenderRecord["files"];
  for(const [role,file]of Object.entries(record.files)){
    const index=binding.source.files.findIndex(original=>original.path===file.path&&contentHash(original)===contentHash(file));
    if(index<0||!binding.files[index])throw new ShotReuseError("The retained carrier lost an exact original shot file.");
    files[role as keyof typeof files]=structuredClone(binding.files[index]!);
  }
  return files;
}
/** Historical metadata only. Admission, copying and publication callers must separately fence
 * current carrier availability and original permissions. No original receipt/path is rewritten. */
export function compileRetainedShotReuse(record:ShotRenderRecord,binding:EditSourceBinding):RetainedShotReuse {
  const args=portable({record,binding}),retained=validateEditBinding(args.binding),source=retained.source.job;
  if(!["animatic","final"].includes(source.stage)||source.dialogueReplacement||source.soundMix||source.lipSync||source.graphicOutput)throw new ShotReuseError("Retained shot reuse requires an original direct film; derived sources need a separate mapping.");
  const at=Date.parse(source.startedAt??source.completedAt??"");if(!Number.isFinite(at))throw new ShotReuseError("The retained film lost its historical render time.");
  const shots=renderShots(source,at),records=source.output!.shotRenders!;
  if(records.length!==shots.length||new Set(records.map(item=>item.shotId)).size!==records.length||records.some((item,index)=>item.shotId!==shots[index]!.id))throw new ShotReuseError("Retain the complete ordered original film shot inventory.");
  sourceRenderRecord(source,args.record,at);mapped(args.record,retained);
  const data={schema:"hv-retained-shot-reuse/1" as const,record:args.record,binding:retained};return {...data,revision:contentHash(data)};
}
export function validateRetainedShotReuse(context:RetainedShotReuse):RetainedShotReuse {
  const checked=portable(context);
  if(!checked||Object.keys(checked).sort().join(",")!=="binding,record,revision,schema"||checked.schema!=="hv-retained-shot-reuse/1")throw new ShotReuseError("Retain the exact sealed shot reuse context.");
  const expected=compileRetainedShotReuse(checked.record,checked.binding);
  if(contentHash(expected)!==contentHash(checked))throw new ShotReuseError("The retained shot reuse context changed.");return expected;
}
/** Role names follow the original record; values are exact positional carrier file bindings. */
export function retainedShotReuseFiles(context:RetainedShotReuse):ShotRenderRecord["files"] {
  const checked=validateRetainedShotReuse(context);return mapped(checked.record,checked.binding);
}
