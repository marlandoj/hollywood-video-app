import {contentHash as hash} from "../../generator/src/capabilities";
import {validateRenderRecord,type ShotRenderRecord} from "./shot-reuse";

export interface CurrentFilmClockRow {ordinal:number;logicalShotId:string;renderId:string;inputRevision:string;record:ShotRenderRecord}
export interface CurrentFilmMediaDigest {sha256:string;bytes:number}
export interface CurrentFilmProbe {
  video:{codec:"h264";width:number;height:number;frames:number;rateNumerator:number;rateDenominator:number;timeBaseNumerator:number;timeBaseDenominator:number;durationTicks:number};
  audio:{codec:"aac";sampleRate:44100;channels:2;timeBaseNumerator:number;timeBaseDenominator:number;durationTicks:number};
}
export type CurrentFilmOverlapReason="single-clip"|"measured-speech"|"requested-zero"|"requested-crossfade";
export interface CurrentFilmAssemblyClockInput {
  projectId:string;jobId:string;jobPlanRevision:string;materializationRevision:string;
  requestedOverlapFrames:0|15;effectiveOverlapFrames:0|15;reason:CurrentFilmOverlapReason;
  rows:CurrentFilmClockRow[];sourceFrames:number[];probe:CurrentFilmProbe;
  video:CurrentFilmMediaDigest;captions:{srt:CurrentFilmMediaDigest;vtt:CurrentFilmMediaDigest};
}
export interface CurrentFilmAssemblyClock {
  schema:"hv-current-film-clock/2";projectId:string;jobId:string;jobPlanRevision:string;materializationRevision:string;
  fps:30;requestedOverlapFrames:0|15;effectiveOverlapFrames:0|15;reason:CurrentFilmOverlapReason;
  spans:{ordinal:number;logicalShotId:string;renderId:string;inputRevision:string;recordRevision:string;frames:number;startFrame:number;endFrame:number;measuredSpeech:boolean}[];
  rawFrames:number;frames:number;probe:CurrentFilmProbe;video:CurrentFilmMediaDigest;
  captions:{policy:"hv-captions-measured-or-fallback-ms/1";srt:CurrentFilmMediaDigest;vtt:CurrentFilmMediaDigest};revision:string;
}
function fail(message:string):never{throw new Error(message);}
const seal=<T extends object>(body:T):T&{revision:string}=>({...body,revision:hash(body)});
function exact(value:unknown,keys:string[]):void{if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!==keys.slice().sort().join(","))fail("Retain exact current-film clock fields.");}
function integer(value:unknown,min:number,max=Number.MAX_SAFE_INTEGER):asserts value is number{if(typeof value!=="number"||!Number.isSafeInteger(value)||value<min||value>max)fail("Retain exact bounded current-film frame, sample and byte counts.");}
function digest(value:unknown):void{if(typeof value!=="string"||!/^[a-f0-9]{64}$/.test(value))fail("Retain exact current-film clock digests.");}
function id(value:unknown):void{if(typeof value!=="string"||!/^[A-Za-z0-9_-]{1,128}$/.test(value))fail("Retain exact current-film clock identities.");}
function portable<T>(input:T):T{
  let nodes=0,bytes=0;const active=new Set<object>();
  const visit=(value:unknown,depth:number):void=>{
    if(++nodes>500000||depth>120)fail("Current-film clock exceeds metadata capacity.");
    if(typeof value==="string"){bytes+=Buffer.byteLength(value);if(bytes>16*1024**2)fail("Current-film clock exceeds metadata capacity.");return;}
    if(value===null||typeof value==="boolean"||typeof value==="number"&&Number.isFinite(value)&&!Object.is(value,-0))return;
    if(typeof value!=="object"||active.has(value))fail("Retain portable current-film clock data.");
    const array=Array.isArray(value),keys=Reflect.ownKeys(value),prototype=Object.getPrototypeOf(value);
    if(array?prototype!==Array.prototype:prototype!==Object.prototype&&prototype!==null)fail("Retain plain current-film clock data.");
    if(array&&keys.length!==value.length+1)fail("Retain dense current-film clock arrays.");active.add(value);
    for(const key of keys){if(array&&key==="length")continue;const field=Object.getOwnPropertyDescriptor(value,key)!;
      if(typeof key!=="string"||!field.enumerable||!Object.hasOwn(field,"value")||array&&(!/^(0|[1-9][0-9]*)$/.test(key)||Number(key)>=value.length))fail("Current-film clock cannot contain accessors or hidden data.");
      bytes+=Buffer.byteLength(key);if(bytes>16*1024**2)fail("Current-film clock exceeds metadata capacity.");visit(field.value,depth+1);
    }active.delete(value);
  };visit(input,0);if(Buffer.byteLength(JSON.stringify(input))>16*1024**2)fail("Current-film clock exceeds metadata capacity.");return structuredClone(input);
}
function media(value:CurrentFilmMediaDigest,max:number):void{exact(value,["sha256","bytes"]);digest(value.sha256);integer(value.bytes,1,max);}
/** The assembler calls this immediately after choosing its actual overlap policy. */
export function currentFilmOverlap(rows:Pick<CurrentFilmClockRow,"record">[],requested:0|15):{effectiveOverlapFrames:0|15;reason:CurrentFilmOverlapReason}{
  if(requested!==0&&requested!==15)fail("Use the admitted current-film overlap request.");
  if(rows.length===1)return {effectiveOverlapFrames:0,reason:"single-clip"};
  if(rows.some(row=>row.record.clip.speech))return {effectiveOverlapFrames:0,reason:"measured-speech"};
  return {effectiveOverlapFrames:requested,reason:requested?"requested-crossfade":"requested-zero"};
}
/** Seal measured media facts only. Callers verify source bytes and owner custody separately. */
export function createCurrentFilmAssemblyClock(raw:CurrentFilmAssemblyClockInput):CurrentFilmAssemblyClock{
  const input=portable(raw);exact(input,["projectId","jobId","jobPlanRevision","materializationRevision","requestedOverlapFrames","effectiveOverlapFrames","reason","rows","sourceFrames","probe","video","captions"]);
  id(input.projectId);id(input.jobId);digest(input.jobPlanRevision);digest(input.materializationRevision);
  if(!Array.isArray(input.rows)||!input.rows.length||input.rows.length>60||!Array.isArray(input.sourceFrames)||input.sourceFrames.length!==input.rows.length)fail("Retain every ordered actual current-film source frame count.");
  const expected=currentFilmOverlap(input.rows,input.requestedOverlapFrames);if(input.effectiveOverlapFrames!==expected.effectiveOverlapFrames||input.reason!==expected.reason)fail("The recorded assembler overlap differs from its actual speech policy.");
  const renderIds=new Set<string>(),logicalIds=new Set<string>();let rawFrames=0,at=0;
  const spans=input.rows.map((row,index)=>{
    exact(row,["ordinal","logicalShotId","renderId","inputRevision","record"]);digest(row.logicalShotId);id(row.renderId);digest(row.inputRevision);
    if(row.ordinal!==index||renderIds.has(row.renderId)||logicalIds.has(row.logicalShotId))fail("Retain unique current-film rows in actual assembly order.");renderIds.add(row.renderId);logicalIds.add(row.logicalShotId);
    const record=validateRenderRecord(row.record,{projectId:input.projectId,id:input.jobId});if(record.shotId!==row.renderId||record.inputHash!==row.inputRevision||record.reusedFrom)fail("The current-film clock lost its fresh owning record.");
    const frames=input.sourceFrames[index]!;integer(frames,1,18000);if(Math.abs(record.clip.durationSec*30-frames)>1e-7||input.rows.length>1&&frames<=input.effectiveOverlapFrames)fail("Actual source frames differ from the clip duration or lack valid dissolve handles.");
    const startFrame=at,endFrame=at+frames;rawFrames+=frames;at=endFrame-input.effectiveOverlapFrames;
    return {ordinal:index,logicalShotId:row.logicalShotId,renderId:row.renderId,inputRevision:row.inputRevision,recordRevision:record.revision,frames,startFrame,endFrame,measuredSpeech:Boolean(record.clip.speech)};
  });
  const frames=spans.at(-1)!.endFrame;exact(input.probe,["video","audio"]);const v=input.probe.video,a=input.probe.audio;
  exact(v,["codec","width","height","frames","rateNumerator","rateDenominator","timeBaseNumerator","timeBaseDenominator","durationTicks"]);exact(a,["codec","sampleRate","channels","timeBaseNumerator","timeBaseDenominator","durationTicks"]);
  for(const value of [v.width,v.height,v.frames,v.rateNumerator,v.rateDenominator,v.timeBaseNumerator,v.timeBaseDenominator,v.durationTicks,a.timeBaseNumerator,a.timeBaseDenominator,a.durationTicks])integer(value,1);
  if(v.codec!=="h264"||a.codec!=="aac"||a.sampleRate!==44100||a.channels!==2||v.width>4096||v.height>4096||v.frames!==frames
    ||BigInt(v.rateNumerator)!==30n*BigInt(v.rateDenominator)||BigInt(v.durationTicks)*BigInt(v.timeBaseNumerator)*30n!==BigInt(frames)*BigInt(v.timeBaseDenominator)
    ||BigInt(a.timeBaseNumerator)*44100n!==BigInt(a.timeBaseDenominator))fail("The actual decoded film probe differs from its exact video clock or 44.1 kHz audio stream.");
  media(input.video,128*1024**3);exact(input.captions,["srt","vtt"]);media(input.captions.srt,8*1024**2);media(input.captions.vtt,8*1024**2);
  return seal({schema:"hv-current-film-clock/2" as const,projectId:input.projectId,jobId:input.jobId,jobPlanRevision:input.jobPlanRevision,materializationRevision:input.materializationRevision,fps:30 as const,...expected,requestedOverlapFrames:input.requestedOverlapFrames,spans,rawFrames,frames,probe:input.probe,video:input.video,captions:{policy:"hv-captions-measured-or-fallback-ms/1" as const,...input.captions}});
}
export function validateCurrentFilmAssemblyClock(raw:CurrentFilmAssemblyClock,rows:CurrentFilmClockRow[],requestedOverlapFrames:0|15):CurrentFilmAssemblyClock{
  const input=portable({raw,rows,requestedOverlapFrames}),clock=input.raw;exact(clock,["schema","projectId","jobId","jobPlanRevision","materializationRevision","fps","requestedOverlapFrames","effectiveOverlapFrames","reason","spans","rawFrames","frames","probe","video","captions","revision"]);
  if(!Array.isArray(clock.spans)||clock.spans.length>60)fail("Retain bounded current-film assembly spans.");
  const expected=createCurrentFilmAssemblyClock({projectId:clock.projectId,jobId:clock.jobId,jobPlanRevision:clock.jobPlanRevision,materializationRevision:clock.materializationRevision,requestedOverlapFrames:input.requestedOverlapFrames,effectiveOverlapFrames:clock.effectiveOverlapFrames,reason:clock.reason,rows:input.rows,sourceFrames:clock.spans.map(row=>row.frames),probe:clock.probe,video:clock.video,captions:{srt:clock.captions.srt,vtt:clock.captions.vtt}});
  if(hash(expected)!==hash(clock))fail("The current-film clock differs from its exact measured records and media facts.");return expected;
}

