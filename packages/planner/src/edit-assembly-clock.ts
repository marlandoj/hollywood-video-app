import {contentHash} from "../../generator/src/capabilities";
import {EDIT_MAX_FRAMES,EDIT_SAMPLES_PER_FRAME,editFail,editId,editNumber,editRecord,validateEditTimeline} from "./edit-timeline";
import type {EditAssemblyParent,EditAssemblyPlan,EditAssemblyRange,EditAssemblySpan} from "./edit-assembly-types";

const S=EDIT_SAMPLES_PER_FRAME,Q=65536;
function hash(value:unknown):void {if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))editFail("Retain an exact assembly revision.");}
/** Do not let JSON coercion erase unsupported values before validation or hashing. */
function portableCopy<T>(input:T):T {
  const active=new Set<object>();
  const visit=(value:unknown,depth:number):void=>{
    if(value===null||typeof value==="string"||typeof value==="boolean")return;
    if(typeof value==="number"){if(!Number.isFinite(value)||Object.is(value,-0))editFail("Retain finite portable assembly numbers.");return;}
    if(typeof value!=="object"||depth>64||active.has(value))editFail("Retain portable, non-cyclic assembly data.");
    const array=Array.isArray(value),prototype=Object.getPrototypeOf(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)editFail("Retain plain assembly records and arrays.");
    active.add(value);const keys=Reflect.ownKeys(value);
    if(array&&keys.length!==value.length+1)editFail("Retain dense assembly arrays without extra fields.");
    for(const key of keys){
      if(array&&key==="length")continue;
      const descriptor=Object.getOwnPropertyDescriptor(value,key)!;
      if(typeof key!=="string"||!descriptor.enumerable||!Object.hasOwn(descriptor,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))editFail("Retain plain enumerable assembly values.");
      visit(descriptor.value,depth+1);
    }
    active.delete(value);
  };
  visit(input,0);return JSON.parse(JSON.stringify(input)) as T;
}
function compile(parent:EditAssemblyParent,ranges:EditAssemblyRange[]):EditAssemblyPlan {
  editRecord(parent,["sequenceId","historyRevision","timeline","sourceReceipts"]);editId(parent.sequenceId);hash(parent.historyRevision);
  parent.timeline=validateEditTimeline(parent.timeline);
  if(!Array.isArray(parent.sourceReceipts)||parent.sourceReceipts.length!==parent.timeline.sources.length)editFail("Retain one ordered receipt binding for every parent original.");
  for(const [i,binding]of parent.sourceReceipts.entries()){
    editRecord(binding,["sourceId","receiptRevision"]);editId(binding.sourceId);hash(binding.receiptRevision);
    if(binding.sourceId!==parent.timeline.sources[i]!.id)editFail("Retain parent source receipt identities in timeline source order.");
  }
  if(!Array.isArray(ranges)||ranges.length<1||ranges.length>256)editFail("Choose one to 256 retained assembly ranges.");
  let frames=0;const ids=new Set<string>();
  for(const range of ranges){
    editRecord(range,["id","fromFrame","toFrame","reason"]);editId(range.id);if(ids.has(range.id))editFail("Give each assembly range a distinct identity.");ids.add(range.id);
    editNumber(range.fromFrame,0,parent.timeline.frames-1,"Parent range start");editNumber(range.toFrame,range.fromFrame+1,parent.timeline.frames,"Parent range end");
    if(typeof range.reason!=="string"||!range.reason.trim()||range.reason.length>2000||/[\p{Cc}\p{Cs}\p{Cf}]/u.test(range.reason.replace(/[\t\r\n]/g,"")))editFail("Explain each assembly range in one to 2,000 readable characters.");
    frames+=range.toFrame-range.fromFrame;if(frames>EDIT_MAX_FRAMES)editFail("The assembly exceeds its 108,000-frame duration capacity.");
  }
  const data={schema:"hv-edit-assembly/1" as const,parent,ranges,join:"cut" as const,frames};return {...data,revision:contentHash(data)};
}
/** Keep the complete parent, including inactive layers and original transition/retime context. */
export function createEditAssemblyPlan(parent:EditAssemblyParent,ranges:EditAssemblyRange[]):EditAssemblyPlan {
  const owned=portableCopy({parent,ranges});return compile(owned.parent,owned.ranges);
}
export function validateEditAssemblyPlan(plan:EditAssemblyPlan):EditAssemblyPlan {
  const owned=portableCopy(plan);editRecord(owned,["schema","parent","ranges","join","frames","revision"]);
  if(owned.schema!=="hv-edit-assembly/1"||owned.join!=="cut")editFail("Use a supported assembly recipe and reviewed hard-cut joins.");hash(owned.revision);editNumber(owned.frames,1,EDIT_MAX_FRAMES,"Assembly duration");
  const expected=compile(owned.parent,owned.ranges);if(owned.frames!==expected.frames||owned.revision!==expected.revision)editFail("The reviewed assembly changed.");return expected;
}
interface RangeClock {id:string;at:number;end:number;parent:number}
/** Child time maps into the unchanged parent output, before source clocks, mixing or composition. */
export class EditAssemblyClock {
  readonly #ranges:RangeClock[]=[];
  readonly #samples:number;
  readonly #parentSamples:number;
  constructor(plan:EditAssemblyPlan){
    const valid=validateEditAssemblyPlan(plan);this.#samples=valid.frames*S;this.#parentSamples=valid.parent.timeline.frames*S;let at=0;
    for(const range of valid.ranges){const end=at+(range.toFrame-range.fromFrame)*S;this.#ranges.push({id:range.id,at,end,parent:range.fromFrame*S});at=end;}
  }
  #index(sample:number):number {let low=0,high=this.#ranges.length;while(low<high){const middle=(low+high)>>>1;if(this.#ranges[middle]!.end<=sample)low=middle+1;else high=middle;}return low;}
  frame(outputFrame:number):{rangeId:string;parentFrame:number}{
    editNumber(outputFrame,0,this.#samples/S-1,"Assembly output frame");const result=this.sample(outputFrame*S);return {rangeId:result.rangeId,parentFrame:result.parentSample/S};
  }
  sample(outputSample:number):{rangeId:string;parentSample:number}{
    editNumber(outputSample,0,this.#samples-1,"Assembly output sample");const range=this.#ranges[this.#index(outputSample)]!;return {rangeId:range.id,parentSample:range.parent+outputSample-range.at};
  }
  spans(outputStartSample:number,outputEndSample:number):EditAssemblySpan[]{
    editNumber(outputStartSample,0,this.#samples,"Assembly window start");editNumber(outputEndSample,outputStartSample,this.#samples,"Assembly window end");const spans:EditAssemblySpan[]=[];
    for(let i=this.#index(outputStartSample);i<this.#ranges.length;i++){const range=this.#ranges[i]!,start=Math.max(outputStartSample,range.at),end=Math.min(outputEndSample,range.end);if(start>=end)break;spans.push({rangeId:range.id,outputStartSample:start,parentStartSample:range.parent+start-range.at,samples:end-start});}
    return spans;
  }
  occurrences(parentStartSample:number,parentEndSample:number):EditAssemblySpan[]{
    editNumber(parentStartSample,0,this.#parentSamples,"Parent provenance start",false);editNumber(parentEndSample,parentStartSample,this.#parentSamples,"Parent provenance end",false);
    if(!Number.isSafeInteger(parentStartSample*Q)||!Number.isSafeInteger(parentEndSample*Q))editFail("Use the parent's retained Q16 sample phase for provenance.");
    const spans:EditAssemblySpan[]=[];for(const range of this.#ranges){const start=Math.max(parentStartSample,range.parent),end=Math.min(parentEndSample,range.parent+range.end-range.at);if(start<end)spans.push({rangeId:range.id,outputStartSample:range.at+start-range.parent,parentStartSample:start,samples:end-start});}return spans;
  }
}
