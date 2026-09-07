import {contentHash} from "../../generator/src/capabilities";
import type {CastCharacter} from "./casting";
import type {Scene} from "../../parser/src/index";
import {performanceForScene,scenePerformanceSource} from "./performance-memory";

export const PICTURE_EMOTIONS=["neutral","calm","joyful","sad","angry","fearful","surprised","determined"] as const;
export const PICTURE_INTENSITIES=["restrained","natural","heightened"] as const;
export const PICTURE_GESTURES=["hold-still","nod","shake-head","avert-gaze","open-palms","shrug","smile","frown"] as const;
export interface PictureControls {emotion?:typeof PICTURE_EMOTIONS[number];intensity?:typeof PICTURE_INTENSITIES[number];gestures?:Array<typeof PICTURE_GESTURES[number]>}
export interface PictureOverride {characterId:string;baseRevision:string;controls:PictureControls}
export interface PicturePerformance {schema:"hv-picture-performance/1";sceneNumber:number;sourceHash:string;transport:"prompt";characters:Array<{characterId:string;name:string;memoryRevision:string|null;controls:PictureControls}>;revision:string}
function record(value:unknown,keys:string[]):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))throw new Error("Use supported picture performance fields.");return value as Record<string,unknown>;}
export function pictureControls(value:unknown):PictureControls {
  const v=record(value,["emotion","intensity","gestures"]),result:PictureControls={};
  if(v.emotion!==undefined){if(!PICTURE_EMOTIONS.includes(v.emotion as any))throw new Error("Choose an available picture emotion.");result.emotion=v.emotion as PictureControls["emotion"];}
  if(v.intensity!==undefined){if(!PICTURE_INTENSITIES.includes(v.intensity as any))throw new Error("Choose restrained, natural or heightened picture intensity.");result.intensity=v.intensity as PictureControls["intensity"];}
  if(v.gestures!==undefined){if(!Array.isArray(v.gestures)||v.gestures.length>3||v.gestures.some(g=>!PICTURE_GESTURES.includes(g))||new Set(v.gestures).size!==v.gestures.length)throw new Error("Choose up to three distinct picture gestures.");result.gestures=[...v.gestures];}
  if(!Object.keys(result).length)throw new Error("Choose a picture performance override, or inherit the saved direction.");return result;
}
export function pictureOverrides(value:unknown):PictureOverride[]{
  if(!Array.isArray(value)||value.length>20)throw new Error("Direct up to 20 cast characters per shot.");
  const result=value.map(input=>{const v=record(input,["characterId","baseRevision","controls"]);if(typeof v.characterId!=="string"||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(v.characterId)||typeof v.baseRevision!=="string"||!/^[a-f0-9]{64}$/.test(v.baseRevision))throw new Error("Choose a saved cast character and reviewed scene for picture direction.");return {characterId:v.characterId,baseRevision:v.baseRevision,controls:pictureControls(v.controls)};}).sort((a,b)=>a.characterId.localeCompare(b.characterId));
  if(new Set(result.map(v=>v.characterId)).size!==result.length)throw new Error("Use one picture override per character.");return result;
}
type PictureCharacter=Pick<CastCharacter,"id"|"name"|"scenePerformances">;
export function pictureBaseRevision(character:PictureCharacter,scene:Scene):string{return contentHash({characterId:character.id,name:character.name,sourceHash:scenePerformanceSource(scene),memoryRevision:character.scenePerformances?.find(p=>p.sceneNumber===scene.index+1)?.revision??null});}
export function picturePerformance(characters:PictureCharacter[],scene:Scene,overrides:PictureOverride[]=[]):PicturePerformance|undefined {
  const edits=pictureOverrides(overrides);if(edits.some(e=>!characters.some(c=>c.id===e.characterId)))throw new Error("A directed character is no longer present in this scene. Review the shot performance.");
  if(edits.some(e=>e.baseRevision!==pictureBaseRevision(characters.find(c=>c.id===e.characterId)!,scene)))throw new Error("The character or saved scene intent changed. Review and rebind the shot picture performance.");
  const entries=characters.flatMap(c=>{const memory=performanceForScene(c,scene),edit=edits.find(e=>e.characterId===c.id),controls={...memory?.picture,...edit?.controls};return Object.keys(controls).length?[{characterId:c.id,name:c.name,memoryRevision:memory?.revision??null,controls:pictureControls(controls)}]:[];}).sort((a,b)=>a.characterId.localeCompare(b.characterId));
  if(!entries.length)return;const data={sceneNumber:scene.index+1,sourceHash:scenePerformanceSource(scene),transport:"prompt" as const,characters:entries};return {schema:"hv-picture-performance/1",...data,revision:contentHash(data)};
}
export function picturePerformancePrompt(value:PicturePerformance):string {
  return "Picture performance direction (text prompt intent; preserve screenplay action):\n"+value.characters.map(c=>c.name+": "+[c.controls.emotion?"emotion "+c.controls.emotion:"",c.controls.intensity?"expression and gesture intensity "+c.controls.intensity:"",c.controls.gestures?(c.controls.gestures.length?"gesture suggestions in order: "+c.controls.gestures.map(g=>g.replaceAll("-"," ")).join(", "):"no additional gesture suggestions"):""].filter(Boolean).join("; ")+".").join("\n");
}
export function validatePicturePerformance(value:PicturePerformance):PicturePerformance {
  record(value,["schema","sceneNumber","sourceHash","transport","characters","revision"]);
  const hash=(v:unknown)=>typeof v==="string"&&/^[a-f0-9]{64}$/.test(v);
  if(value.schema!=="hv-picture-performance/1"||value.transport!=="prompt"||!Number.isInteger(value.sceneNumber)||value.sceneNumber<1||value.sceneNumber>1000||!hash(value.sourceHash)||!Array.isArray(value.characters)||value.characters.length<1||value.characters.length>20)throw new Error("Invalid retained picture performance.");
  for(const [i,c]of value.characters.entries()){
    record(c,["characterId","name","memoryRevision","controls"]);pictureOverrides([{characterId:c.characterId,baseRevision:value.sourceHash,controls:c.controls}]);
    if(typeof c.name!=="string"||!c.name.trim()||c.name.length>80||c.memoryRevision!==null&&!hash(c.memoryRevision)||i>0&&value.characters[i-1]!.characterId>=c.characterId||contentHash(pictureControls(c.controls))!==contentHash(c.controls))throw new Error("Invalid retained character picture direction.");
  }
  const {schema:_schema,revision,...data}=value;if(!hash(revision)||contentHash(data)!==revision)throw new Error("The retained picture performance changed.");return structuredClone(value);
}
export function assertPicturePerformance(actual:PicturePerformance|undefined,expected:PicturePerformance|undefined):void {
  if(actual)validatePicturePerformance(actual);if(contentHash(actual??null)!==contentHash(expected??null))throw new Error("The recorded picture performance differs from its admitted intent.");
}
