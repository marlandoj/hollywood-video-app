import {contentHash as hash} from "../../generator/src/capabilities";
import type {Job} from "../../queue/src/index";
import {validateCompletedCurrentFilmSource} from "./current-film-job-context";
import type {CurrentFilmAssemblyClock} from "./current-film-clock";
import type {CurrentFilmSlot} from "./current-film-jobs";
import type {EditVoiceWindow} from "./edit-timeline";
import type {LineSource} from "./performances";
import type {ShotRenderRecord} from "./shot-reuse";

export interface CurrentFilmSourceSpoken {
  lineId:string;beatId:string;source:LineSource;voiceId:string;performedText:string;
  /** Film-global samples in the retained original mono 22,050 Hz PCM clock. */
  nativeStartSample:number;nativeEndSample:number;
  /** Film-global samples in the editorial 48 kHz clock, rounded once. */
  startSample:number;endSample:number;pcmSha256:string;
}
type AssemblySpan=CurrentFilmAssemblyClock["spans"][number];
export interface CurrentFilmSourceSpan extends AssemblySpan {
  slot:CurrentFilmSlot;record:ShotRenderRecord;startSample:number;endSample:number;spoken:CurrentFilmSourceSpoken[];
}
export interface CurrentFilmSourceClock {
  schema:"hv-current-film-source-clock/1";sourceId:string;sourceOutputRevision:string;jobPlanRevision:string;
  documentRevision:string;clockRevision:string;frames:number;width:number;height:number;
  spans:CurrentFilmSourceSpan[];voices:EditVoiceWindow[];unmeasuredAudio:boolean;isolatedDialogue:boolean;revision:string;
}
function fail(message:string):never{throw new Error(message);}
const sample48=(native:number)=>Math.round(native*48000/22050);

/** Historical metadata derivation only. Byte verification, retained carrier custody
 * and current source permissions remain separate gates. No legacy replan is used. */
export function currentFilmSourceClock(job:Job):CurrentFilmSourceClock {
  // This descriptor-safe validator runs before reading any caller-owned fields.
  const plan=validateCompletedCurrentFilmSource(job);
  const output=job.output!.currentFilm!,clock=output.assembly,voices:EditVoiceWindow[]=[];
  const spans:CurrentFilmSourceSpan[]=clock.spans.map((span,index)=>{
    const slot=plan.materialization.slots[index]!,record=output.records[index]!.record,report=record.clip.speech;
    const physical=new Map(slot.physical.spoken.map(line=>[line.source.hash,line]));
    if(physical.size!==slot.physical.spoken.length)fail("Current-film spoken identities must remain unique within their original slot.");
    const spoken:CurrentFilmSourceSpoken[]=(report?.lines??[]).map(line=>{
      const source=physical.get(line.source.hash);
      if(!source||hash(source.source)!==hash(line.source)||!record.files.audio)fail("The retained measured line lost its exact physical screenplay identity or original audio.");
      const nativeStartSample=span.startFrame*735+line.startSample,nativeEndSample=span.startFrame*735+line.endSample;
      const startSample=sample48(nativeStartSample),endSample=sample48(nativeEndSample);
      if(nativeStartSample<span.startFrame*735||nativeEndSample>span.endFrame*735||startSample>=endSample||endSample>clock.frames*1600)fail("The retained measured line exceeds its actual source picture span.");
      const voiceId=hash({schema:"hv-current-film-source-voice/1",sourceId:job.id,jobPlanRevision:plan.revision,clockRevision:clock.revision,
        logicalShotId:slot.logicalShotId,renderId:slot.renderId,recordRevision:record.revision,lineId:source.lineId,sourceHash:line.source.hash});
      voices.push({id:voiceId,start:startSample,end:endSample,lane:"dialogue"});
      return {lineId:source.lineId,beatId:source.beatId,source:line.source,voiceId,performedText:line.spokenText,nativeStartSample,nativeEndSample,startSample,endSample,pcmSha256:line.pcmSha256};
    });
    return {...span,slot,record,startSample:span.startFrame*1600,endSample:span.endFrame*1600,spoken};
  });
  const body={schema:"hv-current-film-source-clock/1" as const,sourceId:job.id,sourceOutputRevision:hash(job.output),jobPlanRevision:plan.revision,
    documentRevision:plan.materialization.documentRevision,clockRevision:clock.revision,frames:clock.frames,width:clock.probe.video.width,height:clock.probe.video.height,
    spans,voices,unmeasuredAudio:spans.some(span=>!span.record.clip.speech&&span.record.clip.audioMode!=="silent-captioned"),isolatedDialogue:spans.some(span=>Boolean(span.record.clip.speech))};
  return structuredClone({...body,revision:hash(body)});
}
