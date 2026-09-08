import {contentHash,matchCapability,videoRequirements,type ShotRequirements} from "../../generator/src/capabilities";
import type {HealthObservation,RouteDecision,RouteRanking} from "../../generator/src/router";
import {validateRenderRecord,type ShotRenderRecord} from "./shot-reuse";
import {resolveShotRenderAttempt,validateShotRenderRecipe,type ShotDispatchParams,type ShotRenderRecipe} from "./shot-render-recipe";
import type {ShotExecutionEmission,ShotExecutionObservation} from "./shot-execution-equivalence";

export const SHOT_EXECUTION_CAPTURE_LIMITS={bytes:16*1024**2,nodes:500000,providers:9,routes:9} as const;
export interface ShotExecutionCaptureInput {observation:ShotExecutionObservation;ranking:RouteRanking;routes:RouteDecision[]}
/** Private sibling of a sealed shot record. A consistency seal alone does not establish
 * authenticated worker custody, original source identity, current rights or media bytes. */
export interface ShotExecutionCapture extends ShotExecutionCaptureInput {
  schema:"hv-shot-execution-capture/1";projectId:string;jobId:string;shotId:string;inputHash:string;recordRevision:string;
  routeDecisionIds:string[];custody:"unverified";currentAuthority:false;revision:string;
}
const hash=contentHash;
function fail(message:string):never {throw new Error(message);}
function portable<T>(input:T):T {
  let nodes=0,bytes=0;const active=new Set<object>();
  const visit=(value:unknown,depth:number):void=>{
    if(++nodes>SHOT_EXECUTION_CAPTURE_LIMITS.nodes||depth>180)fail("Shot execution capture exceeds its metadata capacity.");
    if(typeof value==="string"){bytes+=Buffer.byteLength(value,"utf8");if(bytes>SHOT_EXECUTION_CAPTURE_LIMITS.bytes)fail("Shot execution capture exceeds its metadata capacity.");return;}
    if(value===null||typeof value==="boolean"||typeof value==="number"&&Number.isFinite(value)&&!Object.is(value,-0))return;
    if(typeof value!=="object"||active.has(value))fail("Retain portable shot execution capture data.");
    const array=Array.isArray(value),prototype=Object.getPrototypeOf(value),keys=Reflect.ownKeys(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)fail("Retain plain shot execution capture data.");
    if(array&&keys.length!==value.length+1)fail("Retain dense shot execution capture arrays.");active.add(value);
    for(const key of keys){if(array&&key==="length")continue;const property=Object.getOwnPropertyDescriptor(value,key)!;
      if(typeof key!=="string"||!property.enumerable||!Object.hasOwn(property,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))fail("Retain capture fields without accessors or hidden data.");
      bytes+=Buffer.byteLength(key,"utf8");visit(property.value,depth+1);
    }active.delete(value);
  };visit(input,0);if(Buffer.byteLength(JSON.stringify(input),"utf8")>SHOT_EXECUTION_CAPTURE_LIMITS.bytes)fail("Shot execution capture exceeds its metadata capacity.");return structuredClone(input);
}
function exact(value:unknown,keys:string[]):void {if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))fail("Retain exact shot execution capture fields.");}
function integer(value:number,min:number,max:number):void {if(!Number.isSafeInteger(value)||value<min||value>max)fail("Retain bounded capture counts and positions.");}
function digest(value:unknown):void {if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))fail("Retain complete capture revisions.");}
function date(value:unknown):number {if(typeof value!=="string"||!Number.isFinite(Date.parse(value))||new Date(value).toISOString()!==value)fail("Retain canonical capture observation dates.");return Date.parse(value);}
function health(value:HealthObservation,at:number):void {
  exact(value,["scope","state","probeInFlight","samples","latencyMs","observedAt"]);
  if(value.scope!=="worker-process"||!["unknown","closed","open","half-open"].includes(value.state)||typeof value.probeInFlight!=="boolean")fail("Retain complete initial worker health.");integer(value.samples,0,Number.MAX_SAFE_INTEGER);
  if(value.probeInFlight&&value.state!=="half-open")fail("An in-flight worker probe requires a half-open circuit.");
  if(value.latencyMs!==null)integer(value.latencyMs,0,Number.MAX_SAFE_INTEGER);
  if(value.state==="unknown"){if(value.samples!==0||value.latencyMs!==null||value.observedAt!==null||value.probeInFlight)fail("Unknown worker health cannot invent observations.");}
  else if(value.observedAt===null||date(value.observedAt)>at||(value.samples<3)!==(value.latencyMs===null))fail("Retain measured worker health at the actual observation time.");
}
function expectedEmission(recipe:ShotRenderRecipe,attempt:number):ShotExecutionEmission {
  const resolved=resolveShotRenderAttempt(recipe,attempt),undefinedKeys=Object.keys(resolved.params).filter(key=>resolved.params[key as keyof ShotDispatchParams]===undefined);
  if(!recipe.references.length)undefinedKeys.push("referenceFrames");if(!recipe.anchors)undefinedKeys.push("frameAnchors");
  return {prompt:resolved.prompt,seed:resolved.seed,params:Object.fromEntries(Object.entries(resolved.params).filter(([,value])=>value!==undefined)) as ShotDispatchParams,undefinedKeys:undefinedKeys.sort(),
    referenceFrames:recipe.references.length?recipe.references.map(({sha256,bytes})=>({sha256,bytes})):null,
    frameAnchors:recipe.anchors?{mode:recipe.anchors.mode,frames:recipe.anchors.frames.map(({at,asset})=>({at,sha256:asset.sha256,bytes:asset.bytes}))}:null};
}
function requirements(recipe:ShotRenderRecipe):ShotRequirements {
  // Capability matching consumes only counts/positions, never image bytes.
  return videoRequirements({...recipe.dispatch.params,...(recipe.references.length?{referenceFrames:recipe.references.map(()=>"")} : {}),...(recipe.anchors?{frameAnchors:recipe.anchors}:{})});
}
function validateRanking(ranking:RouteRanking,recipe:ShotRenderRecipe,seed:number):void {
  if(recipe.providers.kind!=="pinned")fail("Capture requires a complete pinned provider plan.");const plan=recipe.providers.plan,request=requirements(recipe);
  exact(ranking,["schema","at","shotId","seed","planRevision","strategy","requirements","budget","candidates","orderedIds","revision"]);digest(ranking.revision);
  const {revision,...data}=ranking;if(revision!==hash(data)||ranking.schema!=="hv-route-ranking/1"||ranking.shotId!==recipe.dispatch.params.shotId||ranking.seed!==seed||ranking.planRevision!==plan.revision||ranking.strategy!==plan.strategy||hash(ranking.requirements)!==hash(request)||!Number.isFinite(ranking.budget)||ranking.budget<0||ranking.budget>plan.maxShotUsd)fail("The initial rank changed its exact shot, seed or admitted policy.");
  const at=date(ranking.at);if(!Array.isArray(ranking.candidates)||ranking.candidates.length!==plan.pool.length||!Array.isArray(ranking.orderedIds)||ranking.orderedIds.length!==plan.pool.length)fail("Retain every initial admitted routing candidate.");
  for(const [index,candidate]of ranking.candidates.entries()){
    exact(candidate,["index","id","capabilityRevision","estimateUsd","health"]);const entry=plan.pool[index]!;
    if(candidate.index!==index||candidate.id!==entry.spec||candidate.capabilityRevision!==entry.snapshot.revision||candidate.estimateUsd!==matchCapability(entry.snapshot,request,ranking.budget).estimateUsd)fail("The initial rank changed its admitted candidate or estimate.");health(candidate.health,at);
  }
  const expected=[...ranking.candidates].sort((a,b)=>{
    if(request.frameAnchors?.mode==="prefer-native"){const priority=Number(plan.pool[a.index]!.snapshot.frameControlMode!=="native")-Number(plan.pool[b.index]!.snapshot.frameControlMode!=="native");if(priority)return priority;}
    if(plan.strategy==="cost")return (a.estimateUsd??Infinity)-(b.estimateUsd??Infinity)||a.index-b.index;
    if(plan.strategy==="latency")return (a.health.latencyMs??Infinity)-(b.health.latencyMs??Infinity)||a.index-b.index;
    return a.index-b.index;
  }).map(candidate=>candidate.id);
  if(hash(expected)!==hash(ranking.orderedIds))fail("The initial ordered candidates contradict the actual routing policy.");
}
function validateRoutes(input:ShotExecutionCaptureInput,record:ShotRenderRecord):void {
  const {observation:{recipe,providerIndex,fallbackIndex,emission},ranking,routes}=input;if(recipe.providers.kind!=="pinned")fail("Capture requires a pinned provider plan.");
  const plan=recipe.providers.plan,request=requirements(recipe),route=record.clip.routing,selected=plan.pool[providerIndex]!;
  if(!route)fail("The sealed original lacks successful routing evidence.");exact(route,["schema","planRevision","decisionIds","strategy","requirements","selectedCapability","adaptations"]);
  if(route.schema!=="hv-render-route/1"||route.planRevision!==plan.revision||route.strategy!==plan.strategy||hash(route.requirements)!==hash(request)||hash(route.selectedCapability)!==hash(selected.snapshot)||record.clip.provider!==selected.snapshot.adapter||record.clip.model!==selected.snapshot.model||record.clip.seed!==emission.seed)fail("The sealed clip differs from the captured successful provider or attempt.");
  if(!Array.isArray(routes)||routes.length<1||routes.length>SHOT_EXECUTION_CAPTURE_LIMITS.routes||fallbackIndex!==routes.length-1||hash(route.decisionIds)!==hash(routes.map(value=>value.id))||new Set(route.decisionIds).size!==routes.length)fail("Retain the complete successful fallback route.");
  let previousPosition=-1,previousAt=date(ranking.at);
  for(const decision of routes){
    exact(decision,["schema","id","at","shotId","seed","planRevision","strategy","requirements","candidates","selectedId"]);
    const at=date(decision.at);if(decision.schema!=="hv-route-decision/1"||typeof decision.id!=="string"||!/^[-a-zA-Z0-9_]{1,128}$/.test(decision.id)||at<previousAt||decision.shotId!==record.shotId||decision.seed!==emission.seed||decision.planRevision!==plan.revision||decision.strategy!==plan.strategy||hash(decision.requirements)!==hash(request)||!Array.isArray(decision.candidates)||hash(decision.candidates.map(value=>value.id))!==hash(ranking.orderedIds))fail("The successful route changed its original rank, shot or attempt.");previousAt=at;
    for(const candidate of decision.candidates){
      exact(candidate,["id","provider","model","capabilityRevision","priceVersion","eligible","reasons","estimateUsd","billedDurationSec","adaptations","health"]);const entry=plan.pool.find(entry=>entry.spec===candidate.id)!,match=matchCapability(entry.snapshot,request,plan.maxShotUsd);
      // The router reports current names even for a skipped, drifted adapter. Only such
      // unselected capability-changed observations may differ from the admitted identity.
      const identityMatches=candidate.provider===entry.snapshot.adapter&&candidate.model===entry.snapshot.model,skippedDrift=candidate.eligible===false&&candidate.id!==decision.selectedId&&Array.isArray(candidate.reasons)&&candidate.reasons.includes("capability-changed");
      if(typeof candidate.provider!=="string"||typeof candidate.model!=="string"||!identityMatches&&!skippedDrift||candidate.capabilityRevision!==entry.snapshot.revision||candidate.priceVersion!==entry.snapshot.priceVersion||candidate.estimateUsd!==match.estimateUsd||candidate.billedDurationSec!==match.billedDurationSec||hash(candidate.adaptations)!==hash(match.adaptations))fail("The successful route changed its pinned capabilities or estimates.");health(candidate.health,at);
      const blocked=candidate.health.state==="open"||candidate.health.probeInFlight&&candidate.id!==decision.selectedId;
      if(!Array.isArray(candidate.reasons)||new Set(candidate.reasons).size!==candidate.reasons.length||candidate.reasons.some(reason=>![...match.reasons,"price","circuit-open","capability-changed"].includes(reason))||match.reasons.some(reason=>!candidate.reasons.includes(reason))||candidate.reasons.includes("circuit-open")!==blocked||candidate.eligible!==(candidate.reasons.length===0))fail("The successful route changed its observed eligibility.");
    }
    const position=ranking.orderedIds.indexOf(decision.selectedId!);if(position<=previousPosition||!decision.candidates[position]?.eligible)fail("The successful fallback reversed or repeated its ranked dispatch.");previousPosition=position;
  }
  if(routes.at(-1)!.selectedId!==selected.spec)fail("The captured successful provider differs from the final route.");
  const last=routes.at(-1)!.candidates.find(candidate=>candidate.id===selected.spec)!;
  if(hash(route.adaptations)!==hash([...last.adaptations,...(record.clip.framing?["digital-crop"]:[])]))fail("The recorded postprocessing adaptations changed.");
}
/** Validate against the existing record without changing its schema, seal or retained paths. */
export function createShotExecutionCapture(record:ShotRenderRecord,input:ShotExecutionCaptureInput):ShotExecutionCapture {
  const copied=portable({record,input}),saved=validateRenderRecord(copied.record,{projectId:copied.record.projectId,id:copied.record.jobId}),value=copied.input;exact(value,["observation","ranking","routes"]);exact(value.observation,["recipe","attempt","providerIndex","fallbackIndex","emission"]);
  if(saved.reusedFrom||saved.origin.jobId!==saved.jobId)fail("Capture requires the original fresh sealed shot record.");
  const {observation}=value,recipe=validateShotRenderRecipe(observation.recipe);
  if(recipe.providers.kind!=="pinned"||!["animatic","final"].includes(recipe.stage)||recipe.projectId!==saved.projectId||recipe.dispatch.params.shotId!==saved.shotId)fail("Capture requires the exact pinned original film shot.");
  integer(recipe.providers.plan.pool.length,1,SHOT_EXECUTION_CAPTURE_LIMITS.providers);integer(observation.attempt,0,recipe.repair.maximumAttempt);integer(observation.providerIndex,0,recipe.providers.plan.pool.length-1);integer(observation.fallbackIndex,0,SHOT_EXECUTION_CAPTURE_LIMITS.routes-1);
  if(hash(observation.emission)!==hash(expectedEmission(recipe,observation.attempt)))fail("The captured emission differs from the exact recipe or measured image handles.");
  validateRanking(value.ranking,recipe,observation.emission.seed);validateRoutes(value,saved);
  const data={schema:"hv-shot-execution-capture/1" as const,projectId:saved.projectId,jobId:saved.jobId,shotId:saved.shotId,inputHash:saved.inputHash,recordRevision:saved.revision,...value,routeDecisionIds:[...saved.clip.routing!.decisionIds],custody:"unverified" as const,currentAuthority:false as const};
  return portable({...data,revision:hash(data)});
}
export function validateShotExecutionCapture(capture:ShotExecutionCapture,record:ShotRenderRecord):ShotExecutionCapture {
  const copied=portable({capture,record}),value=copied.capture;exact(value,["schema","projectId","jobId","shotId","inputHash","recordRevision","observation","ranking","routes","routeDecisionIds","custody","currentAuthority","revision"]);
  const expected=createShotExecutionCapture(copied.record,{observation:value.observation,ranking:value.ranking,routes:value.routes});if(hash(value)!==hash(expected))fail("The capture or its sealed original record changed.");return expected;
}