/** Decode the actual assembler ffprobe response without deriving duration from container seconds. */
export function parseCurrentFilmProbe(raw:unknown):CurrentFilmProbe {
  const data=portable(raw) as {streams?:{codec_type?:string;codec_name?:string;width?:number;height?:number;nb_read_frames?:string;r_frame_rate?:string;time_base?:string;duration_ts?:number;sample_rate?:string;channels?:number}[]};
  if(!data||!Array.isArray(data.streams)||data.streams.length!==2)fail("The canonical film requires exactly one video and one audio stream.");
  const video=data.streams.filter(stream=>stream?.codec_type==="video"),audio=data.streams.filter(stream=>stream?.codec_type==="audio");if(video.length!==1||audio.length!==1)fail("The canonical film requires actual video and audio stream clocks.");
  const v=video[0]!,a=audio[0]!,ratio=(value:unknown):[number,number]=>{if(typeof value!=="string"||!/^\d+\/\d+$/.test(value))fail("Retain an exact measured stream ratio.");const [n,d]=value.split("/").map(Number);integer(n,1);integer(d,1);return [n,d];};
  const [rateNumerator,rateDenominator]=ratio(v.r_frame_rate),[timeBaseNumerator,timeBaseDenominator]=ratio(v.time_base),[audioNumerator,audioDenominator]=ratio(a.time_base);
  const frames=Number(v.nb_read_frames),sampleRate=Number(a.sample_rate);for(const value of [v.width,v.height,frames,v.duration_ts,a.duration_ts])integer(value,1);
  if(v.codec_name!=="h264"||a.codec_name!=="aac"||sampleRate!==44100||a.channels!==2)fail("The canonical film requires H.264 and 44.1 kHz stereo AAC.");
  return {video:{codec:v.codec_name,width:v.width!,height:v.height!,frames,rateNumerator,rateDenominator,timeBaseNumerator,timeBaseDenominator,durationTicks:v.duration_ts!},audio:{codec:a.codec_name,sampleRate,channels:a.channels,timeBaseNumerator:audioNumerator,timeBaseDenominator:audioDenominator,durationTicks:a.duration_ts!}};
}
