import {contentHash} from "../../generator/src/capabilities";
import type {CameraMove} from "../../generator/src/animatic";
import {gateOrThrow} from "../../safety/src/index";
import type {Shot} from "./index";
import {coverageSettings,coveragePrompt,type ShotCoverage} from "./coverage";
import {framingSettings,opticsSettings,type ShotFraming,type ShotOptics} from "./framing";
import {cameraPathSettings,assertCameraPathContext,type ShotCameraPath} from "./camera-path";
import {frameAnchorSettings,type ShotFrameAnchors} from "./frame-anchors";
import {validateReference} from "./references";
import {validateSceneCuts,type SceneCut} from "./scene-cuts";
import {pictureOverrides,type PictureOverride} from "./picture-performance";

export const DIRECTION_CHOICES={
  size:["unspecified","extreme-wide","wide","full","medium","close-up","extreme-close-up","insert"],
  angle:["unspecified","eye-level","high","low","overhead","dutch"],
  lensType:["unspecified","spherical","anamorphic"],
  movement:["unspecified","static","pan","tilt","dolly","crane","handheld","steadicam","drone"],
  screenDirection:["unspecified","left-to-right","right-to-left","toward-camera","away-from-camera","stationary"],
} as const;
import {lineDirections,compilePerformances,type LineDirection} from "./performances";
/**
 * What one shot may run for, in the contract. It is provider-agnostic on purpose — a direction
 * outlives the pool that renders it — so a configured pool may be able to render less than this,
 * and the API states that narrower limit to the editor (HV-030-06). It can never render more.
 */
export const DIRECTION_MIN_DURATION_SEC=1,DIRECTION_MAX_DURATION_SEC=30;
export interface ShotDirection {
  picture?:PictureOverride[];
  lines?:LineDirection[];
  seed?:number;
  cameraPath?:ShotCameraPath;
  coverage?:ShotCoverage;
  framing?:ShotFraming;optics?:ShotOptics;
  frameAnchors?:ShotFrameAnchors;
  durationFrames:number|null;previewMove:CameraMove|null;
  size:typeof DIRECTION_CHOICES.size[number];angle:typeof DIRECTION_CHOICES.angle[number];
  lensType:typeof DIRECTION_CHOICES.lensType[number];movement:typeof DIRECTION_CHOICES.movement[number];screenDirection:typeof DIRECTION_CHOICES.screenDirection[number];
  heightM:number|null;lensMm:number|null;temperatureK:number|null;contrastRatio:number|null;
  movementSpeed:string;blocking:string;eyelines:string;performance:string;soundIntent:string;transitionIntent:string;
  keyLight:string;fillLight:string;backLight:string;motivatedSources:string;timeOfDay:string;
}
/**
 * The longest each free-text direction field may be. Exported because it is not only this file's
 * rule: the crew's plan writes five of these fields and must gate them to the same lengths, or a
 * plan the model was paid for is refused here after the fact (HV-030-12).
 */
export const DIRECTION_TEXT_LIMITS:Readonly<Record<"movementSpeed"|"blocking"|"eyelines"|"performance"|"soundIntent"|"transitionIntent"|"keyLight"|"fillLight"|"backLight"|"motivatedSources"|"timeOfDay",number>>=Object.freeze({movementSpeed:80,blocking:600,eyelines:400,performance:600,soundIntent:400,transitionIntent:240,keyLight:240,fillLight:240,backLight:240,motivatedSources:400,timeOfDay:80});
const TEXT=DIRECTION_TEXT_LIMITS;
export const DEFAULT_DIRECTION:ShotDirection={durationFrames:null,previewMove:null,size:"unspecified",angle:"unspecified",lensType:"unspecified",movement:"unspecified",screenDirection:"unspecified",
  heightM:null,lensMm:null,temperatureK:null,contrastRatio:null,movementSpeed:"",blocking:"",eyelines:"",performance:"",soundIntent:"",transitionIntent:"",keyLight:"",fillLight:"",backLight:"",motivatedSources:"",timeOfDay:""};
