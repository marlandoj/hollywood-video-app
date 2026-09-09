import type {Job} from "../../queue/src/index";
import {contentHash as hash} from "../../generator/src/capabilities";
import {editValidationKey} from "./edit-validation-key";
import {currentFilmV3Job} from "./current-film-runtime-context";
import {currentFilmV2Job} from "./current-film-job-context";
import {validateCurrentFilmMixedOutput} from "./current-film-mixed-job-context";
import {resolveCurrentFilmMixedAssembly,type CurrentFilmMixedAssemblySlot} from "./current-film-mixed-clock";
import type {CurrentFilmSlot} from "./current-film-jobs";
import type {ShotExecutionCapture} from "./shot-execution-capture";
import type {EditVoiceWindow} from "./edit-timeline";
import type {LineSource} from "./performances";

export const CURRENT_FILM_MIXED_SOURCE_LIMITS={inputBytes:256*1024**2,outputBytes:64*1024**2,spans:60,spoken:100000} as const;
type PhysicalSpoken=CurrentFilmSlot["physical"]["spoken"][number];
export interface CurrentFilmMixedSourceSpoken {
  /** Canonical target document identity, separate from the original performance. */
  lineId:string;beatId:string;source:LineSource;
  original:{lineId:string;beatId:string;source:LineSource};
  voiceId:string;performedText:string;pcmSha256:string;
  /** Half-open samples local to the original record's mono 22,050 Hz waveform. */
  recordStartSample:number;recordEndSample:number;
  /** Half-open samples in the completed target film, before global conversion. */
  nativeStartSample:number;nativeEndSample:number;
  /** Film-global 48 kHz positions, rounded once from the native global clock. */
  startSample:number;endSample:number;
}
export interface CurrentFilmMixedSourceSpan {
  target:CurrentFilmSlot;frames:number;startFrame:number;endFrame:number;startSample:number;endSample:number;
  originalRecord:CurrentFilmMixedAssemblySlot["originalRecord"];originalCapture:ShotExecutionCapture;
  ownedFiles:CurrentFilmMixedAssemblySlot["ownedFiles"];execution:CurrentFilmMixedAssemblySlot["execution"];
  correspondence:CurrentFilmMixedAssemblySlot["correspondence"];spoken:CurrentFilmMixedSourceSpoken[];
}
export interface CurrentFilmMixedSourceClock {
  schema:"hv-current-film-mixed-source-clock/1";sourceId:string;sourceOutputRevision:string;jobPlanRevision:string;
  materializationRevision:string;documentRevision:string;targetRevision:string;originsRevision:string;checkpointRevision:string;clockRevision:string;
  frames:number;width:number;height:number;effectiveOverlapFrames:0|15;
  spans:CurrentFilmMixedSourceSpan[];voices:EditVoiceWindow[];unmeasuredAudio:boolean;isolatedDialogue:boolean;
  authority:"historical-only";mediaVerified:false;revision:string;
}
function fail(message:string):never {throw new Error(message);}
function date(value:unknown):number {
  if(typeof value!=="string"||!Number.isSafeInteger(Date.parse(value))||Date.parse(value)<0||new Date(value).toISOString()!==value)fail("Retain canonical completed mixed-film source times.");
  return Date.parse(value);
}
function equal(a:unknown,b:unknown):boolean {return hash(a)===hash(b);}
const sample48=(native:number)=>Math.round(native*48000/22050);

/** Complete historical metadata derivation. A caller separately establishes current
 * rights, preview approval custody, retained availability and actual media bytes.
 * No source receipt, fresh render record or generation approval is created here. */
