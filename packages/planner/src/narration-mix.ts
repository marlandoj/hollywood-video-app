import type {Job} from "../../queue/src/index";
import {contentHash} from "../../generator/src/capabilities";
import {audioHash,audioNumber,audioRecord,AudioPerformanceError} from "./audio-performances";
import {validateRetainedAudition,type RetainedAudition} from "./retained-auditions";
import {timelineSampleCounts,validateAudioTimeline,type AudioTimelineReport} from "./audio-timeline";
import {parseFountain} from "../../parser/src/index";
import {scenePerformanceSource} from "./performance-memory";
import {renderShots,type RenderFile} from "./shot-reuse";
import {audioLanguage,type AudioLanguage} from "../../generator/src/audio-languages";

export const NARRATION_MIX_RECIPE={schema:"hv-narration-mix-recipe/1",sampleRate:22050,channels:1,encoding:"pcm_s16le",gainScale:16777216,
  envelope:"linear-amplitude-before-and-after-measured-speech",overlappingDucks:"minimum-gain",sum:"fixed-point-before-final-round",clipping:"reject",picture:"unchanged",timing:"no-stretch"} as const;
export const NARRATION_MIX_RECIPE_REVISION=contentHash(NARRATION_MIX_RECIPE);
export interface NarrationCue {id:string;role:"narration"|"voice-over";startSample:number;gainDb:number;duckDb:number;attackMs:number;releaseMs:number;audition:RetainedAudition}
export interface NarrationTrack {schema:"hv-narration-track/1";language:AudioLanguage;review:"owner-reviewed";cues:NarrationCue[];revision:string}
export interface NarrationMixReport {schema:"hv-narration-mix/1";track:NarrationTrack;recipeRevision:string;totalSamples:number;sourceAudioSha256:string;
  conversions:{cueId:string;report:AudioTimelineReport}[];mixWavSha256:string;narrationWavSha256:string;duckedWavSha256:string;
  peaks:{mix:number;narration:number;ducked:number};revision:string}
