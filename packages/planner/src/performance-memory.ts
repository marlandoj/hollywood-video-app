import {contentHash} from "../../generator/src/capabilities";
import {AUDIO_EMOTIONS,type AudioEmotion} from "../../generator/src/audio-capabilities";
import type {Scene} from "../../parser/src/index";
import {gateOrThrow} from "../../safety/src/index";
import {PerformanceError} from "./performances";
import {cutSource} from "./scene-cuts";

export interface ScenePerformance {
  schema:"hv-scene-performance/1";characterId:string;sceneNumber:number;heading:string;sourceHash:string;
  notes:string;controls:{emotion?:AudioEmotion;speed?:number;volume?:number};revision:string;
}
export class PerformanceMemoryError extends PerformanceError {override name="PerformanceMemoryError";}
function fail(message:string):never{throw new PerformanceMemoryError(message);}
function record(value:unknown,keys:string[]):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))fail("Use supported scene performance fields.");return value as Record<string,unknown>;}
function text(value:unknown,max:number):string{if(typeof value!=="string"||value.length>max||[...value].some(c=>{const n=c.charCodeAt(0);return n===127||(n<32&&![9,10,13].includes(n))||(c.length===1&&n>=0xd800&&n<=0xdfff);}))fail("Use plain scene performance text within its limit.");return value.trim();}
const hash=(value:unknown)=>typeof value==="string"&&/^[a-f0-9]{64}$/.test(value);
export function scenePerformanceSource(scene:Scene):string{return contentHash(cutSource(scene));}
function definition(value:unknown):Omit<ScenePerformance,"schema"|"revision">{
  const v=record(value,["characterId","sceneNumber","heading","sourceHash","notes","controls"]),raw=record(v.controls??{},["emotion","speed","volume"]),controls:ScenePerformance["controls"]={};
  if(typeof v.characterId!=="string"||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v.characterId)||!Number.isInteger(v.sceneNumber)||Number(v.sceneNumber)<1||Number(v.sceneNumber)>1000||!hash(v.sourceHash))fail("Bind performance direction to a saved character and scene.");
  if(raw.emotion!==undefined){if(!AUDIO_EMOTIONS.includes(raw.emotion as AudioEmotion))fail("Choose an available emotion direction.");controls.emotion=raw.emotion as AudioEmotion;}
  for(const [key,min,max]of [["speed",.6,1.5],["volume",.5,2]] as const)if(raw[key]!==undefined){const n=raw[key];if(typeof n!=="number"||!Number.isFinite(n)||n<min||n>max)fail("Scene "+key+" must be from "+min+" to "+max+".");controls[key]=n;}
  const notes=text(v.notes??"",600),heading=text(v.heading,20000);if(!heading||!notes&&!Object.keys(controls).length)fail("Enter scene direction or a vocal override, or remove the saved direction.");gateOrThrow(notes);
  return {characterId:v.characterId,sceneNumber:Number(v.sceneNumber),heading,sourceHash:v.sourceHash as string,notes,controls};
}
export function createScenePerformance(characterId:string,scene:Scene,input:unknown):ScenePerformance{
  const settings=record(input,["notes","controls"]),data=definition({characterId,sceneNumber:scene.index+1,heading:scene.heading,sourceHash:scenePerformanceSource(scene),...settings});
  return {schema:"hv-scene-performance/1",...data,revision:contentHash(data)};
}
export function validateScenePerformance(value:ScenePerformance):ScenePerformance{
  record(value,["schema","characterId","sceneNumber","heading","sourceHash","notes","controls","revision"]);const {schema,revision,...data}=value,normalized=definition(data);
  if(schema!=="hv-scene-performance/1"||revision!==contentHash(normalized)||contentHash(data)!==contentHash(normalized))fail("The saved scene performance changed.");return structuredClone(value);
}
export function validateScenePerformances(values:ScenePerformance[],characterId:string):ScenePerformance[]{
  if(!Array.isArray(values)||values.length>60)fail("Keep up to 60 scene performances per character.");const result=values.map(validateScenePerformance);
  if(result.some(v=>v.characterId!==characterId)||new Set(result.map(v=>v.sceneNumber)).size!==result.length||result.some((v,i)=>i>0&&result[i-1]!.sceneNumber>=v.sceneNumber))fail("Scene performances must belong to this character and have unique ordered scenes.");return result;
}
export function assertPerformanceScene(memory:ScenePerformance,scene:Scene|undefined):void{
  validateScenePerformance(memory);if(!scene||memory.sceneNumber!==scene.index+1||memory.heading!==scene.heading||memory.sourceHash!==scenePerformanceSource(scene))fail("Scene "+memory.sceneNumber+" changed. Review or remove its saved character performance before creating new work.");
}
export function performanceForScene(character:{id:string;scenePerformances?:ScenePerformance[]},scene:Scene):ScenePerformance|undefined{
  const memory=character.scenePerformances?.find(p=>p.sceneNumber===scene.index+1);if(memory){if(memory.characterId!==character.id)fail("Scene performance belongs to another character.");assertPerformanceScene(memory,scene);}return memory;
}
export function performanceMemoryPrompt(memory:ScenePerformance):string{
  validateScenePerformance(memory);const controls=Object.entries(memory.controls).map(([k,v])=>k+" "+v).join(", ");
  return "Scene performance intent: "+[memory.notes,controls?"Voice direction: "+controls:""].filter(Boolean).join(". ")+". Follow explicit shot and line direction where it overrides this intent.";
}
