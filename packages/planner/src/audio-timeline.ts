import {contentHash} from "../../generator/src/capabilities";
import {audioPcmHash,validateAudioDelivery,type AudioLineDelivery,type AudioTiming} from "../../generator/src/audio-delivery";
import {audioHash,audioNumber,audioRecord,AudioPerformanceError} from "./audio-performances";

/** Conversion is a derived asset; original 48 kHz delivery evidence stays intact. */
export const AUDIO_TIMELINE_RECIPE={schema:"hv-audio-resample/1",inputRate:48000,outputRate:22050,encoding:"pcm_s16le",channels:1,
  resampler:"swr",filterSize:64,phaseShift:10,exactRational:true,dither:"none",tailPaddingSamples:128,
  speechLength:"ceil-input-times-147-over-320",pauseLength:"nearest-millisecond-sample",timing:"nearest-provider-time-clamped-to-speech"} as const;
export const AUDIO_TIMELINE_RECIPE_REVISION=contentHash(AUDIO_TIMELINE_RECIPE);
export interface TimelineToken {text:string;startSample:number;endSample:number}
export interface AudioTimelineReport {
  schema:"hv-audio-timeline/1";source:AudioLineDelivery;sourceWavSha256:string;
  recipeRevision:string;engineVersion:string;sampleRate:22050;totalSamples:number;
  speechStartSample:number;speechEndSample:number;pcmSha256:string;speechPcmSha256:string;
  alignment:{basis:"rescaled-provider-timestamps";origin:"line-start";words:TimelineToken[];phonemes:TimelineToken[]};revision:string;
}
function fail(s:string):never{throw new AudioPerformanceError(s);}
export function timelineSampleCounts(source:AudioLineDelivery):{before:number;speech:number;after:number;total:number}{
  validateAudioDelivery(source);
  const before=Math.round(source.plan.beforeMs*22050/1000),speech=Math.ceil((source.speechEndSample-source.speechStartSample)*147/320),after=Math.round(source.plan.afterMs*22050/1000);
  return {before,speech,after,total:before+speech+after};
}
export function timelineAlignment(source:AudioLineDelivery):AudioTimelineReport["alignment"]{
  const {before,speech}=timelineSampleCounts(source);
  const tokens=(items:AudioTiming[])=>items.map(t=>({text:t.text,startSample:before+Math.min(speech,Math.round(t.startSec*22050)),endSample:before+Math.min(speech,Math.round(t.endSec*22050))}));
  return {basis:"rescaled-provider-timestamps",origin:"line-start",words:tokens(source.alignment.words),phonemes:tokens(source.alignment.phonemes)};
}
export function createAudioTimelineReport(source:AudioLineDelivery,sourceWavSha256:string,engineVersion:string,pcm:Buffer):AudioTimelineReport{
  const count=timelineSampleCounts(source),data={schema:"hv-audio-timeline/1" as const,source:structuredClone(source),sourceWavSha256,
    recipeRevision:AUDIO_TIMELINE_RECIPE_REVISION,engineVersion,sampleRate:22050 as const,totalSamples:count.total,speechStartSample:count.before,speechEndSample:count.before+count.speech,
    pcmSha256:audioPcmHash(pcm),speechPcmSha256:audioPcmHash(pcm.subarray(count.before*2,(count.before+count.speech)*2)),alignment:timelineAlignment(source)};
  return validateAudioTimeline({...data,revision:contentHash(data)},pcm);
}
/** Historical validation never requires the conversion executable to be installed. */
export function validateAudioTimeline(report:AudioTimelineReport,pcm?:Buffer):AudioTimelineReport{
  audioRecord(report,["schema","source","sourceWavSha256","recipeRevision","engineVersion","sampleRate","totalSamples","speechStartSample","speechEndSample","pcmSha256","speechPcmSha256","alignment","revision"]);
  const count=timelineSampleCounts(report.source);
  if(report.schema!=="hv-audio-timeline/1"||report.sampleRate!==22050||report.recipeRevision!==AUDIO_TIMELINE_RECIPE_REVISION||!/^ffmpeg-audio-[a-f0-9]{64}$/.test(report.engineVersion)
    ||report.totalSamples!==count.total||report.speechStartSample!==count.before||report.speechEndSample!==count.before+count.speech||contentHash(report.alignment)!==contentHash(timelineAlignment(report.source)))fail("The converted audition changed its recipe, duration or provider timing.");
  for(const value of [report.sourceWavSha256,report.pcmSha256,report.speechPcmSha256,report.revision])audioHash(value);
  const {revision,...data}=report;if(contentHash(data)!==revision)fail("The converted audition report changed.");
  if(pcm&&(pcm.length!==count.total*2||audioPcmHash(pcm)!==report.pcmSha256||audioPcmHash(pcm.subarray(count.before*2,(count.before+count.speech)*2))!==report.speechPcmSha256
    ||pcm.subarray(0,count.before*2).some(b=>b!==0)||pcm.subarray((count.before+count.speech)*2).some(b=>b!==0)))fail("The converted audition PCM or exact pauses changed.");
  return structuredClone(report);
}
/** A retained read occupies its complete reviewed pauses and speech. Never trim to fit picture. */
export function assertAudioTimelineWindow(source:AudioLineDelivery,availableSamples:number):void{
  audioNumber(availableSamples,1,22050*60*60,"Available dialogue samples",true);const count=timelineSampleCounts(source);
  if(count.total>availableSamples)fail(`The retained audition needs ${(count.total/22050).toFixed(3)}s; ${(availableSamples/22050).toFixed(3)}s is available in the locked picture. Choose a shorter take or revise the picture timing.`);
}