export interface DirectionSource {id:string;sceneIndex:number;prompt:string;dialogue:Shot["dialogue"]}
export interface DirectionEntry {source:DirectionSource;sourceHash:string;settings:ShotDirection}
export interface DirectionSnapshot {schema:"hv-direction/1";projectId:string;version:number;revision:string;createdAt:string;entries:DirectionEntry[];sceneCuts?:SceneCut[]}
export class DirectionConflict extends Error {override name="DirectionConflict";}
const object=(value:unknown):Record<string,unknown>=>{if(!value||typeof value!=="object"||Array.isArray(value))throw new Error("Use a shot direction record.");return value as Record<string,unknown>;};
export function directionSettings(input:unknown):ShotDirection {
  const value=object(input);if(Object.keys(value).some(key=>!["picture","lines","seed","coverage","framing","optics","frameAnchors","cameraPath"].includes(key)&&!Object.hasOwn(DEFAULT_DIRECTION,key)))throw new Error("Unsupported shot direction field.");
  const result={...DEFAULT_DIRECTION,...value} as ShotDirection;
  if(Object.hasOwn(value,"picture")){if(value.picture===null||value.picture===undefined)delete result.picture;else result.picture=pictureOverrides(value.picture);}
  if(value.lines!==undefined)result.lines=lineDirections(value.lines);
  if(Object.hasOwn(value,"seed")){if(value.seed===null||value.seed===undefined)delete result.seed;else if(typeof value.seed!=="number"||!Number.isSafeInteger(value.seed)||value.seed<0||value.seed>2147483647)throw new Error("Choose a generation seed from 0 to 2147483647.");}
  if(Object.hasOwn(value,"coverage"))result.coverage=coverageSettings(value.coverage);
  if(Object.hasOwn(value,"framing"))result.framing=framingSettings(value.framing);
  if(Object.hasOwn(value,"optics"))result.optics=opticsSettings(value.optics);
  if(Object.hasOwn(value,"frameAnchors")){if(value.frameAnchors===null||value.frameAnchors===undefined)delete result.frameAnchors;else result.frameAnchors=frameAnchorSettings(value.frameAnchors);}
  if(Object.hasOwn(value,"cameraPath")){if(value.cameraPath===null||value.cameraPath===undefined)delete result.cameraPath;else result.cameraPath=cameraPathSettings(value.cameraPath);}
  for(const [key,choices]of Object.entries(DIRECTION_CHOICES))if(!(choices as readonly unknown[]).includes(result[key as keyof ShotDirection]))throw new Error("Choose a valid "+key+" direction.");
  for(const [key,limit]of Object.entries(TEXT)){
    const text=result[key as keyof ShotDirection];if(typeof text!=="string"||text.length>limit||[...text].some(char=>char.charCodeAt(0)<32&&![9,10,13].includes(char.charCodeAt(0))))throw new Error(key+" must be text of at most "+limit+" characters.");
    Object.assign(result,{[key]:text.trim()});
  }
  for(const [key,min,max]of [["heightM",0,100],["lensMm",8,1000],["temperatureK",1000,20000],["contrastRatio",1,100]] as const){
    const number=result[key];if(number!==null&&(typeof number!=="number"||!Number.isFinite(number)||number<min||number>max))throw new Error(key+" must be empty or between "+min+" and "+max+".");
  }
  if(result.durationFrames!==null&&(!Number.isInteger(result.durationFrames)||result.durationFrames<DIRECTION_MIN_DURATION_SEC*30||result.durationFrames>DIRECTION_MAX_DURATION_SEC*30))throw new Error("Choose a duration from "+DIRECTION_MIN_DURATION_SEC+" to "+DIRECTION_MAX_DURATION_SEC+" seconds at 30 fps.");
  if(result.previewMove!==null&&!["static","push-in","pull-out","pan-left","pan-right"].includes(result.previewMove))throw new Error("Choose a supported storyboard motion.");
  assertCameraPathContext({cameraPath:result.cameraPath,frameAnchors:result.frameAnchors,cameraMove:result.previewMove,durationSec:(result.durationFrames??900)/30});
  return result;
}
export function directionSource(shot:Shot):DirectionSource {
  return {id:shot.id,sceneIndex:shot.sceneIndex,prompt:shot.sourcePrompt??shot.prompt,dialogue:structuredClone(shot.dialogue)};
}
export function sourceDirection(shot:Shot):ShotDirection {
  return directionSettings(shot.coverageIntent?{coverage:shot.coverageIntent,durationFrames:shot.cutDurationFrames??null}:{});
}
export function directionEntry(shot:Shot,input:unknown):DirectionEntry {
  const source=directionSource(shot);if((input as ShotDirection)?.lines)compilePerformances(shot.dialogue,undefined,lineDirections((input as ShotDirection).lines));return {source,sourceHash:contentHash(source),settings:directionSettings(input)};
}
function validateEntry(entry:DirectionEntry):DirectionEntry {
  if(!entry||Object.keys(entry).sort().join(",")!=="settings,source,sourceHash")throw new Error("Invalid saved shot direction.");
  const source=entry.source;
  if(!source||Object.keys(source).sort().join(",")!=="dialogue,id,prompt,sceneIndex"||!/^shot-[1-9][0-9]{0,3}-[1-9][0-9]{0,4}$/.test(source.id)
    || !Number.isInteger(source.sceneIndex)||source.sceneIndex<0||source.sceneIndex>999||typeof source.prompt!=="string"||source.prompt.length>200_000
    || !Array.isArray(source.dialogue)||source.dialogue.length>10000||source.dialogue.some(value=>!value||Object.keys(value).sort().join(",")!=="character,lines"||typeof value.character!=="string"||value.character.length>1000||!Array.isArray(value.lines)||value.lines.some(line=>typeof line!=="string"||line.length>200_000))
    || contentHash(source)!==entry.sourceHash)throw new Error("The saved shot source changed.");
  const settings=directionSettings(entry.settings);if(settings.lines)compilePerformances(source.dialogue,undefined,settings.lines);if(contentHash(settings)!==contentHash(entry.settings))throw new Error("The saved shot settings changed.");
  return structuredClone(entry);
}
export function directionSnapshot(projectId:string,version:number,entries:DirectionEntry[],now=Date.now(),sceneCuts?:SceneCut[]):DirectionSnapshot {
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(projectId)||!Number.isSafeInteger(version)||version<0||!Array.isArray(entries)||entries.length>60)throw new Error("A project supports up to 60 saved shot directions.");
  const records=entries.map(validateEntry).sort((a,b)=>a.source.id.localeCompare(b.source.id,"en-US",{numeric:true}));
  for(const record of records)for(const frame of record.settings.frameAnchors?.frames??[])validateReference(frame.asset,projectId);
  if(new Set(records.map(value=>value.source.id)).size!==records.length)throw new Error("Use one direction per shot.");
  const data={projectId,version,entries:records,...(sceneCuts===undefined?{}:{sceneCuts:validateSceneCuts(sceneCuts)})};return {schema:"hv-direction/1",...data,createdAt:new Date(now).toISOString(),revision:contentHash(data)};
}
export function validateDirection(value:DirectionSnapshot,projectId:string):DirectionSnapshot {
  if(!value||value.schema!=="hv-direction/1"||value.projectId!==projectId||!Number.isFinite(Date.parse(value.createdAt)))throw new Error("Invalid saved shot directions.");
  const checked=directionSnapshot(projectId,value.version,value.entries,Date.parse(value.createdAt),value.sceneCuts);if(checked.revision!==value.revision)throw new Error("The saved shot directions changed.");return checked;
}
export function currentDirection(projectId:string,history:DirectionSnapshot[]=[]):DirectionSnapshot {return history.length?validateDirection(history.at(-1)!,projectId):directionSnapshot(projectId,0,[],0);}
export function directionMatches(saved:DirectionSnapshot|undefined,current:DirectionSnapshot):boolean {return saved?saved.projectId===current.projectId&&saved.version===current.version&&saved.revision===current.revision:current.version===0;}
export function staleDirections(shots:Shot[],snapshot:DirectionSnapshot):DirectionEntry[] {
  return snapshot.entries.filter(entry=>{const shot=shots.find(value=>value.id===entry.source.id);return !shot||contentHash(directionSource(shot))!==entry.sourceHash;});
}
export function directionPrompt(settings:ShotDirection):string {
  const labels:Record<string,string>={size:"Shot size",angle:"Camera angle",lensType:"Lens type",movement:"Camera movement intent",screenDirection:"Screen direction",heightM:"Camera height in meters",lensMm:"Focal length in mm",temperatureK:"Color temperature in kelvin",contrastRatio:"Key to fill contrast ratio",movementSpeed:"Movement speed",blocking:"Blocking",eyelines:"Eyelines",performance:"Performance",soundIntent:"Sound intent",transitionIntent:"Transition intent",keyLight:"Key light",fillLight:"Fill light",backLight:"Back light",motivatedSources:"Motivated light sources",timeOfDay:"Time of day"};
  return [...Object.entries(labels).flatMap(([key,label])=>{const value=settings[key as keyof ShotDirection];return value===null||value===""||value==="unspecified"?[]:[label+": "+(Object.hasOwn(DIRECTION_CHOICES,key)?String(value).replaceAll("-"," "):String(value))];}),...(settings.coverage?[coveragePrompt(settings.coverage)]:[]),
    ...(settings.optics?[`Modeled sensor area in mm (creative intent): ${settings.optics.sensorWidthMm} x ${settings.optics.sensorHeightMm}; lens squeeze: ${settings.optics.squeeze}`,settings.optics.look?"Camera look intent: "+settings.optics.look:""]:[])].filter(Boolean).join("\n");
}
export function directShots(shots:Shot[],snapshot:DirectionSnapshot):Shot[] {
  validateDirection(snapshot,snapshot.projectId);
  const stale=staleDirections(shots,snapshot);if(stale.length)throw new DirectionConflict("Shot "+stale[0]!.source.id+" changed or disappeared. Review or remove its saved direction before rendering.");
  return shots.map(shot=>{const entry=snapshot.entries.find(value=>value.source.id===shot.id)??(shot.coverageIntent?directionEntry(shot,sourceDirection(shot)):undefined);if(!entry)return shot;
    return {...applyShotDirection(shot,entry.settings),directionRevision:snapshot.revision};
  });
}
/** Apply explicit artistic settings to an already resolved shot. This does not establish their
 * source correspondence or owner approval. Legacy callers keep their complete snapshot and
 * stale-source checks above; versioned structural callers must validate their own exact binding.
 * Provider-visible shot IDs are preserved, without assuming they encode scene positions. */
export function applyShotDirection(shot:Shot,input:unknown):Shot {
  const settings=directionSettings(input),notes=directionPrompt(settings),prompt=shot.prompt+(notes?"\nShot direction (creative intent; preserve the screenplay action):\n"+notes:"");
  if(prompt.length>30000)throw new Error("This shot has too much direction. Shorten its notes.");gateOrThrow(prompt);
  const {directionRevision:_previousRevision,...base}=shot;
  return {...base,...(settings.lines?.length?{performances:compilePerformances(shot.dialogue,shot.performances,settings.lines)}:{}),seed:settings.seed??shot.seed,sourcePrompt:shot.sourcePrompt??shot.prompt,prompt,durationSec:settings.durationFrames===null?shot.durationSec:settings.durationFrames/30,direction:structuredClone(settings)};
}
