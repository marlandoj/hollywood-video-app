import {contentHash,validateCapability,type CapabilitySnapshot} from "../../generator/src/capabilities";
import {validateProviderPlan,type ProviderPlan} from "../../generator/src/catalog";
import type {GenParams} from "../../generator/src/index";
import {frameAnchorRequest,frameAnchorSettings,type ShotFrameAnchors} from "./frame-anchors";
import {directionSettings} from "./direction";
import {compilePerformances} from "./performances";
import {validatePicturePerformance} from "./picture-performance";
import {validateReference,type ReferenceAsset} from "./references";
import type {GenerationStage} from "./render-stage";
import type {Shot} from "./index";

export const SHOT_RENDER_RECIPE_LIMITS={bytes:8*1024**2,nodes:200000} as const;
/** A legacy injected adapter's class is observable only in the worker. This descriptor is
 * execution evidence, never a pinned provider plan or an authorization to reuse a clip. */
export interface LegacyShotProvider {adapter:string;model:string;richAnimatic:boolean;capability:CapabilitySnapshot|null}
export interface ShotRenderRecipeInput {
  projectId:string;stage:GenerationStage;shot:Shot;sceneHeading?:string;
  /** Resolved by the caller's tier/sheet policy; never infer historical dimensions from today's tiers. */
  outputSize:string;providerPlan?:ProviderPlan;richAnimaticProviders?:boolean[];legacyProviders?:LegacyShotProvider[];
}
export type ShotDispatchParams=Pick<GenParams,"seed"|"durationSec"|"fps"|"widthxheight"|"shotId"|"dialogue"|"performances"|"sceneHeading"|"action"|"framing"|"cameraPath"|"cameraMove"|"exactDuration"|"routingRequirements">;
export interface ShotRenderRecipe {
  schema:"hv-shot-execution/1";engine:1;projectId:string;stage:GenerationStage;
  providers:{kind:"pinned";plan:ProviderPlan;richAnimatic:boolean[]}|{kind:"legacy";candidates:LegacyShotProvider[]};
  dispatch:{prompt:string;params:ShotDispatchParams};
  duration:{plannedSec:number;fallback:"one-second-animatic"|"planned"};
  repair:{seedStep:0|10000;maximumAttempt:2};
  references:ReferenceAsset[];anchors:{frames:{at:number;asset:ReferenceAsset}[];mode:"native"|"storyboard"|"prefer-native"}|null;
  picturePerformance:NonNullable<Shot["picturePerformance"]>|null;
  revision:string;
}
export interface ShotRenderAttempt {prompt:string;seed:number;params:ShotDispatchParams}
function fail(message:string):never{throw new Error(message);}
function portable<T>(input:T):T {
  let nodes=0,bytes=0;const active=new Set<object>();
  const visit=(value:unknown,depth:number):void=>{
    if(++nodes>SHOT_RENDER_RECIPE_LIMITS.nodes||depth>100)fail("The complete shot execution recipe exceeds its capacity.");
    if(typeof value==="string"){bytes+=Buffer.byteLength(value,"utf8");if(bytes>SHOT_RENDER_RECIPE_LIMITS.bytes)fail("The complete shot execution recipe exceeds its capacity.");return;}
    if(value===null||typeof value==="boolean"||typeof value==="number"&&Number.isFinite(value)&&!Object.is(value,-0))return;
    if(typeof value!=="object"||active.has(value))fail("Retain portable shot execution data.");
    const array=Array.isArray(value),keys=Reflect.ownKeys(value),prototype=Object.getPrototypeOf(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)fail("Retain plain shot execution records.");
    if(array&&keys.length!==value.length+1)fail("Retain dense shot execution arrays.");active.add(value);
    for(const key of keys){if(array&&key==="length")continue;const property=Object.getOwnPropertyDescriptor(value,key)!;
      if(typeof key!=="string"||!property.enumerable||!Object.hasOwn(property,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))fail("Retain shot execution fields without accessors or hidden values.");
      bytes+=Buffer.byteLength(key,"utf8");visit(property.value,depth+1);
    }active.delete(value);
  };visit(input,0);if(Buffer.byteLength(JSON.stringify(input),"utf8")>SHOT_RENDER_RECIPE_LIMITS.bytes)fail("The complete shot execution recipe exceeds its capacity.");return structuredClone(input);
}
function exact(value:unknown,keys:string[]):void {if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))fail("Retain the exact shot execution fields.");}
function freeze<T>(value:T):T {if(value&&typeof value==="object"){for(const child of Object.values(value))freeze(child);Object.freeze(value);}return value;}
const text=(value:unknown,max:number,label:string):string=>{if(typeof value!=="string"||value.length>max)fail("Invalid shot execution "+label+".");return value;};
function providers(input:ShotRenderRecipeInput):ShotRenderRecipe["providers"] {
  if(input.providerPlan!==undefined){if(input.legacyProviders!==undefined)fail("Choose one shot provider execution contract.");const plan=validateProviderPlan(input.providerPlan);if(plan.stage!==input.stage)fail("The shot provider plan belongs to another stage.");
    const rich=input.richAnimaticProviders;if(!Array.isArray(rich)||rich.length!==plan.pool.length||rich.some(value=>typeof value!=="boolean"))fail("Retain every actual pinned provider class.");return {kind:"pinned",plan,richAnimatic:[...rich]};}
  if(input.richAnimaticProviders!==undefined)fail("Retain legacy provider classes with their candidates.");
  const candidates=input.legacyProviders;if(!Array.isArray(candidates)||!candidates.length||candidates.length>9)fail("Retain the actual legacy provider candidates.");
  for(const candidate of candidates){exact(candidate,["adapter","model","richAnimatic","capability"]);text(candidate.adapter,200,"provider");text(candidate.model,200,"model");if(typeof candidate.richAnimatic!=="boolean")fail("Retain the legacy provider class.");if(candidate.capability!==null)validateCapability(candidate.capability);}
  return {kind:"legacy",candidates:structuredClone(candidates)};
}
/** Compile the already resolved source shot, without parsing again or changing artistic settings.
 * Neither this recipe nor its seal grants current rights, carrier access, cost or reuse authority.
 * The existing hv-shot-input/1 and hv-shot-render/1 recipes deliberately remain unchanged. */
