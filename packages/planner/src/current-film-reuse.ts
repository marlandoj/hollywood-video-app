import {contentHash as hash} from "../../generator/src/capabilities";
import {validateEditBinding,type EditSourceBinding} from "./edit-jobs";
import {validateCompletedCurrentFilmSource} from "./current-film-job-context";
import {validateCurrentFilmJobPlan,type CurrentFilmJobV2,type CurrentFilmSlot} from "./current-film-jobs";
import {currentFilmSourceClock} from "./current-film-source-clock";
import {validateShotExecutionCapture} from "./shot-execution-capture";
import {validateShotRenderRecipe,resolveShotRenderAttempt,type ShotRenderRecipe,type ShotDispatchParams} from "./shot-render-recipe";
import type {ShotExecutionEmission} from "./shot-execution-equivalence";
import {compilePerformances,spokenText,type PerformanceLine} from "./performances";
import {assertSpeechInput,type RenderFile,type ShotRenderRecord} from "./shot-reuse";

export const CURRENT_FILM_REUSE_LIMITS={bytes:256*1024**2,nodes:2500000,depth:200,differences:64} as const;
export interface CurrentFilmSourceSelector {receiptRevision:string;ordinal:number;logicalShotId:string;renderId:string;inputRevision:string;recordRevision:string}
export interface CurrentFilmTakeChoice {attempt:number;providerIndex:number;fallbackIndex:number}
type Role=keyof ShotRenderRecord["files"];
/** One retained binding, never another copy of its full original Job in each selected slot. */
export interface CurrentFilmRetainedExecution {
  schema:"hv-current-film-retained-execution/1";binding:EditSourceBinding;source:CurrentFilmSourceSelector;
  sourceOutputRevision:string;checkpointRevision:string;captureRevision:string;frames:number;
  files:{role:Role;original:RenderFile;carrier:RenderFile}[];
  authority:"historical-only";custody:"unverified";mediaVerified:false;revision:string;
}
export type CurrentFilmNativeSpeechProjection={kind:"not-local-synthesis"}|{
  kind:"espeak-lines/1";engineVersion:string;sampleRate:22050;channels:1;bits:16;fps:30;initialFrames:number;exactDuration:boolean;
  lines:{performance:PerformanceLine;spokenText:string;beforeSamples:number;afterSamples:number}[];
  tailPolicy:"max(initialFrames,ceil((nativeSamples/22050+0.3)*fps))";
};
export interface CurrentFilmExecutionProjection {
  schema:"hv-current-film-execution-projection/1";engine:1;projectId:string;stage:"animatic"|"final";
  providers:Extract<ShotRenderRecipe["providers"],{kind:"pinned"}>;duration:ShotRenderRecipe["duration"];repair:ShotRenderRecipe["repair"];
  choice:CurrentFilmTakeChoice;emission:ShotExecutionEmission;nativeSpeech:CurrentFilmNativeSpeechProjection;revision:string;
}
type PhysicalLine=CurrentFilmSlot["physical"]["lines"][number];
type SpokenLine=CurrentFilmSlot["physical"]["spoken"][number];
export interface CurrentFilmReuseCorrespondence {
  sourceOrdinal:number;targetOrdinal:number;sourceSceneId:string;targetSceneId:string;
  lines:{lineId:string;source:PhysicalLine|null;target:PhysicalLine|null}[];
  spoken:{lineId:string;source:SpokenLine|null;target:SpokenLine|null;nativeSamples:{start:number;end:number}|null}[];
  picture:{source:ShotRenderRecipe["picturePerformance"];target:ShotRenderRecipe["picturePerformance"]};
}
/** Consistency only. The service obtains authenticated custody and current rights; the
 * copy layer independently checks original bytes. None are granted by a matching seal. */
