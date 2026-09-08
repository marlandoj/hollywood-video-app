import {createHash} from "node:crypto";
import {contentHash,matchCapability,videoRequirements,type ShotRequirements} from "../../generator/src/capabilities";
import type {RouteDecision,RenderRoute} from "../../generator/src/router";
import {parseFountain} from "../../parser/src/index";
import {compileRetainedShotReuse,validateRetainedShotReuse,retainedShotReuseFiles,type RetainedShotReuse} from "./retained-shot-reuse";
import {renderShots,type RenderFile} from "./shot-reuse";
import {compileShotRenderRecipe,validateShotRenderRecipe,resolveShotRenderAttempt,type ShotRenderRecipe,type ShotDispatchParams} from "./shot-render-recipe";

export const SHOT_EXECUTION_EQUIVALENCE_LIMITS={bytes:96*1024**2,nodes:1500000,routes:8} as const;
type ImageIdentity={sha256:string;bytes:number};
/** Observed scalar values and own undefined keys, without callbacks, signals, paths or data URLs.
 * Reference identities must be measured from the bytes actually passed to the provider. */
export interface ShotExecutionEmission {
  prompt:string;seed:number;params:ShotDispatchParams;undefinedKeys:string[];
  referenceFrames:ImageIdentity[]|null;
  frameAnchors:{mode:"native"|"storyboard"|"prefer-native";frames:(ImageIdentity&{at:number})[]}|null;
}
export interface ShotExecutionObservation {
  recipe:ShotRenderRecipe;attempt:number;providerIndex:number;fallbackIndex:number;emission:ShotExecutionEmission;
}
/** A consistency seal, NOT proof that a worker historically captured this observation.
 * The future service must obtain it from immutable authenticated worker custody. */