export function compileShotRenderRecipe(raw:ShotRenderRecipeInput):ShotRenderRecipe {
  const input=portable(raw);exact(input,["projectId","stage","shot","outputSize",...(Object.hasOwn(input,"sceneHeading")?["sceneHeading"]:[]),...(Object.hasOwn(input,"providerPlan")?["providerPlan"]:[]),...(Object.hasOwn(input,"richAnimaticProviders")?["richAnimaticProviders"]:[]),...(Object.hasOwn(input,"legacyProviders")?["legacyProviders"]:[])]);
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(input.projectId)||!["animatic","final","character-sheet"].includes(input.stage))fail("Retain the shot execution project and stage.");
  if(typeof input.outputSize!=="string"||!/^\d{2,5}x\d{2,5}$/.test(input.outputSize)||input.outputSize.split("x").some(value=>Number(value)<16||Number(value)>8192))fail("Retain the actual shot output dimensions.");
  const shot=input.shot;if(!shot||typeof shot!=="object"||!Array.isArray(shot.dialogue)||!Number.isSafeInteger(shot.seed)||shot.seed<0||!Number.isFinite(shot.durationSec)||shot.durationSec<=0||shot.durationSec>600)fail("Retain a resolved shot execution source.");
  text(shot.id,128,"shot identity");text(shot.prompt,30000,"prompt");if(shot.sourcePrompt!==undefined)text(shot.sourcePrompt,30000,"action");if(input.sceneHeading!==undefined)text(input.sceneHeading,30000,"scene heading");
  // Silent/video dispatch accepts the full screenplay capacity. The narrower spoken-text
  // limit belongs to synthesizeLines, where narration actually consumes the dialogue.
  for(const block of shot.dialogue){exact(block,["character","lines"]);text(block.character,1000,"speaker");if(!Array.isArray(block.lines))fail("Retain ordered shot dialogue lines.");for(const line of block.lines)text(line,200000,"dialogue");}
  if(shot.performances!==undefined)compilePerformances(shot.dialogue,shot.performances);
  if(shot.picturePerformance!==undefined)validatePicturePerformance(shot.picturePerformance);
  if(shot.direction!==undefined)directionSettings(shot.direction);
  const policy=providers(input),rich=policy.kind==="pinned"?policy.richAnimatic.some(Boolean):policy.candidates.some(value=>value.richAnimatic);
  const anchors=shot.direction?.frameAnchors?frameAnchorSettings(shot.direction.frameAnchors):undefined,anchorRequest=frameAnchorRequest(anchors,input.stage);
  for(const frame of anchors?.frames??[])validateReference(frame.asset,input.projectId);
  const fallback=input.stage!=="final"&&!anchors&&shot.direction?.durationFrames==null&&!rich;
  const cameraMove=input.stage==="character-sheet"?"static" as const:input.stage==="animatic"?shot.direction?.previewMove??undefined:undefined;
  const params:ShotDispatchParams={seed:shot.seed,durationSec:fallback?1:shot.durationSec,fps:30,widthxheight:input.outputSize,shotId:shot.id,dialogue:structuredClone(shot.dialogue),
    ...(shot.performances!==undefined?{performances:structuredClone(shot.performances)}:{}),...(input.sceneHeading!==undefined?{sceneHeading:input.sceneHeading}:{}),action:shot.sourcePrompt??shot.prompt,
    ...(shot.direction?.framing?{framing:structuredClone(shot.direction.framing)}:{}),...(shot.direction?.cameraPath?{cameraPath:structuredClone(shot.direction.cameraPath)}:{}),
    ...(cameraMove?{cameraMove}:{}),...(shot.direction?.durationFrames!=null?{exactDuration:true}:{}),...(policy.kind==="pinned"?{routingRequirements:structuredClone(policy.plan.requirements)}:{})};
  const data={schema:"hv-shot-execution/1" as const,engine:1 as const,projectId:input.projectId,stage:input.stage,providers:policy,dispatch:{prompt:shot.prompt,params},
    duration:{plannedSec:shot.durationSec,fallback:fallback?"one-second-animatic" as const:"planned" as const},repair:{seedStep:input.stage==="character-sheet"?0 as const:10000 as const,maximumAttempt:2 as const},
    references:(shot.referenceAssets??[]).map(asset=>validateReference(asset,input.projectId)),anchors:anchors&&anchorRequest?{frames:anchors.frames,mode:anchorRequest.mode}:null,picturePerformance:shot.picturePerformance??null};
  const result={...data,revision:contentHash(data)};portable(result);return freeze(result);
}
/** Reconstruct all derived fields, rather than trusting a resealed duration or seed policy. */
export function validateShotRenderRecipe(raw:ShotRenderRecipe):ShotRenderRecipe {
  const value=portable(raw);exact(value,["schema","engine","projectId","stage","providers","dispatch","duration","repair","references","anchors","picturePerformance","revision"]);
  exact(value.dispatch,["prompt","params"]);exact(value.duration,["plannedSec","fallback"]);exact(value.repair,["seedStep","maximumAttempt"]);
  const params=value.dispatch.params;if(!params||typeof params!=="object"||Array.isArray(params)||Object.keys(params).some(key=>!["seed","durationSec","fps","widthxheight","shotId","dialogue","performances","sceneHeading","action","framing","cameraPath","cameraMove","exactDuration","routingRequirements"].includes(key)))fail("Retain supported shot dispatch fields.");
  if(value.providers?.kind==="pinned")exact(value.providers,["kind","plan","richAnimatic"]);else if(value.providers?.kind==="legacy")exact(value.providers,["kind","candidates"]);else fail("Retain the shot provider policy.");
  let anchors:ShotFrameAnchors|undefined;if(value.anchors!==null){exact(value.anchors,["frames","mode"]);if(!["native","storyboard","prefer-native"].includes(value.anchors.mode))fail("Retain the frame anchor mode.");anchors={frames:value.anchors.frames,fallback:value.anchors.mode==="prefer-native"?"storyboard":"stop"};}
  const shot:Shot={id:params.shotId!,sceneIndex:0,prompt:value.dispatch.prompt,sourcePrompt:params.action!,dialogue:params.dialogue!,seed:params.seed,durationSec:value.duration.plannedSec,
    referenceAssets:value.references,...(params.performances!==undefined?{performances:params.performances}:{}),...(value.picturePerformance!==null?{picturePerformance:value.picturePerformance}:{}),
    direction:directionSettings({...(params.framing?{framing:params.framing}:{}),...(params.cameraPath?{cameraPath:params.cameraPath}:{}),...(params.cameraMove&&value.stage!=="character-sheet"?{previewMove:params.cameraMove}:{}),...(params.exactDuration?{durationFrames:Math.round(value.duration.plannedSec*30)}:{}),...(anchors?{frameAnchors:anchors}:{})})};
  const result=compileShotRenderRecipe({projectId:value.projectId,stage:value.stage,shot,outputSize:params.widthxheight!,...(params.sceneHeading!==undefined?{sceneHeading:params.sceneHeading}:{}),...(value.providers.kind==="pinned"?{providerPlan:value.providers.plan,richAnimaticProviders:value.providers.richAnimatic}:{legacyProviders:value.providers.candidates})});
  if(contentHash(result)!==contentHash(value))fail("The shot execution recipe changed.");return result;
}
/** The positional seed passed to a provider differs from params.seed on repairs. */
export function resolveShotRenderAttempt(recipe:ShotRenderRecipe,attempt:number):ShotRenderAttempt {
  const checked=validateShotRenderRecipe(recipe);if(!Number.isSafeInteger(attempt)||attempt<0||attempt>checked.repair.maximumAttempt)fail("Choose a bounded shot repair attempt.");
  const seed=checked.dispatch.params.seed+attempt*checked.repair.seedStep;if(!Number.isSafeInteger(seed))fail("The shot repair seed exceeds its integer capacity.");
  const params=structuredClone(checked.dispatch.params);
  return {prompt:checked.dispatch.prompt,seed,params:{...params,performances:params.performances,sceneHeading:params.sceneHeading,routingRequirements:params.routingRequirements}};
}