export interface CurrentFilmReuseReview {
  schema:"hv-current-film-reuse-review/1";
  source:{selector:CurrentFilmSourceSelector;jobId:string;outputRevision:string;checkpointRevision:string;captureRevision:string;bindingRevision:string;retainedRevision:string;recipeRevision:string};
  target:{planRevision:string;materializationRevision:string;ordinal:number;logicalShotId:string;renderId:string;inputRevision:string;recipeRevision:string};
  policy:"retain-selected-successful-take/1";choice:CurrentFilmTakeChoice;
  sourceProjection:CurrentFilmExecutionProjection|null;targetProjection:CurrentFilmExecutionProjection|null;
  correspondence:CurrentFilmReuseCorrespondence;status:"consistent"|"different"|"unavailable";differences:string[];
  authority:"historical-only";custody:"unverified";mediaVerified:false;revision:string;
}
const flags={authority:"historical-only",custody:"unverified",mediaVerified:false} as const;
function fail(message:string):never {throw new Error(message);}
function exact(value:unknown,keys:string[]):void {if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))fail("Retain exact current-film reuse fields.");}
function integer(value:unknown,min:number,max:number):asserts value is number {if(typeof value!=="number"||!Number.isSafeInteger(value)||Object.is(value,-0)||value<min||value>max)fail("Retain a bounded current-film reuse address.");}
const same=(a:unknown,b:unknown)=>hash(a)===hash(b);
function portable<T>(value:T):T {
  let bytes=0,nodes=0;const active=new Set<object>(),limits=CURRENT_FILM_REUSE_LIMITS;
  const visit=(item:unknown,depth:number):void=>{
    if(++nodes>limits.nodes||depth>limits.depth)fail("Current-film reuse exceeds metadata capacity.");
    if(typeof item==="string"){bytes+=Buffer.byteLength(item);if(bytes>limits.bytes)fail("Current-film reuse exceeds metadata capacity.");return;}
    if(item===null||typeof item==="boolean"||typeof item==="number"&&Number.isFinite(item)&&!Object.is(item,-0))return;
    if(typeof item!=="object"||active.has(item))fail("Retain portable current-film reuse evidence.");
    const array=Array.isArray(item),keys=Reflect.ownKeys(item),prototype=Object.getPrototypeOf(item);
    if(array?prototype!==Array.prototype||keys.length!==item.length+1:prototype!==Object.prototype&&prototype!==null)fail("Retain plain dense current-film reuse evidence.");active.add(item);
    for(const key of keys){if(array&&key==="length")continue;const field=Object.getOwnPropertyDescriptor(item,key)!;
      if(typeof key!=="string"||!field.enumerable||!Object.hasOwn(field,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=item.length))fail("Current-film reuse refuses accessors and hidden fields.");
      bytes+=Buffer.byteLength(key);if(bytes>limits.bytes)fail("Current-film reuse exceeds metadata capacity.");visit(field.value,depth+1);
    }active.delete(item);
  };visit(value,0);if(Buffer.byteLength(JSON.stringify(value))>limits.bytes)fail("Current-film reuse exceeds metadata capacity.");return structuredClone(value);
}
function seal<T extends object>(value:T):T&{revision:string} {const checked=portable(value);return portable({...checked,revision:hash(checked)});}
function sourceRow(binding:EditSourceBinding,selector:CurrentFilmSourceSelector){
  exact(selector,["receiptRevision","ordinal","logicalShotId","renderId","inputRevision","recordRevision"]);
  const job=binding.source.job,plan=validateCompletedCurrentFilmSource(job);integer(selector.ordinal,0,plan.materialization.slots.length-1);
  const slot=plan.materialization.slots[selector.ordinal]!,row=job.currentFilmCheckpoint!.rows[selector.ordinal]!;
  if(binding.source.schema!=="hv-edit-source/3"||selector.receiptRevision!==binding.source.revision||selector.logicalShotId!==slot.logicalShotId||selector.renderId!==slot.renderId||selector.inputRevision!==slot.inputRevision||selector.recordRevision!==row.record.revision)fail("The retained V2 source slot differs from its exact selector.");
  const capture=validateShotExecutionCapture(row.capture,row.record);if(!same(capture.observation.recipe,slot.recipe))fail("The original capture changed its admitted recipe.");assertSpeechInput(row.record,slot.shot);
  return {job,plan,slot,row,capture};
}
export function compileCurrentFilmRetainedExecution(raw:EditSourceBinding,source:CurrentFilmSourceSelector):CurrentFilmRetainedExecution {
  const input=portable({raw,source}),binding=validateEditBinding(input.raw),{job,row,capture}=sourceRow(binding,input.source),span=currentFilmSourceClock(job).spans[input.source.ordinal]!;
  const files=(Object.keys(row.record.files).sort() as Role[]).map(role=>{const original=row.record.files[role]!,index=binding.source.files.findIndex(file=>file.path===original.path),carrier=binding.files[index];
    if(index<0||!carrier||!same(original,binding.source.files[index])||carrier.sha256!==original.sha256||carrier.bytes!==original.bytes)fail("The retained carrier lost an original shot role.");return {role,original,carrier};});
  return seal({schema:"hv-current-film-retained-execution/1" as const,binding,source:input.source,sourceOutputRevision:hash(job.output),checkpointRevision:job.currentFilmCheckpoint!.revision,captureRevision:capture.revision,frames:span.frames,files,...flags});
}
export function validateCurrentFilmRetainedExecution(value:CurrentFilmRetainedExecution):CurrentFilmRetainedExecution {
  const checked=portable(value);exact(checked,["schema","binding","source","sourceOutputRevision","checkpointRevision","captureRevision","frames","files","authority","custody","mediaVerified","revision"]);
  const expected=compileCurrentFilmRetainedExecution(checked.binding,checked.source);if(!same(expected,checked))fail("The retained current-film execution changed.");return expected;
}
function emission(recipe:ShotRenderRecipe,attempt:number):ShotExecutionEmission {
  const resolved=resolveShotRenderAttempt(recipe,attempt),undefinedKeys=Object.keys(resolved.params).filter(key=>resolved.params[key as keyof ShotDispatchParams]===undefined);
  if(!recipe.references.length)undefinedKeys.push("referenceFrames");if(!recipe.anchors)undefinedKeys.push("frameAnchors");
  return {prompt:resolved.prompt,seed:resolved.seed,params:Object.fromEntries(Object.entries(resolved.params).filter(([,value])=>value!==undefined)) as ShotDispatchParams,undefinedKeys:undefinedKeys.sort(),
    referenceFrames:recipe.references.length?recipe.references.map(({sha256,bytes})=>({sha256,bytes})):null,
    frameAnchors:recipe.anchors?{mode:recipe.anchors.mode,frames:recipe.anchors.frames.map(({at,asset})=>({at,sha256:asset.sha256,bytes:asset.bytes}))}:null};
}
class UnavailableExecution extends Error {}
export function compileCurrentFilmExecutionProjection(raw:ShotRenderRecipe,rawChoice:CurrentFilmTakeChoice):CurrentFilmExecutionProjection {
  const input=portable({raw,rawChoice}),recipe=validateShotRenderRecipe(input.raw),choice=input.rawChoice;exact(choice,["attempt","providerIndex","fallbackIndex"]);
  if(recipe.providers.kind!=="pinned"||recipe.stage==="character-sheet")fail("Adoption requires a pinned original film execution.");
  integer(choice.attempt,0,recipe.repair.maximumAttempt);integer(choice.providerIndex,0,recipe.providers.plan.pool.length-1);integer(choice.fallbackIndex,0,recipe.providers.plan.pool.length-1);
  const selected=recipe.providers.plan.pool[choice.providerIndex]!.snapshot,dispatch=emission(recipe,choice.attempt),params=recipe.dispatch.params;let nativeSpeech:CurrentFilmNativeSpeechProjection={kind:"not-local-synthesis"};
  if(selected.postProcessing.includes("temporary-narration")){
    // The actual synthesizer returns before runtime checks when there are no effective
    // spoken lines (including cue-only dialogue). No native engine is consumed then.
    const lines=compilePerformances(params.dialogue??[],params.performances).map(performance=>({performance,spokenText:spokenText(performance),beforeSamples:Math.round(performance.beforeMs*22050/1000),afterSamples:Math.round(performance.afterMs*22050/1000)}));
    if(lines.length){
      const runtimes=selected.postProcessing.filter(value=>/^espeak-[a-f0-9]{64}$/.test(value));
      if(!["rich-animatic","anchor-storyboard"].includes(selected.adapter)||!selected.postProcessing.includes("line-performances-v1")||runtimes.length!==1)throw new UnavailableExecution("The native speech execution contract is unavailable.");
      if(lines.some(line=>!line.spokenText||line.spokenText.length>20000))fail("The native speech target exceeds its actual synthesis line capacity.");
      nativeSpeech={kind:"espeak-lines/1",engineVersion:runtimes[0]!,sampleRate:22050,channels:1,bits:16,fps:30,initialFrames:Math.max(1,Math.round(params.durationSec!*30)),exactDuration:params.exactDuration===true,lines,tailPolicy:"max(initialFrames,ceil((nativeSamples/22050+0.3)*fps))"};
    }
  }
  return seal({schema:"hv-current-film-execution-projection/1" as const,engine:1 as const,projectId:recipe.projectId,stage:recipe.stage,providers:recipe.providers,duration:recipe.duration,repair:recipe.repair,choice,emission:dispatch,nativeSpeech});
}
export function validateCurrentFilmExecutionProjection(value:CurrentFilmExecutionProjection,recipe:ShotRenderRecipe,choice:CurrentFilmTakeChoice):CurrentFilmExecutionProjection {
  const checked=portable({value,recipe,choice}),expected=compileCurrentFilmExecutionProjection(checked.recipe,checked.choice);if(!same(checked.value,expected))fail("The current-film execution projection changed.");return expected;
}
function pictureIntent(value:ShotRenderRecipe["picturePerformance"]){return value?{transport:value.transport,characters:value.characters.map(({characterId,name,controls})=>({characterId,name,controls}))}:null;}
function correspondence(source:CurrentFilmSlot,target:CurrentFilmSlot,record:ShotRenderRecord):CurrentFilmReuseCorrespondence {
  const ids=[...new Set([...source.physical.lines.map(line=>line.lineId),...target.physical.lines.map(line=>line.lineId)])],spoken=[...new Set([...source.physical.spoken.map(line=>line.lineId),...target.physical.spoken.map(line=>line.lineId)])];
  return {sourceOrdinal:source.ordinal,targetOrdinal:target.ordinal,sourceSceneId:source.sceneId,targetSceneId:target.sceneId,
    lines:ids.map(lineId=>({lineId,source:source.physical.lines.find(line=>line.lineId===lineId)??null,target:target.physical.lines.find(line=>line.lineId===lineId)??null})),
    spoken:spoken.map(lineId=>{const a=source.physical.spoken.find(line=>line.lineId===lineId)??null,b=target.physical.spoken.find(line=>line.lineId===lineId)??null,measured=a?record.clip.speech?.lines.find(line=>line.source.hash===a.source.hash):undefined;
      return {lineId,source:a,target:b,nativeSamples:measured?{start:measured.startSample,end:measured.endSample}:null};}),
    picture:{source:source.recipe.picturePerformance,target:target.recipe.picturePerformance}};
}
export function reviewCurrentFilmReuse(rawTarget:CurrentFilmJobV2,targetOrdinal:number,rawRetained:CurrentFilmRetainedExecution):CurrentFilmReuseReview {
  const input=portable({rawTarget,targetOrdinal,rawRetained}),target=validateCurrentFilmJobPlan(input.rawTarget),retained=validateCurrentFilmRetainedExecution(input.rawRetained);
  integer(input.targetOrdinal,0,target.materialization.slots.length-1);const slot=target.materialization.slots[input.targetOrdinal]!,original=sourceRow(retained.binding,retained.source),source=original.slot,observation=original.capture.observation;
  const choice={attempt:observation.attempt,providerIndex:observation.providerIndex,fallbackIndex:observation.fallbackIndex},differences:string[]=[];
  const add=(field:string)=>{if(!differences.includes(field))differences.push(field);};let sourceProjection:CurrentFilmExecutionProjection|null=null,targetProjection:CurrentFilmExecutionProjection|null=null,unavailable=false;
  if(!same(emission(source.recipe,choice.attempt),observation.emission))fail("The source projection differs from the actual captured provider boundary.");
  try{sourceProjection=compileCurrentFilmExecutionProjection(source.recipe,choice);}catch(error){if(!(error instanceof UnavailableExecution))throw error;unavailable=true;add("source-native-speech-contract");}
  if(sourceProjection){
    const speech=original.row.record.clip.speech,native=sourceProjection.nativeSpeech;
    if(speech&&(native.kind!=="espeak-lines/1"||native.engineVersion!==speech.engineVersion||!same(native.lines.map(line=>line.performance),speech.lines.map(({source,voice,beforeMs,afterMs,notes})=>({source,voice,beforeMs,afterMs,notes})))))fail("The source native speech differs from its captured runtime and performance inputs.");
    if(native.kind==="espeak-lines/1"&&Boolean(native.lines.length)!==Boolean(speech))fail("The original source lost its actual native speech evidence.");
  }
  if(slot.recipe.providers.kind!=="pinned"||choice.providerIndex>=slot.recipe.providers.plan.pool.length||choice.fallbackIndex>=slot.recipe.providers.plan.pool.length)add("providers");
  else try{targetProjection=compileCurrentFilmExecutionProjection(slot.recipe,choice);}catch(error){if(!(error instanceof UnavailableExecution))throw error;unavailable=true;add("native-speech-contract");}
  if(sourceProjection&&targetProjection)for(const key of ["projectId","stage","providers","duration","repair","emission","nativeSpeech"] as const)if(!same(sourceProjection[key],targetProjection[key]))add(key);
  const a=original.plan.target.state.context,b=target.target.state.context,oldDoc=a.plan.document,nextDoc=b.plan.document;
  if(!same(a.lineage.root,b.lineage.root)||a.lineage.steps.length>b.lineage.steps.length||a.lineage.steps.some((step,i)=>!same(step,b.lineage.steps[i])))add("shot-lineage");
  const oldAncestry=oldDoc.context.ancestry,nextAncestry=nextDoc.context.ancestry;
  if(oldDoc.rootScriptRevision!==nextDoc.rootScriptRevision||oldAncestry.length>nextAncestry.length||oldAncestry.some((patch,i)=>!same(patch,nextAncestry[i]))||!same(nextAncestry[oldAncestry.length]?.before??nextDoc.context.base,oldDoc.context.base))add("document-lineage");
  const allocation=a.plan.allocations.find(value=>value.id===source.logicalShotId),nextAllocation=b.plan.allocations.find(value=>value.id===slot.logicalShotId);
  if(source.logicalShotId!==slot.logicalShotId||source.renderId!==slot.renderId||!allocation||!same(allocation,nextAllocation)||allocation.retiredBy!==null)add("shot-allocation");
  if(source.baseSeed!==slot.baseSeed)add("base-seed");if(source.baseRequestedFrames!==slot.baseRequestedFrames||source.plannedFrames!==slot.plannedFrames||source.requestedFrames!==slot.requestedFrames)add("requested-duration");
  if(source.sceneId!==slot.sceneId||source.physical.headingLineId!==slot.physical.headingLineId)add("physical-scene");
  if(!same(source.physical.beatIds,slot.physical.beatIds)||!same(source.physical.lines.map(line=>line.lineId),slot.physical.lines.map(line=>line.lineId)))add("physical-membership");
  if(!same(source.physical.spoken,slot.physical.spoken))add("physical-spoken");
  if(!same(source.shot.characterIds??[],slot.shot.characterIds??[])||!same(pictureIntent(source.recipe.picturePerformance),pictureIntent(slot.recipe.picturePerformance)))add("picture-intent");
  if(!same(source.recipe.references,slot.recipe.references)||!same(source.recipe.anchors,slot.recipe.anchors))add("reference-identity");
  const mapping=correspondence(source,slot,original.row.record);
  if(mapping.lines.some(line=>!line.source||!line.target)||mapping.spoken.some(line=>!line.source||!line.target))add("physical-correspondence");
  if(differences.length>CURRENT_FILM_REUSE_LIMITS.differences)fail("The reuse comparison exceeds its difference capacity.");
  return seal({schema:"hv-current-film-reuse-review/1" as const,source:{selector:retained.source,jobId:original.job.id,outputRevision:retained.sourceOutputRevision,checkpointRevision:retained.checkpointRevision,captureRevision:retained.captureRevision,bindingRevision:retained.binding.revision,retainedRevision:retained.revision,recipeRevision:source.recipe.revision},
    target:{planRevision:target.revision,materializationRevision:target.materialization.revision,ordinal:slot.ordinal,logicalShotId:slot.logicalShotId,renderId:slot.renderId,inputRevision:slot.inputRevision,recipeRevision:slot.recipe.revision},policy:"retain-selected-successful-take/1" as const,choice,sourceProjection,targetProjection,correspondence:mapping,status:unavailable?"unavailable" as const:differences.length?"different" as const:"consistent" as const,differences,...flags});
}
export function validateCurrentFilmReuseReview(value:CurrentFilmReuseReview,target:CurrentFilmJobV2,retained:CurrentFilmRetainedExecution):CurrentFilmReuseReview {
  const checked=portable({value,target,retained}),expected=reviewCurrentFilmReuse(checked.target,checked.value.target.ordinal,checked.retained);if(!same(expected,checked.value))fail("The current-film reuse review changed.");return expected;
}