function fail(message:string):never{throw new AudioPerformanceError(message);}
export function narrationSceneWindows(source:Job):{sceneIndex:number;startSample:number;endSample:number}[]{
  const declared=renderShots(source,Date.parse(source.startedAt??source.completedAt??"")),windows:{sceneIndex:number;startSample:number;endSample:number}[]=[];let cursor=0;
  for(const shot of source.output?.shotRenders??[]){const sceneIndex=declared.find(s=>s.id===shot.shotId)?.sceneIndex;if(sceneIndex===undefined)fail("Narration needs the retained scene order.");
    const end=cursor+Math.round(shot.clip.durationSec*30)*735,last=windows.at(-1);if(last?.sceneIndex===sceneIndex)last.endSample=end;else windows.push({sceneIndex,startSample:cursor,endSample:end});cursor=end;}
  return windows;
}
export function narrationTrack(source:Job,input:unknown,totalSamples:number,language:AudioLanguage):NarrationTrack {
  const value=audioRecord(input,["language","reviewed","cues"]);audioLanguage(language);
  if(value.reviewed!==true||value.language!==language||!Array.isArray(value.cues)||value.cues.length>64)fail("Review up to 64 narration cues in the film's dialogue language.");
  audioNumber(totalSamples,1,22050*3600,"Narration timeline samples",true);const windows=narrationSceneWindows(source),scenes=parseFountain(source.scriptText).scenes;
  const cues=value.cues.map(raw=>{const v=audioRecord(raw,["id","role","startSample","gainDb","duckDb","attackMs","releaseMs","audition"]),audition=validateRetainedAudition(v.audition as RetainedAudition);
    if(typeof v.id!=="string"||!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(v.id)||!["narration","voice-over"].includes(v.role as string))fail("Name each narration cue and choose its track role.");
    if(!audition.take.narration||audition.projectId!==source.projectId)fail("Choose a reviewed narration audition owned by this project.");
    if((audition.take.line.localization?.language??audition.take.line.profile.language)!==language)fail("The narration take must match this film's caption language.");
    const sceneIndex=audition.take.sceneIndex,scene=scenes[sceneIndex],recorded=parseFountain(audition.scriptText).scenes[sceneIndex];
    if(!scene||!recorded||scenePerformanceSource(scene)!==scenePerformanceSource(recorded))fail("The narration scene changed. Review a new take against this picture's screenplay.");
    const startSample=audioNumber(v.startSample,0,totalSamples-1,"Narration start sample",true),endSample=startSample+timelineSampleCounts(audition.output.report).total;
    if(endSample>totalSamples||!windows.some(w=>w.sceneIndex===sceneIndex&&startSample>=w.startSample&&endSample<=w.endSample))fail("Place the complete narration read inside its reviewed scene. Shorten an overlong read or revise the picture; audio is never stretched.");
    const gainDb=audioNumber(v.gainDb,-24,0,"Narration gain"),duckDb=audioNumber(v.duckDb,-36,0,"Dialogue ducking");
    if([gainDb,duckDb].some(v=>Math.abs(v*10-Math.round(v*10))>1e-8))fail("Use narration and ducking levels in steps of 0.1 dB.");
    return {id:v.id,role:v.role as NarrationCue["role"],startSample,gainDb,duckDb,attackMs:audioNumber(v.attackMs,0,1000,"Duck attack milliseconds",true),releaseMs:audioNumber(v.releaseMs,0,3000,"Duck release milliseconds",true),audition};
  }).sort((a,b)=>a.startSample-b.startSample||a.id.localeCompare(b.id));
  if(new Set(cues.map(c=>c.id)).size!==cues.length)fail("Use each narration cue identity once.");
  if(cues.reduce((sum,c)=>sum+timelineSampleCounts(c.audition.output.report).total,0)>22050*3600)fail("A narration mix supports up to one hour of combined retained reads.");
  const data={schema:"hv-narration-track/1" as const,language,review:"owner-reviewed" as const,cues};return {...data,revision:contentHash(data)};
}
export function validateNarrationTrack(source:Job,track:NarrationTrack,totalSamples:number,language:AudioLanguage):NarrationTrack {
  audioRecord(track,["schema","language","review","cues","revision"]);const valid=narrationTrack(source,{language:track.language,reviewed:track.review==="owner-reviewed",cues:track.cues},totalSamples,language);
  if(contentHash(valid)!==contentHash(track))fail("The reviewed narration track changed.");return valid;
}
export function narrationConvertedName(cueId:string):string{return "narration/"+cueId+".wav";}
export function narrationMediaNames(report?:NarrationMixReport):string[]{return report?["mix.wav","narration.wav","ducked-dialogue.wav",...report.track.cues.map(c=>narrationConvertedName(c.id))]:[];}
export function validateNarrationFileSet(report:NarrationMixReport,files:RenderFile[]):void {
  const names=narrationMediaNames(report);if(!Array.isArray(files)||files.length!==names.length||new Set(files.map(f=>f.path)).size!==files.length||names.some(name=>files.filter(f=>f.path.endsWith("/"+name)).length!==1))fail("Retain every narration stem and converted cue.");
  for(const [name,sha256]of [["mix.wav",report.mixWavSha256],["narration.wav",report.narrationWavSha256],["ducked-dialogue.wav",report.duckedWavSha256]]){const file=files.find(f=>f.path.endsWith("/"+name))!;if(file.sha256!==sha256||file.bytes!==44+report.totalSamples*2)fail("A narration stem changed.");}
  for(const conversion of report.conversions)if(files.find(f=>f.path.endsWith("/"+narrationConvertedName(conversion.cueId)))!.bytes!==44+conversion.report.totalSamples*2)fail("A converted narration read changed length.");
}
export function narrationAuditionLines(track?:NarrationTrack):{audition:{source:RetainedAudition}}[]{return track?.cues.map(c=>({audition:{source:c.audition}}))??[];}
export function validateNarrationMix(source:Job,report:NarrationMixReport,track:NarrationTrack,totalSamples:number,sourceAudioSha256:string,engineVersion:string):void {
  audioRecord(report,["schema","track","recipeRevision","totalSamples","sourceAudioSha256","conversions","mixWavSha256","narrationWavSha256","duckedWavSha256","peaks","revision"]);
  validateNarrationTrack(source,report.track,totalSamples,track.language);
  if(report.schema!=="hv-narration-mix/1"||contentHash(report.track)!==contentHash(track)||report.recipeRevision!==NARRATION_MIX_RECIPE_REVISION||report.totalSamples!==totalSamples||report.sourceAudioSha256!==sourceAudioSha256||!Array.isArray(report.conversions)||report.conversions.length!==track.cues.length)fail("The narration mix changed its reviewed source or recipe.");
  for(const [i,conversion]of report.conversions.entries()){
    audioRecord(conversion,["cueId","report"]);validateAudioTimeline(conversion.report);const cue=track.cues[i]!;
    if(conversion.cueId!==cue.id||contentHash(conversion.report.source)!==contentHash(cue.audition.output.report)||conversion.report.sourceWavSha256!==cue.audition.output.files.find(f=>f.path===cue.audition.output.wavPath)!.sha256||conversion.report.engineVersion!==engineVersion)fail("The narration mix lost its original audition conversion.");
  }
  audioRecord(report.peaks,["mix","narration","ducked"]);for(const v of Object.values(report.peaks))audioNumber(v,0,32768,"Recorded PCM sample peak",true);
  for(const hash of [report.sourceAudioSha256,report.mixWavSha256,report.narrationWavSha256,report.duckedWavSha256,report.revision])audioHash(hash);
  const {revision,...data}=report;if(revision!==contentHash(data))fail("The narration mix receipt changed.");
}