export interface ShotExecutionWitness {
  schema:"hv-shot-execution-witness/1";
  source:{projectId:string;jobId:string;shotId:string;receiptRevision:string;recordRevision:string;jobRevision:string;inputHash:string};
  observation:ShotExecutionObservation;routes:RouteDecision[];renderRoute:RenderRoute;
  witnessCustody:"unverified";currentAuthority:false;revision:string;
}
export interface ShotExecutionTarget {
  /** Complete current-plan/settings input identity; it need not equal historical hv-shot-input/1. */
  inputRevision:string;recipe:ShotRenderRecipe;attempt:number;providerIndex:number;fallbackIndex:number;
}
export interface ShotExecutionEquivalence {
  schema:"hv-shot-execution-equivalence/1";retained:RetainedShotReuse;witness:ShotExecutionWitness|null;target:ShotExecutionTarget;
  status:"unavailable"|"different"|"consistent";differences:string[];
  witnessCustody:"unverified";currentAuthority:false;mediaVerified:false;revision:string;
}
export interface ShotExecutionMediaVerification {
  schema:"hv-shot-execution-media-verification/1";equivalenceRevision:string;
  files:{role:string;file:RenderFile}[];bytes:number;witnessCustody:"unverified";currentAuthority:false;revision:string;
}
const hash=contentHash;
function fail(message:string):never {throw new Error(message);}
function portable<T>(input:T):T {
  let nodes=0,bytes=0;const active=new Set<object>();
  const visit=(value:unknown,depth:number):void=>{
    if(++nodes>SHOT_EXECUTION_EQUIVALENCE_LIMITS.nodes||depth>180)fail("Execution correspondence exceeds its metadata capacity.");
    if(typeof value==="string"){bytes+=Buffer.byteLength(value,"utf8");if(bytes>SHOT_EXECUTION_EQUIVALENCE_LIMITS.bytes)fail("Execution correspondence exceeds its metadata capacity.");return;}
    if(value===null||typeof value==="boolean"||typeof value==="number"&&Number.isFinite(value)&&!Object.is(value,-0))return;
    if(typeof value!=="object"||active.has(value))fail("Retain portable execution correspondence.");
    const array=Array.isArray(value),keys=Reflect.ownKeys(value),prototype=Object.getPrototypeOf(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)fail("Retain plain execution correspondence.");
    if(array&&keys.length!==value.length+1)fail("Retain dense execution arrays.");active.add(value);
    for(const key of keys){if(array&&key==="length")continue;const property=Object.getOwnPropertyDescriptor(value,key)!;
      if(typeof key!=="string"||!property.enumerable||!Object.hasOwn(property,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))fail("Retain execution fields without accessors or hidden data.");
      bytes+=Buffer.byteLength(key,"utf8");visit(property.value,depth+1);
    }active.delete(value);
  };visit(input,0);if(Buffer.byteLength(JSON.stringify(input),"utf8")>SHOT_EXECUTION_EQUIVALENCE_LIMITS.bytes)fail("Execution correspondence exceeds its metadata capacity.");return structuredClone(input);
}
function exact(value:unknown,keys:string[]):void {if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))fail("Retain exact execution correspondence fields.");}
function digest(value:unknown):void {if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))fail("Retain exact execution input revisions.");}
function integer(value:number,min:number,max:number):void {if(!Number.isSafeInteger(value)||value<min||value>max)fail("Retain bounded execution attempt and provider positions.");}
function seal<T extends object>(value:T):T&{revision:string}{return portable({...value,revision:hash(value)});}
function expectedEmission(recipe:ShotRenderRecipe,attempt:number):ShotExecutionEmission {
  const resolved=resolveShotRenderAttempt(recipe,attempt),undefinedKeys=Object.keys(resolved.params).filter(key=>resolved.params[key as keyof ShotDispatchParams]===undefined),params=Object.fromEntries(Object.entries(resolved.params).filter(([,value])=>value!==undefined)) as ShotDispatchParams;
  if(!recipe.references.length)undefinedKeys.push("referenceFrames");if(!recipe.anchors)undefinedKeys.push("frameAnchors");
  return {prompt:resolved.prompt,seed:resolved.seed,params,undefinedKeys:undefinedKeys.sort(),referenceFrames:recipe.references.length?recipe.references.map(({sha256,bytes})=>({sha256,bytes})):null,
    frameAnchors:recipe.anchors?{mode:recipe.anchors.mode,frames:recipe.anchors.frames.map(({at,asset})=>({at,sha256:asset.sha256,bytes:asset.bytes}))}:null};
}
function requirements(recipe:ShotRenderRecipe):ShotRequirements {
  // Matching reads only reference counts and anchor positions; these placeholders never leave this function.
  return videoRequirements({...recipe.dispatch.params,...(recipe.references.length?{referenceFrames:recipe.references.map(()=>"")} : {}),...(recipe.anchors?{frameAnchors:recipe.anchors}:{})});
}
function checkedPositions(recipe:ShotRenderRecipe,attempt:number,providerIndex:number,fallbackIndex:number):void {
  if(recipe.providers.kind!=="pinned")fail("A complete pinned provider execution contract is required.");
  integer(attempt,0,2);integer(providerIndex,0,recipe.providers.plan.pool.length-1);integer(fallbackIndex,0,SHOT_EXECUTION_EQUIVALENCE_LIMITS.routes-1);
}
/** Each group has a proved position; ordering within a group needs an initial latency
 * observation that hv-route-decision/1 does not retain. Later health is not that observation. */