export function currentFilmMixedSourceClock(input:Job):CurrentFilmMixedSourceClock {
  if(!editValidationKey(input,CURRENT_FILM_MIXED_SOURCE_LIMITS.inputBytes))fail("Retain bounded portable completed mixed-film source evidence.");
  const job=currentFilmV3Job(structuredClone(input));
  if(job.status!=="done"||!job.output||!job.currentFilmCheckpoint||!job.currentFilmOrigins
    ||date(job.completedAt)<date(job.startedAt)||date(job.linkExpiresAt)<=date(job.completedAt))fail("Choose a complete mixed-film source with its original lifetime and output.");
  // This replays the complete ordered checkpoint, including its generated journal,
  // adoptions and exact measured clock. The request validator alone is insufficient.
  validateCurrentFilmMixedOutput(job,job.output);
  const plan=job.currentFilm,clock=job.output.currentFilm.assembly,assembly=resolveCurrentFilmMixedAssembly(job,job.currentFilmCheckpoint);
  if(assembly.slots.length>CURRENT_FILM_MIXED_SOURCE_LIMITS.spans)fail("Mixed-film source spans exceed capacity.");
  const originals=new Map(plan.origins.map(origin=>[origin.id,currentFilmV2Job(origin.binding.source.job)]));
  const spans:CurrentFilmMixedSourceSpan[]=[],voices:EditVoiceWindow[]=[];
  let outputBytes=2048,spokenCount=0;
  const reserve=(value:unknown)=>{outputBytes+=Buffer.byteLength(JSON.stringify(value))+1;if(outputBytes>CURRENT_FILM_MIXED_SOURCE_LIMITS.outputBytes)fail("Mixed-film source clock exceeds its complete output capacity.");};
  for(const [ordinal,slot]of assembly.slots.entries()){
    const target=plan.materialization.slots[ordinal]!,position=clock.spans[ordinal]!,row=job.currentFilmCheckpoint.rows[ordinal]!,record=slot.originalRecord,report=record.clip.speech;
    const selection=plan.selection[ordinal]!;
    const originalCapture=row.kind==="generated"?row.capture:selection.kind==="reuse"?originals.get(selection.originId)!.currentFilmCheckpoint!.rows[selection.source.ordinal]!.capture:fail("The source slot lost its exact original capture.");
    const targetLines=new Map(target.physical.spoken.map(line=>[line.lineId,line])),mapping=new Map<string,{original:PhysicalSpoken;target:PhysicalSpoken;nativeSamples:{start:number;end:number}|null}>();
    const add=(original:PhysicalSpoken,current:PhysicalSpoken,nativeSamples:{start:number;end:number}|null)=>{
      if(mapping.has(original.source.hash)||!equal(targetLines.get(current.lineId),current))fail("The source speech lost its unique target physical correspondence.");
      mapping.set(original.source.hash,{original,target:current,nativeSamples});
    };
    if(slot.correspondence){for(const line of slot.correspondence.spoken){if(!line.source||!line.target)fail("The reused source has unresolved physical speech correspondence.");add(line.source,line.target,line.nativeSamples);}}
    else for(const line of target.physical.spoken)add(line,line,null);
    if(report&&(!slot.ownedFiles.audio||!record.files.audio||report.totalSamples>position.frames*735))fail("The measured source lost its complete native waveform span.");
    const spoken:CurrentFilmMixedSourceSpoken[]=[],seen=new Set<string>();
    for(const line of report?.lines??[]){
      if(++spokenCount>CURRENT_FILM_MIXED_SOURCE_LIMITS.spoken)fail("Mixed-film measured speech exceeds capacity.");
      const matched=mapping.get(line.source.hash);
      if(!matched||seen.has(line.source.hash)||!equal(matched.original.source,line.source)
        ||slot.correspondence&&!equal(matched.nativeSamples,{start:line.startSample,end:line.endSample}))fail("The measured original line differs from its exact target correspondence.");
      seen.add(line.source.hash);
      const nativeStartSample=position.startFrame*735+line.startSample,nativeEndSample=position.startFrame*735+line.endSample;
      const startSample=sample48(nativeStartSample),endSample=sample48(nativeEndSample);
      if(!Number.isSafeInteger(nativeStartSample)||!Number.isSafeInteger(nativeEndSample)||nativeStartSample<position.startFrame*735||nativeEndSample>position.endFrame*735
        ||nativeStartSample>=nativeEndSample||startSample>=endSample||endSample>clock.frames*1600)fail("The measured source line escaped its actual half-open picture span.");
      const voiceId=hash({schema:"hv-current-film-mixed-source-voice/1",sourceId:job.id,jobPlanRevision:plan.revision,clockRevision:clock.revision,
        ordinal,logicalShotId:target.logicalShotId,renderId:target.renderId,inputRevision:target.inputRevision,recordRevision:record.revision,
        lineId:matched.target.lineId,sourceHash:line.source.hash,recordStartSample:line.startSample,recordEndSample:line.endSample});
      const value:CurrentFilmMixedSourceSpoken={lineId:matched.target.lineId,beatId:matched.target.beatId,source:matched.target.source,
        original:{lineId:matched.original.lineId,beatId:matched.original.beatId,source:line.source},voiceId,performedText:line.spokenText,pcmSha256:line.pcmSha256,
        recordStartSample:line.startSample,recordEndSample:line.endSample,nativeStartSample,nativeEndSample,startSample,endSample};
      reserve(value);spoken.push(value);
      const voice:EditVoiceWindow={id:voiceId,start:startSample,end:endSample,lane:"dialogue"};reserve(voice);voices.push(voice);
    }
    const span:CurrentFilmMixedSourceSpan={target,frames:position.frames,startFrame:position.startFrame,endFrame:position.endFrame,startSample:position.startFrame*1600,endSample:position.endFrame*1600,
      originalRecord:record,originalCapture,ownedFiles:slot.ownedFiles,execution:slot.execution,correspondence:slot.correspondence,spoken};
    // Spoken rows were already reserved individually. Reserve remaining evidence
    // before retaining a span; complete captures are never repeated per line.
    reserve({...span,spoken:[]});spans.push(span);
  }
  const body={schema:"hv-current-film-mixed-source-clock/1" as const,sourceId:job.id,sourceOutputRevision:hash(job.output),jobPlanRevision:plan.revision,
    materializationRevision:plan.materialization.revision,documentRevision:plan.materialization.documentRevision,targetRevision:plan.target.revision,
    originsRevision:job.currentFilmOrigins.revision,checkpointRevision:job.currentFilmCheckpoint.revision,clockRevision:clock.revision,
    frames:clock.frames,width:clock.probe.video.width,height:clock.probe.video.height,effectiveOverlapFrames:clock.effectiveOverlapFrames,spans,voices,
    unmeasuredAudio:spans.some(span=>!span.originalRecord.clip.speech&&span.originalRecord.clip.audioMode!=="silent-captioned"),isolatedDialogue:spans.some(span=>Boolean(span.originalRecord.clip.speech)),
    authority:"historical-only" as const,mediaVerified:false as const};
  const result={...body,revision:hash(body)};
  if(!editValidationKey(result,CURRENT_FILM_MIXED_SOURCE_LIMITS.outputBytes))fail("Mixed-film source clock exceeds its complete output capacity.");
  return structuredClone(result);
}

export function validateCurrentFilmMixedSourceClock(value:CurrentFilmMixedSourceClock,job:Job):CurrentFilmMixedSourceClock {
  if(!editValidationKey(value,CURRENT_FILM_MIXED_SOURCE_LIMITS.outputBytes))fail("Retain bounded portable mixed-film source clock metadata.");
  const expected=currentFilmMixedSourceClock(job);
  if(!equal(value,expected))fail("The mixed-film source clock changed its original execution, target identity or actual timing.");
  return expected;
}
