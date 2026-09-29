import {contentHash} from "../../generator/src/capabilities";
import {gateOrThrow} from "../../safety/src/index";
import type {DialogueBlock,CaptionCue} from "./captions";
import {captionCues} from "./captions";

/** Built-in formant voices only. No uploaded voice or identity cloning. */
export const VOICE_CHOICES=[{id:"en-us",label:"US English · plain"},{id:"en-us+f3",label:"US English · bright"},{id:"en-us+m3",label:"US English · low"},{id:"en-gb",label:"British English · plain"}] as const;
export interface VoiceProfile {engine:"espeak-ng";voice:string;rateWpm:number;pitch:number;level:number;pronunciations:{word:string;say:string}[]}
export const DEFAULT_VOICE:VoiceProfile={engine:"espeak-ng",voice:"en-us",rateWpm:175,pitch:50,level:100,pronunciations:[]};
export interface LineSource {index:number;dialogueIndex:number;lineIndex:number;character:string;text:string;cues:string[];hash:string}
export interface LineDirection {index:number;sourceHash:string;rateWpm:number|null;pitch:number|null;level:number|null;beforeMs:number;afterMs:number;notes:string}
export interface PerformanceLine {source:LineSource;voice:VoiceProfile;beforeMs:number;afterMs:number;notes:string}
export interface SpeechReport {schema:"hv-speech/1";engine:"espeak-ng";engineVersion:string;sampleRate:22050;totalSamples:number;lines:(PerformanceLine&{spokenText:string;startSample:number;endSample:number;pcmSha256:string})[]}
export class PerformanceError extends Error {override name="PerformanceError";}
function fail(message:string):never{throw new PerformanceError(message);}
function record(value:unknown,keys:string[]):Record<string,unknown>{if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).some(k=>!keys.includes(k)))fail("Use supported voice or line performance fields.");return value as Record<string,unknown>;}
function number(value:unknown,min:number,max:number,label:string):number{if(typeof value!=="number"||!Number.isInteger(value)||value<min||value>max)fail(`${label} must be a whole number from ${min} to ${max}.`);return value;}
function text(value:unknown,max:number):string{if(typeof value!=="string"||value.length>max||[...value].some(c=>c.charCodeAt(0)<32&&![9,10,13].includes(c.charCodeAt(0))))fail(`Use text of at most ${max} characters.`);return value.trim();}
export function voiceProfile(input:unknown):VoiceProfile {
  const v={...DEFAULT_VOICE,...record(input,Object.keys(DEFAULT_VOICE))};
  if(v.engine!=="espeak-ng"||!VOICE_CHOICES.some(c=>c.id===v.voice))fail("Choose an available built-in temporary voice.");
  if(!Array.isArray(v.pronunciations)||v.pronunciations.length>32)fail("Use up to 32 pronunciation replacements.");
  const pronunciations=v.pronunciations.map(item=>{const p=record(item,["word","say"]),word=text(p.word,80),say=text(p.say,160);if(!word||!say||/[[\]<>\r\n]/.test(word+say))fail("Pronunciations require plain written words and replacements.");return {word,say};});
  if(new Set(pronunciations.map(p=>p.word.toLocaleLowerCase("en-US"))).size!==pronunciations.length)fail("Use one replacement per pronunciation.");
  gateOrThrow(pronunciations.map(p=>p.say).join(" "));
  return {engine:"espeak-ng",voice:String(v.voice),rateWpm:number(v.rateWpm,80,300,"Pace"),pitch:number(v.pitch,0,99,"Pitch"),level:number(v.level,20,150,"Level"),pronunciations};
}
/**
 * HV-016-21: the lines of a speech that are one parenthetical wrapped across several, `(quietly,
 * looking at` / `the door)`, as the index of each line mapped to the whole direction on its first
 * line. Only `/^\([^\r\n]*\)$/` was a direction, so each wrapped half was spoken and captioned. A
 * wrap is an opener with no bracket after its `(`, lines with no bracket at all, and a closer ending in
 * its only bracket, `)`; anything else is left exactly as it was read before.
 */