function routeOrderGroups(recipe:ShotRenderRecipe):string[][] {
  if(recipe.providers.kind!=="pinned")fail("A complete pinned provider execution contract is required.");
  const plan=recipe.providers.plan,request=requirements(recipe),ranked=plan.pool.map((entry,index)=>({entry,index,
    priority:request.frameAnchors?.mode==="prefer-native"?Number(entry.snapshot.frameControlMode!=="native"):0,
    estimate:matchCapability(entry.snapshot,request,plan.maxShotUsd).estimateUsd??Infinity}));
  // Estimate values do not depend on the changing available budget; only eligibility does.
  ranked.sort((a,b)=>a.priority-b.priority||(plan.strategy==="cost"?a.estimate-b.estimate:0)||a.index-b.index);
  if(plan.strategy!=="latency")return ranked.map(value=>[value.entry.spec]);
  const groups:string[][]=[];let previous:number|undefined;
  for(const value of ranked){if(value.priority!==previous)groups.push([]);groups.at(-1)!.push(value.entry.spec);previous=value.priority;}return groups;
}
function routeEvidence(retained:RetainedShotReuse,observed:ShotExecutionObservation):{routes:RouteDecision[];renderRoute:RenderRoute} {
  const {record,binding:{source:{job}}}=retained,recipe=observed.recipe;
  if(recipe.providers.kind!=="pinned")fail("A complete pinned provider execution contract is required.");
  const plan=recipe.providers.plan,route=record.clip.routing;
  if(record.reusedFrom||record.origin.jobId!==job.id)fail("The original dispatch witness must accompany the original generated record, not a later reuse copy.");
  if(!route||route.schema!=="hv-render-route/1"||!Array.isArray(route.decisionIds)||!route.decisionIds.length||route.decisionIds.length>SHOT_EXECUTION_EQUIVALENCE_LIMITS.routes||new Set(route.decisionIds).size!==route.decisionIds.length)fail("The original record lacks complete successful dispatch routing evidence.");
  exact(route,["schema","planRevision","decisionIds","strategy","requirements","selectedCapability","adaptations"]);
  const expected=requirements(recipe),selected=plan.pool[observed.providerIndex]!;
  if(route.planRevision!==plan.revision||route.strategy!==plan.strategy||hash(route.requirements)!==hash(expected)||hash(route.selectedCapability)!==hash(selected.snapshot)||record.clip.provider!==selected.snapshot.adapter||record.clip.model!==selected.snapshot.model||record.clip.seed!==observed.emission.seed||observed.fallbackIndex!==route.decisionIds.length-1)fail("The successful provider, repair seed or route differs from the observed execution.");
  const history=job.routeDecisions;if(!Array.isArray(history)||history.length>8192||new Set(history.map(value=>value.id)).size!==history.length)fail("Retain the complete unique original route history.");
  const indexes=route.decisionIds.map(id=>history.findIndex(value=>value.id===id));
  if(indexes.some((index,i)=>index<0||i>0&&index<=indexes[i-1]!))fail("The successful route decisions lost their original order.");
  const routes=indexes.map(index=>history[index]!),ids=new Set<string>(),groups=routeOrderGroups(recipe);let order:string[]|undefined;
  for(const decision of routes){
    exact(decision,["schema","id","at","shotId","seed","planRevision","strategy","requirements","candidates","selectedId"]);
    if(decision.schema!=="hv-route-decision/1"||decision.shotId!==record.shotId||decision.seed!==observed.emission.seed||decision.planRevision!==plan.revision||decision.strategy!==plan.strategy||hash(decision.requirements)!==hash(expected)||!Number.isFinite(Date.parse(decision.at))||Date.parse(decision.at)<Date.parse(job.startedAt??job.completedAt!)||Date.parse(decision.at)>Date.parse(job.completedAt!)||!Array.isArray(decision.candidates)||decision.candidates.length!==plan.pool.length||new Set(decision.candidates.map(value=>value.id)).size!==plan.pool.length)fail("The original route changed its shot, attempt, policy or complete candidate inventory.");
    const next=decision.candidates.map(value=>value.id);if(order&&hash(order)!==hash(next))fail("The original fallback route changed its ranked candidate order.");order=next;
    const positions=next.map(id=>groups.findIndex(group=>group.includes(id)));
    if(positions.some((position,index)=>position<0||index>0&&position<positions[index-1]!))fail("The original candidate order contradicts its admitted routing policy.");
    for(const candidate of decision.candidates){const entry=plan.pool.find(entry=>entry.spec===candidate.id);if(!entry||candidate.provider!==entry.snapshot.adapter||candidate.model!==entry.snapshot.model||candidate.capabilityRevision!==entry.snapshot.revision||candidate.priceVersion!==entry.snapshot.priceVersion)fail("The original route changed an admitted provider capability.");
      const match=matchCapability(entry.snapshot,expected,plan.maxShotUsd);if(candidate.estimateUsd!==match.estimateUsd||candidate.eligible&&!match.eligible||hash(candidate.adaptations)!==hash(match.adaptations))fail("The original route changed its admitted requirements or adaptations.");
    }
    const position=next.indexOf(decision.selectedId!);if(position<0||!decision.candidates[position]!.eligible||ids.has(decision.selectedId!))fail("The fallback route lacks one distinct eligible provider per dispatch.");
    if(ids.size&&position<=Math.max(...[...ids].map(id=>next.indexOf(id))))fail("The fallback route reversed its ranked dispatch order.");ids.add(decision.selectedId!);
  }
  if(routes.at(-1)!.selectedId!==selected.spec)fail("The final route decision differs from the successful recorded provider.");
  const last=routes.at(-1)!.candidates.find(value=>value.id===selected.spec)!,adaptations=[...last.adaptations,...(record.clip.framing?["digital-crop"]:[])];
  if(hash(route.adaptations)!==hash(adaptations))fail("The recorded postprocessing adaptations changed.");
  return {routes:structuredClone(routes),renderRoute:structuredClone(route)};
}
/** Consistency only. Persist/select observations through a trusted worker ledger before use. */
export function createShotExecutionWitness(retained:RetainedShotReuse,input:ShotExecutionObservation):ShotExecutionWitness {
  const copied=portable({retained,input}),checked=validateRetainedShotReuse(copied.retained),observed=copied.input;exact(observed,["recipe","attempt","providerIndex","fallbackIndex","emission"]);
  const recipe=validateShotRenderRecipe(observed.recipe);checkedPositions(recipe,observed.attempt,observed.providerIndex,observed.fallbackIndex);
  const {record,binding:{source}}=checked,job=source.job,at=Date.parse(job.startedAt??job.completedAt!),shot=renderShots(job,at).find(shot=>shot.id===record.shotId)!;
  if(recipe.providers.kind!=="pinned")fail("A pinned original execution is required.");
  const heading=parseFountain(job.scriptText).scenes[shot.sceneIndex]?.heading,expected=compileShotRenderRecipe({projectId:job.projectId,stage:job.stage as "animatic"|"final",shot,outputSize:source.facts.width+"x"+source.facts.height,providerPlan:job.providerPlan!,richAnimaticProviders:recipe.providers.richAnimatic,...(heading!==undefined?{sceneHeading:heading}:{})});
  if(hash(expected)!==hash(recipe)||hash(observed.emission)!==hash(expectedEmission(recipe,observed.attempt)))fail("Observed dispatch does not match the complete original execution input.");
  const evidence=routeEvidence(checked,observed);
  return seal({schema:"hv-shot-execution-witness/1" as const,source:{projectId:job.projectId,jobId:job.id,shotId:record.shotId,receiptRevision:source.revision,recordRevision:record.revision,jobRevision:hash(job),inputHash:record.inputHash},observation:observed,...evidence,witnessCustody:"unverified" as const,currentAuthority:false as const});
}
export function validateShotExecutionWitness(retained:RetainedShotReuse,witness:ShotExecutionWitness):ShotExecutionWitness {
  const copied=portable({retained,witness}),expected=createShotExecutionWitness(copied.retained,copied.witness.observation);
  if(hash(expected)!==hash(copied.witness))fail("The execution witness or its immutable original changed.");return expected;
}
export function reviewShotExecutionEquivalence(retained:RetainedShotReuse,witness:ShotExecutionWitness|null,target:ShotExecutionTarget):ShotExecutionEquivalence {
  const copied=portable({retained,witness,target}),original=validateRetainedShotReuse(copied.retained),next=copied.target;exact(next,["inputRevision","recipe","attempt","providerIndex","fallbackIndex"]);digest(next.inputRevision);next.recipe=validateShotRenderRecipe(next.recipe);checkedPositions(next.recipe,next.attempt,next.providerIndex,next.fallbackIndex);
  if(next.recipe.projectId!==original.record.projectId)fail("A target execution belongs to another project.");
  const observed=copied.witness===null?null:validateShotExecutionWitness(original,copied.witness),differences:string[]=[];
  const missingLatency=observed!==null&&routeOrderGroups(observed.observation.recipe).some(group=>group.length>1);
  if(!observed)differences.push("The original record has no separately retained complete worker execution witness.");
  else {
    if(missingLatency)differences.push("The original latency ranking lacks its initial worker health observations; later route decisions cannot establish that order.");
    if(hash(next.recipe)!==hash(observed.observation.recipe))differences.push("Complete execution recipe differs, including provider order, labels, settings or media inputs.");
    if(next.attempt!==observed.observation.attempt)differences.push("The exact successful repair attempt differs.");
    if(next.providerIndex!==observed.observation.providerIndex||next.fallbackIndex!==observed.observation.fallbackIndex)differences.push("The exact successful provider or fallback position differs.");
  }
  return seal({schema:"hv-shot-execution-equivalence/1" as const,retained:original,witness:observed,target:next,status:!observed||missingLatency?"unavailable" as const:differences.length?"different" as const:"consistent" as const,differences,witnessCustody:"unverified" as const,currentAuthority:false as const,mediaVerified:false as const});
}
export function validateShotExecutionEquivalence(input:ShotExecutionEquivalence):ShotExecutionEquivalence {
  const value=portable(input),expected=reviewShotExecutionEquivalence(value.retained,value.witness,value.target);if(hash(value)!==hash(expected))fail("The execution equivalence review changed.");return expected;
}
/** Hash every original role through caller-provided authorized reads. This proves bytes at the
 * read boundary, not witness custody, continued availability, owner approval or current rights. */
