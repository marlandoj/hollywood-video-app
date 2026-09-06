import {sourcePlan} from "./scene-cuts";
import {contentHash} from "../../generator/src/capabilities";
import {type Shot} from "./index";
import type {ParseResult} from "../../parser/src/index";
import {directCast,validateCasting,type CastingSnapshot} from "./casting";
import {sourceDirection,directionEntry,directionSettings,directionSnapshot,directShots,validateDirection,DirectionConflict,type DirectionSnapshot,type DirectionSource,type ShotDirection} from "./direction";
import {assertFrameAnchorCatalog} from "./frame-anchors";
import {validateReference,type ReferenceAsset} from "./references";
export interface ShotTake {id:string;label:string;seed:number;settings:ShotDirection}
export interface ShotTakePlan {
  schema:"hv-shot-takes/1";revision:string;projectId:string;scriptVersion:number;maxShots:24|60;
  castingRevision:string;directionVersion:number;directionRevision:string;source:DirectionSource;sourceHash:string;takes:ShotTake[];
}
const record=(input:unknown)=>{if(!input||typeof input!=="object"||Array.isArray(input))throw new Error("Use a shot take record.");return input as Record<string,unknown>;};
const seed=(value:unknown):number=>{if(typeof value!=="number"||!Number.isSafeInteger(value)||value<0||value>2147483647)throw new Error("Choose a take seed from 0 to 2147483647.");return value;};
const label=(value:unknown):string=>{if(typeof value!=="string"||!value.trim()||value.length>80||[...value].some(c=>c.charCodeAt(0)<32||c.charCodeAt(0)===127))throw new Error("Give each take a label of at most 80 characters.");return value.trim();};
export function createShotTakes(projectId:string,scriptVersion:number,casting:CastingSnapshot,direction:DirectionSnapshot,parsed:ParseResult,input:unknown):ShotTakePlan {
  validateCasting(casting,projectId);validateDirection(direction,projectId);
  const value=record(input);
  if(Object.keys(value).sort().join(",")!=="maxShots,shotId,sourceHash,takes"||!Number.isSafeInteger(scriptVersion)||scriptVersion<1||![24,60].includes(value.maxShots as number)
    ||!Array.isArray(value.takes)||value.takes.length<2||value.takes.length>3)throw new Error("Choose a source shot and two or three takes.");
  const shot=sourcePlan(parsed,direction,7000,value.maxShots as number).find(s=>s.id===value.shotId);
  if(!shot)throw new DirectionConflict("The source shot disappeared. Reload the shot plan.");
  const source=directionEntry(shot,{}),saved=direction.entries.find(e=>e.source.id===shot.id);
  if(value.sourceHash!==source.sourceHash||(saved&&saved.sourceHash!==source.sourceHash))throw new DirectionConflict("The source shot changed. Review its direction before generating takes.");
  const takes=value.takes.map((input,index)=>{
    const take=record(input);if(Object.keys(take).sort().join(",")!=="label,seed,settings")throw new Error("Choose a label, seed and settings for each take.");
    const takeSeed=seed(take.seed),settings=directionSettings({...sourceDirection(shot),...saved?.settings,...record(take.settings),seed:takeSeed});
    for(const frame of settings.frameAnchors?.frames??[])validateReference(frame.asset,projectId);
    return {id:"take-"+String.fromCharCode(97+index),label:label(take.label),seed:takeSeed,settings};
  });
  const data={projectId,scriptVersion,maxShots:value.maxShots as 24|60,castingRevision:casting.revision,directionVersion:direction.version,directionRevision:direction.revision,source:source.source,sourceHash:source.sourceHash,takes};
  return {schema:"hv-shot-takes/1",...data,revision:contentHash(data)};
}
export function validateShotTakes(input:ShotTakePlan):ShotTakePlan {
  if(!input||Object.keys(input).sort().join(",")!=="castingRevision,directionRevision,directionVersion,maxShots,projectId,revision,schema,scriptVersion,source,sourceHash,takes"||input.schema!=="hv-shot-takes/1"
    ||![24,60].includes(input.maxShots)||!Number.isSafeInteger(input.scriptVersion)||input.scriptVersion<1||!Number.isSafeInteger(input.directionVersion)||input.directionVersion<0
    ||![input.castingRevision,input.directionRevision,input.sourceHash,input.revision].every(h=>typeof h==="string"&&/^[a-f0-9]{64}$/.test(h))
    ||!Array.isArray(input.takes)||input.takes.length<2||input.takes.length>3)throw new Error("Invalid saved take group.");
  for(const [index,take]of input.takes.entries()){
    if(!take||Object.keys(take).sort().join(",")!=="id,label,seed,settings"||take.id!=="take-"+String.fromCharCode(97+index)||label(take.label)!==take.label||seed(take.seed)!==take.settings?.seed)throw new Error("Invalid saved shot take.");
    directionSnapshot(input.projectId,input.directionVersion,[{source:input.source,sourceHash:input.sourceHash,settings:take.settings}],0);
  }
  const {schema:_schema,revision,...data}=input;if(contentHash(data)!==revision)throw new Error("The saved take group changed.");return structuredClone(input);
}
export function assertShotTakeContext(input:ShotTakePlan,casting:CastingSnapshot,parsed:ParseResult,direction:DirectionSnapshot,scriptVersion:number):ShotTakePlan {
  const plan=validateShotTakes(input);
  if(plan.scriptVersion!==scriptVersion||plan.castingRevision!==casting.revision||plan.directionRevision!==direction.revision||plan.directionVersion!==direction.version
    ||createShotTakes(plan.projectId,scriptVersion,casting,direction,parsed,{shotId:plan.source.id,sourceHash:plan.sourceHash,maxShots:plan.maxShots,takes:plan.takes.map(({label,seed,settings})=>({label,seed,settings:{...settings,cameraPath:settings.cameraPath??null,frameAnchors:settings.frameAnchors??null}}))}).revision!==plan.revision)
    throw new DirectionConflict("The screenplay, cast or base direction changed. Generate a new take group.");
  return plan;
}
export function shotTakeShots(input:ShotTakePlan,casting:CastingSnapshot,parsed:ParseResult,direction:DirectionSnapshot,scriptVersion:number,now=Date.now()):Shot[] {
  const plan=assertShotTakeContext(input,casting,parsed,direction,scriptVersion);
  const source=sourcePlan(parsed,direction,7000,plan.maxShots).find(shot=>shot.id===plan.source.id)!;
  const castShot=directCast([source],parsed,casting,now)[0]!;
  return plan.takes.map(take=>{
    const specific=directionSnapshot(plan.projectId,direction.version,[directionEntry(source,take.settings)],0);
    const directed=directShots([castShot],specific)[0]!;
    return {...directed,id:take.id,seed:take.seed,directionRevision:plan.revision};
  });
}
export function assertTakeCatalog(plan:ShotTakePlan,catalog:ReferenceAsset[]):void {
  validateShotTakes(plan);for(const take of plan.takes)assertFrameAnchorCatalog(take.settings.frameAnchors,plan.projectId,catalog);
}