function wrappedDirections(lines:string[]):Map<number,string|null>{
  const wrapped=new Map<number,string|null>();
  for(let start=0;start<lines.length;start++){
    const first=lines[start]!.trim();if(!first.startsWith("(")||/[()]/.test(first.slice(1)))continue;
    let end=start+1;while(end<lines.length&&!/[()]/.test(lines[end]!))end++;
    const last=lines[end]?.trim();if(last===undefined||!last.endsWith(")")||/[()]/.test(last.slice(0,-1)))continue;
    wrapped.set(start,lines.slice(start,end+1).map(line=>line.trim()).filter(Boolean).join(" "));for(let n=start+1;n<=end;n++)wrapped.set(n,null);start=end;
  }
  return wrapped;
}
export function lineSources(dialogue:DialogueBlock[]):LineSource[]{
  const result:LineSource[]=[];
  dialogue.forEach((block,dialogueIndex)=>{const cues:string[]=[],wrapped=wrappedDirections(block.lines);block.lines.forEach((raw,lineIndex)=>{
    // HV-016-21: a wrapped parenthetical is one direction, on its first line, and not speech.
    if(wrapped.has(lineIndex)){const direction=wrapped.get(lineIndex);if(direction)cues.push(direction);return;}
    const value=raw.trim();if(/^\([^\r\n]*\)$/.test(value)){cues.push(value);return;}if(!value)return;
    const data={index:result.length,dialogueIndex,lineIndex,character:block.character,text:value,cues:[...cues]};result.push({...data,hash:contentHash(data)});
  });});return result;
}
export function lineDirections(input:unknown):LineDirection[]{
  if(!Array.isArray(input)||input.length>128)fail("A shot supports up to 128 directed lines.");
  const lines=input.map(item=>{const v=record(item,["index","sourceHash","rateWpm","pitch","level","beforeMs","afterMs","notes"]);
    if(typeof v.sourceHash!=="string"||!/^[a-f0-9]{64}$/.test(v.sourceHash))fail("Reload the line's screenplay source before directing it.");
    const result:LineDirection={index:number(v.index,0,127,"Line index"),sourceHash:v.sourceHash,rateWpm:v.rateWpm==null?null:number(v.rateWpm,80,300,"Pace"),pitch:v.pitch==null?null:number(v.pitch,0,99,"Pitch"),level:v.level==null?null:number(v.level,20,150,"Level"),beforeMs:number(v.beforeMs??0,0,3000,"Leading pause"),afterMs:number(v.afterMs??200,0,3000,"Trailing pause"),notes:text(v.notes??"",600)};
    gateOrThrow(result.notes);return result;
  }).sort((a,b)=>a.index-b.index);
  if(new Set(lines.map(l=>l.index)).size!==lines.length)fail("Use one direction per dialogue line.");return lines;
}
export function compilePerformances(dialogue:DialogueBlock[],base:PerformanceLine[]|undefined,edits:LineDirection[]=[]):PerformanceLine[]{
  const sources=lineSources(dialogue);if(sources.length>128)fail("Split this shot into coverage with at most 128 spoken lines.");
  for(const edit of lineDirections(edits))if(sources[edit.index]?.hash!==edit.sourceHash)fail("A directed line changed or disappeared. Review its source before saving or rendering.");
  if(base&&(base.length!==sources.length||base.some((line,i)=>line.source.hash!==sources[i]!.hash||contentHash(line.source)!==contentHash(sources[i]))))fail("The saved voice lines no longer match this shot.");
  return sources.map(source=>{const original=base?.[source.index],edit=edits.find(e=>e.index===source.index),voice=voiceProfile(original?.voice??{});
    for(const key of ["rateWpm","pitch","level"] as const)if(edit?.[key]!=null)voice[key]=edit[key];
    return {source,voice,beforeMs:number(edit?.beforeMs??original?.beforeMs??0,0,3000,"Leading pause"),afterMs:number(edit?.afterMs??original?.afterMs??200,0,3000,"Trailing pause"),notes:text(edit?.notes??original?.notes??"",600)};});
}
export function spokenText(line:PerformanceLine):string {
  const dict=[...line.voice.pronunciations].sort((a,b)=>b.word.length-a.word.length);
  const escape=(s:string)=>s.replace(/[.*+?^${}()|[\]\\]/g,"\\$&");
  const pattern=dict.length?new RegExp("(?<![\\p{L}\\p{N}_])(?:"+dict.map(p=>escape(p.word)).join("|")+")(?![\\p{L}\\p{N}_])","giu"):null;
  const result=pattern?line.source.text.replace(pattern,value=>dict.find(p=>p.word.toLocaleLowerCase("en-US")===value.toLocaleLowerCase("en-US"))!.say):line.source.text;
  gateOrThrow(result);return result;
}
export function speechCaptions(report:SpeechReport):CaptionCue[]{return report.lines.flatMap(line=>captionCues([{character:line.source.character,lines:[line.source.text]}],(line.endSample-line.startSample)/report.sampleRate).map(cue=>({...cue,startSec:cue.startSec+line.startSample/report.sampleRate,endSec:cue.endSec+line.startSample/report.sampleRate})));}
export function validateSpeechReport(report:SpeechReport):SpeechReport {
  record(report,["schema","engine","engineVersion","sampleRate","totalSamples","lines"]);
  if(report.schema!=="hv-speech/1"||report.engine!=="espeak-ng"||!/^espeak-[a-f0-9]{64}$/.test(report.engineVersion)||report.sampleRate!==22050||!Array.isArray(report.lines)||!report.lines.length||report.lines.length>128)fail("Invalid recorded speech engine or lines.");
  number(report.totalSamples,1,22050*600,"Recorded samples");let cursor=0;
  for(const [i,line]of report.lines.entries()){
    record(line,["source","voice","beforeMs","afterMs","notes","spokenText","startSample","endSample","pcmSha256"]);
    const {hash,...data}=line.source;record(line.source,["index","dialogueIndex","lineIndex","character","text","cues","hash"]);
    if(data.index!==i||contentHash(data)!==hash||!Array.isArray(data.cues)||data.cues.some(c=>typeof c!=="string"))fail("Recorded line source changed.");
    number(data.dialogueIndex,0,10000,"Dialogue index");number(data.lineIndex,0,10000,"Source line index");text(data.character,1000);text(data.text,20000);text(line.notes,600);
    if(contentHash(voiceProfile(line.voice))!==contentHash(line.voice)||spokenText(line)!==line.spokenText||!/^[a-f0-9]{64}$/.test(line.pcmSha256))fail("Recorded line performance changed.");
    cursor+=Math.round(number(line.beforeMs,0,3000,"Leading pause")*22050/1000);
    if(line.startSample!==cursor||!Number.isInteger(line.endSample)||line.endSample<=cursor)fail("Recorded speech timing changed.");
    cursor=line.endSample+Math.round(number(line.afterMs,0,3000,"Trailing pause")*22050/1000);
  }
  if(cursor!==report.totalSamples)fail("Recorded speech duration changed.");return report;
}