export async function verifyShotExecutionEquivalenceMedia(input:ShotExecutionEquivalence,read:(file:RenderFile,signal?:AbortSignal)=>ReadableStream<Uint8Array>|Promise<ReadableStream<Uint8Array>>,signal?:AbortSignal):Promise<ShotExecutionMediaVerification> {
  signal?.throwIfAborted();const checked=validateShotExecutionEquivalence(input);if(checked.status!=="consistent")fail("Resolve the complete execution correspondence before verifying its source media.");
  const retained=compileRetainedShotReuse(checked.retained.record,checked.retained.binding),files:{role:string;file:RenderFile}[]=[];let total=0;
  for(const [role,file]of Object.entries(retainedShotReuseFiles(retained))){
    signal?.throwIfAborted();const stream=await read(structuredClone(file),signal);if(signal?.aborted){await stream.cancel(signal.reason).catch(()=>{});signal.throwIfAborted();}const reader=stream.getReader(),sum=createHash("sha256");let bytes=0;
    const abort=()=>{void reader.cancel(signal?.reason).catch(()=>{});};signal?.addEventListener("abort",abort,{once:true});
    try{signal?.throwIfAborted();for(;;){const part=await reader.read();signal?.throwIfAborted();if(part.done)break;if(!(part.value instanceof Uint8Array))fail("Source media must supply binary bytes.");bytes+=part.value.byteLength;if(bytes>file.bytes)fail("Original media exceeds its retained size.");sum.update(part.value);}if(bytes!==file.bytes||sum.digest("hex")!==file.sha256)fail("Original media failed complete checksum verification.");}
    finally{await reader.cancel().catch(()=>{});reader.releaseLock();signal?.removeEventListener("abort",abort);}
    total+=bytes;files.push({role,file});
  }
  signal?.throwIfAborted();return seal({schema:"hv-shot-execution-media-verification/1" as const,equivalenceRevision:checked.revision,files,bytes:total,witnessCustody:"unverified" as const,currentAuthority:false as const});
}
