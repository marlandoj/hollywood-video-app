import {contentHash} from "../../generator/src/capabilities";
import {audioHash,audioNumber,audioRecord} from "./audio-performances";
import {soundFail} from "./sound-assets";

export const SOUND_FINISH_RECIPE={schema:"hv-sound-finishing-recipe/1",meter:"ffmpeg-loudnorm-input-and-ebur128-windows",normalizer:"loudnorm-two-pass-linear-or-dynamic",sampleRate:48000,encoding:"pcm_s24le",maximumGainDb:20,stems:"pre-master",measurement:"full-program-stereo",loudnessToleranceLu:0.2,peakToleranceDb:0.05} as const;
export type SoundFinishing={schema:"hv-sound-finishing/1";mode:"measure"}|{schema:"hv-sound-finishing/1";mode:"normalize";targetLufs:number;ceilingDbtp:number;rangeLu:number};
export interface SoundLoudness {schema:"hv-sound-loudness/1";frames:number;integratedLufs:number|null;truePeakDbtp:number|null;rangeLu:number|null;relativeGateLufs:number|null;momentaryMaxLufs:number|null;shortTermMaxLufs:number|null;rangeStable:boolean;silent:boolean;unavailableMomentaryWindows:number;unavailableShortTermWindows:number}
export interface SoundFinishingReport {schema:"hv-sound-finishing-result/1";settings:SoundFinishing;recipeRevision:string;engineVersion:string;inputSha256:string;masterSha256:string;mode:"measure"|"linear"|"dynamic";before:SoundLoudness;after:SoundLoudness;encoded:SoundLoudness;pcmTargetsMet:boolean|null;encodedTargetsMet:boolean|null}
export const SOUND_FINISH_FILES=["finishing/master.wav","finishing/report.json","finishing/processing.json",...(["before","after","encoded"] as const).flatMap(tag=>["finishing/"+tag+"-loudnorm.json","finishing/"+tag+"-windows.txt"])] as const;
export function soundFinishing(input:unknown):SoundFinishing {
  const v=audioRecord(input,["schema","mode","targetLufs","ceilingDbtp","rangeLu"]);
  if(v.schema!=="hv-sound-finishing/1")soundFail("Choose current sound finishing settings.");
  if(v.mode==="measure"){if(Object.keys(v).length!==2)soundFail("Measurement does not apply a delivery target.");return {schema:"hv-sound-finishing/1",mode:"measure"};}
  if(v.mode!=="normalize")soundFail("Choose measurement or reviewed normalization and limiting.");
  const step=(value:unknown,min:number,max:number,label:string)=>{const n=audioNumber(value,min,max,label);if(Math.abs(n*10-Math.round(n*10))>1e-8)soundFail("Use "+label+" in steps of 0.1.");return n;};
  return {schema:"hv-sound-finishing/1",mode:"normalize",targetLufs:step(v.targetLufs,-30,-9,"full-mix target LUFS"),ceilingDbtp:step(v.ceilingDbtp,-9,-1,"true-peak ceiling dBTP"),rangeLu:step(v.rangeLu,1,20,"loudness range LU")};
}
export function soundTargetsMet(m:SoundLoudness,s:SoundFinishing):boolean|null{return s.mode==="measure"?null:m.integratedLufs!==null&&m.truePeakDbtp!==null&&Math.abs(m.integratedLufs-s.targetLufs)<=SOUND_FINISH_RECIPE.loudnessToleranceLu+1e-8&&m.truePeakDbtp<=s.ceilingDbtp+SOUND_FINISH_RECIPE.peakToleranceDb;}
export function validateSoundLoudness(m:SoundLoudness,frames:number):void{
  audioRecord(m,["schema","frames","integratedLufs","truePeakDbtp","rangeLu","relativeGateLufs","momentaryMaxLufs","shortTermMaxLufs","rangeStable","silent","unavailableMomentaryWindows","unavailableShortTermWindows"]);
  if(m.schema!=="hv-sound-loudness/1"||m.frames!==frames||typeof m.silent!=="boolean"||m.rangeStable!==(frames>=48000*60))soundFail("The sound measurement timeline changed.");
  for(const key of ["integratedLufs","truePeakDbtp","relativeGateLufs","momentaryMaxLufs","shortTermMaxLufs"] as const)if(m[key]!==null)audioNumber(m[key],-150,24,key);
  for(const count of [m.unavailableMomentaryWindows,m.unavailableShortTermWindows])audioNumber(count,0,Math.ceil(frames/4800),"unavailable loudness windows",true);
  if(m.rangeLu!==null)audioNumber(m.rangeLu,0,150,"measured loudness range");
  if(m.silent&&(m.integratedLufs!==null||m.truePeakDbtp!==null)||frames<144000&&m.shortTermMaxLufs!==null||frames<19200&&m.integratedLufs!==null)soundFail("Invalid silence or incomplete-window loudness evidence.");
}
export function validateSoundFinishingReport(r:SoundFinishingReport,settings:SoundFinishing,frames:number,inputSha256:string,engineVersion:string):void{
  audioRecord(r,["schema","settings","recipeRevision","engineVersion","inputSha256","masterSha256","mode","before","after","encoded","pcmTargetsMet","encodedTargetsMet"]);soundFinishing(r.settings);
  if(r.schema!=="hv-sound-finishing-result/1"||contentHash(r.settings)!==contentHash(settings)||r.recipeRevision!==contentHash(SOUND_FINISH_RECIPE)||r.engineVersion!==engineVersion||r.inputSha256!==inputSha256||!(settings.mode==="measure"?r.mode==="measure":["linear","dynamic"].includes(r.mode)))soundFail("The finishing receipt differs from its reviewed settings.");
  audioHash(r.inputSha256);audioHash(r.masterSha256);for(const m of [r.before,r.after,r.encoded])validateSoundLoudness(m,frames);
  if(r.pcmTargetsMet!==soundTargetsMet(r.after,settings)||r.encodedTargetsMet!==soundTargetsMet(r.encoded,settings)||settings.mode==="measure"&&(r.masterSha256!==r.inputSha256||contentHash(r.before)!==contentHash(r.after)))soundFail("The delivery result misstates its processing or measured targets.");
}
